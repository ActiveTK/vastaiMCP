import { describe, expect, it, vi } from "vitest";
import { VastApiError, VastClient } from "../src/client.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("VastClient.buildUrl (port of vast.py apiurl)", () => {
  const c = new VastClient("https://console.vast.ai", "k");
  it("prefixes /api/v0 and JSON-encodes non-string query args", () => {
    const u = new URL(c.buildUrl("/instances/1/", { owner: "me", select_filters: { a: { eq: 1 } } }));
    expect(u.pathname).toBe("/api/v0/instances/1/");
    expect(u.searchParams.get("owner")).toBe("me");
    expect(u.searchParams.get("select_filters")).toBe('{"a":{"eq":1}}');
  });
  it("keeps explicit /api/vN/ paths", () => {
    expect(c.buildUrl("/api/v1/instances/")).toBe("https://console.vast.ai/api/v1/instances/");
  });
});

describe("VastClient.request", () => {
  it("sends the bearer token and JSON body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init?.body as string)).toEqual({ state: "running" });
      return jsonResponse({ success: true });
    });
    const c = new VastClient("https://x", "secret", 3, fetchMock as unknown as typeof fetch);
    await expect(c.put("/instances/5/", { json: { state: "running" } })).resolves.toEqual({ success: true });
  });

  it("retries on 429 with backoff", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => (++n < 3 ? jsonResponse({ msg: "slow down" }, 429) : jsonResponse({ ok: 1 })));
    const c = new VastClient("https://x", "k", 5, fetchMock as unknown as typeof fetch);
    await expect(c.get("/users/current")).resolves.toEqual({ ok: 1 });
    expect(n).toBe(3);
  });

  it("raises VastApiError with the server message", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ msg: "This action requires login." }, 403));
    const c = new VastClient("https://x", undefined, 1, fetchMock as unknown as typeof fetch);
    const err = await c.get("/users/current").catch((e) => e);
    expect(err).toBeInstanceOf(VastApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("requires login");
  });
});
