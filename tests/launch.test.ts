import { describe, expect, it } from "vitest";
import { VastApi } from "../src/api/vast.js";
import { VastClient } from "../src/client.js";
import type { VastConfig } from "../src/config.js";
import { buildCreateBody, candidateFilters, launchInstance, runtypeString, sshKeyIdentity } from "../src/workflows/launch.js";
import { waitForInstance } from "../src/workflows/wait.js";

const cfg: VastConfig = { apiKey: "k", baseUrl: "https://x", sshPrivateKeyPath: undefined, sshPublicKey: "ssh-ed25519 AAAATEST user@host", retry: 1 };

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Minimal fake of the vast.ai API covering the launch workflow. */
function fakeApi(opts: { createFailsFor?: number[]; statusSequence?: Record<number, string[]> }) {
  const calls: Call[] = [];
  const sshKeys: { id: number; ssh_key: string }[] = [];
  const instances = new Map<number, { actual_status: string | null; polls: number }>();
  let nextId = 1000;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: url.pathname, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

    if (url.pathname === "/api/v0/ssh/" && method === "GET") return json({ ssh_keys: sshKeys });
    if (url.pathname === "/api/v0/ssh/" && method === "POST") {
      sshKeys.push({ id: 1, ssh_key: body.ssh_key });
      return json({ success: true });
    }
    if (url.pathname === "/api/v0/bundles/" && method === "POST") {
      return json({ offers: [
        { id: 11, machine_id: 1, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24576, dph_total: 0.4, rented: false },
        { id: 12, machine_id: 2, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24576, dph_total: 0.5, rented: false },
        { id: 13, machine_id: 3, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24576, dph_total: 0.6, rented: true },
      ] });
    }
    const ask = url.pathname.match(/^\/api\/v0\/asks\/(\d+)\/$/);
    if (ask && method === "PUT") {
      const offerId = Number(ask[1]);
      if (opts.createFailsFor?.includes(offerId)) return json({ success: false, msg: "no_such_ask" }, 400);
      const id = nextId++;
      instances.set(id, { actual_status: null, polls: 0 });
      return json({ success: true, new_contract: id });
    }
    const inst = url.pathname.match(/^\/api\/v0\/instances\/(\d+)\/$/);
    if (inst && method === "GET") {
      const id = Number(inst[1]);
      const st = instances.get(id);
      if (!st) return json({ instances: null });
      const seq = opts.statusSequence?.[id - 1000] ?? ["loading", "running"];
      const status = seq[Math.min(st.polls, seq.length - 1)];
      st.polls++;
      return json({ instances: { id, machine_id: 1, actual_status: status, intended_status: "running", gpu_name: "RTX 4090", num_gpus: 1,
        ssh_host: "ssh5.vast.ai", ssh_port: 2222, image_runtype: "ssh_direc ssh_proxy", dph_total: 0.4, start_date: Date.now() / 1000, extra_env: [] } });
    }
    if (inst && method === "DELETE") {
      instances.delete(Number(inst[1]));
      return json({ success: true });
    }
    return json({ msg: `unhandled ${method} ${url.pathname}` }, 404);
  }) as typeof fetch;
  const api = new VastApi(new VastClient("https://x", "k", 1, fetchImpl));
  return { api, calls, sshKeys };
}

describe("launch helpers", () => {
  it("runtypeString matches vast.py get_runtype", () => {
    expect(runtypeString("ssh", true)).toBe("ssh_direc ssh_proxy");
    expect(runtypeString("ssh", false)).toBe("ssh_proxy");
    expect(runtypeString("jupyter", true)).toBe("jupyter_direc ssh_direc ssh_proxy");
    expect(runtypeString("jupyter", false)).toBe("jupyter_proxy ssh_proxy");
    expect(runtypeString("args", true)).toBe("args");
  });

  it("buildCreateBody mirrors create__instance's json_blob", () => {
    const b = buildCreateBody({ image: "vastai/pytorch:@vastai-automatic-tag", disk_gb: 40, env: { env: { A: "1" }, ports: [8080] }, onstart_cmd: "echo hi", label: "x" });
    expect(b).toMatchObject({
      image: "vastai/pytorch:@vastai-automatic-tag",
      disk: 40,
      env: { A: "1", "-p 8080:8080": "1" },
      onstart: "echo hi",
      label: "x",
      runtype: "ssh_direc ssh_proxy",
      cancel_unavail: true,
      template_hash_id: null,
      price: null,
    });
    expect(buildCreateBody({ template_hash: "abc" }).runtype).toBeUndefined();
    expect(buildCreateBody({ image: "i", bid_price: 0.1 }).price).toBe(0.1);
    expect(() => buildCreateBody({})).toThrow();
  });

  it("candidateFilters derives disk / port / bid requirements", () => {
    const f = candidateFilters({ disk_gb: 50, env: { ports: [8080] }, bid_price: 0.2, filters: { gpu_name: "RTX 4090" } });
    expect(f).toMatchObject({ gpu_name: "RTX 4090", min_disk_gb: 50, storage_gb: 50, direct_port_count: 1, type: "bid" });
  });

  it("sshKeyIdentity ignores the comment", () => {
    expect(sshKeyIdentity("ssh-ed25519 AAAA me@a")).toBe(sshKeyIdentity("ssh-ed25519 AAAA other@b"));
  });
});

describe("launchInstance workflow", () => {
  it("registers the ssh key, skips rented offers, creates and waits for running", async () => {
    const { api, calls, sshKeys } = fakeApi({});
    const r = await launchInstance(api, cfg, { filters: { gpu_name: "RTX_4090" }, image: "vastai/base-image", disk_gb: 20, pollIntervalS: 0.01, wait_for_ssh: false });
    expect(r.success).toBe(true);
    expect(r.instance?.id).toBe(1000);
    expect(r.instance?.ssh?.command).toBe("ssh -p 2222 root@ssh5.vast.ai");
    expect(r.offer?.offer_id).toBe(11);
    expect(r.attempts).toEqual([expect.objectContaining({ offer_id: 11, outcome: "running", history: ["loading", "running"] })]);
    expect(sshKeys).toHaveLength(1);
    expect(r.notes.join(" ")).toMatch(/Registered SSH public key/);
    // ssh key registered before the ask
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("POST /api/v0/ssh/")).toBeLessThan(order.indexOf("PUT /api/v0/asks/11/"));
    const ask = calls.find((c) => c.path === "/api/v0/asks/11/")!;
    expect(ask.body).toMatchObject({ client_id: "me", image: "vastai/base-image", disk: 20, runtype: "ssh_direc ssh_proxy" });
  });

  it("falls back to the next offer when creation fails, and destroys instances that die", async () => {
    const { api, calls } = fakeApi({ createFailsFor: [11], statusSequence: { 0: ["loading", "exited"], 1: ["running"] } });
    // offer 11 fails at create; offer 12 -> instance 1000 which exits; then no more candidates within max_attempts=2
    const r = await launchInstance(api, cfg, { filters: { gpu_name: "RTX 4090" }, image: "i", pollIntervalS: 0.01, max_attempts: 2, wait_for_ssh: false });
    expect(r.success).toBe(false);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["create_failed", "wait_failed"]);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v0/instances/1000/")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/Destroyed instance 1000/);
  });

  it("uses an explicit offer_id without searching", async () => {
    const { api, calls } = fakeApi({});
    const r = await launchInstance(api, cfg, { offer_id: 12, image: "i", pollIntervalS: 0.01, wait_for_ssh: false, register_ssh_key: false });
    expect(r.success).toBe(true);
    expect(calls.some((c) => c.path === "/api/v0/bundles/")).toBe(false);
    expect(calls.some((c) => c.path === "/api/v0/ssh/")).toBe(false);
  });

  it("returns immediately when wait_for_running is false", async () => {
    const { api } = fakeApi({});
    const r = await launchInstance(api, cfg, { offer_id: 12, image: "i", wait_for_running: false, register_ssh_key: false });
    expect(r.success).toBe(true);
    expect(r.attempts[0].outcome).toBe("created");
  });
});

describe("waitForInstance", () => {
  it("fails fast on terminal states and reports history", async () => {
    const { api } = fakeApi({ statusSequence: { 0: ["created", "loading", "offline"] } });
    await api.createInstance(11, buildCreateBody({ image: "i" }));
    const w = await waitForInstance(api, 1000, { target: "running", intervalS: 0.01, timeoutS: 5 });
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/offline/);
    expect(w.history).toEqual(["created", "loading", "offline"]);
  });

  it("times out", async () => {
    const { api } = fakeApi({ statusSequence: { 0: ["loading"] } });
    await api.createInstance(11, buildCreateBody({ image: "i" }));
    const w = await waitForInstance(api, 1000, { target: "running", intervalS: 0.01, timeoutS: 0.1 });
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/timed out/);
  });
});
