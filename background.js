"use strict";

const AGENT_HTTP_URL = "http://localhost:3456";
const AGENT_STORAGE_KEYS = {
  enabled: "webDataExtractorAgentEnabled",
  log: "webDataExtractorAgentLog"
};

let agentSocket = null;
let reconnectTimer = null;
let agentEnabled = false;
let agentConnected = false;
let agentConnecting = false;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([
    "webDataExtractorResults",
    "webDataExtractorConfigs",
    AGENT_STORAGE_KEYS.enabled,
    AGENT_STORAGE_KEYS.log
  ]);
  await chrome.storage.local.set({
    webDataExtractorResults: current.webDataExtractorResults || [],
    webDataExtractorConfigs: current.webDataExtractorConfigs || {},
    [AGENT_STORAGE_KEYS.enabled]: Boolean(current[AGENT_STORAGE_KEYS.enabled]),
    [AGENT_STORAGE_KEYS.log]: current[AGENT_STORAGE_KEYS.log] || []
  });
});

chrome.runtime.onStartup.addListener(restoreAgentState);
restoreAgentState();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SAVE_EXTRACTED_DATA") {
    chrome.storage.local
      .set({ webDataExtractorResults: message.results || [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SEND_TO_ACTIVE_TAB") {
    sendToActiveTab(message.payload)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_AGENT_STATE") {
    getAgentState()
      .then((state) => sendResponse({ ok: true, data: state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SET_AGENT_ENABLED") {
    setAgentEnabled(Boolean(message.enabled))
      .then((state) => sendResponse({ ok: true, data: state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function restoreAgentState() {
  const stored = await chrome.storage.local.get(AGENT_STORAGE_KEYS.enabled);
  agentEnabled = Boolean(stored[AGENT_STORAGE_KEYS.enabled]);
  if (agentEnabled) {
    connectAgent();
  }
}

async function setAgentEnabled(enabled) {
  agentEnabled = enabled;
  await chrome.storage.local.set({ [AGENT_STORAGE_KEYS.enabled]: enabled });

  if (enabled) {
    connectAgent();
  } else {
    disconnectAgent();
  }

  return getAgentState();
}

async function getAgentState() {
  const stored = await chrome.storage.local.get(AGENT_STORAGE_KEYS.log);
  return {
    enabled: agentEnabled,
    connected: agentConnected,
    url: AGENT_HTTP_URL,
    commands: stored[AGENT_STORAGE_KEYS.log] || []
  };
}

async function connectAgent() {
  if (
    !agentEnabled ||
    agentConnecting ||
    agentSocket?.readyState === WebSocket.OPEN ||
    agentSocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  clearTimeout(reconnectTimer);
  agentConnecting = true;

  let wsUrl;
  try {
    const response = await fetch(`${AGENT_HTTP_URL}/ws-port`);
    const payload = await response.json();
    if (!payload.port) {
      throw new Error("Agent server did not provide a WebSocket port.");
    }
    wsUrl = `ws://localhost:${payload.port}`;
  } catch (error) {
    agentConnecting = false;
    console.log(`AI Browser Agent connection failed: ${error.message}`);
    scheduleReconnect();
    return;
  }

  agentSocket = new WebSocket(wsUrl);

  agentSocket.addEventListener("open", async () => {
    agentConnecting = false;
    agentConnected = true;
    console.log(`AI Browser Agent WebSocket connected: ${wsUrl}`);
    await sendAgentStatus();
  });

  agentSocket.addEventListener("message", (event) => {
    handleAgentMessage(event.data);
  });

  agentSocket.addEventListener("close", () => {
    agentConnecting = false;
    agentConnected = false;
    agentSocket = null;
    scheduleReconnect();
  });

  agentSocket.addEventListener("error", () => {
    agentConnecting = false;
    agentConnected = false;
  });
}

function disconnectAgent() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  agentConnecting = false;
  agentConnected = false;

  if (agentSocket) {
    agentSocket.close();
    agentSocket = null;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!agentEnabled) {
    return;
  }

  reconnectTimer = setTimeout(connectAgent, 1500);
}

async function handleAgentMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch (_error) {
    return;
  }

  const result = await executeAgentCommand(message.command, message.params || {});
  await appendAgentLog(message.command, result.success);
  sendAgentResponse({ id: message.id, result });
  await sendAgentStatus();
}

function sendAgentResponse(payload) {
  if (agentSocket?.readyState === WebSocket.OPEN) {
    agentSocket.send(JSON.stringify(payload));
  }
}

async function sendAgentStatus() {
  if (agentSocket?.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    agentSocket.send(JSON.stringify({
      type: "status",
      url: tab?.url || "",
      title: tab?.title || ""
    }));
  } catch (_error) {
    agentSocket.send(JSON.stringify({ type: "status", url: "", title: "" }));
  }
}

async function executeAgentCommand(command, params) {
  try {
    const tab = await getActiveHttpTab();

    if (command === "screenshot") {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { success: true, data: dataUrl.replace(/^data:image\/png;base64,/, "") };
    }

    const response = await sendToTabWithInjection(tab.id, {
      type: "AGENT_COMMAND",
      command,
      params
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The page did not return an agent response.");
    }

    return response.data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function sendToActiveTab(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  return chrome.tabs.sendMessage(tab.id, payload);
}

async function getActiveHttpTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }
  if (!/^https?:\/\//i.test(tab.url || "")) {
    throw new Error("Open an HTTP or HTTPS tab before using the Agent.");
  }
  return tab;
}

async function sendToTabWithInjection(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (/Receiving end does not exist|Could not establish connection/i.test(error.message)) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      return chrome.tabs.sendMessage(tabId, payload);
    }
    throw error;
  }
}

async function appendAgentLog(command, success) {
  const stored = await chrome.storage.local.get(AGENT_STORAGE_KEYS.log);
  const commands = stored[AGENT_STORAGE_KEYS.log] || [];
  const entry = {
    command: command || "unknown",
    success: Boolean(success),
    time: new Date().toLocaleTimeString()
  };

  await chrome.storage.local.set({
    [AGENT_STORAGE_KEYS.log]: [entry, ...commands].slice(0, 20)
  });
}
