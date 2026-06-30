"use strict";

const GENERIC_PRODUCT_CARD_SELECTORS = [
  "article",
  "[itemtype*='Product' i]",
  "[itemscope][itemtype*='schema.org/Product' i]",
  "[data-testid*='product' i]",
  "[data-test*='product' i]",
  "[data-cy*='product' i]",
  "[class*='product' i]",
  "[class*='item' i]",
  "[class*='card' i]",
  "li"
];

const GENERIC_NAME_SELECTORS = [
  "[itemprop='name']",
  "[data-testid*='name' i]",
  "[data-testid*='title' i]",
  "[data-test*='name' i]",
  "[data-test*='title' i]",
  "[class*='name' i]",
  "[class*='title' i]",
  "[class*='label' i]",
  "h1",
  "h2",
  "h3",
  "h4",
  "a[href]"
];

const GENERIC_PRICE_SELECTORS = [
  "[itemprop='price']",
  "[data-testid*='price' i]",
  "[data-test*='price' i]",
  "[class*='price' i]",
  "[class*='amount' i]",
  "[aria-label*='price' i]",
  "[aria-label*='prix' i]"
];

const ACTION_BUTTON_SELECTORS = [
  "button",
  "[role='button']",
  "input[type='button']",
  "input[type='submit']"
];

const PRICE_TEXT_REGEX = /(?:[€$£]\s*\d{1,6}(?:[\s.,]\d{3})*(?:[.,]\d{2})?|\d{1,6}(?:[\s.,]\d{3})*(?:[.,]\d{2})?\s*[€$£])/g;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  const config = normalizeConfig(message?.config);

  switch (message?.type) {
    case "SCAN_CURRENT_PAGE":
      return scanGeneric(config);
    case "SEARCH_PRODUCT":
      return searchProduct(message.query, config);
    case "GET_CART_TOTAL":
      return getCartTotal(config);
    default:
      throw new Error("Unsupported scanner action.");
  }
}

async function scanGeneric(config = {}) {
  await waitForPageReady();
  await handleCookieConsent();
  await revealHiddenPrices(config);
  await waitForLikelyProducts(config);

  const configured = extractConfiguredProducts(config);
  if (configured.length) {
    return configured;
  }

  const cardProducts = extractProductsFromCommonCards();
  const priceProducts = extractProductsFromPriceElements();

  return dedupeProducts([...cardProducts, ...priceProducts]).sort((a, b) => a.price - b.price);
}

async function searchProduct(query, config = {}) {
  if (!query) {
    throw new Error("Missing search query.");
  }

  const products = await scanGeneric(config);
  return findCheapestProduct(products, query);
}

async function getCartTotal(config = {}) {
  await handleCookieConsent();

  const candidates = [
    config.cartTotalSelector,
    "[data-testid*='cart' i]",
    "[data-testid*='basket' i]",
    "[class*='cart' i]",
    "[class*='basket' i]",
    "[class*='panier' i]",
    "body"
  ].filter(Boolean);

  for (const selector of candidates) {
    const elements = safeQueryAll(selector);
    for (const element of elements) {
      const text = cleanText(element.textContent);
      if (/total|cart|basket|panier/i.test(text)) {
        const price = extractPrice(text);
        if (price) {
          return price;
        }
      }
    }
  }

  return null;
}

function extractConfiguredProducts(config) {
  if (!config.nameSelector && !config.priceSelector) {
    return [];
  }

  if (config.priceSelector && !config.nameSelector) {
    return safeQueryAll(config.priceSelector)
      .filter(isVisible)
      .map((priceElement) => extractProductNearPrice(priceElement, config))
      .filter(isUsableProduct)
      .sort((a, b) => a.price - b.price);
  }

  const nameElements = safeQueryAll(config.nameSelector).filter(isVisible);
  return nameElements
    .map((nameElement) => {
      const card = findProductContainer(nameElement);
      const priceElement = config.priceSelector ? findNearestMatchingElement(card, config.priceSelector) : null;
      const price = priceElement ? extractPrice(cleanText(priceElement.textContent || priceElement.getAttribute("content"))) : extractPrice(cleanText(card.textContent));
      const name = trimProductName(cleanText(nameElement.textContent || nameElement.getAttribute("content")));

      return createProduct({
        name,
        price,
        priceText: priceElement ? cleanText(priceElement.textContent) : "",
        url: extractProductUrl(card),
        quantity: extractQuantity(card, config)
      });
    })
    .filter(isUsableProduct)
    .sort((a, b) => a.price - b.price);
}

function extractProductsFromCommonCards() {
  const cards = GENERIC_PRODUCT_CARD_SELECTORS.flatMap((selector) => safeQueryAll(selector))
    .filter(isVisible)
    .filter((card) => extractPrice(cleanText(card.textContent)) !== null)
    .filter((card) => cleanText(card.textContent).length < 2500);

  const minimalCards = cards.filter((card, index, allCards) => {
    const hasNestedProduct = allCards.some((candidate) => candidate !== card && card.contains(candidate));
    return !hasNestedProduct && allCards.indexOf(card) === index;
  });

  return minimalCards
    .map((card) => extractProductFromCard(card))
    .filter(isUsableProduct);
}

function extractProductsFromPriceElements() {
  const explicitPriceElements = GENERIC_PRICE_SELECTORS.flatMap((selector) => safeQueryAll(selector));
  const textNodes = findElementsContainingPriceText();

  return [...new Set([...explicitPriceElements, ...textNodes])]
    .filter(isVisible)
    .map((element) => extractProductNearPrice(element))
    .filter(isUsableProduct);
}

function extractProductFromCard(card) {
  const text = cleanText(card.textContent);
  const priceElement = findPriceElement(card);
  const rawPriceText = priceElement ? cleanText(priceElement.textContent || priceElement.getAttribute("content")) : text;
  const price = extractPrice(rawPriceText) ?? extractPrice(text);
  const name = extractProductName(card, text);

  return createProduct({
    name,
    price,
    priceText: priceElement ? cleanText(priceElement.textContent) : "",
    url: extractProductUrl(card),
    quantity: extractQuantity(card)
  });
}

function extractProductNearPrice(priceElement, config = {}) {
  const card = findProductContainer(priceElement);
  const text = cleanText(card.textContent);
  const priceText = cleanText(priceElement.textContent || priceElement.getAttribute("content"));
  const price = extractPrice(priceText) ?? extractPrice(text);

  let name = "";
  if (config.nameSelector) {
    const nameElement = findNearestMatchingElement(card, config.nameSelector);
    name = trimProductName(cleanText(nameElement?.textContent || nameElement?.getAttribute("content")));
  }

  if (!name) {
    name = extractProductName(card, text);
  }

  return createProduct({
    name,
    price,
    priceText,
    url: extractProductUrl(card),
    quantity: extractQuantity(card, config)
  });
}

function createProduct({ name, price, priceText, url, quantity }) {
  return {
    name: trimProductName(name),
    price,
    priceText: priceText && extractPrice(priceText) ? priceText : price ? formatPrice(price) : "",
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    url: url || ""
  };
}

function extractProductName(card, fallbackText) {
  for (const selector of GENERIC_NAME_SELECTORS) {
    const element = card.querySelector(selector);
    const text = cleanText(element?.textContent || element?.getAttribute("content"));
    if (text && !containsOnlyPriceOrAction(text)) {
      return trimProductName(text);
    }
  }

  const lines = cleanText(fallbackText)
    .split(/(?<=[.!?])\s+|\s{2,}/)
    .map(trimProductName)
    .filter((line) => line && !containsOnlyPriceOrAction(line));

  return lines[0] || trimProductName(fallbackText);
}

function extractProductUrl(card) {
  const link = card.closest("a[href]") || card.querySelector("a[href]");
  if (!link) {
    return "";
  }

  try {
    return new URL(link.getAttribute("href"), location.href).href;
  } catch (_error) {
    return "";
  }
}

function extractQuantity(card, config = {}) {
  if (!config.quantitySelector) {
    return 1;
  }

  const element = findNearestMatchingElement(card, config.quantitySelector);
  if (!element) {
    return 1;
  }

  const value = element.value || element.getAttribute("value") || element.textContent;
  const quantity = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function findPriceElement(container) {
  for (const selector of GENERIC_PRICE_SELECTORS) {
    const element = container.querySelector(selector);
    if (element && extractPrice(cleanText(element.textContent || element.getAttribute("content")))) {
      return element;
    }
  }

  return findElementsContainingPriceText(container)[0] || null;
}

function findElementsContainingPriceText(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!isVisible(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      const ownText = [...node.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent)
        .join(" ");
      return hasPriceText(ownText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });

  const elements = [];
  let current = walker.nextNode();
  while (current && elements.length < 300) {
    elements.push(current);
    current = walker.nextNode();
  }
  return elements;
}

function findProductContainer(element) {
  const candidates = [];
  let current = element;

  while (current && current !== document.body) {
    if (isVisible(current)) {
      const text = cleanText(current.textContent);
      const hasPrice = extractPrice(text) !== null;
      const hasName = text.replace(PRICE_TEXT_REGEX, "").trim().length >= 6;
      if (hasPrice && hasName && text.length < 2500) {
        candidates.push(current);
      }
    }
    current = current.parentElement;
  }

  return candidates[0] || element.parentElement || element;
}

function findNearestMatchingElement(container, selector) {
  if (!selector) {
    return null;
  }

  const direct = container.matches?.(selector) ? container : container.querySelector(selector);
  if (direct && isVisible(direct)) {
    return direct;
  }

  return safeQueryAll(selector)
    .filter(isVisible)
    .sort((a, b) => distanceBetween(container, a) - distanceBetween(container, b))[0] || null;
}

function distanceBetween(a, b) {
  const aRect = a.getBoundingClientRect();
  const bRect = b.getBoundingClientRect();
  return Math.abs(aRect.top - bRect.top) + Math.abs(aRect.left - bRect.left);
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
    "button[aria-label*='accepter' i]",
    "button[aria-label*='agree' i]"
  ];

  for (const selector of selectors) {
    const button = safeQueryAll(selector).find((element) => isVisible(element));
    const label = cleanText(button?.textContent || button?.getAttribute("aria-label") || button?.id);
    if (button && /accept|accepter|agree|tout/i.test(label)) {
      button.click();
      await delay(600);
      return;
    }
  }
}

async function revealHiddenPrices(config = {}) {
  const selectors = [
    config.priceRevealSelector,
    config.addToCartSelector,
    ...ACTION_BUTTON_SELECTORS
  ].filter(Boolean);

  const buttons = selectors.flatMap((selector) => safeQueryAll(selector))
    .filter(isVisible)
    .filter((button, index, allButtons) => allButtons.indexOf(button) === index)
    .filter((button) => {
      if (config.priceRevealSelector && button.matches(config.priceRevealSelector)) {
        return true;
      }
      const text = cleanText(button.textContent || button.getAttribute("aria-label") || button.value);
      return /afficher\s+le\s+prix|show\s+price|voir\s+le\s+prix/i.test(text);
    });

  for (const button of buttons.slice(0, 20)) {
    button.click();
    await delay(180);
  }

  if (buttons.length) {
    await delay(900);
  }
}

async function waitForLikelyProducts(config, timeoutMs = 10000) {
  try {
    await waitFor(() => {
      if (config.priceSelector && safeQueryAll(config.priceSelector).length > 0) {
        return true;
      }
      if (config.nameSelector && safeQueryAll(config.nameSelector).length > 0) {
        return true;
      }
      return extractPrice(cleanText(document.body?.textContent)) !== null;
    }, timeoutMs);
  } catch (_error) {
    return false;
  }
  return true;
}

async function waitForPageReady(timeoutMs = 15000) {
  if (document.readyState === "complete") {
    await delay(500);
    return;
  }

  await waitFor(() => document.readyState === "complete", timeoutMs);
  await delay(500);
}

async function waitFor(condition, timeoutMs = 10000, intervalMs = 250) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (condition()) {
      return true;
    }
    await delay(intervalMs);
  }

  throw new Error("Timed out waiting for page products.");
}

function extractPrice(text) {
  if (!text) {
    return null;
  }

  PRICE_TEXT_REGEX.lastIndex = 0;
  const matches = [...String(text).matchAll(PRICE_TEXT_REGEX)]
    .map((match) => parseLocalizedPrice(match[0]))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!matches.length) {
    return null;
  }

  return Math.min(...matches);
}

function parseLocalizedPrice(value) {
  const numeric = String(value)
    .replace(/[€$£]/g, "")
    .replace(/\s/g, "")
    .trim();

  const lastComma = numeric.lastIndexOf(",");
  const lastDot = numeric.lastIndexOf(".");
  const decimalSeparator = lastComma > lastDot ? "," : ".";
  let normalized = numeric;

  if (lastComma !== -1 || lastDot !== -1) {
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = normalized.replace(new RegExp(`\\${thousandsSeparator}`, "g"), "");
    normalized = normalized.replace(decimalSeparator, ".");
  }

  return Number.parseFloat(normalized);
}

function formatPrice(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: detectCurrency()
  }).format(value);
}

function detectCurrency() {
  const text = cleanText(document.body?.textContent).slice(0, 20000);
  if (text.includes("$")) {
    return "USD";
  }
  if (text.includes("£")) {
    return "GBP";
  }
  return "EUR";
}

function trimProductName(text) {
  PRICE_TEXT_REGEX.lastIndex = 0;
  return cleanText(text)
    .replace(PRICE_TEXT_REGEX, "")
    .replace(/(add to cart|ajouter|afficher le prix|show price|voir le produit|au panier|buy now).*/gi, "")
    .slice(0, 180)
    .trim();
}

function containsOnlyPriceOrAction(text) {
  const cleaned = cleanText(text);
  PRICE_TEXT_REGEX.lastIndex = 0;
  const withoutPrices = cleaned.replace(PRICE_TEXT_REGEX, "").trim();
  return !cleaned || !withoutPrices || /^(?:add to cart|ajouter|afficher le prix|show price|au panier|buy now)$/i.test(cleaned);
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

  for (const product of products.filter(isUsableProduct)) {
    const key = `${product.name.toLowerCase()}|${product.price}|${product.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(product);
    }
  }

  return unique;
}

function isUsableProduct(product) {
  return Boolean(product?.name) && Number.isFinite(product.price);
}

function hasPriceText(text) {
  PRICE_TEXT_REGEX.lastIndex = 0;
  return PRICE_TEXT_REGEX.test(text);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeQueryAll(selector) {
  if (!selector) {
    return [];
  }

  try {
    return [...document.querySelectorAll(selector)];
  } catch (_error) {
    return [];
  }
}

function normalizeConfig(config = {}) {
  return {
    searchUrl: cleanText(config.searchUrl),
    nameSelector: cleanText(config.nameSelector),
    priceSelector: cleanText(config.priceSelector),
    addToCartSelector: cleanText(config.addToCartSelector),
    quantitySelector: cleanText(config.quantitySelector),
    priceRevealSelector: cleanText(config.priceRevealSelector),
    cartTotalSelector: cleanText(config.cartTotalSelector)
  };
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
