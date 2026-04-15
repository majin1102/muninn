use lance::Dataset;
use lance::dataset::cleanup::CleanupPolicy;
use lance::Result;
use lance::dataset::optimize::{CompactionOptions, compact_files};
use lance::index::vector::VectorIndexParams;
use lance_index::optimize::OptimizeOptions;
use lance_index::vector::ivf::builder::recommended_num_partitions;
use lance_index::{DatasetIndexExt, IndexType};
use lance_linalg::distance::MetricType;

pub(crate) const SEMANTIC_VECTOR_INDEX_NAME: &str = "semantic_vector_idx";

pub(crate) async fn compact_dataset(dataset: Option<Dataset>) -> Result<bool> {
    let Some(mut dataset) = dataset else {
        return Ok(false);
    };
    let before = dataset.version().version;
    compact_files(&mut dataset, CompactionOptions::default(), None).await?;
    Ok(dataset.version().version != before)
}

pub(crate) async fn cleanup_dataset(dataset: Option<Dataset>, floor_version: u64) -> Result<bool> {
    let Some(dataset) = dataset else {
        return Ok(false);
    };
    let removed = dataset
        .cleanup_with_policy(CleanupPolicy {
            before_version: Some(floor_version),
            ..CleanupPolicy::default()
        })
        .await?;
    Ok(removed.old_versions > 0 || removed.bytes_removed > 0)
}

pub(crate) async fn ensure_semantic_vector_index(
    dataset: &mut Dataset,
    target_partition_size: usize,
) -> Result<bool> {
    if has_index_named(dataset, SEMANTIC_VECTOR_INDEX_NAME).await? {
        return Ok(false);
    }

    let row_count = dataset.count_rows(None).await? as usize;
    if row_count == 0 {
        return Ok(false);
    }
    let partitions = recommended_num_partitions(row_count, target_partition_size);
    let params = VectorIndexParams::ivf_flat(partitions.max(1), MetricType::Cosine);
    dataset
        .create_index_builder(&["vector"], IndexType::Vector, &params)
        .name(SEMANTIC_VECTOR_INDEX_NAME.to_string())
        .await?;
    Ok(true)
}

pub(crate) async fn optimize_semantic_index(
    dataset: &mut Dataset,
    merge_count: usize,
) -> Result<bool> {
    if !has_index_named(dataset, SEMANTIC_VECTOR_INDEX_NAME).await? {
        return Ok(false);
    }
    dataset
        .optimize_indices(
            &OptimizeOptions::merge(merge_count)
                .index_names(vec![SEMANTIC_VECTOR_INDEX_NAME.to_string()]),
        )
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

    use lance_index::DatasetIndexExt;
    use serde_json::json;

    use super::{
        SEMANTIC_VECTOR_INDEX_NAME, cleanup_dataset, compact_dataset, ensure_semantic_vector_index,
        optimize_semantic_index,
    };
    use crate::config::{CONFIG_FILE_NAME, llm_test_env_guard};
    use crate::{MemoryId, MemoryLayer, SemanticIndexRow, SemanticIndexTable, SessionTable, SessionTurn, TableOptions};

    fn test_table_options() -> TableOptions {
        TableOptions::local(crate::config::data_root().unwrap()).unwrap()
    }

    fn write_watchdog_config(dir: &tempfile::TempDir) {
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(CONFIG_FILE_NAME),
            serde_json::to_string_pretty(&json!({
                "semanticIndex": {
                    "embedding": {
                        "provider": "mock",
                        "dimensions": 4
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn ensure_semantic_vector_index_creates_missing_index() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        write_watchdog_config(&dir);

        let table = SemanticIndexTable::new(test_table_options());
        table
            .upsert(vec![SemanticIndexRow {
                id: "row-1".to_string(),
                memory_id: "observing:1".to_string(),
                text: "alpha".to_string(),
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.7,
                category: "fact".to_string(),
                created_at: chrono::Utc::now(),
            }])
            .await
            .unwrap();

        let mut dataset = table.try_open_dataset().await.unwrap().unwrap();
        let created = ensure_semantic_vector_index(&mut dataset, 2).await.unwrap();
        assert!(created);

        let indices = dataset.describe_indices(None).await.unwrap();
        assert!(indices.iter().any(|index| index.name() == SEMANTIC_VECTOR_INDEX_NAME));
    }

    #[tokio::test]
    async fn compact_dataset_noops_without_table() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }

        let changed = compact_dataset(None).await.unwrap();
        assert!(!changed);
    }

    #[tokio::test]
    async fn optimize_semantic_index_noops_without_index() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        write_watchdog_config(&dir);

        let session_table = SessionTable::new(test_table_options());
        let compacted = compact_dataset(session_table.try_open_dataset().await.unwrap())
            .await
            .unwrap();
        assert!(!compacted);

        let table = SemanticIndexTable::new(test_table_options());
        table
            .upsert(vec![SemanticIndexRow {
                id: "row-1".to_string(),
                memory_id: "observing:1".to_string(),
                text: "alpha".to_string(),
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.7,
                category: "fact".to_string(),
                created_at: chrono::Utc::now(),
            }])
            .await
            .unwrap();
        let mut dataset = table.try_open_dataset().await.unwrap().unwrap();
        let optimized = optimize_semantic_index(&mut dataset, 2).await.unwrap();
        assert!(!optimized);
    }

    #[tokio::test]
    async fn cleanup_dataset_keeps_floor_version() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }

        let table = SessionTable::new(test_table_options());
        let now = chrono::Utc::now();
        let mut turn = SessionTurn {
            turn_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
            created_at: now,
            updated_at: now,
            session_id: Some("group-a".to_string()),
            agent: "agent-a".to_string(),
            observer: "default-observer".to_string(),
            title: None,
            summary: Some("summary".to_string()),
            tool_calls: None,
            artifacts: None,
            prompt: Some("prompt".to_string()),
            response: Some("response".to_string()),
            observing_epoch: None,
        };
        table.insert(std::slice::from_mut(&mut turn)).await.unwrap();
        let mut second_turn = turn.clone();
        second_turn.turn_id = MemoryId::new(MemoryLayer::Session, u64::MAX);
        second_turn.created_at = chrono::Utc::now();
        second_turn.updated_at = second_turn.created_at;
        second_turn.prompt = Some("prompt-2".to_string());
        second_turn.response = Some("response-2".to_string());
        table
            .insert(std::slice::from_mut(&mut second_turn))
            .await
            .unwrap();

        let dataset = table.try_open_dataset().await.unwrap().unwrap();
        let versions = dataset.versions().await.unwrap();
        assert!(versions.iter().any(|version| version.version == 1));
        assert!(versions.iter().any(|version| version.version == 2));

        let changed = cleanup_dataset(Some(dataset), 2).await.unwrap();
        assert!(changed);

        let reopened = table.try_open_dataset().await.unwrap().unwrap();
        let versions = reopened.versions().await.unwrap();
        assert!(!versions.iter().any(|version| version.version == 1));
        assert!(versions.iter().any(|version| version.version == 2));
    }
}
