use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::Float32Array;
use arrow_schema::DataType;
use chrono::{DateTime, Utc};
use lance::dataset::{MergeInsertBuilder, WhenMatched, WhenNotMatched};
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::TableStats;
use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, delete_by_ids, describe_dataset,
};
use super::codec::{observations_to_reader, record_batch_to_observations};
use crate::maintenance::{
    cleanup_dataset, compact_dataset, ensure_semantic_vector_index, optimize_observation,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub text: String,
    pub vector: Vec<f32>,
    pub importance: f32,
    pub category: String,
    pub references: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ObservationTable {
    access: TableAccess,
}

impl ObservationTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("observation").expect("valid observation table path"),
            ),
        }
    }

    pub async fn try_open_dataset(&self) -> Result<Option<LanceDataset>> {
        self.access.try_open().await
    }

    pub async fn ensure_dataset(&self) -> Result<LanceDataset> {
        if let Some(dataset) = self.access.try_open().await? {
            return Ok(dataset);
        }
        self.access.write(observations_to_reader(Vec::new())?).await
    }

    pub async fn validate_dimensions(&self, expected_dimensions: usize) -> Result<()> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(());
        };
        let actual_dimensions = observation_vector_dimensions(&dataset)?;
        if actual_dimensions != expected_dimensions {
            return Err(Error::invalid_input(format!(
                "observation dimension mismatch: muninn.json expects {expected_dimensions}, but the existing observation table stores {actual_dimensions}; update observation.embedding.dimensions or rebuild the observation table"
            )));
        }
        Ok(())
    }

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        // describe() reports table facts and the observation-specific schema checks
        // that this table already enforces for vector compatibility.
        let actual_dimensions = observation_vector_dimensions(&dataset)?;
        let mut description = describe_dataset(&dataset);
        description.dimensions = Some(HashMap::from([("vector".to_string(), actual_dimensions)]));
        Ok(Some(description))
    }

    pub async fn stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
    }

    pub async fn ensure_vector_index(&self, target_partition_size: usize) -> Result<bool> {
        let Some(mut dataset) = self.access.try_open().await? else {
            return Ok(false);
        };
        ensure_semantic_vector_index(&mut dataset, target_partition_size).await
    }

    pub async fn compact(&self) -> Result<bool> {
        compact_dataset(self.access.try_open().await?).await
    }

    pub async fn cleanup(&self, floor_version: u64) -> Result<bool> {
        cleanup_dataset(self.access.try_open().await?, floor_version).await
    }

    pub async fn optimize(&self, merge_count: usize) -> Result<bool> {
        let Some(mut dataset) = self.access.try_open().await? else {
            return Ok(false);
        };
        optimize_observation(&mut dataset, merge_count).await
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) async fn list(&self) -> Result<Vec<Observation>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_observations(&batch)
    }

    pub async fn load_by_ids(&self, ids: &[String]) -> Result<Vec<Observation>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let predicate = if ids.len() == 1 {
            format!("id = '{}'", super::access::escape_predicate_string(&ids[0]))
        } else {
            let quoted = ids
                .iter()
                .map(|id| format!("'{}'", super::access::escape_predicate_string(id)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("id IN ({quoted})")
        };
        let batch = dataset.scan().filter(&predicate)?.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_observations(&batch)
    }

    pub async fn nearest(&self, query_vector: &[f32], limit: usize) -> Result<Vec<Observation>> {
        if limit == 0 || query_vector.is_empty() {
            return Ok(Vec::new());
        }

        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let query_vector = Float32Array::from(query_vector.to_vec());

        match dataset.scan().nearest("vector", &query_vector, limit) {
            Ok(scanner) => {
                let batch = scanner.try_into_batch().await?;
                if batch.num_rows() == 0 {
                    return Ok(Vec::new());
                }
                record_batch_to_observations(&batch)
            }
            Err(_) => {
                let batch = dataset.scan().try_into_batch().await?;
                if batch.num_rows() == 0 {
                    return Ok(Vec::new());
                }
                let mut rows = record_batch_to_observations(&batch)?;
                rows.sort_by(|left, right| {
                    semantic_vector_score(query_vector.values(), &right.vector)
                        .partial_cmp(&semantic_vector_score(query_vector.values(), &left.vector))
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(right.importance.total_cmp(&left.importance))
                        .then(right.created_at.cmp(&left.created_at))
                });
                rows.truncate(limit);
                Ok(rows)
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn insert(&self, rows: Vec<Observation>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(mut dataset) = self.access.try_open().await? {
            dataset
                .append(
                    observations_to_reader(rows)?,
                    self.access.options().write_params(),
                )
                .await?;
        } else {
            self.access.write(observations_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub async fn upsert(&self, rows: Vec<Observation>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(dataset) = self.access.try_open().await? {
            let dataset = Arc::new(dataset);
            let mut builder = MergeInsertBuilder::try_new(dataset, vec!["id".to_string()])?;
            builder
                .skip_auto_cleanup(true)
                .when_matched(WhenMatched::UpdateAll)
                .when_not_matched(WhenNotMatched::InsertAll);
            let job = builder.try_build()?;
            job.execute_reader(observations_to_reader(rows)?).await?;
        } else {
            self.access.write(observations_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub async fn delete(&self, ids: Vec<String>) -> Result<usize> {
        delete_by_ids(self.access.try_open().await?, "id", ids).await
    }
}

fn semantic_vector_score(query: &[f32], candidate: &[f32]) -> f32 {
    if query.len() != candidate.len() || query.is_empty() {
        return f32::NEG_INFINITY;
    }

    let mut dot = 0.0_f32;
    let mut query_norm = 0.0_f32;
    let mut candidate_norm = 0.0_f32;
    for (left, right) in query.iter().zip(candidate.iter()) {
        dot += left * right;
        query_norm += left * left;
        candidate_norm += right * right;
    }

    let denominator = query_norm.sqrt() * candidate_norm.sqrt();
    if denominator == 0.0 {
        f32::NEG_INFINITY
    } else {
        dot / denominator
    }
}

fn observation_vector_dimensions(dataset: &LanceDataset) -> Result<usize> {
    let vector = dataset.schema().field("vector").ok_or_else(|| {
        Error::invalid_input(
            "observation table schema is invalid: missing vector column; rebuild the observation table",
        )
    })?;

    match vector.data_type() {
        DataType::FixedSizeList(item, dimensions) if item.data_type() == &DataType::Float32 => {
            if dimensions <= 0 {
                return Err(Error::invalid_input(
                    "observation table schema is invalid: vector dimension must be positive; rebuild the observation table",
                ));
            }
            Ok(dimensions as usize)
        }
        actual => Err(Error::invalid_input(format!(
            "observation table schema is incompatible: expected vector column type FixedSizeList<Float32, N>, found {actual:?}; rebuild the observation table"
        ))),
    }
}
