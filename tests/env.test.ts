import { describe, expect, it } from "vitest";
import { buildEnv, normalizePort, parseDockerOptions, smartSplit } from "../src/env.js";

describe("parseDockerOptions (port of vast.py parse_env)", () => {
  it("matches the vast.py doc example", () => {
    expect(parseDockerOptions("-e TYZ=BM3828 -e BOB=UTC -p 10831:22 -p 8080:8080")).toEqual({
      TYZ: "BM3828",
      BOB: "UTC",
      "-p 10831:22": "1",
      "-p 8080:8080": "1",
    });
  });

  it("keeps '=' inside values and strips quotes", () => {
    expect(parseDockerOptions(`-e A='x=y' -h billybob -p 8081:8081/udp`)).toEqual({ A: "x=y", "-h": "billybob", "-p 8081:8081/udp": "1" });
  });

  it("smartSplit respects quotes", () => {
    expect(smartSplit(`-e "A=hello world" -p 1:1`)).toEqual(["-e", "A=hello world", "-p", "1:1"]);
  });
});

describe("buildEnv", () => {
  it("builds the flat env dict from structured input", () => {
    expect(buildEnv({ env: { HF_TOKEN: "hf_x", N: 3 }, ports: [8080, "8081:8081/udp", "9000/tcp"], hostname: "box" })).toEqual({
      HF_TOKEN: "hf_x",
      N: "3",
      "-p 8080:8080": "1",
      "-p 8081:8081/udp": "1",
      "-p 9000:9000/tcp": "1",
      "-h": "box",
    });
  });

  it("rejects bad ports and env names", () => {
    expect(() => normalizePort("abc")).toThrow();
    expect(() => buildEnv({ env: { "BAD-NAME": "1" } })).toThrow();
  });
});
