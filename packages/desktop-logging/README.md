# Desktop logging 0.1.0

This workspace package provides Prismical's shared diagnostic contracts and
logging pipeline. It contains no Electron, filesystem, database, authentication,
or telemetry dependency.

Application services inject `MainLogger` and use `scoped`. Synchronous transport
callbacks capture `scopedSync` from that service. Both methods construct the same
bounded record. `appRunId` is the app-owned launch identity and is also used by
telemetry. The app-owned writer receives normalized records and destination flags;
it owns paths, rotation, persistence failures, and emergency fallback.

`makeWire` prepares renderer/worker records. `ingest` validates and normalizes the
wire fields, then supplies product and process identity from trusted arguments.
It returns false for invalid input or a failed writer. Source timestamps are UTC
ISO strings, not a cross-process ordering guarantee. Native stdout RPC remains
separate; `makeLineDecoder` handles diagnostic stderr/worker pipe framing.

## Shared limits

Records and stream lines: 16 KiB UTF-8; nesting: 5; traversed values: 256;
object keys: 32; array items: 32; string: 2048 characters; error stack: 4096
characters; error cause projection depth and aggregate fanout: 3; scope: 128
characters. Truncation is explicit and preserves the envelope and error codes.
Decoder batches hold at most 128 lines and 1 MiB. App-owned asynchronous queues
use those same bounds and account for dropped records. Decoder fragments stay
within the line limit, including when a process never emits a newline.

Production defaults are info+ file and warn+ console. Development is debug+.
Scope selection enables matching debug only (production file, development both).
An explicit valid `LOG_LEVEL` overrides scope selection. Scope configuration is
bounded to 1024 characters and 16 patterns; case-insensitive exact names or
slash-delimited regexes are accepted. The supported regex subset permits literals,
escaped characters, character classes, anchors, alternation, and at most one
`*`, `+`, or `?` repetition outside character classes. Groups, backreferences,
counted repetitions, and multiple repetitions (including lazy quantifiers) are
rejected to avoid expensive backtracking on the synchronous path. Exact scope
names and patterns such as `/whisper.*/` remain supported. Invalid configuration
returns one issue per control and uses defaults; apps write those issues once.

Privacy applies at every level. The codec masks secret/content keys, obvious
credentials, OAuth URL queries, and personal path components. This does not make
arbitrary prose safe: producers must remove transcripts, prompts, response bodies,
and clipboard/accessibility dumps at source. Local error details are separate
from the narrower telemetry property allowlists.

Use `pnpm test` to run the conformance tests.
