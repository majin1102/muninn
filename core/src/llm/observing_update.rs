use lance::Result;
use serde::{Deserialize, Serialize};

use crate::format::observing::ObservedMemory;
use crate::llm::config::{LlmTask, observing_max_attempts};
use crate::llm::prompts::{build_observing_system_prompt, build_observing_user_prompt};
use crate::llm::provider::{LlmTextRequest, generate_text};
use crate::observer::types::LlmFieldUpdate;

const MAX_TITLE_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 220;
const MAX_NEXT_STEP_CHARS: usize = 120;
const MAX_MEMORY_CHARS: usize = 220;
const MAX_LIST_ITEM_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize)]
pub struct ObservingContent {
    pub title: String,
    pub summary: String,
    pub memories: Vec<ObservedMemory>,
    pub open_questions: Vec<String>,
    pub next_steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObservingTurnInput {
    pub turn_id: String,
    pub summary: String,
    pub why_related: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObserveRequest {
    pub observing_content: ObservingContent,
    pub pending_turns: Vec<ObservingTurnInput>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ObservingContentUpdate {
    pub title: String,
    pub summary: String,
    pub open_questions: Vec<String>,
    pub next_steps: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ObserveResult {
    pub observing_content_update: ObservingContentUpdate,
    pub memory_delta: LlmFieldUpdate<ObservedMemory>,
}

pub struct ObservingUpdater;

impl ObservingUpdater {
    pub async fn observe(input: &ObserveRequest) -> Result<ObserveResult> {
        let prompt = build_observing_prompt(input)?;
        let mut last_error = "observing update returned no output".to_string();

        let max_attempts = observing_max_attempts()?;

        for attempt in 1..=max_attempts {
            let attempt_prompt = build_retry_prompt(&prompt, attempt, &last_error);
            let text = generate_text(
                LlmTask::Observer,
                LlmTextRequest {
                    system: build_observing_system_prompt(),
                    prompt: attempt_prompt,
                },
            )
            .await?
            .ok_or_else(|| lance::Error::invalid_input("observing update is not configured"))?;

            let parsed = parse_observe_result(&text).ok_or_else(|| {
                lance::Error::invalid_input("observing update did not return valid JSON")
            });

            match parsed.and_then(validate_observe_result) {
                Ok(result) => return Ok(result),
                Err(error) => {
                    last_error = error.to_string();
                }
            }
        }

        Err(lance::Error::invalid_input(format!(
            "observing update returned invalid output after {max_attempts} attempts: {last_error}"
        )))
    }
}

fn build_observing_prompt(input: &ObserveRequest) -> Result<String> {
    let json = serde_json::to_string_pretty(input).map_err(|error| {
        lance::Error::invalid_input(format!("serialize observing input: {error}"))
    })?;
    Ok(build_observing_user_prompt(&json))
}

fn parse_observe_result(raw: &str) -> Option<ObserveResult> {
    serde_json::from_str::<ObserveResult>(raw).ok().or_else(|| {
        let start = raw.find('{')?;
        let end = raw.rfind('}')?;
        serde_json::from_str::<ObserveResult>(&raw[start..=end]).ok()
    })
}

fn validate_observe_result(result: ObserveResult) -> Result<ObserveResult> {
    let title = normalize_text(&result.observing_content_update.title, MAX_TITLE_CHARS);
    if title.is_empty() {
        return Err(lance::Error::invalid_input(
            "observing update returned empty observing_content_update.title",
        ));
    }

    let summary = normalize_text(&result.observing_content_update.summary, MAX_SUMMARY_CHARS);
    if summary.is_empty() {
        return Err(lance::Error::invalid_input(
            "observing update returned empty observing_content_update.summary",
        ));
    }

    let open_questions = normalize_string_list(
        &result.observing_content_update.open_questions,
        MAX_LIST_ITEM_CHARS,
    );
    let next_steps = normalize_string_list(
        &result.observing_content_update.next_steps,
        MAX_NEXT_STEP_CHARS,
    );
    let memories_before = normalize_memory_list(&result.memory_delta.before)?;
    let memories_after = normalize_memory_list(&result.memory_delta.after)?;
    validate_memory_delta(&memories_before, &memories_after)?;

    Ok(ObserveResult {
        observing_content_update: ObservingContentUpdate {
            title,
            summary,
            open_questions,
            next_steps,
        },
        memory_delta: LlmFieldUpdate::new(memories_before, memories_after),
    })
}

fn normalize_memory_list(memories: &[ObservedMemory]) -> Result<Vec<ObservedMemory>> {
    let mut normalized = Vec::new();
    for memory in memories {
        let id = memory
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let text = normalize_text(&memory.text, MAX_MEMORY_CHARS);
        if text.is_empty() {
            return Err(lance::Error::invalid_input(
                "observing update returned an empty memory text",
            ));
        }
        normalized.push(ObservedMemory {
            id,
            text,
            category: memory.category.clone(),
            updated_memory: memory
                .updated_memory
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
        });
    }
    Ok(normalized)
}

fn validate_memory_delta(before: &[ObservedMemory], after: &[ObservedMemory]) -> Result<()> {
    let mut before_ids = std::collections::HashSet::new();
    let mut before_texts = std::collections::HashSet::new();
    for memory in before {
        let Some(id) = memory.id.as_ref() else {
            return Err(lance::Error::invalid_input(
                "observing update returned before memory without id",
            ));
        };
        if !before_ids.insert(id.clone()) {
            return Err(lance::Error::invalid_input(
                "observing update returned duplicate before memory id",
            ));
        }
        if !before_texts.insert(memory.text.clone()) {
            return Err(lance::Error::invalid_input(
                "observing update returned duplicate before memory text",
            ));
        }
    }

    let mut after_ids = std::collections::HashSet::new();
    let mut after_texts = std::collections::HashSet::new();
    for memory in after {
        if !after_texts.insert(memory.text.clone()) {
            return Err(lance::Error::invalid_input(
                "observing update returned duplicate after memory text",
            ));
        }
        if let Some(id) = memory.id.as_ref() {
            if !before_ids.contains(id) {
                return Err(lance::Error::invalid_input(
                    "observing update returned unknown after memory id",
                ));
            }
            if !after_ids.insert(id.clone()) {
                return Err(lance::Error::invalid_input(
                    "observing update returned duplicate after memory id",
                ));
            }
        }
        if let Some(updated_memory) = memory.updated_memory.as_ref() {
            if !before
                .iter()
                .any(|candidate| candidate.text == *updated_memory)
            {
                return Err(lance::Error::invalid_input(
                    "observing update returned updated_memory not found in before",
                ));
            }
        }
    }
    Ok(())
}

fn normalize_string_list(values: &[String], max_chars: usize) -> Vec<String> {
    values
        .iter()
        .map(|value| normalize_text(value, max_chars))
        .filter(|value| !value.is_empty())
        .collect()
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

fn build_retry_prompt(base_prompt: &str, attempt: usize, last_error: &str) -> String {
    if attempt == 1 {
        return base_prompt.to_string();
    }

    format!(
        "{base_prompt}\n\nPrevious output was invalid.\nValidation error: {last_error}\nReturn one JSON object only. Keep all required content fields and memory_delta arrays present."
    )
}

#[cfg(test)]
mod tests {
    use crate::format::observing::MemoryCategory;

    use super::*;

    #[test]
    fn parses_embedded_observe_json() {
        let parsed = parse_observe_result(
            "```json\n{\"observing_content_update\":{\"title\":\"observer\",\"summary\":\"summary\",\"open_questions\":[],\"next_steps\":[]},\"memory_delta\":{\"before\":[],\"after\":[{\"text\":\"fact\",\"category\":\"Fact\"}]}}\n```",
        )
        .expect("observing json should parse");

        assert_eq!(parsed.observing_content_update.title, "observer");
        assert_eq!(parsed.memory_delta.after.len(), 1);
    }

    #[test]
    fn validate_observe_result_rejects_empty_title() {
        let error = validate_observe_result(ObserveResult {
            observing_content_update: ObservingContentUpdate {
                title: " ".to_string(),
                summary: "summary".to_string(),
                open_questions: vec![],
                next_steps: vec![],
            },
            memory_delta: LlmFieldUpdate::new(vec![], vec![]),
        })
        .unwrap_err();

        assert!(error.to_string().contains("observing_content_update.title"));
    }

    #[test]
    fn validate_observe_result_normalizes_memory_delta() {
        let normalized = validate_observe_result(ObserveResult {
            observing_content_update: ObservingContentUpdate {
                title: " observer ".to_string(),
                summary: " summary ".to_string(),
                open_questions: vec![" q2 ".to_string()],
                next_steps: vec![" do next ".to_string()],
            },
            memory_delta: LlmFieldUpdate::new(
                vec![ObservedMemory {
                    id: Some("MEM-1".to_string()),
                    text: " old fact ".to_string(),
                    category: MemoryCategory::Fact,
                    updated_memory: Some(" old fact ".to_string()),
                }],
                vec![ObservedMemory {
                    id: None,
                    text: " new fact ".to_string(),
                    category: MemoryCategory::Fact,
                    updated_memory: None,
                }],
            ),
        })
        .expect("observing result should validate");

        assert_eq!(normalized.observing_content_update.title, "observer");
        assert_eq!(
            normalized.memory_delta.before[0].updated_memory,
            Some("old fact".to_string())
        );
        assert_eq!(normalized.observing_content_update.open_questions[0], "q2");
        assert_eq!(normalized.observing_content_update.next_steps[0], "do next");
    }

    #[test]
    fn validate_observe_result_normalizes_empty_lists() {
        let normalized = validate_observe_result(ObserveResult {
            observing_content_update: ObservingContentUpdate {
                title: "observer".to_string(),
                summary: "summary".to_string(),
                open_questions: vec![" q1 ".to_string(), " ".to_string()],
                next_steps: vec![" ".to_string()],
            },
            memory_delta: LlmFieldUpdate::new(vec![], vec![]),
        })
        .expect("observing result should validate");

        assert_eq!(
            normalized.observing_content_update.open_questions,
            vec!["q1"]
        );
        assert!(normalized.observing_content_update.next_steps.is_empty());
    }
}
