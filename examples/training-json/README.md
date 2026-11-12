# Synthetic JSON progress example

This example performs no training and loads no model. Python 3.11+ writes an atomic `training-progress.json` report with preparation, training and evaluation stages. All names, counters and model information are synthetic.

Choose an output folder and configure that exact folder as a root on its corresponding dashboard unit:

```sh
python3 examples/training-json/demo.py --output-dir /tmp/sparkdash-training-example
```

For a local, native dashboard:

```sh
TRAINING_PROGRESS_ENABLED=1 \
TRAINING_PROGRESS_ROOTS='["/tmp/sparkdash-training-example"]' \
npm start
```

Add the host running the example as a configured unit, then open **Training** in the dashboard navigation. The reader checks only `ROOT/training-progress.json`; it does not search child folders. For SSH units, use the output folder as seen by the SSH account. In Docker, configure paths available inside the dashboard container or use an SSH unit to read the host's files.

The worker updates `updatedAt` every second. No update for more than 30 seconds makes its report stale; collection does not refresh that timestamp. The final completed report is retained for at most one hour from its own `updatedAt`, subject to the global count/byte bounds. A static JSON file does not establish continuing activity.

For real code, publish the same [document contract](../../server/training/README.md) from your worker. Report only known counters, states and ETA. Write `null` for unknown values, and update `updatedAt` only when the worker actually reports. The demo's ETA is calculated by the synthetic worker from its known loop duration, rather than inferred by the dashboard. Stop or failure should be reported explicitly when possible; a crashed reporter eventually becomes stale and expires.
