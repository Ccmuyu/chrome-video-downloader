import { describe, expect, it } from "vitest";
import { ivFromSequence, mediaPlaylistError, parseHexIv, parsePlaylist, selectAudio, splitInitGroups } from "./m3u8";

const BASE = "https://cdn.example.com/vod/master.m3u8";

describe("parsePlaylist", () => {
  it("parses a master playlist and sorts by bandwidth", () => {
    const text = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=30
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac",FRAME-RATE=30
high/index.m3u8?token=abc
`;
    const plan = parsePlaylist(text, BASE);
    expect(plan.kind).toBe("master");
    if (plan.kind !== "master") return;
    expect(plan.variants.map((item) => item.resolution)).toEqual(["1920x1080", "640x360"]);
    expect(plan.variants[0]?.uri).toBe("https://cdn.example.com/vod/high/index.m3u8?token=abc");
    expect(plan.variants[0]?.audioGroupId).toBe("aac");
    expect(plan.variants[0]?.fps).toBe(30);
    expect(selectAudio(plan.audio, "aac")?.uri).toBe("audio/en.m3u8");
  });

  it("parses media playlists with map, byterange, and aes key", () => {
    const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:8
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="keys/seg.key",IV=0x0000000000000000000000000000002a
#EXTINF:4.0,
seg-1.m4s
#EXT-X-BYTERANGE:1000@200
#EXTINF:4.0,
seg-2.m4s
#EXT-X-BYTERANGE:500
#EXTINF:2.0,
seg-2.m4s
#EXT-X-ENDLIST
`;
    const plan = parsePlaylist(text, "https://cdn.example.com/v/media.m3u8");
    expect(plan.kind).toBe("media");
    if (plan.kind !== "media") return;
    expect(plan.endList).toBe(true);
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[0]?.uri).toBe("https://cdn.example.com/v/seg-1.m4s");
    expect(plan.segments[0]?.mediaSequence).toBe(8);
    expect(plan.segments[0]?.key?.uri).toBe("https://cdn.example.com/v/keys/seg.key");
    expect(plan.segments[0]?.key?.iv[15]).toBe(0x2a);
    expect(plan.init?.uri).toBe("https://cdn.example.com/v/init.mp4");
    expect(plan.segments[1]?.byterange).toEqual({ length: 1000, offset: 200 });
    expect(plan.segments[2]?.byterange).toEqual({ length: 500, offset: 1200 });
    expect(mediaPlaylistError(plan)).toBeNull();
  });

  it("uses the media sequence as IV when the playlist omits it", () => {
    const text = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:3
#EXT-X-KEY:METHOD=AES-128,URI="k.key"
#EXTINF:6,
a.ts
#EXTINF:6,
b.ts
#EXT-X-ENDLIST
`;
    const plan = parsePlaylist(text, "https://cdn.example.com/a.m3u8");
    if (plan.kind !== "media") throw new Error("expected media");
    expect([...plan.segments[0]!.key!.iv]).toEqual([...ivFromSequence(3)]);
    expect([...plan.segments[1]!.key!.iv]).toEqual([...ivFromSequence(4)]);
  });

  it("rejects live and drm playlists", () => {
    const live = parsePlaylist("#EXTM3U\n#EXTINF:2,\na.ts\n", BASE);
    if (live.kind !== "media") throw new Error("expected media");
    expect(mediaPlaylistError(live)).toBe("直播留到下一期");

    const drm = parsePlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n',
      BASE,
    );
    if (drm.kind !== "media") throw new Error("expected media");
    expect(mediaPlaylistError(drm)).toBe("这个播放列表使用了 DRM，无法下载");
  });

  it("keeps a later init segment with the fragments that follow it", () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4,
preroll.ts
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="main-init.mp4"
#EXTINF:4,
main.m4s
#EXT-X-ENDLIST
`;
    const plan = parsePlaylist(text, "https://cdn.example.com/hls/master.m3u8");
    if (plan.kind !== "media") throw new Error("expected media");
    expect(plan.segments[0]?.mapUri).toBeUndefined();
    expect(plan.segments[1]?.mapUri).toBe("https://cdn.example.com/hls/main-init.mp4");
    expect(splitInitGroups(["v/00000.ts", "v/map-00001.mp4", "v/00001.m4s"])).toEqual([
      ["v/00000.ts"],
      ["v/map-00001.mp4", "v/00001.m4s"],
    ]);
  });

  it("parses a hex IV into 16 bytes", () => {
    const iv = parseHexIv("0x2a");
    expect(iv?.[15]).toBe(0x2a);
    expect(iv?.[0]).toBe(0);
  });
});
