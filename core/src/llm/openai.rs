use async_trait::async_trait;
use lance::{Error, Result};
use serde::Deserialize;

use crate::llm::config::LlmTaskConfig;
use crate::llm::provider::{LlmProvider, LlmTextRequest};

const OPENAI_API_URL: &str = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL: &str = "gpt-5.4-mini";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenAiApiStyle {
    Responses,
    ChatCompletions,
}

#[derive(Debug, Clone)]
pub struct OpenAiLlmProvider {
    model: String,
    api_key: String,
    base_url: String,
    api_style: OpenAiApiStyle,
}

impl OpenAiLlmProvider {
    pub fn new(config: LlmTaskConfig) -> Self {
        let api_style = match config.api.as_deref() {
            Some("openai-completions") | Some("chat_completions") | Some("chat-completions") => {
                OpenAiApiStyle::ChatCompletions
            }
            _ => OpenAiApiStyle::Responses,
        };
        Self {
            model: config
                .model
                .unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string()),
            api_key: config.api_key.unwrap_or_default(),
            base_url: config.base_url.unwrap_or_else(|| match api_style {
                OpenAiApiStyle::Responses => OPENAI_API_URL.to_string(),
                OpenAiApiStyle::ChatCompletions => OPENAI_CHAT_COMPLETIONS_URL.to_string(),
            }),
            api_style,
        }
    }
}

#[derive(Deserialize)]
struct OpenAiResponsesApiResponse {
    output_text: Option<String>,
    output: Option<Vec<OpenAiOutputItem>>,
}

#[derive(Deserialize)]
struct OpenAiOutputItem {
    content: Option<Vec<OpenAiContentItem>>,
}

#[derive(Deserialize)]
struct OpenAiContentItem {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiChatCompletionsResponse {
    choices: Vec<OpenAiChatChoice>,
}

#[derive(Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatMessage,
}

#[derive(Deserialize)]
struct OpenAiChatMessage {
    content: String,
}

#[async_trait]
impl LlmProvider for OpenAiLlmProvider {
    async fn generate_text(&self, request: LlmTextRequest) -> Result<String> {
        if self.api_key.trim().is_empty() {
            return Err(Error::invalid_input(
                "llm.apiKey is required for openai llm provider",
            ));
        }

        let client = reqwest::Client::new();
        match self.api_style {
            OpenAiApiStyle::Responses => {
                let body = serde_json::json!({
                    "model": self.model,
                    "input": [
                        {
                            "role": "system",
                            "content": [{ "type": "input_text", "text": request.system }]
                        },
                        {
                            "role": "user",
                            "content": [{ "type": "input_text", "text": request.prompt }]
                        }
                    ]
                });

                let response = client
                    .post(&self.base_url)
                    .bearer_auth(&self.api_key)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|error| Error::io(format!("openai request failed: {error}")))?;

                if !response.status().is_success() {
                    let status = response.status();
                    let body = response
                        .text()
                        .await
                        .unwrap_or_else(|_| "<unreadable body>".to_string());
                    return Err(Error::invalid_input(format!(
                        "openai request failed with status {status}: {body}"
                    )));
                }

                let payload: OpenAiResponsesApiResponse = response
                    .json()
                    .await
                    .map_err(|error| Error::io(format!("invalid openai response: {error}")))?;

                payload
                    .output_text
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| extract_output_text(payload.output))
                    .ok_or_else(|| {
                        Error::invalid_input("openai response did not contain text output")
                    })
            }
            OpenAiApiStyle::ChatCompletions => {
                let body = serde_json::json!({
                    "model": self.model,
                    "messages": [
                        { "role": "system", "content": request.system },
                        { "role": "user", "content": request.prompt }
                    ]
                });

                let response = client
                    .post(normalize_chat_completions_url(&self.base_url))
                    .bearer_auth(&self.api_key)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|error| {
                        Error::io(format!("openai-compatible request failed: {error}"))
                    })?;

                if !response.status().is_success() {
                    let status = response.status();
                    let body = response
                        .text()
                        .await
                        .unwrap_or_else(|_| "<unreadable body>".to_string());
                    return Err(Error::invalid_input(format!(
                        "openai-compatible request failed with status {status}: {body}"
                    )));
                }

                let payload: OpenAiChatCompletionsResponse =
                    response.json().await.map_err(|error| {
                        Error::io(format!("invalid openai-compatible response: {error}"))
                    })?;

                payload
                    .choices
                    .into_iter()
                    .next()
                    .map(|choice| choice.message.content)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        Error::invalid_input(
                            "openai-compatible response did not contain text content",
                        )
                    })
            }
        }
    }
}

fn extract_output_text(output: Option<Vec<OpenAiOutputItem>>) -> Option<String> {
    let mut collected = Vec::new();
    for item in output.unwrap_or_default() {
        for content in item.content.unwrap_or_default() {
            if content.kind == "output_text" {
                if let Some(text) = content.text.filter(|value| !value.trim().is_empty()) {
                    collected.push(text);
                }
            }
        }
    }

    if collected.is_empty() {
        None
    } else {
        Some(collected.join("\n\n"))
    }
}

fn normalize_chat_completions_url(base_url: &str) -> String {
    if base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else {
        format!("{}/chat/completions", base_url.trim_end_matches('/'))
    }
}
