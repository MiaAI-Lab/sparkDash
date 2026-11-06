# UI localization coverage

**Snapshot baseline:** `main` at `da20ac5` on 2026-11-04. This is an inventory and update checklist, not a completion metric: passing tests or a successful build do not establish that a page is localized.

## Unified progress index

Keep one progress list while retaining separate, complete-feature pull requests. This inventory tracks all reviews; a pending row does not mean its source is included in every branch. Review and upstream landing status were refreshed on 2026-11-04; an open PR is implemented work awaiting review, not shipped coverage.

| Scope | Review entry | Status |
| --- | --- | --- |
| Language infrastructure and initial Settings | [#226](https://github.com/MiaAI-Lab/sparkDash/pull/226) | Merged; included in the baseline. |
| Remaining Settings: MQTT, GPU clock and sessions | [#310](https://github.com/MiaAI-Lab/sparkDash/pull/310) | Completed on main via author-preserving cherry-picks `8a4eb08`, `d81a075`, `8d5dbdb`, `6828b32`; closed by the maintainer. The former #311 slice was consolidated here. |
| Navigation and shared shell | [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315) | On main via author-preserving ports and integration `9ad3711`; closed by maintainer. Included in local showcase `8634aa1`. |
| Overview page and fleet controls | [#316](https://github.com/MiaAI-Lab/sparkDash/pull/316) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Spark detail GPU, CPU and memory | [#317](https://github.com/MiaAI-Lab/sparkDash/pull/317) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Spark detail LLM live panel and sessions | [#318](https://github.com/MiaAI-Lab/sparkDash/pull/318) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Spark detail LLM history, daily statistics and token totals | [#319](https://github.com/MiaAI-Lab/sparkDash/pull/319) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Fleet Reports | [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Device Setup | [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Spark Details | [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Benchmarks | [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Showcase | [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324) | On main via author-preserving ports and integration `9ad3711`; PR remains open; source ported by maintainer. Included in local showcase `8634aa1`. |
| Server Messages | [#325](https://github.com/MiaAI-Lab/sparkDash/pull/325) | Pending upstream; refreshed onto main `da20ac5` with additive UI integration. Functional scope is already visible in local showcase `8634aa1`. |

[#194](https://github.com/MiaAI-Lab/sparkDash/pull/194) stays open as the original integration and server-message design reference, per the maintainer's [latest direction](https://github.com/MiaAI-Lab/sparkDash/pull/194#issuecomment-6586458496). It is not an active merge target. Do not rebase it or count its broad translation work as shipped. Its historical content would remain accessible after closure, but the maintainer explicitly requested an open reference; revisit its status when that reference has an agreed replacement.

When a page PR merges, update its row and the detailed inventory together. Keep all already-merged namespaces and newer coverage rows when resolving shared loader, README, changelog or inventory conflicts.

## Current upstream landing and follow-up (2026-11-04)

The maintainer ported the page slices **#315–#324** into main and integrated them at [`9ad3711`](https://github.com/MiaAI-Lab/sparkDash/commit/9ad371105a0088b7e35b03316fec2702d0cf4403). This is verified source landing, distinct from GitHub's PR merge flag: #315 is closed without a GitHub merge; #316–#324 still have open PR records. Do not replay these already-landed slices just to clear their stale conflict badges. #310 remains completed on main through its earlier author-preserving port.

**#325 is still pending upstream.** Its source is now based on main `da20ac5`. The metadata integration preserves all landed loader namespaces, translated action controls and fallback kinds, localized activity detail labels, raw expanded evidence and Overview health chrome. The three-descriptor / 16 KiB output bounds remain enforced. Regression coverage checks the combined controls and descriptor rendering across locale changes without additional actions.

At this audit, no new maintainer discussion/review requested another behavioral change. All eleven original submitted heads have zero check runs, commit statuses and Actions runs; this is absent CI evidence, not a passing CI result. Local validation for this refreshed #325: catalog validation and all 11 checker regressions passed; typecheck and production build passed; the full frontend suite passed **967 tests / 145 files**. Linux server suite: **1,690 passed, one failed, zero skipped**; the unchanged upstream DSH stalled-socket test timed out before its local request handler ran under full-suite load. One isolated rerun of its entire file passed **7/7**. This is recorded as a full-suite timing failure plus successful focused retry, not a clean all-green Linux run. The namespace-binding checker identified an ambiguous `t` identifier while combining HealthChips/HealthList; distinct bindings fixed it, with all five HealthFindings regressions and catalog/type/build checks passing afterward. No additional broad rerun was needed for that binding-only frontend change. Earlier dated sections describe historical snapshots and are superseded by this section for current landing status.

Read-only comparison against main found no lost #315–#324 fix: shell palette/offline wording, nullable power/multi-GPU labels, completion throughput, unreported cache, token dates, Kiosk legends/live alerts, detail history/reorder, Prefill context limits, STOPPED and Showcase confirmation are retained.

The local instance remains `8634aa1`: it already includes #315–#325 functional changes and native Maya monitoring support. This upstream adaptation does not deploy the unrelated new main features or restart SparkDash/model services. The progress page is updated separately from immutable release metadata.

## Additional live visual check (2026-11-03)

**Deployment receipt:** `.9:5555` now serves `8634aa1` (ready 2026-11-03 11:17 Asia/Shanghai). Health and release manifest passed; four critical configuration hashes, current inference process/container identity, engine/model/capacity, and 41 other running containers were preserved. Maya support is retained; the currently configured port still runs Strata/Qwen3.8. All #315–#325 remain open/unmerged upstream.

Final source differs from full-suite `945beb3` only in date presentation and the activity Time label; the 46 Token and 3 Activity/server-message tests plus type/catalog/build checks passed on those corrections. The final local candidate was visually checked again before switching 5555. Subsequent documentation-only PR heads do not imply undisplayed product changes.

After the first validated publication, the user requested one more visual pass. Actual candidate pages were inspected in the in-app browser at desktop and narrow widths; this pass found and corrected:

- Token-page busiest dates still used English formatting in zh-CN, and the comparison suffix read awkwardly. #320 now localizes UI dates/period wording while retaining bucket/time-zone semantics, default English pure-helper output and CSV bytes.
- Kiosk's known live exception labels were English. #320 now translates only conditions present in the live snapshot; unknown server-only findings keep raw labels.
- The private combined build had copied #325's server-message versions over #322's SparkActions and #320's EventRow chrome. The integration now retains both locale bindings and descriptor rendering. When landing #325 after earlier slices, **combine these changes additively**; never replace either file wholesale. Expanded raw event messages, action payloads and unknown diagnostics remain unchanged.

Final local source `945beb3` passed **891 frontend tests / 136 files**, catalog validation, typecheck and build before the subsequent #320/PR progress update. Its server tree is unchanged from Linux-validated `3f61343` (**1,463 pass, zero failures/skips**). Targeted regressions cover the translated controls alongside server descriptors, Chinese dates and unknown-alert fallbacks. Earlier local test snapshots above remain historical evidence for their stated source revisions. The final date-label follow-up `a054c24` adds locale-aware busiest-tile and x-axis dates only; all 46 affected Token tests plus catalog/type/build checks passed before publication. The full 891-test run remains tied to `945beb3` and the unchanged-server evidence remains tied to `3f61343`.

Live-service observation changed since the previous deployment: the configured R750XA port currently reports **Strata / Qwen3.8-Flash-Next**, 256K context and 16 slots. Native Maya support remains in the private build and its local regressions pass; there is no claim that Maya is currently serving that port. Deployment checks compare the actual current engine/model/capacity and process/container identity without starting or restarting inference services.

## Maintainer feedback and local-first validation (2026-11-03)

The maintainer replied to all eleven reviews at 03:27-03:28 Asia/Shanghai on 2026-11-03. Each branch was rebased onto current main `7c2b963`; the landing order remains **#315, then #316 through #325 in numeric order**. These remain separate PRs against main. Shared namespace/loader additions must still be combined additively when the maintainer lands them. No upstream PR was merged. #310 remains completed by the maintainer's author-preserving port; #194 remains open and untouched per the latest reference-only instruction.

**User delivery rule:** local tests and necessary browser acceptance must pass **before pushing source or updating a PR**. The local showcase and its progress manifest must include submitted source changes; do not equate local visibility with upstream landing.

| Review / latest maintainer feedback | Validated source head before documentation refresh | Follow-up | Upstream |
| --- | --- | --- | --- |
| [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315#issuecomment-6586433820) | `a65b8ef` | Rebase; retain offline wording, batched palette keys and current kiosk route helper. | Open, awaiting maintainer review/landing |
| [#316](https://github.com/MiaAI-Lab/sparkDash/pull/316#issuecomment-6586434204) | `fbcfb4a` | Rebase; retain missing-power and completion-based throughput semantics; localize multi-GPU footer. | Open, awaiting maintainer review/landing |
| [#317](https://github.com/MiaAI-Lab/sparkDash/pull/317#issuecomment-6586434489) | `de4e88d` | Rebase resource panels without replacing current main history or measurement behavior. | Open, awaiting maintainer review/landing |
| [#318](https://github.com/MiaAI-Lab/sparkDash/pull/318#issuecomment-6586434924) | `492b587` | Rebase; localize completed-request throughput while retaining live/completed distinction. | Open, awaiting maintainer review/landing |
| [#319](https://github.com/MiaAI-Lab/sparkDash/pull/319#issuecomment-6586435303) | `2646b8d` | Rebase; retain not-reported cache accounting. Fleet token-page tooltips are owned by #320. | Open, awaiting maintainer review/landing |
| [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320#issuecomment-6586435737) | `98a71a1` | Rebase kiosk trace/read budget and monthly energy cost; localize cache tooltips, trace captions, memory legends and role badges. | Open, awaiting maintainer review/landing |
| [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321#issuecomment-6586436238) | `c5c0269` | Rebase device dialogs; preserve drafts, focus and raw connection values. | Open, awaiting maintainer review/landing |
| [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322#issuecomment-6586436645) | `7df79c1` | Rebase memory-history split/domain order and drag/reorder; localize window summaries and handle labels. | Open, awaiting maintainer review/landing |
| [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323#issuecomment-6586437082) | `f86a14c` | Rebase context-based Prefill choices; retain STOPPED/CANCELLED distinction and Canvas text-only rendering. | Open, awaiting maintainer review/landing |
| [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324#issuecomment-6586437471) | `5f32662` | Rebase Showcase; retain localized history confirmation and raw output. | Open, awaiting maintainer review/landing |
| [#325](https://github.com/MiaAI-Lab/sparkDash/pull/325#issuecomment-6586437855) | `7612255` | Document/enforce max 3 descriptors and 16 KiB UTF-8 JSON; decline metadata without trimming raw diagnostics. | Open, awaiting maintainer review/landing |

Validation completed before publication: per-PR catalog/type checks and affected frontend tests; final combined local candidate `cf08c32` passed **888 frontend tests / 136 files**, catalog validation, 11 catalog-checker tests, typecheck and production build. Linux server validation passed **1,463 tests, 0 failed, 0 skipped** on `3f61343`; `cf08c32` has an identical server tree. The existing Vite large-chunk advisory remains non-blocking. Documentation-only revisions after these source heads do not change validated product code.

Fresh mocked-browser acceptance used current components, long raw model names and multi-GPU rows at **1440 x 1000 and 390 x 1000**, in English and zh-CN. Overview and Kiosk had no page-level horizontal overflow or browser errors. Kiosk history curves/legends and Chinese memory labels were checked. Actual production Canvas share-card exports rendered at **2400 x 1350** from a 1200 logical-pixel template in both browser widths; markup-like user strings remained literal Canvas text and did not execute. This is representative acceptance, not every hardware/error/theme state. No synthetic benchmark, model launch, shutdown or inference was performed.

GitHub CI snapshot before publication: **0 check runs, 0 commit statuses and 0 pull-request Actions runs** on all audited heads. This is absence of CI evidence, not a green CI result; the local gates above provide the validation evidence.

The local candidate retains native Maya monitoring. Local deployment progress and exact release revision are available at `/development-progress.html`, `/development-progress.json` and `/release-info.json` on the existing `.9:5555` instance. Private runtime configuration and rollback artifacts are excluded from PR commits.

## Historical local submitted-work showcase (2026-11-02)

The user explicitly requested that submitted work be visible in the existing local instance. Local build `4e65153` now integrates the submitted scope of #315-#325, the already-landed Settings work (#310), current main `51daebb`, and the private Maya compatibility path. All eleven page/server PRs remain open and unmerged upstream; local integration is not maintainer approval or upstream landing.

The Settings footer now links to **Local development progress / 本地开发进展** at `/development-progress.html`. It lists each PR's feature scope, submitted revision at build time, follow-up fixes, author-review state, upstream landing state and local inclusion. `/development-progress.json` and `/release-info.json` retain the corresponding build manifest. Subsequent documentation-only PR revisions do not imply undisplayed source changes.

| PRs | Code follow-up status | Local showcase | Upstream status |
| --- | --- | --- | --- |
| #310 | Maintainer ported Settings with original authorship | Included | On main; closed as completed |
| #315, #318, #320, #323, #324 | Review fixes pushed and included | Included | Open, awaiting review/landing |
| #316, #317, #319, #321, #322 | Initial implementation submitted; first review required no blocking source correction | Included | Open, queued for landing |
| #325 | Bounded server metadata submitted; documentation updated | Included | Open, explicitly awaiting maintainer look |

Validation: the assembled candidate passed 872 frontend tests, typecheck, catalog validation and production build. Focused multi-GPU footer regressions (3 tests) and final type/catalog/build checks passed after a small integration wording fix. The Linux server suite passed 1,449/1,449 with zero failures and zero skips; the backend tree is unchanged between that run and the deployed build. Live browser acceptance confirmed that the pre-existing Chinese preference applies after refresh to the shell, overview, statistics, benchmark, Showcase, kiosk and detail routes, with no browser exceptions. The progress link opens a 12-row report, and locale switching sends no settings-write request. Native Maya identity, context, capacity, counters, configuration hashes and model-service identity were preserved. No synthetic inference workload was sent.

**Local visibility delivery rule:** after publishing a feature PR or source follow-up, update the local showcase and its progress manifest, and record the actual deployed revision and entry point. Keep upstream review/landing separate from local display. If a submitted slice is not displayed, mark it explicitly with the reason rather than reporting it as visible. Raw diagnostics, commands, model output and existing copy/export-format boundaries remain in force.

## Private deployment boundary (2026-11-01)

Historical deployment snapshot; superseded by the submitted-work showcase above.

The user-authorized private instance now runs upstream main `51daebb` with the existing Maya monitoring compatibility preserved in private follow-up `3dc2e45`. This is separate from the pending catalog reviews: #315-#325 were neither merged nor included in that deployment. #310 is already on main through the maintainer's author-preserving port. Native Maya identity, context, capacity and token counters were verified against the running service; configuration and model-service identity were preserved. The deployment receipt and rollback details remain private operational artifacts, outside this upstream PR.

## Maintainer feedback (2026-11-01)

**Rechecked 2026-11-01 20:32 Asia/Shanghai:** #315-#325 all remain open and unmerged. The maintainer has not posted a second review after the five follow-up fix groups; the latest author comments are still the 07:39-07:40 first reviews linked below. Submitted fixes must not be described as accepted or landed. #310 remains completed on main through its author-preserving port.

The maintainer reviewed all twelve PRs at **07:39-07:40 Asia/Shanghai on 2026-11-01**. This supersedes the earlier no-feedback snapshot. #310 was ported to main with original authorship in `8a4eb08`, `d81a075`, `8d5dbdb`, `6828b32` and closed as completed; GitHub's `merged` flag is false because this was a cherry-pick. Those revisions are ancestors of fetched main `51daebb`.

| PR / author feedback | Current response and boundary |
| --- | --- |
| [#310](https://github.com/MiaAI-Lab/sparkDash/pull/310#issuecomment-6550598237) | Completed on main with original authorship; closed via cherry-pick, not a GitHub merge. |
| [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315#issuecomment-6550599141) | `a05a73a` preserves offline tooltip wording and functional keyboard selection; 24 focused tests, typecheck, catalog check and build passed. |
| [#316](https://github.com/MiaAI-Lab/sparkDash/pull/316#issuecomment-6550599319) | First review clean; queued after #315. |
| [#317](https://github.com/MiaAI-Lab/sparkDash/pull/317#issuecomment-6550599524) | First review clean; preserve additive spark catalogs and the #317 -> #318 -> #319 sequence. |
| [#318](https://github.com/MiaAI-Lab/sparkDash/pull/318#issuecomment-6550599758) | Count hardening applied in `b7b39f0`; typecheck, five LLM locale tests, catalog check and build passed. |
| [#319](https://github.com/MiaAI-Lab/sparkDash/pull/319#issuecomment-6550599955) | First review clean; queued after #317 and #318. |
| [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320#issuecomment-6550600177) | `8933494` / `3607d47` correct translated range/month labels (including UTC year-axis labels), catalog-date punctuation and non-Error retry feedback that updates across locales without refetching. Initial 25 focused tests and final 10 affected tests passed; both revisions passed typecheck, catalog validation and build. |
| [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321#issuecomment-6550600373) | First review clean; queued in page order. |
| [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322#issuecomment-6550600558) | First review clean; queued in page order. |
| [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323#issuecomment-6550600753) | `c356923` restores STOPPED separately from CANCELLED; 47 focused tests, typecheck, catalog and build passed. |
| [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324#issuecomment-6550600944) | `68f0b18` localizes the visible clear-history confirmation and its locale-switch callback; 2 focused tests, typecheck, catalog check and build passed. Six unused leaves are copy-format labels; plain-text exports and raw prompts/output are preserved. |
| [#325](https://github.com/MiaAI-Lab/sparkDash/pull/325#issuecomment-6550601151) | Bounded design accepted in first review; still explicitly awaiting a maintainer look before landing. Linear RoCE title parsing/zero-count notes are non-blocking and remain guarded by the evaluator. |

The follow-up commits retain English output where the migration unintentionally changed it, preserve raw request/data values, and test the corrected behavior. Their exact changes and targeted validation are recorded in the corresponding PR descriptions. Clean first-review comments mean queued for the maintainer's sequence, not merged or deployed. No PR was merged or rebased by this follow-up, and no `.9` deployment was performed. The CI counts below remain a dated snapshot; these local tests are not GitHub CI results.

## CI and maintainer review audit (2026-10-31)

Historical snapshot: superseded for review/landing status by the 2026-11-01 maintainer feedback below. Its CI counts are only the records observed on that date.

Live GitHub records were checked at **06:03 UTC / 14:03 Asia/Shanghai** for #310 and #315-#325, including each PR head, GitHub's test-merge commit, commit statuses, pull-request workflow runs, issue comments, inline review comments and submitted reviews. All twelve PRs are open, unmerged and awaiting maintainer review. None has a submitted review or discussion comment at this snapshot.

**CI status: no checks recorded, not a passing CI result.** All twelve heads have zero PR workflow runs and zero commit statuses; both the heads and test-merge commits have zero check runs. The only tracked workflow, [Publish image](../.github/workflows/publish-image.yml), runs on `v*` release tags, not pull requests. GitHub also lists a dynamic Copilot review workflow, but it has attached no review/check to these PRs. Local test results in the validation record remain separate evidence. No workflow or test policy was changed during this audit.

| PR | Audited head | GitHub checks | Maintainer review |
| --- | --- | --- | --- |
| [#310](https://github.com/MiaAI-Lab/sparkDash/pull/310) | `86fc74c` | None recorded | No feedback yet |
| [#315](https://github.com/MiaAI-Lab/sparkDash/pull/315) | `91563f3` | None recorded | No feedback yet |
| [#316](https://github.com/MiaAI-Lab/sparkDash/pull/316) | `be06492` | None recorded | No feedback yet |
| [#317](https://github.com/MiaAI-Lab/sparkDash/pull/317) | `bed974c` | None recorded | No feedback yet |
| [#318](https://github.com/MiaAI-Lab/sparkDash/pull/318) | `d22aa4d` | None recorded | No feedback yet |
| [#319](https://github.com/MiaAI-Lab/sparkDash/pull/319) | `0325e7a` | None recorded | No feedback yet |
| [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320) | `741c347` | None recorded | No feedback yet |
| [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321) | `96a00ed` | None recorded | No feedback yet |
| [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322) | `fe22866` | None recorded | No feedback yet |
| [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323) | `b85d642` | None recorded | No feedback yet |
| [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324) | `f06b83a` | None recorded | No feedback yet |
| [#325](https://github.com/MiaAI-Lab/sparkDash/pull/325) | `333816a` | None recorded | No feedback yet |

These are the heads inspected before this documentation-only audit update; later source changes require a new check. A documentation-only successor is not a new runtime-validation claim.

The latest relevant author direction remains the [2026-10-30 note on #194](https://github.com/MiaAI-Lab/sparkDash/pull/194#issuecomment-6517707651), following the [merged foundation confirmation on #226](https://github.com/MiaAI-Lab/sparkDash/pull/226#issuecomment-6384941765). The bounded source review found no new required correction:

- All twelve reviews build on the merged foundation, reuse its loader, keep English as source/fallback, and retain exact `i18next@26.4.2` / `react-i18next@17.0.15` pins. No ICU, `intl-messageformat`, new runtime dependency or lockfile graph was introduced.
- The work stays split by coherent feature group. #194 remains the unchanged integration/design reference. Shared catalogs and loader registrations still need additive resolution when the maintainer integrates the separate PRs.
- Catalog validation remains first in `npm test`. Locale regressions use the default frontend test discovery; #325 explicitly adds `server/i18n/*.test.js` to `test:server`.
- #325 uses a finite exact-literal recognizer with a 4,096-code-unit budget and shallow top-level metadata. Unknown output and stored records remain raw. Nested power-batch results intentionally remain raw; their boundary is already documented below and is not claimed as translated coverage.
- The root documentation inventory is explicitly allow-listed, CHANGELOG entries credit `@oscarlius`, and no unrelated `.omx/` ignore change was added.

Remaining scope limits are explicit: representative browser acceptance does not cover every page state, theme or real-device workflow; arbitrary server text and unwired API-error consumers remain raw. The foundation review's optional `{ ns }` / `<Trans>` checker support and direct parser-dependency follow-up remain optional, separate work. Absence of new comments is not maintainer approval, and absent CI checks are not successful checks. This audit changes documentation and PR descriptions only; no merge or deployment is performed.

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

The branches share files but their catalog prefixes do not overlap. Settings #310 is now on main; pending page PRs #315 and #316 remain separate; preserve their merged namespaces and coverage when resolving common files. After a future source-conflict resolution, validate the catalog, typecheck and affected locale regressions once, extending checks only for additional source changes or failures. For this documentation/ignore-only follow-up, verify the allow-list, links, clean diff and unchanged source/dependency trees; do not repeat the full runtime suites.

## Remaining-feature review order and scope

The six remaining groups are independent reviews against `b96244a`. Their shared loader, README, changelog and this inventory must be combined by namespace or entry rather than choosing one whole side. Keep all prior #310/#315–#319 work. The benchmark group keeps Decode, Prefill, Quality, Tool Eval and their share-card interfaces together.

Suggested remaining-group order: fleet reports → device setup → Spark details → benchmarks → Showcase → server messages. Fleet reports and Spark details also change `EventRow.tsx` and `SparkActions.tsx`; the server-message review deliberately contains only descriptor integration on baseline UI. When integrating it last, preserve the earlier translated chrome and add its metadata handling. It also shares `HealthFindings.tsx` with #316: retain the existing translated chrome or deduplicate it by static keys while adding descriptor rendering. No PR is merged by this migration.

## Scope and conventions

This branch owns **server messages**, using `serverMessages`, alongside the baseline `settings` and `language` namespaces. Known API responses, health findings and activity messages gain optional locale-neutral display descriptors. The browser renders these in the selected language while retaining legacy English fields, raw event details and unknown diagnostics. Recognition is finite, bounded and shallow; stored records and wire action values are unchanged.

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
| **On main via #310** | Ported with original authorship through `6828b32`; the PR was closed as completed rather than merged via GitHub. The original snapshot baseline predates this port. |
| **On main (#315)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| **On main (#316)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| **On main (#317)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| **On main (#318)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| **On main (#319)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| **Not wired** | No page-level catalog/wiring claim in this snapshot. |

| Slice | Status | Boundary |
| --- | --- | --- |
| Language selection | **Foundation merged (#226)** | [`LanguageSelector`](../src/components/LanguageSelector.tsx), the locale bootstrap, persistence and English fallback. |
| Settings rows and browser alerts | **Foundation merged (#226)** | Most existing Settings row text plus [`BrowserAlertsSettings`](../src/components/BrowserAlertsSettings.tsx); retain its browser-only permission feedback. |
| MQTT and fleet GPU clock | **On main via #310** | Settings MQTT text and [`FleetGpuClock`](../src/components/FleetGpuClock.tsx) are on main through `6828b32`. |
| Session age and Harness Sessions entry | **On main via #310** | Settings labels/help/preset labels and the entry action only. This does **not** localize [`HarnessWizard`](../src/components/HarnessWizard.tsx). |
| Navigation and shared shell | **On main (#315)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| Spark resource panels | **On main (#317)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| LLM live panel and sessions | **On main (#318)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |
| LLM history, daily statistics and token totals | **On main (#319)** | Ported by the maintainer and included in integration `9ad3711`; PR lifecycle is tracked separately above. |

## Inventory

The route inventory comes from [`App.tsx`](../src/App.tsx), [`useRoute.ts`](../src/hooks/useRoute.ts), [`constants.ts`](../src/constants.ts), and both navigation shells ([desktop](../src/components/shell/AppSidebar.tsx) / [narrow](../src/components/shell/MobileTabBar.tsx)). “Not wired” means the page needs its own namespace/keys and review; it does not mean every string in it has been manually counted.

### Navigable screens

| Surface and route | Primary source | Status / next page-sized slice |
| --- | --- | --- |
| Overview `/` | [`OverviewPage`](../src/components/OverviewPage/OverviewPage.tsx) and its cards | **On main (#316)** — headings, filters, unit/memory cards, inline launcher controls, fleet KPIs, energy/token/traffic cards, local alert text, activity controls, and fleet action/confirmation feedback. Raw events, server-only findings and diagnostics remain unchanged. |
| Spark detail `/spark/:id` | [`SparkPage`](../src/components/SparkPage/SparkPage.tsx) and panels | **On main (#317)** for resource panels; **On main (#318)** for the live LLM panel and session list; **On main (#319)** for LLM history/daily charts and cumulative token totals. Shared VRAM breakdown content is pending in #316. Remaining panels are implemented in the Spark-details review below; all reviews are still pending. |
| Token totals `/tokens` | [`TokensPage`](../src/components/TokensPage/TokensPage.tsx) | **On main [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Cost compare `/cost` | [`CostPage`](../src/components/CostPage/CostPage.tsx) | **On main [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Fleet energy `/energy` | [`EnergyPage`](../src/components/EnergyPage/EnergyPage.tsx) | **On main [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Temps `/temps` | [`TempsPage`](../src/components/TempsPage/TempsPage.tsx) | **On main [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)**. |
| Activity `/activity` | [`ActivityPage`](../src/components/ActivityPage/ActivityPage.tsx) and [`EventRow`](../src/components/ActivityPage/EventRow.tsx) | **On main [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)** — preserve event payloads/raw diagnostics. |
| Embedded showcase `/showcase` | [`ShowcaseView`](../src/components/ShowcasePage/ShowcaseView.tsx) | **On main [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324)**. |
| Full-screen showcase `/showcase/:sparkId` | [`ShowcasePage`](../src/components/ShowcasePage/ShowcasePage.tsx) | **On main [#324](https://github.com/MiaAI-Lab/sparkDash/pull/324)** — preserve prompts, streamed output and session data. |
| Kiosk `/kiosk` | [`KioskPage`](../src/components/KioskPage/KioskPage.tsx) | **On main [#320](https://github.com/MiaAI-Lab/sparkDash/pull/320)** — wall controls and card presentation localized; full visual acceptance remains pending. |
| Decode benchmark `/bench/decode` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`DecodeBenchPage`](../src/components/bench/sparkdash/DecodeBenchPage.tsx) | **On main [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**. |
| Prefill benchmark `/bench/prefill` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`PrefillBenchPage`](../src/components/bench/sparkdash/PrefillBenchPage.tsx) | **On main [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**. |
| Quality benchmark `/bench/quality` | [`BenchPage`](../src/components/bench/BenchPage.tsx) and [`QualityBenchPage`](../src/components/bench/sparkdash/QualityBenchPage.tsx) | **On main [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**. |
| Tool Eval Bench `/bench/tool-eval` | [`ToolEvalBenchPage`](../src/components/bench/tooleval/ToolEvalBenchPage.tsx) | **On main [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)** — treat setup, live run, results and history as one feature slice. |

### Spark detail: panel-sized review batches

Each row is a reviewable surface. #317 groups the related GPU, CPU and memory rows; #318 handles live controls and sessions; #319 covers LLM charts and token totals. Keep English fallback and all existing `spark` prefixes; the remaining panels use the separate `hardware` namespace. These batches do not mark the entire detail page as localized.

| Surface | Primary source | Status / boundary |
| --- | --- | --- |
| Header, unit actions and page-level port controls | [`SparkHeader`](../src/components/SparkPage/SparkHeader.tsx), [`SparkActions`](../src/components/SparkPage/SparkActions.tsx), [`SparkPage`](../src/components/SparkPage/SparkPage.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — retain raw host identity, diagnostics, port values and action payloads. Shared confirmation controls are pending in #316. |
| CPU, system RAM and unified memory | [`CpuPanel`](../src/components/SparkPage/CpuPanel.tsx), [`RamPanel`](../src/components/SparkPage/RamPanel.tsx), [`UnifiedMemoryPanel`](../src/components/SparkPage/UnifiedMemoryPanel.tsx) | **On main (#317)** — labels, sensor provenance/help, core count, memory split legend/tooltips/accessibility, pressure and waiting states. Sensor/model values, metric history, units and split calculations stay unchanged. |
| GPU metrics and charts | [`GpuPanel`](../src/components/SparkPage/GpuPanel.tsx), [`GpuHistoryChart`](../src/components/SparkPage/GpuHistoryChart.tsx) | **On main (#317)** for single-/multi-card metrics, thermal/throttle states, memory availability/allocation-error labels, shared process-table headings, chart windows, view/metric selectors, legends, axes, accessibility and collecting state. Locale switches preserve selected data, storage values, backfill and curve geometry. Raw device/process names, commands and PIDs stay intact. The shared `VramBreakdownBar` legends/tooltips remain pending in #316; this PR does not duplicate them. |
| LLM live metrics, controls and sessions | [`LlmPanel`](../src/components/SparkPage/LlmPanel.tsx), [`ConversationList`](../src/components/SparkPage/ConversationList.tsx) | **On main (#318)** — metrics/help, engine and idle states, port/API-key settings with local validation, benchmark launch/remote-target controls, session age/state/context tooltips and empty/add controls. Preserve mean versus percentile semantics, missing versus zero readings, cached versus computed rates, draft values, targets/navigation and raw model/session identity. Server posture labels/details and API diagnostics remain unchanged. The translated Harness entry opens the wizard covered by the landed device-setup slice. |
| LLM history, daily statistics and token totals | [`LlmTrendChart`](../src/components/SparkPage/LlmTrendChart.tsx), [`LlmDailyChart`](../src/components/SparkPage/LlmDailyChart.tsx), [`LlmTokenTotals`](../src/components/SparkPage/LlmTokenTotals.tsx) | **On main (#319)** — headings/legends, fixed-window and busy-average guidance, daily scale/accessibility/keyboard/hover tooltips, no-sample states, cumulative table/range labels and token-row details. Locale switches retain active day, focus, selected range, in-flight reads, data geometry, per-series scales and raw model IDs. Original UTC date strings, compact units, polling dependencies, ledger versus engine counters and cached/computed/unreported accounting remain unchanged. |
| Model scripts and output | [`LlmModelsPanel`](../src/components/SparkPage/LlmModelsPanel.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — include controls and progress/error feedback; preserve script names, paths and terminal output. |
| Storage | [`StoragePanel`](../src/components/SparkPage/StoragePanel.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — include device/refresh controls; preserve device names and poll-mode values. |
| Network and interconnects | [`NetworkPanel`](../src/components/SparkPage/NetworkPanel.tsx), [`RocePanel`](../src/components/SparkPage/RocePanel.tsx), [`TailscalePanel`](../src/components/SparkPage/TailscalePanel.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — preserve interface names, addresses and connection state. |
| ComfyUI | [`ComfyPanel`](../src/components/SparkPage/ComfyPanel.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — include job controls/status; preserve job names and workflow data. |
| Metric history | [`HistoryPanel`](../src/components/SparkPage/HistoryPanel.tsx), [`HistoryChart`](../src/components/SparkPage/HistoryChart.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** — retain selected range, measured gaps and chart units. |

### Shared shell, Settings, and separate dialogs

| Surface | Primary source | Status / boundary |
| --- | --- | --- |
| Desktop sidebar, mobile tab/sheets, command palette, install prompt, theme/open-access/connection and error UI | [`AppSidebar`](../src/components/shell/AppSidebar.tsx), [`MobileTabBar`](../src/components/shell/MobileTabBar.tsx), [`CommandPalette`](../src/components/shell/CommandPalette.tsx), [`InstallPrompt`](../src/components/shell/InstallPrompt.tsx), [`src/components/ui/`](../src/components/ui/) | **On main (#315)** — retains Spark names, telemetry, raw errors, keyboard shortcuts and English command aliases. The shared ShutdownAll control and its confirmations are pending in #316; remaining unit actions stay separate. |
| Settings dialog | [`SettingsDialog`](../src/components/SettingsDialog.tsx) | **Foundation merged (#226)** for its existing catalog-backed rows and language selector. **On main via #310** for MQTT, fleet GPU clock, Session age labels/presets and the Harness Sessions entry only. |
| Browser notification preferences | [`BrowserAlertsSettings`](../src/components/BrowserAlertsSettings.tsx) | **Foundation merged (#226)**; keep permission/unsupported/insecure feedback and browser-local persistence behavior. |
| Add/Edit Spark | [`AddSparkDialog`](../src/components/AddSparkDialog.tsx), [`EditSparkDialog`](../src/components/EditSparkDialog.tsx) | **On main [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**; include validation, SSH/connection feedback and embedded per-unit GPU clock UI. |
| Harness setup wizard | [`HarnessWizard`](../src/components/HarnessWizard.tsx) | **On main [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**. Its five steps and check/review feedback are included in device setup; route data and helper diagnostics remain raw. |
| Alert notification configuration | [`AlertsDialog`](../src/components/AlertsDialog.tsx) | **On main [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**; preserve endpoint values, tokens and raw delivery errors. |
| Access token prompt | [`AccessTokenDialog`](../src/components/AccessTokenDialog.tsx) | **On main [#321](https://github.com/MiaAI-Lab/sparkDash/pull/321)**; keep token content and server response text unchanged. |
| Hermes update | [`HermesUpdateDialog`](../src/components/SparkPage/HermesUpdateDialog.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)**. |
| Benchmark run dialogs | [`BenchmarkDialog`](../src/components/SparkPage/BenchmarkDialog.tsx), [`PrefillBenchDialog`](../src/components/SparkPage/PrefillBenchDialog.tsx), [`QualityBenchDialog`](../src/components/SparkPage/QualityBenchDialog.tsx) | **On main [#323](https://github.com/MiaAI-Lab/sparkDash/pull/323)**; preserve prompts, benchmark parameters, IDs and result payloads. |
| LLM launch and unit actions | [`LlmLauncherDialog`](../src/components/SparkPage/LlmLauncherDialog.tsx), [`SparkActions`](../src/components/SparkPage/SparkActions.tsx), [`ConfirmShutdownDialog`](../src/components/ConfirmShutdownDialog.tsx), [`ShutdownAll`](../src/components/ShutdownAll.tsx) | **On main (#316)** for inline Overview launcher controls, fleet shutdown and shared confirmation controls. **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)** for the launcher configuration dialog and single-unit action prompts. |
| LLM terminal output | [`LlmModelsPanel`](../src/components/SparkPage/LlmModelsPanel.tsx) | **On main [#322](https://github.com/MiaAI-Lab/sparkDash/pull/322)**; translate modal controls such as **Close output**, while preserving commands and raw terminal output. |

The landed Overview slice #316 also includes shared VRAM tooltips, health-chip controls, activity widgets, restart and shutdown confirmation controls. Their translated text follows the locale wherever reused; this does not mark the surrounding Spark detail, Energy, Activity or other page as localized. The resource panels in #317 share the process-table headings. Full localization of their detailed VRAM breakdown also requires the shared component work in #316; neither PR marks other Spark detail panels as complete.

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

Pass local validation before pushing source changes or editing PR metadata. Record the tested source revision, necessary checks and local showcase inclusion in the unified list.

When adding a route, page entry point, or independent dialog, add it to the appropriate table in the same change. When a UI feature moves between files, update its source link rather than treating the old path as coverage evidence. The route and shell files above are the inventory starting point; component tests remain behavior evidence, not a substitute for reviewing all localized states.
