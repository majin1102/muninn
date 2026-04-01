use std::collections::HashMap;
use std::str::FromStr;

use lance::{Error, Result};

use crate::format::memory::{MemoryId, MemoryLayer};
use crate::format::observing::ObservingSnapshot;
use crate::format::semantic_index::SemanticIndexRow;
use crate::format::session::SessionTurn;
use crate::llm::embedding::embed_text;
use crate::memory::observings::{self, ObservingListQuery};
use crate::memory::sessions::{self, SessionListQuery, render_session_turn_detail};
use crate::memory::types::{ListMode, MemoryView};
use crate::storage::Storage;

impl TryFrom<&SessionTurn> for MemoryView {
    type Error = Error;

    fn try_from(turn: &SessionTurn) -> Result<Self> {
        let title = turn
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let summary = turn
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let detail = render_session_turn_detail(turn);

        if title.is_none() && summary.is_none() && detail.is_none() {
            return Err(Error::invalid_input(
                "rendered session turn must include at least one of title, summary, or detail",
            ));
        }

        Ok(Self {
            memory_id: turn.memory_id()?,
            title,
            summary,
            detail,
            created_at: turn.created_at,
            updated_at: turn.updated_at,
        })
    }
}

impl TryFrom<&ObservingSnapshot> for MemoryView {
    type Error = Error;

    fn try_from(observing: &ObservingSnapshot) -> Result<Self> {
        let title = if observing.title.trim().is_empty() {
            None
        } else {
            Some(observing.title.trim().to_string())
        };
        let summary = if observing.summary.trim().is_empty() {
            None
        } else {
            Some(observing.summary.trim().to_string())
        };
        let detail = if observing.content.trim().is_empty() {
            None
        } else {
            Some(observing.content.clone())
        };

        if title.is_none() && summary.is_none() && detail.is_none() {
            return Err(Error::invalid_input(
                "rendered observing must include at least one of title, summary, or detail",
            ));
        }

        Ok(Self {
            memory_id: observing.memory_id()?,
            title,
            summary,
            detail,
            created_at: observing.created_at,
            updated_at: observing.updated_at,
        })
    }
}

pub async fn recall(storage: &Storage, query: &str, limit: usize) -> Result<Vec<MemoryView>> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let query = query.trim();
    if query.is_empty() {
        return legacy_recall(storage, query, limit).await;
    }

    let session_hits = render_session_turns(sessions::recall(storage, query, limit).await?)?;

    match semantic_recall(storage, query, limit).await {
        Ok(semantic_hits) => {
            let observing_fallback = if semantic_hits.len() < limit {
                render_observings(observings::recall(storage, query, limit).await?)?
            } else {
                Vec::new()
            };
            Ok(merge_recall_results(
                vec![semantic_hits, session_hits, observing_fallback],
                limit,
            ))
        }
        Err(error) => {
            eprintln!("[memory] semantic recall failed for {:?}: {}", query, error);
            legacy_recall(storage, query, limit).await
        }
    }
}

pub async fn list(storage: &Storage, mode: ListMode) -> Result<Vec<MemoryView>> {
    let turns = sessions::list(
        storage,
        SessionListQuery {
            mode,
            agent: None,
            session_id: None,
        },
    )
    .await?;
    let observings = observings::list(
        storage,
        ObservingListQuery {
            mode,
            observer: None,
        },
    )
    .await?;
    combine_rendered_window(
        render_session_turns(turns)?,
        render_observings(observings)?,
        mode,
    )
}

pub async fn timeline(
    storage: &Storage,
    memory_id: &str,
    before_limit: Option<usize>,
    after_limit: Option<usize>,
) -> Result<Vec<MemoryView>> {
    let memory_id = MemoryId::from_str(memory_id)?;
    let before_limit = before_limit.unwrap_or(3);
    let after_limit = after_limit.unwrap_or(3);
    match memory_id.memory_layer() {
        MemoryLayer::Session => {
            let rows = sessions::timeline(storage, &memory_id, before_limit, after_limit).await?;
            render_session_turns(rows)
        }
        MemoryLayer::Observing => {
            let rows = observings::timeline(storage, &memory_id, before_limit, after_limit).await?;
            render_observings(rows)
        }
        layer => Err(Error::invalid_input(format!(
            "unsupported memory layer for rendered timeline: {layer}"
        ))),
    }
}

pub async fn get(storage: &Storage, memory_id: &str) -> Result<Option<MemoryView>> {
    let memory_id = MemoryId::from_str(memory_id)?;
    match memory_id.memory_layer() {
        MemoryLayer::Session => sessions::get(storage, &memory_id)
            .await?
            .as_ref()
            .map(MemoryView::try_from)
            .transpose(),
        MemoryLayer::Observing => observings::get(storage, &memory_id)
            .await?
            .as_ref()
            .map(MemoryView::try_from)
            .transpose(),
        layer => Err(Error::invalid_input(format!(
            "unsupported memory layer for rendered detail: {layer}"
        ))),
    }
}

fn combine_rendered_window(
    turns: Vec<MemoryView>,
    observings: Vec<MemoryView>,
    mode: ListMode,
) -> Result<Vec<MemoryView>> {
    let mut combined = turns.into_iter().chain(observings).collect::<Vec<_>>();
    combined.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    match mode {
        ListMode::Recency { limit } => {
            combined.truncate(limit);
            combined.sort_by(|left, right| left.created_at.cmp(&right.created_at));
            Ok(combined)
        }
        ListMode::Page { offset, limit } => {
            Ok(combined.into_iter().skip(offset).take(limit).collect())
        }
    }
}

fn render_session_turns(turns: Vec<SessionTurn>) -> Result<Vec<MemoryView>> {
    turns
        .iter()
        .map(MemoryView::try_from)
        .collect::<Result<Vec<_>>>()
}

fn render_observings(observings: Vec<ObservingSnapshot>) -> Result<Vec<MemoryView>> {
    observings
        .iter()
        .map(MemoryView::try_from)
        .collect::<Result<Vec<_>>>()
}

async fn legacy_recall(storage: &Storage, query: &str, limit: usize) -> Result<Vec<MemoryView>> {
    let turns = sessions::recall(storage, query, limit).await?;
    let observings = observings::recall(storage, query, limit).await?;
    combine_rendered_window(
        render_session_turns(turns)?,
        render_observings(observings)?,
        ListMode::Recency { limit },
    )
}

async fn semantic_recall(storage: &Storage, query: &str, limit: usize) -> Result<Vec<MemoryView>> {
    let query_vector = embed_text(query).await?;
    let mut fetch_limit = limit.saturating_mul(4).max(limit);
    let candidate_groups = loop {
        let candidates = storage
            .semantic_index()
            .nearest(&query_vector, fetch_limit)
            .await?;
        let candidate_groups = merge_semantic_candidates(candidates.clone());
        if candidate_groups.len() >= limit || candidates.len() < fetch_limit {
            break candidate_groups;
        }
        fetch_limit = fetch_limit.saturating_mul(2);
    };

    let mut hits = Vec::new();
    for candidate in candidate_groups {
        if let Some(memory) = resolve_semantic_candidate(storage, &candidate.memory_id).await? {
            hits.push(memory);
            if hits.len() >= limit {
                break;
            }
        }
    }
    Ok(hits)
}

fn merge_recall_results(result_sets: Vec<Vec<MemoryView>>, limit: usize) -> Vec<MemoryView> {
    let mut deduped = HashMap::<String, MemoryView>::new();

    for memory in result_sets.into_iter().flatten() {
        let key = memory.memory_id.to_string();
        deduped
            .entry(key)
            .and_modify(|current| {
                if memory.created_at > current.created_at
                    || (memory.created_at == current.created_at
                        && memory.updated_at > current.updated_at)
                {
                    *current = memory.clone();
                }
            })
            .or_insert(memory);
    }

    let mut combined = deduped.into_values().collect::<Vec<_>>();
    combined.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    combined.truncate(limit);
    combined.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    combined
}

#[derive(Debug, Clone, PartialEq)]
struct SemanticCandidateGroup {
    memory_id: String,
    reciprocal_rank_score: f32,
    hit_count: usize,
    best_rank: usize,
    max_importance: f32,
    newest_created_at: chrono::DateTime<chrono::Utc>,
}

fn merge_semantic_candidates(candidates: Vec<SemanticIndexRow>) -> Vec<SemanticCandidateGroup> {
    let mut merged = HashMap::<String, SemanticCandidateGroup>::new();

    for (rank, candidate) in candidates.into_iter().enumerate() {
        let rank_score = 1.0 / (rank + 1) as f32;
        let entry = merged
            .entry(candidate.memory_id.clone())
            .or_insert_with(|| SemanticCandidateGroup {
                memory_id: candidate.memory_id.clone(),
                reciprocal_rank_score: 0.0,
                hit_count: 0,
                best_rank: rank,
                max_importance: candidate.importance,
                newest_created_at: candidate.created_at,
            });
        entry.reciprocal_rank_score += rank_score;
        entry.hit_count += 1;
        entry.best_rank = entry.best_rank.min(rank);
        entry.max_importance = entry.max_importance.max(candidate.importance);
        entry.newest_created_at = entry.newest_created_at.max(candidate.created_at);
    }

    let mut merged = merged.into_values().collect::<Vec<_>>();
    merged.sort_by(|left, right| {
        right
            .reciprocal_rank_score
            .total_cmp(&left.reciprocal_rank_score)
            .then(right.hit_count.cmp(&left.hit_count))
            .then(left.best_rank.cmp(&right.best_rank))
            .then(right.max_importance.total_cmp(&left.max_importance))
            .then(right.newest_created_at.cmp(&left.newest_created_at))
    });
    merged
}

async fn resolve_semantic_candidate(
    storage: &Storage,
    memory_id: &str,
) -> Result<Option<MemoryView>> {
    let memory_id = MemoryId::from_str(memory_id)?;
    get(storage, &memory_id.to_string()).await
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use ulid::Ulid;

    use super::{merge_semantic_candidates, recall};
    use crate::format::observing::{
        MemoryCategory, ObservedMemory, ObservingCheckpoint, ObservingSnapshot,
    };
    use crate::format::semantic_index::SemanticIndexRow;
    use crate::format::session::SessionTurn;
    use crate::llm::config::llm_test_env_guard;
    use crate::llm::embedding::embed_text;
    use crate::observer::observing::SnapshotContent;
    use crate::observer::types::LlmFieldUpdate;
    use crate::storage::Storage;

    fn test_storage() -> Storage {
        Storage::local(crate::config::data_root().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn recall_prefers_semantic_index_over_substring_matches() {
        let _guard = llm_test_env_guard();
        let home = tempfile::tempdir().unwrap();
        let home_dir = home.path().join("munnai");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::write(
            home_dir.join("settings.json"),
            r#"{
              "semanticIndex": {
                "embedding": {
                  "provider": "mock",
                  "dimensions": 4
                },
                "defaultImportance": 0.7
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNNAI_HOME", &home_dir);
        }

        let storage = test_storage();
        let now = Utc::now();
        let snapshot_id = Ulid::new().to_string();
        let observed_memory = ObservedMemory {
            id: Some("mem-1".to_string()),
            text: "beta".to_string(),
            category: MemoryCategory::Fact,
            updated_memory: None,
        };
        let snapshot_content = SnapshotContent {
            memories: vec![observed_memory.clone()],
            open_questions: vec![],
            next_steps: vec![],
            memory_delta: LlmFieldUpdate::new(vec![], vec![observed_memory]),
        };
        let observing = ObservingSnapshot {
            snapshot_id: snapshot_id.clone(),
            observing_id: "OBS-1".to_string(),
            snapshot_sequence: 0,
            created_at: now,
            updated_at: now,
            observer: "observer-a".to_string(),
            title: "alpha title".to_string(),
            summary: "alpha summary".to_string(),
            content: serde_json::to_string_pretty(&snapshot_content).unwrap(),
            references: vec!["SESSION:ref-1".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 0,
                indexed_snapshot_sequence: Some(0),
            },
        };
        storage.observings().upsert(vec![observing]).await.unwrap();

        let row = SemanticIndexRow {
            id: "mem-1".to_string(),
            memory_id: format!("OBSERVING:{snapshot_id}"),
            text: "beta".to_string(),
            vector: embed_text("beta").await.unwrap(),
            importance: 0.7,
            category: "fact".to_string(),
            created_at: now,
        };
        storage.semantic_index().upsert(vec![row]).await.unwrap();

        let recalled = recall(&storage, "beta", 10).await.unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(
            recalled[0].memory_id.to_string(),
            format!("OBSERVING:{snapshot_id}")
        );
        assert_eq!(recalled[0].title.as_deref(), Some("alpha title"));
        assert_eq!(recalled[0].summary.as_deref(), Some("alpha summary"));

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }

    #[tokio::test]
    async fn recall_preserves_recent_session_hits_when_semantic_results_reach_limit() {
        let _guard = llm_test_env_guard();
        let home = tempfile::tempdir().unwrap();
        let home_dir = home.path().join("munnai");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::write(
            home_dir.join("settings.json"),
            r#"{
              "semanticIndex": {
                "embedding": {
                  "provider": "mock",
                  "dimensions": 4
                },
                "defaultImportance": 0.7
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNNAI_HOME", &home_dir);
        }

        let storage = test_storage();
        let now = Utc::now();
        let older_snapshot_id = Ulid::new().to_string();
        let newer_snapshot_id = Ulid::new().to_string();
        let session_turn_id = Ulid::new().to_string();

        let older_observing = ObservingSnapshot {
            snapshot_id: older_snapshot_id.clone(),
            observing_id: "OBS-OLDER".to_string(),
            snapshot_sequence: 0,
            created_at: now - Duration::hours(2),
            updated_at: now - Duration::hours(2),
            observer: "observer-a".to_string(),
            title: "older semantic".to_string(),
            summary: "older semantic summary".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["SESSION:older".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 0,
                indexed_snapshot_sequence: Some(0),
            },
        };
        let newer_observing = ObservingSnapshot {
            snapshot_id: newer_snapshot_id.clone(),
            observing_id: "OBS-NEWER".to_string(),
            snapshot_sequence: 0,
            created_at: now - Duration::hours(1),
            updated_at: now - Duration::hours(1),
            observer: "observer-a".to_string(),
            title: "newer semantic".to_string(),
            summary: "newer semantic summary".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["SESSION:newer".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 0,
                indexed_snapshot_sequence: Some(0),
            },
        };
        storage
            .observings()
            .upsert(vec![older_observing, newer_observing])
            .await
            .unwrap();

        let session_turn = SessionTurn {
            turn_id: session_turn_id.clone(),
            created_at: now,
            updated_at: now,
            session_id: Some("group-a".to_string()),
            agent: "agent-a".to_string(),
            observer: "observer-a".to_string(),
            title: Some("session beta".to_string()),
            summary: Some("session beta summary".to_string()),
            title_source: None,
            summary_source: None,
            tool_calling: None,
            artifacts: None,
            prompt: Some("beta prompt".to_string()),
            response: Some("beta response".to_string()),
            observing_epoch: None,
        };
        storage.sessions().upsert(vec![session_turn]).await.unwrap();

        storage
            .semantic_index()
            .upsert(vec![
                SemanticIndexRow {
                    id: "mem-older".to_string(),
                    memory_id: format!("OBSERVING:{older_snapshot_id}"),
                    text: "beta older".to_string(),
                    vector: embed_text("beta").await.unwrap(),
                    importance: 0.7,
                    category: "fact".to_string(),
                    created_at: now - Duration::hours(2),
                },
                SemanticIndexRow {
                    id: "mem-newer".to_string(),
                    memory_id: format!("OBSERVING:{newer_snapshot_id}"),
                    text: "beta newer".to_string(),
                    vector: embed_text("beta").await.unwrap(),
                    importance: 0.7,
                    category: "fact".to_string(),
                    created_at: now - Duration::hours(1),
                },
            ])
            .await
            .unwrap();

        let recalled = recall(&storage, "beta", 2).await.unwrap();
        assert_eq!(recalled.len(), 2);
        assert_eq!(
            recalled[0].memory_id.to_string(),
            format!("OBSERVING:{newer_snapshot_id}")
        );
        assert_eq!(
            recalled[1].memory_id.to_string(),
            format!("SESSION:{session_turn_id}")
        );

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }

    #[tokio::test]
    async fn recall_merges_results_using_recency_window_order() {
        let _guard = llm_test_env_guard();
        let home = tempfile::tempdir().unwrap();
        let home_dir = home.path().join("munnai");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::write(
            home_dir.join("settings.json"),
            r#"{
              "semanticIndex": {
                "embedding": {
                  "provider": "mock",
                  "dimensions": 4
                },
                "defaultImportance": 0.7
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNNAI_HOME", &home_dir);
        }

        let storage = test_storage();
        let now = Utc::now();
        let semantic_snapshot_id = Ulid::new().to_string();
        let session_old_id = Ulid::new().to_string();
        let session_new_id = Ulid::new().to_string();

        storage
            .observings()
            .upsert(vec![ObservingSnapshot {
                snapshot_id: semantic_snapshot_id.clone(),
                observing_id: "OBS-RECENCY".to_string(),
                snapshot_sequence: 0,
                created_at: now - Duration::hours(3),
                updated_at: now - Duration::hours(3),
                observer: "observer-a".to_string(),
                title: "semantic old".to_string(),
                summary: "semantic old summary".to_string(),
                content: "{\"memories\":[]}".to_string(),
                references: vec!["SESSION:semantic".to_string()],
                checkpoint: ObservingCheckpoint {
                    observing_epoch: 0,
                    indexed_snapshot_sequence: Some(0),
                },
            }])
            .await
            .unwrap();
        storage
            .sessions()
            .upsert(vec![
                SessionTurn {
                    turn_id: session_old_id.clone(),
                    created_at: now - Duration::hours(2),
                    updated_at: now - Duration::hours(2),
                    session_id: Some("group-a".to_string()),
                    agent: "agent-a".to_string(),
                    observer: "observer-a".to_string(),
                    title: Some("session beta old".to_string()),
                    summary: Some("session beta old summary".to_string()),
                    title_source: None,
                    summary_source: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("beta old prompt".to_string()),
                    response: Some("beta old response".to_string()),
                    observing_epoch: None,
                },
                SessionTurn {
                    turn_id: session_new_id.clone(),
                    created_at: now - Duration::hours(1),
                    updated_at: now - Duration::hours(1),
                    session_id: Some("group-b".to_string()),
                    agent: "agent-a".to_string(),
                    observer: "observer-a".to_string(),
                    title: Some("session beta new".to_string()),
                    summary: Some("session beta new summary".to_string()),
                    title_source: None,
                    summary_source: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("beta new prompt".to_string()),
                    response: Some("beta new response".to_string()),
                    observing_epoch: None,
                },
            ])
            .await
            .unwrap();
        storage
            .semantic_index()
            .upsert(vec![SemanticIndexRow {
                id: "mem-recency".to_string(),
                memory_id: format!("OBSERVING:{semantic_snapshot_id}"),
                text: "beta semantic".to_string(),
                vector: embed_text("beta").await.unwrap(),
                importance: 0.7,
                category: "fact".to_string(),
                created_at: now - Duration::hours(3),
            }])
            .await
            .unwrap();

        let recalled = recall(&storage, "beta", 2).await.unwrap();
        assert_eq!(recalled.len(), 2);
        assert_eq!(
            recalled[0].memory_id.to_string(),
            format!("SESSION:{session_old_id}")
        );
        assert_eq!(
            recalled[1].memory_id.to_string(),
            format!("SESSION:{session_new_id}")
        );

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }

    #[tokio::test]
    async fn recall_expands_semantic_window_until_limit_unique_memories() {
        let _guard = llm_test_env_guard();
        let home = tempfile::tempdir().unwrap();
        let home_dir = home.path().join("munnai");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::write(
            home_dir.join("settings.json"),
            r#"{
              "semanticIndex": {
                "embedding": {
                  "provider": "mock",
                  "dimensions": 4
                },
                "defaultImportance": 0.7
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNNAI_HOME", &home_dir);
        }

        let storage = test_storage();
        let now = Utc::now();
        let snapshot_a = Ulid::new().to_string();
        let snapshot_b = Ulid::new().to_string();

        for (index, (snapshot_id, observing_id, title)) in [
            (snapshot_a.clone(), "OBS-A", "alpha title"),
            (snapshot_b.clone(), "OBS-B", "beta title"),
        ]
        .into_iter()
        .enumerate()
        {
            let created_at = now + Duration::minutes(index as i64);
            let observing = ObservingSnapshot {
                snapshot_id: snapshot_id.clone(),
                observing_id: observing_id.to_string(),
                snapshot_sequence: 0,
                created_at,
                updated_at: created_at,
                observer: "observer-a".to_string(),
                title: title.to_string(),
                summary: format!("{title} summary"),
                content: serde_json::to_string_pretty(&SnapshotContent {
                    memories: vec![],
                    open_questions: vec![],
                    next_steps: vec![],
                    memory_delta: LlmFieldUpdate::new(vec![], vec![]),
                })
                .unwrap(),
                references: vec!["SESSION:ref".to_string()],
                checkpoint: ObservingCheckpoint {
                    observing_epoch: 0,
                    indexed_snapshot_sequence: Some(0),
                },
            };
            storage.observings().upsert(vec![observing]).await.unwrap();
        }

        let mut rows = Vec::new();
        for index in 0..8 {
            rows.push(SemanticIndexRow {
                id: format!("chunk-a-{index}"),
                memory_id: format!("OBSERVING:{snapshot_a}"),
                text: format!("alpha segment {index}"),
                vector: embed_text("alpha").await.unwrap(),
                importance: 0.7,
                category: "fact".to_string(),
                created_at: now,
            });
        }
        rows.push(SemanticIndexRow {
            id: "chunk-b-0".to_string(),
            memory_id: format!("OBSERVING:{snapshot_b}"),
            text: "beta segment".to_string(),
            vector: embed_text("alpha").await.unwrap(),
            importance: 0.6,
            category: "fact".to_string(),
            created_at: now,
        });
        storage.semantic_index().upsert(rows).await.unwrap();

        let recalled = recall(&storage, "alpha", 2).await.unwrap();
        assert_eq!(recalled.len(), 2);
        assert_eq!(
            recalled[0].memory_id.to_string(),
            format!("OBSERVING:{snapshot_a}")
        );
        assert_eq!(
            recalled[1].memory_id.to_string(),
            format!("OBSERVING:{snapshot_b}")
        );

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }

    #[test]
    fn merge_semantic_candidates_combines_shared_memory_hits() {
        let now = Utc::now();
        let merged = merge_semantic_candidates(vec![
            SemanticIndexRow {
                id: "chunk-a-1".to_string(),
                memory_id: "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZA".to_string(),
                text: "alpha".to_string(),
                vector: vec![1.0, 0.0, 0.0, 0.0],
                importance: 0.4,
                category: "fact".to_string(),
                created_at: now,
            },
            SemanticIndexRow {
                id: "chunk-b-1".to_string(),
                memory_id: "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZB".to_string(),
                text: "beta".to_string(),
                vector: vec![0.0, 1.0, 0.0, 0.0],
                importance: 0.9,
                category: "fact".to_string(),
                created_at: now,
            },
            SemanticIndexRow {
                id: "chunk-a-2".to_string(),
                memory_id: "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZA".to_string(),
                text: "alpha more".to_string(),
                vector: vec![1.0, 0.0, 0.0, 0.0],
                importance: 0.8,
                category: "fact".to_string(),
                created_at: now,
            },
        ]);

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].memory_id, "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZA");
        assert_eq!(merged[0].hit_count, 2);
        assert!(merged[0].reciprocal_rank_score > merged[1].reciprocal_rank_score);
        assert_eq!(merged[1].memory_id, "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZB");
    }
}
