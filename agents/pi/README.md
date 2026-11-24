# Pi occupancy extension

Optional. It lets a sparkDash occupancy helper list your Pi sessions on the LLM
card whose endpoint they are calling. Without it, Pi sessions do not appear.

The extension writes one small metadata file per Pi process under
`$XDG_RUNTIME_DIR/pi-sparkdash-occupancy/` (mode `0700`, files `0600`). The file
holds the session id, project folder name, state, the request destination
(provider, model and base URL) and timestamps. It never holds prompts,
responses, tool output or credentials.

## Install

Copy this folder into your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r agents/pi ~/.pi/agent/extensions/sparkdash-occupancy
```

Then restart Pi, or run `/reload`. To try it without installing:

```bash
pi --extension ./agents/pi
```

## How placement works

A session appears on a card only when the request it is making goes to that
card's endpoint: the base URL's host and port must be the Spark and LLM port the
card monitors, and the model must be the model that card reports. A session
using a cloud model, or a local endpoint sparkDash does not monitor, stays off
the cards. Folder names and model names alone are not used. A `localhost`
destination means the machine the helper runs on, so a session on one Spark
never lands on another Spark's card.

The helper reads the files; the dashboard never reads them directly. A file
left behind by a crashed Pi process stops counting after two minutes.

## Requirements

- Pi 1.4 or newer (the lifecycle hooks this uses).
- A POSIX host with `$XDG_RUNTIME_DIR` (or `/run/user/<uid>`).
- The occupancy helper running on the same host with `pi` in
  `OCCUPANCY_ADAPTERS`.
