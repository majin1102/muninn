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

use super::schema::{
    extraction_schema, observation_context_schema, observation_schema, session_schema, turn_schema,
};
use crate::config::extraction_config;
use crate::extraction::Extraction;
use crate::memory_id::{MemoryId, MemoryLayer};
use crate::observation_context::ObservationContext;
use crate::observation::Observation;
use crate::session::SessionSnapshot;
use crate::turn::{Artifact, Turn, ToolCall};

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
    let tool_calls_json = StringArray::from(
        turns
            .iter()
            .map(|turn| {
                turn.tool_calls
                    .as_ref()
                    .map(|tool_calls| tool_calls_to_json(tool_calls))
            })
            .collect::<Vec<_>>(),
    );
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
            Arc::new(tool_calls_json),
            Arc::new(artifacts_json),
            Arc::new(prompt),
            Arc::new(response),
            Arc::new(observing_epoch),
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
    let tool_calls_json = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
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
        .map(|index| Turn {
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
            agent: agent.value(index).to_string(),
            observer: observer.value(index).to_string(),
            title: optional_string(title, index),
            summary: optional_string(summary, index),
            tool_calls: optional_json(tool_calls_json, index),
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

pub(crate) fn tool_calls_to_json(tool_calls: &[ToolCall]) -> String {
    serde_json::to_string(tool_calls).expect("tool calls should serialize")
}

pub(crate) fn artifacts_to_json(artifacts: &[Artifact]) -> String {
    serde_json::to_string(artifacts).expect("artifacts should serialize")
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

pub(crate) fn session_snapshots_to_record_batch(
    session_snapshots: &[SessionSnapshot],
) -> std::result::Result<RecordBatch, ArrowError> {
    let session_ids = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.session_id.as_str()),
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
    let observer = StringArray::from_iter_values(
        session_snapshots
            .iter()
            .map(|session_snapshot| session_snapshot.observer.as_str()),
    );
    let title =
        StringArray::from_iter_values(session_snapshots.iter().map(|session_snapshot| session_snapshot.title.as_str()));
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

pub(crate) fn session_snapshots_to_reader(
    session_snapshots: Vec<SessionSnapshot>,
) -> RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>> {
    let schema = Arc::new(session_schema());
    let batch = session_snapshots_to_record_batch(&session_snapshots);
    RecordBatchIterator::new(vec![batch].into_iter(), schema)
}

pub(crate) fn record_batch_to_session_snapshots(batch: &RecordBatch) -> Result<Vec<SessionSnapshot>> {
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

    let session_snapshots = (0..batch.num_rows())
        .map(|index| {
            Ok(SessionSnapshot {
                snapshot_id: MemoryId::new(MemoryLayer::Session, row_ids[index]),
                session_id: session_ids.value(index).to_string(),
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
    Ok(session_snapshots)
}

pub(crate) fn observation_contexts_to_record_batch(
    rows: &[ObservationContext],
) -> std::result::Result<RecordBatch, ArrowError> {
    let ids = StringArray::from_iter_values(rows.iter().map(|row| row.id.as_str()));
    let observing_path = StringArray::from_iter_values(rows.iter().map(|row| row.observing_path.as_str()));
    let parent_id = StringArray::from(rows.iter().map(|row| row.parent_id.as_deref()).collect::<Vec<_>>());
    let position = Int64Array::from_iter_values(rows.iter().map(|row| row.position));
    let content = StringArray::from_iter_values(rows.iter().map(|row| row.content.as_str()));
    let created_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let observer = StringArray::from_iter_values(rows.iter().map(|row| row.observer.as_str()));

    Ok(RecordBatch::try_new(
        Arc::new(observation_context_schema()),
        vec![
            Arc::new(ids),
            Arc::new(observing_path),
            Arc::new(parent_id),
            Arc::new(position),
            Arc::new(content),
            Arc::new(created_at),
            Arc::new(updated_at),
            Arc::new(observer),
        ],
    )?)
}

pub(crate) fn observation_contexts_to_reader(
    rows: Vec<ObservationContext>,
) -> Result<RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>>
{
    let schema = Arc::new(observation_context_schema());
    let batch = observation_contexts_to_record_batch(&rows)
        .map_err(|error| Error::invalid_input(format!("build observation context batch: {error}")))?;
    Ok(RecordBatchIterator::new(
        vec![Ok(batch)].into_iter(),
        schema,
    ))
}

pub(crate) fn record_batch_to_observation_contexts(batch: &RecordBatch) -> Result<Vec<ObservationContext>> {
    let ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let observing_path = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let parent_id = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let position = batch
        .column(3)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    let content = batch
        .column(4)
        .as_any()
        .downcast_ref::<StringArray>()
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
    let observer = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();

    (0..batch.num_rows())
        .map(|index| {
            Ok(ObservationContext {
                id: ids.value(index).to_string(),
                observing_path: observing_path.value(index).to_string(),
                parent_id: (!parent_id.is_null(index)).then(|| parent_id.value(index).to_string()),
                position: position.value(index),
                content: content.value(index).to_string(),
                created_at: Utc
                    .timestamp_micros(created_at.value(index))
                    .single()
                    .unwrap(),
                updated_at: Utc
                    .timestamp_micros(updated_at.value(index))
                    .single()
                    .unwrap(),
                observer: observer.value(index).to_string(),
            })
        })
        .collect()
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
    let text = StringArray::from_iter_values(rows.iter().map(|row| row.text.as_str()));
    let context = StringArray::from_iter(rows.iter().map(|row| row.context.as_deref()));
    let anchors = build_string_list_array(rows.iter().map(|row| Some(&row.anchors)));
    let search_text = StringArray::from_iter_values(rows.iter().map(extraction_search_text));
    let vector = build_float32_fixed_size_list_array(
        rows.iter().map(|row| row.vector.as_slice()),
        dimensions,
    )
    .map_err(|error| Error::invalid_input(format!("invalid extraction vector: {error}")))?;
    let importance = Float32Array::from_iter_values(rows.iter().map(|row| row.importance));
    let category = StringArray::from_iter_values(rows.iter().map(|row| row.category.as_str()));
    let turn_refs = build_string_list_array(rows.iter().map(|row| Some(&row.turn_refs)));
    let observation_ids = build_string_list_array(rows.iter().map(|row| Some(&row.observation_ids)));
    let observed_root_anchors = build_string_list_array(
        rows.iter().map(|row| Some(&row.observed_root_anchors)),
    );
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
            Arc::new(text),
            Arc::new(context),
            Arc::new(anchors),
            Arc::new(search_text),
            Arc::new(vector),
            Arc::new(importance),
            Arc::new(category),
            Arc::new(turn_refs),
            Arc::new(observation_ids),
            Arc::new(observed_root_anchors),
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
    let text = batch
        .column(1)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let context = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let anchors = batch
        .column(3)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let vector = batch.column(5);
    let importance = batch
        .column(6)
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap();
    let category = batch
        .column(7)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let turn_refs = batch
        .column(8)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let observation_ids = batch
        .column(9)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let observed_root_anchors = batch
        .column(10)
        .as_any()
        .downcast_ref::<ListArray>()
        .unwrap();
    let created_at = batch
        .column(11)
        .as_any()
        .downcast_ref::<TimestampMicrosecondArray>()
        .unwrap();
    let updated_at = batch
        .column(12)
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
                text: text.value(index).to_string(),
                context: (!context.is_null(index)).then(|| context.value(index).to_string()),
                anchors: optional_string_list(anchors, index).unwrap_or_default(),
                vector,
                importance: importance.value(index),
                category: category.value(index).to_string(),
                turn_refs: optional_string_list(turn_refs, index).unwrap_or_default(),
                observation_ids: optional_string_list(observation_ids, index).unwrap_or_default(),
                observed_root_anchors: optional_string_list(observed_root_anchors, index).unwrap_or_default(),
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

pub(crate) fn observations_to_record_batch(rows: &[Observation]) -> Result<RecordBatch> {
    let dimensions = extraction_dimensions()?;
    let ids = StringArray::from_iter_values(rows.iter().map(|row| row.id.as_str()));
    let observing_path = StringArray::from_iter_values(rows.iter().map(|row| row.observing_path.as_str()));
    let text = StringArray::from_iter_values(rows.iter().map(|row| row.text.as_str()));
    let vector = build_float32_fixed_size_list_array(
        rows.iter().map(|row| row.vector.as_slice()),
        dimensions,
    )
    .map_err(|error| Error::invalid_input(format!("invalid observation vector: {error}")))?;
    let extraction_refs = build_string_list_array(rows.iter().map(|row| Some(&row.extraction_refs)));
    let created_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.created_at.timestamp_micros()),
    )
    .with_timezone("UTC");
    let updated_at = TimestampMicrosecondArray::from_iter_values(
        rows.iter().map(|row| row.updated_at.timestamp_micros()),
    )
    .with_timezone("UTC");

    RecordBatch::try_new(
        Arc::new(observation_schema(dimensions)),
        vec![
            Arc::new(ids),
            Arc::new(observing_path),
            Arc::new(text),
            Arc::new(vector),
            Arc::new(extraction_refs),
            Arc::new(created_at),
            Arc::new(updated_at),
        ],
    )
    .map_err(|error| Error::invalid_input(format!("build observation batch: {error}")))
}

pub(crate) fn observations_to_reader(
    rows: Vec<Observation>,
) -> Result<RecordBatchIterator<impl Iterator<Item = std::result::Result<RecordBatch, ArrowError>>>>
{
    let dimensions = extraction_dimensions()?;
    let schema = Arc::new(observation_schema(dimensions));
    let batch = observations_to_record_batch(&rows).map_err(arrow_error_from_lance)?;
    Ok(RecordBatchIterator::new(
        vec![Ok(batch)].into_iter(),
        schema,
    ))
}

pub(crate) fn record_batch_to_observations(batch: &RecordBatch) -> Result<Vec<Observation>> {
    let ids = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let observing_path = batch
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
    let extraction_refs = batch
        .column(4)
        .as_any()
        .downcast_ref::<ListArray>()
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

    (0..batch.num_rows())
        .map(|index| {
            let vector = if let Some(vector) = vector.as_any().downcast_ref::<FixedSizeListArray>()
            {
                optional_float32_fixed_size_list(vector, index).unwrap_or_default()
            } else {
                return Err(Error::invalid_input(format!(
                    "observation.vector must be FixedSizeList<Float32, N>, got {:?}",
                    vector.data_type()
                )));
            };

            Ok(Observation {
                id: ids.value(index).to_string(),
                observing_path: observing_path.value(index).to_string(),
                text: text.value(index).to_string(),
                vector,
                extraction_refs: optional_string_list(extraction_refs, index).unwrap_or_default(),
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

fn extraction_search_text(row: &Extraction) -> String {
    row.text.clone()
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
