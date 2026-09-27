/** Partial shapes of vast.ai API objects (only the fields this server reads). */

export interface Offer {
  id: number;
  machine_id: number;
  host_id?: number;
  gpu_name: string;
  num_gpus: number;
  gpu_ram: number; // MB
  gpu_total_ram?: number;
  gpu_arch?: string;
  cpu_name?: string;
  cpu_cores_effective?: number;
  cpu_ram?: number; // MB
  disk_space?: number; // GB
  disk_bw?: number;
  dph_total: number;
  dph_base?: number;
  min_bid?: number;
  storage_cost?: number;
  inet_up?: number;
  inet_down?: number;
  reliability2?: number;
  reliability?: number;
  dlperf?: number;
  dlperf_per_dphtotal?: number;
  total_flops?: number;
  cuda_max_good?: number;
  driver_version?: string;
  geolocation?: string;
  verification?: string;
  direct_port_count?: number;
  static_ip?: boolean;
  rentable?: boolean;
  rented?: boolean;
  score?: number;
  duration?: number;
  pcie_bw?: number;
  [k: string]: unknown;
}

export interface Instance {
  id: number;
  machine_id: number;
  actual_status: string | null;
  intended_status?: string;
  cur_state?: string;
  next_state?: string;
  status_msg?: string | null;
  gpu_name: string;
  num_gpus: number;
  gpu_util?: number | null;
  gpu_ram?: number;
  cpu_cores_effective?: number;
  cpu_ram?: number;
  disk_space?: number;
  disk_util?: number;
  ssh_host?: string;
  ssh_port?: number;
  public_ipaddr?: string;
  ports?: Record<string, { HostIp: string; HostPort: string }[]> | null;
  direct_port_start?: number;
  direct_port_end?: number;
  dph_total?: number;
  dph_base?: number;
  storage_cost?: number;
  image_uuid?: string;
  image_runtype?: string;
  label?: string | null;
  start_date?: number;
  end_date?: number | null;
  jupyter_token?: string;
  geolocation?: string;
  reliability2?: number;
  inet_up?: number;
  inet_down?: number;
  extra_env?: [string, string][] | Record<string, string>;
  template_hash_id?: string | null;
  is_bid?: boolean;
  min_bid?: number;
  uptime_mins?: number;
  local_ipaddrs?: string;
  [k: string]: unknown;
}

export interface CreateInstanceResponse {
  success: boolean;
  new_contract?: number;
  msg?: string;
  error?: string;
}

export interface SshKey {
  id: number;
  /** The API returns the key under `ssh_key`. */
  ssh_key: string;
  [k: string]: unknown;
}

export interface UserInfo {
  id: number;
  username?: string;
  email?: string;
  balance?: number;
  credit?: number;
  balance_threshold?: number;
  balance_threshold_enabled?: boolean;
  has_billing?: boolean;
  can_pay?: boolean;
  billing_creditonly?: boolean;
  [k: string]: unknown;
}

export interface Template {
  id: number;
  hash_id: string;
  name: string;
  image: string;
  tag?: string;
  default_tag?: string;
  recommended_disk_space?: number;
  count_created?: number;
  recommended?: boolean;
  ssh_direct?: boolean;
  jup_direct?: boolean;
  use_ssh?: boolean;
  private?: boolean;
  desc?: string;
  [k: string]: unknown;
}

export interface Volume {
  id: number;
  label?: string;
  name?: string;
  disk_space?: number;
  storage_cost?: number;
  status?: string;
  machine_id?: number;
  start_date?: number;
  [k: string]: unknown;
}
