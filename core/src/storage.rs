use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::Arc;

use arrow_array::RecordBatchReader;
use arrow_array::builder::{ListBuilder, StringBuilder};
use arrow_array::{
    Array, FixedSizeListArray, Float32Array, Int64Array, ListArray, RecordBatch,
    RecordBatchIterator, StringArray, TimestampMicrosecondArray, UInt64Array,
};
use arrow_schema::{ArrowError, DataType, Field};
use chrono::{TimeZone, Utc};
use lance::Dataset;
use lance::dataset::WriteParams;
use lance::dataset::builder::DatasetBuilder;
use lance::dataset::{MergeInsertBuilder, WhenMatched, WhenNotMatched};
use lance::io::{ObjectStoreParams, StorageOptionsAccessor};
use lance::{Error, Result};
use object_store::path::Path;
use serde_json::Value;

use crate::config::semantic_index_config;
use crate::format::observing::ObservingSnapshot;
use crate::format::schema::{observing_schema, semantic_index_schema, turn_schema};
use crate::format::semantic_index::SemanticIndexRow;
use crate::format::session::{
    SessionKey, SessionTurn, TurnMetadataSource,
    reconcile_open_turns as reconcile_session_open_turns,
};
use crate::llm::config::{current_storage_config, muninn_home};

#[derive(Debug, Clone)]
pub struct Storage {
    root: Path,
    uri_root: String,
    storage_options: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone)]
pub(crate) enum SessionSelect {
    All,
    ById(String),
    Filter {
        agent: Option<String>,
        session_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct SessionStore<'a> {
    inner: DatasetStore<'a>,
}

#[derive(Debug, Clone)]
pub(crate) struct ObservingStore<'a> {
    inner: DatasetStore<'a>,
}

#[derive(Debug, Clone)]
pub(crate) struct SemanticIndexStore<'a> {
    inner: DatasetStore<'a>,
}

#[derive(Debug, Clone)]
struct DatasetStore<'a> {
    storage: &'a Storage,
    path: Path,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DatasetStats {
    pub version: u64,
    pub fragment_count: usize,
    pub row_count: usize,
}

impl Storage {
    pub fn load() -> Result<Self> {
        match current_storage_config()? {
            Some(config) => Self::from_uri(config.uri, config.storage_options),
            None => Self::local(muninn_home()),
        }
    }

    pub fn from_uri(
        uri_root: impl Into<String>,
        storage_options: Option<HashMap<String, String>>,
    ) -> Result<Self> {
        let uri_root = uri_root.into().trim_end_matches('/').to_string();
        if uri_root.is_empty() {
            return Err(Error::invalid_input("storage.uri must not be empty"));
        }
        Ok(Self {
            root: Path::default(),
            uri_root,
            storage_options,
        })
    }

    pub fn local(root_path: impl AsRef<FsPath>) -> Result<Self> {
        std::fs::create_dir_all(root_path.as_ref()).map_err(|error| {
            Error::io(format!(
                "create storage root {:?}: {error}",
                root_path.as_ref()
            ))
        })?;
        let canonical = std::fs::canonicalize(root_path.as_ref()).map_err(|error| {
            Error::io(format!(
                "canonicalize storage root {:?}: {error}",
                root_path.as_ref()
            ))
        })?;
        Self::from_uri(
            format!("file-object-store://{}", canonical.to_string_lossy()),
            None,
        )
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn matches(&self, other: &Self) -> bool {
        self.uri_root == other.uri_root && self.storage_options == other.storage_options
    }

    pub(crate) fn sessions(&self) -> SessionStore<'_> {
        SessionStore {
            inner: DatasetStore::new(self, self.root.child("turn")),
        }
    }

    pub(crate) fn observings(&self) -> ObservingStore<'_> {
        ObservingStore {
            inner: DatasetStore::new(self, self.root.child("observing")),
        }
    }

    pub(crate) fn semantic_index(&self) -> SemanticIndexStore<'_> {
        SemanticIndexStore {
            inner: DatasetStore::new(self, self.root.child("semantic_index")),
        }
    }

    fn uri_for(&self, path: &Path) -> String {
        if path.as_ref().is_empty() {
            self.uri_root.clone()
        } else {
            let root = self.uri_root.trim_end_matches('/');
            format!("{root}/{}", path.as_ref())
        }
    }

    fn dataset_builder(&self, path: &Path) -> DatasetBuilder {
        let mut builder = DatasetBuilder::from_uri(self.uri_for(path));
        if let Some(storage_options) = self.storage_options.clone() {
            builder = builder.with_storage_options(storage_options);
        }
        builder
    }

    fn write_params(&self) -> Option<WriteParams> {
        self.storage_options
            .clone()
            .map(|storage_options| WriteParams {
                store_params: Some(ObjectStoreParams {
                    storage_options_accessor: Some(Arc::new(
                        StorageOptionsAccessor::with_static_options(storage_options),
                    )),
                    ..Default::default()
                }),
                ..WriteParams::default()
            })
    }
}

impl<'a> DatasetStore<'a> {
    fn new(storage: &'a Storage, path: Path) -> Self {
        Self { storage, path }
    }

    async fn try_open(&self) -> Result<Option<Dataset>> {
        match self.storage.dataset_builder(&self.path).load().await {
            Ok(dataset) => Ok(Some(dataset)),
            Err(Error::DatasetNotFound { .. } | Error::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn write<R>(&self, reader: R) -> Result<Dataset>
    where
        R: RecordBatchReader + Send + 'static,
    {
        Dataset::write(
            reader,
            &self.storage.uri_for(&self.path),
            self.storage.write_params(),
        )
        .await
    }

    async fn maintenance_stats(&self) -> Result<Option<DatasetStats>> {
        let Some(dataset) = self.try_open().await? else {
            return Ok(None);
        };
        Ok(Some(DatasetStats {
            version: dataset.version().version,
            fragment_count: dataset.get_fragments().len(),
            row_count: dataset.count_rows(None).await?,
        }))
    }
}

impl SessionStore<'_> {
    pub(crate) async fn try_open_dataset(&self) -> Result<Option<Dataset>> {
        self.inner.try_open().await
    }

    pub(crate) async fn maintenance_stats(&self) -> Result<Option<DatasetStats>> {
        self.inner.maintenance_stats().await
    }

    pub(crate) async fn select(&self, selector: SessionSelect) -> Result<Vec<SessionTurn>> {
        let turns = self.load_all_turns().await?;
        match selector {
            SessionSelect::All => Ok(turns),
            SessionSelect::ById(turn_id) => Ok(turns
                .into_iter()
                .filter(|turn| turn.turn_id == turn_id)
                .collect()),
            SessionSelect::Filter { agent, session_id } => {
                Ok(filter_turns(turns, agent.as_deref(), session_id.as_deref()))
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn insert(&self, turns: Vec<SessionTurn>) -> Result<()> {
        if turns.is_empty() {
            return Ok(());
        }
        if let Some(mut dataset) = self.inner.try_open().await? {
            dataset.append(turns_to_reader(turns), None).await?;
            return Ok(());
        }
        let retry_turns = turns.clone();
        match self.inner.write(turns_to_reader(turns)).await {
            Ok(_) => Ok(()),
            Err(Error::DatasetAlreadyExists { .. }) => {
                let mut dataset = self.inner.try_open().await?.ok_or_else(|| {
                    Error::io(
                        "turn dataset existed after concurrent create but could not be reopened",
                    )
                })?;
                dataset.append(turns_to_reader(retry_turns), None).await?;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn upsert(&self, turns: Vec<SessionTurn>) -> Result<()> {
        if turns.is_empty() {
            return Ok(());
        }
        if let Some(dataset) = self.inner.try_open().await? {
            return self.execute_turn_upsert(dataset, turns).await;
        }
        let retry_turns = turns.clone();
        match self.inner.write(turns_to_reader(turns)).await {
            Ok(_) => Ok(()),
            Err(Error::DatasetAlreadyExists { .. }) => {
                let dataset = self.inner.try_open().await?.ok_or_else(|| {
                    Error::io(
                        "turn dataset existed after concurrent create but could not be reopened",
                    )
                })?;
                self.execute_turn_upsert(dataset, retry_turns).await
            }
            Err(error) => Err(error),
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn delete(&self, turn_ids: Vec<String>) -> Result<usize> {
        delete_by_ids(self.inner.try_open().await?, "turn_id", turn_ids).await
    }

    #[allow(dead_code)]
    pub(crate) async fn get_turn(&self, turn_id: &str) -> Result<Option<SessionTurn>> {
        Ok(self
            .get_turns(&[turn_id.to_string()])
            .await?
            .into_iter()
            .next())
    }

    #[allow(dead_code)]
    pub(crate) async fn get_turns(&self, turn_ids: &[String]) -> Result<Vec<SessionTurn>> {
        if turn_ids.is_empty() {
            return Ok(Vec::new());
        }
        let turns_by_id = self
            .load_all_turns()
            .await?
            .into_iter()
            .map(|turn| (turn.turn_id.clone(), turn))
            .collect::<HashMap<_, _>>();
        Ok(turn_ids
            .iter()
            .filter_map(|turn_id| turns_by_id.get(turn_id).cloned())
            .collect())
    }

    pub(crate) async fn load_open_turn(&self, session: &SessionKey) -> Result<Option<SessionTurn>> {
        let mut turns = self
            .load_all_turns()
            .await?
            .into_iter()
            .filter(|turn| turn.session_key() == *session)
            .filter(|turn| turn.is_open())
            .collect::<Vec<_>>();
        turns.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then(right.created_at.cmp(&left.created_at))
        });
        Ok(turns.into_iter().next())
    }

    pub(crate) async fn reconcile_open_turns(&self) -> Result<usize> {
        let mut open_turns_by_key = HashMap::<SessionKey, Vec<SessionTurn>>::new();
        for turn in self
            .load_all_turns()
            .await?
            .into_iter()
            .filter(|turn| turn.is_open())
        {
            open_turns_by_key
                .entry(turn.session_key())
                .or_default()
                .push(turn);
        }

        let mut repaired_sessions = 0;
        for turns in open_turns_by_key
            .into_values()
            .filter(|turns| turns.len() > 1)
        {
            let reconciliation = reconcile_session_open_turns(turns)?;
            self.upsert(vec![reconciliation.canonical_turn]).await?;
            self.delete(reconciliation.discarded_turn_ids).await?;
            repaired_sessions += 1;
        }
        Ok(repaired_sessions)
    }

    pub(crate) async fn turns_after_epoch(
        &self,
        observer: &str,
        committed_epoch: Option<u64>,
    ) -> Result<Vec<SessionTurn>> {
        let recovered_epoch = committed_epoch.map(|epoch| epoch + 1).unwrap_or(0);
        let mut turns = self
            .load_all_turns()
            .await?
            .into_iter()
            .filter(|turn| turn.observer == observer)
            .filter(|turn| turn.observable())
            .filter(|turn| match (committed_epoch, turn.observing_epoch) {
                (_, None) => true,
                (Some(epoch), Some(turn_epoch)) => turn_epoch > epoch,
                (None, Some(_)) => true,
            })
            .collect::<Vec<_>>();
        turns.sort_by(|left, right| {
            left.observing_epoch
                .unwrap_or(recovered_epoch)
                .cmp(&right.observing_epoch.unwrap_or(recovered_epoch))
                .then(left.created_at.cmp(&right.created_at))
                .then(left.updated_at.cmp(&right.updated_at))
        });
        Ok(turns)
    }

    async fn load_all_turns(&self) -> Result<Vec<SessionTurn>> {
        let Some(dataset) = self.inner.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_turns(&batch)
    }

    async fn execute_turn_upsert(&self, dataset: Dataset, turns: Vec<SessionTurn>) -> Result<()> {
        let dataset = Arc::new(dataset);
        let mut builder = MergeInsertBuilder::try_new(dataset, vec!["turn_id".to_string()])?;
        builder
            .when_matched(WhenMatched::UpdateAll)
            .when_not_matched(WhenNotMatched::InsertAll);
        let job = builder.try_build()?;
        job.execute_reader(turns_to_reader(turns)).await?;
        Ok(())
    }
}

impl ObservingStore<'_> {
    pub(crate) async fn try_open_dataset(&self) -> Result<Option<Dataset>> {
        self.inner.try_open().await
    }

    pub(crate) async fn maintenance_stats(&self) -> Result<Option<DatasetStats>> {
        self.inner.maintenance_stats().await
    }

    pub(crate) async fn list(&self, observer: Option<&str>) -> Result<Vec<ObservingSnapshot>> {
        let mut observings = self.load_all().await?;
        if let Some(observer) = observer {
            observings.retain(|observing| observing.observer == observer);
        }
        Ok(observings)
    }

    pub(crate) async fn get(&self, snapshot_id: &str) -> Result<Option<ObservingSnapshot>> {
        Ok(self
            .load_all()
            .await?
            .into_iter()
            .find(|observing| observing.snapshot_id == snapshot_id))
    }

    #[allow(dead_code)]
    pub(crate) async fn insert(&self, observings: Vec<ObservingSnapshot>) -> Result<()> {
        if observings.is_empty() {
            return Ok(());
        }
        if let Some(mut dataset) = self.inner.try_open().await? {
            dataset
                .append(observings_to_reader(observings), None)
                .await?;
        } else {
            self.inner.write(observings_to_reader(observings)).await?;
        }
        Ok(())
    }

    pub(crate) async fn upsert(&self, observings: Vec<ObservingSnapshot>) -> Result<()> {
        if observings.is_empty() {
            return Ok(());
        }
        if let Some(dataset) = self.inner.try_open().await? {
            let dataset = Arc::new(dataset);
            let mut builder =
                MergeInsertBuilder::try_new(dataset, vec!["snapshot_id".to_string()])?;
            builder
                .when_matched(WhenMatched::UpdateAll)
                .when_not_matched(WhenNotMatched::InsertAll);
            let job = builder.try_build()?;
            job.execute_reader(observings_to_reader(observings)).await?;
        } else {
            self.inner.write(observings_to_reader(observings)).await?;
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) async fn delete(&self, snapshot_ids: Vec<String>) -> Result<usize> {
        delete_by_ids(self.inner.try_open().await?, "snapshot_id", snapshot_ids).await
    }

    async fn load_all(&self) -> Result<Vec<ObservingSnapshot>> {
        let Some(dataset) = self.inner.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_observings(&batch)
    }
}

impl SemanticIndexStore<'_> {
    #[cfg(test)]
    pub(crate) async fn try_open_dataset(&self) -> Result<Option<Dataset>> {
        self.inner.try_open().await
    }

    pub(crate) async fn ensure_dataset(&self) -> Result<Dataset> {
        if let Some(dataset) = self.inner.try_open().await? {
            return Ok(dataset);
        }
        self.inner.write(semantic_rows_to_reader(Vec::new())?).await
    }

    pub(crate) async fn validate_dimensions(&self, expected_dimensions: usize) -> Result<()> {
        let Some(dataset) = self.inner.try_open().await? else {
            return Ok(());
        };
        let actual_dimensions = semantic_index_vector_dimensions(&dataset)?;
        semantic_index_memory_id_field(&dataset)?;
        if actual_dimensions != expected_dimensions {
            return Err(Error::invalid_input(format!(
                "semantic_index dimension mismatch: settings.json expects {expected_dimensions}, \
but the existing semantic_index dataset stores {actual_dimensions}; update semanticIndex.embedding.dimensions or rebuild the semantic_index dataset"
            )));
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn list(&self) -> Result<Vec<SemanticIndexRow>> {
        let Some(dataset) = self.inner.try_open().await? else {
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
        let Some(dataset) = self.inner.try_open().await? else {
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

        let Some(dataset) = self.inner.try_open().await? else {
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
        if let Some(mut dataset) = self.inner.try_open().await? {
            dataset.append(semantic_rows_to_reader(rows)?, None).await?;
        } else {
            self.inner.write(semantic_rows_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub(crate) async fn upsert(&self, rows: Vec<SemanticIndexRow>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(dataset) = self.inner.try_open().await? {
            let dataset = Arc::new(dataset);
            let mut builder = MergeInsertBuilder::try_new(dataset, vec!["id".to_string()])?;
            builder
                .when_matched(WhenMatched::UpdateAll)
                .when_not_matched(WhenNotMatched::InsertAll);
            let job = builder.try_build()?;
            job.execute_reader(semantic_rows_to_reader(rows)?).await?;
        } else {
            self.inner.write(semantic_rows_to_reader(rows)?).await?;
        }
        Ok(())
    }

    pub(crate) async fn delete(&self, ids: Vec<String>) -> Result<usize> {
        delete_by_ids(self.inner.try_open().await?, "id", ids).await
    }
}

async fn delete_by_ids(
    dataset: Option<Dataset>,
    column_name: &str,
    ids: Vec<String>,
) -> Result<usize> {
    let Some(mut dataset) = dataset else {
        return Ok(0);
    };
    if ids.is_empty() {
        return Ok(0);
    }
    let predicate = ids
        .iter()
        .map(|id| format!("{column_name} = '{}'", escape_predicate_string(id)))
        .collect::<Vec<_>>()
        .join(" OR ");
    let result = dataset.delete(&predicate).await?;
    Ok(result.num_deleted_rows as usize)
}

fn escape_predicate_string(value: &str) -> String {
    value.replace('\'', "''")
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

fn turns_to_record_batch(turns: &[SessionTurn]) -> std::result::Result<RecordBatch, ArrowError> {
    let turn_ids = StringArray::from_iter_values(turns.iter().map(|turn| turn.turn_id.as_str()));
    let created_at = TimestampMicrosecondArray::from_iter_values(
        turns.iter().map(|turn| turn.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        turns.iter().map(|turn| turn.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let session_ids = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.session_id.as_deref())
            .collect::<Vec<_>>(),
    );
    let agent = StringArray::from_iter_values(turns.iter().map(|turn| turn.agent.as_str()));
    let observer = StringArray::from_iter_values(turns.iter().map(|turn| turn.observer.as_str()));
    let title = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.title.as_deref())
            .collect::<Vec<_>>(),
    );
    let summary = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.summary.as_deref())
            .collect::<Vec<_>>(),
    );
    let tool_calling = build_string_list_array(turns.iter().map(|turn| turn.tool_calling.as_ref()));
    let artifacts_json = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.artifacts.as_ref().map(artifacts_to_json))
            .collect::<Vec<_>>(),
    );
    let prompt = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.prompt.as_deref())
            .collect::<Vec<_>>(),
    );
    let response = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.response.as_deref())
            .collect::<Vec<_>>(),
    );
    let observing_epoch = UInt64Array::from(
        turns
            .iter()
            .map(|turn| turn.observing_epoch)
            .collect::<Vec<_>>(),
    );
    let title_source = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.title_source.map(metadata_source_to_str))
            .collect::<Vec<_>>(),
    );
    let summary_source = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.summary_source.map(metadata_source_to_str))
            .collect::<Vec<_>>(),
    );

    Ok(RecordBatch::try_new(
        Arc::new(turn_schema()),
        vec![
            Arc::new(turn_ids),
            Arc::new(created_at),
            Arc::new(updated_at),
            Arc::new(session_ids),
            Arc::new(agent),
            Arc::new(observer),
            Arc::new(title),
            Arc::new(summary),
            Arc::new(tool_calling),
            Arc::new(artifacts_json),
            Arc::new(prompt),
            Arc::new(response),
            Arc::new(observing_epoch),
            Arc::new(title_source),
            Arc::new(summary_source),
        ],
    )?)
}

fn turns_to_reader(
    turns: Vec<SessionTurn>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(turn_schema());
    let batch = turns_to_record_batch(&turns);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

fn record_batch_to_turns(batch: &RecordBatch) -> lance::Result<Vec<SessionTurn>> {
    let turn_ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let created_at = batch
        .column(1)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let updated_at = batch
        .column(2)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let session_ids = batch
        .column(3)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let agent = batch
        .column(4)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let observer = batch
        .column(5)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let title = batch
        .column(6)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let summary = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let tool_calling = batch
        .column(8)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let artifacts_json = batch
        .column(9)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let prompt = batch
        .column(10)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let response = batch
        .column(11)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let observing_epoch = batch
        .column(12)
        .as_any()
        .downcast_ref::<UInt64Array>()
        .unwrap();
    let title_source = batch
        .column(13)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let summary_source = batch
        .column(14)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();

    let turns = (0..batch.num_rows())
        .map(|index| SessionTurn {
            turn_id: turn_ids.value(index).to_string(),
            created_at: Utc
                .timestamp_micros(created_at.value(index))
                .single()
                .unwrap(),
            updated_at: Utc
                .timestamp_micros(updated_at.value(index))
                .single()
                .unwrap(),
            session_id: optional_string(session_ids, index),
            agent: agent.value(index).to_string(),
            observer: observer.value(index).to_string(),
            title: optional_string(title, index),
            summary: optional_string(summary, index),
            title_source: optional_metadata_source(title_source, index),
            summary_source: optional_metadata_source(summary_source, index),
            tool_calling: optional_string_list(tool_calling, index),
            artifacts: optional_artifacts(artifacts_json, index),
            prompt: optional_string(prompt, index),
            response: optional_string(response, index),
            observing_epoch: optional_u64(observing_epoch, index),
        })
        .collect();
    Ok(turns)
}

fn filter_turns(
    turns: Vec<SessionTurn>,
    agent: Option<&str>,
    session_id: Option<&str>,
) -> Vec<SessionTurn> {
    turns
        .into_iter()
        .filter(|turn| {
            let agent_match = agent.map(|value| turn.agent == value).unwrap_or(true);
            let session_match = session_id
                .map(|value| turn.session_id.as_deref() == Some(value))
                .unwrap_or(true);
            agent_match && session_match
        })
        .collect()
}

fn build_string_list_array<'a>(values: impl Iterator<Item = Option<&'a Vec<String>>>) -> ListArray {
    let mut builder = ListBuilder::new(StringBuilder::new());
    for maybe_values in values {
        if let Some(entries) = maybe_values {
            for entry in entries {
                builder.values().append_value(entry);
            }
            builder.append(true);
        } else {
            builder.append(false);
        }
    }
    builder.finish()
}

fn optional_string(array: &StringArray, index: usize) -> Option<String> {
    (!array.is_null(index)).then(|| array.value(index).to_string())
}

fn optional_u64(array: &UInt64Array, index: usize) -> Option<u64> {
    (!array.is_null(index)).then(|| array.value(index))
}

fn metadata_source_to_str(source: TurnMetadataSource) -> &'static str {
    match source {
        TurnMetadataSource::Fallback => "fallback",
        TurnMetadataSource::Generated => "generated",
        TurnMetadataSource::User => "user",
    }
}

fn optional_metadata_source(array: &StringArray, index: usize) -> Option<TurnMetadataSource> {
    if array.is_null(index) {
        return None;
    }
    match array.value(index) {
        "fallback" => Some(TurnMetadataSource::Fallback),
        "generated" => Some(TurnMetadataSource::Generated),
        "user" => Some(TurnMetadataSource::User),
        _ => None,
    }
}

fn optional_string_list(array: &ListArray, index: usize) -> Option<Vec<String>> {
    if array.is_null(index) {
        return None;
    }
    let values = array.value(index);
    let values = values.as_any().downcast_ref::<StringArray>().unwrap();
    Some(
        (0..values.len())
            .map(|idx| values.value(idx).to_string())
            .collect(),
    )
}

fn artifacts_to_json(artifacts: &HashMap<String, String>) -> String {
    serde_json::to_string(artifacts).expect("artifacts should serialize")
}

fn optional_artifacts(array: &StringArray, index: usize) -> Option<HashMap<String, String>> {
    if array.is_null(index) {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(array.value(index)).ok()?;
    let object = parsed.as_object()?;
    Some(
        object
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
            .collect(),
    )
}

fn observings_to_record_batch(
    observings: &[ObservingSnapshot],
) -> std::result::Result<RecordBatch, ArrowError> {
    let snapshot_ids = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.snapshot_id.as_str()),
    );
    let observing_ids = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.observing_id.as_str()),
    );
    let snapshot_sequence = Int64Array::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.snapshot_sequence),
    );
    let created_at = TimestampMicrosecondArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let observer = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.observer.as_str()),
    );
    let title =
        StringArray::from_iter_values(observings.iter().map(|observing| observing.title.as_str()));
    let summary = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.summary.as_str()),
    );
    let content = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.content.as_str()),
    );
    let references = build_string_list_array(
        observings
            .iter()
            .map(|observing| Some(&observing.references)),
    );
    let checkpoint = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| serde_json::to_string(&observing.checkpoint).expect("checkpoint")),
    );

    Ok(RecordBatch::try_new(
        Arc::new(observing_schema()),
        vec![
            Arc::new(snapshot_ids),
            Arc::new(observing_ids),
            Arc::new(snapshot_sequence),
            Arc::new(created_at),
            Arc::new(updated_at),
            Arc::new(observer),
            Arc::new(title),
            Arc::new(summary),
            Arc::new(content),
            Arc::new(references),
            Arc::new(checkpoint),
        ],
    )?)
}

fn observings_to_reader(
    observings: Vec<ObservingSnapshot>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(observing_schema());
    let batch = observings_to_record_batch(&observings);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

fn record_batch_to_observings(batch: &RecordBatch) -> lance::Result<Vec<ObservingSnapshot>> {
    let snapshot_ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let observing_ids = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let snapshot_sequence = batch
        .column(2)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    let created_at = batch
        .column(3)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let updated_at = batch
        .column(4)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let observer = batch
        .column(5)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let title = batch
        .column(6)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let summary = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let content = batch
        .column(8)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let references = batch
        .column(9)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let checkpoint = batch
        .column(10)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();

    let observings = (0..batch.num_rows())
        .map(|index| {
            let checkpoint = serde_json::from_str(checkpoint.value(index)).map_err(|error| {
                Error::invalid_input(format!("deserialize observing checkpoint: {error}"))
            })?;
            Ok(ObservingSnapshot {
                snapshot_id: snapshot_ids.value(index).to_string(),
                observing_id: observing_ids.value(index).to_string(),
                snapshot_sequence: snapshot_sequence.value(index),
                created_at: Utc
                    .timestamp_micros(created_at.value(index))
                    .single()
                    .unwrap(),
                updated_at: Utc
                    .timestamp_micros(updated_at.value(index))
                    .single()
                    .unwrap(),
                observer: observer.value(index).to_string(),
                title: title.value(index).to_string(),
                summary: summary.value(index).to_string(),
                content: content.value(index).to_string(),
                references: optional_string_list(references, index).unwrap_or_default(),
                checkpoint,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(observings)
}

fn semantic_rows_to_record_batch(rows: &[SemanticIndexRow]) -> Result<RecordBatch> {
    let dimensions = semantic_index_dimensions()?;
    let ids = StringArray::from_iter_values(rows.iter().map(|row| row.id.as_str()));
    let memory_ids = StringArray::from_iter_values(rows.iter().map(|row| row.memory_id.as_str()));
    let text = StringArray::from_iter_values(rows.iter().map(|row| row.text.as_str()));
    let vector = build_float32_fixed_size_list_array(
        rows.iter().map(|row| row.vector.as_slice()),
        dimensions,
    )
    .map_err(|error| Error::invalid_input(format!("invalid semantic index vector: {error}")))?;
    let importance = Float32Array::from_iter_values(rows.iter().map(|row| row.importance));
    let category = StringArray::from_iter_values(rows.iter().map(|row| row.category.as_str()));
    let created_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");

    RecordBatch::try_new(
        Arc::new(semantic_index_schema(dimensions)),
        vec![
            Arc::new(ids),
            Arc::new(memory_ids),
            Arc::new(text),
            Arc::new(vector),
            Arc::new(importance),
            Arc::new(category),
            Arc::new(created_at),
        ],
    )
    .map_err(|error| Error::invalid_input(format!("build semantic_index batch: {error}")))
}

fn semantic_rows_to_reader(
    rows: Vec<SemanticIndexRow>,
) -> Result<RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>>
{
    let dimensions = semantic_index_dimensions()?;
    let schema = Arc::new(semantic_index_schema(dimensions));
    let batch = semantic_rows_to_record_batch(&rows).map_err(arrow_error_from_lance)?;
    Ok(RecordBatchIterator::new(
        vec![Ok(batch)].into_iter(),
        schema,
    ))
}

fn record_batch_to_semantic_rows(batch: &RecordBatch) -> lance::Result<Vec<SemanticIndexRow>> {
    let ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let memory_ids = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let text = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let vector = batch.column(3);
    let importance = batch
        .column(4)
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    let category = batch
        .column(5)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let created_at = batch
        .column(6)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();

    (0..batch.num_rows())
        .map(|index| {
            let vector = if let Some(vector) = vector.as_any().downcast_ref::<FixedSizeListArray>()
            {
                optional_float32_fixed_size_list(vector, index).unwrap_or_default()
            } else {
                return Err(lance::Error::invalid_input(format!(
                    "semantic_index.vector must be FixedSizeList<Float32, N>, got {:?}",
                    vector.data_type()
                )));
            };

            Ok(SemanticIndexRow {
                id: ids.value(index).to_string(),
                memory_id: memory_ids.value(index).to_string(),
                text: text.value(index).to_string(),
                vector,
                importance: importance.value(index),
                category: category.value(index).to_string(),
                created_at: Utc
                    .timestamp_micros(created_at.value(index))
                    .single()
                    .unwrap(),
            })
        })
        .collect()
}

fn build_float32_fixed_size_list_array<'a>(
    values: impl Iterator<Item = &'a [f32]>,
    dimensions: usize,
) -> std::result::Result<FixedSizeListArray, ArrowError> {
    let mut flattened = Vec::new();
    let mut row_count = 0usize;
    for entries in values {
        if entries.len() != dimensions {
            return Err(ArrowError::InvalidArgumentError(format!(
                "expected vector length {dimensions}, got {}",
                entries.len()
            )));
        }
        flattened.extend_from_slice(entries);
        row_count += 1;
    }

    FixedSizeListArray::try_new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dimensions as i32,
        Arc::new(Float32Array::from(flattened)),
        None,
    )
    .map_err(|error| {
        ArrowError::InvalidArgumentError(format!(
            "build FixedSizeListArray for {row_count} semantic rows: {error}"
        ))
    })
}

fn optional_float32_fixed_size_list(array: &FixedSizeListArray, index: usize) -> Option<Vec<f32>> {
    if array.is_null(index) {
        return None;
    }
    let values = array.value(index);
    let values = values.as_any().downcast_ref::<Float32Array>().unwrap();
    Some((0..values.len()).map(|idx| values.value(idx)).collect())
}

fn semantic_index_dimensions() -> Result<usize> {
    Ok(semantic_index_config()?.dimensions)
}

fn semantic_index_vector_dimensions(dataset: &Dataset) -> Result<usize> {
    let vector = dataset.schema().field("vector").ok_or_else(|| {
        Error::invalid_input(
            "semantic_index dataset schema is invalid: missing vector column; rebuild the semantic_index dataset",
        )
    })?;

    match vector.data_type() {
        DataType::FixedSizeList(item, dimensions) if item.data_type() == &DataType::Float32 => {
            if dimensions <= 0 {
                return Err(Error::invalid_input(
                    "semantic_index dataset schema is invalid: vector dimension must be positive; rebuild the semantic_index dataset",
                ));
            }
            Ok(dimensions as usize)
        }
        actual => Err(Error::invalid_input(format!(
            "semantic_index dataset schema is incompatible: expected vector column type FixedSizeList<Float32, N>, found {actual:?}; rebuild the semantic_index dataset"
        ))),
    }
}

fn semantic_index_memory_id_field(dataset: &Dataset) -> Result<()> {
    let field = dataset.schema().field("memory_id").ok_or_else(|| {
        Error::invalid_input(
            "semantic_index dataset schema is incompatible: missing memory_id column; rebuild the semantic_index dataset",
        )
    })?;

    match field.data_type() {
        DataType::Utf8 => Ok(()),
        actual => Err(Error::invalid_input(format!(
            "semantic_index dataset schema is incompatible: expected memory_id column type Utf8, found {actual:?}; rebuild the semantic_index dataset"
        ))),
    }
}

fn arrow_error_from_lance(error: Error) -> ArrowError {
    ArrowError::ExternalError(Box::new(error))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{Duration, Utc};

    use super::{SessionSelect, Storage};
    use crate::format::observing::{ObservingCheckpoint, ObservingSnapshot};
    use crate::format::semantic_index::SemanticIndexRow;
    use crate::format::session::{SessionKey, SessionTurn};
    use crate::service::Service;

    fn test_storage() -> Storage {
        let dir = tempfile::tempdir().unwrap();
        Storage::local(dir.keep()).unwrap()
    }

    fn make_turn(
        turn_id: &str,
        agent: &str,
        session_id: Option<&str>,
        summary: Option<&str>,
    ) -> SessionTurn {
        let now = Utc::now();
        SessionTurn {
            turn_id: turn_id.to_string(),
            created_at: now,
            updated_at: now,
            session_id: session_id.map(str::to_string),
            agent: agent.to_string(),
            observer: "observer-a".to_string(),
            title: Some(format!("title-{turn_id}")),
            summary: summary.map(str::to_string),
            title_source: None,
            summary_source: None,
            tool_calling: None,
            artifacts: None,
            prompt: Some(format!("prompt-{turn_id}")),
            response: Some(format!("response-{turn_id}")),
            observing_epoch: None,
        }
    }

    fn make_observing_snapshot(
        snapshot_id: &str,
        observing_id: &str,
        observer: &str,
    ) -> ObservingSnapshot {
        let now = Utc::now();
        ObservingSnapshot {
            snapshot_id: snapshot_id.to_string(),
            observing_id: observing_id.to_string(),
            snapshot_sequence: 0,
            created_at: now,
            updated_at: now,
            observer: observer.to_string(),
            title: format!("title-{snapshot_id}"),
            summary: format!("summary-{snapshot_id}"),
            content: "{\"memories\":[]}".to_string(),
            references: vec![format!("SESSION:{snapshot_id}")],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 0,
                indexed_snapshot_sequence: Some(0),
            },
        }
    }

    fn make_semantic_row(id: &str, text: &str) -> SemanticIndexRow {
        let dimensions = crate::config::semantic_index_config().unwrap().dimensions;
        let vector = (0..dimensions)
            .map(|index| (index + 1) as f32 / 10.0)
            .collect();
        SemanticIndexRow {
            id: id.to_string(),
            memory_id: "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string(),
            text: text.to_string(),
            vector,
            importance: 0.7,
            category: "fact".to_string(),
            created_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn session_store_select_upsert_delete_roundtrip() {
        let storage = test_storage();
        let turns = vec![
            make_turn(
                "01JQ7Y8YQ6V7D4M1N9K2F5T8ZA",
                "agent-a",
                Some("group-a"),
                Some("summary-a"),
            ),
            make_turn(
                "01JQ7Y8YQ6V7D4M1N9K2F5T8ZB",
                "agent-b",
                Some("group-b"),
                Some("summary-b"),
            ),
        ];

        storage.sessions().insert(turns.clone()).await.unwrap();

        assert_eq!(
            storage
                .sessions()
                .select(SessionSelect::All)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            storage
                .sessions()
                .select(SessionSelect::ById(turns[0].turn_id.clone()))
                .await
                .unwrap()[0]
                .agent,
            "agent-a"
        );
        assert_eq!(
            storage
                .sessions()
                .select(SessionSelect::Filter {
                    agent: Some("agent-b".to_string()),
                    session_id: Some("group-b".to_string()),
                })
                .await
                .unwrap()
                .len(),
            1
        );

        let mut updated = turns[0].clone();
        updated.summary = Some("updated summary".to_string());
        updated.updated_at += Duration::seconds(1);
        storage
            .sessions()
            .upsert(vec![updated.clone()])
            .await
            .unwrap();

        let reloaded = storage
            .sessions()
            .select(SessionSelect::ById(updated.turn_id.clone()))
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(reloaded.summary.as_deref(), Some("updated summary"));

        let deleted = storage
            .sessions()
            .delete(vec![updated.turn_id.clone()])
            .await
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(
            storage
                .sessions()
                .select(SessionSelect::All)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn observing_store_list_get_upsert_delete_roundtrip() {
        let storage = test_storage();
        let observing_a =
            make_observing_snapshot("01JQ7Y8YQ6V7D4M1N9K2F5T8ZC", "OBS-A", "observer-a");
        let observing_b =
            make_observing_snapshot("01JQ7Y8YQ6V7D4M1N9K2F5T8ZD", "OBS-B", "observer-b");

        storage
            .observings()
            .insert(vec![observing_a.clone(), observing_b.clone()])
            .await
            .unwrap();

        assert_eq!(storage.observings().list(None).await.unwrap().len(), 2);
        assert_eq!(
            storage
                .observings()
                .list(Some("observer-a"))
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            storage
                .observings()
                .get(&observing_a.snapshot_id)
                .await
                .unwrap()
                .unwrap()
                .observing_id,
            "OBS-A"
        );

        let mut updated = observing_a.clone();
        updated.summary = "updated observing summary".to_string();
        updated.updated_at += Duration::seconds(1);
        storage
            .observings()
            .upsert(vec![updated.clone()])
            .await
            .unwrap();

        assert_eq!(
            storage
                .observings()
                .get(&updated.snapshot_id)
                .await
                .unwrap()
                .unwrap()
                .summary,
            "updated observing summary"
        );

        let deleted = storage
            .observings()
            .delete(vec![observing_b.snapshot_id.clone()])
            .await
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(storage.observings().list(None).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn semantic_index_store_list_upsert_delete_roundtrip() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        crate::llm::config::write_test_muninn_config(
            &home.join("settings.json"),
            None,
            None,
            Some("mock"),
        );
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let storage = Storage::local(dir.path().join("store")).unwrap();
        let row_a = make_semantic_row("mem-a", "alpha");
        let row_b = make_semantic_row("mem-b", "beta");

        storage
            .semantic_index()
            .insert(vec![row_a.clone(), row_b.clone()])
            .await
            .unwrap();

        assert_eq!(storage.semantic_index().list().await.unwrap().len(), 2);
        assert!(
            storage
                .semantic_index()
                .list()
                .await
                .unwrap()
                .iter()
                .any(|row| row.id == "mem-b" && row.text == "beta")
        );
        let subset = storage
            .semantic_index()
            .load_by_ids(&["mem-b".to_string()])
            .await
            .unwrap();
        assert_eq!(subset.len(), 1);
        assert_eq!(subset[0].id, "mem-b");
        assert_eq!(subset[0].memory_id, "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX");

        let mut updated = row_a.clone();
        updated.text = "alpha-updated".to_string();
        updated.created_at += Duration::seconds(1);
        storage
            .semantic_index()
            .upsert(vec![updated.clone()])
            .await
            .unwrap();

        let rows = storage.semantic_index().list().await.unwrap();
        assert!(rows.iter().any(|row| row.id == "mem-a"
            && row.memory_id == "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX"
            && row.text == "alpha-updated"));

        let deleted = storage
            .semantic_index()
            .delete(vec!["mem-b".to_string()])
            .await
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(storage.semantic_index().list().await.unwrap().len(), 1);

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn semantic_index_nearest_returns_closest_vectors_first() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        crate::llm::config::write_test_muninn_config(
            &home.join("settings.json"),
            None,
            None,
            Some("mock"),
        );
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let storage = Storage::local(dir.path().join("store")).unwrap();
        let query = vec![1.0, 0.0, 0.0, 0.0];
        let row_a = SemanticIndexRow {
            id: "mem-a".to_string(),
            memory_id: "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZY".to_string(),
            text: "alpha".to_string(),
            vector: vec![1.0, 0.0, 0.0, 0.0],
            importance: 0.7,
            category: "fact".to_string(),
            created_at: Utc::now(),
        };
        let row_b = SemanticIndexRow {
            id: "mem-b".to_string(),
            memory_id: "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZZ".to_string(),
            text: "beta".to_string(),
            vector: vec![0.0, 1.0, 0.0, 0.0],
            importance: 0.7,
            category: "fact".to_string(),
            created_at: Utc::now(),
        };

        storage
            .semantic_index()
            .upsert(vec![row_b.clone(), row_a.clone()])
            .await
            .unwrap();

        let rows = storage.semantic_index().nearest(&query, 2).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "mem-a");
        assert_eq!(rows[1].id, "mem-b");

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn service_startup_rejects_semantic_index_dimension_mismatch() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("settings.json"),
            r#"{
              "semanticIndex": {
                "embedding": {
                  "provider": "mock",
                  "dimensions": 4
                },
                "defaultImportance": 0.7
              }
            }"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }

        let storage = Storage::local(dir.path().join("store")).unwrap();
        storage
            .semantic_index()
            .insert(vec![make_semantic_row("mem-a", "alpha")])
            .await
            .unwrap();

        std::fs::write(
            home.join("settings.json"),
            r#"{
              "semanticIndex": {
                "embedding": {
                  "provider": "mock",
                  "dimensions": 8
                },
                "defaultImportance": 0.7
              }
            }"#,
        )
        .unwrap();

        let error = Service::new(storage.clone())
            .await
            .err()
            .expect("service startup should fail");
        let message = error.to_string();
        assert!(message.contains("semantic_index dimension mismatch"));
        assert!(message.contains("expects 8"));
        assert!(message.contains("stores 4"));

        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn session_store_load_open_turn_and_turns_after_epoch() {
        let storage = test_storage();
        let mut open_old = make_turn(
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZE",
            "agent-a",
            Some("group-a"),
            None,
        );
        open_old.response = None;
        open_old.updated_at -= Duration::seconds(2);

        let mut open_new = make_turn(
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZF",
            "agent-a",
            Some("group-a"),
            None,
        );
        open_new.response = None;

        let mut pending = make_turn(
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZG",
            "agent-a",
            Some("group-b"),
            Some("summary-b"),
        );
        pending.observing_epoch = Some(3);

        storage
            .sessions()
            .insert(vec![open_old.clone(), open_new.clone(), pending.clone()])
            .await
            .unwrap();

        let latest_open = storage
            .sessions()
            .load_open_turn(&SessionKey::Session {
                session_id: "group-a".to_string(),
                agent: "agent-a".to_string(),
                observer: "observer-a".to_string(),
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest_open.turn_id, open_new.turn_id);

        let pending_turns = storage
            .sessions()
            .turns_after_epoch("observer-a", Some(2))
            .await
            .unwrap();
        assert_eq!(pending_turns.len(), 1);
        assert_eq!(pending_turns[0].turn_id, pending.turn_id);
    }

    #[tokio::test]
    async fn session_store_load_open_turn_matches_full_session_agent_and_observer_key() {
        let storage = test_storage();
        let mut explicit_agent_a = make_turn(
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZH",
            "agent-a",
            Some("group-a"),
            None,
        );
        explicit_agent_a.response = None;

        let mut explicit_agent_b = make_turn(
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZJ",
            "agent-b",
            Some("group-a"),
            None,
        );
        explicit_agent_b.response = None;

        let mut agent_default = make_turn("01JQ7Y8YQ6V7D4M1N9K2F5T8ZK", "agent-c", None, None);
        agent_default.response = None;

        storage
            .sessions()
            .insert(vec![
                explicit_agent_a.clone(),
                explicit_agent_b.clone(),
                agent_default.clone(),
            ])
            .await
            .unwrap();

        let explicit_lookup = storage
            .sessions()
            .load_open_turn(&SessionKey::Session {
                session_id: "group-a".to_string(),
                agent: "agent-b".to_string(),
                observer: "observer-a".to_string(),
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(explicit_lookup.turn_id, explicit_agent_b.turn_id);

        let default_lookup = storage
            .sessions()
            .load_open_turn(&SessionKey::Agent {
                agent: "agent-c".to_string(),
                observer: "observer-a".to_string(),
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(default_lookup.turn_id, agent_default.turn_id);
    }

    #[tokio::test]
    async fn session_store_reconcile_open_turns_merges_into_latest_row() {
        let storage = test_storage();
        let mut first = make_turn(
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZL",
            "agent-a",
            Some("group-a"),
            Some("summary-a"),
        );
        first.response = None;
        first.prompt = Some("prompt-a".to_string());
        first.tool_calling = Some(vec!["tool-a".to_string()]);
        first.artifacts = Some(HashMap::from([("shared".to_string(), "a".to_string())]));

        let mut second = make_turn(
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZM",
            "agent-a",
            Some("group-a"),
            Some("summary-b"),
        );
        second.response = None;
        second.prompt = Some("prompt-b".to_string());
        second.tool_calling = Some(vec!["tool-b".to_string()]);
        second.artifacts = Some(HashMap::from([
            ("shared".to_string(), "b".to_string()),
            ("new".to_string(), "v".to_string()),
        ]));

        storage
            .sessions()
            .insert(vec![first.clone(), second.clone()])
            .await
            .unwrap();

        let repaired = storage.sessions().reconcile_open_turns().await.unwrap();
        assert_eq!(repaired, 1);

        let turns = storage
            .sessions()
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-a".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].turn_id, second.turn_id);
        assert_eq!(turns[0].prompt.as_deref(), Some("prompt-a\n\nprompt-b"));
        assert_eq!(
            turns[0].tool_calling.as_deref(),
            Some(&["tool-a".to_string(), "tool-b".to_string()][..])
        );
        assert_eq!(
            turns[0]
                .artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.get("shared"))
                .map(String::as_str),
            Some("b")
        );
        assert_eq!(turns[0].title.as_deref(), second.title.as_deref());
        assert_eq!(turns[0].summary.as_deref(), second.summary.as_deref());
    }
}
