import test from "node:test";
import assert from "node:assert/strict";
import { sshCommandSpec } from "../ssh.js";

test("a unit's SSH key file overrides the global identity without replacing it", () => {
  const previous = process.env.SSH_IDENTITY_FILE;
  process.env.SSH_IDENTITY_FILE = "/root/.ssh/id_ed25519";
  try {
    const spec = sshCommandSpec(
      {
        id: "luffy-1",
        ssh: { host: "192.0.2.10", user: "devopsfortunato", auth: "key", identityFile: "/root/.ssh/sparkdash_pi" },
      },
      { multiplex: false }
    );
    const at = spec.args.indexOf("-i");
    assert.ok(at > 0);
    assert.equal(spec.args[at + 1], "/root/.ssh/sparkdash_pi");

    const other = sshCommandSpec(
      { id: "spark1", ssh: { host: "192.0.2.11", user: "devopsfortunato", auth: "key" } },
      { multiplex: false }
    );
    const otherAt = other.args.indexOf("-i");
    assert.equal(other.args[otherAt + 1], "/root/.ssh/id_ed25519");
  } finally {
    if (previous == null) delete process.env.SSH_IDENTITY_FILE;
    else process.env.SSH_IDENTITY_FILE = previous;
  }
});
