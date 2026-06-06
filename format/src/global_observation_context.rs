use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use lance::dataset::{MergeInsertBuilder, WhenMatched, WhenNotMatched};
use lance::Result;
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, delete_by_ids,
    describe_dataset, escape_predicate_string,
};
use super::codec::{global_observation_contexts_to_reader, record_batch_to_global_observation_contexts};
use crate::maintenance::{
    cleanup_dataset, compact_dataset, ensure_global_observation_context_id_index,
    optimize_global_observation_context,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalObservationContext {
    pub id: String,
    pub global_path: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub content: String,
    pub source_refs: Vec<String>,
    pub expand_refs: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub observer: String,
}

#[derive(Debug, Clone)]
pub struct GlobalObservationContextTable {
    access: TableAccess,
}

impl GlobalObservationContextTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("global_observation_context").expect("valid global observation context table path"),
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
        self.access.write(global_observation_contexts_to_reader(Vec::new())?).await
    }

    pub async fn stats(&self) -> Result<Option<TableStats>> {
        self.access.maintenance_stats().await
    }

    pub async fn compact(&self) -> Result<bool> {
        compact_dataset(self.access.try_open().await?).await
    }

    pub async fn ensure_id_index(&self) -> Result<bool> {
        let Some(mut dataset) = self.access.try_open().await? else {
            return Ok(false);
        };
        ensure_global_observation_context_id_index(&mut dataset).await
    }

    pub async fn optimize(&self, merge_count: usize) -> Result<bool> {
        let Some(mut dataset) = self.access.try_open().await? else {
            return Ok(false);
        };
        optimize_global_observation_context(&mut dataset, merge_count).await
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

    pub async fn list(&self, observer: Option<&str>) -> Result<Vec<GlobalObservationContext>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let mut scan = dataset.scan();
        if let Some(observer) = observer {
            scan.filter(&format!(
                "observer = '{}'",
                escape_predicate_string(observer)
            ))?;
        }
        let batch = scan.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let mut rows = record_batch_to_global_observation_contexts(&batch)?;
        rows.sort_by(|left, right| {
            left.global_path
                .cmp(&right.global_path)
                .then(left.position.cmp(&right.position))
                .then(left.updated_at.cmp(&right.updated_at))
        });
        Ok(rows)
    }

    pub async fn get(&self, ids: &[String]) -> Result<Vec<GlobalObservationContext>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let predicate = if ids.len() == 1 {
            format!("id = '{}'", escape_predicate_string(&ids[0]))
        } else {
            let quoted = ids
                .iter()
                .map(|id| format!("'{}'", escape_predicate_string(id)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("id IN ({quoted})")
        };
        let batch = dataset.scan().filter(&predicate)?.try_into_batch().await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let rows = record_batch_to_global_observation_contexts(&batch)?;
        let mut by_id = rows
            .into_iter()
            .map(|row| (row.id.clone(), row))
            .collect::<HashMap<_, _>>();
        Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
    }

    pub async fn upsert(&self, rows: Vec<GlobalObservationContext>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if let Some(dataset) = self.access.try_open().await? {
            let dataset = Arc::new(dataset);
            let mut builder = MergeInsertBuilder::try_new(dataset, vec!["id".to_string()])?;
            builder
                .skip_auto_cleanup(true)
                .when_matched(WhenMatched::UpdateAll)
                .when_not_matched(WhenNotMatched::InsertAll);
            let job = builder.try_build()?;
            job.execute_reader(global_observation_contexts_to_reader(rows)?).await?;
        } else {
            self.access.write(global_observation_contexts_to_reader(rows)?).await?;
        }
        Ok(())
    }

pub async fn delete(&self, ids: Vec<String>) -> Result<usize> {
        delete_by_ids(self.access.try_open().await?, "id", ids).await
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{GlobalObservationContext, GlobalObservationContextTable};
    use crate::TableOptions;

    #[tokio::test]
    async fn global_observation_context_table_upserts_lists_and_deletes_rows() {
        let dir = tempfile::tempdir().unwrap();
        let table = GlobalObservationContextTable::new(TableOptions::local(dir.path()).unwrap());
        let now = Utc::now();

        table
            .upsert(vec![GlobalObservationContext {
                id: "00000000-0000-4000-8000-000000000001".to_string(),
                global_path: "Caroline / What happened?".to_string(),
                parent_id: None,
                position: 0,
                content: "Caroline attended a support group.".to_string(),
                source_refs: vec!["extraction:1".to_string()],
                expand_refs: vec![],
                created_at: now,
                updated_at: now,
                observer: "default-observer".to_string(),
            }])
            .await
            .unwrap();

        table
            .upsert(vec![GlobalObservationContext {
                id: "00000000-0000-4000-8000-000000000001".to_string(),
                global_path: "Caroline / What happened?".to_string(),
                parent_id: None,
                position: 0,
                content: "Caroline attended an LGBTQ support group.".to_string(),
                source_refs: vec!["extraction:1".to_string(), "extraction:2".to_string()],
                expand_refs: vec!["extraction:2".to_string()],
                created_at: now,
                updated_at: now,
                observer: "default-observer".to_string(),
            }])
            .await
            .unwrap();
        table
            .upsert(vec![GlobalObservationContext {
                id: "00000000-0000-4000-8000-000000000002".to_string(),
                global_path: "Melanie / What happened?".to_string(),
                parent_id: None,
                position: 1,
                content: "Melanie painted a lake sunrise.".to_string(),
                source_refs: vec!["extraction:3".to_string()],
                expand_refs: vec!["extraction:3".to_string()],
                created_at: now,
                updated_at: now,
                observer: "default-observer".to_string(),
            }])
            .await
            .unwrap();

        let rows = table.list(Some("default-observer")).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].content, "Caroline attended an LGBTQ support group.");

        let rows = table
            .get(&[
                "00000000-0000-4000-8000-000000000002".to_string(),
                "missing".to_string(),
                "00000000-0000-4000-8000-000000000001".to_string(),
            ])
            .await
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec![
                "00000000-0000-4000-8000-000000000002",
                "00000000-0000-4000-8000-000000000001",
            ],
        );

        assert_eq!(
            table
                .delete(vec!["00000000-0000-4000-8000-000000000001".to_string()])
                .await
                .unwrap(),
            1,
        );
        assert_eq!(table.list(Some("default-observer")).await.unwrap().len(), 1);
    }
}
