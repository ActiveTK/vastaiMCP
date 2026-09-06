import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VastApi } from "../src/api/vast.js";
import { VastClient } from "../src/client.js";
import type { VastConfig } from "../src/config.js";
import { FleetManager, selfDestructSnippet } from "../src/fleet/manager.js";
import { FleetStore } from "../src/fleet/state.js";
import { sleep } from "../src/util.js";

const cfg: VastConfig = { apiKey: "k", baseUrl: "https://x", sshPrivateKeyPath: undefined, sshPublicKey: undefined, retry: 1 };

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Fake vast.ai covering: bundles search, asks create, v1 instance list, single get, bulk + single delete.
 * Instances progress created -> loading -> running on each list poll unless a script says otherwise.
 */
function fakeApi(opts: { offers?: number; createFailsFor?: number[]; bulkDeleteFails?: number; dieAfterRunning?: number[]; sameMachine?: boolean; stuckOnStart?: number } = {}) {
  const calls: Call[] = [];
  let stuckLeft = opts.stuckOnStart ?? 0;
  const live = new Map<number, { label: string | null; status: string; polls: number; machine_id: number; dph: number }>();
  let nextId = 5000;
  let bulkFailsLeft = opts.bulkDeleteFails ?? 0;
  const offers = Array.from({ length: opts.offers ?? 6 }, (_, i) => ({
    id: 100 + i,
    machine_id: opts.sameMachine ? 1 : 10 + i,
    gpu_name: "RTX 3060",
    num_gpus: 1,
    gpu_ram: 12000,
    cpu_cores_effective: 64 - i * 4,
    cpu_ram: 128000,
    dph_total: 0.1 + i * 0.01,
    rented: false,
  }));
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const listRows = () =>
    [...live.entries()].map(([id, s]) => ({
      id, machine_id: s.machine_id, label: s.label, actual_status: s.status, intended_status: "running", gpu_name: "RTX 3060", num_gpus: 1,
      dph_total: s.dph, start_date: Date.now() / 1000, ssh_host: "ssh.vast.ai", ssh_port: 2000 + id, image_runtype: "ssh_proxy", extra_env: [],
    }));
  const advance = () => {
    for (const [id, s] of live) {
      s.polls++;
      if (s.status === "created") s.status = "loading";
      else if (s.status === "loading") s.status = "running";
      else if (s.status === "running" && opts.dieAfterRunning?.includes(id) && s.polls > 3) s.status = "exited";
    }
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/v0/ssh/") return json({ ssh_keys: [] });
    if (url.pathname === "/api/v0/bundles/" && method === "POST") return json({ offers: offers.slice(0, body.limit ?? offers.length) });
    const ask = url.pathname.match(/^\/api\/v0\/asks\/(\d+)\/$/);
    if (ask && method === "PUT") {
      const offerId = Number(ask[1]);
      if (opts.createFailsFor?.includes(offerId)) return json({ success: false, msg: "no_such_ask" }, 400);
      const id = nextId++;
      const o = offers.find((x) => x.id === offerId)!;
      live.set(id, { label: body.label ?? null, status: "created", polls: 0, machine_id: o.machine_id, dph: o.dph_total });
      return json({ success: true, new_contract: id });
    }
    if (url.pathname === "/api/v1/instances/" && method === "GET") {
      advance();
      return json({ instances: listRows(), next_token: null });
    }
    const one = url.pathname.match(/^\/api\/v0\/instances\/(\d+)\/$/);
    if (one && method === "GET") {
      const s = live.get(Number(one[1]));
      return json({ instances: s ? listRows().find((r) => r.id === Number(one[1])) : null });
    }
    if (one && method === "DELETE") {
      live.delete(Number(one[1]));
      return json({ success: true });
    }
    if (url.pathname === "/api/v0/instances/" && method === "PUT") {
      for (const id of body.ids as number[]) {
        const s = live.get(id);
        if (!s) continue;
        if (body.state === "stopped") s.status = "stopped";
        else if (stuckLeft > 0) {
          stuckLeft--;
          s.status = "stuck";
        } else s.status = "loading";
      }
      return json({ success: true });
    }
    if (url.pathname === "/api/v0/instances/" && method === "DELETE") {
      if (bulkFailsLeft > 0) {
        bulkFailsLeft--;
        return json({ success: false, msg: "temporarily unavailable" }, 500);
      }
      for (const id of body.instance_ids) live.delete(id);
      return json({ success: true });
    }
    return json({ msg: `unhandled ${method} ${url.pathname}` }, 404);
  }) as typeof fetch;
  return { api: new VastApi(new VastClient("https://x", "k", 1, fetchImpl)), calls, live, offers };
}

const dirs: string[] = [];
function tmpStore() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vastai-mcp-fleet-"));
  dirs.push(d);
  return new FleetStore(d);
}
const managers: FleetManager[] = [];
function manager(api: VastApi, store: FleetStore, extra: ConstructorParameters<typeof FleetManager>[3] = {}) {
  const m = new FleetManager(api, cfg, store, { pollIntervalS: 0.05, tickIntervalS: 0.2, createMarginS: 0, ...extra });
  managers.push(m);
  return m;
}
afterEach(() => {
  for (const m of managers.splice(0)) m.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("selfDestructSnippet", () => {
  it("uses CONTAINER_API_KEY / CONTAINER_ID and the configured base url", () => {
    const s = selfDestructSnippet("https://console.vast.ai", 900);
    expect(s).toContain("sleep 900");
    expect(s).toContain('$CONTAINER_API_KEY');
    expect(s).toContain("https://console.vast.ai/api/v0/instances/$CONTAINER_ID/");
  });
});

describe("FleetManager.launch", () => {
  it("dry_run reports candidates and cost without creating", async () => {
    const { api, calls } = fakeApi();
    const m = manager(api, tmpStore());
    const r = await m.launch({ count: 3, ttl_minutes: 60, image: "i", dry_run: true, filters: { strategy: "most_cpu" } });
    expect(r.dry_run?.candidates).toHaveLength(3);
    expect(r.dry_run?.estimated_cost_usd).toBeCloseTo((0.1 + 0.11 + 0.12) * 1, 5);
    expect(calls.some((c) => c.path.startsWith("/api/v0/asks/"))).toBe(false);
    const search = calls.find((c) => c.path === "/api/v0/bundles/")!.body as Record<string, unknown>;
    expect(search.order).toEqual([["cpu_cores_effective", "desc"], ["dph_total", "asc"]]);
    expect(search.limit).toBe(Math.ceil(3 * 1.5) + 10);
  });

  it("refuses when the cost cap is exceeded", async () => {
    const { api } = fakeApi();
    const m = manager(api, tmpStore());
    await expect(m.launch({ count: 3, ttl_minutes: 600, image: "i", max_total_cost_usd: 1 })).rejects.toThrow(/exceeds max_total_cost_usd/);
  });

  it("creates count instances, skipping failed offers, labels them, persists, and destroys them all at the deadline", async () => {
    const { api, calls, live } = fakeApi({ createFailsFor: [100] });
    const store = tmpStore();
    const m = manager(api, store);
    const r = await m.launch({ name: "t1", count: 3, ttl_minutes: 2 / 60, image: "i", onstart_cmd: "echo hi", self_destruct: true });
    const f = r.fleet!;
    expect(f.state).toBe("active");
    expect(f.alive).toBe(3);
    expect(f.create_failures).toBe(1);
    expect(store.get("t1")?.members.map((x) => x.offer_id).sort()).toEqual([101, 102, 103]);
    const ask = calls.find((c) => c.path === "/api/v0/asks/101/")!.body as Record<string, unknown>;
    expect(ask.label).toBe("fleet:t1");
    expect(ask.cancel_unavail).toBe(true);
    expect(String(ask.onstart)).toMatch(/self-destruct[\s\S]*echo hi/);
    expect(live.size).toBe(3);

    // wait past the 1 s deadline; the timer must destroy everything and verify
    for (let i = 0; i < 60 && store.get("t1")?.state !== "terminated"; i++) await sleep(100);
    const done = store.get("t1")!;
    expect(done.state).toBe("terminated");
    expect(done.termination?.verified).toBe(true);
    expect(live.size).toBe(0);
    const bulk = calls.filter((c) => c.method === "DELETE" && c.path === "/api/v0/instances/");
    expect(bulk.length).toBeGreaterThan(0);
    expect((bulk[0].body as { instance_ids: number[] }).instance_ids).toHaveLength(3);
    expect(m.hasActiveFleets()).toBe(false);
  });

  it("de-duplicates by machine unless unique_machines=false", async () => {
    const { api } = fakeApi({ sameMachine: true });
    const m = manager(api, tmpStore());
    const r1 = await m.launch({ count: 3, ttl_minutes: 60, image: "i", dry_run: true });
    expect(r1.dry_run?.after_dedupe).toBe(1);
    const r2 = await m.launch({ count: 3, ttl_minutes: 60, image: "i", dry_run: true, unique_machines: false });
    expect(r2.dry_run?.after_dedupe).toBe(6);
  });

  it("replaces members that exit before the deadline", async () => {
    const { api, live } = fakeApi();
    const m = manager(api, tmpStore());
    const r = await m.launch({ name: "t2", count: 2, ttl_minutes: 30, image: "i" });
    const first = r.fleet!;
    expect(first.alive).toBe(2);
    // kill one instance externally
    const victim = [...live.keys()][0];
    live.get(victim)!.status = "exited";
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const f = m.get("t2")!;
      if (f.replacements_made >= 1 && f.members.filter((x) => !x.destroyed_at).length === 2) break;
    }
    const f = m.get("t2")!;
    expect(f.replacements_made).toBe(1);
    const dead = f.members.find((x) => x.instance_id === victim)!;
    expect(dead.destroyed_at).toBeDefined();
    expect(dead.replaced_by).toBeDefined();
    expect(f.members.filter((x) => !x.destroyed_at)).toHaveLength(2);
    await m.terminate("t2", "test");
  });
});

describe("FleetManager.control (warm pool: wait → stop → start)", () => {
  it("waits for a running streak, stops everything, then starts everything at once", async () => {
    const { api, calls, live } = fakeApi();
    const m = manager(api, tmpStore());
    await m.launch({ name: "c1", count: 3, ttl_minutes: 30, image: "i" });
    const w = await m.control("c1", "wait", { runningStreak: 2, pollS: 2 });
    expect(w.ok).toBe(true);
    expect(w.reached).toBe(3);
    expect(m.summarize(m.get("c1")!).totals.vcpus).toBe(64 + 60 + 56);

    const s = await m.control("c1", "stop", { pollS: 2 });
    expect(s.ok).toBe(true);
    expect(s.target).toBe("stopped");
    expect([...live.values()].every((x) => x.status === "stopped")).toBe(true);
    const stopCall = calls.find((c) => c.method === "PUT" && c.path === "/api/v0/instances/" && (c.body as { state: string }).state === "stopped")!;
    expect((stopCall.body as { ids: number[] }).ids).toHaveLength(3);

    const st = await m.control("c1", "start", { runningStreak: 2, pollS: 2 });
    expect(st.ok).toBe(true);
    expect(st.reached).toBe(3);
    expect(st.destroyed_ids).toEqual([]);
    expect([...live.values()].every((x) => x.status === "running")).toBe(true);
    await m.terminate("c1", "test");
  }, 30_000);

  it("destroys stragglers that never come back after start", async () => {
    const { api, live } = fakeApi({ stuckOnStart: 1 });
    const m = manager(api, tmpStore());
    await m.launch({ name: "c2", count: 2, ttl_minutes: 30, image: "i" });
    await m.control("c2", "wait", { runningStreak: 1, pollS: 2 });
    await m.control("c2", "stop", { pollS: 2 });
    const st = await m.control("c2", "start", { runningStreak: 1, pollS: 2, timeoutS: 5 });
    expect(st.ok).toBe(false);
    expect(st.destroyed_ids).toHaveLength(1);
    expect(st.alive).toBe(1);
    expect(live.size).toBe(1);
    await m.terminate("c2", "test");
  }, 30_000);
});

describe("FleetManager.terminate", () => {
  it("falls back to per-instance deletes when the bulk endpoint fails, and verifies", async () => {
    const { api, calls, live } = fakeApi({ bulkDeleteFails: 1 });
    const m = manager(api, tmpStore());
    await m.launch({ name: "t3", count: 2, ttl_minutes: 30, image: "i" });
    const r = await m.terminate("t3", "test");
    expect(r.verified).toBe(true);
    expect(r.remaining_ids).toEqual([]);
    expect(live.size).toBe(0);
    expect(calls.filter((c) => c.method === "DELETE" && /\/instances\/\d+\/$/.test(c.path)).length).toBe(2);
  });

  it("adopts stray instances carrying the fleet label", async () => {
    const { api, live } = fakeApi();
    const m = manager(api, tmpStore());
    await m.launch({ name: "t4", count: 1, ttl_minutes: 30, image: "i" });
    live.set(9999, { label: "fleet:t4", status: "running", polls: 0, machine_id: 99, dph: 0.5 });
    const r = await m.terminate("t4", "test");
    expect(r.verified).toBe(true);
    expect(live.has(9999)).toBe(false);
    expect(m.get("t4")!.members.some((x) => x.instance_id === 9999)).toBe(true);
  });

  it("is idempotent while in flight", async () => {
    const { api } = fakeApi();
    const m = manager(api, tmpStore());
    await m.launch({ name: "t5", count: 1, ttl_minutes: 30, image: "i" });
    const [a, b] = await Promise.all([m.terminate("t5", "x"), m.terminate("t5", "y")]);
    expect(a).toBe(b);
  });
});

describe("persistence and reaping", () => {
  it("start() reaps fleets whose deadline passed while the process was down", async () => {
    const { api, live } = fakeApi();
    const store = tmpStore();
    const m1 = manager(api, store);
    await m1.launch({ name: "t6", count: 2, ttl_minutes: 30, image: "i" });
    m1.stop();
    // simulate the deadline having passed on disk
    const f = store.get("t6")!;
    f.deadline_at = Date.now() / 1000 - 10;
    store.save(f);
    expect(live.size).toBe(2);

    const m2 = manager(api, store);
    const boot = m2.start();
    expect(boot.expired).toEqual(["t6"]);
    for (let i = 0; i < 60 && store.get("t6")?.state !== "terminated"; i++) await sleep(50);
    expect(store.get("t6")?.state).toBe("terminated");
    expect(live.size).toBe(0);
  });

  it("reapOnce() destroys expired fleets synchronously (CLI path)", async () => {
    const { api, live } = fakeApi();
    const store = tmpStore();
    const m1 = manager(api, store);
    await m1.launch({ name: "t7", count: 1, ttl_minutes: 30, image: "i" });
    m1.stop();
    const f = store.get("t7")!;
    f.deadline_at = Date.now() / 1000 - 1;
    store.save(f);
    const m2 = manager(api, store);
    const results = await m2.reapOnce();
    expect(results).toHaveLength(1);
    expect(results[0].verified).toBe(true);
    expect(live.size).toBe(0);
  });

  it("extend() pushes the deadline and re-arms the timer", async () => {
    const { api, live } = fakeApi();
    const store = tmpStore();
    const m = manager(api, store);
    await m.launch({ name: "t8", count: 1, ttl_minutes: 2 / 60, image: "i" });
    const s = await m.extend("t8", 30);
    expect(s.seconds_remaining).toBeGreaterThan(1000);
    await sleep(2300);
    expect(live.size).toBe(1);
    expect(store.get("t8")?.state).toBe("active");
    await m.terminate("t8", "test");
  });
});
