# Xenopi vision integration

Xenopi consumes the existing Xenolith wire v2 implementation. It adds no encoder,
projector, model catalog, HTTP service or new native dependency. The model and
`mmproj-F16.gguf` are configured for service startup once. When connected to an
existing server, `describe` is authoritative, including on reconnect.

## Responsibilities

- Pi owns attachment loading, optional resizing, terminal presentation, tools
  and its JSONL sessions. User and tool messages contain text/image blocks.
- Xenopi validates and translates those blocks, sends inline Base64 or a
  conversation-scoped media reference, and synchronizes session boundaries.
- Xenolith owns preprocessing, visual embeddings, mixed attention, KV caches,
  weight verification, persistent source media and derived embedding caches.

Gemma produces text from the supplied image; this work does not add image
synthesis. The projector remains the exact artifact verified with Xenolith:

| Artifact | SHA-256 |
| --- | --- |
| `mmproj-F16.gguf` | `d00f211a7d4f7fb19bd9b75d8e9342eccffb5920b08fd9562167560fdfcc5dd1` |
| `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf` | `a7c5bc715f5ff8e99a3e8901ce7d2b42b402c669bf24f7c5250747633d0f5891` |

Both artifacts come from `unsloth/gemma-4-26B-A4B-it-qat-GGUF` revision
`7b92b5b28818151e8669af2e45e88d6086f490dd`. Xenolith performs its existing
artifact verification; Xenopi does not add another scan of model weights.

## Transport and persistence

Protocol v1 remains text-only. V2 adds a validated `vision` capability object;
Pi advertises `input: ["text", "image"]` only when that object is present.
Each user message or tool result has at most one image. Its text blocks become
one caption in their original text order. The native wire format does not encode
arbitrary interleaving of text/image blocks or multiple images per message.
Unsupported input fails explicitly.

Images use canonical Base64 of PNG/JPEG encoded bytes. The source identity is
SHA-256 of those bytes, not a path, filename, decoded pixel hash or Base64 string.
Synchronization keys include that identity and visual budget. Server history
references and incoming inline data produce the same key. Model capabilities
must remain unchanged across reconnects; Xenolith independently fingerprints
model, preprocessing and numerical implementation for its caches.

A confirmed media ID may replace inline data in append/rebuild on the same bound
conversation. A new conversation receives bytes; an interrupted append is
reconciled from history before retrying. The original bytes remain in Pi history,
so forks/rebuilds can create a new server conversation. `readImageMedia` also
supports original-byte retrieval through `media`, checks each chunk offset and
total, advances by decoded byte count and verifies the final SHA-256.

Image compaction summarizes the exact prepared messages, including split-turn
prefixes, using an ephemeral visual request. Branch summaries do the same for
Pi's selected entries. They do not mutate the live wire conversation. If a
visual summary fails, compaction/navigation is cancelled rather than falling
back to Pi's image placeholders. Successful compaction leaves older images in
the Pi session tree; its active context uses the summary plus retained messages.

## Limits and waiting

The existing engine supports 64k/128k contexts for vision and visual budgets up
to 1120. Xenopi reads budgets/defaults and byte bounds from the service instead
of changing Xenolith's kernels. With the current engine, limits are 48 MiB per
encoded image, 256 MiB of active media, counting each visual occurrence, and 96 MiB per wire frame.
Large reconstruction requests can still exceed that last bound even if separate
appends fitted; failure preserves Pi's source history. No automatic splitting
or hidden image removal is attempted.

Padding, the 512/1024 text prefill comparison, full visual temporary K/V and the
1024-element local ring remain Xenolith responsibilities. The optional OpenSSL
weight verification dependency remains on the engine side.

Preparation is synchronous and precedes some wire replies/events. `Preparing
image` displays elapsed wall time without invented progress. Cancellation
between operations stops the next request. Cancellation during preparation
waits for its reply, marks synchronization dirty and suppresses generation.
Cancellation during an ephemeral preparation is deferred until the server's
first stream event, because that operation combines preparation and generation.
Unknown results after disconnect are reconciled from saved history.

## Validation

`npm test` includes text-v1 regression tests and image-v2 tests for capabilities,
configuration, translation, budgets, image identity, append/rebuild/fork/resume,
frame/media limits, tool images, interrupted preparation, cancellation, media
retrieval and real Pi attachment/read/compaction workflows with a mock engine.

`test/model/vision.test.ts` uses the real kitten and existing model/projector at
65536 and 131072. It checks recognition, follow-up cache reuse, original-byte
export, service/session restart, visual compaction and the standard `read` tool.
It writes timing and response evidence to `test-logs/vision-65536.json` and
`test-logs/vision-131072.json`. Vision cases are skipped unless
`XENOLITH_MMPROJ` and `XENOLITH_TEST_IMAGE` are configured. Model test files run
serially so they cannot spawn competing weight owners.

Real-machine results and any remaining limitations are recorded after running
that suite; mock-engine passes alone do not establish model quality or latency.

## Lunar Lake results (2026-10-14)

The final unit suite passes 179/179 on macOS and WSL. Real-model checks pass at
65536 and 131072 for attachment recognition, text follow-up/cache reuse, original
media export, CLI attachment, service/session restart, visual compaction, retained
summary recall and the standard read tool. Existing text checks cover tools,
resume, rewind, compaction, overflow recovery, MCP, orphan cleanup and Codemode
reload. The overflow fixture now scales with context capacity so that it tests
token overflow rather than accidentally exceeding the wire frame bound at 64k.

The pre-vision Xenopi baseline is commit `80831d1` (the previous tool-call fix plus
upstream `e92a082`). Matched greedy text requests produced identical answers,
stop reasons and token usage in every sample. After one warm-up per variant,
each capacity uses an ABBA/ABBA sequence with four samples per variant:

| Capacity | Baseline median | Vision-capable client median | Change |
| --- | --- | --- | --- |
| 65536 | 2763.64 ms | 2789.46 ms | +0.93% |
| 131072 | 3250.28 ms | 3030.01 ms | -6.78% |

These are end-to-end client timings for a short text request on a text-only
service, not Xenolith's README prefill/decode throughput benchmarks. Four
samples cannot establish a stable speedup or exclude every regression. The
Xenolith binary and kernels were unchanged.

The final vision run recognized the kitten in 26.59 s at 64k and 29.97 s at
128k, excluding engine startup. Text follow-ups took 7.74 s and 6.78 s. CLI requests made after that image
was already processed can reuse the derived embedding cache; they do not measure
a fresh encoder run. Raw timings, responses, source fingerprints and complete
validation evidence are retained in [validation/vision-lnl-20261014.json](validation/vision-lnl-20261014.json).

The final checkout also passed a CLI run with automatic service startup from
`xenolith.json`: 42.34 s including startup, replying “In questa immagine c'è un
gattino.” No projector argument was supplied to the CLI. The isolated WSL manual
configuration is `/home/simo/dev/xenopi-vision-20261014/manual/agent/xenolith.json`;
the projector path is already recorded there. The test engine was stopped after
verification; saved media and caches remain for subsequent manual tests.
