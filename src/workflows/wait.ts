import type { VastApi } from "../api/vast.js";
import type { Instance } from "../types.js";

export type WaitTarget = "running" | "stopped";

export interface WaitOptions {
  target: WaitTarget;
  timeoutS?: number;
  intervalS?: number;
  onProgress?: (msg: string) => void;
}

export interface WaitResult {
  ok: boolean;
  reason: string;
  instance: Instance | null;
  elapsed_s: number;
  /** De-duplicated status transitions observed while waiting, e.g. ["created", "loading", "running"]. */
  history: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll GET /instances/{id}/ until actual_status reaches the target.
 *
 * Follows the guidance in vast's own SKILL.md: `exited` / `offline` never
 * recover into `running`, and `unknown` (no host heartbeat) is treated as
 * failed after it persists for a while. Always bounded by a timeout.
 */
export async function waitForInstance(api: VastApi, id: number, opts: WaitOptions): Promise<WaitResult> {
  const timeoutS = opts.timeoutS ?? 600;
  const intervalS = Math.max(2, opts.intervalS ?? 5);
  const started = Date.now();
  const history: string[] = [];
  let unknownStreak = 0;
  let missingStreak = 0;
  let last: Instance | null = null;

  const record = (status: string) => {
    if (history[history.length - 1] !== status) {
      history.push(status);
      opts.onProgress?.(`instance ${id}: ${status}`);
    }
  };

  while (true) {
    let inst: Instance | null = null;
    try {
      inst = await api.getInstance(id);
    } catch (e) {
      // transient API errors: keep polling until timeout
      opts.onProgress?.(`instance ${id}: poll error ${(e as Error).message}`);
    }
    const elapsed = (Date.now() - started) / 1000;

    if (inst) {
      last = inst;
      missingStreak = 0;
      const status = inst.actual_status ?? "provisioning";
      const msg = inst.status_msg?.trim();
      record(msg && status !== "running" ? `${status} (${msg.slice(0, 120)})` : status);

      if (status === opts.target) {
        return { ok: true, reason: `reached ${status}`, instance: inst, elapsed_s: Math.round(elapsed), history };
      }
      if (opts.target === "running") {
        if (status === "exited" || status === "offline") {
          return { ok: false, reason: `instance entered terminal state "${status}"${msg ? `: ${msg}` : ""}`, instance: inst, elapsed_s: Math.round(elapsed), history };
        }
        if (status === "unknown") {
          unknownStreak++;
          if (unknownStreak >= 6) {
            return { ok: false, reason: "host stopped sending heartbeats (status unknown)", instance: inst, elapsed_s: Math.round(elapsed), history };
          }
        } else unknownStreak = 0;
        if (status === "stopped" && (inst.intended_status === "stopped" || inst.next_state === "stopped")) {
          return {
            ok: false,
            reason: `instance is stopped and not scheduled to start (scheduling failed, outbid, or insufficient credit)${msg ? `: ${msg}` : ""}`,
            instance: inst,
            elapsed_s: Math.round(elapsed),
            history,
          };
        }
      }
    } else {
      missingStreak++;
      if (missingStreak >= 3) {
        return { ok: false, reason: "instance no longer exists", instance: null, elapsed_s: Math.round(elapsed), history };
      }
    }

    if (elapsed >= timeoutS) {
      return { ok: false, reason: `timed out after ${timeoutS}s (last status: ${last?.actual_status ?? "unknown"})`, instance: last, elapsed_s: Math.round(elapsed), history };
    }
    await sleep(intervalS * 1000);
  }
}
