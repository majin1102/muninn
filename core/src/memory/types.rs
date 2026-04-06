#[cfg(test)]
use std::str::FromStr;

#[cfg(test)]
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde::{Deserializer, Serializer};

#[cfg(test)]
use crate::format::MemoryId;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ListMode {
    Recency { limit: usize },
    Page { offset: usize, limit: usize },
}

impl ListMode {
    #[cfg(test)]
    pub fn limit(self) -> usize {
        match self {
            Self::Recency { limit } | Self::Page { limit, .. } => limit,
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryView {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub memory_id: MemoryId,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[cfg(test)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecallHit {
    #[serde(
        serialize_with = "serialize_memory_id",
        deserialize_with = "deserialize_memory_id"
    )]
    pub memory_id: MemoryId,
    pub text: String,
}

#[cfg(test)]
fn serialize_memory_id<S>(memory_id: &MemoryId, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&memory_id.to_string())
}

#[cfg(test)]
fn deserialize_memory_id<'de, D>(deserializer: D) -> Result<MemoryId, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    MemoryId::from_str(&value).map_err(serde::de::Error::custom)
}
