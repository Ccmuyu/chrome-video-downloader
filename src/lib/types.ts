export type MediaKind = "file" | "hls" | "dash";

export type SniffedMedia = {
  id: string;
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  url: string;
  pathKey: string;
  kind: MediaKind;
  mime?: string;
  referer: string;
  detectedAt: number;
  unsupportedReason?: string;
};

export type JobState =
  | "queued"
  | "resolving"
  | "fetching"
  | "muxing"
  | "saving"
  | "done"
  | "failed"
  | "cancelled";

export type Variant = {
  uri: string;
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
  audioGroupId?: string;
  fps?: number;
};

export type DownloadJob = {
  id: string;
  mediaId: string;
  tabId: number;
  state: JobState;
  kind: MediaKind;
  variant?: Variant;
  progress: { done: number; total: number };
  bytesDone: number;
  filename?: string;
  error?: string;
  needOrigins?: string[];
  createdAt: number;
};

export type AudioRendition = {
  groupId: string;
  name: string;
  uri?: string;
  language?: string;
  isDefault: boolean;
  autoselect: boolean;
};

export type SegmentKey = {
  method: string;
  uri: string;
  iv: Uint8Array;
  keyFormat?: string;
};

export type SegmentPlan = {
  uri: string;
  duration: number;
  mediaSequence: number;
  byterange?: { length: number; offset: number };
  key?: SegmentKey;
  mapUri?: string;
  mapByterange?: { length: number; offset: number };
};

export type MediaPlaylistPlan = {
  kind: "media";
  segments: SegmentPlan[];
  endList: boolean;
  targetDuration?: number;
  init?: { uri: string; byterange?: { length: number; offset: number } };
};

export type MasterPlaylistPlan = {
  kind: "master";
  variants: Variant[];
  audio: AudioRendition[];
};

export type PlaylistPlan = MasterPlaylistPlan | MediaPlaylistPlan;

export type PopupState = {
  tabId: number | null;
  pageUrl: string;
  pageTitle: string;
  granted: boolean;
  enabled: boolean;
  items: SniffedMedia[];
  jobs: DownloadJob[];
};
