mod core;
mod storage;
mod search;
mod renderer;

use axum::{routing::post, Router};
use core::types::{ListParams, Memory, RecallParams};

async fn recall(_params: RecallParams) -> Vec<Memory> {
    vec![]
}

async fn list(_params: ListParams) -> Vec<Memory> {
    vec![]
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/recall", post(recall))
        .route("/list", post(list));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await.unwrap();
    println!("Munnai Sidecar listening on http://127.0.0.1:8080");
    axum::serve(listener, app).await.unwrap();
}

