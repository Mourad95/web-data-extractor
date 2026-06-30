"use strict";

const DEFAULT_SHOPPING_LIST = [
  "blanc de poulet 1kg",
  "blanc de poulet 500g",
  "viande hachée 5% 500g",
  "jambon blanc 4 tranches",
  "thon boîte nature 140g",
  "oeufs plein air x12",
  "riz complet 1kg",
  "pâtes complètes 500g",
  "nouilles de riz 250g",
  "sauce soja sucrée",
  "huile d'olive vierge extra 1L",
  "huile de sésame",
  "miel",
  "courgette",
  "carottes 1kg",
  "poivron",
  "concombre",
  "tomates cerises",
  "tomates concassées 400g boîte",
  "avocat",
  "oignon",
  "ail",
  "citron",
  "maïs doux boîte",
  "gingembre frais",
  "fromage blanc 0% 1kg",
  "fromage râpé",
  "graines de chia bio"
];

const AUCHAN_SEARCH_URL = "https://www.auchan.fr/recherche?text={query}";
const SEARCH_PARAM_NAMES = ["q", "query", "search", "text", "s", "keyword"];
const PROMO_THRESHOLD = 80;
const PROMO_DISCOUNT = 20;

const state = {
  results: [],
  busy: false,
  activeTab: null,
  hostname: ""
};

const elements = {
  configForm: document.getElementById("configForm"),
  searchUrl: document.getElementById("searchUrl"),
  nameSelector: document.getElementById("nameSelector"),
  priceSelector: document.getElementById("priceSelector"),
  addToCartSelector: document.getElementById("addToCartSelector"),
  quantitySelector: document.getElementById("quantitySelector"),
  productList: document.getElementById("productList"),
  saveConfig: document.getElementById("saveConfig"),
  scanPage: document.getElementById("scanPage"),
  scanList: document.getElementById("scanList"),
  exportResults: document.getElementById("exportResults"),
  resultsBody: document.getElementById("resultsBody"),
  subtotal: document.getElementById("subtotal"),
  discount: document.getElementById("discount"),
  total: document.getElementById("total"),
  spinner: document.getElementById("spinner"),
  statusText: document.getElementById("statusText"),
  domainLabel: document.getElementById("domainLabel")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  elements.scanPage.addEventListener("click", scanCurrentPage);
  elements.scanList.addEventListener("click", scanShoppingList);
  elements.saveConfig.addEventListener("click", saveConfiguration);
  elements.exportResults.addEventListener("click", exportResults);
  elements.productList.addEventListener("change", saveShoppingList);

  try {
    state.activeTab = await getActiveTab();
    state.hostname = getHostname(state.activeTab.url);
    elements.domainLabel.textContent = state.hostname || "Current website";
    await loadConfiguration();
    await restoreResults();
    setStatus("Ready to scan this page or a configured search list.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadConfiguration() {
  const {
    siteConfigurations = {},
    shoppingList = DEFAULT_SHOPPING_LIST
  } = await chrome.storage.local.get(["siteConfigurations", "shoppingList"]);

  const saved = siteConfigurations[state.hostname] || {};
  const defaults = getDefaultConfigForTab(state.activeTab);
  setConfigFields({ ...defaults, ...saved });
  elements.productList.value = normalizeList(shoppingList).join("\n");
}

async function restoreResults() {
  const { shoppingListResults = [] } = await chrome.storage.local.get("shoppingListResults");
  if (shoppingListResults.length) {
    setResults(shoppingListResults, "Loaded saved shopping list results.");
  }
}

async function saveConfiguration() {
  try {
    const config = getConfigFromFields();
    const { siteConfigurations = {} } = await chrome.storage.local.get("siteConfigurations");
    await chrome.storage.local.set({
      siteConfigurations: {
        ...siteConfigurations,
        [state.hostname]: config
      }
    });
    await saveShoppingList();
    setStatus(`Saved configuration for ${state.hostname}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function saveShoppingList() {
  await chrome.storage.local.set({ shoppingList: getShoppingList() });
}

async function scanCurrentPage() {
  setBusy(true, "Scanning current page with generic detection...");

  try {
    const products = await sendContentMessage({
      type: "SCAN_CURRENT_PAGE",
      config: getConfigFromFields()
    });

    const normalized = products.map((product) => normalizeResult(product));
    setResults(normalized, `Found ${normalized.length} products on this page.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function scanShoppingList() {
  const list = getShoppingList();
  if (!list.length) {
    setStatus("Add at least one product to the custom list.", true);
    return;
  }

  setResults([], "Starting custom list scan...");
  setBusy(true);

  const results = [];
  const config = getConfigFromFields();

  try {
    await saveShoppingList();

    for (let index = 0; index < list.length; index += 1) {
      const query = list[index];
      setStatus(`Searching ${index + 1}/${list.length}: ${query}`);

      await navigateToSearch(query, config);
      const product = await sendContentMessage({ type: "SEARCH_PRODUCT", query, config });
      const row = product
        ? normalizeResult(product, query)
        : {
            query,
            name: "No matching product found",
            price: null,
            priceText: "N/A",
            quantity: 1,
            url: ""
          };

      results.push(row);
      setResults(results, `Captured ${results.length}/${list.length} products.`);
      await chrome.storage.local.set({ shoppingListResults: results });
    }

    setStatus("Custom list scan complete.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function exportResults() {
  const subtotal = calculateSubtotal(state.results);
  const discount = subtotal >= PROMO_THRESHOLD ? PROMO_DISCOUNT : 0;
  const total = Math.max(0, subtotal - discount);
  const lines = [
    "E-commerce Price Scanner",
    "",
    ...state.results.map((item, index) => {
      const query = item.query ? ` (${item.query})` : "";
      return `${index + 1}. ${item.name}${query} - ${item.priceText || formatPrice(item.price)} x${item.quantity || 1}`;
    }),
    "",
    `Subtotal: ${formatPrice(subtotal)}`,
    `BIENVENUE20: -${formatPrice(discount)}`,
    `Total: ${formatPrice(total)}`
  ];

  await navigator.clipboard.writeText(lines.join("\n"));
  setStatus("Results copied to clipboard.");
}

async function sendContentMessage(message) {
  const tab = await getActiveTab();

  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) {
      throw new Error(response?.error || "The page did not return scan data.");
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
        throw new Error(response?.error || "The injected scanner did not return data.");
      }
      return response.data;
    }
    throw error;
  }
}

async function navigateToSearch(query, config) {
  const tab = await getActiveTab();
  const url = buildSearchUrl(query, config, tab);

  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
}

function buildSearchUrl(query, config, tab) {
  const template = cleanText(config.searchUrl) || getDefaultConfigForTab(tab).searchUrl;
  if (!template) {
    throw new Error("Add a search URL before scanning a custom list. Use {query} where the product should go.");
  }

  if (template.includes("{query}")) {
    return template.replaceAll("{query}", encodeURIComponent(query));
  }

  const url = new URL(template, tab.url);
  const existingParam = SEARCH_PARAM_NAMES.find((name) => url.searchParams.has(name)) || SEARCH_PARAM_NAMES[0];
  url.searchParams.set(existingParam, query);
  return url.href;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
    throw new Error("Open an HTTP or HTTPS e-commerce page before scanning.");
  }

  return tab;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for the search page to load."));
    }, 25000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function getDefaultConfigForTab(tab) {
  const hostname = getHostname(tab?.url);
  if (/(\.|^)auchan\.fr$/i.test(hostname)) {
    return { searchUrl: AUCHAN_SEARCH_URL };
  }

  return { searchUrl: "" };
}

function getConfigFromFields() {
  return {
    searchUrl: cleanText(elements.searchUrl.value),
    nameSelector: cleanText(elements.nameSelector.value),
    priceSelector: cleanText(elements.priceSelector.value),
    addToCartSelector: cleanText(elements.addToCartSelector.value),
    quantitySelector: cleanText(elements.quantitySelector.value)
  };
}

function setConfigFields(config) {
  elements.searchUrl.value = config.searchUrl || "";
  elements.nameSelector.value = config.nameSelector || "";
  elements.priceSelector.value = config.priceSelector || "";
  elements.addToCartSelector.value = config.addToCartSelector || "";
  elements.quantitySelector.value = config.quantitySelector || "";
}

function getShoppingList() {
  return normalizeList(elements.productList.value.split(/\n+/));
}

function normalizeList(list) {
  return list
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function normalizeResult(product, query = "") {
  return {
    query,
    name: product.name || "Unknown product",
    price: product.price ?? null,
    priceText: product.priceText || formatPrice(product.price),
    quantity: product.quantity || 1,
    url: product.url || ""
  };
}

function setResults(results, statusMessage) {
  state.results = results;
  renderResults();
  updateTotals();
  elements.exportResults.disabled = results.length === 0;

  if (statusMessage) {
    setStatus(statusMessage);
  }
}

function renderResults() {
  elements.resultsBody.replaceChildren();

  if (!state.results.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    row.innerHTML = '<td colspan="3">No results yet.</td>';
    elements.resultsBody.append(row);
    return;
  }

  const fragment = document.createDocumentFragment();

  state.results.forEach((item) => {
    const row = document.createElement("tr");
    const productCell = document.createElement("td");
    const priceCell = document.createElement("td");
    const quantityCell = document.createElement("td");

    const name = document.createElement("span");
    name.className = "product-name";
    name.textContent = item.name;
    productCell.append(name);

    if (item.query) {
      const query = document.createElement("span");
      query.className = "product-query";
      query.textContent = item.query;
      productCell.append(query);
    }

    if (item.url) {
      const url = document.createElement("span");
      url.className = "product-url";
      url.textContent = item.url;
      productCell.append(url);
    }

    priceCell.textContent = item.priceText || formatPrice(item.price);
    quantityCell.textContent = item.quantity || 1;

    row.append(productCell, priceCell, quantityCell);
    fragment.append(row);
  });

  elements.resultsBody.append(fragment);
}

function updateTotals() {
  const subtotal = calculateSubtotal(state.results);
  const discount = subtotal >= PROMO_THRESHOLD ? PROMO_DISCOUNT : 0;
  const total = Math.max(0, subtotal - discount);

  elements.subtotal.textContent = formatPrice(subtotal);
  elements.discount.textContent = discount ? `-${formatPrice(discount)}` : formatPrice(0);
  elements.total.textContent = formatPrice(total);
}

function calculateSubtotal(results) {
  return results.reduce((sum, item) => {
    const price = Number.isFinite(item.price) ? item.price : parsePrice(item.priceText);
    const quantity = Number(item.quantity || 1);
    return sum + (Number.isFinite(price) ? price * quantity : 0);
  }, 0);
}

function parsePrice(value) {
  if (!value) {
    return null;
  }

  const match = String(value).match(/(?:[€$£]\s*)?(\d{1,6}(?:[\s.,]\d{3})*(?:[.,]\d{2})?)(?:\s*[€$£])?/);
  if (!match) {
    return null;
  }

  return Number(match[1].replace(/\s/g, "").replace(",", "."));
}

function formatPrice(value) {
  const amount = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR"
  }).format(amount);
}

function setBusy(isBusy, message) {
  state.busy = isBusy;
  elements.scanPage.disabled = isBusy;
  elements.scanList.disabled = isBusy;
  elements.saveConfig.disabled = isBusy;
  elements.spinner.hidden = !isBusy;

  if (message) {
    setStatus(message);
  }
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
