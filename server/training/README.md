# JSON training progress

This optional module reads worker-reported JSON documents and presents them on one **Training** page. It is read-only: it does not start or stop jobs, parse framework logs, inspect processes, control evaluation concurrency or schedule resources.

## Enable and choose output folders

```sh
TRAINING_PROGRESS_ENABLED=1 \
TRAINING_PROGRESS_ROOTS='["/srv/training/experiment-a"]' \
npm start
```

The default is **off**, with **no roots**. Each root is an explicit output directory containing one `training-progress.json`. Child folders are not searched. For multiple workers or runs, list their output folders. Roots apply on each configured Unix unit as the collection user. Override them by configured unit ID:

```sh
TRAINING_PROGRESS_ROOTS_BY_UNIT='{"worker-a":["/srv/training/experiment-a"],"worker-b":[]}'
```

An empty per-unit array disables collection for that unit. Paths must be absolute or start with `~/`; `~` refers to the collection user's home. Roots and their fixed document must be ordinary directories/files, not symlinks or special files. Missing, unreadable or malformed documents are reported without replacing known values with zero. Invalid enabled configuration produces a generic error on the page and performs no probes.

Python 3 is required on the dashboard host for native collection and on each SSH target. The standard-library probe is the same for both transports. Windows targets are unsupported in this first slice. An unavailable Python interpreter or SSH transport makes that unit unavailable without stopping other units.

In Docker, local roots are paths visible **inside the dashboard container**. Explicitly mount the output folder read-only, or configure an SSH unit to read the host's files under the appropriate account. The reader does not enter host namespaces, infer a host home directory or use model processes as activity evidence. The runtime image includes Python for the probe.

## Document contract, version 1

Workers atomically replace `training-progress.json`. This example shows reported values, including an unknown total:

```json
{
  "schema_version": 1,
  "id": "experiment-a",
  "source_id": "trainer-0",
  "campaign": "Example experiment",
  "label": "Trainer 0",
  "model": "Example model",
  "updatedAt": 0,
  "stages": {
    "data": [],
    "training": [{
      "id": "fit",
      "label": "Training",
      "state": "running",
      "completed": 120,
      "total": null,
      "unit": "steps",
      "etaSeconds": 300,
      "metrics": [{"label": "Loss", "value": 0.42}]
    }],
    "evaluation": []
  }
}
```

Replace `updatedAt: 0` with the worker's actual epoch timestamp in **milliseconds**. The static example is intentionally expired; it does not establish activity. The [synthetic example](../../examples/training-json/) publishes current timestamps without a model or GPU.

- `schema_version`, `id`, `campaign`, `updatedAt` and `stages` identify a report. `source_id`, `label` and `model` are optional. Run IDs are supplied by workers; the same ID joins sources across units. Source identity is scoped to the configured unit and explicit `source_id` or output-folder identity. Different experiments should use different run IDs.
- `stages` can contain the `data`, `training` and `evaluation` arrays; an omitted group is empty. Each row has an `id`, `label` and explicit `state`: `running`, `waiting`, `complete`, `stopped`, `failed` or `unknown`.
- `completed`, `total` and `unit` may be omitted or `null`. Unknown values stay unknown; a reported zero remains zero. State is never inferred from a counter reaching its total.
- `etaSeconds` is optional and must be reported by the worker. The page displays the reported remaining time with its report timestamp. The dashboard does not calculate ETA from throughput, extrapolate it, or invent a finish time.
- Optional `metrics` are worker-reported labels, values and units. They are displayed without choosing an optimization goal, comparing checkpoints or treating throughput as a quality score.
- Unrecognized fields do not become public fields. Text is bounded and rendered as text, not HTML. Do not put secrets, prompts or examples into report labels or metrics.

Each group is limited to sixteen stages, and each stage to eight metrics. IDs are at most 96 characters; names/labels have limits of 80–160 characters depending on the field, and units at most 32. Counts must be finite nonnegative numbers no greater than JavaScript's maximum safe integer; reported ETA is bounded to one year. Each normalized report is at most 32 KiB, within the input and global limits below. The implementation's field validation and synthetic tests define the accepted bounds. Reports are metadata only; no model weights, datasets or executable training objects are loaded.

## Freshness and bounded retention

Polls occur every ten seconds with no overlapping collection for the same unit. Worker `updatedAt` determines freshness: a report no more than thirty seconds old can describe current work. A successful filesystem read does **not** refresh that worker timestamp or prove that its process is alive. Workers should publish a heartbeat with their current reported state more frequently than every thirty seconds.

Older reports are shown as stale. Collection failure or disappearance retains the last known report with an unavailable/stale status rather than manufacturing progress or completion. Worker timestamps more than five seconds in the future are rejected. Every report expires one hour after its own timestamp, including completed reports; rereading a file never extends that retention. Removing a unit or its configured root removes the corresponding cached data.

Bounds are sixteen roots per unit, thirty-two collected units, sixty-four retained reports globally, thirty-two sources per run, and one MiB for normalized retained data/response. Each input document is at most 64 KiB, per-unit probe output is at most 256 KiB, and each probe has an eight-second timeout. When count or byte bounds are reached, the response explicitly reports truncation. There is no persistent history database or background artifact import.

The module self-registers one `GET /api/training-progress` route behind the dashboard's existing authentication and host checks. While disabled it returns 404 and starts no collection. A read-only `trainingProgressEnabled` capability in `/api/settings` gates the page and navigation; it is configured through the server environment, not saved through Settings.

## Example and verification

Use [the synthetic worker](../../examples/training-json/) to verify the complete path from atomic report to page. Its input documents and test fixtures contain no private deployment details or real training results.

The backend uses `server/collectors/TrainingProgressCollector.js` for the unit-specific read and a small feature module for the one provider, normalized snapshots and route. Tests use temporary files and isolated server configuration. Run the standard repository checks: `npm run typecheck`, `npm run build` and `npm test`.
