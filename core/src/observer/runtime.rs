use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use chrono::Utc;
use lance::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::format::{
    ObservingTable, SemanticIndexRow, SemanticIndexTable, SessionTable, SessionTurn, TableOptions,
};
use crate::llm::config::{EmbeddingConfig, effective_observer_name};
use crate::llm::embedding::embed_text;
use crate::llm::observing::{
    GatewayAction, GatewayUpdate, ObservingGateway, ObservingThreadGatewayInput,
};
use crate::llm::observing_update::{
    ObserveRequest, ObserveResult, ObservingTurnInput, ObservingUpdater,
};
use crate::observer::thread::{
    ObservingThread, SnapshotContent, load_threads, turn_ref,
};
#[cfg(test)]
use crate::observer::types::ObserverWatermark;

fn observer_singleton() -> &'static Mutex<Option<Observer>> {
    static INSTANCE: OnceLock<Mutex<Option<Observer>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone)]
struct PendingObservingTask {
    observing_id: String,
    input: ObserveRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingIndexBatch {
    turns: Vec<SessionTurn>,
    observing_ids: HashSet<String>,
}

#[derive(Debug)]
struct Window {
    epoch: u64,
    observing_epoch: Option<u64>,
    session_writers: usize,
    buffer: Vec<SessionTurn>,
    observing_buffer: Vec<SessionTurn>,
    blocked_since: Option<Instant>,
    warned_stalled: bool,
    flushing: bool,
}

#[derive(Debug)]
struct ObserverTask {
    cancel: CancellationToken,
    task: StdMutex<Option<JoinHandle<()>>>,
}

pub(crate) struct ObservingWindow {
    observer: Observer,
    epoch: u64,
    completed: bool,
}

impl ObservingWindow {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn observer(&self) -> &str {
        &self.observer.name
    }

    pub(crate) async fn include(&self, turn: SessionTurn) {
        self.observer.include_turn(turn).await;
    }

    pub(crate) fn complete(mut self) {
        self.completed = true;
        self.observer.release_session_writer();
    }
}

impl Drop for ObservingWindow {
    fn drop(&mut self) {
        if !self.completed {
            self.observer.release_session_writer();
        }
    }
}

#[derive(Clone)]
pub struct Observer {
    table_options: TableOptions,
    name: String,
    window: Arc<StdMutex<Window>>,
    committed_epoch: Arc<Mutex<Option<u64>>>,
    threads: Arc<Mutex<Vec<ObservingThread>>>,
    index_batches: Arc<Mutex<Vec<PendingIndexBatch>>>,
    shutdown: Arc<AtomicBool>,
    task: Arc<ObserverTask>,
}

impl Observer {
    pub async fn new(table_options: TableOptions) -> Result<Self> {
        let observer_name = effective_observer_name()?;
        let mut singleton = observer_singleton().lock().await;
        if let Some(observer) = singleton.as_ref().cloned() {
            if !observer.is_shutdown().await
                && observer.name == observer_name
                && observer.table_options.matches(&table_options)
            {
                return Ok(observer);
            }
            observer.shutdown(true).await;
        }

        let observer = Self::build(table_options, observer_name).await?;
        *singleton = Some(observer.clone());
        Ok(observer)
    }

    async fn build(table_options: TableOptions, observer: String) -> Result<Self> {
        let semantic_config = crate::config::semantic_index_config()?;
        let mut threads = load_threads(&table_options, &observer).await?;
        for thread in &mut threads {
            if let Err(error) = catch_up_index(&table_options, thread, &semantic_config).await {
                eprintln!(
                    "[observer] semantic_index catch-up failed for {}: {}",
                    thread.observing_id, error
                );
            }
        }
        let index_batches = restore_index_batches(&table_options, &observer, &threads).await?;

        let committed_epoch = load_committed_epoch(&table_options, &observer).await?;
        let mut inbox = session_table(&table_options)
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
                let repaired_turns = inbox.clone();
                session_table(&table_options)
                    .update(&repaired_turns)
                    .await?;
                inbox = repaired_turns;
            }
        }

        let observer = Self {
            table_options,
            name: observer,
            window: Arc::new(StdMutex::new(Window {
                epoch: next_epoch(committed_epoch),
                observing_epoch: None,
                session_writers: 0,
                buffer: inbox,
                observing_buffer: Vec::new(),
                blocked_since: None,
                warned_stalled: false,
                flushing: false,
            })),
            committed_epoch: Arc::new(Mutex::new(committed_epoch)),
            threads: Arc::new(Mutex::new(threads)),
            index_batches: Arc::new(Mutex::new(index_batches)),
            shutdown: Arc::new(AtomicBool::new(false)),
            task: Arc::new(ObserverTask {
                cancel: CancellationToken::new(),
                task: StdMutex::new(None),
            }),
        };
        Ok(observer)
    }

    pub async fn shutdown(&self, wait: bool) {
        self.shutdown.store(true, Ordering::Relaxed);
        self.task.shutdown(wait).await;
    }

    pub(crate) fn window(&self) -> ObservingWindow {
        let mut window = self.window.lock().expect("observer window poisoned");
        let epoch = window.epoch;
        window.session_writers += 1;
        if window.session_writers == 1 {
            window.blocked_since = Some(Instant::now());
            window.warned_stalled = false;
        }
        ObservingWindow {
            observer: self.clone(),
            epoch,
            completed: false,
        }
    }

    async fn include_turn(&self, turn: SessionTurn) {
        if !turn.observable() || self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let mut window = self.window.lock().expect("observer window poisoned");
        enqueue_turn(&mut window.buffer, turn);
    }

    #[cfg(test)]
    pub async fn watermark(&self) -> Result<ObserverWatermark> {
        let observing_epoch = {
            self.window
                .lock()
                .expect("observer window poisoned")
                .observing_epoch
        };
        let committed_epoch = *self.committed_epoch.lock().await;
        let index_batches = self.index_batches.lock().await.clone();
        let pending = {
            let window = self.window.lock().expect("observer window poisoned");
            collect_pending(&window, &index_batches)
        };
        let pending_turn_ids = pending
            .iter()
            .map(|turn| turn.turn_id.to_string())
            .collect::<Vec<_>>();
        Ok(ObserverWatermark {
            resolved: pending.is_empty(),
            pending_turn_ids,
            observing_epoch,
            committed_epoch,
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn flush_epoch(&self) -> Result<usize> {
        flush_epoch_with(self).await
    }

    pub(crate) async fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn shares_task_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.task, &other.task)
    }

    #[cfg(test)]
    pub(crate) async fn task_stopped(&self) -> bool {
        self.task.is_shutdown().await
    }

    #[cfg(test)]
    pub(crate) async fn snapshot(&self) -> Result<Vec<SessionTurn>> {
        let window = self.window.lock().expect("observer window poisoned");
        let mut turns = window.observing_buffer.clone();
        turns.extend(window.buffer.clone());
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
        self.threads.lock().await.clone()
    }
}

impl Observer {
    fn release_session_writer(&self) {
        let mut window = self.window.lock().expect("observer window poisoned");
        if window.session_writers > 0 {
            window.session_writers -= 1;
        }
        if window.session_writers == 0 {
            window.blocked_since = None;
            window.warned_stalled = false;
        }
        drop(window);
        self.schedule_task_if_ready();
    }

    fn schedule_task_if_ready(&self) {
        if self.shutdown.load(Ordering::Relaxed) || self.task.is_running() {
            return;
        }

        {
            let mut window = self.window.lock().expect("observer window poisoned");
            if window.session_writers > 0 {
                maybe_warn_stalled_writers(&self.name, &mut window);
                return;
            }
            if window.flushing || window.buffer.is_empty() {
                return;
            }
        }

        self.task.spawn(self.clone());
    }
}

impl ObserverTask {
    fn spawn(&self, observer: Observer) {
        if self.cancel.is_cancelled() {
            return;
        }
        self.clear_finished();
        let mut slot = self.task.lock().expect("observer task poisoned");
        if slot.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }

        let cancel = self.cancel.clone();
        *slot = Some(tokio::spawn(async move {
            loop {
                if cancel.is_cancelled() {
                    break;
                }
                match flush_epoch_with(&observer).await {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(error) => {
                        eprintln!("[observer] flush task failed: {}", error);
                        break;
                    }
                }
            }
        }));
    }

    fn clear_finished(&self) {
        let mut slot = self.task.lock().expect("observer task poisoned");
        if slot.as_ref().is_some_and(|task| task.is_finished()) {
            *slot = None;
        }
    }

    fn is_running(&self) -> bool {
        self.clear_finished();
        self.task.lock().expect("observer task poisoned").is_some()
    }

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
        self.clear_finished();
        self.task
            .lock()
            .expect("observer task poisoned")
            .is_none()
            && self.cancel.is_cancelled()
        }
}

impl Drop for ObserverTask {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn flush_epoch_with(
    observer: &Observer,
) -> Result<usize> {
    if observer.shutdown.load(Ordering::Relaxed) {
        return Ok(0);
    }

    enum FlushWork {
        Idle,
        RetryIndexBatches,
        FlushTurns { epoch: u64, turns: Vec<SessionTurn> },
    }

    let has_batches = !observer.index_batches.lock().await.is_empty();
    let work = {
        let mut window = observer.window.lock().expect("observer window poisoned");
        if window.flushing {
            return Ok(0);
        }
        if window.observing_buffer.is_empty() && window.buffer.is_empty() {
            if !has_batches {
                FlushWork::Idle
            } else {
                window.flushing = true;
                FlushWork::RetryIndexBatches
            }
        } else {
            if window.session_writers > 0 {
                maybe_warn_stalled_writers(&observer.name, &mut window);
                return Ok(0);
            }
            if window.observing_buffer.is_empty() {
                window.observing_epoch = Some(window.epoch);
                window.observing_buffer = std::mem::take(&mut window.buffer);
            }
            let Some(epoch) = window.observing_epoch else {
                return Ok(0);
            };
            if window.observing_buffer.is_empty() {
                window.observing_epoch = None;
                FlushWork::Idle
            } else {
                window.flushing = true;
                FlushWork::FlushTurns {
                    epoch,
                    turns: window.observing_buffer.clone(),
                }
            }
        }
    };

    match work {
        FlushWork::Idle => Ok(0),
        FlushWork::RetryIndexBatches => {
            let mut threads = observer.threads.lock().await;
            let mut batches = observer.index_batches.lock().await;
            let result = retry_index_batches(&observer.table_options, &mut threads, &mut batches).await;
            drop(batches);
            drop(threads);
            observer
                .window
                .lock()
                .expect("observer window poisoned")
                .flushing = false;
            result.map(|_| 0)
        }
        FlushWork::FlushTurns { epoch, turns } => {
            let mut threads = observer.threads.lock().await;
            let result = flush_epoch_inner(
                &observer.table_options,
                &observer.name,
                &mut threads,
                epoch,
                &turns,
            )
            .await;
            drop(threads);

            match result {
                Ok(failed_index_ids) => {
                    {
                        let mut committed_epoch = observer.committed_epoch.lock().await;
                        *committed_epoch = Some(epoch);
                    }
                    if !failed_index_ids.is_empty() {
                        let mut batches = observer.index_batches.lock().await;
                        push_index_batch(&mut batches, turns.clone(), failed_index_ids);
                    }
                    {
                        let mut window = observer.window.lock().expect("observer window poisoned");
                        window.observing_epoch = None;
                        window.observing_buffer.clear();
                        window.epoch += 1;
                        window.flushing = false;
                    }
                    observer.schedule_task_if_ready();
                    Ok(turns.len())
                }
                Err(error) => {
                    observer
                        .window
                        .lock()
                        .expect("observer window poisoned")
                        .flushing = false;
                    Err(error)
                }
            }
        }
    }
}

fn next_epoch(committed_epoch: Option<u64>) -> u64 {
    committed_epoch.map(|epoch| epoch + 1).unwrap_or(0)
}

fn maybe_warn_stalled_writers(name: &str, window: &mut Window) {
    let Some(blocked_since) = window.blocked_since else {
        return;
    };
    if window.warned_stalled {
        return;
    }
    let threshold = Duration::from_secs(5);
    if blocked_since.elapsed() >= threshold {
        eprintln!(
            "[observer] {} session writers have blocked window flush for {:?}",
            name,
            blocked_since.elapsed()
        );
        window.warned_stalled = true;
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

#[cfg(test)]
fn collect_pending(window: &Window, index_batches: &[PendingIndexBatch]) -> Vec<SessionTurn> {
    let mut turns_by_id = HashMap::new();
    for turn in window
        .observing_buffer
        .iter()
        .chain(window.buffer.iter())
        .chain(index_batches.iter().flat_map(|batch| batch.turns.iter()))
    {
        turns_by_id
            .entry(turn.turn_id)
            .and_modify(|existing: &mut SessionTurn| {
                if turn.updated_at > existing.updated_at {
                    *existing = turn.clone();
                }
            })
            .or_insert_with(|| turn.clone());
    }

    let mut pending = turns_by_id.into_values().collect::<Vec<_>>();
    pending.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.updated_at.cmp(&right.updated_at))
            .then(left.turn_id.cmp(&right.turn_id))
    });
    pending
}

fn thread_has_pending_index(thread: &ObservingThread) -> bool {
    let latest_snapshot_sequence = thread
        .snapshots
        .len()
        .checked_sub(1)
        .map(|value| value as i64);
    match (thread.indexed_snapshot_sequence, latest_snapshot_sequence) {
        (_, None) => false,
        (Some(indexed), Some(latest)) => indexed < latest,
        (None, Some(_)) => true,
    }
}

async fn restore_index_batches(
    table_options: &TableOptions,
    observer: &str,
    threads: &[ObservingThread],
) -> Result<Vec<PendingIndexBatch>> {
    let mut observing_ids_by_epoch = HashMap::<u64, HashSet<String>>::new();
    for thread in threads
        .iter()
        .filter(|thread| thread_has_pending_index(thread))
    {
        observing_ids_by_epoch
            .entry(thread.observing_epoch)
            .or_default()
            .insert(thread.observing_id.clone());
    }
    if observing_ids_by_epoch.is_empty() {
        return Ok(Vec::new());
    }

    let epochs = observing_ids_by_epoch
        .keys()
        .copied()
        .collect::<HashSet<_>>();
    let turns = session_table(table_options)
        .turns_for_observing_epochs(observer, &epochs)
        .await?;
    let mut turns_by_epoch = HashMap::<u64, Vec<SessionTurn>>::new();
    for turn in turns {
        let Some(epoch) = turn.observing_epoch else {
            continue;
        };
        turns_by_epoch.entry(epoch).or_default().push(turn);
    }

    let mut index_batches = Vec::new();
    let mut pending_epochs = observing_ids_by_epoch.into_iter().collect::<Vec<_>>();
    pending_epochs.sort_by_key(|(epoch, _)| *epoch);
    for (epoch, observing_ids) in pending_epochs {
        let Some(turns) = turns_by_epoch.remove(&epoch) else {
            continue;
        };
        push_index_batch(&mut index_batches, turns, observing_ids);
    }
    Ok(index_batches)
}

async fn load_committed_epoch(table_options: &TableOptions, observer: &str) -> Result<Option<u64>> {
    Ok(observing_table(table_options)
        .list(Some(observer))
        .await?
        .into_iter()
        .map(|observing| observing.checkpoint.observing_epoch)
        .max())
}

async fn flush_epoch_inner(
    table_options: &TableOptions,
    observer: &str,
    threads: &mut Vec<ObservingThread>,
    epoch: u64,
    pending_turns: &[SessionTurn],
) -> Result<HashSet<String>> {
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
    let failed_index_ids = flush_threads(table_options, threads, &touched_ids).await?;

    eprintln!(
        "[observer] flushed epoch {} with {} turns",
        epoch,
        pending_turns.len()
    );
    Ok(failed_index_ids)
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
    let mut touched_ids = HashSet::<String>::new();

    for update in updates {
        let Ok(turn_id) = update.turn_id.parse() else {
            continue;
        };
        let Some(turn) = turn_map.get(&turn_id) else {
            continue;
        };
        let observe_turn = ObservingTurnInput {
            turn_id: turn.turn_id.to_string(),
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
                        thread.push_reference(turn_ref(turn));
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
                    let mut references = Vec::new();
                    if !references
                        .iter()
                        .any(|reference| reference == &turn_ref(turn))
                    {
                        references.push(turn_ref(turn));
                    }
                    references
                };
                let thread = ObservingThread::new(
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
    threads.push(ObservingThread::new(
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
    table_options: &TableOptions,
    threads: &mut [ObservingThread],
    touched_ids: &HashSet<String>,
) -> Result<HashSet<String>> {
    let mut observings = collect_touched_threads(threads, touched_ids)
        .iter()
        .filter(|thread| !thread.snapshots.is_empty())
        .map(ObservingThread::to_row)
        .collect::<Result<Vec<_>>>()?;
    let persisted_ids = observings
        .iter()
        .map(|observing| observing.observing_id.clone())
        .collect::<HashSet<_>>();
    observing_table(table_options).insert(&mut observings).await?;
    let mut observings_by_id = observings
        .into_iter()
        .map(|observing| (observing.observing_id.clone(), observing))
        .collect::<HashMap<_, _>>();
    for thread in threads
        .iter_mut()
        .filter(|thread| persisted_ids.contains(&thread.observing_id))
    {
        let Some(observing) = observings_by_id.remove(&thread.observing_id) else {
            return Err(lance::Error::invalid_input(format!(
                "missing persisted observing row for {} after flush",
                thread.observing_id
            )));
        };
        thread.snapshot_id = Some(observing.snapshot_id.clone());
        if thread.snapshot_ids.last() != Some(&observing.snapshot_id) {
            thread.snapshot_ids.push(observing.snapshot_id.clone());
        }
        thread.references = observing.references.clone();
        thread.indexed_snapshot_sequence = observing.checkpoint.indexed_snapshot_sequence;
        thread.observing_epoch = observing.checkpoint.observing_epoch;
        thread.updated_at = observing.updated_at;
    }

    let semantic_config = crate::config::semantic_index_config()?;
    let mut failed_index_ids = HashSet::new();
    for observing_id in touched_ids {
        let Some(thread) = threads
            .iter_mut()
            .find(|thread| thread.observing_id == *observing_id)
        else {
            continue;
        };
        if let Err(error) = catch_up_index(table_options, thread, &semantic_config).await {
            eprintln!(
                "[observer] semantic_index flush failed for {}: {}",
                thread.observing_id, error
            );
            failed_index_ids.insert(thread.observing_id.clone());
        }
    }
    Ok(failed_index_ids)
}

fn push_index_batch(
    batches: &mut Vec<PendingIndexBatch>,
    turns: Vec<SessionTurn>,
    observing_ids: HashSet<String>,
) {
    if turns.is_empty() || observing_ids.is_empty() {
        return;
    }
    batches.push(PendingIndexBatch {
        turns,
        observing_ids,
    });
}

async fn retry_index_batches(
    table_options: &TableOptions,
    threads: &mut [ObservingThread],
    batches: &mut Vec<PendingIndexBatch>,
) -> Result<()> {
    if batches.is_empty() {
        return Ok(());
    }

    let semantic_config = crate::config::semantic_index_config()?;
    for batch in batches.iter_mut() {
        batch.observing_ids = retry_index_batch(
            table_options,
            threads,
            &batch.observing_ids,
            &semantic_config,
        )
        .await?;
    }
    batches.retain(|batch| !batch.observing_ids.is_empty());
    Ok(())
}

async fn retry_index_batch(
    table_options: &TableOptions,
    threads: &mut [ObservingThread],
    observing_ids: &HashSet<String>,
    semantic_config: &EmbeddingConfig,
) -> Result<HashSet<String>> {
    let mut failed_ids = HashSet::new();
    for observing_id in observing_ids {
        let Some(thread) = threads
            .iter_mut()
            .find(|thread| thread.observing_id == *observing_id)
        else {
            continue;
        };
        if let Err(error) = catch_up_index(table_options, thread, semantic_config).await {
            eprintln!(
                "[observer] semantic_index retry failed for {}: {}",
                thread.observing_id, error
            );
            failed_ids.insert(thread.observing_id.clone());
        }
    }
    Ok(failed_ids)
}

async fn catch_up_index(
    table_options: &TableOptions,
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
        let memory_id = thread.snapshot_ref(snapshot_index)?;
        apply_memory_delta(table_options, current, &memory_id, semantic_config).await?;
        latest_indexed_sequence = Some(snapshot_index as i64);
    }

    if latest_indexed_sequence != thread.indexed_snapshot_sequence {
        if let Some(snapshot_sequence) = latest_indexed_sequence {
            thread.set_indexed_snapshot_sequence(snapshot_sequence);
        }
        if thread.snapshot_id.is_some() {
            let observings = vec![thread.to_row()?];
            observing_table(table_options)
                .update(&observings)
                .await?;
        }
    }
    Ok(())
}

pub(crate) async fn apply_memory_delta(
    table_options: &TableOptions,
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
    semantic_index_table(table_options)
        .delete(deleted_ids)
        .await?;

    let upsert_ids = delta
        .after
        .iter()
        .filter_map(|memory| memory.id.clone())
        .collect::<Vec<_>>();
    let existing_rows = semantic_index_table(table_options)
        .load_by_ids(&upsert_ids)
        .await?;
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

    semantic_index_table(table_options).upsert(upserts).await
}

fn session_table(table_options: &TableOptions) -> SessionTable {
    SessionTable::new(table_options.to_owned())
}

fn observing_table(table_options: &TableOptions) -> ObservingTable {
    ObservingTable::new(table_options.to_owned())
}

fn semantic_index_table(table_options: &TableOptions) -> SemanticIndexTable {
    SemanticIndexTable::new(table_options.to_owned())
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
