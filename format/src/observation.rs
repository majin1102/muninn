use std::collections::HashMap;

use arrow_array::Float32Array;
use chrono::{DateTime, Utc};
use lance::{Error, Result};
use lance_index::scalar::FullTextSearchQuery;
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, delete_by_ids,
    describe_dataset, escape_predicate_string,
};
use super::codec::{observations_to_reader, record_batch_to_observations};
use crate::extraction::RecallMode;
use crate::maintenance::{
    OBSERVATION_SEARCH_TEXT_COLUMN, cleanup_dataset, compact_dataset, ensure_observation_fts_index,
    ensure_semantic_vector_index,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub curation_id: String,
    pub snapshot_id: String,
    pub text: String,
    pub vector: Vec<f32>,
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

    pub async fn stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
    }

    pub async fn compact(&self) -> Result<bool> {
        compact_dataset(self.access.try_open().await?).await
    }

    pub async fn cleanup(&self, floor_version: u64) -> Result<bool> {
        cleanup_dataset(self.access.try_open().await?, floor_version).await
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
        Ok(vector_created || fts_created)
    }

    pub async fn list_for_curation(&self, curation_id: &str) -> Result<Vec<Observation>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset
            .scan()
            .filter(&format!(
                "curation_id = '{}'",
                escape_predicate_string(curation_id)
            ))?
            .try_into_batch()
            .await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_observations(&batch)
    }

    pub async fn replace_for_curation(
        &self,
        curation_id: &str,
        rows: Vec<Observation>,
    ) -> Result<()> {
        let existing = self.list_for_curation(curation_id).await?;
        if !existing.is_empty() {
            delete_by_ids(
                self.access.try_open().await?,
                "id",
                existing.into_iter().map(|row| row.id).collect(),
            )
            .await?;
        }
        if rows.is_empty() {
            return Ok(());
        }
        if rows.iter().any(|row| row.curation_id != curation_id) {
            return Err(Error::invalid_input(
                "observation replace rows must match curation_id",
            ));
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
                return record_batch_to_observations(&batch);
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
    async fn observation_table_replaces_rows_by_curation_id() {
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
            .replace_for_curation(
                "entity:caroline",
                vec![Observation {
                    id: "one".to_string(),
                    curation_id: "entity:caroline".to_string(),
                    snapshot_id: "curation:0".to_string(),
                    text: "first".to_string(),
                    vector: vec![0.1, 0.2, 0.3, 0.4],
                    references: vec!["extraction:a".to_string()],
                    created_at: now,
                }],
            )
            .await
            .unwrap();

        table
            .replace_for_curation(
                "entity:caroline",
                vec![Observation {
                    id: "two".to_string(),
                    curation_id: "entity:caroline".to_string(),
                    snapshot_id: "curation:1".to_string(),
                    text: "second".to_string(),
                    vector: vec![0.4, 0.3, 0.2, 0.1],
                    references: vec!["extraction:b".to_string()],
                    created_at: now,
                }],
            )
            .await
            .unwrap();

        let rows = table.list_for_curation("entity:caroline").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "two");
    }
}
