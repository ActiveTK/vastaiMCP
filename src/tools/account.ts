import { z } from "zod";
import { guard, ok, type ToolContext } from "./common.js";

export function registerAccountTools({ server, api, cfg }: ToolContext) {
  server.registerTool(
    "vast_account",
    {
      title: "Account & balance",
      description: "Show the vast.ai account behind the configured API key: username, email, credit balance, and the SSH key / API configuration this server is using. Call this first to verify authentication.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const u = await api.getUser();
      return ok({
        user: { id: u.id, username: u.username, email: u.email },
        balance_usd: u.balance ?? u.credit,
        balance_threshold_usd: u.balance_threshold_enabled ? u.balance_threshold : undefined,
        config: {
          api_url: cfg.baseUrl,
          ssh_private_key: cfg.sshPrivateKeyPath ?? "(none; set VAST_SSH_KEY)",
          ssh_public_key: cfg.sshPublicKey ?? "(none; set VAST_SSH_PUBLIC_KEY)",
        },
      });
    }),
  );

  server.registerTool(
    "vast_gpu_names",
    {
      title: "List GPU model names",
      description: "Return the exact GPU model names accepted by gpu_name filters (e.g. \"RTX 4090\", \"H100 SXM\"). Optionally filter by substring.",
      inputSchema: { contains: z.string().optional().describe('Case-insensitive substring filter, e.g. "4090" or "H100".') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ contains }) => {
      let names = await api.gpuNames();
      if (contains) names = names.filter((n) => n.toLowerCase().includes(contains.toLowerCase()));
      return ok({ count: names.length, gpu_names: names.sort() });
    }),
  );
}
