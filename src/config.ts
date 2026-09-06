import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runtime configuration for the server.
 *
 * Resolution order mirrors the vastai CLI (vast.py):
 *   - API key: VAST_API_KEY env  ->  ~/.vast_api_key file
 *   - Base URL: VAST_URL env      ->  https://console.vast.ai
 */
export interface VastConfig {
  apiKey: string | undefined;
  baseUrl: string;
  /** Path to the SSH private key used by vast_run / vast_copy_file. */
  sshPrivateKeyPath: string | undefined;
  /** Path to (or literal contents of) the SSH public key registered on the account before launch. */
  sshPublicKey: string | undefined;
  /** Retry count for 429 responses. */
  retry: number;
}

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function readApiKeyFile(): string | undefined {
  const p = path.join(os.homedir(), ".vast_api_key");
  try {
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, "utf8").trim();
      return v || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VastConfig {
  const home = os.homedir();
  const sshDir = path.join(home, ".ssh");

  const privateKeyPath =
    env.VAST_SSH_KEY ||
    firstExisting([
      path.join(sshDir, "id_ed25519"),
      path.join(sshDir, "id_rsa"),
      path.join(sshDir, "id_ecdsa"),
    ]);

  let publicKey: string | undefined = env.VAST_SSH_PUBLIC_KEY;
  if (!publicKey && privateKeyPath) {
    const pub = privateKeyPath + ".pub";
    if (fs.existsSync(pub)) publicKey = pub;
  }

  return {
    apiKey: env.VAST_API_KEY?.trim() || readApiKeyFile(),
    baseUrl: (env.VAST_URL || "https://console.vast.ai").replace(/\/+$/, ""),
    sshPrivateKeyPath: privateKeyPath,
    sshPublicKey: publicKey,
    retry: Number(env.VAST_RETRY || 3),
  };
}

/** Resolve a value that may be either a file path or literal key material. */
export function readKeyMaterial(value: string): string {
  try {
    if (fs.existsSync(value)) return fs.readFileSync(value, "utf8").trim();
  } catch {
    /* ignore */
  }
  return value.trim();
}
