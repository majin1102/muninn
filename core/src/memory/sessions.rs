use lance::{Error, Result};

use crate::format::memory::{MemoryId, MemoryLayer};
use crate::format::session::{SessionKey, SessionTurn};
use crate::memory::types::ListMode;
use crate::storage::{SessionSelect, Storage};

#[derive(Debug, Clone)]
pub struct SessionListQuery {
    pub mode: ListMode,
    pub agent: Option<String>,
    pub session_id: Option<String>,
}

pub async fn get(storage: &Storage, memory_id: &MemoryId) -> Result<Option<SessionTurn>> {
    ensure_session_memory_id(memory_id)?;
    storage.sessions().get_turn(memory_id.memory_point()).await
}

pub async fn list(storage: &Storage, query: SessionListQuery) -> Result<Vec<SessionTurn>> {
    let turns = storage
        .sessions()
        .select(SessionSelect::Filter {
            agent: query.agent.clone(),
            session_id: query.session_id.clone(),
        })
        .await?;
    Ok(apply_list_mode(turns, query.mode))
}

pub(crate) async fn timeline(
    storage: &Storage,
    memory_id: &MemoryId,
    before_limit: usize,
    after_limit: usize,
) -> Result<Vec<SessionTurn>> {
    ensure_session_memory_id(memory_id)?;
    let Some(anchor) = storage.sessions().get_turn(memory_id.memory_point()).await? else {
        return Ok(Vec::new());
    };
    let turns = storage
        .sessions()
        .load_session_turns(&anchor.session_key())
        .await?;

    Ok(timeline_from_source(
        &turns,
        *memory_id,
        before_limit,
        after_limit,
        &anchor.session_key(),
    )
    .unwrap_or_default())
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

pub(crate) fn render_session_turn_detail(turn: &SessionTurn) -> Option<String> {
    let mut lines = Vec::new();
    if let Some(prompt) = turn
        .prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("Prompt: {prompt}"));
    }
    if let Some(response) = turn
        .response
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("Response: {response}"));
    }
    if let Some(tool_calling) = turn
        .tool_calling
        .as_ref()
        .filter(|entries| !entries.is_empty())
    {
        lines.push(format!("Tools: {}", tool_calling.join(", ")));
    }
    if let Some(artifacts) = turn
        .artifacts
        .as_ref()
        .filter(|entries| !entries.is_empty())
    {
        let mut entries = artifacts.iter().collect::<Vec<_>>();
        entries.sort_by(|left, right| left.0.cmp(right.0));
        let rendered = entries
            .into_iter()
            .map(|(key, value)| format!("{key}: {value}"))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Artifacts: {rendered}"));
    }

    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

pub(crate) fn timeline_from_source(
    turns: &[SessionTurn],
    memory_id: MemoryId,
    before_limit: usize,
    after_limit: usize,
    session: &SessionKey,
) -> Option<Vec<SessionTurn>> {
    let mut filtered = turns
        .iter()
        .filter(|turn| turn.session_key().same_group_as(session))
        .cloned()
        .collect::<Vec<SessionTurn>>();
    filtered.sort_by(|left, right| left.created_at.cmp(&right.created_at));

    let anchor_index = filtered.iter().position(|turn| turn.turn_id == memory_id)?;
    let start = anchor_index.saturating_sub(before_limit);
    let end = (anchor_index + after_limit + 1).min(filtered.len());
    Some(filtered[start..end].to_vec())
}
