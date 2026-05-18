use std::collections::HashMap;

use arrow_array::{Float32Array, RecordBatch, StringArray};
use chrono::{DateTime, Utc};
use lance::dataset::MergeInsertBuilder;
use lance::dataset::{WhenMatched, WhenNotMatched};
use lance::Result;
use lance_index::scalar::FullTextSearchQuery;
use object_store::path::Path;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, delete_by_ids,
    describe_dataset, escape_predicate_string,
};
use super::codec::{observations_to_reader, record_batch_to_observations};
use crate::extraction::RecallMode;
use crate::maintenance::{
    OBSERVATION_SEARCH_TEXT_COLUMN, cleanup_dataset, compact_dataset, ensure_observation_fts_index,
    ensure_observation_id_index, ensure_semantic_vector_index, optimize_observation,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub observing_path: String,
    pub text: String,
    pub vector: Vec<f32>,
    pub extraction_refs: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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

    pub async fn stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
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

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        Ok(Some(describe_dataset(&dataset)))
    }

    pub async fn ensure_vector_index(&self, target_partition_size: usize) -> Result<bool> {
        let Some(mut dataset) = self.access.try_open().await? else {
            return Ok(false);
        };
        let vector_created = ensure_semantic_vector_index(&mut dataset, target_partition_size).await?;
        let fts_created = ensure_observation_fts_index(&mut dataset).await?;
        let id_created = ensure_observation_id_index(&mut dataset).await?;
        Ok(vector_created || fts_created || id_created)
    }

    pub async fn get(&self, ids: &[String]) -> Result<Vec<Observation>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let predicate = if ids.len() == 1 {
            format!("id = '{}'", escape_predicate_string(&ids[0]))
        } else {
            let quoted = ids
                .iter()
                .map(|id| format!("'{}'", escape_predicate_string(id)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("id IN ({quoted})")
        };
        let batch = dataset.scan().filter(&predicate)?.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let rows = record_batch_to_observations(&batch)?;
        let mut by_id = rows
            .into_iter()
            .map(|row| (row.id.clone(), row))
            .collect::<HashMap<_, _>>();
        Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
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

    pub async fn search(
        &self,
        query: &str,
        query_vector: &[f32],
        limit: usize,
        mode: RecallMode,
    ) -> Result<Vec<Observation>> {
        match mode {
            RecallMode::Vector => self.nearest(query_vector, limit).await,
            RecallMode::Fts => self.full_text(query, limit).await,
            RecallMode::Hybrid => self.hybrid(query, query_vector, limit).await,
        }
    }

    async fn nearest(&self, query_vector: &[f32], limit: usize) -> Result<Vec<Observation>> {
        if limit == 0 || query_vector.is_empty() {
            return Ok(Vec::new());
        }

        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let query_vector = Float32Array::from(query_vector.to_vec());

        if let Ok(scanner) = dataset.scan().nearest("vector", &query_vector, limit) {
            if let Ok(batch) = scanner.try_into_batch().await {
                if batch.num_rows() == 0 {
                    return Ok(Vec::new());
                }
                return record_batch_to_observations(&batch);
            }
        }

        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let mut rows = record_batch_to_observations(&batch)?;
        rows.sort_by(|left, right| {
            vector_score(query_vector.values(), &right.vector)
                .partial_cmp(&vector_score(query_vector.values(), &left.vector))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(right.created_at.cmp(&left.created_at))
        });
        rows.truncate(limit);
        Ok(rows)
    }

    async fn full_text(&self, query: &str, limit: usize) -> Result<Vec<Observation>> {
        if limit == 0 || query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let normalized_query = query.trim();
        let query = FullTextSearchQuery::new(normalized_query.to_string())
            .with_column(OBSERVATION_SEARCH_TEXT_COLUMN.to_string())?
            .limit(Some(limit as i64));
        if let Ok(scanner) = dataset.scan().full_text_search(query) {
            if let Ok(batch) = scanner.try_into_batch().await {
                if batch.num_rows() == 0 {
                    return Ok(Vec::new());
                }
                let ids = batch_ids(&batch)?;
                return self.get(&ids).await;
            }
        }
        fallback_full_text(&dataset, normalized_query, limit).await
    }

    async fn hybrid(
        &self,
        query: &str,
        query_vector: &[f32],
        limit: usize,
    ) -> Result<Vec<Observation>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let candidate_limit = (limit * 4).max(20);
        let vector_rows = self.nearest(query_vector, candidate_limit).await?;
        let fts_rows = self.full_text(query, candidate_limit).await?;
        Ok(merge_ranked(vector_rows, fts_rows, limit))
    }

}

fn batch_ids(batch: &RecordBatch) -> Result<Vec<String>> {
    let ids = batch
        .column_by_name("id")
        .ok_or_else(|| lance::Error::invalid_input("observation search result missing id column"))?
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or_else(|| lance::Error::invalid_input("observation search id column must be Utf8"))?;
    Ok((0..batch.num_rows()).map(|index| ids.value(index).to_string()).collect())
}

fn merge_ranked(
    vector_rows: Vec<Observation>,
    fts_rows: Vec<Observation>,
    limit: usize,
) -> Vec<Observation> {
    let mut scores: HashMap<String, f32> = HashMap::new();
    let mut rows: HashMap<String, Observation> = HashMap::new();

    for (rank, row) in vector_rows.into_iter().enumerate() {
        add_rank(&mut scores, &mut rows, rank, row);
    }
    for (rank, row) in fts_rows.into_iter().enumerate() {
        add_rank(&mut scores, &mut rows, rank, row);
    }

    let mut ranked = rows.into_values().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        scores
            .get(&right.id)
            .copied()
            .unwrap_or_default()
            .total_cmp(&scores.get(&left.id).copied().unwrap_or_default())
            .then(right.created_at.cmp(&left.created_at))
    });
    ranked.truncate(limit);
    ranked
}

fn add_rank(
    scores: &mut HashMap<String, f32>,
    rows: &mut HashMap<String, Observation>,
    rank: usize,
    row: Observation,
) {
    let score = 1.0_f32 / (60.0 + rank as f32 + 1.0);
    *scores.entry(row.id.clone()).or_default() += score;
    rows.entry(row.id.clone()).or_insert(row);
}

async fn fallback_full_text(
    dataset: &LanceDataset,
    query: &str,
    limit: usize,
) -> Result<Vec<Observation>> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let batch = dataset.scan().try_into_batch().await?;
    if batch.num_rows() == 0 {
        return Ok(Vec::new());
    }
    let mut scored = record_batch_to_observations(&batch)?
        .into_iter()
        .filter_map(|row| {
            let score = lexical_score(&row, &tokens);
            (score > 0).then_some((score, row))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then(right.created_at.cmp(&left.created_at))
    });
    scored.truncate(limit);
    Ok(scored.into_iter().map(|(_, row)| row).collect())
}

fn lexical_score(row: &Observation, tokens: &[String]) -> usize {
    let haystack = normalize_search_text(&row.text);
    tokens.iter().filter(|token| haystack.contains(token.as_str())).count()
}

fn query_tokens(query: &str) -> Vec<String> {
    normalize_search_text(query)
        .split_whitespace()
        .filter(|token| token.len() >= 3 && !is_stopword(token))
        .map(|token| token.to_string())
        .collect()
}

fn normalize_search_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(normalize_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_token(token: &str) -> &str {
    match token {
        "children" => "kids",
        "child" => "kid",
        "people" => "person",
        "individuals" => "person",
        other => other,
    }
}

fn is_stopword(token: &str) -> bool {
    matches!(
        token,
        "the" | "and" | "for" | "with" | "that" | "this" | "what" | "when" | "where" | "who"
            | "why" | "how" | "did" | "does" | "was" | "were" | "are" | "about" | "from"
            | "into" | "after" | "before" | "their" | "there" | "then" | "than"
    )
}

fn vector_score(query: &[f32], row: &[f32]) -> f32 {
    if query.is_empty() || row.is_empty() || query.len() != row.len() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut query_norm = 0.0_f32;
    let mut row_norm = 0.0_f32;
    for (left, right) in query.iter().zip(row.iter()) {
        dot += left * right;
        query_norm += left * left;
        row_norm += right * right;
    }
    if query_norm == 0.0 || row_norm == 0.0 {
        return 0.0;
    }
    dot / (query_norm.sqrt() * row_norm.sqrt())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{Observation, ObservationTable};
    use crate::{TableOptions, config::llm_test_env_guard};

    #[tokio::test]
    async fn observation_table_upserts_and_deletes_rows() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn");
        std::fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        std::fs::write(
            home.join("muninn.json"),
            serde_json::json!({
                "observer": { "name": "default-observer", "llm": "mock" },
                "llm": { "mock": { "provider": "mock" } },
                "extraction": {
                    "embedding": {
                        "provider": "mock",
                        "dimensions": 4
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let table = ObservationTable::new(TableOptions::local(dir.path()).unwrap());
        let now = Utc::now();

        table
            .upsert(vec![Observation {
                id: "one".to_string(),
                observing_path: "Caroline".to_string(),
                text: "first".to_string(),
                vector: vec![0.1, 0.2, 0.3, 0.4],
                extraction_refs: vec!["extraction:a".to_string()],
                created_at: now,
                updated_at: now,
            }])
            .await
            .unwrap();

        table
            .upsert(vec![Observation {
                id: "one".to_string(),
                observing_path: "Caroline".to_string(),
                text: "second".to_string(),
                vector: vec![0.4, 0.3, 0.2, 0.1],
                extraction_refs: vec!["extraction:b".to_string()],
                created_at: now,
                updated_at: now,
            }])
            .await
            .unwrap();
        table
            .upsert(vec![Observation {
                id: "two".to_string(),
                observing_path: "Melanie".to_string(),
                text: "third".to_string(),
                vector: vec![0.0, 0.0, 0.0, 1.0],
                extraction_refs: vec!["extraction:c".to_string()],
                created_at: now,
                updated_at: now,
            }])
            .await
            .unwrap();

        let rows = table.get(&["one".to_string()]).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "second");
        assert_eq!(rows[0].extraction_refs, vec!["extraction:b"]);

        let rows = table
            .get(&["two".to_string(), "missing".to_string(), "one".to_string()])
            .await
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["two", "one"],
        );

        assert_eq!(table.delete(vec!["one".to_string()]).await.unwrap(), 1);
        assert!(table.get(&["one".to_string()]).await.unwrap().is_empty());
    }
}
