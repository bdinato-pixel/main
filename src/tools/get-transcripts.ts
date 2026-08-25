import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchTranscriptSegments,
  getCaptionTracks,
  pickBestTrack,
  TranscriptError,
} from "../services/transcript-client.js";
import { extractVideoId } from "../services/video-id.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat } from "../types.js";
import type { TranscriptSegment, VideoTranscriptResult } from "../types.js";

const MAX_VIDEOS_PER_CALL = 5;
const DEFAULT_MAX_CHARACTERS_PER_VIDEO = 6000;

const GetTranscriptsInputSchema = z
  .object({
    video_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_VIDEOS_PER_CALL)
      .describe(
        `List of YouTube video IDs or full video URLs to transcribe (1-${MAX_VIDEOS_PER_CALL} items). Keep this small — ` +
          "each transcript can be large. Typically fed from the video_id/url fields returned by youtube_analyze_topic, " +
          "youtube_search_videos, or youtube_get_video_details.",
      ),
    language: z
      .string()
      .optional()
      .describe(
        "Preferred 2-letter language code for the transcript, e.g. 'pt' or 'en'. If that language isn't available, " +
          "falls back to a manually-created track in another language, then to an auto-generated one. Omit to just take " +
          "the best available track.",
      ),
    include_timestamps: z
      .boolean()
      .default(false)
      .describe(
        "If true, return an array of timed segments ({start_seconds, duration_seconds, text}) instead of one flat " +
          "text block. Useful for quoting or citing a specific moment (default: false)",
      ),
    max_characters_per_video: z
      .number()
      .int()
      .min(500)
      .max(20000)
      .default(DEFAULT_MAX_CHARACTERS_PER_VIDEO)
      .describe(
        `Truncate each video's transcript to at most this many characters (500-20000, default ${DEFAULT_MAX_CHARACTERS_PER_VIDEO}). ` +
          "Raise this for a single long video you need in full detail; keep it low when transcribing several videos at once.",
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable"),
  })
  .strict();

type GetTranscriptsInput = z.infer<typeof GetTranscriptsInputSchema>;

async function getTranscriptForVideo(
  idOrUrl: string,
  language: string | undefined,
  includeTimestamps: boolean,
  maxCharacters: number,
): Promise<VideoTranscriptResult> {
  const videoId = extractVideoId(idOrUrl);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  let tracks;
  try {
    tracks = await getCaptionTracks(videoId);
  } catch (error) {
    return {
      video_id: videoId,
      url,
      transcript_available: false,
      language_code: null,
      is_auto_generated: null,
      available_languages: [],
      character_count: 0,
      word_count: 0,
      truncated: false,
      transcript: null,
      segments: null,
      error: error instanceof TranscriptError ? error.message : String(error),
    };
  }

  if (tracks.length === 0) {
    return {
      video_id: videoId,
      url,
      transcript_available: false,
      language_code: null,
      is_auto_generated: null,
      available_languages: [],
      character_count: 0,
      word_count: 0,
      truncated: false,
      transcript: null,
      segments: null,
      error: "No captions (manual or auto-generated) are available for this video.",
    };
  }

  const availableLanguages = [...new Set(tracks.map((t) => t.languageCode))];
  const chosenTrack = pickBestTrack(tracks, language);

  if (!chosenTrack) {
    return {
      video_id: videoId,
      url,
      transcript_available: false,
      language_code: null,
      is_auto_generated: null,
      available_languages: availableLanguages,
      character_count: 0,
      word_count: 0,
      truncated: false,
      transcript: null,
      segments: null,
      error: "Could not select a caption track.",
    };
  }

  let rawSegments;
  try {
    rawSegments = await fetchTranscriptSegments(chosenTrack);
  } catch (error) {
    return {
      video_id: videoId,
      url,
      transcript_available: false,
      language_code: chosenTrack.languageCode,
      is_auto_generated: chosenTrack.kind === "asr",
      available_languages: availableLanguages,
      character_count: 0,
      word_count: 0,
      truncated: false,
      transcript: null,
      segments: null,
      error: error instanceof TranscriptError ? error.message : String(error),
    };
  }

  const fullText = rawSegments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const truncated = fullText.length > maxCharacters;
  const transcriptText = truncated ? `${fullText.slice(0, maxCharacters)}...` : fullText;

  let segments: TranscriptSegment[] | null = null;
  if (includeTimestamps) {
    let runningLength = 0;
    segments = [];
    for (const s of rawSegments) {
      if (runningLength >= maxCharacters) break;
      segments.push(s);
      runningLength += s.text.length + 1;
    }
  }

  return {
    video_id: videoId,
    url,
    transcript_available: true,
    language_code: chosenTrack.languageCode,
    is_auto_generated: chosenTrack.kind === "asr",
    available_languages: availableLanguages,
    character_count: transcriptText.length,
    word_count: transcriptText.split(/\s+/).filter(Boolean).length,
    truncated,
    transcript: includeTimestamps ? null : transcriptText,
    segments,
    error: null,
  };
}

function toMarkdown(results: VideoTranscriptResult[]): string {
  const lines = [`# Transcripts (${results.length} video(s))`, ""];
  for (const r of results) {
    lines.push(`## ${r.url}`);
    if (!r.transcript_available) {
      lines.push(`- **Status**: unavailable — ${r.error}`);
      if (r.available_languages.length > 0) {
        lines.push(`- **Languages that were found**: ${r.available_languages.join(", ")}`);
      }
      lines.push("");
      continue;
    }
    lines.push(`- **Language**: ${r.language_code}${r.is_auto_generated ? " (auto-generated)" : ""}`);
    lines.push(`- **Word count**: ${r.word_count}${r.truncated ? " (truncated)" : ""}`);
    if (r.segments) {
      lines.push("- **Segments**:");
      for (const seg of r.segments) {
        lines.push(`  - [${seg.start_seconds.toFixed(1)}s] ${seg.text}`);
      }
    } else {
      lines.push("- **Transcript**:");
      lines.push("");
      lines.push(`> ${r.transcript}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function registerGetTranscriptsTool(server: McpServer): void {
  server.registerTool(
    "youtube_get_transcripts",
    {
      title: "Get YouTube Video Transcripts",
      description: `Fetch the spoken-word transcript (manually-created or auto-generated captions) for one or more YouTube videos, so their actual content can be read and evaluated — not just titles/descriptions.

This does NOT use the YouTube Data API or YOUTUBE_API_KEY quota. It reads the same publicly displayed caption tracks that YouTube's own video player uses, so it only works for videos that have captions available (most spoken-content videos do; silent videos, some music videos, or videos with captions disabled will not).

Typical workflow: call youtube_analyze_topic or youtube_search_videos first to find videos, then pass their video_id/url values here to evaluate what each video actually says (topics covered, claims made, tone, structure, etc. — you do that evaluation yourself by reading the returned transcript text).

Args:
  - video_ids (string[]): 1-${MAX_VIDEOS_PER_CALL} video IDs or full YouTube URLs
  - language (string): Optional preferred 2-letter language code, e.g. 'pt'. Falls back automatically if unavailable.
  - include_timestamps (boolean): Return timed segments instead of flat text (default false)
  - max_characters_per_video (number): Truncate each transcript, 500-20000 chars (default ${DEFAULT_MAX_CHARACTERS_PER_VIDEO})
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: For each video: whether a transcript was available, the language and whether it's auto-generated, word/character counts, whether it was truncated, and the transcript itself (flat text or timed segments). Videos without captions get a structured "unavailable" result with a reason instead of an error, so a batch call never fails outright just because one video has no captions.

Examples:
  - Use when: "What do these top 10 videos actually talk about?" -> video_ids=[<the 10 video_id values from youtube_analyze_topic>]
  - Use when: "Quote what's said around the 2-minute mark" -> include_timestamps=true, then look for segments near start_seconds=120
  - Don't use when: You only need view/like counts or metadata (use youtube_get_video_details instead — much cheaper)

Error Handling:
  - A video with no captions returns transcript_available=false with an explanatory error field — this is not a tool failure
  - Returns an error message only if the YouTube watch page itself could not be reached (network/timeout)
  - This relies on scraping publicly displayed captions rather than an official API, so it can occasionally break if YouTube changes its page structure, or be rate-limited under heavy use`,
      inputSchema: GetTranscriptsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetTranscriptsInput) => {
      try {
        const results = await Promise.all(
          params.video_ids.map((idOrUrl) =>
            getTranscriptForVideo(idOrUrl, params.language, params.include_timestamps, params.max_characters_per_video),
          ),
        );

        const output = { count: results.length, transcripts: results };
        let textContent =
          params.response_format === ResponseFormat.MARKDOWN ? toMarkdown(results) : JSON.stringify(output, null, 2);

        if (textContent.length > CHARACTER_LIMIT) {
          textContent = `${textContent.slice(0, CHARACTER_LIMIT)}\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Reduce max_characters_per_video or the number of video_ids per call.]`;
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
