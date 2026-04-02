use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use chrono::Utc;
use lance::Result;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::format::semantic_index::SemanticIndexRow;
use crate::format::session::SessionTurn;
use crate::llm::config::{EmbeddingConfig, effective_observer_name};
use crate::llm::embedding::embed_text;
use crate::llm::observing::{
    GatewayAction, GatewayUpdate, ObservingGateway, ObservingThreadGatewayInput,
};
use crate::llm::observing_update::{
    ObserveRequest, ObserveResult, ObservingTurnInput, ObservingUpdater,
};
use crate::observer::observing::{
    ObservingThread, SnapshotContent, load_threads, observing_reference, turn_reference,
};
use crate::storage::Storage;

fn observer_singleton() -> &'static Mutex<Option<Observer>> {
    static INSTANCE: OnceLock<Mutex<Option<Observer>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone)]
struct PendingObservingTask {
    observing_id: String,
    input: ObserveRequest,
}

#[derive(Debug, Default)]
struct ObserverState {
    committed_epoch: Option<u64>,
    observing_epoch: Option<u64>,
    buffer: Vec<SessionTurn>,
    observing_buffer: Vec<SessionTurn>,
    threads: Vec<ObservingThread>,
    flushing: bool,
    shutdown: bool,
}

#[derive(Debug)]
struct EpochBarrierState {
    current_epoch: u64,
    open_writes: usize,
    blocked_since: Option<Instant>,
    warned_stalled: bool,
}

#[derive(Debug)]
struct ObserverRuntime {
    cancel: CancellationToken,
    task: StdMutex<Option<JoinHandle<()>>>,
}

#[derive(Debug)]
pub(crate) struct PostWriteGuard {
    epoch: u64,
    barrier: Arc<StdMutex<EpochBarrierState>>,
    completed: bool,
}

impl PostWriteGuard {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn complete(mut self) {
        self.completed = true;
        decrement_open_writes(&self.barrier);
    }
}

impl Drop for PostWriteGuard {
    fn drop(&mut self) {
        if !self.completed {
            decrement_open_writes(&self.barrier);
        }
    }
}

#[derive(Clone)]
pub struct Observer {
    storage: Storage,
    observer: String,
    poll_interval: Duration,
    barrier: Arc<StdMutex<EpochBarrierState>>,
    state: Arc<Mutex<ObserverState>>,
    runtime: Arc<ObserverRuntime>,
}

impl Observer {
    pub async fn new(storage: Storage) -> Result<Self> {
        let observer_name = effective_observer_name()?;
        let mut singleton = observer_singleton().lock().await;
        if let Some(observer) = singleton.as_ref().cloned() {
            if !observer.is_shutdown().await
                && observer.observer == observer_name
                && observer.storage.matches(&storage)
            {
                return Ok(observer);
            }
            observer.shutdown(true).await;
        }

        let observer = Self::build(storage, observer_name).await?;
        *singleton = Some(observer.clone());
        Ok(observer)
    }

    async fn build(storage: Storage, observer: String) -> Result<Self> {
        let semantic_config = crate::config::semantic_index_config()?;
        let mut threads = load_threads(&storage, &observer).await?;
        for thread in &mut threads {
            if let Err(error) = catch_up_index(&storage, thread, &semantic_config).await {
                eprintln!(
                    "[observer] semantic_index catch-up failed for {}: {}",
                    thread.observing_id, error
                );
            }
        }

        let committed_epoch = load_committed_epoch(&storage, &observer).await?;
        let mut inbox = storage
            .sessions()
            .turns_after_epoch(&observer, committed_epoch)
            .await?;
        if !inbox.is_empty() {
            let repaired_epoch = next_epoch(committed_epoch);
            let mut repaired = false;
            for turn in &mut inbox {
                if turn.observing_epoch != Some(repaired_epoch) {
                    turn.observing_epoch = Some(repaired_epoch);
                    repaired = true;
                }
            }
            if repaired {
                storage.sessions().upsert(inbox.clone()).await?;
            }
        }

        let observer = Self {
            storage,
            observer,
            poll_interval: default_poll_interval(),
            barrier: Arc::new(StdMutex::new(EpochBarrierState {
                current_epoch: next_epoch(committed_epoch),
                open_writes: 0,
                blocked_since: None,
                warned_stalled: false,
            })),
            state: Arc::new(Mutex::new(ObserverState {
                committed_epoch,
                observing_epoch: None,
                buffer: inbox,
                observing_buffer: Vec::new(),
                threads,
                flushing: false,
                shutdown: false,
            })),
            runtime: Arc::new(ObserverRuntime {
                cancel: CancellationToken::new(),
                task: StdMutex::new(None),
            }),
        };
        observer.start_polling();
        Ok(observer)
    }

    pub async fn shutdown(&self, wait: bool) {
        self.state.lock().await.shutdown = true;
        self.runtime.shutdown(wait).await;
    }

    pub(crate) fn begin_post(&self) -> PostWriteGuard {
        let mut barrier = self
            .barrier
            .lock()
            .expect("observer epoch barrier poisoned");
        let epoch = barrier.current_epoch;
        barrier.open_writes += 1;
        if barrier.open_writes == 1 {
            barrier.blocked_since = Some(Instant::now());
            barrier.warned_stalled = false;
        }
        PostWriteGuard {
            epoch,
            barrier: Arc::clone(&self.barrier),
            completed: false,
        }
    }

    pub(crate) async fn enqueue(&self, turns: Vec<SessionTurn>) {
        if turns.is_empty() {
            return;
        }
        let mut state = self.state.lock().await;
        if state.shutdown {
            return;
        }
        for turn in turns {
            enqueue_turn(&mut state.buffer, turn);
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn flush_epoch(&self) -> Result<usize> {
        flush_epoch_with(
            &self.storage,
            &self.observer,
            self.poll_interval,
            &self.barrier,
            &self.state,
        )
        .await
    }

    pub(crate) async fn is_shutdown(&self) -> bool {
        self.state.lock().await.shutdown
    }

    #[cfg(test)]
    pub(crate) fn shares_runtime_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.runtime, &other.runtime)
    }

    #[cfg(test)]
    pub(crate) async fn runtime_stopped(&self) -> bool {
        self.runtime.is_shutdown().await
    }

    #[cfg(test)]
    pub(crate) async fn snapshot(&self) -> Result<Vec<SessionTurn>> {
        let state = self.state.lock().await;
        let mut turns = state.observing_buffer.clone();
        turns.extend(state.buffer.clone());
        turns.sort_by(|left, right| {
            left.observing_epoch
                .cmp(&right.observing_epoch)
                .then(left.created_at.cmp(&right.created_at))
                .then(left.updated_at.cmp(&right.updated_at))
        });
        Ok(turns)
    }

    #[cfg(test)]
    pub(crate) async fn threads_snapshot(&self) -> Vec<ObservingThread> {
        self.state.lock().await.threads.clone()
    }

    fn start_polling(&self) {
        let storage = self.storage.clone();
        let observer = self.observer.clone();
        let poll_interval = self.poll_interval;
        let barrier = Arc::clone(&self.barrier);
        let state = Arc::clone(&self.state);
        let cancel = self.runtime.cancel.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(poll_interval) => {
                        let _ =
                            flush_epoch_with(&storage, &observer, poll_interval, &barrier, &state)
                                .await;
                    }
                }
            }
        });
        let mut slot = self
            .runtime
            .task
            .lock()
            .expect("observer runtime task poisoned");
        *slot = Some(task);
    }
}

impl ObserverRuntime {
    async fn shutdown(&self, wait: bool) {
        self.cancel.cancel();
        if !wait {
            return;
        }
        let task = {
            let mut slot = self.task.lock().expect("observer runtime task poisoned");
            slot.take()
        };
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    #[cfg(test)]
    async fn is_shutdown(&self) -> bool {
        self.task
            .lock()
            .expect("observer runtime task poisoned")
            .is_none()
    }
}

impl Drop for ObserverRuntime {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn flush_epoch_with(
    storage: &Storage,
    observer: &str,
    poll_interval: Duration,
    barrier: &Arc<StdMutex<EpochBarrierState>>,
    state: &Arc<Mutex<ObserverState>>,
) -> Result<usize> {
    let mut state = state.lock().await;
    if state.shutdown || state.flushing {
        return Ok(0);
    }
    let epoch = if let Some(epoch) = state.observing_epoch {
        epoch
    } else {
        if state.buffer.is_empty() {
            return Ok(0);
        }
        let mut barrier = barrier.lock().expect("observer epoch barrier poisoned");
        if barrier.open_writes > 0 {
            maybe_warn_stalled_writes(observer, poll_interval, &mut barrier);
            return Ok(0);
        }
        let epoch = barrier.current_epoch;
        barrier.current_epoch += 1;
        state.observing_epoch = Some(epoch);
        state.observing_buffer = std::mem::take(&mut state.buffer);
        epoch
    };
    if state.observing_buffer.is_empty() {
        state.observing_epoch = None;
        return Ok(0);
    }

    state.flushing = true;
    let pending_turns = state.observing_buffer.clone();
    let result =
        flush_epoch_inner(storage, observer, &mut state.threads, epoch, &pending_turns).await;
    match result {
        Ok(flushed) => {
            state.committed_epoch = Some(epoch);
            state.observing_epoch = None;
            state.observing_buffer.clear();
            state.flushing = false;
            Ok(flushed)
        }
        Err(error) => {
            state.flushing = false;
            Err(error)
        }
    }
}

fn next_epoch(committed_epoch: Option<u64>) -> u64 {
    committed_epoch.map(|epoch| epoch + 1).unwrap_or(0)
}

fn default_poll_interval() -> Duration {
    let millis = std::env::var("MUNINN_OBSERVER_POLL_MS")
        .ok()
        .or_else(|| std::env::var("MUNINN_OBSERVE_WINDOW_MS").ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000);
    Duration::from_millis(millis)
}

fn decrement_open_writes(barrier: &Arc<StdMutex<EpochBarrierState>>) {
    let mut barrier = barrier.lock().expect("observer epoch barrier poisoned");
    if barrier.open_writes > 0 {
        barrier.open_writes -= 1;
    }
    if barrier.open_writes == 0 {
        barrier.blocked_since = None;
        barrier.warned_stalled = false;
    }
}

fn maybe_warn_stalled_writes(
    observer: &str,
    poll_interval: Duration,
    barrier: &mut EpochBarrierState,
) {
    let Some(blocked_since) = barrier.blocked_since else {
        return;
    };
    if barrier.warned_stalled {
        return;
    }
    let threshold = poll_interval.saturating_mul(5);
    if blocked_since.elapsed() >= threshold {
        eprintln!(
            "[observer] {} open writes have blocked epoch sealing for {:?}",
            observer,
            blocked_since.elapsed()
        );
        barrier.warned_stalled = true;
    }
}

fn enqueue_turn(buffer: &mut Vec<SessionTurn>, turn: SessionTurn) {
    if let Some(existing) = buffer
        .iter_mut()
        .find(|existing| existing.turn_id == turn.turn_id)
    {
        *existing = turn;
    } else {
        buffer.push(turn);
    }
    buffer.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.updated_at.cmp(&right.updated_at))
    });
}

async fn load_committed_epoch(storage: &Storage, observer: &str) -> Result<Option<u64>> {
    Ok(storage
        .observings()
        .list(Some(observer))
        .await?
        .into_iter()
        .map(|observing| observing.checkpoint.observing_epoch)
        .max())
}

async fn flush_epoch_inner(
    storage: &Storage,
    observer: &str,
    threads: &mut Vec<ObservingThread>,
    epoch: u64,
    pending_turns: &[SessionTurn],
) -> Result<usize> {
    ensure_root_thread(threads, observer, pending_turns, epoch);

    let gateway_inputs = active_gateway_inputs(threads, observer);
    let gateway_result = ObservingGateway::route(&gateway_inputs, pending_turns).await?;
    let touched_ids = apply_gateway_updates(
        threads,
        observer,
        pending_turns,
        epoch,
        gateway_result.updates,
    )
    .await?;
    flush_threads(storage, threads, &touched_ids).await?;

    eprintln!(
        "[observer] flushed epoch {} with {} turns",
        epoch,
        pending_turns.len()
    );
    Ok(pending_turns.len())
}

pub(crate) async fn apply_gateway_updates(
    threads: &mut Vec<ObservingThread>,
    observer: &str,
    pending_turns: &[SessionTurn],
    observing_epoch: u64,
    updates: Vec<GatewayUpdate>,
) -> Result<HashSet<String>> {
    let turn_map = pending_turns
        .iter()
        .map(|turn| (turn.turn_id.clone(), turn.clone()))
        .collect::<HashMap<_, _>>();

    let now = Utc::now();
    let mut observe_turns_by_thread = HashMap::<String, HashMap<String, ObservingTurnInput>>::new();
    let mut turn_parent_by_id = HashMap::<String, String>::new();
    let mut touched_ids = HashSet::<String>::new();
    let mut reset_references = HashSet::<String>::new();

    for update in updates {
        let Some(turn) = turn_map.get(&update.turn_id) else {
            continue;
        };
        let observe_turn = ObservingTurnInput {
            turn_id: turn.turn_id.clone(),
            summary: turn_summary(turn),
            why_related: normalize_text(&update.why, 100),
        };

        match update.action {
            GatewayAction::Append => {
                let Some(target_id) = update.observing_id.as_ref() else {
                    continue;
                };
                if threads
                    .iter()
                    .any(|thread| thread.observing_id == *target_id)
                {
                    turn_parent_by_id
                        .entry(turn.turn_id.clone())
                        .or_insert_with(|| target_id.clone());
                    touched_ids.insert(target_id.clone());
                    merge_observing_turn_input(
                        &mut observe_turns_by_thread,
                        target_id.clone(),
                        observe_turn,
                    );
                    if let Some(thread) = threads
                        .iter_mut()
                        .find(|thread| thread.observing_id == *target_id)
                    {
                        if reset_references.insert(target_id.clone()) {
                            thread.reset_references();
                        }
                        thread.push_reference(turn_reference(turn));
                        thread.updated_at = now;
                        thread.observing_epoch = observing_epoch;
                    }
                }
            }
            GatewayAction::New => {
                let Some(new_thread) = update.new_thread.as_ref() else {
                    continue;
                };
                let references = {
                    let mut references = turn_parent_by_id
                        .get(&turn.turn_id)
                        .map(|parent_id| vec![observing_reference(parent_id)])
                        .unwrap_or_default();
                    if !references
                        .iter()
                        .any(|reference| reference == &turn_reference(turn))
                    {
                        references.push(turn_reference(turn));
                    }
                    references
                };
                let thread = ObservingThread::new_seeded(
                    observer,
                    &new_thread.title,
                    &new_thread.summary,
                    references,
                    observing_epoch,
                    now,
                );
                let observing_id = thread.observing_id.clone();
                threads.push(thread);
                touched_ids.insert(observing_id.clone());
                merge_observing_turn_input(
                    &mut observe_turns_by_thread,
                    observing_id,
                    observe_turn,
                );
            }
        }
    }

    let observe_tasks = observe_turns_by_thread
        .into_iter()
        .filter_map(|(observing_id, turns_by_id)| {
            let thread = threads
                .iter()
                .find(|thread| thread.observing_id == observing_id)?;
            Some(PendingObservingTask {
                observing_id,
                input: ObserveRequest {
                    observing_content: thread.current_content(),
                    pending_turns: turns_by_id.into_values().collect::<Vec<_>>(),
                },
            })
        })
        .collect::<Vec<_>>();

    let mut all_touched_ids = touched_ids;
    for task in observe_tasks {
        let result = ObservingUpdater::observe(&task.input).await?;
        apply_observe_result(threads, &task.observing_id, observing_epoch, result)?;
        all_touched_ids.insert(task.observing_id);
    }
    Ok(all_touched_ids)
}

fn apply_observe_result(
    threads: &mut [ObservingThread],
    observing_id: &str,
    observing_epoch: u64,
    result: ObserveResult,
) -> Result<()> {
    let now = Utc::now();
    let Some(thread) = threads
        .iter_mut()
        .find(|thread| thread.observing_id == observing_id)
    else {
        return Err(lance::Error::invalid_input(format!(
            "missing observing thread for observing result: {observing_id}"
        )));
    };
    thread.apply_observe_result(result, observing_epoch, now)
}

fn active_gateway_inputs(
    threads: &[ObservingThread],
    observer: &str,
) -> Vec<ObservingThreadGatewayInput> {
    let now = Utc::now();
    threads
        .iter()
        .filter(|thread| thread.updated_at >= now - chrono::Duration::days(7))
        .filter(|thread| thread.observer == observer)
        .map(|thread| ObservingThreadGatewayInput {
            observing_id: thread.observing_id.clone(),
            title: thread.title.clone(),
            summary: thread.summary.clone(),
        })
        .collect()
}

fn ensure_root_thread(
    threads: &mut Vec<ObservingThread>,
    observer: &str,
    pending_turns: &[SessionTurn],
    observing_epoch: u64,
) {
    let now = Utc::now();
    threads.retain(|thread| thread.updated_at >= now - chrono::Duration::days(7));
    if !threads.is_empty() {
        return;
    }

    let seed = pending_turns
        .iter()
        .filter_map(|turn| turn.summary.as_deref())
        .last()
        .or_else(|| pending_turns.iter().find_map(|turn| turn.prompt.as_deref()))
        .or_else(|| {
            pending_turns
                .iter()
                .find_map(|turn| turn.response.as_deref())
        })
        .unwrap_or("Session root");
    threads.push(ObservingThread::new_seeded(
        observer,
        seed,
        seed,
        Vec::new(),
        observing_epoch,
        now,
    ));
}

fn collect_touched_threads(
    threads: &[ObservingThread],
    ids: &HashSet<String>,
) -> Vec<ObservingThread> {
    threads
        .iter()
        .filter(|thread| ids.contains(&thread.observing_id))
        .cloned()
        .collect()
}

fn merge_observing_turn_input(
    by_session: &mut HashMap<String, HashMap<String, ObservingTurnInput>>,
    observing_id: String,
    input: ObservingTurnInput,
) {
    let turns = by_session.entry(observing_id).or_default();
    turns
        .entry(input.turn_id.clone())
        .and_modify(|existing| {
            if !existing.why_related.contains(&input.why_related) {
                existing.why_related = normalize_text(
                    &format!("{} {}", existing.why_related, input.why_related),
                    180,
                );
            }
        })
        .or_insert(input);
}

fn turn_summary(turn: &SessionTurn) -> String {
    turn.summary.clone().unwrap_or_else(|| {
        turn.prompt
            .clone()
            .or_else(|| turn.response.clone())
            .unwrap_or_default()
    })
}

async fn flush_threads(
    storage: &Storage,
    threads: &mut [ObservingThread],
    touched_ids: &HashSet<String>,
) -> Result<()> {
    let observings = collect_touched_threads(threads, touched_ids)
        .iter()
        .filter(|thread| thread.snapshot_id.is_some())
        .map(ObservingThread::to_row)
        .collect::<Result<Vec<_>>>()?;
    storage.observings().upsert(observings).await?;

    let semantic_config = crate::config::semantic_index_config()?;
    for observing_id in touched_ids {
        let Some(thread) = threads
            .iter_mut()
            .find(|thread| thread.observing_id == *observing_id)
        else {
            continue;
        };
        if let Err(error) = catch_up_index(storage, thread, &semantic_config).await {
            eprintln!(
                "[observer] semantic_index flush failed for {}: {}",
                thread.observing_id, error
            );
        }
    }
    Ok(())
}

async fn catch_up_index(
    storage: &Storage,
    thread: &mut ObservingThread,
    semantic_config: &EmbeddingConfig,
) -> Result<()> {
    let start = thread
        .indexed_snapshot_sequence
        .map(|value| value + 1)
        .unwrap_or(0) as usize;
    if start >= thread.snapshots.len() {
        return Ok(());
    }

    let mut latest_indexed_sequence = thread.indexed_snapshot_sequence;
    for snapshot_index in start..thread.snapshots.len() {
        let current = thread
            .snapshots
            .get(snapshot_index)
            .ok_or_else(|| lance::Error::invalid_input("missing snapshot during index flush"))?;
        let memory_id = thread.snapshot_memory_id(snapshot_index)?;
        apply_memory_delta(storage, current, &memory_id, semantic_config).await?;
        latest_indexed_sequence = Some(snapshot_index as i64);
    }

    if latest_indexed_sequence != thread.indexed_snapshot_sequence {
        if let Some(snapshot_sequence) = latest_indexed_sequence {
            thread.set_indexed_snapshot_sequence(snapshot_sequence);
        }
        if thread.snapshot_id.is_some() {
            storage.observings().upsert(vec![thread.to_row()?]).await?;
        }
    }
    Ok(())
}

pub(crate) async fn apply_memory_delta(
    storage: &Storage,
    current: &SnapshotContent,
    memory_id: &str,
    semantic_config: &EmbeddingConfig,
) -> Result<()> {
    let delta = &current.memory_delta;
    let after_ids = delta
        .after
        .iter()
        .filter_map(|memory| memory.id.clone())
        .collect::<HashSet<_>>();
    let deleted_ids = delta
        .before
        .iter()
        .filter_map(|memory| memory.id.clone())
        .filter(|id| !after_ids.contains(id))
        .collect::<Vec<_>>();
    storage.semantic_index().delete(deleted_ids).await?;

    let upsert_ids = delta
        .after
        .iter()
        .filter_map(|memory| memory.id.clone())
        .collect::<Vec<_>>();
    let existing_rows = storage.semantic_index().load_by_ids(&upsert_ids).await?;
    let existing_by_id = existing_rows
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect::<HashMap<_, _>>();

    let mut upserts = Vec::new();
    for memory in &delta.after {
        let id = memory
            .id
            .as_ref()
            .ok_or_else(|| lance::Error::invalid_input("memory delta upsert missing id"))?;
        let text = memory.text.trim();
        if text.is_empty() {
            continue;
        }
        let vector = embed_text(text).await?;
        let category = memory.category.semantic_index_category().to_string();
        let created_at = existing_by_id
            .get(id)
            .map(|existing| existing.created_at)
            .unwrap_or_else(Utc::now);
        let importance = existing_by_id
            .get(id)
            .map(|existing| existing.importance)
            .unwrap_or(semantic_config.default_importance);
        upserts.push(SemanticIndexRow {
            id: id.clone(),
            memory_id: memory_id.to_string(),
            text: text.to_string(),
            vector,
            importance,
            category,
            created_at,
        });
    }

    storage.semantic_index().upsert(upserts).await
}

fn normalize_text(value: &str, max_chars: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    let mut chars = trimmed.chars();
    let text = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{text}...")
    } else {
        text
    }
}
