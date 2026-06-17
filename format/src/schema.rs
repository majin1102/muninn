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
        Field::new("turn_sequence", DataType::Int64, true),
        Field::new("project", DataType::Utf8, false),
        Field::new("cwd", DataType::Utf8, false),
        Field::new("agent", DataType::Utf8, false),
        Field::new("extractor", DataType::Utf8, false),
        Field::new("events_json", DataType::Utf8, false),
        Field::new("artifacts_json", DataType::Utf8, true),
        Field::new("metadata_json", DataType::Utf8, true),
        Field::new("prompt", DataType::Utf8, true),
        Field::new("response", DataType::Utf8, true),
        Field::new("extraction_epoch", DataType::UInt64, true),
    ])
}

pub fn session_schema() -> Schema {
    Schema::new(vec![
        Field::new("session_id", DataType::Utf8, false),
        Field::new("project", DataType::Utf8, false),
        Field::new("cwd", DataType::Utf8, false),
        Field::new("agent", DataType::Utf8, false),
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
        Field::new("extractor", DataType::Utf8, false),
        Field::new("title", DataType::Utf8, false),
        Field::new("summary", DataType::Utf8, false),
        Field::new("signals", DataType::Utf8, false),
        Field::new("content", DataType::Utf8, false),
        Field::new(
            "references",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            false,
        ),
    ])
}

pub fn extraction_schema(dimensions: usize) -> Schema {
    let mut id_metadata = std::collections::HashMap::new();
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
        Field::new("title", DataType::Utf8, false),
        Field::new("summary", DataType::Utf8, false),
        Field::new("content", DataType::Utf8, false),
        Field::new("cwd", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dimensions as i32,
            ),
            false,
        ),
        Field::new(
            "turn_refs",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            false,
        ),
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
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extraction_schema_has_refs_and_no_memory_id() {
        let schema = extraction_schema(3);
        assert!(schema.field_with_name("id").is_ok());
        assert!(schema.field_with_name("title").is_ok());
        assert!(schema.field_with_name("summary").is_ok());
        assert!(schema.field_with_name("content").is_ok());
        assert!(schema.field_with_name("cwd").is_ok());
        assert!(schema.field_with_name("vector").is_ok());
        assert!(schema.field_with_name("importance").is_err());
        assert!(schema.field_with_name("category").is_err());
        assert!(schema.field_with_name("turn_refs").is_ok());
        assert!(schema.field_with_name("anchors").is_err());
        assert!(schema.field_with_name("created_at").is_ok());
        assert!(schema.field_with_name("updated_at").is_ok());
        assert!(schema.field_with_name("text").is_err());
        assert!(schema.field_with_name("context").is_err());
        assert!(schema.field_with_name("search_text").is_err());
        assert!(schema.field_with_name("project").is_err());
        assert!(schema.field_with_name("agent").is_err());
        assert!(schema.field_with_name("session_id").is_err());
        assert!(schema.field_with_name("snapshot_id").is_err());
        assert!(schema.field_with_name("memory_id").is_err());
    }

    #[test]
    fn turn_schema_uses_events_json_not_tool_calls_json() {
        let schema = turn_schema();
        assert!(schema.field_with_name("project").is_ok());
        assert!(schema.field_with_name("cwd").is_ok());
        assert!(schema.field_with_name("agent").is_ok());
        assert!(schema.field_with_name("extractor").is_ok());
        assert!(schema.field_with_name("turn_sequence").is_ok());
        assert!(schema.field_with_name("metadata_json").is_ok());
        assert!(schema.field_with_name("events_json").is_ok());
        assert!(schema.field_with_name("tool_calls_json").is_err());
        assert!(schema.field_with_name("artifacts_json").is_ok());
        assert!(schema.field_with_name("prompt").is_ok());
        assert!(schema.field_with_name("response").is_ok());
        assert!(schema.field_with_name("extraction_epoch").is_ok());
        assert!(schema.field_with_name("title").is_err());
        assert!(schema.field_with_name("summary").is_err());
    }

    #[test]
    fn session_schema_tracks_project_cwd_agent_and_extractor() {
        let schema = session_schema();
        assert!(schema.field_with_name("session_id").is_ok());
        assert!(schema.field_with_name("project").is_ok());
        assert!(schema.field_with_name("cwd").is_ok());
        assert!(schema.field_with_name("agent").is_ok());
        assert!(schema.field_with_name("extractor").is_ok());
        assert!(schema.field_with_name("metadata_json").is_err());
    }

    #[test]
    fn session_schema_has_signals_field() {
        let schema = session_schema();
        assert!(schema.field_with_name("signals").is_ok());
        assert_eq!(
            schema.field_with_name("signals").unwrap().data_type(),
            &DataType::Utf8
        );
    }
}
