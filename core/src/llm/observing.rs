use lance::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

use crate::format::memory::session::SessionTurn;
use crate::llm::config::{LlmTask, observing_max_attempts};
use crate::llm::prompts::{
    build_observing_gateway_system_prompt, build_observing_gateway_user_prompt,
};
use crate::llm::provider::{LlmTextRequest, generate_text};

#[derive(Debug, Clone, Serialize)]
pub struct ObservingThreadGatewayInput {
    pub observing_id: String,
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnGatewayInput {
    pub turn_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
struct GatewayInput {
    observing_threads: Vec<ObservingThreadGatewayInput>,
    pending_turns: Vec<TurnGatewayInput>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GatewayAction {
    Append,
    New,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct NewThreadHint {
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct GatewayUpdate {
    pub turn_id: String,
    pub action: GatewayAction,
    pub observing_id: Option<String>,
    pub summary: String,
    pub new_thread: Option<NewThreadHint>,
    pub why: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct GatewayResult {
    pub updates: Vec<GatewayUpdate>,
}

pub struct ObservingGateway;

impl ObservingGateway {
    pub async fn route(
        observing_threads: &[ObservingThreadGatewayInput],
        pending_turns: &[SessionTurn],
    ) -> Result<GatewayResult> {
        let pending_turns = pending_turns
            .iter()
            .map(|turn| TurnGatewayInput {
                turn_id: turn.turn_id.to_string(),
                summary: turn.summary.clone().unwrap_or_else(|| {
                    turn.prompt
                        .clone()
                        .or_else(|| turn.response.clone())
                        .unwrap_or_default()
                }),
            })
            .collect::<Vec<_>>();
        let input = GatewayInput {
            observing_threads: observing_threads.to_vec(),
            pending_turns: pending_turns.clone(),
        };
        let prompt = build_observing_gateway_prompt(&input)?;
        let mut last_error = "observer gateway returned no output".to_string();

        let max_attempts = observing_max_attempts()?;

        for attempt in 1..=max_attempts {
            let attempt_prompt = build_retry_prompt(&prompt, attempt, &last_error);
            let text = generate_text(
                LlmTask::Observer,
                LlmTextRequest {
                    system: build_observing_gateway_system_prompt(),
                    prompt: attempt_prompt,
                },
            )
            .await?
            .ok_or_else(|| lance::Error::invalid_input("observer gateway is not configured"))?;

            let parsed = parse_gateway_result(&text).ok_or_else(|| {
                lance::Error::invalid_input("observer gateway did not return valid JSON")
            });

            match parsed.and_then(|value| validate_gateway_result(&input, value)) {
                Ok(result) => return Ok(result),
                Err(error) => {
                    last_error = error.to_string();
                }
            }
        }

        Err(lance::Error::invalid_input(format!(
            "observer gateway returned invalid output after {max_attempts} attempts: {last_error}"
        )))
    }
}

fn validate_gateway_result(input: &GatewayInput, result: GatewayResult) -> Result<GatewayResult> {
    let valid_turn_ids = input
        .pending_turns
        .iter()
        .map(|turn| turn.turn_id.as_str())
        .collect::<HashSet<_>>();
    let valid_thread_ids = input
        .observing_threads
        .iter()
        .map(|thread| thread.observing_id.as_str())
        .collect::<HashSet<_>>();

    let mut updates = Vec::new();
    let mut covered_turn_ids = HashSet::new();

    for update in result.updates {
        let turn_id = update.turn_id.trim().to_string();
        if !valid_turn_ids.contains(turn_id.as_str()) {
            return Err(lance::Error::invalid_input(format!(
                "observer gateway referenced unknown turn_id: {}",
                update.turn_id
            )));
        }

        let summary = normalize_text(&update.summary, 220);
        if summary.is_empty() {
            return Err(lance::Error::invalid_input(format!(
                "observer gateway returned empty summary for turn_id: {turn_id}"
            )));
        }

        let why = normalize_text(&update.why, 100);
        if why.is_empty() {
            return Err(lance::Error::invalid_input(format!(
                "observer gateway returned empty why for turn_id: {turn_id}"
            )));
        }
        let normalized = match update.action {
            GatewayAction::Append => {
                if update.new_thread.is_some() {
                    return Err(lance::Error::invalid_input(format!(
                        "observer gateway returned append update with new_thread for turn_id: {turn_id}"
                    )));
                }
                let observing_id = update
                    .observing_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| valid_thread_ids.contains(*value))
                    .map(ToOwned::to_owned);
                let Some(observing_id) = observing_id else {
                    return Err(lance::Error::invalid_input(format!(
                        "observer gateway returned invalid append target for turn_id: {turn_id}"
                    )));
                };
                GatewayUpdate {
                    turn_id: turn_id.clone(),
                    action: GatewayAction::Append,
                    observing_id: Some(observing_id),
                    summary,
                    new_thread: None,
                    why,
                }
            }
            GatewayAction::New => {
                if update
                    .observing_id
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                {
                    return Err(lance::Error::invalid_input(format!(
                        "observer gateway returned new update with observing_id for turn_id: {turn_id}"
                    )));
                }
                let Some(new_thread) = update.new_thread else {
                    return Err(lance::Error::invalid_input(format!(
                        "observer gateway returned new update without new_thread for turn_id: {turn_id}"
                    )));
                };
                let title = normalize_text(&new_thread.title, 120);
                let new_summary = normalize_text(&new_thread.summary, 220);
                if title.is_empty() || new_summary.is_empty() {
                    return Err(lance::Error::invalid_input(format!(
                        "observer gateway returned incomplete new thread payload for turn_id: {turn_id}"
                    )));
                }
                GatewayUpdate {
                    turn_id: turn_id.clone(),
                    action: GatewayAction::New,
                    observing_id: None,
                    summary,
                    new_thread: Some(NewThreadHint {
                        title,
                        summary: new_summary,
                    }),
                    why,
                }
            }
        };
        covered_turn_ids.insert(turn_id);
        updates.push(normalized);
    }

    if updates.is_empty() && !input.pending_turns.is_empty() {
        return Err(lance::Error::invalid_input(
            "observer gateway returned no valid updates",
        ));
    }

    let missing_turn_ids = input
        .pending_turns
        .iter()
        .filter_map(|turn| {
            (!covered_turn_ids.contains(turn.turn_id.as_str())).then(|| turn.turn_id.clone())
        })
        .collect::<Vec<_>>();
    if !missing_turn_ids.is_empty() {
        return Err(lance::Error::invalid_input(format!(
            "observer gateway omitted pending turns: {}",
            missing_turn_ids.join(", ")
        )));
    }

    Ok(GatewayResult { updates })
}

fn build_observing_gateway_prompt(input: &GatewayInput) -> Result<String> {
    let json = serde_json::to_string_pretty(input).map_err(|error| {
        lance::Error::invalid_input(format!("serialize observer input: {error}"))
    })?;
    Ok(build_observing_gateway_user_prompt(&json))
}

fn parse_gateway_result(raw: &str) -> Option<GatewayResult> {
    serde_json::from_str::<GatewayResult>(raw).ok().or_else(|| {
        let start = raw.find('{')?;
        let end = raw.rfind('}')?;
        serde_json::from_str::<GatewayResult>(&raw[start..=end]).ok()
    })
}

fn build_retry_prompt(base_prompt: &str, attempt: usize, last_error: &str) -> String {
    if attempt == 1 {
        return base_prompt.to_string();
    }

    format!(
        "{base_prompt}\n\nPrevious output was invalid.\nValidation error: {last_error}\nReturn one JSON object only. Make sure every pending turn_id appears in at least one update."
    )
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

pub fn new_observing_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gateway_result_accepts_embedded_json() {
        let parsed = parse_gateway_result(
            "```json\n{\"updates\":[{\"turn_id\":\"TURN-1\",\"action\":\"new\",\"observing_id\":null,\"summary\":\"topic\",\"new_thread\":{\"title\":\"topic\",\"summary\":\"topic\"},\"why\":\"independent\"}]}\n```",
        )
        .expect("gateway json should parse");

        assert_eq!(parsed.updates.len(), 1);
        assert_eq!(parsed.updates[0].turn_id, "TURN-1");
    }

    #[test]
    fn validate_rejects_invalid_existing_session() {
        let input = GatewayInput {
            observing_threads: vec![ObservingThreadGatewayInput {
                observing_id: "OBS-1".to_string(),
                title: "title".to_string(),
                summary: "summary".to_string(),
            }],
            pending_turns: vec![TurnGatewayInput {
                turn_id: "TURN-1".to_string(),
                summary: "summary".to_string(),
            }],
        };

        let error = validate_gateway_result(
            &input,
            GatewayResult {
                updates: vec![GatewayUpdate {
                    turn_id: "TURN-1".to_string(),
                    action: GatewayAction::Append,
                    observing_id: Some("OBS-X".to_string()),
                    summary: "topic".to_string(),
                    new_thread: None,
                    why: "reason".to_string(),
                }],
            },
        )
        .unwrap_err();

        assert!(error.to_string().contains("invalid append target"));
    }

    #[test]
    fn validate_rejects_missing_turns() {
        let input = GatewayInput {
            observing_threads: vec![ObservingThreadGatewayInput {
                observing_id: "OBS-1".to_string(),
                title: "title".to_string(),
                summary: "summary".to_string(),
            }],
            pending_turns: vec![TurnGatewayInput {
                turn_id: "TURN-1".to_string(),
                summary: "summary".to_string(),
            }],
        };

        let error = validate_gateway_result(&input, GatewayResult { updates: vec![] }).unwrap_err();
        assert!(error.to_string().contains("no valid updates"));
    }

    #[test]
    fn validate_keeps_multiple_updates_for_same_turn() {
        let input = GatewayInput {
            observing_threads: vec![ObservingThreadGatewayInput {
                observing_id: "OBS-1".to_string(),
                title: "title".to_string(),
                summary: "summary".to_string(),
            }],
            pending_turns: vec![TurnGatewayInput {
                turn_id: "TURN-1".to_string(),
                summary: "summary".to_string(),
            }],
        };

        let result = validate_gateway_result(
            &input,
            GatewayResult {
                updates: vec![
                    GatewayUpdate {
                        turn_id: "TURN-1".to_string(),
                        action: GatewayAction::Append,
                        observing_id: Some("OBS-1".to_string()),
                        summary: "summary".to_string(),
                        new_thread: None,
                        why: "reason".to_string(),
                    },
                    GatewayUpdate {
                        turn_id: "TURN-1".to_string(),
                        action: GatewayAction::New,
                        observing_id: None,
                        summary: "branch".to_string(),
                        new_thread: Some(NewThreadHint {
                            title: "title".to_string(),
                            summary: "summary".to_string(),
                        }),
                        why: "independent".to_string(),
                    },
                ],
            },
        )
        .expect("gateway result should validate");

        assert_eq!(result.updates.len(), 2);
    }

    #[test]
    fn gateway_result_is_normalized() {
        let input = GatewayInput {
            observing_threads: vec![ObservingThreadGatewayInput {
                observing_id: "OBS-1".to_string(),
                title: "title".to_string(),
                summary: "summary".to_string(),
            }],
            pending_turns: vec![TurnGatewayInput {
                turn_id: "TURN-1".to_string(),
                summary: "summary".to_string(),
            }],
        };

        let result = validate_gateway_result(
            &input,
            GatewayResult {
                updates: vec![GatewayUpdate {
                    turn_id: " TURN-1 ".to_string(),
                    action: GatewayAction::Append,
                    observing_id: Some(" OBS-1 ".to_string()),
                    summary: " summary ".to_string(),
                    new_thread: None,
                    why: " reason ".to_string(),
                }],
            },
        )
        .expect("gateway result should normalize");

        assert_eq!(result.updates[0].turn_id, "TURN-1");
        assert_eq!(result.updates[0].summary, "summary");
        assert_eq!(result.updates[0].why, "reason");
    }
}
