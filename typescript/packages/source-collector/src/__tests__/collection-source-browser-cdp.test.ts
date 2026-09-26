import { describe, expect, it, vi } from "vitest";

import {
  ensureCdpAnchorPage,
  ensureCdpBootstrapTarget,
  ensureCdpReplacementPage,
  reclaimCdpOrphanPages,
} from "../collection/collection-source-browser.js";

describe("CDP collector page ownership", () => {
  it("reuses an existing CDP page target", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json([{ id: "live", type: "page" }], {
          status: 200,
        }),
      ),
    );

    await expect(
      ensureCdpBootstrapTarget("http://127.0.0.1:9223/", fetchImpl),
    ).resolves.toBe("existing");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("creates a blank target when dedicated Chrome has no pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json([], { status: 200 }))
      .mockResolvedValueOnce(
        Response.json(
          { id: "new", type: "page" },
          {
            status: 200,
          },
        ),
      );

    await expect(
      ensureCdpBootstrapTarget("http://127.0.0.1:9223/", fetchImpl),
    ).resolves.toBe("created");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      new URL("http://127.0.0.1:9223/json/new?about%3Ablank"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("rejects non-loopback CDP bootstrap endpoints", async () => {
    const fetchImpl = vi.fn();
    await expect(
      // eslint-disable-next-line unicorn/prefer-https -- proving remote HTTP CDP is rejected
      ensureCdpBootstrapTarget("http://example.com:9223/", fetchImpl),
    ).rejects.toThrow("SOURCE_CDP_ENDPOINT_FORBIDDEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves a live anchor page so a later CDP handshake can reconnect", async () => {
    const newPage = vi.fn(() =>
      Promise.resolve({
        close: vi.fn(() => Promise.resolve()),
        isClosed: () => false,
      }),
    );

    await ensureCdpAnchorPage({
      pages: () => [{ close: vi.fn(), isClosed: () => false }],
      newPage,
    });

    expect(newPage).not.toHaveBeenCalled();
  });

  it("creates an anchor before disconnecting when no live target remains", async () => {
    const newPage = vi.fn(() =>
      Promise.resolve({
        close: vi.fn(() => Promise.resolve()),
        isClosed: () => false,
      }),
    );

    await ensureCdpAnchorPage({
      pages: () => [{ close: vi.fn(), isClosed: () => true }],
      newPage,
    });

    expect(newPage).toHaveBeenCalledOnce();
  });

  it("creates a replacement before retiring the final live CDP page", async () => {
    const retiringPage = { close: vi.fn(), isClosed: () => false };
    const newPage = vi.fn(() =>
      Promise.resolve({
        close: vi.fn(() => Promise.resolve()),
        isClosed: () => false,
      }),
    );

    await ensureCdpReplacementPage(
      { pages: () => [retiringPage], newPage },
      retiringPage,
    );

    expect(newPage).toHaveBeenCalledOnce();
  });

  it("reuses another live CDP page when retiring a failed page", async () => {
    const retiringPage = { close: vi.fn(), isClosed: () => false };
    const newPage = vi.fn(() =>
      Promise.resolve({
        close: vi.fn(() => Promise.resolve()),
        isClosed: () => false,
      }),
    );

    await ensureCdpReplacementPage(
      {
        pages: () => [retiringPage, { close: vi.fn(), isClosed: () => false }],
        newPage,
      },
      retiringPage,
    );

    expect(newPage).not.toHaveBeenCalled();
  });

  it("closes only live pages left by a previous collector process", async () => {
    const liveClose = vi.fn(() => Promise.resolve());
    const closedClose = vi.fn(() => Promise.resolve());
    const pages = [
      { close: liveClose, isClosed: () => false },
      { close: closedClose, isClosed: () => true },
    ];

    await reclaimCdpOrphanPages(pages);

    expect(liveClose).toHaveBeenCalledOnce();
    expect(liveClose).toHaveBeenCalledWith({
      reason: "SOURCE_COLLECTOR_ORPHAN_RECLAIMED",
    });
    expect(closedClose).not.toHaveBeenCalled();
  });

  it("fails attachment when orphan ownership cannot be reclaimed", async () => {
    const pages = [
      {
        close: vi.fn(() => Promise.reject(new Error("close failed"))),
        isClosed: () => false,
      },
    ];

    await expect(reclaimCdpOrphanPages(pages)).rejects.toThrow("close failed");
  });
});
