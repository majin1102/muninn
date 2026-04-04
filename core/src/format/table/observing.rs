use futures_util::TryStreamExt;
use lance::dataset::UpdateBuilder;
use lance::{Error, Result};
use object_store::path::Path;

use super::access::{
    LanceDataset, TableAccess, TableOptions, TableStats, delete_by_row_ids, escape_predicate_string,
};
use super::codec::{
    observings_to_reader, record_batch_to_observings, record_batch_to_observings_with_row_ids,
};
use crate::format::memory::MemoryId;
use crate::format::memory::observing::ObservingSnapshot;

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

    pub(crate) async fn upsert(&self, observings: Vec<ObservingSnapshot>) -> Result<()> {
        self.upsert_and_load_inserted(observings).await.map(|_| ())
    }

    pub(crate) async fn upsert_and_load_inserted(
        &self,
        observings: Vec<ObservingSnapshot>,
    ) -> Result<Vec<ObservingSnapshot>> {
        if observings.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(dataset) = self.access.try_open().await? {
            let before_version = dataset.version().version;
            let (existing, new): (Vec<_>, Vec<_>) = observings
                .into_iter()
                .partition(|observing| observing.snapshot_id.memory_point() != u64::MAX);
            let mut dataset = update_observing_rows(dataset, &existing).await?;
            if !new.is_empty() {
                dataset.append(observings_to_reader(new), None).await?;
            }
            if dataset.version().version == before_version {
                return Ok(Vec::new());
            }
            let delta = dataset
                .delta()
                .compared_against_version(before_version)
                .build()?;
            let mut inserted = delta.get_inserted_rows().await?;
            let mut rows = Vec::new();
            while let Some(batch) = inserted.try_next().await? {
                if batch.num_rows() == 0 {
                    continue;
                }
                rows.extend(record_batch_to_observings(&batch)?);
            }
            Ok(rows)
        } else {
            let dataset = self.access.write(observings_to_reader(observings)).await?;
            let batch = dataset.scan().with_row_id().try_into_batch().await?;
            if batch.num_rows() == 0 {
                Ok(Vec::new())
            } else {
                record_batch_to_observings(&batch)
            }
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
        builder =
            builder.set(
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
