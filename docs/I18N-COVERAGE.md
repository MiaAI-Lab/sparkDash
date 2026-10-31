# UI localization coverage

**Snapshot baseline:** `main` at `b96244a2589a2130e80ff1b2b399252934a01154` on 2026-10-31. This is an inventory and update checklist, not a completion metric: passing tests or a successful build do not establish that a page is localized.

## Unified progress index

Keep one progress list while retaining separate, complete-feature pull requests. This inventory tracks all reviews; a pending row does not mean its source is included in every branch. Open status was checked on 2026-10-31; an open PR is implemented work awaiting review, not shipped coverage.

| Scope | Review entry | Status |
| --- | --- | --- |
| Language infrastructure and initial Settings | [#226](https://github.com/MiaAI-Lab/sparkDash/pull/226) | Merged; included in the baseline. |
| Remaining Settings: MQTT, GPU clock and sessions | [#310](https://github.com/MiaAI-Lab/sparkDash/pull/310) | Open, independent Settings review. The former #311 session slice was consolidated here. |
| Navigation and shared shell | [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315) | Open, independent Shell review. |
| Overview page and fleet controls | [#316](https://github.com/MiaAI-Lab/sparkDash/pull/316) | Open, independent Overview review. |
| Spark detail GPU, CPU and memory | [#317](https://github.com/MiaAI-Lab/sparkDash/pull/317) | Open, resource-panel review with separate CPU/memory and GPU commits. |
| Spark detail LLM live panel and sessions | [#318](https://github.com/MiaAI-Lab/sparkDash/pull/318) | Open, independent review; metrics/help, endpoint settings, benchmark entry controls and sessions. Charts/totals and benchmark dialogs remain separate. |
| Spark detail LLM history, daily statistics and token totals | [#319](https://github.com/MiaAI-Lab/sparkDash/pull/319) | Open, independent review; chart presentation, daily tooltips/accessibility and cumulative token table/range labels. |
| Fleet Reports | [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320) | Implemented; pending maintainer review, not merged or deployed. |
| Device Setup | [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321) | Implemented; pending maintainer review, not merged or deployed. |
| Spark Details | [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322) | Implemented; pending maintainer review, not merged or deployed. |
| Benchmarks | [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323) | Implemented; pending maintainer review, not merged or deployed. |
| Showcase | [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324) | Implemented; pending maintainer review, not merged or deployed. |
| Server Messages | [#325](https://github.com/MiaAI-Lab/sparkDash/pull/325) | Implemented; pending maintainer review, not merged or deployed. |

[#194](https://github.com/MiaAI-Lab/sparkDash/pull/194) stays open as the original integration and server-message design reference, per the maintainer's [latest direction](https://github.com/MiaAI-Lab/sparkDash/pull/194#issuecomment-6517707651). It is not an active merge target. Do not rebase it or count its broad translation work as shipped. Its historical content would remain accessible after closure, but the maintainer explicitly requested an open reference; revisit its status when that reference has an agreed replacement.

When a page PR merges, update its row and the detailed inventory together. Keep all already-merged namespaces and newer coverage rows when resolving shared loader, README, changelog or inventory conflicts.

## Spark detail merge order

Recommended order: [#317](https://github.com/MiaAI-Lab/sparkDash/pull/317) → [#318](https://github.com/MiaAI-Lab/sparkDash/pull/318) → [#319](https://github.com/MiaAI-Lab/sparkDash/pull/319). This records the integration plan; the PRs remain separate reviews against `main`. The documentation follow-up does not merge, rebase or deploy them. Keep #194 open and unchanged as the server-message design reference.

| Step | Scope | `spark` prefixes to retain in both locales |
| --- | --- | --- |
| #317 | GPU, CPU and memory panels | `cpu`, `ram`, `memory`, `gpu`, `gpuChart`, `processes` |
| #318 | LLM live controls and sessions | All #317 keys plus `llm`, `sessions` |
| #319 | LLM history, daily statistics and token totals | All earlier keys plus `llmTrend`, `llmDaily`, `llmTokens` |

After each predecessor is merged by the maintainer, update the next PR from the resulting `main` and resolve its remaining diff. The pairwise conflicts are in `CHANGELOG.md`, `README.md`, this inventory and the two `spark.json` catalogs; the shared loader registration is identical in these three branches. Treat a different conflict set after upstream changes as a new review point.

- **Catalogs:** combine the English and `zh-CN` objects by key, preserving every prefix above and any newer main keys. Never resolve these add/add conflicts by selecting an entire side. Check duplicate keys and interpolation parameters with `npm run i18n:check` after the actual source resolution.
- **Loader:** keep one `enSpark` import, one `zhSpark` import, one `spark` resource per locale and one `spark` namespace entry. Preserve `settings`, `language` and any already-merged `shell`/`overview` registrations.
- **README and CHANGELOG:** combine the actual shipped coverage and keep each PR's own credited entry. Retain newer upstream wording and avoid duplicate section headings.
- **Progress inventory:** use the latest complete index (currently the version in #325) as the starting point, preserving newer rows. Mark only PRs actually merged as **Merged**, with their verified revision; retain the other **Pending** / **Not wired** boundaries. Update branch-specific namespace wording to match the resulting main.
- **Ignore rules:** retain `docs/` for nested documentation, reopen only the root directory with `!/docs/`, then use `/docs/*` and `!/docs/I18N-COVERAGE.md` to allow-list this one file. Other untracked documentation remains ignored. No further `git add -f` is needed for this inventory.

The branches share files but their catalog prefixes do not overlap. Other pending page PRs (#310, #315 and #316) remain separate; preserve their merged namespaces and coverage when resolving common files. After a future source-conflict resolution, validate the catalog, typecheck and affected locale regressions once, extending checks only for additional source changes or failures. For this documentation/ignore-only follow-up, verify the allow-list, links, clean diff and unchanged source/dependency trees; do not repeat the full runtime suites.

## Remaining-feature review order and scope

The six remaining groups are independent reviews against `b96244a`. Their shared loader, README, changelog and this inventory must be combined by namespace or entry rather than choosing one whole side. Keep all prior #310/#315–#319 work. The benchmark group keeps Decode, Prefill, Quality, Tool Eval and their share-card interfaces together.

Suggested remaining-group order: fleet reports → device setup → Spark details → benchmarks → Showcase → server messages. Fleet reports and Spark details also change `EventRow.tsx` and `SparkActions.tsx`; the server-message review deliberately contains only descriptor integration on baseline UI. When integrating it last, preserve the earlier translated chrome and add its metadata handling. It also shares `HealthFindings.tsx` with #316: retain the existing translated chrome or deduplicate it by static keys while adding descriptor rendering. No PR is merged by this migration.

## Scope and conventions

This branch owns **fleet reports**, using `statistics`, `activity`, alongside the baseline `settings` and `language` namespaces. Token totals, cost comparison, energy and monthly archives, temperature charts, activity filters/exports and kiosk presentation now use English and Simplified Chinese catalogs. Locale changes retain selected ranges, filters, graph geometry, pending clears and raw event details.

English catalogs are the source/fallback. Reuse the single loader in `src/i18n/index.ts`, static keys and ordinary i18next interpolation/plurals. Do not translate user data, IDs, protocol values, commands, URLs, raw logs or model/product names. #194 remains the unchanged integration/design reference; current main remains the implementation base.

## Validation record (2026-10-31)

The combined local candidate `2a16e5a` passed 800 frontend tests. Follow-up `48dbf89` preserves unknown response shapes and uses static Showcase keys; its affected regressions, typecheck, catalog checks and production build passed. Split branches received catalog/type checks and focused extraction regressions; each PR records its own counts.

**Linux server validation completed:** the complete `npm run test:server` suite passed **1,433/1,433**, with **0 failures and 0 skips**, on the combined `48dbf89` source. It ran once in an isolated Debian Bookworm container with Node 24.19.0, Python 3, zsh and util-linux, using `--init`, no network, temporary configuration and a fresh dependency install. The server tree is identical to #325; the other five feature PRs do not change server code. This closes the earlier Linux validation gap. The earlier Windows `npm test` attempt remains an incomplete run, not a separate full-suite pass.

**Representative browser acceptance completed:** Chrome 156, English and Simplified Chinese, at 1440 x 1000 and 390 x 1000, using real components and production styles with local mocked responses. The same mounted surfaces were switched between locales, producing 32 page/locale/width captures. No page-level horizontal overflow or browser exceptions were observed. Wide token tables retain their intentional internal horizontal scroll. The real language selector persisted the choice and did not repeat token data requests; a 390 x 844 device-dialog check confirmed the footer can be scrolled into view and focused.

| Review | Representative surface checked | Retained behavior |
| --- | --- | --- |
| #320 Fleet Reports | Token totals, expanded activity, monthly energy | Token range/grouping and raw model identity; expanded raw event details; estimated energy and coverage wording |
| #321 Device Setup | Add Spark connection form | Pending LAN address and raw SSH values across locale changes |
| #322 Spark Details | Model launcher configuration | Pending model name and directory path |
| #323 Benchmarks | Tool Eval setup and command preview | Custom URL/model drafts, raw command; locale switching did not issue another preview request |
| #324 Showcase | Configuration and pending terminal grid | Raw model names, prompt text and pending state |
| #325 Server Messages | Health chips/list and terminal feedback | Known translated health descriptors; raw output, reasoning and external diagnostics |

Browser acceptance found a Token totals grammar regression (`7 day` / `24 hour`). #320 follow-up `27a8631` uses ordinary i18next counted plurals while preserving singular per-unit labels. A regression reproduced the failure before the fix; both affected locale tests then passed, along with typecheck, catalog validation, production build and diff checks. The same frontend fix was applied to the combined candidate for the final browser check. The shared language-selector help now says the setting applies to translated pages, replacing the outdated Settings-only wording without claiming complete site coverage. The backend is unchanged, so the Linux suite was not repeated.

This is representative page acceptance, not exhaustive coverage of every dialog, theme, error state or real-device workflow. No real connection check, benchmark, model launch, production traffic, merge or deployment was used.

## Status legend and known slices

| Status | Meaning |
| --- | --- |
| **Foundation merged (#226)** | Wired to the shipped language infrastructure; only the explicitly named surface is covered. |
| **Pending (#310)** | Included in the separate Settings PR, but not in the baseline `main`; update this document when merged. |
| **Pending (#315)** | Included in the separate Shell PR, but not in the baseline `main`. |
| **Pending (#316)** | Included in the separate Overview PR, but not in the baseline `main`. |
| **Pending (#317)** | Included in the separate resource-panel PR, but not in the baseline `main`. |
| **Pending (#318)** | Included in the separate live LLM panel/session PR, but not in the baseline `main`. |
| **Pending (#319)** | Implemented in the separate #319 review; covers the LLM history/daily charts and cumulative token table, not separate dialogs or a merged `main` claim. |
| **Not wired** | No page-level catalog/wiring claim in this snapshot. |

| Slice | Status | Boundary |
| --- | --- | --- |
| Language selection | **Foundation merged (#226)** | [`LanguageSelector`](../src/components/LanguageSelector.tsx), the locale bootstrap, persistence and English fallback. |
| Settings rows and browser alerts | **Foundation merged (#226)** | Most existing Settings row text plus [`BrowserAlertsSettings`](../src/components/BrowserAlertsSettings.tsx); retain its browser-only permission feedback. |
| MQTT and fleet GPU clock | **Pending (#310)** | Settings MQTT text and [`FleetGpuClock`](../src/components/FleetGpuClock.tsx) are not a `main` claim until #310 merges. |
| Session age and Harness Sessions entry | **Pending (#310)** | Settings labels/help/preset labels and the entry action only. This does **not** localize [`HarnessWizard`](../src/components/HarnessWizard.tsx). |
| Navigation and shared shell | **Pending (#315)** | Desktop/sidebar and mobile navigation, command palette and its commands, theme/open-access/connection/error/install UI, plus App-owned empty/error text. Benchmark navigation only; page bodies and standalone dialogs remain separate slices. Fleet shutdown is pending in #316. |
| Spark resource panels | **Pending (#317)** | GPU metrics and history-chart controls, CPU, system RAM, unified memory and the shared process table. Shared VRAM breakdown content is pending in #316; other detail panels remain separate below. |
| LLM live panel and sessions | **Pending (#318)** | Live metric labels/help, engine state, port/API-key settings, local/remote benchmark entry controls and session rows. Server posture/diagnostics remain raw; charts, totals and benchmark dialogs remain separate. |
| LLM history, daily statistics and token totals | **Pending (#319)** | Chart headings, legends, scale guidance, keyboard/hover tooltips, range labels and cumulative token wording. Preserve dates, graph geometry, range values, polling and cache-split accounting. |

## Inventory

The route inventory comes from [`App.tsx`](../src/App.tsx), [`useRoute.ts`](../src/hooks/useRoute.ts), [`constants.ts`](../src/constants.ts), and both navigation shells ([desktop](../src/components/shell/AppSidebar.tsx) / [narrow](../src/components/shell/MobileTabBar.tsx)). “Not wired” means the page needs its own namespace/keys and review; it does not mean every string in it has been manually counted.

### Navigable screens

| Surface and route | Primary source | Status / next page-sized slice |
| --- | --- | --- |
| Overview `/` | [`OverviewPage`](../src/components/OverviewPage/OverviewPage.tsx) and its cards | **Pending (#316)** — headings, filters, unit/memory cards, inline launcher controls, fleet KPIs, energy/token/traffic cards, local alert text, activity controls, and fleet action/confirmation feedback. Raw events, server-only findings and diagnostics remain unchanged. |
| Spark detail `/spark/:id` | [`SparkPage`](../src/components/SparkPage/SparkPage.tsx) and panels | **Pending (#317)** for resource panels; **Pending (#318)** for the live LLM panel and session list; **Pending (#319)** for LLM history/daily charts and cumulative token totals. Shared VRAM breakdown content is pending in #316. Remaining panels are implemented in the Spark-details review below; all reviews are still pending. |
| Token totals `/tokens` | [`TokensPage`](../src/components/TokensPage/TokensPage.tsx) | **Pending [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Cost compare `/cost` | [`CostPage`](../src/components/CostPage/CostPage.tsx) | **Pending [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Fleet energy `/energy` | [`EnergyPage`](../src/components/EnergyPage/EnergyPage.tsx) | **Pending [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Temps `/temps` | [`TempsPage`](../src/components/TempsPage/TempsPage.tsx) | **Pending [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Activity `/activity` | [`ActivityPage`](../src/components/ActivityPage/ActivityPage.tsx) and [`EventRow`](../src/components/ActivityPage/EventRow.tsx) | **Pending [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)** — preserve event payloads/raw diagnostics. |
| Embedded showcase `/showcase` | [`ShowcaseView`](../src/components/ShowcasePage/ShowcaseView.tsx) | **Pending [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324)**. |
| Full-screen showcase `/showcase/:sparkId` | [`ShowcasePage`](../src/components/ShowcasePage/ShowcasePage.tsx) | **Pending [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324)** — preserve prompts, streamed output and session data. |
| Kiosk `/kiosk` | [`KioskPage`](../src/components/KioskPage/KioskPage.tsx) | **Pending [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)** — wall controls and card presentation localized; full visual acceptance remains pending. |
| Decode benchmark `/bench/decode` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`DecodeBenchPage`](../src/components/bench/sparkdash/DecodeBenchPage.tsx) | **Pending [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**. |
| Prefill benchmark `/bench/prefill` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`PrefillBenchPage`](../src/components/bench/sparkdash/PrefillBenchPage.tsx) | **Pending [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**. |
| Quality benchmark `/bench/quality` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`QualityBenchPage`](../src/components/bench/sparkdash/QualityBenchPage.tsx) | **Pending [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**. |
| Tool Eval Bench `/bench/tool-eval` | [`ToolEvalBenchPage`](../src/components/bench/tooleval/ToolEvalBenchPage.tsx) | **Pending [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)** — treat setup, live run, results and history as one feature slice. |

### Spark detail: panel-sized review batches

Each row is a reviewable surface. #317 groups the related GPU, CPU and memory rows; #318 handles live controls and sessions; #319 covers LLM charts and token totals. Keep English fallback and all existing `spark` prefixes; the remaining panels use the separate `hardware` namespace. These batches do not mark the entire detail page as localized.

| Surface | Primary source | Status / boundary |
| --- | --- | --- |
| Header, unit actions and page-level port controls | [`SparkHeader`](../src/components/SparkPage/SparkHeader.tsx), [`SparkActions`](../src/components/SparkPage/SparkActions.tsx), [`SparkPage`](../src/components/SparkPage/SparkPage.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — retain raw host identity, diagnostics, port values and action payloads. Shared confirmation controls are pending in #316. |
| CPU, system RAM and unified memory | [`CpuPanel`](../src/components/SparkPage/CpuPanel.tsx), [`RamPanel`](../src/components/SparkPage/RamPanel.tsx), [`UnifiedMemoryPanel`](../src/components/SparkPage/UnifiedMemoryPanel.tsx) | **Pending (#317)** — labels, sensor provenance/help, core count, memory split legend/tooltips/accessibility, pressure and waiting states. Sensor/model values, metric history, units and split calculations stay unchanged. |
| GPU metrics and charts | [`GpuPanel`](../src/components/SparkPage/GpuPanel.tsx), [`GpuHistoryChart`](../src/components/SparkPage/GpuHistoryChart.tsx) | **Pending (#317)** for single-/multi-card metrics, thermal/throttle states, memory availability/allocation-error labels, shared process-table headings, chart windows, view/metric selectors, legends, axes, accessibility and collecting state. Locale switches preserve selected data, storage values, backfill and curve geometry. Raw device/process names, commands and PIDs stay intact. The shared `VramBreakdownBar` legends/tooltips remain pending in #316; this PR does not duplicate them. |
| LLM live metrics, controls and sessions | [`LlmPanel`](../src/components/SparkPage/LlmPanel.tsx), [`ConversationList`](../src/components/SparkPage/ConversationList.tsx) | **Pending (#318)** — metrics/help, engine and idle states, port/API-key settings with local validation, benchmark launch/remote-target controls, session age/state/context tooltips and empty/add controls. Preserve mean versus percentile semantics, missing versus zero readings, cached versus computed rates, draft values, targets/navigation and raw model/session identity. Server posture labels/details and API diagnostics remain unchanged. The translated Harness entry opens the wizard covered by the pending device-setup review. |
| LLM history, daily statistics and token totals | [`LlmTrendChart`](../src/components/SparkPage/LlmTrendChart.tsx), [`LlmDailyChart`](../src/components/SparkPage/LlmDailyChart.tsx), [`LlmTokenTotals`](../src/components/SparkPage/LlmTokenTotals.tsx) | **Pending (#319)** — headings/legends, fixed-window and busy-average guidance, daily scale/accessibility/keyboard/hover tooltips, no-sample states, cumulative table/range labels and token-row details. Locale switches retain active day, focus, selected range, in-flight reads, data geometry, per-series scales and raw model IDs. Original UTC date strings, compact units, polling dependencies, ledger versus engine counters and cached/computed/unreported accounting remain unchanged. |
| Model scripts and output | [`LlmModelsPanel`](../src/components/SparkPage/LlmModelsPanel.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — include controls and progress/error feedback; preserve script names, paths and terminal output. |
| Storage | [`StoragePanel`](../src/components/SparkPage/StoragePanel.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — include device/refresh controls; preserve device names and poll-mode values. |
| Network and interconnects | [`NetworkPanel`](../src/components/SparkPage/NetworkPanel.tsx), [`RocePanel`](../src/components/SparkPage/RocePanel.tsx), [`TailscalePanel`](../src/components/SparkPage/TailscalePanel.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — preserve interface names, addresses and connection state. |
| ComfyUI | [`ComfyPanel`](../src/components/SparkPage/ComfyPanel.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — include job controls/status; preserve job names and workflow data. |
| Metric history | [`HistoryPanel`](../src/components/SparkPage/HistoryPanel.tsx), [`HistoryChart`](../src/components/SparkPage/HistoryChart.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — retain selected range, measured gaps and chart units. |

### Shared shell, Settings, and separate dialogs

| Surface | Primary source | Status / boundary |
| --- | --- | --- |
| Desktop sidebar, mobile tab/sheets, command palette, install prompt, theme/open-access/connection and error UI | [`AppSidebar`](../src/components/shell/AppSidebar.tsx), [`MobileTabBar`](../src/components/shell/MobileTabBar.tsx), [`CommandPalette`](../src/components/shell/CommandPalette.tsx), [`InstallPrompt`](../src/components/shell/InstallPrompt.tsx), [`src/components/ui/`](../src/components/ui/) | **Pending (#315)** — retains Spark names, telemetry, raw errors, keyboard shortcuts and English command aliases. The shared ShutdownAll control and its confirmations are pending in #316; remaining unit actions stay separate. |
| Settings dialog | [`SettingsDialog`](../src/components/SettingsDialog.tsx) | **Foundation merged (#226)** for its existing catalog-backed rows and language selector. **Pending (#310)** for MQTT, fleet GPU clock, Session age labels/presets and the Harness Sessions entry only. |
| Browser notification preferences | [`BrowserAlertsSettings`](../src/components/BrowserAlertsSettings.tsx) | **Foundation merged (#226)**; keep permission/unsupported/insecure feedback and browser-local persistence behavior. |
| Add/Edit Spark | [`AddSparkDialog`](../src/components/AddSparkDialog.tsx), [`EditSparkDialog`](../src/components/EditSparkDialog.tsx) | **Pending [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**; include validation, SSH/connection feedback and embedded per-unit GPU clock UI. |
| Harness setup wizard | [`HarnessWizard`](../src/components/HarnessWizard.tsx) | **Pending [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**. Its five steps and check/review feedback are included in device setup; route data and helper diagnostics remain raw. |
| Alert notification configuration | [`AlertsDialog`](../src/components/AlertsDialog.tsx) | **Pending [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**; preserve endpoint values, tokens and raw delivery errors. |
| Access token prompt | [`AccessTokenDialog`](../src/components/AccessTokenDialog.tsx) | **Pending [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**; keep token content and server response text unchanged. |
| Hermes update | [`HermesUpdateDialog`](../src/components/SparkPage/HermesUpdateDialog.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)**. |
| Benchmark run dialogs | [`BenchmarkDialog`](../src/components/SparkPage/BenchmarkDialog.tsx), [`PrefillBenchDialog`](../src/components/SparkPage/PrefillBenchDialog.tsx), [`QualityBenchDialog`](../src/components/SparkPage/QualityBenchDialog.tsx) | **Pending [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**; preserve prompts, benchmark parameters, IDs and result payloads. |
| LLM launch and unit actions | [`LlmLauncherDialog`](../src/components/SparkPage/LlmLauncherDialog.tsx), [`SparkActions`](../src/components/SparkPage/SparkActions.tsx), [`ConfirmShutdownDialog`](../src/components/ConfirmShutdownDialog.tsx), [`ShutdownAll`](../src/components/ShutdownAll.tsx) | **Pending (#316)** for inline Overview launcher controls, fleet shutdown and shared confirmation controls. **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** for the launcher configuration dialog and single-unit action prompts. |
| LLM terminal output | [`LlmModelsPanel`](../src/components/SparkPage/LlmModelsPanel.tsx) | **Pending [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)**; translate modal controls such as **Close output**, while preserving commands and raw terminal output. |

The pending Overview PR #316 also includes shared VRAM tooltips, health-chip controls, activity widgets, restart and shutdown confirmation controls. Their translated text follows the locale wherever reused; this does not mark the surrounding Spark detail, Energy, Activity or other page as localized. The resource panels in #317 share the process-table headings. Full localization of their detailed VRAM breakdown also requires the shared component work in #316; neither PR marks other Spark detail panels as complete.

## Server-authored display messages

Status: **Pending [#325](https://github.com/MiaAI-Lab/sparkDash/pull/325)**. Optional API descriptors cover known top-level responses; nested batch entries retain their original text. Health titles/hints and bounded known details are translated; unknown details stay raw. Activity summaries can render descriptors while expanded messages/data preserve the original. Power feedback retains descriptors in state so changing language does not repeat the action. Other API consumers keep their original raw-error display until explicitly wired; this batch does not claim arbitrary server text is translated.

## Per-page acceptance and update checklist

Use this for each feature review. Mark implementation as Pending when submitted; mark shipped coverage only after a verified merge.

- [ ] Give the surface a namespace or coherent key prefix; add identical key shapes to English and `zh-CN`, with English remaining the fallback/source.
- [ ] Move every visible and accessible UI string in scope: headings, labels, button text, placeholders, titles, `aria-*` text, empty/loading states, validation and success/failure feedback.
- [ ] Preserve raw diagnostics, user data, IDs, protocols, commands, URLs and product/model names; do not translate values merely because adjacent labels are translated.
- [ ] Switch English → `zh-CN` → English while the surface is mounted. Verify the selected locale, accessible text and any browser-local preference; for editable forms, verify the locale round-trip does not discard pending input.
- [ ] Exercise success, disabled/pending/loading and failure feedback that the slice owns, including permission feedback where applicable.
- [ ] Add or update focused regression coverage, then run `npm test`, `npm run typecheck` and `npm run build` before submitting the slice.
- [ ] Inspect desktop and narrow/mobile layouts (including dialog/sheet focus behavior where relevant) in both locales.
- [ ] After merge, change the relevant **Pending** rows to **Merged**, record the PR number and verified revision, and leave unrelated rows **Not wired**.

## Maintenance notes

When adding a route, page entry point, or independent dialog, add it to the appropriate table in the same change. When a UI feature moves between files, update its source link rather than treating the old path as coverage evidence. The route and shell files above are the inventory starting point; component tests remain behavior evidence, not a substitute for reviewing all localized states.
