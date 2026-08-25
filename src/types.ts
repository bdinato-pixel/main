export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export enum VideoOrder {
  VIEW_COUNT = "viewCount",
  RELEVANCE = "relevance",
  DATE = "date",
  RATING = "rating",
}

export interface RawSearchItem {
  id: { videoId?: string };
  snippet: {
    title: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
    description: string;
  };
}

export interface RawVideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
    tags?: string[];
    categoryId?: string;
    defaultAudioLanguage?: string;
  };
  statistics: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
    favoriteCount?: string;
  };
  contentDetails: {
    duration: string;
    caption?: string;
  };
}

export interface RawChannelItem {
  id: string;
  snippet: {
    title: string;
    country?: string;
    publishedAt: string;
  };
  statistics: {
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    videoCount?: string;
    viewCount?: string;
  };
}

export interface VideoSummary {
  video_id: string;
  url: string;
  title: string;
  channel_id: string;
  channel_title: string;
  published_at: string;
  view_count: number;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate_percent: number | null;
  duration_seconds: number;
  duration_human: string;
  is_short: boolean;
  tags: string[];
  description_snippet: string;
}

export interface ChannelSummary {
  channel_id: string;
  channel_title: string;
  url: string;
  subscriber_count: number | null;
  video_count: number | null;
  total_view_count: number | null;
  country: string | null;
}

export interface TranscriptSegment {
  start_seconds: number;
  duration_seconds: number;
  text: string;
}

export interface VideoTranscriptResult {
  video_id: string;
  url: string;
  transcript_available: boolean;
  language_code: string | null;
  is_auto_generated: boolean | null;
  available_languages: string[];
  character_count: number;
  word_count: number;
  truncated: boolean;
  transcript: string | null;
  segments: TranscriptSegment[] | null;
  error: string | null;
}

export interface TopicAnalysis {
  query: string;
  candidates_examined: number;
  top_videos: VideoSummary[];
  aggregate: {
    total_views: number;
    average_views: number;
    average_likes: number | null;
    average_comments: number | null;
    average_engagement_rate_percent: number | null;
    average_duration_seconds: number;
    shortest_video_seconds: number;
    longest_video_seconds: number;
    oldest_published_at: string;
    newest_published_at: string;
    unique_channel_count: number;
    top_channels: Array<{ channel_title: string; video_count: number }>;
    top_keywords: Array<{ keyword: string; count: number }>;
  };
  channels?: ChannelSummary[];
}
