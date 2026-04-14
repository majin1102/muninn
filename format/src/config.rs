use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
#[cfg(test)]
use std::path::Path;

use lance::{Error, Result};
use serde::Deserialize;

pub(crate) const CONFIG_FILE_NAME: &str = "muninn.json";

const DEFAULT_SEMANTIC_INDEX_DIMENSIONS: usize = 8;
#[cfg(test)]
const DEFAULT_SEMANTIC_INDEX_IMPORTANCE: f32 = 0.7;
#[cfg(test)]
#[allow(dead_code)]
const DEFAULT_OBSERVER_NAME: &str = "default-observer";

#[derive(Debug, Clone)]
#[cfg_attr(test, allow(dead_code))]
pub struct EmbeddingConfig {
    #[cfg(test)]
    pub provider: String,
    #[cfg(test)]
    pub model: Option<String>,
    #[cfg(test)]
    pub api_key: Option<String>,
    #[cfg(test)]
    pub base_url: Option<String>,
    pub dimensions: usize,
    #[cfg(test)]
    pub default_importance: f32,
}

#[derive(Debug, Clone)]
pub struct StorageConfig {
    pub uri: String,
    pub storage_options: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, allow(dead_code))]
struct MuninnConfig {
    storage: Option<StorageFileConfig>,
    #[cfg(test)]
    observer: Option<ObserverFileConfig>,
    semantic_index: Option<SemanticIndexFileConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageFileConfig {
    uri: String,
    storage_options: Option<HashMap<String, String>>,
}

#[cfg(test)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ObserverFileConfig {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
#[serde(rename_all = "camelCase")]
struct SemanticIndexFileConfig {
    embedding: EmbeddingFileConfig,
    #[cfg(test)]
    default_importance: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
#[serde(rename_all = "camelCase")]
struct EmbeddingFileConfig {
    #[cfg(test)]
    provider: String,
    #[cfg(test)]
    model: Option<String>,
    #[cfg(test)]
    api_key: Option<String>,
    #[cfg(test)]
    base_url: Option<String>,
    dimensions: Option<usize>,
}

pub fn data_root() -> Result<PathBuf> {
    Ok(muninn_home())
}

pub fn current_storage_config() -> Result<Option<StorageConfig>> {
    Ok(load_muninn_config()?.and_then(|config| {
        config.storage.map(|storage| StorageConfig {
            uri: storage.uri,
            storage_options: storage.storage_options,
        })
    }))
}

pub fn semantic_index_config() -> Result<EmbeddingConfig> {
    let file_config = load_muninn_config()?.and_then(|config| config.semantic_index);
    Ok(EmbeddingConfig {
        #[cfg(test)]
        provider: file_config
            .as_ref()
            .map(|config| config.embedding.provider.clone())
            .unwrap_or_else(|| "mock".to_string()),
        #[cfg(test)]
        model: file_config
            .as_ref()
            .and_then(|config| config.embedding.model.clone()),
        #[cfg(test)]
        api_key: file_config
            .as_ref()
            .and_then(|config| config.embedding.api_key.clone()),
        #[cfg(test)]
        base_url: file_config
            .as_ref()
            .and_then(|config| config.embedding.base_url.clone()),
        dimensions: file_config
            .as_ref()
            .and_then(|config| config.embedding.dimensions)
            .unwrap_or(DEFAULT_SEMANTIC_INDEX_DIMENSIONS),
        #[cfg(test)]
        default_importance: file_config
            .as_ref()
            .and_then(|config| config.default_importance)
            .unwrap_or(DEFAULT_SEMANTIC_INDEX_IMPORTANCE),
    })
}

#[cfg(test)]
pub fn semantic_index_config_from_raw(raw: &str) -> Result<EmbeddingConfig> {
    let parsed = parse_muninn_config(raw, "provided Muninn config")?;
    Ok(EmbeddingConfig {
        #[cfg(test)]
        provider: parsed
            .semantic_index
            .as_ref()
            .map(|config| config.embedding.provider.clone())
            .unwrap_or_else(|| "mock".to_string()),
        #[cfg(test)]
        model: parsed
            .semantic_index
            .as_ref()
            .and_then(|config| config.embedding.model.clone()),
        #[cfg(test)]
        api_key: parsed
            .semantic_index
            .as_ref()
            .and_then(|config| config.embedding.api_key.clone()),
        #[cfg(test)]
        base_url: parsed
            .semantic_index
            .as_ref()
            .and_then(|config| config.embedding.base_url.clone()),
        dimensions: parsed
            .semantic_index
            .as_ref()
            .and_then(|config| config.embedding.dimensions)
            .unwrap_or(DEFAULT_SEMANTIC_INDEX_DIMENSIONS),
        #[cfg(test)]
        default_importance: parsed
            .semantic_index
            .as_ref()
            .and_then(|config| config.default_importance)
            .unwrap_or(DEFAULT_SEMANTIC_INDEX_IMPORTANCE),
    })
}

pub(crate) fn config_path() -> PathBuf {
    muninn_home().join(CONFIG_FILE_NAME)
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

fn load_muninn_config() -> Result<Option<MuninnConfig>> {
    let path = config_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| Error::io(format!("failed to read {}: {error}", path.display())))?;
    let parsed = parse_muninn_config(&raw, &path.display().to_string())?;
    Ok(Some(parsed))
}

fn parse_muninn_config(raw: &str, source: &str) -> Result<MuninnConfig> {
    serde_json::from_str::<MuninnConfig>(raw)
        .map_err(|error| Error::invalid_input(format!("invalid Muninn config {source}: {error}")))
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn effective_observer_name() -> Result<String> {
    Ok(load_muninn_config()?
        .and_then(|config| config.observer.map(|observer| observer.name))
        .unwrap_or_else(|| DEFAULT_OBSERVER_NAME.to_string()))
}

#[cfg(test)]
pub(crate) fn llm_test_env_guard() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let isolated_home = std::env::temp_dir().join("muninn-test-home");
    fs::create_dir_all(&isolated_home).expect("create isolated muninn home");
    fs::write(
        isolated_home.join(CONFIG_FILE_NAME),
        r#"{
  "observer": {
    "name": "test-observer"
  }
}"#,
    )
    .expect("write isolated muninn config");
    unsafe {
        std::env::set_var("MUNINN_HOME", isolated_home.as_os_str());
    }

    guard
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn write_test_muninn_config(
    path: &Path,
    observer_name: Option<&str>,
    semantic_index_provider: Option<&str>,
) {
    use serde_json::{Map, Value, json};

    let mut root = Map::<String, Value>::new();
    root.insert(
        "observer".to_string(),
        json!({
            "name": observer_name.unwrap_or("test-observer"),
        }),
    );

    if let Some(provider) = semantic_index_provider {
        root.insert(
            "semanticIndex".to_string(),
            json!({
                "embedding": {
                    "provider": provider,
                    "dimensions": 4
                },
                "defaultImportance": 0.7
            }),
        );
    }

    fs::write(
        path,
        serde_json::to_string_pretty(&Value::Object(root)).expect("serialize test config"),
    )
    .expect("write test muninn config");
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_SEMANTIC_INDEX_DIMENSIONS, semantic_index_config_from_raw};

    #[test]
    fn semantic_index_config_uses_defaults_when_section_is_missing() {
        let config = semantic_index_config_from_raw("{}").unwrap();
        assert_eq!(config.provider, "mock");
        assert_eq!(config.dimensions, DEFAULT_SEMANTIC_INDEX_DIMENSIONS);
        assert_eq!(config.default_importance, 0.7);
    }
}
