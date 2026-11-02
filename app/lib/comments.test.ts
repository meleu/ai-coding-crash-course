import { describe, it, expect } from "vitest";
import { formatCommentDate, splitCommentText } from "./comments";

describe("splitCommentText", () => {
  it("returns plain text as a single segment", () => {
    expect(splitCommentText("no links here")).toEqual([
      { type: "text", value: "no links here" },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(splitCommentText("")).toEqual([]);
  });

  it("links http and https URLs within text", () => {
    expect(
      splitCommentText("see https://a.dev/x and http://b.dev for more")
    ).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://a.dev/x" },
      { type: "text", value: " and " },
      { type: "link", value: "http://b.dev" },
      { type: "text", value: " for more" },
    ]);
  });

  it("does not link other schemes", () => {
    const text = "javascript:alert(1) data:text/html,hi ftp://a.dev";

    expect(splitCommentText(text)).toEqual([{ type: "text", value: text }]);
  });

  it("leaves trailing punctuation out of the link", () => {
    expect(splitCommentText("Try https://a.dev/x.")).toEqual([
      { type: "text", value: "Try " },
      { type: "link", value: "https://a.dev/x" },
      { type: "text", value: "." },
    ]);
  });

  it("leaves an unmatched closing paren out of the link", () => {
    expect(splitCommentText("(see https://a.dev/x)")).toEqual([
      { type: "text", value: "(see " },
      { type: "link", value: "https://a.dev/x" },
      { type: "text", value: ")" },
    ]);
  });

  it("keeps a matched paren inside the link", () => {
    expect(splitCommentText("https://a.dev/x_(y)")).toEqual([
      { type: "link", value: "https://a.dev/x_(y)" },
    ]);
  });

  it("does not treat markup as a link boundary it can escape", () => {
    expect(splitCommentText('https://a.dev/"><script>')).toEqual([
      { type: "link", value: "https://a.dev/" },
      { type: "text", value: '"><script>' },
    ]);
  });
});

describe("formatCommentDate", () => {
  it("formats in UTC regardless of the local timezone", () => {
    expect(formatCommentDate("2026-03-01T23:30:00.000Z")).toBe("Mar 1, 2026");
  });
});
