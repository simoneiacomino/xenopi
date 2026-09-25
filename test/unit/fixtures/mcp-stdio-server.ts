import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFixtureServer } from "./mcp-tools.js";

const server = createFixtureServer("stdio");
await server.connect(new StdioServerTransport());
