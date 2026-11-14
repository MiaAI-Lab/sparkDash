# Home Assistant

Poll a sparkDash hub from Home Assistant. The integration is a custom component in this repo, not a core Home Assistant integration and not published to HACS.

sparkDash already knows the fleet. This integration reads that list and creates one device per Spark. It does not SSH to the units, and it does not change settings or power state.

If you already publish to a broker, the [MQTT](../README.md#mqtt) feed is the other way in. Use this integration when you do not want a broker.

## Requirements

- Home Assistant 2024.11 or newer (Container, Core, or Supervised). The component uses `ConfigEntry.runtime_data`.
- A sparkDash hub the Home Assistant **host** can reach. The URL is fetched by Home Assistant, not by the browser you use to add the integration.
- sparkDash listens on `127.0.0.1:5555` by default. That address works only when Home Assistant runs on the same machine. From another machine, publish the port (`BIND_HOST`) on an address Home Assistant can route to.

`/api/sparks` is unauthenticated unless `SPARKDASH_TOKEN` is set. A LAN bind without a token is readable by anyone who can reach the port (the server refuses state-changing requests on a tokenless remote bind, and `SPARKDASH_ALLOW_OPEN_REMOTE=0` closes the reads too). Prefer one of:

- Home Assistant on the same host, talking to `http://127.0.0.1:5555`
- Tailscale, or an SSH tunnel, to the loopback port
- `SPARKDASH_TOKEN`, which this integration sends as `Authorization: Bearer`

Do not put an open dashboard on the public internet for this integration.

## Install

Copy the component folder, not this README, into the Home Assistant config directory:

```bash
mkdir -p /path/to/config/custom_components
cp -R homeassistant/custom_components/sparkdash /path/to/config/custom_components/sparkdash
```

The result must be `config/custom_components/sparkdash/manifest.json`. Restart Home Assistant, then **Settings → Devices & services → Add integration → sparkDash**.

| Field | Value |
|-------|--------|
| Dashboard URL | Base URL only, no path. `http://127.0.0.1:5555` on the same host, or `http://<hub-lan-ip>:5555` from another host |
| Access token | The `SPARKDASH_TOKEN` value, or empty when the hub has no token |

Setup calls `GET /api/sparks` once. A non-URL, a hub that does not return a `sparks` list, and a rejected token each fail in the form instead of creating an entry. The same URL cannot be added twice. To change the token, remove the integration and add it again.

## What it adds

One device per Spark already returned by `GET /api/sparks`. The name, manufacturer and model come from that payload (`name`, `hardware.device`). Every 30 seconds the coordinator refreshes the fleet, then `GET /api/sparks/:id/metrics` for each id. A Spark whose metrics call fails is marked offline; the others stay.

| Entity | Source |
|--------|--------|
| Online | `online` |
| GPU temperature | `metrics.gpu.temperature` |
| GPU usage | `metrics.gpu.usage` |
| GPU power | `metrics.gpu.power.draw` |
| System power | `metrics.gpu.power.systemDraw` |
| VRAM | `metrics.gpu.vram.percentage` |
| CPU usage | `metrics.cpu.usage` |
| CPU temperature | `metrics.cpu.temperature` |
| Memory | `metrics.ram.percentage` |
| OOM risk | `metrics.unifiedMemory.oomRisk` |
| Model | `metrics.llm[0].modelId` |
| Decode speed | `metrics.llm[0].generationTps` |
| Active slots | `metrics.llm[0].slotsActive` |
| Uptime | `uptime` (seconds) |

Only the first probed engine is shown. API keys, wallet fields and `modelPath` are not copied into entity state.

## Limits

- A Spark added in the dashboard after setup does not appear until you reload the sparkDash integration (**Settings → Devices & services → sparkDash → Reload**).
- The access token is stored in the config entry. It is not a Home Assistant entity, and it is not written to sparkDash.
- There is no options flow, no power control, and no bench trigger.

## Development

The component is plain Python and imports Home Assistant at runtime, so this repo does not run it under `npm test`. `server/__tests__/homeassistant-docs.test.js` only checks that this guide stays linked and that the component tree does not carry a sample LAN address or a token.
