use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, describe_dataset,
};
use super::codec::{
    dreamings_to_reader, record_batch_to_dreamings, record_batch_to_dreamings_with_row_ids,
};
use super::memory_id::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};
use super::session::SourceRows;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dreaming {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub dreaming_id: MemoryId,
    pub project: String,
    pub parent_id: Option<u64>,
    pub created_at: DateTime<Utc>,
    pub session_snapshot_version: u64,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct DreamingTable {
    access: TableAccess,
}

impl DreamingTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("dreaming").expect("valid dreaming table path"),
            ),
        }
    }

    pub async fn try_open_dataset(&self) -> Result<Option<LanceDataset>> {
        self.access.try_open().await
    }

    pub async fn stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
    }

    pub async fn describe(&self) -> Result<Option<TableDescription>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        Ok(Some(describe_dataset(&dataset)))
    }

    pub async fn list(&self) -> Result<Vec<Dreaming>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().with_row_id().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let mut rows = record_batch_to_dreamings(&batch)?;
        rows.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then(left.dreaming_id.cmp(&right.dreaming_id))
        });
        Ok(rows)
    }

    pub async fn get(&self, row_id: u64) -> Result<Option<Dreaming>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        let batch = dataset
            .take_rows(&[row_id], dataset.schema().clone())
            .await?;
        if batch.num_rows() == 0 {
            return Ok(None);
        }
        Ok(record_batch_to_dreamings_with_row_ids(&batch, &[row_id])?
            .into_iter()
            .next())
    }

    pub async fn append(&self, row: &mut Dreaming) -> Result<()> {
        if row.dreaming_id.memory_layer() != MemoryLayer::Dreaming
            || row.dreaming_id.memory_point() != u64::MAX
        {
            return Err(Error::invalid_input(
                "dreaming append requires a pending dreaming id",
            ));
        }
        if let Some(mut dataset) = self.access.try_open().await? {
            let before_version = dataset.version().version;
            dataset
                .append(
                    dreamings_to_reader(vec![row.clone()]),
                    self.access.options().write_params(),
                )
                .await?;
            assign_appended_dreaming_id_from_delta(&dataset, before_version, row).await?;
        } else {
            let dataset = self
                .access
                .write(dreamings_to_reader(vec![row.clone()]))
                .await?;
            assign_appended_dreaming_id_from_scan(&dataset, row).await?;
        }
        Ok(())
    }

    pub async fn delta(&self, baseline_version: u64) -> Result<SourceRows<Dreaming>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(SourceRows {
                source_version: 0,
                rows: Vec::new(),
            });
        };
        let source_version = dataset.version().version;
        if source_version <= baseline_version {
            return Ok(SourceRows {
                source_version,
                rows: Vec::new(),
            });
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
            rows.extend(record_batch_to_dreamings(&batch)?);
        }
        rows.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then(left.dreaming_id.cmp(&right.dreaming_id))
        });
        Ok(SourceRows {
            source_version,
            rows,
        })
    }
}

async fn assign_appended_dreaming_id_from_delta(
    dataset: &LanceDataset,
    before_version: u64,
    row: &mut Dreaming,
) -> Result<()> {
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
        inserted_rows.extend(record_batch_to_dreamings(&batch)?);
    }
    if inserted_rows.len() != 1 {
        return Err(Error::invalid_input(format!(
            "expected 1 inserted dreaming row, got {}",
            inserted_rows.len()
        )));
    }
    row.dreaming_id = inserted_rows[0].dreaming_id;
    Ok(())
}

async fn assign_appended_dreaming_id_from_scan(
    dataset: &LanceDataset,
    row: &mut Dreaming,
) -> Result<()> {
    let batch = dataset.scan().with_row_id().try_into_batch().await?;
    if batch.num_rows() != 1 {
        return Err(Error::invalid_input(format!(
            "expected 1 inserted dreaming row, got {}",
            batch.num_rows()
        )));
    }
    let inserted_row = record_batch_to_dreamings(&batch)?
        .into_iter()
        .next()
        .ok_or_else(|| Error::invalid_input("expected inserted dreaming row"))?;
    row.dreaming_id = inserted_row.dreaming_id;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use tempfile::tempdir;

    use super::{Dreaming, DreamingTable};
    use crate::{MemoryId, MemoryLayer, TableOptions};

    #[tokio::test]
    async fn append_assigns_dreaming_id_and_roundtrips() {
        let dir = tempdir().unwrap();
        let table = DreamingTable::new(TableOptions::local(dir.path()).unwrap());
        let mut row = Dreaming {
            dreaming_id: MemoryId::new(MemoryLayer::Dreaming, u64::MAX),
            project: "/repo/muninn".to_string(),
            parent_id: None,
            created_at: Utc::now(),
            session_snapshot_version: 5,
            content: "# Project Dream\n\n## Signals\n\n### Guidance\n- [2] Keep schemas minimal.\n\n### Skills\n\n### Open Questions".to_string(),
        };

        table.append(&mut row).await.unwrap();
        assert_ne!(row.dreaming_id.memory_point(), u64::MAX);

        let loaded = table
            .get(row.dreaming_id.memory_point())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.project, "/repo/muninn");
        assert_eq!(loaded.parent_id, None);
        assert_eq!(loaded.session_snapshot_version, 5);
        assert!(loaded.content.contains("Keep schemas minimal"));
    }

    #[tokio::test]
    async fn append_rejects_pending_id_from_wrong_layer() {
        let dir = tempdir().unwrap();
        let table = DreamingTable::new(TableOptions::local(dir.path()).unwrap());
        let mut row = Dreaming {
            dreaming_id: MemoryId::new(MemoryLayer::Turn, u64::MAX),
            project: "/repo/muninn".to_string(),
            parent_id: None,
            created_at: Utc::now(),
            session_snapshot_version: 5,
            content: "# Project Dream".to_string(),
        };

        let error = table.append(&mut row).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("dreaming append requires a pending dreaming id")
        );
    }
}
