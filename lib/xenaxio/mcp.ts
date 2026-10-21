// Ready-made client settings for a personal MCP token (spec M4).

/** Name of the server entry in the user's MCP client. */
const SERVER_NAME = "xenaxio";

export function claudeCodeCommand(url: string, token: string): string {
  return `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}

export function jsonConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
