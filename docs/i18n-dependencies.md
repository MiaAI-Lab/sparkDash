# Proposed localization dependencies

The localization foundation requires a maintainer decision before it can land. This integration branch pins the versions already tested; pinning and passing tests do not establish maintainer approval or a security audit of the packages.

| Direct build dependency | Exact version | Purpose | Package license |
| --- | --- | --- | --- |
| i18next | 26.4.2 | Catalog lookup and language lifecycle | MIT |
| react-i18next | 17.0.16 | React subscriptions and immediate language rerender | MIT |
| i18next-icu | 2.5.0 | ICU parameter and plural formatting | MIT |
| intl-messageformat | 12.1.3 | Explicit peer required by i18next-icu | BSD-3-Clause |

These frontend dependencies belong in devDependencies because the production server serves the built UI. They are bundled into the frontend build. `package-lock.json` records their transitive graph and integrity digests. This maintenance pass adds an explicit declaration for the already-resolved intl-messageformat peer and pins the four versions; it does not select newer releases or alter resolved versions. Third-party notices include the direct localization packages and the formatter's BSD text.

The maintainer noted that some selected versions were published recently. The proposal for a small foundation PR is to retain the existing tested graph while the maintainer evaluates whether to accept it, select an older compatible graph, or request a smaller dependency approach. Any changed graph requires a fresh clean install, ICU catalog / plural / parameter tests, typecheck, frontend regression suite, production build and language-switch browser checks before publication.

## Proposed review sequence

1. Foundation: dependency decision, loader / detection / preference, Settings language control, shell navigation and focused tests / documentation. No server recognizer or complete page conversion.
2. Overview / Settings / device forms and Spark panels, divided further if requested.
3. Tokens / energy / activity.
4. Benchmarks / Showcase / Tool Eval, divided by feature.
5. Server descriptors: bounded recognition, explicit response projection, raw persistence and compatibility tests; reviewed independently of page catalogs.

PR #194 remains a Draft integration reference while this decision and splitting are pending. Each follow-up will name its foundation / main dependency, include only its own component and namespace changes, and report tests for its exact head. No force push or history replacement is needed to preserve the original localization work.
