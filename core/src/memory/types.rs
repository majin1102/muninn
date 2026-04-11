#[cfg(test)]
use std::str::FromStr;

#[cfg(test)]
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde::{Deserializer, Serializer};

#[cfg(test)]
use crate::format::MemoryId;
#[cfg(test)]
use crate::format::{ObservingSnapshot, SessionTurn};

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
impl TryFrom<&SessionTurn> for MemoryView {
    type Error = &'static str;

    fn try_from(turn: &SessionTurn) -> Result<Self, Self::Error> {
        let title = trim_text(turn.title.as_deref());
        let summary = trim_text(turn.summary.as_deref());
        let detail = render_session_turn_detail(turn);
        if title.is_none() && summary.is_none() && detail.is_none() {
            return Err("session turn cannot be rendered without text");
        }
        Ok(Self {
            memory_id: turn.turn_id,
            title,
            summary,
            detail,
            created_at: turn.created_at,
            updated_at: turn.updated_at,
        })
    }
}

#[cfg(test)]
impl TryFrom<&ObservingSnapshot> for MemoryView {
    type Error = &'static str;

    fn try_from(snapshot: &ObservingSnapshot) -> Result<Self, Self::Error> {
        let title = trim_text(Some(snapshot.title.as_str()));
        let summary = trim_text(Some(snapshot.summary.as_str()));
        let detail = trim_text(Some(snapshot.content.as_str()));
        if title.is_none() && summary.is_none() && detail.is_none() {
            return Err("observing snapshot cannot be rendered without text");
        }
        Ok(Self {
            memory_id: snapshot.snapshot_id,
            title,
            summary,
            detail,
            created_at: snapshot.created_at,
            updated_at: snapshot.updated_at,
        })
    }
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

#[cfg(test)]
fn trim_text(value: Option<&str>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

#[cfg(test)]
fn render_session_turn_detail(turn: &SessionTurn) -> Option<String> {
    let mut lines = Vec::new();
    if let Some(prompt) = trim_text(turn.prompt.as_deref()) {
        lines.push(format!("Prompt: {prompt}"));
    }
    if let Some(response) = trim_text(turn.response.as_deref()) {
        lines.push(format!("Response: {response}"));
    }
    if let Some(tool_calling) = turn.tool_calling.as_ref().filter(|tools| !tools.is_empty()) {
        lines.push(format!("Tools: {}", tool_calling.join(", ")));
    }
    if let Some(artifacts) = turn.artifacts.as_ref().filter(|artifacts| !artifacts.is_empty()) {
        let mut entries = artifacts
            .iter()
            .map(|(key, value)| format!("{key}: {value}"))
            .collect::<Vec<_>>();
        entries.sort();
        lines.push(format!("Artifacts: {}", entries.join(", ")));
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}
