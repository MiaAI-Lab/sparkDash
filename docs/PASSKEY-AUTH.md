# Passkey authentication plan and design

## Goal

Let a human enrol and sign in with passkeys instead of keeping sparkDash's shared access token in browser storage. Keep the existing token-only and keyless installations unchanged unless `SPARKDASH_PASSKEY_ORIGIN` is explicitly configured.

## Authentication and authority

- `SPARKDASH_TOKEN` remains the bootstrap/recovery credential. No anonymous first-user enrolment.
- A token sign-in exchanges the token for an opaque session cookie. Its session records token authority, so the next page can enrol with only the cookie; it does not depend on a browser forwarding credentials from a deep login path.
- A passkey sign-in grants a session without token authority. It may use the dashboard and list credentials but cannot enrol or revoke them. A stolen passkey session must not create permanent access.
- Successful sign-ins clear any previously stored bearer token. Sign-out destroys the session server-side, clears the cookie and stored bearer token, and reconnects the live telemetry stream without credentials.
- By default both the token and sessions authenticate API requests. Optional `SPARKDASH_PASSKEY_ONLY=1` refuses the token after enrolment, except read-only GET/HEAD `/metrics` scraping. With no credential enrolled the token still works. Existing token-derived sessions remain valid until expiry/sign-out, allowing the operator to finish enrolment and management.
- This does not change the existing loopback-local-trust rule for read-only REST requests. It is not a second factor while bearer access remains enabled.

## Server implementation

1. `server/passkeys/settings.js` validates an explicit browser-facing origin. Use HTTPS with a hostname or HTTP localhost; no IP RP IDs. Origin and RP ID never come from request headers.
2. `server/passkeys/store.js` persists credential public keys, counters, labels, hashed sessions, challenges, the failed-attempt window and a salted scrypt token fingerprint in `config/passkeys.sqlite` (mode `0600`, absolute `PASSKEYS_DB_PATH` override). SQLite `BEGIN IMMEDIATE` transactions serialize the service and recovery CLI; atomic JSON renames alone cannot prevent a concurrent request from undoing recovery. Native SQLite requires Node 22.13+, within the supported Node 22 runtime. Sessions expire at a fixed time. Separate login/registration challenge pools evict their oldest entries at the cap rather than denying all new sign-ins until expiry.
3. `server/passkeys/routes.js` registers exact login, token-exchange and logout routes ahead of the general gate. Management routes authenticate explicitly, including on loopback. Real WebAuthn verification uses `@simplewebauthn/server`, requiring user verification and discoverable credentials. Challenges expire and are spent before verification. Successful authentication rechecks the credential/counter and writes the new counter and session together, so a concurrent verification cannot regress a counter or revive a revoked credential.
   Enrolment also rechecks the reset generation and, when authorised by a cookie, that its token-derived session is still live at commit. A logout or reset during signature verification cannot mint permanent access.
4. `server/auth.js` accepts either bearer authority or a session. Cookie-authenticated mutations and WebSocket upgrades require the configured Origin; cookies are HttpOnly, SameSite=Strict, host-only, path `/`, and Secure with a `__Host-` prefix on HTTPS. Existing WebSockets revalidate before each broadcast so revoked/expired sessions stop receiving telemetry.
5. `server/passkeys/preflight.js` refuses invalid origins, missing bootstrap tokens, unavailable runtime/verifier dependencies and unusable paths at boot. A store that cannot be armed disables passkey operations and falls back to legacy token sign-in; corrupt state is preserved by the host reset command before starting a new database. Restart after corrupt-store recovery. Token rotation or a lost fingerprint clears enrolments, sessions and ceremonies.
6. `server/passkeyAdmin.js list|reset|sign-out-all` supplies host-side recovery, including when the service is stopped. There is no HTTP reset route.

## Browser implementation

- Extend the existing Access token dialog into Sign in when passkeys are enabled; retain the old token-save flow otherwise.
- Use `@simplewebauthn/browser` for real registration/authentication ceremonies. Show cancellation separately from server errors.
- Add a Settings Passkeys section with labels, enrolment/last-used dates, enrol/revoke controls gated by token authority, and sign-out.
- A session-change signal reconnects the cookie-authenticated WebSocket and reloads settings without reloading the page. Same-turn token/session changes cause one reconnect.
- Translate the new Settings controls into English and Simplified Chinese.

## Verification plan

- Server tests exercise real ES256 registrations/assertions without mocking the verifier: token-session bootstrap, management authority, multiple credentials, wrong origin, challenge expiry/replay, counter rollback and concurrent commits, zero-counter synced passkeys, session expiry/logout/restart, token rotation, strict mode, throttling/cap, startup failures and host recovery.
- Mutation checks remove guards and must fail their behavioural tests.
- Run typecheck, i18n checks, frontend tests/build and the full server suite; distinguish host prerequisites and failures present on the unmodified base.
- Build the production Dockerfile, start an isolated Compose deployment using its normal environment passthrough, and use Chromium's virtual authenticator to enrol, sign out, sign in, reload, and revoke through the actual UI. Verify cookies and that localStorage no longer contains the shared token.
- Create a draft PR with the operator setup, security boundaries and observed verification evidence; do not merge or alter any live installation.

Operational instructions are in [Remote access](REMOTE-ACCESS.md#passkey-sign-in).
