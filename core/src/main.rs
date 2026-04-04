#[tokio::main]
async fn main() {
    muninn_sidecar::muninn::run_stdio().await;
}
