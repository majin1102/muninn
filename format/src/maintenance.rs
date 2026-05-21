use lance::Dataset;
use lance::Result;
use lance::dataset::cleanup::CleanupPolicy;
use lance::dataset::optimize::{CompactionOptions, compact_files};
use lance::index::vector::VectorIndexParams;
use lance_index::optimize::OptimizeOptions;
use lance_index::scalar::InvertedIndexParams;
use lance_index::vector::ivf::builder::recommended_num_partitions;
use lance_index::{DatasetIndexExt, IndexType};
use lance_linalg::distance::MetricType;

pub(crate) const SEMANTIC_VECTOR_INDEX_NAME: &str = "semantic_vector_idx";
pub(crate) const EXTRACTION_FTS_INDEX_NAME: &str = "extraction_fts_idx";
pub(crate) const EXTRACTION_SEARCH_TEXT_COLUMN: &str = "search_text";
pub(crate) const OBSERVATION_FTS_INDEX_NAME: &str = "observation_fts_idx";
pub(crate) const OBSERVATION_SEARCH_TEXT_COLUMN: &str = "text";

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

pub(crate) async fn ensure_extraction_fts_index(dataset: &mut Dataset) -> Result<bool> {
    if has_index_named(dataset, EXTRACTION_FTS_INDEX_NAME).await? {
        return Ok(false);
    }

    let row_count = dataset.count_rows(None).await? as usize;
    if row_count == 0 {
        return Ok(false);
    }
    dataset
        .create_index_builder(
            &[EXTRACTION_SEARCH_TEXT_COLUMN],
            IndexType::Inverted,
            &InvertedIndexParams::default(),
        )
        .name(EXTRACTION_FTS_INDEX_NAME.to_string())
        .await?;
    Ok(true)
}

pub(crate) async fn ensure_observation_fts_index(dataset: &mut Dataset) -> Result<bool> {
    if has_index_named(dataset, OBSERVATION_FTS_INDEX_NAME).await? {
        return Ok(false);
    }

    let row_count = dataset.count_rows(None).await? as usize;
    if row_count == 0 {
        return Ok(false);
    }
    dataset
        .create_index_builder(
            &[OBSERVATION_SEARCH_TEXT_COLUMN],
            IndexType::Inverted,
            &InvertedIndexParams::default(),
        )
        .name(OBSERVATION_FTS_INDEX_NAME.to_string())
        .await?;
    Ok(true)
}

pub(crate) async fn ensure_extraction_id_index(dataset: &mut Dataset) -> Result<bool> {
    let _ = dataset;
    Ok(false)
}

pub(crate) async fn ensure_observation_id_index(dataset: &mut Dataset) -> Result<bool> {
    let _ = dataset;
    Ok(false)
}

pub(crate) async fn ensure_observation_context_id_index(dataset: &mut Dataset) -> Result<bool> {
    let _ = dataset;
    Ok(false)
}

pub(crate) async fn optimize_extraction(
    dataset: &mut Dataset,
    merge_count: usize,
) -> Result<bool> {
    let mut names = Vec::new();
    for name in [SEMANTIC_VECTOR_INDEX_NAME, EXTRACTION_FTS_INDEX_NAME] {
        if has_index_named(dataset, name).await? {
            names.push(name.to_string());
        }
    }
    if names.is_empty() {
        return Ok(false);
    }
    dataset
        .optimize_indices(&OptimizeOptions::merge(merge_count).index_names(names))
        .await?;
    Ok(true)
}

pub(crate) async fn optimize_observation(
    dataset: &mut Dataset,
    merge_count: usize,
) -> Result<bool> {
    let mut names = Vec::new();
    for name in [SEMANTIC_VECTOR_INDEX_NAME, OBSERVATION_FTS_INDEX_NAME] {
        if has_index_named(dataset, name).await? {
            names.push(name.to_string());
        }
    }
    if names.is_empty() {
        return Ok(false);
    }
    dataset
        .optimize_indices(&OptimizeOptions::merge(merge_count).index_names(names))
        .await?;
    Ok(true)
}

pub(crate) async fn optimize_observation_context(
    dataset: &mut Dataset,
    merge_count: usize,
) -> Result<bool> {
    let _ = dataset;
    let _ = merge_count;
    Ok(false)
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
        SEMANTIC_VECTOR_INDEX_NAME, cleanup_dataset, compact_dataset, ensure_extraction_id_index,
        ensure_observation_context_id_index, ensure_observation_id_index,
        ensure_semantic_vector_index, optimize_extraction,
    };
    use crate::config::{CONFIG_FILE_NAME, llm_test_env_guard};
    use crate::{
        Extraction, ExtractionTable, MemoryId, MemoryLayer, Observation, ObservationContext,
        ObservationContextTable, ObservationTable, TableOptions, Turn, TurnTable,
    };

    fn test_table_options() -> TableOptions {
        TableOptions::local(crate::config::data_root().unwrap()).unwrap()
    }

    fn write_watchdog_config(dir: &tempfile::TempDir) {
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(CONFIG_FILE_NAME),
            serde_json::to_string_pretty(&json!({
                "extraction": {
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

        let table = ExtractionTable::new(test_table_options());
        table
            .upsert(vec![Extraction {
                id: "row-1".to_string(),
                text: "alpha".to_string(),
                context: None,
                anchors: vec![],
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.7,
                turn_refs: vec!["turn:1".to_string()],
                observation_paths: vec![],
                observed_root_anchors: vec![],
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            }])
            .await
            .unwrap();

        let mut dataset = table.try_open_dataset().await.unwrap().unwrap();
        let created = ensure_semantic_vector_index(&mut dataset, 2).await.unwrap();
        assert!(created);

        let indices = dataset.describe_indices(None).await.unwrap();
        assert!(
            indices
                .iter()
                .any(|index| index.name() == SEMANTIC_VECTOR_INDEX_NAME)
        );
    }

    #[tokio::test]
    async fn ensure_id_indexes_are_disabled() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        write_watchdog_config(&dir);
        let now = chrono::Utc::now();

        let extraction_table = ExtractionTable::new(test_table_options());
        extraction_table
            .upsert(vec![Extraction {
                id: "extraction-1".to_string(),
                text: "alpha".to_string(),
                context: None,
                anchors: vec![],
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.7,
                turn_refs: vec!["turn:1".to_string()],
                observation_paths: vec![],
                observed_root_anchors: vec![],
                created_at: now,
                updated_at: now,
            }])
            .await
            .unwrap();
        let mut extraction_dataset = extraction_table.try_open_dataset().await.unwrap().unwrap();
        assert!(!ensure_extraction_id_index(&mut extraction_dataset).await.unwrap());

        let observation_table = ObservationTable::new(test_table_options());
        observation_table
            .upsert(vec![Observation {
                id: "observation-1".to_string(),
                observing_path: "Alice / Plan".to_string(),
                text: "Alice has a plan.".to_string(),
                vector: vec![0.1, 0.2, 0.3, 0.4],
                extraction_refs: vec!["extraction-1".to_string()],
                created_at: now,
                updated_at: now,
            }])
            .await
            .unwrap();
        let mut observation_dataset = observation_table.try_open_dataset().await.unwrap().unwrap();
        assert!(!ensure_observation_id_index(&mut observation_dataset).await.unwrap());

        let context_table = ObservationContextTable::new(test_table_options());
        context_table
            .upsert(vec![ObservationContext {
                id: "context-1".to_string(),
                observing_path: "Alice / Plan".to_string(),
                parent_id: None,
                position: 0,
                content: "Alice planning context.".to_string(),
                source_refs: vec!["extraction:1".to_string()],
                expand_refs: vec![],
                created_at: now,
                updated_at: now,
                observer: "default-observer".to_string(),
            }])
            .await
            .unwrap();
        let mut context_dataset = context_table.try_open_dataset().await.unwrap().unwrap();
        assert!(
            !ensure_observation_context_id_index(&mut context_dataset)
                .await
                .unwrap()
        );
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
    async fn optimize_extraction_noops_without_index() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        write_watchdog_config(&dir);

        let session_table = TurnTable::new(test_table_options());
        let compacted = compact_dataset(session_table.try_open_dataset().await.unwrap())
            .await
            .unwrap();
        assert!(!compacted);

        let table = ExtractionTable::new(test_table_options());
        table
            .upsert(vec![Extraction {
                id: "row-1".to_string(),
                text: "alpha".to_string(),
                context: None,
                anchors: vec![],
                vector: vec![0.1, 0.2, 0.3, 0.4],
                importance: 0.7,
                turn_refs: vec!["turn:1".to_string()],
                observation_paths: vec![],
                observed_root_anchors: vec![],
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            }])
            .await
            .unwrap();
        let mut dataset = table.try_open_dataset().await.unwrap().unwrap();
        let optimized = optimize_extraction(&mut dataset, 2).await.unwrap();
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

        let table = TurnTable::new(test_table_options());
        let now = chrono::Utc::now();
        let mut turn = Turn {
            turn_id: MemoryId::new(MemoryLayer::Turn, u64::MAX),
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
        second_turn.turn_id = MemoryId::new(MemoryLayer::Turn, u64::MAX);
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
