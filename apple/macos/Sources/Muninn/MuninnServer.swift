import Foundation
import Darwin

struct MuninnServerSession: Equatable {
    let baseURL: URL
    let appURL: URL
    let apiToken: String
}

@MainActor
final class MuninnServer: ObservableObject {
    enum State: Equatable {
        case idle
        case starting
        case ready(MuninnServerSession)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private var process: Process?

    func start() async {
        stop()
        state = .starting

        do {
            let launch = try makeLaunch()
            process = launch.process
            try launch.process.run()
            let session = MuninnServerSession(
                baseURL: launch.baseURL,
                appURL: appURL(for: launch.baseURL),
                apiToken: launch.apiToken
            )
            try await waitForHealth(baseURL: launch.baseURL)
            state = .ready(session)
        } catch {
            stop()
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        guard let process else {
            return
        }
        if process.isRunning {
            process.terminate()
        }
        self.process = nil
    }

    private func makeLaunch() throws -> ServerLaunch {
        let resources = Bundle.module.resourceURL
            ?? Bundle.main.resourceURL
            ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let serverRoot = resources.appending(path: "Resources/Server")
        let bundleNode = serverRoot.appending(path: "bin/node")
        let bundleEntry = serverRoot.appending(path: "packages/server/dist/index.js")
        let runtime = try resolveRuntime(
            bundleRoot: serverRoot,
            bundleNode: bundleNode,
            bundleEntry: bundleEntry
        )


        let port = try reservePort()
        let token = UUID().uuidString
        let baseURL = URL(string: "http://127.0.0.1:\(port)")!
        let muninnHome = try defaultMuninnHome()

        let process = Process()
        process.executableURL = runtime.node
        process.arguments = [runtime.entry.path]
        process.currentDirectoryURL = runtime.root
        var environment = ProcessInfo.processInfo.environment
        environment["HOST"] = "127.0.0.1"
        environment["PORT"] = String(port)
        environment["MUNINN_HOME"] = muninnHome.path
        environment["MUNINN_DESKTOP_TOKEN"] = token
        process.environment = environment

        return ServerLaunch(process: process, baseURL: baseURL, apiToken: token)
    }

    private func defaultMuninnHome() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let home = appSupport.appending(path: "Muninn", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return home
    }

    private func waitForHealth(baseURL: URL) async throws {
        let deadline = Date().addingTimeInterval(15)
        let healthURL = baseURL.appending(path: "health")
        var lastError: Error?

        while Date() < deadline {
            do {
                let (_, response) = try await URLSession.shared.data(from: healthURL)
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    return
                }
            } catch {
                lastError = error
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }

        throw MuninnServerError.healthTimeout(lastError?.localizedDescription ?? "server did not respond")
    }
}

private func appURL(for baseURL: URL) -> URL {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    components.path = "/app/"
    return components.url!
}

private struct ServerRuntime {
    let root: URL
    let node: URL
    let entry: URL
}

private struct ServerLaunch {
    let process: Process
    let baseURL: URL
    let apiToken: String
}

private enum MuninnServerError: LocalizedError {
    case missingResource(String)
    case healthTimeout(String)

    var errorDescription: String? {
        switch self {
        case .missingResource(let message):
            return message
        case .healthTimeout(let message):
            return "Muninn server health check timed out: \(message)"
        }
    }
}

private func resolveRuntime(bundleRoot: URL, bundleNode: URL, bundleEntry: URL) throws -> ServerRuntime {
    let fileManager = FileManager.default
    if fileManager.isExecutableFile(atPath: bundleNode.path), fileManager.fileExists(atPath: bundleEntry.path) {
        return ServerRuntime(root: bundleRoot, node: bundleNode, entry: bundleEntry)
    }

    let repoRoot = try findDevRepoRoot()
    let devEntry = repoRoot.appending(path: "packages/server/dist/index.js")
    guard fileManager.fileExists(atPath: devEntry.path) else {
        throw MuninnServerError.missingResource(
            "Bundled server entry not found at \(bundleEntry.path). Dev server entry not found at \(devEntry.path). Run `pnpm --filter @muninn/server build` first."
        )
    }
    guard let devNode = findNode() else {
        throw MuninnServerError.missingResource(
            "Bundled Node runtime not found at \(bundleNode.path), and node was not found in PATH. Run from a shell with Node in PATH."
        )
    }
    return ServerRuntime(root: repoRoot, node: devNode, entry: devEntry)
}

private func findDevRepoRoot() throws -> URL {
    let fileManager = FileManager.default
    var current = URL(fileURLWithPath: fileManager.currentDirectoryPath)

    while true {
        let serverEntry = current.appending(path: "packages/server/dist/index.js")
        let workspace = current.appending(path: "pnpm-workspace.yaml")
        if fileManager.fileExists(atPath: serverEntry.path), fileManager.fileExists(atPath: workspace.path) {
            return current
        }

        let parent = current.deletingLastPathComponent()
        if parent.path == current.path {
            throw MuninnServerError.missingResource("Could not locate Muninn repo root from \(fileManager.currentDirectoryPath)")
        }
        current = parent
    }
}

private func findNode() -> URL? {
    let environment = ProcessInfo.processInfo.environment
    if let node = environment["NODE_BINARY"], FileManager.default.isExecutableFile(atPath: node) {
        return URL(fileURLWithPath: node)
    }

    for directory in (environment["PATH"] ?? "").split(separator: ":") {
        let candidate = URL(fileURLWithPath: String(directory)).appending(path: "node")
        if FileManager.default.isExecutableFile(atPath: candidate.path) {
            return candidate
        }
    }

    for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
    }

    return nil
}

private func reservePort() throws -> Int {
    let socketFD = socket(AF_INET, SOCK_STREAM, 0)
    guard socketFD >= 0 else {
        throw POSIXError(.EADDRNOTAVAIL)
    }
    defer { close(socketFD) }

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

    let bindResult = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
            bind(socketFD, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bindResult == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EADDRNOTAVAIL)
    }

    var boundAddress = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let nameResult = withUnsafeMutablePointer(to: &boundAddress) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
            getsockname(socketFD, sockaddrPointer, &length)
        }
    }
    guard nameResult == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EADDRNOTAVAIL)
    }

    return Int(UInt16(bigEndian: boundAddress.sin_port))
}
