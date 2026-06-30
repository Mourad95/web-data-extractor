"use strict";

const PRODUCT_CARD_SELECTORS = [
  "article",
  "[data-testid*='product' i]",
  "[class*='product' i]"
].join(",");

const PRICE_BUTTON_SELECTORS = [
  "button",
  "[role='button']"
].join(",");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "SCAN_CURRENT_PAGE":
      return scanCurrentPage();
    case "SEARCH_PRODUCT":
      return searchProduct(message.query);
    case "GET_CART_TOTAL":
      return getCartTotal();
    default:
      throw new Error("Unsupported Auchan helper action.");
  }
}

async function scanCurrentPage() {
  await handleCookieConsent();
  await revealHiddenPrices();
  await waitForProductCards();
  return extractVisibleProducts();
}

async function searchProduct(query) {
  if (!query) {
    throw new Error("Missing search query.");
  }

  await handleCookieConsent();

  const url = `https://www.auchan.fr/recherche?text=${encodeURIComponent(query)}`;
  if (!isCurrentSearchPage(query)) {
    history.pushState(null, "", url);
    location.assign(url);
  }

  await waitForPageReady();
  await handleCookieConsent();
  await revealHiddenPrices();
  await waitForProductCards();

  const products = extractVisibleProducts();
  return findCheapestProduct(products, query);
}

async function getCartTotal() {
  await handleCookieConsent();

  const candidates = [
    "[data-testid*='cart' i]",
    "[class*='cart' i]",
    "[class*='basket' i]",
    "[class*='panier' i]",
    "body"
  ];

  for (const selector of candidates) {
    const elements = [...document.querySelectorAll(selector)];
    for (const element of elements) {
      const text = cleanText(element.textContent);
      if (/total/i.test(text) || /panier/i.test(text)) {
        const price = extractPrice(text);
        if (price) {
          return price;
        }
      }
    }
  }

  return null;
}

function isCurrentSearchPage(query) {
  const currentUrl = new URL(location.href);
  return currentUrl.pathname === "/recherche" && currentUrl.searchParams.get("text") === query;
}

function extractVisibleProducts() {
  const cards = [...document.querySelectorAll(PRODUCT_CARD_SELECTORS)]
    .filter(isVisible)
    .filter((card, index, allCards) => allCards.findIndex((candidate) => candidate === card || candidate.contains(card)) === index);

  const products = cards
    .map(extractProductFromCard)
    .filter((product) => product.name && Number.isFinite(product.price));

  return dedupeProducts(products).sort((a, b) => a.price - b.price);
}

function extractProductFromCard(card) {
  const text = cleanText(card.textContent);
  const price = extractPrice(text);
  const url = extractProductUrl(card);
  const name = extractProductName(card, text);

  return {
    name,
    price,
    priceText: price ? formatPrice(price) : "",
    url
  };
}

function extractProductName(card, fallbackText) {
  const nameSelectors = [
    "[data-testid*='name' i]",
    "[data-testid*='title' i]",
    "[class*='name' i]",
    "[class*='title' i]",
    "h3",
    "h2",
    "a[href*='/p/']",
    "a[href]"
  ];

  for (const selector of nameSelectors) {
    const element = card.querySelector(selector);
    const text = cleanText(element?.textContent);
    if (text && !containsOnlyPriceOrAction(text)) {
      return trimProductName(text);
    }
  }

  return trimProductName(fallbackText);
}

function extractProductUrl(card) {
  const link = card.querySelector("a[href]");
  if (!link) {
    return "";
  }

  try {
    return new URL(link.getAttribute("href"), location.origin).href;
  } catch (_error) {
    return "";
  }
}

function findCheapestProduct(products, query) {
  if (!products.length) {
    return null;
  }

  const scored = products
    .map((product) => ({
      product,
      score: scoreProduct(product.name, query)
    }))
    .sort((a, b) => b.score - a.score || a.product.price - b.product.price);

  const bestScore = scored[0]?.score ?? 0;
  const relevant = scored.filter((item) => item.score === bestScore || item.score >= 0.34);
  const pool = relevant.length ? relevant : scored;

  return pool
    .map((item) => item.product)
    .sort((a, b) => a.price - b.price)[0];
}

function scoreProduct(name, query) {
  const nameTokens = tokenize(name);
  const queryTokens = tokenize(query);
  if (!queryTokens.length) {
    return 0;
  }

  const matches = queryTokens.filter((token) => nameTokens.some((nameToken) => nameToken.includes(token) || token.includes(nameToken)));
  return matches.length / queryTokens.length;
}

async function handleCookieConsent() {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "button[id*='accept' i]",
    "button[class*='accept' i]",
    "button[aria-label*='accept' i]",
    "button[aria-label*='accepter' i]"
  ];

  for (const selector of selectors) {
    const button = [...document.querySelectorAll(selector)].find((element) => isVisible(element));
    if (button && /accept|accepter|tout/i.test(cleanText(button.textContent) || button.getAttribute("aria-label") || button.id)) {
      button.click();
      await delay(600);
      return;
    }
  }
}

async function revealHiddenPrices() {
  const buttons = [...document.querySelectorAll(PRICE_BUTTON_SELECTORS)]
    .filter(isVisible)
    .filter((button) => /afficher\s+le\s+prix/i.test(cleanText(button.textContent)));

  for (const button of buttons.slice(0, 20)) {
    button.click();
    await delay(180);
  }

  if (buttons.length) {
    await delay(900);
  }
}

async function waitForProductCards(timeoutMs = 12000) {
  await waitFor(() => document.querySelectorAll(PRODUCT_CARD_SELECTORS).length > 0, timeoutMs);
}

async function waitForPageReady(timeoutMs = 15000) {
  if (document.readyState === "complete") {
    await delay(800);
    return;
  }

  await waitFor(() => document.readyState === "complete", timeoutMs);
  await delay(800);
}

async function waitFor(condition, timeoutMs = 10000, intervalMs = 250) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (condition()) {
      return true;
    }
    await delay(intervalMs);
  }

  throw new Error("Timed out waiting for Auchan results.");
}

function extractPrice(text) {
  if (!text) {
    return null;
  }

  const matches = [...text.matchAll(/(\d{1,4})(?:[\s.,](\d{2}))?\s*€/g)]
    .map((match) => Number(`${match[1].replace(/\s/g, "")}.${match[2] || "00"}`))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!matches.length) {
    return null;
  }

  return Math.min(...matches);
}

function formatPrice(value) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR"
  }).format(value);
}

function trimProductName(text) {
  return cleanText(text)
    .replace(/\d{1,4}(?:[\s.,]\d{2})?\s*€.*/g, "")
    .replace(/(ajouter|afficher le prix|voir le produit|au panier).*/gi, "")
    .slice(0, 180)
    .trim();
}

function containsOnlyPriceOrAction(text) {
  return /^(?:\d{1,4}(?:[\s.,]\d{2})?\s*€|ajouter|afficher le prix|au panier)$/i.test(text);
}

function tokenize(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((token) => token.length > 1);
}

function dedupeProducts(products) {
  const seen = new Set();
  const unique = [];

  for (const product of products) {
    const key = `${product.name.toLowerCase()}|${product.price}|${product.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(product);
    }
  }

  return unique;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
