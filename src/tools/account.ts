import { z } from "zod";
import { guard, ok, type ToolContext } from "./common.js";

export function registerAccountTools({ server, api, cfg }: ToolContext) {
  server.registerTool(
    "vast_account",
    {
      title: "Account & balance",
      description: "Show the vast.ai account behind the configured API key: username, email, prepaid credit (credit_usd is what instances are paid from; host_balance_usd is host payout balance), and the SSH key / API configuration this server is using. Call this first to verify authentication.",
      inputSchema: { include_raw: z.boolean().optional().describe("Also return the raw /users/current object (api_key stripped).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ include_raw }) => {
      const u = await api.getUser();
      return ok({
        user: { id: u.id, username: u.username, email: u.email },
        // vast.py user_fields exposes both: `credit` is the prepaid client balance you spend on instances,
        // `balance` is the (host-side) payout balance and is typically 0 for pure clients.
        credit_usd: typeof u.credit === "number" ? Number(u.credit.toFixed(2)) : undefined,
        host_balance_usd: typeof u.balance === "number" ? Number(u.balance.toFixed(2)) : undefined,
        balance_threshold_usd: u.balance_threshold_enabled ? u.balance_threshold : undefined,
        billing: { has_billing: u.has_billing, can_pay: u.can_pay, credit_only: u.billing_creditonly },
        config: {
          api_url: cfg.baseUrl,
          ssh_private_key: cfg.sshPrivateKeyPath ?? "(none; set VAST_SSH_KEY)",
          ssh_public_key: cfg.sshPublicKey ? (cfg.sshPublicKey.startsWith("ssh-") || cfg.sshPublicKey.includes(" ") ? cfg.sshPublicKey.split(/\s+/).slice(0, 2).join(" ").slice(0, 40) + "… (derived from private key)" : cfg.sshPublicKey) : "(none; set VAST_SSH_PUBLIC_KEY)",
        },
        raw: include_raw ? u : undefined,
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
