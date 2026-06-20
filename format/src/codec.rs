use std::sync::Arc;

use arrow_array::builder::{ListBuilder, StringBuilder};
use arrow_array::{
    Array, FixedSizeListArray, Float32Array, Int64Array, ListArray, RecordBatch,
    RecordBatchIterator, StringArray, TimestampMicrosecondArray, UInt64Array,
};
use arrow_schema::{ArrowError, DataType, Field};
use chrono::{TimeZone, Utc};
use lance::dataset::ROW_ID;
use lance::{Error, Result};
use serde_json::{Map, Value};

use super::schema::{extraction_schema, session_schema, turn_schema};
use crate::config::extraction_config;
use crate::extraction::Extraction;
use crate::memory_id::{MemoryId, MemoryLayer};
use crate::session::SessionSnapshot;
use crate::turn::{Artifact, Turn, TurnEvent};

pub(crate) fn turns_to_record_batch(
    turns: &[Turn],
) -> std::result::Result<RecordBatch, ArrowError> {
    let created_at = TimestampMicrosecondArray::from_iter_values(
        turns.iter().map(|turn| turn.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        turns.iter().map(|turn| turn.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let session_ids = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.session_id.as_deref())
            .collect::<Vec<_>>(),
    );
    let turn_sequence = Int64Array::from(
        turns
            .iter()
            .map(|turn| turn.turn_sequence)
            .collect::<Vec<_>>(),
    );
    let agent = StringArray::from_iter_values(turns.iter().map(|turn| turn.agent.as_str()));
    let project = StringArray::from_iter_values(turns.iter().map(|turn| turn.project.as_str()));
    let cwd = StringArray::from_iter_values(turns.iter().map(|turn| turn.cwd.as_str()));
    let extractor = StringArray::from_iter_values(turns.iter().map(|turn| turn.extractor.as_str()));
    let events_json =
        StringArray::from_iter_values(turns.iter().map(|turn| events_to_json(&turn.events)));
    let artifacts_json = StringArray::from(
        turns
            .iter()
            .map(|turn| {
                turn.artifacts
                    .as_ref()
                    .map(|artifacts| artifacts_to_json(artifacts))
            })
            .collect::<Vec<_>>(),
    );
    let metadata_json = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.metadata.as_ref().map(metadata_to_json))
            .collect::<Vec<_>>(),
    );
    let prompt = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.prompt.as_deref())
            .collect::<Vec<_>>(),
    );
    let response = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.response.as_deref())
            .collect::<Vec<_>>(),
    );
    let extraction_epoch = UInt64Array::from(
        turns
            .iter()
            .map(|turn| turn.extraction_epoch)
            .collect::<Vec<_>>(),
    );

    Ok(RecordBatch::try_new(
        Arc::new(turn_schema()),
        vec![
            Arc::new(created_at),
            Arc::new(updated_at),
            Arc::new(session_ids),
            Arc::new(turn_sequence),
            Arc::new(project),
            Arc::new(cwd),
            Arc::new(agent),
            Arc::new(extractor),
            Arc::new(events_json),
            Arc::new(artifacts_json),
            Arc::new(metadata_json),
            Arc::new(prompt),
            Arc::new(response),
            Arc::new(extraction_epoch),
        ],
    )?)
}

pub(crate) fn turns_to_reader(
    turns: Vec<Turn>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(turn_schema());
    let batch = turns_to_record_batch(&turns);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

pub(crate) fn record_batch_to_turns(batch: &RecordBatch) -> Result<Vec<Turn>> {
    let row_ids = batch_row_ids(batch)?;
    record_batch_to_turns_with_row_ids(batch, &row_ids)
}

pub(crate) fn record_batch_to_turns_with_row_ids(
    batch: &RecordBatch,
    row_ids: &[u64],
) -> Result<Vec<Turn>> {
    let created_at = batch
        .column(0)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let updated_at = batch
        .column(1)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let session_ids = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let project = batch
        .column(4)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let cwd = batch
        .column(5)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let agent = batch
        .column(6)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let extractor = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let events_json = batch
        .column(8)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let artifacts_json = batch
        .column(9)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let metadata_json = batch
        .column(10)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let prompt = batch
        .column(11)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let response = batch
        .column(12)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let extraction_epoch = batch
        .column(13)
        .as_any()
        .downcast_ref::<UInt64Array>()
        .unwrap();
    let turn_sequence = batch
        .column(3)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();

    let mut turns = Vec::with_capacity(batch.num_rows());
    for index in 0..batch.num_rows() {
        turns.push(Turn {
            turn_id: MemoryId::new(MemoryLayer::Turn, row_ids[index]),
            created_at: Utc
                .timestamp_micros(created_at.value(index))
                .single()
                .unwrap(),
            updated_at: Utc
                .timestamp_micros(updated_at.value(index))
                .single()
                .unwrap(),
            session_id: optional_string(session_ids, index),
            turn_sequence: optional_i64(turn_sequence, index),
            project: project.value(index).to_string(),
            cwd: cwd.value(index).to_string(),
            agent: agent.value(index).to_string(),
            extractor: extractor.value(index).to_string(),
            events: required_events(events_json, index)?,
            artifacts: optional_artifacts(artifacts_json, index),
            metadata: optional_json(metadata_json, index),
            prompt: optional_string(prompt, index),
            response: optional_string(response, index),
            extraction_epoch: optional_u64(extraction_epoch, index),
        });
    }
    Ok(turns)
}

pub(crate) fn build_string_list_array<'a>(
    values: impl Iterator<Item = Option<&'a Vec<String>>>,
) -> ListArray {
    let mut builder = ListBuilder::new(StringBuilder::new());
    for maybe_values in values {
        if let Some(entries) = maybe_values {
            for entry in entries {
                builder.values().append_value(entry);
            }
            builder.append(true);
        } else {
            builder.append(false);
        }
    }
    builder.finish()
}

pub(crate) fn optional_string(array: &StringArray, index: usize) -> Option<String> {
    (!array.is_null(index)).then(|| array.value(index).to_string())
}

pub(crate) fn optional_u64(array: &UInt64Array, index: usize) -> Option<u64> {
    (!array.is_null(index)).then(|| array.value(index))
}

pub(crate) fn optional_i64(array: &Int64Array, index: usize) -> Option<i64> {
    (!array.is_null(index)).then(|| array.value(index))
}

pub(crate) fn optional_string_list(array: &ListArray, index: usize) -> Option<Vec<String>> {
    if array.is_null(index) {
        return None;
    }
    let values = array.value(index);
    let values = values.as_any().downcast_ref::<StringArray>().unwrap();
    Some(
        (0..values.len())
            .map(|idx| values.value(idx).to_string())
            .collect(),
    )
}

pub(crate) fn events_to_json(events: &[TurnEvent]) -> String {
    serde_json::to_string(events).expect("turn events should serialize")
}

pub(crate) fn artifacts_to_json(artifacts: &[Artifact]) -> String {
    serde_json::to_string(artifacts).expect("artifacts should serialize")
}

pub(crate) fn metadata_to_json(metadata: &Map<String, Value>) -> String {
    serde_json::to_string(metadata).expect("metadata should serialize")
}

pub(crate) fn optional_json<T>(array: &StringArray, index: usize) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    if array.is_null(index) {
        return None;
    }
    serde_json::from_str(array.value(index)).ok()
}

pub(crate) fn optional_artifacts(array: &StringArray, index: usize) -> Option<Vec<Artifact>> {
    optional_json(array, index)
}

pub(crate) fn required_events(array: &StringArray, index: usize) -> Result<Vec<TurnEvent>> {
    serde_json::from_str(array.value(index)).map_err(|error| {
        Error::invalid_input(format!("invalid events_json for turn row {index}: {error}"))
    })
}

pub(crate) fn session_snapshots_to_record_batch(
    session_snapshots: &[SessionSnapshot],
) -> std::result::Result<RecordBatch, ArrowError> {
    let session_ids = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.session_id.as_str()),
    );
    let project = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.project.as_str()),
    );
    let cwd = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.cwd.as_str()),
    );
    let agent = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.agent.as_str()),
    );
    let snapshot_sequence = Int64Array::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.snapshot_sequence),
    );
    let created_at = TimestampMicrosecondArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let extractor = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.extractor.as_str()),
    );
    let title = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.title.as_str()),
    );
    let summary = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.summary.as_str()),
    );
    let content = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.content.as_str()),
    );
    let references = build_string_list_array(
        session_snapshots
            .iter()
            .map(|session_snapshot| Some(&session_snapshot.references)),
    );

    Ok(RecordBatch::try_new(
        Arc::new(session_schema()),
        vec![
            Arc::new(session_ids),
            Arc::new(project),
            Arc::new(cwd),
            Arc::new(agent),
            Arc::new(snapshot_sequence),
            Arc::new(created_at),
            Arc::new(updated_at),
            Arc::new(extractor),
            Arc::new(title),
            Arc::new(summary),
            Arc::new(content),
            Arc::new(references),
        ],
    )?)
}

pub(crate) fn session_snapshots_to_reader(
    session_snapshots: Vec<SessionSnapshot>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(session_schema());
    let batch = session_snapshots_to_record_batch(&session_snapshots);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

pub(crate) fn record_batch_to_session_snapshots(
    batch: &RecordBatch,
) -> Result<Vec<SessionSnapshot>> {
    let row_ids = batch_row_ids(batch)?;
    record_batch_to_session_snapshots_with_row_ids(batch, &row_ids)
}

pub(crate) fn record_batch_to_session_snapshots_with_row_ids(
    batch: &RecordBatch,
    row_ids: &[u64],
) -> Result<Vec<SessionSnapshot>> {
    let session_ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let project = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let cwd = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let agent = batch
        .column(3)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let snapshot_sequence = batch
        .column(4)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    let created_at = batch
        .column(5)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let updated_at = batch
        .column(6)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let extractor = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let title = batch
        .column(8)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let summary = batch
        .column(9)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let content = batch
        .column(10)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let references = batch
        .column(11)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();

    let session_snapshots = (0..batch.num_rows())
        .map(|index| {
            Ok(SessionSnapshot {
                snapshot_id: MemoryId::new(MemoryLayer::Session, row_ids[index]),
                session_id: session_ids.value(index).to_string(),
                project: project.value(index).to_string(),
                cwd: cwd.value(index).to_string(),
                agent: agent.value(index).to_string(),
                snapshot_sequence: snapshot_sequence.value(index),
                created_at: Utc
                    .timestamp_micros(created_at.value(index))
                    .single()
                    .unwrap(),
                updated_at: Utc
                    .timestamp_micros(updated_at.value(index))
                    .single()
                    .unwrap(),
                extractor: extractor.value(index).to_string(),
                title: title.value(index).to_string(),
                summary: summary.value(index).to_string(),
                content: content.value(index).to_string(),
                references: optional_string_list(references, index).unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(session_snapshots)
}

pub(crate) fn batch_row_ids(batch: &RecordBatch) -> Result<Vec<u64>> {
    let row_ids = batch
        .column_by_name(ROW_ID)
        .ok_or_else(|| Error::invalid_input("record batch missing _rowid column"))?
        .as_any()
        .downcast_ref::<UInt64Array>()
        .ok_or_else(|| Error::invalid_input("record batch _rowid column must be UInt64"))?;
    Ok((0..row_ids.len())
        .map(|index| row_ids.value(index))
        .collect())
}

pub(crate) fn extractions_to_record_batch(rows: &[Extraction]) -> Result<RecordBatch> {
    let dimensions = extraction_dimensions()?;
    let ids = StringArray::from_iter_values(rows.iter().map(|row| row.id.as_str()));
    let title = StringArray::from_iter_values(rows.iter().map(|row| row.title.as_str()));
    let summary = StringArray::from_iter_values(rows.iter().map(|row| row.summary.as_str()));
    let content = StringArray::from_iter_values(rows.iter().map(|row| row.content.as_str()));
    let cwd = StringArray::from_iter_values(rows.iter().map(|row| row.cwd.as_str()));
    let vector = build_float32_fixed_size_list_array(
        rows.iter().map(|row| row.vector.as_slice()),
        dimensions,
    )
    .map_err(|error| Error::invalid_input(format!("invalid extraction vector: {error}")))?;
    let turn_refs = build_string_list_array(rows.iter().map(|row| Some(&row.turn_refs)));
    let created_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");

    RecordBatch::try_new(
        Arc::new(extraction_schema(dimensions)),
        vec![
            Arc::new(ids),
            Arc::new(title),
            Arc::new(summary),
            Arc::new(content),
            Arc::new(cwd),
            Arc::new(vector),
            Arc::new(turn_refs),
            Arc::new(created_at),
            Arc::new(updated_at),
        ],
    )
    .map_err(|error| Error::invalid_input(format!("build extraction batch: {error}")))
}

pub(crate) fn extractions_to_reader(
    rows: Vec<Extraction>,
) -> Result<RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>>
{
    let dimensions = extraction_dimensions()?;
    let schema = Arc::new(extraction_schema(dimensions));
    let batch = extractions_to_record_batch(&rows).map_err(arrow_error_from_lance)?;
    Ok(RecordBatchIterator::new(
        vec![Ok(batch)].into_iter(),
        schema,
    ))
}

pub(crate) fn record_batch_to_extractions(batch: &RecordBatch) -> Result<Vec<Extraction>> {
    let ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let title = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let summary = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let content = batch
        .column(3)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let cwd = batch
        .column(4)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let vector = batch.column(5);
    let turn_refs = batch
        .column(6)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let created_at = batch
        .column(7)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let updated_at = batch
        .column(8)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();

    (0..batch.num_rows())
        .map(|index| {
            let vector = if let Some(vector) = vector.as_any().downcast_ref::<FixedSizeListArray>()
            {
                optional_float32_fixed_size_list(vector, index).unwrap_or_default()
            } else {
                return Err(Error::invalid_input(format!(
                    "extraction.vector must be FixedSizeList<Float32, N>, got {:?}",
                    vector.data_type()
                )));
            };

            Ok(Extraction {
                id: ids.value(index).to_string(),
                title: title.value(index).to_string(),
                summary: summary.value(index).to_string(),
                content: content.value(index).to_string(),
                cwd: cwd.value(index).to_string(),
                vector,
                turn_refs: optional_string_list(turn_refs, index).unwrap_or_default(),
                created_at: Utc
                    .timestamp_micros(created_at.value(index))
                    .single()
                    .unwrap(),
                updated_at: Utc
                    .timestamp_micros(updated_at.value(index))
                    .single()
                    .unwrap(),
            })
        })
        .collect()
}

pub(crate) fn build_float32_fixed_size_list_array<'a>(
    values: impl Iterator<Item = &'a [f32]>,
    dimensions: usize,
) -> std::result::Result<FixedSizeListArray, ArrowError> {
    let mut flattened = Vec::new();
    let mut row_count = 0usize;
    for entries in values {
        if entries.len() != dimensions {
            return Err(ArrowError::InvalidArgumentError(format!(
                "expected vector length {dimensions}, got {}",
                entries.len()
            )));
        }
        flattened.extend_from_slice(entries);
        row_count += 1;
    }

    FixedSizeListArray::try_new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dimensions as i32,
        Arc::new(Float32Array::from(flattened)),
        None,
    )
    .map_err(|error| {
        ArrowError::InvalidArgumentError(format!(
            "build FixedSizeListArray for {row_count} extraction rows: {error}"
        ))
    })
}

pub(crate) fn optional_float32_fixed_size_list(
    array: &FixedSizeListArray,
    index: usize,
) -> Option<Vec<f32>> {
    if array.is_null(index) {
        return None;
    }
    let values = array.value(index);
    let values = values.as_any().downcast_ref::<Float32Array>().unwrap();
    Some((0..values.len()).map(|idx| values.value(idx)).collect())
}

pub(crate) fn extraction_dimensions() -> Result<usize> {
    Ok(extraction_config()?.dimensions)
}

pub(crate) fn arrow_error_from_lance(error: Error) -> ArrowError {
    ArrowError::ExternalError(Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::fs;

    fn sample_turn() -> Turn {
        Turn {
            turn_id: MemoryId::new(MemoryLayer::Turn, 1),
            created_at: Utc.timestamp_micros(1_000_000).single().unwrap(),
            updated_at: Utc.timestamp_micros(2_000_000).single().unwrap(),
            session_id: Some("session-1".to_string()),
            turn_sequence: Some(7),
            project: "muninn".to_string(),
            cwd: "/repo/muninn".to_string(),
            agent: "agent".to_string(),
            extractor: "extractor".to_string(),
            events: vec![TurnEvent::UserMessage {
                text: "hello".to_string(),
                timestamp: None,
                artifacts: None,
            }],
            artifacts: None,
            metadata: None,
            prompt: Some("hello".to_string()),
            response: Some("world".to_string()),
            extraction_epoch: None,
        }
    }

    fn sample_extraction() -> Extraction {
        Extraction {
            id: "extraction-1".to_string(),
            title: "Report defaults".to_string(),
            summary: "Report defaults require CSV export names.".to_string(),
            content: "## Title\n\nReport defaults\n\n## Summary\n\nReport defaults require CSV export names.\n\n## Content\n\n- Use `daily-report.csv`.".to_string(),
            cwd: "/repo/reports".to_string(),
            vector: vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            turn_refs: vec!["turn:1".to_string()],
            created_at: Utc.timestamp_micros(3_000_000).single().unwrap(),
            updated_at: Utc.timestamp_micros(4_000_000).single().unwrap(),
        }
    }

    fn write_test_config(dir: &tempfile::TempDir) {
        let home = dir.path().join("muninn");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("muninn.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "providers": {
                    "embedding": {
                        "default": {
                            "type": "mock",
                            "dimensions": 8
                        }
                    }
                },
                "extractor": {
                    "name": "default-extractor",
                    "llmProvider": "default",
                    "embeddingProvider": "default"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", home);
        }
    }

    #[test]
    fn turn_codec_roundtrips_turn_sequence() {
        let batch = turns_to_record_batch(&[sample_turn()]).unwrap();
        assert!(batch.schema().field_with_name("turn_sequence").is_ok());

        let rows = record_batch_to_turns_with_row_ids(&batch, &[1]).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].turn_sequence, Some(7));
    }

    #[test]
    fn invalid_turn_events_json_returns_error() {
        let batch = turns_to_record_batch(&[sample_turn()]).unwrap();
        let columns = batch
            .columns()
            .iter()
            .enumerate()
            .map(|(index, column)| {
                if index == 8 {
                    Arc::new(StringArray::from_iter_values(["not json"])) as Arc<dyn Array>
                } else {
                    Arc::clone(column)
                }
            })
            .collect();
        let batch = RecordBatch::try_new(batch.schema(), columns).unwrap();

        let error = record_batch_to_turns_with_row_ids(&batch, &[1])
            .expect_err("invalid events_json should be reported");

        assert!(
            error
                .to_string()
                .contains("invalid events_json for turn row 0"),
            "{error}"
        );
    }

    #[test]
    fn extraction_codec_roundtrips_title_summary_content() {
        let dir = tempfile::tempdir().unwrap();
        write_test_config(&dir);

        let batch = extractions_to_record_batch(&[sample_extraction()]).unwrap();
        assert!(batch.schema().field_with_name("title").is_ok());
        assert!(batch.schema().field_with_name("summary").is_ok());
        assert!(batch.schema().field_with_name("content").is_ok());
        assert!(batch.schema().field_with_name("text").is_err());
        assert!(batch.schema().field_with_name("context").is_err());
        assert!(batch.schema().field_with_name("search_text").is_err());

        let rows = record_batch_to_extractions(&batch).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Report defaults");
        assert_eq!(rows[0].summary, "Report defaults require CSV export names.");
        assert!(rows[0].content.contains("## Content"));
        assert_eq!(rows[0].turn_refs, vec!["turn:1"]);
    }
}
