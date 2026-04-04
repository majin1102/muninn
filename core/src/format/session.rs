use chrono::{DateTime, Utc};
use lance::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::format::memory::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnMetadataSource {
    Fallback,
    Generated,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum SessionKey {
    Session {
        session_id: String,
        agent: String,
        observer: String,
    },
    Agent {
        agent: String,
        observer: String,
    },
    Observer {
        observer: String,
    },
}

#[derive(Debug, Clone)]
pub struct Session {
    key: SessionKey,
    open_turn: Option<SessionTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurn {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub turn_id: MemoryId,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(rename = "session_id")]
    pub session_id: Option<String>,
    pub agent: String,
    pub observer: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    #[serde(default, skip_serializing, skip_deserializing)]
    pub(crate) title_source: Option<TurnMetadataSource>,
    #[serde(default, skip_serializing, skip_deserializing)]
    pub(crate) summary_source: Option<TurnMetadataSource>,
    pub tool_calling: Option<Vec<String>>,
    pub artifacts: Option<HashMap<String, String>>,
    pub prompt: Option<String>,
    pub response: Option<String>,
    pub observing_epoch: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SessionWrite {
    pub session_id: Option<String>,
    pub agent: String,
    pub observer: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub(crate) title_source: Option<TurnMetadataSource>,
    pub(crate) summary_source: Option<TurnMetadataSource>,
    pub tool_calling: Option<Vec<String>>,
    pub artifacts: Option<HashMap<String, String>>,
    pub prompt: Option<String>,
    pub response: Option<String>,
}

impl SessionKey {
    pub(crate) fn from_parts(session_id: Option<&str>, agent: &str, observer: &str) -> Self {
        if let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) {
            return Self::Session {
                session_id: session_id.to_string(),
                agent: agent.to_string(),
                observer: observer.to_string(),
            };
        }
        if !agent.trim().is_empty() {
            return Self::Agent {
                agent: agent.to_string(),
                observer: observer.to_string(),
            };
        }
        Self::Observer {
            observer: observer.to_string(),
        }
    }

    pub(crate) fn same_group_as(&self, other: &Self) -> bool {
        self == other
    }
}

impl Session {
    pub(crate) fn new(key: SessionKey, open_turn: Option<SessionTurn>) -> Result<Self> {
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
        Ok(Self { key, open_turn })
    }

    pub(crate) fn key(&self) -> &SessionKey {
        &self.key
    }

    pub(crate) fn open_turn(&self) -> Option<&SessionTurn> {
        self.open_turn.as_ref()
    }

    pub(crate) fn preview_prompt(&self, incoming: Option<&str>) -> Option<String> {
        let current = self
            .open_turn
            .as_ref()
            .filter(|turn| turn.is_open())
            .and_then(|turn| turn.prompt.as_deref());
        merge_prompt(current, incoming)
    }

    pub fn apply(&mut self, write: SessionWrite) -> Result<Option<SessionTurn>> {
        if self.key != write.session_key() {
            return Err(Error::invalid_input(
                "message session does not match session",
            ));
        }

        let mut turn = if let Some(open_turn) = self.open_turn.take() {
            open_turn
        } else {
            SessionTurn::new_pending(&write)
        };
        turn.merge(&write)?;
        if turn.is_open() {
            self.open_turn = Some(turn);
            Ok(None)
        } else {
            Ok(Some(turn))
        }
    }
}

impl SessionTurn {
    pub fn new(write: &SessionWrite) -> Self {
        Self::new_pending(write)
    }

    pub fn new_pending(write: &SessionWrite) -> Self {
        let now = Utc::now();
        Self {
            turn_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
            created_at: now,
            updated_at: now,
            session_id: write.session_id.clone(),
            agent: write.agent.clone(),
            observer: write.observer.clone(),
            title: None,
            summary: None,
            title_source: None,
            summary_source: None,
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        }
    }

    pub fn merge(&mut self, update: &SessionWrite) -> Result<()> {
        if self.session_key() != update.session_key() {
            return Err(Error::invalid_input(
                "message session does not match open turn",
            ));
        }
        if self.agent != update.agent {
            return Err(Error::invalid_input(
                "message agent does not match open turn",
            ));
        }
        if self.observer != update.observer {
            return Err(Error::invalid_input(
                "message observer does not match open turn",
            ));
        }

        merge_metadata_field(
            &mut self.title,
            &mut self.title_source,
            update.title.as_deref(),
            update.title_source(),
        );
        merge_metadata_field(
            &mut self.summary,
            &mut self.summary_source,
            update.summary.as_deref(),
            update.summary_source(),
        );
        self.prompt = merge_prompt(self.prompt.as_deref(), update.prompt.as_deref());
        if update
            .response
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            self.response = update.response.clone();
        }
        merge_tool_calling(&mut self.tool_calling, update.tool_calling.as_ref());
        merge_artifacts(&mut self.artifacts, update.artifacts.as_ref());
        self.updated_at = Utc::now();
        Ok(())
    }

    pub fn observable(&self) -> bool {
        has_text_content(self.response.as_deref()) && has_text_content(self.summary.as_deref())
    }

    pub(crate) fn is_open(&self) -> bool {
        !has_text_content(self.response.as_deref())
    }

    pub fn memory_id(&self) -> Result<MemoryId> {
        if self.turn_id.memory_layer() != MemoryLayer::Session {
            return Err(Error::invalid_input(format!(
                "invalid turn memory layer: {}",
                self.turn_id.memory_layer()
            )));
        }
        Ok(self.turn_id)
    }

    pub fn with_row_id(mut self, row_id: u64) -> Self {
        self.turn_id = MemoryId::new(MemoryLayer::Session, row_id);
        self
    }

    pub fn set_row_id(&mut self, row_id: u64) {
        self.turn_id = MemoryId::new(MemoryLayer::Session, row_id);
    }

    pub(crate) fn session_key(&self) -> SessionKey {
        SessionKey::from_parts(self.session_id.as_deref(), &self.agent, &self.observer)
    }
}

impl SessionWrite {
    pub(crate) fn session_key(&self) -> SessionKey {
        SessionKey::from_parts(self.session_id.as_deref(), &self.agent, &self.observer)
    }

    pub(crate) fn title_source(&self) -> Option<TurnMetadataSource> {
        has_text_content(self.title.as_deref())
            .then(|| self.title_source.unwrap_or(TurnMetadataSource::User))
    }

    pub(crate) fn summary_source(&self) -> Option<TurnMetadataSource> {
        has_text_content(self.summary.as_deref())
            .then(|| self.summary_source.unwrap_or(TurnMetadataSource::User))
    }

    pub fn validate(&self) -> Result<()> {
        let has_content = has_string_list_content(self.tool_calling.as_ref())
            || has_string_map_content(self.artifacts.as_ref())
            || has_text_content(self.prompt.as_deref())
            || has_text_content(self.response.as_deref());

        if has_content {
            Ok(())
        } else {
            Err(Error::invalid_input(
                "turn must include at least one message field",
            ))
        }
    }
}

pub(crate) fn has_text_content(value: Option<&str>) -> bool {
    value.map(|value| !value.trim().is_empty()).unwrap_or(false)
}

#[derive(Debug, Clone)]
pub(crate) struct OpenTurnReconciliation {
    pub(crate) canonical_turn: SessionTurn,
    pub(crate) discarded_turn_ids: Vec<MemoryId>,
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
    // TODO: use an LLM-assisted reconciliation strategy for title/summary conflicts.

    Ok(OpenTurnReconciliation {
        canonical_turn,
        discarded_turn_ids,
    })
}

fn merge_prompt(current: Option<&str>, incoming: Option<&str>) -> Option<String> {
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

fn has_string_list_content(value: Option<&Vec<String>>) -> bool {
    value.map(|entries| !entries.is_empty()).unwrap_or(false)
}

fn has_string_map_content(value: Option<&HashMap<String, String>>) -> bool {
    value.map(|entries| !entries.is_empty()).unwrap_or(false)
}

fn merge_tool_calling(current: &mut Option<Vec<String>>, incoming: Option<&Vec<String>>) {
    let Some(incoming) = incoming else {
        return;
    };
    if incoming.is_empty() {
        return;
    }
    let current_values = current.get_or_insert_with(Vec::new);
    current_values.extend(incoming.iter().cloned());
}

fn merge_artifacts(
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

fn merge_metadata_field(
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::Arc;

    use super::{SessionKey, SessionTurn, SessionWrite, TurnMetadataSource, reconcile_open_turns};
    use crate::format::memory::{MemoryId, MemoryLayer};
    use crate::memory::sessions::{apply_list_mode, get, timeline, timeline_from_source};
    use crate::memory::types::{ListMode, MemoryView};
    use crate::service::{PostMessage, Service};
    use crate::storage::{SessionSelect, Storage};
    use chrono::{TimeZone, Utc};
    use tokio::sync::Barrier;

    fn session_memory_id(row_id: u64) -> MemoryId {
        MemoryId::new(MemoryLayer::Session, row_id)
    }

    fn make_turn(id: u64, created_at: i64, agent: &str, session_id: Option<&str>) -> SessionTurn {
        let timestamp = Utc.timestamp_micros(created_at).single().unwrap();
        SessionTurn {
            turn_id: session_memory_id(id),
            created_at: timestamp,
            updated_at: timestamp,
            session_id: session_id.map(str::to_string),
            agent: agent.to_string(),
            observer: "observer-a".to_string(),
            title: None,
            summary: None,
            title_source: None,
            summary_source: None,
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        }
    }

    async fn post(
        storage: &Storage,
        session_id: Option<&str>,
        agent: &str,
        title: Option<&str>,
        summary: Option<&str>,
        tool_calling: Option<Vec<String>>,
        artifacts: Option<HashMap<String, String>>,
        prompt: Option<&str>,
        response: Option<&str>,
    ) -> SessionTurn {
        Service::new(storage.clone())
            .await
            .unwrap()
            .sessions()
            .post(PostMessage {
                session_id: session_id.map(str::to_string),
                agent: agent.to_string(),
                title: title.map(str::to_string),
                summary: summary.map(str::to_string),
                tool_calling,
                artifacts,
                prompt: prompt.map(str::to_string),
                response: response.map(str::to_string),
            })
            .await
            .unwrap()
    }

    #[test]
    fn recency_mode_returns_ascending_window() {
        let result = apply_list_mode(
            vec![
                make_turn(1, 1, "agent", None),
                make_turn(2, 3, "agent", None),
                make_turn(3, 2, "agent", None),
            ],
            ListMode::Recency { limit: 2 },
        );
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:3", "session:2"]);
    }

    #[test]
    fn timeline_honors_filters() {
        let turns = [
            make_turn(1, 1, "agent-a", Some("group")),
            make_turn(2, 2, "agent-a", Some("group")),
            make_turn(3, 3, "agent-b", Some("other")),
            make_turn(4, 4, "agent-a", Some("group")),
        ];
        let anchor = turns
            .iter()
            .find(|turn| turn.turn_id == session_memory_id(2))
            .unwrap();
        let result =
            timeline_from_source(&turns, session_memory_id(2), 1, 1, &anchor.session_key())
                .unwrap();
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:1", "session:2", "session:4"]);
    }

    #[test]
    fn timeline_orders_chronologically_even_if_source_is_recency_sorted() {
        let turns = [
            make_turn(4, 4, "agent-a", Some("group")),
            make_turn(3, 3, "agent-a", Some("group")),
            make_turn(2, 2, "agent-a", Some("group")),
            make_turn(1, 1, "agent-a", Some("group")),
        ];
        let anchor = turns
            .iter()
            .find(|turn| turn.turn_id == session_memory_id(3))
            .unwrap();
        let result =
            timeline_from_source(&turns, session_memory_id(3), 1, 1, &anchor.session_key())
                .unwrap();
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:2", "session:3", "session:4"]);
    }

    #[test]
    fn session_turn_update_validate_requires_content() {
        let update = SessionWrite {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: None,
            title_source: None,
            summary_source: None,
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
        };

        assert!(update.validate().is_err());
    }

    #[test]
    fn session_apply_seals_completed_turn_without_assigning_observer_epoch() {
        let key = SessionKey::from_parts(Some("group"), "agent", "observer");
        let mut session = super::Session::new(key, None).unwrap();

        let first = session
            .apply(SessionWrite {
                session_id: Some("group".to_string()),
                agent: "agent".to_string(),
                observer: "observer".to_string(),
                title: None,
                summary: None,
                title_source: None,
                summary_source: None,
                tool_calling: None,
                artifacts: None,
                prompt: Some("prompt".to_string()),
                response: None,
            })
            .unwrap();
        assert!(first.is_none());
        assert_eq!(session.open_turn().unwrap().observing_epoch, None);

        let sealed = session
            .apply(SessionWrite {
                session_id: Some("group".to_string()),
                agent: "agent".to_string(),
                observer: "observer".to_string(),
                title: None,
                summary: Some("summary".to_string()),
                title_source: None,
                summary_source: None,
                tool_calling: None,
                artifacts: None,
                prompt: None,
                response: Some("response".to_string()),
            })
            .unwrap();
        let sealed = sealed.expect("response should seal turn");
        assert!(session.open_turn().is_none());
        assert_eq!(sealed.observing_epoch, None);
    }

    #[test]
    fn summary_priority_allows_upgrading_fallback_to_generated_to_user() {
        let mut turn = SessionTurn::new(&SessionWrite {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: None,
            title_source: None,
            summary_source: None,
            tool_calling: None,
            artifacts: None,
            prompt: Some("prompt".to_string()),
            response: None,
        });

        turn.merge(&SessionWrite {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: Some("fallback".to_string()),
            title_source: None,
            summary_source: Some(TurnMetadataSource::Fallback),
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
        })
        .unwrap();
        assert_eq!(turn.summary.as_deref(), Some("fallback"));
        assert_eq!(turn.summary_source, Some(TurnMetadataSource::Fallback));

        turn.merge(&SessionWrite {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: Some("generated".to_string()),
            title_source: None,
            summary_source: Some(TurnMetadataSource::Generated),
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
        })
        .unwrap();
        assert_eq!(turn.summary.as_deref(), Some("generated"));
        assert_eq!(turn.summary_source, Some(TurnMetadataSource::Generated));

        turn.merge(&SessionWrite {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: Some("user".to_string()),
            title_source: None,
            summary_source: Some(TurnMetadataSource::User),
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
        })
        .unwrap();
        assert_eq!(turn.summary.as_deref(), Some("user"));
        assert_eq!(turn.summary_source, Some(TurnMetadataSource::User));
    }

    #[test]
    fn reconcile_open_turns_merges_content_into_latest_turn_id() {
        let mut first = make_turn(101, 1, "agent", Some("group"));
        first.prompt = Some("prompt-a".to_string());
        first.tool_calling = Some(vec!["tool-a".to_string()]);
        first.artifacts = Some(HashMap::from([("shared".to_string(), "a".to_string())]));
        first.title = Some("title-a".to_string());
        first.summary = Some("summary-a".to_string());

        let mut second = make_turn(102, 2, "agent", Some("group"));
        second.prompt = Some("prompt-b".to_string());
        second.tool_calling = Some(vec!["tool-b".to_string()]);
        second.artifacts = Some(HashMap::from([
            ("shared".to_string(), "b".to_string()),
            ("new".to_string(), "v".to_string()),
        ]));
        second.title = Some("title-b".to_string());
        second.summary = Some("summary-b".to_string());

        let repaired = reconcile_open_turns(vec![second.clone(), first.clone()]).unwrap();
        assert_eq!(repaired.canonical_turn.turn_id, second.turn_id);
        assert_eq!(
            repaired.canonical_turn.prompt.as_deref(),
            Some("prompt-a\n\nprompt-b")
        );
        assert_eq!(
            repaired.canonical_turn.tool_calling.as_deref(),
            Some(&["tool-a".to_string(), "tool-b".to_string()][..])
        );
        assert_eq!(
            repaired
                .canonical_turn
                .artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.get("shared"))
                .map(String::as_str),
            Some("b")
        );
        assert_eq!(
            repaired
                .canonical_turn
                .artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.get("new"))
                .map(String::as_str),
            Some("v")
        );
        assert_eq!(repaired.canonical_turn.title.as_deref(), Some("title-b"));
        assert_eq!(
            repaired.canonical_turn.summary.as_deref(),
            Some("summary-b")
        );
        assert_eq!(repaired.discarded_turn_ids, vec![first.turn_id]);
    }

    #[tokio::test]
    async fn summary_input_is_persisted_without_summarizer() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();

        let turn = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            Some("provided summary"),
            None,
            None,
            Some("prompt body"),
            None,
        )
        .await;

        assert_eq!(turn.summary.as_deref(), Some("provided summary"));
        let persisted = get(&storage, &turn.memory_id().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.summary.as_deref(), Some("provided summary"));
    }

    #[tokio::test]
    async fn detail_rejects_invalid_memory_layers_and_formats() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();

        let turn = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            Some("summary"),
            None,
            None,
            Some("prompt"),
            None,
        )
        .await;

        let memory_id = turn.memory_id().unwrap().to_string();
        let found = get(&storage, &MemoryId::from_str(&memory_id).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.turn_id, turn.turn_id);

        let bad_layer = format!("observing:{}", turn.turn_id.memory_point());
        assert!(
            get(&storage, &MemoryId::from_str(&bad_layer).unwrap())
                .await
                .is_err()
        );
        assert!(MemoryId::from_str("bad-memory-id").is_err());
    }

    #[tokio::test]
    async fn response_turns_fall_back_to_prompt_and_response_summary_when_short() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        let config_path = home.join(crate::llm::config::CONFIG_FILE_NAME);
        crate::llm::config::write_test_muninn_config(&config_path, Some("mock"), None, None);
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let storage = Storage::local(dir.path()).unwrap();

        let turn = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("what happened?"),
            Some("response body"),
        )
        .await;

        assert_eq!(turn.title.as_deref(), Some("what happened"));
        assert_eq!(
            turn.summary.as_deref(),
            Some("what happened?\n\nresponse body")
        );
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn explicit_summary_is_not_overwritten_by_generated_summary() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        let config_path = home.join(crate::llm::config::CONFIG_FILE_NAME);
        crate::llm::config::write_test_muninn_config(&config_path, Some("mock"), None, None);
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let storage = Storage::local(dir.path()).unwrap();

        let turn = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            Some("provided summary"),
            None,
            None,
            Some("what happened?"),
            Some("response body"),
        )
        .await;

        assert_eq!(turn.summary.as_deref(), Some("provided summary"));
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn response_turns_persist_without_summarizer_provider() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", dir.path().join("missing-muninn-home"));
        }
        let storage = Storage::local(dir.path()).unwrap();

        let turn = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            None,
            Some("response body"),
        )
        .await;

        assert_eq!(turn.summary, None);
        assert_eq!(turn.response.as_deref(), Some("response body"));
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn explicit_titles_are_preserved_on_turns() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();

        let turn = post(
            &storage,
            Some("group-a"),
            "agent-a",
            Some("custom title"),
            None,
            None,
            None,
            None,
            Some("response body"),
        )
        .await;

        assert_eq!(turn.title.as_deref(), Some("custom title"));
    }

    #[tokio::test]
    async fn consecutive_prompts_append_to_the_same_open_turn() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();

        let first = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            None,
        )
        .await;
        let merged = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            Some(vec!["tool-a".to_string()]),
            Some(HashMap::from([("k".to_string(), "v".to_string())])),
            None,
            None,
        )
        .await;
        let appended = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-b"),
            None,
        )
        .await;

        assert_eq!(first.turn_id, merged.turn_id);
        assert_eq!(first.turn_id, appended.turn_id);
        assert_eq!(merged.prompt.as_deref(), Some("prompt-a"));
        assert_eq!(
            merged.tool_calling.as_deref(),
            Some(&["tool-a".to_string()][..])
        );
        assert_eq!(
            merged
                .artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.get("k"))
                .map(String::as_str),
            Some("v")
        );
        assert_eq!(appended.prompt.as_deref(), Some("prompt-a\n\nprompt-b"));
    }

    #[tokio::test]
    async fn concurrent_writes_for_same_session_key_share_one_open_turn() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();
        let service = Service::new(storage.clone()).await.unwrap();
        let barrier = Arc::new(Barrier::new(3));

        let first_service = service.clone();
        let first_barrier = barrier.clone();
        let first = tokio::spawn(async move {
            first_barrier.wait().await;
            first_service
                .sessions()
                .post(PostMessage {
                    session_id: Some("group-a".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-a".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        let second_service = service.clone();
        let second_barrier = barrier.clone();
        let second = tokio::spawn(async move {
            second_barrier.wait().await;
            second_service
                .sessions()
                .post(PostMessage {
                    session_id: Some("group-a".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-b".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        barrier.wait().await;
        let first = first.await.unwrap();
        let second = second.await.unwrap();

        assert_eq!(first.turn_id, second.turn_id);

        let turns = storage
            .sessions()
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-a".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(turns.len(), 1);
        let persisted = turns.into_iter().next().unwrap();
        assert_eq!(persisted.turn_id, first.turn_id);
        assert!(matches!(
            persisted.prompt.as_deref(),
            Some("prompt-a\n\nprompt-b") | Some("prompt-b\n\nprompt-a")
        ));
        assert!(persisted.response.is_none());
    }

    #[tokio::test]
    async fn concurrent_writes_for_different_session_keys_do_not_share_turns() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();
        let service = Service::new(storage.clone()).await.unwrap();
        let barrier = Arc::new(Barrier::new(3));

        let first_service = service.clone();
        let first_barrier = barrier.clone();
        let first = tokio::spawn(async move {
            first_barrier.wait().await;
            first_service
                .sessions()
                .post(PostMessage {
                    session_id: Some("group-a".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-a".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        let second_service = service.clone();
        let second_barrier = barrier.clone();
        let second = tokio::spawn(async move {
            second_barrier.wait().await;
            second_service
                .sessions()
                .post(PostMessage {
                    session_id: Some("group-b".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-b".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        barrier.wait().await;
        let first = first.await.unwrap();
        let second = second.await.unwrap();

        assert_ne!(first.turn_id, second.turn_id);

        let group_a_turns = storage
            .sessions()
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-a".to_string()),
            })
            .await
            .unwrap();
        let group_b_turns = storage
            .sessions()
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-b".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(group_a_turns.len(), 1);
        assert_eq!(group_b_turns.len(), 1);
        assert_eq!(group_a_turns[0].turn_id, first.turn_id);
        assert_eq!(group_b_turns[0].turn_id, second.turn_id);
    }

    #[tokio::test]
    async fn public_timeline_uses_memory_ids_and_returns_empty_for_missing_anchor() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();

        let a = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            Some("response-a"),
        )
        .await;
        let b = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-b"),
            Some("response-b"),
        )
        .await;
        let _c = post(
            &storage,
            Some("group-b"),
            "agent-a",
            None,
            Some("c"),
            None,
            None,
            Some("prompt-c"),
            None,
        )
        .await;
        let d = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-d"),
            Some("response-d"),
        )
        .await;

        let timeline_rows = timeline(&storage, &b.memory_id().unwrap(), 1, 1)
            .await
            .unwrap();
        let ids = timeline_rows
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&a.turn_id.to_string()));
        assert!(ids.contains(&b.turn_id.to_string()));
        assert!(ids.contains(&d.turn_id.to_string()));

        let missing_anchor = MemoryId::new(MemoryLayer::Session, 999_999).to_string();
        let missing = timeline(
            &storage,
            &MemoryId::from_str(&missing_anchor).unwrap(),
            1,
            1,
        )
        .await
        .unwrap();
        assert!(missing.is_empty());
    }

    #[test]
    fn turn_memory_id_roundtrip() {
        let turn = make_turn(42, 100, "agent", None);
        let memory_id = turn.memory_id().unwrap();
        assert_eq!(memory_id.memory_layer(), MemoryLayer::Session);
        assert_eq!(memory_id.to_string(), "session:42");
    }

    #[test]
    fn row_id_requires_memory_layer_prefix() {
        assert!(MemoryId::from_str("legacy-row-id").is_err());
        let session_memory_id = MemoryId::from_str("session:42").unwrap();
        assert_eq!(session_memory_id.memory_layer(), MemoryLayer::Session);
        assert_eq!(session_memory_id.memory_point(), 42);
    }

    #[test]
    fn turn_try_into_rendered_memory_prefers_summary() {
        let mut turn = make_turn(42, 100, "agent", Some("group"));
        turn.title = Some("Turn title".to_string());
        turn.summary = Some("Short summary".to_string());
        turn.prompt = Some("Prompt body".to_string());

        let rendered = MemoryView::try_from(&turn).unwrap();
        assert_eq!(rendered.memory_id.to_string(), "session:42");
        assert_eq!(rendered.title.as_deref(), Some("Turn title"));
        assert_eq!(rendered.summary.as_deref(), Some("Short summary"));
        assert_eq!(rendered.detail.as_deref(), Some("Prompt: Prompt body"));
    }

    #[test]
    fn session_prefers_explicit_session_id_then_agent_default_then_observer_default() {
        let explicit = make_turn(1, 1, "agent-a", Some("group-a"));
        assert_eq!(
            explicit.session_key(),
            SessionKey::Session {
                session_id: "group-a".to_string(),
                agent: "agent-a".to_string(),
                observer: "observer-a".to_string(),
            }
        );

        let agent_default = make_turn(2, 2, "agent-a", None);
        assert_eq!(
            agent_default.session_key(),
            SessionKey::Agent {
                agent: "agent-a".to_string(),
                observer: "observer-a".to_string(),
            }
        );

        let observer_default = SessionKey::from_parts(None, "", "observer-a");
        assert_eq!(
            observer_default,
            SessionKey::Observer {
                observer: "observer-a".to_string()
            }
        );
    }

    #[test]
    fn timeline_uses_resolved_default_session_when_session_id_is_missing() {
        let turns = [
            make_turn(1, 1, "agent-a", None),
            make_turn(2, 2, "agent-a", None),
            make_turn(3, 3, "agent-b", None),
            make_turn(4, 4, "agent-a", Some("group-a")),
        ];
        let anchor = turns
            .iter()
            .find(|turn| turn.turn_id == session_memory_id(2))
            .unwrap();
        let result =
            timeline_from_source(&turns, session_memory_id(2), 1, 1, &anchor.session_key())
                .unwrap();
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:1", "session:2"]);
    }

    #[test]
    fn timeline_with_explicit_session_id_stays_scoped_to_the_full_session_key() {
        let turns = [
            make_turn(1, 1, "agent-a", Some("group-a")),
            make_turn(2, 2, "agent-a", Some("group-a")),
            make_turn(3, 3, "agent-b", Some("group-a")),
            make_turn(4, 4, "agent-a", Some("group-a")),
        ];
        let anchor = turns
            .iter()
            .find(|turn| turn.turn_id == session_memory_id(2))
            .unwrap();
        let result =
            timeline_from_source(&turns, session_memory_id(2), 1, 1, &anchor.session_key())
                .unwrap();
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:1", "session:2", "session:4"]);
    }

    #[tokio::test]
    async fn same_explicit_session_with_different_agents_opens_new_turns() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();

        let first = post(
            &storage,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            None,
        )
        .await;
        let second = post(
            &storage,
            Some("group-a"),
            "agent-b",
            None,
            None,
            Some(vec!["tool-b".to_string()]),
            None,
            None,
            None,
        )
        .await;

        assert_ne!(first.turn_id, second.turn_id);
        assert_eq!(second.agent, "agent-b");
    }

    #[tokio::test]
    async fn missing_session_id_reuses_agent_default_open_turn() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::local(dir.path()).unwrap();

        let first = post(
            &storage,
            None,
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            None,
        )
        .await;
        let merged = post(
            &storage,
            None,
            "agent-a",
            None,
            Some("default summary"),
            Some(vec!["tool-a".to_string()]),
            None,
            None,
            None,
        )
        .await;

        assert_eq!(first.turn_id, merged.turn_id);
        assert_eq!(
            merged.tool_calling.as_deref(),
            Some(&["tool-a".to_string()][..])
        );
        assert_eq!(merged.summary.as_deref(), Some("default summary"));
    }
}
