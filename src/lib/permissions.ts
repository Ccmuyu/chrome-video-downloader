import { originPattern } from "./url";

export async function grantedOriginPatterns(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  return (all.origins ?? []).filter((origin) => origin.startsWith("http://") || origin.startsWith("https://"));
}

// 比对的是 chrome.permissions 里的来源，不是 manifest 的 host_permissions。后者始终为空。
export async function missingOriginPatterns(urls: string[]): Promise<string[]> {
  const patterns = [...new Set(urls.map((url) => originPattern(url)).filter((item): item is string => Boolean(item)))];
  const missing: string[] = [];
  for (const pattern of patterns) {
    const ok = await chrome.permissions.contains({ origins: [pattern] });
    if (!ok) missing.push(pattern);
  }
  return missing;
}

export function patternMatches(pattern: string, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const match = /^(https?|\*):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern);
  if (!match) return false;
  const scheme = match[1];
  const host = match[2];
  const path = match[3];
  if (!scheme || !host || !path) return false;
  if (scheme !== "*" && `${scheme}:` !== target.protocol) return false;
  if (host === "*") {
    // any host
  } else if (host.startsWith("*.")) {
    const bare = host.slice(2);
    if (target.hostname !== bare && !target.hostname.endsWith(`.${bare}`)) return false;
  } else if (target.hostname !== host) {
    return false;
  }
  if (path === "/*") return true;
  return target.pathname.startsWith(path.replace(/\*$/, ""));
}

export async function pageIsGranted(pageUrl: string): Promise<boolean> {
  const pattern = originPattern(pageUrl);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}
