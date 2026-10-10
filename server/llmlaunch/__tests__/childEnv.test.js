import { test } from "node:test";
import { strict as assert } from "node:assert";
import { scrubbedChildEnv } from "../childEnv.js";

test("a launcher script does not inherit the dashboard's port, token or host paths", () => {
  const env = scrubbedChildEnv({
    PATH: "/usr/bin",
    HOME: "/root",
    CUDA_VISIBLE_DEVICES: "0",
    PORT: "5555",
    LLM_PORT: "8888",
    BIND_HOST: "0.0.0.0",
    NODE_ENV: "production",
    SPARKDASH_TOKEN: "secret",
    SPARKDASH_ALLOWED_HOSTS: "x",
    DASHBOARD_TOKEN: "legacy",
    POLL_INTERVAL_GPU: "2000",
    HOST_ROOT_PATH: "/host/root",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/root", CUDA_VISIBLE_DEVICES: "0" });
});
