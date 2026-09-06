import { z } from "zod";
import { summarizeInstance } from "../format.js";
import { waitForInstance } from "../workflows/wait.js";
import { guard, instanceIdSchema, ok, progressReporter, type ToolContext } from "./common.js";

export function registerInstanceTools({ server, api }: ToolContext) {
  server.registerTool(
    "vast_list_instances",
    {
      title: "List my instances",
      description: "List all instances on the account with status, GPU, price and SSH endpoint. Filter by status or label. Running instances incur GPU charges; stopped ones incur storage charges only.",
      inputSchema: {
        status: z.array(z.string()).optional().describe('Only these actual_status values, e.g. ["running"], ["stopped","exited"].'),
        label: z.string().optional().describe("Only instances whose label contains this text."),
        include_raw: z.boolean().optional().describe("Also return the raw API objects (large)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ status, label, include_raw }) => {
      let rows = await api.listInstances();
      if (status?.length) rows = rows.filter((r) => status.includes(r.actual_status ?? "provisioning"));
      if (label) rows = rows.filter((r) => (r.label ?? "").toLowerCase().includes(label.toLowerCase()));
      const summaries = rows.map((r) => summarizeInstance(r));
      const hourly = summaries.filter((s) => s.status === "running").reduce((a, s) => a + (s.price_per_hour ?? 0), 0);
      return ok({
        count: summaries.length,
        running_cost_per_hour_usd: Number(hourly.toFixed(4)),
        instances: summaries,
        raw: include_raw ? rows : undefined,
      });
    }),
  );

  server.registerTool(
    "vast_instance",
    {
      title: "Instance details",
      description: "Get a single instance: status, status message, SSH command, published ports, Jupyter URL, price, environment. Use to poll status or fetch connection info.",
      inputSchema: { instance_id: instanceIdSchema, include_raw: z.boolean().optional().describe("Also return the raw API object.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ instance_id, include_raw }) => {
      const inst = await api.getInstance(instance_id);
      if (!inst) return ok({ found: false, instance_id, message: "Instance not found or already destroyed." });
      return ok({ found: true, instance: summarizeInstance(inst, { includeEnv: true }), raw: include_raw ? inst : undefined });
    }),
  );

  server.registerTool(
    "vast_wait_instance",
    {
      title: "Wait for instance status",
      description: "Block until the instance reaches the target status (running or stopped) or a terminal failure/timeout occurs. Returns the status history and final connection info. Prefer vast_launch which already waits.",
      inputSchema: {
        instance_id: instanceIdSchema,
        target: z.enum(["running", "stopped"]).optional().describe("Status to wait for (default running)."),
        timeout_s: z.number().int().min(5).max(3600).optional().describe("Max seconds to wait (default 600)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ instance_id, target, timeout_s }, extra) => {
      const w = await waitForInstance(api, instance_id, { target: target ?? "running", timeoutS: timeout_s, onProgress: progressReporter(extra) });
      const res = ok({ ok: w.ok, reason: w.reason, elapsed_s: w.elapsed_s, history: w.history, instance: w.instance ? summarizeInstance(w.instance) : undefined });
      if (!w.ok) res.isError = true;
      return res;
    }),
  );

  server.registerTool(
    "vast_instance_control",
    {
      title: "Start / stop / reboot instance",
      description: "Change an instance's power state. stop keeps the disk (storage charges only, GPU may be taken by someone else); start resumes a stopped instance; reboot = stop+start without losing GPU priority. Optionally waits for the resulting state.",
      inputSchema: {
        instance_id: instanceIdSchema,
        action: z.enum(["start", "stop", "reboot"]),
        wait: z.boolean().optional().describe("Wait for the instance to reach the resulting state (default true)."),
        timeout_s: z.number().int().min(5).max(1800).optional().describe("Max seconds to wait (default 300)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ instance_id, action, wait, timeout_s }, extra) => {
      let r: { success: boolean; msg?: string };
      if (action === "reboot") r = await api.rebootInstance(instance_id);
      else r = await api.setInstanceState(instance_id, action === "start" ? "running" : "stopped");
      if (!r.success) throw new Error(r.msg ?? `failed to ${action} instance ${instance_id}`);
      if (wait ?? true) {
        const target = action === "stop" ? "stopped" : "running";
        const w = await waitForInstance(api, instance_id, { target, timeoutS: timeout_s ?? 300, onProgress: progressReporter(extra) });
        const res = ok({ action, ok: w.ok, reason: w.reason, history: w.history, instance: w.instance ? summarizeInstance(w.instance) : undefined });
        if (!w.ok) res.isError = true;
        return res;
      }
      return ok({ action, ok: true, message: r.msg ?? `${action} requested for instance ${instance_id}` });
    }),
  );

  server.registerTool(
    "vast_destroy",
    {
      title: "Destroy instances",
      description: "Permanently destroy one or more instances. This deletes the instance disk and stops all billing. Irreversible. Use when a job is finished.",
      inputSchema: { instance_ids: z.array(instanceIdSchema).min(1).describe("Instance ids to destroy.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ instance_ids }) => {
      // Bulk DELETE /instances/ (64 per request, as the CLI does); fall back to per-id deletes on failure.
      const results: { instance_id: number; destroyed: boolean; message?: string }[] = [];
      try {
        const rs = await api.destroyInstances(instance_ids);
        const failed = rs.find((r) => !r.success);
        if (failed) throw new Error(failed.msg ?? "bulk destroy reported failure");
        for (const id of instance_ids) results.push({ instance_id: id, destroyed: true });
      } catch (bulkErr) {
        for (const id of instance_ids) {
          try {
            const r = await api.destroyInstance(id);
            results.push({ instance_id: id, destroyed: !!r.success, message: r.msg });
          } catch (e) {
            results.push({ instance_id: id, destroyed: false, message: `${(e as Error).message} (bulk: ${(bulkErr as Error).message})` });
          }
        }
      }
      const res = ok({ results });
      if (results.some((r) => !r.destroyed)) res.isError = true;
      return res;
    }),
  );

  server.registerTool(
    "vast_update_instance",
    {
      title: "Update label / bid price",
      description: "Change an instance's label and/or the bid price of an interruptible instance (raise the bid to resume an outbid instance).",
      inputSchema: {
        instance_id: instanceIdSchema,
        label: z.string().optional().describe("New label."),
        bid_price: z.number().optional().describe("New per-machine bid in USD/hour (interruptible instances only)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ instance_id, label, bid_price }) => {
      if (label === undefined && bid_price === undefined) throw new Error("Provide label and/or bid_price.");
      const out: Record<string, unknown> = { instance_id };
      if (label !== undefined) {
        const r = await api.labelInstance(instance_id, label);
        if (!r.success) throw new Error(r.msg ?? "label update failed");
        out.label = label;
      }
      if (bid_price !== undefined) {
        const r = await api.changeBid(instance_id, bid_price);
        if (!r.success) throw new Error(r.msg ?? "bid update failed");
        out.bid_price = bid_price;
      }
      return ok(out);
    }),
  );

  server.registerTool(
    "vast_logs",
    {
      title: "Instance logs",
      description: "Fetch container logs (stdout of the image entrypoint and onstart script) or the host daemon logs for an instance. Useful to debug images that fail to start or to watch onstart progress.",
      inputSchema: {
        instance_id: instanceIdSchema,
        tail: z.number().int().min(1).max(100000).optional().describe("Number of trailing lines (default 1000)."),
        filter: z.string().optional().describe("grep-style filter applied server-side."),
        daemon_logs: z.boolean().optional().describe("Fetch host daemon logs instead of container logs."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ instance_id, tail, filter, daemon_logs }) => {
      const text = await api.logs(instance_id, { tail, filter, daemon_logs });
      return { content: [{ type: "text", text: text || "(no log output)" }] };
    }),
  );
}
