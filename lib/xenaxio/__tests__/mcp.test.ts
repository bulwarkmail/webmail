import { describe, expect, it } from "vitest";
import { claudeCodeCommand, jsonConfig } from "../mcp";

describe("MCP client settings", () => {
  it("builds the Claude Code command and JSON config", () => {
    expect(claudeCodeCommand("https://app.xenaxio.com/mcp", "xen_mcp_abc")).toBe(
      'claude mcp add --transport http xenaxio https://app.xenaxio.com/mcp --header "Authorization: Bearer xen_mcp_abc"',
    );
    expect(JSON.parse(jsonConfig("https://app.xenaxio.com/mcp", "xen_mcp_abc"))).toEqual({
      mcpServers: { xenaxio: { type: "http", url: "https://app.xenaxio.com/mcp", headers: { Authorization: "Bearer xen_mcp_abc" } } },
    });
  });
});
