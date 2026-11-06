# Images

Configure the model and matching projector once in Xenolith. For a new setup:

```sh
xenolith config init \
  --model /absolute/path/to/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf \
  --mmproj /absolute/path/to/mmproj-F16.gguf --ctx 65536
```

For an existing setup, update the native configuration rather than running
initialization over it. `XENOLITH_MMPROJ` and an existing `mmproj` in XenoPi's
`xenolith.json` remain explicit overrides; XenoPi passes them as `--mmproj`
only when starting Xenolith. An already running service supplies its actual
capabilities through `describe`; no projector argument is needed for each image.
Use the same pinned model and F16 projector documented and verified in Xenolith.
This implementation currently supports vision at 65536 and 131072 context
positions; the engine validates that limit. Text-only services remain supported.

Attach a local PNG/JPEG:

```sh
xenopi @/path/to/image.jpg "Describe this image"
```

You can continue chatting about it. Within an existing chat, ask the agent to
use its standard `read` tool on an image. Image-producing tools, including screenshots and
MCP results, use Pi's ordinary typed image content. XenoPi sends encoded bytes,
so the file must exist on the client machine, not on the Xenolith server.

One image per user message or tool result is supported. Send other images in
separate turns. Text blocks in a message form its caption. Unsupported formats and requests
exceeding the service's image or frame limits fail explicitly. Pi may
resize images before storing them in history according to its normal settings.

The visual budget defaults to the value advertised by Xenolith (currently 280).
Set `imageBudget` in `xenolith.json`, or `XENOLITH_IMAGE_BUDGET`, to choose another
advertised budget (currently 70, 140, 280, 560 or 1120). Increasing it costs more
encoder work and context space. Changing it rebuilds affected visual prefixes.

Pi sessions retain inline bytes; Xenolith retains its own source media. Reopening,
forking and rebuilding therefore do not depend on the original file path.
Visual compaction and branch summaries receive the images;
a failed visual summary cancels that operation and preserves the conversation.

The TUI shows `Preparing image` while waiting for image append/rebuild. The displayed time measures
preparation latency. Xenolith's synchronous
preparation cannot be interrupted by the wire cancel operation: after a user
cancels, XenoPi waits for the in-flight preparation to settle and does not start
another generation. Once generation starts, ordinary wire cancellation applies.

See the [Xenolith vision guide](https://github.com/simoneiacomino/xenolith/blob/main/docs/vision.md)
for engine architecture, limits and persistence contracts.

