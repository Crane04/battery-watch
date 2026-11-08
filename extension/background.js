// Chrome only shows its Bluetooth picker from a normal tab (not a side panel or popup),
// so Battery Watch lives in a pinned tab. Clicking the toolbar icon jumps to it.
const PAGE = chrome.runtime.getURL('panel.html');

chrome.action.onClicked.addListener(async () => {
  const [open] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [PAGE] });
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: PAGE, pinned: true });
  }
});

// The tab keeps a port open while it's connected. When the tab closes, the
// connection ends with it, so clear the % badge rather than leave a stale number.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  port.onMessage.addListener(() => {}); // heartbeats keep this worker awake
  port.onDisconnect.addListener(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Battery Watch' });
  });
});
