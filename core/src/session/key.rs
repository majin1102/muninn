#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum SessionKey {
    Session {
        session_id: String,
        agent: String,
        observer: String,
    },
    Agent {
        agent: String,
        observer: String,
    },
    Observer {
        observer: String,
    },
}

impl SessionKey {
    pub(crate) fn from(session_id: Option<&str>, agent: &str, observer: &str) -> Self {
        if let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) {
            return Self::Session {
                session_id: session_id.to_string(),
                agent: agent.to_string(),
                observer: observer.to_string(),
            };
        }
        if !agent.trim().is_empty() {
            return Self::Agent {
                agent: agent.to_string(),
                observer: observer.to_string(),
            };
        }
        Self::Observer {
            observer: observer.to_string(),
        }
    }

    pub(crate) fn same_group_as(&self, other: &Self) -> bool {
        self == other
    }
}
