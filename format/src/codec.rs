use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::builder::{ListBuilder, StringBuilder};
use arrow_array::{
    Array, FixedSizeListArray, Float32Array, Int64Array, ListArray, RecordBatch,
    RecordBatchIterator, StringArray, TimestampMicrosecondArray, UInt64Array,
};
use arrow_schema::{ArrowError, DataType, Field, Schema as ArrowSchema};
use chrono::{TimeZone, Utc};
use lance::dataset::ROW_ID;
use lance::{Error, Result};
use serde_json::Value;

use super::schema::{observing_schema, semantic_index_schema, turn_schema};
use crate::config::semantic_index_config;
use crate::memory_id::{MemoryId, MemoryLayer};
use crate::observing::ObservingSnapshot;
use crate::semantic_index::SemanticIndexRow;
use crate::session::SessionTurn;

pub(crate) fn turns_to_record_batch(
    turns: &[SessionTurn],
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
    let agent = StringArray::from_iter_values(turns.iter().map(|turn| turn.agent.as_str()));
    let observer = StringArray::from_iter_values(turns.iter().map(|turn| turn.observer.as_str()));
    let title = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.title.as_deref())
            .collect::<Vec<_>>(),
    );
    let summary = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.summary.as_deref())
            .collect::<Vec<_>>(),
    );
    let tool_calling = build_string_list_array(turns.iter().map(|turn| turn.tool_calling.as_ref()));
    let artifacts_json = StringArray::from(
        turns
            .iter()
            .map(|turn| turn.artifacts.as_ref().map(artifacts_to_json))
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
    let observing_epoch = UInt64Array::from(
        turns
            .iter()
            .map(|turn| turn.observing_epoch)
            .collect::<Vec<_>>(),
    );

    Ok(RecordBatch::try_new(
        Arc::new(turn_schema()),
        vec![
            Arc::new(created_at),
            Arc::new(updated_at),
            Arc::new(session_ids),
            Arc::new(agent),
            Arc::new(observer),
            Arc::new(title),
            Arc::new(summary),
            Arc::new(tool_calling),
            Arc::new(artifacts_json),
            Arc::new(prompt),
            Arc::new(response),
            Arc::new(observing_epoch),
        ],
    )?)
}

pub(crate) fn turns_to_reader(
    turns: Vec<SessionTurn>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(turn_schema());
    let batch = turns_to_record_batch(&turns);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

pub(crate) fn turns_to_update_record_batch(
    turns: &[SessionTurn],
) -> std::result::Result<RecordBatch, ArrowError> {
    let batch = turns_to_record_batch(turns)?;
    let mut fields = vec![Field::new(ROW_ID, DataType::UInt64, false)];
    fields.extend(
        batch
            .schema()
            .fields()
            .iter()
            .map(|field| field.as_ref().clone()),
    );

    let mut columns = vec![Arc::new(UInt64Array::from_iter_values(
        turns.iter().map(|turn| turn.turn_id.memory_point()),
    )) as Arc<dyn Array>];
    columns.extend(batch.columns().iter().cloned());

    RecordBatch::try_new(Arc::new(ArrowSchema::new(fields)), columns)
}

pub(crate) fn turns_to_update_reader(
    turns: Vec<SessionTurn>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(ArrowSchema::new(
        std::iter::once(Field::new(ROW_ID, DataType::UInt64, false))
            .chain(
                turn_schema()
                    .fields
                    .iter()
                    .map(|field| field.as_ref().clone()),
            )
            .collect::<Vec<_>>(),
    ));
    let batch = turns_to_update_record_batch(&turns);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

pub(crate) fn record_batch_to_turns(batch: &RecordBatch) -> Result<Vec<SessionTurn>> {
    let row_ids = batch_row_ids(batch)?;
    record_batch_to_turns_with_row_ids(batch, &row_ids)
}

pub(crate) fn record_batch_to_turns_with_row_ids(
    batch: &RecordBatch,
    row_ids: &[u64],
) -> Result<Vec<SessionTurn>> {
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
    let agent = batch
        .column(3)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let observer = batch
        .column(4)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let title = batch
        .column(5)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let summary = batch
        .column(6)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let tool_calling = batch
        .column(7)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let artifacts_json = batch
        .column(8)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let prompt = batch
        .column(9)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let response = batch
        .column(10)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let observing_epoch = batch
        .column(11)
        .as_any()
        .downcast_ref::<UInt64Array>()
        .unwrap();

    let turns = (0..batch.num_rows())
        .map(|index| SessionTurn {
            turn_id: MemoryId::new(MemoryLayer::Session, row_ids[index]),
            created_at: Utc
                .timestamp_micros(created_at.value(index))
                .single()
                .unwrap(),
            updated_at: Utc
                .timestamp_micros(updated_at.value(index))
                .single()
                .unwrap(),
            session_id: optional_string(session_ids, index),
            agent: agent.value(index).to_string(),
            observer: observer.value(index).to_string(),
            title: optional_string(title, index),
            summary: optional_string(summary, index),
            tool_calling: optional_string_list(tool_calling, index),
            artifacts: optional_artifacts(artifacts_json, index),
            prompt: optional_string(prompt, index),
            response: optional_string(response, index),
            observing_epoch: optional_u64(observing_epoch, index),
        })
        .collect();
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

pub(crate) fn artifacts_to_json(artifacts: &HashMap<String, String>) -> String {
    serde_json::to_string(artifacts).expect("artifacts should serialize")
}

pub(crate) fn optional_artifacts(
    array: &StringArray,
    index: usize,
) -> Option<HashMap<String, String>> {
    if array.is_null(index) {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(array.value(index)).ok()?;
    let object = parsed.as_object()?;
    Some(
        object
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
            .collect(),
    )
}

pub(crate) fn observings_to_record_batch(
    observings: &[ObservingSnapshot],
) -> std::result::Result<RecordBatch, ArrowError> {
    let observing_ids = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.observing_id.as_str()),
    );
    let snapshot_sequence = Int64Array::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.snapshot_sequence),
    );
    let created_at = TimestampMicrosecondArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let observer = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.observer.as_str()),
    );
    let title =
        StringArray::from_iter_values(observings.iter().map(|observing| observing.title.as_str()));
    let summary = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.summary.as_str()),
    );
    let content = StringArray::from_iter_values(
        observings
            .iter()
            .map(|observing| observing.content.as_str()),
    );
    let references = build_string_list_array(
        observings
            .iter()
            .map(|observing| Some(&observing.references)),
    );

    Ok(RecordBatch::try_new(
        Arc::new(observing_schema()),
        vec![
            Arc::new(observing_ids),
            Arc::new(snapshot_sequence),
            Arc::new(created_at),
            Arc::new(updated_at),
            Arc::new(observer),
            Arc::new(title),
            Arc::new(summary),
            Arc::new(content),
            Arc::new(references),
        ],
    )?)
}

pub(crate) fn observings_to_reader(
    observings: Vec<ObservingSnapshot>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(observing_schema());
    let batch = observings_to_record_batch(&observings);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

pub(crate) fn record_batch_to_observings(batch: &RecordBatch) -> Result<Vec<ObservingSnapshot>> {
    let row_ids = batch_row_ids(batch)?;
    record_batch_to_observings_with_row_ids(batch, &row_ids)
}

pub(crate) fn record_batch_to_observings_with_row_ids(
    batch: &RecordBatch,
    row_ids: &[u64],
) -> Result<Vec<ObservingSnapshot>> {
    let observing_ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let snapshot_sequence = batch
        .column(1)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    let created_at = batch
        .column(2)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let updated_at = batch
        .column(3)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let observer = batch
        .column(4)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let title = batch
        .column(5)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let summary = batch
        .column(6)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let content = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let references = batch
        .column(8)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();

    let observings = (0..batch.num_rows())
        .map(|index| {
            Ok(ObservingSnapshot {
                snapshot_id: MemoryId::new(MemoryLayer::Observing, row_ids[index]),
                observing_id: observing_ids.value(index).to_string(),
                snapshot_sequence: snapshot_sequence.value(index),
                created_at: Utc
                    .timestamp_micros(created_at.value(index))
                    .single()
                    .unwrap(),
                updated_at: Utc
                    .timestamp_micros(updated_at.value(index))
                    .single()
                    .unwrap(),
                observer: observer.value(index).to_string(),
                title: title.value(index).to_string(),
                summary: summary.value(index).to_string(),
                content: content.value(index).to_string(),
                references: optional_string_list(references, index).unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(observings)
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

pub(crate) fn semantic_rows_to_record_batch(rows: &[SemanticIndexRow]) -> Result<RecordBatch> {
    let dimensions = semantic_index_dimensions()?;
    let ids = StringArray::from_iter_values(rows.iter().map(|row| row.id.as_str()));
    let memory_ids = StringArray::from_iter_values(rows.iter().map(|row| row.memory_id.as_str()));
    let text = StringArray::from_iter_values(rows.iter().map(|row| row.text.as_str()));
    let vector = build_float32_fixed_size_list_array(
        rows.iter().map(|row| row.vector.as_slice()),
        dimensions,
    )
    .map_err(|error| Error::invalid_input(format!("invalid semantic index vector: {error}")))?;
    let importance = Float32Array::from_iter_values(rows.iter().map(|row| row.importance));
    let category = StringArray::from_iter_values(rows.iter().map(|row| row.category.as_str()));
    let created_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");

    RecordBatch::try_new(
        Arc::new(semantic_index_schema(dimensions)),
        vec![
            Arc::new(ids),
            Arc::new(memory_ids),
            Arc::new(text),
            Arc::new(vector),
            Arc::new(importance),
            Arc::new(category),
            Arc::new(created_at),
        ],
    )
    .map_err(|error| Error::invalid_input(format!("build semantic_index batch: {error}")))
}

pub(crate) fn semantic_rows_to_reader(
    rows: Vec<SemanticIndexRow>,
) -> Result<RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>>
{
    let dimensions = semantic_index_dimensions()?;
    let schema = Arc::new(semantic_index_schema(dimensions));
    let batch = semantic_rows_to_record_batch(&rows).map_err(arrow_error_from_lance)?;
    Ok(RecordBatchIterator::new(
        vec![Ok(batch)].into_iter(),
        schema,
    ))
}

pub(crate) fn record_batch_to_semantic_rows(batch: &RecordBatch) -> Result<Vec<SemanticIndexRow>> {
    let ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let memory_ids = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let text = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let vector = batch.column(3);
    let importance = batch
        .column(4)
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    let category = batch
        .column(5)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let created_at = batch
        .column(6)
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
                    "semantic_index.vector must be FixedSizeList<Float32, N>, got {:?}",
                    vector.data_type()
                )));
            };

            Ok(SemanticIndexRow {
                id: ids.value(index).to_string(),
                memory_id: memory_ids.value(index).to_string(),
                text: text.value(index).to_string(),
                vector,
                importance: importance.value(index),
                category: category.value(index).to_string(),
                created_at: Utc
                    .timestamp_micros(created_at.value(index))
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
            "build FixedSizeListArray for {row_count} semantic rows: {error}"
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

pub(crate) fn semantic_index_dimensions() -> Result<usize> {
    Ok(semantic_index_config()?.dimensions)
}

pub(crate) fn arrow_error_from_lance(error: Error) -> ArrowError {
    ArrowError::ExternalError(Box::new(error))
}
