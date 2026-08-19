/**
 * dsh-occupancy-helper: provider-to-origin YAML parsing tests.
 * Run: node --test scripts/dsh-occupancy-helper/index.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseProviderBaseUrls, loadProviderOrigins } from "./index.js";

const SAMPLE_YAML = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: john-remote
    model: deepseek-v4-flash-dspark
- id: llm-deepseek
  disabled: true
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: tavily
- id: web-search-deepseek
  disabled: true
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      john-remote:
        displayName: "JohnOfUs DeepSeek V4 Flash (Remote)"
        apiKeyEnv: JOHN_API_KEY
        api: openai-completions
        baseURL: "http://100.120.26.16:8888/v1"
        compat:
          thinkingFormat: deepseek
        models:
          - id: deepseek-v4-flash-dspark
            name: "DeepSeek V4 Flash"
            contextWindow: 1048576
            maxTokens: 32768
      mama:
        displayName: "M.A.M.A server (Kalliope)"
        apiKeyEnv: MAMA_API_KEY
        api: openai-completions
        baseURL: "http://100.124.155.99:4000/v1"
        models:
          - id: "qwen3.6:35b-a3b"
            name: "Qwen 3.6 35B"
            contextWindow: 262144
            maxTokens: 32768
- insert:
    - id: web-search-tavily
      name: "@deepseek-ai/dsh-web-search-tavily"`;

test("parseProviderBaseUrls extracts provider→host:port from cordis.patch.yml", () => {
  const origins = new Map();
  parseProviderBaseUrls(SAMPLE_YAML, origins);
  assert.deepEqual(origins.get("john-remote"), { host: "100.120.26.16", port: 8888 });
  assert.deepEqual(origins.get("mama"), { host: "100.124.155.99", port: 4000 });
});

test("parseProviderBaseUrls handles empty text", () => {
  const origins = new Map();
  parseProviderBaseUrls("", origins);
  assert.equal(origins.size, 0);
});

test("parseProviderBaseUrls handles text without providers block", () => {
  const origins = new Map();
  parseProviderBaseUrls("- id: foo\n  config:\n    bar: baz", origins);
  assert.equal(origins.size, 0);
});

test("parseProviderBaseUrls handles https URLs with default port", () => {
  const yaml = `- id: llm
  config:
    providers:
      cloud:
        baseURL: "https://api.deepseek.com/v1"`;
  const origins = new Map();
  parseProviderBaseUrls(yaml, origins);
  assert.deepEqual(origins.get("cloud"), { host: "api.deepseek.com", port: 443 });
});

test("loadProviderOrigins returns empty map for missing directory", () => {
  const origins = loadProviderOrigins("/nonexistent/path/profiles");
  assert.equal(origins.size, 0);
});
