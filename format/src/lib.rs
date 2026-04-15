pub mod access;
pub mod codec;
pub(crate) mod config;
pub(crate) mod maintenance;
pub mod memory_id;
pub mod observing;
pub mod schema;
pub mod semantic_index;
pub mod session;

pub use access::{TableDescription, TableOptions, TableStats};
pub use config::data_root;
pub use memory_id::{MemoryId, MemoryLayer, deserialize_memory_id, serialize_memory_id};
pub use observing::{ObservedMemory, ObservingSnapshot, ObservingTable};
pub use semantic_index::{SemanticIndexRow, SemanticIndexTable};
pub use session::{SessionTable, SessionTurn};
