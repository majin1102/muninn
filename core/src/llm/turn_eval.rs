use std::collections::BTreeSet;

use crate::llm::prompts::{MAX_TURN_SUMMARY_CHARS, MAX_TURN_TITLE_CHARS};
use crate::llm::turn::TurnOutput;

const MIN_USER_SECTION_CHARS: usize = 24;
const PREFERENCE_MARKERS: &[&str] = &["默认", "prefer", "偏好", "以后", "先给结论", "default"];
const CONSTRAINT_MARKERS: &[&str] = &[
    "不要", "不能", "禁止", "必须", "only", "avoid", "约束", "限制",
];
const STATUS_MARKERS: &[&str] = &["已", "确认", "完成", "修复", "定位", "当前", "状态", "风险"];
const NEXT_STEP_MARKERS: &[&str] = &["下一步", "接下来", "后续", "待", "继续", "should", "next"];
const REASONING_FILLER_MARKERS: &[&str] = &[
    "详细分析",
    "一步一步",
    "总体来看",
    "需要注意的是",
    "可以看到",
    "说明",
    "因此我们可以",
    "整体而言",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnEvaluationIssue {
    pub code: &'static str,
    pub message: String,
    pub penalty: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnEvaluation {
    pub score: u8,
    pub passed: bool,
    pub issues: Vec<TurnEvaluationIssue>,
}

pub fn evaluate_turn_output(
    prompt: Option<&str>,
    response: &str,
    output: &TurnOutput,
) -> TurnEvaluation {
    let mut issues = Vec::new();

    if output.title.trim().is_empty() {
        issues.push(issue("title.empty", "title must not be empty", 40));
    }
    if output.title.contains('\n') {
        issues.push(issue("title.newline", "title should stay on one line", 15));
    }
    if output.title.chars().count() > MAX_TURN_TITLE_CHARS {
        issues.push(issue(
            "title.too_long",
            format!("title exceeds {} characters", MAX_TURN_TITLE_CHARS),
            15,
        ));
    }
    if is_vague_title(&output.title) {
        issues.push(issue(
            "title.vague",
            "title is too vague for retrieval; include topic, action, or status",
            12,
        ));
    }

    if output.summary.trim().is_empty() {
        issues.push(issue("summary.empty", "summary must not be empty", 40));
    }
    if output.summary.contains('\n') {
        issues.push(issue(
            "summary.newline",
            "summary should stay on one line",
            10,
        ));
    }
    if output.summary.chars().count() > MAX_TURN_SUMMARY_CHARS {
        issues.push(issue(
            "summary.too_long",
            format!("summary exceeds {} characters", MAX_TURN_SUMMARY_CHARS),
            15,
        ));
    }

    let (user_section, agent_section) = match split_summary_sections(&output.summary) {
        Some(sections) => sections,
        None => {
            issues.push(issue(
                "summary.structure",
                "summary must follow the `User: ... Agent: ...` structure",
                30,
            ));
            ("", "")
        }
    };

    if user_section.chars().count() < MIN_USER_SECTION_CHARS {
        issues.push(issue(
            "summary.user_too_short",
            "user section is too short to preserve the user's request and constraints",
            12,
        ));
    }
    if agent_section.trim().is_empty() {
        issues.push(issue(
            "summary.agent_missing",
            "agent section must capture the reply-side result or status",
            16,
        ));
    }
    if !agent_section.trim().is_empty()
        && agent_section.chars().count() > user_section.chars().count()
    {
        issues.push(issue(
            "summary.agent_too_long",
            "agent section is too dominant; user-side memory should remain the primary signal",
            8,
        ));
    }

    let prompt_tokens = salient_tokens(prompt.unwrap_or(""));
    if !prompt_tokens.is_empty() && overlap_count(user_section, &prompt_tokens) == 0 {
        issues.push(issue(
            "summary.user_not_grounded",
            "user section does not retain recognizable prompt facts or terms",
            18,
        ));
    }
    if contains_any(prompt.unwrap_or(""), PREFERENCE_MARKERS)
        && !contains_any(user_section, PREFERENCE_MARKERS)
    {
        issues.push(issue(
            "summary.user_preference_missing",
            "prompt contains user preferences, but the user section does not preserve them clearly",
            12,
        ));
    }
    if contains_any(prompt.unwrap_or(""), CONSTRAINT_MARKERS)
        && !contains_any(user_section, CONSTRAINT_MARKERS)
    {
        issues.push(issue(
            "summary.user_constraint_missing",
            "prompt contains constraints or prohibitions, but the user section does not preserve them clearly",
            12,
        ));
    }

    let response_tokens = salient_tokens(response);
    if !response_tokens.is_empty() && overlap_count(agent_section, &response_tokens) == 0 {
        issues.push(issue(
            "summary.agent_not_grounded",
            "agent section does not retain recognizable response facts or terms",
            10,
        ));
    }
    if contains_any(response, STATUS_MARKERS) && !contains_any(agent_section, STATUS_MARKERS) {
        issues.push(issue(
            "summary.agent_status_missing",
            "response contains status or conclusion signals, but the agent section does not preserve them clearly",
            10,
        ));
    }
    if contains_any(response, NEXT_STEP_MARKERS) && !contains_any(agent_section, NEXT_STEP_MARKERS)
    {
        issues.push(issue(
            "summary.agent_next_step_missing",
            "response contains next-step guidance, but the agent section does not preserve it clearly",
            10,
        ));
    }
    if contains_any(agent_section, REASONING_FILLER_MARKERS) {
        issues.push(issue(
            "summary.agent_reasoning_filler",
            "agent section still includes process-heavy filler instead of only conclusions, status, blockers, and next steps",
            8,
        ));
    }

    let total_penalty = issues.iter().map(|item| item.penalty as u16).sum::<u16>();
    let score = 100u8.saturating_sub(total_penalty.min(100) as u8);
    TurnEvaluation {
        score,
        passed: score >= 70,
        issues,
    }
}

fn issue(code: &'static str, message: impl Into<String>, penalty: u8) -> TurnEvaluationIssue {
    TurnEvaluationIssue {
        code,
        message: message.into(),
        penalty,
    }
}

fn split_summary_sections(summary: &str) -> Option<(&str, &str)> {
    let user_text = summary.strip_prefix("User:")?.trim();
    let (user, agent) = user_text.split_once("Agent:")?;
    Some((user.trim(), agent.trim()))
}

fn is_vague_title(title: &str) -> bool {
    let normalized = title.trim().to_lowercase();
    let vague = [
        "technical discussion",
        "analysis",
        "summary",
        "conversation",
        "讨论",
        "分析",
        "总结",
        "技术讨论",
        "一次对话",
        "需求分析",
        "问题分析",
    ];
    vague.iter().any(|item| normalized == *item)
}

fn salient_tokens(text: &str) -> BTreeSet<String> {
    text.split(|ch: char| {
        !(ch.is_alphanumeric() || ch == '_' || ch == '/' || ch == '-' || ch == '.')
    })
    .filter_map(|token| {
        let normalized = token.trim().to_lowercase();
        let char_len = normalized.chars().count();
        if char_len >= 3 || contains_non_ascii(&normalized) {
            Some(normalized)
        } else {
            None
        }
    })
    .collect()
}

fn overlap_count(text: &str, tokens: &BTreeSet<String>) -> usize {
    let haystack = text.to_lowercase();
    tokens
        .iter()
        .filter(|token| haystack.contains(token.as_str()))
        .count()
}

fn contains_non_ascii(value: &str) -> bool {
    value.chars().any(|ch| !ch.is_ascii())
}

fn contains_any(text: &str, markers: &[&str]) -> bool {
    let normalized = text.to_lowercase();
    markers
        .iter()
        .any(|marker| normalized.contains(&marker.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::evaluate_turn_output;
    use crate::llm::turn::TurnOutput;

    #[test]
    fn strong_turn_output_scores_well() {
        let output = TurnOutput {
            title: "OpenViking recall prompt 与评测方案已确定".to_string(),
            summary: "User: 需要把 turn 的 title 和 summary 提示词收紧到 recall 场景，并补评测与单测，重点保留用户约束、事实和后续可执行信息。 Agent: 已将 turn 链统一命名，补了 normalize 和 fallback，并规划规则评测器和 fixture 扩展，下一步继续接 live provider 采样。".to_string(),
        };
        let evaluation = evaluate_turn_output(
            Some("需要把 turn 的 title 和 summary 提示词收紧到 recall 场景，并补评测与单测。"),
            "已将 turn 链统一命名，补了 normalize 和 fallback，并规划规则评测器和 fixture 扩展。",
            &output,
        );
        assert!(evaluation.passed, "{evaluation:?}");
        assert!(evaluation.score >= 80, "{evaluation:?}");
    }

    #[test]
    fn weak_turn_output_is_flagged() {
        let output = TurnOutput {
            title: "分析".to_string(),
            summary: "简单总结".to_string(),
        };
        let evaluation = evaluate_turn_output(
            Some("以后默认中文回答，不要 type hints。"),
            "可以，我会这样做。",
            &output,
        );
        assert!(!evaluation.passed, "{evaluation:?}");
        assert!(evaluation.score < 70, "{evaluation:?}");
        assert!(
            evaluation
                .issues
                .iter()
                .any(|item| item.code == "summary.structure")
        );
        assert!(
            evaluation
                .issues
                .iter()
                .any(|item| item.code == "title.vague")
        );
    }

    #[test]
    fn missing_user_preferences_and_constraints_are_flagged() {
        let output = TurnOutput {
            title: "代码风格要求已记录".to_string(),
            summary: "User: 需要处理代码改动。 Agent: 已记录需求，后续会继续推进。".to_string(),
        };
        let evaluation = evaluate_turn_output(
            Some("以后默认中文回答，不要 type hints，代码改动优先用 apply_patch。"),
            "已记录这些偏好，后续会默认中文并避免主动引入 type hints。",
            &output,
        );
        assert!(
            evaluation
                .issues
                .iter()
                .any(|item| item.code == "summary.user_preference_missing")
        );
        assert!(
            evaluation
                .issues
                .iter()
                .any(|item| item.code == "summary.user_constraint_missing")
        );
    }

    #[test]
    fn missing_agent_status_and_next_step_are_flagged() {
        let output = TurnOutput {
            title: "recall 问题排查".to_string(),
            summary: "User: 排查 recall 在 detail 和 list/timeline 上的不一致。 Agent: 我做了详细分析，整体而言问题比较复杂。".to_string(),
        };
        let evaluation = evaluate_turn_output(
            Some("排查 recall 在 detail 和 list/timeline 上的不一致。"),
            "已确认 list/timeline 仍会走旧分支，下一步补 layer-aware 路由测试。",
            &output,
        );
        assert!(
            evaluation
                .issues
                .iter()
                .any(|item| item.code == "summary.agent_status_missing")
        );
        assert!(
            evaluation
                .issues
                .iter()
                .any(|item| item.code == "summary.agent_reasoning_filler")
        );
    }
}
