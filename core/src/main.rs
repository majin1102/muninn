use munnai_sidecar::memory::types::ListMode;
use munnai_sidecar::service::{
    MemoryRecall, MemoryTimeline, ObservingList, PostMessage, Service, SessionList,
};
use munnai_sidecar::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestEnvelope {
    id: u64,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseEnvelope {
    id: u64,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
}

struct RequestHandling {
    response: ResponseEnvelope,
    should_exit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMessageParams {
    #[serde(rename = "session_id")]
    session_id: Option<String>,
    agent: String,
    title: Option<String>,
    summary: Option<String>,
    tool_calling: Option<Vec<String>>,
    artifacts: Option<HashMap<String, String>>,
    prompt: Option<String>,
    response: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecallParams {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    mode: ListMode,
    agent: Option<String>,
    #[serde(rename = "session_id")]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservingListParams {
    mode: ListMode,
    observer: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryListParams {
    mode: ListMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineParams {
    memory_id: String,
    before_limit: Option<usize>,
    after_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailParams {
    memory_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsValidateParams {
    content: String,
}

#[tokio::main]
async fn main() {
    let storage = match Storage::load() {
        Ok(storage) => storage,
        Err(error) => {
            eprintln!("storage init error: {error}");
            return;
        }
    };
    let service = match Service::new(storage).await {
        Ok(service) => service,
        Err(error) => {
            eprintln!("service init error: {error}");
            return;
        }
    };
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("stdin read error: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let handled = handle_request(&service, &line).await;
        let encoded = serde_json::to_string(&handled.response).expect("response should encode");
        if writeln!(stdout, "{encoded}").is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
        if handled.should_exit {
            break;
        }
    }
    service.shutdown().await;
}

async fn handle_request(service: &Service, line: &str) -> RequestHandling {
    let request: RequestEnvelope = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return RequestHandling {
                response: ResponseEnvelope {
                    id: 0,
                    ok: false,
                    data: None,
                    error: Some(format!("invalid request: {error}")),
                },
                should_exit: false,
            };
        }
    };

    let should_exit = request.method == "shutdown";
    let result = match request.method.as_str() {
        "addMessage" => match parse_params::<AddMessageParams>(&request.params) {
            Ok(params) => service
                .sessions()
                .post(PostMessage {
                    session_id: params.session_id,
                    agent: params.agent,
                    title: params.title,
                    summary: params.summary,
                    tool_calling: params.tool_calling,
                    artifacts: params.artifacts,
                    prompt: params.prompt,
                    response: params.response,
                })
                .await
                .map(|turn| serde_json::to_value(turn).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "sessions.list" => match parse_params::<ListParams>(&request.params) {
            Ok(params) => service
                .sessions()
                .list(SessionList {
                    mode: params.mode,
                    agent: params.agent,
                    session_id: params.session_id,
                })
                .await
                .map(|turns| serde_json::to_value(turns).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "observings.list" => match parse_params::<ObservingListParams>(&request.params) {
            Ok(params) => service
                .observings()
                .list(ObservingList {
                    mode: params.mode,
                    observer: params.observer,
                })
                .await
                .map(|observings| serde_json::to_value(observings).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "sessions.get" => match parse_params::<DetailParams>(&request.params) {
            Ok(params) => service
                .sessions()
                .get(&params.memory_id)
                .await
                .map(|turn| serde_json::to_value(turn).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "observings.get" => match parse_params::<DetailParams>(&request.params) {
            Ok(params) => service
                .observings()
                .get(&params.memory_id)
                .await
                .map(|observing| serde_json::to_value(observing).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.recall" => match parse_params::<RecallParams>(&request.params) {
            Ok(params) => service
                .memories()
                .recall(MemoryRecall {
                    text: params.query,
                    limit: params.limit.unwrap_or(10),
                })
                .await
                .map(|memories| serde_json::to_value(memories).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.list" => match parse_params::<MemoryListParams>(&request.params) {
            Ok(params) => service
                .memories()
                .list(params.mode)
                .await
                .map(|memories| serde_json::to_value(memories).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.timeline" => match parse_params::<TimelineParams>(&request.params) {
            Ok(params) => service
                .memories()
                .timeline(MemoryTimeline {
                    memory_id: params.memory_id,
                    before_limit: params.before_limit,
                    after_limit: params.after_limit,
                })
                .await
                .map(|memories| serde_json::to_value(memories).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "memories.get" => match parse_params::<DetailParams>(&request.params) {
            Ok(params) => service
                .memories()
                .get(&params.memory_id)
                .await
                .map(|memory| serde_json::to_value(memory).unwrap())
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "settings.validate" => match parse_params::<SettingsValidateParams>(&request.params) {
            Ok(params) => service
                .validate_settings(&params.content)
                .await
                .map(|_| Value::Null)
                .map_err(|error| error.to_string()),
            Err(error) => Err(error),
        },
        "shutdown" => {
            service.shutdown().await;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown method: {}", request.method)),
    };

    RequestHandling {
        response: match result {
            Ok(data) => ResponseEnvelope {
                id: request.id,
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => ResponseEnvelope {
                id: request.id,
                ok: false,
                data: None,
                error: Some(error),
            },
        },
        should_exit,
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: &Value) -> std::result::Result<T, String> {
    serde_json::from_value(params.clone()).map_err(|error| format!("invalid params: {error}"))
}
