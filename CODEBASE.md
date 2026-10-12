# Codebase map

## Runtime entry points

- `server/index.js`: Express API, existing GET authentication, Spark registry and collectors.
- `src/App.tsx`: dashboard settings and page composition.
- `src/components/OverviewPage/OverviewPage.tsx`: fleet layout and optional cards.
- `src/api/client.ts` / `src/api/types.ts`: existing browser API transport and contracts.

## Optional inference activity

This feature is disabled without `SPARKDASH_INFERENCE_ACTIVITY_URL`. Operators
approve non-secret display names through `SPARKDASH_INFERENCE_ACTIVITY_LABELS`;
the dashboard does not receive client API keys or prompts.

| New file | Responsibility |
| --- | --- |
| `server/collectors/InferenceActivity.js` | Private literal-IP JSON reader, bounded shared polling, sanitization, grouped counts/age extrema and server freshness. |
| `server/collectors/__tests__/InferenceActivity.test.js` | URL/privacy/body limits, grouping, safe counts/overflow, source expiry and polling regressions. |
| `server/__tests__/inference-activity-route.test.js` | Isolated real HTTP route: auth, no-store, default-off/no-I/O, grouped busy principal and server-only configuration. |
| `src/components/OverviewPage/InferenceTrafficCard.tsx` | Existing Panel with named-principal counts/ages and recent durations; server-authoritative availability and elapsed no-response timeout. |
| `src/components/OverviewPage/InferenceTrafficCard.test.tsx` | Disabled/unknown/zero rendering, approved names, clock skew, stalled fetch, recovery and timer cleanup. |

Connected existing files:

- `server/index.js`: creates the store; `/api/inference/activity` returns a
  read-only no-store snapshot under the existing GET access policy; Settings
  expose only the read-only `inferenceActivityEnabled` capability.
- `server/__tests__/isolatedEnv.js` / `isolatedEnv.test.js`: clear activity source
  variables so tests never contact an operator's configured source.
- `src/api/client.ts`, `client.test.ts`, `types.ts`: typed `apiFetch` integration.
- `src/App.tsx`, `OverviewPage.tsx`, `OverviewPage.test.tsx`: no card or polling
  without the capability; enabled card participates in the normal layout.
- `.env.example` / `README.md`: opt-in configuration, exact JSON contract and
  access/privacy limitations.

Input is capped at 256 rows independently of positive safe-integer counts.
Sanitized duplicate groups coalesce; unsafe group/total sums fail closed.
HTTP in-flight counts include queueing/prefill/decode, not GPU slots or per-key
tokens/sec. The source must already be sanitized; secret-pattern filtering is
not a general secret detector. No persistent activity data or new dependency.
The optional outbound fetch and label-route exposure still require the
maintainer's acceptance; this change does not alter dashboard authorization.
