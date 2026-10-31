# Changelog

All notable changes to **sparkDash** are documented here.  
The README [Latest version changelog](./README.md#latest-version-changelog) summarises the latest releases; this file keeps the full history.

Format: version sections are listed newest first.

---

## [Unreleased]

### Fixed
- **TensorFold's prefill rate no longer counts prompt-cache hits as computed tokens, and its slots are not invented.** The `/metrics`-only prefill rate divided every prompt token, cache-restored ones included, by the time spent computing only the rest, so an agent lane with a 97 % hit rate read 26,000–125,000 tok/s against about 1,150 in the engine's own log. The cached counter the ledger already reads is now subtracted, giving a computed-only rate over a one-minute window of finished requests, with the cached share reported beside it; until a request has finished the split reads unknown rather than a measured zero. A build whose `/health` carries no stream count also no longer reports `slotsTotal: 1` on an engine running four streams — the running count is shown with no total claimed. Thanks to @naeemakhtar110 (#288).
- **The decode bench sends TensorFold's required `top_k`, and only to TensorFold.** TensorFold's native DeepSeek sampler can refuse a non-greedy request that carries no `top_k`, and the decode bench is the one bench that runs above temperature 0, so an otherwise healthy engine failed every stream. The bench now resolves the engine from the target port's own snapshot entry — never from the request body, a model name, or another port's engine — and sends and records `top_k: 20` for a detected TensorFold alone; other and unknown targets keep their existing requests, and the sampling label and the mixed-settings warning include it so histories taken with different sampling are not compared as equals. Thanks to @tfolkman (#303).
- **An engine that answers on the worker node is named instead of looking like a head with no model.** Workers are deliberately not LLM-polled and heads always are, so a recipe that starts rank 0 — and with it the OpenAI API — on the node configured as worker left the head's ports unanswered: the card offered to launch a model, the token totals stopped, and nothing pointed at the cause. While every configured port of an online head answers nothing, sparkDash now probes that head's paired workers on their configured ports once a minute; when one answers, the card says which worker answers, on which port and with which model, and asks whether to swap head and worker. It never changes the registry and never swaps roles, and it only finds an engine on a port reachable from the dashboard, so no hint is not evidence that nothing moved. Reported by @eleata, implemented by @markyu0401 (#298, #271).
- Recognize explicit mlx-serve identity before Ollama compatibility probes, and read its live counters without completion spikes.

### Added
- **English/Simplified Chinese for fleet reports.** Token totals, cost comparison, energy and monthly archives, temperature charts, activity filters/exports and kiosk presentation now use English and Simplified Chinese catalogs. Locale changes retain selected ranges, filters, graph geometry, pending clears and raw event details. Thanks to @oscarlius.
- **Kiosk: a wall display at `/kiosk`.** A full-screen page with no menus for a TV or spare monitor, opened from the sidebar or the command palette. The header carries fleet decode tok/s with its 30-minute trace, GPU power, the hottest GPU, queued requests, 24-hour energy and output tokens, units online and the clock. Below it each unit gets a card in large type with the Overview card's key figures, computed by the same code: name, role, the served model and context in a pill beside the name, and IP; the memory split into model and system with the space free (RAM too on a host with a discrete card, and a Mac shown as the unified pool it is); GPU use, temperature and power, CPU use and temperature, root-disk free space, live decode and prefill tok/s (a worker's head is named in its role badge), and a 30-minute trace of GPU and CPU use and generation and prefill tok/s from the metrics history. The Overview's alerts appear in a band at the bottom while any are active. Up to six units fit one screen in at least two rows (3 × 2 on a 16:9 wall), and each card sizes its type from its share of the screen, from a 720p TV to 4K; a larger fleet keeps that size and scrolls under the header a row at a time. The page holds its last good frame instead of dimming when an update fails, keeps the screen awake where the browser allows, hides an idle cursor, and **Esc** returns to the dashboard. `?fit=scroll`, `?cols=N` and `?theme=` choose the layout per screen. See the README's Kiosk section.
- **Quality bench: delete one saved run.** The history keeps the last 30 runs per unit, but there was no way to drop a single one: `DELETE …/quality-bench/:benchId` only cancels a run in flight, and `DELETE …/quality-bench` wipes every run of the unit (or of a port), so removing a cancelled run or one made with a misconfigured model meant editing `config/quality-bench-history.json` by hand. `DELETE /api/sparks/:id/llm/quality-bench/history/:benchId` now removes exactly one saved run and rewrites the file, keeping the other runs and the other ports' history. The Quality bench page's history table offers **Delete** per row and the dialog's footer offers **Delete run**, both after a confirmation. The route is separate from the cancel one on purpose: a reverse proxy that allows selected write routes can allow single-run deletes without also allowing "clear all history". Thanks to @WebQuotient (#299).
- **RoCE panel shows RDMA payload throughput.** The ↓/↑ rates were netdev byte counters, so a busy TP2 ring read a few KB/s while RDMA carried the traffic. The collector now also reads each port's own `port_rcv_data` / `port_xmit_data` counters (`/sys/class/infiniband/*/ports/1/counters/`), which count 4-byte words and are 64-bit on the CX7 ports, and diffs them on the same ~4.5 s fast cadence into `rdmaRxBps` / `rdmaTxBps`; a counter that goes backwards is treated as a reset and yields no rate rather than a negative one. The panel shows RDMA ↓/↑ next to the netdev row, and the note says which counters each row comes from. Thanks to @Nipale-ai (#294, closes #270).
- **Server and engine versions are visible.** Settings showed the version bundled into the page it was loaded from, so a `dist` build left over from an earlier release reported its own version as the server's. `GET /api/health` now also returns `version`, read from the running server's `package.json`, and Settings shows that value, falling back to the bundled one when health cannot be read. vLLM units also show their engine version: the probe reads `GET /version` (at most once per 10 minutes — it cannot change between polls), carries it as `engineVersion` in the LLM snapshot, and the LLM panel's backend chip reads `vLLM · :8888 · v0.11.0`. TensorFold units show theirs from the engine's own open `/health`, which names the release when the build carries one (`zig/src/server/identity.zig`, `status_routes.zig`'s `openHealth`), so `TensorFold · :8888 · v0.6.0`; a build that returns only `{"status": "ok"}` leaves the chip unchanged rather than inferring a version from a model name. An engine that does not answer `/version`, or answers with no usable string, leaves the chip as it was, and no backend other than vLLM and TensorFold is asked. Thanks to @bangell (#292, closes #173).
- **GPU temperature limits are configurable.** **Settings → GPU temperature alerts** (`healthTempWarnC`, `healthTempCriticalC`) sets the °C at which the Health finding for a hot GPU warns and turns critical, for units in enclosed or poorly ventilated rooms, or hardware with its own thermal policy. The defaults stay 85 and 90, so nothing changes until you edit them. Each value must be a number from 40 to 110 and the warning must be lower than critical; a save that breaks this is refused (`400` from `PUT /api/settings`), and an unusable `settings.json` falls back to 85/90. The finding text shows the configured limits, and Alert notifications follow them because they reuse the finding. A **Reset to Defaults** button restores 85 and 90. The change applies on the next sample, without a restart. Per-unit overrides are left for a later step. Thanks to @jammsen (#273, closes #233).
- **Locals engines are recognised and show live rates.** [Locals](https://github.com/Generated-Computers/Locals) (an MLX server for Apple silicon) reports `owned_by: "locals"` on `/v1/models` and also answers Ollama's `/api/tags`, so it read as Ollama with no throughput. It is now detected by `owned_by` before the Ollama probe, and the probe reads the engine's own `GET /stats`: decode tok/s from `tokens_out`, which moves with every decode step, and prefill tok/s from `prefill_tokens`. Locals counts a prompt when its prefill finishes, so a long prompt reads 0 until it lands; its rate is then taken over the engine's own `prefill_s`, not over the poll interval, which would overstate it. Cached tokens give the prefix-cache hit rate and the cached/uncached split (only from engines that report `prefill_tokens`, so the stock mlx engine does not skew it), and the running requests come from the engine's `active` list. The unit card shows the same engine tiles as vLLM, and benchmarks read the live token counter from `/stats`. **A poll whose stats cannot be read is now unmeasured, not zero.** When the endpoint answers `/v1/models` but `/stats` fails or has no counters, the snapshot carries `measurementValid: false` and a `measurementError`, the endpoint stays up, and the rates and running count are cleared. History and the client-side trends record a gap, Prometheus omits the rate and counter series and exports `sparkdash_llm_measurement_valid 0`, and the cards, the sidebar rail, the benchmark live rate and the fleet decode total show "—" with the reason. A poll also has no rate, and says so, when there is no earlier sample within 10 s to measure against (including the first poll after the endpoint was unreachable, which only re-seeds the counters), when the set of engines reporting counters changed, or when a counter went backwards because the engine restarted; counters are read strictly (a count is a finite, non-negative number, so `null` is not 0) and kept per engine. So tokens generated during an outage, or a restart, never show up as one interval's rate. Thanks to @ezoushen (#265).
- **Splash engines are recognised and show live rates.** [Splash](https://github.com/incoai/splash) (an MLX server for Apple silicon) reports `owned_by: "splash"` and serves its own `splash_*` Prometheus series, so it used to read as vLLM with 0 tok/s. It is now detected from `owned_by` (or from the series, for a lane first labelled vLLM). Decode and prefill tok/s are deltas of `splash_decode_output_tokens_total` and `splash_prefill_input_tokens_total`, so an idle engine reads 0; the engine's own `*_tokens_per_second` gauges are lifetime averages and are not used. Prefill counts the tokens actually computed, and prefix-cache hits (`splash_cache_reused_tokens_total`) are the cached share, so a cache hit does not inflate the prefill tile. The card also shows running (prefilling + decoding) and queued requests, TTFT and inter-token p95 (the engine reports milliseconds), and draft acceptance, with the vLLM engine tiles; benchmarks read the decoded-token counter. Like Locals, a scrape that fails, errors out or has no counters is an unmeasured poll (`measurementValid: false`): the previous rates, running and queued counts and latencies are cleared instead of staying on the card, and the first good scrape afterwards, like the first after an unreachable endpoint, only re-seeds the counters (reported as unmeasured, with that reason). A scrape that has counters but no scheduler gauges no longer keeps the previous running count. As for Locals, a scrape with no earlier sample within 10 s to measure against, or whose counters went backwards because the engine restarted, has no rate and says so, and a counter must be a finite, non-negative number. Thanks to @ezoushen (#266).
- **GPU clock cap for the whole fleet from Settings.** **Settings → GPU clock cap** shows the states a Spark can be in — **Full capacity** and **1800–2400 MHz** in 100 MHz steps — marks the one every unit is on, and applies a picked state to every Spark in turn when the dialog is saved (a pick on its own changes nothing). **Keep after reboot** installs a boot hook on each unit — the systemd service with `NOPASSWD: ALL`, an `@reboot` cron job where only the `nvidia-smi` commands are granted — and is disabled with the reason inline where no unit that answered can keep the cap; **Full capacity** clears the cap everywhere. The result names which hook each unit took, and a unit that fails or cannot take a cap at all is named instead of being counted as a success. API: `POST /api/sparks/gpu-clock-all`. Thanks to @danieljohnmorris (#218).
- **GPU clock cap: keep after reboot without `NOPASSWD: ALL`.** A passwordless rule for the two `nvidia-smi` commands — the shape sparkLimiter installs — is enough to cap, read back and unlock. **Keep after reboot** now uses the hook the unit can actually take: `spark-gpu-clock-limit.service` (the unit sparkLimiter installs) where sudo reaches a root shell and systemd runs, and otherwise an `@reboot` line in the SSH user's own crontab — tagged `# sparkdash-gpu-clock-cap` — that re-applies the cap with the same narrow rule. Only one hook is kept at a time; other crontab lines are never touched, and a crontab that cannot be read refuses the change instead of being rewritten. Where the unit offers neither hook the box is disabled with the reason inline, before the GPU is touched. Switching it off, or **Remove limit**, drops both hooks. Thanks to @danieljohnmorris (#218).
- **GPU clock cap: failures are no longer silent.** A fleet where every unit was skipped (no GPU) now answers `success: false` with `applied: 0` and the row reads **Nothing changed** instead of a green *Capped*. The `@reboot` job tries three times and, when none works, leaves a failure marker (and a `logger` line) that the unit dialog shows as "could not re-apply the cap" until the next Apply or Remove. The `sudo` path and home directory that go into that line must be plain absolute paths or the change is refused before the GPU is touched; the line is found by the tag at its end, so a user line that only mentions the tag is never rewritten. A cap applied without **Keep after reboot** now records itself before old boot hooks are removed, and a hook that cannot be removed is named in the error. The fleet route has a three-minute budget. The README's narrow sudoers rule is now anchored (`^-lgc 0,[0-9]+$`, or exact commands on older sudo) instead of `-lgc *`. Thanks to @danieljohnmorris (#218).
- **Language foundation.** Settings offers an immediate, browser-local English / 简体中文 switch. This first batch translates Settings only, uses English source catalogs and checks translation keys in `npm test`; other pages follow in separate changes. Thanks to @oscarlius (#226).
- **MQTT publishing.** **Settings → MQTT** (`mqttEnabled`, off by default) forwards what sparkDash already holds to your own broker as it changes: the activity feed to `PREFIX/events` (QoS 1, the same records the Activity page shows), retained per-unit availability `1`/`0` on `PREFIX/status/{unitId}` mirroring `sparkdash_up`, and per-unit readings on `PREFIX/metrics/{unitId}` — a JSON twin of the unit's Prometheus series (`{ts, up, uptime_seconds, gpu[], memory_available_bytes, cpu, ram, net[], disks[], llm[], collector_last_success_seconds}`) built by the same rules, so an unreachable unit publishes `{up: 0}` and values the collectors could not take are omitted rather than reported as zero. sparkDash's own availability is a retained `PREFIX/dashboard/status` with a last-will `0`, so a crashed dashboard is visible at the broker. Broker URL, username and topic prefix are set in the dialog; the password comes from the `SPARKDASH_MQTT_PASSWORD` environment variable so it never lands in the world-readable `settings.json`. Publishing is best-effort: while the broker is unreachable sparkDash retries every 5 s and drops messages instead of queueing them, and nothing on the publish path can block a poll loop. See the README's MQTT section. Thanks to @mvandergrift (#248).
- **Harness sessions on each LLM card.** One occupancy helper per machine lists OpenClaw, OpenCode and oh-my-pi over ACP metadata (`initialize` and `session/list` only) and keeps private read-only adapters for Hermes and DeepSeek Harness. The dashboard polls that helper's cache, routes sessions onto a Spark and port, and never treats ACP age as Generating or Stalled. Settings has a finite session age (1 hour to 14 days, default 12 hours). The helper refuses an all-interface bind, requires a bearer token off loopback, and the dashboard refuses userinfo, redirects, and DNS answers outside the allowlist. A helper that rejects the token is shown as a helper error, so it does not open the dashboard access-token dialog. Thanks to @kesslerio (#208).

### Changed
- **Quality bench: cancelling a run that already finished is refused.** `DELETE …/quality-bench/:benchId` answered `200` with the finished run's own record, so a request that changed nothing looked like a successful cancel. It now answers `409` and points at the history delete route; the dialog only offers **Cancel** while the run is in flight, so no UI path relied on the old answer.
- **Multi-GPU hosts show each card on the Overview.** A host with two or more GPUs (for example two RTX PRO 6000) showed a single GPU bar: the busiest card's usage, the hottest card's temperature and the VRAM of all cards summed, so a model split unevenly across the cards, or an idle card, could not be seen. The unit card now shows one VRAM bar per GPU (**GPU 0 VRAM**, **GPU 1 VRAM**) with its load, temperature and power on the line under it; a card at 80 °C or thermally throttled has that line in the warning colour. The combined VRAM, GPU, GPU temp and GPU power rows are not shown on these hosts. Units with one GPU look the same as before.
- **Decode bench: thinking on/off for every type.** The Thinking choice was offered only for Prose; Structured, Code and JSON always ran with thinking off. It is now available for all four types and defaults to on, as for Prose. Reasoning tokens count toward decode tok/s; with a small max-tokens budget a thinking run may end before the answer itself starts. API callers that leave out `thinking` now get thinking on for every type.
- **Decode bench: temperature is called out when comparing runs.** Since v2.70.0 the decode bench defaults to temperature 0.7 with thinking on; earlier versions always ran at temperature 0 with thinking off. On servers that use speculative decoding, temperature above 0 can be several times slower (GLM-5.3-Flash-EXL3: about 87 tok/s at temp 0, about 27 at 0.7, with or without thinking), so a new run could look like a regression against an old one. The temperature field now says how the old runs were made and to set 0 to compare with them; each history row shows its temperature and thinking setting (runs from before 2.70 show `temp 0 · thinking off`); and the history card warns when its runs used different settings.
- **History panel sits in the hardware column.** On wide screens the unit page's History panel (Settings → Metrics history) now closes the left column, right under GPU, memory, CPU and Models, instead of starting below both columns, which left a large empty area under the hardware panels whenever the right column (LLM, storage, network) was taller. Its charts follow the panel's own width: two per row from 560 px, three from 900 px. Below 1280 px, where the columns stack, it stays last.

### Fixed
- **A Mac's unified memory is split into the GPU's share and the rest.** macmon reports only RAM as a whole, so a Mac's unified memory read as all "System" (GPU 0) and its VRAM as everything in use. The same SSH call now also reads the GPU driver's "In use system memory" from `ioreg` (summed over accelerators), so `unifiedMemory.gpuUsed` and `gpu.vram.used` carry the GPU's share, as on a Spark, and the rest is `cpuUsed`; headroom stays what the whole system has free. Without that figure the pool is reported as before. **A Mac host is also treated as unified memory** by the memory breakdown, the Overview card and the History panel (label, headroom thresholds), instead of as a discrete card: before, its free memory was shown as total minus GPU use.
- **The dashboard survives a boot where Tailscale comes up late.** The container restarts unconditionally, so after a reboot the server routinely tried to bind the unit's Tailscale address before `tailscale0` had it, failed with `EADDRNOTAVAIL`, and exited — and under `node --watch` an exit parks the process until a file changes, so the dashboard stayed dead forever and only a manual container restart revived it. A transient bind failure is now retried every 5 s for up to ~2 minutes with the reason in the log; every other bind error (port in use, bad address) still ends the process as a real misconfiguration. The retry policy is a pure, unit-tested decision in `server/listenRetry.js`. Found on a DGX Spark that booted faster than its mesh interface. Thanks to @SovereignSunman.
- **Token totals no longer count prompt an engine never measured as computed prefill.** When an engine publishes no cached-prompt counter (or gains one part way through, after an engine update), every prompt token it read was shown as **computed prefill**, and a range that mixed reported and unreported traffic diluted the hit rate with tokens nobody measured: a lane at 98 % cache hits read as 2.3 B computed tokens and a 1.5 % all-time hit rate. The ledger now counts `unreportedPromptTokens` (prompt credited by a sample with no cached delta) on lifetime rows and day/hour buckets, and the Token totals page shows that part as its own **Prompt, cache not reported** stack, tile figure and CSV column (`unreported_prompt_tokens`); the Overview **LLM token totals** card and each Spark's **Total tokens by model** count it out of **Prefill** too (a grey **Not reported** segment on the card). Computed = prompt − cached − not reported, and the hit rate covers only the prompt whose split was measured. Rows written before the count take it once at load: a bucket from its `cacheReported` flag, a lifetime row from its retained unreported days (a lower bound when older days were pruned).
- **GPU holders are named by program, not by their whole command line.** nvidia-smi reports some desktop GPU clients, such as a browser's GPU process, by their full command line, so on a desktop unit the Overview **GPU is in use** card filled with Brave's flags and handles. The card and the Spark page's GPU process table now show the program name (`brave (804 MB), ptyxis (150 MB)`); the table's tooltip keeps the full name. Compute-app memory and GPU UUID are now read from the end of each nvidia-smi line, so a comma inside a command line no longer shifts them and misreports that process's memory.
- **`.env` is read before the modules that consume it.** `server/index.js` called `dotenv.config()` after its import list, but ESM evaluates every imported module first, and `config.js` and `settings.js` read `process.env` at module scope. So a path set in `.env` — `SETTINGS_JSON_PATH`, `SPARKS_JSON_PATH` and the other config paths — was ignored and the built-in `config/` default used instead. `.env` is now loaded first (`import "dotenv/config"`), and a variable already set in the real environment still wins over the file. Thanks to @SpaceshipCreative (#242).
- **Backend detection probes Ollama once, not twice.** `_classifyOpenAIBackend` asked `/api/tags` twice in a row on every engine whose `owned_by` does not name a backend, so a non-Ollama engine logged two 404s a minute where the detection order added for #282 intended one. Detection now asks once per pass; the classification result is unchanged (#293).
- **Overview keeps GPU evidence when launcher discovery fails, and no longer asserts that a head has no model.** Two separate states were presented as facts they had not established. A unit whose launcher list could not be read showed only **Models unavailable**, discarding the GPU and process activity the collector had supplied, because the missing launcher list was checked before the activity; that activity is now shown next to it, with no cause claimed for it. And a worker whose online head had no answering inference probe read **No model loaded on the head** — the same probe state a cold-starting head, a head switching model and a head with no watched LLM port all produce, so residency was never established. The card now says the head's inference API is not ready yet, or that no LLM port is watched on it, and an offline head still reads **Head is offline**. Reported by @smkzw (#279).
- **A failed PowerShell command on a Windows unit says what went wrong.** With stderr redirected — which is how every command sparkDash runs over SSH arrives — PowerShell serialises its error stream instead of writing plain text, so a Windows unit's panel showed `SSH to <host>:22 failed: #< CLIXML` and nothing else. The error and warning streams are now decoded out of that envelope (`_xNNNN_` escapes and XML entities included) and shown as the message, capped at 300 characters, and an access-denied error adds that the account sparkDash signs in as may not be entitled to read the WMI/CIM classes the collector queries, which is the usual cause and is not visible in the message itself. Plain stderr on every platform keeps its existing handling. Reported by @mapfde (#280).
- **TensorFold builds whose prompt cache comes from a recipe patch report their cached prompt tokens.** The collector read `tensorfold:prompt_tokens_cached_total` and fell back to `tensorfold:prefix_cache_hits_total`, both of which are upstream (ashhart/TensorFold) names. A build that branched before upstream published them and gets its prompt-cache tier from a recipe patch publishes `tensorfold:prompt_cache_cached_tokens` instead, so no cached total was ever recorded: the ledger wrote `cachedTokens: 0` with `cacheReported: false` for every hour and day, Token totals showed the cache as unknown, and Cost compare priced every prompt token at the full input rate (a reported fleet with 97 % cache hits read $180 instead of about $11 for a week). All three names are now read in that precedence order, with the existing clamp to the same scrape's prompt total. **Cost compare also no longer presents an unreported cache as a measured zero:** where the engine published no cached-prompt counter the tiles say so instead of "0 of them cached" and "no cache discount published", which read as a measured cache miss. Reported by @lastingchild (#281).
- **Engines that name themselves are no longer probed for LM Studio and Ollama every minute.** Detection re-runs every 60 s and asked LM Studio's `/api/v0/models` (then Ollama's `/api/tags`) before reading `/v1/models` `owned_by`, so a Locals, Splash or TensorFold server logged a 404 a minute — over 5,000 in four days on one Locals lane, which also counts them in its `/stats` `errors`. An `owned_by` that is exactly an engine's own name (`locals`, `splash`, `tensorfold`, `ds4`, `sglang`, `exl3`, `q27`, `freetoken`, `radiance`) now classifies the server from the card alone. Partial matches still wait for the LM Studio and Ollama probes, because Ollama reports a model's namespace as `owned_by` (a namespace such as `splashai` stays Ollama). Thanks to @ezoushen (#283, fixes #282).
- **The helper-token load line is logged once, not on every poll.** The occupancy poller reloads the encrypted helper tokens each tick, which repeated "Loaded N helper token(s)" in the server log every 15 s; it now logs only when the count changes. Found in an independent post-merge review of #208.
- **Launcher output follows on macOS again.** Start and Stop probe whether `tail` supports `--pid` and otherwise fall back to a short timed shutdown of the follower, so BSD/macOS `tail` no longer ends the job silently with no output or exit marker. Found in an independent post-merge review of #218 and #264.
- **MQTT metrics no longer report an unmeasured LLM as idle.** When a Locals or Splash endpoint answers but its stats cannot be read, the `PREFIX/metrics/{unitId}` entry carries `measurement_valid: 0` and omits rates and counters, like the Prometheus export. Found in an independent post-merge review of #265 and #266.
- **GPU clock cap: Debian cron accepts the reboot hook.** Shortened the generated command below cron's command-field limit while preserving lock serialization, stale-job checks, retries and failure reporting. Sandbox installs now enforce that limit.
- **Fleet GPU clock: partial failures no longer claim nothing changed.** When no unit completes the requested operation, the result warns that changes may already have applied; the requested state stays pending for retry.
- **Model launcher completion preserves final output.** Start and live Output wait for the log follower to drain after the script's process group exits instead of killing it after a fixed delay. This prevents missing final lines in the job API and retains the script's actual exit code, including when its output resembles the exit marker. A delayed-follower regression covers the last unterminated UTF-8 line.
- **Persistence-only fleet GPU changes are saved.** Changing Keep after reboot at the current frequency compares the requested state with each unit's installed hooks, including missing, disabled, failed, duplicate and differently configured hooks. A checkbox-only change uses a known shared frequency; opening Settings alone never queues a GPU operation, and failed Saves remain retryable before other settings are stored.
- **GPU clock operations and reboot jobs no longer race.** Apply, Remove and each reboot attempt share a per-user util-linux `flock`; token checks, clock mutations and marker updates are serialized, so a completed reset or newer Apply cannot be undone by an older job. Missing locking support refuses changes before hardware or hooks are touched.
- **GPU clock failures preserve truthful state.** Failed service-file removal restores both the requested live cap and its marker, reporting restoration failures explicitly. Unreadable crontabs now fail status rather than hiding installed hooks. Cron persistence applies through `sudo -k -n` so a typed password or cached authentication cannot falsely promise a working boot-time cap.
- **GPU clock regression fixtures cannot modify caller state.** Every generated-shell subprocess uses sandbox HOME and PATH, including manual commands and password-mode tests, protecting the runner's own crontab and cap marker.
- **GPU Save failures remain actionable.** A failed settings write after a GPU-only change can be retried without applying the hardware again. NVIDIA command failures on the cron path retain their clock-error category rather than being misreported as sudo authorization failures.
- **Turning off Keep after reboot preserves the displayed GPU cap.** Stopping the previous systemd service resets the clocks and deletes its cap marker. The non-persistent apply now restores the marker after re-applying the requested cap, so status still reports the live cap after the service is removed.
- **GPU clock changes refuse inaccessible old markers before changing hardware.** After sudo permissions are narrowed, an old root-owned marker can no longer be cleaned up. Apply and Remove now check that before touching clocks or boot hooks, rather than changing the hardware and leaving status showing a stale cap.
- **Failed fleet clock changes remain retryable.** A live-cap refresh matching the selected value no longer clears an unsuccessful boot-hook operation. Settings Save retries the outstanding change, preserving the requested Keep after reboot option; unsupported units are no longer counted as unreadable.
- **Boot-hook transitions preserve clock status and user intent.** Switching from a user marker to the systemd marker clears the superseded copy. An installed hook can be unticked even when its daemon is unavailable, and Full capacity still removes stranded hooks on already-unlocked GPUs. Selecting a shared cap remains actionable when another unit could not be read. Delayed reboot jobs check their install token before attempting the cap or writing markers, so removing or replacing a sleeping job invalidates it.
- **TensorFold cached prompt totals** now read the dedicated Prometheus cache counter, falling back to prefix-cache hits and clamping to the same scrape's prompt total. Thanks to @eleata (#272).
- **Contributor onboarding links resolve again.** AGENTS.md and CODEBASE.md are tracked rather than ignored, with current architecture, conventions and test commands, plus an onboarding-link regression. Reported by @eXsoR65 (#256).
- **RoCE explains its traffic-counter scope and cumulative pause totals**, so netdev rates are not mistaken for RDMA payload throughput. Reported by @Nipale-ai (#270); the dedicated RDMA throughput counters are added above.
- **TensorFold per-stream decode and effective prefill rates** use completion-window counters with noise guards and a bounded prefill hold. Effective rates include cache credit and have no GB10-specific upper cap. Thanks to @EagleClaw89 (#252).
- **Remote probes survive unmatched patterns under zsh.** CPU, storage, network, Intel GPU, RoCE and model-file enumeration use scoped, sorted find calls; shell-specific fixtures skip when zsh is absent. Thanks to @EugeneClaw (#257, fixes #255).
- **TensorFold Prometheus latency, cache and KV metrics** are populated when measured; incomplete or invalid latency histograms remain unavailable. Thanks to @eXsoR65 (#260).
- **macOS storage reports the APFS container and aggregate disk I/O.** Shared free space includes snapshots/other volume allocations, existing root-device toggles keep working, and missing optional I/O statistics do not discard capacity. Thanks to @eXsoR65 (#259).
- **Remote macOS network counters and rates** now come from BSD netstat and ifconfig, retaining valid counters when no IPv4 default route exists. Thanks to @eXsoR65 (#258).
- **Apple GPU identity uses the macmon SoC name**, with compatibility fallback for older macmon. Thanks to @eXsoR65 (#261).
- **Low-power health findings describe the observation** without diagnosing a stuck GPU or recommending a reset from utilisation and watts alone. The guidance asks readers to check workload progress and explains memory-bound decode. Reported by @Nipale-ai (#267).
- **Cost compare on a fresh install shows a neutral empty catalog** when fetching is disabled and no catalog exists, with setup guidance and Retry. Failed enabled fetches still report an error. Reported by @Nipale-ai (#269).
- **Cost compare requires a hosted-model choice.** Fresh browsers and removed catalog entries no longer silently price usage as the alphabetically first model. USD prices and context grouping use a consistent US locale. Reported by @Nipale-ai (#268).
- **Start and Stop work on macOS units.** The programs sparkDash runs over SSH to start or stop a registered model read `/proc`, call GNU `stat -c` and launch the script with `setsid`, and a Mac has none of the three. On a macOS unit every Start and Stop therefore ended at `refusing: <directory> is world-writable` (a mode that cannot be read counts as writable) and the model never started. The programs now read process facts from `/proc` where it exists and from `ps` elsewhere, fall back to BSD `stat -f`, and start the script as its own session leader with perl's `POSIX::setsid` when there is no `setsid` (macOS ships perl). `ps` start times are read with `LC_ALL=C`, so an SSH session in another language cannot make a live script look dead. The safety checks are unchanged and still fail closed: a script whose mode or owner cannot be read, or that is world-writable, is refused. Linux units run the same commands as before. Before the fix 14 of the 21 tests in `launcher.test.js` failed on a Mac; all pass now, on macOS and on Linux, and new tests cover the recorded start time, the log size cap and the refusals when `stat` is unusable or reports another owner. Thanks to @ezoushen (#264).

---

## [2.70.0] — 2026-10-22

### Added
- **Overview cards show the CPU temperature and CPU power.** On a Spark the CPU runs hotter than the GPU under the same load, but the cards only showed the GPU temperature. Two bars (CPU temp, CPU power) follow the GPU bars, with the same 75/80 °C colours and the sensor kind in the tooltip, and they are hidden when a unit reports no CPU sensor or power reading. Thanks to @deedaleet (#243)
- **Cost compare page.** A new page (`/cost`, sidebar, mobile Stats sheet) prices the fleet's token counters as if they had run on any hosted model: prefill at the input rate, completions at the output rate, and cached prefill at the provider's cache-read rate when one is published, so it also shows what the prefix cache saves. It uses the same time ranges and per-Spark/port/model counters as Token totals (All time uses the lifetime totals and the tracked-days average). Prices come from the community litellm catalog (`GET /api/model-prices`, ~2.9k chat models, searchable); the catalog is fetched from raw.githubusercontent.com only when `MODEL_PRICES_FETCH=1` (off by default; no redirects, 5 s timeout, 10 MB streamed cap), cached for 24 h, and the last good copy is kept in `config/model-prices.json` and served flagged stale while refreshes fail (failures are retried at most once a minute, with one request in flight). Prices load independently of usage, so a LAN without internet still shows usage. Thanks to @fish-not-phish (#231).
- **Overview card shows the engine's parallel slot count.** For engines that report requests (TensorFold, Strata) the LLM chip read `N running · M queued` and never said how many requests the engine decodes at once, so a unit on `--parallel 4` looked the same as one on 8. The chip now ends with `· 4 slots` (the same number the unit page's Slots tile uses), with a tooltip. Engines that report no capacity (vLLM) are unchanged. Thanks to @danieljohnmorris (#238).
- **`MAX_ACTIVE_BENCH_JOBS` raises the fleet benchmark cap.** At most two decode / prefill / quality benchmarks could run at once across all units, so a third unit was refused with 429 even when every unit was idle. The cap is now set with `MAX_ACTIVE_BENCH_JOBS` (default 2, clamped to 1–32, passed through by the compose files; see the README environment table), and the 429 message names it. Each unit still runs one benchmark at a time; queuing is not added. Asked in #235.
- **Radiance engines are recognised and show live rates.** Radiance (the native RDNA engine) reports `owned_by: "radiance"`, serves vLLM-format `/metrics` and only advances its token counters when a request finishes, so it used to read as vLLM with 0 tok/s mid-request. It now has its own backend label, skips the `/slots` probe, takes the KV pool from `radiance:kv_cache_max_tokens|bytes`, shows the vLLM engine tiles, and reads live decode / prefill rates from its `radiance:*_tokens_per_second` gauges while the matching engine-step counters advance (older builds keep the counter-derived rates). A 401 on `/metrics` keeps the label; the per-port API key is used as for other backends. Thanks to @abti (#232).
- **Strata decode and prefill monitoring.** Detects Strata before its llama.cpp-compatible slots and reads native JSON metrics. Mixed parallel slots keep decode and prefill activity visible; fallback decode means and last-reported prefill means are labelled explicitly. The sidebar shows active phases instead of misleading zero decode rates, model aliases retain the native context limit on detail and overview cards, and loaded engines show Active. Idle clears rates, and completed-request totals are never used as live TPS. Thanks to @oscarlius.
- **NVIDIA Flare (Helios) support: tok/s monitoring and benchmarks.** [flare-local-inference](https://github.com/NVIDIA/flare-local-inference) is detected from its `/v1/models` card (`owned_by` is the generic `local`; the `flare` object with `max_concurrency` and `prefill_chunk_size` is the signal), with a `/metrics` `flare_generated_tokens_total` fallback. Live decode tok/s comes from `flare_generated_tokens_total` deltas and prefill tok/s from `flare_prefill_tokens_total` (computed tokens only), with cached vs uncached prefill and the prefix-cache hit rate from `flare_cache_reused_tokens_total`. The panel also shows slots (`flare_active_requests`, card `max_concurrency`), the waiting queue, preemptions and KV pool use (`flare_total_kv_tokens` / `flare_free_kv_tokens`). Flare publishes no latency histograms, so TTFT/E2E/ITL tiles stay empty. Decode, prefill, quality and Tool Eval benches already speak OpenAI streaming and work unchanged; the bench rate cross-check reads the same generated-token counter. Flare's default port is 8000 (`flare run --port`); add it as an LLM port, and set an API key if it was started with `--api-key-file`.
- **Intel Arc GPUs.** Discrete GPUs bound to the Linux `xe` driver now show up next to NVIDIA cards, on the local node and on SSH nodes (`server/collectors/intelGpu.js`). Everything comes from sysfs/hwmon, no vendor tools, and on SSH nodes it rides the existing GPU round trip. Temperature, fan, clock and power limit are read directly; power is the energy-counter delta between polls and usage comes from the GT idle residency; VRAM total and use come from the root-only debugfs `vram_mm` file (plain read, then `sudo -n`) and fall back to the PCI BAR size, flagged with `vramSource: "pci-bar"`, when it cannot be read. Each entry in `gpu.gpus[]` now carries a `vendor` (`"nvidia"`, `"amd"` or `"intel"`); Intel cards use their own index range (2000 and up), like AMD (1000 and up), and NVIDIA output is otherwise unchanged. Integrated GPUs and `i915` are not read. Intel cards are shown (and counted in the power totals) but are not judged by the NVIDIA-tuned health thresholds yet: the GPU hot and low-power findings look at NVIDIA devices only, so an Intel card at full load or at its power cap never raises a false finding. The privileged debugfs VRAM read is opt-in: **Settings → Intel Arc VRAM via sudo** (`intelVramSudo`, off by default). While it is off, no `sudo` runs on any host and VRAM shows the PCI BAR size. When on, the read is cached per node for 45 seconds, so even with working passwordless `sudo -n` a host sees at most one sudo call per window (temperature, power and clocks still refresh every poll); a node where `sudo -n` cannot read the file is also remembered for 10 minutes and probed without sudo meanwhile, so neither case writes to the host's auth log on every poll. If the file is missing or shaped differently (other `tile*` directories are tried) the card falls back to the PCI BAR size. The local collector looks once for an `xe`-driver card in sysfs, without spawning anything, and skips the probe entirely on NVIDIA-only hosts (re-checked every 10 minutes so a hot-added card is found); SSH nodes need no extra step because the probe already rides the GPU round trip. A card that exposes no power cap reports its power limit as unavailable rather than zero, and a host with only such cards is still a successful GPU collection. The sudo read is one `sudo -n cat <exact path>` per debugfs file so a sudoers rule can pin exactly those files (the rule is in the README under Intel Arc GPUs); an installed but failing `nvidia-smi` next to an Intel card marks the GPU collection failed instead of hiding the NVIDIA cards; and a probe card header that is not a PCI address is ignored. Thanks to @BHCC2025 (#181).
- **Token totals: last 24 hours, 6 hours and 1 hour; one row per unit and model.** The range selectors on Overview and the unit's LLM panel gain **Last 6 hours** and **Last 1 hour**, and **Today** becomes a rolling **Last 24 hours** (hourly UTC buckets, so a range spans N-1 to N hours of real time; `GET /api/llm-token-totals?range=today|6h|1h`). The Overview tile is now **Tokens in last 24 hours**, and the Overview token table lists one row per unit and model instead of one row per model with a unit count; ports of the same model on one unit merge. Thanks to @yr75myjnqx-tech (#223).
- **Back to Overview on each unit page.** The unit page header has a small **← Overview** link above the unit name, for when the sidebar is collapsed or hidden on a narrow screen. Thanks to @yr75myjnqx-tech (#221).
- **Per-unit metrics history, 48 h and 30 days (opt-in, server side).** With the new `metricsHistory` setting on (`PUT /api/settings`; default off), the server keeps 1-minute buckets for 48 h and 15-minute buckets for 30 days per unit — GPU utilisation, temperature and power, memory used and headroom (MemAvailable of the GB10 unified pool, free VRAM on a discrete card), CPU utilisation and temperature, RAM on hosts, network rx/tx, and per LLM endpoint decode/prefill tok/s and KV fill — each bucket with avg, max (min for headroom) and a sample count. Offline units, failed or stale collections and missing sensors are gaps, never zeros; a reading counts as stale after 3 × the current poll interval (at least 15 s), so it follows Settings → Poll interval. `GET /api/sparks/:id/history?range=1h|6h|24h|7d|30d` serves them (at most ~500 points per series). It is the GPU history store generalised (`server/metrics/UnitHistory.js`): one store and one sampler for the 8 h GPU chart series, the Temps page's minute-resolution week (files and API unchanged) and these tiers. Tiers are written to `config/metrics-history.json` (`METRICS_HISTORY_JSON_PATH`, mode 0600, ~1 MB per unit at most), never while the setting is off, including buckets still pending when it is turned off.
- **History panel on the unit page.** With **Settings → Metrics history** on, each unit's page gets a full-width History panel under its columns: 1h / 6h / 24h / 7d / 30d chips (remembered per browser), small multiples for GPU, memory headroom (with the low / critical lines of the VRAM breakdown), CPU, RAM on hosts, network and each LLM endpoint, an average line with a shaded peak (low point for free memory), gaps where the unit was offline, and one crosshair shared by every chart (pointer, or arrow keys / Home / End / Escape). It polls every 30 s, only while it is on screen and the tab is visible; if a refresh fails, the last data stays up with a **Stale** note saying when it was fetched. Follow-up to #163.
- **Alert notifications to ntfy, Discord, Slack or a webhook (opt-in).** Nothing told you about a problem unless a dashboard was open. **Settings → Alert notifications → Configure…** now has the server notify you when a Health finding (GPU temperature, unified memory, Xid / OOM, RoCE, …) or an Overview exception (unit offline, thermal or hardware throttle, storage ≥ 90 %, LLM or tailnet unavailable) has held for its wait, and again once it has stayed clear as long — with no thresholds of its own, so a notification always matches the card chips and the strip. Each condition can be switched off or given its own wait; one message per channel per evaluation; optional reminders; the firing set survives a restart. Channel URLs are stored encrypted with the unit passwords and shown masked, must pass the same outbound-target policy as unit and LLM addresses (checked on save and again on every send, with the connection pinned to the checked address), redirects are never followed, a failed send is not retried, and a failure is reported as a status code or a fixed reason, never a server's answer. Slack text escapes `&`, `<` and `>`, so unit names cannot add mentions or links. Every notification sent or failed is on the Activity page (*Alert notifications*). While on, the exceptions strip lists the server's alerts with their real durations. Off by default: while off nothing is evaluated or sent, and the alert config and test routes answer 409. New endpoints: `GET /api/alerts`, `GET`/`PUT /api/alerts/config`, `POST /api/alerts/test`.
- **Tab badge and desktop notifications (opt-in, per browser).** A background tab gave no sign that anything was wrong. Two switches in Settings, both off by default and stored in this browser only: **Tab badge** puts the count in the title — `(2) sparkDash` — and a red (any critical) or amber dot on the icon; **Desktop notifications** shows one when an exception becomes active (not for what was already wrong when the page opened), asking for the browser's permission only when you turn it on. Both count every alert the Overview exceptions strip knows of — the same `deriveAlerts` with the temperature unit, or the server's alerts while alert notifications are on — even while *Show active fleet exceptions* is off and the strip shows throttling only. Conditions the browser derives must hold 30 s before they count and stay clear 30 s before they stop, so a flapping reading notifies once. On a plain-HTTP LAN address the desktop switch is disabled with a note (browsers allow notifications only on HTTPS or localhost).

### Changed
- **Decode bench: temperature 0.7 and thinking on by default, both selectable.** The decode benchmark used to run at temperature 0 with thinking off. The Decode benchmark dialog now has a **Thinking** choice (*With thinking*, the default, or *Without thinking*), shown for the **Prose** type only (structured, code and JSON always run with thinking off, enforced by the server too, so the answer fits the token budget), and a **Temperature** field (0 to 2, default 0.7; 0 is greedy). `POST /api/sparks/:id/llm/bench` takes `temperature` and `thinking`, the job config records them, and the result text and share card show them. Reasoning tokens count toward decode tok/s, as before for any model that streams them. Runs saved before this change have neither field and are shown as temp 0 · thinking off, so old and new results are not comparable.

### Fixed
- **An idle-looking Overview card names the process that holds the GPU, and "Start anyway" asks twice when memory is short.** When no LLM answered but the GPU was busy, the card said "Something is loading" even when nvidia-smi showed an unrelated server (one on a port that is not in the unit's LLM ports) holding the memory. It now says "GPU is in use", lists the top processes with their memory, and points to **+ Add LLM port**; "Something is loading" stays only when no process is named. When the free memory is under the unit's low-headroom threshold (8 GB unified, 2 GB discrete), **Start anyway…** first shows a warning and needs a second click. Thanks to @naeemakhtar110 (#253).
- **Cache hit rate is no longer a fake 0 % on engines that never publish a cached-token counter.** Token totals credit `cachedTokens` from the engine's cumulative counters, so a backend that reports the prefix-cache split only per response — TensorFold CUDA builds whose `/health` carries no `cached_tokens_total`, and any OpenAI-compatible engine that simply omits it — credited nothing, forever: the Token page's **Cache hit rate** tile read `0 %` / "The prefix cache saved nothing" and both tables showed `0 %` cached while the engine was in fact serving most of the prompt from its cache. The ledger now stores whether the split was measured at all (`cacheReported`, on each model row, UTC day and hour bucket, in `GET /api/llm-token-totals` and `/history`), rows written by earlier versions fall back to the endpoint's live counter and to the cached tokens they already hold, and the tile, the tables and the insight render `—` with "This engine does not report prefix-cache hits" instead of a zero that looks like a cache bug. A measured zero (prefix caching off) still reads `0 %`, matching the Overview and unit tables, which already blank an empty cached column. Thanks to @Vincebye (#245)
- **`docker compose up --build` no longer builds an arm64 image on other hosts.** Both compose files pinned `build.platforms: [linux/arm64]` but set no service `platform`, so on an amd64 machine Docker built the arm64 image, started it under emulation and printed `The requested image's platform (linux/arm64) does not match the detected host platform (linux/amd64/v3) and no specific platform was requested`. The pin is gone and Docker detects the host platform, so a Spark still builds and runs the arm64 image and an x86 host builds a native amd64 one. Both architectures stay supported: `docker-compose.multiarch.yml` builds `linux/arm64` + `linux/amd64` into one manifest list (what the release workflow publishes), and a service-level `platform: ${DOCKER_DEFAULT_PLATFORM:-}` makes single-architecture cross-builds pin the build and the container platform together, so `up` never warns about a mismatch. Reported in #246. Thanks to @Vincebye (#247)
- **The server exits when it cannot bind its port.** A port already in use was only logged and the process stayed up without serving, so systemd, launchd or a plain Docker `CMD` never restarted it. It now logs `cannot listen on <host>:<port>` and exits with status 1. Under the compose file's `node --watch` supervisor the container itself still stays up. Thanks to @SpaceshipCreative (#242).
- **Tok/s spike after an LLM endpoint came back.** The first successful poll after three failed ones reported the engine's lifetime token counters as one interval's rate, and that became the day's peak. That poll now only seeds the counters (one reading of 0, then normal). Thanks to @SpaceshipCreative (#242).
- **llama.cpp tok/s read 0 with overlapping slots.** A slot starting a new request counts down, and its negative delta cancelled the tokens another slot generated in the same interval. Deltas are now clamped per slot. Thanks to @SpaceshipCreative (#242).
- **No snapshot is serialised while no dashboard is connected.** Every unit's snapshot was turned into JSON every tick even with zero clients. Alerts are still evaluated every tick, and a connected dashboard still gets a snapshot every tick. Thanks to @SpaceshipCreative (#242).
- **TensorFold engines with a rich `/health` showed "queue unknown" though the queue is measurable.** The Python engine (GLM on two Sparks) publishes cumulative totals and streams in `/health` but no waiting count: its queue gauge lives on Prometheus `/metrics` alone (`tensorfold:requests_waiting`). sparkDash polled `/metrics` only when `/health` lacked the totals, so with a rich `/health` the gauge was never read and the LLM card read **queue unknown** (since 79be516; before it, a false "0 queued"). Such builds now poll `/metrics` queue-only: the waiting gauge applies while totals, rates, drafts, running and occupied slots stay `/health`'s, keeping #212's measured-vs-unavailable distinction. Verified live on a GLM pair: idle reads "0 queued", and 12×512-token requests against 6 lanes read "6 running · 6 queued" and drain back. A queue count the server reports itself in `/health` (`live.waiting`) is not overwritten from `/metrics`. Thanks to @mikegoltsov (#240, reported in #239 by @kohlmayer).
- **The decode benchmark no longer changes the task as streams are added.** Concurrent structured, prose and JSON streams got the shared prompt with a `(stream i/n)` suffix, so the fourth request read `(stream 4/4)` at ×4 and `(stream 4/5)` at ×5. GLM-5.3-Flash took `4/4` as "the last quarter": it started counting at 151 and drifted into prose, needed 129 decode rounds instead of 53, and the ×4 aggregate fell (143.6 tok/s against ~230 with the fix); it did this with that one request alone too (5/5 trials, 5/5 controls passed). Each stream now gets `Request ID: decode-N` before the shared prompt, which keeps prompts distinct for the prefix cache and stays the same as the stream count grows. C1 is unchanged and code prompts are unchanged. Thanks to @Medalink (#241).
- **Quality bench history and comparison cover every port on the unit.** The History list and the "Compare with" picker only showed runs from the LLM port selected for the next run, so results from models served on other ports could not be compared. They now default to **All ports** (each row and picker entry shows its port), and a History **Show** selector narrows the list to one port. The port still only chooses the endpoint of a new run. **Clear** now names its scope (**Clear all ports** / **Clear port N**) and clears exactly what the selector shows. API: `GET …/llm/quality-bench` takes an optional `historyPort` (a port or `all`); without it the list follows `port` as before. Reported in #237.
- **GPU history no longer rewrites its past on every poll.** The charts averaged samples into buckets measured from the moving left edge, so each new sample shifted every boundary and old peaks changed height and position. Buckets are now anchored to absolute time (completed buckets keep their value, only the live one moves), the first overlapping bucket is kept whole, and the plot is clipped to its area on the unit page and on the Temps page. Thanks to @havra (#230, reported in #229).
- **vLLM prefill no longer counts prefix-cache hits as prefill work.** `vllm:prompt_tokens_total` includes tokens served from the prefix cache, and the Prefill tile divided all of it by the TTFT delta, so a mostly cached agent prompt read as 100k+ tok/s (a 7.5K-token prompt that was ~99 % cached showed about 16,000 tok/s; the engine computed ~80 tokens). The prefill rate now uses only the computed share (prompt minus `vllm:prompt_tokens_cached_total`, or `vllm:prefix_cache_hits_total` on vLLM builds without it), and vLLM now fills the cached / uncached prefill rows and their daily history like SGLang and llama.cpp do. A counter reset after an engine restart reads 0 instead of a spike. Thanks to @jeff-defuser (#234).
- **A damaged secrets file is no longer overwritten.** If `config/sparks-secrets.json` exists but cannot be parsed, saving SSH passwords, LLM API keys or alert channel URLs now fails with a clear error and leaves the file alone, instead of rewriting it without the other sections. An alert channel URL that cannot be decrypted (for example after a key change) stays in the file while its channel is configured.
- **No phantom `Cap 0.1 GHz` chip on units without a clock cap.** With no cap marker the probe output is only the boot id, and a boot id that starts with digits (for example `139dcc9e-…`) was read as a cap of 139 MHz. The marker line's first token now has to be a whole number. Thanks to @yr75myjnqx-tech (#219).
- **Dialogs no longer close when a text selection ends outside them.** Dragging to select text in a field and releasing the mouse on the dark overlay used to close Add Spark, Settings and the other dialogs, losing what was typed. The overlay now closes only when the press also started on it (one shared `useOverlayClose` hook). Reported in #224.
- **TensorFold engines that report only through `/metrics` showed 0 tok/s.** Builds whose `/health` is just `{"status": "ok"}` (the `tensorfold-native` Zig engine) publish every counter on Prometheus `/metrics`. sparkDash copied the token totals from there but never turned them into a rate, so the Decode tile read 0 tok/s even mid-generation. Decode tok/s now comes from the poll-window diff of `generation_tokens_total` + `generation_tokens_running`: the total moves only when a request finishes, the running gauge counts the tokens of requests still decoding, so their sum grows while tokens are produced. A request finishing can show one short dip and spike, as the two counters are not updated in the same instant; the pair averages out. Prefill is unchanged, since `prompt_tokens_total` includes cached prefix tokens. From a contribution by @yrjo.
- **GPU history is saved without blocking the server.** The 8 h GPU history (`config/gpu-history.json`) and the Temps page's week (`config/gpu-history-long.json`) are now written asynchronously every 5 minutes, one unit per event-loop turn, instead of in one synchronous rewrite; shutdown still writes them synchronously. A unit whose id is `__proto__` no longer loses its history on save.

---

## [2.50.0] — 2026-10-15

### Added
- **Tool Eval: Show card.** A finished Tool Eval Bench result has a **Show card** button that renders it as a share image, the same kind the decode, prefill and quality benchmarks make: final score ring and rating, deployability and responsiveness, the pass / partial split, safety warnings when there are any, and a tile per category. The window offers **Copy image** (HTTPS or localhost), **Download PNG**, and right-click → Copy Image elsewhere. Failed scenarios are left off the card.
- **Tool Eval: comparison card.** Tick two runs in History and **Show comparison card** turns the comparison into an image: both scores and the change, metric tiles (deployability, responsiveness, scenarios passed, how many scenarios got better or worse), and every category with both bars and the change in points. It says when the two runs were not set up the same way.
- **GPU clock cap asks for the sudo password when the unit has no passwordless sudo.** The password is sent once to the unit's `sudo -S` over stdin, never stored or logged, and only accepted over https or from the machine itself; three wrong ones lock that account for five minutes.
- **GPU clock cap: run it on the Spark yourself.** Edit unit → GPU clock cap has a *Run it on the Spark yourself* panel that gives a command to paste into a terminal on the Spark. It uses plain `sudo`, so it asks for the password there, and prints the result in plain words. Use it when the dashboard has no passwordless sudo on a unit.
- **GPU clock cap from Edit unit.** Spark units get a **GPU clock cap** section (Linux Spark units only): cap the graphics clock with `nvidia-smi -lgc 0,MAX`, optionally **keep it after reboot** with a systemd service (`spark-gpu-clock-limit.service`, the unit sparkLimiter installs), or remove it again. It shows the cap in effect and the GPU maximum, and the value appears on the unit's card and GPU panel. Runs as root locally and through `sudo -n` over SSH, so the SSH user needs passwordless sudo; nothing changes without it. API: `GET|PUT|DELETE /api/sparks/:id/gpu-clock`.

### Fixed

---

## [2.40.1] — 2026-10-14

### Added
- **GPU clock cap on each unit.** A GPU locked with `nvidia-smi -lgc` shows a `Cap 1.8 GHz` chip on the Overview card and `cap 1800 MHz` under the SM clock. NVML cannot read the lock back, so whatever sets it writes a one-line marker (`<MHz> [boot_id]`) to `/run/sparkdash/gpu-clock-cap` or `~/.config/sparkdash/gpu-clock-cap`; a marker from an earlier boot is ignored. Read-only: sparkDash changes no clocks. Thanks @danieljohnmorris (#213).
- **AMD GPU telemetry.** Units with an AMD GPU report utilisation, temperature, power and VRAM through `amd-smi` (found on `PATH`, `AMD_SMI_PATH` or the usual ROCm locations), alongside NVIDIA cards on the same host; values `amd-smi` does not report show as unavailable instead of 0. Tested by the author on a Radeon AI PRO R9700; on other AMD hardware it is covered by fixtures only. AMD cards use `gpu` label / history index 1000 + their amd-smi index. From a contribution by @abti (#198).
- **Overview cards list every loaded vLLM model.** Models served from private Docker containers (not reachable as a monitored LLM port) now appear on the unit's card, labelled **Loaded**. To find them sparkDash runs a read-only Python helper over SSH on the unit every 30 s: it asks `docker` for running vLLM containers and reads `/v1/models` on their private addresses. It runs only on remote Linux units with LLM monitoring on (never workers), reads at most 20 containers and 50 models, and a failed run keeps the previous list for about 90 s. Thanks to @bobatngs (#201).
- **Models panel: "Run both".** Starting a model while another launcher on the same unit is running now offers **Run both** next to **Stop it, then start**, so two models can share a unit without starting the second by hand. The start script can still refuse if memory is short. Thanks @ZackSample (#195).
- **Optional inference request activity card.** For shared inference deployments, an Overview card groups in-flight requests and recent completions by approved display labels from a gateway's sanitized JSON. Off by default and no requests are made until `SPARKDASH_INFERENCE_ACTIVITY_URL` and `SPARKDASH_INFERENCE_ACTIVITY_LABELS` are set in the server's environment; the URL must be an explicit loopback or RFC1918 IP literal, with no redirects, a 5 s timeout and a 64 KiB cap. Thanks @desy0305 (#196).
- **Published container image.** Release tags (`v*`) are built for arm64 and amd64 and pushed to `ghcr.io/miaai-lab/sparkdash`; `docker-compose.image.yml` runs it with the same mounts and environment as `docker-compose.yml`. Thanks @kelchm (#197).
- **Temps page.** A new nav page (sidebar, mobile Stats sheet and command palette) draws GPU temperature across the fleet over **the last 24 h** or **the last 7 days**, one graph per unit with a line per card on multi-GPU hosts (`/temps`). To serve it, the server now also keeps a minute-resolution GPU history for a week in its own file (`config/gpu-history-long.json`, env `GPU_HISTORY_LONG_JSON_PATH`) next to the dense 8-hour one, and `GET /api/sparks/:id/gpu-history` serves windows over 8 h from it, so the graphs are drawn from persisted history rather than an empty buffer after a refresh.

### Fixed
- **Mac units come online and report CPU, GPU and RAM.** Liveness read `/proc/uptime`, which macOS does not have, so a Mac never left offline; it now uses `sysctl kern.boottime`. With [macmon](https://github.com/vladkens/macmon) on the Mac (no sudo; `MACMON_PATH` if it is not in the usual places), one sample per cycle feeds CPU and GPU usage, temperatures, RAM and power. Without macmon a Mac is re-checked once a minute and logged once instead of failing on every poll. Thanks @jdudley (#211).
- **TensorFold Slots tile counts occupied lanes, not open requests.** The tile read `requests_running` (open generate calls, which include waiting work), so it could show `10 / 8`. It now sums the decoding, prefilling and paused lanes, and an unavailable queue reads "queue unknown" instead of "0 queued". Thanks @GO1984 (#212).
- **GPU and energy data on remote units whose login shell is zsh.** The `amd-smi` lookup used shell globs for versioned ROCm directories, and zsh aborts the whole probe on an unmatched glob, so NVIDIA data was dropped too on hosts without ROCm. The versioned directories are now found with `find`, and a test checks the resolver contains no unquoted glob. Thanks @mvandergrift (#210) and @s1nc3ju1y (#204).
- **Rootless Docker: host reads no longer fail silently.** When `nsenter` is denied (rootless Docker), the collector falls back to the container only on the permission path, logs it once and remembers it; kernel-error, NV_ERR and RoCE counters stay unknown instead of reading 0, network reads fall back only when the container shares the host's network namespace, and a timed-out command is not retried. Thanks @tfolkman (#140).
- **LLM panel no longer says "Idle · last served Xm ago" while a prompt is prefilling.** On TensorFold, which publishes token counters only when a request finishes, both rates read 0 during a prefill, so the Decode tile showed "Idle" next to the Prefill tile's "prefilling". The idle note is now hidden while a prefill is in flight. Reported by @solodddd (#202).
- **Disk read/write speed on remote units.** Only the unit sparkDash runs on measured it; every Linux unit reached over SSH and every Windows PC showed 0 B/s forever. Remote Linux units now read the block-device counters in the same SSH round trip as the disk usage, and Windows PCs read the per-drive performance counters, so the Storage panel shows live read and write speed (macOS units still show none). Two mounts on one physical disk no longer make the second read 0. Reported by a user ("disk I/O is not being reflected in real-time").

---

## [2.40.0] — 2026-10-11

### Added
- **LM Studio and Ollama are detected by their own endpoints** (`/api/v0/models`, `/api/tags`), so a server that answers 200 + JSON on every path (LM Studio) is no longer labelled SGLang or vLLM, and an identified backend is never downgraded. `/metrics` is no longer fetched from engines that never serve it. LLM panels are matched to their port instead of their position in the list, and the Add wizard, the "+ Add LLM port" panel and each LLM panel's settings have **LM Studio :1234 / Ollama :11434 / TensorFold :8888** presets that only fill in a port. From a contribution by @HassanEmam (#191).
- **Windows units with an AMD iGPU (Strix Halo)** show GPU utilisation and memory from Windows' GPU performance counters when `nvidia-smi` is not installed (an NVIDIA PC whose `nvidia-smi` fails still reports the failure). Model launchers now say plainly that they are not supported on Windows. From #191.
- **Every Overview panel can be hidden.** Settings now has switches for Recent activity and for each of the four tiles (Fleet decode, Fleet power, Memory in use, Tokens today), next to the existing Fleet energy and LLM token totals ones. The remaining tiles share the row, and a column with nothing left in it disappears. Hidden panels stay available from the sidebar pages. Suggested by a user.

### Fixed
- **Windows PCs: "keys work everywhere but here".** The setup docs now explain that for an administrator account `sshd` ignores `~/.ssh/authorized_keys` and reads `C:\ProgramData\ssh\administrators_authorized_keys`, which only Administrators and SYSTEM may write (with the `icacls` command), and a refused key on a Windows unit adds the same hint to the connection error. Suggested by a user.

---

## [2.32.0] — 2026-10-10

### Fixed
- **Sidebar reorder** — dropping a Spark after dragging it no longer also opens it. The drag library swallows the click that follows a drop before the app sees it, so the browser followed the link on its own; the default action is now cancelled for a moment after a drop
- **TensorFold prefill tok/s no longer reads 100k+.** The rate divided every prompt token by the time spent computing, but an agent that re-sends a growing conversation gets ~95% of those tokens from the prefix cache (a 56k-token turn computed 2.7k tokens in 1.1 s and showed 49k tok/s, on another turn 146k). The probe now uses computed (uncached) tokens, from `cached_tokens_total`, and holds the last real rate when a prompt was fully cached. Builds that do not report the cached total still use the whole prompt. Reported on a unit serving GLM-5.3-Flash.
- **An LLM that only SSH can reach is now monitored ("Something is loading" on a unit whose engine is up).** The live probe only tried the unit's own address, so an engine on a port that is not exposed (a unit behind a NAT that forwards just SSH, like a remote Spark on port 30022) showed "LLM server not reachable", and the Overview card guessed that a model was still loading because the GPU memory was in use. After two failed direct probes the monitor now opens an SSH forward to the unit's loopback and probes through it (a **via SSH** chip on the LLM panel says so), retries the direct path if the forward keeps failing, backs off between attempts (1 to 15 minutes) and never tunnels for a pinned `llmHost`, a local unit or a Windows PC. Reported for GLM-5.3-Flash on port 8093.
- **The installed iPhone app: header under the status bar, and the icon.** The app runs under the status bar (`viewport-fit=cover`), so the logo and the clock overlapped. The phone top bar now starts below the safe area (and respects the side insets in landscape), with a dark strip behind the status bar so the clock stays readable in the light themes. The home-screen icon was a dark square with a bare bolt; it is now the logo: the amber rounded square with the dark bolt (full-bleed for iOS and the maskable Android icons). iOS keeps the old icon until the app is removed from the home screen and added again.
- **Decode benchmark: "Live generation" no longer shows 0 tok/s.** The live figure in the dialog was the engine's own reading, which is 0 on engines whose counters only move when a request finishes (TensorFold and EXL3 `/health` totals), and missing for a Remote target. It is now measured from the benchmark's own streams (tokens received across all streams over the last ~2 s, once a second; nothing is shown until the first token, not a 0 during prefill) and falls back to the engine reading only when there are no streams yet. Reported on a unit serving GLM-5.3-Flash on port 8093.
- **Health findings no longer flap at a threshold.** A GPU hovering around 85 °C raised "running hot" and "back to normal" every minute and filled Activity with identical events. A finding now stays active for 90 s after its rule last raised it, so a reading that crosses a threshold back and forth produces one event and one "back to normal" when it has really settled. This applies to every health rule (temperature, memory, link speed, RoCE, concurrency).


---

## [2.31.0] — 2026-10-10

### Added
- **`/metrics` shows when each collector last succeeded.** `sparkdash_collector_last_success_timestamp_seconds{collector=…}` (gpu, cpu, ram, memory, network, storage, llm, roce) is the Unix time of the last poll that returned real data rather than a collector's zeroed defaults, so a stuck GPU poll can be caught even while SSH liveness still passes (`time() - …  > 60`). Domains that are not polled (storage polling off, LLM monitoring off) are not exported, so they never age into a false alert, and RoCE is stamped with the time of its own sample. Requested by a user.
- **RoCE / RDMA monitoring.** Spark units with RDMA devices get a **RoCE / RDMA** panel: link state and rate, MTU, RX/TX traffic, errors and drops, PFC priorities, QoS trust mode and DSCP map, pause settings, and the RDMA / ethtool counters with their change since the last sample. Read from sysfs, `ethtool` and `mlnx_qos` on each Spark, without root or switch integration (about every 5 s, the slower ethtool and QoS facts every 30 s; units without RDMA are re-checked every 10 minutes). Two new health findings: *a RoCE link went down* and *RoCE is dropping packets*. The panel is collapsed by default (a one-line summary: links up, speed, PFC, loss) and remembers being opened. Exposed as `metrics.roce` in the unit's metrics. Requested by a user; switch telemetry could follow as an optional extra.
- **Time zone setting.** **Settings → Time zone** (`timeZone`, an IANA name such as `Europe/Paris`; empty follows each browser, as before) sets the hour and day boundaries and the labels on the Tokens, Energy and Activity charts, so the 24 h charts line up with your local time whatever the viewing device. Half-hour zones (India, Nepal) show correct `:30` / `:45` hour labels on the Tokens page. Daily token buckets and the monthly energy totals are stored per UTC day/month and stay UTC.

### Fixed
- **A host `./dist` older than the image's copy no longer shadows a rebuilt Docker image.** The server now serves whichever of `./dist` and the image's `dist-baked` has the newer `index.html` (the host build wins a tie), so `git pull` + `docker compose up --build -d` is enough even if you once ran `npm run build` on the host.
- **Test suite hardening.** Timing-sensitive tests (network and SGLang rate calculations) allow scheduling jitter; the test-server isolation helper also covers `TOOL_EVAL_RESULTS_DIR`; and the README's settings, API and Quick start text was corrected against the code (labels, defaults, `refresh` domains, the token-totals `?sparkId=` reset).
- **Settings → Time zone is a stable row.** The title and help sit above the field, the field and "Use browser" are left-aligned under them, and one line is reserved for the message, so showing it never moves anything (it used to widen the control and crush the label). The "unknown time zone" message appears only after you leave the field, not while a name is half typed.
- **The GPU history chart fills its panel.** It stayed at about half the panel width on wide screens (and on any layout change after the first paint): the width observer was attached to the "collecting history" box, which is replaced by the chart once data arrives, so the chart kept its first width. The observer now follows whichever element is shown.
- **Review fixes for RoCE, the time zone setting and the tests.** A single dropped frame no longer raises a RoCE warning (port discards need two consecutive readings, RDMA counters three); a failed or empty read keeps the last good RoCE sample for a few reads instead of flapping, and RoCE can no longer hold up the network update; ports are listed in a stable order; the RoCE panel sorts after Network on narrow screens; its script forks about half as often. The Settings dialog refuses an unknown time zone instead of silently saving the browser default, and the Overview activity feed and the Token tables' tooltips follow the zone too. Test servers now override every config file path (a shared helper plus a test that fails when the server starts using a new one), so running the tests can no longer touch the real `bench-active.json` and friends.
- **Spark page: Unified memory, CPU and Models in one row.** The Models list is now the third column next to Unified memory and CPU (RAM and CPU on dedicated hosts) instead of a separate full-width row below them; it wraps to a second row when the column is narrow. The three cards in the row share one height.
- **The monthly energy archive could be moved aside by a server that merely could not read it.** A server run as another user (for example the test suite on the host, with the container's root-owned file) treated a permission error as a corrupt archive and renamed the file to `fleet-energy-monthly.unreadable-*.json`, once per restart. A file that cannot be *read* is now left alone and not overwritten (only content that is not valid JSON is set aside), and the test servers no longer touch the real `config/` archive.
- **CPU and RAM sit side by side on dedicated GPU hosts** (Windows PCs included), like unified memory and CPU on a Spark; they stack on narrow screens.
- **Windows units, first real-hardware pass.** Found on a Windows PC with an RTX 5090: the memory card no longer adds VRAM on top of RAM (it showed 100%), graphics processes with no memory figure (`dwm.exe`, `explorer.exe`) no longer fill the GPU process list, CPU temperature shows a dash instead of 0 °C, and model start/stop is not offered for Windows PCs (the Models panel and the Overview launcher are hidden, and the launcher API answers 400).

---

## [2.30.0] — 2026-10-10

The version number is 2.0.0 plus 0.01 for each of the 30 issues and pull requests closed since 2.0.0 shipped.

### Added
- **Install sparkDash as a mobile app (PWA).** Over HTTPS (for example Tailscale Serve) the dashboard installs to the home screen and runs fullscreen, with its own icon and an in-app install banner (iPhone gets the manual *Add to Home Screen* hint). A small service worker caches only the app shell; `/api`, `/ws` and `/metrics` always come from the network. README: *Tailscale Serve (HTTPS)* and *Mobile PWA*. Thanks @HassanEmam ([#188](https://github.com/MiaAI-Lab/sparkDash/pull/188)).
- **Windows PCs as units.** A Windows PC with an NVIDIA GPU can be added over the built-in OpenSSH Server: choose *Windows PC with an NVIDIA GPU* as the unit type. Two PowerShell scripts per poll supply GPU (`nvidia-smi`), RAM, uptime, CPU load, disks and network adapters; shutdown works. No CPU temperature, automatic Wake-on-LAN MAC detection, Hermes/Tailnet checks or kernel-error events on Windows. The connection test also checks that `nvidia-smi` answers. See *Windows PCs* in the README. Needs a real Windows host to confirm; reports welcome.
- **Prometheus export.** **Settings → Prometheus metrics** (`prometheusExport`, off by default) serves `GET /metrics` in the Prometheus text format, so the fleet can be scraped into Prometheus, VictoriaMetrics or Grafana and kept beyond the dashboard's own history. It renders the snapshot sparkDash already holds — no extra SSH or nvidia-smi calls per scrape — with node_exporter / DCGM-style names in base units: `sparkdash_up`, per-card GPU utilization, temperature, power, memory and throttle state (`gpu` label, so multi-GPU hosts get a series per card), `sparkdash_memory_available_bytes` (unified-pool `MemAvailable` on a GB10, free VRAM on a discrete GPU), CPU, RAM, network, disk, and per LLM endpoint `sparkdash_llm_up`, tok/s, KV cache fill, running requests and the engine's lifetime token counters. Every series is labelled with the unit's id, name, kind and role. An unreachable unit exports only `sparkdash_up 0`, and values the collectors could not read are omitted rather than reported as zero. The endpoint uses the existing auth (a bearer token on a token-protected remote bind); while the setting is off it answers 404. See the README's Prometheus section for a `scrape_config`.
- **Per-Spark `llmHost`.** A Spark's config can name the host the LLM probes and benchmarks talk to, separate from `lanIp` and `ssh.host`. This is for a serving cluster whose SSH or display name does not reach the API (for example, the head of a multi-Spark model that serves on another address). Empty keeps today's behavior: `127.0.0.1` for the local Spark, otherwise `lanIp`. The value is checked like the other target hosts, and `POST /api/sparks/:id/refresh/llm` re-probes the LLM after a change.
- **Restart sparkDash from the UI.** When the fleet changes and Energy needs a restart, the notice now has a "Restart sparkDash" button (with a confirm). Only offered when running in Docker with the compose restart policy; the page reloads itself when the server is back.
- **Monthly energy history.** Fleet energy now keeps a small permanent roll-up per UTC month (`config/fleet-energy-monthly.json`, `GET /api/fleet-energy/monthly`): watt-hours and coverage per node, the fleet total, output tokens and Wh per output token, and which Sparks were measured that month. Finished minutes are added once (a stored watermark prevents double counting across restarts), the first start backfills from the existing 31-day file, and when the fleet changes the previous scope's minutes are rolled up before its file is set aside. **Reset…** only empties the 31-day window; the archive is removed only by `DELETE /api/fleet-energy/monthly?month=YYYY-MM` or `?all=true&confirm=delete-all-history`. The Energy page has a new **Monthly history** panel with a month picker (per-node table, cost, efficiency, open or closed) and a year view of twelve monthly bars. A clock-jump guard never folds or advances the watermark past now + 1 day (a stored watermark beyond that is clamped back, totals kept), the panel refetches right after **Reset…**, months are UTC (the panel says so, as they will not match a local-time electricity bill), and old-scope minutes pass the same plausibility checks as the live file before they are rolled up.

### Fixed
- **The Fleet energy card says why coverage is partial.** "Partial coverage: 4/5 nodes currently fresh" now has an ⓘ tooltip that names the nodes without a fresh power reading and explains the cause (offline or not reporting); the Fleet energy data gains `staleNodeIds`.
- **A token-protected remote bind no longer shows a blank page.** The built frontend (shell and assets) now loads without a token so the app can ask for it; `/api`, `/ws` and `/metrics` stay token-gated. Thanks @HassanEmam ([#183](https://github.com/MiaAI-Lab/sparkDash/pull/183)).
- **The SSH tunnel fallback for benchmarks and Showcase works again** ([#176](https://github.com/MiaAI-Lab/sparkDash/issues/176)): opening the tunnel threw `Unknown encoding: text`, so every remote unit whose LLM listens only on loopback failed. An unreachable `llmHost` no longer tunnels to the SSH host's loopback either.
- **`npm run dev` listens on loopback only**, so nobody on the LAN can reach the whole API through Vite's proxy. Thanks @danielkuykendall23-boop ([#168](https://github.com/MiaAI-Lab/sparkDash/pull/168)).
- **Model launchers no longer inherit the dashboard's environment** ([#186](https://github.com/MiaAI-Lab/sparkDash/issues/186)). A start script run on the local Spark saw the container's `PORT=5555` and tried to bind sparkDash's own port. Launcher and Hermes scripts now get a clean environment without `PORT`, `LLM_PORT`, `BIND_HOST`, `NODE_ENV`, `SPARKDASH_*` (the access token included) and the host-path variables.
- **A short first row of units stretches to the full width.** With two units on a wide screen the Overview's first row now fills the width of the row below instead of leaving empty columns. A single unit keeps its card size.
- **A Windows host added as a Linux unit now gets a clear SSH error** instead of cmd.exe's "'true' is not recognized…", pointing at the *Windows PC with an NVIDIA GPU* unit type.
- **"Frontend not built" after upgrading with Docker.** Compose mounts the host's `./dist` over the image's build, so a checkout that was never built with `npm run build` (or a fresh clone) showed an empty mount and a 503. The image now keeps a second copy (`dist-baked`) and the server uses it whenever `./dist` has no `index.html`; a host build takes over again without a restart. Rebuild the image once (`docker compose up --build -d`) to get the fallback. The message also now says how to fix it.
- **FreeToken on the LLM panel.** The KV cache, Running, E2E p95 and a new **TTFT mean** tile now show for FreeToken servers, and a protected `/v1/stats` is reported as needing a key instead of as missing data (both found with the tests from [#144](https://github.com/MiaAI-Lab/sparkDash/pull/144), thanks @oscarlius).
- **Decode benchmark: pick the model on a multi-model server.** When `/v1/models` lists several IDs (a router), the decode dialog shows a **Model** picker with the exact served IDs instead of silently benchmarking the first one, and the probe keeps reporting a real model id (`contextLength` is `null` for routers). Thanks @kesslerio ([#130](https://github.com/MiaAI-Lab/sparkDash/pull/130)).
- **FreeToken servers are no longer re-probed on `/slots`** — found by running the tests from [#144](https://github.com/MiaAI-Lab/sparkDash/pull/144) (thanks @oscarlius) against `main`.
- **Settings → Poll interval now sets how often units are polled.** The 1s / 2s / 5s / 10s choice only changed how often the dashboard was pushed a snapshot; the collectors kept their own env-only timers, so every unit was still polled over SSH every 2 s at 10 s (no load saved) and 1 s showed no fresher data. GPU, CPU/RAM, network, memory bandwidth, LLM and ComfyUI polling now follow the setting for every unit, and changing it re-arms the running monitors' timers in place — no restart, no duplicate polls, and an unreachable unit's paused polls and SSH backoff are kept. Memory bandwidth stays at 2 s or slower because `nvidia-smi dmon` blocks for about a second. Storage, liveness, Tailnet, Hermes and the `NV_ERR` journal scan keep their own cadences. An explicitly set `POLL_INTERVAL_GPU` / `_CPU` / `_NETWORK` / `_LLM` / `_COMFY` / `_BANDWIDTH` still pins its domain. The dialog now says what the setting does and that 1 s costs the most on remote units.
- **Add / Edit dialog wording follows the unit type.** Choosing *Dedicated GPU host* now makes the final button read **Add GPU Host** (it always said *Add Spark*), and the Edit dialog title and the remove confirmation name the host the same way.
- **GPU history on hosts with several GPUs.** The main graph only ever showed the combined line (busiest card, hottest card, summed power), so a second card was invisible. The server now also keeps a history per card (`gpus[]` in `GET /api/sparks/:id/gpu-history`, existing fields unchanged), and with more than one GPU a toggle above the graph switches between **Combined**, **All GPUs** (one coloured line per card for utilization, power or temperature) and a single card. The choice is remembered. Single-GPU hosts look exactly as before.
- **Fleet energy efficiency keeps its digits.** The Overview card printed Wh/token with four fixed decimals, so a fleet-scale figure of ~0.001 Wh/token kept only one or two significant digits (0.0010537 read `0.0011`, and a busier day a single digit). It now shows three significant digits (`0.00105 Wh/token`).

---

## [2.0.0] — 2026-10-09

A major release: a redesigned application shell, a rebuilt Overview, a Benchmarks section with a new Tool Eval Bench, in-app Showcase, launchers for your own models, fleet-wide Token totals / Energy / Activity pages, a rewritten Quality bench, and a long list of correctness and security fixes. Everything under **Added**, **Changed** and **Fixed** below ships in 2.0.0.

### Highlights
- New shell: sidebar + command palette, four themes, smooth Apple-style page transitions, real links everywhere.
- Overview rebuilt around per-Spark cards that show the model, head/worker relations, a memory breakdown and a launcher.
- Benchmarks section: Decode, Prefill, Quality and **Tool Eval Bench** (new), with side-by-side compare.
- Showcase is now an in-app page with much smoother token streaming.
- Start and stop your own LLMs from the dashboard.
- Token totals, Fleet energy and Activity pages.
- Live prefill tok/s that no longer drops to 0 during a long prefill.

### Added
- **Health findings per Spark.** The server now runs a small set of explainable rules over metrics it already collects and reports them as `health[]` on each Spark snapshot (`server/health/HealthEvaluator.js`). Overview cards show the active findings as chips (details and what to try in the tooltip) and the Spark page lists them in full: **GPU running hot** (85 °C warn, 90 °C critical), **GPU stuck in a low-power state** (≥ 90 % utilisation but under 15 W for 5 samples in a row; normal decode draw does not trigger it), **unified memory running low** (under 3 GB available warns, under 1.5 GB is critical), **several models loaded while memory is busy**, and **network link slower than 1 Gb/s**.
- **Kernel errors become Activity events.** The GPU collector now reads NVIDIA **Xid errors** and kernel **OOM-killer kills** from the journal (one cached scan per minute; `gpu.kernelErrors` = `{ xid, oomKills, lastXid }`). When a counter rises, Activity records an event (new **Health** category) and the node shows a critical finding for the next hour. The first reading after a restart is only a baseline, so old errors since boot do not raise an alert.
- **Clear Activity history.** A **Clear history…** button on the Activity page deletes events older than 7 days, older than 24 hours, or everything, after an in-place confirmation (new `DELETE /api/events?olderThanMs=`; omit the parameter to delete all). Event ids keep counting up, so nothing already on screen is reused.
- **Reset Token totals and Fleet energy.** A **Reset…** button on each page. Fleet energy can delete minutes older than 7 days, older than 24 hours, or everything (`DELETE /api/fleet-energy?olderThanMs=`; power keeps being recorded afterwards). Token totals can reset all Sparks or just one (`DELETE /api/llm-token-totals?sparkId=`): counted totals and the daily/hourly history are zeroed while each engine's counter baseline is kept, so counting restarts from now instead of re-adding what the engine already served. Each asks for confirmation first.
- **Mobile: "Shut down all" lives in the Sparks sheet.** On phones the button moved from the Overview header into the Sparks menu (new "Fleet" section), with the same confirmation. Desktop is unchanged. The flow is now one shared component.
- **Mobile: Stats tab.** The bottom bar's Search tab became **Stats**, which opens Token totals, Fleet energy and Activity (search stays one tap away in the top bar). Those pages left the Sparks menu, and Showcase now sits under Benchmarks, right after Prefill.
- **Mobile navigation feels like iOS.** The active-tab highlight is one pill that slides between tabs on a spring curve, tabs shrink slightly under your finger and the active icon pops, and the Sparks / Stats sheets slide up from the bottom with a fading backdrop and slide back down when closed. All of it is off with reduced motion.
- Health findings also write Activity events when they appear and when they clear (`health.*`).
- **New application shell.** A collapsible sidebar (Overview, Sparks, Benchmarks, Token totals, Fleet energy, Activity, Showcase, Settings) replaces the top tab bar, with a bottom tab bar on phones and a **command palette** (Ctrl/⌘ K) to jump to any Spark, page, action or setting. Ctrl/⌘ B toggles the sidebar, which now slides in and out. The access-token state lives in a small, gentle chip at the bottom of the sidebar instead of a banner. Header links to the sparkDash website ([mia-ai.net](https://mia-ai.net/)) and the [GitHub repository](https://github.com/MiaAI-Lab/sparkDash) are in Settings and the sidebar.
- **Four themes: White, Light, Dark and OLED**, cycled from the theme switch; all colours are design tokens, so every page, chart and card follows the theme.
- **Smooth, Apple-like motion.** Navigating between pages and sections cross-fades through the View Transitions API (with a plain fallback), the sidebar hide/show is animated, and mouse-wheel notches glide instead of jumping (touchpads, Ctrl/Shift scrolling, text selection and number inputs are left alone). Everything respects `prefers-reduced-motion`.
- **Real links throughout.** The logo, every sidebar entry, tab, Spark card and Overview card is a genuine `<a href>`: right-click → Open in new tab / Copy link, middle-click and Ctrl/⌘-click work as in any website, while a plain click still navigates in-app without a reload. Pages have stable URLs (`/tokens`, `/energy`, `/activity`, `/showcase`, `/bench/<type>`, `/spark/<id>`).
- **Overview cards rebuilt.**
  - Each card leads with a model row (name, backend, live decode/prefill tok/s, slots); the decode/prefill graphs were removed because the numbers say it all.
  - **Idle cards offer a launcher**: load or add a model from the card itself, choosing from the models registered on that Spark. While anything on the fleet is still loading, starting another one is blocked with an explanation, so a second launch can't be started by mistake.
  - **Worker cards show their head** (a link to the head Spark) and the model the cluster is serving; the HEAD and WORKER role badges are uppercase.
  - GPU and CPU temperature bars turn red above 80 °C; all cards in a row have equal height.
  - While a prompt is being processed with no rate yet, the card shows a "prefilling" indicator instead of 0.
- **Memory breakdown that reads the same on every card.** The VRAM bar shows two colours only — **Model** (weights plus the KV cache that belongs to the serving engine) and **System** (everything else) — with identical colours on head and worker cards, and no "Free" or "KV" legend items. A worker's bar mirrors its head's model.
- **Tool Eval Bench.**
  - **Trials**: a Trials control (`--trials`) in Simple and Advanced mode.
  - **Compare two results side by side** from the history.
  - **Check for updates** asks GitHub (from the Spark) whether a newer commit exists; the button is **Upgrade now**, and a reinstall is offered when you're already current.
  - A clear green **Upgrade complete / Installation complete** banner shows the version change (old → new).
  - Upgrades work for installs not made by `uv` (falls back to `uv tool install --force`) and the panel closes itself when the job finishes.
  - The page is renamed from "Tool Eval" to **Tool Eval Bench** everywhere.
- **Showcase is a page in the app.** It opens inside the dashboard (sidebar stays), fills the available area, can be run on any Spark with chips, shows a proper empty state with a one-click "Run on <other Spark>" when the chosen Spark has no model, and offers **Open in new window ↗** if you still want a separate window. The look was redone (animated aurora, glass tiles, glowing terminal cards, aggregate sparkline).
- **Much smoother token streaming and auto-opening reasoning.** Streamed text is revealed with a frame-rate catch-up animation (no bursty chunks, no cut surrogate pairs), the caret follows the text, and the reasoning block opens by itself while the model is thinking, then folds when the answer starts.
- **Live prefill tok/s during a long prefill.** Engines that publish prompt totals only when a request finishes (TensorFold) used to show 0 for the whole prefill. The probe now flags `prefillActive`, holds the last measured rate for 20 s so the card doesn't flicker to 0, and the LLM panel and Overview card show "Prefilling…" while it runs. New `prefillActive` field on `metrics.llm[]`.
- **Access-token dialog** — the dashboard asks for the token itself (see below).
- **Quality bench: GSM8K, MMLU and Instruction following replace the JavaScript Code category.** GSM8K (200 problems) and MMLU (285 questions, 5 per subject) are fixed seeded samples of the public test sets (both MIT, bundled under `server/collectors/data/`), so scores track published numbers closely. Instruction following (40 prompts, rules checked by code) is opt-in so existing overall scores stay comparable. Model code is no longer executed, so the Node sandbox runner was removed. Runs saved with a Code score keep their stored data but the category no longer appears.
- **Dedicated pages: Token totals, Fleet energy, Activity** (sidebar). Token totals shows generated / prompt / cached tokens by type, model and Spark over 24 h – all time, with cache-hit rate, period-over-period change, insights and sortable tables (new `/api/llm-token-totals/history`; hourly buckets are kept for 72 h from now on). Fleet energy shows per-node kWh by hour/day, average power, peak, efficiency (Wh per 1,000 tokens), coverage and estimated cost (new Settings fields for electricity price and currency; `/api/fleet-energy/history`). Activity is the full filterable event history with paging (`/api/events?beforeId=`, 2,000 events kept). The Overview cards link to them.
- **Benchmarks section** with one page per benchmark: Decode, Prefill, Quality, and — new — **Tool Eval Bench**, powered by [tool-eval-bench](https://github.com/SeraphimSerapis/tool-eval-bench) run on the Spark. The Tool Eval Bench UI exposes every option of the tool, installs it on request, streams live progress, keeps results and history, and compares runs. Its other modes (throughput, speculative decoding, context pressure, needle, decision model) are under Advanced > all options. The Simple view offers ready runs: regular, regular + Hard mode, short, Hard mode only.
- **Models panel: start and stop your own LLMs from the Spark page.** Register a folder that holds a `start.sh` and a `stop.sh` (per Spark), then Start / Stop it and watch the script's output stream live in the UI (optionally in an expanded view; auto-open is a preference). The start script runs detached on the Spark and logs to `~/.cache/sparkdash/llm/<id>.log`, so closing the browser or restarting sparkDash never stops a model, and the output can be re-attached later. "Running" tracks the script's whole process group. Starting a model while another runs offers "Stop it, then start". Only the registered start/stop script names inside the registered directory are ever executed. Registrations live in `config/llm-launchers.json`.
- **FreeToken LLM backend** — detected from `/v1/models` (`owned_by: FreeToken`), with a `/v1/stats` schema check when the owner is missing. Decode and prefill tok/s are FreeToken's 5-second window (they read 0 when idle). TTFT is the reported mean. `requests.p95_ms` is end-to-end latency, not TTFT p95. KV occupancy is shown when `kv.total_pages` is present. Queue length, slot capacity, and preemptions stay unset.
- **Glance** — README points at the community [`sparkdash-dgx-cluster`](https://github.com/glanceapp/community-widgets/tree/main/widgets/sparkdash-dgx-cluster) widget.
- **The dashboard asks for the access token.** On a server with `SPARKDASH_TOKEN` set, the only way to give the UI the token was typing `localStorage.sparkdashToken = "…"` in devtools and reloading, and a refused WebSocket left the page on "Connecting to live telemetry…" forever. Now any 401, or a live connection that closes before its first snapshot while the server reports the token missing or wrong, opens an **Access token** dialog; the token is checked against the server before it is saved, and the WebSocket reconnects with it immediately. **Settings → Access token** shows Set / Not set with Change and Clear. A new `GET /api/auth/status` (served ahead of the auth middleware) returns `{ tokenRequired, authenticated }` and never the token itself. Installs without a token see no change.
- **KV cache fill for SGLang and TensorFold, and SGLang's memory split.** Each `metrics.llm[]` entry's `kvCacheUsage` (0–1, the share of the engine's KV pool held by requests) was filled only for vLLM and q27. SGLang now reports it from `sglang:token_usage` (or `kv_used_tokens / max_total_num_tokens` on builds without it) and TensorFold 0.6.0 CUDA from `/health` as `1 − pool_free_tokens / pool_tokens` (spark-1: 5%); older vLLM builds that name the gauge `gpu_cache_usage_perc` are read too. Two new fields say where an SGLang engine's memory went: `weightsGb` and `kvCacheGb` from `/server_info` `internal_states[].memory_usage` (RTX PRO 6000: 71.1 GB of weights, 10.7 GB of KV pool), with `sglang:kv_cache_memory_usage_gb` as the pool-size fallback. Both are null on every other backend. The probe reads these from the payloads it already fetches — no extra requests per poll.
- **The VRAM bar shows what holds the memory and how close it is to the limit.** It was one fill coloured by percentage, which misread both kinds of unit: on a GB10 it drew only the GPU's share of the unified pool (spark-1: 98.6 of 121.7 GB, calm) while the CPU side held another 15.8 GB and only 7.2 GB were left, and on the RTX PRO 6000 an idle SGLang engine's pre-allocated KV pool kept it permanently red with 3.2 GB still free. The bar on the Overview cards and the GPU panel is now split by category — **LLM engine** (the largest GPU process while the unit, or a worker's head, has an endpoint online), **System/CPU** (GB10 only), **Other GPU** — over a free track, in category colours that are neither the amber accent nor a warning. Severity moved to the headroom figure in the bar's header ("7.2 GB free"): amber under 8 GB and red under 4 GB of `unifiedMemory.available` on a GB10, amber under 2 GB and red under 1 GB of free VRAM on a discrete GPU; the Available figure next to it follows the same rule. The GPU panel adds a legend line ("Engine 98.6 · System 15.8 · Free 7.2 GB · KV 5%", KV amber from 90%), and hovering or focusing the bar (keyboard included; Escape closes) opens a breakdown with the engine's process and pid, its weights and KV pool size and KV fill where the backend reports them, and a one-line verdict. Multi-GPU hosts get the same bar per card, from that card's processes. On by default — **Settings → Detailed VRAM breakdown** (`showVramBreakdown`) turns it off and restores the previous bar exactly.
- **The LLM panel says when an idle endpoint last served** — while generation and prefill are both zero, a small muted note under Generation tok/s reads "Idle · last served 12m ago" (or just "Idle" when sparkDash has not seen the endpoint serve since it started). The server tracks the last poll with generation or prefill above zero per LLM port and exposes it as `lastActiveAt` (epoch ms, in memory only — null after a restart) on each `metrics.llm[]` entry. The Overview card footer keeps its live `tok/s` / `prefill` figures, zeros included.

### Changed
- **License: Apache 2.0 from this version on.** sparkDash 2.0.0 and later are released under the Apache License 2.0 (`LICENSE`, plus a `NOTICE`). Versions up to 1.9.0 stay under the MIT License, whose text is kept in `LICENSE-MIT`.
- **Credits.** The README Acknowledgements now name the contributors and the projects and data sparkDash builds on (tool-eval-bench and its sources, GSM8K, MMLU, IFEval, Hermes Agent, Geist, Feather), and a new `THIRD_PARTY_NOTICES.md` carries the copyright notices and the SIL OFL text for the fonts that ship in the UI.
- **Settings: the Density option was removed.** Compact is the only layout.
- **Access-token row** in Settings restyled (the "Not set" state is readable, with clear actions).
- **Role badges** (HEAD / WORKER) are uppercase and larger; worker blocks on Overview cards are intentionally quieter than the head's.
- **Local launchers and Tool Eval Bench need a resolvable SSH user.** On a *This host* unit they refuse to run when no valid SSH user can be determined (shared spawn code), instead of guessing.
- **Quality scoring is stricter (scoring version 2).** Runs saved with the previous scorer remain viewable but are not comparable with new runs.
- **Prefill and Showcase fit the context window.** Prompt sizes are clamped to what the model's context can hold (shared `contextFit` helper), and the prefill route passes the context length.
- **Documentation** (README, CODEBASE.md) updated for all of the above.

### Fixed
- **Spark page on phones.** The name sits on its own line with the role / engine / uptime tags underneath, Edit and Shut down are two equal thumb-sized buttons, panels use less side padding, the GPU ring is smaller so the temperature / power / clock stats get room, and the daily-peak axis shows `M tok/s` instead of an unreadable `44552k tok/s`.
- **Mobile tab bar is docked to the bottom edge** instead of floating above it, with a solid background so content no longer shows through.
- **Prefill tok/s showed 0 most of the time.** See *Live prefill tok/s* above; the displayed rate is also now clamped to physically plausible values.
- **Tool Eval Bench: failed or stuck upgrades.** `uv tool upgrade` failed with "not installed" for tools not installed by uv, the "Force reinstall" checkbox had no effect, and the panel sat on "Done. Checking the install…" after success. All three are fixed; results from older runs with omitted-option placeholders reload correctly.
- **Review of the 2.0 features.** A multi-agent review found and fixed issues across the WebSocket error path (a socket error could escape), GPU-history guards on bad input, launcher routes (editing or removing a launcher that is running now answers 409 instead of corrupting state), Showcase/Prefill streaming edge cases, atomic file writes, and several accessibility problems in the Tool Eval Bench tabs and dialogs (focus handling, inert background behind modals, labelled controls).
- **Quality scorers tightened across categories (review of every category).** Arithmetic chain, state tracking, Reasoning and GSM8K now require the last `Answer:` line to be only the answer (`1200.9`, `1200 or 1201`, `1,23` and `3, 77, 4` no longer pass); MMLU needs the letter at the end of a line and case-sensitive (`Answer: a cat`, `A or B` no longer score) and also reads `The answer is (B)` / `**C**`, with a 1,024-token budget; Instruction following fails an empty reply and no longer counts `*`/`***` as words or `-` as `* `; Long-context recall reads `otter: 90471 (was 48213)`, `a: 1, b: 2` on one line, and a closing 'was originally' note correctly, and skips sizes without 20% token headroom. The GSM8K/MMLU samples now ship a `data/NOTICE.md` with their MIT notices. Scores from earlier runs used the old rules and are not directly comparable.
- **Quality · QA scoring no longer passes hedges and look-alikes.** A reply passed if it merely *contained* the accepted answer, so `1391` passed for 391, `391 or 5` passed, `11, 2, 4, 7, 9` passed a sort, `Australia` passed `Au`, and a sign error passed an add/subtract. Each item now has a mode: numbers must end on the answer, dates on the date, sorted lists must end with the list in order, and words must match as a whole word in a short reply. Generated binary prompts are also unique now. The suite seed is unchanged, but QA scores from earlier runs were scored more leniently, so don't compare them directly.
- **DGX Spark Wake button.** GB10 does not wake from a magic packet. Wake and Wake All are only offered for dedicated GPU hosts. A wake request for a Spark unit is rejected.
- **Free VRAM on an idle GPU host.** On a `host` unit with discrete cards, free VRAM was only recomputed as total − used when used was above 0, so a fully idle card reported the machine's free system RAM as free VRAM. Free VRAM is now total − used whenever nvidia-smi reports a total. Spark units (shared pool) are unchanged.
- **A broken remote unit no longer hammers SSH forever** — collectors kept polling a unit the monitor already knew was unreachable, so every domain interval opened another connection that failed authentication: one unit with no key attempted ~233,000 logins a day, indefinitely. Collector polls now pause while a remote unit is offline (local units are exempt — their reads are /proc and /sys), and a credential failure gets four quick retries (5s → 15s → 30s → 60s) before effectively stopping at one attempt every 15 minutes (~96 a day), with the offline snapshot reading "SSH authentication failed — check the key or user for this unit (paused after N attempts — edit the unit to retry now)" so the unit page says what to fix instead of going quiet. Network failures still widen gradually, since a rebooting host comes back on its own; editing the unit resets the retries immediately.
- **CPU temperature stops pretending to be the CPU ([#142](https://github.com/MiaAI-Lab/sparkDash/issues/142))** — both readers took the first plausible sensor they found, without looking at what it was, so on a GB10 (no CPU package sensor at all: seven `acpitz` zones and nothing else) the tile labelled an ACPI/board zone as the CPU, ~15 °C above the GPU die. A real CPU sensor now wins wherever it appears in the list; when there is none the reading is kept but named for what it is — the panel shows `Temperature (ACPI)` with the sensor name in the tooltip, and the metrics carry `temperatureLabel` / `temperatureSource` for anyone reading the API.
- **Editing a This host unit with no LAN IP.** Saving any change from the Edit dialog failed with "lanIp or ssh.host is required", because the edit was checked as if the unit were remote.
- **The SSH user is checked on local units too.** A **This host** unit with no LAN IP skipped the SSH user check (letters, digits, `.`, `_`, `-`), although local Hermes checks put that name in shell commands.
- **Hermes refuses an unsafe SSH user from an older config.** The new check guards the API, but a `sparks.json` saved before it could still hold an SSH user that Hermes splices into its scripts (`/home/<user>/…`), which a local unit runs as root in the host namespace. Hermes now refuses to run anything for such a user and reports `Invalid SSH user` on the unit instead.
- **Saved secrets stay with their host.** Pointing a unit at another host kept its saved SSH password and LLM API keys and sent them there. Changing the SSH host, user or **This host** now drops the password unless the same edit enters it again, and changing the LAN IP, SSH host or **This host** drops the LLM API keys (the benches can reach the LLM through an SSH tunnel).
- **A loopback dashboard refuses other sites and DNS rebinding.** A page from another site open in the same browser could press Wake All or open the live-telemetry socket, and a rebound name could read and change everything. On a loopback bind, `Origin` must now match the request's own `Host`, and `Host` must be one of this machine's names: `localhost`, `*.localhost`, any IP address, its hostname or `<hostname>.local`, or its Tailscale name. Tailscale Serve and the Vite dev server on a LAN IP keep working with no setup; only a custom proxy domain goes in the new `SPARKDASH_ALLOWED_HOSTS`, and a refused browser gets a page naming the host to add. A valid `SPARKDASH_TOKEN` skips the check; non-loopback binds are unchanged.
- **Closing the tab cancels a running Showcase on token-protected installs.** The cancel request sent on `pagehide` / `beforeunload` carried no `Authorization` header, so a server with `SPARKDASH_TOKEN` set rejected it with 401 and the session kept generating after the tab was gone. It now sends the same bearer token as every other API call.
- **Live telemetry with an access token.** The browser's WebSocket passes the token as `?token=` (it cannot set headers), but the upgrade check read it from `req.query`, which a raw upgrade request does not have — so on any install with `SPARKDASH_TOKEN` set, the dashboard's socket was refused even with the right token. The token is now read from the upgrade URL; an `Authorization: Bearer` header keeps working as before.
- **Say plainly when a remote bind is open.** A non-loopback bind without `SPARKDASH_TOKEN` is open by default (`SPARKDASH_ALLOW_OPEN_REMOTE` unset or `1`), but `/api/health` reported it as `authMode: "required-missing"`, the startup log warned that mutations "will fail closed", and the README said the same. None of that was true. Health and preflight now report `authMode: "open-remote"` (keeping `required-missing` for `SPARKDASH_ALLOW_OPEN_REMOTE=0`, which really fails closed), the startup warning says the port is open, the README describes the actual default, and the header shows a dismissible **Open access** chip on such installs explaining that anyone who can reach the address can change settings and power units off until `SPARKDASH_TOKEN` is set. Loopback and token installs see no change.
- **Overview bars say what they measure.** The card's bar labelled `GPU` (or `Temperature` on a unit without a CPU sensor) was the GPU temperature, `CPU` was the CPU temperature, and `Usage` was GPU utilisation; they now read **GPU temp**, **CPU temp** and **GPU util**. The Storage mini-stat on a 1.8 TB disk was cut to `816.4 / 1831.7 …`; each side now carries its own compact unit (`816 GB / 1.8 TB`, `674 GB / 3.7 TB` on a GB10), with the exact figures and percentage on hover. SGLang is spelled **SGLang** (was `sgLang`) on the Overview, the LLM panel badge and the benchmark share card. The LLM panel's **Engine** tile reads a muted `n/a` — hover: "This backend does not report engine sleep state" — on backends such as TensorFold that publish no sleep state, instead of a bare `—` that looked like a failed probe.
- **Fleet Energy history when a Spark joins or leaves.** A membership change still starts a fresh scope (the old totals are not the new fleet's), but the previous `fleet-energy.json` is renamed to `fleet-energy.scope-<savedAt>.json` before the next flush, so up to 31 days of per-minute history is no longer overwritten.
- **Fleet Energy efficiency on fleets with more than one serving node.** Wh/token counted output tokens only when the fleet had exactly one head with one available endpoint, so two clusters, or a cluster plus a standalone node, recorded no tokens and the card read `— Wh/token`. Every available endpoint on a head or standalone node is now its own counter (workers are skipped, so a cluster counts once), and the figure divides only energy recorded since a token source was first seen, so the first day after upgrading does not read high.
- **Byte rates and memory sizes.** A transfer of 1023.95 KiB/s was labeled `1024.0 KB/s`, and 1023.5 MiB of RAM or VRAM was labeled `1024 MB` on the device panels and the Overview card. Both roll into the next unit: `1.0 MB/s` and `1.0 GB`. A 512 MB reading stays `512 MB`.
- **Benchmark duration.** A run of 119.5 seconds was labeled `1m 60s` on the decode dialog, the prefill dialog, and the share card. It now reads `2m 0s`. 59.95 seconds was `60.0 s` and is now `1m 0s`. A 27.8 second run is unchanged.
- **TensorFold slots on CUDA.** A TensorFold 0.6.0 CUDA server with 3 of its 4 streams busy showed `1 / 1` on the LLM card's Slots tile. The tile now reads `streams.max` and `requests_running` from `/health` (or `streams.decoding` + `streams.prefilling` when `requests_running` is missing) and shows `3 / 4`. MLX servers still size it from `max_batch_size`, and a `/health` without these fields keeps the previous `1 / 1`.
- **Two token totals, explained.** The LLM panel's `Total Generated` tile is the engine's own counter and restarts at zero with the engine, while **Total tokens by model** below it is sparkDash's durable ledger — so on spark-1 the tile read 51,950 next to a table saying 200k. The tile is now **Generated (engine)** (hover: "Reported by the engine since it last started"), and the node and fleet tables say they are *Counted by sparkDash since tracking began*. The **Daily peak tok/s** chart drew decode and prefill on one scale, so next to spark-1's ~50k tok/s prefill peaks its ~200 tok/s decode bars were under 0.2 px tall; each series now has its own 14-day scale, and a y-axis names both tops in the series' colours (decode `205 tok/s`, prefill `50k tok/s`). It also gains a tooltip with the date, decode peak and prefill peak of the hovered day, in real tok/s; the chart is focusable and the arrow keys, Home and End step through the 14 days.
- **`npm run dev` listens on loopback.** Vite listened on `0.0.0.0`, so anyone on the LAN could use the whole API through its proxy; it now listens on `127.0.0.1` (use an SSH tunnel from another machine).

---

## [1.8.9] — 2026-09-28

### Added
- **Multi-GPU hosts** — a dedicated GPU host with several NVIDIA cards now reports every card: the header names them all (`NVIDIA GeForce RTX 5080 + RTX 5060 Ti`), the GPU panel adds a block per card, and the API exposes `gpu.gpus[]`. `metrics.gpu` keeps its shape as the all-cards aggregate, so single-GPU units, including every DGX Spark, are unchanged.
- **TensorFold LLM backend** — detected from `/v1/models` (`owned_by: tensorfold`), labeled on the LLM card and Overview. Live tok/s reads cumulative token totals from `/health` when the server publishes them (TensorFold 0.5.0 CUDA does; older or MLX builds show 0 tok/s). Prefill tok/s uses `prefill_seconds_total` when the server sends it. Benches and showcase work as on any OpenAI-compatible server.
- **KV cache pool** — the vLLM tile shows free tokens left in the allocated pool (`cache_config_info` size × usage), with the pool size and memory underneath. Older servers that only expose the usage gauge still show the percent.
- **Cached vs computed prefill in token totals** — the per-model token tables (node LLM panel + fleet Overview card) now split the prompt bucket into three columns: **Cached** (prefix-cache served), **Prefill** (computed = prompt − cached) and **Generated**. The probe exposes a new lifetime `totalCachedTokens` counter: vLLM `vllm:prefix_cache_hits_total` (token-granular), SGLang `total_cached_tokens` from `/server_info` or `sglang:cached_tokens_total{cache_source="device"}` from Prometheus, llama.cpp `n_prompt_tokens_cache` summed across slots, TensorFold `cached_tokens_total` from the CUDA server's `/health` (0.5.0+), and ds4/q27 computed+cached prefill counters (their raw prefill counter is computed-only, so the reported prompt is now the full prompt: computed + cached). EXL3 exposes no split — its cached column stays "—" and prefill equals prompt. The ledger clamps cached ≤ prompt on every credit, so backend backfills never inflate the cached share, and older ledger files upgrade transparently (cached starts at 0; the split begins at deployment, no retroactive history).
- **LLM token totals per model** — sparkDash now keeps a durable ledger of cumulative prompt (prefill) and generated (completion) tokens, attributed to the model the server reported when the tokens were produced, across all supported LLM backends (vLLM, SGLang, ds4-server, q27, EXL3, llama.cpp). The node LLM panel gains a **Total tokens by model** block and Overview can show a fleet-wide **LLM Token Totals** card (Settings → *Show LLM Token Totals*, off by default), each with a time-range picker: All time, Today, Last 7 / 14 days, Last month (per-UTC-day buckets, 35-day retention; ranged views start at deployment — no retroactive history). Probes report the new lifetime `totalPromptTokens` counter alongside `totalOutputTokens` (null when a backend does not expose it). SGLang servers need `--enable-metrics` (or a build whose `/server_info` carries `total_input_tokens` / `total_output_tokens`) for SGLang-side counting to work. Counters accumulate saturatingly at `Number.MAX_SAFE_INTEGER` and survive engine restarts without double counting.
- **Custom prefill size** — type any token count from 256–300k in the prefill benchmark (plus the preset chips).
- **q27 LLM backend** — detect signalnine/q27 via `/v1/models` ownership or `q27_*` Prometheus series; report backend-aware decode/prefill rates and inference-health telemetry.
- **Hide worker nodes** — Settings toggle. Worker-role Sparks drop off Overview cards and the tab bar (the open worker tab stays). Direct URLs and batch Wake / Shutdown / Hermes still include them.
- **On-demand Remote bench** — a **Remote** button next to decode/prefill opens a host + port (HTTPS) field. Paste a Tailscale URL such as `https://name.ts.net/v1/models`; nothing is probed until you run Decode or Prefill against it.
- **Decode / prefill benches on remote Sparks** — if the remote LLM is not reachable on its LAN IP (loopback-only bind), sparkDash opens an SSH local-forward to `127.0.0.1:<port>` for the job. Bench buttons stay on the LLM card even when the live probe shows no model.
- **Benchmark share image** — the decode/prefill **Copy results** button is now a split button: the label copies the text summary as before, and the caret on its right offers **Copy as text** / **Copy as image** on hover or click. The image is a 1200×675-or-taller card drawn in the app's dark palette with the sparkDash mark, the unit, the model, the engine and exposure badges the LLM panel shows (TensorFold, sgLang, vLLM, … plus Open · Local), one row per level and the same legend the dialog shows. On by default (Settings → **Benchmark share image** turns it off, restoring the plain text button); it copies where the page has an image clipboard — HTTPS or localhost — and otherwise downloads the PNG, and says so in the menu rather than pretending.

### Fixed
- **GPU process VRAM on multi-GPU hosts** — the compute-apps cache was keyed by PID, so a process holding memory on two cards (llama.cpp with a layer split) showed only the last card's share. Entries are keyed by PID + GPU uuid and the process list sums a PID across cards.
- **Decode bench “Too many benchmark requests”** — start quota was 6/min stacked with a 2/min cooldown, and failed retries still burned the quota. Starts are now 20/min, cooldown is 3s (double-click only), and 400/409 responses do not count.
- **Decode bench 24×/32× work budget ([#93](https://github.com/MiaAI-Lab/sparkDash/issues/93))** — the post-1.8.6 security cap (131k total tokens) rejected a full concurrency sweep at 2048 max tokens. The cap is 262k so every advertised level fits.
- **Prefill bench still dying at ~5 min** — Node undici aborts streams with no headers/body after 300s. Long prefills now use an Agent with those idle timeouts disabled; the per-size AbortSignal remains the bound.
- **SGLang live Prefill tok/s latching ([#99](https://github.com/MiaAI-Lab/sparkDash/issues/99))** — the poll picked its Prometheus applier from the *displayed* rates, so a non-zero prefill kept selecting the cache-split path (which by design never writes `prefillTps`) and the value could not return to 0. Which applier runs now depends on whether `/server_info` carries `total_*` counters on that poll. The token baseline is also seeded outside the rate window, so the first poll after a restart no longer turns the engine's lifetime prompt counter into a rate.
- **SGLang prefill tok/s split** — with `--enable-metrics` the cached/uncached rows differenced `prompt_tokens_total` as the computed side, so “uncached” double-counted the prefix-cache hits and the hit rate read ~49% where the device truth was ~98%. The tile now reports the prompt tokens taken in during the poll window — cache-served + computed — and the rows below split that total, all from `realtime_tokens_total{mode="prefill_compute"|"prefill_cache"}` (`prefill_effective_tokens_total{mode="input"}` / `cached_tokens_total{cache_source="device"}`, then prompt − cached, as fallbacks). A window that prefilled nothing reads 0 even while unrelated requests are still decoding, instead of holding the previous value.
- **`SPARKDASH_TOKEN` never reached the container ([#86](https://github.com/MiaAI-Lab/sparkDash/pull/86))** — the compose file did not pass it through, so a `BIND_HOST=0.0.0.0` install failed closed no matter what `.env` said. The empty default still reads as "no token".
- **Tailscale addresses classified as public ([#89](https://github.com/MiaAI-Lab/sparkDash/pull/89))** — `100.64.0.0/10`, where a tailnet lives, now reads as LAN on the endpoint-exposure indicator.
- **SGLang served model ID ([#95](https://github.com/MiaAI-Lab/sparkDash/pull/95))** — the panel and the bench requests use the id from `/v1/models` (what the server accepts), keeping the native storage path on `modelPath`.
- **Remote SSH session churn** — collectors reuse an authenticated SSH transport instead of creating a full SSH/PAM login for every metric poll. `SSH_CONTROL_PERSIST_SECONDS=0` restores one connection per command if needed.
- **Shutdown controls ([#90](https://github.com/MiaAI-Lab/sparkDash/issues/90))** — three separate failures on the shutdown path: a local unit in Docker called the host helper from inside the container (no sudo there) instead of entering the host mount namespace; the remote command joined its lines with `;`, so the backgrounded line ended in `&;` and the shell rejected the whole script before running anything; and the authorization probe was `sudo -n true`, which a sudoers rule scoped to the helper does not authorize. The probe is now the helper's own `--check` (see the README contract), with `sudo -n true` kept as a fallback for broader sudo setups. A local unit whose helper or `nsenter` is missing now reports the error instead of logging success.

---

## [1.9.0] — 2026-10-03

### Added
- **Quality bench** — a **Quality** button on the LLM card (and in the **Remote** panel) runs a fixed, deterministic quality suite against whatever the port is serving, so models, quantizations and KV-cache formats can be compared over time. Six categories, all at temperature 0 with a fixed seed and stable item ids: **QA** (150: 30 fixed + 120 generated), **Reasoning** (40 word problems, thinking on), **Arithmetic chain** (40 ten-step chains, thinking on), **State tracking** (40 token-transfer stories, thinking on), **Code** (25 JavaScript functions with hidden tests) and optional **Long-context recall** (8k–256k needle recall with late corrections; stale answers counted). Per-category score, overall score (mean of category %), mean completion tokens and `max_tokens` hits for the thinking categories, and a collapsible per-item table. Model code runs in a separate Node process with an empty environment, a 128 MB heap and a 10 s kill, never in the server.
- **Quality compare** — the last 30 runs per unit are kept with label, model id, settings and per-item pass/fail + reply hash. **Compare with** pairs two runs item by item: both scores, identical replies, only-this / only-other counts and an exact two-sided McNemar p-value, with *difference within noise* when p ≥ 0.05. **Copy results** copies a plain-text summary.
- One quality run per unit at a time; it is mutually exclusive with the decode / prefill benches and the showcase, counts toward the global bench cap, and is finalized as *interrupted* on restart like the other benches. Model id and context length come from the live probe, falling back to `/v1/models`.

Quality bench by Mia's AI Lab.

---

## [1.8.8] — 2026-09-22

### Fixed
- **SGLang overview tok/s stuck at 0** — `generation_tokens_total` on current SGLang builds only moves when a request finishes, so the live rate was 0 for the whole decode and then one spiked poll. Overview now uses `gen_throughput` while a request is running.

---

## [1.8.7] — 2026-09-22

### Changed
- **Decode bench code concurrency** — each concurrent code stream is a different Python task (binary search, LRU, …), starting with its own name so the prompts do not share a prefix. The code warmup is a separate `warmup_noop` prompt, so stream 1 is not a cache hit of the warmup. Concurrency 1 is `binary_search`.

---

## [1.8.6] — 2026-09-01

### Added
- **Prefill benchmark** — sequential context-size sweep (1k–300k) measuring prefill tok/s (`prompt_tokens` ÷ TTFT) and TTFT. Unique prefix per size so prefix-cache does not inflate later runs. Button on the LLM card; persisted last run. Per-size timeout scales with context (90s floor, ~8 ms/token, 45 min cap).
- **DGX Spark CPU temperature** — remote Sparks collect CPU temp over SSH with the same hwmon allowlist as hosts (`acpitz` / `coretemp` / `k10temp` / `zenpower`; NVMe / CX7 filtered out). Overview shows a CPU bar and Spark pages show a CPU row on the GPU panel when the reading is above 0°C.

### Fixed
- **Prefill bench 256k timeout** — per-size cap was 12 minutes (`~3 ms/token`); slow prefills aborted before first token. Now ~8 ms/token with a 45 minute cap, and the error names the limit.
- **Copy results tok/s** — clipboard text now uses one decimal like the decode-bench table (`31.5` not `31`), and TTFT uses the same mean as the table. ([#57](https://github.com/MiaAI-Lab/sparkDash/issues/57))
- **SGLang log spam** — probe current `/server_info` and `/model_info` first; keep the deprecated `/get_*` aliases as fallback so old servers still work. ([#52](https://github.com/MiaAI-Lab/sparkDash/issues/52))

---

## [1.8.5] — 2026-08-28

### Fixed
- **Decode type picker defaults to Structured** — opening the sheet (or loading a previous run) no longer leaves Prose/Code/JSON selected. A still-running job still shows its type.
- **Code workload was prose-speed** — the LRU + "thorough comments" prompt is English with `def` sprinkled in, so DFlash2 accept matched Prose. Code is now `clamp_00`…`clamp_49` identical-shape Python helpers, no comments.

---

## [1.8.4] — 2026-08-28

### Added
- **Decode benchmark type picker** — choose **Structured** (default, count 1→200), **Prose** (lab hash-map explanation), **Code** (fixed LRU-cache Python prompt), or **JSON** (GPU-metrics catalog) before Run. Labels are output types only — no `response_format`, grammars, or guided JSON. Same lab protocol for every type: temp 0, `top_p` 1, thinking off, 32-token warmup, default 400 tokens. The selected type is shown on results and in copied summaries.

---

## [1.8.3] — 2026-08-28

### Changed
- **Decode benchmark uses the lab structured protocol** — count 1→200 (numbers only) instead of the Showcase JSON/YAML catalog + fill-to-max. Temperature **0**, `top_p` **1**, thinking **off**, 32-token warmup, default max tokens **400**. Concurrency 1 is the same prompt as glm-5.3-flash-sm120 `tests/bench_decode.py --structured`; concurrent streams get a unique suffix so they do not share a prefix-cache block.
- **Thinking flags default off** — GLM / Qwen / MiniMax think unless the request disables it. `applyThinkingFlags` now defaults to off and always sends `enable_thinking`, `thinking`, and `thinking_mode`. HTTP 400 retries keep an explicit off payload instead of stripping flags (stripping lets hybrid models think by default). Showcase treats a missing thinking flag as off.

---

## [1.8.2] — 2026-08-23

### Added
- **EXL3 live tok/s** — detect ExLlamaV3 `tools/serve_openai.py` (`owned_by: exl3` or `/health` `{ok, busy}`) instead of mislabeling it as vLLM. Generation and prefill tok/s come from `/health` cumulative token counters (no Prometheus `/metrics`).
- **Tailnet monitoring** — opt-in per unit (`tailscaleMonitoring`, default **off**); `tailscale status --json` on the host and a Tailnet card under Resources. Flags a unit that is healthy on the LAN but off its tailnet. ([#43](https://github.com/MiaAI-Lab/sparkDash/pull/43))
- **NV_ERR_NO_MEMORY on the GPU panel** — count of NVRM `NV_ERR_NO_MEMORY` kernel log lines since boot (shown when > 0). Journal is scanned at most once a minute, not on the 2s poll. Replaces the approach in [#40](https://github.com/MiaAI-Lab/sparkDash/pull/40).

### Security
- **`BIND_HOST` now defaults to `127.0.0.1` (loopback) instead of `0.0.0.0`** — the dashboard is unauthenticated and can SSH into and power off Sparks, so it is no longer reachable on the LAN by default. Set `BIND_HOST` to the host's LAN IP (or `0.0.0.0`) to opt in to remote access. **Migration:** if you access sparkDash from another machine via bare-metal `npm start`, set `BIND_HOST` explicitly. Production and dev Compose both set `BIND_HOST=0.0.0.0` (`network_mode: host`). Startup now also warns when bound to a non-loopback address. ([#35](https://github.com/MiaAI-Lab/sparkDash/pull/35))

### Fixed
- Decode bench `POST /api/sparks/:id/llm/bench` rejects LLM ports that are not in the Spark's configured list (same allowlist as showcase). ([#45](https://github.com/MiaAI-Lab/sparkDash/pull/45))
- **Host CPU temperature** — dedicated GPU hosts (`kind: host`) show CPU temp on the RAM panel and Overview (hidden at 0°C / no sensor). Remote hosts now read hwmon/thermal over SSH. DGX Sparks still do not display CPU temp (remote Sparks still skip the extra sensor SSH). ([#34](https://github.com/MiaAI-Lab/sparkDash/pull/34))

### Changed
- Docker Node base image pulls from `public.ecr.aws/docker/library/node` so Spark builds do not fail on Docker Hub IPv6 `auth.docker.io` / “network is unreachable”. `deploy.sh` prints that workaround if a build still fails.
- README architecture diagram top border aligned with the box. ([#39](https://github.com/MiaAI-Lab/sparkDash/pull/39))

---

## [1.8.1] — 2026-08-16

### Added
- **Daily LLM tok/s history** — busy-sample rollups (peak + mean) for decode and prefill, persisted in `config/llm-daily.json` (30 UTC days). 14-day peak chart on the LLM card; `GET /api/sparks/:id/llm/daily`.
- **Cached vs uncached prefill tok/s** — live rows when the backend splits kinds: ds4 labeled prefill counters, llama.cpp `/slots` `n_prompt_tokens_cache`, SGLang `sglang:cached_tokens_total` (L1 `cache_source="device"`). Combined Prefill stays computed/uncached. vLLM is unchanged (combined prefill + prefix-cache hit rate).

### Changed
- **Docker SSH key auth** — compose comments + README: key auth runs inside the container (`/root/.ssh`), not the host user’s `~/.ssh`. Custom-named keys must be mounted as `id_ed25519` (or set `SSH_IDENTITY_FILE`). LAN IPs are from the sparkDash host. Add/Edit Spark hint when auth is Key.

### Fixed
- SGLang `/metrics` no longer overwrites `/get_server_info` tok/s when both are present.
- llama.cpp `n_prompt_tokens_processed: 0` is not treated as missing (fully cached prompts).

---

## [1.8.0] — 2026-08-15

### Added
- **Non-Spark unit support** (`kind: "host"`) — dedicated GPU hosts (any Linux box with an NVIDIA GPU, e.g. a workstation with an RTX card) are first-class units: added from the **+** button (choose **Dedicated GPU host**), monitored via SSH + `nvidia-smi` exactly like a Spark, but never labeled as a DGX Spark.
- **Detected host hardware** — for `kind: "host"`, the header shows real hardware detected once when online (GPU model, CUDA driver, CPU model/cores, system RAM) instead of fixed GB10 specs.
- **Separate system RAM vs discrete VRAM** — for host units, VRAM comes straight from `nvidia-smi` (`memory.used` / `memory.total`, free = total − used) while system RAM is read from `/proc/meminfo`. Spark behavior is unchanged (GB10 unified HBM pool).
- **RAM panel + Overview RAM bar** — host unit pages get a dedicated RAM panel, and Overview cards show a RAM bar under VRAM for hosts.
- **Host Resources layout** — host unit pages stack **RAM → Network → Storage** in the right column with **GPU** filling the left column (Sparks keep the original layout). CX7 IP is hidden for hosts (Spark-specific NIC).
- **Prefill tok/s** (moved from Unreleased) — live LLM panel sparkline, Overview cards as two columns (**tok/s** | **prefill**), decode-bench **Prefill** column (`prompt_tokens` ÷ TTFT).
- **Live prefill measurement** — vLLM uses engine-step `iteration_tokens_total` surplus over generation (so a short/cached prefill that lands in the same poll as the first decode tokens still counts); prompt/TTFT counters are the fallback because they often only move at first token. ds4 uses computed (not cached) prefill token diffs. Idle returns to 0. Opening a saved chat in the UI does not hit the GPU; prefill is the prompt/KV pass when you send or regenerate.

### Changed
- **Decode benchmark matches Showcase structural** — same prompt catalog and fill-to-max shaping (`min_tokens` / `ignore_eos` / fill suffix); no 4k unique prefill prefix. Temperature **0**, thinking **off** (Showcase defaults are temp 0.7 and thinking off). Default max tokens 512.
- **Update Hermes button is now a permanent, neutral control** — no more toast notifications for Hermes updates. It turns warning-yellow and shows a commit-count badge **only when an update is actually available**; clicking it opens the update dialog (status / pending commits / release notes) as before.
- **Overview "Update Hermes" button** (formerly "Update All") follows the same rule — neutral by default, warning-yellow with a pending-count badge only when ≥1 monitored Spark has an update available. Pressing it now shows a **live progress bar** (x/y Sparks settled, driven by WS per-Spark update status) until every started update finishes.

### Fixed
- **Decode benchmark "Benchmark not found" mid-run** — running jobs lived only in memory, so a `node --watch` / SIGTERM reload dropped them and the dialog poll hit 404. Active benches are now checkpointed to `config/bench-active.json`, finalized on shutdown, and recovered as interrupted on boot; the dialog also recovers via the list endpoint instead of showing a bare 404.

### Removed
- **Toast system** (`useToasts.ts`, `useHermesAlerts.ts`, `components/ui/Toaster.tsx`) — Hermes notifications now live entirely on the header button instead of pop-up toasts.

---

## [1.7.0] — 2026-08-08

### Added
- **Hermes Agent service per Spark** — opt-in `hermesMonitoring` toggle in Edit Spark; when on, sparkDash treats the Hermes Agent CLI (nousresearch/hermes-agent) as installed on that machine
- **Update notifications** — background `hermes update --check` poll (10 min) per monitored Spark; a toast alerts when an update is available
- **One-click update** — `Update Hermes` button in the Spark header and in the update alert toast; runs `hermes update` over SSH (non-interactive), with running/success/error state streamed over WS
- **Hermes status in snapshot** — installed / version / updateAvailable / behindCommits / checkedAt / job status per Spark (`snapshot.hermes`)
- **Toast system** — minimal built-in toast store + Toaster component (no new dependency), reused for Hermes alerts
- **Update confirmation dialog with real content** — clicking Update Hermes (header button or alert toast) opens a modal with **Update now** / **Cancel**. When the update is only commits on `main` (no newer tagged release than what is installed), it shows the **actual pending commits** from git (`HEAD..origin/main`) instead of the latest-release changelog — the full release changelog is shown only when a real version bump exists
- **`GET /api/sparks/:id/hermes/updates`** — update preview: latest release (cached) + installed version + **real pending commits** from git on the Spark + a resolved view; the old `/api/hermes/releases/latest` is superseded
- **Update All** — `POST /api/sparks/hermes/update-all` + Overview button runs `hermes update` on every Spark with Hermes Agent enabled (per-spark start/skip/fail summary; per-spark progress still streamed over WS)
- **`POST /api/sparks/:id/hermes/check`** (force check now) and **`POST /api/sparks/:id/hermes/update`** (background job, 202)

### Changed
- `hermesMonitoring` normalized in Spark config; server boots HermesProbe only when enabled (all roles, local + remote)
- Toast stack renders above modals at `z-index: 10000`

### Fixed
- **Local Spark Hermes runs as the wrong user (root), corrupting the install** — hermes + its git repo belong to the host user, but the local path executed hermes as the container root. That produced git "dubious ownership" failures and, once worked around, wrote root-owned files into the user's tree (tools/*.py, uv.lock, …) and ran `uv pip install` as root — which failed and left `venv/bin/hermes` missing, breaking the `hermes` CLI entirely. The local path now resolves the host user from the host passwd bind mount and drops to that user via `setpriv` (`nsenter` + host mount ns so host git is visible), with a self-healing root-owned-file repair step. Remote SSH already ran as the real user.
- **Broken launcher detection + auto-repair** — when the `hermes` launcher exists but cannot execute (e.g. missing venv entry point), sparkDash now reports "broken install" instead of a false "no update" and the one-click update automatically rebuilds the venv entry point (`uv pip install -e .`), then retries.
- **Stale git lock bricks later updates** — an interrupted `hermes update` can leave `.git/shallow.lock` (or any `*.lock`) behind, making every later fetch fail; leftover `*.lock` files are cleared before each check/update.

---

## [1.6.0] — 2026-08-07

### Added
- **ComfyUI monitoring** — opt-in per Spark (`comfyMonitoring`, default port **8188**); Edit Spark checkbox + inline port field; connectivity Test includes ComfyUI when enabled
- **ComfyUI probe** — `GET /system_stats` + `GET /queue` (job-centric card; no host RAM/VRAM duplicate of GPU/CPU panels)
- **Active / queued jobs** — workflow title, model weight names from the graph, footprint (resolution · steps · sampler · batch · node count)
- **Live progress** — Comfy WebSocket when events are available; elapsed/avg-duration estimate otherwise; progress bar on the running job
- **Last finished job** — status + duration from `/api/jobs` (with `/history` fallback)
- **Cancel / remove** — `POST /api/sparks/:id/comfy/cancel` to interrupt a running job or dequeue a pending one from the card
- **Open ComfyUI** — deep link to `http://{lanIp}:{comfyPort}` (LAN IP preferred over localhost for remote browsers)
- **Overview Comfy chip** — `Comfy · idle` / `run` / `Nq` / muted when unreachable (only when monitoring is on)
- **Model inventory** — checkpoints + LoRAs from `/models/*` (section hidden when both lists are empty)
- **Queue ETA** — estimate from recent job durations × pending (+ progress remainder when known)
- **Collapsible sections** — **Resources** (GPU / CPU / Storage / Network) and **Services** (LLM / ComfyUI); open state persisted in `localStorage`
- **Services layout** — primary LLM + ComfyUI side-by-side when both enabled; +1 extra LLM full-width; +2 extras as a pair; odd leftover full-width

### Changed
- **Compact UI is the default** layout density (`density: "compact"` in settings + CSS/`data-density`); comfortable remains available via Settings
- Spark snapshot includes **`lanIp`** / **`isLocal`** for client deep-links

### Fixed
- Comfy progress WebSocket soft-reconnects on host/port change (no longer permanently closed after `setTarget`)

---

## [1.5.0] — 2026-08-03

### Added
- **GPU thermal throttle meter** — collect NVIDIA `clocks_throttle_reasons` (HW/SW thermal, HW slowdown, SW power cap) plus SM current/max clocks via `nvidia-smi` (local and remote)
- **GPU panel Throttle row** — status chip (`OK` / `Thermal` / `Power` / `HW`) with SM clock bar and tooltip of active reasons
- **Overview thermal hint** — compact red “Thermal throttle” banner when any Spark reports thermal slowdown

---

## [1.4.7] — 2026-08-02

### Added
- **SGLang and DwarfStar (ds4-server) properly supported in LLM probes** — correct backend detection, model/context, and live tok/s for both engines alongside vLLM and llama.cpp
- **ds4-server / DwarfStar LLM probe** — auto-detect Entrpi/ds4-on-spark via `owned_by: ds4.c` or Prometheus `ds4_*` series; model/`context_length` from `/v1/models`; live tok/s from `ds4_tokens_*` counter diffs
- **`llmProbeHost`** — local Sparks probe `127.0.0.1` so loopback-bound servers (ds4 `start.sh` default `--host 127.0.0.1`) are reachable; Showcase / Decode bench / connectivity test use the same host
- **Docker host networking** — compose uses `network_mode: host` so the container can reach host loopback LLM ports

### Fixed
- **SGLang tok/s stuck at 0** — modern SGLang without `total_*_tokens` / `--enable-metrics` now reads `internal_states[].last_gen_throughput`
- **SGLang sticky ~30 tok/s when idle** — only treat `last_gen_throughput` as live after it changes between polls; expire to 0 when it stops moving
- **ds4 window-gauge idle bleed** — do not use `ds4_decode_tok_s` / `ds4_prefill_tok_s` (~60s averages) for the live panel

### Changed
- Backend badge / types include **ds4**; overview labels distinguish ds4 / sgLang / vLLM

---

## [1.4.5] — 2026-07-31

### Fixed
- **SGLang detection** — OpenAI-compatible servers are no longer always labeled vLLM; SGLang is identified via `owned_by` / `/get_server_info`, and HF hub cache model paths are shortened to `org/name` ([#29](https://github.com/MiaAI-Lab/sparkDash/pull/29))
- **Overview model name trim** — long LLM / worker labels wrap instead of ellipsis-truncating in the stats grid

### Changed
- **Decode benchmark concurrencies** — added 5, 10, 12, and 24 ([#27](https://github.com/MiaAI-Lab/sparkDash/pull/27))
- **LLM API key port renames** — keys migrate/prune when ports change; rejected keys show “Bad API key” ([#26](https://github.com/MiaAI-Lab/sparkDash/pull/26))

---

## [1.4.4] — 2026-07-30

### Added
- **Optional per-port LLM API key** — set a Bearer token in LLM panel Settings for OpenAI-compatible gateways (e.g. LiteLLM); stored encrypted like SSH passwords; used by probe, Showcase, and Decode bench ([#21](https://github.com/MiaAI-Lab/sparkDash/issues/21))

### Changed
- **Settings version label** — reads `package.json` version instead of a hardcoded string

---

## [1.4.3] — 2026-07-30

### Added
- **Shutdown confirmation dialog** — Shutdown / Shutdown All open a danger-zone modal requiring a checkbox and typing `poweroff` before powering off ([#22](https://github.com/MiaAI-Lab/sparkDash/issues/22), [#24](https://github.com/MiaAI-Lab/sparkDash/pull/24))

### Changed
- **Decode benchmark results** — dropped Server column; show Aggregate + per-stream tok/s

### Fixed
- **Storage tile height jump** — always show disk ↑/↓ I/O rates (`0 B/s` when idle) so multi-disk panels keep a stable height ([#20](https://github.com/MiaAI-Lab/sparkDash/issues/20), [#23](https://github.com/MiaAI-Lab/sparkDash/pull/23))

---

## [1.4.0] — 2026-07-29

### Added
- **Free storage** — each disk row in the Storage panel now shows available free space (GB) right-aligned next to used/total, and I/O speeds moved to their own row below

---

## [1.3.9] — 2026-07-28

### Added
- **Prompt Showcase prompt types** — **Text** / **Structural** / **Mixed** catalogs (mixed interleaves structural and text) so tok/s can be compared by workload shape; type is stored on runs and shown in History
- **Endpoint security posture badge** — per-LLM-panel green / amber / red hint from unauthenticated `/v1/models` (or `/slots`) reachability plus configured probe-host scope (loopback / LAN / public); tooltip does not claim process bind address ([#17](https://github.com/MiaAI-Lab/sparkDash/issues/17), [#19](https://github.com/MiaAI-Lab/sparkDash/pull/19))
- **Configurable `BIND_HOST`** — HTTP and WebSocket listen address via env (default `0.0.0.0`); documented for Docker bridge vs host-network / reverse-proxy setups ([#18](https://github.com/MiaAI-Lab/sparkDash/pull/18))

### Changed
- **Showcase fills max tokens** — each stream requests a full-length generation (`min_tokens` = `max_tokens`, `ignore_eos`, empty `stop`) plus a hard “do not stop early” prompt suffix; retries once without those fields if the backend returns HTTP 400; per-stream timeout raised to 360s for long fills

### Fixed
- **Live showcase tok/s under-count** — live/peak rates counted SSE deltas (often multi-token chunks on vLLM), so terminals showed ~6 tok/s while streaming then jumped to the real ~25 at completion; now estimate from streamed text (~4 chars/token) using the same first→last token window as final decode tok/s

---

## [1.3.4] — 2026-07-27

### Changed
- **Prompt Showcase model header** — model id shown as a prominent centered banner above the metrics strip (removed from the compact title stack under the spark name)
- **Prompt Showcase density** — tighter config fields/inputs/buttons and ~1px smaller base type for more room for the terminal grid

---

## [1.3.3] — 2026-07-25

### Added
- **Prompt Showcase history** — finished runs are archived to disk (`config/showcase-history.json`, last 20 per Spark); History panel to browse, open a past run (read-only terminals), reuse prompts/settings, or clear history
- **Showcase sampling temperature** — **Temp** control (0–2, default 0.7) before Run; validated server-side and applied to chat completions
- **Open Showcase when LLM is offline** — Showcase button remains available on the LLM panel when no model is loaded on the selected port (view history / stage a run)

### Changed
- **Peak tok/s** — per-terminal peak rate, always-visible aggregate and server peak in the metrics strip; peak included in copy-out

---

## [1.3.1] — 2026-07-24

### Fixed
- **LLM probe `/slots` 404 spam** — once a backend is known to be vLLM or SGLang, skip the llama.cpp `/slots` re-probe on each detect cycle (still probes on first contact / unknown / llama.cpp). Thanks [@kesslerio](https://github.com/kesslerio) ([#16](https://github.com/MiaAI-Lab/sparkDash/pull/16), fixes [#15](https://github.com/MiaAI-Lab/sparkDash/issues/15))

---

## [1.3.0] — 2026-07-23

Major feature release.

### Added
- **LLM Prompt Showcase** — full-page multi-terminal streaming demo (`/showcase/:sparkId`) opened from the LLM panel
  - Up to **32** concurrent chat streams with curated default prompts; optional prompt editor (“Show prompts”)
  - Dense auto-fit terminal grid, brand chrome in the config bar, Hide/Show controls with peek strip (Stop + aggregate tok/s)
  - Aggregate **tok/s** hero from server `/metrics` during the run (peak, tokens, streams)
  - Copy one terminal or copy all as plain text; collapsible reasoning vs answer styling
  - Thinking-flag adapter (`enable_thinking` vs MiniMax `thinking_mode`, with 400 retry)
  - Ephemeral sessions with heartbeat cancel; mutual exclusion vs DecodeBench (409 both ways)
  - Shared streaming helper extracted for DecodeBench + Showcase (`LlmStreaming.js`)

### Changed
- Mid-run: Port / Terminals / Max tokens / Run locked; Stop stays available
- Changing terminal count after a run clears stale streams and rebuilds the grid

---

## [1.23.2] — 2026-07-23

### Added
- **Copy results** on the decode benchmark dialog — clipboard plain-text summary (`model | decode tok/s results:` plus per-concurrency decode/server tok/s, optional peak, TTFT; failed rows included)

---

## [1.23.1] — 2026-07-22

### Fixed
- **Local Spark VRAM lag** — Docker Compose sets `pid: host` so `nvidia-smi` compute-apps sees host GPU processes on each poll (parity with remote SSH Sparks)
- **Stale `gpu-memory.json` override** — a successful live compute-apps result (including cleared **0**) is trusted; the host cron file is backup only when live query is unavailable
- **Unified Memory GPU used** — prefer live compute-apps cache over the cron file; fix cache sum using `vramMB`

---

## [1.23.0] — 2026-07-22

### Added
- **Centralized metrics history store** (`src/hooks/metricsStore.ts`)
  - Single writer from the WebSocket snapshot path; series keyed by `${sparkId}:${metric}`
  - Caps each series at 1800 samples (~1 h at the default 2 s poll); sparklines read a 30-sample tail
  - Survives Spark tab switches (history no longer lives in per-panel `useState`)
  - Offline Sparks skip ingest so frozen hosts do not drag charts to zero
  - Series: `gpu.usage`, `gpu.temp`, `cpu.usage`, `llm:${port}.tps` (multi-port aware)
  - `useSpark` / `getSpark` selective-subscription seam; orphan series pruned when a Spark leaves the WS list

### Changed
- **GPU/CPU sparklines** — Usage and Temperature charts widened (180px)
- **Spark tab pills** — memoize label + online dot only; drag handle stays outside memo so reorder listeners stay fresh

---

## [1.22.6] — 2026-07-22

### Added
- **Compact UI** (Settings toggle; persisted as `density: "comfortable" | "compact"`, default comfortable)
  - Applies `data-density` on `<html>` with CSS tokens for shell/header/page/panel/card spacing, root font size, and tighter radius
  - Overview cards, Spark page grid, Panel padding/title margin, and dashboard header gap all follow density tokens
  - Compact mode pins panel/overview `.text-sm` metric text to 14px

---

## [1.22.5] — 2026-07-22

### Added
- **vLLM LLM panel row 3** (when `backend === "vllm"`)
  - **Prefix Cache** — lifetime hit rate (`prefix_cache_hits_total` ÷ `prefix_cache_queries_total`)
  - **E2E p95** — end-to-end request latency from `e2e_request_latency_seconds`
  - **ITL p95** — inter-token latency from `inter_token_latency_seconds`
  - **MTP Accept** — speculative decode acceptance (`spec_decode_num_accepted_tokens_total` ÷ `spec_decode_num_draft_tokens_total`)
  - Parsed from the same `/metrics` body as existing tiles; tooltips match the row-2 pattern; missing series show **—**

---

## [1.2.2] — 2026-07-22

### Added
- **Benchmark debug traces** (Settings → **Enable debug traces for Benchmark runs**, default **off**)
  - When enabled, each decode-bench wave persists: full stream **prompts**, HTTP status/headers, SSE **completion IDs**, finish reason, token **usage**, content previews (first/last chars — not full output), and ~1 Hz **GPU** samples (util, temp, power, VRAM)
  - Local Sparks sample fresh GPU metrics during the run; remotes use the live snapshot cache (avoids SSH spam)
  - `config.debug: true` is recorded on jobs that ran with traces on

### Changed
- **Decode benchmark dialog UI**
  - Tighter, more consistent padding on the sheet (header / body / footer)
  - Results shown as denser comparison rows: load/TTFT on the left; **Server** and **Decode** tok/s **right-aligned**
  - Column headers on wider screens; clearer status/progress chrome and legend
  - **Max tokens / stream** stacked like Concurrency (label + hint above a compact input) so the field no longer wraps into a crushed column
  - Max-tokens input value **left-aligned**

### Fixed
- **Worker role flipping to Standalone**
  - API fallback tab snapshots no longer hardcode `role: "standalone"` — they copy role / workerLabel / workerHeadId / llmMonitoring from the registry
  - After Edit/save refresh, live WS metrics are kept but role fields are refreshed from the API
  - PATCH with `role: null` / invalid role no longer clobbers a persisted Worker (normalize would otherwise fall through to Standalone)
  - `workerNode: true` without an explicit role promotes to **Worker**; role strings are trimmed/lowercased
  - Unit tests cover coerce/patch edge cases (`server/sparks/__tests__/role-normalize.test.js`)

---

## [1.2.0] — 2026-07-21

### Added
- **Spark roles** (Edit Spark → **Role**): **Head**, **Worker**, **Standalone** (replaces the Worker-node checkbox)
  - **Head** — cluster head; local LLM always monitored; overview/header show a **Head** badge; MiniStat still shows live **vLLM / model id**
  - **Worker** — no local LLM API (card hidden, ports not probed); optional **Worker label** (cluster/model name) and **Head Spark** picker; overview MiniStat shows **Worker** / label; header shows **Worker** + label badges
  - **Standalone** — normal single-node Spark; optional **LLM monitoring** toggle (default on)
- **Standalone LLM monitoring** — when Role is Standalone, enable/disable probing and the LLM card without making the Spark a worker
- Role badges on Overview cards and Spark header (Head / Worker / Standalone)
- Shared `resolveSparkRole` / `isLlmMonitoringEnabled` helpers (`src/api/sparkRole.ts`)

### Fixed
- **Shutdown “Failed to fetch”** — remote shutdown verifies script/`sudo -n`, then backgrounds so SSH returns before the host dies; only mid-session connection drops count as success; local Sparks acknowledge HTTP **before** power-off; Shutdown All does remotes first, local last
- **Docker image build** — drop flaky second-stage `npm ci --omit=dev`; prune in builder and copy `node_modules`; retry on first `npm ci`
- **Worker → Standalone** — switching role back to Standalone re-enables LLM monitoring (worker had forced it off)

### Notes
- `workerNode` remains derived (`role === "worker"`) for existing probe/card checks; prefer `role` in new code.
- Legacy configs with only `workerNode: true` migrate to role **Worker**.
- Thin alternative to contributor PR #9 (`llmCluster` topology) — same overview/worker UX via `workerLabel` + `workerHeadId`.

---

## [1.1.7] — 2026-07-21

### Added
- **vLLM inference tiles** on the LLM panel (shown only when `backend === "vllm"`):
  - **KV Cache** — usage % from Prometheus (`kv_cache_usage_perc`), colour-coded (green / amber / red)
  - **Requests** — running / waiting counts
  - **TTFT p95** — time-to-first-token 95th percentile from histogram quantiles
  - **Preempts** — cumulative preemption counter
- **Info tooltips** (small “i”) next to each of those four metrics
- Histogram parse/quantile helpers in `LlmProbe` with unit tests (`npm test` → `server/collectors/__tests__`)

### Notes
- Metrics use the same single `/metrics` fetch already used for tok/s (no extra HTTP call).
- ITL p95 was considered and omitted to keep the panel readable; TTFT p95 is the latency signal kept.
- Supersedes contributor PR #11 without personal `docker-compose` SSH mounts or `host.docker.internal`.

---

## [1.1.5] — 2026-07-21

### Added
- **LLM decode benchmark**
  - **Run decode benchmark** on each LLM panel (when a model is available)
  - Multi-select **concurrency** levels (`1, 2, 3, 4, 6, 8, 16, 32`); default selection **1, 2**
  - Levels run **one after another**; within a level, N streams fire together
  - Each concurrent stream uses a **distinct JSON/HTML write-style prompt** (higher decode tok/s workloads)
  - Configurable **max tokens per stream** (default **500**, range 64–2048); input allows clearing digits while typing
  - Async jobs: `POST` starts → poll status; one active bench per Spark; cancel supported
  - Results show **Server tok/s** (live-style engine counter samples, same idea as Generation tok/s) and **Per-stream** decode after first token, plus TTFT and stream OK counts
  - Last run **persisted** (`config/bench-history.json`) and restored when reopening the dialog (survives refresh / restart)
  - Mobile-friendly solid sheet (portaled to `document.body`, scrollable body, sticky footer)
- **Remove additional LLM ports** — only non-primary ports show **Remove**; server rejects deleting the first port

### Fixed
- **GB10 GPU used / process list** (unified memory + Docker)
  - Host helper `config/gpu-memory.sh` writes safe JSON: used sum, **MemTotal** as pool size, process list (Python JSON; env-configurable path)
  - `SystemCollector` hydrates process cache from `gpu-memory.json` when in-container `compute-apps` is empty
  - Generated `config/gpu-memory.json` gitignored and no longer tracked
  - Supersedes contributor PR #10 (no machine-specific SSH mounts in compose)
- **Mobile Edit / Add Spark dialogs** — solid max-height sheet, scrollable form, sticky actions, body scroll lock (can reach all fields on phone)

### Notes
- Decode bench hits the real LLM endpoint over LAN; use off-peak for high concurrency.
- Host cron for GPU file (example): `* * * * * /path/to/sparkDash/config/gpu-memory.sh` with `./config` bind-mounted into Docker.

---

## [1.1.0] — 2026-07-20

### Added
- **Power management**
  - Per-Spark **Shutdown** and **Wake** controls in the Spark header
  - Overview **Shutdown All** (online Sparks only) and **Wake All**
  - Shutdown runs over SSH: `sudo -n /usr/local/bin/spark-shutdown` (install that script on each host with passwordless sudo for it)
  - Shared Wake-on-LAN helper (`server/wol.js`): MAC validation, `/24` broadcast from LAN IP (fallback `255.255.255.255`), single-settlement UDP send
- **Wake-on-LAN MAC**
  - Auto-detect MAC of the **enP7s7** interface during network polls (local + remote)
  - Persist as `detectedMacAddress` for use when the node is offline
  - Optional **MAC override** in Edit Spark (`macAddress`); Wake uses override → detected → request body
- **Worker node**
  - Edit Spark checkbox **Worker node** (with info tooltip)
  - When set: LLM panels and “Add LLM port” are hidden; LLM ports are not probed
  - **Worker node** badge in the Spark header
- README notes for power controls and LAN trust model for power APIs

### Notes
- Power APIs are unauthenticated like the rest of the dashboard — keep port **5555** on a trusted network only.

---

## [1.0.5] — 2026-07-20

### Added
- **Multiple LLM ports** — monitor several LLM servers on different ports simultaneously (each port gets its own panel and backend detection)
- **GPU processes** — top GPU processes by VRAM usage (name, PID, memory) in the GPU panel
- **Spark uptime** — system uptime badge inline on each Spark header

### Backend (summary)
- `SparkRegistry`: `llmPorts` array with migration from legacy `llmPort`
- `SparkMonitor`: `Map<port, LlmProbe>` for parallel multi-port polling
- `SystemCollector`: process list via `nvidia-smi`
- API: `PUT` / `POST` / `DELETE` LLM port endpoints

---

## Earlier releases

Versions before **1.0.5** were not recorded in a dedicated changelog. See git history for prior commits (e.g. themes, Docker layout, multi-Spark UI, encrypted SSH secrets).
