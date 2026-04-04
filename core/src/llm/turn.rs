use lance::Result;
use serde::Deserialize;

use crate::llm::config::{DEFAULT_TITLE_MAX_CHARS, LlmTask, task_config};
use crate::llm::prompts::{build_turn_system_prompt, build_turn_user_prompt};
use crate::llm::provider::{LlmTextRequest, generate_text};

pub struct TurnGenerator;
const MAX_SUMMARY_CHARS: usize = 1000;
#[cfg(test)]
const AGENT_CONCLUSION_CHARS: usize = 120;
#[cfg(test)]
const AGENT_STATUS_CHARS: usize = 100;
#[cfg(test)]
const AGENT_NEXT_CHARS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnOutput {
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Deserialize)]
struct RawTurnOutput {
    summary: String,
}

impl TurnGenerator {
    pub async fn generate_if_configured(
        prompt: Option<&str>,
        response: &str,
    ) -> Result<Option<TurnOutput>> {
        if response.trim().is_empty() {
            return Ok(None);
        }

        let prompt = prompt.filter(|value| !value.trim().is_empty());
        let Some(prompt) = prompt else {
            return Ok(None);
        };
        let config = task_config(LlmTask::Turn)?;
        let title_max_chars = config
            .as_ref()
            .map(|config| config.title_max_chars)
            .unwrap_or(DEFAULT_TITLE_MAX_CHARS);

        if let Some(config) = config {
            if should_use_llm_summary(Some(prompt), response, config.llm_summary_threshold_chars) {
                match generate_text(
                    LlmTask::Turn,
                    LlmTextRequest {
                        system: build_turn_system_prompt(),
                        prompt: build_turn_user_prompt(Some(prompt), response),
                    },
                )
                .await
                {
                    Ok(Some(raw)) => {
                        if let Some(output) =
                            parse_turn_output(raw, Some(prompt), response, config.title_max_chars)
                        {
                            return Ok(Some(output));
                        }
                    }
                    Ok(None) | Err(_) => {}
                }
            }
        }

        Ok(build_local_turn(Some(prompt), response, title_max_chars))
    }
}

fn should_use_llm_summary(prompt: Option<&str>, response: &str, threshold_chars: usize) -> bool {
    prompt.unwrap_or("").trim().chars().count() + response.trim().chars().count() >= threshold_chars
}

fn build_direct_summary(prompt: Option<&str>, response: &str) -> Option<String> {
    let prompt = prompt?.trim();
    let response = response.trim();
    if prompt.is_empty() || response.is_empty() {
        return None;
    }
    Some(format!("{prompt}\n\n{response}"))
}

fn build_local_turn(
    prompt: Option<&str>,
    response: &str,
    title_max_chars: usize,
) -> Option<TurnOutput> {
    let summary = build_direct_summary(prompt, response)?;
    let title = derive_local_title(prompt, Some(&summary), response, title_max_chars)?;
    Some(TurnOutput { title, summary })
}

#[cfg(test)]
fn normalize_agent_source(response: &str) -> String {
    let normalized = normalize_text_field(response.to_string(), 260, false).unwrap_or_default();
    if normalized.is_empty() {
        return "Conclusion: none Status: none Next: none".to_string();
    }
    if normalized.contains("Conclusion:")
        && normalized.contains("Status:")
        && normalized.contains("Next:")
    {
        return normalized;
    }

    let (conclusion, remainder) = split_sentence(&normalized);
    let (status, next) = split_status_and_next(remainder);

    format!(
        "Conclusion: {} Status: {} Next: {}",
        truncate_chars(conclusion.trim(), AGENT_CONCLUSION_CHARS),
        truncate_chars(status.trim(), AGENT_STATUS_CHARS),
        truncate_chars(next.trim(), AGENT_NEXT_CHARS),
    )
}

#[cfg(test)]
fn split_sentence(text: &str) -> (&str, &str) {
    let boundary = ['。', '！', '？', '.', '!', '?', ';', '；']
        .iter()
        .filter_map(|marker| text.find(*marker))
        .min()
        .unwrap_or(text.len());
    let head = text[..boundary].trim();
    let tail = text[boundary..].trim_matches(['。', '！', '？', '.', '!', '?', ';', '；', ' ']);
    (if head.is_empty() { text.trim() } else { head }, tail)
}

#[cfg(test)]
fn split_status_and_next(text: &str) -> (&str, &str) {
    if text.is_empty() {
        return ("none", "none");
    }
    if let Some(index) = find_next_step_marker(text) {
        let (status, next) = text.split_at(index);
        let next = trim_next_marker(next);
        let status = status.trim().trim_end_matches(['。', '；', ';', ' ']);
        return (
            if status.is_empty() { "none" } else { status },
            if next.is_empty() { "none" } else { next },
        );
    }
    (text.trim(), "none")
}

#[cfg(test)]
fn find_next_step_marker(text: &str) -> Option<usize> {
    const MARKERS: &[&str] = &["下一步", "后续", "接下来", "next"];
    let lower = text.to_lowercase();
    MARKERS
        .iter()
        .filter_map(|marker| lower.find(&marker.to_lowercase()))
        .min()
}

#[cfg(test)]
fn trim_next_marker(text: &str) -> &str {
    text.trim()
        .trim_start_matches("下一步")
        .trim_start_matches("后续")
        .trim_start_matches("接下来")
        .trim_start_matches("Next")
        .trim_start_matches("next")
        .trim_start_matches(':')
        .trim()
}

fn parse_turn_output(
    raw: String,
    prompt: Option<&str>,
    response: &str,
    title_max_chars: usize,
) -> Option<TurnOutput> {
    let parsed = parse_raw_turn_output(&raw);
    let fallback_summary = build_fallback_summary(prompt, response);
    let summary = parsed
        .as_ref()
        .and_then(|value| normalize_summary(value.summary.clone(), prompt, response))
        .or_else(|| normalize_summary(raw.clone(), prompt, response))
        .or_else(|| normalize_text_field(fallback_summary.clone(), MAX_SUMMARY_CHARS, false))?;
    let title = derive_local_title(prompt, Some(&summary), response, title_max_chars)?;
    Some(TurnOutput { title, summary })
}

fn parse_raw_turn_output(raw: &str) -> Option<RawTurnOutput> {
    serde_json::from_str::<RawTurnOutput>(raw).ok().or_else(|| {
        let start = raw.find('{')?;
        let end = raw.rfind('}')?;
        serde_json::from_str::<RawTurnOutput>(&raw[start..=end]).ok()
    })
}

fn normalize_text_field(
    raw: String,
    max_chars: usize,
    trim_trailing_punct: bool,
) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut trimmed = collapsed.trim().to_string();
    if trim_trailing_punct {
        trimmed = trimmed
            .trim_end_matches([
                '。', '！', '？', '.', '!', '?', ';', '；', ':', '：', ',', '，', ' ',
            ])
            .trim()
            .to_string();
    }
    let trimmed = truncate_chars(&trimmed, max_chars);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn normalize_title(raw: String, max_chars: usize) -> Option<String> {
    normalize_text_field(raw, max_chars, true)
}

fn normalize_summary(raw: String, prompt: Option<&str>, response: &str) -> Option<String> {
    let normalized = normalize_text_field(raw, MAX_SUMMARY_CHARS, false)?;
    let has_user = normalized.contains("User:");
    let has_agent = normalized.contains("Agent:");
    if has_user && has_agent {
        return Some(normalized);
    }
    if !has_user && !has_agent {
        return Some(build_fallback_summary(prompt, response));
    }
    let user_text = excerpt(prompt.unwrap_or(""), 400);
    let agent_text = if has_agent {
        normalized
            .split_once("Agent:")
            .map(|(_, tail)| tail.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| excerpt(response, 400))
    } else {
        excerpt(response, 400)
    };
    let summary = format!(
        "User: {} Agent: {}",
        default_user_text(&user_text),
        agent_text
    );
    normalize_text_field(summary, MAX_SUMMARY_CHARS, false)
}

fn build_fallback_summary(prompt: Option<&str>, response: &str) -> String {
    build_direct_summary(prompt, response).unwrap_or_else(|| excerpt(response, 400))
}

fn default_user_text(user_text: &str) -> String {
    if user_text.trim().is_empty() {
        "No explicit user request captured.".to_string()
    } else {
        user_text.to_string()
    }
}

fn derive_title_from_summary(summary: &str, max_chars: usize) -> Option<String> {
    let source = summary
        .strip_prefix("User:")
        .map(str::trim)
        .and_then(|text| text.split("Agent:").next())
        .unwrap_or(summary)
        .trim();
    if source.is_empty() {
        return None;
    }
    let boundary = [
        '。', '！', '？', '.', '!', '?', ';', '；', ':', '：', ',', '，',
    ]
    .iter()
    .filter_map(|marker| source.find(*marker))
    .min()
    .unwrap_or(source.len());
    normalize_title(source[..boundary].trim().to_string(), max_chars)
}

fn derive_local_title(
    prompt: Option<&str>,
    summary: Option<&str>,
    response: &str,
    max_chars: usize,
) -> Option<String> {
    normalize_title(prompt.unwrap_or("").trim().to_string(), max_chars)
        .or_else(|| summary.and_then(|value| derive_title_from_summary(value, max_chars)))
        .or_else(|| normalize_title(excerpt(response, max_chars), max_chars))
}

fn excerpt(value: &str, max_chars: usize) -> String {
    truncate_chars(value.trim(), max_chars)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let excerpt = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() && max_chars > 3 {
        format!(
            "{}...",
            excerpt.chars().take(max_chars - 3).collect::<String>()
        )
    } else {
        excerpt
    }
}

#[cfg(test)]
mod tests {
    use super::{
        TurnGenerator, build_direct_summary, derive_local_title, normalize_agent_source,
        parse_turn_output, should_use_llm_summary,
    };
    use crate::llm::config::{llm_test_env_guard, write_test_muninn_config};

    #[tokio::test]
    async fn generate_without_provider_keeps_turn_optional() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let summary = TurnGenerator::generate_if_configured(None, "response")
            .await
            .unwrap();
        assert_eq!(summary, None);
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[tokio::test]
    async fn short_turn_uses_direct_summary_and_local_title() {
        let _guard = llm_test_env_guard();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("muninn-home");
        std::fs::create_dir_all(&home).unwrap();
        let config_path = home.join(crate::llm::config::CONFIG_FILE_NAME);
        write_test_muninn_config(&config_path, Some("mock"), None, None);
        unsafe {
            std::env::set_var("MUNINN_HOME", &home);
        }
        let generated = TurnGenerator::generate_if_configured(
            Some("以后默认中文回答，不要 type hints。"),
            "已记录这些偏好。下一步无。",
        )
        .await
        .unwrap()
        .expect("configured provider should return a turn");
        assert_eq!(generated.title, "以后默认中文回答，不要 type hints");
        assert_eq!(
            generated.summary,
            "以后默认中文回答，不要 type hints。\n\n已记录这些偏好。下一步无。"
        );
        unsafe {
            std::env::remove_var("MUNINN_HOME");
        }
    }

    #[test]
    fn turn_over_threshold_uses_llm_summary_path() {
        assert!(should_use_llm_summary(
            Some(&"A".repeat(500)),
            "已确认。",
            500
        ));
        assert!(should_use_llm_summary(
            Some("短 prompt"),
            &"B".repeat(498),
            500
        ));
        assert!(!should_use_llm_summary(Some("短 prompt"), "已确认。", 500));
    }

    #[test]
    fn direct_summary_joins_prompt_and_response() {
        let summary = build_direct_summary(
            Some("排查 recall 不一致问题"),
            "已确认 list 仍走旧分支。当前未修复。下一步补 layer-aware 测试。",
        )
        .expect("summary should exist");
        assert_eq!(
            summary,
            "排查 recall 不一致问题\n\n已确认 list 仍走旧分支。当前未修复。下一步补 layer-aware 测试。"
        );
    }

    #[test]
    fn normalize_agent_source_splits_status_and_next() {
        let normalized = normalize_agent_source(
            "已确认 list 仍走旧分支。当前未修复。下一步补 layer-aware 测试。",
        );
        assert!(normalized.contains("Conclusion:"), "{normalized}");
        assert!(normalized.contains("Status:"), "{normalized}");
        assert!(normalized.contains("Next:"), "{normalized}");
    }

    #[test]
    fn local_title_prefers_prompt_excerpt() {
        let title = derive_local_title(
            Some("OpenViking recall 方案已确定，并继续补 timeline 测试。"),
            Some("User: prompt Agent: response"),
            "response",
            100,
        )
        .expect("title should exist");
        assert_eq!(
            title,
            "OpenViking recall 方案已确定，并继续补 timeline 测试"
        );
    }

    #[test]
    fn parse_turn_output_falls_back_to_prompt_and_response_when_json_is_missing() {
        let generated = parse_turn_output(
            "plain text without json".to_string(),
            Some("以后默认中文回答，不要 type hints。"),
            "已记录这些偏好，后续回答会遵守。",
            100,
        )
        .expect("fallback output should exist");

        assert!(generated.title.contains("以后默认中文回答"));
        assert_eq!(
            generated.summary,
            "以后默认中文回答，不要 type hints。\n\n已记录这些偏好，后续回答会遵守。"
        );
    }

    #[test]
    fn parse_turn_output_derives_title_from_summary_when_title_is_empty() {
        let generated = parse_turn_output(
            r#"{"title":"   ","summary":"User: OpenViking recall 阈值和 prompt 已重新约束。 Agent: 已完成 turn 命名统一，下一步补评测模块。"}"#.to_string(),
            Some("原始 prompt"),
            "原始 response",
            100,
        )
        .expect("generated output should exist");

        assert_eq!(generated.title, "原始 prompt");
        assert!(generated.summary.contains("Agent: 已完成 turn 命名统一"));
    }

    #[test]
    fn parse_turn_output_repairs_missing_user_section() {
        let generated = parse_turn_output(
            r#"{"title":"Observing turn","summary":"Agent: 已定位到 observing dataset append 缺失，下一步补 list 和 recall 验证。"}"#.to_string(),
            Some("排查 observing 为什么在 sidecar 和 UI 上读不到。"),
            "已定位到 observing dataset append 缺失，下一步补 list 和 recall 验证。",
            100,
        )
        .expect("generated output should exist");

        assert!(
            generated
                .summary
                .starts_with("User: 排查 observing 为什么在 sidecar 和 UI 上读不到。 Agent:")
        );
        assert!(
            generated
                .summary
                .contains("已定位到 observing dataset append 缺失")
        );
    }

    #[test]
    fn parse_turn_output_truncates_overlong_fields() {
        let long_title = "A".repeat(120);
        let long_summary = format!("User: {} Agent: {}", "B".repeat(900), "C".repeat(900));
        let raw = format!(r#"{{"title":"{long_title}","summary":"{long_summary}"}}"#);
        let generated = parse_turn_output(raw, Some("prompt"), "response", 100)
            .expect("generated output should exist");

        assert!(generated.title.chars().count() <= 100, "{generated:?}");
        assert!(generated.summary.chars().count() <= 1000, "{generated:?}");
    }
}
