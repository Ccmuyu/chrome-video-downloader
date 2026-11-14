import type { Variant } from "./types";

export function variantLabel(variant: Variant, index: number): string {
  const parts: string[] = [];
  if (variant.resolution) parts.push(variant.resolution);
  if (variant.bandwidth) parts.push(`${Math.round(variant.bandwidth / 1000)} kbps`);
  if (variant.fps) parts.push(`${Math.round(variant.fps)} fps`);
  return parts.join(" · ") || `清晰度 ${index + 1}`;
}

export function kindLabel(kind: string): string {
  if (kind === "hls") return "HLS";
  if (kind === "dash") return "DASH";
  return "直链";
}
