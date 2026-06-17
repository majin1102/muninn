use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use muninn_format::{
    Dreaming, DreamingTable, Extraction, ExtractionTable, MemoryId, MemoryLayer, RecallMode,
    SessionSnapshot, SessionTable, TableOptions, Turn, TurnTable, data_root,
};
use napi::{Error, Result as NapiResult};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

#[derive(Clone)]
struct CoreResources {
    dreaming_table: DreamingTable,
    session_table: SessionTable,
    turn_table: TurnTable,
    extraction_table: ExtractionTable,
}

struct CoreState {
    resources: Mutex<Option<CoreResources>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ListModeInput {
    Recency { limit: usize },
    Page { offset: usize, limit: usize },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnListParams {
    mode: ListModeInput,
    agent: Option<String>,
    session_id: Option<String>,
    extractor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnTimelineParams {
    memory_id: String,
    before_limit: Option<usize>,
    after_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnLoadAfterEpochParams {
    extractor: String,
    committed_epoch: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableDeltaParams {
    extractor: String,
    baseline_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupParams {
    floor_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnInsertParams {
    turns: Vec<Turn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnDeleteParams {
    turn_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListSnapshotsParams {
    extractor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInsertParams {
    snapshots: Vec<SessionSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DreamingAppendParams {
    row: Dreaming,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionNearestParams {
    vector: Vec<f32>,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionSearchParams {
    query: String,
    vector: Vec<f32>,
    limit: usize,
    mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionGetParams {
    ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionListParams {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionDeltaParams {
    baseline_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionUpsertParams {
    rows: Vec<Extraction>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionDeleteParams {
    ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageTargetParams {
    uri: String,
    storage_options: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedDimensionsParams {
    expected: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetPartitionSizeParams {
    target_partition_size: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptimizeParams {
    merge_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletedCount {
    deleted: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedResult {
    changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedResult {
    created: bool,
}

#[napi]
pub struct CoreBinding {
    inner: Arc<CoreState>,
}

#[napi]
impl CoreBinding {
    #[napi(js_name = "close")]
    pub async fn close(&self) -> NapiResult<()> {
        let mut guard = self.inner.resources.lock().await;
        guard.take();
        Ok(())
    }

    #[napi(js_name = "turnGet")]
    pub async fn turn_get(&self, turn_id: String) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let memory_id = parse_memory_id(&turn_id, MemoryLayer::Turn)?;
        into_napi_value(
            resources
                .turn_table
                .get_turn(memory_id.memory_point())
                .await,
        )
    }

    #[napi(js_name = "turnList")]
    pub async fn turn_list(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TurnListParams>(params)?;
        let resources = self.resources().await?;
        let turns = match params.mode {
            ListModeInput::Recency { limit } => {
                resources
                    .turn_table
                    .list_recent_turns(params.agent, params.session_id, params.extractor, limit)
                    .await
            }
            ListModeInput::Page { offset, limit } => {
                resources
                    .turn_table
                    .list_turns(params.agent, params.session_id, params.extractor, offset, limit)
                    .await
            }
        };
        into_napi_value(turns)
    }

    #[napi(js_name = "turnTimeline")]
    pub async fn turn_timeline(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TurnTimelineParams>(params)?;
        let resources = self.resources().await?;
        let memory_id = parse_memory_id(&params.memory_id, MemoryLayer::Turn)?;
        into_napi_value(
            resources
                .turn_table
                .timeline_turns(
                    memory_id,
                    params.before_limit.unwrap_or(3),
                    params.after_limit.unwrap_or(3),
                )
                .await,
        )
    }

    #[napi(js_name = "turnLoadAfterEpoch")]
    pub async fn turn_load_after_epoch(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TurnLoadAfterEpochParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .turn_table
                .turns_after_epoch(&params.extractor, params.committed_epoch)
                .await,
        )
    }

    #[napi(js_name = "turnDelta")]
    pub async fn turn_delta(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TableDeltaParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .turn_table
                .delta(&params.extractor, params.baseline_version)
                .await,
        )
    }

    #[napi(js_name = "turnInsert")]
    pub async fn turn_insert(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TurnInsertParams>(params)?;
        let resources = self.resources().await?;
        let mut turns = params.turns;
        resources
            .turn_table
            .insert(&mut turns)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(turns)
    }

    #[napi(js_name = "turnDelete")]
    pub async fn turn_delete(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TurnDeleteParams>(params)?;
        let resources = self.resources().await?;
        let turn_ids = params
            .turn_ids
            .iter()
            .map(|turn_id| parse_memory_id(turn_id, MemoryLayer::Turn))
            .collect::<NapiResult<Vec<_>>>()?;
        let deleted = resources
            .turn_table
            .delete(turn_ids)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(DeletedCount { deleted })
    }

    #[napi(js_name = "turnTableStats")]
    pub async fn turn_table_stats(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.turn_table.stats().await)
    }

    #[napi(js_name = "turnCompact")]
    pub async fn turn_compact(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let changed = resources
            .turn_table
            .compact()
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "turnCleanup")]
    pub async fn turn_cleanup(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<CleanupParams>(params)?;
        let resources = self.resources().await?;
        let changed = resources
            .turn_table
            .cleanup(params.floor_version)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "describeTurnTable")]
    pub async fn describe_turn_table(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.turn_table.describe().await)
    }

    #[napi(js_name = "sessionGetSnapshot")]
    pub async fn session_get_snapshot(&self, snapshot_id: String) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let memory_id = parse_memory_id(&snapshot_id, MemoryLayer::Session)?;
        into_napi_value(resources.session_table.get(memory_id.memory_point()).await)
    }

    #[napi(js_name = "sessionListSnapshots")]
    pub async fn session_list_snapshots(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionListSnapshotsParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .session_table
                .list(params.extractor.as_deref())
                .await,
        )
    }

    #[napi(js_name = "sessionListSnapshotsWithVersion")]
    pub async fn session_list_snapshots_with_version(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionListSnapshotsParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .session_table
                .list_with_version(params.observer.as_deref())
                .await,
        )
    }

    #[napi(js_name = "sessionSnapshots")]
    pub async fn session_snapshots(&self, session_id: String) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .session_table
                .load_thread_snapshots(&session_id)
                .await,
        )
    }

    #[napi(js_name = "sessionDelta")]
    pub async fn session_delta(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TableDeltaParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .session_table
                .delta(&params.extractor, params.baseline_version)
                .await,
        )
    }

    #[napi(js_name = "sessionInsert")]
    pub async fn session_insert(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionInsertParams>(params)?;
        let resources = self.resources().await?;
        let mut snapshots = params.snapshots;
        resources
            .session_table
            .insert(&mut snapshots)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(snapshots)
    }

    #[napi(js_name = "sessionTableStats")]
    pub async fn session_table_stats(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.session_table.stats().await)
    }

    #[napi(js_name = "sessionCompact")]
    pub async fn session_compact(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let changed = resources
            .session_table
            .compact()
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "sessionCleanup")]
    pub async fn session_cleanup(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<CleanupParams>(params)?;
        let resources = self.resources().await?;
        let changed = resources
            .session_table
            .cleanup(params.floor_version)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "describeSessionTable")]
    pub async fn describe_session_table(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.session_table.describe().await)
    }

    #[napi(js_name = "dreamingGet")]
    pub async fn dreaming_get(&self, dreaming_id: String) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let memory_id = parse_memory_id(&dreaming_id, MemoryLayer::Dreaming)?;
        into_napi_value(resources.dreaming_table.get(memory_id.memory_point()).await)
    }

    #[napi(js_name = "dreamingList")]
    pub async fn dreaming_list(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.dreaming_table.list().await)
    }

    #[napi(js_name = "dreamingDelta")]
    pub async fn dreaming_delta(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ExtractionDeltaParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .dreaming_table
                .delta(params.baseline_version)
                .await,
        )
    }

    #[napi(js_name = "dreamingAppend")]
    pub async fn dreaming_append(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<DreamingAppendParams>(params)?;
        let resources = self.resources().await?;
        let mut row = params.row;
        resources
            .dreaming_table
            .append(&mut row)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(row)
    }

    #[napi(js_name = "dreamingTableStats")]
    pub async fn dreaming_table_stats(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.dreaming_table.stats().await)
    }

    #[napi(js_name = "describeDreamingTable")]
    pub async fn describe_dreaming_table(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.dreaming_table.describe().await)
    }

    #[napi(js_name = "extractionNearest")]
    pub async fn extraction_nearest(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ExtractionNearestParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .extraction_table
                .nearest(&params.vector, params.limit)
                .await,
        )
    }

    #[napi(js_name = "extractionSearch")]
    pub async fn extraction_search(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ExtractionSearchParams>(params)?;
        let resources = self.resources().await?;
        let mode = parse_recall_mode(&params.mode)?;
        into_napi_value(
            resources
                .extraction_table
                .search(&params.query, &params.vector, params.limit, mode)
                .await,
        )
    }

    #[napi(js_name = "extractionGet")]
    pub async fn extraction_get(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ExtractionGetParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(resources.extraction_table.get(&params.ids).await)
    }

    #[napi(js_name = "extractionList")]
    pub async fn extraction_list(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ExtractionListParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(resources.extraction_table.list(params.limit).await)
    }

    #[napi(js_name = "extractionDelta")]
    pub async fn extraction_delta(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ExtractionDeltaParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .extraction_table
                .delta(params.baseline_version)
                .await,
        )
    }

    #[napi(js_name = "extractionUpsert")]
    pub async fn extraction_upsert(&self, params: Value) -> NapiResult<()> {
        let params = parse_params::<ExtractionUpsertParams>(params)?;
        let resources = self.resources().await?;
        resources
            .extraction_table
            .upsert(params.rows)
            .await
            .map_err(to_napi_error)
    }

    #[napi(js_name = "extractionDelete")]
    pub async fn extraction_delete(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ExtractionDeleteParams>(params)?;
        let resources = self.resources().await?;
        let deleted = resources
            .extraction_table
            .delete(params.ids)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(DeletedCount { deleted })
    }

    #[napi(js_name = "extractionValidateDimensions")]
    pub async fn extraction_validate_dimensions(&self, params: Value) -> NapiResult<()> {
        let params = parse_params::<ExpectedDimensionsParams>(params)?;
        let resources = self.resources().await?;
        resources
            .extraction_table
            .validate_dimensions(params.expected)
            .await
            .map_err(to_napi_error)
    }

    #[napi(js_name = "extractionTableStats")]
    pub async fn extraction_table_stats(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.extraction_table.stats().await)
    }

    #[napi(js_name = "extractionEnsureVectorIndex")]
    pub async fn extraction_ensure_vector_index(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TargetPartitionSizeParams>(params)?;
        let resources = self.resources().await?;
        let created = resources
            .extraction_table
            .ensure_vector_index(params.target_partition_size)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(CreatedResult { created })
    }

    #[napi(js_name = "extractionCompact")]
    pub async fn extraction_compact(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let changed = resources
            .extraction_table
            .compact()
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "extractionCleanup")]
    pub async fn extraction_cleanup(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<CleanupParams>(params)?;
        let resources = self.resources().await?;
        let changed = resources
            .extraction_table
            .cleanup(params.floor_version)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "extractionOptimize")]
    pub async fn extraction_optimize(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<OptimizeParams>(params)?;
        let resources = self.resources().await?;
        let changed = resources
            .extraction_table
            .optimize(params.merge_count)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "describeExtractionTable")]
    pub async fn describe_extraction_table(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.extraction_table.describe().await)
    }

}

#[napi(js_name = "createCoreBinding")]
pub fn create_core_binding(params: Option<Value>) -> NapiResult<CoreBinding> {
    let table_options = params
        .map(parse_params::<Option<StorageTargetParams>>)
        .transpose()?
        .flatten()
        .map(|params| TableOptions::from_uri(params.uri, params.storage_options))
        .transpose()
        .map_err(to_napi_error)?;
    let table_options = match table_options {
        Some(table_options) => table_options,
        None => TableOptions::load().map_err(to_napi_error)?,
    };
    let turn_table = TurnTable::new(table_options.clone());
    let session_table = SessionTable::new(table_options.clone());
    let dreaming_table = DreamingTable::new(table_options.clone());
    let extraction_table = ExtractionTable::new(table_options);
    Ok(CoreBinding {
        inner: Arc::new(CoreState {
            resources: Mutex::new(Some(CoreResources {
                dreaming_table,
                turn_table,
                session_table,
                extraction_table,
            })),
        }),
    })
}

#[napi(js_name = "describeExtractionForStorage")]
pub async fn describe_extraction_for_storage(params: Value) -> NapiResult<Value> {
    let table_options = parse_params::<Option<StorageTargetParams>>(params)?
        .map(|params| TableOptions::from_uri(params.uri, params.storage_options))
        .transpose()
        .map_err(to_napi_error)?;
    let table_options = match table_options {
        Some(table_options) => table_options,
        None => TableOptions::local_read_only(data_root().map_err(to_napi_error)?)
            .map_err(to_napi_error)?,
    };
    into_napi_value(ExtractionTable::new(table_options).describe().await)
}

impl CoreBinding {
    async fn resources(&self) -> NapiResult<CoreResources> {
        let guard = self.inner.resources.lock().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::from_reason("native core binding is closed"))
    }
}

fn parse_memory_id(raw: &str, expected_layer: MemoryLayer) -> NapiResult<MemoryId> {
    let memory_id = MemoryId::from_str(raw)
        .map_err(|error| Error::from_reason(format!("invalid params: {error}")))?;
    if memory_id.memory_layer() != expected_layer {
        return Err(Error::from_reason(format!(
            "invalid params: expected {} memory id, got {}",
            match expected_layer {
                MemoryLayer::Turn => "turn",
                MemoryLayer::Session => "session",
                MemoryLayer::Dreaming => "dreaming",
            },
            memory_id.memory_layer()
        )));
    }
    Ok(memory_id)
}

fn parse_recall_mode(raw: &str) -> NapiResult<RecallMode> {
    match raw {
        "vector" => Ok(RecallMode::Vector),
        "fts" => Ok(RecallMode::Fts),
        "hybrid" => Ok(RecallMode::Hybrid),
        other => Err(Error::from_reason(format!(
            "invalid params: unsupported recall mode {other}"
        ))),
    }
}

fn to_napi_error(error: impl ToString) -> Error {
    Error::from_reason(error.to_string())
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> NapiResult<T> {
    serde_json::from_value(params).map_err(to_napi_error)
}

fn into_napi_value<T: Serialize, E: ToString>(result: Result<T, E>) -> NapiResult<Value> {
    to_napi_value(result.map_err(to_napi_error)?)
}

fn to_napi_value<T: Serialize>(value: T) -> NapiResult<Value> {
    serde_json::to_value(value).map_err(to_napi_error)
}
