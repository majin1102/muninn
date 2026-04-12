use std::future::Future;
use std::time::Duration;

use chrono::Utc;

use crate::format::observing::MemoryCategory;
use crate::format::{
    MemoryId, MemoryLayer, ObservedMemory, ObservingCheckpoint, ObservingSnapshot,
    ObservingTable, SemanticIndexRow, SemanticIndexTable, SessionSelect, SessionTable,
    SessionTurn, TableOptions,
};
use crate::llm::config::EmbeddingConfig;
use crate::llm::config::{effective_observer_name, llm_test_env_guard, write_test_muninn_config};
use crate::llm::observing::{GatewayAction, GatewayUpdate, NewThreadHint};
use crate::observer::runtime::{Observer, apply_gateway_updates, apply_memory_delta};
use crate::observer::thread::{ObservingThread, SnapshotContent};
use crate::test_support::{TestService, TurnContent};
use crate::session::SessionUpdate;

async fn wait_until<F, Fut>(mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    for _ in 0..50 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition was not met in time");
}

fn observable_turn(
    session_id: &str,
    agent: &str,
    observer: &str,
    prompt: &str,
    response: &str,
    summary: &str,
) -> SessionTurn {
    let update = SessionUpdate {
        session_id: Some(session_id.to_string()),
        agent: agent.to_string(),
        observer: observer.to_string(),
        title: None,
        summary: Some(summary.to_string()),
        tool_calling: None,
        artifacts: None,
        prompt: Some(prompt.to_string()),
        response: Some(response.to_string()),
        observing_epoch: None,
    };
    let mut turn = SessionTurn::new(&update);
    turn.summary = update.summary.clone();
    turn.prompt = update.prompt.clone();
    turn.response = update.response.clone();
    turn
}

fn set_data_root(dir: &tempfile::TempDir) {
    let root = dir.path().join("muninn");
    unsafe {
        std::env::set_var("MUNINN_HOME", &root);
    }
}

fn clear_data_root() {
    unsafe {
        std::env::remove_var("MUNINN_HOME");
        std::env::remove_var("MUNINN_OBSERVER_POLL_MS");
    }
}

fn test_table_options() -> TableOptions {
    TableOptions::local(crate::config::data_root().unwrap()).unwrap()
}

fn session_table(table_options: &TableOptions) -> SessionTable {
    SessionTable::new(table_options.to_owned())
}

fn observing_table(table_options: &TableOptions) -> ObservingTable {
    ObservingTable::new(table_options.to_owned())
}

fn semantic_index_table(table_options: &TableOptions) -> SemanticIndexTable {
    SemanticIndexTable::new(table_options.to_owned())
}

fn pending_turn_id() -> MemoryId {
    MemoryId::new(MemoryLayer::Session, u64::MAX)
}

fn pending_snapshot_id() -> MemoryId {
    MemoryId::new(MemoryLayer::Observing, u64::MAX)
}

fn set_test_config(
    dir: &tempfile::TempDir,
    turn_provider: Option<&str>,
    observer_provider: Option<&str>,
    semantic_index_provider: Option<&str>,
) {
    let home = dir.path().join("muninn");
    std::fs::create_dir_all(&home).unwrap();
    let config_path = home.join(crate::llm::config::CONFIG_FILE_NAME);
    write_test_muninn_config(
        &config_path,
        turn_provider,
        observer_provider,
        semantic_index_provider,
    );
}

async fn post_observable(
    table_options: &TableOptions,
    session_id: &str,
    prompt: &str,
    response: &str,
    summary: &str,
) -> SessionTurn {
    let service = TestService::new(table_options.clone()).await.unwrap();
    post_observable_with_service(&service, table_options, session_id, prompt, response, summary)
        .await
}

async fn post_observable_with_service(
    service: &TestService,
    table_options: &TableOptions,
    session_id: &str,
    prompt: &str,
    response: &str,
    summary: &str,
) -> SessionTurn {
    service
        .accept(TurnContent {
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
        .unwrap();
    session_table(table_options)
        .load_latest_turn_for(
            Some(session_id),
            "agent-a",
            &effective_observer_name().unwrap(),
        )
        .await
        .unwrap()
        .expect("observable turn should be persisted")
}

#[tokio::test]
async fn flush_completed_turn_persists_observing_checkpoint() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }
    let table_options = test_table_options();

    let turn = post_observable(
        &table_options,
        "group-a",
        "prompt-a",
        "response-a",
        "summary-a",
    )
    .await;
    assert_eq!(turn.observing_epoch, Some(0));

    wait_until(|| {
        let table_options = table_options.clone();
        async move {
            observing_table(&table_options)
                .list(Some("test-observer"))
                .await
                .map(|rows| {
                    rows.len() == 1
                        && rows[0].checkpoint.indexed_snapshot_sequence == Some(0)
                })
                .unwrap_or(false)
        }
    })
    .await;

    let observings = observing_table(&table_options)
        .list(Some("test-observer"))
        .await
        .unwrap();
    assert_eq!(observings.len(), 1);
    assert_eq!(observings[0].checkpoint.observing_epoch, 0);
    assert_eq!(observings[0].checkpoint.indexed_snapshot_sequence, Some(0));
    assert_eq!(observings[0].references, vec![turn.turn_id.to_string()]);

    clear_data_root();
}

#[tokio::test]
async fn different_sessions_flush_in_separate_epochs() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }
    let table_options = test_table_options();
    let observer = Observer::new(table_options.clone()).await.unwrap();
    let service = TestService::new(table_options.clone()).await.unwrap();

    let first = post_observable_with_service(
        &service,
        &table_options,
        "group-a",
        "prompt-a",
        "response-a",
        "summary-a",
    )
    .await;
    wait_until(|| {
        let observer = observer.clone();
        async move {
            observer.window().epoch() == 1
        }
    })
    .await;
    let second = post_observable_with_service(
        &service,
        &table_options,
        "group-b",
        "prompt-b",
        "response-b",
        "summary-b",
    )
    .await;
    assert_eq!(first.observing_epoch, Some(0));
    assert_eq!(second.observing_epoch, Some(1));

    wait_until(|| {
        let table_options = table_options.clone();
        async move {
            observing_table(&table_options)
                .list(Some("test-observer"))
                .await
                .map(|rows| rows.len() >= 2)
                .unwrap_or(false)
        }
    })
    .await;

    let observings = observing_table(&table_options)
        .list(Some("test-observer"))
        .await
        .unwrap();
    let mut epochs = observings
        .iter()
        .map(|observing| observing.checkpoint.observing_epoch)
        .collect::<Vec<_>>();
    epochs.sort();
    assert!(epochs.contains(&0));
    assert!(epochs.contains(&1));

    clear_data_root();
}

#[tokio::test]
async fn failed_post_does_not_leak_open_write_barrier() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }
    let table_options = test_table_options();
    let service = TestService::new(table_options.clone()).await.unwrap();

    let error = service
        .accept(TurnContent {
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

    let turn = post_observable(
        &table_options,
        "group-a",
        "prompt-a",
        "response-a",
        "summary-a",
    )
    .await;
    wait_until(|| {
        let table_options = table_options.clone();
        async move {
            observing_table(&table_options)
                .list(Some("test-observer"))
                .await
                .map(|rows| rows.iter().any(|row| row.references == vec![turn.turn_id.to_string()]))
                .unwrap_or(false)
        }
    })
    .await;

    clear_data_root();
}

#[tokio::test]
async fn observer_shutdown_is_idempotent_and_drops_enqueues() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }

    let observer = Observer::new(test_table_options()).await.unwrap();
    observer.shutdown(true).await;
    observer.shutdown(true).await;

    assert!(observer.is_shutdown().await);
    assert!(observer.task_stopped().await);

    let turn = observable_turn(
        "group-a",
        "agent-a",
        "test-observer",
        "prompt-a",
        "response-a",
        "summary-a",
    );
    let window = observer.window();
    window.include(turn).await;
    window.complete();
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
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }

    let first = Observer::new(test_table_options()).await.unwrap();
    first.shutdown(true).await;

    let second = Observer::new(test_table_options()).await.unwrap();
    assert!(first.is_shutdown().await);
    assert!(!second.is_shutdown().await);
    assert!(!first.shares_task_with(&second));

    clear_data_root();
}

#[tokio::test]
async fn observer_watermark_tracks_pending_turns_until_flush_completes() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }

    let observer = Observer::new(test_table_options()).await.unwrap();
    let turn = observable_turn(
        "group-a",
        "agent-a",
        "test-observer",
        "prompt-a",
        "response-a",
        "summary-a",
    );
    let window = observer.window();
    window.include(turn.clone()).await;

    let current = observer.watermark().await.unwrap();
    assert!(!current.resolved);
    assert_eq!(current.pending_turn_ids, vec![turn.turn_id.to_string()]);
    assert_eq!(current.observing_epoch, None);

    window.complete();
    wait_until(|| {
        let observer = observer.clone();
        async move { observer.watermark().await.map(|wm| wm.resolved).unwrap_or(false) }
    })
    .await;

    let flushed = observer.watermark().await.unwrap();
    assert!(flushed.resolved);
    assert!(flushed.pending_turn_ids.is_empty());
    assert_eq!(flushed.committed_epoch, Some(0));

    clear_data_root();
}

#[tokio::test]
async fn observer_watermark_dedupes_and_sorts_pending_turn_ids() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }

    let observer = Observer::new(test_table_options()).await.unwrap();
    let mut second = observable_turn(
        "group-a",
        "agent-a",
        "test-observer",
        "prompt",
        "response",
        "summary",
    )
    .with_row_id(2);
    second.created_at = second.created_at + chrono::Duration::seconds(1);
    second.updated_at = second.created_at;

    let mut first = observable_turn(
        "group-a",
        "agent-a",
        "test-observer",
        "prompt",
        "response",
        "summary",
    )
    .with_row_id(1);
    first.updated_at = first.created_at;

    let mut first_newer = first.clone();
    first_newer.updated_at = first_newer.updated_at + chrono::Duration::seconds(5);

    let window = observer.window();
    window.include(second).await;
    window.include(first.clone()).await;
    window.include(first_newer).await;

    let watermark = observer.watermark().await.unwrap();
    assert!(!watermark.resolved);
    assert_eq!(
        watermark.pending_turn_ids,
        vec![first.turn_id.to_string(), "session:2".to_string()]
    );
    assert_eq!(watermark.observing_epoch, None);
    window.complete();

    clear_data_root();
}

#[tokio::test]
async fn observer_watermark_keeps_turn_pending_until_index_retry_succeeds() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), Some("broken"));
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }

    let table_options = test_table_options();
    let turn = post_observable(
        &table_options,
        "group-a",
        "prompt-a",
        "response-a",
        "summary-a",
    )
    .await;
    let observer = Observer::new(test_table_options()).await.unwrap();
    wait_until(|| {
        let observer = observer.clone();
        async move {
            observer
                .watermark()
                .await
                .map(|wm| !wm.resolved && wm.committed_epoch == Some(0))
                .unwrap_or(false)
        }
    })
    .await;

    let stuck = observer.watermark().await.unwrap();
    assert!(!stuck.resolved);
    assert_eq!(stuck.pending_turn_ids, vec![turn.turn_id.to_string()]);
    assert_eq!(stuck.committed_epoch, Some(0));

    set_test_config(&dir, None, Some("mock"), Some("mock"));
    assert_eq!(observer.flush_epoch().await.unwrap(), 0);

    let recovered = observer.watermark().await.unwrap();
    assert!(recovered.resolved);
    assert!(recovered.pending_turn_ids.is_empty());
    assert_eq!(recovered.committed_epoch, Some(0));

    clear_data_root();
}

#[tokio::test]
async fn observer_restart_restores_pending_turns_from_observing_epoch() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), Some("broken"));
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }

    let table_options = test_table_options();
    let turn = post_observable(
        &table_options,
        "group-a",
        "prompt-a",
        "response-a",
        "summary-a",
    )
    .await;
    let observer = Observer::new(test_table_options()).await.unwrap();
    wait_until(|| {
        let observer = observer.clone();
        async move {
            observer
                .watermark()
                .await
                .map(|wm| !wm.resolved && wm.committed_epoch == Some(0))
                .unwrap_or(false)
        }
    })
    .await;
    observer.shutdown(true).await;

    let restarted = Observer::new(test_table_options()).await.unwrap();
    let watermark = restarted.watermark().await.unwrap();
    assert!(!watermark.resolved);
    assert_eq!(watermark.pending_turn_ids, vec![turn.turn_id.to_string()]);
    assert_eq!(watermark.committed_epoch, Some(0));

    clear_data_root();
}

#[tokio::test]
async fn recovery_requeues_observable_turns_without_an_epoch() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    unsafe {
        std::env::set_var("MUNINN_OBSERVER_POLL_MS", "60000");
    }
    let table_options = test_table_options();

    let mut observings = vec![ObservingSnapshot {
            snapshot_id: pending_snapshot_id(),
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
        }];
    observing_table(&table_options)
        .insert(&mut observings)
        .await
        .unwrap();

    let now = Utc::now();
    let turn = SessionTurn {
        turn_id: pending_turn_id(),
        created_at: now,
        updated_at: now,
        session_id: Some("group-a".to_string()),
        agent: "agent-a".to_string(),
        observer: "test-observer".to_string(),
        title: Some("Recovered turn".to_string()),
        summary: Some("summary-a".to_string()),
        tool_calling: None,
        artifacts: None,
        prompt: Some("prompt-a".to_string()),
        response: Some("response-a".to_string()),
        observing_epoch: None,
    };
    let mut turns = vec![turn.clone()];
    session_table(&table_options).insert(&mut turns).await.unwrap();
    let persisted_turn = session_table(&table_options)
        .select(SessionSelect::Filter {
            agent: Some("agent-a".to_string()),
            session_id: Some("group-a".to_string()),
        })
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();

    let observer = Observer::new(test_table_options()).await.unwrap();
    let inbox = observer.snapshot().await.unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].turn_id, persisted_turn.turn_id);
    assert_eq!(inbox[0].observing_epoch, Some(1));

    let persisted = session_table(&table_options)
        .select(SessionSelect::ById(persisted_turn.turn_id.memory_point()))
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

    let mut turn = SessionTurn::new(&SessionUpdate {
        session_id: Some("group-a".to_string()),
        agent: "agent-a".to_string(),
        observer: "test-observer".to_string(),
        title: None,
        summary: Some("turn c summary".to_string()),
        tool_calling: None,
        artifacts: None,
        prompt: Some("prompt-c".to_string()),
        response: Some("response-c".to_string()),
        observing_epoch: None,
    });
    turn.summary = Some("turn c summary".to_string());
    turn.prompt = Some("prompt-c".to_string());
    turn.response = Some("response-c".to_string());

    let mut threads = vec![ObservingThread {
        observing_id: "OBS-A".to_string(),
        snapshot_id: Some(MemoryId::new(MemoryLayer::Observing, 42)),
        snapshot_ids: vec![MemoryId::new(MemoryLayer::Observing, 42)],
        observing_epoch: 0,
        title: "Session A".to_string(),
        summary: "Existing line A".to_string(),
        snapshots: Vec::new(),
        references: vec!["session:79".to_string()],
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
                turn_id: turn.turn_id.to_string(),
                action: GatewayAction::Append,
                observing_id: Some("OBS-A".to_string()),
                summary: "continue A".to_string(),
                new_thread: None,
                why: "same thread".to_string(),
            },
            GatewayUpdate {
                turn_id: turn.turn_id.to_string(),
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
        vec!["session:79".to_string(), turn.turn_id.to_string()]
    );
    assert!(
        session_b
            .references
            .iter()
            .any(|reference| *reference == turn.turn_id.to_string())
    );

    clear_data_root();
}

#[tokio::test]
async fn load_runtime_restores_observings() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, Some("mock"), None);
    set_data_root(&dir);
    let table_options = test_table_options();

    let observing = ObservingSnapshot {
        snapshot_id: pending_snapshot_id(),
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
        references: vec!["session:77".to_string()],
        checkpoint: ObservingCheckpoint {
            observing_epoch: 3,
            indexed_snapshot_sequence: Some(0),
        },
    };
    let mut observings = vec![observing];
    observing_table(&table_options)
        .insert(&mut observings)
        .await
        .unwrap();

    let observer = Observer::new(test_table_options()).await.unwrap();

    let sessions = observer.threads_snapshot().await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].observing_id, "OBS-LINE");
    assert_eq!(
        sessions[0].snapshot_id.as_ref().map(ToString::to_string),
        Some("observing:0".to_string())
    );
    assert_eq!(sessions[0].snapshots.len(), 1);
    assert_eq!(sessions[0].snapshots[0].memories.len(), 1);
    assert_eq!(sessions[0].references, vec!["session:77".to_string()]);
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
    let table_options = test_table_options();

    let first_created_at = Utc::now() - chrono::Duration::hours(1);
    semantic_index_table(&table_options)
        .upsert(vec![
            SemanticIndexRow {
                id: "mem-1".to_string(),
                memory_id: "observing:201".to_string(),
                text: "before text".to_string(),
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.33,
                category: "fact".to_string(),
                created_at: first_created_at,
            },
            SemanticIndexRow {
                id: "mem-deleted".to_string(),
                memory_id: "observing:201".to_string(),
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
    let mut observings = vec![
            ObservingSnapshot {
                snapshot_id: pending_snapshot_id(),
                observing_id: "OBS-CATCHUP".to_string(),
                snapshot_sequence: 0,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                observer: "test-observer".to_string(),
                title: "Catch-up observing".to_string(),
                summary: "Checkpoint lagging behind".to_string(),
                content: snapshot0.to_string(),
                references: vec!["session:70".to_string()],
                checkpoint: ObservingCheckpoint {
                    observing_epoch: 0,
                    indexed_snapshot_sequence: None,
                },
            },
            ObservingSnapshot {
                snapshot_id: pending_snapshot_id(),
                observing_id: "OBS-CATCHUP".to_string(),
                snapshot_sequence: 1,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                observer: "test-observer".to_string(),
                title: "Catch-up observing".to_string(),
                summary: "Checkpoint lagging behind".to_string(),
                content: snapshot1.to_string(),
                references: vec!["session:71".to_string()],
                checkpoint: ObservingCheckpoint {
                    observing_epoch: 0,
                    indexed_snapshot_sequence: Some(0),
                },
            },
        ];
    observing_table(&table_options)
        .insert(&mut observings)
        .await
        .unwrap();

    let _observer = Observer::new(test_table_options()).await.unwrap();

    let rows = semantic_index_table(&table_options).list().await.unwrap();
    assert_eq!(rows.len(), 2);
    let persisted = observing_table(&table_options).list(None).await.unwrap();
    let latest = persisted
        .iter()
        .find(|observing| {
            observing.observing_id == "OBS-CATCHUP" && observing.snapshot_sequence == 1
        })
        .unwrap();
    let mem_1 = rows.iter().find(|row| row.id == "mem-1").unwrap();
    let mem_2 = rows.iter().find(|row| row.id == "mem-2").unwrap();
    assert_eq!(mem_1.text, "after text");
    assert_eq!(mem_1.importance, 0.33);
    assert_eq!(mem_1.created_at, first_created_at);
    assert_eq!(mem_1.category, "fact");
    assert_eq!(mem_1.memory_id, latest.snapshot_id.to_string());
    assert_eq!(mem_1.vector.len(), 4);
    assert_eq!(mem_2.text, "concept promoted");
    assert_eq!(mem_2.category, "other");
    assert_eq!(mem_2.importance, 0.7);
    assert_eq!(mem_2.memory_id, latest.snapshot_id.to_string());
    assert_eq!(mem_2.vector.len(), 4);
    assert!(rows.iter().all(|row| row.id != "mem-deleted"));

    assert_eq!(latest.checkpoint.indexed_snapshot_sequence, Some(1));

    clear_data_root();
}

#[tokio::test]
async fn replaying_snapshot_keeps_index_metadata() {
    let _guard = llm_test_env_guard();
    let dir = tempfile::tempdir().unwrap();
    set_test_config(&dir, None, None, Some("mock"));
    set_data_root(&dir);
    let table_options = test_table_options();

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
    apply_memory_delta(&table_options, &snapshot, "observing:301", &initial_config)
        .await
        .unwrap();

    let first_row = semantic_index_table(&table_options)
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.id == "mem-1")
        .unwrap();
    let pinned_created_at = first_row.created_at - chrono::Duration::minutes(15);
    semantic_index_table(&table_options)
        .upsert(vec![SemanticIndexRow {
            id: first_row.id.clone(),
            memory_id: first_row.memory_id.clone(),
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
    apply_memory_delta(&table_options, &snapshot, "observing:302", &replay_config)
        .await
        .unwrap();

    let rows = semantic_index_table(&table_options).list().await.unwrap();
    assert_eq!(rows.len(), 1);
    let row = rows.iter().find(|item| item.id == "mem-1").unwrap();
    assert_eq!(row.importance, 0.25);
    assert_eq!(row.created_at, pinned_created_at);
    assert_eq!(row.category, "fact");
    assert_eq!(row.memory_id, "observing:302");
    assert_eq!(row.text, "stable fact");
    assert_eq!(row.vector.len(), 4);

    clear_data_root();
}
