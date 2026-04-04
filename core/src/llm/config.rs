use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use lance::{Error, Result};
use serde::Deserialize;

pub(crate) const CONFIG_FILE_NAME: &str = "muninn.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmProviderKind {
    Mock,
    OpenAi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmTask {
    Turn,
    Observer,
}

#[derive(Debug, Clone)]
pub struct EmbeddingConfig {
    pub provider: String,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub dimensions: usize,
    pub default_importance: f32,
}

#[derive(Debug, Clone)]
pub struct LlmTaskConfig {
    pub provider: LlmProviderKind,
    pub model: Option<String>,
    pub api: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub llm_summary_threshold_chars: usize,
    pub title_max_chars: usize,
}

#[derive(Debug, Clone)]
pub struct ObserverConfig {
    pub name: String,
    pub llm: String,
    pub max_attempts: usize,
}

#[derive(Debug, Clone)]
pub struct StorageConfig {
    pub uri: String,
    pub storage_options: Option<HashMap<String, String>>,
}

const DEFAULT_LLM_SUMMARY_THRESHOLD_CHARS: usize = 500;
pub(crate) const DEFAULT_TITLE_MAX_CHARS: usize = 100;
const DEFAULT_OBSERVER_MAX_ATTEMPTS: usize = 3;

pub fn task_config(task: LlmTask) -> Result<Option<LlmTaskConfig>> {
    let config = load_muninn_config()?;
    let file_config = config
        .as_ref()
        .and_then(|value| resolve_task_llm_config(value, task));
    let provider = file_config
        .as_ref()
        .map(|config| parse_provider(&config.provider))
        .transpose()?;

    let Some(provider) = provider else {
        return Ok(None);
    };

    let model = file_config.as_ref().and_then(|config| config.model.clone());
    let api_key = file_config.as_ref().and_then(resolve_file_api_key);
    let api = file_config.as_ref().and_then(|config| config.api.clone());
    let base_url = file_config
        .as_ref()
        .and_then(|config| config.base_url.clone());
    let llm_summary_threshold_chars = config
        .as_ref()
        .and_then(|config| config.turn.as_ref())
        .and_then(|config| config.llm_summary_threshold_chars)
        .unwrap_or(DEFAULT_LLM_SUMMARY_THRESHOLD_CHARS);
    let title_max_chars = config
        .as_ref()
        .and_then(|config| config.turn.as_ref())
        .and_then(|config| config.title_max_chars)
        .unwrap_or(DEFAULT_TITLE_MAX_CHARS);

    Ok(Some(LlmTaskConfig {
        provider,
        model,
        api,
        api_key,
        base_url,
        llm_summary_threshold_chars,
        title_max_chars,
    }))
}

pub fn current_observer_config() -> Result<Option<ObserverConfig>> {
    Ok(load_muninn_config()?.and_then(|config| {
        config.observer.map(|observer| ObserverConfig {
            name: observer.name,
            llm: observer.llm,
            max_attempts: observer
                .max_attempts
                .unwrap_or(DEFAULT_OBSERVER_MAX_ATTEMPTS),
        })
    }))
}

pub fn current_storage_config() -> Result<Option<StorageConfig>> {
    Ok(load_muninn_config()?.and_then(|config| {
        config.storage.map(|storage| StorageConfig {
            uri: storage.uri,
            storage_options: storage.storage_options,
        })
    }))
}

pub fn observing_max_attempts() -> Result<usize> {
    Ok(current_observer_config()?
        .map(|config| config.max_attempts)
        .unwrap_or(DEFAULT_OBSERVER_MAX_ATTEMPTS))
}

pub fn current_observer_name() -> Result<Option<String>> {
    Ok(current_observer_config()?.map(|config| config.name))
}

pub fn effective_observer_name() -> Result<String> {
    Ok(current_observer_name()?.unwrap_or_else(|| "default-observer".to_string()))
}

fn parse_provider(value: &str) -> Result<LlmProviderKind> {
    match value {
        "mock" => Ok(LlmProviderKind::Mock),
        "openai" => Ok(LlmProviderKind::OpenAi),
        other => Err(Error::invalid_input(format!(
            "unsupported llm provider: {other}"
        ))),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MuninnConfig {
    pub storage: Option<StorageFileConfig>,
    pub turn: Option<TurnFileConfig>,
    pub observer: Option<ObserverFileConfig>,
    pub llm: Option<HashMap<String, LlmFileConfig>>,
    pub semantic_index: Option<SemanticIndexFileConfig>,
    pub watchdog: Option<WatchdogFileConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageFileConfig {
    pub uri: String,
    pub storage_options: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnFileConfig {
    pub llm: Option<String>,
    pub llm_summary_threshold_chars: Option<usize>,
    pub title_max_chars: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObserverFileConfig {
    pub name: String,
    pub llm: String,
    pub max_attempts: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlmFileConfig {
    pub provider: String,
    pub model: Option<String>,
    pub api: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticIndexFileConfig {
    pub embedding: EmbeddingFileConfig,
    pub default_importance: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchdogFileConfig {
    pub enabled: Option<bool>,
    pub interval_ms: Option<u64>,
    pub compact_min_fragments: Option<usize>,
    pub semantic_index: Option<WatchdogSemanticIndexFileConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchdogSemanticIndexFileConfig {
    pub target_partition_size: Option<usize>,
    pub optimize_merge_count: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddingFileConfig {
    pub provider: String,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub dimensions: Option<usize>,
}

fn resolve_task_llm_config(config: &MuninnConfig, task: LlmTask) -> Option<LlmFileConfig> {
    let llm_name = match task {
        LlmTask::Turn => config.turn.as_ref()?.llm.as_deref()?,
        LlmTask::Observer => config.observer.as_ref()?.llm.as_str(),
    };
    config.llm.as_ref()?.get(llm_name).cloned()
}

fn load_muninn_config() -> Result<Option<MuninnConfig>> {
    let path = config_path();
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| Error::io(format!("failed to read {}: {error}", path.display())))?;
    let parsed = serde_json::from_str::<MuninnConfig>(&raw).map_err(|error| {
        Error::invalid_input(format!(
            "invalid Muninn config {}: {error}",
            path.display()
        ))
    })?;
    Ok(Some(parsed))
}

pub(crate) fn config_path() -> Option<PathBuf> {
    Some(muninn_home().join(CONFIG_FILE_NAME))
}

pub(crate) fn muninn_home() -> PathBuf {
    if let Ok(path) = std::env::var("MUNINN_HOME") {
        return PathBuf::from(path);
    }

    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".muninn");
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".muninn")
}

fn resolve_file_api_key(config: &LlmFileConfig) -> Option<String> {
    config.api_key.clone()
}

#[cfg(test)]
pub(crate) fn llm_test_env_guard() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};

    static LLM_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = LLM_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let isolated_home = std::env::temp_dir().join("muninn-test-home");
    fs::create_dir_all(&isolated_home).expect("create isolated muninn home");
    let isolated_config_path = isolated_home.join(CONFIG_FILE_NAME);
    let default_config = r#"{
  "observer": {
    "name": "test-observer",
    "llm": "missing_test_llm"
  }
}"#;
    fs::write(&isolated_config_path, default_config).expect("write test observer config");
    unsafe {
        std::env::set_var("MUNINN_HOME", isolated_home.as_os_str());
    }

    guard
}

#[cfg(test)]
pub(crate) fn write_test_muninn_config(
    path: &std::path::Path,
    turn_provider: Option<&str>,
    observer_provider: Option<&str>,
    semantic_index_provider: Option<&str>,
) {
    use serde_json::{Map, Value, json};

    let mut root = Map::<String, Value>::new();
    let mut llm = Map::<String, Value>::new();

    if let Some(provider) = turn_provider {
        root.insert(
            "turn".to_string(),
            json!({
                "llm": "test_turn_llm",
            }),
        );
        llm.insert(
            "test_turn_llm".to_string(),
            json!({
                "provider": provider,
            }),
        );
    }

    if let Some(provider) = observer_provider {
        root.insert(
            "observer".to_string(),
            json!({
                "name": "test-observer",
                "llm": "test_observer_llm",
                "maxAttempts": 3,
            }),
        );
        llm.insert(
            "test_observer_llm".to_string(),
            json!({
                "provider": provider,
            }),
        );
    } else {
        root.insert(
            "observer".to_string(),
            json!({
                "name": "test-observer",
                "llm": "missing_test_llm",
                "maxAttempts": 3,
            }),
        );
    }

    if !llm.is_empty() {
        root.insert("llm".to_string(), Value::Object(llm));
    }

    if let Some(provider) = semantic_index_provider {
        root.insert(
            "semanticIndex".to_string(),
            json!({
                "embedding": {
                    "provider": provider,
                    "dimensions": 4,
                },
                "defaultImportance": 0.7,
            }),
        );
    }

    fs::write(
        path,
        serde_json::to_string_pretty(&Value::Object(root)).expect("serialize test muninn config"),
    )
    .expect("write test muninn config");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        CONFIG_FILE_NAME, DEFAULT_LLM_SUMMARY_THRESHOLD_CHARS, DEFAULT_OBSERVER_MAX_ATTEMPTS,
        DEFAULT_TITLE_MAX_CHARS, LlmTask, current_observer_name, current_storage_config,
        llm_test_env_guard, observing_max_attempts, task_config,
    };

    #[test]
    fn reads_turn_and_observer_config_from_turn_and_observer_sections() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        fs::create_dir_all(&home).unwrap();
        let path = home.join(CONFIG_FILE_NAME);
        fs::write(
            &path,
            r#"{
              "turn": {
                "llm": "default_turn_llm",
                "llmSummaryThresholdChars": 640,
                "titleMaxChars": 120
              },
              "observer": {
                "name": "sidecar-a",
                "llm": "default_observer_llm",
                "maxAttempts": 5
              },
              "llm": {
                "default_turn_llm": {
                  "provider": "openai",
                  "model": "gpt-5.4-mini",
                  "api": "responses",
                  "apiKey": "sk-test",
                  "baseUrl": "https://example.test/v1/responses"
                },
                "default_observer_llm": {
                  "provider": "openai",
                  "model": "gpt-5.4-mini",
                  "api": "responses",
                  "apiKey": "sk-observer",
                  "baseUrl": "https://example.test/v1/responses"
                }
              }
            }"#,
        )
        .unwrap();

        unsafe {
            std::env::set_var("MUNINN_HOME", home.as_os_str());
        }

        let turn_config = task_config(LlmTask::Turn).unwrap().unwrap();
        let observer_config = task_config(LlmTask::Observer).unwrap().unwrap();
        assert_eq!(turn_config.model.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(observer_config.model.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(
            current_observer_name().unwrap().as_deref(),
            Some("sidecar-a")
        );
        assert_eq!(observing_max_attempts().unwrap(), 5);
        assert_eq!(turn_config.api_key.as_deref(), Some("sk-test"));
        assert_eq!(
            turn_config.base_url.as_deref(),
            Some("https://example.test/v1/responses")
        );
        assert_eq!(turn_config.llm_summary_threshold_chars, 640);
        assert_eq!(turn_config.title_max_chars, 120);
        assert_eq!(observer_config.api_key.as_deref(), Some("sk-observer"));

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[test]
    fn uses_muninn_home_when_set() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let muninn_home = dir.path().join("custom-home");
        fs::create_dir_all(&muninn_home).unwrap();
        fs::write(
            muninn_home.join(CONFIG_FILE_NAME),
            r#"{
              "turn": {"llm": "project-turn"},
              "observer": {"name": "project-observer", "llm": "project-observer"},
              "llm": {
                "project-turn": {"provider": "openai", "model": "project-model", "apiKey": "project-key"},
                "project-observer": {"provider": "openai", "model": "project-observer-model", "apiKey": "project-observer-key"}
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &muninn_home);
        }

        let config = task_config(LlmTask::Turn).unwrap().unwrap();
        assert_eq!(config.model.as_deref(), Some("project-model"));
        assert_eq!(config.api_key.as_deref(), Some("project-key"));
        assert_eq!(
            current_observer_name().unwrap().as_deref(),
            Some("project-observer")
        );
        assert_eq!(
            config.llm_summary_threshold_chars,
            DEFAULT_LLM_SUMMARY_THRESHOLD_CHARS
        );
        assert_eq!(config.title_max_chars, DEFAULT_TITLE_MAX_CHARS);
        assert_eq!(
            observing_max_attempts().unwrap(),
            DEFAULT_OBSERVER_MAX_ATTEMPTS
        );

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[test]
    fn falls_back_to_default_home_settings_when_muninn_home_is_missing() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let fake_home = dir.path().join("home");
        let user_config = fake_home.join(".muninn").join(CONFIG_FILE_NAME);
        fs::create_dir_all(user_config.parent().unwrap()).unwrap();
        fs::write(
            &user_config,
            r#"{
              "turn": {"llm": "user-turn"},
              "observer": {"name": "user-observer", "llm": "user-observer"},
              "llm": {
                "user-turn": {"provider": "openai", "model": "user-turn-model", "apiKey": "user-turn-key"},
                "user-observer": {"provider": "openai", "model": "user-model", "apiKey": "user-key"}
              }
            }"#,
        )
        .unwrap();

        unsafe {
            std::env::remove_var("MUNINN_HOME");
            std::env::set_var("HOME", &fake_home);
        }

        let config = task_config(LlmTask::Observer).unwrap().unwrap();
        assert_eq!(config.model.as_deref(), Some("user-model"));
        assert_eq!(config.api_key.as_deref(), Some("user-key"));
        assert_eq!(
            current_observer_name().unwrap().as_deref(),
            Some("user-observer")
        );
        assert_eq!(
            config.llm_summary_threshold_chars,
            DEFAULT_LLM_SUMMARY_THRESHOLD_CHARS
        );
        assert_eq!(config.title_max_chars, DEFAULT_TITLE_MAX_CHARS);
        assert_eq!(
            observing_max_attempts().unwrap(),
            DEFAULT_OBSERVER_MAX_ATTEMPTS
        );
    }

    #[test]
    fn reads_storage_config_from_settings() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(CONFIG_FILE_NAME),
            r#"{
              "storage": {
                "uri": "s3://example-bucket/muninn",
                "storageOptions": {
                  "region": "ap-southeast-1",
                  "access_key_id": "key"
                }
              },
              "observer": {"name": "obs", "llm": "obs-llm"},
              "llm": {
                "obs-llm": {"provider": "mock"}
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }

        let storage = current_storage_config().unwrap().unwrap();
        assert_eq!(storage.uri, "s3://example-bucket/muninn");
        assert_eq!(
            storage
                .storage_options
                .as_ref()
                .and_then(|options| options.get("region"))
                .map(String::as_str),
            Some("ap-southeast-1")
        );
        assert_eq!(
            storage
                .storage_options
                .as_ref()
                .and_then(|options| options.get("access_key_id"))
                .map(String::as_str),
            Some("key")
        );

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }
}
