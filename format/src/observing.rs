use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
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
use crate::maintenance::{cleanup_dataset, compact_dataset};

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
pub struct ObservingTable {
    access: TableAccess,
}

impl ObservingTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("observing").expect("valid observing table path"),
            ),
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

    pub async fn cleanup(&self, floor_version: u64) -> Result<bool> {
        cleanup_dataset(self.access.try_open().await?, floor_version).await
    }

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        // describe() only reports facts from an opened table; it does not promise
        // full observing-schema validation beyond what opening the dataset already enforces.
        Ok(Some(describe_dataset(&dataset)))
    }

    pub async fn list(&self, observer: Option<&str>) -> Result<Vec<ObservingSnapshot>> {
        let mut observings = self.load_all().await?;
        if let Some(observer) = observer {
            observings.retain(|observing| observing.observer == observer);
        }
        Ok(observings)
    }

    pub async fn get(&self, row_id: u64) -> Result<Option<ObservingSnapshot>> {
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

    pub async fn insert(&self, observings: &mut [ObservingSnapshot]) -> Result<()> {
        if observings.is_empty() {
            return Ok(());
        }
        if observings
            .iter()
            .any(|observing| observing.snapshot_id.memory_point() != u64::MAX)
        {
            return Err(Error::invalid_input(
                "observing insert requires pending snapshot ids",
            ));
        }
        let new_indexes = (0..observings.len()).collect::<Vec<_>>();
        if let Some(mut dataset) = self.access.try_open().await? {
            let before_version = dataset.version().version;
            dataset
                .append(
                    observings_to_reader(observings.to_vec()),
                    self.access.options().write_params(),
                )
                .await?;
            assign_inserted_snapshot_ids_from_delta(&dataset, before_version, observings, &new_indexes)
                .await?;
        } else {
            let dataset = self
                .access
                .write(observings_to_reader(observings.to_vec()))
                .await?;
            assign_inserted_snapshot_ids_from_scan(&dataset, observings).await?;
        }
        Ok(())
    }

    pub async fn update(&self, observings: &[ObservingSnapshot]) -> Result<()> {
        let _ = observings;
        Err(Error::invalid_input(
            "observing update is no longer supported",
        ))
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

    pub async fn load_thread_snapshots(
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

    pub async fn delta(
        &self,
        observer: &str,
        baseline_version: u64,
    ) -> Result<Vec<ObservingSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let version = dataset.version().version;
        if version <= baseline_version {
            return Ok(Vec::new());
        }
        let delta = dataset
            .delta()
            .compared_against_version(baseline_version)
            .build()?;
        let mut inserted = delta.get_inserted_rows().await?;
        let mut rows = Vec::new();
        while let Some(batch) = inserted.try_next().await? {
            if batch.num_rows() == 0 {
                continue;
            }
            rows.extend(
                record_batch_to_observings(&batch)?
                    .into_iter()
                    .filter(|row| row.observer == observer),
            );
        }
        rows.sort_by(|left, right| {
            left.snapshot_sequence
                .cmp(&right.snapshot_sequence)
                .then(left.created_at.cmp(&right.created_at))
                .then(left.updated_at.cmp(&right.updated_at))
                .then(left.snapshot_id.cmp(&right.snapshot_id))
        });
        Ok(rows)
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

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{ObservingSnapshot, ObservingTable};
    use crate::{MemoryId, MemoryLayer, TableOptions};

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
        };

        assert_eq!(observing.memory_id().unwrap().to_string(), "observing:42");
    }

    #[tokio::test]
    async fn insert_assigns_snapshot_id_and_update_rejects_pending_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let table = ObservingTable::new(TableOptions::local(dir.path()).unwrap());
        let mut pending = vec![ObservingSnapshot {
            snapshot_id: MemoryId::new(MemoryLayer::Observing, u64::MAX),
            observing_id: "OBS-LINE".to_string(),
            snapshot_sequence: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            observer: "observer-a".to_string(),
            title: "Observing Title".to_string(),
            summary: "Observing summary".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["session:7".to_string()],
        }];

        table.insert(&mut pending).await.unwrap();
        assert_ne!(pending[0].snapshot_id.memory_point(), u64::MAX);

        let err = table
            .update(&[ObservingSnapshot {
                snapshot_id: MemoryId::new(MemoryLayer::Observing, u64::MAX),
                observing_id: "OBS-LINE".to_string(),
                snapshot_sequence: 1,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                observer: "observer-a".to_string(),
                title: "Observing Title".to_string(),
                summary: "Observing summary".to_string(),
                content: "{\"memories\":[]}".to_string(),
                references: vec!["session:7".to_string()],
            }])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("observing update is no longer supported"));
    }
}
