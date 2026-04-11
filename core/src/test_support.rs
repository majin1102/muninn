#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
use lance::Result;

#[cfg(test)]
use crate::observer::runtime::Observer;
#[cfg(test)]
use crate::session::SessionRegistry;
#[cfg(test)]
use crate::{TableOptions, session::SessionKey};

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct TurnContent {
    pub session_id: Option<String>,
    pub agent: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tool_calling: Option<Vec<String>>,
    pub artifacts: Option<HashMap<String, String>>,
    pub prompt: Option<String>,
    pub response: Option<String>,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestService {
    observer: Observer,
    session_registry: Arc<SessionRegistry>,
}

#[cfg(test)]
impl TestService {
    pub(crate) async fn new(table_options: TableOptions) -> Result<Self> {
        Ok(Self {
            observer: Observer::new(table_options.clone()).await?,
            session_registry: Arc::new(SessionRegistry::new(table_options)),
        })
    }

    pub(crate) async fn accept(&self, turn_content: TurnContent) -> Result<()> {
        let observer = crate::llm::config::effective_observer_name()?;
        let key = SessionKey::from(
            turn_content.session_id.as_deref(),
            &turn_content.agent,
            &observer,
        );
        let window = self.observer.window();
        let session = self.session_registry.load(key).await?;
        let turn = session.accept(turn_content, &window).await?;
        window.include(turn).await;
        window.complete();
        Ok(())
    }
}
