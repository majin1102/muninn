use futures_util::TryStreamExt;
use chrono::{DateTime, Utc};
use lance::dataset::UpdateBuilder;
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, delete_by_row_ids,
    describe_dataset,
    escape_predicate_string,
};
use super::codec::{
    observings_to_reader, record_batch_to_observings, record_batch_to_observings_with_row_ids,
};
use super::memory_id::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservingCheckpoint {
    pub observing_epoch: u64,
    pub indexed_snapshot_sequence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObservingSnapshot {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub snapshot_id: MemoryId,
    pub observing_id: String,
    pub snapshot_sequence: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub observer: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub references: Vec<String>,
    pub checkpoint: ObservingCheckpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum MemoryCategory {
    Preference,
    Fact,
    Decision,
    Entity,
    Concept,
    Other,
}

impl MemoryCategory {
    pub fn semantic_index_category(&self) -> &'static str {
        match self {
            Self::Preference => "preference",
            Self::Fact => "fact",
            Self::Decision => "decision",
            Self::Entity => "entity",
            Self::Concept | Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedMemory {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub text: String,
    pub category: MemoryCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_memory: Option<String>,
}

impl ObservingSnapshot {
    pub fn memory_id(&self) -> Result<MemoryId> {
        if self.snapshot_id.memory_layer() != MemoryLayer::Observing {
            return Err(Error::invalid_input(format!(
                "invalid observing memory layer: {}",
                self.snapshot_id.memory_layer()
            )));
        }
        Ok(self.snapshot_id)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ObservingTable {
    access: TableAccess,
}

impl ObservingTable {
    pub(crate) fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("observing").expect("valid observing table path"),
            ),
        }
    }

    pub(crate) async fn try_open_dataset(&self) -> Result<Option<LanceDataset>> {
        self.access.try_open().await
    }

    pub(crate) async fn maintenance_stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
    }

    pub(crate) async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        // describe() only reports facts from an opened table; it does not promise
        // full observing-schema validation beyond what opening the dataset already enforces.
        Ok(Some(describe_dataset(&dataset)))
    }

    pub(crate) async fn list(&self, observer: Option<&str>) -> Result<Vec<ObservingSnapshot>> {
        let mut observings = self.load_all().await?;
        if let Some(observer) = observer {
            observings.retain(|observing| observing.observer == observer);
        }
        Ok(observings)
    }

    pub(crate) async fn get(&self, row_id: u64) -> Result<Option<ObservingSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        let batch = dataset
            .take_rows(&[row_id], dataset.schema().clone())
            .await?;
        if batch.num_rows() == 0 {
            return Ok(None);
        }
        Ok(record_batch_to_observings_with_row_ids(&batch, &[row_id])?
            .into_iter()
            .next())
    }

    #[allow(dead_code)]
    pub(crate) async fn insert(&self, observings: Vec<ObservingSnapshot>) -> Result<()> {
        if observings.is_empty() {
            return Ok(());
        }
        if let Some(mut dataset) = self.access.try_open().await? {
            dataset
                .append(observings_to_reader(observings), None)
                .await?;
        } else {
            self.access.write(observings_to_reader(observings)).await?;
        }
        Ok(())
    }

    pub(crate) async fn upsert(&self, observings: &mut [ObservingSnapshot]) -> Result<()> {
        if observings.is_empty() {
            return Ok(());
        }
        if let Some(dataset) = self.access.try_open().await? {
            let before_version = dataset.version().version;
            let mut existing = Vec::new();
            let mut new = Vec::new();
            let mut new_indexes = Vec::new();
            for (index, observing) in observings.iter().cloned().enumerate() {
                if observing.snapshot_id.memory_point() != u64::MAX {
                    existing.push(observing);
                } else {
                    new.push(observing);
                    new_indexes.push(index);
                }
            }
            let mut dataset = update_observing_rows(dataset, &existing).await?;
            if !new.is_empty() {
                dataset.append(observings_to_reader(new), None).await?;
                assign_inserted_snapshot_ids_from_delta(
                    &dataset,
                    before_version,
                    observings,
                    &new_indexes,
                )
                .await?;
            }
            Ok(())
        } else {
            let dataset = self.access.write(observings_to_reader(observings.to_vec())).await?;
            assign_inserted_snapshot_ids_from_scan(&dataset, observings).await
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn delete(&self, snapshot_ids: Vec<MemoryId>) -> Result<usize> {
        delete_by_row_ids(
            self.access.try_open().await?,
            &snapshot_ids
                .iter()
                .map(|id| id.memory_point())
                .collect::<Vec<_>>(),
        )
        .await
    }

    pub(crate) async fn load_thread_snapshots(
        &self,
        observing_id: &str,
    ) -> Result<Vec<ObservingSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset
            .scan()
            .with_row_id()
            .filter(&format!(
                "observing_id = '{}'",
                escape_predicate_string(observing_id)
            ))?
            .try_into_batch()
            .await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_observings(&batch)
    }

    async fn load_all(&self) -> Result<Vec<ObservingSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().with_row_id().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_observings(&batch)
    }
}

async fn update_observing_rows(
    mut dataset: LanceDataset,
    observings: &[ObservingSnapshot],
) -> Result<LanceDataset> {
    for observing in observings {
        let mut builder = UpdateBuilder::new(std::sync::Arc::new(dataset))
            .update_where(&observing_update_filter(observing))?;
        builder = builder.set("observing_id", &json_string_expr(&observing.observing_id))?;
        builder = builder.set(
            "snapshot_sequence",
            &observing.snapshot_sequence.to_string(),
        )?;
        builder = builder.set(
            "created_at",
            &timestamp_expr(observing.created_at.timestamp_micros()),
        )?;
        builder = builder.set(
            "updated_at",
            &timestamp_expr(observing.updated_at.timestamp_micros()),
        )?;
        builder = builder.set("observer", &json_string_expr(&observing.observer))?;
        builder = builder.set("title", &json_string_expr(&observing.title))?;
        builder = builder.set("summary", &json_string_expr(&observing.summary))?;
        builder = builder.set("content", &json_string_expr(&observing.content))?;
        builder = builder.set("references", &string_list_expr(&observing.references))?;
        builder = builder.set(
            "checkpoint",
            &json_string_expr(&serde_json::to_string(&observing.checkpoint).map_err(
                |error| Error::invalid_input(format!("serialize checkpoint: {error}")),
            )?),
        )?;
        dataset = builder
            .build()?
            .execute()
            .await?
            .new_dataset
            .as_ref()
            .clone();
    }
    Ok(dataset)
}

async fn assign_inserted_snapshot_ids_from_delta(
    dataset: &LanceDataset,
    before_version: u64,
    observings: &mut [ObservingSnapshot],
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
    let mut inserted_rows = Vec::new();
    while let Some(batch) = inserted.try_next().await? {
        if batch.num_rows() == 0 {
            continue;
        }
        inserted_rows.extend(record_batch_to_observings(&batch)?);
    }
    if inserted_rows.len() != new_indexes.len() {
        return Err(Error::invalid_input(format!(
            "expected {} inserted observings, got {}",
            new_indexes.len(),
            inserted_rows.len()
        )));
    }
    for (index, inserted_row) in new_indexes.iter().zip(inserted_rows) {
        observings[*index].snapshot_id = inserted_row.snapshot_id;
    }
    Ok(())
}

async fn assign_inserted_snapshot_ids_from_scan(
    dataset: &LanceDataset,
    observings: &mut [ObservingSnapshot],
) -> Result<()> {
    let batch = dataset.scan().with_row_id().try_into_batch().await?;
    if batch.num_rows() != observings.len() {
        return Err(Error::invalid_input(format!(
            "expected {} inserted observings, got {}",
            observings.len(),
            batch.num_rows()
        )));
    }
    let inserted_rows = record_batch_to_observings(&batch)?;
    for (observing, inserted_row) in observings.iter_mut().zip(inserted_rows) {
        observing.snapshot_id = inserted_row.snapshot_id;
    }
    Ok(())
}

fn json_string_expr(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn observing_update_filter(observing: &ObservingSnapshot) -> String {
    format!(
        "observing_id = {} AND snapshot_sequence = {}",
        json_string_expr(&observing.observing_id),
        observing.snapshot_sequence
    )
}

fn string_list_expr(values: &[String]) -> String {
    serde_json::to_string(values).expect("string list should serialize")
}

fn timestamp_expr(micros: i64) -> String {
    format!("to_timestamp_micros({micros})")
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{ObservingCheckpoint, ObservingSnapshot};
    use crate::format::{MemoryId, MemoryLayer};
    use crate::memory::types::MemoryView;

    #[test]
    fn observing_memory_id_roundtrip() {
        let observing = ObservingSnapshot {
            snapshot_id: MemoryId::new(MemoryLayer::Observing, 42),
            observing_id: "OBS-LINE".to_string(),
            snapshot_sequence: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            observer: "observer-a".to_string(),
            title: "Observing Title".to_string(),
            summary: "Observing summary".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["session:7".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 1,
                indexed_snapshot_sequence: Some(1),
                pending_parent_id: None,
            },
        };

        assert_eq!(observing.memory_id().unwrap().to_string(), "observing:42");
    }

    #[test]
    fn observing_try_into_rendered_memory_prefers_summary() {
        let observing = ObservingSnapshot {
            snapshot_id: MemoryId::new(MemoryLayer::Observing, 42),
            observing_id: "OBS-LINE".to_string(),
            snapshot_sequence: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            observer: "observer-a".to_string(),
            title: "Observing Title".to_string(),
            summary: "Observing summary".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["session:7".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 1,
                indexed_snapshot_sequence: Some(1),
                pending_parent_id: None,
            },
        };

        let rendered = MemoryView::try_from(&observing).unwrap();
        assert_eq!(rendered.memory_id.to_string(), "observing:42");
        assert_eq!(rendered.title.as_deref(), Some("Observing Title"));
        assert_eq!(rendered.summary.as_deref(), Some("Observing summary"));
        assert_eq!(rendered.detail.as_deref(), Some("{\"memories\":[]}"));
    }
}
