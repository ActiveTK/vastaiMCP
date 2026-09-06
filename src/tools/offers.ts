import { z } from "zod";
import { summarizeOffer } from "../format.js";
import { buildOfferQuery } from "../query.js";
import { guard, ok, offerFilterShape, type ToolContext } from "./common.js";

export function registerOfferTools({ server, api }: ToolContext) {
  server.registerTool(
    "vast_search_offers",
    {
      title: "Search GPU offers",
      description:
        "Search the vast.ai marketplace for rentable GPU machines using structured filters (GPU model, VRAM, price cap, region, reliability...). " +
        "Returns compact offer summaries; the `offer_id` can be passed to vast_launch. " +
        "Defaults match `vastai search offers`: verified, rentable, not already rented, on-demand pricing, ranked by overall value. " +
        "Prices are USD per hour for the whole instance. To just rent something, prefer vast_launch which searches and creates in one step.",
      inputSchema: {
        ...offerFilterShape,
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
        storage_gb: z.number().optional().describe("Disk size used for price calculation (default 5 GB, or min_disk_gb)."),
        include_raw: z.boolean().optional().describe("Also return the raw API objects (large)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { include_raw, ...filters } = args;
      const query = buildOfferQuery({ ...filters, limit: filters.limit ?? 20 });
      const offers = await api.searchOffers(query);
      return ok({
        count: offers.length,
        pricing_type: query.type,
        offers: offers.map(summarizeOffer),
        raw: include_raw ? offers : undefined,
      });
    }),
  );
}
