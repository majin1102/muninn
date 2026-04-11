use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use muninn_format::{
    MemoryId, MemoryLayer, ObservingSnapshot, ObservingTable, SemanticIndexRow,
    SemanticIndexTable, SessionTable, SessionTurn, TableOptions, data_root,
};
use napi::{Error, Result as NapiResult};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

#[derive(Clone)]
struct CoreResources {
    session_table: SessionTable,
    observing_table: ObservingTable,
    semantic_index_table: SemanticIndexTable,
}

struct CoreState {
    resources: Mutex<Option<CoreResources>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLoadOpenTurnParams {
    session_id: Option<String>,
    agent: String,
    observer: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ListModeInput {
    Recency { limit: usize },
    Page { offset: usize, limit: usize },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListTurnsParams {
    mode: ListModeInput,
    agent: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionTimelineTurnsParams {
    memory_id: String,
    before_limit: Option<usize>,
    after_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLoadTurnsAfterEpochParams {
    observer: String,
    committed_epoch: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionUpsertParams {
    turns: Vec<SessionTurn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDeleteTurnsParams {
    turn_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservingListSnapshotsParams {
    observer: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservingUpsertParams {
    snapshots: Vec<ObservingSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticNearestParams {
    vector: Vec<f32>,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticLoadByIdsParams {
    ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticUpsertParams {
    rows: Vec<SemanticIndexRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticDeleteParams {
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

    #[napi(js_name = "sessionLoadOpenTurn")]
    pub async fn session_load_open_turn(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionLoadOpenTurnParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
            .session_table
            .load_open_turn_for(params.session_id.as_deref(), &params.agent, &params.observer)
            .await,
        )
    }

    #[napi(js_name = "sessionGetTurn")]
    pub async fn session_get_turn(&self, turn_id: String) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let memory_id = parse_memory_id(&turn_id, MemoryLayer::Session)?;
        into_napi_value(resources.session_table.get_turn(memory_id.memory_point()).await)
    }

    #[napi(js_name = "sessionListTurns")]
    pub async fn session_list_turns(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionListTurnsParams>(params)?;
        let resources = self.resources().await?;
        let turns = match params.mode {
            ListModeInput::Recency { limit } => {
                resources
                    .session_table
                    .list_recent_turns(params.agent, params.session_id, limit)
                    .await
            }
            ListModeInput::Page { offset, limit } => {
                resources
                    .session_table
                    .list_turns(params.agent, params.session_id, offset, limit)
                    .await
            }
        };
        into_napi_value(turns)
    }

    #[napi(js_name = "sessionTimelineTurns")]
    pub async fn session_timeline_turns(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionTimelineTurnsParams>(params)?;
        let resources = self.resources().await?;
        let memory_id = parse_memory_id(&params.memory_id, MemoryLayer::Session)?;
        into_napi_value(
            resources
            .session_table
            .timeline_turns(
                memory_id,
                params.before_limit.unwrap_or(3),
                params.after_limit.unwrap_or(3),
            )
            .await,
        )
    }

    #[napi(js_name = "sessionLoadTurnsAfterEpoch")]
    pub async fn session_load_turns_after_epoch(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionLoadTurnsAfterEpochParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .session_table
                .turns_after_epoch(&params.observer, params.committed_epoch)
                .await,
        )
    }

    #[napi(js_name = "sessionInsert")]
    pub async fn session_insert(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionUpsertParams>(params)?;
        let resources = self.resources().await?;
        let mut turns = params.turns;
        resources
            .session_table
            .insert(&mut turns)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(turns)
    }

    #[napi(js_name = "sessionUpdate")]
    pub async fn session_update(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionUpsertParams>(params)?;
        let resources = self.resources().await?;
        let turns = params.turns;
        resources
            .session_table
            .update(&turns)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(turns)
    }

    #[napi(js_name = "sessionDeleteTurns")]
    pub async fn session_delete_turns(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SessionDeleteTurnsParams>(params)?;
        let resources = self.resources().await?;
        let turn_ids = params
            .turn_ids
            .iter()
            .map(|turn_id| parse_memory_id(turn_id, MemoryLayer::Session))
            .collect::<NapiResult<Vec<_>>>()?;
        let deleted = resources
            .session_table
            .delete(turn_ids)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(DeletedCount { deleted })
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

    #[napi(js_name = "describeSessionTable")]
    pub async fn describe_session_table(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.session_table.describe().await)
    }

    #[napi(js_name = "observingGetSnapshot")]
    pub async fn observing_get_snapshot(&self, snapshot_id: String) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let memory_id = parse_memory_id(&snapshot_id, MemoryLayer::Observing)?;
        into_napi_value(resources.observing_table.get(memory_id.memory_point()).await)
    }

    #[napi(js_name = "observingListSnapshots")]
    pub async fn observing_list_snapshots(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ObservingListSnapshotsParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(resources.observing_table.list(params.observer.as_deref()).await)
    }

    #[napi(js_name = "observingThreadSnapshots")]
    pub async fn observing_thread_snapshots(&self, observing_id: String) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.observing_table.load_thread_snapshots(&observing_id).await)
    }

    #[napi(js_name = "observingInsert")]
    pub async fn observing_insert(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ObservingUpsertParams>(params)?;
        let resources = self.resources().await?;
        let mut snapshots = params.snapshots;
        resources
            .observing_table
            .insert(&mut snapshots)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(snapshots)
    }

    #[napi(js_name = "observingUpdate")]
    pub async fn observing_update(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<ObservingUpsertParams>(params)?;
        let resources = self.resources().await?;
        let snapshots = params.snapshots;
        resources
            .observing_table
            .update(&snapshots)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(snapshots)
    }

    #[napi(js_name = "observingTableStats")]
    pub async fn observing_table_stats(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.observing_table.stats().await)
    }

    #[napi(js_name = "observingCompact")]
    pub async fn observing_compact(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let changed = resources
            .observing_table
            .compact()
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "describeObservingTable")]
    pub async fn describe_observing_table(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.observing_table.describe().await)
    }

    #[napi(js_name = "semanticNearest")]
    pub async fn semantic_nearest(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SemanticNearestParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(
            resources
                .semantic_index_table
                .nearest(&params.vector, params.limit)
                .await,
        )
    }

    #[napi(js_name = "semanticLoadByIds")]
    pub async fn semantic_load_by_ids(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SemanticLoadByIdsParams>(params)?;
        let resources = self.resources().await?;
        into_napi_value(resources.semantic_index_table.load_by_ids(&params.ids).await)
    }

    #[napi(js_name = "semanticUpsert")]
    pub async fn semantic_upsert(&self, params: Value) -> NapiResult<()> {
        let params = parse_params::<SemanticUpsertParams>(params)?;
        let resources = self.resources().await?;
        resources
            .semantic_index_table
            .upsert(params.rows)
            .await
            .map_err(to_napi_error)
    }

    #[napi(js_name = "semanticDelete")]
    pub async fn semantic_delete(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<SemanticDeleteParams>(params)?;
        let resources = self.resources().await?;
        let deleted = resources
            .semantic_index_table
            .delete(params.ids)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(DeletedCount { deleted })
    }

    #[napi(js_name = "semanticValidateDimensions")]
    pub async fn semantic_validate_dimensions(&self, params: Value) -> NapiResult<()> {
        let params = parse_params::<ExpectedDimensionsParams>(params)?;
        let resources = self.resources().await?;
        resources
            .semantic_index_table
            .validate_dimensions(params.expected)
            .await
            .map_err(to_napi_error)
    }

    #[napi(js_name = "semanticTableStats")]
    pub async fn semantic_table_stats(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.semantic_index_table.stats().await)
    }

    #[napi(js_name = "semanticEnsureVectorIndex")]
    pub async fn semantic_ensure_vector_index(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<TargetPartitionSizeParams>(params)?;
        let resources = self.resources().await?;
        let created = resources
            .semantic_index_table
            .ensure_vector_index(params.target_partition_size)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(CreatedResult { created })
    }

    #[napi(js_name = "semanticCompact")]
    pub async fn semantic_compact(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        let changed = resources
            .semantic_index_table
            .compact()
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "semanticOptimize")]
    pub async fn semantic_optimize(&self, params: Value) -> NapiResult<Value> {
        let params = parse_params::<OptimizeParams>(params)?;
        let resources = self.resources().await?;
        let changed = resources
            .semantic_index_table
            .optimize(params.merge_count)
            .await
            .map_err(to_napi_error)?;
        to_napi_value(ChangedResult { changed })
    }

    #[napi(js_name = "describeSemanticIndexTable")]
    pub async fn describe_semantic_index_table(&self) -> NapiResult<Value> {
        let resources = self.resources().await?;
        into_napi_value(resources.semantic_index_table.describe().await)
    }
}

#[napi(js_name = "createCoreBinding")]
pub async fn create_core_binding() -> NapiResult<CoreBinding> {
    let table_options = TableOptions::load().map_err(to_napi_error)?;
    Ok(CoreBinding {
        inner: Arc::new(CoreState {
            resources: Mutex::new(Some(CoreResources {
                session_table: SessionTable::new(table_options.clone()),
                observing_table: ObservingTable::new(table_options.clone()),
                semantic_index_table: SemanticIndexTable::new(table_options),
            })),
        }),
    })
}

#[napi(js_name = "describeSemanticIndexForStorage")]
pub async fn describe_semantic_index_for_storage(params: Value) -> NapiResult<Value> {
    let table_options = parse_params::<Option<StorageTargetParams>>(params)?
        .map(|params| TableOptions::from_uri(params.uri, params.storage_options))
        .transpose()
        .map_err(to_napi_error)?;
    let table_options = match table_options {
        Some(table_options) => table_options,
        None => TableOptions::local_read_only(data_root().map_err(to_napi_error)?)
            .map_err(to_napi_error)?,
    };
    into_napi_value(SemanticIndexTable::new(table_options).describe().await)
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
                MemoryLayer::Session => "session",
                MemoryLayer::Observing => "observing",
            },
            memory_id.memory_layer()
        )));
    }
    Ok(memory_id)
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
