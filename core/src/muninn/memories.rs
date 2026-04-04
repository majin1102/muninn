use super::*;

impl Memories<'_> {
    pub async fn recall(&self, recall: MemoryRecall) -> Result<Vec<RecallHit>> {
        memory_memories::recall(self.muninn.table_options(), &recall.text, recall.limit).await
    }

    pub async fn list(&self, mode: ListMode) -> Result<Vec<MemoryView>> {
        memory_memories::list(self.muninn.table_options(), mode).await
    }

    pub async fn get(&self, memory_id: &str) -> Result<Option<MemoryView>> {
        memory_memories::get(self.muninn.table_options(), memory_id).await
    }

    pub async fn timeline(&self, timeline: MemoryTimeline) -> Result<Vec<MemoryView>> {
        memory_memories::timeline(
            self.muninn.table_options(),
            &timeline.memory_id,
            timeline.before_limit,
            timeline.after_limit,
        )
        .await
    }
}
