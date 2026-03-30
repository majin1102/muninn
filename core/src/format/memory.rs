use std::fmt::{Display, Formatter};
use std::str::FromStr;

use lance::{Error, Result};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MemoryLayer {
    Thinking,
    Observing,
    Session,
}

impl MemoryLayer {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Thinking => "THINKING",
            Self::Observing => "OBSERVING",
            Self::Session => "SESSION",
        }
    }
}

impl Display for MemoryLayer {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MemoryLayer {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "THINKING" => Ok(Self::Thinking),
            "OBSERVING" => Ok(Self::Observing),
            "SESSION" => Ok(Self::Session),
            _ => Err(Error::invalid_input(format!(
                "invalid memory layer: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct MemoryId {
    pub memory_layer: MemoryLayer,
    pub memory_point: Ulid,
}

impl MemoryId {
    pub fn new(memory_layer: MemoryLayer, memory_point: Ulid) -> Self {
        Self {
            memory_layer,
            memory_point,
        }
    }

    pub fn memory_layer(&self) -> MemoryLayer {
        self.memory_layer
    }

    pub fn memory_point(&self) -> Ulid {
        self.memory_point
    }
}

impl Display for MemoryId {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.memory_layer, self.memory_point)
    }
}

impl FromStr for MemoryId {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        let Some((memory_layer, memory_point)) = value.split_once(':') else {
            return Err(Error::invalid_input(format!(
                "invalid memory id format: {value}"
            )));
        };

        if memory_point.contains(':') {
            return Err(Error::invalid_input(format!(
                "invalid memory id format: {value}"
            )));
        }

        let memory_layer = MemoryLayer::from_str(memory_layer)?;
        let memory_point = Ulid::from_str(memory_point)
            .map_err(|error| Error::invalid_input(format!("invalid ulid in memory id: {error}")))?;

        Ok(Self {
            memory_layer,
            memory_point,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::{MemoryId, MemoryLayer};

    #[test]
    fn memory_layer_roundtrip() {
        assert_eq!(
            MemoryLayer::from_str("THINKING").unwrap(),
            MemoryLayer::Thinking
        );
        assert_eq!(MemoryLayer::Observing.to_string(), "OBSERVING");
    }

    #[test]
    fn memory_id_roundtrip() {
        let parsed = MemoryId::from_str("SESSION:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX").unwrap();
        assert_eq!(parsed.memory_layer(), MemoryLayer::Session);
        assert_eq!(
            parsed.memory_point().to_string(),
            "01JQ7Y8YQ6V7D4M1N9K2F5T8ZX"
        );
        assert_eq!(parsed.to_string(), "SESSION:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX");
    }

    #[test]
    fn invalid_memory_id_is_rejected() {
        assert!(MemoryId::from_str("SESSION").is_err());
        assert!(MemoryId::from_str("UNKNOWN:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX").is_err());
        assert!(MemoryId::from_str("SESSION:bad-ulid").is_err());
        assert!(MemoryId::from_str("SESSION:01JQ7Y8YQ6V7D4M1N9K2F5T8ZX:extra").is_err());
    }
}
