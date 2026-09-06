import { z } from "zod";
import { summarizeOffer, summarizeVolume } from "../format.js";
import { parseOrder, parseQuery, OFFER_MULT } from "../query.js";
import { guard, ok, type ToolContext } from "./common.js";

export function registerVolumeTools({ server, api }: ToolContext) {
  server.registerTool(
    "vast_volumes",
    {
      title: "Manage persistent volumes",
      description:
        "Persistent local volumes that survive instance destruction. list: your volumes. search: volume offers (returns offer ids usable as create's offer_id or vast_launch volume.create_from_offer_id). " +
        "create: rent a volume from an offer. delete: remove a volume (irreversible). A volume can only be attached to instances on the same machine.",
      inputSchema: {
        action: z.enum(["list", "search", "create", "delete"]),
        volume_type: z.enum(["local", "network", "all"]).optional().describe("For list (default all)."),
        min_disk_gb: z.number().optional().describe("For search: minimum available space."),
        machine_id: z.number().int().optional().describe("For search: restrict to a machine (e.g. the machine of a running instance)."),
        region: z.string().optional().describe("For search: 2-letter country codes, comma separated."),
        raw_query: z.string().optional().describe('For search: vastai query syntax, e.g. "inet_up>500 storage_cost<0.2".'),
        limit: z.number().int().min(1).max(100).optional().describe("For search (default 20)."),
        offer_id: z.number().int().optional().describe("For create: volume offer id."),
        size_gb: z.number().optional().describe("For create: size in GB (default 15)."),
        name: z.string().optional().describe("For create: volume name."),
        volume_id: z.number().int().optional().describe("For delete."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a) => {
      switch (a.action) {
        case "list": {
          const vols = await api.listVolumes(a.volume_type ?? "all");
          return ok({ count: vols.length, volumes: vols.map(summarizeVolume) });
        }
        case "search": {
          const q: Record<string, unknown> = { verified: { eq: true }, external: { eq: false }, disk_space: { gte: a.min_disk_gb ?? 1 } };
          if (a.machine_id !== undefined) q.machine_id = { eq: a.machine_id };
          if (a.region) q.geolocation = { in: a.region.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) };
          if (a.raw_query) parseQuery(a.raw_query, q, new Set(), {}, OFFER_MULT);
          q.order = parseOrder("score-");
          q.limit = a.limit ?? 20;
          q.allocated_storage = a.size_gb ?? a.min_disk_gb ?? 1;
          const offers = await api.searchVolumes(q);
          return ok({
            count: offers.length,
            offers: offers.map((o) => ({
              offer_id: o.id,
              machine_id: o.machine_id,
              disk_gb: o.disk_space,
              storage_cost_per_gb_month: o.storage_cost,
              location: o.geolocation,
              inet_down_mbps: o.inet_down,
              inet_up_mbps: o.inet_up,
              reliability: o.reliability2 ?? o.reliability,
              gpu_on_machine: o.gpu_name ? summarizeOffer(o).gpu : undefined,
            })),
          });
        }
        case "create": {
          if (a.offer_id === undefined) throw new Error("offer_id is required for create.");
          return ok({ created: await api.createVolume(a.offer_id, a.size_gb ?? 15, a.name) });
        }
        case "delete": {
          if (a.volume_id === undefined) throw new Error("volume_id is required for delete.");
          return ok({ deleted: a.volume_id, response: await api.deleteVolume(a.volume_id) });
        }
      }
    }),
  );
}
