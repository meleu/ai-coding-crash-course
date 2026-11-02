// Comment helpers live here rather than in lessonCommentService so that client
// components can import them without pulling the database driver into the
// browser bundle.

export const MAX_COMMENT_LENGTH = 2000;

export type CommentSegment =
  | { type: "text"; value: string }
  | { type: "link"; value: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/**
 * Sentence punctuation directly after a URL isn't part of it. A closing paren
 * only counts as part of the URL when it has a matching opening paren.
 */
function trimUrl(url: string) {
  let trimmed = url.replace(/[.,;:!?]+$/, "");

  while (
    trimmed.endsWith(")") &&
    trimmed.split(")").length > trimmed.split("(").length
  ) {
    trimmed = trimmed.slice(0, -1).replace(/[.,;:!?]+$/, "");
  }

  return trimmed;
}

/**
 * Splits plain comment text into text and http(s) link segments, for rendering
 * as React nodes. Comments are never rendered as HTML.
 */
export function splitCommentText(text: string): CommentSegment[] {
  const segments: CommentSegment[] = [];
  let position = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (match.index > position) {
      segments.push({ type: "text", value: text.slice(position, match.index) });
    }
    segments.push({ type: "link", value: url });
    position = match.index + url.length;
  }

  if (position < text.length) {
    segments.push({ type: "text", value: text.slice(position) });
  }

  return segments;
}

// Fixed to UTC so server-rendered and hydrated dates always match.
export function formatCommentDate(isoDate: string) {
  return new Date(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
