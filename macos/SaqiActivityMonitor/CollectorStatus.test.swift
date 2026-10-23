import Foundation

@main struct StatusChecks {
    static func main() {
        let time = "2026-09-26T12:00:00.000Z"
        let now = CollectorStatus.date(time)!
        for state in ["idle", "paused", "collecting"] {
            let json = """
            {"version":1,"state":"\(state)","seenAt":"\(time)","progressAt":null,"retryAt":null,"current":null,"error":null,"lastCompleted":null,"reviewWarning":null}
            """
            let status = CollectorStatus.decode(Data(json.utf8))!
            precondition(status.connected(at: now.addingTimeInterval(149)))
            precondition(!status.connected(at: now.addingTimeInterval(150)))
            precondition(status.progressAt == nil)
        }
        precondition(CollectorStatus.decode(Data("{broken".utf8)) == nil)
        precondition(CollectorStatus.decode(Data("{\"version\":2,\"state\":\"idle\"}".utf8)) == nil)
        let label = "app.saqi.rig.translate"
        let missing = "Could not find service \"\(label)\" in domain for user gui: 501"
        precondition(LaunchctlPresence.inspect(exitCode: 0, diagnostics: "state = running", label: label) == .loaded)
        precondition(LaunchctlPresence.inspect(exitCode: 1, diagnostics: missing, label: label) == .unloaded)
        precondition(LaunchctlPresence.inspect(exitCode: 5, diagnostics: "Bad request.\n\(missing)\n", label: label) == .unloaded)
        precondition(LaunchctlPresence.inspect(exitCode: -9, diagnostics: missing, label: label) == .unknown)
        precondition(LaunchctlPresence.inspect(exitCode: 1, diagnostics: "Operation not permitted", label: label) == .unknown)
        precondition(LaunchctlPresence.inspect(exitCode: 1, diagnostics: "", label: label) == .unknown)
        precondition(LaunchctlPresence.inspect(exitCode: 1, diagnostics: missing + "\nOperation not permitted", label: label) == .unknown)
        precondition(LaunchctlPresence.inspect(exitCode: 1, diagnostics: missing.replacingOccurrences(of: label, with: label + ".other"), label: label) == .unknown)
        precondition(LaunchctlPresence.inspect(exitCode: 1, diagnostics: "Could not find service \"\(label)\" in domain for ", label: label) == .unknown)
        precondition(!LaunchctlPresence.loaded.canStart && LaunchctlPresence.loaded.canStop)
        precondition(LaunchctlPresence.unloaded.canStart && !LaunchctlPresence.unloaded.canStop)
        precondition(!LaunchctlPresence.unknown.canStart && LaunchctlPresence.unknown.canStop)
        let initial: LaunchctlPresence? = nil
        precondition(initial?.canStart != true && initial?.canStop != true)
        precondition(monitorPythonExecutable(nil) == "/usr/bin/python3")
        precondition(monitorPythonExecutable("") == "/usr/bin/python3")
        precondition(monitorPythonExecutable("python3") == "/usr/bin/python3")
        precondition(monitorPythonExecutable("/managed Python 3.15/bin/python3") == "/managed Python 3.15/bin/python3")
        print("Collector and local translation status checks passed")
    }
}
