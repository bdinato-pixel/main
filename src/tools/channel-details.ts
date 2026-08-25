import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getChannelsByIds } from "../services/youtube-client.js";
import { toChannelSummary } from "../services/format.js";
import { ResponseFormat } from "../types.js";
import type { ChannelSummary } from "../types.js";

const ChannelDetailsInputSchema = z
  .object({
    channel_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe("List of YouTube channel IDs (1-50 items), e.g. ['UC_x5XG1OV2P6uZZ5FSM9Ttw']"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
  })
  .strict();

type ChannelDetailsInput = z.infer<typeof ChannelDetailsInputSchema>;

function toMarkdown(channels: ChannelSummary[]): string {
  const lines = [`# Channel details (${channels.length})`, ""];
  channels.forEach((c) => {
    lines.push(`## ${c.channel_title}`);
    lines.push(`- **Subscribers**: ${c.subscriber_count === null ? "hidden" : c.subscriber_count.toLocaleString("en-US")}`);
    lines.push(`- **Total videos**: ${c.video_count === null ? "n/a" : c.video_count.toLocaleString("en-US")}`);
    lines.push(`- **Total channel views**: ${c.total_view_count === null ? "n/a" : c.total_view_count.toLocaleString("en-US")}`);
    lines.push(`- **Country**: ${c.country ?? "n/a"}`);
    lines.push(`- **URL**: ${c.url}`);
    lines.push("");
  });
  return lines.join("\n");
}

export function registerChannelDetailsTool(server: McpServer): void {
  server.registerTool(
    "youtube_get_channel_details",
    {
      title: "Get YouTube Channel Details",
      description: `Fetch subscriber count, total video count, and total view count for one or more YouTube channels by channel ID.

Use this to understand how established a channel is (e.g. to check whether a top-viewed video came from a huge established channel or a small one that went viral). It does NOT list a channel's individual videos.

Args:
  - channel_ids (string[]): 1-50 YouTube channel IDs (the 'channel_id' field returned by youtube_search_videos, youtube_get_video_details, or youtube_analyze_topic)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: For each channel: title, subscriber count (or 'hidden' if the owner disabled it), total video count, total channel view count, country, and URL.

Examples:
  - Use when: "How big is the channel that posted the top result?" -> channel_ids=["<channel_id>"]
  - Don't use when: You need a list of a channel's videos (not supported by this tool)

Error Handling:
  - Returns an error message if YOUTUBE_API_KEY is missing or invalid
  - Returns "No channels found" if none of the given IDs resolve to a public channel`,
      inputSchema: ChannelDetailsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ChannelDetailsInput) => {
      try {
        const channelDetails = await getChannelsByIds(params.channel_ids);
        const channels = channelDetails.map(toChannelSummary);

        if (channels.length === 0) {
          return { content: [{ type: "text" as const, text: "No channels found for the given IDs." }] };
        }

        const output = { count: channels.length, channels };
        const textContent =
          params.response_format === ResponseFormat.MARKDOWN ? toMarkdown(channels) : JSON.stringify(output, null, 2);

        return {
          content: [{ type: "text" as const, text: textContent }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  );
}
