"use strict";

const STORAGE_KEYS = {
  configs: "webDataExtractorConfigs",
  results: "webDataExtractorResults"
};

const state = {
  results: [],
  activeTab: null,
  hostname: ""
};

const elements = {
  domainLabel: document.getElementById("domainLabel"),
  currentUrl: document.getElementById("currentUrl"),
  targetUrl: document.getElementById("targetUrl"),
  navigateButton: document.getElementById("navigateButton"),
  cssSelector: document.getElementById("cssSelector"),
  extractType: document.getElementById("extractType"),
  attributeName: document.getElementById("attributeName"),
  labelName: document.getElementById("labelName"),
  saveConfig: document.getElementById("saveConfig"),
  extractButton: document.getElementById("extractButton"),
  clearResults: document.getElementById("clearResults"),
  exportCsv: document.getElementById("exportCsv"),
  resultsBody: document.getElementById("resultsBody"),
  spinner: document.getElementById("spinner"),
  statusText: document.getElementById("statusText"),
  agentStatusDot: document.getElementById("agentStatusDot"),
  agentToggle: document.getElementById("agentToggle"),
  agentUrl: document.getElementById("agentUrl"),
  agentLog: document.getElementById("agentLog")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  elements.navigateButton.addEventListener("click", navigateToUrl);
  elements.extractButton.addEventListener("click", extractData);
  elements.saveConfig.addEventListener("click", saveConfiguration);
  elements.clearResults.addEventListener("click", clearResults);
  elements.exportCsv.addEventListener("click", exportCsv);
  elements.extractType.addEventListener("change", updateAttributePlaceholder);
  elements.agentToggle.addEventListener("click", toggleAgent);

  try {
    state.activeTab = await getActiveTab();
    state.hostname = getHostname(state.activeTab.url);
    elements.domainLabel.textContent = state.hostname || "Current page";
    elements.currentUrl.textContent = state.activeTab.url || "No URL available";
    elements.targetUrl.value = state.activeTab.url || "";

    await loadConfiguration();
    await restoreResults();
    updateAttributePlaceholder();
    await refreshAgentState();
    setInterval(() => {
      refreshAgentState().catch(() => {});
    }, 2000);
    setStatus("Ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadConfiguration() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.configs);
  const configs = stored[STORAGE_KEYS.configs] || {};
  const config = configs[state.hostname] || {};
  const latestSelector = Array.isArray(config.selectors) ? config.selectors[0] : null;

  elements.targetUrl.value = config.urlPattern || elements.targetUrl.value;
  elements.cssSelector.value = latestSelector?.selector || "";
  elements.extractType.value = latestSelector?.extract || "text";
  elements.attributeName.value = latestSelector?.attribute || "";
  elements.labelName.value = latestSelector?.label || "";
}

async function restoreResults() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.results);
  setResults(stored[STORAGE_KEYS.results] || []);
}

async function saveConfiguration() {
  try {
    const config = getConfigFromFields();
    const stored = await chrome.storage.local.get(STORAGE_KEYS.configs);
    const configs = stored[STORAGE_KEYS.configs] || {};

    await chrome.storage.local.set({
      [STORAGE_KEYS.configs]: {
        ...configs,
        [state.hostname]: {
          urlPattern: cleanText(elements.targetUrl.value),
          selectors: [config]
        }
      }
    });

    setStatus(`Saved configuration for ${state.hostname || "this page"}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function navigateToUrl() {
  const rawUrl = cleanText(elements.targetUrl.value);
  if (!rawUrl) {
    setStatus("Enter a URL.", true);
    return;
  }

  try {
    const tab = await getActiveTab();
    const url = new URL(rawUrl, tab.url).href;
    setBusy(true, "Navigating...");
    await chrome.tabs.update(tab.id, { url });
    window.close();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

async function extractData() {
  setBusy(true, "Extracting data...");

  try {
    const config = getConfigFromFields();
    const rows = await sendContentMessage({
      type: "SCAN_PAGE",
      config
    });

    const normalized = rows.map((row) => ({
      name: row.name || config.label || config.selector,
      value: row.value || "",
      url: row.url || state.activeTab?.url || ""
    }));

    setResults(normalized);
    await chrome.storage.local.set({ [STORAGE_KEYS.results]: normalized });
    setStatus(`Extracted ${normalized.length} item${normalized.length === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function clearResults() {
  setResults([]);
  await chrome.storage.local.set({ [STORAGE_KEYS.results]: [] });
  setStatus("Results cleared.");
}

async function refreshAgentState() {
  const state = await sendRuntimeMessage({ type: "GET_AGENT_STATE" });
  renderAgentState(state);
}

async function toggleAgent() {
  try {
    elements.agentToggle.disabled = true;
    const currentState = await sendRuntimeMessage({ type: "GET_AGENT_STATE" });
    const nextState = await sendRuntimeMessage({
      type: "SET_AGENT_ENABLED",
      enabled: !currentState.enabled
    });
    renderAgentState(nextState);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.agentToggle.disabled = false;
  }
}

function renderAgentState(agentState = {}) {
  elements.agentStatusDot.classList.toggle("running", Boolean(agentState.connected));
  elements.agentToggle.textContent = agentState.enabled ? "Stop Agent" : "Start Agent";
  elements.agentUrl.textContent = agentState.url || "http://localhost:3456";

  const commands = Array.isArray(agentState.commands) ? agentState.commands : [];
  if (!commands.length) {
    elements.agentLog.textContent = "No recent commands.";
    return;
  }

  elements.agentLog.innerHTML = commands
    .slice(0, 5)
    .map((entry) => `
      <div class="agent-log-row">
        <span>${escapeHtml(entry.time || "")}</span>
        <strong>${escapeHtml(entry.command || "unknown")}</strong>
        <span>${entry.success ? "ok" : "error"}</span>
      </div>
    `)
    .join("");
}

function exportCsv() {
  if (!state.results.length) {
    setStatus("There are no results to export.", true);
    return;
  }

  const rows = [
    ["#", "Label", "Value", "URL/Context"],
    ...state.results.map((item, index) => [
      index + 1,
      item.name || "",
      item.value || "",
      item.url || ""
    ])
  ];

  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `web-data-extractor-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("CSV exported.");
}

async function sendContentMessage(message) {
  const tab = await getActiveTab();
  state.activeTab = tab;

  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) {
      throw new Error(response?.error || "The page did not return extracted data.");
    }
    return response.data;
  } catch (error) {
    if (/Receiving end does not exist|Could not establish connection/i.test(error.message)) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      const response = await chrome.tabs.sendMessage(tab.id, message);
      if (!response?.ok) {
        throw new Error(response?.error || "The page did not return extracted data.");
      }
      return response.data;
    }
    throw error;
  }
}

async function sendRuntimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "The extension background did not respond.");
  }
  return response.data;
}

function getConfigFromFields() {
  const selector = cleanText(elements.cssSelector.value);
  if (!selector) {
    throw new Error("Enter a CSS selector.");
  }

  return {
    selector,
    extract: elements.extractType.value,
    attribute: cleanText(elements.attributeName.value),
    label: cleanText(elements.labelName.value)
  };
}

function setResults(results) {
  state.results = Array.isArray(results) ? results : [];
  elements.exportCsv.disabled = !state.results.length;

  if (!state.results.length) {
    elements.resultsBody.innerHTML = `<tr class="empty-row"><td colspan="4">No results yet.</td></tr>`;
    return;
  }

  elements.resultsBody.innerHTML = state.results
    .map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.name || "")}</td>
        <td>${escapeHtml(item.value || "")}</td>
        <td>${formatContextCell(item.url)}</td>
      </tr>
    `)
    .join("");
}

function formatContextCell(url) {
  if (!url) {
    return "";
  }

  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`;
}

function updateAttributePlaceholder() {
  const extractType = elements.extractType.value;
  const needsAttribute = extractType === "attribute" || extractType === "data-*";
  elements.attributeName.disabled = !needsAttribute;
  elements.attributeName.placeholder = extractType === "data-*" ? "Optional data-* name" : "Attribute name";
}

function setBusy(isBusy, message = "") {
  elements.spinner.hidden = !isBusy;
  elements.extractButton.disabled = isBusy;
  elements.navigateButton.disabled = isBusy;
  elements.saveConfig.disabled = isBusy;
  if (message) {
    setStatus(message);
  }
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.classList.toggle("error", isError);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }
  return tab;
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanText(value) {
  return String(value || "").trim();
}
