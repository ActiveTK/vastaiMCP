import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { VastApi } from "../api/vast.js";
import { VastApiError } from "../client.js";
import type { VastConfig } from "../config.js";
import type { FleetManager } from "../fleet/manager.js";
import { compact } from "../format.js";
import { REGIONS } from "../query.js";

export interface ToolContext {
  api: VastApi;
  cfg: VastConfig;
  server: McpServer;
  fleets: FleetManager;
}

export function ok(data: unknown): CallToolResult {
  const payload = compact(data);
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    structuredContent: payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined,
  };
}

export function fail(e: unknown): CallToolResult {
  let message: string;
  if (e instanceof VastApiError) {
    message = e.message;
    if (e.status === 401 || e.status === 403) message += "\nHint: the API key is missing or invalid. Set VAST_API_KEY or write it to ~/.vast_api_key (create one at https://console.vast.ai/manage-keys/).";
    if (e.status === 429) message += "\nHint: rate limited; wait a few seconds and retry.";
  } else message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wrap a handler so thrown errors become isError results instead of protocol errors. */
export function guard<A extends unknown[]>(fn: (...args: A) => Promise<CallToolResult>): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      return fail(e);
    }
  };
}

type Extra = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, "sendNotification" | "_meta">;

/** Progress reporter that forwards to notifications/progress when the client supplied a progressToken. */
export function progressReporter(extra: Extra | undefined): (msg: string) => void {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return () => {};
  let n = 0;
  return (message: string) => {
    n++;
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message } }).catch(() => {});
  };
}

export const instanceIdSchema = z.number().int().positive().describe("Instance id (the `id` from vast_list_instances / vast_launch).");

export const offerFilterShape = {
  gpu_name: z.string().optional().describe('Exact GPU model, e.g. "RTX 4090", "RTX_4090", "H100 SXM", "A100 PCIE". Use vast_gpu_names for the exact list.'),
  gpu_names: z.array(z.string()).optional().describe("Accept any of these GPU models (OR)."),
  num_gpus: z.number().int().min(1).optional().describe("Exact number of GPUs per instance."),
  min_num_gpus: z.number().int().min(1).optional().describe("Minimum number of GPUs."),
  min_gpu_ram_gb: z.number().optional().describe("Minimum VRAM per GPU in GB."),
  min_cpu_ram_gb: z.number().optional().describe("Minimum system RAM in GB."),
  min_cpu_cores: z.number().optional().describe("Minimum effective CPU cores."),
  min_disk_gb: z.number().optional().describe("Minimum available disk in GB."),
  max_price_per_hour: z.number().optional().describe("Maximum total price in USD per hour (dph_total)."),
  min_reliability: z.number().min(0).max(1).optional().describe("Minimum host reliability score 0..1 (e.g. 0.95)."),
  min_inet_down_mbps: z.number().optional().describe("Minimum download bandwidth in Mb/s."),
  min_inet_up_mbps: z.number().optional().describe("Minimum upload bandwidth in Mb/s."),
  min_cuda_version: z.number().optional().describe("Minimum supported CUDA version, e.g. 12.4."),
  min_dlperf: z.number().optional().describe("Minimum DLPerf score."),
  region: z.string().optional().describe(`Region name (${Object.keys(REGIONS).join(", ")}) or comma-separated 2-letter country codes like "US,CA" or "JP".`),
  exclude_region: z.string().optional().describe("Same format as region; offers in these locations are excluded."),
  direct_port_count: z.number().int().optional().describe("Minimum number of direct (publicly reachable) ports. Set >=1 if you need to expose services."),
  static_ip: z.boolean().optional().describe("Require a static public IP."),
  datacenter_only: z.boolean().optional().describe("Only datacenter-hosted machines."),
  verified_only: z.boolean().optional().describe("Only verified hosts (default true)."),
  machine_id: z.number().int().optional().describe("Restrict to a specific machine id."),
  host_id: z.number().int().optional().describe("Restrict to a specific host id."),
  raw_query: z.string().optional().describe('Escape hatch using vastai CLI query syntax, e.g. "gpu_ram>=24 pcie_bw>10 geolocation in [US,CA]". Merged on top of the structured filters.'),
  type: z.enum(["on-demand", "bid", "reserved"]).optional().describe('Pricing type. "bid" = interruptible/spot (exposes min_bid).'),
  strategy: z.enum(["best_value", "cheapest", "fastest", "most_reliable", "most_cpu", "most_ram", "most_vram", "most_disk", "most_bandwidth"]).optional().describe("How to rank results (default best_value = vast's score). most_cpu = effective vCPU count descending, etc."),
  order: z.string().optional().describe('Explicit sort, comma-separated; suffix "-" for descending, e.g. "dph_total" or "dlperf_usd-". Overrides strategy.'),
};

export const envShape = {
  env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Environment variables for the container, e.g. {"HF_TOKEN": "hf_xxx", "MODEL_NAME": "Qwen/Qwen2.5-3B-Instruct"}.'),
  ports: z.array(z.union([z.string(), z.number()])).optional().describe('Container ports to publish, e.g. [8080, "8081:8081/udp"]. Requires a host with direct ports.'),
  hostname: z.string().optional().describe("Container hostname."),
  docker_options: z.string().optional().describe('vastai CLI style string for compatibility: "-e A=1 -p 8080:8080 -h name".'),
};
