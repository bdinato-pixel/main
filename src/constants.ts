export const YOUTUBE_API_BASE_URL = "https://www.googleapis.com/youtube/v3";

// Maximum characters returned in a single tool response before truncation.
export const CHARACTER_LIMIT = 30000;

// YouTube Data API limits at most 50 IDs per videos.list / channels.list call.
export const MAX_IDS_PER_BATCH = 50;

// YouTube Data API limits search.list to 50 results per page.
export const MAX_SEARCH_RESULTS_PER_PAGE = 50;
