"use strict";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    shoppingListResults: []
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SAVE_SHOPPING_RESULTS") {
    chrome.storage.local
      .set({ shoppingListResults: message.results || [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "FORWARD_TO_ACTIVE_TAB") {
    forwardToActiveTab(message.payload)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function forwardToActiveTab(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  return chrome.tabs.sendMessage(tab.id, payload);
}
