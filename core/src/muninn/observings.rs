use super::*;

impl Observings<'_> {
    pub async fn list(&self, list: ObservingList) -> Result<Vec<ObservingSnapshot>> {
        memory_observings::list(
            self.muninn.table_options(),
            ObservingListQuery {
                mode: list.mode,
                observer: list.observer,
            },
        )
        .await
    }

    pub async fn get(&self, memory_id: &str) -> Result<Option<ObservingSnapshot>> {
        memory_observings::get(self.muninn.table_options(), &memory_id.parse()?).await
    }
}
