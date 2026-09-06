/**
 * Offer search query construction.
 *
 * Port of vast.py `parse_query()` (raw query syntax escape hatch) plus a
 * structured builder used by the MCP tools. Output is the `q` dict that
 * POST /api/v0/bundles/ expects: { field: { op: value }, order: [...], type, limit, allocated_storage }.
 */

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notin";
export type Condition = Partial<Record<Op, unknown>>;
export type Query = Record<string, unknown>;

export const OFFER_FIELDS = new Set([
  "bw_nvlink", "compute_cap", "cpu_arch", "cpu_cores", "cpu_cores_effective", "cpu_ghz", "cpu_ram",
  "cuda_max_good", "datacenter", "direct_port_count", "driver_version", "disk_bw", "disk_space", "dlperf",
  "dlperf_per_dphtotal", "dph_total", "duration", "external", "flops_per_dphtotal", "gpu_arch",
  "gpu_display_active", "gpu_frac", "gpu_mem_bw", "gpu_name", "gpu_ram", "gpu_total_ram", "gpu_max_power",
  "gpu_max_temp", "has_avx", "host_id", "id", "inet_down", "inet_down_cost", "inet_up", "inet_up_cost",
  "machine_id", "min_bid", "mobo_name", "num_gpus", "pci_gen", "pcie_bw", "reliability", "rentable", "rented",
  "storage_cost", "static_ip", "total_flops", "ubuntu_version", "verification", "verified", "vms_enabled",
  "geolocation", "cluster_id",
]);

export const OFFER_ALIAS: Record<string, string> = {
  cuda_vers: "cuda_max_good",
  display_active: "gpu_display_active",
  dlperf_usd: "dlperf_per_dphtotal",
  dph: "dph_total",
  flops_usd: "flops_per_dphtotal",
};

/** Fields whose user-facing unit differs from the API unit (GB -> MB, days -> seconds). */
export const OFFER_MULT: Record<string, number> = {
  cpu_ram: 1000,
  gpu_ram: 1000,
  gpu_total_ram: 1000,
  duration: 24 * 60 * 60,
};

export const REGIONS: Record<string, string[]> = {
  North_America: ["AG","BS","BB","BZ","CA","CR","CU","DM","DO","SV","GD","GT","HT","HN","JM","MX","NI","PA","KN","LC","VC","TT","US"],
  South_America: ["AR","BO","BR","CL","CO","EC","FK","GF","GY","PY","PE","SR","UY","VE"],
  Europe: ["AL","AD","AT","BY","BE","BA","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IS","IE","IT","LV","LI","LT","LU","MT","MD","MC","ME","NL","MK","NO","PL","PT","RO","RU","SM","RS","SK","SI","ES","SE","CH","UA","GB","VA","XK"],
  Asia: ["AF","AM","AZ","BH","BD","BT","BN","KH","CN","GE","IN","ID","IR","IQ","IL","JP","JO","KZ","KW","KG","LA","LB","MY","MV","MN","MM","NP","KP","OM","PK","PH","QA","SA","SG","KR","LK","SY","TW","TJ","TH","TL","TR","TM","AE","UZ","VN","YE","HK","MO"],
  Oceania: ["AS","AU","CK","FJ","PF","GU","KI","MH","FM","NR","NC","NZ","NU","MP","PW","PG","PN","WS","SB","TK","TO","TV","VU","WF"],
  Africa: ["DZ","AO","BJ","BW","BF","BI","CV","CM","CF","TD","KM","CG","CD","CI","DJ","EG","GQ","ER","SZ","ET","GA","GM","GH","GN","GW","KE","LS","LR","LY","MG","MW","ML","MR","MU","MA","MZ","NA","NE","NG","RW","ST","SN","SC","SL","SO","ZA","SS","SD","TZ","TG","TN","UG","ZM","ZW"],
};

const OP_NAMES: Record<string, Op> = {
  ">=": "gte", ">": "gt", gt: "gt", gte: "gte",
  "<=": "lte", "<": "lt", lt: "lt", lte: "lte",
  "!=": "neq", "==": "eq", "=": "eq", eq: "eq", neq: "neq", noteq: "neq", "not eq": "neq",
  notin: "notin", "not in": "notin", nin: "notin", in: "in",
};

/** Default filters applied by `vastai search offers` unless -n is passed. */
export function defaultOfferQuery(): Query {
  return {
    verified: { eq: true },
    external: { eq: false },
    rentable: { eq: true },
    rented: { eq: false },
  };
}

function coerce(value: string): unknown {
  if (value === "true" || value === "True") return true;
  if (value === "false" || value === "False") return false;
  if (value === "None" || value === "null") return null;
  return value;
}

/**
 * Port of vast.py parse_query(). Accepts e.g.
 *   gpu_name=RTX_4090 num_gpus>=2 dph_total<=1.5 geolocation in [US,CA]
 * and merges conditions into `res`.
 */
export function parseQuery(
  queryStr: string,
  res: Query = {},
  fields: Set<string> = OFFER_FIELDS,
  alias: Record<string, string> = OFFER_ALIAS,
  mult: Record<string, number> = OFFER_MULT,
): Query {
  const q = queryStr.trim();
  if (!q) return res;
  const pattern = /([a-zA-Z0-9_]+)( *[=><!]+| +(?:[lg]te?|nin|neq|eq|not ?eq|not ?in|in) )?( *)(\[[^\]]+\]|"[^"]+"|[^ ]+)?( *)/g;
  const opts: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  let joined = "";
  while ((m = pattern.exec(q)) !== null) {
    if (m[0] === "") {
      pattern.lastIndex++;
      continue;
    }
    opts.push(m);
    joined += m[0];
  }
  if (joined !== q) {
    throw new Error(`Unconsumed text in query. Did you forget to quote your query? ${JSON.stringify(joined)} != ${JSON.stringify(q)}`);
  }

  for (const [, rawField, rawOp = "", , rawValue = ""] of opts) {
    let field = rawField;
    let value: unknown = rawValue.replace(/^[,[]+|[,\]]+$/g, "");
    const op = rawOp.trim();
    const opName = OP_NAMES[op];

    if (field in alias) field = alias[field];
    void fields; // vast.py only warns on unknown fields; we stay permissive.
    if (!opName) throw new Error(`Unknown operator ${JSON.stringify(op)} in query.`);
    if (opName === "in" || opName === "notin") {
      value = String(value).split(",").map((x) => x.trim()).filter(Boolean);
    }
    if (value === "" || (Array.isArray(value) && value.length === 0)) {
      throw new Error(`Value cannot be blank for field ${field}.`);
    }
    if (value === "?" || value === "*" || value === "any") {
      if (opName !== "eq") throw new Error("Wildcard only makes sense with equals.");
      delete res[field];
      continue;
    }

    if (typeof value === "string") value = value.replace(/_/g, " ").replace(/^"|"$/g, "");
    else if (Array.isArray(value)) value = value.map((x) => String(x).replace(/_/g, " ").replace(/^"|"$/g, ""));

    const cond: Condition = (res[field] as Condition) ?? {};
    if (field in mult) cond[opName] = Number(value) * mult[field];
    else cond[opName] = typeof value === "string" ? coerce(value) : value;
    res[field] = cond;
  }
  return res;
}

/** Parse "dph_total,num_gpus-" style order strings into [[field, dir], ...]. */
export function parseOrder(order: string, alias: Record<string, string> = OFFER_ALIAS): [string, "asc" | "desc"][] {
  const out: [string, "asc" | "desc"][] = [];
  for (let name of order.split(",")) {
    name = name.trim();
    if (!name) continue;
    let dir: "asc" | "desc" = "asc";
    let field = name;
    if (name.endsWith("-")) {
      dir = "desc";
      field = name.slice(0, -1);
    } else if (name.endsWith("+")) {
      field = name.slice(0, -1);
    }
    if (field in alias) field = alias[field];
    out.push([field, dir]);
  }
  return out;
}

/** GPU names on the CLI use underscores ("RTX_4090"); the API wants spaces ("RTX 4090"). */
export function normalizeGpuName(name: string): string {
  return name.trim().replace(/_+/g, " ").replace(/\s+/g, " ");
}

export function resolveRegion(region: string): string[] {
  const r = region.trim();
  if (r in REGIONS) return REGIONS[r];
  const key = Object.keys(REGIONS).find((k) => k.toLowerCase().replace(/_/g, "") === r.toLowerCase().replace(/[_ ]/g, ""));
  if (key) return REGIONS[key];
  const codes = r.replace(/^\[|\]$/g, "").split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (codes.length && codes.every((c) => /^[A-Z]{2}$/.test(c))) return codes;
  throw new Error(`Invalid region ${JSON.stringify(region)}. Use one of ${Object.keys(REGIONS).join(", ")} or a list of 2-letter country codes like "US,CA".`);
}

export type OfferType = "on-demand" | "bid" | "reserved";
export type Strategy = "best_value" | "cheapest" | "fastest" | "most_reliable";

export interface OfferFilters {
  gpu_name?: string;
  gpu_names?: string[];
  num_gpus?: number;
  min_num_gpus?: number;
  min_gpu_ram_gb?: number;
  min_cpu_ram_gb?: number;
  min_cpu_cores?: number;
  min_disk_gb?: number;
  max_price_per_hour?: number;
  min_reliability?: number;
  min_inet_down_mbps?: number;
  min_inet_up_mbps?: number;
  min_cuda_version?: number;
  min_dlperf?: number;
  region?: string;
  exclude_region?: string;
  direct_port_count?: number;
  static_ip?: boolean;
  datacenter_only?: boolean;
  verified_only?: boolean;
  machine_id?: number;
  host_id?: number;
  raw_query?: string;
  type?: OfferType;
  strategy?: Strategy;
  order?: string;
  limit?: number;
  storage_gb?: number;
}

export const STRATEGY_ORDER: Record<Strategy, string> = {
  best_value: "score-",
  cheapest: "dph_total",
  fastest: "dlperf-",
  most_reliable: "reliability-,score-",
};

/** Build the JSON body for POST /api/v0/bundles/ from structured filters. */
export function buildOfferQuery(f: OfferFilters): Query {
  const q: Query = defaultOfferQuery();
  if (f.verified_only === false) delete q.verified;

  const set = (field: string, op: Op, value: unknown) => {
    const cond: Condition = (q[field] as Condition) ?? {};
    cond[op] = value;
    q[field] = cond;
  };

  if (f.gpu_names && f.gpu_names.length) set("gpu_name", "in", f.gpu_names.map(normalizeGpuName));
  else if (f.gpu_name) set("gpu_name", "eq", normalizeGpuName(f.gpu_name));
  if (f.num_gpus !== undefined) set("num_gpus", "eq", f.num_gpus);
  if (f.min_num_gpus !== undefined) set("num_gpus", "gte", f.min_num_gpus);
  if (f.min_gpu_ram_gb !== undefined) set("gpu_ram", "gte", f.min_gpu_ram_gb * OFFER_MULT.gpu_ram);
  if (f.min_cpu_ram_gb !== undefined) set("cpu_ram", "gte", f.min_cpu_ram_gb * OFFER_MULT.cpu_ram);
  if (f.min_cpu_cores !== undefined) set("cpu_cores_effective", "gte", f.min_cpu_cores);
  if (f.min_disk_gb !== undefined) set("disk_space", "gte", f.min_disk_gb);
  if (f.max_price_per_hour !== undefined) set("dph_total", "lte", f.max_price_per_hour);
  if (f.min_reliability !== undefined) set("reliability", "gte", f.min_reliability);
  if (f.min_inet_down_mbps !== undefined) set("inet_down", "gte", f.min_inet_down_mbps);
  if (f.min_inet_up_mbps !== undefined) set("inet_up", "gte", f.min_inet_up_mbps);
  if (f.min_cuda_version !== undefined) set("cuda_max_good", "gte", f.min_cuda_version);
  if (f.min_dlperf !== undefined) set("dlperf", "gte", f.min_dlperf);
  if (f.region) set("geolocation", "in", resolveRegion(f.region));
  if (f.exclude_region) set("geolocation", "notin", resolveRegion(f.exclude_region));
  if (f.direct_port_count !== undefined) set("direct_port_count", "gte", f.direct_port_count);
  if (f.static_ip !== undefined) set("static_ip", "eq", f.static_ip);
  if (f.datacenter_only) set("datacenter", "eq", true);
  if (f.machine_id !== undefined) set("machine_id", "eq", f.machine_id);
  if (f.host_id !== undefined) set("host_id", "eq", f.host_id);
  if (f.raw_query) parseQuery(f.raw_query, q);

  const order = f.order ?? STRATEGY_ORDER[f.strategy ?? "best_value"];
  q.order = parseOrder(order);
  q.type = f.type ?? "on-demand";
  if (f.limit !== undefined) q.limit = Math.floor(f.limit);
  q.allocated_storage = f.storage_gb ?? f.min_disk_gb ?? 5.0;
  return q;
}
