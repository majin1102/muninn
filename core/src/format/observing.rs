use std::str::FromStr;

use chrono::{DateTime, Utc};
use lance::{Error, Result};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::format::memory::{MemoryId, MemoryLayer};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservingCheckpoint {
    pub observing_epoch: u64,
    pub indexed_snapshot_sequence: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObservingSnapshot {
    pub snapshot_id: String,
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
        let id = Ulid::from_str(&self.snapshot_id).map_err(|error| {
            Error::invalid_input(format!("invalid observing snapshot ulid: {error}"))
        })?;
        Ok(MemoryId::new(MemoryLayer::Observing, id))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{ObservingCheckpoint, ObservingSnapshot};
    use crate::memory::types::MemoryView;

    #[test]
    fn observing_memory_id_roundtrip() {
        let observing = ObservingSnapshot {
            snapshot_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string(),
            observing_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string(),
            snapshot_sequence: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            observer: "observer-a".to_string(),
            title: "Observing Title".to_string(),
            summary: "Observing summary".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["SESSION:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 1,
                indexed_snapshot_sequence: Some(1),
            },
        };

        assert_eq!(
            observing.memory_id().unwrap().to_string(),
            "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX"
        );
    }

    #[test]
    fn observing_try_into_rendered_memory_prefers_summary() {
        let observing = ObservingSnapshot {
            snapshot_id: "01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string(),
            observing_id: "OBS-LINE".to_string(),
            snapshot_sequence: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            observer: "observer-a".to_string(),
            title: "Observing Title".to_string(),
            summary: "Observing summary".to_string(),
            content: "{\"memories\":[]}".to_string(),
            references: vec!["SESSION:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX".to_string()],
            checkpoint: ObservingCheckpoint {
                observing_epoch: 1,
                indexed_snapshot_sequence: Some(1),
            },
        };

        let rendered = MemoryView::try_from(&observing).unwrap();
        assert_eq!(
            rendered.memory_id.to_string(),
            "OBSERVING:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX"
        );
        assert_eq!(rendered.title.as_deref(), Some("Observing Title"));
        assert_eq!(rendered.summary.as_deref(), Some("Observing summary"));
        assert_eq!(rendered.detail.as_deref(), Some("{\"memories\":[]}"));
    }
}
