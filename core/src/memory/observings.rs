use std::collections::HashMap;

use lance::{Error, Result};

use crate::format::memory::{MemoryId, MemoryLayer};
use crate::format::observing::ObservingSnapshot;
use crate::memory::types::ListMode;
use crate::storage::Storage;

#[derive(Debug, Clone)]
pub struct ObservingListQuery {
    pub mode: ListMode,
    pub observer: Option<String>,
}

pub async fn get(storage: &Storage, memory_id: &MemoryId) -> Result<Option<ObservingSnapshot>> {
    ensure_observing_memory_id(memory_id)?;
    let snapshot_id = memory_id.memory_point().to_string();
    storage.observings().get(&snapshot_id).await
}

pub async fn list(storage: &Storage, query: ObservingListQuery) -> Result<Vec<ObservingSnapshot>> {
    let observings = storage.observings().list(query.observer.as_deref()).await?;

    Ok(apply_list_mode(observings, query.mode))
}

pub(crate) async fn timeline(
    storage: &Storage,
    memory_id: &MemoryId,
    before_limit: usize,
    after_limit: usize,
) -> Result<Vec<ObservingSnapshot>> {
    ensure_observing_memory_id(memory_id)?;
    let snapshot_id = memory_id.memory_point().to_string();
    let mut observings = storage.observings().list(None).await?;
    let Some(anchor) = observings
        .iter()
        .find(|observing| observing.snapshot_id == snapshot_id)
    else {
        return Ok(Vec::new());
    };
    let observing_id = anchor.observing_id.clone();
    observings.retain(|observing| observing.observing_id == observing_id);
    observings.sort_by(|left, right| {
        left.snapshot_sequence
            .cmp(&right.snapshot_sequence)
            .then(left.created_at.cmp(&right.created_at))
    });

    let Some(anchor_index) = observings
        .iter()
        .position(|observing| observing.snapshot_id == snapshot_id)
    else {
        return Ok(Vec::new());
    };
    let start = anchor_index.saturating_sub(before_limit);
    let end = (anchor_index + after_limit + 1).min(observings.len());
    Ok(observings[start..end].to_vec())
}

pub(crate) async fn recall(
    storage: &Storage,
    query: &str,
    limit: usize,
) -> Result<Vec<ObservingSnapshot>> {
    let query_lower = query.to_lowercase();
    let mut observings = storage.observings().list(None).await?;
    observings.retain(|observing| {
        matches_query(Some(observing.title.as_str()), &query_lower)
            || matches_query(Some(observing.summary.as_str()), &query_lower)
            || matches_query(Some(observing.content.as_str()), &query_lower)
    });
    observings.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(right.snapshot_sequence.cmp(&left.snapshot_sequence))
    });
    observings.truncate(limit);
    Ok(observings)
}

fn ensure_observing_memory_id(memory_id: &MemoryId) -> Result<()> {
    if memory_id.memory_layer() != MemoryLayer::Observing {
        return Err(Error::invalid_input(format!(
            "invalid memory layer for observing lookup: {}",
            memory_id.memory_layer()
        )));
    }
    Ok(())
}

fn apply_list_mode(observings: Vec<ObservingSnapshot>, mode: ListMode) -> Vec<ObservingSnapshot> {
    let mut latest_by_observing_id = HashMap::<String, ObservingSnapshot>::new();
    for observing in observings {
        latest_by_observing_id
            .entry(observing.observing_id.clone())
            .and_modify(|current| {
                if observing.snapshot_sequence > current.snapshot_sequence
                    || (observing.snapshot_sequence == current.snapshot_sequence
                        && observing.created_at > current.created_at)
                {
                    *current = observing.clone();
                }
            })
            .or_insert(observing);
    }

    let mut latest = latest_by_observing_id.into_values().collect::<Vec<_>>();
    match mode {
        ListMode::Recency { limit } => {
            latest.sort_by(|left, right| {
                right
                    .created_at
                    .cmp(&left.created_at)
                    .then(right.snapshot_sequence.cmp(&left.snapshot_sequence))
            });
            latest.truncate(limit);
            latest.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then(left.snapshot_sequence.cmp(&right.snapshot_sequence))
            });
            latest
        }
        ListMode::Page { offset, limit } => {
            latest.sort_by(|left, right| {
                right
                    .created_at
                    .cmp(&left.created_at)
                    .then(right.snapshot_sequence.cmp(&left.snapshot_sequence))
            });
            latest.into_iter().skip(offset).take(limit).collect()
        }
    }
}

fn matches_query(value: Option<&str>, query_lower: &str) -> bool {
    value
        .map(|value| value.to_lowercase().contains(query_lower))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use ulid::Ulid;

    use super::recall;
    use crate::format::observing::{ObservingCheckpoint, ObservingSnapshot};
    use crate::storage::Storage;

    fn test_storage() -> Storage {
        Storage::local(crate::config::data_root().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn recall_does_not_match_reference_only_queries() {
        let home = tempfile::tempdir().unwrap();
        let home_dir = home.path().join("munnai");
        std::fs::create_dir_all(&home_dir).unwrap();
        unsafe {
            std::env::set_var("MUNNAI_HOME", &home_dir);
        }

        let storage = test_storage();
        let now = Utc::now();
        let observing = ObservingSnapshot {
            snapshot_id: Ulid::new().to_string(),
            observing_id: "OBS-1".to_string(),
            snapshot_sequence: 0,
            created_at: now,
            updated_at: now,
            observer: "observer-a".to_string(),
            title: "release plan".to_string(),
            summary: "shipping prep".to_string(),
            content: "discussion about rollout".to_string(),
            references: vec!["SESSION:secret-keyword".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 0,
                indexed_snapshot_sequence: Some(0),
            },
        };
        storage.observings().upsert(vec![observing]).await.unwrap();

        let recalled = recall(&storage, "secret-keyword", 10).await.unwrap();
        assert!(recalled.is_empty());

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }
}
