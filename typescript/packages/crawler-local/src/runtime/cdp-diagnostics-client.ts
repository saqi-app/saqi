import { get } from "node:http";

import { z } from "zod";

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const CdpVersionSchema = z.looseObject({
  Browser: z.string().trim().min(1),
  webSocketDebuggerUrl: z.url(),
});

export interface CdpDiagnostic {
  readonly browser: null | string;
  readonly detail: null | string;
  readonly endpoint: string;
  readonly reachable: boolean;
}

/** Bounded, read-only probe of Chrome's local DevTools discovery endpoint. */
export function inspectCdpEndpoint(
  endpoint: string,
  timeoutMs = 2_000,
): Promise<CdpDiagnostic> {
  const versionUrl = new URL("json/version", endpoint);
  return new Promise((resolvePromise) => {
    const request = get(versionUrl, { timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAXIMUM_RESPONSE_BYTES) request.destroy();
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200)
            throw new Error(`HTTP_${String(response.statusCode ?? "UNKNOWN")}`);
          const version = CdpVersionSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          resolvePromise({
            browser: version.Browser,
            detail: null,
            endpoint,
            reachable: true,
          });
        } catch (error) {
          resolvePromise(failed(endpoint, error));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("TIMEOUT")));
    request.once("error", (error) => resolvePromise(failed(endpoint, error)));
  });
}

function failed(endpoint: string, error: unknown): CdpDiagnostic {
  return {
    browser: null,
    detail: error instanceof Error ? error.message : String(error),
    endpoint,
    reachable: false,
  };
}
