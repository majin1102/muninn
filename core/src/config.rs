use std::fs;
use std::path::PathBuf;

use crate::llm::config::{EmbeddingConfig, MuninnConfig, SemanticIndexFileConfig};
use lance::{Error, Result};

const DEFAULT_SEMANTIC_INDEX_DIMENSIONS: usize = 8;
const DEFAULT_SEMANTIC_INDEX_IMPORTANCE: f32 = 0.7;
const DEFAULT_WATCHDOG_INTERVAL_MS: u64 = 60_000;
const DEFAULT_WATCHDOG_COMPACT_MIN_FRAGMENTS: usize = 8;
const DEFAULT_WATCHDOG_TARGET_PARTITION_SIZE: usize = 1_024;
const DEFAULT_WATCHDOG_OPTIMIZE_MERGE_COUNT: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchdogSemanticIndexConfig {
    pub target_partition_size: usize,
    pub optimize_merge_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchdogConfig {
    pub enabled: bool,
    pub interval_ms: u64,
    pub compact_min_fragments: usize,
    pub semantic_index: WatchdogSemanticIndexConfig,
}

pub fn semantic_index_config() -> Result<EmbeddingConfig> {
    let file_config = load_muninn_config()?.and_then(|config| config.semantic_index);
    Ok(embedding_config_from_file_config(file_config.as_ref()))
}

#[cfg(test)]
pub fn semantic_index_config_from_raw(raw: &str) -> Result<EmbeddingConfig> {
    let parsed = parse_muninn_config(raw, "provided Muninn config")?;
    Ok(embedding_config_from_file_config(
        parsed.semantic_index.as_ref(),
    ))
}

pub fn watchdog_config() -> Result<WatchdogConfig> {
    let file_config = load_muninn_config()?.and_then(|config| config.watchdog);
    let semantic_file_config = file_config
        .as_ref()
        .and_then(|config| config.semantic_index.as_ref());

    let interval_ms = file_config
        .as_ref()
        .and_then(|config| config.interval_ms)
        .unwrap_or(DEFAULT_WATCHDOG_INTERVAL_MS);
    if interval_ms == 0 {
        return Err(Error::invalid_input(
            "watchdog.intervalMs must be a positive integer",
        ));
    }

    let compact_min_fragments = file_config
        .as_ref()
        .and_then(|config| config.compact_min_fragments)
        .unwrap_or(DEFAULT_WATCHDOG_COMPACT_MIN_FRAGMENTS);
    if compact_min_fragments == 0 {
        return Err(Error::invalid_input(
            "watchdog.compactMinFragments must be a positive integer",
        ));
    }

    let target_partition_size = semantic_file_config
        .and_then(|config| config.target_partition_size)
        .unwrap_or(DEFAULT_WATCHDOG_TARGET_PARTITION_SIZE);
    if target_partition_size == 0 {
        return Err(Error::invalid_input(
            "watchdog.semanticIndex.targetPartitionSize must be a positive integer",
        ));
    }

    let optimize_merge_count = semantic_file_config
        .and_then(|config| config.optimize_merge_count)
        .unwrap_or(DEFAULT_WATCHDOG_OPTIMIZE_MERGE_COUNT);
    if optimize_merge_count == 0 {
        return Err(Error::invalid_input(
            "watchdog.semanticIndex.optimizeMergeCount must be a positive integer",
        ));
    }

    Ok(WatchdogConfig {
        enabled: file_config
            .as_ref()
            .and_then(|config| config.enabled)
            .unwrap_or(true),
        interval_ms,
        compact_min_fragments,
        semantic_index: WatchdogSemanticIndexConfig {
            target_partition_size,
            optimize_merge_count,
        },
    })
}

pub fn data_root() -> Result<PathBuf> {
    Ok(crate::llm::config::muninn_home())
}

fn load_muninn_config() -> Result<Option<MuninnConfig>> {
    let path = crate::llm::config::config_path();
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| Error::io(format!("failed to read {}: {error}", path.display())))?;
    let parsed = parse_muninn_config(&raw, &path.display().to_string())?;
    Ok(Some(parsed))
}

fn embedding_config_from_file_config(
    file_config: Option<&SemanticIndexFileConfig>,
) -> EmbeddingConfig {
    let provider = file_config
        .map(|config| config.embedding.provider.clone())
        .unwrap_or_else(|| "mock".to_string());
    let model = file_config.and_then(|config| config.embedding.model.clone());
    let api_key = file_config.and_then(|config| config.embedding.api_key.clone());
    let base_url = file_config.and_then(|config| config.embedding.base_url.clone());
    let dimensions = file_config
        .and_then(|config| config.embedding.dimensions)
        .unwrap_or(DEFAULT_SEMANTIC_INDEX_DIMENSIONS);
    let default_importance = file_config
        .and_then(|config| config.default_importance)
        .unwrap_or(DEFAULT_SEMANTIC_INDEX_IMPORTANCE);

    EmbeddingConfig {
        provider,
        model,
        api_key,
        base_url,
        dimensions,
        default_importance,
    }
}

fn parse_muninn_config(raw: &str, source: &str) -> Result<MuninnConfig> {
    serde_json::from_str::<MuninnConfig>(raw)
        .map_err(|error| Error::invalid_input(format!("invalid Muninn config {source}: {error}")))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{DEFAULT_WATCHDOG_INTERVAL_MS, semantic_index_config_from_raw, watchdog_config};
    use crate::llm::config::llm_test_env_guard;

    #[test]
    fn watchdog_config_uses_defaults_when_section_is_missing() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(crate::llm::config::CONFIG_FILE_NAME), "{}").unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }

        let config = watchdog_config().unwrap();
        assert!(config.enabled);
        assert_eq!(config.interval_ms, DEFAULT_WATCHDOG_INTERVAL_MS);
        assert_eq!(config.compact_min_fragments, 8);
        assert_eq!(config.semantic_index.target_partition_size, 1024);
        assert_eq!(config.semantic_index.optimize_merge_count, 4);

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[test]
    fn watchdog_config_reads_explicit_values() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(crate::llm::config::CONFIG_FILE_NAME),
            r#"{
              "watchdog": {
                "enabled": false,
                "intervalMs": 15000,
                "compactMinFragments": 12,
                "semanticIndex": {
                  "targetPartitionSize": 2048,
                  "optimizeMergeCount": 6
                }
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }

        let config = watchdog_config().unwrap();
        assert!(!config.enabled);
        assert_eq!(config.interval_ms, 15_000);
        assert_eq!(config.compact_min_fragments, 12);
        assert_eq!(config.semantic_index.target_partition_size, 2_048);
        assert_eq!(config.semantic_index.optimize_merge_count, 6);

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[test]
    fn semantic_index_config_from_raw_uses_defaults_when_section_is_missing() {
        let config = semantic_index_config_from_raw("{}").unwrap();
        assert_eq!(config.provider, "mock");
        assert_eq!(config.dimensions, 8);
        assert_eq!(config.default_importance, 0.7);
    }
}
