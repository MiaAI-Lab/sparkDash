/**
 * The decode bench sends a TensorFold-only sampler field, so the engine it believes it is
 * talking to has to be the engine on the port it is benching — not whichever entry happens to
 * sit at the same index, and never anything the caller supplied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { backendForPort } from "../DecodeBench.js";

test("the backend comes from the entry whose own port matches", () => {
  const llm = [
    { port: 8000, backend: "vllm" },
    { port: 8001, backend: "tensorfold" },
  ];
  assert.equal(backendForPort(llm, 8000), "vllm");
  assert.equal(backendForPort(llm, 8001), "tensorfold");
});

test("a snapshot offset from the configured port list does not hand back the wrong engine", () => {
  // Configured ports ["abc", 8000, 8001]; SparkMonitor._llmPorts() drops the invalid entry, so
  // the snapshot holds two entries while indexOf(8000) is 1. A positional read would call 8000
  // TensorFold and send it top_k, which a strict OpenAI-compatible server rejects.
  const llm = [
    { port: 8000, backend: "vllm" },
    { port: 8001, backend: "tensorfold" },
  ];
  assert.equal(backendForPort(llm, 8000), "vllm", "the port's own engine, not index 1's");
});

test("a port with no snapshot entry is unknown, not the first or the available one", () => {
  const llm = [
    { port: 8001, backend: "tensorfold", available: true },
    { port: 8002, backend: "vllm", available: true },
  ];
  // A port added since the last LLM poll: no entry describes it yet.
  assert.equal(backendForPort(llm, 8003), null);
  assert.equal(backendForPort([], 8001), null);
  assert.equal(backendForPort(undefined, 8001), null);
  assert.equal(backendForPort(null, 8001), null);
});

test("an entry with no backend, or no port, is not matched into a guess", () => {
  assert.equal(backendForPort([{ port: 8001 }], 8001), null);
  assert.equal(backendForPort([{ backend: "tensorfold" }], 8001), null);
  assert.equal(backendForPort([{ port: null, backend: "tensorfold" }], 8001), null);
});

test("the port is compared numerically, so a string port still matches", () => {
  assert.equal(backendForPort([{ port: "8001", backend: "tensorfold" }], 8001), "tensorfold");
  assert.equal(backendForPort([{ port: 8001, backend: "tensorfold" }], "8001"), "tensorfold");
});
