/**
 * Container environment construction.
 *
 * vast.py sends `env` as a flat dict where ordinary variables are `{NAME: value}`
 * and docker flags are encoded as keys: `{"-p 8080:8080": "1", "-h": "host", ...}`.
 * See parse_env() in vast.py; buildEnv() produces the same shape from structured input.
 */

export interface EnvSpec {
  env?: Record<string, string | number | boolean>;
  /** Port mappings like "8080", "8080:8080", "8081:8081/udp". Bare port maps to itself. */
  ports?: (string | number)[];
  hostname?: string;
  /** Docker-style string for compatibility: "-e A=1 -p 8080:8080 -h name". */
  docker_options?: string;
}

const PORT_CHARS = /^[0-9:tcpud/]+$/;

export function normalizePort(p: string | number): string {
  const s = String(p).trim();
  if (/^\d+$/.test(s)) return `${s}:${s}`;
  if (/^\d+\/(tcp|udp)$/.test(s)) {
    const [port, proto] = s.split("/");
    return `${port}:${port}/${proto}`;
  }
  if (!/^\d+:\d+(\/(tcp|udp))?$/.test(s)) {
    throw new Error(`Invalid port mapping ${JSON.stringify(s)}. Use "8080", "8080:8080" or "8080:8080/udp".`);
  }
  return s;
}

/** Split on whitespace while respecting single/double quotes (vast.py smart_split). */
export function smartSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Port of vast.py parse_env(). */
export function parseDockerOptions(s: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!s) return result;
  let prev: string | null = null;
  for (const e of smartSplit(s)) {
    if (prev === null) {
      if (["-e", "-p", "-h", "-v", "-n"].includes(e)) prev = e;
      continue;
    }
    if (prev === "-p") {
      if (PORT_CHARS.test(e)) result["-p " + e] = "1";
    } else if (prev === "-e") {
      const i = e.indexOf("=");
      if (i > 0) result[e.slice(0, i)] = e.slice(i + 1).replace(/^['"]|['"]$/g, "");
    } else if (prev === "-v") {
      if (/^[a-zA-Z0-9:./_]+$/.test(e)) result["-v " + e] = "1";
    } else if (prev === "-n") {
      if (/^[a-z0-9-]+$/.test(e)) result["-n " + e] = "1";
    } else {
      result[prev] = e;
    }
    prev = null;
  }
  return result;
}

export function buildEnv(spec: EnvSpec): Record<string, string> {
  const out: Record<string, string> = parseDockerOptions(spec.docker_options);
  for (const p of spec.ports ?? []) out["-p " + normalizePort(p)] = "1";
  if (spec.hostname) out["-h"] = spec.hostname;
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable name ${JSON.stringify(k)}.`);
    out[k] = String(v);
  }
  return out;
}
