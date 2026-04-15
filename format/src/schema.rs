use std::collections::HashMap;
use std::sync::Arc;

use arrow_schema::{DataType, Field, Schema, TimeUnit};

pub fn turn_schema() -> Schema {
    Schema::new(vec![
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
        Field::new(
            "updated_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
        Field::new("session_id", DataType::Utf8, true),
        Field::new("agent", DataType::Utf8, false),
        Field::new("observer", DataType::Utf8, false),
        Field::new("title", DataType::Utf8, true),
        Field::new("summary", DataType::Utf8, true),
        Field::new(
            "tool_calling",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            true,
        ),
        Field::new("artifacts_json", DataType::Utf8, true),
        Field::new("prompt", DataType::Utf8, true),
        Field::new("response", DataType::Utf8, true),
        Field::new("observing_epoch", DataType::UInt64, true),
    ])
}

pub fn observing_schema() -> Schema {
    Schema::new(vec![
        Field::new("observing_id", DataType::Utf8, false),
        Field::new("snapshot_sequence", DataType::Int64, false),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
        Field::new(
            "updated_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
        Field::new("observer", DataType::Utf8, false),
        Field::new("title", DataType::Utf8, false),
        Field::new("summary", DataType::Utf8, false),
        Field::new("content", DataType::Utf8, false),
        Field::new(
            "references",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            false,
        ),
    ])
}

pub fn semantic_index_schema(dimensions: usize) -> Schema {
    let mut id_metadata = HashMap::new();
    id_metadata.insert(
        "lance-schema:unenforced-primary-key".to_string(),
        "true".to_string(),
    );
    id_metadata.insert(
        "lance-schema:unenforced-primary-key:position".to_string(),
        "1".to_string(),
    );

    Schema::new(vec![
        Field::new("id", DataType::Utf8, false).with_metadata(id_metadata),
        Field::new("memory_id", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dimensions as i32,
            ),
            false,
        ),
        Field::new("importance", DataType::Float32, false),
        Field::new("category", DataType::Utf8, false),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
    ])
}
