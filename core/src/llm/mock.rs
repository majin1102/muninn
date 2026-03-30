use async_trait::async_trait;
use lance::Result;
use serde_json::{Value, json};

use crate::llm::provider::{LlmProvider, LlmTextRequest};

pub struct MockLlmProvider;

#[async_trait]
impl LlmProvider for MockLlmProvider {
    async fn generate_text(&self, request: LlmTextRequest) -> Result<String> {
        if request
            .system
            .contains("routing gateway for an observing memory system")
        {
            return Ok(mock_gateway_output(&request.prompt));
        }
        if request.system.contains("\"memory_delta\"") {
            return Ok(mock_observe_output(&request.prompt));
        }

        let seed = extract_block(&request.prompt, "User request:", "Final response:")
            .filter(|value| !value.trim().is_empty())
            .or_else(|| extract_labeled_value(&request.prompt, "Final response:"))
            .unwrap_or_else(|| request.prompt.trim());
        if request.system.contains("Return exactly one JSON object") {
            if request.system.contains("must have only:") && request.system.contains("\"title\"") {
                return Ok(json!({
                    "title": format!("Mock title: {}", excerpt(seed)),
                })
                .to_string());
            }
            return Ok(json!({
                "title": "Mock summary",
                "summary": format!("Mock summary: {}", excerpt(seed)),
            })
            .to_string());
        }
        Ok(format!("Mock summary: {}", excerpt(seed)))
    }
}

fn mock_gateway_output(prompt: &str) -> String {
    let input = extract_input_json(prompt);
    let first_session_id = input
        .get("observing_threads")
        .and_then(Value::as_array)
        .and_then(|threads| threads.first())
        .and_then(|thread| thread.get("observing_id"))
        .and_then(Value::as_str)
        .unwrap_or("OBS-1");

    let updates = input
        .get("pending_turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|turn| {
            let turn_id = turn
                .get("turn_id")
                .and_then(Value::as_str)
                .unwrap_or("TURN-1");
            let summary = turn
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("mock routed update");
            json!({
                "turn_id": turn_id,
                "action": "append",
                "observing_id": first_session_id,
                "summary": format!("Mock routed: {}", excerpt(summary)),
                "new_thread": null,
                "why": format!("Relevant to {}", first_session_id),
            })
        })
        .collect::<Vec<_>>();

    json!({ "updates": updates }).to_string()
}

fn mock_observe_output(prompt: &str) -> String {
    let input = extract_input_json(prompt);
    let session_state = input
        .get("observing_content")
        .cloned()
        .unwrap_or(Value::Null);
    let current_title = session_state
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Mock observing thread");
    let current_summary = session_state
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("Mock observing summary");
    let before_open_questions = session_state
        .get("open_questions")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));

    let first_turn = input
        .get("pending_turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.first())
        .cloned()
        .unwrap_or(Value::Null);
    let turn_summary = first_turn
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("mock observe update");
    let why_related = first_turn
        .get("why_related")
        .and_then(Value::as_str)
        .unwrap_or("mock relevance");

    let after_memories = vec![json!({
        "text": format!("{}", excerpt(turn_summary)),
        "category": "Fact"
    })];

    let after_open_questions = before_open_questions
        .as_array()
        .cloned()
        .unwrap_or_default();

    json!({
        "observing_content_update": {
            "title": current_title,
            "summary": format!("{} {}", excerpt(current_summary), excerpt(turn_summary)).trim(),
            "open_questions": after_open_questions,
            "next_steps": [format!("Follow up: {}", excerpt(why_related))]
        },
        "memory_delta": {
            "before": [],
            "after": after_memories
        }
    })
    .to_string()
}

fn extract_input_json(prompt: &str) -> Value {
    let start = prompt.find('{');
    let end = prompt.rfind('}');
    match (start, end) {
        (Some(start), Some(end)) if start <= end => {
            serde_json::from_str::<Value>(&prompt[start..=end]).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

fn extract_labeled_value<'a>(input: &'a str, label: &str) -> Option<&'a str> {
    input
        .lines()
        .find_map(|line| line.strip_prefix(label))
        .map(str::trim)
}

fn extract_block<'a>(input: &'a str, start_label: &str, end_label: &str) -> Option<&'a str> {
    let start = input.find(start_label)? + start_label.len();
    let rest = &input[start..];
    let end = rest.find(end_label).unwrap_or(rest.len());
    Some(rest[..end].trim())
}

fn excerpt(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let excerpt = chars.by_ref().take(80).collect::<String>();
    if chars.next().is_some() {
        format!("{excerpt}...")
    } else {
        excerpt
    }
}
