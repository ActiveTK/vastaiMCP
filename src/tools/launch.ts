import { z } from "zod";
import { launchInstance } from "../workflows/launch.js";
import { envShape, guard, ok, offerFilterShape, progressReporter, type ToolContext } from "./common.js";

export function registerLaunchTools({ server, api, cfg }: ToolContext) {
  server.registerTool(
    "vast_launch",
    {
      title: "Launch a GPU instance (search → create → wait → SSH)",
      description:
        "One-shot workflow to rent a GPU machine on vast.ai. It (1) registers your SSH public key on the account if needed, " +
        "(2) searches offers matching the filters (or uses offer_id), (3) creates the instance with the given image/disk/env/ports, " +
        "(4) waits until the container is running, retrying with the next-best offer if a host fails to start (failed instances are destroyed), " +
        "and (5) waits until SSH accepts connections. Returns the instance id, SSH command, published ports and hourly price. " +
        "Billing starts at creation; use vast_destroy when done. " +
        'Typical call: {"gpu_name":"RTX 4090","image":"vastai/pytorch:@vastai-automatic-tag","disk_gb":40,"max_price_per_hour":0.6}. ' +
        "Images: vastai/base-image, vastai/pytorch, vastai/vllm, vastai/comfy (all support the @vastai-automatic-tag tag), or any Docker Hub image.",
      inputSchema: {
        offer_id: z.number().int().optional().describe("Skip searching and rent this exact offer (from vast_search_offers)."),
        ...offerFilterShape,
        image: z.string().optional().describe('Docker image, e.g. "vastai/pytorch:@vastai-automatic-tag" or "pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime". Required unless template_hash is given.'),
        template_hash: z.string().optional().describe("vast.ai template hash (from vast_templates). When set, image/runtype come from the template."),
        disk_gb: z.number().min(1).optional().describe("Local disk size in GB (default 20). Also used as the minimum disk filter."),
        ...envShape,
        onstart_cmd: z.string().optional().describe("Shell script run inside the container at every start (e.g. pip install ... ). Runs as root in the background."),
        runtype: z.enum(["ssh", "jupyter", "args"]).optional().describe('"ssh" (default) injects sshd; "jupyter" also starts Jupyter; "args" runs the image entrypoint as-is (no ssh).'),
        direct: z.boolean().optional().describe("Use direct (faster) connections for ssh/jupyter when the host offers them (default true; falls back to proxy)."),
        jupyter_lab: z.boolean().optional().describe("For runtype jupyter: launch JupyterLab instead of Notebook."),
        jupyter_dir: z.string().optional().describe("For runtype jupyter: directory to serve."),
        entrypoint: z.string().optional().describe("For runtype args: override the image entrypoint."),
        args: z.array(z.string()).optional().describe("For runtype args: arguments passed to the entrypoint."),
        label: z.string().optional().describe("Label to tag the instance with."),
        bid_price: z.number().optional().describe("Create an interruptible (spot) instance with this bid in USD/hour. Omit for on-demand."),
        image_login: z.string().optional().describe('Docker login for private registries: "-u user -p pass registry.example.com".'),
        cancel_unavail: z.boolean().optional().describe("Fail instead of creating a stopped instance when the host cannot schedule it (default true)."),
        ssh_public_key: z.string().optional().describe("Public key (literal or file path) to register on the account before launch. Defaults to VAST_SSH_PUBLIC_KEY / the .pub next to VAST_SSH_KEY."),
        register_ssh_key: z.boolean().optional().describe("Set false to skip SSH key registration."),
        wait_for_running: z.boolean().optional().describe("Wait for actual_status == running (default true). If false, returns right after creation."),
        timeout_s: z.number().int().min(10).max(3600).optional().describe("Max seconds to wait for running per attempt (default 600)."),
        wait_for_ssh: z.boolean().optional().describe("After running, wait until SSH accepts the configured private key (default true when VAST_SSH_KEY is set)."),
        ssh_timeout_s: z.number().int().min(5).max(900).optional().describe("Max seconds to wait for SSH (default 120)."),
        max_attempts: z.number().int().min(1).max(10).optional().describe("How many different offers to try before giving up (default 3)."),
        destroy_on_failure: z.boolean().optional().describe("Destroy instances that fail to reach running before trying the next offer (default true)."),
        volume: z
          .object({
            create_from_offer_id: z.number().int().optional().describe("Create a new local volume from this volume offer id (vast_volumes search)."),
            link_volume_id: z.number().int().optional().describe("Attach an existing volume by id."),
            mount_path: z.string().describe("Mount path inside the container, e.g. /workspace/data."),
            size_gb: z.number().optional().describe("Size for a new volume (default 15)."),
            name: z.string().optional(),
          })
          .optional()
          .describe("Attach a persistent volume."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (args, extra) => {
      const {
        offer_id, image, template_hash, disk_gb, env, ports, hostname, docker_options, onstart_cmd, runtype, direct, jupyter_lab, jupyter_dir,
        entrypoint, args: entryArgs, label, bid_price, image_login, cancel_unavail, ssh_public_key, register_ssh_key, wait_for_running, timeout_s,
        wait_for_ssh, ssh_timeout_s, max_attempts, destroy_on_failure, volume, ...filters
      } = args;
      const result = await launchInstance(api, cfg, {
        offer_id,
        filters,
        image,
        template_hash,
        disk_gb,
        env: { env, ports, hostname, docker_options },
        onstart_cmd,
        runtype,
        direct,
        jupyter_lab,
        jupyter_dir,
        entrypoint,
        args: entryArgs,
        label,
        bid_price,
        image_login,
        cancel_unavail,
        ssh_public_key,
        register_ssh_key,
        wait_for_running,
        timeout_s,
        wait_for_ssh,
        ssh_timeout_s,
        max_attempts,
        destroy_on_failure,
        volume,
        onProgress: progressReporter(extra),
      });
      const res = ok(result);
      if (!result.success) res.isError = true;
      return res;
    }),
  );
}
