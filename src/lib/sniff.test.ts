import { describe, expect, it } from "vitest";
import { classifyMime, classifyUrl, isPlaylistText, isPreviewSized, mergeDetection, shouldPeekBody } from "./sniff";
import { pathKeyOf, preferMediaUrl } from "./url";
import { outputFilename } from "./filename";

describe("sniff", () => {
  it("lists playlists and files, and hides bare segments", () => {
    expect(classifyUrl("https://cdn.example.com/a/index.m3u8?token=1")).toEqual({ kind: "hls", listable: true });
    expect(classifyUrl("https://cdn.example.com/v.mp4")).toEqual({ kind: "file", listable: true });
    expect(classifyUrl("https://cdn.example.com/seg/1.ts")?.listable).toBe(false);
    expect(classifyUrl("blob:https://example.com/id")).toBeNull();
  });

  it("dedupes by path and ignores the signature query", () => {
    expect(pathKeyOf("https://cdn.example.com/a.m3u8?token=1")).toBe("https://cdn.example.com/a.m3u8");
    expect(pathKeyOf("https://cdn.example.com/a.m3u8?token=2#t=1")).toBe("https://cdn.example.com/a.m3u8");
  });

  it("peeks only ambiguous responses and recognizes a playlist body", () => {
    expect(shouldPeekBody("https://cdn.example.com/playlist", "text/plain")).toBe(true);
    expect(shouldPeekBody("https://cdn.example.com/app.js", "text/plain")).toBe(false);
    expect(shouldPeekBody("https://cdn.example.com/v.mp4", "video/mp4")).toBe(false);
    expect(isPlaylistText("\n#EXTM3U\n")).toBe(true);
    expect(mergeDetection(null, classifyMime("application/vnd.apple.mpegurl"))).toEqual({
      kind: "hls",
      listable: true,
    });
  });

  it("hides hover-preview webms even when the response is video/webm", () => {
    const preview = "https://ew.phncdn.com/videos/202411/12/430600081/180P_225K_430600081.webm";
    expect(classifyUrl(preview)?.listable).toBe(false);
    expect(mergeDetection(classifyUrl(preview), classifyMime("video/webm"))?.listable).toBe(false);
    expect(classifyUrl("https://cdn.example.com/clip.webm")?.listable).toBe(true);
    expect(classifyUrl("https://cdn.example.com/thumbs/poster.mp4")?.listable).toBe(false);
    expect(classifyUrl("https://cdn.example.com/1080P_8000K_12.webm")?.listable).toBe(true);
  });

  it("keeps a signed media url when a later request drops the query", () => {
    const signed = "https://ev-h.phncdn.com/hls/v/master.m3u8?validfrom=1&hash=abc";
    const bare = "https://ev-h.phncdn.com/hls/v/master.m3u8";
    expect(preferMediaUrl(signed, bare)).toBe(signed);
    expect(preferMediaUrl(bare, signed)).toBe(signed);
  });

  it("drops tiny file responses that look like previews", () => {
    expect(isPreviewSized("file", 4096)).toBe(true);
    expect(isPreviewSized("hls", 200)).toBe(false);
    expect(isPreviewSized("file", null)).toBe(false);
  });

  it("builds a filesystem-safe filename", () => {
    expect(outputFilename('a/b: "c"', "1920x1080")).toBe("a b c_1920x1080.mp4");
  });
});
