use std::collections::HashMap;

use lance::{Error, Result};

use crate::format::memory::observing::ObservingSnapshot;
use crate::format::memory::{MemoryId, MemoryLayer};
use crate::format::table::{ObservingTable, TableOptions};
use crate::memory::types::ListMode;

#[derive(Debug, Clone)]
pub struct ObservingListQuery {
    pub mode: ListMode,
    pub observer: Option<String>,
}

pub async fn get(
    table_options: &TableOptions,
    memory_id: &MemoryId,
) -> Result<Option<ObservingSnapshot>> {
    ensure_observing_memory_id(memory_id)?;
    ObservingTable::new(table_options.clone())
        .get(memory_id.memory_point())
        .await
}

pub async fn list(
    table_options: &TableOptions,
    query: ObservingListQuery,
) -> Result<Vec<ObservingSnapshot>> {
    let observings = ObservingTable::new(table_options.clone())
        .list(query.observer.as_deref())
        .await?;

    Ok(apply_list_mode(observings, query.mode))
}

pub(crate) async fn timeline(
    table_options: &TableOptions,
    memory_id: &MemoryId,
    before_limit: usize,
    after_limit: usize,
) -> Result<Vec<ObservingSnapshot>> {
    ensure_observing_memory_id(memory_id)?;
    let table = ObservingTable::new(table_options.clone());
    let Some(anchor) = table.get(memory_id.memory_point()).await? else {
        return Ok(Vec::new());
    };
    let mut observings = table.load_thread_snapshots(&anchor.observing_id).await?;
    observings.sort_by(|left, right| {
        left.snapshot_sequence
            .cmp(&right.snapshot_sequence)
            .then(left.created_at.cmp(&right.created_at))
    });

    let Some(anchor_index) = observings
        .iter()
        .position(|observing| observing.snapshot_id == *memory_id)
    else {
        return Ok(Vec::new());
    };
    let start = anchor_index.saturating_sub(before_limit);
    let end = (anchor_index + after_limit + 1).min(observings.len());
    Ok(observings[start..end].to_vec())
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
