import { describe, expect, it } from "vitest";
import { compact, jupyterUrl, publishedPorts, sshEndpoint, summarizeInstance } from "../src/format.js";
import type { Instance } from "../src/types.js";

const base: Instance = {
  id: 1,
  machine_id: 2,
  actual_status: "running",
  gpu_name: "RTX 4090",
  num_gpus: 1,
  ssh_host: "ssh5.vast.ai",
  ssh_port: 12345,
  image_runtype: "ssh_direc ssh_proxy",
  dph_total: 0.5,
};

describe("sshEndpoint (port of vast.py _ssh_url)", () => {
  it("prefers a direct 22/tcp mapping", () => {
    const i: Instance = { ...base, public_ipaddr: "1.2.3.4", ports: { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "40022" }] } };
    expect(sshEndpoint(i)).toEqual({ host: "1.2.3.4", port: 40022, user: "root", direct: true, command: "ssh -p 40022 root@1.2.3.4" });
  });

  it("falls back to the proxy host and bumps the port for jupyter runtypes", () => {
    expect(sshEndpoint(base)?.port).toBe(12345);
    expect(sshEndpoint({ ...base, image_runtype: "jupyter_proxy ssh_proxy" })?.port).toBe(12346);
  });

  it("returns undefined when nothing is published yet", () => {
    expect(sshEndpoint({ ...base, ssh_host: undefined, ssh_port: undefined })).toBeUndefined();
  });
});

describe("ports and jupyter", () => {
  it("maps container ports to public host:port", () => {
    const i: Instance = { ...base, public_ipaddr: "1.2.3.4", ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "41080" }] } };
    expect(publishedPorts(i)).toEqual({ "8080/tcp": "1.2.3.4:41080" });
    expect(jupyterUrl({ ...i, image_runtype: "jupyter_direc ssh_direc ssh_proxy", jupyter_token: "tok" })).toBe("https://1.2.3.4:41080/?token=tok");
  });
});

describe("summarizeInstance", () => {
  it("keeps the connection-relevant fields and drops undefined ones", () => {
    const s = compact(summarizeInstance({ ...base, extra_env: [["A", "1"]], label: null }, { includeEnv: true }));
    expect(s).toMatchObject({ id: 1, status: "running", gpu: "1x RTX 4090", price_per_hour: 0.5, env: { A: "1" } });
    expect("label" in s).toBe(false);
    expect(s.ssh?.command).toBe("ssh -p 12345 root@ssh5.vast.ai");
  });
});
