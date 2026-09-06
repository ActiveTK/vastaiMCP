/**
 * SSH helpers built on ssh2. vast.ai's REST "execute" endpoint only permits
 * ls / rm / du, so real command execution and file transfer go over SSH.
 */
import fs from "node:fs";
import path from "node:path";
import { Client, type ConnectConfig } from "ssh2";

export interface SshTarget {
  host: string;
  port: number;
  user?: string;
}

export interface SshAuth {
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
}

function connectConfig(target: SshTarget, auth: SshAuth, timeoutMs: number): ConnectConfig {
  if (!auth.privateKeyPath) {
    throw new Error("No SSH private key configured. Set VAST_SSH_KEY to the path of the private key whose public half is registered on vast.ai.");
  }
  const key = fs.readFileSync(auth.privateKeyPath);
  return {
    host: target.host,
    port: target.port,
    username: target.user ?? "root",
    privateKey: key,
    passphrase: auth.passphrase ?? process.env.VAST_SSH_PASSPHRASE,
    readyTimeout: timeoutMs,
    keepaliveInterval: 10_000,
    // Instances are ephemeral; host keys change every launch.
    hostVerifier: () => true,
  };
}

function connect(target: SshTarget, auth: SshAuth, timeoutMs: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.once("ready", () => resolve(conn));
    conn.once("error", reject);
    try {
      conn.connect(connectConfig(target, auth, timeoutMs));
    } catch (e) {
      reject(e);
    }
  });
}

/** Try to open an SSH session; resolves true when a connection is accepted. */
export async function probeSsh(target: SshTarget, auth: SshAuth, timeoutMs = 10_000): Promise<boolean> {
  try {
    const conn = await connect(target, auth, timeoutMs);
    conn.end();
    return true;
  } catch {
    return false;
  }
}

export async function sshExec(
  target: SshTarget,
  auth: SshAuth,
  command: string,
  opts: { timeoutMs?: number; maxOutputBytes?: number; connectTimeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxOutputBytes ?? 200_000;
  const started = Date.now();
  const conn = await connect(target, auth, opts.connectTimeoutMs ?? 20_000);
  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const timer = setTimeout(() => {
        reject(new Error(`command timed out after ${timeoutMs} ms; partial stdout:\n${stdout.slice(-4000)}`));
        conn.end();
      }, timeoutMs);
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        const push = (which: "out" | "err", chunk: Buffer) => {
          const s = chunk.toString("utf8");
          if (which === "out") {
            if (stdout.length + s.length > maxBytes) {
              stdout += s.slice(0, Math.max(0, maxBytes - stdout.length));
              truncated = true;
            } else stdout += s;
          } else {
            if (stderr.length + s.length > maxBytes / 4) {
              stderr += s.slice(0, Math.max(0, maxBytes / 4 - stderr.length));
              truncated = true;
            } else stderr += s;
          }
        };
        stream.on("data", (c: Buffer) => push("out", c));
        stream.stderr.on("data", (c: Buffer) => push("err", c));
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ exit_code: code, stdout, stderr, truncated, duration_ms: Date.now() - started });
        });
      });
    });
  } finally {
    conn.end();
  }
}

export interface CopyResult {
  direction: "upload" | "download";
  local_path: string;
  remote_path: string;
  bytes: number;
}

export async function sftpCopy(
  target: SshTarget,
  auth: SshAuth,
  direction: "upload" | "download",
  localPath: string,
  remotePath: string,
  opts: { connectTimeoutMs?: number } = {},
): Promise<CopyResult> {
  const conn = await connect(target, auth, opts.connectTimeoutMs ?? 20_000);
  try {
    const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) =>
      conn.sftp((err, s) => (err ? reject(err) : resolve(s))),
    );
    if (direction === "upload") {
      const stat = fs.statSync(localPath);
      if (!stat.isFile()) throw new Error(`local path is not a regular file: ${localPath}`);
      await new Promise<void>((resolve, reject) => sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve())));
      return { direction, local_path: localPath, remote_path: remotePath, bytes: stat.size };
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await new Promise<void>((resolve, reject) => sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve())));
    return { direction, local_path: localPath, remote_path: remotePath, bytes: fs.statSync(localPath).size };
  } finally {
    conn.end();
  }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
