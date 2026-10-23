import AppKit
import Combine
import SwiftUI

struct JobStatus: Identifiable {
    let id: String
    let presence: LaunchctlPresence
    let running: Bool
    let failed: Bool
    let waiting: Bool
    let detail: String
    let updated: Date?
    var label: String? = nil
}

@MainActor final class RigMonitor: ObservableObject {
    @Published var jobs: [JobStatus] = []
    @Published var refreshing = false
    @Published var controlError: String?
    let root: URL
    let pythonExecutable: String
    let state = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Saqi")
    var translationPresence: LaunchctlPresence? { jobs.first(where: { $0.id == "translate" })?.presence }
    init() {
        root = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "SaqiRepository") as? String ?? "")
        pythonExecutable = monitorPythonExecutable(Bundle.main.object(forInfoDictionaryKey: "SaqiPythonExecutable") as? String)
        refresh()
    }
    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        let directory = state
        Task {
            let result = await Task.detached { () -> [JobStatus] in
                ["translate", "collect"].map { name in
                    if name == "collect" {
                        let file = directory.appendingPathComponent("collector-status.json")
                        guard let data = try? Data(contentsOf: file), let status = CollectorStatus.decode(data) else {
                            return JobStatus(id: name, presence: .unknown, running: false, failed: true, waiting: false,
                                             detail: "Load the Saqi extension in personal Chrome, then open its popup. Run the collector doctor if setup needs repair.", updated: nil, label: "Setup needed")
                        }
                        return JobStatus(id: name, presence: .loaded, running: status.connected() && status.state == "collecting",
                                         failed: !status.connected() || status.state == "error" || status.reviewWarning != nil,
                                         waiting: status.connected() && status.state == "human_required", detail: status.detail,
                                         updated: CollectorStatus.date(status.progressAt), label: status.label)
                    }
                    let label = "app.saqi.rig.\(name)"
                    let (code, output) = run("/bin/launchctl", ["print", "gui/\(getuid())/\(label)"])
                    let presence = LaunchctlPresence.inspect(exitCode: code, diagnostics: output, label: label)
                    if presence == .unloaded {
                        return JobStatus(id: name, presence: .unloaded, running: false, failed: false,
                                         waiting: false, detail: "Background translation is stopped.", updated: nil)
                    }
                    if presence == .unknown {
                        return JobStatus(id: name, presence: .unknown, running: false, failed: true,
                                         waiting: false, detail: "Local translation status could not be inspected. Refresh to try again. Stop rechecks the job safely before changing its startup file.",
                                         updated: nil, label: "Status unavailable")
                    }
                    let running = output.contains("state = running")
                    let failed = output.split(separator: "\n").contains { line in
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
                        detail = lines.suffix(2).joined(separator: "\n")
                    }
                    let date = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
                    let quotaWaiting = !running && detail.contains("Waiting for Codex quota:")
                    return JobStatus(id: name, presence: .loaded, running: running, failed: !running && failed,
                                     waiting: quotaWaiting, detail: detail, updated: date,
                                     label: quotaWaiting ? "Waiting for quota" : nil)
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
        let python = pythonExecutable
        Task {
            let (code, output) = await Task.detached { run(python, [script, action]) }.value
            controlError = code == 0 ? nil : output
            refreshing = false
            refresh()
        }
    }
    func stop() {
        let alert = NSAlert()
        alert.messageText = "Stop local Mac translation?"
        alert.informativeText = "This stops translation and its login startup. Collection is controlled by the Chrome extension. An interrupted Codex call may need manual recovery before translating again. Existing publications remain safe."
        alert.addButton(withTitle: "Stop rig")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { control("stop") }
    }
    func open(_ url: URL) {
        if NSWorkspace.shared.open(url) {
            controlError = nil
        } else {
            controlError = "Could not open \(url.lastPathComponent). Check that it exists and try again."
        }
    }
    func openChrome() {
        Task {
            let (code, output) = await Task.detached { run("/usr/bin/open", ["-a", "Google Chrome"]) }.value
            controlError = code == 0 ? nil : output.isEmpty ? "Google Chrome could not open. Check its installation." : output
        }
    }
}

// These local commands emit small bounded output and never read credentials.
func run(_ executable: String, _ arguments: [String]) -> (Int32, String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = ProcessInfo.processInfo.environment.merging(["LC_ALL": "C"]) { _, value in value }
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let code = process.terminationReason == .exit ? process.terminationStatus : -process.terminationStatus
        return (code, String(decoding: data, as: UTF8.self))
    } catch { return (1, error.localizedDescription) }
}

@main struct SaqiActivityMonitor: App {
    @StateObject private var monitor = RigMonitor()
    private let timer = Timer.publish(every: 10, on: .main, in: .common).autoconnect()
    var body: some Scene {
        WindowGroup("Saqi rig") { panel }
            .defaultSize(width: 440, height: 620)
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
                    Text("Saqi on this Mac").font(.title2.bold())
                    Spacer()
                    if monitor.refreshing { ProgressView().controlSize(.small).accessibilityLabel("Updating local rig status") }
                    Button { monitor.refresh() } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(monitor.refreshing).help("Refresh progress").accessibilityLabel("Refresh local rig status")
                }
                ForEach(monitor.jobs) { job in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Circle().fill((job.failed || job.waiting) ? .orange : job.running ? .green : .gray).frame(width: 8, height: 8)
                            Text(job.id == "translate" ? "Local translation + word meanings" : "Chrome collection").bold()
                            Spacer()
                            Text(job.label ?? (job.presence == .unloaded ? "Stopped" : job.waiting ? "Verify in Chrome" : job.running ? "Running" : job.failed ? "Needs attention" : "Scheduled"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ScrollView {
                            Text(job.detail).font(.caption).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }.frame(maxHeight: 110)
                        if let date = job.updated {
                            Text("\(job.id == "collect" ? "Last collection progress" : "Last output") \(date.formatted(date: .abbreviated, time: .standard))")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Divider()
                }
                Text("Local translation: every 30s · Collection: personal Chrome\nThis panel does not control the production VM. The Mac must be awake for local work. Use the Chrome popup for source verification.")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = monitor.controlError {
                    ScrollView { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }.frame(maxHeight: 96)
                }
                HStack {
                    Button("Start local translation") { monitor.control("install") }
                        .disabled(monitor.refreshing || monitor.translationPresence?.canStart != true)
                    Button("Stop local translation…") { monitor.stop() }
                        .disabled(monitor.refreshing || monitor.translationPresence?.canStop != true)
                }
                HStack {
                    Button("Open log folder") { monitor.open(monitor.state) }
                    Button("Open Chrome") { monitor.openChrome() }
                }
                HStack {
                    Button("Open Saqi") { monitor.open(URL(string: "https://saqi.app")!) }
                    Spacer()
                    Button("Quit monitor") { NSApplication.shared.terminate(nil) }
                        .help("Translation and collection continue after the monitor closes")
                }
            }
            .padding(18).frame(width: 440)
            .onReceive(timer) { _ in monitor.refresh() }
    }

}
