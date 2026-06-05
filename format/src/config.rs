use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
#[cfg(test)]
use std::path::Path;

use lance::{Error, Result};
use serde::Deserialize;

pub(crate) const CONFIG_FILE_NAME: &str = "muninn.json";

const DEFAULT_SESSION_OBSERVATION_DIMENSIONS: usize = 8;
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
    extractor: Option<ExtractorFileConfig>,
    #[cfg(test)]
    observer: Option<ObserverFileConfig>,
    providers: Option<ProvidersFileConfig>,
    extraction: Option<serde_json::Value>,
    #[serde(rename = "semanticIndex")]
    semantic_index: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractorFileConfig {
    embedding_provider: Option<String>,
    default_importance: Option<serde_json::Value>,
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
struct ProvidersFileConfig {
    embedding: Option<HashMap<String, EmbeddingFileConfig>>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
#[serde(rename_all = "camelCase")]
struct EmbeddingFileConfig {
    #[cfg(test)]
    #[serde(rename = "type")]
    provider_type: String,
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

pub fn session_observation_config() -> Result<EmbeddingConfig> {
    let parsed = load_muninn_config()?;
    let embedding = resolve_embedding_provider(parsed.as_ref())?;
    Ok(EmbeddingConfig {
        #[cfg(test)]
        provider: embedding
            .as_ref()
            .map(|config| config.provider_type.clone())
            .unwrap_or_else(|| "mock".to_string()),
        #[cfg(test)]
        model: embedding.as_ref().and_then(|config| config.model.clone()),
        #[cfg(test)]
        api_key: embedding.as_ref().and_then(|config| config.api_key.clone()),
        #[cfg(test)]
        base_url: embedding.as_ref().and_then(|config| config.base_url.clone()),
        dimensions: embedding
            .as_ref()
            .and_then(|config| config.dimensions)
            .unwrap_or(DEFAULT_SESSION_OBSERVATION_DIMENSIONS),
    })
}

#[cfg(test)]
pub fn session_observation_config_from_raw(raw: &str) -> Result<EmbeddingConfig> {
    let parsed = parse_muninn_config(raw, "provided Muninn config")?;
    let embedding = resolve_embedding_provider(Some(&parsed))?;
    Ok(EmbeddingConfig {
        #[cfg(test)]
        provider: embedding
            .as_ref()
            .map(|config| config.provider_type.clone())
            .unwrap_or_else(|| "mock".to_string()),
        #[cfg(test)]
        model: embedding.as_ref().and_then(|config| config.model.clone()),
        #[cfg(test)]
        api_key: embedding.as_ref().and_then(|config| config.api_key.clone()),
        #[cfg(test)]
        base_url: embedding.as_ref().and_then(|config| config.base_url.clone()),
        dimensions: embedding
            .as_ref()
            .and_then(|config| config.dimensions)
            .unwrap_or(DEFAULT_SESSION_OBSERVATION_DIMENSIONS),
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
    let parsed = serde_json::from_str::<MuninnConfig>(raw)
        .map_err(|error| Error::invalid_input(format!("invalid Muninn config {source}: {error}")))?;
    if parsed.semantic_index.is_some() {
        return Err(Error::invalid_input(
            "semanticIndex is no longer supported; use extractor.embeddingProvider instead.",
        ));
    }
    if parsed.extraction.is_some() {
        return Err(Error::invalid_input(
            "extraction is no longer supported; use extractor.embeddingProvider and extractor.recallMode instead.",
        ));
    }
    if parsed
        .extractor
        .as_ref()
        .and_then(|extractor| extractor.default_importance.as_ref())
        .is_some()
    {
        return Err(Error::invalid_input(
            "extractor.defaultImportance is not supported; extraction importance has been removed.",
        ));
    }
    Ok(parsed)
}

fn resolve_embedding_provider(config: Option<&MuninnConfig>) -> Result<Option<EmbeddingFileConfig>> {
    let Some(config) = config else {
        return Ok(None);
    };
    let Some(provider_name) = config
        .extractor
        .as_ref()
        .and_then(|extractor| extractor.embedding_provider.as_deref())
    else {
        return Ok(None);
    };
    let provider = config
        .providers
        .as_ref()
        .and_then(|providers| providers.embedding.as_ref())
        .and_then(|embeddings| embeddings.get(provider_name))
        .cloned()
        .ok_or_else(|| {
            Error::invalid_input(format!(
                "extractor.embeddingProvider references missing providers.embedding.{provider_name}."
            ))
        })?;
    Ok(Some(provider))
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
    extraction_provider: Option<&str>,
) {
    use serde_json::{Map, Value, json};

    let mut root = Map::<String, Value>::new();
    root.insert(
        "observer".to_string(),
        json!({
            "name": observer_name.unwrap_or("test-observer"),
        }),
    );

    if let Some(provider) = extraction_provider {
        root.insert(
            "providers".to_string(),
            json!({
                "embedding": {
                    "default": {
                        "type": provider,
                        "dimensions": 4
                    }
                }
            }),
        );
        root.insert(
            "extractor".to_string(),
            json!({
                "name": "test-extractor",
                "embeddingProvider": "default"
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
    use super::{DEFAULT_SESSION_OBSERVATION_DIMENSIONS, session_observation_config_from_raw};

    #[test]
    fn session_observation_config_uses_defaults_when_section_is_missing() {
        let config = session_observation_config_from_raw("{}").unwrap();
        assert_eq!(config.provider, "mock");
        assert_eq!(config.dimensions, DEFAULT_SESSION_OBSERVATION_DIMENSIONS);
    }

    #[test]
    fn session_observation_config_rejects_semantic_index() {
        let error = session_observation_config_from_raw(
            r#"{
  "semanticIndex": {
    "embedding": {
      "provider": "mock"
    }
  }
}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("semanticIndex"));
    }

    #[test]
    fn session_observation_config_resolves_extractor_embedding_provider() {
        let config = session_observation_config_from_raw(
            r#"{
  "extractor": {
    "embeddingProvider": "large"
  },
  "providers": {
    "embedding": {
      "large": {
        "type": "mock",
        "dimensions": 16
      }
    }
  }
}"#,
        )
        .unwrap();
        assert_eq!(config.provider, "mock");
        assert_eq!(config.dimensions, 16);
    }

    #[test]
    fn session_observation_config_rejects_top_level_extraction() {
        let error = session_observation_config_from_raw(
            r#"{
  "extraction": {
    "embeddingProvider": "default"
  }
}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("extraction is no longer supported"));
    }

    #[test]
    fn session_observation_config_rejects_extractor_default_importance() {
        let error = session_observation_config_from_raw(
            r#"{
  "extractor": {
    "embeddingProvider": "default",
    "defaultImportance": 0.7
  }
}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("extractor.defaultImportance"));
    }
}
