// 只改扩展自己发出的请求。tabIds 用 TAB_ID_NONE，页面里的播放请求不会被改 Referer。
// 规则 id 从 1000 起，启动时按这个下界清掉上次 Worker 留下的会话规则。
const RULE_FLOOR = 1000;
let nextRuleId = RULE_FLOOR + Math.floor(Math.random() * 1000);

export async function clearOwnedSessionRules(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.map((rule) => rule.id).filter((id) => id >= RULE_FLOOR);
  if (ids.length === 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}

export async function installRefererRule(pageUrl: string, urls: string[]): Promise<number | null> {
  const hosts = uniqueHosts(urls);
  if (hosts.length === 0) return null;
  let referer = pageUrl;
  let origin = pageUrl;
  try {
    const page = new URL(pageUrl);
    referer = page.href;
    origin = page.origin;
  } catch {
    return null;
  }
  const id = nextRuleId;
  nextRuleId += 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: referer },
            { header: "Origin", operation: "set", value: origin },
          ],
        },
        condition: {
          requestDomains: hosts,
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },
    ],
  });
  return id;
}

export async function removeRefererRule(id: number | null): Promise<void> {
  if (id == null) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
}

function uniqueHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    try {
      const host = new URL(value).hostname;
      if (host) hosts.add(host);
    } catch {
      // skip
    }
  }
  return [...hosts];
}
