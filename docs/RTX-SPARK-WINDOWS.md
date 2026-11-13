# sparkDash on NVIDIA RTX Spark (Windows 11 ARM64, native)

This branch adapts **sparkDash** for native deployment on the **NVIDIA RTX Spark**
(GB10, Windows 11 ARM64) — no Docker, no WSL. Everything runs directly on the host as a
single Node process (`node server/index.js`) plus a prebuilt React frontend.

The project is built on the upstream [Mia's AI Lab / sparkDash](https://github.com/MiaAI-Lab/sparkDash).
Upstream code remains under its original license (Apache-2.0 for ≥2.0.0, MIT for ≤1.9.0 — see
`LICENSE`, `LICENSE-MIT`, and `NOTICE`). The Windows/RTX-Spark changes in this branch are released
under the same license terms and preserve the upstream copyright notice.

## What this branch adds

| File | Purpose |
|---|---|
| `start.ps1` / `stop.ps1` | Lifecycle: launch / stop the dashboard from PowerShell. `start` claims the port (never kills a foreign process); `stop` falls back to the port owner and only kills a process whose command line is this repo's `server/index.js`. |
| `scripts/config.ps1` | Shared settings. Parses `./.env` into an in-memory map, injects it into the child at launch, then restores the console (so stale values do not survive between runs). |
| `scripts/banner.ps1` | Startup banner. |
| `scripts/windows/ssh-askpass.cmd` / `.ps1` | `SSH_ASKPASS` helper for remote units on Windows (there is no sshpass on Windows). **Must be CRLF** — Windows batch files parse incorrectly on LF. |
| `server/collectors/windowsLocal.js` | Local Windows metric collectors (PowerShell 5.1 compatible: CPU / RAM / GPU / temps). |
| `server/util/windowsCommands.js` | Windows process spawning / PowerShell invocation helpers. |
| `server/util/windowsProgram.js` | Locates PowerShell and other Windows tools. |
| `server/tooleval/commands.js` | Tool-eval install via the local `pip`/venv on Windows (uv is not used). |

## Key adaptation notes

- **ARM64-native Node.** Use the arm64 build (`D:\llm\node-arm64`). The x64 build falls back to
  x86 emulation on GB10 and is unusably slow.
- **PowerShell 5.1, not pwsh 7.** All PowerShell is written for the built-in Windows PowerShell 5.1.
  Output is forced to UTF-8 (`[Console]::OutputEncoding`) to avoid GBK/CP936 mojibake in logs.
- **`.env` stays out of the console.** `config.ps1` never writes `.env` values into the caller's
  process environment; it only copies them into the server child at launch. This is why a removed
  token cannot keep gating the page, and why `clean-env` exists.
- **Remote units on Windows.** System metrics come over SSH; password auth uses the bundled
  askpass helper with `SSH_ASKPASS_REQUIRE=force`. Key auth is more robust (uses `BatchMode`).
- **Port ownership.** A listener started from an elevated window reports `OwningProcess = 0` to a
  non-elevated shell, so `start.ps1` identifies the holder over HTTP rather than trusting the TCP
  table, and `stop.ps1` matches the command line before killing.

## Quick start

```powershell
cd D:\llm\sparkDash
npm run build      # build the frontend (arm64 Node) — backend-only changes skip this
.\start.ps1        # serve the dashboard (default http://127.0.0.1:5555)
.\stop.ps1         # stop it
```

See `AGENTS.md` and `CODEBASE.md` for general contributor and architecture guidance.
