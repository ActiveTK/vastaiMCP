import { describe, expect, it } from "vitest";
import { buildOfferQuery, defaultOfferQuery, normalizeGpuName, parseOrder, parseQuery, resolveRegion } from "../src/query.js";

describe("parseQuery (port of vast.py parse_query)", () => {
  it("parses the canonical CLI example", () => {
    const q = parseQuery("gpu_name=RTX_4090 num_gpus=1 verified=true direct_port_count>=1 rentable=true");
    expect(q).toEqual({
      gpu_name: { eq: "RTX 4090" },
      num_gpus: { eq: "1" },
      verified: { eq: true },
      direct_port_count: { gte: "1" },
      rentable: { eq: true },
    });
  });

  it("applies unit multipliers and aliases", () => {
    const q = parseQuery("gpu_ram>=24 dph<=1.5 cuda_vers>=12.4 duration>2");
    expect(q.gpu_ram).toEqual({ gte: 24000 });
    expect(q.dph_total).toEqual({ lte: "1.5" });
    expect(q.cuda_max_good).toEqual({ gte: "12.4" });
    expect(q.duration).toEqual({ gt: 2 * 86400 });
  });

  it("parses in / notin lists", () => {
    const q = parseQuery("geolocation in [US,CA] gpu_name notin [RTX_3060,RTX_3070]");
    expect(q.geolocation).toEqual({ in: ["US", "CA"] });
    expect(q.gpu_name).toEqual({ notin: ["RTX 3060", "RTX 3070"] });
  });

  it("merges into an existing query and supports wildcard removal", () => {
    const q = parseQuery("verified=any num_gpus>=2", defaultOfferQuery());
    expect(q.verified).toBeUndefined();
    expect(q.rentable).toEqual({ eq: true });
    expect(q.num_gpus).toEqual({ gte: "2" });
  });

  it("rejects unknown operators and unconsumed text", () => {
    expect(() => parseQuery("gpu_name ~ RTX")).toThrow();
  });
});

describe("parseOrder", () => {
  it("handles direction suffixes and aliases", () => {
    expect(parseOrder("dlperf_usd-,num_gpus,dph+")).toEqual([
      ["dlperf_per_dphtotal", "desc"],
      ["num_gpus", "asc"],
      ["dph_total", "asc"],
    ]);
  });
});

describe("resolveRegion", () => {
  it("expands named regions and accepts country lists", () => {
    expect(resolveRegion("Europe")).toContain("DE");
    expect(resolveRegion("north america")).toContain("US");
    expect(resolveRegion("US, ca")).toEqual(["US", "CA"]);
    expect(resolveRegion("[JP,KR]")).toEqual(["JP", "KR"]);
    expect(() => resolveRegion("Mars")).toThrow();
  });
});

describe("buildOfferQuery", () => {
  it("produces the body vast.py would send for a typical search", () => {
    const q = buildOfferQuery({ gpu_name: "RTX_4090", num_gpus: 1, max_price_per_hour: 0.6, min_gpu_ram_gb: 24, region: "JP", limit: 5, strategy: "cheapest" });
    expect(q).toMatchObject({
      verified: { eq: true },
      external: { eq: false },
      rentable: { eq: true },
      rented: { eq: false },
      gpu_name: { eq: "RTX 4090" },
      num_gpus: { eq: 1 },
      dph_total: { lte: 0.6 },
      gpu_ram: { gte: 24000 },
      geolocation: { in: ["JP"] },
      order: [["dph_total", "asc"]],
      type: "on-demand",
      limit: 5,
      allocated_storage: 5,
    });
  });

  it("layers raw_query on top and honours bid type", () => {
    const q = buildOfferQuery({ raw_query: "pcie_bw>10 verified=any", type: "bid", min_disk_gb: 40, order: "score-" });
    expect(q.verified).toBeUndefined();
    expect(q.pcie_bw).toEqual({ gt: "10" });
    expect(q.type).toBe("bid");
    expect(q.allocated_storage).toBe(40);
    expect(q.order).toEqual([["score", "desc"]]);
  });

  it("normalizes gpu names", () => {
    expect(normalizeGpuName("RTX_4090")).toBe("RTX 4090");
    expect(normalizeGpuName("H100  SXM")).toBe("H100 SXM");
  });
});
