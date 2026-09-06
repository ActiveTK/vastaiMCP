/**
 * Build an onstart script from structured pieces.
 *
 * vast runs the onstart script on *every* container start (including a
 * start after stop), so `screens` are re-launched whenever the instance is
 * (re)started — that is what makes "prepare, stop, then start all at once"
 * workflows possible.
 */

export interface ScreenSpec {
  /** screen session name; sanitised to [A-Za-z0-9_-] */
  name?: string;
  /** command run inside `bash -lc`; stdout/stderr appended to <workdir>/<name>.log */
  command: string;
}

export interface OnstartSpec {
  /** apt packages to install before anything else (screen and curl are added automatically when screens are used) */
  apt_packages?: string[];
  /** raw script inserted after package setup */
  onstart_cmd?: string;
  /** detached screen sessions to start */
  screens?: ScreenSpec[];
  /** directory for logs (default /work) */
  workdir?: string;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sanitizeScreenName(name: string | undefined, fallback: string): string {
  const n = (name ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return n || fallback;
}

/** Returns undefined when nothing was specified. */
export function buildOnstart(spec: OnstartSpec): string | undefined {
  const screens = (spec.screens ?? []).filter((s) => s.command?.trim());
  const pkgs = new Set(spec.apt_packages ?? []);
  if (screens.length) {
    pkgs.add("screen");
    pkgs.add("curl");
  }
  const workdir = spec.workdir ?? "/work";
  const lines: string[] = [];
  if (pkgs.size) {
    lines.push(
      "export DEBIAN_FRONTEND=noninteractive",
      "dpkg --configure -a || true",
      "apt-get -f -y install || true",
      `(apt-get update && apt-get install -y ${[...pkgs].map(shq).join(" ")}) || true`,
    );
  }
  if (screens.length) lines.push(`mkdir -p ${shq(workdir)}`);
  if (spec.onstart_cmd?.trim()) lines.push(spec.onstart_cmd.trim());
  screens.forEach((s, i) => {
    const name = sanitizeScreenName(s.name, i === 0 ? "main" : `job${i + 1}`);
    const cmd = `${s.command.trim()} >>${workdir}/${name}.log 2>&1`;
    lines.push(`screen -S ${name} -dm bash -lc ${shq(cmd)}`);
  });
  if (!lines.length) return undefined;
  return lines.join("\n");
}
