import { describe, expect, it, vi } from "vitest";

import {
  isTrustedMutationRequest,
  MAX_JSON_BODY_BYTES,
  readBoundedJson,
  secureOperationsResponse,
} from "../operations-boundary";

function mutationRequest(overrides: Record<string, string> = {}) {
  return new Request("https://ops.saqi.app/api/rig/state", {
    method: "POST",
    headers: {
      host: "ops.saqi.app",
      origin: "https://ops.saqi.app",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...overrides,
    },
    body: "{}",
  });
}

describe("mutation request checks", () => {
  it("accepts exact same-origin browser metadata", () => {
    expect(isTrustedMutationRequest(mutationRequest())).toBe(true);
  });

  it.each([
    ["host", "evil.example"],
    ["origin", "https://evil.example"],
    ["sec-fetch-site", "cross-site"],
    ["sec-fetch-mode", "navigate"],
  ])("rejects invalid %s metadata", (header, value) => {
    expect(isTrustedMutationRequest(mutationRequest({ [header]: value }))).toBe(
      false
    );
  });
});

describe("response cache boundary", () => {
  it("never caches operations responses", () => {
    const html = secureOperationsResponse(new Response("ok"));
    expect(html.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(html.headers.get("pragma")).toBe("no-cache");
    expect(html.headers.get("content-security-policy")).toContain(
      "default-src 'self'"
    );
    expect(html.headers.get("content-security-policy")).toContain(
      "connect-src 'self'"
    );
  });
});

describe("bounded JSON reader", () => {
  it.each([undefined, "1"])(
    "cancels a multi-chunk overflow with content-length %s",
    async (contentLength) => {
      const cancel = vi.fn();
      const sizes = [MAX_JSON_BODY_BYTES / 2, MAX_JSON_BODY_BYTES / 2, 1];
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          cancel,
          pull(controller) {
            const size = sizes[pulls++];
            if (size === undefined) throw new Error("Read beyond overflow");
            controller.enqueue(new Uint8Array(size));
          },
        },
        { highWaterMark: 0 }
      );
      const init = {
        body,
        duplex: "half",
        headers: contentLength ? { "content-length": contentLength } : {},
        method: "POST",
      } satisfies RequestInit & { duplex: "half" };
      const request = new Request("https://ops.saqi.app/api", init);
      await expect(readBoundedJson(request)).rejects.toThrow(
        "Request body too large"
      );
      expect(pulls).toBe(3);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    }
  );

  it("parses a small JSON body", async () => {
    const request = mutationRequest({ "content-type": "application/json" });
    await expect(readBoundedJson(request)).resolves.toEqual({});
  });

  it("rejects bodies over the byte limit", async () => {
    const request = new Request("https://ops.saqi.app/api", {
      method: "POST",
      body: `"${"a".repeat(MAX_JSON_BODY_BYTES)}"`,
    });
    await expect(readBoundedJson(request)).rejects.toThrow();
  });
});
