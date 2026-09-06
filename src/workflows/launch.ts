/**
 * The "rent a GPU box" workflow, end to end:
 *
 *   1. make sure the local SSH public key is registered on the account
 *   2. search offers (or use an explicit offer id)
 *   3. PUT /asks/{offer}/ to create the instance
 *   4. poll until actual_status == running (destroy + try the next offer on failure)
 *   5. optionally wait until SSH accepts a connection
 *   6. return connection details
 */
import type { VastApi, CreateInstanceBody } from "../api/vast.js";
import { VastApiError } from "../client.js";
import type { VastConfig } from "../config.js";
import { readKeyMaterial } from "../config.js";
import { buildEnv, type EnvSpec } from "../env.js";
import { summarizeInstance, summarizeOffer, sshEndpoint, type InstanceSummary, type OfferSummary } from "../format.js";
import { buildOfferQuery, type OfferFilters } from "../query.js";
import { probeSsh } from "../ssh.js";
import type { Instance, Offer } from "../types.js";
import { waitForInstance } from "./wait.js";

export type Runtype = "ssh" | "jupyter" | "args";

export interface LaunchParams {
  offer_id?: number;
  filters?: OfferFilters;
  image?: string;
  template_hash?: string;
  disk_gb?: number;
  env?: EnvSpec;
  onstart_cmd?: string;
  runtype?: Runtype;
  direct?: boolean;
  jupyter_lab?: boolean;
  jupyter_dir?: string;
  entrypoint?: string;
  args?: string[];
  label?: string;
  bid_price?: number;
  image_login?: string;
  cancel_unavail?: boolean;
  ssh_public_key?: string;
  register_ssh_key?: boolean;
  wait_for_running?: boolean;
  timeout_s?: number;
  wait_for_ssh?: boolean;
  ssh_timeout_s?: number;
  max_attempts?: number;
  destroy_on_failure?: boolean;
  volume?: {
    create_from_offer_id?: number;
    link_volume_id?: number;
    mount_path: string;
    size_gb?: number;
    name?: string;
  };
  /** Poll interval for status checks (seconds); mainly for tests. */
  pollIntervalS?: number;
  onProgress?: (msg: string) => void;
}

export interface LaunchAttempt {
  offer_id: number;
  instance_id?: number;
  outcome: "running" | "created" | "create_failed" | "wait_failed";
  detail: string;
  history?: string[];
}

export interface LaunchResult {
  success: boolean;
  instance?: InstanceSummary;
  offer?: OfferSummary;
  ssh_ready?: boolean;
  attempts: LaunchAttempt[];
  notes: string[];
  error?: string;
}

/** Port of vast.py get_runtype(). */
export function runtypeString(runtype: Runtype, direct: boolean): string {
  if (runtype === "args") return "args";
  if (runtype === "jupyter") return direct ? "jupyter_direc ssh_direc ssh_proxy" : "jupyter_proxy ssh_proxy";
  return direct ? "ssh_direc ssh_proxy" : "ssh_proxy";
}

/** Compare public keys by type + key material, ignoring the trailing comment. */
export function sshKeyIdentity(key: string): string {
  const parts = key.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : key.trim();
}

/**
 * Register `publicKey` on the account if it is not already there. Keys on the
 * account are injected into every new instance, so this must happen *before*
 * PUT /asks/{id}/ (vast's SKILL.md: "create ssh-key ... do BEFORE create").
 */
export async function ensureSshKeyRegistered(api: VastApi, publicKey: string): Promise<"already_registered" | "registered"> {
  const material = readKeyMaterial(publicKey);
  if (/PRIVATE KEY/.test(material)) throw new Error("That is a private key; the public key (.pub) must be registered.");
  if (!/^ssh-|^ecdsa-|^sk-/.test(material)) throw new Error("Public key must start with ssh-ed25519 / ssh-rsa / ecdsa-... .");
  const wanted = sshKeyIdentity(material);
  const existing = await api.listSshKeys();
  if (existing.some((k) => sshKeyIdentity(k.ssh_key ?? "") === wanted)) return "already_registered";
  await api.addSshKey(material);
  return "registered";
}

export function buildCreateBody(p: LaunchParams): CreateInstanceBody {
  if (!p.image && !p.template_hash) throw new Error("Either image or template_hash is required.");
  const runtype = p.runtype ?? "ssh";
  const direct = p.direct ?? true;
  const body: CreateInstanceBody = {
    image: p.image,
    env: buildEnv(p.env ?? {}),
    price: p.bid_price ?? null,
    disk: p.disk_gb ?? 20,
    label: p.label ?? null,
    onstart: p.onstart_cmd ?? p.entrypoint ?? null,
    image_login: p.image_login ?? null,
    python_utf8: false,
    lang_utf8: false,
    use_jupyter_lab: !!p.jupyter_lab,
    jupyter_dir: p.jupyter_dir ?? null,
    force: false,
    cancel_unavail: p.cancel_unavail ?? true,
    template_hash_id: p.template_hash ?? null,
    user: null,
  };
  if (!p.template_hash) body.runtype = runtypeString(runtype, direct);
  if (runtype === "args" && p.args) body.args = p.args;
  // Port of vast.py validate_portal_config(): drop jupyter entries from PORTAL_CONFIG for non-jupyter runtypes.
  if (body.env.PORTAL_CONFIG && body.runtype && !body.runtype.includes("jupyter")) {
    const kept = body.env.PORTAL_CONFIG.split("|").filter((c) => !c.toLowerCase().includes("jupyter"));
    if (!kept.length) throw new Error("PORTAL_CONFIG must contain at least one non-jupyter entry when runtype is not jupyter.");
    body.env.PORTAL_CONFIG = kept.join("|");
  }
  if (p.volume) {
    const v = p.volume;
    if (!v.create_from_offer_id && !v.link_volume_id) throw new Error("volume needs create_from_offer_id or link_volume_id");
    if (!/^(\/)?([^/\0]+(\/)?)+$/.test(v.mount_path)) throw new Error(`invalid mount_path ${v.mount_path}`);
    body.volume_info = {
      mount_path: v.mount_path,
      create_new: !!v.create_from_offer_id,
      volume_id: (v.create_from_offer_id ?? v.link_volume_id)!,
      ...(v.name ? { name: v.name } : {}),
      ...(v.create_from_offer_id ? { size: v.size_gb ?? 15 } : v.size_gb ? { size: v.size_gb } : {}),
    };
  }
  return body;
}

export function candidateFilters(p: LaunchParams): OfferFilters {
  const f: OfferFilters = { ...(p.filters ?? {}) };
  const disk = p.disk_gb ?? 20;
  f.min_disk_gb = Math.max(f.min_disk_gb ?? 0, disk);
  f.storage_gb = f.storage_gb ?? disk;
  f.type = p.bid_price !== undefined ? "bid" : (f.type ?? "on-demand");
  // Published container ports and direct ssh need direct port mappings on the host.
  const wantsPorts = (p.env?.ports?.length ?? 0) > 0 || /-p\s/.test(p.env?.docker_options ?? "");
  if (wantsPorts && f.direct_port_count === undefined) f.direct_port_count = 1;
  f.limit = f.limit ?? Math.max(10, (p.max_attempts ?? 3) * 3);
  return f;
}

export async function launchInstance(api: VastApi, cfg: VastConfig, p: LaunchParams): Promise<LaunchResult> {
  const notes: string[] = [];
  const attempts: LaunchAttempt[] = [];
  const progress = (m: string) => p.onProgress?.(m);
  const body = buildCreateBody(p);

  // 1. SSH key
  const pub = p.ssh_public_key ?? cfg.sshPublicKey;
  if ((p.register_ssh_key ?? true) && pub) {
    try {
      const r = await ensureSshKeyRegistered(api, pub);
      notes.push(r === "registered" ? `Registered SSH public key from ${pub} on the account.` : `SSH public key from ${pub} already registered on the account.`);
    } catch (e) {
      notes.push(`Could not register SSH key: ${(e as Error).message}`);
    }
  } else if (!pub) {
    notes.push("No SSH public key configured (VAST_SSH_PUBLIC_KEY); only keys already on your vast.ai account will be injected.");
  }

  // 2. Candidates
  let candidates: Offer[];
  if (p.offer_id) {
    candidates = [{ id: p.offer_id } as Offer];
  } else {
    const q = buildOfferQuery(candidateFilters(p));
    progress("searching offers");
    candidates = await api.searchOffers(q);
    if (!candidates.length) {
      return { success: false, attempts, notes, error: "No offers matched the filters. Relax gpu_name / max_price_per_hour / region or check vast_gpu_names for exact GPU names." };
    }
    if (p.bid_price !== undefined) {
      const tooLow = candidates.filter((c) => typeof c.min_bid === "number" && c.min_bid > p.bid_price!);
      if (tooLow.length) notes.push(`${tooLow.length} candidate(s) skipped because their min_bid exceeds bid_price=${p.bid_price}.`);
      candidates = candidates.filter((c) => !(typeof c.min_bid === "number" && c.min_bid > p.bid_price!));
      if (!candidates.length) return { success: false, attempts, notes, error: "All matching offers have a min_bid above bid_price." };
    }
  }

  const maxAttempts = Math.max(1, Math.min(p.max_attempts ?? 3, candidates.length));
  const waitRunning = p.wait_for_running ?? true;

  for (let i = 0; i < maxAttempts; i++) {
    const offer = candidates[i];
    progress(`creating instance from offer ${offer.id} (attempt ${i + 1}/${maxAttempts})`);

    // 3. Create
    let instanceId: number;
    try {
      const r = await api.createInstance(offer.id, body);
      if (!r.success || !r.new_contract) {
        attempts.push({ offer_id: offer.id, outcome: "create_failed", detail: r.msg ?? r.error ?? JSON.stringify(r) });
        continue;
      }
      instanceId = r.new_contract;
    } catch (e) {
      const msg = e instanceof VastApiError ? e.message : (e as Error).message;
      attempts.push({ offer_id: offer.id, outcome: "create_failed", detail: msg });
      // Account-level problems will not be fixed by trying another offer.
      if (e instanceof VastApiError && (e.status === 401 || e.status === 403 || /credit|balance/i.test(msg))) {
        return { success: false, attempts, notes, error: msg };
      }
      continue;
    }

    if (!waitRunning) {
      const inst = await api.getInstance(instanceId);
      attempts.push({ offer_id: offer.id, instance_id: instanceId, outcome: "created", detail: "created; not waiting for running" });
      return {
        success: true,
        instance: inst ? summarizeInstance(inst) : ({ id: instanceId, status: "created" } as InstanceSummary),
        offer: offer.gpu_name ? summarizeOffer(offer) : undefined,
        attempts,
        notes,
      };
    }

    // 4. Wait for running
    const w = await waitForInstance(api, instanceId, { target: "running", timeoutS: p.timeout_s ?? 600, intervalS: p.pollIntervalS, onProgress: progress });
    if (!w.ok) {
      attempts.push({ offer_id: offer.id, instance_id: instanceId, outcome: "wait_failed", detail: w.reason, history: w.history });
      if (p.destroy_on_failure ?? true) {
        try {
          await api.destroyInstance(instanceId);
          notes.push(`Destroyed instance ${instanceId} after it failed to start (${w.reason}).`);
        } catch (e) {
          notes.push(`Instance ${instanceId} failed to start AND could not be destroyed: ${(e as Error).message}. Destroy it manually to stop storage charges.`);
        }
      } else {
        notes.push(`Instance ${instanceId} left in place (destroy_on_failure=false); storage charges continue.`);
      }
      continue;
    }

    // 5. SSH readiness
    let inst: Instance = w.instance!;
    let sshReady: boolean | undefined;
    const ep = sshEndpoint(inst);
    if ((p.wait_for_ssh ?? true) && cfg.sshPrivateKeyPath && ep) {
      const deadline = Date.now() + (p.ssh_timeout_s ?? 120) * 1000;
      sshReady = false;
      progress(`waiting for ssh on ${ep.host}:${ep.port}`);
      while (Date.now() < deadline) {
        if (await probeSsh(ep, { privateKeyPath: cfg.sshPrivateKeyPath }, 8000)) {
          sshReady = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
        inst = (await api.getInstance(instanceId)) ?? inst;
      }
      if (!sshReady) notes.push("Instance is running but SSH did not accept the configured key within ssh_timeout_s. It may still be booting; retry vast_run shortly, or check that the key on the account matches VAST_SSH_KEY.");
    } else if ((p.wait_for_ssh ?? true) && !cfg.sshPrivateKeyPath) {
      notes.push("Skipped SSH readiness check: no private key configured (VAST_SSH_KEY).");
    }

    attempts.push({ offer_id: offer.id, instance_id: instanceId, outcome: "running", detail: `running after ${w.elapsed_s}s`, history: w.history });
    const summary = summarizeInstance(inst);
    if (summary.status !== "running" && !ep) notes.push("SSH endpoint not yet published; call vast_instance again in a few seconds.");
    return {
      success: true,
      instance: summary,
      offer: offer.gpu_name ? summarizeOffer(offer) : undefined,
      ssh_ready: sshReady,
      attempts,
      notes,
    };
  }

  return {
    success: false,
    attempts,
    notes,
    error: `All ${attempts.length} attempt(s) failed. See attempts[] for per-offer details.`,
  };
}
