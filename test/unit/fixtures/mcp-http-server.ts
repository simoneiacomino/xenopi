import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFixtureServer } from "./mcp-tools.js";

export interface HttpFixture {
  url: string;
  rejected: number;
  close(): Promise<void>;
}

export async function startHttpFixture(token: string): Promise<HttpFixture> {
  const mcp = createFixtureServer("http");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);

  const state = { rejected: 0 };
  const http: HttpServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      state.rejected++;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    void transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    get rejected(): number {
      return state.rejected;
    },
    async close(): Promise<void> {
      await transport.close();
      await mcp.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
