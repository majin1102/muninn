use chrono::Utc;

use crate::format::observing::{
    MemoryCategory, ObservedMemory, ObservingCheckpoint, ObservingSnapshot,
};
use crate::format::semantic_index::SemanticIndexRow;
use crate::format::session::{SessionTurn, SessionWrite};
use crate::llm::config::EmbeddingConfig;
use crate::llm::config::{llm_test_env_guard, write_test_munnai_config};
use crate::llm::observing::{GatewayAction, GatewayUpdate, NewThreadHint};
use crate::observer::observer::{Observer, apply_gateway_updates, apply_memory_delta};
use crate::observer::observing::{ObservingThread, SnapshotContent};
use crate::service::{PostMessage, Service};
use crate::storage::{SessionSelect, Storage};

fn set_data_root(dir: &tempfile::TempDir) {
    let root = dir.path().join("munnai");
    unsafe {
        std::env::set_var("MUNNAI_HOME", &root);
    }
}

fn clear_data_root() {
    unsafe {
        std::env::remove_var("MUNNAI_HOME");
        std::env::remove_var("MUNNAI_OBSERVER_POLL_MS");
    }
}

fn test_storage() -> Storage {
    Storage::local(crate::config::data_root().unwrap()).unwrap()
}

fn set_test_config(
    dir: &tempfile::TempDir,
    turn_provider: Option<&str>,
    observer_provider: Option<&str>,
    semantic_index_provider: Option<&str>,
) {
    let home = dir.path().join("munnai");
    std::fs::create_dir_all(&home).unwrap();
    let config_path = home.join("settings.json");
    write_test_munnai_config(
        &config_path,
        turn_provider,
        observer_provider,
        semantic_index_provider,
    );
}

async fn post_observable(
    storage: &Storage,
    session_id: &str,
    prompt: &str,
    response: &str,
    summary: &str,
) -> SessionTurn {
    Service::new(storage.clone())
        .await
        .unwrap()
        .sessions()
        .post(PostMessage {
            session_id: Some(session_id.to_string()),
            agent: "agent-a".to_string(),
            title: None,
            summary: Some(summary.to_string()),
            tool_calling: None,
            artifacts: None,
            prompt: Some(prompt.to_string()),
            response: Some(response.to_string()),
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn flush_completed_turn_persists_observing_checkpoint() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNNAI_OBSERVER_POLL_MS", "60000");
    }
    let storage = test_storage();

    let turn = post_observable(&storage, "group-a", "prompt-a", "response-a", "summary-a").await;
    assert_eq!(turn.observing_epoch, Some(0));

    let observer = Observer::new(test_storage()).await.unwrap();
    let inbox = observer.snapshot().await.unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].turn_id, turn.turn_id);

    let flushed = observer.flush_epoch().await.unwrap();
    assert_eq!(flushed, 1);
    assert!(observer.snapshot().await.unwrap().is_empty());

    let observings = storage
        .observings()
        .list(Some("test-observer"))
        .await
        .unwrap();
    assert_eq!(observings.len(), 1);
    assert_eq!(observings[0].checkpoint.observing_epoch, 0);
    assert_eq!(observings[0].checkpoint.indexed_snapshot_sequence, Some(0));
    assert_eq!(
        observings[0].references,
        vec![format!("SESSION:{}", turn.turn_id)]
    );

    clear_data_root();
}

#[tokio::test]
async fn different_sessions_share_same_open_epoch() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNNAI_OBSERVER_POLL_MS", "60000");
    }
    let storage = test_storage();

    let first = post_observable(&storage, "group-a", "prompt-a", "response-a", "summary-a").await;
    let second = post_observable(&storage, "group-b", "prompt-b", "response-b", "summary-b").await;
    assert_eq!(first.observing_epoch, Some(0));
    assert_eq!(second.observing_epoch, Some(0));

    let observer = Observer::new(test_storage()).await.unwrap();
    let inbox = observer.snapshot().await.unwrap();
    assert_eq!(inbox.len(), 2);
    assert!(inbox.iter().any(|turn| turn.turn_id == first.turn_id));
    assert!(inbox.iter().any(|turn| turn.turn_id == second.turn_id));

    let flushed = observer.flush_epoch().await.unwrap();
    assert_eq!(flushed, 2);

    let observings = storage
        .observings()
        .list(Some("test-observer"))
        .await
        .unwrap();
    assert!(!observings.is_empty());
    assert!(
        observings
            .iter()
            .all(|observing| observing.checkpoint.observing_epoch == 0)
    );

    clear_data_root();
}

#[tokio::test]
async fn failed_post_does_not_leak_open_write_barrier() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNNAI_OBSERVER_POLL_MS", "60000");
    }
    let storage = test_storage();
    let service = Service::new(storage.clone()).await.unwrap();

    let error = service
        .sessions()
        .post(PostMessage {
            session_id: Some("group-a".to_string()),
            agent: "agent-a".to_string(),
            title: None,
            summary: None,
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
        })
        .await;
    assert!(error.is_err());

    let turn = post_observable(&storage, "group-a", "prompt-a", "response-a", "summary-a").await;
    let observer = Observer::new(test_storage()).await.unwrap();
    let inbox = observer.snapshot().await.unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].turn_id, turn.turn_id);
    assert_eq!(observer.flush_epoch().await.unwrap(), 1);

    clear_data_root();
}

#[tokio::test]
async fn observer_shutdown_is_idempotent_and_drops_enqueues() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNNAI_OBSERVER_POLL_MS", "60000");
    }

    let observer = Observer::new(test_storage()).await.unwrap();
    observer.shutdown().await;
    observer.shutdown().await;

    assert!(observer.is_shutdown().await);
    assert!(observer.runtime_stopped().await);

    let turn = SessionTurn::new(&SessionWrite {
        session_id: Some("group-a".to_string()),
        agent: "agent-a".to_string(),
        observer: "test-observer".to_string(),
        title: None,
        summary: Some("summary-a".to_string()),
        title_source: None,
        summary_source: None,
        tool_calling: None,
        artifacts: None,
        prompt: Some("prompt-a".to_string()),
        response: Some("response-a".to_string()),
    });
    observer.enqueue(vec![turn]).await;
    assert!(observer.snapshot().await.unwrap().is_empty());

    clear_data_root();
}

#[tokio::test]
async fn observer_new_replaces_shutdown_singleton() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNNAI_OBSERVER_POLL_MS", "60000");
    }

    let first = Observer::new(test_storage()).await.unwrap();
    first.shutdown().await;

    let second = Observer::new(test_storage()).await.unwrap();
    assert!(first.is_shutdown().await);
    assert!(!second.is_shutdown().await);
    assert!(!first.shares_runtime_with(&second));

    clear_data_root();
}

#[tokio::test]
async fn recovery_requeues_observable_turns_without_an_epoch() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNNAI_OBSERVER_POLL_MS", "60000");
    }
    let storage = test_storage();

    storage
        .observings()
        .upsert(vec![ObservingSnapshot {
            snapshot_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZQ".to_string(),
            observing_id: "OBS-RECOVERY".to_string(),
            snapshot_sequence: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            observer: "test-observer".to_string(),
            title: "Recovered".to_string(),
            summary: "Committed epoch 0".to_string(),
            content: serde_json::json!({"memories":[],"openQuestions":[],"nextSteps":[]})
                .to_string(),
            references: vec![],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 0,
                indexed_snapshot_sequence: Some(0),
            },
        }])
        .await
        .unwrap();

    let now = Utc::now();
    let turn = SessionTurn {
        turn_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZR".to_string(),
        created_at: now,
        updated_at: now,
        session_id: Some("group-a".to_string()),
        agent: "agent-a".to_string(),
        observer: "test-observer".to_string(),
        title: Some("Recovered turn".to_string()),
        summary: Some("summary-a".to_string()),
        title_source: None,
        summary_source: None,
        tool_calling: None,
        artifacts: None,
        prompt: Some("prompt-a".to_string()),
        response: Some("response-a".to_string()),
        observing_epoch: None,
    };
    storage.sessions().upsert(vec![turn.clone()]).await.unwrap();

    let observer = Observer::new(test_storage()).await.unwrap();
    let inbox = observer.snapshot().await.unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].turn_id, turn.turn_id);
    assert_eq!(inbox[0].observing_epoch, Some(1));

    let persisted = storage
        .sessions()
        .select(SessionSelect::ById(turn.turn_id.clone()))
        .await
        .unwrap();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].observing_epoch, Some(1));

    clear_data_root();
}

#[tokio::test]
async fn gateway_can_append_or_spawn_observing() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);

    let mut turn = SessionTurn::new(&SessionWrite {
        session_id: Some("group-a".to_string()),
        agent: "agent-a".to_string(),
        observer: "test-observer".to_string(),
        title: None,
        summary: Some("turn c summary".to_string()),
        title_source: None,
        summary_source: None,
        tool_calling: None,
        artifacts: None,
        prompt: Some("prompt-c".to_string()),
        response: Some("response-c".to_string()),
    });
    turn.summary = Some("turn c summary".to_string());
    turn.prompt = Some("prompt-c".to_string());
    turn.response = Some("response-c".to_string());

    let mut threads = vec![ObservingThread {
        observing_id: "OBS-A".to_string(),
        snapshot_id: None,
        observing_epoch: 0,
        title: "Session A".to_string(),
        summary: "Existing line A".to_string(),
        snapshots: Vec::new(),
        references: vec!["SESSION:TURN-PREV".to_string()],
        indexed_snapshot_sequence: None,
        observer: "test-observer".to_string(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }];

    let touched_ids = apply_gateway_updates(
        &mut threads,
        "test-observer",
        std::slice::from_ref(&turn),
        7,
        vec![
            GatewayUpdate {
                turn_id: turn.turn_id.clone(),
                action: GatewayAction::Append,
                observing_id: Some("OBS-A".to_string()),
                summary: "continue A".to_string(),
                new_thread: None,
                why: "same thread".to_string(),
            },
            GatewayUpdate {
                turn_id: turn.turn_id.clone(),
                action: GatewayAction::New,
                observing_id: None,
                summary: "branch B".to_string(),
                new_thread: Some(NewThreadHint {
                    title: "Session B".to_string(),
                    summary: "New line B".to_string(),
                }),
                why: "independent thread".to_string(),
            },
        ],
    )
    .await
    .unwrap();

    assert_eq!(touched_ids.len(), 2);
    assert!(touched_ids.contains("OBS-A"));

    assert_eq!(threads.len(), 2);
    assert!(threads.iter().all(|thread| thread.observing_epoch == 7));
    let session_a = threads
        .iter()
        .find(|thread| thread.observing_id == "OBS-A")
        .unwrap();
    let session_b = threads
        .iter()
        .find(|thread| thread.observing_id != "OBS-A")
        .unwrap();

    assert_eq!(
        session_a.references,
        vec![format!("SESSION:{}", turn.turn_id)]
    );
    assert!(
        session_b
            .references
            .iter()
            .any(|reference| reference == "OBSERVING:OBS-A")
    );
    assert!(
        session_b
            .references
            .iter()
            .any(|reference| *reference == format!("SESSION:{}", turn.turn_id))
    );

    clear_data_root();
}

#[tokio::test]
async fn load_runtime_restores_observings() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    let storage = test_storage();

    let observing = ObservingSnapshot {
        snapshot_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string(),
        observing_id: "OBS-LINE".to_string(),
        snapshot_sequence: 0,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        observer: "test-observer".to_string(),
        title: "Loaded observing".to_string(),
        summary: "Loaded summary".to_string(),
        content: serde_json::json!({
            "memories": [{"id":"00000000-0000-0000-0000-000000000001","text": "concept", "category": "Concept"}],
            "openQuestions": ["what next"],
            "nextSteps": ["follow up"]
        })
        .to_string(),
        references: vec!["SESSION:01TEST".to_string()],
        checkpoint: ObservingCheckpoint {
            observing_epoch: 3,
            indexed_snapshot_sequence: Some(0),
        },
    };
    storage.observings().upsert(vec![observing]).await.unwrap();

    let observer = Observer::new(test_storage()).await.unwrap();

    let sessions = observer.threads_snapshot().await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].observing_id, "OBS-LINE");
    assert_eq!(
        sessions[0].snapshot_id.as_deref(),
        Some("01JQ7Y8YQ6V7D4M1N9K2F5T8ZX")
    );
    assert_eq!(sessions[0].snapshots.len(), 1);
    assert_eq!(sessions[0].snapshots[0].memories.len(), 1);
    assert_eq!(sessions[0].references, vec!["SESSION:01TEST".to_string()]);
    assert_eq!(sessions[0].indexed_snapshot_sequence, Some(0));
    assert_eq!(sessions[0].observing_epoch, 3);

    clear_data_root();
}

#[tokio::test]
async fn catches_up_semantic_index_from_checkpoint() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, None, Some("mock"));
    set_data_root(&dir);
    let storage = test_storage();

    let first_created_at = Utc::now() - chrono::Duration::hours(1);
    storage
        .semantic_index()
        .upsert(vec![
            SemanticIndexRow {
                id: "mem-1".to_string(),
                text: "before text".to_string(),
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.33,
                category: "fact".to_string(),
                created_at: first_created_at,
            },
            SemanticIndexRow {
                id: "mem-deleted".to_string(),
                text: "to be deleted".to_string(),
                vector: vec![0.4, 0.3, 0.2, 0.1],
                importance: 0.51,
                category: "entity".to_string(),
                created_at: first_created_at,
            },
        ])
        .await
        .unwrap();

    let snapshot0 = serde_json::json!({
        "memories": [
            {"id":"mem-1","text":"before text","category":"Fact"},
            {"id":"mem-deleted","text":"to be deleted","category":"Entity"}
        ],
        "openQuestions": [],
        "nextSteps": [],
        "memoryDelta": {
            "before": [],
            "after": [
                {"id":"mem-1","text":"before text","category":"Fact"},
                {"id":"mem-deleted","text":"to be deleted","category":"Entity"}
            ]
        }
    });
    let snapshot1 = serde_json::json!({
        "memories": [
            {"id":"mem-1","text":"after text","category":"Fact"},
            {"id":"mem-2","text":"concept promoted","category":"Concept"}
        ],
        "openQuestions": [],
        "nextSteps": [],
        "memoryDelta": {
            "before": [
                {"id":"mem-1","text":"before text","category":"Fact"},
                {"id":"mem-deleted","text":"to be deleted","category":"Entity"}
            ],
            "after": [
                {"id":"mem-1","text":"after text","category":"Fact"},
                {"id":"mem-2","text":"concept promoted","category":"Concept"}
            ]
        }
    });
    storage
        .observings()
        .upsert(vec![
            ObservingSnapshot {
                snapshot_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZA".to_string(),
                observing_id: "OBS-CATCHUP".to_string(),
                snapshot_sequence: 0,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                observer: "test-observer".to_string(),
                title: "Catch-up observing".to_string(),
                summary: "Checkpoint lagging behind".to_string(),
                content: snapshot0.to_string(),
                references: vec!["SESSION:TURN-0".to_string()],
                checkpoint: ObservingCheckpoint {
                    observing_epoch: 0,
                    indexed_snapshot_sequence: None,
                },
            },
            ObservingSnapshot {
                snapshot_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZB".to_string(),
                observing_id: "OBS-CATCHUP".to_string(),
                snapshot_sequence: 1,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                observer: "test-observer".to_string(),
                title: "Catch-up observing".to_string(),
                summary: "Checkpoint lagging behind".to_string(),
                content: snapshot1.to_string(),
                references: vec!["SESSION:TURN-1".to_string()],
                checkpoint: ObservingCheckpoint {
                    observing_epoch: 0,
                    indexed_snapshot_sequence: Some(0),
                },
            },
        ])
        .await
        .unwrap();

    let _observer = Observer::new(test_storage()).await.unwrap();

    let rows = storage.semantic_index().list().await.unwrap();
    assert_eq!(rows.len(), 2);
    let mem_1 = rows.iter().find(|row| row.id == "mem-1").unwrap();
    let mem_2 = rows.iter().find(|row| row.id == "mem-2").unwrap();
    assert_eq!(mem_1.text, "after text");
    assert_eq!(mem_1.importance, 0.33);
    assert_eq!(mem_1.created_at, first_created_at);
    assert_eq!(mem_1.category, "fact");
    assert_eq!(mem_1.vector.len(), 4);
    assert_eq!(mem_2.text, "concept promoted");
    assert_eq!(mem_2.category, "other");
    assert_eq!(mem_2.importance, 0.7);
    assert_eq!(mem_2.vector.len(), 4);
    assert!(rows.iter().all(|row| row.id != "mem-deleted"));

    let persisted = storage.observings().list(None).await.unwrap();
    let observing = persisted
        .iter()
        .find(|observing| observing.snapshot_id == "01JQ7Y8YQ6V7D4M1N9K2F5T8ZB")
        .unwrap();
    assert_eq!(observing.checkpoint.indexed_snapshot_sequence, Some(1));

    clear_data_root();
}

#[tokio::test]
async fn replaying_snapshot_keeps_index_metadata() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, None, Some("mock"));
    set_data_root(&dir);
    let storage = test_storage();

    let snapshot = SnapshotContent {
        memories: vec![ObservedMemory {
            id: Some("mem-1".to_string()),
            text: "stable fact".to_string(),
            category: MemoryCategory::Fact,
            updated_memory: None,
        }],
        open_questions: Vec::new(),
        next_steps: Vec::new(),
        memory_delta: crate::observer::types::LlmFieldUpdate::new(
            vec![],
            vec![ObservedMemory {
                id: Some("mem-1".to_string()),
                text: "stable fact".to_string(),
                category: MemoryCategory::Fact,
                updated_memory: None,
            }],
        ),
    };
    let initial_config = EmbeddingConfig {
        provider: "mock".to_string(),
        model: None,
        api_key: None,
        base_url: None,
        dimensions: 4,
        default_importance: 0.7,
    };
    apply_memory_delta(&storage, &snapshot, &initial_config)
        .await
        .unwrap();

    let first_row = storage
        .semantic_index()
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.id == "mem-1")
        .unwrap();
    let pinned_created_at = first_row.created_at - chrono::Duration::minutes(15);
    storage
        .semantic_index()
        .upsert(vec![SemanticIndexRow {
            id: first_row.id.clone(),
            text: first_row.text.clone(),
            vector: first_row.vector.clone(),
            importance: 0.25,
            category: first_row.category.clone(),
            created_at: pinned_created_at,
        }])
        .await
        .unwrap();

    let replay_config = EmbeddingConfig {
        provider: "mock".to_string(),
        model: None,
        api_key: None,
        base_url: None,
        dimensions: 4,
        default_importance: 0.95,
    };
    apply_memory_delta(&storage, &snapshot, &replay_config)
        .await
        .unwrap();

    let rows = storage.semantic_index().list().await.unwrap();
    assert_eq!(rows.len(), 1);
    let row = rows.iter().find(|item| item.id == "mem-1").unwrap();
    assert_eq!(row.importance, 0.25);
    assert_eq!(row.created_at, pinned_created_at);
    assert_eq!(row.category, "fact");
    assert_eq!(row.text, "stable fact");
    assert_eq!(row.vector.len(), 4);

    clear_data_root();
}
