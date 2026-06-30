"use strict";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "SCAN_PAGE":
      return scanPage(message.config);
    case "SEARCH_AND_SCAN":
      return searchAndScan(message.url, message.config);
    case "AGENT_COMMAND":
      return runAgentCommand(message.command, message.params || {});
    default:
      throw new Error("Unsupported extractor action.");
  }
}

async function runAgentCommand(command, params = {}) {
  try {
    switch (command) {
      case "navigate":
        return await agentNavigate(params.url);
      case "click":
        return agentClick(params.selector);
      case "fill":
        return agentFill(params.selector, params.value);
      case "extract":
        return agentExtract(params.selector, params.attribute || "text");
      case "wait":
        await delay(Number(params.ms) || 0);
        return { success: true, data: { waitedMs: Number(params.ms) || 0 } };
      case "scroll":
        return agentScroll(params.direction, params.amount);
      case "eval":
        return agentEval(params.javascript);
      case "screenshot":
        return { success: false, error: "Screenshots are captured by the extension background." };
      default:
        return { success: false, error: `Unsupported agent command: ${command || "unknown"}.` };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function agentNavigate(url) {
  if (!url) {
    throw new Error("Missing url.");
  }

  const targetUrl = new URL(url, window.location.href).href;
  window.location.href = targetUrl;
  return { success: true, data: { url: targetUrl } };
}

function agentClick(selector) {
  const element = queryRequiredElement(selector);
  element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  element.click();
  return { success: true, data: elementSummary(element) };
}

function agentFill(selector, value = "") {
  const element = queryRequiredElement(selector);
  const text = String(value ?? "");

  if (!("value" in element)) {
    throw new Error("Selected element cannot be filled.");
  }

  element.focus();
  element.value = text;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { success: true, data: elementSummary(element) };
}

function agentExtract(selector, attribute = "text") {
  const element = queryRequiredElement(selector);
  const normalizedAttribute = cleanText(attribute).toLowerCase() || "text";

  if (normalizedAttribute === "text") {
    return { success: true, data: cleanText(element.innerText || element.textContent) };
  }
  if (normalizedAttribute === "html") {
    return { success: true, data: element.innerHTML || "" };
  }
  if (normalizedAttribute === "href" || normalizedAttribute === "src") {
    const value = element.getAttribute(normalizedAttribute);
    return {
      success: true,
      data: value ? new URL(value, window.location.href).href : ""
    };
  }

  return { success: false, error: "Attribute must be one of: text, href, src, html." };
}

function agentScroll(direction = "down", amount = 3) {
  const normalizedDirection = direction === "up" ? "up" : "down";
  const pages = Math.max(1, Number(amount) || 1);
  const top = window.innerHeight * pages * (normalizedDirection === "up" ? -1 : 1);

  window.scrollBy({ top, left: 0, behavior: "smooth" });
  return {
    success: true,
    data: {
      x: window.scrollX,
      y: window.scrollY,
      direction: normalizedDirection,
      amount: pages
    }
  };
}

function agentEval(javascript) {
  if (!javascript) {
    throw new Error("Missing javascript.");
  }

  const result = window.eval(String(javascript));
  return { success: true, data: serializeEvalResult(result) };
}

function queryRequiredElement(selector) {
  const normalizedSelector = cleanText(selector);
  if (!normalizedSelector) {
    throw new Error("Missing selector.");
  }

  try {
    const element = document.querySelector(normalizedSelector);
    if (!element) {
      throw new Error(`No element matches selector: ${normalizedSelector}`);
    }
    return element;
  } catch (error) {
    if (error.name === "SyntaxError") {
      throw new Error("The CSS selector is not valid.");
    }
    throw error;
  }
}

function elementSummary(element) {
  return {
    tagName: element.tagName?.toLowerCase() || "",
    id: element.id || "",
    text: cleanText(element.innerText || element.textContent).slice(0, 200)
  };
}

function serializeEvalResult(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return String(value);
  }
}

async function scanPage(config = {}) {
  await waitForPageReady();

  const normalized = normalizeConfig(config);
  const elements = safeQueryAll(normalized.selector).filter(isElement);

  return elements
    .map((element) => createExtractedItem(element, normalized))
    .filter((item) => item.value);
}

async function searchAndScan(url, config = {}) {
  if (!url) {
    throw new Error("Missing URL.");
  }

  const targetUrl = new URL(url, window.location.href).href;
  if (targetUrl !== window.location.href) {
    window.location.href = targetUrl;
    return [];
  }

  return scanPage(config);
}

function normalizeConfig(config = {}) {
  const selector = cleanText(config.selector);
  if (!selector) {
    throw new Error("Enter a CSS selector.");
  }

  return {
    selector,
    extract: cleanText(config.extract) || "text",
    attribute: cleanText(config.attribute || config.attributeName),
    label: cleanText(config.label)
  };
}

function createExtractedItem(element, config) {
  const value = extractValue(element, config);
  const contextUrl = getContextUrl(element);
  const fallbackName = config.label || readableSelectorName(element) || config.selector;

  return {
    name: fallbackName,
    value: normalizeExtractedValue(value, config.extract),
    url: contextUrl
  };
}

function extractValue(element, config) {
  switch (config.extract) {
    case "href":
      return element.getAttribute("href") ? new URL(element.getAttribute("href"), window.location.href).href : "";
    case "src":
      return element.getAttribute("src") ? new URL(element.getAttribute("src"), window.location.href).href : "";
    case "alt":
      return element.getAttribute("alt") || "";
    case "data-*":
      return extractDataAttribute(element, config.attribute);
    case "attribute":
      return config.attribute ? element.getAttribute(config.attribute) || "" : "";
    case "innerHTML":
      return element.innerHTML || "";
    case "text":
    default:
      return element.innerText || element.textContent || "";
  }
}

function extractFirstDataAttribute(element) {
  const dataAttribute = Array.from(element.attributes).find((attribute) => attribute.name.startsWith("data-"));
  return dataAttribute?.value || "";
}

function extractDataAttribute(element, attributeName) {
  if (!attributeName) {
    return extractFirstDataAttribute(element);
  }

  const normalizedName = attributeName.startsWith("data-") ? attributeName : `data-${attributeName}`;
  return element.getAttribute(normalizedName) || "";
}

function getContextUrl(element) {
  const link = element.closest("a[href]") || element.querySelector?.("a[href]");
  if (!link) {
    return window.location.href;
  }

  try {
    return new URL(link.getAttribute("href"), window.location.href).href;
  } catch (_error) {
    return window.location.href;
  }
}

function readableSelectorName(element) {
  if (element.id) {
    return `#${element.id}`;
  }

  if (element.getAttribute("aria-label")) {
    return element.getAttribute("aria-label");
  }

  if (element.getAttribute("name")) {
    return element.getAttribute("name");
  }

  return element.tagName ? element.tagName.toLowerCase() : "";
}

function safeQueryAll(selector) {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch (_error) {
    throw new Error("The CSS selector is not valid.");
  }
}

function isElement(node) {
  return node && node.nodeType === Node.ELEMENT_NODE;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeExtractedValue(value, extractType) {
  if (extractType === "innerHTML") {
    return String(value || "").trim();
  }

  return cleanText(value);
}

function waitForPageReady() {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
