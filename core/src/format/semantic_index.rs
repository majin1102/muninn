use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIndexRow {
    pub id: String,
    pub text: String,
    pub vector: Vec<f32>,
    pub importance: f32,
    pub category: String,
    pub created_at: DateTime<Utc>,
}
