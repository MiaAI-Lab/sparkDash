# shared/ — Seam Contracts

This directory holds the **seam contracts** for the multi-Spark dashboard. A seam is any
format that crosses a batch boundary: one batch produces it, another consumes it. Workers
see only their own slice and treat already-committed upstream code as ground truth — so
the seam is pinned here, and only Batch 0 (creation) and Batch 5B (finalization) may
modify it.

## Files

| File | Purpose | Producer | Consumers |
|---|---|---|---|
| `types.ts` | Canonical TypeScript types (no runtime code) | Batch 0 | All batches (JSDoc references) |
| `api.schema.json` | JSON Schema for `NodeAgentSnapshot` (the /telemetry response) | Batch 0 | Batch 1A (validate), Batch 3A (consume), Batch 4A/4B (render) |
| `recipe.schema.json` | JSON Schema for per-node recipe files (`config/recipes.json`) | Batch 0 | Batch 1B (validate), Batch 2A/2B (consume), Batch 5A (extend) |

## Conventions

- **Timestamps:** ms epoch (`number`), ISO-8601 strings only where noted.
- **Memory:** MB (megabytes) unless suffixed GB/KB.
- **Percentages:** 0–100.
- **Nullability:** `null` = not available / not yet polled; `[]` = none.
- **Producer/consumer:** node agent PRODUCES `NodeAgentSnapshot`, `VersionInfo`,
  `ServiceInstance`, `MemoryBudget`, `RequestStats`, `TopologyInfo`, `ContainerInfo`,
  `ActionResponse`. Dashboard server PRODUCES `FleetSnapshot` (aggregated). Frontend
  CONSUMES both.

## How to validate

```bash
# Validate a NodeAgentSnapshot against api.schema.json
node -e "
const { validate } = require('ajv');
const schema = require('./shared/api.schema.json');
const snapshot = require('./test-fixture.json');
const ajv = new validate();
const valid = ajv.compile(schema)(snapshot);
console.log(valid ? 'VALID' : 'INVALID: ' + ajv.errors);
"

# Validate a recipe file against recipe.schema.json
node -e "
const { validate } = require('ajv');
const schema = require('./shared/recipe.schema.json');
const recipes = require('./agent/config/recipes.example.json');
const ajv = new validate();
const valid = ajv.compile(schema)(recipes);
console.log(valid ? 'VALID' : 'INVALID: ' + ajv.errors);
"
```

## Changing a seam

If a batch needs to change a seam (add a field, change a type), it must:
1. Update `types.ts` (canonical type)
2. Update the relevant `.schema.json` (JSON Schema)
3. Enumerate **every consumer** (production readers AND tests that parse the shape)
4. Update all consumers in the same batch (or a follow-on batch)
5. Add a **seam invariant** test: the producing batch's real output validates against the schema

**Trusted vs suspect:** Batch 0 produces the schemas (trusted). All other batches consume
(trusted). If a batch changes a schema, it owns the change end-to-end.
