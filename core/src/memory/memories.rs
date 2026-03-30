use std::str::FromStr;

use lance::{Error, Result};

use crate::format::memory::{MemoryId, MemoryLayer};
use crate::format::observing::ObservingSnapshot;
use crate::format::session::SessionTurn;
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
    let turns = sessions::recall(storage, query, limit).await?;
    let observings = observings::recall(storage, query, limit).await?;
    combine_rendered_window(
        render_session_turns(turns)?,
        render_observings(observings)?,
        ListMode::Recency { limit },
    )
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
