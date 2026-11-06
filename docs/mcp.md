# MCP and Codemode

MCP is provided by Pi's built-in extension. Use `xenopi mcp --help` for server management and `/mcp` inside a session for connections and authentication.
The user configuration is `~/.xenopi/agent/mcp.json`, or `mcp.json` under `XENOPI_DIR` when set. Trusted projects can use `.xenopi/mcp.json`.

```json
{
  "mcpServers": {
    "local": { "command": "/path/to/server", "args": [] },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${SERVICE_TOKEN}" }
    }
  }
}
```

Servers use Pi's default `codemode` exposure: the model runs JavaScript to discover and call tools without placing every MCP schema in its prompt.
Set a server's `exposure` to `direct` to declare its tools immediately, or `deferred` to load them through `tool_search`.
Tool names follow Pi's `mcp__server__tool` convention. See the [Pi MCP documentation](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/mcp.md).

Tool schemas are passed to Xenolith unchanged. Direct or deferred tools must have schemas supported by the service's renderer; the current Gemma renderer can reject complex schemas such as properties expressed only through `$ref` or `anyOf`.
Codemode keeps those MCP schemas out of the inference request, while Pi and the MCP server retain responsibility for argument validation and execution.

See [upgrading from XenoPi 0.1](development.md#upgrading-from-xenopi-01) for older MCP configurations.
