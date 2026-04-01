use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use lance::Dataset;
use lance::Result;
use lance::dataset::optimize::{CompactionOptions, compact_files};
use lance::index::vector::VectorIndexParams;
use lance_index::optimize::OptimizeOptions;
use lance_index::vector::ivf::builder::recommended_num_partitions;
use lance_index::{DatasetIndexExt, IndexType};
use lance_linalg::distance::MetricType;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::{WatchdogConfig, watchdog_config};
use crate::storage::{DatasetStats, Storage};

pub(crate) const SEMANTIC_VECTOR_INDEX_NAME: &str = "semantic_vector_idx";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ManagedDataset {
    Turn,
    Observing,
    SemanticIndex,
}

impl ManagedDataset {
    const ALL: [Self; 3] = [Self::Turn, Self::Observing, Self::SemanticIndex];

    fn label(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Observing => "observing",
            Self::SemanticIndex => "semantic_index",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DatasetWatchState {
    last_seen_version: Option<u64>,
    last_maintained_version: Option<u64>,
    last_fragment_count: Option<usize>,
}

#[derive(Clone)]
pub(crate) struct Watchdog {
    storage: Storage,
    config: WatchdogConfig,
    state: Arc<Mutex<HashMap<ManagedDataset, DatasetWatchState>>>,
}

pub(crate) struct WatchdogRuntime {
    cancel: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Watchdog {
    pub(crate) fn new(storage: Storage) -> Result<Self> {
        Ok(Self {
            storage,
            config: watchdog_config()?,
            state: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn enabled(&self) -> bool {
        self.config.enabled
    }

    pub(crate) fn interval(&self) -> Duration {
        Duration::from_millis(self.config.interval_ms)
    }

    pub(crate) async fn bootstrap(&self) -> Result<()> {
        self.bootstrap_turn().await?;
        self.bootstrap_observing().await?;
        self.bootstrap_semantic_index().await?;
        Ok(())
    }

    pub(crate) async fn run_once(&self) -> Result<()> {
        for kind in ManagedDataset::ALL {
            if let Err(error) = self.maintain(kind).await {
                eprintln!("[watchdog] {} maintenance failed: {}", kind.label(), error);
            }
        }
        Ok(())
    }

    pub(crate) fn spawn(&self) -> Arc<WatchdogRuntime> {
        let watchdog = self.clone();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = task_cancel.cancelled() => break,
                    _ = tokio::time::sleep(watchdog.interval()) => {
                        if let Err(error) = watchdog.run_once().await {
                            eprintln!("[watchdog] maintenance loop failed: {}", error);
                        }
                    }
                }
            }
        });
        Arc::new(WatchdogRuntime {
            cancel,
            task: Mutex::new(Some(task)),
        })
    }

    async fn bootstrap_turn(&self) -> Result<()> {
        if let Some(stats) = self.storage.sessions().maintenance_stats().await? {
            self.update_state(ManagedDataset::Turn, stats, false).await;
        }
        Ok(())
    }

    async fn bootstrap_observing(&self) -> Result<()> {
        if let Some(stats) = self.storage.observings().maintenance_stats().await? {
            self.update_state(ManagedDataset::Observing, stats, false)
                .await;
        }
        Ok(())
    }

    async fn bootstrap_semantic_index(&self) -> Result<()> {
        let mut dataset = self.storage.semantic_index().ensure_dataset().await?;
        let created = ensure_semantic_vector_index(&mut dataset, &self.config).await?;
        let stats = dataset_stats(&dataset).await?;
        self.update_state(ManagedDataset::SemanticIndex, stats, created)
            .await;
        Ok(())
    }

    async fn maintain(&self, kind: ManagedDataset) -> Result<()> {
        match kind {
            ManagedDataset::Turn => self.maintain_turn().await,
            ManagedDataset::Observing => self.maintain_observing().await,
            ManagedDataset::SemanticIndex => self.maintain_semantic_index().await,
        }
    }

    async fn maintain_turn(&self) -> Result<()> {
        let Some(mut dataset) = self.storage.sessions().try_open_dataset().await? else {
            return Ok(());
        };
        let stats = dataset_stats(&dataset).await?;
        if self.seen_version(ManagedDataset::Turn).await == Some(stats.version) {
            return Ok(());
        }

        let maintained = if stats.fragment_count >= self.config.compact_min_fragments {
            compact_files(&mut dataset, CompactionOptions::default(), None).await?;
            true
        } else {
            false
        };
        let after = dataset_stats(&dataset).await?;
        self.update_state(ManagedDataset::Turn, after, maintained)
            .await;
        Ok(())
    }

    async fn maintain_observing(&self) -> Result<()> {
        let Some(mut dataset) = self.storage.observings().try_open_dataset().await? else {
            return Ok(());
        };
        let stats = dataset_stats(&dataset).await?;
        if self.seen_version(ManagedDataset::Observing).await == Some(stats.version) {
            return Ok(());
        }

        let maintained = if stats.fragment_count >= self.config.compact_min_fragments {
            compact_files(&mut dataset, CompactionOptions::default(), None).await?;
            true
        } else {
            false
        };
        let after = dataset_stats(&dataset).await?;
        self.update_state(ManagedDataset::Observing, after, maintained)
            .await;
        Ok(())
    }

    async fn maintain_semantic_index(&self) -> Result<()> {
        let mut dataset = self.storage.semantic_index().ensure_dataset().await?;
        let initial_stats = dataset_stats(&dataset).await?;
        if self.seen_version(ManagedDataset::SemanticIndex).await == Some(initial_stats.version) {
            return Ok(());
        }

        ensure_semantic_vector_index(&mut dataset, &self.config).await?;
        if initial_stats.fragment_count >= self.config.compact_min_fragments {
            compact_files(&mut dataset, CompactionOptions::default(), None).await?;
        }
        dataset
            .optimize_indices(
                &OptimizeOptions::merge(self.config.semantic_index.optimize_merge_count)
                    .index_names(vec![SEMANTIC_VECTOR_INDEX_NAME.to_string()]),
            )
            .await?;

        let after = dataset_stats(&dataset).await?;
        self.update_state(ManagedDataset::SemanticIndex, after, true)
            .await;
        Ok(())
    }

    async fn seen_version(&self, kind: ManagedDataset) -> Option<u64> {
        self.state
            .lock()
            .await
            .get(&kind)
            .and_then(|state| state.last_seen_version)
    }

    async fn update_state(&self, kind: ManagedDataset, stats: DatasetStats, maintained: bool) {
        let mut state = self.state.lock().await;
        let entry = state.entry(kind).or_default();
        entry.last_seen_version = Some(stats.version);
        entry.last_fragment_count = Some(stats.fragment_count);
        if maintained {
            entry.last_maintained_version = Some(stats.version);
        }
    }

    #[cfg(test)]
    async fn state_for(&self, kind: ManagedDataset) -> DatasetWatchState {
        self.state
            .lock()
            .await
            .get(&kind)
            .cloned()
            .unwrap_or_default()
    }
}

impl WatchdogRuntime {
    pub(crate) async fn shutdown(&self, wait: bool) {
        self.cancel.cancel();
        if !wait {
            return;
        }
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }

    #[cfg(test)]
    async fn is_shutdown(&self) -> bool {
        self.task.lock().await.is_none()
    }
}

impl Drop for WatchdogRuntime {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn dataset_stats(dataset: &Dataset) -> Result<DatasetStats> {
    Ok(DatasetStats {
        version: dataset.version().version,
        fragment_count: dataset.get_fragments().len(),
        row_count: dataset.count_rows(None).await?,
    })
}

async fn ensure_semantic_vector_index(
    dataset: &mut Dataset,
    config: &WatchdogConfig,
) -> Result<bool> {
    if has_index_named(dataset, SEMANTIC_VECTOR_INDEX_NAME).await? {
        return Ok(false);
    }

    let row_count = dataset.count_rows(None).await? as usize;
    if row_count == 0 {
        return Ok(false);
    }
    let partitions =
        recommended_num_partitions(row_count, config.semantic_index.target_partition_size);
    let params = VectorIndexParams::ivf_flat(partitions.max(1), MetricType::Cosine);
    dataset
        .create_index_builder(&["vector"], IndexType::Vector, &params)
        .name(SEMANTIC_VECTOR_INDEX_NAME.to_string())
        .await?;
    Ok(true)
}

async fn has_index_named(dataset: &Dataset, name: &str) -> Result<bool> {
    Ok(dataset
        .describe_indices(None)
        .await?
        .iter()
        .any(|index| index.name() == name))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use lance_index::DatasetIndexExt;
    use serde_json::json;

    use super::{ManagedDataset, SEMANTIC_VECTOR_INDEX_NAME, Watchdog};
    use crate::llm::config::llm_test_env_guard;
    use crate::storage::Storage;

    fn test_storage() -> Storage {
        Storage::local(crate::config::data_root().unwrap()).unwrap()
    }

    fn write_watchdog_config(dir: &tempfile::TempDir) {
        let home = dir.path().join("munnai");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("settings.json"),
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
            std::env::set_var("MUNNAI_HOME", &home);
        }
    }

    #[tokio::test]
    async fn bootstrap_creates_semantic_index_dataset_and_index() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_watchdog_config(&dir);
        let storage = test_storage();
        storage
            .semantic_index()
            .upsert(vec![crate::format::semantic_index::SemanticIndexRow {
                id: "mem-bootstrap".to_string(),
                memory_id: "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string(),
                text: "text-bootstrap".to_string(),
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.7,
                category: "fact".to_string(),
                created_at: chrono::Utc::now(),
            }])
            .await
            .unwrap();
        let watchdog = Watchdog::new(storage.clone()).unwrap();

        watchdog.bootstrap().await.unwrap();

        let dataset = storage
            .semantic_index()
            .try_open_dataset()
            .await
            .unwrap()
            .unwrap();
        let indices = dataset.describe_indices(None).await.unwrap();
        assert!(
            indices
                .iter()
                .any(|index| index.name() == SEMANTIC_VECTOR_INDEX_NAME)
        );

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }

    #[tokio::test]
    async fn run_once_updates_semantic_index_state_after_new_rows() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_watchdog_config(&dir);
        let storage = test_storage();
        let watchdog = Watchdog::new(storage.clone()).unwrap();
        watchdog.bootstrap().await.unwrap();

        for index in 0..3 {
            storage
                .semantic_index()
                .upsert(vec![crate::format::semantic_index::SemanticIndexRow {
                    id: format!("mem-{index}"),
                    memory_id: format!("OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8Z{index}"),
                    text: format!("text-{index}"),
                    vector: vec![0.1, 0.2, 0.3, 0.4],
                    importance: 0.7,
                    category: "fact".to_string(),
                    created_at: chrono::Utc::now(),
                }])
                .await
                .unwrap();
        }

        watchdog.run_once().await.unwrap();
        let state = watchdog.state_for(ManagedDataset::SemanticIndex).await;
        assert!(state.last_seen_version.is_some());
        assert!(state.last_maintained_version.is_some());
        assert!(state.last_fragment_count.is_some());

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }

    #[tokio::test]
    async fn runtime_shutdown_is_idempotent() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_watchdog_config(&dir);
        let storage = test_storage();
        let watchdog = Watchdog::new(storage).unwrap();
        let runtime = watchdog.spawn();

        tokio::time::timeout(Duration::from_secs(1), runtime.shutdown(true))
            .await
            .unwrap();
        assert!(runtime.is_shutdown().await);

        tokio::time::timeout(Duration::from_secs(1), runtime.shutdown(true))
            .await
            .unwrap();

        unsafe {
            std::env::remove_var("MUNNAI_HOME");
        }
    }
}
