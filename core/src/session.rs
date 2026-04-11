use std::collections::HashMap;
#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicI64, Ordering};
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

use lance::{Error, Result};
#[cfg(test)]
use serde::{Deserialize, Serialize};
#[cfg(test)]
use tokio::sync::Mutex;

use crate::format::session::SessionTurn;
#[cfg(test)]
use crate::format::session::TurnMetadataSource;
#[cfg(test)]
use crate::llm::turn::TurnGenerator;
#[cfg(test)]
use crate::observer::runtime::ObservingWindow;

mod key;
#[cfg(test)]
mod registry;
#[cfg(test)]
mod update;

pub(crate) use key::SessionKey;
#[cfg(test)]
pub(crate) use registry::SessionRegistry;
#[cfg(test)]
pub(crate) use update::SessionUpdate;

#[cfg(test)]
pub struct Session {
    key: SessionKey,
    table: Arc<crate::format::SessionTable>,
    open_turn: Mutex<Option<SessionTurn>>,
    last_used: AtomicI64,
}

#[derive(Debug, Clone)]
pub(crate) struct OpenTurnReconciliation {
    pub(crate) canonical_turn: SessionTurn,
    pub(crate) discarded_turn_ids: Vec<crate::format::MemoryId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(test)]
pub(crate) struct ResolvedTurnMetadata {
    pub(crate) title: Option<String>,
    pub(crate) title_source: Option<TurnMetadataSource>,
    pub(crate) summary: Option<String>,
    pub(crate) summary_source: Option<TurnMetadataSource>,
}

#[cfg(test)]
impl Session {
    pub(crate) fn new(
        key: SessionKey,
        table: Arc<crate::format::SessionTable>,
        open_turn: Option<SessionTurn>,
    ) -> Result<Self> {
        if let Some(turn) = open_turn.as_ref() {
            if turn.session_key() != key {
                return Err(Error::invalid_input(
                    "open turn session key does not match session",
                ));
            }
            if !turn.is_open() {
                return Err(Error::invalid_input(
                    "open turn must not contain a response",
                ));
            }
        }
        Ok(Self {
            key,
            table,
            open_turn: Mutex::new(open_turn),
            last_used: AtomicI64::new(current_timestamp()),
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) async fn open_turn(&self) -> Option<SessionTurn> {
        self.open_turn.lock().await.clone()
    }

    pub(crate) async fn preview_prompt(&self, incoming: Option<&str>) -> Option<String> {
        let open_turn = self.open_turn.lock().await;
        let current = open_turn
            .as_ref()
            .filter(|turn| turn.is_open())
            .and_then(|turn| turn.prompt.as_deref());
        merge_prompt(current, incoming)
    }

    pub(crate) async fn accept(
        &self,
        turn_content: crate::test_support::TurnContent,
        window: &ObservingWindow,
    ) -> Result<SessionTurn> {
        self.touch();
        let mut update = SessionUpdate::from(self, turn_content, window.observer().to_string()).await?;
        update.observing_epoch = Some(window.epoch());
        self.apply(update).await
    }

    pub(crate) async fn apply(&self, update: SessionUpdate) -> Result<SessionTurn> {
        if self.key != update.session_key() {
            return Err(Error::invalid_input(
                "message session does not match session",
            ));
        }

        let mut open_turn = self.open_turn.lock().await;
        let mut turn = if let Some(open_turn) = open_turn.take() {
            open_turn
        } else {
            SessionTurn::new_pending(&update)
        };
        turn.merge(&update)?;
        if turn.observable() {
            turn.observing_epoch = update.observing_epoch;
        }
        if turn.turn_id.memory_point() == u64::MAX {
            self.table.insert(std::slice::from_mut(&mut turn)).await?;
        } else {
            self.table.update(std::slice::from_ref(&turn)).await?;
        }

        if turn.is_open() {
            *open_turn = Some(turn.clone());
        } else {
            *open_turn = None;
        }
        self.touch();

        Ok(turn)
    }

    pub(crate) fn touch(&self) {
        self.last_used.store(current_timestamp(), Ordering::Relaxed);
    }

    pub(crate) fn expired(&self, max_idle_secs: i64) -> bool {
        current_timestamp() - self.last_used.load(Ordering::Relaxed) > max_idle_secs
    }
}

#[cfg(test)]
pub(crate) async fn resolve_turn_metadata(
    prompt: Option<&str>,
    title: Option<String>,
    summary: Option<String>,
    response: Option<&str>,
) -> ResolvedTurnMetadata {
    let mut title = sanitized_text(title);
    let mut summary = sanitized_text(summary);
    let mut title_source = title.as_ref().map(|_| TurnMetadataSource::User);
    let mut summary_source = summary.as_ref().map(|_| TurnMetadataSource::User);
    let response = response.filter(|value| !value.trim().is_empty());
    let prompt = prompt.filter(|value| !value.trim().is_empty());

    if let (Some(prompt), Some(response)) = (prompt, response) {
        if title.is_none() || summary.is_none() {
            if let Ok(Some(generated)) =
                TurnGenerator::generate_if_configured(Some(prompt), response).await
            {
                if title.is_none() && !generated.title.trim().is_empty() {
                    title = Some(generated.title);
                    title_source = Some(TurnMetadataSource::Generated);
                }
                if summary.is_none() && !generated.summary.trim().is_empty() {
                    summary = Some(generated.summary);
                    summary_source = Some(TurnMetadataSource::Generated);
                }
            }
        }
        if summary.is_none() {
            summary = Some(format!("{}\n\n{}", prompt.trim(), response.trim()));
            summary_source = Some(TurnMetadataSource::Fallback);
        }
    }

    ResolvedTurnMetadata {
        title,
        title_source,
        summary,
        summary_source,
    }
}

pub(crate) fn has_text_content(value: Option<&str>) -> bool {
    value.map(|value| !value.trim().is_empty()).unwrap_or(false)
}

pub(crate) fn merge_prompt(current: Option<&str>, incoming: Option<&str>) -> Option<String> {
    let current = current.filter(|value| !value.trim().is_empty());
    let incoming = incoming.filter(|value| !value.trim().is_empty());
    match (current, incoming) {
        (Some(current), Some(incoming)) if current == incoming => Some(current.to_string()),
        (Some(current), Some(incoming)) => Some(format!("{current}\n\n{incoming}")),
        (Some(current), None) => Some(current.to_string()),
        (None, Some(incoming)) => Some(incoming.to_string()),
        (None, None) => None,
    }
}

pub(crate) fn merge_tool_calling(
    current: &mut Option<Vec<String>>,
    incoming: Option<&Vec<String>>,
) {
    let Some(incoming) = incoming else {
        return;
    };
    if incoming.is_empty() {
        return;
    }
    let current_values = current.get_or_insert_with(Vec::new);
    current_values.extend(incoming.iter().cloned());
}

pub(crate) fn merge_artifacts(
    current: &mut Option<HashMap<String, String>>,
    incoming: Option<&HashMap<String, String>>,
) {
    let Some(incoming) = incoming else {
        return;
    };
    if incoming.is_empty() {
        return;
    }
    let current_values = current.get_or_insert_with(HashMap::new);
    for (key, value) in incoming {
        current_values.insert(key.clone(), value.clone());
    }
}

#[cfg(test)]
fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
pub(crate) fn merge_metadata_field(
    current: &mut Option<String>,
    current_source: &mut Option<TurnMetadataSource>,
    incoming: Option<&str>,
    incoming_source: Option<TurnMetadataSource>,
) {
    let Some(incoming) = incoming.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let should_replace =
        !has_text_content(current.as_deref()) || incoming_source >= *current_source;
    if should_replace {
        *current = Some(incoming.to_string());
        *current_source = incoming_source;
    }
}

pub(crate) fn reconcile_open_turns(turns: Vec<SessionTurn>) -> Result<OpenTurnReconciliation> {
    if turns.is_empty() {
        return Err(Error::invalid_input(
            "open turn reconciliation requires turns",
        ));
    }

    let mut sorted = turns;
    sorted.sort_by(|left, right| left.turn_id.cmp(&right.turn_id));
    let expected_key = sorted[0].session_key();
    if sorted
        .iter()
        .any(|turn| turn.session_key() != expected_key || !turn.is_open())
    {
        return Err(Error::invalid_input(
            "open turn reconciliation requires turns from one open session",
        ));
    }

    let mut canonical_turn = sorted
        .last()
        .cloned()
        .expect("sorted turns should contain canonical turn");
    let discarded_turn_ids = sorted[..sorted.len() - 1]
        .iter()
        .map(|turn| turn.turn_id)
        .collect::<Vec<_>>();

    let mut merged_prompt = None;
    let mut merged_tool_calling = None;
    let mut merged_artifacts = None;
    let mut latest_updated_at = canonical_turn.updated_at;
    for turn in &sorted {
        merged_prompt = merge_prompt(merged_prompt.as_deref(), turn.prompt.as_deref());
        merge_tool_calling(&mut merged_tool_calling, turn.tool_calling.as_ref());
        merge_artifacts(&mut merged_artifacts, turn.artifacts.as_ref());
        if turn.updated_at > latest_updated_at {
            latest_updated_at = turn.updated_at;
        }
    }

    canonical_turn.prompt = merged_prompt;
    canonical_turn.tool_calling = merged_tool_calling;
    canonical_turn.artifacts = merged_artifacts;
    canonical_turn.response = None;
    canonical_turn.observing_epoch = None;
    canonical_turn.updated_at = latest_updated_at;

    Ok(OpenTurnReconciliation {
        canonical_turn,
        discarded_turn_ids,
    })
}

#[cfg(test)]
fn sanitized_text(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}
