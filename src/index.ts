#!/usr/bin/env node
/**
 * MCP server for searching YouTube and analyzing the top viewed videos for a topic.
 * Uses the public YouTube Data API v3 (requires a free YOUTUBE_API_KEY).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchVideosTool } from "./tools/search-videos.js";
import { registerVideoDetailsTool } from "./tools/video-details.js";
import { registerChannelDetailsTool } from "./tools/channel-details.js";
import { registerAnalyzeTopicTool } from "./tools/analyze-topic.js";

const server = new McpServer({
  name: "youtube-mcp-server",
  version: "1.0.0",
});

registerSearchVideosTool(server);
registerVideoDetailsTool(server);
registerChannelDetailsTool(server);
registerAnalyzeTopicTool(server);

async function main(): Promise<void> {
  if (!process.env.YOUTUBE_API_KEY) {
    console.error(
      "ERROR: YOUTUBE_API_KEY environment variable is required. " +
        "Create one at https://console.cloud.google.com/apis/credentials after enabling the 'YouTube Data API v3'.",
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("youtube-mcp-server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
