/**
 * Persistent fleet state. Each fleet is one JSON file under the state
 * directory so that deadlines survive a server restart and can be enforced
 * by the `reap` CLI even when no MCP client is attached.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Query } from "../query.js";

export type FleetState = "launching" | "active" | "terminating" | "terminated";

export interface FleetMember {
  instance_id: number;
  offer_id: number;
  machine_id?: number;
  gpu?: string;
  cpu_cores?: number;
  cpu_ram_gb?: number;
  price_per_hour?: number;
  location?: string;
  created_at: number;
  running_at?: number;
  /** last observed actual_status, or "gone" when the API no longer lists it */
  status?: string;
  /** first time the instance was missing from the list (cleared when it reappears) */
  gone_since?: number;
  status_message?: string;
  ssh?: { host: string; port: number; direct: boolean };
  public_ip?: string;
  destroyed_at?: number;
  destroy_error?: string;
  replaced_by?: number;
  replacement_of?: number;
}

export interface FleetCandidate {
  offer_id: number;
  machine_id: number;
  gpu?: string;
  cpu_cores?: number;
  cpu_ram_gb?: number;
  price_per_hour?: number;
  location?: string;
  min_bid?: number;
}

export interface FleetSpec {
  image?: string;
  template_hash?: string;
  disk_gb: number;
  env: Record<string, string>;
  onstart?: string;
  runtype?: string;
  bid_price?: number;
  image_login?: string;
  self_destruct: boolean;
}

export interface FleetTermination {
  requested_at: number;
  reason: string;
  rounds: number;
  last_error?: string;
  finished_at?: number;
  verified: boolean;
}

export interface Fleet {
  name: string;
  label: string;
  created_at: number;
  deadline_at: number;
  ttl_minutes: number;
  target_count: number;
  state: FleetState;
  spec: FleetSpec;
  query: Query;
  members: FleetMember[];
  candidates: FleetCandidate[];
  create_failures: { offer_id: number; error: string; at: number }[];
  replace_failed: boolean;
  max_replacements: number;
  replacements_made: number;
  termination?: FleetTermination;
  notes: string[];
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.VAST_MCP_STATE_DIR || path.join(os.homedir(), ".vastai-mcp", "fleets");
}

export class FleetStore {
  constructor(public readonly dir: string = defaultStateDir()) {}

  private file(name: string): string {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`invalid fleet name ${JSON.stringify(name)}`);
    return path.join(this.dir, `${name}.json`);
  }

  list(): Fleet[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: Fleet[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Fleet);
      } catch {
        /* skip corrupt files */
      }
    }
    return out.sort((a, b) => a.created_at - b.created_at);
  }

  get(name: string): Fleet | undefined {
    const p = this.file(name);
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8")) as Fleet;
  }

  save(fleet: Fleet): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = this.file(fleet.name);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(fleet, null, 2));
    fs.renameSync(tmp, p);
  }

  delete(name: string): void {
    const p = this.file(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
