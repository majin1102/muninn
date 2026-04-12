use std::collections::HashMap;
#[cfg(test)]
use std::collections::HashSet;
use std::sync::Arc;

use arrow_array::UInt64Array;
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lance::dataset::transaction::{Operation, Transaction, UpdateMode};
use lance::dataset::write::CommitBuilder;
use lance::dataset::{ProjectionRequest, ROW_ID};
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, delete_by_row_ids,
    describe_dataset,
    escape_predicate_string,
};
use super::codec::{
    record_batch_to_turns, record_batch_to_turns_with_row_ids, turns_to_reader,
    turns_to_update_reader,
};
use super::memory_id::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};
use crate::watchdog::compact_dataset;
#[cfg(test)]
use crate::session::SessionUpdate;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurn {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub turn_id: MemoryId,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(rename = "session_id")]
    pub session_id: Option<String>,
    pub agent: String,
    pub observer: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tool_calling: Option<Vec<String>>,
    pub artifacts: Option<HashMap<String, String>>,
    pub prompt: Option<String>,
    pub response: Option<String>,
    pub observing_epoch: Option<u64>,
}

impl SessionTurn {
    #[cfg_attr(not(test), allow(dead_code))]
    #[cfg(test)]
    pub(crate) fn new(write: &SessionUpdate) -> Self {
        Self::new_pending(write)
    }

    #[cfg(test)]
    pub(crate) fn new_pending(write: &SessionUpdate) -> Self {
        let now = Utc::now();
        Self {
            turn_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
            created_at: now,
            updated_at: now,
            session_id: write.session_id.clone(),
            agent: write.agent.clone(),
            observer: write.observer.clone(),
            title: None,
            summary: None,
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn merge(&mut self, update: &SessionUpdate) -> Result<()> {
        if self.session_id != update.session_id
            || self.agent != update.agent
            || self.observer != update.observer
        {
            return Err(Error::invalid_input(
                "message session does not match open turn",
            ));
        }

        if let Some(title) = update.title.as_deref().filter(|value| !value.trim().is_empty()) {
            self.title = Some(title.to_string());
        }
        if let Some(summary) = update.summary.as_deref().filter(|value| !value.trim().is_empty()) {
            self.summary = Some(summary.to_string());
        }
        self.prompt = merge_prompt(self.prompt.as_deref(), update.prompt.as_deref());
        if update
            .response
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            self.response = update.response.clone();
        }
        merge_tool_calling(&mut self.tool_calling, update.tool_calling.as_ref());
        merge_artifacts(&mut self.artifacts, update.artifacts.as_ref());
        self.updated_at = Utc::now();
        Ok(())
    }

    pub fn observable(&self) -> bool {
        has_text_content(self.response.as_deref()) && has_text_content(self.summary.as_deref())
    }

    pub(crate) fn is_open(&self) -> bool {
        !has_text_content(self.response.as_deref())
    }

    pub fn memory_id(&self) -> Result<MemoryId> {
        if self.turn_id.memory_layer() != MemoryLayer::Session {
            return Err(Error::invalid_input(format!(
                "invalid turn memory layer: {}",
                self.turn_id.memory_layer()
            )));
        }
        Ok(self.turn_id)
    }

    pub fn with_row_id(mut self, row_id: u64) -> Self {
        self.turn_id = MemoryId::new(MemoryLayer::Session, row_id);
        self
    }

    pub fn set_row_id(&mut self, row_id: u64) {
        self.turn_id = MemoryId::new(MemoryLayer::Session, row_id);
    }

}

#[derive(Debug, Clone)]
enum SessionQuery {
    ByIdentity {
        session_id: Option<String>,
        agent: String,
        observer: String,
    },
}

impl SessionQuery {
    fn by_identity(session_id: Option<&str>, agent: &str, observer: &str) -> Self {
        Self::ByIdentity {
            session_id: session_id.map(str::to_string),
            agent: agent.to_string(),
            observer: observer.to_string(),
        }
    }

    fn from_turn(turn: &SessionTurn) -> Self {
        Self::by_identity(turn.session_id.as_deref(), &turn.agent, &turn.observer)
    }

    fn matches_turn(&self, turn: &SessionTurn) -> bool {
        match self {
            Self::ByIdentity {
                session_id,
                agent,
                observer,
            } => {
                turn.session_id == *session_id && turn.agent == *agent && turn.observer == *observer
            }
        }
    }
}

#[derive(Debug, Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum SessionSelect {
    ById(u64),
    Filter {
        agent: Option<String>,
        session_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct SessionTable {
    access: TableAccess,
}

impl SessionTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(options, Path::parse("turn").expect("valid turn table path")),
        }
    }

    pub async fn try_open_dataset(&self) -> Result<Option<LanceDataset>> {
        self.access.try_open().await
    }

    pub async fn stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
    }

    pub async fn compact(&self) -> Result<bool> {
        compact_dataset(self.access.try_open().await?).await
    }

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        // describe() only reports facts from an opened table; it does not promise
        // full turn-schema validation beyond what opening the dataset already enforces.
        Ok(Some(describe_dataset(&dataset)))
    }

    pub(crate) async fn select(&self, selector: SessionSelect) -> Result<Vec<SessionTurn>> {
        match selector {
            SessionSelect::ById(turn_id) => Ok(self.get_turn(turn_id).await?.into_iter().collect()),
            SessionSelect::Filter { agent, session_id } => {
                let turns = self.load_all_turns().await?;
                Ok(filter_turns(turns, agent.as_deref(), session_id.as_deref()))
            }
        }
    }

    pub async fn insert(&self, turns: &mut [SessionTurn]) -> Result<()> {
        if turns.is_empty() {
            return Ok(());
        }
        if turns
            .iter()
            .any(|turn| turn.turn_id.memory_point() != u64::MAX)
        {
            return Err(Error::invalid_input(
                "session insert requires pending turn ids",
            ));
        }
        let new_indexes = (0..turns.len()).collect::<Vec<_>>();
        if let Some(mut dataset) = self.access.try_open().await? {
            let before_version = dataset.version().version;
            dataset.append(turns_to_reader(turns.to_vec()), None).await?;
            return self
                .assign_inserted_ids_from_delta(&dataset, before_version, turns, &new_indexes)
                .await;
        }
        let retry_turns = turns.to_vec();
        match self.access.write(turns_to_reader(retry_turns.clone())).await {
            Ok(dataset) => self.assign_inserted_ids_from_scan(&dataset, turns).await,
            Err(Error::DatasetAlreadyExists { .. }) => {
                let mut dataset = self.access.try_open().await?.ok_or_else(|| {
                    Error::io(
                        "turn dataset existed after concurrent create but could not be reopened",
                    )
                })?;
                let before_version = dataset.version().version;
                dataset.append(turns_to_reader(retry_turns), None).await?;
                self.assign_inserted_ids_from_delta(&dataset, before_version, turns, &new_indexes)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    pub async fn update(&self, turns: &[SessionTurn]) -> Result<()> {
        if turns.is_empty() {
            return Ok(());
        }
        if turns.iter().any(|turn| turn.turn_id.memory_point() == u64::MAX) {
            return Err(Error::invalid_input(
                "session update requires persisted turn ids",
            ));
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Err(Error::invalid_input(
                "cannot update session rows before dataset exists",
            ));
        };
        self.update_existing(dataset, turns.to_vec()).await?;
        Ok(())
    }

    pub async fn delete(&self, turn_ids: Vec<MemoryId>) -> Result<usize> {
        delete_by_row_ids(
            self.access.try_open().await?,
            &turn_ids
                .iter()
                .map(|id| id.memory_point())
                .collect::<Vec<_>>(),
        )
        .await
    }

    #[allow(dead_code)]
    pub async fn get_turn(&self, turn_id: u64) -> Result<Option<SessionTurn>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        let batch = dataset
            .take_rows(&[turn_id], dataset.schema().clone())
            .await?;
        Ok(record_batch_to_turns_with_row_ids(&batch, &[turn_id])?
            .into_iter()
            .next())
    }

    #[allow(dead_code)]
    pub(crate) async fn get_turns(&self, turn_ids: &[u64]) -> Result<Vec<SessionTurn>> {
        if turn_ids.is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset
            .take_rows(turn_ids, dataset.schema().clone())
            .await?;
        record_batch_to_turns_with_row_ids(&batch, turn_ids)
    }

    async fn load_open_turn(&self, query: &SessionQuery) -> Result<Option<SessionTurn>> {
        let mut turns = self
            .load_session_turns(query)
            .await?
            .into_iter()
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

    pub async fn load_open_turn_for(
        &self,
        session_id: Option<&str>,
        agent: &str,
        observer: &str,
    ) -> Result<Option<SessionTurn>> {
        self.load_open_turn(&SessionQuery::by_identity(session_id, agent, observer))
            .await
    }

    #[cfg(test)]
    pub(crate) async fn load_latest_turn_for(
        &self,
        session_id: Option<&str>,
        agent: &str,
        observer: &str,
    ) -> Result<Option<SessionTurn>> {
        let query = SessionQuery::by_identity(session_id, agent, observer);
        self.load_latest_turn(&query).await
    }

    #[cfg(test)]
    async fn load_latest_turn(&self, query: &SessionQuery) -> Result<Option<SessionTurn>> {
        let mut turns = self.load_session_turns(query).await?;
        turns.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then(right.created_at.cmp(&left.created_at))
                .then(right.turn_id.cmp(&left.turn_id))
        });
        Ok(turns.into_iter().next())
    }

    async fn load_session_turns(&self, query: &SessionQuery) -> Result<Vec<SessionTurn>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset
            .scan()
            .with_row_id()
            .filter(&session_query_filter(query))?
            .try_into_batch()
            .await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_turns(&batch)
    }

    pub async fn turns_after_epoch(
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

    #[cfg(test)]
    pub(crate) async fn turns_for_observing_epochs(
        &self,
        observer: &str,
        epochs: &HashSet<u64>,
    ) -> Result<Vec<SessionTurn>> {
        if epochs.is_empty() {
            return Ok(Vec::new());
        }

        let mut turns = self
            .load_all_turns()
            .await?
            .into_iter()
            .filter(|turn| turn.observer == observer)
            .filter(|turn| turn.observable())
            .filter(|turn| {
                turn.observing_epoch
                    .is_some_and(|epoch| epochs.contains(&epoch))
            })
            .collect::<Vec<_>>();
        turns.sort_by(|left, right| {
            left.observing_epoch
                .cmp(&right.observing_epoch)
                .then(left.created_at.cmp(&right.created_at))
                .then(left.updated_at.cmp(&right.updated_at))
                .then(left.turn_id.cmp(&right.turn_id))
        });
        Ok(turns)
    }

    async fn load_all_turns(&self) -> Result<Vec<SessionTurn>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().with_row_id().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_turns(&batch)
    }

    async fn update_existing(
        &self,
        dataset: LanceDataset,
        turns: Vec<SessionTurn>,
    ) -> Result<LanceDataset> {
        let row_ids = turns
            .iter()
            .map(|turn| turn.turn_id.memory_point())
            .collect::<Vec<_>>();
        let row_addresses = dataset
            .take_rows(
                &row_ids,
                ProjectionRequest::from_sql([("rowaddr", "_rowaddr")]),
            )
            .await?;
        let rowaddr = row_addresses
            .column_by_name("rowaddr")
            .ok_or_else(|| Error::invalid_input("record batch missing projected rowaddr column"))?
            .as_any()
            .downcast_ref::<UInt64Array>()
            .ok_or_else(|| Error::invalid_input("projected rowaddr column must be UInt64"))?;
        if rowaddr.len() != turns.len() {
            return Err(Error::invalid_input(format!(
                "expected {} row addresses, got {}",
                turns.len(),
                rowaddr.len()
            )));
        }

        let mut turns_by_fragment = HashMap::<u64, Vec<SessionTurn>>::new();
        for (turn, rowaddr) in turns.into_iter().zip(rowaddr.values().iter().copied()) {
            turns_by_fragment
                .entry(rowaddr >> 32)
                .or_default()
                .push(turn);
        }

        let mut updated_fragments = Vec::with_capacity(turns_by_fragment.len());
        let mut fields_modified = Vec::new();
        for (fragment_id, fragment_turns) in turns_by_fragment {
            let mut fragment = dataset.get_fragment(fragment_id as usize).ok_or_else(|| {
                Error::invalid_input(format!("fragment {fragment_id} not found for turn update"))
            })?;
            let (updated_fragment, fragment_fields_modified) = fragment
                .update_columns(turns_to_update_reader(fragment_turns), ROW_ID, ROW_ID)
                .await?;
            updated_fragments.push(updated_fragment);
            fields_modified.extend(fragment_fields_modified);
        }
        fields_modified.sort_unstable();
        fields_modified.dedup();

        let transaction = Transaction::new(
            dataset.manifest().version,
            Operation::Update {
                removed_fragment_ids: vec![],
                updated_fragments,
                new_fragments: vec![],
                fields_modified,
                merged_generations: Vec::new(),
                fields_for_preserving_frag_bitmap: vec![],
                update_mode: Some(UpdateMode::RewriteColumns),
                inserted_rows_filter: None,
            },
            None,
        );

        CommitBuilder::new(Arc::new(dataset))
            .execute(transaction)
            .await
    }

    async fn assign_inserted_ids_from_delta(
        &self,
        dataset: &LanceDataset,
        before_version: u64,
        turns: &mut [SessionTurn],
        new_indexes: &[usize],
    ) -> Result<()> {
        if new_indexes.is_empty() {
            return Ok(());
        }
        let delta = dataset
            .delta()
            .compared_against_version(before_version)
            .build()?;
        let mut inserted = delta.get_inserted_rows().await?;
        let mut inserted_turns = Vec::new();
        while let Some(batch) = inserted.try_next().await? {
            if batch.num_rows() == 0 {
                continue;
            }
            inserted_turns.extend(record_batch_to_turns(&batch)?);
        }
        if inserted_turns.len() != new_indexes.len() {
            return Err(Error::invalid_input(format!(
                "expected {} inserted turns, got {}",
                new_indexes.len(),
                inserted_turns.len()
            )));
        }
        for (index, inserted_turn) in new_indexes.iter().zip(inserted_turns) {
            turns[*index].set_row_id(inserted_turn.turn_id.memory_point());
        }
        Ok(())
    }

    async fn assign_inserted_ids_from_scan(
        &self,
        dataset: &LanceDataset,
        turns: &mut [SessionTurn],
    ) -> Result<()> {
        let batch = dataset.scan().with_row_id().try_into_batch().await?;
        if batch.num_rows() != turns.len() {
            return Err(Error::invalid_input(format!(
                "expected {} inserted turns, got {}",
                turns.len(),
                batch.num_rows()
            )));
        }
        let inserted_turns = record_batch_to_turns(&batch)?;
        for (turn, inserted_turn) in turns.iter_mut().zip(inserted_turns) {
            turn.set_row_id(inserted_turn.turn_id.memory_point());
        }
        Ok(())
    }

    pub async fn list_turns(
        &self,
        agent: Option<String>,
        session_id: Option<String>,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<SessionTurn>> {
        let turns = self
            .select(SessionSelect::Filter { agent, session_id })
            .await?;
        Ok(crate::memory::sessions::apply_list_mode(
            turns,
            crate::memory::types::ListMode::Page { offset, limit },
        ))
    }

    pub async fn list_recent_turns(
        &self,
        agent: Option<String>,
        session_id: Option<String>,
        limit: usize,
    ) -> Result<Vec<SessionTurn>> {
        let turns = self
            .select(SessionSelect::Filter { agent, session_id })
            .await?;
        Ok(crate::memory::sessions::apply_list_mode(
            turns,
            crate::memory::types::ListMode::Recency { limit },
        ))
    }

    pub async fn timeline_turns(
        &self,
        memory_id: MemoryId,
        before_limit: usize,
        after_limit: usize,
    ) -> Result<Vec<SessionTurn>> {
        if memory_id.memory_layer() != MemoryLayer::Session {
            return Err(Error::invalid_input(format!(
                "invalid memory layer for session lookup: {}",
                memory_id.memory_layer()
            )));
        }
        let Some(anchor) = self.get_turn(memory_id.memory_point()).await? else {
            return Ok(Vec::new());
        };
        let query = SessionQuery::from_turn(&anchor);
        let turns = self.load_session_turns(&query).await?;
        Ok(timeline_from_source(&turns, memory_id, before_limit, after_limit, &query).unwrap_or_default())
    }
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

fn has_text_content(value: Option<&str>) -> bool {
    value.map(|value| !value.trim().is_empty()).unwrap_or(false)
}

#[cfg(test)]
fn merge_prompt(current: Option<&str>, incoming: Option<&str>) -> Option<String> {
    let current = current.filter(|value| !value.trim().is_empty());
    let incoming = incoming.filter(|value| !value.trim().is_empty());
    match (current, incoming) {
        (Some(current), Some(incoming)) if current == incoming => Some(current.to_string()),
        (Some(current), Some(incoming)) => Some(format!("{current}\n\n{incoming}")),
        (Some(current), None) => Some(current.to_string()),
        (None, Some(incoming)) => Some(incoming.to_string()),
        (None, None) => None,
    }
}

#[cfg(test)]
fn merge_tool_calling(current: &mut Option<Vec<String>>, incoming: Option<&Vec<String>>) {
    let Some(incoming) = incoming else {
        return;
    };
    if incoming.is_empty() {
        return;
    }
    let current_values = current.get_or_insert_with(Vec::new);
    current_values.extend(incoming.iter().cloned());
}

#[cfg(test)]
fn merge_artifacts(
    current: &mut Option<HashMap<String, String>>,
    incoming: Option<&HashMap<String, String>>,
) {
    let Some(incoming) = incoming else {
        return;
    };
    if incoming.is_empty() {
        return;
    }
    let current_values = current.get_or_insert_with(HashMap::new);
    for (key, value) in incoming {
        current_values.insert(key.clone(), value.clone());
    }
}

fn session_query_filter(query: &SessionQuery) -> String {
    match query {
        SessionQuery::ByIdentity {
            session_id: Some(session_id),
            agent,
            observer,
        } => format!(
            "session_id = '{}' AND agent = '{}' AND observer = '{}'",
            escape_predicate_string(session_id),
            escape_predicate_string(agent),
            escape_predicate_string(observer),
        ),
        SessionQuery::ByIdentity {
            session_id: None,
            agent,
            observer,
        } => format!(
            "session_id IS NULL AND agent = '{}' AND observer = '{}'",
            escape_predicate_string(agent),
            escape_predicate_string(observer),
        ),
    }
}

fn timeline_from_source(
    turns: &[SessionTurn],
    memory_id: MemoryId,
    before_limit: usize,
    after_limit: usize,
    query: &SessionQuery,
) -> Option<Vec<SessionTurn>> {
    let mut filtered = turns
        .iter()
        .filter(|turn| query.matches_turn(turn))
        .cloned()
        .collect::<Vec<SessionTurn>>();
    filtered.sort_by(|left, right| left.created_at.cmp(&right.created_at));

    let anchor_index = filtered.iter().position(|turn| turn.turn_id == memory_id)?;
    let start = anchor_index.saturating_sub(before_limit);
    let end = (anchor_index + after_limit + 1).min(filtered.len());
    Some(filtered[start..end].to_vec())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::Arc;

    use super::{SessionQuery, SessionTurn, session_query_filter, timeline_from_source};
    use crate::format::{MemoryId, MemoryLayer, SessionSelect, SessionTable, TableOptions};
    use crate::memory::sessions::{apply_list_mode, get, timeline};
    use crate::memory::types::{ListMode, MemoryView};
    use crate::test_support::{TestService, TurnContent};
    use crate::session::{Session, SessionKey, SessionUpdate};
    use chrono::{TimeZone, Utc};
    use tokio::sync::Barrier;

    fn session_memory_id(row_id: u64) -> MemoryId {
        MemoryId::new(MemoryLayer::Session, row_id)
    }

    fn make_turn(id: u64, created_at: i64, agent: &str, session_id: Option<&str>) -> SessionTurn {
        let timestamp = Utc.timestamp_micros(created_at).single().unwrap();
        SessionTurn {
            turn_id: session_memory_id(id),
            created_at: timestamp,
            updated_at: timestamp,
            session_id: session_id.map(str::to_string),
            agent: agent.to_string(),
            observer: "observer-a".to_string(),
            title: None,
            summary: None,
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        }
    }

    fn session_table(table_options: &TableOptions) -> SessionTable {
        SessionTable::new(table_options.to_owned())
    }

    async fn post(
        table_options: &TableOptions,
        session_id: Option<&str>,
        agent: &str,
        title: Option<&str>,
        summary: Option<&str>,
        tool_calling: Option<Vec<String>>,
        artifacts: Option<HashMap<String, String>>,
        prompt: Option<&str>,
        response: Option<&str>,
    ) -> SessionTurn {
        let muninn = TestService::new(table_options.clone()).await.unwrap();
        let observer = crate::llm::config::effective_observer_name().unwrap();
        muninn
            .accept(TurnContent {
                session_id: session_id.map(str::to_string),
                agent: agent.to_string(),
                title: title.map(str::to_string),
                summary: summary.map(str::to_string),
                tool_calling,
                artifacts,
                prompt: prompt.map(str::to_string),
                response: response.map(str::to_string),
            })
            .await
            .unwrap();
        session_table(table_options)
            .load_latest_turn_for(session_id, agent, &observer)
            .await
            .unwrap()
            .expect("accepted turn should be persisted")
    }

    #[test]
    fn recency_mode_returns_ascending_window() {
        let result = apply_list_mode(
            vec![
                make_turn(1, 1, "agent", None),
                make_turn(2, 3, "agent", None),
                make_turn(3, 2, "agent", None),
            ],
            ListMode::Recency { limit: 2 },
        );
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:3", "session:2"]);
    }

    #[test]
    fn session_query_filter_uses_exact_identity_predicate() {
        assert_eq!(
            session_query_filter(&SessionQuery::by_identity(
                Some("group-a"),
                "agent-a",
                "observer-a",
            )),
            "session_id = 'group-a' AND agent = 'agent-a' AND observer = 'observer-a'"
        );
    }

    #[test]
    fn session_query_filter_uses_is_null_for_missing_session_id() {
        assert_eq!(
            session_query_filter(&SessionQuery::by_identity(None, "agent-a", "observer-a")),
            "session_id IS NULL AND agent = 'agent-a' AND observer = 'observer-a'"
        );
    }

    #[test]
    fn timeline_honors_filters() {
        let turns = [
            make_turn(1, 1, "agent-a", Some("group")),
            make_turn(2, 2, "agent-a", Some("group")),
            make_turn(3, 3, "agent-b", Some("other")),
            make_turn(4, 4, "agent-a", Some("group")),
        ];
        let anchor = turns
            .iter()
            .find(|turn| turn.turn_id == session_memory_id(2))
            .unwrap();
        let result = timeline_from_source(
            &turns,
            session_memory_id(2),
            1,
            1,
            &SessionQuery::from_turn(anchor),
        )
        .unwrap();
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:1", "session:2", "session:4"]);
    }

    #[test]
    fn timeline_orders_chronologically_even_if_source_is_recency_sorted() {
        let turns = [
            make_turn(4, 4, "agent-a", Some("group")),
            make_turn(3, 3, "agent-a", Some("group")),
            make_turn(2, 2, "agent-a", Some("group")),
            make_turn(1, 1, "agent-a", Some("group")),
        ];
        let anchor = turns
            .iter()
            .find(|turn| turn.turn_id == session_memory_id(3))
            .unwrap();
        let result = timeline_from_source(
            &turns,
            session_memory_id(3),
            1,
            1,
            &SessionQuery::from_turn(anchor),
        )
        .unwrap();
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:2", "session:3", "session:4"]);
    }

    #[tokio::test]
    async fn load_open_turn_for_matches_exact_identity() {
        let dir = tempfile::tempdir().unwrap();
        let table = SessionTable::new(TableOptions::local(dir.path()).unwrap());
        let now = Utc::now();
        let mut turns = vec![
            SessionTurn {
                turn_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
                created_at: now,
                updated_at: now,
                session_id: Some("group-a".to_string()),
                agent: "agent-a".to_string(),
                observer: "observer-a".to_string(),
                title: None,
                summary: None,
                tool_calling: None,
                artifacts: None,
                prompt: Some("matched".to_string()),
                response: None,
                observing_epoch: None,
            },
            SessionTurn {
                turn_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
                created_at: now,
                updated_at: now,
                session_id: Some(" group-a ".to_string()),
                agent: "agent-a".to_string(),
                observer: "observer-a".to_string(),
                title: None,
                summary: None,
                tool_calling: None,
                artifacts: None,
                prompt: Some("not-matched".to_string()),
                response: None,
                observing_epoch: None,
            },
        ];

        table.insert(&mut turns).await.unwrap();
        let loaded = table
            .load_open_turn_for(Some("group-a"), "agent-a", "observer-a")
            .await
            .unwrap()
            .expect("expected exact open turn");

        assert_eq!(loaded.prompt.as_deref(), Some("matched"));
    }

    #[test]
    fn session_turn_update_validate_requires_content() {
        let update = SessionUpdate {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: None,
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        };

        assert!(update.validate().is_err());
    }

    #[tokio::test]
    async fn session_apply_seals_completed_turn_without_assigning_observer_epoch() {
        let key = SessionKey::from(Some("group"), "agent", "observer");
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();
        let session = Session::new(key, Arc::new(SessionTable::new(table_options)), None).unwrap();

        let first = session
            .apply(SessionUpdate {
                session_id: Some("group".to_string()),
                agent: "agent".to_string(),
                observer: "observer".to_string(),
                title: None,
                summary: None,
                tool_calling: None,
                artifacts: None,
                prompt: Some("prompt".to_string()),
                response: None,
                observing_epoch: None,
            })
            .await
            .unwrap();
        assert!(first.is_open());
        assert_eq!(session.open_turn().await.unwrap().observing_epoch, None);

        let sealed = session
            .apply(SessionUpdate {
                session_id: Some("group".to_string()),
                agent: "agent".to_string(),
                observer: "observer".to_string(),
                title: None,
                summary: Some("summary".to_string()),
                tool_calling: None,
                artifacts: None,
                prompt: None,
                response: Some("response".to_string()),
                observing_epoch: None,
            })
            .await
            .unwrap();
        assert!(session.open_turn().await.is_none());
        assert_eq!(sealed.observing_epoch, None);
    }

    #[test]
    fn later_summary_updates_replace_previous_value() {
        let mut turn = SessionTurn::new(&SessionUpdate {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: None,
            tool_calling: None,
            artifacts: None,
            prompt: Some("prompt".to_string()),
            response: None,
            observing_epoch: None,
        });

        turn.merge(&SessionUpdate {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: Some("fallback".to_string()),
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        })
        .unwrap();
        assert_eq!(turn.summary.as_deref(), Some("fallback"));

        turn.merge(&SessionUpdate {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: Some("generated".to_string()),
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        })
        .unwrap();
        assert_eq!(turn.summary.as_deref(), Some("generated"));

        turn.merge(&SessionUpdate {
            session_id: Some("group".to_string()),
            agent: "agent".to_string(),
            observer: "observer".to_string(),
            title: None,
            summary: Some("user".to_string()),
            tool_calling: None,
            artifacts: None,
            prompt: None,
            response: None,
            observing_epoch: None,
        })
        .unwrap();
        assert_eq!(turn.summary.as_deref(), Some("user"));
    }

    #[tokio::test]
    async fn summary_input_is_persisted_without_summarizer() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            Some("provided summary"),
            None,
            None,
            Some("prompt body"),
            None,
        )
        .await;

        assert_eq!(turn.summary.as_deref(), Some("provided summary"));
        let persisted = get(&table_options, &turn.memory_id().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.summary.as_deref(), Some("provided summary"));
    }

    #[tokio::test]
    async fn detail_rejects_invalid_memory_layers_and_formats() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            Some("summary"),
            None,
            None,
            Some("prompt"),
            None,
        )
        .await;

        let memory_id = turn.memory_id().unwrap().to_string();
        let found = get(&table_options, &MemoryId::from_str(&memory_id).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.turn_id, turn.turn_id);

        let bad_layer = format!("observing:{}", turn.turn_id.memory_point());
        assert!(
            get(&table_options, &MemoryId::from_str(&bad_layer).unwrap())
                .await
                .is_err()
        );
        assert!(MemoryId::from_str("bad-memory-id").is_err());
    }

    #[tokio::test]
    async fn response_turns_fall_back_to_prompt_and_response_summary_when_short() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        let config_path = home.join(crate::llm::config::CONFIG_FILE_NAME);
        crate::llm::config::write_test_muninn_config(&config_path, Some("mock"), None, None);
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("what happened?"),
            Some("response body"),
        )
        .await;

        assert_eq!(turn.title.as_deref(), Some("what happened"));
        assert_eq!(
            turn.summary.as_deref(),
            Some("what happened?\n\nresponse body")
        );
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn explicit_summary_is_not_overwritten_by_generated_summary() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        let config_path = home.join(crate::llm::config::CONFIG_FILE_NAME);
        crate::llm::config::write_test_muninn_config(&config_path, Some("mock"), None, None);
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            Some("provided summary"),
            None,
            None,
            Some("what happened?"),
            Some("response body"),
        )
        .await;

        assert_eq!(turn.summary.as_deref(), Some("provided summary"));
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn response_turns_persist_without_summarizer_provider() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", dir.path().join("missing-muninn-home"));
        }
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            None,
            Some("response body"),
        )
        .await;

        assert_eq!(turn.summary, None);
        assert_eq!(turn.response.as_deref(), Some("response body"));
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn explicit_titles_are_preserved_on_turns() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();

        let turn = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            Some("custom title"),
            None,
            None,
            None,
            None,
            Some("response body"),
        )
        .await;

        assert_eq!(turn.title.as_deref(), Some("custom title"));
    }

    #[tokio::test]
    async fn consecutive_prompts_append_to_the_same_open_turn() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();

        let first = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            None,
        )
        .await;
        let merged = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            Some(vec!["tool-a".to_string()]),
            Some(HashMap::from([("k".to_string(), "v".to_string())])),
            None,
            None,
        )
        .await;
        let appended = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-b"),
            None,
        )
        .await;

        assert_eq!(first.turn_id, merged.turn_id);
        assert_eq!(first.turn_id, appended.turn_id);
        assert_eq!(merged.prompt.as_deref(), Some("prompt-a"));
        assert_eq!(
            merged.tool_calling.as_deref(),
            Some(&["tool-a".to_string()][..])
        );
        assert_eq!(
            merged
                .artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.get("k"))
                .map(String::as_str),
            Some("v")
        );
        assert_eq!(appended.prompt.as_deref(), Some("prompt-a\n\nprompt-b"));
    }

    #[tokio::test]
    async fn concurrent_writes_for_same_session_key_share_one_open_turn() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();
        let service = TestService::new(table_options.clone()).await.unwrap();
        let barrier = Arc::new(Barrier::new(3));

        let first_service = service.clone();
        let first_barrier = barrier.clone();
        let first = tokio::spawn(async move {
            first_barrier.wait().await;
            first_service
                .accept(TurnContent {
                    session_id: Some("group-a".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-a".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        let second_service = service.clone();
        let second_barrier = barrier.clone();
        let second = tokio::spawn(async move {
            second_barrier.wait().await;
            second_service
                .accept(TurnContent {
                    session_id: Some("group-a".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-b".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        barrier.wait().await;
        first.await.unwrap();
        second.await.unwrap();

        let turns = session_table(&table_options)
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-a".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(turns.len(), 1);
        let persisted = turns.into_iter().next().unwrap();
        assert_ne!(persisted.turn_id.memory_point(), u64::MAX);
        assert!(matches!(
            persisted.prompt.as_deref(),
            Some("prompt-a\n\nprompt-b") | Some("prompt-b\n\nprompt-a")
        ));
        assert!(persisted.response.is_none());
    }

    #[tokio::test]
    async fn concurrent_writes_for_different_session_keys_do_not_share_turns() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();
        let service = TestService::new(table_options.clone()).await.unwrap();
        let barrier = Arc::new(Barrier::new(3));

        let first_service = service.clone();
        let first_barrier = barrier.clone();
        let first = tokio::spawn(async move {
            first_barrier.wait().await;
            first_service
                .accept(TurnContent {
                    session_id: Some("group-a".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-a".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        let second_service = service.clone();
        let second_barrier = barrier.clone();
        let second = tokio::spawn(async move {
            second_barrier.wait().await;
            second_service
                .accept(TurnContent {
                    session_id: Some("group-b".to_string()),
                    agent: "agent-a".to_string(),
                    title: None,
                    summary: None,
                    tool_calling: None,
                    artifacts: None,
                    prompt: Some("prompt-b".to_string()),
                    response: None,
                })
                .await
                .unwrap()
        });

        barrier.wait().await;
        first.await.unwrap();
        second.await.unwrap();

        let group_a_turns = session_table(&table_options)
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-a".to_string()),
            })
            .await
            .unwrap();
        let group_b_turns = session_table(&table_options)
            .select(SessionSelect::Filter {
                agent: Some("agent-a".to_string()),
                session_id: Some("group-b".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(group_a_turns.len(), 1);
        assert_eq!(group_b_turns.len(), 1);
        assert_ne!(group_a_turns[0].turn_id, group_b_turns[0].turn_id);
    }

    #[tokio::test]
    async fn insert_assigns_row_id_and_update_rejects_pending_turns() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();
        let mut pending = vec![SessionTurn::new_pending(&SessionUpdate {
            session_id: Some("group-a".to_string()),
            agent: "agent-a".to_string(),
            observer: "observer-a".to_string(),
            title: None,
            summary: None,
            tool_calling: None,
            artifacts: None,
            prompt: Some("prompt-a".to_string()),
            response: None,
            observing_epoch: None,
        })];

        session_table(&table_options).insert(&mut pending).await.unwrap();
        assert_ne!(pending[0].turn_id.memory_point(), u64::MAX);

        let err = session_table(&table_options)
            .update(&[SessionTurn::new_pending(&SessionUpdate {
                session_id: Some("group-a".to_string()),
                agent: "agent-a".to_string(),
                observer: "observer-a".to_string(),
                title: None,
                summary: None,
                tool_calling: None,
                artifacts: None,
                prompt: Some("prompt-a".to_string()),
                response: None,
                observing_epoch: None,
            })])
            .await
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("session update requires persisted turn ids"));
    }

    #[tokio::test]
    async fn public_timeline_uses_memory_ids_and_returns_empty_for_missing_anchor() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", dir.path().join("missing-muninn-home"));
        }
        let table_options = TableOptions::local(dir.path()).unwrap();

        let a = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            Some("response-a"),
        )
        .await;
        let b = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-b"),
            Some("response-b"),
        )
        .await;
        let _c = post(
            &table_options,
            Some("group-b"),
            "agent-a",
            None,
            Some("c"),
            None,
            None,
            Some("prompt-c"),
            None,
        )
        .await;
        let d = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-d"),
            Some("response-d"),
        )
        .await;

        let timeline_rows = timeline(&table_options, &b.memory_id().unwrap(), 1, 1)
            .await
            .unwrap();
        let ids = timeline_rows
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&a.turn_id.to_string()));
        assert!(ids.contains(&b.turn_id.to_string()));
        assert!(ids.contains(&d.turn_id.to_string()));

        let missing_anchor = MemoryId::new(MemoryLayer::Session, 999_999).to_string();
        let missing = timeline(
            &table_options,
            &MemoryId::from_str(&missing_anchor).unwrap(),
            1,
            1,
        )
        .await
        .unwrap();
        assert!(missing.is_empty());
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[test]
    fn turn_memory_id_roundtrip() {
        let turn = make_turn(42, 100, "agent", None);
        let memory_id = turn.memory_id().unwrap();
        assert_eq!(memory_id.memory_layer(), MemoryLayer::Session);
        assert_eq!(memory_id.to_string(), "session:42");
    }

    #[test]
    fn row_id_requires_memory_layer_prefix() {
        assert!(MemoryId::from_str("legacy-row-id").is_err());
        let session_memory_id = MemoryId::from_str("session:42").unwrap();
        assert_eq!(session_memory_id.memory_layer(), MemoryLayer::Session);
        assert_eq!(session_memory_id.memory_point(), 42);
    }

    #[test]
    fn turn_try_into_rendered_memory_prefers_summary() {
        let mut turn = make_turn(42, 100, "agent", Some("group"));
        turn.title = Some("Turn title".to_string());
        turn.summary = Some("Short summary".to_string());
        turn.prompt = Some("Prompt body".to_string());

        let rendered = MemoryView::try_from(&turn).unwrap();
        assert_eq!(rendered.memory_id.to_string(), "session:42");
        assert_eq!(rendered.title.as_deref(), Some("Turn title"));
        assert_eq!(rendered.summary.as_deref(), Some("Short summary"));
        assert_eq!(rendered.detail.as_deref(), Some("Prompt: Prompt body"));
    }

    #[test]
    fn timeline_with_explicit_session_id_stays_scoped_to_the_full_session_key() {
        let turns = [
            make_turn(1, 1, "agent-a", Some("group-a")),
            make_turn(2, 2, "agent-a", Some("group-a")),
            make_turn(3, 3, "agent-b", Some("group-a")),
            make_turn(4, 4, "agent-a", Some("group-a")),
        ];
        let anchor = turns
            .iter()
            .find(|turn| turn.turn_id == session_memory_id(2))
            .unwrap();
        let result = timeline_from_source(
            &turns,
            session_memory_id(2),
            1,
            1,
            &SessionQuery::from_turn(anchor),
        )
        .unwrap();
        let ids = result
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["session:1", "session:2", "session:4"]);
    }

    #[tokio::test]
    async fn same_explicit_session_with_different_agents_opens_new_turns() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();

        let first = post(
            &table_options,
            Some("group-a"),
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            None,
        )
        .await;
        let second = post(
            &table_options,
            Some("group-a"),
            "agent-b",
            None,
            None,
            Some(vec!["tool-b".to_string()]),
            None,
            None,
            None,
        )
        .await;

        assert_ne!(first.turn_id, second.turn_id);
        assert_eq!(second.agent, "agent-b");
    }

    #[tokio::test]
    async fn missing_session_id_reuses_agent_default_open_turn() {
        let _guard = crate::llm::config::llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let table_options = TableOptions::local(dir.path()).unwrap();

        let first = post(
            &table_options,
            None,
            "agent-a",
            None,
            None,
            None,
            None,
            Some("prompt-a"),
            None,
        )
        .await;
        let merged = post(
            &table_options,
            None,
            "agent-a",
            None,
            Some("default summary"),
            Some(vec!["tool-a".to_string()]),
            None,
            None,
            None,
        )
        .await;

        assert_eq!(first.turn_id, merged.turn_id);
        assert_eq!(
            merged.tool_calling.as_deref(),
            Some(&["tool-a".to_string()][..])
        );
        assert_eq!(merged.summary.as_deref(), Some("default summary"));
    }
}
