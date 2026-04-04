use std::collections::HashMap;

use lance::{Error, Result};

use crate::format::memory::session::TurnMetadataSource;

use super::{SessionKey, has_text_content};

#[derive(Debug, Clone)]
pub(crate) struct SessionUpdate {
    pub(crate) session_id: Option<String>,
    pub(crate) agent: String,
    pub(crate) observer: String,
    pub(crate) title: Option<String>,
    pub(crate) summary: Option<String>,
    pub(crate) title_source: Option<TurnMetadataSource>,
    pub(crate) summary_source: Option<TurnMetadataSource>,
    pub(crate) tool_calling: Option<Vec<String>>,
    pub(crate) artifacts: Option<HashMap<String, String>>,
    pub(crate) prompt: Option<String>,
    pub(crate) response: Option<String>,
}

impl SessionUpdate {
    pub(crate) fn session_key(&self) -> SessionKey {
        SessionKey::from_parts(self.session_id.as_deref(), &self.agent, &self.observer)
    }

    pub(crate) fn title_source(&self) -> Option<TurnMetadataSource> {
        has_text_content(self.title.as_deref())
            .then(|| self.title_source.unwrap_or(TurnMetadataSource::User))
    }

    pub(crate) fn summary_source(&self) -> Option<TurnMetadataSource> {
        has_text_content(self.summary.as_deref())
            .then(|| self.summary_source.unwrap_or(TurnMetadataSource::User))
    }

    pub(crate) fn validate(&self) -> Result<()> {
        let has_content = has_string_list_content(self.tool_calling.as_ref())
            || has_string_map_content(self.artifacts.as_ref())
            || has_text_content(self.prompt.as_deref())
            || has_text_content(self.response.as_deref());

        if has_content {
            Ok(())
        } else {
            Err(Error::invalid_input(
                "turn must include at least one message field",
            ))
        }
    }
}

fn has_string_list_content(value: Option<&Vec<String>>) -> bool {
    value.map(|entries| !entries.is_empty()).unwrap_or(false)
}

fn has_string_map_content(value: Option<&HashMap<String, String>>) -> bool {
    value.map(|entries| !entries.is_empty()).unwrap_or(false)
}
