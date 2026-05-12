use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::Float32Array;
use arrow_schema::DataType;
use chrono::{DateTime, Utc};
use lance::dataset::{MergeInsertBuilder, WhenMatched, WhenNotMatched};
use lance::{Error, Result};
use lance_index::scalar::FullTextSearchQuery;
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::TableStats;
use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, delete_by_ids, describe_dataset,
};
use super::codec::{extractions_to_reader, record_batch_to_extractions};
use crate::maintenance::{
    cleanup_dataset, compact_dataset, ensure_extraction_fts_index, ensure_semantic_vector_index,
    optimize_extraction, EXTRACTION_SEARCH_TEXT_COLUMN,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Extraction {
    pub id: String,
    pub text: String,
    pub context: Option<String>,
    pub anchors: Vec<String>,
    pub vector: Vec<f32>,
    pub importance: f32,
    pub category: String,
    pub references: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecallMode {
    Vector,
    Fts,
    Hybrid,
}

#[derive(Debug, Clone)]
pub struct ExtractionTable {
    access: TableAccess,
}

impl ExtractionTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("extraction").expect("valid extraction table path"),
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
        self.access.write(extractions_to_reader(Vec::new())?).await
    }

    pub async fn validate_dimensions(&self, expected_dimensions: usize) -> Result<()> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(());
        };
        let actual_dimensions = extraction_vector_dimensions(&dataset)?;
        if actual_dimensions != expected_dimensions {
            return Err(Error::invalid_input(format!(
                "extraction dimension mismatch: muninn.json expects {expected_dimensions}, but the existing extraction table stores {actual_dimensions}; update extraction.embedding.dimensions or rebuild the extraction table"
            )));
        }
        Ok(())
    }

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        // describe() reports table facts and the extraction-specific schema checks
        // that this table already enforces for vector compatibility.
        let actual_dimensions = extraction_vector_dimensions(&dataset)?;
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
        let vector_created = ensure_semantic_vector_index(&mut dataset, target_partition_size).await?;
        let fts_created = ensure_extraction_fts_index(&mut dataset).await?;
        Ok(vector_created || fts_created)
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
        optimize_extraction(&mut dataset, merge_count).await
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) async fn list(&self) -> Result<Vec<Extraction>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_extractions(&batch)
    }

    pub async fn load_by_ids(&self, ids: &[String]) -> Result<Vec<Extraction>> {
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
        record_batch_to_extractions(&batch)
    }

    pub async fn nearest(&self, query_vector: &[f32], limit: usize) -> Result<Vec<Extraction>> {
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
                return record_batch_to_extractions(&batch);
            }
        }

        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let mut rows = record_batch_to_extractions(&batch)?;
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

    pub async fn search(
        &self,
        query: &str,
        query_vector: &[f32],
        limit: usize,
        mode: RecallMode,
    ) -> Result<Vec<Extraction>> {
        match mode {
            RecallMode::Vector => self.nearest(query_vector, limit).await,
            RecallMode::Fts => self.full_text(query, limit).await,
            RecallMode::Hybrid => self.hybrid(query, query_vector, limit).await,
        }
    }

    async fn full_text(&self, query: &str, limit: usize) -> Result<Vec<Extraction>> {
        if limit == 0 || query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let normalized_query = query.trim();
        let query = FullTextSearchQuery::new(normalized_query.to_string())
            .with_column(EXTRACTION_SEARCH_TEXT_COLUMN.to_string())?
            .limit(Some(limit as i64));
        if let Ok(scanner) = dataset.scan().full_text_search(query) {
            if let Ok(batch) = scanner.try_into_batch().await {
                if batch.num_rows() == 0 {
                    return Ok(Vec::new());
                }
                return record_batch_to_extractions(&batch);
            }
        }
        fallback_full_text(&dataset, normalized_query, limit).await
    }

    async fn hybrid(
        &self,
        query: &str,
        query_vector: &[f32],
        limit: usize,
    ) -> Result<Vec<Extraction>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let candidate_limit = (limit * 4).max(20);
        let vector_rows = self.nearest(query_vector, candidate_limit).await?;
        let fts_rows = self.full_text(query, candidate_limit).await?;
        Ok(merge_ranked(vector_rows, fts_rows, limit))
    }

    #[allow(dead_code)]
    pub(crate) async fn insert(&self, rows: Vec<Extraction>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(mut dataset) = self.access.try_open().await? {
            dataset
                .append(
                    extractions_to_reader(rows)?,
                    self.access.options().write_params(),
                )
                .await?;
        } else {
            self.access.write(extractions_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub async fn upsert(&self, rows: Vec<Extraction>) -> Result<()> {
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
            job.execute_reader(extractions_to_reader(rows)?).await?;
        } else {
            self.access.write(extractions_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub async fn delete(&self, ids: Vec<String>) -> Result<usize> {
        delete_by_ids(self.access.try_open().await?, "id", ids).await
    }
}

fn merge_ranked(
    vector_rows: Vec<Extraction>,
    fts_rows: Vec<Extraction>,
    limit: usize,
) -> Vec<Extraction> {
    let mut scores: HashMap<String, f32> = HashMap::new();
    let mut rows: HashMap<String, Extraction> = HashMap::new();

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
            .then(right.importance.total_cmp(&left.importance))
            .then(right.created_at.cmp(&left.created_at))
    });
    ranked.truncate(limit);
    ranked
}

fn add_rank(
    scores: &mut HashMap<String, f32>,
    rows: &mut HashMap<String, Extraction>,
    rank: usize,
    row: Extraction,
) {
    let score = 1.0_f32 / (60.0 + rank as f32 + 1.0);
    *scores.entry(row.id.clone()).or_default() += score;
    rows.entry(row.id.clone()).or_insert(row);
}

async fn fallback_full_text(
    dataset: &LanceDataset,
    query: &str,
    limit: usize,
) -> Result<Vec<Extraction>> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let batch = dataset.scan().try_into_batch().await?;
    if batch.num_rows() == 0 {
        return Ok(Vec::new());
    }
    let mut scored = record_batch_to_extractions(&batch)?
        .into_iter()
        .filter_map(|row| {
            let score = lexical_score(&row, &tokens);
            (score > 0).then_some((score, row))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then(right.importance.total_cmp(&left.importance))
            .then(right.created_at.cmp(&left.created_at))
    });
    scored.truncate(limit);
    Ok(scored.into_iter().map(|(_, row)| row).collect())
}

fn lexical_score(row: &Extraction, tokens: &[String]) -> usize {
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

fn normalize_token(token: &str) -> String {
    if token.len() > 3 && token.ends_with('s') {
        token[..token.len() - 1].to_string()
    } else {
        token.to_string()
    }
}

fn is_stopword(token: &str) -> bool {
    matches!(
        token,
        "the"
            | "and"
            | "for"
            | "with"
            | "that"
            | "this"
            | "what"
            | "when"
            | "where"
            | "who"
            | "why"
            | "how"
            | "are"
            | "was"
            | "were"
            | "did"
            | "does"
            | "have"
            | "has"
            | "had"
            | "from"
            | "about"
            | "into"
            | "their"
            | "there"
            | "they"
            | "them"
            | "she"
            | "her"
            | "his"
            | "him"
    )
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

fn extraction_vector_dimensions(dataset: &LanceDataset) -> Result<usize> {
    let vector = dataset.schema().field("vector").ok_or_else(|| {
        Error::invalid_input(
            "extraction table schema is invalid: missing vector column; rebuild the extraction table",
        )
    })?;

    match vector.data_type() {
        DataType::FixedSizeList(item, dimensions) if item.data_type() == &DataType::Float32 => {
            if dimensions <= 0 {
                return Err(Error::invalid_input(
                    "extraction table schema is invalid: vector dimension must be positive; rebuild the extraction table",
                ));
            }
            Ok(dimensions as usize)
        }
        actual => Err(Error::invalid_input(format!(
            "extraction table schema is incompatible: expected vector column type FixedSizeList<Float32, N>, found {actual:?}; rebuild the extraction table"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::{Extraction, ExtractionTable, RecallMode};
    use crate::config::{CONFIG_FILE_NAME, llm_test_env_guard};
    use crate::TableOptions;

    fn write_config(dir: &tempfile::TempDir) {
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
        unsafe {
            std::env::set_var("MUNINN_HOME", home);
        }
    }

    fn row(id: &str, text: &str, context: Option<&str>, vector: Vec<f32>) -> Extraction {
        Extraction {
            id: id.to_string(),
            text: text.to_string(),
            context: context.map(str::to_string),
            anchors: vec![],
            vector,
            importance: 0.7,
            category: "Fact".to_string(),
            references: vec!["turn:1".to_string()],
            created_at: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn search_supports_fts_and_hybrid_modes() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);

        let table = ExtractionTable::new(TableOptions::local(crate::config::data_root().unwrap()).unwrap());
        table
            .upsert(vec![
                row(
                    "career",
                    "Caroline researched adoption agencies for her summer plans.",
                    Some("Caroline discussed summer plans."),
                    vec![1.0, 0.0, 0.0, 0.0],
                ),
                row(
                    "painting",
                    "Melanie painted a lake sunrise in 2022.",
                    None,
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
            ])
            .await
            .unwrap();
        table.ensure_vector_index(2).await.unwrap();

        let fts = table
            .search("adoption agencies", &[], 1, RecallMode::Fts)
            .await
            .unwrap();
        assert_eq!(fts[0].id, "career");

        let hybrid = table
            .search("adoption agencies", &[0.0, 1.0, 0.0, 0.0], 2, RecallMode::Hybrid)
            .await
            .unwrap();
        assert!(hybrid.iter().any(|item| item.id == "career"));
    }

    #[tokio::test]
    async fn fts_search_matches_extraction_text_not_context() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);

        let table = ExtractionTable::new(TableOptions::local(crate::config::data_root().unwrap()).unwrap());
        table
            .upsert(vec![
                row(
                    "text-hit",
                    "Caroline researched adoption agencies.",
                    Some("No matching lexical clue here."),
                    vec![1.0, 0.0, 0.0, 0.0],
                ),
                row(
                    "context-only",
                    "Caroline discussed summer activities.",
                    Some("Caroline researched adoption agencies."),
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
            ])
            .await
            .unwrap();
        table.ensure_vector_index(2).await.unwrap();

        let fts = table
            .search("adoption agencies", &[], 10, RecallMode::Fts)
            .await
            .unwrap();

        assert!(fts.iter().any(|item| item.id == "text-hit"));
        assert!(!fts.iter().any(|item| item.id == "context-only"));
    }
}
