use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::Arc;

use lance::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::config::semantic_index_config;
use crate::format::memory::observing::ObservingSnapshot;
use crate::format::memory::session::SessionTurn;
use crate::format::table::{ObservingTable, SemanticIndexTable, SessionTable, TableOptions};
use crate::llm::config::effective_observer_name;
use crate::memory::memories as memory_memories;
use crate::memory::observings::{self as memory_observings, ObservingListQuery};
use crate::memory::sessions::{self as memory_sessions, SessionListQuery};
use crate::memory::types::{ListMode, MemoryView, RecallHit};
use crate::observer::runtime::Observer;
use crate::session::{resolve_turn_metadata, Session, SessionKey, SessionUpdate};
use crate::watchdog::{Watchdog, WatchdogRuntime};

mod memories;
mod observings;
mod sessions;

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

pub use crate::observer::types::ObserverWatermark;

#[derive(Clone)]
pub struct Muninn {
    table_options: TableOptions,
    observer: Observer,
    watchdog: Option<Watchdog>,
    _watchdog: Option<Arc<WatchdogRuntime>>,
    sessions: Arc<Mutex<HashMap<SessionKey, Session>>>,
    session_write_locks: Arc<Mutex<HashMap<SessionKey, Arc<Mutex<()>>>>>,
}

impl Muninn {
    pub async fn new(table_options: TableOptions) -> Result<Self> {
        SemanticIndexTable::new(table_options.clone())
            .validate_dimensions(semantic_index_config()?.dimensions)
            .await?;
        SessionTable::new(table_options.clone())
            .reconcile_open_turns()
            .await?;
        let observer = Observer::new(table_options.clone()).await?;
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
            table_options,
            observer,
            watchdog: watchdog.enabled().then_some(watchdog.clone()),
            _watchdog: watchdog_runtime,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_write_locks: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn sessions(&self) -> Sessions<'_> {
        Sessions { muninn: self }
    }

    pub fn memories(&self) -> Memories<'_> {
        Memories { muninn: self }
    }

    pub fn observings(&self) -> Observings<'_> {
        Observings { muninn: self }
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

    pub fn table_options(&self) -> &TableOptions {
        &self.table_options
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
        self.semantic_index_table()
            .validate_dimensions(expected_dimensions)
            .await
    }

    pub async fn observer_watermark(&self) -> Result<ObserverWatermark> {
        self.observer.watermark().await
    }

    fn session_table(&self) -> SessionTable {
        SessionTable::new(self.table_options.clone())
    }

    fn observing_table(&self) -> ObservingTable {
        ObservingTable::new(self.table_options.clone())
    }

    fn semantic_index_table(&self) -> SemanticIndexTable {
        SemanticIndexTable::new(self.table_options.clone())
    }

    async fn load_session(&self, key: SessionKey) -> Result<Session> {
        if let Some(session) = self.sessions.lock().await.get(&key).cloned() {
            return Ok(session);
        }

        let open_turn = self.session_table().load_open_turn(&key).await?;
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

pub async fn run_stdio() {
    let table_options = match TableOptions::load() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("table init error: {error}");
            return;
        }
    };
    let muninn = match Muninn::new(table_options).await {
        Ok(muninn) => muninn,
        Err(error) => {
            eprintln!("muninn init error: {error}");
            return;
        }
    };

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("stdin read error: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let handled = handle_request(&muninn, &line).await;
        let encoded = serde_json::to_string(&handled.response).expect("response should encode");
        if writeln!(stdout, "{encoded}").is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
        if handled.should_exit {
            break;
        }
    }

    muninn.shutdown().await;
}

async fn handle_request(muninn: &Muninn, line: &str) -> RequestHandling {
    let request: RequestEnvelope = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return RequestHandling {
                response: ResponseEnvelope {
                    id: 0,
                    ok: false,
                    data: None,
                    error: Some(format!("invalid request: {error}")),
                },
                should_exit: false,
            };
        }
    };

    let should_exit = request.method == "shutdown";
    let result = match request.method.as_str() {
        "addMessage" => match parse_params::<AddMessageParams>(&request.params) {
            Ok(params) => muninn
                .sessions()
                .post(PostMessage {
                    session_id: params.session_id,
                    agent: params.agent,
                    title: params.title,
                    summary: params.summary,
                    tool_calling: params.tool_calling,
                    artifacts: params.artifacts,
                    prompt: params.prompt,
                    response: params.response,
                })
                .await
                .map(|turn| serde_json::to_value(turn).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "sessions.list" => match parse_params::<ListParams>(&request.params) {
            Ok(params) => muninn
                .sessions()
                .list(SessionList {
                    mode: params.mode,
                    agent: params.agent,
                    session_id: params.session_id,
                })
                .await
                .map(|turns| serde_json::to_value(turns).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "observings.list" => match parse_params::<ObservingListParams>(&request.params) {
            Ok(params) => muninn
                .observings()
                .list(ObservingList {
                    mode: params.mode,
                    observer: params.observer,
                })
                .await
                .map(|observings| serde_json::to_value(observings).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "sessions.get" => match parse_params::<DetailParams>(&request.params) {
            Ok(params) => muninn
                .sessions()
                .get(&params.memory_id)
                .await
                .map(|turn| serde_json::to_value(turn).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "observings.get" => match parse_params::<DetailParams>(&request.params) {
            Ok(params) => muninn
                .observings()
                .get(&params.memory_id)
                .await
                .map(|observing| serde_json::to_value(observing).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.recall" => match parse_params::<RecallParams>(&request.params) {
            Ok(params) => muninn
                .memories()
                .recall(MemoryRecall {
                    text: params.query,
                    limit: params.limit.unwrap_or(10),
                })
                .await
                .map(|memories| serde_json::to_value(memories).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.list" => match parse_params::<MemoryListParams>(&request.params) {
            Ok(params) => muninn
                .memories()
                .list(params.mode)
                .await
                .map(|memories| serde_json::to_value(memories).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.timeline" => match parse_params::<TimelineParams>(&request.params) {
            Ok(params) => muninn
                .memories()
                .timeline(MemoryTimeline {
                    memory_id: params.memory_id,
                    before_limit: params.before_limit,
                    after_limit: params.after_limit,
                })
                .await
                .map(|memories| serde_json::to_value(memories).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.get" => match parse_params::<DetailParams>(&request.params) {
            Ok(params) => muninn
                .memories()
                .get(&params.memory_id)
                .await
                .map(|memory| serde_json::to_value(memory).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "observer.watermark" => match parse_params::<ObserverWatermarkParams>(&request.params) {
            Ok(_) => muninn
                .observer_watermark()
                .await
                .map(|watermark| serde_json::to_value(watermark).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "settings.validate" => match parse_params::<SettingsValidateParams>(&request.params) {
            Ok(params) => muninn
                .validate_settings(&params.content)
                .await
                .map(|_| Value::Null)
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "observer.flush" => muninn
            .flush_observer_epoch()
            .await
            .map(|count| serde_json::to_value(count).unwrap())
            .map_err(|error| error.to_string()),
        "watchdog.run_once" => muninn
            .run_watchdog_once()
            .await
            .map(|()| serde_json::to_value(true).unwrap())
            .map_err(|error| error.to_string()),
        "shutdown" => {
            muninn.shutdown().await;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown method: {}", request.method)),
    };

    RequestHandling {
        response: match result {
            Ok(data) => ResponseEnvelope {
                id: request.id,
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => ResponseEnvelope {
                id: request.id,
                ok: false,
                data: None,
                error: Some(error),
            },
        },
        should_exit,
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: &Value) -> std::result::Result<T, String> {
    serde_json::from_value(params.clone()).map_err(|error| format!("invalid params: {error}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope {
    id: u64,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseEnvelope {
    id: u64,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
}

struct RequestHandling {
    response: ResponseEnvelope,
    should_exit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMessageParams {
    #[serde(rename = "session_id")]
    session_id: Option<String>,
    agent: String,
    title: Option<String>,
    summary: Option<String>,
    tool_calling: Option<Vec<String>>,
    artifacts: Option<HashMap<String, String>>,
    prompt: Option<String>,
    response: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecallParams {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    mode: ListMode,
    agent: Option<String>,
    #[serde(rename = "session_id")]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservingListParams {
    mode: ListMode,
    observer: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryListParams {
    mode: ListMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineParams {
    memory_id: String,
    before_limit: Option<usize>,
    after_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailParams {
    memory_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ObserverWatermarkParams {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsValidateParams {
    content: String,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use serde_json::json;

    use super::Muninn;
    use crate::format::table::TableOptions;
    use crate::llm::config::llm_test_env_guard;

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
        assert!(muninn.observer.shares_runtime_with(&cloned.observer));

        muninn.shutdown().await;
        cloned.shutdown().await;

        assert!(muninn.observer.is_shutdown().await);

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }
}

pub struct Sessions<'a> {
    muninn: &'a Muninn,
}

pub struct Memories<'a> {
    muninn: &'a Muninn,
}

pub struct Observings<'a> {
    muninn: &'a Muninn,
}
