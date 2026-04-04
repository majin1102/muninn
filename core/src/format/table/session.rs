use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow_array::UInt64Array;
use chrono::{Duration, Utc};
use lance::dataset::transaction::{Operation, Transaction, UpdateMode};
use lance::dataset::write::CommitBuilder;
use lance::dataset::{ProjectionRequest, ROW_ID};
use lance::{Error, Result};
use object_store::path::Path;

use super::access::{
    LanceDataset, TableAccess, TableOptions, TableStats, delete_by_row_ids, escape_predicate_string,
};
use super::codec::{
    record_batch_to_turns, record_batch_to_turns_with_row_ids, turns_to_reader,
    turns_to_update_reader,
};
use crate::format::memory::session::SessionTurn;
use crate::format::memory::{MemoryId, MemoryLayer};
use crate::session::{SessionKey, reconcile_open_turns as reconcile_session_open_turns};

#[derive(Debug, Clone)]
pub(crate) enum SessionSelect {
    All,
    ById(u64),
    Filter {
        agent: Option<String>,
        session_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct SessionTable {
    access: TableAccess,
}

impl SessionTable {
    pub(crate) fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(options, Path::parse("turn").expect("valid turn table path")),
        }
    }

    pub(crate) async fn try_open_dataset(&self) -> Result<Option<LanceDataset>> {
        self.access.try_open().await
    }

    pub(crate) async fn maintenance_stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
    }

    pub(crate) async fn select(&self, selector: SessionSelect) -> Result<Vec<SessionTurn>> {
        match selector {
            SessionSelect::All => self.load_all_turns().await,
            SessionSelect::ById(turn_id) => Ok(self.get_turn(turn_id).await?.into_iter().collect()),
            SessionSelect::Filter { agent, session_id } => {
                let turns = self.load_all_turns().await?;
                Ok(filter_turns(turns, agent.as_deref(), session_id.as_deref()))
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn insert(&self, turns: Vec<SessionTurn>) -> Result<()> {
        if turns.is_empty() {
            return Ok(());
        }
        if let Some(mut dataset) = self.access.try_open().await? {
            dataset.append(turns_to_reader(turns), None).await?;
            return Ok(());
        }
        let retry_turns = turns.clone();
        match self.access.write(turns_to_reader(turns)).await {
            Ok(_) => Ok(()),
            Err(Error::DatasetAlreadyExists { .. }) => {
                let mut dataset = self.access.try_open().await?.ok_or_else(|| {
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
        if let Some(mut dataset) = self.access.try_open().await? {
            let (existing, new): (Vec<_>, Vec<_>) = turns
                .into_iter()
                .partition(|turn| turn.turn_id.memory_point() != u64::MAX);
            if !existing.is_empty() {
                dataset = rewrite_turn_rows_by_row_id(dataset, existing).await?;
            }
            if !new.is_empty() {
                dataset.append(turns_to_reader(new), None).await?;
            }
            return Ok(());
        }
        let retry_turns = turns.clone();
        match self.access.write(turns_to_reader(turns)).await {
            Ok(_) => Ok(()),
            Err(Error::DatasetAlreadyExists { .. }) => {
                let mut dataset = self.access.try_open().await?.ok_or_else(|| {
                    Error::io(
                        "turn dataset existed after concurrent create but could not be reopened",
                    )
                })?;
                let (existing, new): (Vec<_>, Vec<_>) = retry_turns
                    .into_iter()
                    .partition(|turn| turn.turn_id.memory_point() != u64::MAX);
                if !existing.is_empty() {
                    dataset = rewrite_turn_rows_by_row_id(dataset, existing).await?;
                }
                if !new.is_empty() {
                    dataset.append(turns_to_reader(new), None).await?;
                }
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn delete(&self, turn_ids: Vec<MemoryId>) -> Result<usize> {
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
    pub(crate) async fn get_turn(&self, turn_id: u64) -> Result<Option<SessionTurn>> {
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

    pub(crate) async fn load_open_turn(&self, session: &SessionKey) -> Result<Option<SessionTurn>> {
        let mut turns = self
            .load_session_turns(session)
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

    pub(crate) async fn load_latest_turn(
        &self,
        session: &SessionKey,
    ) -> Result<Option<SessionTurn>> {
        let mut turns = self.load_session_turns(session).await?;
        turns.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then(right.created_at.cmp(&left.created_at))
                .then(right.turn_id.cmp(&left.turn_id))
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

    pub(crate) async fn load_session_turns(
        &self,
        session: &SessionKey,
    ) -> Result<Vec<SessionTurn>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset
            .scan()
            .with_row_id()
            .filter(&session_key_filter(session))?
            .try_into_batch()
            .await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_turns(&batch)
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

fn session_key_filter(session: &SessionKey) -> String {
    match session {
        SessionKey::Session {
            session_id,
            agent,
            observer,
        } => format!(
            "session_id = '{}' AND agent = '{}' AND observer = '{}'",
            escape_predicate_string(session_id),
            escape_predicate_string(agent),
            escape_predicate_string(observer),
        ),
        SessionKey::Agent { agent, observer } => format!(
            "session_id IS NULL AND agent = '{}' AND observer = '{}'",
            escape_predicate_string(agent),
            escape_predicate_string(observer),
        ),
        SessionKey::Observer { observer } => format!(
            "session_id IS NULL AND agent = '' AND observer = '{}'",
            escape_predicate_string(observer),
        ),
    }
}

async fn rewrite_turn_rows_by_row_id(
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
