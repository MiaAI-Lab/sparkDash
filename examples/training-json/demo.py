#!/usr/bin/env python3
"""Write synthetic JSON progress; no model, framework or GPU is used.

Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
"""
import argparse
import json
import os
from pathlib import Path
import tempfile
import time


def publish(output, stages):
    document = {
        "schema_version": 1,
        "id": "synthetic-example",
        "source_id": "example-worker",
        "campaign": "Synthetic JSON progress",
        "label": "Example worker",
        "model": "Example model",
        "updatedAt": round(time.time() * 1000),
        "stages": stages,
    }
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=output, prefix=".progress-", delete=False) as file:
            temporary = Path(file.name)
            json.dump(document, file, allow_nan=False)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, output / "training-progress.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--interval", type=float, default=1)
    args = parser.parse_args()
    if not 1 <= args.steps <= 1000 or not 0 < args.interval <= 10:
        parser.error("steps must be 1–1000 and interval must be greater than 0 and at most 10 seconds")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stages = {
        "data": [{"id": "prepare", "label": "Prepare synthetic examples", "state": "complete", "completed": 100, "total": 100, "unit": "samples"}],
        "training": [{"id": "train", "label": "Synthetic training", "state": "running", "completed": 0, "total": args.steps, "unit": "steps"}],
        "evaluation": [{"id": "evaluate", "label": "Synthetic evaluation", "state": "waiting", "completed": None, "total": None, "unit": None}],
    }
    print(f"Writing synthetic reports to {args.output_dir / 'training-progress.json'}", flush=True)
    try:
        for step in range(args.steps + 1):
            row = stages["training"][0]
            row["completed"] = step
            # The synthetic worker knows its loop duration and reports this ETA.
            # sparkDash does not calculate or extrapolate this field.
            row["etaSeconds"] = (args.steps - step) * args.interval
            publish(args.output_dir, stages)
            time.sleep(args.interval)
        stages["training"][0]["state"] = "complete"
        stages["training"][0].pop("etaSeconds", None)
        for step in range(6):
            stages["evaluation"][0].update(state="running", completed=step, total=5, unit="samples")
            publish(args.output_dir, stages)
            time.sleep(args.interval)
        stages["evaluation"][0]["state"] = "complete"
        publish(args.output_dir, stages)
    except KeyboardInterrupt:
        for rows in stages.values():
            for row in rows:
                if row["state"] in ("running", "waiting"):
                    row["state"] = "stopped"
                    row.pop("etaSeconds", None)
        publish(args.output_dir, stages)
        raise SystemExit(130)
    print("Synthetic worker finished; its last report expires from the dashboard after one hour.")


if __name__ == "__main__":
    main()
