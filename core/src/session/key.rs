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

    pub(crate) fn session_id(&self) -> Option<&str> {
        match self {
            Self::Session { session_id, .. } => Some(session_id),
            Self::Agent { .. } | Self::Observer { .. } => None,
        }
    }

    pub(crate) fn agent(&self) -> &str {
        match self {
            Self::Session { agent, .. } | Self::Agent { agent, .. } => agent,
            Self::Observer { .. } => "",
        }
    }

    pub(crate) fn observer(&self) -> &str {
        match self {
            Self::Session { observer, .. }
            | Self::Agent { observer, .. }
            | Self::Observer { observer } => observer,
        }
    }
}
