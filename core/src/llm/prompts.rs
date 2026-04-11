use std::sync::OnceLock;

use serde::Deserialize;

#[cfg(test)]
pub const MAX_TURN_TITLE_CHARS: usize = 100;
#[cfg(test)]
pub const MAX_TURN_SUMMARY_CHARS: usize = 1000;

#[derive(Debug, Deserialize)]
struct PromptTemplateFile {
    system: String,
    user_template: String,
}

#[cfg(test)]
pub fn build_turn_system_prompt() -> String {
    turn_template()
        .system
        .replace("{{max_title_chars}}", &MAX_TURN_TITLE_CHARS.to_string())
        .replace("{{max_summary_chars}}", &MAX_TURN_SUMMARY_CHARS.to_string())
}

#[cfg(test)]
pub fn build_turn_user_prompt(prompt: Option<&str>, response: &str) -> String {
    turn_template()
        .user_template
        .replace("{{prompt}}", prompt.unwrap_or(""))
        .replace("{{response}}", response)
}

pub fn build_observing_gateway_system_prompt() -> String {
    observing_gateway_template().system.clone()
}

pub fn build_observing_gateway_user_prompt(input_json: &str) -> String {
    observing_gateway_template()
        .user_template
        .replace("{{input_json}}", input_json)
}

pub fn build_observing_system_prompt() -> String {
    observing_template().system.clone()
}

pub fn build_observing_user_prompt(input_json: &str) -> String {
    observing_template()
        .user_template
        .replace("{{input_json}}", input_json)
}

#[cfg(test)]
fn turn_template() -> &'static PromptTemplateFile {
    static TEMPLATE: OnceLock<PromptTemplateFile> = OnceLock::new();
    TEMPLATE.get_or_init(|| {
        serde_yaml::from_str(include_str!("../../../packages/core/prompts/turn.yaml"))
            .expect("turn.yaml must be valid")
    })
}

fn observing_gateway_template() -> &'static PromptTemplateFile {
    static TEMPLATE: OnceLock<PromptTemplateFile> = OnceLock::new();
    TEMPLATE.get_or_init(|| {
        serde_yaml::from_str(include_str!(
            "../../../packages/core/prompts/observing-gateway.yaml"
        ))
        .expect("observing-gateway.yaml must be valid")
    })
}

fn observing_template() -> &'static PromptTemplateFile {
    static TEMPLATE: OnceLock<PromptTemplateFile> = OnceLock::new();
    TEMPLATE.get_or_init(|| {
        serde_yaml::from_str(include_str!("../../../packages/core/prompts/observing.yaml"))
            .expect("observing.yaml must be valid")
    })
}
