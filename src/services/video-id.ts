const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractVideoId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.replace(/^\//, "");
    }
    const vParam = url.searchParams.get("v");
    if (vParam) return vParam;
    const shortsMatch = url.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  } catch {
    // Not a URL; fall through and return the raw input so the API can report it as not found.
  }
  return trimmed;
}
