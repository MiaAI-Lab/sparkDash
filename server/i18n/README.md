# Server message descriptors

API responses retain their original English `error` and `message` fields. The
top-level JSON response boundary can add optional `i18n.error` or
`i18n.message` metadata for a finite recognized vocabulary. It never translates
or traverses nested objects, persisted events, command output, or unknown
diagnostics. Unknown errors and delivery results keep their original shape and raw text.

Health findings and activity summaries can also carry descriptors. Each descriptor
object is capped at three entries and 16 KiB of serialized UTF-8 JSON. If either cap
would be exceeded, the object is omitted and the original fields are retained.
