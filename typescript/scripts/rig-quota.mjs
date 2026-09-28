import { spawn } from "node:child_process";

// Admission only: quota never prevents recovery of an already dispatched call.
export function quotaDecision(result) {
  const snapshot = result?.rateLimitsByLimitId
    ? result.rateLimitsByLimitId.codex
    : result?.rateLimits;
  const windows = [snapshot?.primary, snapshot?.secondary].filter(
    (v) => v != null,
  );
  if (
    !windows.length ||
    windows.some(
      (v) =>
        !Number.isFinite(v.usedPercent) ||
        v.usedPercent < 0 ||
        v.usedPercent > 100,
    )
  )
    return { allowed: false, reason: "Quota unavailable" };
  const usedPercent = Math.max(...windows.map((v) => v.usedPercent));
  const exhausted = windows.filter((v) => v.usedPercent >= 80);
  const resetTimes = exhausted.map((v) => v.resetsAt).filter(Number.isFinite);
  if (usedPercent >= 80)
    return {
      allowed: false,
      reason: `Quota reserve: ${usedPercent}% used (80% stop threshold)`,
      resetsAt: resetTimes.length ? Math.max(...resetTimes) : null,
    };
  if (
    result.ordinaryUsageAllowed !== true ||
    snapshot.spendControlReached === true
  )
    return {
      allowed: false,
      reason: "Quota permission unavailable or exhausted",
    };
  return { allowed: true, usedPercent };
}

export function readQuota({ timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
      child.once("close", () => clearTimeout(killTimer));
      resolve(result);
    };
    const unavailable = () =>
      finish({ allowed: false, reason: "Quota unavailable" });
    const timer = setTimeout(unavailable, timeoutMs);
    child.once("error", unavailable);
    child.once("close", unavailable);
    child.stdin.on("error", unavailable);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1_048_576) return unavailable();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return unavailable();
        }
        if (message.id === 1) {
          if (message.error) return unavailable();
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          child.stdin.write(
            `${JSON.stringify({ id: 2, method: "account/rateLimits/read" })}\n`,
          );
        } else if (message.id === 2) {
          return finish(quotaDecision(message.result));
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "saqi_rig", version: "1.0.0" },
          capabilities: null,
        },
      })}\n`,
    );
  });
}
