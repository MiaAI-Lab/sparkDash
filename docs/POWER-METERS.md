# Power meters (wall power)

sparkDash estimates each unit's power from GPU and CPU telemetry: the GPU board draw as
measured, the CPU draw modelled from utilization, plus a flat 23 W. On a DGX Spark that
estimate reads roughly 30–40 % below the wall, because it leaves out power-supply losses and
everything else in the box. If your units sit on metered outlets (a smart power strip, a smart
plug, a metered PDU), sparkDash can read those meters and record **wall power** next to the
estimate.

This is opt-in, and it extends the existing energy accounting instead of adding a second one:

- **Nothing runs without a config file.** With no `config/power-meters.json` sparkDash makes no
  meter requests, and the Energy page, `/api/fleet-energy` and its files are exactly as before.
- **One store.** Wall power is recorded by the fleet-energy tracker in the same minute buckets
  and monthly archive as the estimate, as additional fields. The estimate's own fields, files
  and API fields are unchanged.
- **One dashboard.** With meters configured the Energy page's figures (energy, cost,
  efficiency, the charts) are wall power, with GPU (measured) and CPU (modelled) drawn over it
  and added to the By-node table. The raw estimate is not shown once the wall is measured: it
  reads below the wall, and only serves to fill gaps, scaled.
- **Meters are providers.** A provider reads one kind of meter. Home Assistant is the first,
  which already covers most smart plugs and strips (Matter, Zigbee, Wi-Fi) and many PDUs
  through their HA integrations. See [Adding a provider](#adding-a-provider).

## Configure

Create `config/power-meters.json`, or point `POWER_METERS_CONFIG_PATH` at the file:

```json
{
  "meters": {
    "ha": {
      "type": "homeassistant",
      "url": "https://homeassistant.local:8123"
    }
  },
  "units": {
    "spark-a": {
      "meter": "ha",
      "channel": "sensor.power_strip_outlet_3_power",
      "since": "2026-08-13T00:00:00Z"
    },
    "spark-b": {
      "meter": "ha",
      "channel": "sensor.power_strip_outlet_4_power",
      "since": "2026-08-13T00:00:00Z"
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `meters.<id>` | One meter. `<id>` is your name for it. |
| `meters.<id>.type` | Provider: `homeassistant`. |
| `units.<unitId>` | A registered unit's id (as in `sparks.json`) mapped to one meter channel. An id sparkDash does not know is shown in the status, but not recorded. |
| `units.<unitId>.channel` | The provider's name for that outlet's power reading (for Home Assistant, a power sensor's entity id). |
| `units.<unitId>.since` | Optional ISO time the unit was plugged into that outlet. Meter history from before it is ignored, so readings from whatever used the outlet earlier are not counted. |
| `pollIntervalMs` | How often each meter is read, default `10000` (5–300 s). The tracker's 2 s energy sampler only uses the last reading; it never contacts the meter. |
| `staleAfterMs` | A reading older than this (by the meter's own timestamp) is not used; default `max(30 s, 3 × poll)`. Plugs that report only on change (many Zigbee and Z-Wave meters report every 1–5 minutes) need a larger value, up to 900 s; the symptom of a value that is too small is a meter that flaps between "stopped reading" and "recovered" while nothing is recorded. |
| `history.enabled` | Read the meters' own history, default `true`. |
| `history.backfillDays` | How far back the first start backfills, default `400`. |
| `enabled` | `false` switches the feature off without deleting the file. |

The file holds no credentials: a meter that needs one reads it from its own `SPARKDASH_`
environment variable (`SPARKDASH_HA_TOKEN` for Home Assistant). An invalid file keeps the
feature off, logs the reason and shows it on the Energy page. Restart sparkDash after editing the file. If a unit's channel or meter changes, its wall
minutes in the 31-day window came from another outlet and are dropped; Monthly keeps what was
already archived, and a meter with history loads the last day again.

### Home Assistant

- **Channel**: any sensor with a power unit (`W`, `kW`, `mW`), such as a plug's or strip
  outlet's power entity. Its `last_reported` time decides freshness, so a device that stops
  reporting goes stale even while HA still shows its last value. `unavailable`/`unknown` is a
  missing reading, never zero.
- **Token**: a long-lived access token in the `SPARKDASH_HA_TOKEN` environment variable, like
  `SPARKDASH_MQTT_PASSWORD`; the docker-compose files pass it through from `.env`. It is never
  read from the config file, which is rejected if it holds a `token`. Give sparkDash its own HA
  user, so the token can be revoked on its own.
  The token can do anything that user can, so a read-only user is enough and safer.
- **History** comes from the recorder's long-term statistics over HA's WebSocket API, so the
  sensor needs a `state_class` (power sensors from integrations normally have
  `measurement`). HA keeps 5-minute statistics for its purge window (10 days by default) and
  hourly statistics indefinitely.
- **TLS**: an HA with a private CA needs that CA trusted by Node:
  `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. Without it the meter reports
  `TLS certificate not trusted`.
- **Outbound policy**: the HA host follows the same rules as unit, LLM and alert targets
  (`server/validate.js`). It must be an allowed target when the file loads; before each poll
  and each history session it is resolved, an answer that is a forbidden address (link-local
  and cloud metadata, multicast, unspecified) refuses the request, and the connection is pinned
  to the checked addresses, so DNS rebinding cannot redirect it. LAN, Tailscale and loopback
  addresses are allowed. Plain `http://` works on the LAN, as Home Assistant is commonly set
  up; prefer `https://` where the token crosses a network you do not trust.
- **Bounds**: a state read times out after 8 s by default (`timeoutMs`, 0.5–60 s, and never
  later than the next poll) and is capped at 64 KiB; a history session has a 60 s deadline,
  each WebSocket message is capped at 8 MiB, and a history request is abandoned after 120 s.

## How wall power is recorded

**Live first.** Each meter is read every `pollIntervalMs`. The fleet-energy sampler, which runs
every 2 s, integrates the latest fresh reading into the same minute buckets as the estimate.

**Then the meter's own record.** For a meter that keeps history, a pass 45 s after every
5-minute boundary fetches its 5-minute statistics and overwrites the minutes they cover. Once an
hour it also fetches hourly statistics, which fill minutes no 5-minute figure confirmed. Live
readings never overwrite a confirmed minute.

**One boundary.** When meters are first configured, wall power gets a fixed boundary: the start
of the hour one day earlier (`wallStartMs`, kept in the monthly archive). Every hour of a
meter's record is counted on exactly one side of it:

- *Before the boundary*, the meter's hourly statistics go straight into the monthly archive as
  hourly totals, back to each unit's `since` (at most `history.backfillDays`). They never become
  minutes. An import mark per unit stops an hour from being imported twice. The hours inside
  the 31-day window are also kept as they are (`wallHours` in `fleet-energy.json`, at most 744
  per unit) for the Energy page's views to read. They are only shown: Monthly already has
  them, and nothing folds them. Months before the boundary carry per-unit wall totals, but
  fleet figures (and so Wh per token) only when every configured unit was imported together.
- *From the boundary on*, wall power lives in minutes: the first pass loads the last day from
  the meter's 5-minute statistics (the same step every later pass repeats over its 6-hour
  lookback), then live readings and the passes above take over. Monthly folds these minutes.

So the backfill writes at most a day of minutes, and nothing in the 31-day window before the
boundary is rewritten: those minutes keep the estimate only. For each of those hours the
views show the meter's hourly figure instead, measured for the whole hour and never filled on
top, or fill the hour from the estimate (see below) where the meter has no figure. 24 h and
31 d totals count an hour cut by their edge pro rata. A unit metered later than the others is imported up to the
boundary and recorded in minutes from its own start; the time in between stays filled. After
downtime, the first pass continues from where the last one stopped, inside the window.

**Monthly archive.** Wall minutes are folded into their month only once the meter has
confirmed them, or after an hour if the meter cannot be reached. A minute is counted once, and
with the meter's figure where there is one. GPU and CPU parts fold with the estimate.

**Starting over.** `DELETE /api/fleet-energy/wall?confirm=delete-wall-power` removes every
wall figure: the minutes' wall entries, the months' wall fields (and months that held nothing
else), the boundary and the meter bookkeeping. The estimate and its GPU/CPU parts stay. With
meters still configured, recording starts again with a new boundary and the next pass reloads
the meter's history.

**Gaps are filled from the estimate.** Where no meter measured (a gap in the meter, or a unit
with no meter), wall power is filled as estimate × a ratio learned per unit: measured wall ÷
estimate over the last 7 days of minutes where both were complete. A unit needs an hour of
overlap for its own ratio; until then, and for units without a meter, the fleet's ratio is used.
Ratios outside 0.5–4 are ignored: such an outlet is measuring something else as well. Filled
energy is kept apart from measured energy in every payload (`…FilledWh`/`…FilledMs`), and the
page says how much of a range was filled. Time neither the meter nor the estimate covered is
left out.

**On disk.** Minutes that only hold wall data (time sparkDash was not running) are stored
without the estimate's empty fields, and the new fields are rounded to a microwatt-hour.
`fleet-energy.json` is rewritten in full at most hourly and on shutdown; every 30 s only the
minutes changed since then go to `fleet-energy.recent.json`, which loading merges back in.

Coverage and efficiency follow the estimate's rules. Per-unit figures count while that unit was
covered, fleet figures only while every unit was. Wh per token counts minutes the whole fleet
was covered.

## Is it working?

- **The Energy page** shows a chip per meter next to *Updated*: green while it reads, red when it
  does not, with the address, poll interval, how far its record reaches and each unit's reading
  on hover. A warning banner appears only when a meter stops reading or its history fails.
- **The Activity log** records when a meter connects, stops reading and recovers, when history
  has been loaded, and when loading history fails.
- **`GET /api/power-meters`** returns the same status as JSON.
- **Prometheus** (with export on): `sparkdash_power_meter_up{meter,type}` and
  `sparkdash_wall_power_watts{unit,meter}` for every fresh reading.

## API

The energy figures are part of the existing routes, as additional fields:

| Route | Added while meters are configured |
|-------|-----------------------------------|
| `GET /api/fleet-energy` | `wall`: the estimate's summary fields for wall power (`currentWatts30s`, `energy24hKwh`, coverage, `hourlyWatts24h`, …), plus `freshNodeIds`, `filledNodeIds`, `ratios`, `filledEnergy24hKwh` |
| `GET /api/fleet-energy/history` | `wallNodeIds`, `wallRatios`; per hour `nodeWallWh`, `nodeWallCoverageMs`, `nodeWallMeteredMs`, `nodeWallFilledWh`, `nodeWallFilledMs`, `avgWallWatts`, `fleetWallWh`, `fleetWallFilledWh`, `fleetWallCoverageMs`, `wallCoveredOutputTokens` |
| `GET /api/fleet-energy/monthly` | per month `totalWallWh`, `totalWallFilledWh`, `fleetWallWh`, `fleetWallFilledWh`, `fleetWallCoverageMs`, `wallWhPerOutputToken`; per node `wallWh`, `wallCoverageMs`, `wallMeteredMs`, `wallFilledWh`, `wallFilledMs` |

History rows also carry `nodeGpuWh`, `nodeCpuWh` and `nodePartsCoverageMs`, the estimate's GPU
and CPU parts, for every install, and months carry `gpuWh`, `cpuWh` and `partsCoverageMs` per
node. Both start when sparkDash is upgraded; earlier history has no parts.

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/power-meters` | `enabled`, `state` (`absent`, `disabled`, `invalid` with `error`, or `ok`), each meter's type, display target, health and history state, and each unit's current reading |
| POST | `/api/power-meters/reconcile` | Runs a history pass now; returns the status |
| DELETE | `/api/fleet-energy/wall?confirm=delete-wall-power` | Removes all recorded wall power, minutes and months; returns `{ minutes, months }` touched |

All sit behind the dashboard's authentication like the rest of the API. The status also carries
`wallStartMs`, the boundary above.

## Adding a provider

A provider is a class in `server/powermeter/providers/` that extends `PowerMeterProvider`
(`PowerMeterProvider.js` documents each member) and is registered in `providers/index.js`:

```js
export class ShellyPlugProvider extends PowerMeterProvider {
  static type = "shelly";          // the "type" in power-meters.json
  static label = "Shelly";         // the name people see on the page and in the Activity log
  static historyPeriods = [];      // live only: no readHistory

  static validate(spec) { return URL.canParse(spec.url) ? [] : ["url must be a URL"]; }

  async readPower(channels, { signal } = {}) {
    // → Map(channel → { watts, atMs, error? }); atMs is when the meter last reported
  }
}
registerProvider(ShellyPlugProvider);
```

Registration checks that the class extends the base, has a `type` and a `label`, implements `readPower`, and
implements `readHistory` exactly when it lists `historyPeriods` (`5minute`, `hour`). A meter
that cannot give its own timestamp should use the time of the read. Nothing outside
`server/powermeter/` needs to change.
