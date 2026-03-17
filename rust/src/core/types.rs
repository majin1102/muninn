use serde::{Deserialize, Serialize};

pub type MemoryId = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub memory_id: MemoryId,
    pub r#type: MemoryType,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    Thinking,
    Session,
    Message,
}

#[derive(Debug, Deserialize)]
pub struct RecallParams {
    pub query: String,
    pub limit: Option<usize>,
    pub thinking_ratio: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub r#type: Option<MemoryType>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}
