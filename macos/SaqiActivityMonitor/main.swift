import AppKit
import Combine
import SwiftUI

struct JobStatus: Identifiable {
    let id: String
    let installed: Bool
    let running: Bool
    let failed: Bool
    let waiting: Bool
    let detail: String
    let updated: Date?
}

@MainActor final class RigMonitor: ObservableObject {
    @Published var jobs: [JobStatus] = []
    @Published var refreshing = false
    @Published var controlError: String?
    let root: URL
    let state = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Saqi")
    init() {
        root = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "SaqiRepository") as? String ?? "")
        refresh()
    }
    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        let directory = state
        Task {
            let result = await Task.detached { () -> [JobStatus] in
                ["translate", "collect"].map { name in
                    let (code, output) = run("/bin/launchctl", ["print", "gui/\(getuid())/app.saqi.rig.\(name)"])
                    var running = output.contains("state = running")
                    var failed = output.split(separator: "\n").contains { line in
                        let value = line.trimmingCharacters(in: .whitespaces)
                        return value.hasPrefix("last exit code = ") && value != "last exit code = 0"
                    }
                    let file = directory.appendingPathComponent("\(name).log")
                    var detail = "No task output yet"
                    if let handle = try? FileHandle(forReadingFrom: file) {
                        let size = (try? handle.seekToEnd()) ?? 0
                        try? handle.seek(toOffset: size > 8192 ? size - 8192 : 0)
                        let data = (try? handle.readToEnd()) ?? Data()
                        try? handle.close()
                        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
                        detail = (name == "collect" && lines.first?.hasPrefix("PERSONAL_CHROME") == true ? lines : lines.suffix(2)).joined(separator: "\n")
                    }
                    let date = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
                    let personal = name == "collect" && detail.hasPrefix("PERSONAL_CHROME")
                    if personal {
                        running = detail.hasPrefix("PERSONAL_CHROME running") && -(date?.timeIntervalSinceNow ?? -1000) < 90
                        failed = detail.hasPrefix("PERSONAL_CHROME attention") || (detail.hasPrefix("PERSONAL_CHROME running") && !running)
                    }
                    return JobStatus(id: name, installed: code == 0 || personal, running: running, failed: !running && failed,
                                     waiting: detail.split(separator: "\n").last?.contains("SOURCE_HUMAN_REQUIRED") == true,
                                     detail: detail, updated: date)
                }
            }.value
            jobs = result
            refreshing = false
        }
    }
    func control(_ action: String) {
        guard !refreshing else { return }
        refreshing = true
        let script = root.appendingPathComponent("typescript/scripts/rig-background.py").path
        Task {
            let (code, output) = await Task.detached { run("/usr/bin/python3", [script, action]) }.value
            controlError = code == 0 ? nil : output
            refreshing = false
            refresh()
        }
    }
    func stop() {
        let alert = NSAlert()
        alert.messageText = "Stop background translation?"
        alert.informativeText = "This stops translation and its login startup. Collection is controlled by the Chrome extension. An interrupted Codex call may need manual recovery before translating again. Existing publications remain safe."
        alert.addButton(withTitle: "Stop rig")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { control("stop") }
    }
}

// These local commands emit small bounded output and never read credentials.
func run(_ executable: String, _ arguments: [String]) -> (Int32, String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    } catch { return (1, error.localizedDescription) }
}

@main struct SaqiActivityMonitor: App {
    @StateObject private var monitor = RigMonitor()
    private let timer = Timer.publish(every: 10, on: .main, in: .common).autoconnect()
    var body: some Scene {
        WindowGroup("Saqi rig") { panel }
            .defaultSize(width: 440, height: 430)
        MenuBarExtra {
            panel
        } label: {
            Label("Saqi", systemImage: monitor.jobs.contains(where: { $0.failed || $0.waiting }) ? "exclamationmark.circle.fill" : "books.vertical")
        }
        .menuBarExtraStyle(.window)
    }
    private var panel: some View {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Saqi rig").font(.title2.bold())
                    Spacer()
                    Button { monitor.refresh() } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(monitor.refreshing).help("Refresh progress")
                }
                ForEach(monitor.jobs) { job in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Circle().fill((job.failed || job.waiting) ? .orange : job.running ? .green : .gray).frame(width: 8, height: 8)
                            Text(job.id == "translate" ? "Translation + insights" : "Authors + poems").bold()
                            Spacer()
                            Text(!job.installed ? "Stopped" : job.waiting ? "Verify in Chrome" : job.running ? "Running" : job.failed ? "Needs attention" : "Scheduled")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Text(job.detail).font(.caption.monospaced()).textSelection(.enabled).lineLimit(6).fixedSize(horizontal: false, vertical: true)
                        if let date = job.updated {
                            Text("Last output \(date.formatted(date: .omitted, time: .standard))")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Divider()
                }
                Text("Translation: every 30s · Collection: personal Chrome\nLong tasks never overlap. Mac must be awake. Source verification may require Chrome.")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = monitor.controlError { Text(error).font(.caption).foregroundStyle(.red).lineLimit(4) }
                HStack {
                    Button("Start translation") { monitor.control("install") }.disabled(monitor.refreshing)
                    Button("Stop translation…") { monitor.stop() }.disabled(monitor.refreshing)
                    Button("Logs") { NSWorkspace.shared.open(monitor.state) }
                }
                HStack {
                    Button("Open Saqi") { NSWorkspace.shared.open(URL(string: "https://saqi.app")!) }
                    Spacer()
                    Button("Quit monitor") { NSApplication.shared.terminate(nil) }
                }
            }
            .padding(18).frame(width: 440)
            .onReceive(timer) { _ in monitor.refresh() }
    }

}
