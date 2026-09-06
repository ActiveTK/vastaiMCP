/**
 * Thin HTTP client that reproduces the request shape of vast.py's
 * `apiurl()` / `http_request()` helpers so we can talk to the REST API
 * without shelling out to the `vastai` CLI.
 */

export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export class VastApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly body: string,
    message?: string,
  ) {
    super(message ?? `${method} ${url} -> HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "VastApiError";
  }
}

export interface RequestOptions {
  /** Query-string params. Non-string values are JSON encoded (as in vast.py apiurl()). */
  query?: Record<string, unknown>;
  /** JSON body. */
  json?: unknown;
  /** Skip the Authorization header (a few endpoints are public). */
  noAuth?: boolean;
  /** Override base URL (e.g. run.vast.ai for serverless). */
  baseUrl?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VastClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly retry = 3,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Mirrors vast.py apiurl(): prefixes /api/v0 unless an explicit /api/vN/ path is given. */
  buildUrl(subpath: string, query?: Record<string, unknown>, baseUrl?: string): string {
    let p = subpath;
    if (!/^\/api\/v\d+\//.test(p)) p = "/api/v0" + p;
    const url = new URL((baseUrl ?? this.baseUrl) + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    }
    return url.toString();
  }

  private headers(noAuth?: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "vastai-mcp",
    };
    if (this.apiKey && !noAuth) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async request<T = unknown>(method: "GET" | "PUT" | "POST" | "DELETE", subpath: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(subpath, opts.query, opts.baseUrl);
    const init: RequestInit = { method, headers: this.headers(opts.noAuth) };
    if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
    else if (method !== "GET") init.body = "{}";

    let backoff = 150;
    let res: Response | undefined;
    for (let attempt = 0; attempt < Math.max(1, this.retry); attempt++) {
      res = await this.fetchImpl(url, init);
      if (res.status === 429) {
        await sleep(backoff);
        backoff *= 1.5;
        continue;
      }
      break;
    }
    if (!res) throw new Error("no response");

    const text = await res.text();
    if (!res.ok) {
      let msg: string | undefined;
      try {
        const j = JSON.parse(text);
        msg = j?.msg ?? j?.error ?? j?.message;
      } catch {
        /* not json */
      }
      throw new VastApiError(res.status, method, url, text, msg ? `${method} ${subpath} -> HTTP ${res.status}: ${msg}` : undefined);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T = unknown>(subpath: string, opts?: RequestOptions) {
    return this.request<T>("GET", subpath, opts);
  }
  put<T = unknown>(subpath: string, opts?: RequestOptions) {
    return this.request<T>("PUT", subpath, opts);
  }
  post<T = unknown>(subpath: string, opts?: RequestOptions) {
    return this.request<T>("POST", subpath, opts);
  }
  delete<T = unknown>(subpath: string, opts?: RequestOptions) {
    return this.request<T>("DELETE", subpath, opts);
  }

  /** Plain GET of an absolute URL (used for result_url polling of logs / execute). */
  async fetchText(url: string): Promise<{ status: number; text: string }> {
    const r = await this.fetchImpl(url);
    return { status: r.status, text: await r.text() };
  }
}
