use std::fmt::{Display, Formatter};
use std::str::FromStr;

use lance::{Error, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MemoryLayer {
    Thinking,
    Observing,
    Session,
}

impl MemoryLayer {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Thinking => "thinking",
            Self::Observing => "observing",
            Self::Session => "session",
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
            "thinking" => Ok(Self::Thinking),
            "observing" => Ok(Self::Observing),
            "session" => Ok(Self::Session),
            _ => Err(Error::invalid_input(format!(
                "invalid memory layer: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct MemoryId {
    pub memory_layer: MemoryLayer,
    pub memory_point: u64,
}

impl MemoryId {
    pub fn new(memory_layer: MemoryLayer, memory_point: u64) -> Self {
        Self {
            memory_layer,
            memory_point,
        }
    }

    pub fn memory_layer(&self) -> MemoryLayer {
        self.memory_layer
    }

    pub fn memory_point(&self) -> u64 {
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
        let memory_point = memory_point.parse::<u64>().map_err(|error| {
            Error::invalid_input(format!("invalid row id in memory id: {error}"))
        })?;

        Ok(Self {
            memory_layer,
            memory_point,
        })
    }
}

pub fn serialize_memory_id<S>(
    memory_id: &MemoryId,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&memory_id.to_string())
}

pub fn deserialize_memory_id<'de, D>(deserializer: D) -> std::result::Result<MemoryId, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    MemoryId::from_str(&value).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::{MemoryId, MemoryLayer};

    #[test]
    fn memory_layer_roundtrip() {
        assert_eq!(
            MemoryLayer::from_str("thinking").unwrap(),
            MemoryLayer::Thinking
        );
        assert_eq!(MemoryLayer::Observing.to_string(), "observing");
    }

    #[test]
    fn memory_id_roundtrip() {
        let parsed = MemoryId::from_str("session:42").unwrap();
        assert_eq!(parsed.memory_layer(), MemoryLayer::Session);
        assert_eq!(parsed.memory_point(), 42);
        assert_eq!(parsed.to_string(), "session:42");
    }

    #[test]
    fn invalid_memory_id_is_rejected() {
        assert!(MemoryId::from_str("session").is_err());
        assert!(MemoryId::from_str("unknown:42").is_err());
        assert!(MemoryId::from_str("session:bad-row-id").is_err());
        assert!(MemoryId::from_str("session:42:extra").is_err());
    }
}
