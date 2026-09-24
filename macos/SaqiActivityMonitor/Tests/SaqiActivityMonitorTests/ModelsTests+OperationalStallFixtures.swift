import XCTest
@testable import SaqiActivityMonitor

extension ModelsTests {
    func providerOperationalStatus(
        reason: String,
        operatorAction: String = "none",
        recovery: String = "automatic",
        remainingWork: Int = 1,
        productionStalled: Bool = false,
        serviceState: String = "running",
    ) -> MonitorOperationalStatus {
        let now = Date(timeIntervalSince1970: 1000)
        let growth = productionStalled
            ? PipelineGrowth(production: ProductionGrowth(configured: true, lastSuccessAt: nil, state: "stalled"))
            : nil
        return MonitorOperationalStatus.evaluate(
            service: service(actualState: serviceState, actions: []),
            health: validHealth(observedAt: 1_000_000, runId: "process:1", growth: growth),
            runtime: providerRuntime(
                reason: reason,
                operatorAction: operatorAction,
                recovery: recovery,
                remainingWork: remainingWork,
                now: now,
            ),
            paused: false,
            now: now,
        )
    }

    func operatorAction(for reason: String) -> String {
        switch reason {
        case "auth_wait":
            "restore_auth"
        case "budget_exhausted":
            "rearm_budget"
        case "budget_unarmed":
            "arm_budget"
        case "disabled":
            "enable_provider"
        default:
            "inspect_provider"
        }
    }

    func providerRuntime(
        reason: String,
        operatorAction: String,
        recovery: String,
        remainingWork: Int,
        now: Date,
    ) -> RuntimeStatus {
        let observedAt = Int(now.timeIntervalSince1970 * 1000)
        let execution = ProviderExecutionHealth(
            configDigest: String(repeating: "a", count: 64),
            observedAt: observedAt,
            providers: [
                providerExecutionEntry(
                    reason: reason,
                    operatorAction: operatorAction,
                    recovery: recovery,
                    remainingWork: remainingWork,
                ),
            ],
            runId: "provider-run",
            schemaId: "saqi.provider-execution-health",
            schemaVersion: 1,
        )
        return RuntimeStatus(
            configDigest: String(repeating: "a", count: 64),
            observedAt: "1970-01-01T00:16:40.000Z",
            ownerPid: 1,
            resourcePressure: ResourcePressureStatus(nextProbeAt: 0, reasons: [], state: "ready"),
            runId: "run",
            workload: RuntimeWorkload(providerExecution: execution),
        )
    }

    func providerExecutionEntry(
        reason: String,
        operatorAction: String,
        recovery: String,
        remainingWork: Int,
    ) -> ProviderExecutionEntry {
        ProviderExecutionEntry(
            admission: ProviderExecutionAdmission(
                operatorAction: operatorAction,
                primaryReason: reason,
                recovery: recovery,
                retryAt: nil,
                state: recovery == "operator" ? "closed" : "waiting",
            ),
            credentials: ProviderCredentialHealth(
                accountEpoch: 1,
                change: "none",
                changedAt: nil,
                errorCode: nil,
                lastVerifiedAt: 1,
                materialEpoch: 1,
                retryAt: nil,
                state: "ready",
            ),
            enabled: true,
            gates: providerExecutionGates(),
            model: "gpt-5.6-sol",
            modelKey: "sol-5.6",
            progress: ProviderExecutionProgress(
                accepted: 0,
                activeInvocations: 0,
                delayedWork: 0,
                lastAcceptedAt: nil,
                readyWork: remainingWork,
                state: "idle",
                terminalWork: 0,
            ),
            provider: "sol",
            sessions: ProviderExecutionSessions(
                activeCurrentAccountEpoch: 0,
                activePreviousAccountEpoch: 0,
                activeUnattributed: 0,
            ),
            throughput: nil,
        )
    }

    func providerExecutionGates() -> ProviderExecutionGates {
        ProviderExecutionGates(
            authentication: RetryGate(errorCode: nil, retryAt: nil, state: "ready"),
            budget: BudgetGate(
                budgetId: nil,
                maximumOperations: 0,
                remainingOperations: 0,
                reservedOperations: 0,
                state: "unarmed",
            ),
            operator: OperatorGate(globalPaused: false, paidWorkPaused: false),
            provider: ProviderGate(errorCode: nil, retryAt: nil, state: "ready"),
            quota: QuotaGate(errorCode: nil, nextProbeAt: nil, retryAt: nil, state: "clear"),
            resources: ResourceGate(nextProbeAt: nil, reasons: [], state: "ready"),
            scheduler: SchedulerGate(
                activeInvocations: 0,
                configuredConcurrency: 1,
                nextWakeAt: nil,
                selectedConcurrency: 1,
                state: "ready",
            ),
        )
    }
}
