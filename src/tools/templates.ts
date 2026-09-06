import { z } from "zod";
import { summarizeTemplate } from "../format.js";
import { guard, ok, type ToolContext } from "./common.js";

export function registerTemplateTools({ server, api }: ToolContext) {
  server.registerTool(
    "vast_templates",
    {
      title: "Search templates",
      description:
        "Search vast.ai templates (pre-configured image + env + ports bundles such as PyTorch, vLLM, ComfyUI, Ollama). " +
        "Pass the returned template_hash to vast_launch instead of an image. Results are sorted by popularity.",
      inputSchema: {
        name_contains: z.string().optional().describe('Case-insensitive substring match on the template name, e.g. "vllm".'),
        recommended_only: z.boolean().optional().describe("Only vast's recommended templates."),
        mine_only: z.boolean().optional().describe("Only your private templates."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 30)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ name_contains, recommended_only, mine_only, limit }) => {
      const filters: Record<string, unknown> = {};
      if (recommended_only) filters.recommended = { eq: true };
      if (mine_only) filters.private = { eq: true };
      let rows = await api.searchTemplates(filters);
      if (name_contains) {
        const n = name_contains.toLowerCase();
        rows = rows.filter((t) => (t.name ?? "").toLowerCase().includes(n) || (t.image ?? "").toLowerCase().includes(n));
      }
      rows.sort((a, b) => (b.count_created ?? 0) - (a.count_created ?? 0));
      const out = rows.slice(0, limit ?? 30).map(summarizeTemplate);
      return ok({ count: out.length, total_matched: rows.length, templates: out });
    }),
  );
}
