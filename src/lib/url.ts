const VOLATILE_QUERY_KEYS = new Set([
  "token",
  "expires",
  "expiry",
  "signature",
  "sign",
  "sig",
  "auth",
  "auth_key",
  "policy",
]);

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function pageIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

// 同一路径后来又出现时，不要用没有查询参数的地址盖掉已经带签名的那条。
export function preferMediaUrl(previous: string, next: string): string {
  try {
    const prev = new URL(previous);
    const incoming = new URL(next);
    if (`${prev.origin}${prev.pathname}` !== `${incoming.origin}${incoming.pathname}`) return next;
    if (prev.search && !incoming.search) return previous;
    return next;
  } catch {
    return next;
  }
}

// 去重键去掉 query 和 hash。带签名的同一文件每次查询不同，仍应算一条。
export function pathKeyOf(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href;
}

export function originPattern(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

export function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export function resolveUri(uri: string, base: string): string {
  return new URL(uri, base).href;
}

export function loggableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return "(invalid-url)";
  }
}

export function extensionOf(value: string): string {
  try {
    const path = new URL(value).pathname.toLowerCase();
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot) : "";
  } catch {
    return "";
  }
}

export function hasVolatileQuery(value: string): boolean {
  const url = new URL(value);
  for (const key of url.searchParams.keys()) {
    if (VOLATILE_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}
