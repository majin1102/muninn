import SwiftUI
import AppKit

@main
struct MuninnApp: App {
    @StateObject private var server = MuninnServer()

    var body: some Scene {
        WindowGroup {
            ContentView(server: server)
                .frame(minWidth: 960, minHeight: 640)
                .onAppear {
                    NSApplication.shared.setActivationPolicy(.regular)
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
                .task {
                    await server.start()
                }
                .onDisappear {
                    server.stop()
                }
        }
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("About Muninn") {
                    NSApplication.shared.orderFrontStandardAboutPanel()
                }
            }
        }
    }
}
