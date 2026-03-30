use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmFieldUpdate<T> {
    pub before: Vec<T>,
    pub after: Vec<T>,
}

impl<T> LlmFieldUpdate<T> {
    pub fn new(before: Vec<T>, after: Vec<T>) -> Self {
        Self { before, after }
    }
}

impl<T> Default for LlmFieldUpdate<T> {
    fn default() -> Self {
        Self {
            before: Vec::new(),
            after: Vec::new(),
        }
    }
}
