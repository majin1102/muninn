use std::collections::HashMap;
use std::sync::Arc;

use lance::Result;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::config::semantic_index_config;
use crate::format::observing::ObservingSnapshot;
use crate::format::session::{Session, SessionKey, SessionTurn, SessionWrite, TurnMetadataSource};
use crate::llm::config::effective_observer_name;
use crate::llm::turn::TurnGenerator;
use crate::memory::memories;
use crate::memory::observings::{self, ObservingListQuery};
use crate::memory::sessions::{self, SessionListQuery};
use crate::memory::types::{ListMode, MemoryView, RecallHit};
use crate::observer::observer::Observer;
use crate::storage::Storage;
use crate::watchdog::{Watchdog, WatchdogRuntime};

#[derive(Debug, Clone)]
pub struct PostMessage {
    pub session_id: Option<String>,
    pub agent: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tool_calling: Option<Vec<String>>,
    pub artifacts: Option<HashMap<String, String>>,
    pub prompt: Option<String>,
    pub response: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionList {
    pub mode: ListMode,
    pub agent: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MemoryRecall {
    pub text: String,
    pub limit: usize,
}

#[derive(Debug, Clone)]
pub struct MemoryTimeline {
    pub memory_id: String,
    pub before_limit: Option<usize>,
    pub after_limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct ObservingList {
    pub mode: ListMode,
    pub observer: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObserverWatermark {
    pub resolved: bool,
    pub pending_turn_ids: Vec<String>,
}

#[derive(Clone)]
pub struct Service {
    storage: Storage,
    observer: Observer,
    watchdog: Option<Watchdog>,
    _watchdog: Option<Arc<WatchdogRuntime>>,
    sessions: Arc<Mutex<HashMap<SessionKey, Session>>>,
    session_write_locks: Arc<Mutex<HashMap<SessionKey, Arc<Mutex<()>>>>>,
}

impl Service {
    pub async fn new(storage: Storage) -> Result<Self> {
        storage
            .semantic_index()
            .validate_dimensions(semantic_index_config()?.dimensions)
            .await?;
        storage.sessions().reconcile_open_turns().await?;
        let observer = Observer::new(storage.clone()).await?;
        let watchdog = Watchdog::new(storage.clone())?;
        let watchdog_runtime = if watchdog.enabled() {
            if let Err(error) = watchdog.bootstrap().await {
                eprintln!("[watchdog] bootstrap failed: {}", error);
            }
            Some(watchdog.spawn())
        } else {
            None
        };
        Ok(Self {
            storage,
            observer,
            watchdog: watchdog.enabled().then_some(watchdog.clone()),
            _watchdog: watchdog_runtime,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_write_locks: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn sessions(&self) -> Sessions<'_> {
        Sessions { service: self }
    }

    pub fn memories(&self) -> Memories<'_> {
        Memories { service: self }
    }

    pub fn observings(&self) -> Observings<'_> {
        Observings { service: self }
    }

    pub async fn flush_observer_epoch(&self) -> Result<usize> {
        self.observer.flush_epoch().await
    }

    pub async fn run_watchdog_once(&self) -> Result<()> {
        if let Some(watchdog) = &self.watchdog {
            watchdog.run_once().await?;
        }
        Ok(())
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub async fn shutdown(&self) {
        self.observer.shutdown(false).await;
        if let Some(watchdog) = &self._watchdog {
            watchdog.shutdown(false).await;
        }
    }

    pub async fn validate_settings(&self, content: &str) -> Result<()> {
        let expected_dimensions =
            crate::config::semantic_index_config_from_raw(content)?.dimensions;
        self.storage
            .semantic_index()
            .validate_dimensions(expected_dimensions)
            .await
    }

    pub async fn observer_watermark(&self) -> Result<ObserverWatermark> {
        self.observer.watermark().await
    }

    async fn load_session(&self, key: SessionKey) -> Result<Session> {
        if let Some(session) = self.sessions.lock().await.get(&key).cloned() {
            return Ok(session);
        }

        let open_turn = self.storage.sessions().load_open_turn(&key).await?;
        let session = Session::new(key.clone(), open_turn)?;
        self.sessions.lock().await.insert(key, session.clone());
        Ok(session)
    }

    async fn store_session(&self, session: Session) {
        let key = session.key().clone();
        let mut sessions = self.sessions.lock().await;
        if session.open_turn().is_some() {
            sessions.insert(key, session);
        } else {
            sessions.remove(&key);
        }
    }

    async fn session_write_lock(&self, key: &SessionKey) -> Arc<Mutex<()>> {
        let mut locks = self.session_write_locks.lock().await;
        if let Some(lock) = locks.get(key) {
            return lock.clone();
        }

        let lock = Arc::new(Mutex::new(()));
        locks.insert(key.clone(), lock.clone());
        lock
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use serde_json::json;

    use super::Service;
    use crate::llm::config::llm_test_env_guard;
    use crate::storage::Storage;

    fn write_service_config(dir: &tempfile::TempDir) {
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
    async fn cloned_services_share_one_runtime_and_shutdown_is_idempotent() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_service_config(&dir);
        let storage = Storage::local(crate::config::data_root().unwrap()).unwrap();
        let service = Service::new(storage).await.unwrap();
        let cloned = service.clone();

        let first_runtime = service._watchdog.as_ref().unwrap();
        let second_runtime = cloned._watchdog.as_ref().unwrap();
        assert!(Arc::ptr_eq(first_runtime, second_runtime));
        assert!(service.observer.shares_runtime_with(&cloned.observer));

        service.shutdown().await;
        cloned.shutdown().await;

        assert!(service.observer.is_shutdown().await);

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }
}

pub struct Sessions<'a> {
    service: &'a Service,
}

impl Sessions<'_> {
    pub async fn post(&self, message: PostMessage) -> Result<SessionTurn> {
        let observer = effective_observer_name()?;
        let key = SessionKey::from_parts(message.session_id.as_deref(), &message.agent, &observer);
        let session_write_lock = self.service.session_write_lock(&key).await;
        let turn = {
            let _session_guard = session_write_lock.lock().await;
            let mut session = self.service.load_session(key).await?;
            let guard = self.service.observer.begin_post();
            let preview_prompt = session.preview_prompt(message.prompt.as_deref());
            let metadata = resolve_turn_metadata(preview_prompt.as_deref(), &message).await;
            let write = SessionWrite {
                session_id: message.session_id,
                agent: message.agent,
                observer,
                title: metadata.title,
                summary: metadata.summary,
                title_source: metadata.title_source,
                summary_source: metadata.summary_source,
                tool_calling: message.tool_calling,
                artifacts: message.artifacts,
                prompt: message.prompt,
                response: message.response,
            };
            write.validate()?;

            let mut observable_turns = Vec::new();
            let turn = if let Some(mut sealed_turn) = session.apply(write)? {
                if sealed_turn.observable() {
                    sealed_turn.observing_epoch = Some(guard.epoch());
                }
                self.service
                    .storage()
                    .sessions()
                    .upsert(vec![sealed_turn.clone()])
                    .await?;
                let persisted = self
                    .service
                    .storage()
                    .sessions()
                    .load_latest_turn(session.key())
                    .await?
                    .ok_or_else(|| {
                        lance::Error::invalid_input(
                            "sealed turn write completed but persisted row could not be reloaded",
                        )
                    })?;
                if persisted.observable() {
                    observable_turns.push(persisted.clone());
                }
                persisted
            } else {
                let open_turn = session.open_turn().cloned().ok_or_else(|| {
                    lance::Error::invalid_input("session apply completed without an open turn")
                })?;
                self.service
                    .storage()
                    .sessions()
                    .upsert(vec![open_turn.clone()])
                    .await?;
                let persisted = self
                    .service
                    .storage()
                    .sessions()
                    .load_open_turn(session.key())
                    .await?
                    .ok_or_else(|| {
                        lance::Error::invalid_input(
                            "open turn write completed but persisted row could not be reloaded",
                        )
                    })?;
                session = Session::new(session.key().clone(), Some(persisted.clone()))?;
                persisted
            };
            self.service.store_session(session).await;
            self.service.observer.enqueue(observable_turns).await;
            guard.complete();
            turn
        };
        Ok(turn)
    }

    pub async fn list(&self, list: SessionList) -> Result<Vec<SessionTurn>> {
        sessions::list(
            self.service.storage(),
            SessionListQuery {
                mode: list.mode,
                agent: list.agent,
                session_id: list.session_id,
            },
        )
        .await
    }

    pub async fn get(&self, memory_id: &str) -> Result<Option<SessionTurn>> {
        sessions::get(self.service.storage(), &memory_id.parse()?).await
    }
}

struct ResolvedTurnMetadata {
    title: Option<String>,
    title_source: Option<TurnMetadataSource>,
    summary: Option<String>,
    summary_source: Option<TurnMetadataSource>,
}

async fn resolve_turn_metadata(
    prompt: Option<&str>,
    message: &PostMessage,
) -> ResolvedTurnMetadata {
    let mut title = sanitized_text(message.title.clone());
    let mut summary = sanitized_text(message.summary.clone());
    let mut title_source = title.as_ref().map(|_| TurnMetadataSource::User);
    let mut summary_source = summary.as_ref().map(|_| TurnMetadataSource::User);
    let response = message
        .response
        .as_deref()
        .filter(|value| !value.trim().is_empty());
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


fn sanitized_text(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

pub struct Memories<'a> {
    service: &'a Service,
}

impl Memories<'_> {
    pub async fn recall(&self, recall: MemoryRecall) -> Result<Vec<RecallHit>> {
        memories::recall(self.service.storage(), &recall.text, recall.limit).await
    }

    pub async fn list(&self, mode: ListMode) -> Result<Vec<MemoryView>> {
        memories::list(self.service.storage(), mode).await
    }

    pub async fn get(&self, memory_id: &str) -> Result<Option<MemoryView>> {
        memories::get(self.service.storage(), memory_id).await
    }

    pub async fn timeline(&self, timeline: MemoryTimeline) -> Result<Vec<MemoryView>> {
        memories::timeline(
            self.service.storage(),
            &timeline.memory_id,
            timeline.before_limit,
            timeline.after_limit,
        )
        .await
    }
}

pub struct Observings<'a> {
    service: &'a Service,
}

impl Observings<'_> {
    pub async fn list(&self, list: ObservingList) -> Result<Vec<ObservingSnapshot>> {
        observings::list(
            self.service.storage(),
            ObservingListQuery {
                mode: list.mode,
                observer: list.observer,
            },
        )
        .await
    }

    pub async fn get(&self, memory_id: &str) -> Result<Option<ObservingSnapshot>> {
        observings::get(self.service.storage(), &memory_id.parse()?).await
    }
}
