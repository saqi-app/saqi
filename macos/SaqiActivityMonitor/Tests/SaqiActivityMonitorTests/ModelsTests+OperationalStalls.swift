import XCTest
@testable import SaqiActivityMonitor

extension ModelsTests {
    func testRetainedSourceStatusIsDecodedAndCannotEnableControl() throws {
        var snapshot = service(actualState: "running_outdated", actions: ["start", "restart", "stop"])
        snapshot.sourceIdentityStatus = .retainedUnverified
        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(ServiceSnapshot.self, from: data)
        XCTAssertEqual(decoded.sourceIdentityStatus, .retainedUnverified)
        XCTAssertFalse(decoded.allows("start"))
        XCTAssertFalse(decoded.allows("restart"))
        XCTAssertTrue(decoded.allows("stop"))
        let invalid = try XCTUnwrap(String(data: data, encoding: .utf8))
            .replacingOccurrences(of: "retained_unverified", with: "unrecognized")
        XCTAssertThrowsError(try JSONDecoder().decode(ServiceSnapshot.self, from: Data(invalid.utf8)))
    }

    func testOperationalStatusLabelsIntentionalPaidPause() throws {
        let now = Date(timeIntervalSince1970: 1000)
        let sol = provider(key: "sol-5.6", provider: "sol", blockReason: "paused")
        let health = validHealth(
            queues: [queue(kind: sol.workKind, pending: 10)],
            providers: [sol],
            observedAt: 1_000_000,
            runId: "process:1",
        )
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: health,
            runtime: nil,
            paused: false,
            now: now,
        )
        XCTAssertEqual(result.severity, .waiting)
        XCTAssertEqual(result.label, "Paid translation paused")
        XCTAssertEqual(result.wait?.kind, .paidPause)
        XCTAssertFalse(try XCTUnwrap(result.wait).requiresAttention)
        XCTAssertTrue(sol.activityLabel().hasPrefix("paid work paused"))
    }

    func testOperationalStatusSurfacesProductionStallBeforeAutomaticWaits() {
        let now = Date(timeIntervalSince1970: 1000)
        let sol = provider(key: "sol-5.6", provider: "sol", blockReason: "paused")
        let health = validHealth(
            queues: [queue(kind: sol.workKind, pending: 10)],
            providers: [sol],
            observedAt: 1_000_000,
            runId: "process:1",
            growth: PipelineGrowth(
                production: ProductionGrowth(configured: true, lastSuccessAt: nil, state: "stalled"),
            ),
        )
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: health,
            runtime: nil,
            paused: false,
            now: now,
        )
        XCTAssertEqual(result.severity, .attention)
        XCTAssertEqual(result.label, "Production stalled · attention needed")
        XCTAssertTrue(result.requiresAttention)
    }

    func testProviderOperatorBlockersOutrankProductionStallWhenWorkRemains() throws {
        let cases: [String: OperationalWaitKind] = [
            "auth_wait": .authentication,
            "budget_exhausted": .budget,
            "budget_unarmed": .budget,
            "circuit_open": .provider,
            "disabled": .provider,
        ]
        for (reason, kind) in cases {
            let result = providerOperationalStatus(
                reason: reason,
                operatorAction: operatorAction(for: reason),
                recovery: "operator",
                productionStalled: true,
            )
            XCTAssertEqual(result.severity, .attention, reason)
            XCTAssertEqual(result.wait?.kind, kind, reason)
            XCTAssertTrue(try XCTUnwrap(result.wait, reason).requiresAttention, reason)
            XCTAssertTrue(result.label.contains("attention needed"), reason)
            XCTAssertNotEqual(result.label, "Production stalled · attention needed", reason)
        }
    }

    func testProviderAutomaticWaitsRemainNonAttention() throws {
        let cases: [String: OperationalWaitKind] = [
            "auth_wait": .authentication,
            "codex_quota_wait": .quota,
            "error_dampener": .provider,
            "launch_pacing": .retry,
            "network_wait": .network,
            "provider_backoff": .provider,
            "rate_limit_wait": .rateLimit,
            "resource_wait": .resource,
        ]
        for (reason, kind) in cases {
            let result = providerOperationalStatus(reason: reason)
            XCTAssertEqual(result.severity, .waiting, reason)
            XCTAssertFalse(result.requiresAttention, reason)
            XCTAssertEqual(result.wait?.kind, kind, reason)
            XCTAssertFalse(try XCTUnwrap(result.wait, reason).requiresAttention, reason)
            XCTAssertTrue(result.label.contains("automatically"), reason)
        }
    }

    func testProviderNonWaitingExecutionReasonsUseLegacyHealthyStatus() {
        for reason in ["active", "ready", "no_ready_work", "adaptive_capacity", "at_capacity"] {
            let result = providerOperationalStatus(reason: reason)
            XCTAssertEqual(result.severity, .healthy, reason)
            XCTAssertEqual(result.label, "Running · healthy", reason)
            XCTAssertNil(result.wait, reason)
        }
    }

    func testAutomaticProviderWaitDoesNotMaskProductionStall() {
        let result = providerOperationalStatus(reason: "codex_quota_wait", productionStalled: true)
        XCTAssertEqual(result.severity, .attention)
        XCTAssertEqual(result.label, "Production stalled · attention needed")
        XCTAssertNil(result.wait)
    }

    func testProviderIntentionalPausesRemainNeutral() throws {
        let cases: [String: OperationalWaitKind] = [
            "operator_paused": .operatorPause,
            "paid_work_paused": .paidPause,
        ]
        for (reason, kind) in cases {
            let result = providerOperationalStatus(reason: reason)
            XCTAssertEqual(result.severity, .neutral, reason)
            XCTAssertEqual(result.wait?.kind, kind, reason)
            XCTAssertFalse(try XCTUnwrap(result.wait, reason).requiresAttention, reason)
        }
    }

    func testProviderBlockerWithoutRemainingWorkDoesNotMaskProductionStall() {
        let result = providerOperationalStatus(
            reason: "budget_unarmed",
            operatorAction: "arm_budget",
            recovery: "operator",
            remainingWork: 0,
            productionStalled: true,
        )
        XCTAssertEqual(result.severity, .attention)
        XCTAssertEqual(result.label, "Production stalled · attention needed")
        XCTAssertNil(result.wait)
    }

    func testServiceStateStillOutranksProviderBlockers() {
        let expected = [
            "fenced": "Fenced · attention needed",
            "running_outdated": "Running · restart needed",
            "starting": "Starting · preparing lanes",
            "stopped": "Stopped",
        ]
        for (state, label) in expected {
            let result = providerOperationalStatus(
                reason: "budget_unarmed",
                operatorAction: "arm_budget",
                recovery: "operator",
                serviceState: state,
            )
            XCTAssertEqual(result.label, label, state)
            XCTAssertEqual(
                result.requiresAttention,
                state == "fenced" || state == "running_outdated",
                state,
            )
        }
    }

    func testMissingPipelineDiagnosticsRequiresAttentionWhileServiceRuns() {
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: nil,
            runtime: nil,
            paused: false,
        )

        XCTAssertEqual(result.label, "Diagnostics unavailable")
        XCTAssertTrue(result.requiresAttention)
    }

    func testTopLevelBlockedHealthRequiresAttentionWithoutBlockedCheck() {
        let now = Date(timeIntervalSince1970: 1000)
        let health = PipelineHealth(
            checks: [],
            schemaId: "saqi.pipeline-health",
            schemaVersion: 1,
            configDigest: String(repeating: "a", count: 64),
            growth: nil,
            heartbeatIntervalMs: nil,
            lastProgressAt: nil,
            observedAt: 1_000_000,
            origins: [],
            providers: [],
            queues: [],
            runId: "process:1",
            sol: nil,
            state: "blocked",
        )
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: health,
            runtime: nil,
            paused: false,
            now: now,
        )

        XCTAssertEqual(result.label, "Pipeline blocked · attention needed")
        XCTAssertTrue(result.requiresAttention)
    }

    func testCurrentRuntimeProviderBlockerOutranksPriorProcessPipelineHealth() {
        let now = Date(timeIntervalSince1970: 1000)
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: validHealth(observedAt: 1_000_000, runId: "process:999"),
            runtime: providerRuntime(
                reason: "paid_work_paused",
                operatorAction: "resume_paid",
                recovery: "operator",
                remainingWork: 4,
                now: now,
            ),
            paused: false,
            now: now,
        )

        XCTAssertEqual(result.label, "Paid translation paused")
        XCTAssertEqual(result.severity, .neutral)
        XCTAssertEqual(result.wait?.kind, .paidPause)
    }

    func testStaleRuntimeCannotReportOldBudgetBlockWhenPipelineIsFresh() {
        let snapshotTime = Date(timeIntervalSince1970: 1000)
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: validHealth(observedAt: 1_901_000, runId: "process:1"),
            runtime: providerRuntime(
                reason: "budget_exhausted",
                operatorAction: "rearm_budget",
                recovery: "operator",
                remainingWork: 4,
                now: snapshotTime,
            ),
            paused: false,
            now: Date(timeIntervalSince1970: 1901),
        )

        XCTAssertEqual(result.label, "Running · healthy")
        XCTAssertEqual(result.severity, .healthy)
    }

    func testRetainedPauseCannotHideFreshBlockedHealth() {
        let now = Date(timeIntervalSince1970: 1000)
        let health = PipelineHealth(
            checks: [],
            schemaId: "saqi.pipeline-health",
            schemaVersion: 1,
            configDigest: String(repeating: "a", count: 64),
            growth: nil,
            heartbeatIntervalMs: nil,
            lastProgressAt: nil,
            observedAt: 1_000_000,
            origins: [],
            providers: [],
            queues: [],
            runId: "process:1",
            sol: nil,
            state: "blocked",
        )
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: health,
            runtime: nil,
            paused: true,
            now: now,
        )

        XCTAssertEqual(result.label, "Pipeline blocked · attention needed")
        XCTAssertTrue(result.requiresAttention)
    }

    func testRetainedPauseDoesNotDescribeNewRunAsPaused() {
        let now = Date(timeIntervalSince1970: 1000)
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: validHealth(observedAt: 1_000_000, runId: "process:1"),
            runtime: nil,
            paused: true,
            now: now,
        )

        XCTAssertEqual(result.label, "Running · healthy")
        XCTAssertEqual(result.severity, .healthy)
    }

    func testRetainedPauseDoesNotOverrideCurrentUnpausedProvider() {
        let now = Date(timeIntervalSince1970: 1000)
        let result = MonitorOperationalStatus.evaluate(
            service: service(actualState: "running", actions: []),
            health: validHealth(observedAt: 1_000_000, runId: "process:1"),
            runtime: providerRuntime(
                reason: "ready",
                operatorAction: "none",
                recovery: "automatic",
                remainingWork: 1,
                now: now,
            ),
            paused: true,
            now: now,
        )

        XCTAssertEqual(result.label, "Running · healthy")
        XCTAssertEqual(result.severity, .healthy)
    }
}
