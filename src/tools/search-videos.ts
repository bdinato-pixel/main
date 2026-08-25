import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getVideosByIds, searchVideos } from "../services/youtube-client.js";
import { toVideoSummary } from "../services/format.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat, VideoOrder } from "../types.js";
import type { VideoSummary } from "../types.js";

const SearchVideosInputSchema = z
  .object({
    query: z.string().min(1).max(200).describe("Search terms, e.g. 'inteligencia artificial' or 'home workout'"),
    order: z
      .nativeEnum(VideoOrder)
      .default(VideoOrder.RELEVANCE)
      .describe(
        "Ranking used by YouTube's search index: 'relevance' (best match, default), 'viewCount' (most viewed first), " +
          "'date' (newest first), or 'rating'. Note 'viewCount' here reflects YouTube's own ranking, not necessarily the " +
          "true current view count — use youtube_analyze_topic when you need exact, verified view counts.",
      ),
    max_results: z.number().int().min(1).max(50).default(10).describe("Number of videos to return (1-50, default 10)"),
    published_after: z
      .string()
      .datetime()
      .optional()
      .describe("Only include videos published after this ISO 8601 timestamp, e.g. '2026-01-01T00:00:00Z'"),
    published_before: z
      .string()
      .datetime()
      .optional()
      .describe("Only include videos published before this ISO 8601 timestamp"),
    region_code: z
      .string()
      .length(2)
      .optional()
      .describe("Two-letter region code to bias results, e.g. 'BR' for Brazil, 'US' for United States"),
    relevance_language: z
      .string()
      .optional()
      .describe("Two-letter language code to bias results, e.g. 'pt' for Portuguese, 'en' for English"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
  })
  .strict();

type SearchVideosInput = z.infer<typeof SearchVideosInputSchema>;

function toMarkdown(query: string, videos: VideoSummary[]): string {
  if (videos.length === 0) return `No videos found for '${query}'.`;
  const lines = [`# YouTube search results: '${query}'`, "", `Found ${videos.length} video(s)`, ""];
  videos.forEach((v, i) => {
    lines.push(`## ${i + 1}. ${v.title}`);
    lines.push(`- **Channel**: ${v.channel_title}`);
    lines.push(`- **Views**: ${v.view_count.toLocaleString("en-US")}`);
    lines.push(`- **Published**: ${v.published_at}`);
    lines.push(`- **Duration**: ${v.duration_human}${v.is_short ? " (Short)" : ""}`);
    lines.push(`- **URL**: ${v.url}`);
    lines.push("");
  });
  return lines.join("\n");
}

export function registerSearchVideosTool(server: McpServer): void {
  server.registerTool(
    "youtube_search_videos",
    {
      title: "Search YouTube Videos",
      description: `Search YouTube for videos matching a topic or query and return their metadata and statistics (views, likes, comments, duration).

This performs a YouTube search (like typing into the YouTube search box) and enriches each result with real view/like/comment counts and duration. It does NOT download or play video content.

Args:
  - query (string): Search terms
  - order ('relevance' | 'viewCount' | 'date' | 'rating'): Ranking strategy (default: 'relevance')
  - max_results (number): How many videos to return, 1-50 (default: 10)
  - published_after / published_before (ISO 8601 timestamp): Optional date range filter
  - region_code (string): Optional 2-letter region code, e.g. 'BR'
  - relevance_language (string): Optional 2-letter language code, e.g. 'pt'
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: For each video: id, url, title, channel, published date, view/like/comment counts, engagement rate, duration, whether it's a Short, tags, and a description snippet.

Examples:
  - Use when: "Find recent videos about React 19" -> query="React 19", order="date"
  - Use when: "What videos rank best for keto diet" -> query="keto diet", order="relevance"
  - Don't use when: You need a verified top-10-by-views ranking (use youtube_analyze_topic instead, which re-sorts by real view counts)

Error Handling:
  - Returns an error message if YOUTUBE_API_KEY is missing or invalid
  - Returns "No videos found for '<query>'" if the search returns no results`,
      inputSchema: SearchVideosInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchVideosInput) => {
      try {
        const searchResults = await searchVideos({
          query: params.query,
          order: params.order,
          maxResults: params.max_results,
          publishedAfter: params.published_after,
          publishedBefore: params.published_before,
          regionCode: params.region_code,
          relevanceLanguage: params.relevance_language,
        });

        const videoIds = searchResults.map((item) => item.id.videoId!).filter(Boolean);
        const videoDetails = await getVideosByIds(videoIds);
        const videos = videoDetails.map(toVideoSummary);

        if (videos.length === 0) {
          return { content: [{ type: "text" as const, text: `No videos found for '${params.query}'.` }] };
        }

        const output = { query: params.query, count: videos.length, videos };
        let textContent =
          params.response_format === ResponseFormat.MARKDOWN
            ? toMarkdown(params.query, videos)
            : JSON.stringify(output, null, 2);

        if (textContent.length > CHARACTER_LIMIT) {
          textContent = `${textContent.slice(0, CHARACTER_LIMIT)}\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Reduce max_results to see fewer, complete entries.]`;
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
