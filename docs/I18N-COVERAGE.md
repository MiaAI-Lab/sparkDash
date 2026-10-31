# UI localization coverage

**Snapshot baseline:** `main` at `b96244a2589a2130e80ff1b2b399252934a01154` on 2026-10-31. This is an inventory and update checklist, not a completion metric: passing tests or a successful build do not establish that a page is localized.

## Scope and conventions

The English catalogs are the source and fallback, initialized in [`src/i18n/index.ts`](../src/i18n/index.ts). This branch registers [`settings`](../src/locales/en/settings.json), [`language`](../src/locales/en/language.json) and [`overview`](../src/locales/en/overview.json), with matching `zh-CN` files. The separate Shell namespace is pending in [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315). Translate visible product UI, accessible names, validation/help/empty/loading and success/failure feedback. Do **not** translate raw server diagnostics, user-supplied text, IDs, protocol values, commands, URLs, or product and model names unless a product decision explicitly says otherwise.

The first integration is deliberately page-sized. Follow the maintainer's [page-sized direction](https://github.com/MiaAI-Lab/sparkDash/pull/194#issuecomment-6517707651): keep #194 open and unchanged as an integration/translation reference, including its server-message design. Do not rebase it, revive the broad integration, or describe it as merged.

## Status legend and known slices

| Status | Meaning |
| --- | --- |
| **Foundation merged (#226)** | Wired to the shipped language infrastructure; only the explicitly named surface is covered. |
| **Pending (#310)** | Included in the separate Settings PR, but not in the baseline `main`; update this document when merged. |
| **Pending (#315)** | Included in the separate Shell PR, but not in the baseline `main`. |
| **Pending (this Overview PR)** | Implemented in this change, but not a merged `main` claim. |
| **Not wired** | No page-level catalog/wiring claim in this snapshot. |

| Slice | Status | Boundary |
| --- | --- | --- |
| Language selection | **Foundation merged (#226)** | [`LanguageSelector`](../src/components/LanguageSelector.tsx), the locale bootstrap, persistence and English fallback. |
| Settings rows and browser alerts | **Foundation merged (#226)** | Most existing Settings row text plus [`BrowserAlertsSettings`](../src/components/BrowserAlertsSettings.tsx); retain its browser-only permission feedback. |
| MQTT and fleet GPU clock | **Pending (#310)** | Settings MQTT text and [`FleetGpuClock`](../src/components/FleetGpuClock.tsx) are not a `main` claim until #310 merges. |
| Session age and Harness Sessions entry | **Pending (#310)** | Settings labels/help/preset labels and the entry action only. This does **not** localize [`HarnessWizard`](../src/components/HarnessWizard.tsx). |
| Navigation and shared shell | **Pending (#315)** | Desktop/sidebar and mobile navigation, command palette and its commands, theme/open-access/connection/error/install UI, plus App-owned empty/error text. Benchmark navigation only; page bodies and standalone dialogs remain separate slices. Fleet shutdown is covered by this Overview change. |

## Inventory

The route inventory comes from [`App.tsx`](../src/App.tsx), [`useRoute.ts`](../src/hooks/useRoute.ts), [`constants.ts`](../src/constants.ts), and both navigation shells ([desktop](../src/components/shell/AppSidebar.tsx) / [narrow](../src/components/shell/MobileTabBar.tsx)). “Not wired” means the page needs its own namespace/keys and review; it does not mean every string in it has been manually counted.

### Navigable screens

| Surface and route | Primary source | Status / next page-sized slice |
| --- | --- | --- |
| Overview `/` | [`OverviewPage`](../src/components/OverviewPage/OverviewPage.tsx) and its cards | **Pending (this Overview PR)** — headings, filters, unit/memory cards, inline launcher controls, fleet KPIs, energy/token/traffic cards, local alert text, activity controls, and fleet action/confirmation feedback. Raw events, server-only findings and diagnostics remain unchanged. |
| Spark detail `/spark/:id` | [`SparkPage`](../src/components/SparkPage/SparkPage.tsx) and panels | **Not wired** — split large panels into reviewable slices; keep telemetry values, model identifiers and raw collector errors unchanged. |
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

### Shared shell, Settings, and separate dialogs

| Surface | Primary source | Status / boundary |
| --- | --- | --- |
| Desktop sidebar, mobile tab/sheets, command palette, install prompt, theme/open-access/connection and error UI | [`AppSidebar`](../src/components/shell/AppSidebar.tsx), [`MobileTabBar`](../src/components/shell/MobileTabBar.tsx), [`CommandPalette`](../src/components/shell/CommandPalette.tsx), [`InstallPrompt`](../src/components/shell/InstallPrompt.tsx), [`src/components/ui/`](../src/components/ui/) | **Pending (#315)** — retains Spark names, telemetry, raw errors, keyboard shortcuts and English command aliases. The shared ShutdownAll control and its confirmations are covered in this Overview change; remaining unit actions stay separate. |
| Settings dialog | [`SettingsDialog`](../src/components/SettingsDialog.tsx) | **Foundation merged (#226)** for its existing catalog-backed rows and language selector. **Pending (#310)** for MQTT, fleet GPU clock, Session age labels/presets and the Harness Sessions entry only. |
| Browser notification preferences | [`BrowserAlertsSettings`](../src/components/BrowserAlertsSettings.tsx) | **Foundation merged (#226)**; keep permission/unsupported/insecure feedback and browser-local persistence behavior. |
| Add/Edit Spark | [`AddSparkDialog`](../src/components/AddSparkDialog.tsx), [`EditSparkDialog`](../src/components/EditSparkDialog.tsx) | **Not wired**; include validation, SSH/connection feedback and embedded per-unit GPU clock UI. |
| Harness setup wizard | [`HarnessWizard`](../src/components/HarnessWizard.tsx) | **Not wired**. The current Settings entry only opens this wizard; its five steps, route data and check/review feedback remain a separate feature slice. |
| Alert notification configuration | [`AlertsDialog`](../src/components/AlertsDialog.tsx) | **Not wired**; preserve endpoint values, tokens and raw delivery errors. |
| Access token prompt | [`AccessTokenDialog`](../src/components/AccessTokenDialog.tsx) | **Not wired**; keep token content and server response text unchanged. |
| Hermes update | [`HermesUpdateDialog`](../src/components/SparkPage/HermesUpdateDialog.tsx) | **Not wired**. |
| Benchmark run dialogs | [`BenchmarkDialog`](../src/components/SparkPage/BenchmarkDialog.tsx), [`PrefillBenchDialog`](../src/components/SparkPage/PrefillBenchDialog.tsx), [`QualityBenchDialog`](../src/components/SparkPage/QualityBenchDialog.tsx) | **Not wired**; preserve prompts, benchmark parameters, IDs and result payloads. |
| LLM launch and unit actions | [`LlmLauncherDialog`](../src/components/SparkPage/LlmLauncherDialog.tsx), [`SparkActions`](../src/components/SparkPage/SparkActions.tsx), [`ConfirmShutdownDialog`](../src/components/ConfirmShutdownDialog.tsx), [`ShutdownAll`](../src/components/ShutdownAll.tsx) | **Pending (this Overview PR)** for inline Overview launcher controls, fleet shutdown and shared confirmation controls. **Not wired** for the launcher configuration dialog and single-unit action prompts. |
| LLM terminal output | [`LlmModelsPanel`](../src/components/SparkPage/LlmModelsPanel.tsx) | **Not wired**; translate modal controls such as **Close output**, while preserving commands and raw terminal output. |

Overview also uses shared VRAM tooltips, health-chip controls, activity widgets, restart and shutdown confirmation controls. Their translated text follows the locale wherever reused; this does not mark the surrounding Spark detail, Energy, Activity or other page as localized.

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
