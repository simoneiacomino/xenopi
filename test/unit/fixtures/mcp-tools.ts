import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const ECHO_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "The message to echo back." },
  },
  required: ["message"],
  additionalProperties: false,
};

export const FAIL_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const PYDANTIC_SCHEMA = {
  $defs: {
    Priority: {
      enum: ["low", "high"],
      title: "Priority",
      type: "string",
    },
    Filter: {
      properties: {
        field: { title: "Field", type: "string" },
        values: { items: { type: "string" }, title: "Values", type: "array" },
      },
      required: ["field"],
      title: "Filter",
      type: "object",
    },
  },
  properties: {
    query: { title: "Query", type: "string", description: "Search text." },
    limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null, title: "Limit" },
    priority: { $ref: "#/$defs/Priority" },
    filters: {
      anyOf: [{ items: { $ref: "#/$defs/Filter" }, type: "array" }, { type: "null" }],
      default: null,
      title: "Filters",
    },
    mode: { const: "fast", title: "Mode" },
    freeform: { title: "Freeform" },
  },
  required: ["query", "priority", "freeform"],
  title: "searchArguments",
  type: "object",
};

export function createFixtureServer(label: string): Server {
  const server = new Server(
    { name: `xenopi-fixture-${label}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: `Echo a message back over ${label}.`,
        inputSchema: ECHO_SCHEMA,
      },
      {
        name: "boom",
        description: "Always fails.",
        inputSchema: FAIL_SCHEMA,
      },
      {
        name: "search",
        description: "A pydantic-shaped search tool.",
        inputSchema: PYDANTIC_SCHEMA,
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search") {
      return { content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }] };
    }
    if (request.params.name === "boom") {
      return { content: [{ type: "text", text: "boom failed" }], isError: true };
    }
    const args = (request.params.arguments ?? {}) as { message?: unknown };
    return {
      content: [{ type: "text", text: `${label}:${String(args.message ?? "")}` }],
    };
  });
  return server;
}
