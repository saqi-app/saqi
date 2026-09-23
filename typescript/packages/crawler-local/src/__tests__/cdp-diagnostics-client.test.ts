import { createServer } from "node:http";

import { afterEach, expect, test } from "vitest";

import { inspectCdpEndpoint } from "../runtime/cdp-diagnostics-client.js";

const TEST_SERVERS: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  const servers = [...TEST_SERVERS];
  TEST_SERVERS.length = 0;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) =>
            error ? rejectPromise(error) : resolvePromise(),
          ),
        ),
    ),
  );
});

test("reports a valid bounded Chrome DevTools endpoint", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        Browser: "Chrome/fixture",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fixture",
      }),
    );
  });
  TEST_SERVERS.push(server);
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP fixture address");

  await expect(
    inspectCdpEndpoint(`http://127.0.0.1:${String(address.port)}/`),
  ).resolves.toMatchObject({ browser: "Chrome/fixture", reachable: true });
});

test("turns connection failures into actionable diagnostics", async () => {
  await expect(
    inspectCdpEndpoint("http://127.0.0.1:1/", 100),
  ).resolves.toMatchObject({
    browser: null,
    reachable: false,
  });
});
