import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getChannelsByIds, getVideosByIds, searchVideos } from "../services/youtube-client.js";
import { average, extractTopKeywords, toChannelSummary, toVideoSummary } from "../services/format.js";
import { CHARACTER_LIMIT, MAX_SEARCH_RESULTS_PER_PAGE } from "../constants.js";
import { ResponseFormat, VideoOrder } from "../types.js";
import type { TopicAnalysis, VideoSummary } from "../types.js";

const AnalyzeTopicInputSchema = z
  .object({
    topic: z.string().min(1).max(200).describe("Topic or search query to analyze, e.g. 'inteligencia artificial' or 'marathon training'"),
    top_n: z.number().int().min(1).max(25).default(10).describe("How many top-viewed videos to return (1-25, default 10)"),
    candidate_pool_size: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_RESULTS_PER_PAGE)
      .default(MAX_SEARCH_RESULTS_PER_PAGE)
      .describe(
        `How many search results to pull and compare before picking the top_n by actual view count (1-${MAX_SEARCH_RESULTS_PER_PAGE}, default ${MAX_SEARCH_RESULTS_PER_PAGE}). ` +
          "Higher values give a more reliable ranking at the cost of a larger API call; leave at default unless you need to conserve API quota.",
      ),
    published_after: z
      .string()
      .datetime()
      .optional()
      .describe("Only consider videos published after this ISO 8601 timestamp, e.g. '2026-01-01T00:00:00Z' (omit for all-time)"),
    published_before: z
      .string()
      .datetime()
      .optional()
      .describe("Only consider videos published before this ISO 8601 timestamp"),
    video_duration: z
      .enum(["any", "short", "medium", "long"])
      .default("any")
      .describe(
        "Filter by length before ranking: 'short' (<4 min, includes Shorts), 'medium' (4-20 min), 'long' (>20 min), or 'any' (default)",
      ),
    region_code: z.string().length(2).optional().describe("Two-letter region code to bias results, e.g. 'BR' for Brazil"),
    relevance_language: z.string().optional().describe("Two-letter language code to bias results, e.g. 'pt' for Portuguese"),
    include_channel_stats: z
      .boolean()
      .default(true)
      .describe("Whether to also fetch subscriber/video counts for the channels behind the top videos (default true)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
  })
  .strict();

type AnalyzeTopicInput = z.infer<typeof AnalyzeTopicInputSchema>;

function buildAggregate(candidatesExamined: number, topVideos: VideoSummary[]): TopicAnalysis["aggregate"] {
  const views = topVideos.map((v) => v.view_count);
  const likes = topVideos.filter((v) => v.like_count !== null).map((v) => v.like_count as number);
  const comments = topVideos.filter((v) => v.comment_count !== null).map((v) => v.comment_count as number);
  const engagementRates = topVideos
    .filter((v) => v.engagement_rate_percent !== null)
    .map((v) => v.engagement_rate_percent as number);
  const durations = topVideos.map((v) => v.duration_seconds);
  const publishedDates = topVideos.map((v) => v.published_at).sort();

  const channelFrequency = new Map<string, number>();
  for (const v of topVideos) {
    channelFrequency.set(v.channel_title, (channelFrequency.get(v.channel_title) ?? 0) + 1);
  }
  const topChannels = [...channelFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([channel_title, video_count]) => ({ channel_title, video_count }));

  return {
    total_views: views.reduce((sum, v) => sum + v, 0),
    average_views: average(views),
    average_likes: likes.length > 0 ? average(likes) : null,
    average_comments: comments.length > 0 ? average(comments) : null,
    average_engagement_rate_percent: engagementRates.length > 0 ? average(engagementRates) : null,
    average_duration_seconds: average(durations),
    shortest_video_seconds: Math.min(...durations),
    longest_video_seconds: Math.max(...durations),
    oldest_published_at: publishedDates[0],
    newest_published_at: publishedDates[publishedDates.length - 1],
    unique_channel_count: new Set(topVideos.map((v) => v.channel_id)).size,
    top_channels: topChannels,
    top_keywords: extractTopKeywords(topVideos.map((v) => v.title)),
  };
}

function toMarkdown(analysis: TopicAnalysis): string {
  const { query, candidates_examined, top_videos, aggregate, channels } = analysis;
  const subsByChannelId = new Map((channels ?? []).map((c) => [c.channel_id, c.subscriber_count]));

  const lines = [
    `# Top ${top_videos.length} most-viewed videos for '${query}'`,
    "",
    `_Ranked by verified view count out of ${candidates_examined} candidates examined._`,
    "",
  ];

  top_videos.forEach((v, i) => {
    const subs = subsByChannelId.get(v.channel_id);
    lines.push(`## ${i + 1}. ${v.title}`);
    lines.push(
      `- **Channel**: ${v.channel_title}${subs !== undefined && subs !== null ? ` (${subs.toLocaleString("en-US")} subscribers)` : ""}`,
    );
    lines.push(`- **Views**: ${v.view_count.toLocaleString("en-US")}`);
    lines.push(`- **Likes**: ${v.like_count === null ? "hidden" : v.like_count.toLocaleString("en-US")}`);
    lines.push(`- **Comments**: ${v.comment_count === null ? "disabled/hidden" : v.comment_count.toLocaleString("en-US")}`);
    lines.push(`- **Engagement rate**: ${v.engagement_rate_percent === null ? "n/a" : `${v.engagement_rate_percent}%`}`);
    lines.push(`- **Duration**: ${v.duration_human}${v.is_short ? " (Short)" : ""}`);
    lines.push(`- **Published**: ${v.published_at}`);
    lines.push(`- **URL**: ${v.url}`);
    lines.push("");
  });

  lines.push("## Aggregate analysis");
  lines.push(`- **Total views (top ${top_videos.length})**: ${aggregate.total_views.toLocaleString("en-US")}`);
  lines.push(`- **Average views**: ${aggregate.average_views.toLocaleString("en-US")}`);
  lines.push(
    `- **Average engagement rate**: ${aggregate.average_engagement_rate_percent === null ? "n/a" : `${aggregate.average_engagement_rate_percent}%`}`,
  );
  lines.push(
    `- **Duration range**: ${Math.round(aggregate.shortest_video_seconds / 60)} to ${Math.round(aggregate.longest_video_seconds / 60)} minutes (avg ${Math.round(aggregate.average_duration_seconds / 60)} min)`,
  );
  lines.push(`- **Publish date range**: ${aggregate.oldest_published_at} to ${aggregate.newest_published_at}`);
  lines.push(`- **Unique channels represented**: ${aggregate.unique_channel_count} of ${top_videos.length} videos`);
  if (aggregate.top_channels.length > 0) {
    lines.push(`- **Channels with multiple entries**: ${aggregate.top_channels
      .filter((c) => c.video_count > 1)
      .map((c) => `${c.channel_title} (${c.video_count})`)
      .join(", ") || "none"}`);
  }
  if (aggregate.top_keywords.length > 0) {
    lines.push(`- **Common title keywords**: ${aggregate.top_keywords.map((k) => `${k.keyword} (${k.count})`).join(", ")}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function registerAnalyzeTopicTool(server: McpServer): void {
  server.registerTool(
    "youtube_analyze_topic",
    {
      title: "Analyze Top Viewed YouTube Videos for a Topic",
      description: `Search YouTube for a topic, verify real view counts for a pool of candidate videos, and return the top N most-viewed videos (default 10) along with aggregate analysis.

This is the main workflow tool for "what are the most-watched videos about X". It searches YouTube, fetches exact statistics (views, likes, comments, duration) for each candidate, re-sorts them by actual view count (search ranking alone is not a reliable view-count ordering), and returns both the ranked list and an aggregate analysis (total/average views, average engagement rate, duration range, publish date range, which channels dominate, and common title keywords).

Args:
  - topic (string): Topic or search query to analyze
  - top_n (number): How many top-viewed videos to return, 1-25 (default 10)
  - candidate_pool_size (number): How many search results to compare before ranking, 1-50 (default 50)
  - published_after / published_before (ISO 8601 timestamp): Optional date range, e.g. to find "most viewed this year"
  - video_duration ('any' | 'short' | 'medium' | 'long'): Filter by length before ranking (default 'any')
  - region_code (string): Optional 2-letter region code, e.g. 'BR'
  - relevance_language (string): Optional 2-letter language code, e.g. 'pt'
  - include_channel_stats (boolean): Also fetch subscriber counts for the channels behind the top videos (default true)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: Ranked list of top_n videos with full stats, plus an aggregate analysis block (total/average views, average engagement rate, duration stats, publish date range, dominant channels, common keywords in titles). This only analyzes metadata (views, likes, titles, etc.) — to evaluate what a video actually says, pass its video_id/url into youtube_get_transcripts afterward.

Examples:
  - Use when: "What are the 10 most watched videos about the 2026 World Cup?" -> topic="2026 World Cup"
  - Use when: "Most viewed cooking videos published this year, longer than 20 minutes" -> topic="cooking", published_after="2026-01-01T00:00:00Z", video_duration="long"
  - Don't use when: You already have specific video IDs (use youtube_get_video_details instead)

Error Handling:
  - Returns an error message if YOUTUBE_API_KEY is missing or invalid
  - Returns "No videos found for topic '<topic>'" if the search returns no results
  - A YouTube Premium account has no effect on this tool; it always uses the public YouTube Data API v3 via YOUTUBE_API_KEY`,
      inputSchema: AnalyzeTopicInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AnalyzeTopicInput) => {
      try {
        const searchResults = await searchVideos({
          query: params.topic,
          order: VideoOrder.VIEW_COUNT,
          maxResults: params.candidate_pool_size,
          publishedAfter: params.published_after,
          publishedBefore: params.published_before,
          videoDuration: params.video_duration,
          regionCode: params.region_code,
          relevanceLanguage: params.relevance_language,
        });

        const candidateIds = searchResults.map((item) => item.id.videoId!).filter(Boolean);
        const videoDetails = await getVideosByIds(candidateIds);
        const candidates = videoDetails.map(toVideoSummary).sort((a, b) => b.view_count - a.view_count);
        const topVideos = candidates.slice(0, params.top_n);

        if (topVideos.length === 0) {
          return { content: [{ type: "text" as const, text: `No videos found for topic '${params.topic}'.` }] };
        }

        let channels: TopicAnalysis["channels"];
        if (params.include_channel_stats) {
          const uniqueChannelIds = [...new Set(topVideos.map((v) => v.channel_id))];
          const channelDetails = await getChannelsByIds(uniqueChannelIds);
          channels = channelDetails.map(toChannelSummary);
        }

        const analysis: TopicAnalysis = {
          query: params.topic,
          candidates_examined: candidates.length,
          top_videos: topVideos,
          aggregate: buildAggregate(candidates.length, topVideos),
          channels,
        };

        let textContent =
          params.response_format === ResponseFormat.MARKDOWN ? toMarkdown(analysis) : JSON.stringify(analysis, null, 2);

        if (textContent.length > CHARACTER_LIMIT) {
          textContent = `${textContent.slice(0, CHARACTER_LIMIT)}\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Reduce top_n to see fewer, complete entries.]`;
        }

        return {
          content: [{ type: "text" as const, text: textContent }],
          structuredContent: analysis as unknown as Record<string, unknown>,
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
