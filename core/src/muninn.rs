use std::str::FromStr;
use std::sync::Arc;
#[cfg(test)]
use std::collections::HashMap;

use lance::Result;
use serde::{Deserialize, Serialize};
use crate::config::semantic_index_config;
use crate::format::{ObservingSnapshot, ObservingTable, SemanticIndexTable, SessionTable, SessionTurn, TableDescription, TableOptions};
use crate::memory::sessions::{self as memory_sessions, SessionListQuery};
use crate::memory::types::ListMode as SessionListMode;
use crate::watchdog::{Watchdog, WatchdogRuntime};
#[cfg(test)]
use crate::llm::config::effective_observer_name;
#[cfg(test)]
use crate::observer::runtime::Observer;
use crate::session::SessionKey;
#[cfg(test)]
use crate::session::SessionRegistry;

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct TurnContent {
    pub session_id: Option<String>,
    pub agent: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tool_calling: Option<Vec<String>>,
    pub artifacts: Option<HashMap<String, String>>,
    pub prompt: Option<String>,
    pub response: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ListModeInput {
    Recency { limit: usize },
    Page { offset: usize, limit: usize },
}

impl From<ListModeInput> for SessionListMode {
    fn from(value: ListModeInput) -> Self {
        match value {
            ListModeInput::Recency { limit } => SessionListMode::Recency { limit },
            ListModeInput::Page { offset, limit } => SessionListMode::Page { offset, limit },
        }
    }
}

#[derive(Clone)]
pub struct Muninn {
    table_options: TableOptions,
    watchdog: Option<Watchdog>,
    _watchdog: Option<Arc<WatchdogRuntime>>,
    #[cfg(test)]
    observer: Observer,
    #[cfg(test)]
    session_registry: Arc<SessionRegistry>,
}

impl Muninn {
    pub async fn new(table_options: TableOptions) -> Result<Self> {
        SemanticIndexTable::new(table_options.clone())
            .validate_dimensions(semantic_index_config()?.dimensions)
            .await?;
        SessionTable::new(table_options.clone())
            .reconcile_open_turns()
            .await?;
        let watchdog = Watchdog::new(table_options.clone())?;
        let watchdog_runtime = if watchdog.enabled() {
            if let Err(error) = watchdog.bootstrap().await {
                eprintln!("[watchdog] bootstrap failed: {}", error);
            }
            Some(watchdog.spawn())
        } else {
            None
        };
        Ok(Self {
            table_options: table_options.clone(),
            watchdog: watchdog.enabled().then_some(watchdog.clone()),
            _watchdog: watchdog_runtime,
            #[cfg(test)]
            observer: Observer::new(table_options.clone()).await?,
            #[cfg(test)]
            session_registry: Arc::new(SessionRegistry::new(table_options)),
        })
    }

    #[cfg(test)]
    pub async fn accept(&self, turn_content: TurnContent) -> Result<()> {
        let observer = effective_observer_name()?;
        let key = SessionKey::from(
            turn_content.session_id.as_deref(),
            &turn_content.agent,
            &observer,
        );
        let window = self.observer.window();
        let session = self.session_registry.load(key).await?;
        let turn = session.accept(turn_content, &window).await?;
        window.include(turn).await;
        window.complete();
        Ok(())
    }

    #[cfg(test)]
    pub async fn flush_observer_epoch(&self) -> Result<usize> {
        self.observer.flush_epoch().await
    }

    pub async fn run_watchdog_once(&self) -> Result<()> {
        if let Some(watchdog) = &self.watchdog {
            watchdog.run_once().await?;
        }
        Ok(())
    }

    pub async fn session_load_open_turn(
        &self,
        session_id: Option<String>,
        agent: String,
        observer: String,
    ) -> Result<Option<SessionTurn>> {
        let key = SessionKey::from(session_id.as_deref(), &agent, &observer);
        SessionTable::new(self.table_options.clone())
            .load_open_turn(&key)
            .await
    }

    pub async fn session_get_turn(&self, turn_id: &str) -> Result<Option<SessionTurn>> {
        let turn_id = parse_session_memory_id(turn_id)
            .map_err(lance::Error::invalid_input)?;
        SessionTable::new(self.table_options.clone())
            .get_turn(turn_id.memory_point())
            .await
    }

    pub async fn session_list_turns(
        &self,
        mode: ListModeInput,
        agent: Option<String>,
        session_id: Option<String>,
    ) -> Result<Vec<SessionTurn>> {
        memory_sessions::list(
            &self.table_options,
            SessionListQuery {
                mode: mode.into(),
                agent,
                session_id,
            },
        )
        .await
    }

    pub async fn session_timeline_turns(
        &self,
        memory_id: &str,
        before_limit: Option<usize>,
        after_limit: Option<usize>,
    ) -> Result<Vec<SessionTurn>> {
        let turn_id = parse_session_memory_id(memory_id)
            .map_err(lance::Error::invalid_input)?;
        memory_sessions::timeline(
            &self.table_options,
            &turn_id,
            before_limit.unwrap_or(3),
            after_limit.unwrap_or(3),
        )
        .await
    }

    pub async fn session_load_turns_after_epoch(
        &self,
        observer: &str,
        committed_epoch: Option<u64>,
    ) -> Result<Vec<SessionTurn>> {
        SessionTable::new(self.table_options.clone())
            .turns_after_epoch(observer, committed_epoch)
            .await
    }

    pub async fn session_upsert(&self, mut turns: Vec<SessionTurn>) -> Result<Vec<SessionTurn>> {
        SessionTable::new(self.table_options.clone())
            .upsert(&mut turns)
            .await?;
        Ok(turns)
    }

    pub async fn describe_session_table(&self) -> Result<Option<TableDescription>> {
        SessionTable::new(self.table_options.clone()).describe().await
    }

    pub async fn observing_get_snapshot(&self, snapshot_id: &str) -> Result<Option<ObservingSnapshot>> {
        let snapshot_id = parse_observing_memory_id(snapshot_id)
            .map_err(lance::Error::invalid_input)?;
        ObservingTable::new(self.table_options.clone())
            .get(snapshot_id.memory_point())
            .await
    }

    pub async fn observing_list_snapshots(
        &self,
        observer: Option<&str>,
    ) -> Result<Vec<ObservingSnapshot>> {
        ObservingTable::new(self.table_options.clone())
            .list(observer)
            .await
    }

    pub async fn observing_thread_snapshots(
        &self,
        observing_id: &str,
    ) -> Result<Vec<ObservingSnapshot>> {
        ObservingTable::new(self.table_options.clone())
            .load_thread_snapshots(observing_id)
            .await
    }

    pub async fn observing_upsert(
        &self,
        mut snapshots: Vec<ObservingSnapshot>,
    ) -> Result<Vec<ObservingSnapshot>> {
        ObservingTable::new(self.table_options.clone())
            .upsert(&mut snapshots)
            .await?;
        Ok(snapshots)
    }

    pub async fn describe_observing_table(&self) -> Result<Option<TableDescription>> {
        ObservingTable::new(self.table_options.clone()).describe().await
    }

    pub async fn semantic_nearest(
        &self,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<crate::format::SemanticIndexRow>> {
        SemanticIndexTable::new(self.table_options.clone())
            .nearest(vector, limit)
            .await
    }

    pub async fn semantic_load_by_ids(
        &self,
        ids: &[String],
    ) -> Result<Vec<crate::format::SemanticIndexRow>> {
        SemanticIndexTable::new(self.table_options.clone())
            .load_by_ids(ids)
            .await
    }

    pub async fn semantic_upsert(
        &self,
        rows: Vec<crate::format::SemanticIndexRow>,
    ) -> Result<()> {
        SemanticIndexTable::new(self.table_options.clone())
            .upsert(rows)
            .await
    }

    pub async fn semantic_delete(&self, ids: Vec<String>) -> Result<usize> {
        SemanticIndexTable::new(self.table_options.clone())
            .delete(ids)
            .await
    }

    pub async fn describe_semantic_index_table(&self) -> Result<Option<TableDescription>> {
        SemanticIndexTable::new(self.table_options.clone()).describe().await
    }

    #[cfg(test)]
    pub async fn shutdown(&self) {
        #[cfg(test)]
        self.observer.shutdown(false).await;
        if let Some(watchdog) = &self._watchdog {
            watchdog.shutdown(false).await;
        }
    }
}

fn parse_session_memory_id(raw: &str) -> std::result::Result<crate::format::MemoryId, String> {
    let memory_id = crate::format::MemoryId::from_str(raw)
        .map_err(|error| format!("invalid params: {error}"))?;
    if memory_id.memory_layer() != crate::format::MemoryLayer::Session {
        return Err(format!(
            "invalid params: expected session memory id, got {}",
            memory_id.memory_layer()
        ));
    }
    Ok(memory_id)
}

fn parse_observing_memory_id(raw: &str) -> std::result::Result<crate::format::MemoryId, String> {
    let memory_id = crate::format::MemoryId::from_str(raw)
        .map_err(|error| format!("invalid params: {error}"))?;
    if memory_id.memory_layer() != crate::format::MemoryLayer::Observing {
        return Err(format!(
            "invalid params: expected observing memory id, got {}",
            memory_id.memory_layer()
        ));
    }
    Ok(memory_id)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use serde_json::json;

    use super::Muninn;
    use crate::format::TableOptions;
    use crate::llm::config::llm_test_env_guard;
    use crate::session::SessionUpdate;
    use crate::{SessionTurn, format::MemoryId};

    fn write_muninn_config(dir: &tempfile::TempDir) {
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(crate::llm::config::CONFIG_FILE_NAME),
            serde_json::to_string_pretty(&json!({
                "watchdog": {
                    "enabled": true,
                    "intervalMs": 60000,
                    "compactMinFragments": 2,
                    "semanticIndex": {
                        "targetPartitionSize": 2,
                        "optimizeMergeCount": 2
                    }
                },
                "semanticIndex": {
                    "embedding": {
                        "provider": "mock",
                        "dimensions": 4
                    },
                    "defaultImportance": 0.7
                },
                "observer": {
                    "name": "test-observer",
                    "llm": "missing_test_llm"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
    }

    #[tokio::test]
    async fn cloned_muninns_share_one_runtime_and_shutdown_is_idempotent() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_muninn_config(&dir);
        let table_options = TableOptions::local(crate::config::data_root().unwrap()).unwrap();
        let muninn = Muninn::new(table_options).await.unwrap();
        let cloned = muninn.clone();

        let first_runtime = muninn._watchdog.as_ref().unwrap();
        let second_runtime = cloned._watchdog.as_ref().unwrap();
        assert!(Arc::ptr_eq(first_runtime, second_runtime));
        assert!(muninn.observer.shares_task_with(&cloned.observer));

        muninn.shutdown().await;
        cloned.shutdown().await;

        assert!(muninn.observer.is_shutdown().await);

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn typed_service_methods_roundtrip() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_muninn_config(&dir);
        let table_options = TableOptions::local(crate::config::data_root().unwrap()).unwrap();
        let muninn = Muninn::new(table_options).await.unwrap();

        let update = SessionUpdate {
            session_id: Some("group-a".to_string()),
            agent: "agent-a".to_string(),
            observer: "test-observer".to_string(),
            title: None,
            summary: Some("helper summary".to_string()),
            title_source: None,
            summary_source: None,
            tool_calling: None,
            artifacts: None,
            prompt: Some("helper prompt".to_string()),
            response: None,
            observing_epoch: Some(0),
        };
        let mut turn = SessionTurn::new_pending(&update);
        turn.merge(&update).unwrap();

        let persisted = muninn.session_upsert(vec![turn]).await.unwrap().remove(0);
        assert_ne!(persisted.turn_id, MemoryId::new(crate::format::MemoryLayer::Session, u64::MAX));
        let session_description = muninn.describe_session_table().await.unwrap().unwrap();
        assert!(session_description.dimensions.is_none());

        let loaded = muninn
            .session_load_open_turn(
                Some("group-a".to_string()),
                "agent-a".to_string(),
                "test-observer".to_string(),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.turn_id, persisted.turn_id);
        assert_eq!(loaded.prompt.as_deref(), Some("helper prompt"));

        let observing = serde_json::json!({
            "snapshotId": "observing:18446744073709551615",
            "observingId": "obs-1",
            "snapshotSequence": 0,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
            "observer": "test-observer",
            "title": "thread",
            "summary": "thread summary",
            "content": "{\"memories\":[],\"openQuestions\":[],\"nextSteps\":[],\"memoryDelta\":{\"before\":[],\"after\":[]}}",
            "references": [],
            "checkpoint": {
                "observingEpoch": 0,
                "indexedSnapshotSequence": null,
                "pendingParentId": null
            }
        });
        let observing: crate::format::ObservingSnapshot =
            serde_json::from_value(observing).unwrap();
        let persisted_observing = muninn.observing_upsert(vec![observing]).await.unwrap();
        assert_eq!(persisted_observing.len(), 1);
        assert_ne!(
            persisted_observing[0].snapshot_id.to_string(),
            "observing:18446744073709551615"
        );
        let observing_description = muninn.describe_observing_table().await.unwrap().unwrap();
        assert!(observing_description.dimensions.is_none());

        let rows: Vec<crate::format::SemanticIndexRow> = serde_json::from_value(json!([
            {
                "id": "mem-1",
                "memoryId": "observing:1",
                "text": "memory text",
                "vector": [0.1, 0.2, 0.3, 0.4],
                "importance": 0.7,
                "category": "fact",
                "createdAt": "2024-01-01T00:00:00Z"
            }
        ]))
        .unwrap();
        muninn.semantic_upsert(rows).await.unwrap();
        let semantic_description = muninn
            .describe_semantic_index_table()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            semantic_description
                .dimensions
                .as_ref()
                .and_then(|dimensions| dimensions.get("vector"))
                .copied(),
            Some(4)
        );

        let semantic_deleted = muninn
            .semantic_delete(vec!["mem-1".to_string()])
            .await
            .unwrap();
        assert_eq!(semantic_deleted, 1);

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }
}
