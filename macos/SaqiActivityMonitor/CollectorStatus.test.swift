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
        print("Collector status: fresh, stale, paused, invalid schema checks passed")
    }
}
