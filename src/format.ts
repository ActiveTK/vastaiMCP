/**
 * Compact, LLM-friendly views of API objects. Raw objects have 100+ fields;
 * the summaries keep what is needed to decide and to connect.
 */
import type { Instance, Offer, Template, Volume } from "./types.js";

const round = (v: unknown, d = 3): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : undefined;

export interface OfferSummary {
  offer_id: number;
  machine_id: number;
  gpu: string;
  num_gpus: number;
  gpu_ram_gb?: number;
  price_per_hour: number;
  min_bid_per_hour?: number;
  storage_cost_per_gb_month?: number;
  cpu?: string;
  cpu_cores?: number;
  cpu_ram_gb?: number;
  disk_gb?: number;
  inet_down_mbps?: number;
  inet_up_mbps?: number;
  reliability?: number;
  dlperf?: number;
  dlperf_per_dollar?: number;
  cuda?: number;
  location?: string;
  verified?: string;
  direct_ports?: number;
  static_ip?: boolean;
  max_duration_days?: number;
}

export function summarizeOffer(o: Offer): OfferSummary {
  return {
    offer_id: o.id,
    machine_id: o.machine_id,
    gpu: `${o.num_gpus}x ${o.gpu_name}`,
    num_gpus: o.num_gpus,
    gpu_ram_gb: round(o.gpu_ram / 1024, 1),
    price_per_hour: round(o.dph_total, 4) ?? o.dph_total,
    min_bid_per_hour: round(o.min_bid, 4),
    storage_cost_per_gb_month: round(o.storage_cost, 3),
    cpu: o.cpu_name,
    cpu_cores: round(o.cpu_cores_effective, 1),
    cpu_ram_gb: round((o.cpu_ram ?? 0) / 1024, 1),
    disk_gb: round(o.disk_space, 0),
    inet_down_mbps: round(o.inet_down, 0),
    inet_up_mbps: round(o.inet_up, 0),
    reliability: round(o.reliability2 ?? o.reliability, 4),
    dlperf: round(o.dlperf, 1),
    dlperf_per_dollar: round(o.dlperf_per_dphtotal, 1),
    cuda: o.cuda_max_good,
    location: o.geolocation,
    verified: o.verification,
    direct_ports: o.direct_port_count,
    static_ip: o.static_ip,
    max_duration_days: round((o.duration ?? 0) / 86400, 1),
  };
}

export interface SshEndpoint {
  host: string;
  port: number;
  user: "root";
  /** true when the port is a direct host port (faster), false when via vast's ssh proxy */
  direct: boolean;
  command: string;
}

/** Port of vast.py _ssh_url(): prefer a direct 22/tcp mapping, else the proxy host. */
export function sshEndpoint(i: Instance): SshEndpoint | undefined {
  const p22 = i.ports?.["22/tcp"];
  if (p22 && p22.length && i.public_ipaddr) {
    const port = Number(p22[0].HostPort);
    if (port > 0) {
      return { host: i.public_ipaddr, port, user: "root", direct: true, command: `ssh -p ${port} root@${i.public_ipaddr}` };
    }
  }
  if (i.ssh_host && i.ssh_port) {
    let port = Number(i.ssh_port);
    if ((i.image_runtype ?? "").includes("jupyter")) port += 1;
    return { host: i.ssh_host, port, user: "root", direct: false, command: `ssh -p ${port} root@${i.ssh_host}` };
  }
  return undefined;
}

/** Map of container port -> public host:port, from the docker port bindings. */
export function publishedPorts(i: Instance): Record<string, string> {
  const out: Record<string, string> = {};
  if (!i.ports) return out;
  for (const [containerPort, bindings] of Object.entries(i.ports)) {
    if (!bindings?.length) continue;
    const b = bindings[0];
    const host = b.HostIp && b.HostIp !== "0.0.0.0" ? b.HostIp : (i.public_ipaddr ?? b.HostIp);
    out[containerPort] = `${host}:${b.HostPort}`;
  }
  return out;
}

export function jupyterUrl(i: Instance): string | undefined {
  if (!(i.image_runtype ?? "").includes("jupyter")) return undefined;
  const ports = publishedPorts(i);
  const hp = ports["8080/tcp"];
  if (hp && i.jupyter_token) return `https://${hp}/?token=${i.jupyter_token}`;
  return undefined;
}

export interface InstanceSummary {
  id: number;
  status: string;
  status_message?: string;
  label?: string | null;
  gpu: string;
  gpu_util_percent?: number;
  machine_id: number;
  location?: string;
  image?: string;
  runtype?: string;
  disk_gb?: number;
  disk_used_gb?: number;
  price_per_hour?: number;
  storage_cost_per_gb_month?: number;
  is_interruptible?: boolean;
  bid_per_hour?: number;
  age_hours?: number;
  uptime_minutes?: number;
  ssh?: SshEndpoint;
  jupyter_url?: string;
  ports?: Record<string, string>;
  public_ip?: string;
  reliability?: number;
  env?: Record<string, string>;
}

export function summarizeInstance(i: Instance, opts: { includeEnv?: boolean } = {}): InstanceSummary {
  const env = Array.isArray(i.extra_env) ? Object.fromEntries(i.extra_env) : i.extra_env;
  const s: InstanceSummary = {
    id: i.id,
    status: i.actual_status ?? "provisioning",
    status_message: i.status_msg?.trim() || undefined,
    label: i.label ?? undefined,
    gpu: `${i.num_gpus}x ${i.gpu_name}`,
    gpu_util_percent: round(i.gpu_util, 1),
    machine_id: i.machine_id,
    location: i.geolocation,
    image: i.image_uuid,
    runtype: i.image_runtype,
    disk_gb: round(i.disk_space, 0),
    disk_used_gb: round(i.disk_util, 1),
    price_per_hour: round(i.dph_total, 4),
    storage_cost_per_gb_month: round(i.storage_cost, 3),
    is_interruptible: i.is_bid || undefined,
    bid_per_hour: i.is_bid ? round(i.min_bid, 4) : undefined,
    age_hours: i.start_date ? round((Date.now() / 1000 - i.start_date) / 3600, 2) : undefined,
    uptime_minutes: round(i.uptime_mins, 1),
    ssh: sshEndpoint(i),
    jupyter_url: jupyterUrl(i),
    ports: publishedPorts(i),
    public_ip: i.public_ipaddr,
    reliability: round(i.reliability2, 4),
  };
  if (opts.includeEnv && env) s.env = env;
  if (s.ports && !Object.keys(s.ports).length) delete s.ports;
  return s;
}

export function summarizeTemplate(t: Template) {
  return {
    template_hash: t.hash_id,
    id: t.id,
    name: t.name,
    image: t.tag ? `${t.image}:${t.tag}` : t.image,
    recommended_disk_gb: t.recommended_disk_space,
    times_used: t.count_created,
    recommended: t.recommended || undefined,
    ssh: t.use_ssh || undefined,
    ssh_direct: t.ssh_direct || undefined,
    jupyter_direct: t.jup_direct || undefined,
    private: t.private || undefined,
    description: typeof t.desc === "string" ? t.desc.slice(0, 300) : undefined,
  };
}

export function summarizeVolume(v: Volume) {
  return {
    id: v.id,
    name: v.label ?? v.name,
    status: v.status,
    disk_gb: v.disk_space,
    storage_cost_per_gb_month: round(v.storage_cost, 3),
    machine_id: v.machine_id,
    age_hours: v.start_date ? round((Date.now() / 1000 - v.start_date) / 3600, 2) : undefined,
  };
}

/** Drop undefined values recursively so JSON output stays compact. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}
