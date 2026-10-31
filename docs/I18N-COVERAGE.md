# UI localization coverage

**Snapshot baseline:** `main` at `b96244a2589a2130e80ff1b2b399252934a01154` on 2026-10-31. This is an inventory and update checklist, not a completion metric: passing tests or a successful build do not establish that a page is localized.

## Unified progress index

Keep one progress list while retaining separate, page-sized pull requests. Open status was checked on 2026-10-31; an open PR is implemented work awaiting review, not shipped coverage.

| Scope | Review entry | Status |
| --- | --- | --- |
| Language infrastructure and initial Settings | [#226](https://github.com/MiaAI-Lab/sparkDash/pull/226) | Merged; included in the baseline. |
| Remaining Settings: MQTT, GPU clock and sessions | [#310](https://github.com/MiaAI-Lab/sparkDash/pull/310) | Open, independent Settings review. The former #311 session slice was consolidated here. |
| Navigation and shared shell | [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315) | Open, independent Shell review. |
| Overview page and fleet controls | [#316](https://github.com/MiaAI-Lab/sparkDash/pull/316) | Open, independent Overview review. |
| Spark detail GPU, CPU and memory | [#317](https://github.com/MiaAI-Lab/sparkDash/pull/317) | Open, resource-panel review with separate CPU/memory and GPU commits. |
| Spark detail LLM live panel and sessions | [#318](https://github.com/MiaAI-Lab/sparkDash/pull/318) | Open, independent review; metrics/help, endpoint settings, benchmark entry controls and sessions. Charts/totals and benchmark dialogs remain separate. |
| Spark detail LLM history, daily statistics and token totals | [#319](https://github.com/MiaAI-Lab/sparkDash/pull/319) | Open, independent review; chart presentation, daily tooltips/accessibility and cumulative token table/range labels. |
| Other detail panels, pages and dialogs | Inventory and panel batches below | Not yet wired unless explicitly marked otherwise. |

[#194](https://github.com/MiaAI-Lab/sparkDash/pull/194) stays open as the original integration and server-message design reference, per the maintainer's [latest direction](https://github.com/MiaAI-Lab/sparkDash/pull/194#issuecomment-6517707651). It is not an active merge target. Do not rebase it or count its broad translation work as shipped. Its historical content would remain accessible after closure, but the maintainer explicitly requested an open reference; revisit its status when that reference has an agreed replacement.

When a page PR merges, update its row and the detailed inventory together. Keep all already-merged namespaces and newer coverage rows when resolving shared loader, README, changelog or inventory conflicts.

## Scope and conventions

The English catalogs are the source and fallback, initialized in [`src/i18n/index.ts`](../src/i18n/index.ts). This branch registers [`settings`](../src/locales/en/settings.json), [`language`](../src/locales/en/language.json) and [`spark`](../src/locales/en/spark.json), with matching `zh-CN` files. Its `spark` keys cover `llmTrend`, `llmDaily` and `llmTokens`; retain the resource-panel keys from #317 and `llm`/`sessions` from #318 when merging. The separate Shell and Overview namespaces are pending in [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315) and [#316](https://github.com/MiaAI-Lab/sparkDash/pull/316). Translate visible product UI, accessible names, validation/help/empty/loading and success/failure feedback. Do **not** translate raw server diagnostics, user-supplied text, IDs, protocol values, commands, URLs, or product and model names unless a product decision explicitly says otherwise.

The first integration is deliberately page-sized. Follow the maintainer's [page-sized direction](https://github.com/MiaAI-Lab/sparkDash/pull/194#issuecomment-6517707651): keep #194 open and unchanged as an integration/translation reference, including its server-message design. Do not rebase it, revive the broad integration, or describe it as merged.

## Status legend and known slices

| Status | Meaning |
| --- | --- |
| **Foundation merged (#226)** | Wired to the shipped language infrastructure; only the explicitly named surface is covered. |
| **Pending (#310)** | Included in the separate Settings PR, but not in the baseline `main`; update this document when merged. |
| **Pending (#315)** | Included in the separate Shell PR, but not in the baseline `main`. |
| **Pending (#316)** | Included in the separate Overview PR, but not in the baseline `main`. |
| **Pending (#317)** | Included in the separate resource-panel PR, but not in the baseline `main`. |
| **Pending (#318)** | Included in the separate live LLM panel/session PR, but not in the baseline `main`. |
| **Pending (#319)** | Implemented in this change; covers the LLM history/daily charts and cumulative token table, not separate dialogs or a merged `main` claim. |
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
| Spark detail `/spark/:id` | [`SparkPage`](../src/components/SparkPage/SparkPage.tsx) and panels | **Pending (#317)** for resource panels; **Pending (#318)** for the live LLM panel and session list; **Pending (#319)** for LLM history/daily charts and cumulative token totals. Shared VRAM breakdown content is pending in #316. Remaining areas are **Not wired**; see the panel-sized breakdown below. |
| Token totals `/tokens` | [`TokensPage`](../src/components/TokensPage/TokensPage.tsx) | **Not wired**. |
| Cost compare `/cost` | [`CostPage`](../src/components/CostPage/CostPage.tsx) | **Not wired**. |
| Fleet energy `/energy` | [`EnergyPage`](../src/components/EnergyPage/EnergyPage.tsx) | **Not wired**. |
| Temps `/temps` | [`TempsPage`](../src/components/TempsPage/TempsPage.tsx) | **Not wired**. |
| Activity `/activity` | [`ActivityPage`](../src/components/ActivityPage/ActivityPage.tsx) and [`EventRow`](../src/components/ActivityPage/EventRow.tsx) | **Not wired** — preserve event payloads/raw diagnostics. |
| Embedded showcase `/showcase` | [`ShowcaseView`](../src/components/ShowcasePage/ShowcaseView.tsx) | **Not wired**. |
| Full-screen showcase `/showcase/:sparkId` | [`ShowcasePage`](../src/components/ShowcasePage/ShowcasePage.tsx) | **Not wired** — preserve prompts, streamed output and session data. |
| Kiosk `/kiosk` | [`KioskPage`](../src/components/KioskPage/KioskPage.tsx) | **Not wired** — desktop-like wall and narrow behavior need separate visual checks. |
| Decode benchmark `/bench/decode` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`DecodeBenchPage`](../src/components/bench/sparkdash/DecodeBenchPage.tsx) | **Not wired**. |
| Prefill benchmark `/bench/prefill` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`PrefillBenchPage`](../src/components/bench/sparkdash/PrefillBenchPage.tsx) | **Not wired**. |
| Quality benchmark `/bench/quality` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`QualityBenchPage`](../src/components/bench/sparkdash/QualityBenchPage.tsx) | **Not wired**. |
| Tool Eval Bench `/bench/tool-eval` | [`ToolEvalBenchPage`](../src/components/bench/tooleval/ToolEvalBenchPage.tsx) | **Not wired** — treat setup, live run, results and history as one feature slice. |

### Spark detail: panel-sized review batches

Each row is a reviewable surface. #317 groups the related GPU, CPU and memory rows; #318 handles live controls and sessions; #319 covers LLM charts and token totals. Keep the English fallback and one shared `spark` namespace; add coherent key prefixes as panels are wired. These batches do not mark the entire detail page as localized.

| Surface | Primary source | Status / boundary |
| --- | --- | --- |
| Header, unit actions and page-level port controls | [`SparkHeader`](../src/components/SparkPage/SparkHeader.tsx), [`SparkActions`](../src/components/SparkPage/SparkActions.tsx), [`SparkPage`](../src/components/SparkPage/SparkPage.tsx) | **Not wired** — retain raw host identity, diagnostics, port values and action payloads. Shared confirmation controls are pending in #316. |
| CPU, system RAM and unified memory | [`CpuPanel`](../src/components/SparkPage/CpuPanel.tsx), [`RamPanel`](../src/components/SparkPage/RamPanel.tsx), [`UnifiedMemoryPanel`](../src/components/SparkPage/UnifiedMemoryPanel.tsx) | **Pending (#317)** — labels, sensor provenance/help, core count, memory split legend/tooltips/accessibility, pressure and waiting states. Sensor/model values, metric history, units and split calculations stay unchanged. |
| GPU metrics and charts | [`GpuPanel`](../src/components/SparkPage/GpuPanel.tsx), [`GpuHistoryChart`](../src/components/SparkPage/GpuHistoryChart.tsx) | **Pending (#317)** for single-/multi-card metrics, thermal/throttle states, memory availability/allocation-error labels, shared process-table headings, chart windows, view/metric selectors, legends, axes, accessibility and collecting state. Locale switches preserve selected data, storage values, backfill and curve geometry. Raw device/process names, commands and PIDs stay intact. The shared `VramBreakdownBar` legends/tooltips remain pending in #316; this PR does not duplicate them. |
| LLM live metrics, controls and sessions | [`LlmPanel`](../src/components/SparkPage/LlmPanel.tsx), [`ConversationList`](../src/components/SparkPage/ConversationList.tsx) | **Pending (#318)** — metrics/help, engine and idle states, port/API-key settings with local validation, benchmark launch/remote-target controls, session age/state/context tooltips and empty/add controls. Preserve mean versus percentile semantics, missing versus zero readings, cached versus computed rates, draft values, targets/navigation and raw model/session identity. Server posture labels/details and API diagnostics remain unchanged. The translated Harness entry opens the still-untranslated wizard. |
| LLM history, daily statistics and token totals | [`LlmTrendChart`](../src/components/SparkPage/LlmTrendChart.tsx), [`LlmDailyChart`](../src/components/SparkPage/LlmDailyChart.tsx), [`LlmTokenTotals`](../src/components/SparkPage/LlmTokenTotals.tsx) | **Pending (#319)** — headings/legends, fixed-window and busy-average guidance, daily scale/accessibility/keyboard/hover tooltips, no-sample states, cumulative table/range labels and token-row details. Locale switches retain active day, focus, selected range, in-flight reads, data geometry, per-series scales and raw model IDs. Original UTC date strings, compact units, polling dependencies, ledger versus engine counters and cached/computed/unreported accounting remain unchanged. |
| Model scripts and output | [`LlmModelsPanel`](../src/components/SparkPage/LlmModelsPanel.tsx) | **Not wired** — include controls and progress/error feedback; preserve script names, paths and terminal output. |
| Storage | [`StoragePanel`](../src/components/SparkPage/StoragePanel.tsx) | **Not wired** — include device/refresh controls; preserve device names and poll-mode values. |
| Network and interconnects | [`NetworkPanel`](../src/components/SparkPage/NetworkPanel.tsx), [`RocePanel`](../src/components/SparkPage/RocePanel.tsx), [`TailscalePanel`](../src/components/SparkPage/TailscalePanel.tsx) | **Not wired** — preserve interface names, addresses and connection state. |
| ComfyUI | [`ComfyPanel`](../src/components/SparkPage/ComfyPanel.tsx) | **Not wired** — include job controls/status; preserve job names and workflow data. |
| Metric history | [`HistoryPanel`](../src/components/SparkPage/HistoryPanel.tsx), [`HistoryChart`](../src/components/SparkPage/HistoryChart.tsx) | **Not wired** — retain selected range, measured gaps and chart units. |

### Shared shell, Settings, and separate dialogs

| Surface | Primary source | Status / boundary |
| --- | --- | --- |
| Desktop sidebar, mobile tab/sheets, command palette, install prompt, theme/open-access/connection and error UI | [`AppSidebar`](../src/components/shell/AppSidebar.tsx), [`MobileTabBar`](../src/components/shell/MobileTabBar.tsx), [`CommandPalette`](../src/components/shell/CommandPalette.tsx), [`InstallPrompt`](../src/components/shell/InstallPrompt.tsx), [`src/components/ui/`](../src/components/ui/) | **Pending (#315)** — retains Spark names, telemetry, raw errors, keyboard shortcuts and English command aliases. The shared ShutdownAll control and its confirmations are pending in #316; remaining unit actions stay separate. |
| Settings dialog | [`SettingsDialog`](../src/components/SettingsDialog.tsx) | **Foundation merged (#226)** for its existing catalog-backed rows and language selector. **Pending (#310)** for MQTT, fleet GPU clock, Session age labels/presets and the Harness Sessions entry only. |
| Browser notification preferences | [`BrowserAlertsSettings`](../src/components/BrowserAlertsSettings.tsx) | **Foundation merged (#226)**; keep permission/unsupported/insecure feedback and browser-local persistence behavior. |
| Add/Edit Spark | [`AddSparkDialog`](../src/components/AddSparkDialog.tsx), [`EditSparkDialog`](../src/components/EditSparkDialog.tsx) | **Not wired**; include validation, SSH/connection feedback and embedded per-unit GPU clock UI. |
| Harness setup wizard | [`HarnessWizard`](../src/components/HarnessWizard.tsx) | **Not wired**. The Settings entry in #310 and session-list entry in #318 only open this wizard; its five steps, route data and check/review feedback remain a separate feature slice. |
| Alert notification configuration | [`AlertsDialog`](../src/components/AlertsDialog.tsx) | **Not wired**; preserve endpoint values, tokens and raw delivery errors. |
| Access token prompt | [`AccessTokenDialog`](../src/components/AccessTokenDialog.tsx) | **Not wired**; keep token content and server response text unchanged. |
| Hermes update | [`HermesUpdateDialog`](../src/components/SparkPage/HermesUpdateDialog.tsx) | **Not wired**. |
| Benchmark run dialogs | [`BenchmarkDialog`](../src/components/SparkPage/BenchmarkDialog.tsx), [`PrefillBenchDialog`](../src/components/SparkPage/PrefillBenchDialog.tsx), [`QualityBenchDialog`](../src/components/SparkPage/QualityBenchDialog.tsx) | **Not wired**; preserve prompts, benchmark parameters, IDs and result payloads. |
| LLM launch and unit actions | [`LlmLauncherDialog`](../src/components/SparkPage/LlmLauncherDialog.tsx), [`SparkActions`](../src/components/SparkPage/SparkActions.tsx), [`ConfirmShutdownDialog`](../src/components/ConfirmShutdownDialog.tsx), [`ShutdownAll`](../src/components/ShutdownAll.tsx) | **Pending (#316)** for inline Overview launcher controls, fleet shutdown and shared confirmation controls. **Not wired** for the launcher configuration dialog and single-unit action prompts. |
| LLM terminal output | [`LlmModelsPanel`](../src/components/SparkPage/LlmModelsPanel.tsx) | **Not wired**; translate modal controls such as **Close output**, while preserving commands and raw terminal output. |

The pending Overview PR #316 also includes shared VRAM tooltips, health-chip controls, activity widgets, restart and shutdown confirmation controls. Their translated text follows the locale wherever reused; this does not mark the surrounding Spark detail, Energy, Activity or other page as localized. The resource panels in #317 share the process-table headings. Full localization of their detailed VRAM breakdown also requires the shared component work in #316; neither PR marks other Spark detail panels as complete.

## Per-page acceptance and update checklist

Use this for every page-sized pull request and mark this inventory only after the change has merged.

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
