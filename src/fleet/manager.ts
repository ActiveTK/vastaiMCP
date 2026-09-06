/**
 * Fleet manager: launch N instances at once, keep them alive for a TTL, and
 * guarantee they are destroyed at the deadline.
 *
 * Termination guarantees are layered:
 *   1. in-process deadline timer + 30 s watchdog tick (this file)
 *   2. state persisted to disk; expired fleets are reaped on the next start or
 *      by `vastai-mcp reap` (cron-able, independent of any MCP client)
 *   3. optional in-container self-destruct via CONTAINER_API_KEY (best effort)
 *   4. bulk DELETE is verified against the instance list and retried with
 *      backoff until nothing with the fleet label remains
 */
import type { VastApi } from "../api/vast.js";
import { VastApiError } from "../client.js";
import type { VastConfig } from "../config.js";
import { buildEnv, type EnvSpec } from "../env.js";
import { sshEndpoint, summarizeOffer, type OfferSummary } from "../format.js";
import { buildOfferQuery, type OfferFilters } from "../query.js";
import type { Instance, Offer } from "../types.js";
import { chunk, nowS, pMap, sleep } from "../util.js";
import { buildCreateBody, ensureSshKeyRegistered, type Runtype } from "../workflows/launch.js";
import { FleetStore, type Fleet, type FleetCandidate, type FleetMember } from "./state.js";

export interface FleetLaunchParams {
  name?: string;
  count: number;
  ttl_minutes: number;
  filters?: OfferFilters;
  image?: string;
  template_hash?: string;
  disk_gb?: number;
  env?: EnvSpec;
  onstart_cmd?: string;
  runtype?: Runtype;
  direct?: boolean;
  bid_price?: number;
  image_login?: string;
  unique_machines?: boolean;
  overprovision?: number;
  create_concurrency?: number;
  replace_failed?: boolean;
  max_replacements?: number;
  self_destruct?: boolean;
  register_ssh_key?: boolean;
  max_total_cost_usd?: number;
  dry_run?: boolean;
  wait_for_running?: boolean;
  timeout_s?: number;
  onProgress?: (msg: string) => void;
}

export interface FleetSummary {
  name: string;
  state: string;
  label: string;
  created_at: string;
  deadline_at: string;
  seconds_remaining: number;
  ttl_minutes: number;
  target_count: number;
  counts: Record<string, number>;
  alive: number;
  running: number;
  estimated_cost_usd: number;
  hourly_cost_usd: number;
  replacements_made: number;
  create_failures: number;
  termination?: Fleet["termination"] & { remaining_ids?: number[] };
  notes: string[];
  members?: FleetMember[];
}

export interface FleetLaunchResult {
  fleet?: FleetSummary;
  dry_run?: { candidates: OfferSummary[]; estimated_cost_usd: number; search_returned: number; after_dedupe: number };
  notes: string[];
}

export interface TerminateResult {
  name: string;
  state: string;
  verified: boolean;
  destroyed: number;
  remaining_ids: number[];
  rounds: number;
  last_error?: string;
}

export interface FleetManagerOptions {
  log?: (msg: string) => void;
  pollIntervalS?: number;
  tickIntervalS?: number;
  /** Do not start new creates when fewer than this many seconds remain before the deadline (default 30). */
  createMarginS?: number;
  /** Seconds an instance may be missing from the instance list before it is considered dead and replaced (default 90). */
  goneGraceS?: number;
  onIdle?: () => void;
}

const MAX_TIMER_MS = 2 ** 31 - 1;
const TERMINAL_FOR_RUNNING = new Set(["exited", "offline"]);

/** Shell snippet that makes the container destroy itself at the deadline (requires CONTAINER_API_KEY, set by vast inside instances). */
export function selfDestructSnippet(baseUrl: string, secondsFromNow: number): string {
  const s = Math.max(30, Math.ceil(secondsFromNow));
  return (
    `(nohup sh -c 'sleep ${s}; curl -fsS -m 30 -X DELETE -H "Authorization: Bearer $CONTAINER_API_KEY" ` +
    `"${baseUrl}/api/v0/instances/$CONTAINER_ID/" >/dev/null 2>&1 || true' >/dev/null 2>&1 &) ; # vastai-mcp fleet self-destruct`
  );
}

function candidateFromOffer(o: Offer): FleetCandidate {
  const s = summarizeOffer(o);
  return { offer_id: o.id, machine_id: o.machine_id, gpu: s.gpu, cpu_cores: s.cpu_cores, cpu_ram_gb: s.cpu_ram_gb, price_per_hour: s.price_per_hour, location: s.location, min_bid: s.min_bid_per_hour };
}

export class FleetManager {
  private fleets = new Map<string, Fleet>();
  private timers = new Map<string, NodeJS.Timeout>();
  private monitors = new Set<string>();
  private terminations = new Map<string, Promise<TerminateResult>>();
  private tick?: NodeJS.Timeout;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly pollIntervalS: number;

  constructor(
    private readonly api: VastApi,
    private readonly cfg: VastConfig,
    private readonly store: FleetStore,
    private readonly opts: FleetManagerOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.pollIntervalS = opts.pollIntervalS ?? 15;
  }

  // ---- lifecycle ------------------------------------------------------

  /** Load persisted fleets, reap expired ones, re-arm timers, start the watchdog. */
  start(): { loaded: number; expired: string[]; active: string[] } {
    const expired: string[] = [];
    const active: string[] = [];
    for (const f of this.store.list()) {
      this.fleets.set(f.name, f);
      if (f.state === "terminated") continue;
      if (f.state === "terminating" || nowS() >= f.deadline_at) {
        expired.push(f.name);
        void this.terminate(f.name, f.state === "terminating" ? "resume termination after restart" : "deadline passed while server was down");
      } else {
        active.push(f.name);
        this.armTimer(f);
        this.startMonitor(f.name);
      }
    }
    const tickS = this.opts.tickIntervalS ?? 30;
    this.tick = setInterval(() => this.watchdog(), tickS * 1000);
    this.tick.unref();
    return { loaded: this.fleets.size, expired, active };
  }

  stop(): void {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  get stateDir(): string {
    return this.store.dir;
  }

  hasActiveFleets(): boolean {
    return [...this.fleets.values()].some((f) => f.state !== "terminated");
  }

  /** Terminate every fleet whose deadline has passed (or that is mid-termination) and wait for the result. */
  async reapOnce(): Promise<TerminateResult[]> {
    const out: TerminateResult[] = [];
    for (const f of this.store.list()) {
      this.fleets.set(f.name, f);
      if (f.state === "terminated") continue;
      if (f.state === "terminating" || nowS() >= f.deadline_at) out.push(await this.terminate(f.name, "reap"));
    }
    return out;
  }

  private watchdog(): void {
    if (this.stopped) return;
    const t = nowS();
    for (const f of this.fleets.values()) {
      if (f.state === "terminated") continue;
      if (f.state === "terminating" || t >= f.deadline_at) void this.terminate(f.name, "watchdog");
    }
  }

  private armTimer(f: Fleet): void {
    const existing = this.timers.get(f.name);
    if (existing) clearTimeout(existing);
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, (f.deadline_at - nowS()) * 1000));
    const t = setTimeout(() => {
      this.timers.delete(f.name);
      if (nowS() >= f.deadline_at - 0.5) void this.terminate(f.name, "ttl expired");
      else this.armTimer(f);
    }, delay);
    this.timers.set(f.name, t);
  }

  private save(f: Fleet): void {
    this.fleets.set(f.name, f);
    try {
      this.store.save(f);
    } catch (e) {
      this.log(`fleet ${f.name}: failed to persist state: ${(e as Error).message}`);
    }
  }

  private checkIdle(): void {
    if (!this.hasActiveFleets()) this.opts.onIdle?.();
  }

  // ---- launch ---------------------------------------------------------

  async launch(p: FleetLaunchParams): Promise<FleetLaunchResult> {
    const notes: string[] = [];
    const progress = (m: string) => {
      this.log(m);
      p.onProgress?.(m);
    };
    if (!p.image && !p.template_hash) throw new Error("Either image or template_hash is required.");
    if (p.count < 1) throw new Error("count must be >= 1");
    if (!(p.ttl_minutes > 0)) throw new Error("ttl_minutes must be > 0");
    const name = p.name ?? `fleet-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
    if (this.fleets.get(name) && this.fleets.get(name)!.state !== "terminated") throw new Error(`fleet ${name} already exists and is ${this.fleets.get(name)!.state}`);
    const label = `fleet:${name}`;

    // SSH key registration (once per fleet, before any create)
    if ((p.register_ssh_key ?? true) && this.cfg.sshPublicKey && !p.dry_run) {
      try {
        const r = await ensureSshKeyRegistered(this.api, this.cfg.sshPublicKey);
        notes.push(r === "registered" ? "Registered SSH public key on the account." : "SSH public key already registered.");
      } catch (e) {
        notes.push(`Could not register SSH key: ${(e as Error).message}`);
      }
    }

    // Search
    const filters: OfferFilters = { ...(p.filters ?? {}) };
    const disk = p.disk_gb ?? 20;
    filters.min_disk_gb = Math.max(filters.min_disk_gb ?? 0, disk);
    filters.storage_gb = filters.storage_gb ?? disk;
    filters.type = p.bid_price !== undefined ? "bid" : (filters.type ?? "on-demand");
    const wantsPorts = (p.env?.ports?.length ?? 0) > 0;
    if (wantsPorts && filters.direct_port_count === undefined) filters.direct_port_count = 1;
    const overprovision = p.overprovision ?? 1.5;
    filters.limit = Math.min(2000, Math.ceil(p.count * overprovision) + 10);
    const query = buildOfferQuery(filters);
    progress(`fleet ${name}: searching offers (limit ${filters.limit})`);
    let offers = await this.api.searchOffers(query);
    const searchReturned = offers.length;
    if (p.bid_price !== undefined) offers = offers.filter((o) => !(typeof o.min_bid === "number" && o.min_bid > p.bid_price!));
    if (p.unique_machines ?? true) {
      const seen = new Set<number>();
      offers = offers.filter((o) => (seen.has(o.machine_id) ? false : (seen.add(o.machine_id), true)));
    }
    if (!offers.length) throw new Error("No offers matched the filters.");
    if (offers.length < p.count) notes.push(`Only ${offers.length} distinct offers matched; the fleet will be smaller than ${p.count} unless more become available.`);

    const candidates = offers.map(candidateFromOffer);
    const estimate = candidates.slice(0, p.count).reduce((a, c) => a + (c.price_per_hour ?? 0), 0) * (p.ttl_minutes / 60);
    if (p.max_total_cost_usd !== undefined && estimate > p.max_total_cost_usd) {
      throw new Error(`Estimated cost $${estimate.toFixed(2)} for ${Math.min(p.count, candidates.length)} instances x ${p.ttl_minutes} min exceeds max_total_cost_usd=${p.max_total_cost_usd}. Nothing was created.`);
    }
    if (p.dry_run) {
      return { notes, dry_run: { candidates: offers.slice(0, p.count).map(summarizeOffer), estimated_cost_usd: Number(estimate.toFixed(2)), search_returned: searchReturned, after_dedupe: offers.length } };
    }

    // Fleet record
    const body = buildCreateBody({
      image: p.image, template_hash: p.template_hash, disk_gb: disk, env: p.env, onstart_cmd: p.onstart_cmd,
      runtype: p.runtype, direct: p.direct, bid_price: p.bid_price, image_login: p.image_login, cancel_unavail: true, label,
    });
    const createdAt = nowS();
    const fleet: Fleet = {
      name, label, created_at: createdAt, deadline_at: createdAt + p.ttl_minutes * 60, ttl_minutes: p.ttl_minutes,
      target_count: p.count, state: "launching",
      spec: { image: p.image, template_hash: p.template_hash, disk_gb: disk, env: body.env, onstart: p.onstart_cmd, runtype: body.runtype, bid_price: p.bid_price, image_login: p.image_login, self_destruct: p.self_destruct ?? true },
      query, members: [], candidates, create_failures: [],
      replace_failed: p.replace_failed ?? true, max_replacements: p.max_replacements ?? p.count, replacements_made: 0, notes,
    };
    if (fleet.spec.self_destruct && p.template_hash) notes.push("self_destruct adds an onstart script; if the template defines its own onstart the server may ignore ours, so rely on the deadline timer / reap for that case.");
    this.save(fleet);
    this.armTimer(fleet);

    // Create
    progress(`fleet ${name}: creating up to ${p.count} instances from ${candidates.length} candidates`);
    await this.createFromCandidates(fleet, p.count, p.create_concurrency ?? 8, progress);
    fleet.state = "active";
    if (!fleet.members.length) {
      fleet.notes.push("No instance could be created; fleet terminated.");
      this.save(fleet);
      await this.terminate(name, "nothing created");
      return { fleet: this.summarize(fleet), notes: fleet.notes };
    }
    if (fleet.members.length < p.count) fleet.notes.push(`Created ${fleet.members.length}/${p.count}; ${fleet.create_failures.length} offer(s) failed at create.`);
    this.save(fleet);
    this.startMonitor(name);

    if (p.wait_for_running) {
      const deadline = Date.now() + (p.timeout_s ?? 600) * 1000;
      while (Date.now() < deadline && fleet.state === "active") {
        const running = fleet.members.filter((m) => !m.destroyed_at && m.status === "running").length;
        const alive = fleet.members.filter((m) => !m.destroyed_at).length;
        if (running >= alive && alive > 0 && fleet.members.some((m) => m.status)) break;
        await sleep(Math.min(this.pollIntervalS, 5) * 1000);
      }
    }
    return { fleet: this.summarize(fleet), notes: fleet.notes };
  }

  private bodyFor(fleet: Fleet) {
    const secs = fleet.deadline_at - nowS();
    const parts: string[] = [];
    if (fleet.spec.self_destruct) parts.push(selfDestructSnippet(this.cfg.baseUrl, secs));
    if (fleet.spec.onstart) parts.push(fleet.spec.onstart);
    return {
      client_id: "me", image: fleet.spec.image, env: fleet.spec.env, price: fleet.spec.bid_price ?? null, disk: fleet.spec.disk_gb,
      label: fleet.label, onstart: parts.length ? parts.join("\n") : null, image_login: fleet.spec.image_login ?? null,
      python_utf8: false, lang_utf8: false, use_jupyter_lab: false, jupyter_dir: null, force: false, cancel_unavail: true,
      template_hash_id: fleet.spec.template_hash ?? null, user: null, ...(fleet.spec.runtype ? { runtype: fleet.spec.runtype } : {}),
    };
  }

  /** Pull candidates in rank order until `wanted` new members exist or the pool is empty. */
  private async createFromCandidates(fleet: Fleet, wanted: number, concurrency: number, progress: (m: string) => void, replacementOf?: number): Promise<number> {
    let created = 0;
    let inflight = 0;
    let fatal: string | undefined;
    const used = new Set<number>([...fleet.members.map((m) => m.offer_id), ...fleet.create_failures.map((f) => f.offer_id)]);
    const queue = fleet.candidates.filter((c) => !used.has(c.offer_id));
    const worker = async () => {
      // Only start a create when it could still be needed: created + in-flight < wanted (never over-provision).
      while (!fatal && created + inflight < wanted && nowS() < fleet.deadline_at - (this.opts.createMarginS ?? 30)) {
        const c = queue.shift();
        if (!c) return;
        inflight++;
        try {
          const r = await this.api.createInstance(c.offer_id, this.bodyFor(fleet));
          if (!r.success || !r.new_contract) {
            fleet.create_failures.push({ offer_id: c.offer_id, error: r.msg ?? r.error ?? JSON.stringify(r), at: nowS() });
            continue;
          }
          if (created >= wanted) {
            // raced past the target; destroy the extra immediately
            await this.api.destroyInstance(r.new_contract).catch(() => {});
            continue;
          }
          created++;
          const m: FleetMember = { instance_id: r.new_contract, offer_id: c.offer_id, machine_id: c.machine_id, gpu: c.gpu, cpu_cores: c.cpu_cores, cpu_ram_gb: c.cpu_ram_gb, price_per_hour: c.price_per_hour, location: c.location, created_at: nowS(), status: "created" };
          if (replacementOf) m.replacement_of = replacementOf;
          fleet.members.push(m);
          this.save(fleet);
          progress(`fleet ${fleet.name}: created instance ${r.new_contract} from offer ${c.offer_id} (${fleet.members.filter((x) => !x.destroyed_at).length} alive)`);
        } catch (e) {
          const msg = e instanceof VastApiError ? e.message : (e as Error).message;
          fleet.create_failures.push({ offer_id: c.offer_id, error: msg, at: nowS() });
          if (e instanceof VastApiError && (e.status === 401 || e.status === 403 || /credit|balance/i.test(msg))) fatal = msg;
        } finally {
          inflight--;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    if (fatal) fleet.notes.push(`Stopped creating: ${fatal}`);
    this.save(fleet);
    return created;
  }

  // ---- monitor --------------------------------------------------------

  private startMonitor(name: string): void {
    if (this.monitors.has(name)) return;
    this.monitors.add(name);
    void (async () => {
      try {
        while (!this.stopped) {
          const fleet = this.fleets.get(name);
          if (!fleet || fleet.state === "terminated" || fleet.state === "terminating") break;
          try {
            await this.refresh(fleet);
          } catch (e) {
            this.log(`fleet ${name}: monitor error ${(e as Error).message}`);
          }
          await sleep(this.pollIntervalS * 1000);
        }
      } finally {
        this.monitors.delete(name);
      }
    })();
  }

  /** One observation pass: update member statuses from the instance list, adopt strays, replace dead members. */
  async refresh(fleet: Fleet): Promise<Instance[]> {
    const rows = await this.api.listInstances();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const t = nowS();
    for (const m of fleet.members) {
      if (m.destroyed_at) continue;
      const r = byId.get(m.instance_id);
      if (!r) {
        // The v1 list can lag a fresh create; remember when we first missed it and let the replacement rule apply a grace period.
        m.status = "gone";
        m.gone_since ??= t;
        continue;
      }
      delete m.gone_since;
      applyInstance(m, r, t);
    }
    // Adopt instances carrying our label that we do not know about (e.g. create succeeded but the process died before persisting).
    for (const r of rows) {
      if (r.label === fleet.label && !fleet.members.some((m) => m.instance_id === r.id)) {
        const m: FleetMember = { instance_id: r.id, offer_id: 0, machine_id: r.machine_id, created_at: r.start_date ?? t, gpu: `${r.num_gpus}x ${r.gpu_name}`, price_per_hour: r.dph_total };
        applyInstance(m, r, t);
        fleet.members.push(m);
        fleet.notes.push(`Adopted stray instance ${r.id} carrying label ${fleet.label}.`);
      }
    }
    // Replace members that died before/after running while there is still meaningful time left.
    if (fleet.state === "active" && fleet.replace_failed && fleet.deadline_at - t > 180) {
      const goneGraceS = this.opts.goneGraceS ?? 90;
      const dead = fleet.members.filter(
        (m) =>
          !m.destroyed_at &&
          !m.replaced_by &&
          (TERMINAL_FOR_RUNNING.has(m.status ?? "") || (m.status === "gone" && !m.running_at && t - (m.gone_since ?? t) > goneGraceS && t - m.created_at > goneGraceS)),
      );
      for (const m of dead) {
        if (fleet.replacements_made >= fleet.max_replacements) break;
        if (m.status !== "gone") {
          try {
            await this.api.destroyInstance(m.instance_id);
          } catch (e) {
            m.destroy_error = (e as Error).message;
          }
        }
        m.destroyed_at = t;
        fleet.replacements_made++;
        const before = fleet.members.length;
        await this.createFromCandidates(fleet, 1, 1, this.log, m.instance_id);
        if (fleet.members.length > before) m.replaced_by = fleet.members[fleet.members.length - 1].instance_id;
      }
    }
    this.save(fleet);
    return rows;
  }

  // ---- terminate ------------------------------------------------------

  terminate(name: string, reason: string): Promise<TerminateResult> {
    const inflight = this.terminations.get(name);
    if (inflight) return inflight;
    const p = this.terminateInner(name, reason).finally(() => this.terminations.delete(name));
    this.terminations.set(name, p);
    return p;
  }

  private async terminateInner(name: string, reason: string): Promise<TerminateResult> {
    const fleet = this.fleets.get(name) ?? this.store.get(name);
    if (!fleet) throw new Error(`unknown fleet ${name}`);
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
    if (fleet.state === "terminated") {
      return { name, state: fleet.state, verified: true, destroyed: fleet.members.filter((m) => m.destroyed_at).length, remaining_ids: [], rounds: fleet.termination?.rounds ?? 0 };
    }
    fleet.state = "terminating";
    fleet.termination = fleet.termination ?? { requested_at: nowS(), reason, rounds: 0, verified: false };
    this.save(fleet);
    this.log(`fleet ${name}: terminating (${reason})`);

    let remaining: number[] = [];
    const maxRounds = 8;
    for (let round = 0; round < maxRounds; round++) {
      fleet.termination.rounds++;
      // adopt strays by label so nothing with our label survives
      try {
        const rows = await this.api.listInstances();
        for (const r of rows) {
          if (r.label === fleet.label && !fleet.members.some((m) => m.instance_id === r.id)) {
            fleet.members.push({ instance_id: r.id, offer_id: 0, machine_id: r.machine_id, created_at: r.start_date ?? nowS(), status: r.actual_status ?? "provisioning" });
          }
        }
      } catch (e) {
        fleet.termination.last_error = `list: ${(e as Error).message}`;
      }
      const ids = fleet.members.filter((m) => !m.destroyed_at).map((m) => m.instance_id);
      if (ids.length) {
        await pMap(chunk(ids, 64), async (ids64) => {
          try {
            await this.api.destroyInstances(ids64);
          } catch (e) {
            fleet.termination!.last_error = `bulk delete: ${(e as Error).message}`;
            await pMap(ids64, async (id) => {
              try {
                await this.api.destroyInstance(id);
              } catch (e2) {
                const m = fleet.members.find((x) => x.instance_id === id);
                if (m) m.destroy_error = (e2 as Error).message;
              }
            }, 8);
          }
        }, 4);
      }
      // verify
      await sleep(ids.length ? 2000 : 0);
      try {
        const rows = await this.api.listInstances();
        const present = new Set(rows.map((r) => r.id));
        const t = nowS();
        for (const m of fleet.members) {
          if (!m.destroyed_at && !present.has(m.instance_id)) m.destroyed_at = t;
        }
        remaining = fleet.members.filter((m) => !m.destroyed_at).map((m) => m.instance_id);
        const strays = rows.filter((r) => r.label === fleet.label).map((r) => r.id);
        remaining = [...new Set([...remaining, ...strays])];
      } catch (e) {
        fleet.termination.last_error = `verify: ${(e as Error).message}`;
        remaining = ids;
      }
      this.save(fleet);
      if (!remaining.length) {
        fleet.state = "terminated";
        fleet.termination.finished_at = nowS();
        fleet.termination.verified = true;
        this.save(fleet);
        this.log(`fleet ${name}: terminated, ${fleet.members.filter((m) => m.destroyed_at).length} instance(s) destroyed`);
        this.checkIdle();
        return { name, state: fleet.state, verified: true, destroyed: fleet.members.filter((m) => m.destroyed_at).length, remaining_ids: [], rounds: fleet.termination.rounds };
      }
      this.log(`fleet ${name}: ${remaining.length} instance(s) still present after round ${round + 1}; retrying`);
      await sleep(Math.min(30_000, 1000 * 2 ** round));
    }
    // Give up for now; retry in 60 s (a ref'd timer, so the process stays alive), and `reap` covers restarts.
    fleet.notes.push(`Termination incomplete after ${maxRounds} rounds; ${remaining.length} instance(s) remain: ${remaining.join(", ")}. Will keep retrying.`);
    this.save(fleet);
    if (!this.stopped) {
      const t = setTimeout(() => {
        this.timers.delete(name);
        void this.terminate(name, "retry");
      }, 60_000);
      this.timers.set(name, t);
    }
    return { name, state: fleet.state, verified: false, destroyed: fleet.members.filter((m) => m.destroyed_at).length, remaining_ids: remaining, rounds: fleet.termination.rounds, last_error: fleet.termination.last_error };
  }

  // ---- queries --------------------------------------------------------

  get(name: string): Fleet | undefined {
    return this.fleets.get(name) ?? this.store.get(name);
  }

  list(): FleetSummary[] {
    const names = new Set([...this.fleets.keys(), ...this.store.list().map((f) => f.name)]);
    return [...names].map((n) => this.summarize(this.get(n)!)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async extend(name: string, minutes: number): Promise<FleetSummary> {
    const f = this.get(name);
    if (!f) throw new Error(`unknown fleet ${name}`);
    if (f.state !== "active" && f.state !== "launching") throw new Error(`fleet ${name} is ${f.state}`);
    f.deadline_at = Math.max(f.deadline_at, nowS()) + minutes * 60;
    f.ttl_minutes = Math.round((f.deadline_at - f.created_at) / 60);
    f.notes.push(`Deadline extended by ${minutes} min (in-container self-destruct timers, if any, still fire at the original deadline).`);
    this.save(f);
    this.armTimer(f);
    return this.summarize(f);
  }

  /** Members that are currently running, with fresh SSH endpoints. */
  async runningMembers(name: string): Promise<{ member: FleetMember; instance: Instance }[]> {
    const f = this.get(name);
    if (!f) throw new Error(`unknown fleet ${name}`);
    const rows = await this.refresh(f);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return f.members
      .filter((m) => !m.destroyed_at && m.status === "running")
      .map((m) => ({ member: m, instance: byId.get(m.instance_id)! }))
      .filter((x) => x.instance);
  }

  summarize(f: Fleet, opts: { members?: boolean } = {}): FleetSummary {
    const t = nowS();
    const counts: Record<string, number> = {};
    let hourly = 0;
    let cost = 0;
    for (const m of f.members) {
      const key = m.destroyed_at ? "destroyed" : (m.status ?? "created");
      counts[key] = (counts[key] ?? 0) + 1;
      const price = m.price_per_hour ?? 0;
      const end = m.destroyed_at ?? t;
      if (!m.destroyed_at && m.status === "running") hourly += price;
      if (m.running_at) cost += (price * Math.max(0, end - m.running_at)) / 3600;
    }
    const alive = f.members.filter((m) => !m.destroyed_at).length;
    const s: FleetSummary = {
      name: f.name, state: f.state, label: f.label,
      created_at: new Date(f.created_at * 1000).toISOString(), deadline_at: new Date(f.deadline_at * 1000).toISOString(),
      seconds_remaining: Math.max(0, Math.round(f.deadline_at - t)), ttl_minutes: f.ttl_minutes, target_count: f.target_count,
      counts, alive, running: counts.running ?? 0,
      estimated_cost_usd: Number(cost.toFixed(3)), hourly_cost_usd: Number(hourly.toFixed(3)),
      replacements_made: f.replacements_made, create_failures: f.create_failures.length,
      termination: f.termination ? { ...f.termination, remaining_ids: f.state === "terminated" ? undefined : f.members.filter((m) => !m.destroyed_at).map((m) => m.instance_id) } : undefined,
      notes: f.notes,
    };
    if (opts.members) s.members = f.members;
    return s;
  }
}

function applyInstance(m: FleetMember, r: Instance, t: number): void {
  m.status = r.actual_status ?? "provisioning";
  m.status_message = r.status_msg?.trim() || undefined;
  if (m.status === "running" && !m.running_at) m.running_at = t;
  const ep = sshEndpoint(r);
  if (ep) m.ssh = { host: ep.host, port: ep.port, direct: ep.direct };
  if (r.public_ipaddr) m.public_ip = r.public_ipaddr;
  if (typeof r.dph_total === "number") m.price_per_hour = r.dph_total;
  if (!m.machine_id) m.machine_id = r.machine_id;
}
