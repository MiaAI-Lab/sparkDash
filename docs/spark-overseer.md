# Spark Overseer

Opt-in, local security observations for instrumented model workloads on DGX Spark / GB10 units. It is engine-independent: use it with OpenAI-compatible model responses and with the tools an agent actually executes. No external AI reviewer, token budget, packet interception, privileged agent or additional npm dependency is required.

## What this does and does not establish

A model process is not the same thing as an agent executing tools. Spark Overseer distinguishes:

- **Response observed:** an instrumented OpenAI-compatible response passed through the observer.
- **Tool proposal:** a model returned tool arguments. The observer does not execute them.
- **Execution:** a command started/exited through the explicit command wrapper. Exit code 0 is not proof that a transfer succeeded, and a signal is not proof of unauthorized behavior.
- **Coverage gap:** response inspection was malformed, unsupported or over its bounded inspection budget.

The dashboard continuously reads configured, per-unit local journals even while no browser is open. Filtering, source coverage, resident-model telemetry, producer-supplied model labels and signal details are shown separately.

**This is not a firewall, sandbox, authorization system, country detector or malware verdict.** Uninstrumented processes and network connections are invisible. There is no passive packet capture, payload inspection, DNS history or automatic inference-to-process attribution. A same-user/root adversary can bypass or alter its own instrumentation. It is an observation aid, not independent containment. Use separately administered egress controls and protected logging when your threat model requires enforcement.

## Enable deliberately

The default is **disabled**, with no source polling, workload changes or model/network calls. Existing dashboard authentication protects the new read endpoint. If exposing SparkDash remotely, configure its normal authentication rather than treating an oversight page as access control.

1. Choose a private, writable journal directory on each instrumented unit. The supplied writers create journal files with mode 0600; they reject symlinks, multiply-linked files and group/world-writable files. They do not create directories or silently truncate/rotate files.
2. Instrument the selected execution/model-response paths below. The dashboard needs a **local read-only journal copy** for each configured registry unit. Supplying remote copies is an operator-managed transport, not new SSH access granted by this feature. Remote units are not automatically instrumented.
3. Create an operator-owned JSON file outside the repository, for example:

```json
{
  "sources": [
    { "sparkId": "unit-a", "journal": "/var/lib/spark-overseer/unit-a.ndjson" },
    { "sparkId": "unit-b", "journal": "/var/lib/spark-overseer/unit-b.ndjson" }
  ]
}
```

Use actual SparkDash registry IDs. Unknown units are explicitly unavailable, never attributed to another unit. At most 16 sources, one per unit, are accepted. Source paths are startup-only local configuration, never HTTP parameters or browser payloads.

```sh
SPARK_OVERSEER_ENABLED=1 \
SPARK_OVERSEER_CONFIG=/absolute/path/to/overseer-sources.json \
npm start
```

Open **Spark Overseer** in the workspace sidebar, or **Stats → Spark Overseer** on mobile. Configuration changes require the normal dashboard restart; this feature never restarts a model or agent.

## Observe real command execution

```sh
node scripts/overseer/observe-run.mjs \
  --journal /absolute/path/to/unit-a.ndjson \
  --model your-model-id \
  --allow-host docs.example \
  -- your-tool executable-argument
```

This starts the explicit command without an extra shell, inherits stdin/stdout/stderr, records a privacy-minimized start and exit observation, and preserves its exit status. If observation fails, it warns and runs the requested command: this is intentionally **not fail-closed enforcement**. Model labels and destination allowlists are operator/producer-supplied metadata, not approval receipts. Do not allow an untrusted agent to administer them if you need a separate trust boundary.

Place this wrapper at the actual tool-execution boundary, not around an entire long-lived agent: wrapping the outer agent does not introspect every descendant tool. Cancellation forwards termination to its owned process; this is not a process sandbox.

## Observe model-returned tool proposals

Pipe the response from an existing authorized local inference client through:

```sh
your-existing-inference-client | node scripts/overseer/observe-completion.mjs \
  --journal /absolute/path/to/unit-a.ndjson \
  --model your-model-id \
  --allow-host docs.example
```

The adapter passes stdout bytes through unchanged, including SSE. It inspects `choices[].message.tool_calls` and fragmented `choices[].delta.tool_calls`, not natural-language reasoning. OpenAI-style single-line `data:` JSON SSE frames are supported. Inspection is bounded to 2 MiB per response, 32 tool entries, and 64 KiB of assembled arguments per entry. Unsupported/malformed/truncated inspection produces a visible coverage-gap event, not an all-clear. It does not reroute requests or add model API credentials. Your downstream consumer still receives the original response; privacy minimization applies to the journal, not to the response you already requested.

## Deterministic signals

Rules inspect arguments locally, discard the raw text, and retain only enum signals, destination hints, a bounded model label, an argument fingerprint, timestamps, stage and exit code.

| Signal | Examples | Important qualification |
| --- | --- | --- |
| Upload | curl data/form/file flags, scp/sftp, selected POST syntax | Capability/syntax only; authorized uploads also flag |
| Credential access | `.env`, SSH key paths, AWS credential path, process environment | Not a complete sensitive-file classifier |
| Metadata access | canonicalized cloud metadata destinations | A proposal is not proof of a network request |
| Unlisted destination | URL hostname outside the exact configured allowlist | Allowlisting is not authorization to upload |
| Control change | selected firewall-flush/disable or observer-removal syntax | Heuristic text can appear in a harmless example |
| Encoded execution | selected base64 decoding syntax | Not general deobfuscation |
| Download/execute | curl/wget piped to selected shells | Not arbitrary shell/program analysis |

Matching uses the complete canonical hostname before privacy minimization. Subdomain suffix spoofing does not match an allowed hostname. URL usernames/passwords, paths, queries and subdomains are excluded from emitted hints. Displaying the last two hostname labels is only a presentation heuristic, **not a public-suffix parser, geolocation result or security boundary**. Alternate protocols, commands without literal URLs, deeply encoded strings and arbitrary SDK behavior can evade these rules. Inspect flags in the context of the task; do not equate a flag with guilt or an empty result with safety.

## Bounds and retention

The collector polls every five seconds, permits only one outstanding read per source, and marks read timeouts/failures unavailable without blocking other units. It reads at most the final 512 KiB / 1,000 complete records per journal. Pending final lines are retried. Rotation is supported; malformed records, capacity warnings and tail truncation remain visible. Up to 2,000 events from the last 24 hours are retained in memory; restart rebuilds from source tails and may omit older events. Original journals are the local record, not the browser.

The provided writers refuse to exceed 4 MiB per journal. Explicitly rotate journals under your own retention policy; the feature never deletes your files. A journal can be readable while its producer is disabled or bypassed. The source check timestamp proves a read, not a live heartbeat from every workload.

## Safe, reproducible qualification

```sh
node --test server/overseer/__tests__/*.test.js
npm run typecheck
npm run build
TZ=UTC npm test
```

The executable scenario test starts an ephemeral **loopback-only** HTTP sink/model fixture, creates a clearly synthetic `.env` canary, and exercises the actual shipped CLI adapters and collector. It proves a real harmless upload reaches only that sink and is flagged, an allowlisted benign read is quiet, and fragmented model tool proposals concerning metadata/credentials are flagged without executing them. The response bytes must remain identical. No actual credentials, third-party upload, firewall modification or model change occurs.

Additional tests cover privacy projection, enum injection, suffix spoofing, canonicalized metadata IPs, malformed/oversized responses, disabled mode, missing/corrupt/rotated/full/symlink journals, per-unit isolation, start/finish deduplication, expiry and stalled-source cancellation. Synthetic fixtures are **not** evidence that every real model or exfiltration technique will be detected. False positives and false negatives are expected; enforcement and a separately qualified AI reviewer are outside this feature.
