use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lance::{Error, Result};
use object_store::path::Path;
use serde::{Deserialize, Serialize};

use super::access::{
    LanceDataset, TableAccess, TableDescription, TableOptions, TableStats, delete_by_row_ids,
    describe_dataset, escape_predicate_string,
};
use super::codec::{
    record_batch_to_session_snapshots, record_batch_to_session_snapshots_with_row_ids,
    session_snapshots_to_reader,
};
use super::memory_id::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};
use crate::maintenance::{cleanup_dataset, compact_dataset};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub snapshot_id: MemoryId,
    pub session_id: String,
    pub project: String,
    pub cwd: String,
    pub agent: String,
    pub snapshot_sequence: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub extractor: String,
    pub title: String,
    pub summary: String,
    pub memory_signals: Vec<String>,
    pub skill_signals: Vec<String>,
    pub skill_details: String,
    pub content: String,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRows<T> {
    pub source_version: u64,
    pub rows: Vec<T>,
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

impl SessionSnapshot {
    pub fn memory_id(&self) -> Result<MemoryId> {
        if self.snapshot_id.memory_layer() != MemoryLayer::Session {
            return Err(Error::invalid_input(format!(
                "invalid session memory layer: {}",
                self.snapshot_id.memory_layer()
            )));
        }
        Ok(self.snapshot_id)
    }
}

#[derive(Debug, Clone)]
pub struct SessionTable {
    access: TableAccess,
}

impl SessionTable {
    pub fn new(options: TableOptions) -> Self {
        Self {
            access: TableAccess::new(
                options,
                Path::parse("session_snapshot").expect("valid session snapshot table path"),
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
        // full session-schema validation beyond what opening the dataset already enforces.
        Ok(Some(describe_dataset(&dataset)))
    }

    pub async fn list_with_version(
        &self,
        extractor: Option<&str>,
    ) -> Result<SourceRows<SessionSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(SourceRows {
                source_version: 0,
                rows: Vec::new(),
            });
        };
        let source_version = dataset.version().version;
        let batch = dataset.scan().with_row_id().try_into_batch().await?;
        let mut rows = if batch.num_rows() == 0 {
            Vec::new()
        } else {
            record_batch_to_session_snapshots(&batch)?
        };
        if let Some(extractor) = extractor {
            rows.retain(|snapshot| snapshot.extractor == extractor);
        }
        Ok(SourceRows {
            source_version,
            rows,
        })
    }

    pub async fn list_at_version(
        &self,
        extractor: Option<&str>,
        version: u64,
    ) -> Result<SourceRows<SessionSnapshot>> {
        if version == 0 {
            return Ok(SourceRows {
                source_version: 0,
                rows: Vec::new(),
            });
        }
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(SourceRows {
                source_version: 0,
                rows: Vec::new(),
            });
        };
        let dataset = dataset.checkout_version(version).await?;
        let batch = dataset.scan().with_row_id().try_into_batch().await?;
        let mut rows = if batch.num_rows() == 0 {
            Vec::new()
        } else {
            record_batch_to_session_snapshots(&batch)?
        };
        if let Some(extractor) = extractor {
            rows.retain(|snapshot| snapshot.extractor == extractor);
        }
        Ok(SourceRows {
            source_version: dataset.version().version,
            rows,
        })
    }

    pub async fn list(&self, extractor: Option<&str>) -> Result<Vec<SessionSnapshot>> {
        Ok(self.list_with_version(extractor).await?.rows)
    }

    pub async fn get(&self, row_id: u64) -> Result<Option<SessionSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(None);
        };
        let batch = dataset
            .take_rows(&[row_id], dataset.schema().clone())
            .await?;
        if batch.num_rows() == 0 {
            return Ok(None);
        }
        Ok(
            record_batch_to_session_snapshots_with_row_ids(&batch, &[row_id])?
                .into_iter()
                .next(),
        )
    }

    pub async fn insert(&self, snapshots: &mut [SessionSnapshot]) -> Result<()> {
        if snapshots.is_empty() {
            return Ok(());
        }
        if snapshots
            .iter()
            .any(|snapshot| snapshot.snapshot_id.memory_point() != u64::MAX)
        {
            return Err(Error::invalid_input(
                "session insert requires pending snapshot ids",
            ));
        }
        let new_indexes = (0..snapshots.len()).collect::<Vec<_>>();
        if let Some(mut dataset) = self.access.try_open().await? {
            let before_version = dataset.version().version;
            dataset
                .append(
                    session_snapshots_to_reader(snapshots.to_vec()),
                    self.access.options().write_params(),
                )
                .await?;
            assign_inserted_snapshot_ids_from_delta(
                &dataset,
                before_version,
                snapshots,
                &new_indexes,
            )
            .await?;
        } else {
            let dataset = self
                .access
                .write(session_snapshots_to_reader(snapshots.to_vec()))
                .await?;
            assign_inserted_snapshot_ids_from_scan(&dataset, snapshots).await?;
        }
        Ok(())
    }

    pub async fn update(&self, snapshots: &[SessionSnapshot]) -> Result<()> {
        let _ = snapshots;
        Err(Error::invalid_input(
            "session update is no longer supported",
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

    pub async fn load_thread_snapshots(&self, session_id: &str) -> Result<Vec<SessionSnapshot>> {
        let Some(dataset) = self.access.try_open().await? else {
            return Ok(Vec::new());
        };
        let batch = dataset
            .scan()
            .with_row_id()
            .filter(&format!(
                "session_id = '{}'",
                escape_predicate_string(session_id)
            ))?
            .try_into_batch()
            .await?;
        if batch.num_rows() == 0 {
            return Ok(Vec::new());
        }
        record_batch_to_session_snapshots(&batch)
    }

    pub async fn delta(
        &self,
        extractor: &str,
        baseline_version: u64,
    ) -> Result<SourceRows<SessionSnapshot>> {
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
            rows.extend(
                record_batch_to_session_snapshots(&batch)?
                    .into_iter()
                    .filter(|row| row.extractor == extractor),
            );
        }
        rows.sort_by(|left, right| {
            left.snapshot_sequence
                .cmp(&right.snapshot_sequence)
                .then(left.created_at.cmp(&right.created_at))
                .then(left.updated_at.cmp(&right.updated_at))
                .then(left.snapshot_id.cmp(&right.snapshot_id))
        });
        Ok(SourceRows {
            source_version,
            rows,
        })
    }
}

async fn assign_inserted_snapshot_ids_from_delta(
    dataset: &LanceDataset,
    before_version: u64,
    snapshots: &mut [SessionSnapshot],
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
        inserted_rows.extend(record_batch_to_session_snapshots(&batch)?);
    }
    if inserted_rows.len() != new_indexes.len() {
        return Err(Error::invalid_input(format!(
            "expected {} inserted session snapshots, got {}",
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
    snapshots: &mut [SessionSnapshot],
) -> Result<()> {
    let batch = dataset.scan().with_row_id().try_into_batch().await?;
    if batch.num_rows() != snapshots.len() {
        return Err(Error::invalid_input(format!(
            "expected {} inserted session snapshots, got {}",
            snapshots.len(),
            batch.num_rows()
        )));
    }
    let inserted_rows = record_batch_to_session_snapshots(&batch)?;
    for (snapshot, inserted_row) in snapshots.iter_mut().zip(inserted_rows) {
        snapshot.snapshot_id = inserted_row.snapshot_id;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{SessionSnapshot, SessionTable};
    use crate::{MemoryId, MemoryLayer, TableOptions};

    #[test]
    fn session_memory_id_roundtrip() {
        let snapshot = SessionSnapshot {
            snapshot_id: MemoryId::new(MemoryLayer::Session, 42),
            session_id: "OBS-LINE".to_string(),
            project: "muninn".to_string(),
            cwd: "/repo/muninn".to_string(),
            agent: "codex".to_string(),
            snapshot_sequence: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            extractor: "extractor-a".to_string(),
            title: "Session Title".to_string(),
            summary: "Session summary".to_string(),
            memory_signals: Vec::new(),
            skill_signals: Vec::new(),
            skill_details: "{}".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["turn:7".to_string()],
        };

        assert_eq!(snapshot.memory_id().unwrap().to_string(), "session:42");
    }

    #[tokio::test]
    async fn insert_assigns_snapshot_id_and_update_rejects_pending_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let table = SessionTable::new(TableOptions::local(dir.path()).unwrap());
        let mut pending = vec![SessionSnapshot {
            snapshot_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
            session_id: "OBS-LINE".to_string(),
            project: "muninn".to_string(),
            cwd: "/repo/muninn".to_string(),
            agent: "codex".to_string(),
            snapshot_sequence: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            extractor: "extractor-a".to_string(),
            title: "Session Title".to_string(),
            summary: "Session summary".to_string(),
            memory_signals: Vec::new(),
            skill_signals: Vec::new(),
            skill_details: "{}".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["turn:7".to_string()],
        }];

        table.insert(&mut pending).await.unwrap();
        assert_ne!(pending[0].snapshot_id.memory_point(), u64::MAX);

        let err = table
            .update(&[SessionSnapshot {
                snapshot_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
                session_id: "OBS-LINE".to_string(),
                project: "muninn".to_string(),
                cwd: "/repo/muninn".to_string(),
                agent: "codex".to_string(),
                snapshot_sequence: 1,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                extractor: "extractor-a".to_string(),
                title: "Session Title".to_string(),
                summary: "Session summary".to_string(),
                memory_signals: Vec::new(),
                skill_signals: Vec::new(),
                skill_details: "{}".to_string(),
                content: "{\"memories\":[]}".to_string(),
                references: vec!["turn:7".to_string()],
            }])
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("session update is no longer supported")
        );
    }

    #[tokio::test]
    async fn session_signal_fields_roundtrip_and_delta_returns_source_version() {
        let dir = tempfile::tempdir().unwrap();
        let table = SessionTable::new(TableOptions::local(dir.path()).unwrap());
        let mut rows = vec![SessionSnapshot {
            snapshot_id: MemoryId::new(MemoryLayer::Session, u64::MAX),
            session_id: "session-a".to_string(),
            project: "muninn".to_string(),
            cwd: "/repo/muninn".to_string(),
            agent: "codex".to_string(),
            snapshot_sequence: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            extractor: "default-extractor".to_string(),
            title: "Session Title".to_string(),
            summary: "Session summary".to_string(),
            memory_signals: vec!["Keep schemas minimal.".to_string()],
            skill_signals: vec!["Prefer focused Rust codec tests.".to_string()],
            skill_details: "{\"skills\":[\"schema-codec\"]}".to_string(),
            content: "# Session Title\n\n## Summary\nSession summary\n\n## Memory Signals\n- Keep schemas minimal.".to_string(),
            references: vec!["turn:7".to_string()],
        }];

        table.insert(&mut rows).await.unwrap();
        let loaded = table
            .get(rows[0].snapshot_id.memory_point())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.memory_signals, vec!["Keep schemas minimal."]);
        assert_eq!(
            loaded.skill_signals,
            vec!["Prefer focused Rust codec tests."]
        );
        assert_eq!(loaded.skill_details, "{\"skills\":[\"schema-codec\"]}");

        let delta = table.delta("default-extractor", 0).await.unwrap();
        assert_eq!(delta.rows.len(), 1);
        assert_eq!(delta.rows[0].memory_signals, vec!["Keep schemas minimal."]);
        assert_eq!(
            delta.rows[0].skill_signals,
            vec!["Prefer focused Rust codec tests."]
        );
        assert_eq!(
            delta.rows[0].skill_details,
            "{\"skills\":[\"schema-codec\"]}"
        );
        assert!(delta.source_version > 0);

        let scanned = table
            .list_with_version(Some("default-extractor"))
            .await
            .unwrap();
        assert_eq!(scanned.rows.len(), 1);
        assert_eq!(scanned.source_version, delta.source_version);
    }
}
