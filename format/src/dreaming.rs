use std::sync::Arc;

use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lance::dataset::UpdateBuilder;
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, delete_by_ids,
    delete_by_row_ids,
    describe_dataset,
};
use super::codec::{
    dreaming_projects_to_reader, dreamings_to_reader, record_batch_to_dreaming_projects,
    record_batch_to_dreamings, record_batch_to_dreamings_with_row_ids,
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub content: String,
    pub support_turns: Vec<DreamingSupportTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DreamingSupportTurn {
    pub turn_id: String,
    pub created_at: DateTime<Utc>,
    pub contribution: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DreamingProject {
    pub project: String,
    pub session_snapshot_version: u64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct DreamingTable {
    access: TableAccess,
}

#[derive(Debug, Clone)]
pub struct DreamingProjectTable {
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

    pub async fn update(&self, row_id: u64, row: &Dreaming) -> Result<()> {
        if row.dreaming_id.memory_layer() != MemoryLayer::Dreaming
            || row.dreaming_id.memory_point() != row_id
        {
            return Err(Error::invalid_input(
                "dreaming update requires a matching dreaming id",
            ));
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Err(Error::invalid_input("dreaming table does not exist"));
        };
        let batch = dataset
            .take_rows(&[row_id], dataset.schema().clone())
            .await?;
        if batch.num_rows() == 0 {
            return Err(Error::invalid_input(format!(
                "dreaming row {row_id} does not exist"
            )));
        }
        let existing = record_batch_to_dreamings_with_row_ids(&batch, &[row_id])?
            .into_iter()
            .next()
            .ok_or_else(|| Error::invalid_input(format!("dreaming row {row_id} does not exist")))?;
        let row_filter = sql_dreaming_identity_filter(&existing);
        let matching_rows = dataset.count_rows(Some(row_filter.clone())).await?;
        if matching_rows != 1 {
            return Err(Error::invalid_input(format!(
                "expected 1 matching dreaming row for {row_id}, got {matching_rows}"
            )));
        }
        let result = UpdateBuilder::new(Arc::new(dataset))
            .update_where(&row_filter)?
            .set("project", &sql_string(&row.project))?
            .set("created_at", &sql_timestamp_micros(row.created_at))?
            .set("updated_at", &sql_timestamp_micros(row.updated_at))?
            .set("content", &sql_string(&row.content))?
            .set("support_turns", &sql_support_turns(&row.support_turns))?
            .build()?
            .execute()
            .await?;
        if result.rows_updated != 1 {
            return Err(Error::invalid_input(format!(
                "expected 1 updated dreaming row for {row_id}, got {}",
                result.rows_updated
            )));
        }
        Ok(())
    }

    pub async fn delete(&self, row_ids: &[u64]) -> Result<usize> {
        delete_by_row_ids(self.access.try_open().await?, row_ids).await
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

impl DreamingProjectTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("dreaming_project").expect("valid dreaming project table path"),
            ),
        }
    }

    pub async fn list(&self) -> Result<Vec<DreamingProject>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset.scan().try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let mut rows = record_batch_to_dreaming_projects(&batch)?;
        rows.sort_by(|left, right| left.project.cmp(&right.project));
        Ok(rows)
    }

    pub async fn get(&self, project: &str) -> Result<Option<DreamingProject>> {
        Ok(self
            .list()
            .await?
            .into_iter()
            .find(|row| row.project == project))
    }

    pub async fn upsert(&self, row: DreamingProject) -> Result<()> {
        let dataset = self.access.try_open().await?;
        let _ = delete_by_ids(dataset, "project", vec![row.project.clone()]).await?;
        if let Some(mut dataset) = self.access.try_open().await? {
            dataset
                .append(
                    dreaming_projects_to_reader(vec![row]),
                    self.access.options().write_params(),
                )
                .await?;
        } else {
            self.access
                .write(dreaming_projects_to_reader(vec![row]))
                .await?;
        }
        Ok(())
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

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sql_timestamp_micros(value: DateTime<Utc>) -> String {
    format!("to_timestamp_micros({})", value.timestamp_micros())
}

fn sql_dreaming_identity_filter(row: &Dreaming) -> String {
    format!(
        "project = {} AND created_at = {} AND updated_at = {} AND content = {}",
        sql_string(&row.project),
        sql_timestamp_micros(row.created_at),
        sql_timestamp_micros(row.updated_at),
        sql_string(&row.content)
    )
}

fn sql_support_turns(values: &[DreamingSupportTurn]) -> String {
    if values.is_empty() {
        return concat!(
            "array_slice(",
            "make_array(named_struct('turn_id', '', 'created_at', to_timestamp_micros(0), 'contribution', 0)),",
            "1, 0)"
        )
        .to_string();
    }
    let entries = values
        .iter()
        .map(|value| {
            format!(
                "named_struct('turn_id', {}, 'created_at', {}, 'contribution', {})",
                sql_string(&value.turn_id),
                sql_timestamp_micros(value.created_at),
                value.contribution
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("make_array({entries})")
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

    use super::{Dreaming, DreamingSupportTurn, DreamingTable};
    use crate::{MemoryId, MemoryLayer, TableOptions};

    #[tokio::test]
    async fn append_assigns_dreaming_id_and_roundtrips() {
        let dir = tempdir().unwrap();
        let table = DreamingTable::new(TableOptions::local(dir.path()).unwrap());
        let mut row = Dreaming {
            dreaming_id: MemoryId::new(MemoryLayer::Dreaming, u64::MAX),
            project: "/repo/muninn".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            content: "## Memory Signal\nPrefer minimal schemas.".to_string(),
            support_turns: vec![DreamingSupportTurn {
                turn_id: "turn:5".to_string(),
                created_at: Utc::now(),
                contribution: 1,
            }],
        };

        table.append(&mut row).await.unwrap();
        assert_ne!(row.dreaming_id.memory_point(), u64::MAX);

        let loaded = table
            .get(row.dreaming_id.memory_point())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.project, "/repo/muninn");
        assert!(loaded.content.contains("Prefer minimal schemas"));
        assert_eq!(loaded.support_turns.len(), 1);
        assert_eq!(loaded.support_turns[0].turn_id, "turn:5");
        assert_eq!(loaded.support_turns[0].contribution, 1);
    }

    #[tokio::test]
    async fn append_rejects_pending_id_from_wrong_layer() {
        let dir = tempdir().unwrap();
        let table = DreamingTable::new(TableOptions::local(dir.path()).unwrap());
        let mut row = Dreaming {
            dreaming_id: MemoryId::new(MemoryLayer::Turn, u64::MAX),
            project: "/repo/muninn".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            content: "## Memory Signal\nPrefer minimal schemas.".to_string(),
            support_turns: Vec::new(),
        };

        let error = table.append(&mut row).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("dreaming append requires a pending dreaming id")
        );
    }

    #[tokio::test]
    async fn update_preserves_dreaming_id_and_support_turns_can_be_cleared() {
        let dir = tempdir().unwrap();
        let table = DreamingTable::new(TableOptions::local(dir.path()).unwrap());
        let mut row = Dreaming {
            dreaming_id: MemoryId::new(MemoryLayer::Dreaming, u64::MAX),
            project: "/repo/muninn".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            content: "## Memory Signal\nPrefer minimal schemas.".to_string(),
            support_turns: vec![DreamingSupportTurn {
                turn_id: "turn:5".to_string(),
                created_at: Utc::now(),
                contribution: 1,
            }],
        };

        table.append(&mut row).await.unwrap();
        let row_id = row.dreaming_id.memory_point();
        row.updated_at = Utc::now();
        row.content = "## Memory Signal\nPrefer focused schemas.".to_string();
        row.support_turns.clear();

        table.update(row_id, &row).await.unwrap();

        let loaded = table.get(row_id).await.unwrap().unwrap();
        assert_eq!(loaded.dreaming_id, row.dreaming_id);
        assert_eq!(loaded.content, "## Memory Signal\nPrefer focused schemas.");
        assert!(loaded.support_turns.is_empty());
    }
}
