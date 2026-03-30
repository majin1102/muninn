use lance::{Error, Result};

use crate::config::semantic_index_config;

const OPENAI_EMBEDDINGS_URL: &str = "https://api.openai.com/v1/embeddings";

pub async fn embed_text(text: &str) -> Result<Vec<f32>> {
    let config = semantic_index_config()?;
    match config.provider.as_str() {
        "mock" => Ok(mock_embedding(text, config.dimensions)),
        "openai" => {
            openai_embedding(
                text,
                config.model.as_deref().unwrap_or("text-embedding-3-small"),
                config.api_key.as_deref().unwrap_or_default(),
                config.base_url.as_deref().unwrap_or(OPENAI_EMBEDDINGS_URL),
                config.dimensions,
            )
            .await
        }
        other => Err(Error::invalid_input(format!(
            "unsupported semanticIndex embedding provider: {other}"
        ))),
    }
}

fn mock_embedding(text: &str, dimensions: usize) -> Vec<f32> {
    let mut values = vec![0.0_f32; dimensions.max(1)];
    for (index, byte) in text.bytes().enumerate() {
        let slot = index % values.len();
        values[slot] += (byte as f32) / 255.0;
    }
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in &mut values {
            *value /= norm;
        }
    }
    values
}

async fn openai_embedding(
    text: &str,
    model: &str,
    api_key: &str,
    base_url: &str,
    dimensions: usize,
) -> Result<Vec<f32>> {
    if api_key.trim().is_empty() {
        return Err(Error::invalid_input(
            "semanticIndex.embedding.apiKey is required for openai embeddings",
        ));
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "input": text,
        "dimensions": dimensions,
    });
    let response = client
        .post(base_url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| Error::io(format!("semanticIndex embedding request failed: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable body>".to_string());
        return Err(Error::invalid_input(format!(
            "semanticIndex embedding request failed with status {status}: {body}"
        )));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| Error::io(format!("invalid semanticIndex embedding response: {error}")))?;
    let vector = payload
        .get("data")
        .and_then(|value| value.as_array())
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("embedding"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| Error::invalid_input("semanticIndex embedding response missing vector"))?;
    vector
        .iter()
        .map(|value| {
            value.as_f64().map(|number| number as f32).ok_or_else(|| {
                Error::invalid_input("semanticIndex embedding value must be numeric")
            })
        })
        .collect()
}
