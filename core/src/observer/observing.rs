use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use lance::Result;
use serde::{Deserialize, Serialize};
use ulid::Ulid;
use uuid::Uuid;

use crate::format::observing::{ObservedMemory, ObservingCheckpoint, ObservingSnapshot};
use crate::format::session::SessionTurn;
use crate::llm::observing::new_observing_id;
use crate::llm::observing_update::{ObserveResult, ObservingContent};
use crate::observer::types::LlmFieldUpdate;
use crate::storage::Storage;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotContent {
    #[serde(default)]
    pub(crate) memories: Vec<ObservedMemory>,
    #[serde(default)]
    pub(crate) open_questions: Vec<String>,
    #[serde(default)]
    pub(crate) next_steps: Vec<String>,
    #[serde(default)]
    pub(crate) memory_delta: LlmFieldUpdate<ObservedMemory>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservingThread {
    pub(crate) observing_id: String,
    pub(crate) snapshot_id: Option<String>,
    pub(crate) observing_epoch: u64,
    pub(crate) title: String,
    pub(crate) summary: String,
    pub(crate) snapshots: Vec<SnapshotContent>,
    pub(crate) references: Vec<String>,
    pub(crate) indexed_snapshot_sequence: Option<i64>,
    pub(crate) observer: String,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

impl ObservingThread {
    pub(crate) fn new_seeded(
        observer: &str,
        title: &str,
        summary: &str,
        references: Vec<String>,
        observing_epoch: u64,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            observing_id: new_observing_id(),
            snapshot_id: None,
            observing_epoch,
            title: normalize_title(title),
            summary: normalize_summary(summary),
            snapshots: Vec::new(),
            references,
            indexed_snapshot_sequence: None,
            observer: observer.to_string(),
            created_at: now,
            updated_at: now,
        }
    }

    pub(crate) fn from_rows(mut rows: Vec<ObservingSnapshot>) -> Result<Self> {
        rows.sort_by(|left, right| {
            left.snapshot_sequence
                .cmp(&right.snapshot_sequence)
                .then(left.updated_at.cmp(&right.updated_at))
        });
        let snapshots = rows
            .iter()
            .map(deserialize_snapshot)
            .collect::<Result<Vec<_>>>()?;
        if snapshots.is_empty() {
            return Err(lance::Error::invalid_input(
                "missing snapshots for observing thread",
            ));
        }
        let latest_row = rows
            .last()
            .cloned()
            .ok_or_else(|| lance::Error::invalid_input("missing latest observing snapshot row"))?;

        Ok(Self {
            observing_id: latest_row.observing_id.clone(),
            snapshot_id: Some(latest_row.snapshot_id.clone()),
            observing_epoch: latest_row.checkpoint.observing_epoch,
            title: latest_row.title.clone(),
            summary: latest_row.summary.clone(),
            snapshots,
            references: latest_row.references.clone(),
            indexed_snapshot_sequence: latest_row.checkpoint.indexed_snapshot_sequence,
            observer: latest_row.observer.clone(),
            created_at: rows
                .first()
                .map(|row| row.created_at)
                .unwrap_or(latest_row.created_at),
            updated_at: latest_row.updated_at,
        })
    }

    pub(crate) fn latest_snapshot(&self) -> Option<&SnapshotContent> {
        self.snapshots.last()
    }

    pub(crate) fn current_content(&self) -> ObservingContent {
        let snapshot = self.latest_snapshot().cloned().unwrap_or_default();
        ObservingContent {
            title: self.title.clone(),
            summary: self.summary.clone(),
            memories: snapshot.memories,
            open_questions: snapshot.open_questions,
            next_steps: snapshot.next_steps,
        }
    }

    pub(crate) fn apply_observe_result(
        &mut self,
        result: ObserveResult,
        observing_epoch: u64,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let current_snapshot = self.latest_snapshot().cloned().unwrap_or_default();
        let memories_before = current_snapshot.memories;
        let (materialized_delta, materialized_memories) =
            apply_memories_delta(memories_before.clone(), result.memory_delta.clone())?;

        self.title = result.observing_content_update.title;
        self.summary = result.observing_content_update.summary;
        self.observing_epoch = observing_epoch;
        self.snapshots.push(SnapshotContent {
            memories: materialized_memories,
            open_questions: result.observing_content_update.open_questions,
            next_steps: result.observing_content_update.next_steps,
            memory_delta: materialized_delta,
        });
        self.snapshot_id = Some(Ulid::new().to_string());
        self.updated_at = now;
        Ok(())
    }

    pub(crate) fn reset_references(&mut self) {
        self.references.clear();
    }

    pub(crate) fn push_reference(&mut self, reference: String) {
        if !self.references.contains(&reference) {
            self.references.push(reference);
        }
    }

    pub(crate) fn to_row(&self) -> Result<ObservingSnapshot> {
        let snapshot_id = self.snapshot_id.clone().ok_or_else(|| {
            lance::Error::invalid_input(format!(
                "missing snapshot id for observing thread {}",
                self.observing_id
            ))
        })?;
        let snapshot_sequence =
            self.snapshots.len().checked_sub(1).ok_or_else(|| {
                lance::Error::invalid_input("missing snapshots for observing thread")
            })? as i64;
        let content = self.latest_snapshot().ok_or_else(|| {
            lance::Error::invalid_input(format!(
                "missing latest snapshot for observing thread {}",
                self.observing_id
            ))
        })?;

        Ok(ObservingSnapshot {
            snapshot_id,
            observing_id: self.observing_id.clone(),
            snapshot_sequence,
            created_at: self.updated_at,
            updated_at: self.updated_at,
            observer: self.observer.clone(),
            title: self.title.clone(),
            summary: self.summary.clone(),
            content: serde_json::to_string_pretty(content).map_err(|error| {
                lance::Error::invalid_input(format!("serialize observing content: {error}"))
            })?,
            references: self.references.clone(),
            checkpoint: ObservingCheckpoint {
                observing_epoch: self.observing_epoch,
                indexed_snapshot_sequence: self.indexed_snapshot_sequence,
            },
        })
    }

    pub(crate) fn set_indexed_snapshot_sequence(&mut self, snapshot_sequence: i64) {
        self.indexed_snapshot_sequence = Some(snapshot_sequence);
    }
}

pub(crate) async fn load_threads(
    storage: &Storage,
    observer: &str,
) -> Result<Vec<ObservingThread>> {
    let now = Utc::now();
    let observings = storage.observings().list(None).await?;
    let mut grouped = HashMap::<String, Vec<ObservingSnapshot>>::new();

    for observing in observings
        .into_iter()
        .filter(|observing| observing.observer == observer)
        .filter(|observing| observing.updated_at >= now - ChronoDuration::days(7))
    {
        grouped
            .entry(observing.observing_id.clone())
            .or_default()
            .push(observing);
    }

    grouped
        .into_values()
        .map(ObservingThread::from_rows)
        .collect()
}

pub(crate) fn turn_reference(turn: &SessionTurn) -> String {
    format!("SESSION:{}", turn.turn_id)
}

pub(crate) fn observing_reference(observing_id: &str) -> String {
    format!("OBSERVING:{observing_id}")
}

fn deserialize_snapshot(observing: &ObservingSnapshot) -> Result<SnapshotContent> {
    serde_json::from_str::<SnapshotContent>(&observing.content).map_err(|error| {
        lance::Error::invalid_input(format!(
            "deserialize observing content for {}: {error}",
            observing.observing_id
        ))
    })
}

fn normalize_title(value: &str) -> String {
    normalize_text(value, 120.min(48))
}

fn normalize_summary(value: &str) -> String {
    normalize_text(value, 220)
}

fn normalize_text(value: &str, max_chars: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    let mut chars = trimmed.chars();
    let text = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{text}...")
    } else {
        text
    }
}

fn materialize_memory_ids(memories: Vec<ObservedMemory>) -> Result<Vec<ObservedMemory>> {
    let mut seen = HashSet::new();
    memories
        .into_iter()
        .map(|memory| {
            let id = memory.id.unwrap_or_else(|| Uuid::new_v4().to_string());
            if !seen.insert(id.clone()) {
                return Err(lance::Error::invalid_input(
                    "observing update materialized duplicate memory id",
                ));
            }
            Ok(ObservedMemory {
                id: Some(id),
                text: memory.text,
                category: memory.category,
                updated_memory: memory.updated_memory,
            })
        })
        .collect()
}

fn apply_memories_delta(
    current_memories: Vec<ObservedMemory>,
    delta: LlmFieldUpdate<ObservedMemory>,
) -> Result<(LlmFieldUpdate<ObservedMemory>, Vec<ObservedMemory>)> {
    let before = delta.before;
    let after = materialize_memory_ids(delta.after)?;

    let current_ids = current_memories
        .iter()
        .filter_map(|memory| memory.id.clone())
        .collect::<HashSet<_>>();
    let before_ids = before
        .iter()
        .filter_map(|memory| memory.id.clone())
        .collect::<HashSet<_>>();
    let after_ids = after
        .iter()
        .filter_map(|memory| memory.id.clone())
        .collect::<HashSet<_>>();

    for before_id in &before_ids {
        if !current_ids.contains(before_id) {
            return Err(lance::Error::invalid_input(
                "observing delta referenced unknown memory id",
            ));
        }
    }

    let deleted_ids = before_ids
        .difference(&after_ids)
        .cloned()
        .collect::<HashSet<_>>();
    let mut merged = current_memories
        .into_iter()
        .filter(|memory| {
            memory
                .id
                .as_ref()
                .map(|id| !deleted_ids.contains(id))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    for memory in &after {
        let id = memory
            .id
            .as_ref()
            .ok_or_else(|| lance::Error::invalid_input("materialized memory missing id"))?;
        if let Some(existing) = merged
            .iter_mut()
            .find(|existing| existing.id.as_ref() == Some(id))
        {
            *existing = memory.clone();
        } else {
            merged.push(memory.clone());
        }
    }

    Ok((LlmFieldUpdate::new(before, after), merged))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{ObservingThread, SnapshotContent};
    use crate::format::observing::{MemoryCategory, ObservedMemory};
    use crate::llm::observing_update::{ObserveResult, ObservingContentUpdate};
    use crate::observer::types::LlmFieldUpdate;

    #[test]
    fn apply_observe_result_patches_memories_into_full_snapshot() {
        let now = Utc::now();
        let mut thread =
            ObservingThread::new_seeded("observer-a", "Title", "Summary", vec![], 0, now);
        thread.snapshots.push(SnapshotContent {
            memories: vec![
                ObservedMemory {
                    id: Some("mem-1".to_string()),
                    text: "old fact".to_string(),
                    category: MemoryCategory::Fact,
                    updated_memory: None,
                },
                ObservedMemory {
                    id: Some("mem-2".to_string()),
                    text: "delete me".to_string(),
                    category: MemoryCategory::Entity,
                    updated_memory: None,
                },
            ],
            open_questions: vec![],
            next_steps: vec![],
            memory_delta: Default::default(),
        });

        thread
            .apply_observe_result(
                ObserveResult {
                    observing_content_update: ObservingContentUpdate {
                        title: "Title 2".to_string(),
                        summary: "Summary 2".to_string(),
                        open_questions: vec!["open question".to_string()],
                        next_steps: vec![],
                    },
                    memory_delta: LlmFieldUpdate::new(
                        vec![
                            ObservedMemory {
                                id: Some("mem-1".to_string()),
                                text: "old fact".to_string(),
                                category: MemoryCategory::Fact,
                                updated_memory: None,
                            },
                            ObservedMemory {
                                id: Some("mem-2".to_string()),
                                text: "delete me".to_string(),
                                category: MemoryCategory::Entity,
                                updated_memory: None,
                            },
                        ],
                        vec![
                            ObservedMemory {
                                id: Some("mem-1".to_string()),
                                text: "new fact".to_string(),
                                category: MemoryCategory::Fact,
                                updated_memory: None,
                            },
                            ObservedMemory {
                                id: None,
                                text: "brand new".to_string(),
                                category: MemoryCategory::Decision,
                                updated_memory: None,
                            },
                        ],
                    ),
                },
                1,
                now,
            )
            .unwrap();

        let latest = thread.latest_snapshot().unwrap();
        assert_eq!(latest.memories.len(), 2);
        assert!(
            latest
                .memories
                .iter()
                .any(|memory| memory.id.as_deref() == Some("mem-1") && memory.text == "new fact")
        );
        assert!(
            latest
                .memories
                .iter()
                .all(|memory| memory.text != "delete me")
        );
        assert!(
            latest
                .memories
                .iter()
                .any(|memory| memory.text == "brand new" && memory.id.is_some())
        );
        assert_eq!(latest.open_questions, vec!["open question".to_string()]);
        assert_eq!(latest.memory_delta.before.len(), 2);
        assert_eq!(latest.memory_delta.after.len(), 2);
        assert!(
            latest
                .memory_delta
                .after
                .iter()
                .all(|memory| memory.id.is_some())
        );
    }
}
