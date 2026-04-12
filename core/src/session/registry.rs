use std::sync::Arc;

use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use lance::Result;

use crate::format::{SessionTable, TableOptions};

use super::{Session, SessionKey};

pub(crate) struct SessionRegistry {
    table: Arc<SessionTable>,
    sessions: DashMap<SessionKey, Arc<Session>>,
}

impl SessionRegistry {
    const SESSION_TTL_SECS: i64 = 2 * 60 * 60;

    pub(crate) fn new(options: TableOptions) -> Self {
        Self {
            table: Arc::new(SessionTable::new(options)),
            sessions: DashMap::new(),
        }
    }

    pub(crate) async fn load(&self, key: SessionKey) -> Result<Arc<Session>> {
        self.evict_expired();

        if let Some(session) = self.sessions.get(&key) {
            let session = Arc::clone(session.value());
            session.touch();
            return Ok(session);
        }

        let open_turn = self
            .table
            .load_open_turn_for(key.session_id(), key.agent(), key.observer())
            .await?;
        let created = Arc::new(Session::new(
            key.clone(),
            Arc::clone(&self.table),
            open_turn,
        )?);
        created.touch();

        match self.sessions.entry(key) {
            Entry::Occupied(entry) => {
                let session = Arc::clone(entry.get());
                session.touch();
                Ok(session)
            }
            Entry::Vacant(entry) => {
                entry.insert(Arc::clone(&created));
                Ok(created)
            }
        }
    }

    fn evict_expired(&self) {
        let expired = self
            .sessions
            .iter()
            .filter_map(|entry| entry.value().expired(Self::SESSION_TTL_SECS).then(|| entry.key().clone()))
            .collect::<Vec<_>>();
        for key in expired {
            self.sessions.remove(&key);
        }
    }
}
