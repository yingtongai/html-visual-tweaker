import { HISTORY_LIMIT, PageHistory, SavedVersion, StyleRule, pageKey } from '../shared/types';

const storageKey = (url = location.href) => `html-tweaker:${pageKey(url)}`;
const extensionStorageAvailable = () => typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

export async function loadHistory(url = location.href): Promise<PageHistory> {
  if (extensionStorageAvailable()) {
    const result = await chrome.storage.local.get(storageKey(url));
    return (result[storageKey(url)] as PageHistory | undefined) ?? { url: pageKey(url), versions: [] };
  }
  try {
    const raw = localStorage.getItem(storageKey(url));
    return raw ? JSON.parse(raw) as PageHistory : { url: pageKey(url), versions: [] };
  } catch {
    return { url: pageKey(url), versions: [] };
  }
}

export async function saveVersion(rules: StyleRule[], title: string, url = location.href): Promise<SavedVersion> {
  const history = await loadHistory(url);
  const version: SavedVersion = { id: crypto.randomUUID(), createdAt: Date.now(), title, rules };
  history.versions = [version, ...history.versions].slice(0, HISTORY_LIMIT);
  history.activeVersionId = version.id;
  if (extensionStorageAvailable()) await chrome.storage.local.set({ [storageKey(url)]: history });
  else localStorage.setItem(storageKey(url), JSON.stringify(history));
  return version;
}

export async function saveHistory(history: PageHistory): Promise<void> {
  history.versions = history.versions.slice(0, HISTORY_LIMIT);
  if (extensionStorageAvailable()) await chrome.storage.local.set({ [storageKey(history.url)]: history });
  else localStorage.setItem(storageKey(history.url), JSON.stringify(history));
}

export async function setActiveVersion(versionId: string | null, url = location.href): Promise<void> {
  const history = await loadHistory(url);
  history.activeVersionId = versionId;
  await saveHistory(history);
}
