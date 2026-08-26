import type { RawChannelItem, RawVideoItem, ChannelSummary, VideoSummary } from "../types.js";

const ISO_8601_DURATION_RE = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;

export function parseIsoDuration(duration: string): number {
  const match = ISO_8601_DURATION_RE.exec(duration);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatDurationHuman(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function toIntOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computeEngagementRate(views: number, likes: number | null, comments: number | null): number | null {
  if (views <= 0) return null;
  const engagements = (likes ?? 0) + (comments ?? 0);
  if (likes === null && comments === null) return null;
  return Math.round((engagements / views) * 10000) / 100;
}

export function toVideoSummary(item: RawVideoItem): VideoSummary {
  const viewCount = toIntOrNull(item.statistics.viewCount) ?? 0;
  const likeCount = toIntOrNull(item.statistics.likeCount);
  const commentCount = toIntOrNull(item.statistics.commentCount);
  const durationSeconds = parseIsoDuration(item.contentDetails.duration);

  return {
    video_id: item.id,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    title: item.snippet.title,
    channel_id: item.snippet.channelId,
    channel_title: item.snippet.channelTitle,
    published_at: item.snippet.publishedAt,
    view_count: viewCount,
    like_count: likeCount,
    comment_count: commentCount,
    engagement_rate_percent: computeEngagementRate(viewCount, likeCount, commentCount),
    duration_seconds: durationSeconds,
    duration_human: formatDurationHuman(durationSeconds),
    is_short: durationSeconds > 0 && durationSeconds <= 60,
    tags: item.snippet.tags ?? [],
    description_snippet:
      item.snippet.description.length > 200 ? `${item.snippet.description.slice(0, 200)}...` : item.snippet.description,
  };
}

export function toChannelSummary(item: RawChannelItem): ChannelSummary {
  return {
    channel_id: item.id,
    channel_title: item.snippet.title,
    url: `https://www.youtube.com/channel/${item.id}`,
    subscriber_count: item.statistics.hiddenSubscriberCount ? null : toIntOrNull(item.statistics.subscriberCount),
    video_count: toIntOrNull(item.statistics.videoCount),
    total_view_count: toIntOrNull(item.statistics.viewCount),
    country: item.snippet.country ?? null,
  };
}

const STOPWORDS = new Set([
  // Portuguese
  "de", "a", "o", "que", "e", "do", "da", "em", "um", "uma", "para", "com", "no", "na", "os", "as",
  "se", "por", "mais", "as", "dos", "das", "ao", "aos", "como", "mas", "ou", "quando", "muito", "nos",
  "já", "eu", "você", "voce", "ele", "ela", "isso", "esse", "essa", "pelo", "pela", "até", "sem",
  "sobre", "entre", "depois", "vs", "e", "é", "não", "sim", "the", "of",
  // English
  "the", "a", "an", "and", "or", "to", "in", "on", "for", "with", "of", "is", "are", "was", "were",
  "this", "that", "it", "at", "by", "from", "vs", "your", "you", "how", "what", "why", "new", "top",
]);

export function extractTopKeywords(titles: string[], limit = 10): Array<{ keyword: string; count: number }> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const words = title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
    const seenInTitle = new Set(words);
    for (const word of seenInTitle) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
}
