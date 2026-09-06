/**
 * Typed wrappers around the vast.ai REST endpoints used by the server.
 *
 * Each method documents the vast.py CLI function it was derived from so the
 * mapping can be re-verified against upstream when the API changes.
 */
import { VastClient } from "../client.js";
import type { Query } from "../query.js";
import type { CreateInstanceResponse, Instance, Offer, SshKey, Template, UserInfo, Volume } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CreateInstanceBody {
  image?: string;
  env: Record<string, string>;
  price?: number | null;
  disk: number;
  label?: string | null;
  onstart?: string | null;
  image_login?: string | null;
  python_utf8?: boolean;
  lang_utf8?: boolean;
  use_jupyter_lab?: boolean;
  jupyter_dir?: string | null;
  force?: boolean;
  cancel_unavail?: boolean;
  template_hash_id?: string | null;
  user?: string | null;
  runtype?: string;
  args?: string[];
  volume_info?: {
    mount_path: string;
    create_new: boolean;
    volume_id: number;
    name?: string;
    size?: number;
  };
  extra?: unknown;
}

export interface LogsOptions {
  tail?: number;
  filter?: string;
  daemon_logs?: boolean;
}

export class VastApi {
  constructor(public readonly client: VastClient) {}

  // ---- account ---------------------------------------------------------

  /** vast.py show__user: GET /users/current (api_key is stripped from the response). */
  async getUser(): Promise<UserInfo> {
    const u = await this.client.get<UserInfo & { api_key?: string }>("/users/current");
    delete u.api_key;
    return u;
  }

  /** vast.py _get_gpu_names: GET /gpu_names/unique/ (public). */
  async gpuNames(): Promise<string[]> {
    const r = await this.client.get<{ gpu_names: string[] }>("/gpu_names/unique/", { noAuth: true });
    return r.gpu_names ?? [];
  }

  // ---- offers ----------------------------------------------------------

  /** vast.py search__offers: POST /bundles/ with the query dict as body. */
  async searchOffers(query: Query): Promise<Offer[]> {
    const r = await this.client.post<{ offers: Offer[] }>("/bundles/", { json: query });
    let rows = r.offers ?? [];
    // vast.py applies the `rented` filter client-side.
    const rentedCond = query.rented as Record<string, unknown> | undefined;
    if (rentedCond) {
      const [op] = Object.keys(rentedCond);
      const target = rentedCond[op];
      rows = rows.filter((row) => {
        const rented = row.rented ?? false;
        switch (op) {
          case "eq": return rented === target;
          case "neq": return rented !== target;
          case "in": return (target as unknown[]).includes(rented);
          case "notin": return !(target as unknown[]).includes(rented);
          default: return true;
        }
      });
    }
    return rows;
  }

  // ---- instances -------------------------------------------------------

  /** vast.py _fetch_all_instances_v1: paginated GET /api/v1/instances/. */
  async listInstances(): Promise<Instance[]> {
    const rows: Instance[] = [];
    const params: Record<string, unknown> = {
      select_filters: {},
      order_by: [{ col: "id", dir: "asc" }],
      limit: 25,
    };
    for (let page = 0; page < 200; page++) {
      const data = await this.client.get<{ instances?: Instance[]; next_token?: string | null }>("/api/v1/instances/", { query: params });
      rows.push(...(data.instances ?? []));
      if (!data.next_token) break;
      params.after_token = data.next_token;
    }
    return rows;
  }

  /** vast.py show__instance: GET /instances/{id}/?owner=me. Returns null when the instance is gone. */
  async getInstance(id: number): Promise<Instance | null> {
    const r = await this.client.get<{ instances: Instance | null }>(`/instances/${id}/`, { query: { owner: "me" } });
    return r.instances ?? null;
  }

  /** vast.py create__instance: PUT /asks/{offer_id}/. */
  async createInstance(offerId: number, body: CreateInstanceBody): Promise<CreateInstanceResponse> {
    return this.client.put<CreateInstanceResponse>(`/asks/${offerId}/`, { json: { client_id: "me", ...body } });
  }

  /** vast.py start_instance / stop_instance: PUT /instances/{id}/ {state}. */
  async setInstanceState(id: number, state: "running" | "stopped"): Promise<{ success: boolean; msg?: string }> {
    return this.client.put(`/instances/${id}/`, { json: { state } });
  }

  /** vast.py reboot__instance: PUT /instances/reboot/{id}/. */
  async rebootInstance(id: number): Promise<{ success: boolean; msg?: string }> {
    return this.client.put(`/instances/reboot/${id}/`, { json: {} });
  }

  /** vast.py destroy_instance: DELETE /instances/{id}/. */
  async destroyInstance(id: number): Promise<{ success: boolean; msg?: string }> {
    return this.client.delete(`/instances/${id}/`, { json: {} });
  }

  /** vast.py label__instance: PUT /instances/{id}/ {label}. */
  async labelInstance(id: number, label: string): Promise<{ success: boolean; msg?: string }> {
    return this.client.put(`/instances/${id}/`, { json: { label } });
  }

  /** vast.py change__bid: PUT /instances/bid_price/{id}/. */
  async changeBid(id: number, price: number): Promise<{ success: boolean; msg?: string }> {
    return this.client.put(`/instances/bid_price/${id}/`, { json: { client_id: "me", price } });
  }

  // ---- ssh keys --------------------------------------------------------

  /** vast.py show__ssh_keys: GET /ssh/ -> {"ssh_keys": [{"id", "ssh_key"}]}. */
  async listSshKeys(): Promise<SshKey[]> {
    const r = await this.client.get<SshKey[] | { ssh_keys?: SshKey[] }>("/ssh/");
    if (Array.isArray(r)) return r;
    return r.ssh_keys ?? [];
  }

  /** vast.py create__ssh_key: POST /ssh/ {ssh_key}. */
  async addSshKey(publicKey: string): Promise<unknown> {
    return this.client.post("/ssh/", { json: { ssh_key: publicKey } });
  }

  /** vast.py delete__ssh_key: DELETE /ssh/{id}/. */
  async deleteSshKey(id: number): Promise<unknown> {
    return this.client.delete(`/ssh/${id}/`);
  }

  /** vast.py attach__ssh: POST /instances/{id}/ssh/ {ssh_key}. */
  async attachSshKey(instanceId: number, publicKey: string): Promise<unknown> {
    return this.client.post(`/instances/${instanceId}/ssh/`, { json: { ssh_key: publicKey } });
  }

  /** vast.py detach__ssh: DELETE /instances/{id}/ssh/{key_id}/. */
  async detachSshKey(instanceId: number, keyId: number): Promise<unknown> {
    return this.client.delete(`/instances/${instanceId}/ssh/${keyId}/`);
  }

  // ---- logs / remote commands -----------------------------------------

  /** Poll an S3-style result_url the way vast.py does (30 x 0.3s, then a few slower retries). */
  private async pollResultUrl(url: string, notFoundMsg: string): Promise<string> {
    const delays = [...Array(30).fill(300), 1000, 2000, 3000, 5000];
    for (const d of delays) {
      await sleep(d);
      const r = await this.client.fetchText(url);
      if (r.status === 200) return r.text;
    }
    throw new Error(notFoundMsg);
  }

  /** vast.py logs: PUT /instances/request_logs/{id}/ then poll result_url. */
  async logs(id: number, opts: LogsOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {};
    if (opts.filter) body.filter = opts.filter;
    if (opts.tail) body.tail = String(opts.tail);
    if (opts.daemon_logs) body.daemon_logs = "true";
    const r = await this.client.put<{ result_url?: string; msg?: string; success?: boolean }>(`/instances/request_logs/${id}/`, { json: body });
    if (!r.result_url) throw new Error(r.msg ?? "log request did not return a result_url");
    const text = await this.pollResultUrl(r.result_url, r.msg ?? `logs for instance ${id} were not ready in time; retry in a few seconds`);
    return text.replace(/\n\s*\n/g, "\n");
  }

  /** vast.py execute: PUT /instances/command/{id}/ (only ls / rm / du are allowed server-side). */
  async execute(id: number, command: string): Promise<string> {
    const r = await this.client.put<{ success: boolean; result_url?: string; writeable_path?: string; msg?: string }>(
      `/instances/command/${id}/`,
      { json: { command } },
    );
    if (!r.success || !r.result_url) throw new Error(r.msg ?? JSON.stringify(r));
    const text = await this.pollResultUrl(r.result_url, `command output for instance ${id} was not ready in time`);
    return r.writeable_path ? text.split(r.writeable_path).join("") : text;
  }

  // ---- templates -------------------------------------------------------

  /** vast.py search__templates: GET /template/?select_cols=["*"]&select_filters={...}. */
  async searchTemplates(filters: Query): Promise<Template[]> {
    const r = await this.client.get<{ templates?: Template[] }>("/template/", {
      query: { select_cols: ["*"], select_filters: filters },
    });
    return r.templates ?? [];
  }

  // ---- volumes ---------------------------------------------------------

  /** vast.py show__volumes: GET /volumes?owner=me&type=all_volume. */
  async listVolumes(type: "local" | "network" | "all" = "all"): Promise<Volume[]> {
    const t = { local: "local_volume", network: "network_volume", all: "all_volume" }[type];
    const r = await this.client.get<{ volumes?: Volume[] }>("/volumes", { query: { owner: "me", type: t } });
    return r.volumes ?? [];
  }

  /** vast.py search__volumes: POST /volumes/search/. */
  async searchVolumes(query: Query): Promise<Offer[]> {
    const r = await this.client.post<{ offers?: Offer[] }>("/volumes/search/", { json: query });
    return r.offers ?? [];
  }

  /** vast.py create__volume: PUT /volumes/ {id, size, name}. */
  async createVolume(offerId: number, sizeGb: number, name?: string): Promise<unknown> {
    const body: Record<string, unknown> = { id: offerId, size: Math.floor(sizeGb) };
    if (name) body.name = name;
    return this.client.put("/volumes/", { json: body });
  }

  /** vast.py delete__volume: DELETE /volumes/?id=... */
  async deleteVolume(id: number): Promise<unknown> {
    return this.client.delete("/volumes/", { query: { id } });
  }
}
