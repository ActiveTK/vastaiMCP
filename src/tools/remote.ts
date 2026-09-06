import { z } from "zod";
import { sshEndpoint } from "../format.js";
import { sftpCopy, shellQuote, sshExec } from "../ssh.js";
import { guard, instanceIdSchema, ok, type ToolContext } from "./common.js";

async function resolveEndpoint(ctx: ToolContext, instanceId: number) {
  const inst = await ctx.api.getInstance(instanceId);
  if (!inst) throw new Error(`Instance ${instanceId} not found.`);
  if (inst.actual_status !== "running") throw new Error(`Instance ${instanceId} is ${inst.actual_status ?? "provisioning"}, not running. Use vast_wait_instance first.`);
  const ep = sshEndpoint(inst);
  if (!ep) throw new Error(`Instance ${instanceId} has no SSH endpoint yet; retry in a few seconds.`);
  if (!ctx.cfg.sshPrivateKeyPath) throw new Error("No SSH private key configured. Set VAST_SSH_KEY to a private key whose public key is registered on the account.");
  return { ep, auth: { privateKeyPath: ctx.cfg.sshPrivateKeyPath } };
}

export function registerRemoteTools(ctx: ToolContext) {
  const { server, api } = ctx;

  server.registerTool(
    "vast_run",
    {
      title: "Run a shell command over SSH",
      description:
        "Execute a shell command on a running instance over SSH (as root) and return stdout/stderr/exit code. Uses the private key from VAST_SSH_KEY. " +
        "For long jobs start them detached (nohup ... > log 2>&1 &) and poll with a follow-up vast_run; commands are killed at timeout_s.",
      inputSchema: {
        instance_id: instanceIdSchema,
        command: z.string().describe("Command line, run with `bash -lc`."),
        cwd: z.string().optional().describe("Working directory (default: the image's default, usually /root or /workspace)."),
        timeout_s: z.number().int().min(1).max(3600).optional().describe("Kill the command after this many seconds (default 120)."),
        max_output_kb: z.number().int().min(1).max(4000).optional().describe("Truncate combined output beyond this size (default 200 KB)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ instance_id, command, cwd, timeout_s, max_output_kb }) => {
      const { ep, auth } = await resolveEndpoint(ctx, instance_id);
      const script = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
      const r = await sshExec(ep, auth, `bash -lc ${shellQuote(script)}`, { timeoutMs: (timeout_s ?? 120) * 1000, maxOutputBytes: (max_output_kb ?? 200) * 1024 });
      const res = ok({ instance_id, host: `${ep.host}:${ep.port}`, ...r });
      if (r.exit_code !== 0) res.isError = true;
      return res;
    }),
  );

  server.registerTool(
    "vast_copy_file",
    {
      title: "Copy a file to/from an instance",
      description: "Transfer a single file between the local machine and a running instance over SFTP. For directories, tar them first or use rsync over the SSH endpoint from vast_instance.",
      inputSchema: {
        instance_id: instanceIdSchema,
        direction: z.enum(["upload", "download"]).describe("upload = local → instance, download = instance → local."),
        local_path: z.string().describe("Absolute or cwd-relative local file path."),
        remote_path: z.string().describe("Absolute path on the instance, e.g. /workspace/train.py. Never copy into / or /root directly."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ instance_id, direction, local_path, remote_path }) => {
      const { ep, auth } = await resolveEndpoint(ctx, instance_id);
      const r = await sftpCopy(ep, auth, direction, local_path, remote_path);
      return ok({ instance_id, ...r });
    }),
  );

  server.registerTool(
    "vast_api_execute",
    {
      title: "Run ls / rm / du via the vast API (no SSH)",
      description: "Run a constrained command on an instance through vast's own API, without SSH keys. Only `ls`, `rm` and `du` are permitted server-side. Prefer vast_run when SSH is configured.",
      inputSchema: {
        instance_id: instanceIdSchema,
        command: z.string().describe('e.g. "ls -la /workspace", "du -sh /workspace", "rm -r /workspace/tmp".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ instance_id, command }) => {
      if (!/^\s*(ls|rm|du)\b/.test(command)) throw new Error("vast's execute endpoint only allows commands starting with ls, rm or du. Use vast_run for anything else.");
      const out = await api.execute(instance_id, command);
      return { content: [{ type: "text", text: out || "(no output)" }] };
    }),
  );
}
