const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export function safeBaseName(title: string): string {
  const cleaned = String(title ?? "").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  const sliced = cleaned.slice(0, 80).trim();
  return sliced || "video";
}

export function outputFilename(title: string, resolution?: string, ext = "mp4"): string {
  const base = safeBaseName(title);
  const suffix = resolution ? `_${resolution}` : "";
  return `${base}${suffix}.${ext.replace(/^\./, "")}`;
}

export function fileExtensionFor(url: string, mime?: string): string {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  const known = [".mp4", ".webm", ".m4a", ".mp3", ".m4v", ".mov", ".aac", ".ogg", ".opus"];
  const found = known.find((ext) => path.endsWith(ext));
  if (found) return found.slice(1);
  const type = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "audio/mpeg") return "mp3";
  if (type === "audio/mp4" || type === "audio/x-m4a") return "m4a";
  if (type === "audio/webm") return "webm";
  if (type === "video/webm") return "webm";
  if (type.startsWith("audio/")) return "m4a";
  return "mp4";
}
