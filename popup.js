"use strict";

const SHOPPING_LIST = [
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

const PROMO_THRESHOLD = 80;
const PROMO_DISCOUNT = 20;

const state = {
  results: [],
  busy: false
};

const elements = {
  scanPage: document.getElementById("scanPage"),
  scanList: document.getElementById("scanList"),
  exportResults: document.getElementById("exportResults"),
  resultsBody: document.getElementById("resultsBody"),
  subtotal: document.getElementById("subtotal"),
  discount: document.getElementById("discount"),
  total: document.getElementById("total"),
  spinner: document.getElementById("spinner"),
  statusText: document.getElementById("statusText")
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  elements.scanPage.addEventListener("click", scanCurrentPage);
  elements.scanList.addEventListener("click", scanShoppingList);
  elements.exportResults.addEventListener("click", exportResults);
  restoreResults();
}

async function restoreResults() {
  const { shoppingListResults = [] } = await chrome.storage.local.get("shoppingListResults");
  if (shoppingListResults.length) {
    setResults(shoppingListResults, "Loaded saved shopping list results.");
  }
}

async function scanCurrentPage() {
  setBusy(true, "Scanning visible products...");

  try {
    const products = await sendContentMessage({ type: "SCAN_CURRENT_PAGE" });
    const normalized = products.map((product) => ({
      query: "",
      name: product.name || "Unknown product",
      price: product.price ?? null,
      priceText: product.priceText || formatPrice(product.price),
      quantity: 1,
      url: product.url || ""
    }));

    setResults(normalized, `Found ${normalized.length} visible products.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function scanShoppingList() {
  setResults([], "Starting shopping list scan...");
  setBusy(true);

  const results = [];

  try {
    for (let index = 0; index < SHOPPING_LIST.length; index += 1) {
      const query = SHOPPING_LIST[index];
      setStatus(`Searching ${index + 1}/${SHOPPING_LIST.length}: ${query}`);

      await navigateToSearch(query);
      const product = await sendContentMessage({ type: "SEARCH_PRODUCT", query });
      const row = product
        ? {
            query,
            name: product.name || query,
            price: product.price ?? null,
            priceText: product.priceText || formatPrice(product.price),
            quantity: 1,
            url: product.url || ""
          }
        : {
            query,
            name: "No matching product found",
            price: null,
            priceText: "N/A",
            quantity: 1,
            url: ""
          };

      results.push(row);
      setResults(results, `Captured ${results.length}/${SHOPPING_LIST.length} products.`);
      await chrome.storage.local.set({ shoppingListResults: results });
    }

    setStatus("Shopping list scan complete.");
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
    "Auchan Drive Helper",
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
  const tab = await getActiveAuchanTab();

  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) {
      throw new Error(response?.error || "The Auchan page did not return scan data.");
    }
    return response.data;
  } catch (error) {
    if (/Receiving end does not exist/i.test(error.message)) {
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

async function navigateToSearch(query) {
  const tab = await getActiveAuchanTab();
  const url = `https://www.auchan.fr/recherche?text=${encodeURIComponent(query)}`;

  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
}

async function getActiveAuchanTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab.url?.startsWith("https://www.auchan.fr/")) {
    throw new Error("Open a https://www.auchan.fr/ tab before scanning.");
  }

  return tab;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for the Auchan search page to load."));
    }, 20000);

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

  const match = String(value).match(/(\d{1,4}(?:[\s.,]\d{2})?)\s*€/);
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
  elements.spinner.hidden = !isBusy;

  if (message) {
    setStatus(message);
  }
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.style.color = isError ? "var(--danger)" : "var(--muted)";
}
