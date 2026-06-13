import SwiftUI
import WebKit

struct ContentView: View {
    @ObservedObject var server: MuninnServer

    var body: some View {
        Group {
            switch server.state {
            case .idle, .starting:
                ProgressView("Starting Muninn")
                    .controlSize(.large)
            case .ready(let session):
                MuninnWebView(session: session)
            case .failed(let message):
                VStack(alignment: .leading, spacing: 12) {
                    Text("Muninn could not start")
                        .font(.headline)
                    Text(message)
                        .font(.body)
                        .textSelection(.enabled)
                    Button("Retry") {
                        Task { await server.start() }
                    }
                }
                .padding(32)
                .frame(maxWidth: 560)
            }
        }
    }
}

struct MuninnWebView: NSViewRepresentable {
    let session: MuninnServerSession

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let controller = WKUserContentController()
        let bootstrap = """
        window.__MUNINN_DESKTOP__ = {
          apiBase: "\(session.baseURL.absoluteString)",
          apiToken: "\(session.apiToken)"
        };
        """
        controller.addUserScript(WKUserScript(
            source: bootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: session.appURL))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        if webView.url == nil {
            webView.load(URLRequest(url: session.appURL))
        }
    }
}
