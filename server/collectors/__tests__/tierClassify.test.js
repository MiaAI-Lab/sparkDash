import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyTier, isWeightFile, stripWeightExt } from "../SystemCollector.js";

test("classifyTier: root NVMe mount is hot", () => {
  assert.equal(classifyTier("nvme0n1p2", "/", "ext4"), "hot");
  assert.equal(classifyTier("nvme0n1p2", "/", ""), "hot");
});

test("classifyTier: NAS cifs/nfs mount is cold", () => {
  assert.equal(classifyTier("//192.168.68.58/modelshelf", "/mnt/modelshelf", "cifs"), "cold");
  assert.equal(classifyTier("nfs.example:/data", "/mnt/models", "nfs4"), "cold");
  assert.equal(classifyTier("somedev", "/media/hot4tb", "ext4"), "cold");
  assert.equal(classifyTier("somedev", "/Volumes/T5", "exfat"), "cold");
});

test("classifyTier: other real local mounts are warm", () => {
  assert.equal(classifyTier("sdb1", "/data/usb", "ext4"), "warm");
  assert.equal(classifyTier("xdpu0", "/mnt/xdp", "xfs"), "cold"); // prefix override
});

test("classifyTier: tierPaths override wins", () => {
  const tierPaths = { cold: ["/mnt/models"] };
  assert.equal(classifyTier("nvme0n1p2", "/", "ext4", tierPaths), "hot");
  assert.equal(classifyTier("nvme0n1p2", "/mnt/models", "ext4", tierPaths), "cold");
  assert.equal(classifyTier("somedev", "/mnt/models/lora", "ext4", tierPaths), "cold");
});

test("classifyTier: empty mount/device defaults to warm", () => {
  assert.equal(classifyTier("", ""), "warm");
  assert.equal(classifyTier("sdb1", ""), "warm");
});

test("isWeightFile: recognizes weight extensions, case-insensitive, rejects others", () => {
  assert.equal(isWeightFile("model.safetensors"), true);
  assert.equal(isWeightFile("model.gguf"), true);
  assert.equal(isWeightFile("model.bin"), true);
  assert.equal(isWeightFile("model.pt"), true);
  assert.equal(isWeightFile("model.GGUF"), true);
  assert.equal(isWeightFile("README.md"), false);
  assert.equal(isWeightFile("config.json"), false);
  assert.equal(isWeightFile("tokenizer"), false);
});

test("stripWeightExt: removes extension and keeps the stem", () => {
  assert.equal(stripWeightExt("llama-3.gguf"), "llama-3");
  assert.equal(stripWeightExt("model.safetensors"), "model");
  assert.equal(stripWeightExt("noext"), "noext");
});
