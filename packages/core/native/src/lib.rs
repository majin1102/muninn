use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use lance::Result as LanceResult;
use muninn_sidecar::format::{ObservingSnapshot, SemanticIndexRow, SemanticIndexTable, SessionTurn};
use muninn_sidecar::muninn::{ListModeInput, Muninn};
use muninn_sidecar::{TableOptions, data_root};
use napi::{Error, Result as NapiResult};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

struct CoreState {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageTargetParams {
    uri: String,
    storage_options: Option<HashMap<String, String>>,
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
    pub async fn session_load_open_turn(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionLoadOpenTurnParams>(params)?;
        self.call(self.inner.muninn.session_load_open_turn(
            params.session_id,
            params.agent,
            params.observer,
        ))
        .await
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionGetTurn")]
    pub async fn session_get_turn(&self, turn_id: String) -> NapiResult<Value> {
        self.call(self.inner.muninn.session_get_turn(&turn_id))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionListTurns")]
    pub async fn session_list_turns(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionListTurnsParams>(params)?;
        self.call(self.inner.muninn.session_list_turns(
            params.mode,
            params.agent,
            params.session_id,
        ))
        .await
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionTimelineTurns")]
    pub async fn session_timeline_turns(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionTimelineTurnsParams>(params)?;
        self.call(self.inner.muninn.session_timeline_turns(
            &params.memory_id,
            params.before_limit,
            params.after_limit,
        ))
        .await
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionLoadTurnsAfterEpoch")]
    pub async fn session_load_turns_after_epoch(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionLoadTurnsAfterEpochParams>(params)?;
        self.call(
            self.inner
                .muninn
                .session_load_turns_after_epoch(&params.observer, params.committed_epoch),
        )
        .await
        .and_then(to_napi_value)
    }

    #[napi(js_name = "sessionUpsert")]
    pub async fn session_upsert(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SessionUpsertParams>(params)?;
        self.call(self.inner.muninn.session_upsert(params.turns))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "describeSessionTable")]
    pub async fn describe_session_table(&self) -> NapiResult<Value> {
        self.call(self.inner.muninn.describe_session_table())
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingGetSnapshot")]
    pub async fn observing_get_snapshot(
        &self,
        snapshot_id: String,
    ) -> NapiResult<Value> {
        self.call(self.inner.muninn.observing_get_snapshot(&snapshot_id))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingListSnapshots")]
    pub async fn observing_list_snapshots(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<ObservingListSnapshotsParams>(params)?;
        self.call(self.inner.muninn.observing_list_snapshots(params.observer.as_deref()))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingThreadSnapshots")]
    pub async fn observing_thread_snapshots(
        &self,
        observing_id: String,
    ) -> NapiResult<Value> {
        self.call(self.inner.muninn.observing_thread_snapshots(&observing_id))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "observingUpsert")]
    pub async fn observing_upsert(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<ObservingUpsertParams>(params)?;
        self.call(self.inner.muninn.observing_upsert(params.snapshots))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "describeObservingTable")]
    pub async fn describe_observing_table(&self) -> NapiResult<Value> {
        self.call(self.inner.muninn.describe_observing_table())
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "semanticNearest")]
    pub async fn semantic_nearest(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SemanticNearestParams>(params)?;
        self.call(self.inner.muninn.semantic_nearest(&params.vector, params.limit))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "semanticLoadByIds")]
    pub async fn semantic_load_by_ids(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SemanticLoadByIdsParams>(params)?;
        self.call(self.inner.muninn.semantic_load_by_ids(&params.ids))
            .await
            .and_then(to_napi_value)
    }

    #[napi(js_name = "semanticUpsert")]
    pub async fn semantic_upsert(
        &self,
        params: Value,
    ) -> NapiResult<()> {
        let params = parse_params::<SemanticUpsertParams>(params)?;
        self.call(self.inner.muninn.semantic_upsert(params.rows)).await
    }

    #[napi(js_name = "semanticDelete")]
    pub async fn semantic_delete(
        &self,
        params: Value,
    ) -> NapiResult<Value> {
        let params = parse_params::<SemanticDeleteParams>(params)?;
        self.call(self.inner.muninn.semantic_delete(params.ids))
            .await
            .and_then(|deleted| to_napi_value(DeletedCount { deleted }))
    }

    #[napi(js_name = "describeSemanticIndexTable")]
    pub async fn describe_semantic_index_table(&self) -> NapiResult<Value> {
        self.call(self.inner.muninn.describe_semantic_index_table())
            .await
            .and_then(to_napi_value)
    }

}

impl CoreBinding {
    async fn call<T, F>(&self, future: F) -> NapiResult<T>
    where
        F: Future<Output = LanceResult<T>>,
    {
        future.await.map_err(to_napi_error)
    }
}

#[napi(js_name = "createCoreBinding")]
pub async fn create_core_binding() -> NapiResult<CoreBinding> {
    let table_options = TableOptions::load().map_err(to_napi_error)?;
    let muninn = Muninn::new(table_options).await.map_err(to_napi_error)?;
    Ok(CoreBinding {
        inner: Arc::new(CoreState { muninn }),
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
    SemanticIndexTable::new(table_options)
        .describe()
        .await
        .map_err(to_napi_error)
        .and_then(to_napi_value)
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
