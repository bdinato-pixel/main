import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getVideosByIds } from "../services/youtube-client.js";
import { toVideoSummary } from "../services/format.js";
import { extractVideoId } from "../services/video-id.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat } from "../types.js";
import type { VideoSummary } from "../types.js";

const VideoDetailsInputSchema = z
  .object({
    video_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe("List of YouTube video IDs or full video URLs (1-50 items), e.g. ['dQw4w9WgXcQ'] or ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
  })
  .strict();

type VideoDetailsInput = z.infer<typeof VideoDetailsInputSchema>;

function toMarkdown(videos: VideoSummary[]): string {
  const lines = [`# Video details (${videos.length})`, ""];
  videos.forEach((v) => {
    lines.push(`## ${v.title}`);
    lines.push(`- **Channel**: ${v.channel_title}`);
    lines.push(`- **Views**: ${v.view_count.toLocaleString("en-US")}`);
    lines.push(`- **Likes**: ${v.like_count === null ? "hidden" : v.like_count.toLocaleString("en-US")}`);
    lines.push(`- **Comments**: ${v.comment_count === null ? "disabled/hidden" : v.comment_count.toLocaleString("en-US")}`);
    lines.push(`- **Engagement rate**: ${v.engagement_rate_percent === null ? "n/a" : `${v.engagement_rate_percent}%`}`);
    lines.push(`- **Duration**: ${v.duration_human}${v.is_short ? " (Short)" : ""}`);
    lines.push(`- **Published**: ${v.published_at}`);
    lines.push(`- **Tags**: ${v.tags.length > 0 ? v.tags.join(", ") : "none"}`);
    lines.push(`- **URL**: ${v.url}`);
    lines.push(`- **Description**: ${v.description_snippet}`);
    lines.push("");
  });
  return lines.join("\n");
}

export function registerVideoDetailsTool(server: McpServer): void {
  server.registerTool(
    "youtube_get_video_details",
    {
      title: "Get YouTube Video Details",
      description: `Fetch full metadata and statistics for one or more specific YouTube videos by ID or URL.

Use this when you already know which video(s) you want details for. It does NOT search — use youtube_search_videos or youtube_analyze_topic to discover videos first.

Args:
  - video_ids (string[]): 1-50 video IDs or full YouTube URLs (watch, youtu.be, or /shorts/ links all accepted)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: For each video: title, channel, view/like/comment counts, engagement rate, duration, tags, publish date, and description snippet. Videos that no longer exist or are private are silently omitted.

Examples:
  - Use when: "Get stats for this video: https://www.youtube.com/watch?v=dQw4w9WgXcQ" -> video_ids=["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
  - Use when: Comparing several known videos side by side -> pass all their IDs in one call
  - Don't use when: You don't know the video IDs yet (search first)

Error Handling:
  - Returns an error message if YOUTUBE_API_KEY is missing or invalid
  - Returns "No videos found" if none of the given IDs resolve to a public video`,
      inputSchema: VideoDetailsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: VideoDetailsInput) => {
      try {
        const ids = params.video_ids.map(extractVideoId);
        const videoDetails = await getVideosByIds(ids);
        const videos = videoDetails.map(toVideoSummary);

        if (videos.length === 0) {
          return { content: [{ type: "text" as const, text: "No videos found for the given IDs/URLs." }] };
        }

        const output = { count: videos.length, videos };
        let textContent =
          params.response_format === ResponseFormat.MARKDOWN ? toMarkdown(videos) : JSON.stringify(output, null, 2);

        if (textContent.length > CHARACTER_LIMIT) {
          textContent = `${textContent.slice(0, CHARACTER_LIMIT)}\n\n[Response truncated at ${CHARACTER_LIMIT} characters.]`;
        }

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
