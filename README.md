# What is XenoPi

XenoPi is a small distribution of [pi](https://github.com/earendil-works/pi) that talks to Xenolith through its wire protocol.
I made it to try the protocol with a real coding agent.

The adapter translates pi's requests into Xenolith sessions. So when you continue a conversation it can append the new turn, and things like rewinds and checkpoints can use the same session too.
This is mainly a demo of the protocol. For the engine, the hardware and the model, see the [Xenolith README](https://github.com/simoneiacomino/xenolith/blob/main/README.md).

# Build and run

You need Node.js 26 or newer, a built Xenolith binary, and the model described in the Xenolith README.
From this directory:

```sh
npm ci
npm run build
XENOLITH_BIN=/path/to/xenolith XENOLITH_MODEL=/path/to/model.gguf node dist/src/bin/xenopi.js
```

XenoPi starts the Xenolith service when it needs it. The model stays on your machine.
