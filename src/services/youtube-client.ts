import axios, { AxiosError } from "axios";
import {
  MAX_IDS_PER_BATCH,
  MAX_SEARCH_RESULTS_PER_PAGE,
  YOUTUBE_API_BASE_URL,
} from "../constants.js";
import type { RawChannelItem, RawSearchItem, RawVideoItem, VideoOrder } from "../types.js";

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

function getApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new YouTubeApiError(
      "YOUTUBE_API_KEY environment variable is not set. Get a free API key from the Google Cloud Console " +
        "(enable 'YouTube Data API v3'), then set YOUTUBE_API_KEY. A YouTube Premium subscription does not " +
        "provide API access on its own.",
    );
  }
  return key;
}

async function apiGet<T>(endpoint: string, params: Record<string, string | number | undefined>): Promise<T> {
  const query: Record<string, string> = { key: getApiKey() };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") query[k] = String(v);
  }

  try {
    const response = await axios.get<T>(`${YOUTUBE_API_BASE_URL}/${endpoint}`, {
      params: query,
      timeout: 30000,
    });
    return response.data;
  } catch (error) {
    throw toApiError(error);
  }
}

function toApiError(error: unknown): YouTubeApiError {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ error?: { message?: string; errors?: Array<{ reason?: string }> } }>;
    const status = axiosError.response?.status;
    const apiMessage = axiosError.response?.data?.error?.message?.replace(/\.+$/, "");
    const reason = axiosError.response?.data?.error?.errors?.[0]?.reason;

    if (status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) {
      return new YouTubeApiError(
        "Error: YouTube Data API daily quota exceeded. Quota resets at midnight Pacific Time, or request a " +
          "higher quota in the Google Cloud Console.",
        403,
      );
    }
    if (status === 403) {
      return new YouTubeApiError(
        `Error: Permission denied by YouTube Data API${apiMessage ? `: ${apiMessage}` : ""}. Check that the ` +
          "'YouTube Data API v3' is enabled for your Google Cloud project and that the API key has no " +
          "restrictions blocking this request.",
        403,
      );
    }
    if (status === 400) {
      return new YouTubeApiError(`Error: Invalid request to YouTube Data API${apiMessage ? `: ${apiMessage}` : ""}.`, 400);
    }
    if (status === 404) {
      return new YouTubeApiError("Error: Resource not found on YouTube.", 404);
    }
    if (axiosError.code === "ECONNABORTED") {
      return new YouTubeApiError("Error: Request to YouTube Data API timed out. Please try again.");
    }
    return new YouTubeApiError(
      `Error: YouTube Data API request failed${status ? ` with status ${status}` : ""}${apiMessage ? `: ${apiMessage}` : ""}.`,
      status,
    );
  }
  return new YouTubeApiError(`Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`);
}

export interface SearchVideosOptions {
  query: string;
  order?: VideoOrder;
  maxResults?: number;
  publishedAfter?: string;
  publishedBefore?: string;
  videoDuration?: "any" | "short" | "medium" | "long";
  regionCode?: string;
  relevanceLanguage?: string;
  safeSearch?: "moderate" | "none" | "strict";
}

export async function searchVideos(options: SearchVideosOptions): Promise<RawSearchItem[]> {
  const data = await apiGet<{ items: RawSearchItem[] }>("search", {
    part: "snippet",
    type: "video",
    q: options.query,
    order: options.order,
    maxResults: Math.min(options.maxResults ?? MAX_SEARCH_RESULTS_PER_PAGE, MAX_SEARCH_RESULTS_PER_PAGE),
    publishedAfter: options.publishedAfter,
    publishedBefore: options.publishedBefore,
    videoDuration: options.videoDuration,
    regionCode: options.regionCode,
    relevanceLanguage: options.relevanceLanguage,
    safeSearch: options.safeSearch,
  });
  return data.items.filter((item) => Boolean(item.id?.videoId));
}

async function batchIds<T>(ids: string[], fetchBatch: (batchIds: string[]) => Promise<T[]>): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_BATCH) {
    const batch = ids.slice(i, i + MAX_IDS_PER_BATCH);
    results.push(...(await fetchBatch(batch)));
  }
  return results;
}

export async function getVideosByIds(ids: string[]): Promise<RawVideoItem[]> {
  if (ids.length === 0) return [];
  return batchIds(ids, async (batch) => {
    const data = await apiGet<{ items: RawVideoItem[] }>("videos", {
      part: "snippet,statistics,contentDetails",
      id: batch.join(","),
      maxResults: MAX_IDS_PER_BATCH,
    });
    return data.items;
  });
}

export async function getChannelsByIds(ids: string[]): Promise<RawChannelItem[]> {
  if (ids.length === 0) return [];
  return batchIds(ids, async (batch) => {
    const data = await apiGet<{ items: RawChannelItem[] }>("channels", {
      part: "snippet,statistics",
      id: batch.join(","),
      maxResults: MAX_IDS_PER_BATCH,
    });
    return data.items;
  });
}
