import { describe, expect, it } from "vitest";
import { buildOnstart, sanitizeScreenName } from "../src/onstart.js";

describe("buildOnstart", () => {
  it("returns undefined when nothing is given", () => {
    expect(buildOnstart({})).toBeUndefined();
    expect(buildOnstart({ screens: [{ command: "  " }] })).toBeUndefined();
  });

  it("passes a raw onstart through unchanged", () => {
    expect(buildOnstart({ onstart_cmd: "pip install x" })).toBe("pip install x");
  });

  it("installs screen+curl, makes /work and starts detached screens like the loader script", () => {
    const s = buildOnstart({ onstart_cmd: "echo prep", screens: [{ name: "load er!", command: "python3 run.py --n 1" }, { command: "sleep infinity" }] })!;
    const lines = s.split("\n");
    expect(lines[0]).toBe("export DEBIAN_FRONTEND=noninteractive");
    expect(lines).toContain("dpkg --configure -a || true");
    expect(lines).toContain("apt-get -f -y install || true");
    expect(lines.find((l) => l.startsWith("(apt-get update"))).toContain("'screen' 'curl'");
    expect(lines).toContain("mkdir -p '/work'");
    expect(lines).toContain("echo prep");
    expect(lines).toContain("screen -S load_er_ -dm bash -lc 'python3 run.py --n 1 >>/work/load_er_.log 2>&1'");
    expect(lines).toContain("screen -S job2 -dm bash -lc 'sleep infinity >>/work/job2.log 2>&1'");
  });

  it("quotes single quotes inside commands", () => {
    const s = buildOnstart({ screens: [{ command: "echo 'hi'" }] })!;
    expect(s).toContain(`bash -lc 'echo '\\''hi'\\'' >>/work/main.log 2>&1'`);
  });

  it("adds extra apt packages", () => {
    const s = buildOnstart({ apt_packages: ["jq"] })!;
    expect(s).toContain("apt-get install -y 'jq'");
    expect(s).not.toContain("screen");
  });

  it("sanitizes names", () => {
    expect(sanitizeScreenName("a b/c", "x")).toBe("a_b_c");
    expect(sanitizeScreenName("", "x")).toBe("x");
  });
});
