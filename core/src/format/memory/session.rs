use chrono::{DateTime, Utc};
use lance::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::format::memory::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};
use crate::session::{
    SessionKey, SessionUpdate, has_text_content, merge_artifacts, merge_metadata_field,
    merge_prompt, merge_tool_calling,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnMetadataSource {
    Fallback,
    Generated,
    User,
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

impl SessionTurn {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new(write: &SessionUpdate) -> Self {
        Self::new_pending(write)
    }

    pub(crate) fn new_pending(write: &SessionUpdate) -> Self {
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

    pub(crate) fn merge(&mut self, update: &SessionUpdate) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::Arc;

    use super::{SessionTurn, TurnMetadataSource};
    use crate::format::memory::{MemoryId, MemoryLayer};
    use crate::format::table::{SessionSelect, SessionTable, TableOptions};
    use crate::memory::sessions::{apply_list_mode, get, timeline, timeline_from_source};
    use crate::memory::types::{ListMode, MemoryView};
    use crate::muninn::{Muninn, PostMessage};
    use crate::session::{Session, SessionKey, SessionUpdate, reconcile_open_turns};
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

    fn session_table(table_options: &TableOptions) -> SessionTable {
        SessionTable::new(table_options.to_owned())
    }

    async fn post(
        table_options: &TableOptions,
        session_id: Option<&str>,
        agent: &str,
        title: Option<&str>,
        summary: Option<&str>,
        tool_calling: Option<Vec<String>>,
        artifacts: Option<HashMap<String, String>>,
        prompt: Option<&str>,
        response: Option<&str>,
    ) -> SessionTurn {
        Muninn::new(table_options.clone())
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
        let update = SessionUpdate {
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
        let mut session = Session::new(key, None).unwrap();

        let first = session
            .apply(SessionUpdate {
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
            .apply(SessionUpdate {
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
        let mut turn = SessionTurn::new(&SessionUpdate {
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

        turn.merge(&SessionUpdate {
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

        turn.merge(&SessionUpdate {
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

        turn.merge(&SessionUpdate {
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
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
        let persisted = get(&table_options, &turn.memory_id().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.summary.as_deref(), Some("provided summary"));
    }

    #[tokio::test]
    async fn detail_rejects_invalid_memory_layers_and_formats() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
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
        let found = get(&table_options, &MemoryId::from_str(&memory_id).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.turn_id, turn.turn_id);

        let bad_layer = format!("observing:{}", turn.turn_id.memory_point());
        assert!(
            get(&table_options, &MemoryId::from_str(&bad_layer).unwrap())
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let first = post(
            &table_options,
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
            &table_options,
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
            &table_options,
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
        let table_options = TableOptions::local(dir.path()).unwrap();
        let service = Muninn::new(table_options.clone()).await.unwrap();
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

        let turns = session_table(&table_options)
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
        let table_options = TableOptions::local(dir.path()).unwrap();
        let service = Muninn::new(table_options.clone()).await.unwrap();
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

        let group_a_turns = session_table(&table_options)
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-a".to_string()),
            })
            .await
            .unwrap();
        let group_b_turns = session_table(&table_options)
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let a = post(
            &table_options,
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
            &table_options,
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
            &table_options,
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
            &table_options,
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

        let timeline_rows = timeline(&table_options, &b.memory_id().unwrap(), 1, 1)
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
            &table_options,
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let first = post(
            &table_options,
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
            &table_options,
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
        let table_options = TableOptions::local(dir.path()).unwrap();

        let first = post(
            &table_options,
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
            &table_options,
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
