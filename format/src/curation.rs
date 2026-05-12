use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, describe_dataset,
    escape_predicate_string,
};
use super::codec::{
    curation_snapshots_to_reader, record_batch_to_curation_snapshots,
};
use super::memory_id::{MemoryId, deserialize_memory_id, serialize_memory_id};
use crate::maintenance::{cleanup_dataset, compact_dataset};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurationSnapshot {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub snapshot_id: MemoryId,
    pub curation_id: String,
    pub snapshot_sequence: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub observer: String,
    pub anchor: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub references: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CurationSnapshotTable {
    access: TableAccess,
}

impl CurationSnapshotTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("curation_snapshot").expect("valid curation snapshot table path"),
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
        self.access.write(curation_snapshots_to_reader(Vec::new())).await
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
        Ok(Some(describe_dataset(&dataset)))
    }

    pub async fn insert(&self, snapshots: &mut [CurationSnapshot]) -> Result<()> {
        if snapshots.is_empty() {
            return Ok(());
        }
        if snapshots
            .iter()
            .any(|snapshot| snapshot.snapshot_id.memory_point() != u64::MAX)
        {
            return Err(Error::invalid_input(
                "curation insert requires pending snapshot ids",
            ));
        }
        let new_indexes = (0..snapshots.len()).collect::<Vec<_>>();
        if let Some(mut dataset) = self.access.try_open().await? {
            let before_version = dataset.version().version;
            dataset
                .append(
                    curation_snapshots_to_reader(snapshots.to_vec()),
                    self.access.options().write_params(),
                )
                .await?;
            assign_inserted_snapshot_ids_from_delta(&dataset, before_version, snapshots, &new_indexes)
                .await?;
        } else {
            let dataset = self
                .access
                .write(curation_snapshots_to_reader(snapshots.to_vec()))
                .await?;
            assign_inserted_snapshot_ids_from_scan(&dataset, snapshots).await?;
        }
        Ok(())
    }

    pub async fn latest(&self, curation_id: &str) -> Result<Option<CurationSnapshot>> {
        let mut rows = self.list(Some(curation_id)).await?;
        rows.sort_by(|left, right| {
            right
                .snapshot_sequence
                .cmp(&left.snapshot_sequence)
                .then(right.updated_at.cmp(&left.updated_at))
                .then(right.snapshot_id.cmp(&left.snapshot_id))
        });
        Ok(rows.into_iter().next())
    }

    pub async fn list(&self, curation_id: Option<&str>) -> Result<Vec<CurationSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let mut scan = dataset.scan();
        scan.with_row_id();
        if let Some(curation_id) = curation_id {
            scan.filter(&format!(
                "curation_id = '{}'",
                escape_predicate_string(curation_id)
            ))?;
        }
        let batch = scan.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let mut rows = record_batch_to_curation_snapshots(&batch)?;
        rows.sort_by(|left, right| {
            left.curation_id
                .cmp(&right.curation_id)
                .then(left.snapshot_sequence.cmp(&right.snapshot_sequence))
                .then(left.created_at.cmp(&right.created_at))
                .then(left.snapshot_id.cmp(&right.snapshot_id))
        });
        Ok(rows)
    }
}

async fn assign_inserted_snapshot_ids_from_delta(
    dataset: &LanceDataset,
    before_version: u64,
    snapshots: &mut [CurationSnapshot],
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
        inserted_rows.extend(record_batch_to_curation_snapshots(&batch)?);
    }
    if inserted_rows.len() != new_indexes.len() {
        return Err(Error::invalid_input(format!(
            "expected {} inserted curation snapshots, got {}",
            new_indexes.len(),
            inserted_rows.len()
        )));
    }
    for (index, inserted_row) in new_indexes.iter().zip(inserted_rows) {
        snapshots[*index].snapshot_id = inserted_row.snapshot_id;
    }
    Ok(())
}

async fn assign_inserted_snapshot_ids_from_scan(
    dataset: &LanceDataset,
    snapshots: &mut [CurationSnapshot],
) -> Result<()> {
    let batch = dataset.scan().with_row_id().try_into_batch().await?;
    if batch.num_rows() != snapshots.len() {
        return Err(Error::invalid_input(format!(
            "expected {} inserted curation snapshots, got {}",
            snapshots.len(),
            batch.num_rows()
        )));
    }
    let inserted_rows = record_batch_to_curation_snapshots(&batch)?;
    for (snapshot, inserted_row) in snapshots.iter_mut().zip(inserted_rows) {
        snapshot.snapshot_id = inserted_row.snapshot_id;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{CurationSnapshot, CurationSnapshotTable};
    use crate::{MemoryId, MemoryLayer, TableOptions};

    #[tokio::test]
    async fn curation_table_appends_snapshots_and_assigns_row_ids() {
        let dir = tempfile::tempdir().unwrap();
        let table = CurationSnapshotTable::new(TableOptions::local(dir.path()).unwrap());
        let now = Utc::now();
        let mut snapshots = vec![CurationSnapshot {
            snapshot_id: MemoryId::new(MemoryLayer::Curation, u64::MAX),
            curation_id: "entity:caroline".to_string(),
            snapshot_sequence: 0,
            created_at: now,
            updated_at: now,
            observer: "default-observer".to_string(),
            anchor: "Caroline".to_string(),
            title: "Entity Memory: Caroline".to_string(),
            summary: "Caroline summary".to_string(),
            content: "# Entity Memory: Caroline".to_string(),
            references: vec!["extraction:a".to_string()],
        }];

        table.insert(&mut snapshots).await.unwrap();
        assert_eq!(snapshots[0].snapshot_id.to_string(), "curation:0");

        let latest = table.latest("entity:caroline").await.unwrap().unwrap();
        assert_eq!(latest.snapshot_id.to_string(), "curation:0");
        assert_eq!(latest.references, vec!["extraction:a"]);
    }
}
