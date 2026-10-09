import { describe, expect, it } from "vitest";
import { canAdvance, parsePorts, rolePatch, slugifyId, validateConnect, validateRole, type AddSparkDraft } from "./addSparkSteps";

const base: AddSparkDraft = {
  name: "",
  kind: "spark",
  lanIp: "",
  cx7Ip: "",
  isLocal: false,
  llmPorts: [8888],
  ssh: { host: "", user: "zurih", auth: "key", port: 22 },
};

describe("add spark steps", () => {
  it("requires a LAN IP for remote hosts only", () => {
    expect(validateConnect(base)).toMatch(/LAN IP/);
    expect(validateConnect({ ...base, lanIp: "10.0.0.2" })).toBeNull();
    expect(validateConnect({ ...base, isLocal: true })).toBeNull();
  });

  it("requires a password for password auth", () => {
    const cfg = { ...base, lanIp: "10.0.0.2", ssh: { ...base.ssh, auth: "pass" as const } };
    expect(validateConnect(cfg)).toMatch(/Password/);
    expect(validateConnect({ ...cfg, ssh: { ...cfg.ssh, password: "x" } })).toBeNull();
    // local hosts never use SSH
    expect(validateConnect({ ...cfg, isLocal: true })).toBeNull();
  });

  it("requires a name on the role step", () => {
    expect(validateRole(base)).not.toBeNull();
    expect(validateRole({ ...base, name: "  " })).not.toBeNull();
    expect(validateRole({ ...base, name: "a" })).toBeNull();
  });

  it("gates each step", () => {
    const ok = { ...base, lanIp: "10.0.0.2", name: "Lab" };
    expect(canAdvance(0, base)).toBe(false);
    expect(canAdvance(0, ok)).toBe(true);
    expect(canAdvance(1, { ...ok, name: "" })).toBe(false);
    expect(canAdvance(2, ok)).toBe(true);
    expect(canAdvance(2, { ...ok, lanIp: "" })).toBe(false);
  });

  it("keeps worker role consistent", () => {
    expect(rolePatch("worker")).toEqual({ role: "worker", workerNode: true, llmMonitoring: false });
    expect(rolePatch("head")).toEqual({ role: "head", workerNode: false, llmMonitoring: true });
  });

  it("parses ports and ids", () => {
    expect(parsePorts("8888, 8000,abc, 70000, 0")).toEqual([8888, 8000]);
    expect(slugifyId("My Spark!")).toBe("my-spark-");
    expect(slugifyId("", 5)).toBe("spark-5");
  });
});
