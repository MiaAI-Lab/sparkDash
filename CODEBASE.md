# Codebase guide

The server uses JavaScript ESM; the client uses React and TypeScript. `server/index.js` owns the HTTP / WebSocket entry points. Shared protocol types live in `src/api/types.ts`; collector and benchmark implementations live under `server/collectors/`.

## Interface language

`src/main.tsx` calls `bootstrapI18n()` before mounting the application. `src/i18n/index.ts` initializes i18next and ICU, coordinates lazy catalog loading through `resources.ts`, and applies the active HTML language. `detect.ts` gives a saved browser preference priority over browser language; unsupported languages use English. The preference does not change server settings.

React components use `useTranslation()` with a static key and an inline English default. Chinese catalogs are split into namespaces under `src/locales/zh-Hans/`. Keep submitted option values, protocol identifiers, model output, benchmark prompts and scoring independent of translation. See [localization coverage and contributor notes](./docs/i18n.md).

## Message and persistence boundaries

`src/shared/applicationText.js` recognizes a finite vocabulary of complete authored messages. It uses literal prefix / suffix / separator searches with a 4,096 UTF-16-code-unit recognition budget. Oversized and unknown text is not truncated or reinterpreted; callers retain the complete diagnostic. `src/i18n/messages.ts` renders optional descriptors and recognized historical messages in the browser's language.

`server/i18n/messages.js` provides optional, locale-neutral descriptors while retaining original English API fields and HTTP status codes. The global `responseI18n()` boundary decorates only the current message object. Batch power routes explicitly call `responseI18nResults()` for their own result rows. It does not recursively scan benchmark results, model output or arbitrary arrays.

Benchmark managers separate persisted job snapshots from API presentation. New active / history snapshots do not add derived translation descriptors; getters project descriptors without visiting per-result rows. Showcase archives keep stream contents and errors raw. EventLog stores raw events and projects descriptors for API / subscriber presentation. Existing history files are not rewritten on read; legacy descriptors remain readable.

## Verification

- `npm test`: server and frontend regression suites. Run native collector / process tests on Linux; tests that start the server must use `server/__tests__/isolatedEnv.js` to isolate all configuration paths.
- `npm run typecheck` and `npm run build`: TypeScript and production output.
- `npm run i18n:check -- --strict`: static translation keys, defaults and ICU parameters.
- `npm run i18n:coverage` and `npm run test:i18n-coverage`: AST coverage and exact documented exceptions.
- `npm run test:i18n-browser-config`: browser discovery, explicit overrides and profile ownership regressions.
- `npm run test:i18n-browser`: independent headless Chromium / Chrome / Edge with a loopback fixture, synthetic data and an isolated temporary profile. No deployed device actions are required.

`server/i18n/recognizer.test.js` includes a timeout-controlled child-process regression for repetitive near-matches and raw diagnostic preservation. `server/collectors/__tests__/i18nPersistence.test.js` verifies persistence / presentation separation. Keep these boundaries covered when adding authored messages or new history fields.

Browser artifacts default to `.omx/i18n-browser/`, ignored by the shared `.gitignore`. Browser profiles use a unique OS temporary directory and are removed only if owned by the test process. The harness discovers installed browsers on Windows, macOS and Linux; an explicit `I18N_BROWSER_BINARY` takes priority and is checked before the fixture server starts.
