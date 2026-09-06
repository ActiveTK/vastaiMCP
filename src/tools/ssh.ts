import { z } from "zod";
import { readKeyMaterial } from "../config.js";
import { ensureSshKeyRegistered } from "../workflows/launch.js";
import { guard, instanceIdSchema, ok, type ToolContext } from "./common.js";

export function registerSshKeyTools({ server, api, cfg }: ToolContext) {
  server.registerTool(
    "vast_ssh_keys",
    {
      title: "Manage SSH keys",
      description:
        "Manage SSH public keys. list: keys on the account (injected into every new instance). add: register a key (defaults to the configured VAST_SSH_PUBLIC_KEY). " +
        "delete: remove a key from the account. attach/detach: add or remove a key on an already-running instance (needed when a key was added after the instance was created).",
      inputSchema: {
        action: z.enum(["list", "add", "delete", "attach", "detach"]),
        public_key: z.string().optional().describe("For add/attach: public key literal or path to a .pub file. Defaults to the configured public key."),
        key_id: z.number().int().optional().describe("For delete/detach: ssh key id from list."),
        instance_id: instanceIdSchema.optional().describe("For attach/detach."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ action, public_key, key_id, instance_id }) => {
      const keySource = public_key ?? cfg.sshPublicKey;
      switch (action) {
        case "list": {
          const keys = await api.listSshKeys();
          return ok({ count: keys.length, keys: keys.map((k) => ({ id: k.id, public_key: k.public_key })) });
        }
        case "add": {
          if (!keySource) throw new Error("No public key given and VAST_SSH_PUBLIC_KEY is not configured.");
          const r = await ensureSshKeyRegistered(api, keySource);
          return ok({ result: r, source: keySource });
        }
        case "delete": {
          if (key_id === undefined) throw new Error("key_id is required for delete.");
          return ok({ deleted: key_id, response: await api.deleteSshKey(key_id) });
        }
        case "attach": {
          if (!instance_id) throw new Error("instance_id is required for attach.");
          if (!keySource) throw new Error("No public key given and VAST_SSH_PUBLIC_KEY is not configured.");
          const material = readKeyMaterial(keySource);
          return ok({ attached_to: instance_id, response: await api.attachSshKey(instance_id, material) });
        }
        case "detach": {
          if (!instance_id || key_id === undefined) throw new Error("instance_id and key_id are required for detach.");
          return ok({ detached_from: instance_id, key_id, response: await api.detachSshKey(instance_id, key_id) });
        }
      }
    }),
  );
}
