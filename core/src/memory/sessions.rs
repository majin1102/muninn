use lance::{Error, Result};

use crate::format::{MemoryId, MemoryLayer, SessionTable, SessionTurn, TableOptions};
use crate::memory::types::ListMode;

pub(crate) async fn get(
    table_options: &TableOptions,
    memory_id: &MemoryId,
) -> Result<Option<SessionTurn>> {
    ensure_session_memory_id(memory_id)?;
    SessionTable::new(table_options.clone())
        .get_turn(memory_id.memory_point())
        .await
}

pub(crate) async fn timeline(
    table_options: &TableOptions,
    memory_id: &MemoryId,
    before_limit: usize,
    after_limit: usize,
) -> Result<Vec<SessionTurn>> {
    ensure_session_memory_id(memory_id)?;
    SessionTable::new(table_options.clone())
        .timeline_turns(*memory_id, before_limit, after_limit)
        .await
}

fn ensure_session_memory_id(memory_id: &MemoryId) -> Result<()> {
    if memory_id.memory_layer() != MemoryLayer::Session {
        return Err(Error::invalid_input(format!(
            "invalid memory layer for session lookup: {}",
            memory_id.memory_layer()
        )));
    }
    Ok(())
}

pub(crate) fn apply_list_mode(mut turns: Vec<SessionTurn>, mode: ListMode) -> Vec<SessionTurn> {
    turns.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    match mode {
        ListMode::Recency { limit } => {
            turns.truncate(limit);
            turns.sort_by(|left, right| left.created_at.cmp(&right.created_at));
            turns
        }
        ListMode::Page { offset, limit } => turns.into_iter().skip(offset).take(limit).collect(),
    }
}
