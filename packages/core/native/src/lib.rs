use std::future::Future;
use std::sync::Arc;

use lance::Result as LanceResult;
use muninn_sidecar::format::{ObservingSnapshot, SemanticIndexRow, SessionTurn};
use muninn_sidecar::muninn::{ListModeInput, Muninn};
use muninn_sidecar::TableOptions;
use napi::{Error, Result as NapiResult};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::runtime::Runtime;

struct CoreState {
    runtime: Runtime,
    muninn: Muninn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLoadOpenTurnParams {
    session_id: Option<String>,
    agent: String,
    observer: String,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletedCount {
    deleted: usize,
}

#[napi]
pub struct CoreBinding {
    inner: Arc<CoreState>,
}

#[napi]
impl CoreBinding {
    #[napi(js_name = "sessionLoadOpenTurn")]
    pub fn session_load_open_turn(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionLoadOpenTurnParams>(params)?;
        self.call(self.inner.muninn.session_load_open_turn(
            params.session_id,
            params.agent,
            params.observer,
        ))
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionGetTurn")]
    pub fn session_get_turn(&self, turn_id: String) -> NapiResult<Value> {
        self.call(self.inner.muninn.session_get_turn(&turn_id))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionListTurns")]
    pub fn session_list_turns(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionListTurnsParams>(params)?;
        self.call(self.inner.muninn.session_list_turns(
            params.mode,
            params.agent,
            params.session_id,
        ))
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionTimelineTurns")]
    pub fn session_timeline_turns(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionTimelineTurnsParams>(params)?;
        self.call(self.inner.muninn.session_timeline_turns(
            &params.memory_id,
            params.before_limit,
            params.after_limit,
        ))
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionLoadTurnsAfterEpoch")]
    pub fn session_load_turns_after_epoch(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionLoadTurnsAfterEpochParams>(params)?;
        self.call(
            self.inner
                .muninn
                .session_load_turns_after_epoch(&params.observer, params.committed_epoch),
        )
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionUpsert")]
    pub fn session_upsert(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionUpsertParams>(params)?;
        self.call(self.inner.muninn.session_upsert(params.turns))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingGetSnapshot")]
    pub fn observing_get_snapshot(
        &self,
        snapshot_id: String,
    ) -> NapiResult<Value> {
        self.call(self.inner.muninn.observing_get_snapshot(&snapshot_id))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingListSnapshots")]
    pub fn observing_list_snapshots(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<ObservingListSnapshotsParams>(params)?;
        self.call(self.inner.muninn.observing_list_snapshots(params.observer.as_deref()))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingThreadSnapshots")]
    pub fn observing_thread_snapshots(
        &self,
        observing_id: String,
    ) -> NapiResult<Value> {
        self.call(self.inner.muninn.observing_thread_snapshots(&observing_id))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingUpsert")]
    pub fn observing_upsert(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<ObservingUpsertParams>(params)?;
        self.call(self.inner.muninn.observing_upsert(params.snapshots))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "semanticNearest")]
    pub fn semantic_nearest(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SemanticNearestParams>(params)?;
        self.call(self.inner.muninn.semantic_nearest(&params.vector, params.limit))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "semanticLoadByIds")]
    pub fn semantic_load_by_ids(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SemanticLoadByIdsParams>(params)?;
        self.call(self.inner.muninn.semantic_load_by_ids(&params.ids))
            .and_then(to_napi_value)
    }

    #[napi(js_name = "semanticUpsert")]
    pub fn semantic_upsert(
        &self,
        params: Value,
    ) -> NapiResult<()> {
        let params = parse_params::<SemanticUpsertParams>(params)?;
        self.call(self.inner.muninn.semantic_upsert(params.rows))
    }

    #[napi(js_name = "semanticDelete")]
    pub fn semantic_delete(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SemanticDeleteParams>(params)?;
        self.call(self.inner.muninn.semantic_delete(params.ids))
            .and_then(|deleted| to_napi_value(DeletedCount { deleted }))
    }

}

impl CoreBinding {
    fn call<T, F>(&self, future: F) -> NapiResult<T>
    where
        F: Future<Output = LanceResult<T>>,
    {
        self.inner.runtime.block_on(future).map_err(to_napi_error)
    }
}

#[napi(js_name = "createCoreBinding")]
pub fn create_core_binding() -> NapiResult<CoreBinding> {
    let table_options = TableOptions::load().map_err(to_napi_error)?;
    let runtime = Runtime::new()
        .map_err(|error| Error::from_reason(error.to_string()))?;
    let muninn = runtime
        .block_on(Muninn::new(table_options))
        .map_err(to_napi_error)?;
    Ok(CoreBinding {
        inner: Arc::new(CoreState { runtime, muninn }),
    })
}

fn to_napi_error(error: impl ToString) -> Error {
    Error::from_reason(error.to_string())
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> NapiResult<T> {
    serde_json::from_value(params).map_err(to_napi_error)
}

fn to_napi_value<T: Serialize>(value: T) -> NapiResult<Value> {
    serde_json::to_value(value).map_err(to_napi_error)
}
