# Server localization descriptors

The API continues to return its English `message`, `title`, `detail`, `hint`,
and `error` fields. New application-authored values may also include:

```json
{ "i18n": { "message": { "key": "activity.message.sparkOnline", "params": { "name": "spark-01" } } } }
```

`EventLog.record()` attaches descriptors for fleet, power, Hermes, thermal,
health, benchmark, and launcher events. New health and launcher events include
structured data; browser rendering derives known historical messages without
rewriting persisted history. `HealthEvaluator` attaches descriptors per field,
including actual thresholds and complete Xid/RoCE diagnostics.

The JSON response middleware calls `responseI18n()` for errors, success notices,
and batch results. `src/shared/applicationText.js` recognizes a finite vocabulary
of complete application-authored messages at both server and browser boundaries.
Known dynamic messages extract parameters; arbitrary external errors receive a
translated summary and retain their complete raw detail. Original fields, HTTP
status codes, process output, prompts, scoring inputs and CLI arguments remain
unchanged. Browsers use static translation keys in `src/i18n/messages.ts` at
render time, so existing data responds immediately to a language switch.
