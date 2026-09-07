chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (!tab.url?.startsWith('file://')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'show-editor' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/editor.js'] });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab?.url?.startsWith('file://')) return;
  if (message?.type === 'read-page-source') {
    void readPageSource(sender.tab.url)
      .then((source) => sendResponse({ ok: true, source }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '无法读取当前 HTML 源码' }));
    return true;
  }
  if (
    message?.type === 'export-package'
    && typeof message.content === 'string'
    && typeof message.filename === 'string'
    && typeof message.exportFolder === 'string'
    && typeof message.assetRootUrl === 'string'
  ) {
    void exportPackage(message.content, message.filename, message.exportFolder, message.assetRootUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '浏览器导出失败' }));
    return true;
  }
});

async function readPageSource(tabUrl: string): Promise<string> {
  const url = new URL(tabUrl);
  url.search = '';
  url.hash = '';
  const response = await fetch(url.href, { cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取当前 HTML 源码：${response.status}`);
  return response.text();
}

async function exportPackage(
  content: string,
  filename: string,
  exportFolder: string,
  assetRootUrl: string
): Promise<{ fileCount: number; warningCount: number }> {
  const folder = normalizeDownloadFolder(exportFolder);
  const safeFilename = sanitizePathSegment(filename);
  const rootUrl = normalizeFileDirectoryUrl(assetRootUrl);
  const pageUrl = new URL(safeFilename, rootUrl);
  const documentBaseUrl = readDocumentBaseUrl(content, pageUrl);
  const pending = extractReferences(content, documentBaseUrl);
  const queued = new Set(pending.map(fileUrlKey));
  let fileCount = 0;
  let warningCount = 0;

  while (pending.length) {
    if (queued.size > 500) {
      warningCount += pending.length;
      break;
    }
    const resourceUrl = pending.shift()!;
    const relativePath = relativeAssetPath(resourceUrl, rootUrl);
    if (!relativePath || fileUrlKey(resourceUrl) === fileUrlKey(pageUrl)) {
      if (!relativePath) warningCount += 1;
      continue;
    }
    try {
      const response = await fetch(resourceUrl.href, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type')?.split(';')[0] || inferMimeType(relativePath);
      await downloadBytes(bytes, mimeType, `${folder}/${relativePath}`);
      fileCount += 1;

      if (isTextDependency(relativePath, mimeType)) {
        const text = new TextDecoder().decode(bytes);
        const nestedBase = /\.html?$/i.test(relativePath) ? readDocumentBaseUrl(text, resourceUrl) : resourceUrl;
        for (const nested of extractReferences(text, nestedBase)) {
          const key = fileUrlKey(nested);
          if (!queued.has(key)) {
            queued.add(key);
            pending.push(nested);
          }
        }
      }
    } catch (error) {
      warningCount += 1;
      console.warn('[HTML Visual Tweaker] unable to copy resource', resourceUrl.href, error);
    }
  }

  await downloadBytes(new TextEncoder().encode(content), 'text/html;charset=utf-8', `${folder}/${safeFilename}`);
  return { fileCount: fileCount + 1, warningCount };
}

function extractReferences(source: string, baseUrl: URL): URL[] {
  const rawReferences = new Set<string>();
  const attributePattern = /\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gi;
  const srcsetPattern = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;
  const cssUrlPattern = /\burl\(\s*(["']?)(.*?)\1\s*\)/gi;
  const cssImportPattern = /@import\s+(?:url\(\s*)?(["'])(.*?)\1/gi;
  const modulePattern = /\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?(["'])(.*?)\1/g;
  const dynamicImportPattern = /\bimport\s*\(\s*(["'])(.*?)\1\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(source))) rawReferences.add(match[2]);
  while ((match = srcsetPattern.exec(source))) {
    match[2].split(',').forEach((candidate) => rawReferences.add(candidate.trim().split(/\s+/)[0]));
  }
  while ((match = cssUrlPattern.exec(source))) rawReferences.add(match[2]);
  while ((match = cssImportPattern.exec(source))) rawReferences.add(match[2]);
  while ((match = modulePattern.exec(source))) rawReferences.add(match[2]);
  while ((match = dynamicImportPattern.exec(source))) rawReferences.add(match[2]);

  const urls: URL[] = [];
  for (const reference of rawReferences) {
    const value = reference.trim();
    if (!value || value.startsWith('#') || /^(?:data|blob|https?|mailto|tel|javascript):/i.test(value)) continue;
    try {
      const resolved = new URL(value, baseUrl);
      if (resolved.protocol !== 'file:') continue;
      resolved.search = '';
      resolved.hash = '';
      urls.push(resolved);
    } catch {
      // Ignore malformed resource references from page content.
    }
  }
  return urls;
}

function readDocumentBaseUrl(source: string, pageUrl: URL): URL {
  const match = source.match(/<base\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/i);
  if (!match) return pageUrl;
  try { return new URL(match[2], pageUrl); }
  catch { return pageUrl; }
}

function normalizeFileDirectoryUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'file:') throw new Error('只能导出本地 HTML 页面的资源');
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function relativeAssetPath(resourceUrl: URL, rootUrl: URL): string | null {
  const resourcePath = safelyDecodePath(resourceUrl.pathname);
  const rootPath = safelyDecodePath(rootUrl.pathname);
  if (!resourcePath.toLocaleLowerCase().startsWith(rootPath.toLocaleLowerCase())) return null;
  const relative = resourcePath.slice(rootPath.length).replace(/^\/+/, '');
  if (!relative || relative.endsWith('/')) return null;
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.map(sanitizePathSegment).join('/');
}

function safelyDecodePath(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function fileUrlKey(url: URL): string {
  const copy = new URL(url.href);
  copy.search = '';
  copy.hash = '';
  return copy.href.toLocaleLowerCase();
}

function normalizeDownloadFolder(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || /^[a-z]:/i.test(normalized)) throw new Error('导出目录必须是下载目录下的相对路径');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('导出目录不能包含 . 或 ..');
  return parts.map(sanitizePathSegment).join('/');
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return sanitized || 'unnamed';
}

function isTextDependency(path: string, mimeType: string): boolean {
  return /\.(?:css|js|mjs|cjs|html?|svg)$/i.test(path)
    || /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/i.test(mimeType);
}

function inferMimeType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    html: 'text/html', htm: 'text/html', json: 'application/json', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf'
  };
  return extension ? types[extension] ?? 'application/octet-stream' : 'application/octet-stream';
}

async function downloadBytes(bytes: Uint8Array, mimeType: string, filename: string): Promise<void> {
  const binaryChunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binaryChunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  const url = `data:${mimeType};base64,${btoa(binaryChunks.join(''))}`;
  await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'overwrite' });
}
