use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::Float32Array;
use arrow_schema::DataType;
use chrono::{DateTime, Utc};
use lance::dataset::{MergeInsertBuilder, WhenMatched, WhenNotMatched};
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{LanceDataset, TableAccess, TableDescription, TableOptions, delete_by_ids, describe_dataset};
use super::codec::{record_batch_to_semantic_rows, semantic_rows_to_reader};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIndexRow {
    pub id: String,
    pub memory_id: String,
    pub text: String,
    pub vector: Vec<f32>,
    pub importance: f32,
    pub category: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct SemanticIndexTable {
    access: TableAccess,
}

impl SemanticIndexTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("semantic_index").expect("valid semantic_index table path"),
            ),
        }
    }

    #[cfg(test)]
    pub(crate) async fn try_open_dataset(&self) -> Result<Option<LanceDataset>> {
        self.access.try_open().await
    }

    pub(crate) async fn ensure_dataset(&self) -> Result<LanceDataset> {
        if let Some(dataset) = self.access.try_open().await? {
            return Ok(dataset);
        }
        self.access
            .write(semantic_rows_to_reader(Vec::new())?)
            .await
    }

    pub(crate) async fn validate_dimensions(&self, expected_dimensions: usize) -> Result<()> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(());
        };
        let actual_dimensions = semantic_index_vector_dimensions(&dataset)?;
        semantic_index_memory_id_field(&dataset)?;
        if actual_dimensions != expected_dimensions {
            return Err(Error::invalid_input(format!(
                "semantic_index dimension mismatch: muninn.json expects {expected_dimensions}, but the existing semantic_index table stores {actual_dimensions}; update semanticIndex.embedding.dimensions or rebuild the semantic_index table"
            )));
        }
        Ok(())
    }

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        // describe() reports table facts and the semantic-index-specific schema checks
        // that this table already enforces for vector and memory_id compatibility.
        let actual_dimensions = semantic_index_vector_dimensions(&dataset)?;
        semantic_index_memory_id_field(&dataset)?;
        let mut description = describe_dataset(&dataset);
        description.dimensions = Some(HashMap::from([(
            "vector".to_string(),
            actual_dimensions,
        )]));
        Ok(Some(description))
    }

    #[cfg(test)]
    pub(crate) async fn list(&self) -> Result<Vec<SemanticIndexRow>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_semantic_rows(&batch)
    }

    pub(crate) async fn load_by_ids(&self, ids: &[String]) -> Result<Vec<SemanticIndexRow>> {
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
        record_batch_to_semantic_rows(&batch)
    }

    pub(crate) async fn nearest(
        &self,
        query_vector: &[f32],
        limit: usize,
    ) -> Result<Vec<SemanticIndexRow>> {
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
                record_batch_to_semantic_rows(&batch)
            }
            Err(_) => {
                let batch = dataset.scan().try_into_batch().await?;
                if batch.num_rows() == 0 {
                    return Ok(Vec::new());
                }
                let mut rows = record_batch_to_semantic_rows(&batch)?;
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
    pub(crate) async fn insert(&self, rows: Vec<SemanticIndexRow>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(mut dataset) = self.access.try_open().await? {
            dataset.append(semantic_rows_to_reader(rows)?, None).await?;
        } else {
            self.access.write(semantic_rows_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub(crate) async fn upsert(&self, rows: Vec<SemanticIndexRow>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(dataset) = self.access.try_open().await? {
            let dataset = Arc::new(dataset);
            let mut builder = MergeInsertBuilder::try_new(dataset, vec!["id".to_string()])?;
            builder
                .when_matched(WhenMatched::UpdateAll)
                .when_not_matched(WhenNotMatched::InsertAll);
            let job = builder.try_build()?;
            job.execute_reader(semantic_rows_to_reader(rows)?).await?;
        } else {
            self.access.write(semantic_rows_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub(crate) async fn delete(&self, ids: Vec<String>) -> Result<usize> {
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

fn semantic_index_vector_dimensions(dataset: &LanceDataset) -> Result<usize> {
    let vector = dataset.schema().field("vector").ok_or_else(|| {
        Error::invalid_input(
            "semantic_index table schema is invalid: missing vector column; rebuild the semantic_index table",
        )
    })?;

    match vector.data_type() {
        DataType::FixedSizeList(item, dimensions) if item.data_type() == &DataType::Float32 => {
            if dimensions <= 0 {
                return Err(Error::invalid_input(
                    "semantic_index table schema is invalid: vector dimension must be positive; rebuild the semantic_index table",
                ));
            }
            Ok(dimensions as usize)
        }
        actual => Err(Error::invalid_input(format!(
            "semantic_index table schema is incompatible: expected vector column type FixedSizeList<Float32, N>, found {actual:?}; rebuild the semantic_index table"
        ))),
    }
}

fn semantic_index_memory_id_field(dataset: &LanceDataset) -> Result<()> {
    let field = dataset.schema().field("memory_id").ok_or_else(|| {
        Error::invalid_input(
            "semantic_index table schema is incompatible: missing memory_id column; rebuild the semantic_index table",
        )
    })?;

    match field.data_type() {
        DataType::Utf8 => Ok(()),
        actual => Err(Error::invalid_input(format!(
            "semantic_index table schema is incompatible: expected memory_id column type Utf8, found {actual:?}; rebuild the semantic_index table"
        ))),
    }
}
