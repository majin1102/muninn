use async_trait::async_trait;
use lance::Result;

use crate::llm::config::{LlmProviderKind, LlmTask, task_config};
use crate::llm::mock::MockLlmProvider;
use crate::llm::openai::OpenAiLlmProvider;

#[derive(Debug, Clone)]
pub struct LlmTextRequest {
    pub system: String,
    pub prompt: String,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn generate_text(&self, request: LlmTextRequest) -> Result<String>;
}

pub async fn generate_text(task: LlmTask, request: LlmTextRequest) -> Result<Option<String>> {
    let Some(config) = task_config(task)? else {
        return Ok(None);
    };

    let output = match config.provider {
        LlmProviderKind::Mock => MockLlmProvider.generate_text(request).await?,
        LlmProviderKind::OpenAi => {
            OpenAiLlmProvider::new(config)
                .generate_text(request)
                .await?
        }
    };
    Ok(Some(output))
}
