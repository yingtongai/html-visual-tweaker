chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (!tab.url?.startsWith('file://')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'show-editor' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/editor.js'] });
  }
});
