import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTokenBank } from "../tokenBank.js";

describe("applyTokenBank", () => {
  it("banks previous live when the counter resets", () => {
    process.env.TOKEN_BANK_PATH = join(mkdtempSync(join(tmpdir(), "tb-")), "bank.json");
    const a = applyTokenBank("nyx:8888", 1000);
    assert.equal(a.lifetime, 1000);
    const b = applyTokenBank("nyx:8888", 40);
    assert.equal(b.banked, 1000);
    assert.equal(b.live, 40);
    assert.equal(b.lifetime, 1040);
    const c = applyTokenBank("nyx:8888", 50);
    assert.equal(c.lifetime, 1050);
  });
});
