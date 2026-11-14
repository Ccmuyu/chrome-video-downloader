const KEY = "cvd-enabled";

// 存在 chrome.storage.local，关浏览器后还在。缺省视为开启，避免升级后突然不再嗅探。
export async function isEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] !== false;
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY]: enabled });
}
