// Use a normal extension tab so switching away does not destroy an active job.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html');
  const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, {active: true});
    await chrome.windows.update(existing.windowId, {focused: true});
  } else {
    await chrome.tabs.create({url});
  }
});
