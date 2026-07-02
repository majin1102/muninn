use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow_array::Float32Array;
use arrow_schema::DataType;
use chrono::{DateTime, Utc};
use lance::dataset::{MergeInsertBuilder, WhenMatched, WhenNotMatched};
use lance::{Error, Result};
use lance_index::scalar::FullTextSearchQuery;
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, describe_dataset,
    escape_predicate_string,
};
use super::codec::{record_batch_to_session_search, session_search_to_reader};
use crate::maintenance::{
    SESSION_SEARCH_TEXT_COLUMN, cleanup_dataset, compact_dataset, ensure_semantic_vector_index,
    ensure_session_search_fts_index, ensure_session_search_identity_index, optimize_session_search,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearch {
    pub latest_snapshot_id: String,
    pub session_id: String,
    pub project: String,
    pub cwd: String,
    pub agent: String,
    pub title: String,
    pub summary: String,
    pub search_text: String,
    pub vector: Vec<f32>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    pub project: String,
    pub agent: String,
    pub session_id: String,
}

#[derive(Debug, Clone)]
pub struct SessionSearchTable {
    access: TableAccess,
}

impl SessionSearchTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("session_search").expect("valid session_search table path"),
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
        self.access
            .write(session_search_to_reader(Vec::new())?)
            .await
    }

    pub async fn validate_dimensions(&self, expected_dimensions: usize) -> Result<()> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(());
        };
        let actual_dimensions = session_search_vector_dimensions(&dataset)?;
        if actual_dimensions != expected_dimensions {
            return Err(Error::invalid_input(format!(
                "session_search dimension mismatch: muninn.json expects {expected_dimensions}, but the existing session_search table stores {actual_dimensions}; update providers.embedding.<name>.dimensions or rebuild the session_search table"
            )));
        }
        Ok(())
    }

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        let actual_dimensions = session_search_vector_dimensions(&dataset)?;
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
        let vector_created =
            ensure_semantic_vector_index(&mut dataset, target_partition_size).await?;
        let fts_created = ensure_session_search_fts_index(&mut dataset).await?;
        let identity_created = ensure_session_search_identity_index(&mut dataset).await?;
        Ok(vector_created || fts_created || identity_created)
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
        optimize_session_search(&mut dataset, merge_count).await
    }

    pub async fn list(&self, limit: Option<usize>) -> Result<Vec<SessionSearch>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let mut scan = dataset.scan();
        if let Some(limit) = limit {
            scan.limit(Some(limit as i64), None)?;
        }
        let batch = scan.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_session_search(&batch)
    }

    pub async fn get(&self, identities: &[SessionIdentity]) -> Result<Vec<SessionSearch>> {
        if identities.is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let predicate = identity_predicate(identities);
        let batch = dataset.scan().filter(&predicate)?.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let rows = record_batch_to_session_search(&batch)?;
        let mut by_identity = rows
            .into_iter()
            .map(|row| (identity_key(&row), row))
            .collect::<HashMap<_, _>>();
        Ok(identities
            .iter()
            .filter_map(|identity| by_identity.remove(&identity_key_from_parts(identity)))
            .collect())
    }

    pub async fn search(
        &self,
        query: &str,
        query_vector: &[f32],
        limit: usize,
    ) -> Result<Vec<SessionSearch>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        self.validate_query_vector(query_vector).await?;
        let candidate_limit = (limit * 4).max(20);
        let vector_rows = self.nearest(query_vector, candidate_limit).await?;
        let fts_rows = self.full_text(query, candidate_limit).await?;
        Ok(merge_ranked(vector_rows, fts_rows, limit))
    }

    pub async fn upsert(&self, rows: Vec<SessionSearch>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        validate_unique_identities(&rows)?;
        if let Some(dataset) = self.access.try_open().await? {
            let dataset = Arc::new(dataset);
            let mut builder = MergeInsertBuilder::try_new(
                dataset,
                vec![
                    "project".to_string(),
                    "agent".to_string(),
                    "session_id".to_string(),
                ],
            )?;
            builder
                .skip_auto_cleanup(true)
                .when_matched(WhenMatched::UpdateAll)
                .when_not_matched(WhenNotMatched::InsertAll);
            let job = builder.try_build()?;
            job.execute_reader(session_search_to_reader(rows)?).await?;
        } else {
            self.access.write(session_search_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub async fn replace_all(&self, rows: Vec<SessionSearch>) -> Result<()> {
        validate_unique_identities(&rows)?;
        let is_empty = rows.is_empty();
        let reader = session_search_to_reader(rows)?;
        let Some(mut dataset) = self.access.try_open().await? else {
            self.access.write(reader).await?;
            return Ok(());
        };
        dataset.delete("project IS NOT NULL").await?;
        if !is_empty {
            dataset
                .append(reader, self.access.options().write_params())
                .await?;
        }
        Ok(())
    }

    pub async fn delete(&self, identities: Vec<SessionIdentity>) -> Result<usize> {
        let Some(mut dataset) = self.access.try_open().await? else {
            return Ok(0);
        };
        if identities.is_empty() {
            return Ok(0);
        }
        let predicate = identity_predicate(&identities);
        let result = dataset.delete(&predicate).await?;
        Ok(result.num_deleted_rows as usize)
    }

    async fn validate_query_vector(&self, query_vector: &[f32]) -> Result<()> {
        if query_vector.is_empty() {
            return Ok(());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(());
        };
        let actual_dimensions = session_search_vector_dimensions(&dataset)?;
        if query_vector.len() != actual_dimensions {
            return Err(Error::invalid_input(format!(
                "session_search query vector dimension mismatch: query vector has {}, but the session_search table stores {actual_dimensions}",
                query_vector.len(),
            )));
        }
        Ok(())
    }

    async fn nearest(&self, query_vector: &[f32], limit: usize) -> Result<Vec<SessionSearch>> {
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
                return record_batch_to_session_search(&batch);
            }
        }

        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let mut rows = record_batch_to_session_search(&batch)?;
        rows.sort_by(|left, right| {
            vector_score(query_vector.values(), &right.vector)
                .partial_cmp(&vector_score(query_vector.values(), &left.vector))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(right.updated_at.cmp(&left.updated_at))
                .then(left.project.cmp(&right.project))
                .then(left.agent.cmp(&right.agent))
                .then(left.session_id.cmp(&right.session_id))
        });
        rows.truncate(limit);
        Ok(rows)
    }

    async fn full_text(&self, query: &str, limit: usize) -> Result<Vec<SessionSearch>> {
        if limit == 0 || query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let normalized_query = query.trim();
        let query = FullTextSearchQuery::new(normalized_query.to_string())
            .with_column(SESSION_SEARCH_TEXT_COLUMN.to_string())?
            .limit(Some(limit as i64));
        if let Ok(scanner) = dataset.scan().full_text_search(query) {
            if let Ok(batch) = scanner.try_into_batch().await {
                if batch.num_rows() > 0 {
                    return record_batch_to_session_search(&batch);
                }
            }
        }
        fallback_full_text(&dataset, normalized_query, limit).await
    }
}

type IdentityKey = (String, String, String);

fn identity_key(row: &SessionSearch) -> IdentityKey {
    (
        row.project.clone(),
        row.agent.clone(),
        row.session_id.clone(),
    )
}

fn identity_key_from_parts(identity: &SessionIdentity) -> IdentityKey {
    (
        identity.project.clone(),
        identity.agent.clone(),
        identity.session_id.clone(),
    )
}

fn identity_predicate(identities: &[SessionIdentity]) -> String {
    identities
        .iter()
        .map(|identity| {
            format!(
                "(project = '{}' AND agent = '{}' AND session_id = '{}')",
                escape_predicate_string(&identity.project),
                escape_predicate_string(&identity.agent),
                escape_predicate_string(&identity.session_id),
            )
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn validate_unique_identities(rows: &[SessionSearch]) -> Result<()> {
    let mut seen = HashSet::new();
    for row in rows {
        let key = identity_key(row);
        if !seen.insert(key) {
            return Err(Error::invalid_input(format!(
                "duplicate session_search identity: project='{}', agent='{}', session_id='{}'",
                row.project, row.agent, row.session_id
            )));
        }
    }
    Ok(())
}

fn merge_ranked(
    vector_rows: Vec<SessionSearch>,
    fts_rows: Vec<SessionSearch>,
    limit: usize,
) -> Vec<SessionSearch> {
    let mut scores: HashMap<IdentityKey, f32> = HashMap::new();
    let mut rows: HashMap<IdentityKey, SessionSearch> = HashMap::new();

    for (rank, row) in vector_rows.into_iter().enumerate() {
        add_rank(&mut scores, &mut rows, rank, row);
    }
    for (rank, row) in fts_rows.into_iter().enumerate() {
        add_rank(&mut scores, &mut rows, rank, row);
    }

    let mut ranked = rows.into_values().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        scores
            .get(&identity_key(right))
            .copied()
            .unwrap_or_default()
            .total_cmp(&scores.get(&identity_key(left)).copied().unwrap_or_default())
            .then(right.updated_at.cmp(&left.updated_at))
            .then(left.project.cmp(&right.project))
            .then(left.agent.cmp(&right.agent))
            .then(left.session_id.cmp(&right.session_id))
    });
    ranked.truncate(limit);
    ranked
}

fn add_rank(
    scores: &mut HashMap<IdentityKey, f32>,
    rows: &mut HashMap<IdentityKey, SessionSearch>,
    rank: usize,
    row: SessionSearch,
) {
    let key = identity_key(&row);
    let score = 1.0_f32 / (60.0 + rank as f32 + 1.0);
    *scores.entry(key.clone()).or_default() += score;
    rows.entry(key).or_insert(row);
}

async fn fallback_full_text(
    dataset: &LanceDataset,
    query: &str,
    limit: usize,
) -> Result<Vec<SessionSearch>> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let batch = dataset.scan().try_into_batch().await?;
    if batch.num_rows() == 0 {
        return Ok(Vec::new());
    }
    let mut scored = record_batch_to_session_search(&batch)?
        .into_iter()
        .filter_map(|row| {
            let score = lexical_score(&row, &tokens);
            (score > 0).then_some((score, row))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then(right.updated_at.cmp(&left.updated_at))
            .then(left.project.cmp(&right.project))
            .then(left.agent.cmp(&right.agent))
            .then(left.session_id.cmp(&right.session_id))
    });
    scored.truncate(limit);
    Ok(scored.into_iter().map(|(_, row)| row).collect())
}

fn lexical_score(row: &SessionSearch, tokens: &[String]) -> usize {
    let haystack = normalize_search_text(&format!(
        "{}\n{}\n{}",
        row.title, row.summary, row.search_text
    ));
    tokens
        .iter()
        .filter(|token| haystack.contains(token.as_str()))
        .count()
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

fn vector_score(query: &[f32], row: &[f32]) -> f32 {
    if query.is_empty() || row.is_empty() || query.len() != row.len() {
        return f32::NEG_INFINITY;
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
        f32::NEG_INFINITY
    } else {
        dot / (query_norm.sqrt() * row_norm.sqrt())
    }
}

fn session_search_vector_dimensions(dataset: &LanceDataset) -> Result<usize> {
    let vector = dataset.schema().field("vector").ok_or_else(|| {
        Error::invalid_input(
            "session_search table schema is invalid: missing vector column; rebuild the session_search table",
        )
    })?;

    match vector.data_type() {
        DataType::FixedSizeList(item, dimensions) if item.data_type() == &DataType::Float32 => {
            if dimensions <= 0 {
                return Err(Error::invalid_input(
                    "session_search table schema is invalid: vector dimension must be positive; rebuild the session_search table",
                ));
            }
            Ok(dimensions as usize)
        }
        actual => Err(Error::invalid_input(format!(
            "session_search table schema is incompatible: expected vector column type FixedSizeList<Float32, N>, found {actual:?}; rebuild the session_search table"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::{TimeZone, Utc};
    use serde_json::json;

    use super::{SessionIdentity, SessionSearch, SessionSearchTable};
    use crate::config::{CONFIG_FILE_NAME, llm_test_env_guard};
    use crate::{TableOptions, data_root};

    fn write_config(dir: &tempfile::TempDir) {
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(CONFIG_FILE_NAME),
            serde_json::to_string_pretty(&json!({
                "providers": {
                    "llm": {
                        "default": { "type": "mock" }
                    },
                    "embedding": {
                        "default": {
                            "type": "mock",
                            "dimensions": 4
                        }
                    }
                },
                "extractor": {
                    "name": "default-extractor",
                    "llmProvider": "default",
                    "embeddingProvider": "default"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", home);
        }
    }

    fn table() -> SessionSearchTable {
        SessionSearchTable::new(TableOptions::local(data_root().unwrap()).unwrap())
    }

    fn identity(project: &str, agent: &str, session_id: &str) -> SessionIdentity {
        SessionIdentity {
            project: project.to_string(),
            agent: agent.to_string(),
            session_id: session_id.to_string(),
        }
    }

    fn row(
        latest_snapshot_id: &str,
        project: &str,
        agent: &str,
        session_id: &str,
        title: &str,
        search_text: &str,
        vector: Vec<f32>,
    ) -> SessionSearch {
        SessionSearch {
            latest_snapshot_id: latest_snapshot_id.to_string(),
            session_id: session_id.to_string(),
            project: project.to_string(),
            cwd: format!("/repo/{project}"),
            agent: agent.to_string(),
            title: title.to_string(),
            summary: format!("{title} summary"),
            search_text: search_text.to_string(),
            vector,
            updated_at: Utc.timestamp_micros(1_000_000).single().unwrap(),
        }
    }

    #[tokio::test]
    async fn search_supports_hybrid_session_title_and_search_text() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();

        table
            .upsert(vec![
                row(
                    "snapshot-a",
                    "project-a",
                    "codex",
                    "session-a",
                    "Adoption agency shortlist",
                    "Caroline researched summer agencies and application timing.",
                    vec![1.0, 0.0, 0.0, 0.0],
                ),
                row(
                    "snapshot-b",
                    "project-a",
                    "codex",
                    "session-b",
                    "Lake painting notes",
                    "Melanie painted a lake sunrise.",
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
            ])
            .await
            .unwrap();
        table.ensure_vector_index(2).await.unwrap();

        let rows = table
            .search("adoption agency", &[0.0, 1.0, 0.0, 0.0], 2)
            .await
            .unwrap();

        assert_eq!(rows[0].session_id, "session-a");
        assert_eq!(rows[0].title, "Adoption agency shortlist");
    }

    #[tokio::test]
    async fn upsert_replaces_one_session_identity_without_id() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();

        table
            .upsert(vec![row(
                "snapshot-a",
                "project-a",
                "codex",
                "session-a",
                "Old title",
                "old search text",
                vec![1.0, 0.0, 0.0, 0.0],
            )])
            .await
            .unwrap();
        table
            .upsert(vec![
                row(
                    "snapshot-b",
                    "project-a",
                    "codex",
                    "session-a",
                    "New title",
                    "new search text",
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
                row(
                    "snapshot-c",
                    "project-a",
                    "claude",
                    "session-a",
                    "Other agent title",
                    "other search text",
                    vec![0.0, 0.0, 1.0, 0.0],
                ),
            ])
            .await
            .unwrap();

        let rows = table
            .get(&[
                identity("project-a", "codex", "session-a"),
                identity("project-a", "claude", "session-a"),
            ])
            .await
            .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].latest_snapshot_id, "snapshot-b");
        assert_eq!(rows[0].title, "New title");
        assert_eq!(rows[1].latest_snapshot_id, "snapshot-c");
        assert_eq!(table.list(None).await.unwrap().len(), 2);
        let description = table.describe().await.unwrap().unwrap();
        assert!(!description.field_metadata.contains_key("id"));
    }

    #[tokio::test]
    async fn upsert_rejects_duplicate_session_identity_before_writing() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();

        let empty_table_error = table
            .upsert(vec![
                row(
                    "snapshot-a",
                    "project-a",
                    "codex",
                    "session-a",
                    "Duplicate one",
                    "duplicate one",
                    vec![1.0, 0.0, 0.0, 0.0],
                ),
                row(
                    "snapshot-b",
                    "project-a",
                    "codex",
                    "session-a",
                    "Duplicate two",
                    "duplicate two",
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
            ])
            .await
            .expect_err("duplicate identities should be rejected before creating a table");

        assert!(
            empty_table_error
                .to_string()
                .contains("duplicate session_search identity"),
            "{empty_table_error}"
        );
        assert!(table.try_open_dataset().await.unwrap().is_none());

        table
            .upsert(vec![row(
                "snapshot-c",
                "project-c",
                "claude",
                "session-c",
                "Existing",
                "existing",
                vec![0.0, 0.0, 1.0, 0.0],
            )])
            .await
            .unwrap();

        let existing_table_error = table
            .upsert(vec![
                row(
                    "snapshot-d",
                    "project-d",
                    "codex",
                    "session-d",
                    "Duplicate three",
                    "duplicate three",
                    vec![0.0, 0.0, 0.0, 1.0],
                ),
                row(
                    "snapshot-e",
                    "project-d",
                    "codex",
                    "session-d",
                    "Duplicate four",
                    "duplicate four",
                    vec![1.0, 1.0, 0.0, 0.0],
                ),
            ])
            .await
            .expect_err("duplicate identities should be rejected before merge insert");

        assert!(
            existing_table_error
                .to_string()
                .contains("duplicate session_search identity"),
            "{existing_table_error}"
        );
        let rows = table.list(None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].latest_snapshot_id, "snapshot-c");
    }

    #[tokio::test]
    async fn delete_removes_composite_identity() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();

        table
            .upsert(vec![
                row(
                    "snapshot-a",
                    "project-a",
                    "codex",
                    "session-a",
                    "Target",
                    "target",
                    vec![1.0, 0.0, 0.0, 0.0],
                ),
                row(
                    "snapshot-b",
                    "project-b",
                    "codex",
                    "session-a",
                    "Same session different project",
                    "keep",
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
            ])
            .await
            .unwrap();

        let deleted = table
            .delete(vec![identity("project-a", "codex", "session-a")])
            .await
            .unwrap();

        assert_eq!(deleted, 1);
        assert!(
            table
                .get(&[identity("project-a", "codex", "session-a")])
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            table
                .get(&[identity("project-b", "codex", "session-a")])
                .await
                .unwrap()[0]
                .latest_snapshot_id,
            "snapshot-b"
        );
    }

    #[tokio::test]
    async fn replace_all_rebuilds_table() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();

        table
            .upsert(vec![
                row(
                    "snapshot-a",
                    "project-a",
                    "codex",
                    "session-a",
                    "Old A",
                    "old a",
                    vec![1.0, 0.0, 0.0, 0.0],
                ),
                row(
                    "snapshot-b",
                    "project-b",
                    "codex",
                    "session-b",
                    "Old B",
                    "old b",
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
            ])
            .await
            .unwrap();

        table
            .replace_all(vec![row(
                "snapshot-c",
                "project-c",
                "claude",
                "session-c",
                "Replacement",
                "replacement",
                vec![0.0, 0.0, 1.0, 0.0],
            )])
            .await
            .unwrap();

        let rows = table.list(None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].latest_snapshot_id, "snapshot-c");
        assert_eq!(rows[0].project, "project-c");
    }

    #[tokio::test]
    async fn replace_all_rejects_bad_vector_without_deleting_existing_rows() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();
        table
            .upsert(vec![row(
                "snapshot-a",
                "project-a",
                "codex",
                "session-a",
                "Existing",
                "existing search text",
                vec![1.0, 0.0, 0.0, 0.0],
            )])
            .await
            .unwrap();

        let error = table
            .replace_all(vec![row(
                "snapshot-b",
                "project-b",
                "claude",
                "session-b",
                "Bad replacement",
                "bad replacement",
                vec![1.0, 0.0, 0.0],
            )])
            .await
            .expect_err("replacement rows should validate before deleting old rows");

        assert!(
            error.to_string().contains("invalid session_search vector"),
            "{error}"
        );
        let rows = table.list(None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].latest_snapshot_id, "snapshot-a");
    }

    #[tokio::test]
    async fn search_rejects_mismatched_query_vector_dimensions() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();
        table
            .upsert(vec![row(
                "snapshot-a",
                "project-a",
                "codex",
                "session-a",
                "Adoption agency shortlist",
                "Caroline researched adoption agencies.",
                vec![1.0, 0.0, 0.0, 0.0],
            )])
            .await
            .unwrap();

        let error = table
            .search("adoption agencies", &[1.0, 0.0, 0.0], 1)
            .await
            .expect_err("mismatched query vector should fail");

        assert!(
            error
                .to_string()
                .contains("session_search query vector dimension mismatch"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn replace_all_rejects_duplicate_session_identity() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();
        table
            .upsert(vec![row(
                "snapshot-a",
                "project-a",
                "codex",
                "session-a",
                "Existing",
                "existing",
                vec![1.0, 0.0, 0.0, 0.0],
            )])
            .await
            .unwrap();

        let error = table
            .replace_all(vec![
                row(
                    "snapshot-b",
                    "project-b",
                    "claude",
                    "session-b",
                    "Replacement one",
                    "replacement one",
                    vec![0.0, 1.0, 0.0, 0.0],
                ),
                row(
                    "snapshot-c",
                    "project-b",
                    "claude",
                    "session-b",
                    "Replacement two",
                    "replacement two",
                    vec![0.0, 0.0, 1.0, 0.0],
                ),
            ])
            .await
            .expect_err("duplicate replacement identities should fail");

        assert!(
            error
                .to_string()
                .contains("duplicate session_search identity"),
            "{error}"
        );
        let rows = table.list(None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].latest_snapshot_id, "snapshot-a");
    }

    #[tokio::test]
    async fn validate_dimensions_rejects_wrong_embedding_config() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        write_config(&dir);
        let table = table();
        table
            .upsert(vec![row(
                "snapshot-a",
                "project-a",
                "codex",
                "session-a",
                "Title",
                "search",
                vec![1.0, 0.0, 0.0, 0.0],
            )])
            .await
            .unwrap();

        let error = table
            .validate_dimensions(8)
            .await
            .expect_err("wrong dimensions should fail");

        assert!(
            error
                .to_string()
                .contains("session_search dimension mismatch"),
            "{error}"
        );
    }
}
