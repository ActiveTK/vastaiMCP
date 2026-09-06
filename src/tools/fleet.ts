import { z } from "zod";
import { sshEndpoint } from "../format.js";
import { shellQuote, sshExec } from "../ssh.js";
import { pMap } from "../util.js";
import { envShape, guard, ok, offerFilterShape, progressReporter, type ToolContext } from "./common.js";

const fleetName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).describe("Fleet name (letters, digits, . _ -).");

export function registerFleetTools({ server, fleets, cfg }: ToolContext) {
  server.registerTool(
    "vast_fleet_launch",
    {
      title: "Launch a fleet of N instances with a hard TTL",
      description:
        "Rent many instances at once and guarantee they are destroyed after ttl_minutes. Searches offers with the filters, ranks them " +
        "(strategy, e.g. most_cpu = vCPU count descending), de-duplicates by machine, creates `count` instances in parallel, then returns immediately " +
        "while a background monitor tracks status, replaces instances that die before the deadline, and destroys everything at the deadline " +
        "(bulk DELETE, verified against the instance list, retried until nothing with the fleet label remains). " +
        "The deadline is also persisted to disk (~/.vastai-mcp/fleets) so it is enforced after a restart or by `vastai-mcp reap`, and each container gets a " +
        "self-destruct timer as a last resort. Use dry_run=true first to see the candidate machines and estimated cost. " +
        "Billing: every created instance is charged from creation until destroyed; check vast_fleet_status for cost.",
      inputSchema: {
        count: z.number().int().min(1).max(1000).describe("Number of instances to create."),
        ttl_minutes: z.number().min(1).max(60 * 24 * 14).describe("Lifetime in minutes, measured from fleet creation. All instances are destroyed at this deadline."),
        name: fleetName.optional().describe("Fleet name (default: fleet-<timestamp>). Instances are labelled fleet:<name>."),
        image: z.string().optional().describe("Docker image. Required unless template_hash is given."),
        template_hash: z.string().optional().describe("vast.ai template hash (from vast_templates)."),
        disk_gb: z.number().min(1).optional().describe("Disk per instance in GB (default 20)."),
        ...envShape,
        onstart_cmd: z.string().optional().describe("Startup script run in every container."),
        runtype: z.enum(["ssh", "jupyter", "args"]).optional().describe('Default "ssh". Ignored with template_hash.'),
        direct: z.boolean().optional().describe("Prefer direct connections (default true)."),
        bid_price: z.number().optional().describe("Use interruptible pricing with this bid (USD/hour per instance)."),
        image_login: z.string().optional().describe("Docker login for private registries."),
        ...offerFilterShape,
        unique_machines: z.boolean().optional().describe("At most one instance per physical machine (default true)."),
        overprovision: z.number().min(1).max(5).optional().describe("Search for count*overprovision candidates so failed creates can fall through to the next machine (default 1.5)."),
        create_concurrency: z.number().int().min(1).max(32).optional().describe("Parallel create requests (default 8)."),
        replace_failed: z.boolean().optional().describe("Replace instances that exit/go offline before the deadline with the next candidate (default true)."),
        max_replacements: z.number().int().min(0).optional().describe("Cap on replacements (default = count)."),
        self_destruct: z.boolean().optional().describe("Prepend an in-container self-destruct timer (uses CONTAINER_API_KEY) to onstart as a backstop (default true)."),
        max_total_cost_usd: z.number().optional().describe("Refuse to create anything if the estimated cost (top `count` offers x ttl) exceeds this."),
        dry_run: z.boolean().optional().describe("Only search and report candidates + estimated cost; create nothing."),
        wait_for_running: z.boolean().optional().describe("Block until all alive instances report running or timeout_s (default false)."),
        timeout_s: z.number().int().min(10).max(3600).optional().describe("Max seconds to block when wait_for_running (default 600)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a, extra) => {
      const {
        count, ttl_minutes, name, image, template_hash, disk_gb, env, ports, hostname, docker_options, onstart_cmd, runtype, direct, bid_price, image_login,
        unique_machines, overprovision, create_concurrency, replace_failed, max_replacements, self_destruct, max_total_cost_usd, dry_run, wait_for_running, timeout_s,
        ...filters
      } = a;
      const r = await fleets.launch({
        count, ttl_minutes, name, image, template_hash, disk_gb, env: { env, ports, hostname, docker_options }, onstart_cmd, runtype, direct, bid_price, image_login,
        filters, unique_machines, overprovision, create_concurrency, replace_failed, max_replacements, self_destruct, max_total_cost_usd, dry_run, wait_for_running, timeout_s,
        onProgress: progressReporter(extra),
      });
      return ok(r);
    }),
  );

  server.registerTool(
    "vast_fleet_status",
    {
      title: "Fleet status",
      description: "Status of one fleet: counts per instance status, alive/running numbers, seconds until the deadline, cost so far, termination progress, and optionally every member with its SSH endpoint. Set refresh=true to re-poll the API first.",
      inputSchema: {
        name: fleetName,
        include_members: z.boolean().optional().describe("Include the per-instance member list (default false)."),
        refresh: z.boolean().optional().describe("Query the API now instead of using the last monitor observation (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ name, include_members, refresh }) => {
      const f = fleets.get(name);
      if (!f) throw new Error(`unknown fleet ${name}`);
      if ((refresh ?? true) && f.state !== "terminated") await fleets.refresh(f);
      return ok(fleets.summarize(f, { members: include_members }));
    }),
  );

  server.registerTool(
    "vast_fleet_list",
    {
      title: "List fleets",
      description: "List all fleets known to this server (persisted on disk), including terminated ones, with alive counts and deadlines.",
      inputSchema: { include_terminated: z.boolean().optional().describe("Also list terminated fleets (default false).") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ include_terminated }) => {
      const all = fleets.list().filter((f) => include_terminated || f.state !== "terminated");
      return ok({ count: all.length, state_dir: fleets.stateDir, fleets: all });
    }),
  );

  server.registerTool(
    "vast_fleet_destroy",
    {
      title: "Destroy a fleet now",
      description: "Immediately destroy every instance in the fleet (bulk DELETE, verified, retried). Returns when the instance list confirms they are gone or after wait_s; termination continues in the background if needed.",
      inputSchema: {
        name: fleetName.optional().describe("Fleet to destroy."),
        all: z.boolean().optional().describe("Destroy every non-terminated fleet."),
        wait_s: z.number().int().min(0).max(600).optional().describe("Max seconds to wait for verification (default 120)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ name, all, wait_s }) => {
      const targets = all ? fleets.list().filter((f) => f.state !== "terminated").map((f) => f.name) : name ? [name] : [];
      if (!targets.length) throw new Error("Give name or all=true.");
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), (wait_s ?? 120) * 1000));
      const results = await Promise.all(
        targets.map(async (n) => {
          const r = await Promise.race([fleets.terminate(n, "vast_fleet_destroy"), timeout]);
          if (r === "timeout") {
            const s = fleets.summarize(fleets.get(n)!);
            return { name: n, state: s.state, verified: false, remaining_ids: s.termination?.remaining_ids ?? [], note: "still terminating in the background; check vast_fleet_status" };
          }
          return r;
        }),
      );
      const res = ok({ results });
      if (results.some((r) => !r.verified)) res.isError = true;
      return res;
    }),
  );

  server.registerTool(
    "vast_fleet_extend",
    {
      title: "Extend a fleet's deadline",
      description: "Push the fleet deadline back by `minutes`. Note: in-container self-destruct timers (if enabled) still fire at the original deadline; extend early or launch with self_destruct=false when you expect to extend.",
      inputSchema: { name: fleetName, minutes: z.number().min(1).max(60 * 24 * 14) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ name, minutes }) => ok(await fleets.extend(name, minutes))),
  );

  server.registerTool(
    "vast_fleet_run",
    {
      title: "Run a command on every running fleet instance",
      description: "Execute a shell command over SSH on all running instances of the fleet in parallel and return per-instance exit codes and (truncated) output. Requires VAST_SSH_KEY. Use for kicking off jobs (nohup ... &) or collecting small results.",
      inputSchema: {
        name: fleetName,
        command: z.string().describe("Command line, run with `bash -lc`."),
        concurrency: z.number().int().min(1).max(64).optional().describe("Parallel SSH sessions (default 16)."),
        timeout_s: z.number().int().min(1).max(3600).optional().describe("Per-instance timeout (default 120)."),
        max_output_kb: z.number().int().min(1).max(256).optional().describe("Per-instance output cap (default 8 KB)."),
        instance_ids: z.array(z.number().int()).optional().describe("Restrict to these instance ids."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ name, command, concurrency, timeout_s, max_output_kb, instance_ids }) => {
      if (!cfg.sshPrivateKeyPath) throw new Error("No SSH private key configured (VAST_SSH_KEY).");
      let targets = await fleets.runningMembers(name);
      if (instance_ids?.length) targets = targets.filter((t) => instance_ids.includes(t.member.instance_id));
      if (!targets.length) throw new Error("No running instances in the fleet (yet).");
      const auth = { privateKeyPath: cfg.sshPrivateKeyPath };
      const script = `bash -lc ${shellQuote(command)}`;
      const results = await pMap(
        targets,
        async ({ member, instance }) => {
          const ep = sshEndpoint(instance);
          if (!ep) return { instance_id: member.instance_id, error: "no ssh endpoint" };
          try {
            const r = await sshExec(ep, auth, script, { timeoutMs: (timeout_s ?? 120) * 1000, maxOutputBytes: (max_output_kb ?? 8) * 1024, connectTimeoutMs: 15_000 });
            return { instance_id: member.instance_id, host: `${ep.host}:${ep.port}`, exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr || undefined, truncated: r.truncated || undefined };
          } catch (e) {
            return { instance_id: member.instance_id, host: `${ep.host}:${ep.port}`, error: (e as Error).message };
          }
        },
        concurrency ?? 16,
      );
      const okCount = results.filter((r) => "exit_code" in r && r.exit_code === 0).length;
      return ok({ fleet: name, targeted: results.length, succeeded: okCount, results });
    }),
  );
}
