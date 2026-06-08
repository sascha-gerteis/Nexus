const NexusUI = (() => {
  const SUPPORTED_LANGUAGES = ["en", "th", "zh", "es", "hi", "ar", "fr"];
  const RTL_LANGUAGES = ["ar"];
  const LANGUAGE_OPTIONS = [
    { code: "en", label: "English" },
    { code: "th", label: "ไทย" },
    { code: "zh", label: "中文" },
    { code: "es", label: "Español" },
    { code: "hi", label: "हिन्दी" },
    { code: "ar", label: "العربية" },
    { code: "fr", label: "Français" }
  ];
  const SUPPORTED_CURRENCIES = ["THB", "USD", "EUR", "GBP", "JPY"];
  const CURRENCY_OPTIONS = [
    { code: "THB", label: "THB" },
    { code: "USD", label: "USD" },
    { code: "EUR", label: "EUR" },
    { code: "GBP", label: "GBP" },
    { code: "JPY", label: "JPY" }
  ];
  const FX_FALLBACK_RATES = {
    USD: 1,
    THB: 36,
    EUR: 0.92,
    GBP: 0.78,
    JPY: 157
  };
  const autoTranslatedTextNodes = new WeakMap();
  const autoTranslatedElements = new WeakMap();
  const autoTranslatedAttributes = new WeakMap();
const FX_CACHE_KEY = "nexus_fx_rates_cache";
const FX_CACHE_TTL_MS = 15 * 60 * 1000;

  function q(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function slugify(text) {
    return String(text || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function toast(message) {
    let el = document.getElementById("toast");

    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.classList.add("show");

    setTimeout(() => {
      el.classList.remove("show");
    }, 2800);
  }

  function getCurrency() {
    const stored = String(localStorage.getItem("nexus_currency") || "THB").toUpperCase();
    return SUPPORTED_CURRENCIES.includes(stored) ? stored : "THB";
  }

 function setCurrency(currency) {
  const requested = String(currency || "THB").toUpperCase();
  const normalized = SUPPORTED_CURRENCIES.includes(requested) ? requested : "THB";

  localStorage.setItem("nexus_currency", normalized);

  document.querySelectorAll(".currency-select").forEach((select) => {
    select.value = normalized;
  });

  if (typeof mountGlobalNav === "function") {
    mountGlobalNav({ force: true });
  }

  document.dispatchEvent(new CustomEvent("currencychange"));
}

  function currencySwitch() {
    const currency = getCurrency();

    return `
      <label class="currency-select-wrap" aria-label="${escapeAttribute(t("nav_currency"))}">
        <select class="currency-select" onchange="NexusUI.setCurrency(this.value)">
          ${CURRENCY_OPTIONS.map((item) => `
            <option value="${item.code}" ${currency === item.code ? "selected" : ""}>${item.label}</option>
          `).join("")}
        </select>
      </label>
    `;
  }

function getCachedFxRates() {
  try {
    const cached = localStorage.getItem(FX_CACHE_KEY);

    if (!cached) return { ...FX_FALLBACK_RATES };

    const parsed = JSON.parse(cached);

    if (
      parsed &&
      parsed.rates &&
      parsed.created_at &&
      Date.now() - parsed.created_at < FX_CACHE_TTL_MS
    ) {
      return {
        ...FX_FALLBACK_RATES,
        ...parsed.rates
      };
    }

    if (parsed?.rate) {
      return {
        ...FX_FALLBACK_RATES,
        THB: Number(parsed.rate) || FX_FALLBACK_RATES.THB
      };
    }

    return { ...FX_FALLBACK_RATES };
  } catch {
    return { ...FX_FALLBACK_RATES };
  }
}

async function refreshUsdToThbRate() {
  try {
    const cached = localStorage.getItem(FX_CACHE_KEY);
    const parsed = cached ? JSON.parse(cached) : null;

    if (
      parsed?.rates?.THB &&
      parsed.created_at &&
      Date.now() - parsed.created_at < FX_CACHE_TTL_MS
    ) {
      return parsed.rates.THB;
    }
  } catch {
    // Keep using the local fallback if cache is unreadable.
  }

  return getCachedFxRates().THB;
}

function getProductBaseAmount(product) {
  const pricingType = String(product?.pricing_type || "").toLowerCase();
  const productCurrency = String(product?.currency || "USD").toUpperCase();

  const isSetupFee = pricingType === "setup_fee";

  const usdValue = isSetupFee
    ? Number(product?.setup_fee_usd || 0)
    : Number(product?.price_usd || 0);

  const thbValue = isSetupFee
    ? Number(product?.setup_fee_thb || 0)
    : Number(product?.price_thb || 0);

  const genericValue = isSetupFee
    ? Number(product?.setup_fee || 0)
    : Number(product?.price || 0);

  if (usdValue > 0) {
    return {
      amount: usdValue,
      currency: "USD"
    };
  }

  if (thbValue > 0) {
    return {
      amount: thbValue,
      currency: "THB"
    };
  }

  if (genericValue > 0) {
    return {
      amount: genericValue,
      currency: SUPPORTED_CURRENCIES.includes(productCurrency) ? productCurrency : "USD"
    };
  }

  return {
    amount: 0,
    currency: "USD"
  };
}

function convertAmount(amount, fromCurrency, toCurrency) {
  const from = String(fromCurrency || "USD").toUpperCase();
  const to = String(toCurrency || "USD").toUpperCase();
  const rates = getCachedFxRates();

  if (!amount || amount <= 0) return 0;

  if (from === to) return Number(amount);

  const fromRate = rates[from] || 1;
  const toRate = rates[to] || 1;
  const converted = (Number(amount) / fromRate) * toRate;

  if (to === "THB" || to === "JPY") return Math.round(converted);
  return Math.round(converted * 100) / 100;
}

function formatMoney(amount, currency) {
  const selectedCurrency = String(currency || getCurrency() || "USD").toUpperCase();

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: SUPPORTED_CURRENCIES.includes(selectedCurrency) ? selectedCurrency : "USD",
    minimumFractionDigits: selectedCurrency === "THB" || selectedCurrency === "JPY" ? 0 : undefined,
    maximumFractionDigits: selectedCurrency === "THB" || selectedCurrency === "JPY" ? 0 : 2
  }).format(Number(amount || 0));
}

function priceAmount(product) {
  if (!product) return 0;

  const displayCurrency = getCurrency();
  const base = getProductBaseAmount(product);

  return convertAmount(base.amount, base.currency, displayCurrency);
}

function money(product) {
  if (!product || product.pricing_type === "custom_quote") {
    return "Custom quote";
  }

  if (product.pricing_type === "free_demo") {
    return "Free demo";
  }

  const displayCurrency = getCurrency();
  const amount = priceAmount(product);

  if (!amount || amount <= 0) {
    return "Contact for price";
  }

  const amountText = formatMoney(amount, displayCurrency);

  if (product.pricing_type === "monthly") {
    return `${amountText}/mo`;
  }

  if (product.pricing_type === "one_time") {
    return `${amountText} once`;
  }

  if (product.pricing_type === "setup_fee") {
    return `${amountText} setup`;
  }

  return amountText;
}
  function colorClass(color) {
  const safeColor = String(color || "blue").toLowerCase();

  const allowed = [
    "blue",
    "cyan",
    "teal",
    "green",
    "lime",
    "yellow",
    "orange",
    "red",
    "pink",
    "rose",
    "purple",
    "violet",
    "indigo",
    "slate",
    "dark"
  ];

  return allowed.includes(safeColor) ? safeColor : "blue";
}

function productColorTheme(color) {
  const safeColor = colorClass(color);

  const themes = {
    blue: {
      glow: "rgba(37, 99, 235, 0.14)",
      iconBg: "#eff6ff",
      iconColor: "#2563eb",
      iconBorder: "#bfdbfe"
    },
    cyan: {
      glow: "rgba(8, 145, 178, 0.14)",
      iconBg: "#ecfeff",
      iconColor: "#0891b2",
      iconBorder: "#a5f3fc"
    },
    teal: {
      glow: "rgba(15, 118, 110, 0.14)",
      iconBg: "#f0fdfa",
      iconColor: "#0f766e",
      iconBorder: "#99f6e4"
    },
    green: {
      glow: "rgba(22, 163, 74, 0.14)",
      iconBg: "#f0fdf4",
      iconColor: "#16a34a",
      iconBorder: "#bbf7d0"
    },
    lime: {
      glow: "rgba(101, 163, 13, 0.15)",
      iconBg: "#f7fee7",
      iconColor: "#65a30d",
      iconBorder: "#d9f99d"
    },
    yellow: {
      glow: "rgba(202, 138, 4, 0.16)",
      iconBg: "#fefce8",
      iconColor: "#ca8a04",
      iconBorder: "#fef08a"
    },
    orange: {
      glow: "rgba(234, 88, 12, 0.16)",
      iconBg: "#fff7ed",
      iconColor: "#ea580c",
      iconBorder: "#fed7aa"
    },
    red: {
      glow: "rgba(220, 38, 38, 0.14)",
      iconBg: "#fef2f2",
      iconColor: "#dc2626",
      iconBorder: "#fecaca"
    },
    pink: {
      glow: "rgba(219, 39, 119, 0.14)",
      iconBg: "#fdf2f8",
      iconColor: "#db2777",
      iconBorder: "#fbcfe8"
    },
    rose: {
      glow: "rgba(225, 29, 72, 0.14)",
      iconBg: "#fff1f2",
      iconColor: "#e11d48",
      iconBorder: "#fecdd3"
    },
    purple: {
      glow: "rgba(147, 51, 234, 0.14)",
      iconBg: "#faf5ff",
      iconColor: "#9333ea",
      iconBorder: "#e9d5ff"
    },
    violet: {
      glow: "rgba(124, 58, 237, 0.14)",
      iconBg: "#f5f3ff",
      iconColor: "#7c3aed",
      iconBorder: "#ddd6fe"
    },
    indigo: {
      glow: "rgba(79, 70, 229, 0.14)",
      iconBg: "#eef2ff",
      iconColor: "#4f46e5",
      iconBorder: "#c7d2fe"
    },
    slate: {
      glow: "rgba(71, 85, 105, 0.14)",
      iconBg: "#f8fafc",
      iconColor: "#475569",
      iconBorder: "#cbd5e1"
    },
    dark: {
      glow: "rgba(15, 23, 42, 0.16)",
      iconBg: "#0f172a",
      iconColor: "#ffffff",
      iconBorder: "#1e293b"
    }
  };

  const theme = themes[safeColor] || themes.blue;

  return `
    --product-card-glow:${theme.glow};
    --product-icon-bg:${theme.iconBg};
    --product-icon-color:${theme.iconColor};
    --product-icon-border:${theme.iconBorder};
  `;
}

  function pillClass(color) {
  const safeColor = String(color || "blue").toLowerCase();

  const allowed = [
    "blue",
    "cyan",
    "teal",
    "green",
    "lime",
    "yellow",
    "orange",
    "red",
    "pink",
    "rose",
    "purple",
    "violet",
    "indigo",
    "slate",
    "dark"
  ];

  return `pill ${allowed.includes(safeColor) ? safeColor : "blue"}`;
}

  function arrayList(value) {
    if (!value) return [];

    if (Array.isArray(value)) return value;

    if (typeof value === "string") {
      return value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (match) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[match];
    });
  }

  function escapeAttribute(str) {
    return String(str || "").replace(/[&<>"']/g, (match) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[match];
    });
  }

  function safeBase64Decode(value) {
    if (!value) return "";

    try {
      let raw = String(value).trim();

      raw = raw
        .replace("data:text/html;base64,", "")
        .replace("data:application/xhtml+xml;base64,", "")
        .replace(/\s/g, "");

      const decoded = atob(raw);

      try {
        return decodeURIComponent(
          decoded
            .split("")
            .map((char) => {
              return "%" + ("00" + char.charCodeAt(0).toString(16)).slice(-2);
            })
            .join("")
        );
      } catch (unicodeError) {
        return decoded;
      }
    } catch (error) {
      return "";
    }
  }

  function looksLikeHtml(value) {
    const text = String(value || "").trim().toLowerCase();

    return (
      text.startsWith("<!doctype html") ||
      text.startsWith("<html") ||
      text.startsWith("<body") ||
      text.startsWith("<div") ||
      text.startsWith("<section") ||
      text.startsWith("<main") ||
      text.includes("<html") ||
      text.includes("<body") ||
      text.includes("<div") ||
      text.includes("<style")
    );
  }

  function normalizeHtmlSource(value) {
    if (!value) return "";

    const raw = String(value).trim();

    if (looksLikeHtml(raw)) {
      return raw;
    }

    if (
      raw.startsWith("data:text/html;base64,") ||
      raw.startsWith("data:application/xhtml+xml;base64,")
    ) {
      return safeBase64Decode(raw);
    }

    const decoded = safeBase64Decode(raw);

    if (looksLikeHtml(decoded)) {
      return decoded;
    }

    return "";
  }

  function normalizeImageSource(value) {
    if (!value) return "";

    let source = String(value).trim();

    if (!source) return "";

    source = source.replace(/\s/g, "");

    if (source.startsWith("data:image/")) {
      return source;
    }

    if (
      source.startsWith("http://") ||
      source.startsWith("https://") ||
      source.startsWith("/") ||
      source.startsWith("./") ||
      source.startsWith("../")
    ) {
      return source;
    }

    if (source.startsWith("/9j/")) {
      return `data:image/jpeg;base64,${source}`;
    }

    if (source.startsWith("iVBOR")) {
      return `data:image/png;base64,${source}`;
    }

    if (source.startsWith("R0lGOD")) {
      return `data:image/gif;base64,${source}`;
    }

    if (source.startsWith("UklGR")) {
      return `data:image/webp;base64,${source}`;
    }

    if (source.startsWith("PHN2Zy")) {
      return `data:image/svg+xml;base64,${source}`;
    }

    return source;
  }

  function prepareResponsiveHtml(htmlSource) {
    const source = String(htmlSource || "").trim();

    if (!source) return "";

    const responsiveStyle = `
      <style>
        html,
        body {
          width: 100% !important;
          max-width: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow-x: hidden !important;
          box-sizing: border-box !important;
          background: #ffffff;
        }

        *,
        *::before,
        *::after {
          box-sizing: border-box !important;
          max-width: 100% !important;
        }

        img,
        video,
        canvas,
        svg {
          max-width: 100% !important;
          height: auto !important;
        }

        table {
          max-width: 100% !important;
          width: 100% !important;
        }

        iframe {
          max-width: 100% !important;
        }

        [style*="width"] {
          max-width: 100% !important;
        }

        @media (max-width: 900px) {
          body {
            font-size: 14px !important;
          }
        }

        @media (max-width: 640px) {
          body {
            font-size: 13px !important;
          }
        }
      </style>
    `;

    if (source.toLowerCase().includes("</head>")) {
      return source.replace("</head>", `${responsiveStyle}</head>`);
    }

    return `
      <!doctype html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          ${responsiveStyle}
        </head>
        <body>
          ${source}
        </body>
      </html>
    `;
  }

  function productCard(product, options = {}) {
    const cardOptions = options && typeof options === "object" && !Array.isArray(options) ? options : {};
    const developer = product.developers || {};
    const slug = encodeURIComponent(product.slug || "");
    const rawSlug = String(product.slug || "");
    const isCustomRequest =
      Boolean(product.is_demo) ||
      product.listing_type === "custom_request" ||
      product.pricing_type === "custom_quote";
    const showCompare = Boolean(cardOptions.showCompare);
    const compareSelected = Boolean(cardOptions.compareSelected);
    const ctaHref = isCustomRequest
      ? `/pages/custom-request/index.html?slug=${slug}`
      : `/pages/checkout/index.html?slug=${slug}&step=setup`;
    const ctaLabel = isCustomRequest ? t("common_request_custom_automation") : t("common_buy");

    return `
      <article class="product-card color-${colorClass(product.color)}">
        <div class="product-top">
          <div class="product-icon ${colorClass(product.color)}">
            ${escapeHtml(product.icon || "AI")}
          </div>

          <span class="${pillClass(product.color)}">
            ${escapeHtml(l(localizeRecord(product, "badge", localizeRecord(product, "category", "Automation"))))}
          </span>
        </div>

        <h3>${escapeHtml(l(localizeRecord(product, "title")))}</h3>

        <p>${escapeHtml(l(localizeRecord(product, "short_description")))}</p>

        <div
          class="developer-mini"
          onclick="event.stopPropagation(); location.href='/pages/developers/profile.html?id=${developer.id || ""}'"
          style="cursor:pointer"
        >
          <div class="avatar">
            ${escapeHtml(developer.avatar_letter || "N")}
          </div>

          <div>
            <strong>${escapeHtml(developer.display_name || "Nexus Internal")}</strong>
            <span>${escapeHtml(l(localizeRecord(developer, "type", "Verified Operator")))} &middot; &#9733; ${escapeHtml(l(developer.rating || "New"))}</span>
          </div>
        </div>

        <div class="tags">
          <span class="tag">${escapeHtml(l(localizeRecord(product, "category", "Automation")))}</span>
          <span class="tag">${escapeHtml(l(localizeRecord(product, "delivery_time", "Custom")))}</span>
          <span class="tag">&#9733; ${escapeHtml(l(product.rating || "New"))} (${escapeHtml(product.review_count || 0)})</span>
        </div>

        ${showCompare ? `
          <button
            type="button"
            class="compare-toggle ${compareSelected ? "active" : ""}"
            aria-pressed="${compareSelected ? "true" : "false"}"
            onclick="event.stopPropagation(); NexusApp.toggleCompare('${escapeAttribute(rawSlug)}')"
          >
            <span>${compareSelected ? "Selected" : "Compare"}</span>
          </button>
        ` : ""}

        <div class="meta-grid">
          <div class="meta">
            <span>${escapeHtml(l("Price"))}</span>
            <strong>${money(product)}</strong>
          </div>

          <div class="meta">
            <span>${escapeHtml(l("Setup"))}</span>
            <strong>${escapeHtml(l(localizeRecord(product, "setup_type", "Self-serve or guided")))}</strong>
          </div>
        </div>

        <div class="card-actions">
          <button
            type="button"
            class="btn btn-secondary btn-small"
            onclick="event.stopPropagation(); NexusApp.openProduct('${escapeAttribute(product.slug || "")}')"
          >
            ${t("common_preview")}</button>

          <a
            class="btn btn-primary btn-small"
            href="${ctaHref}"
            onclick="event.stopPropagation();"
          >
            ${ctaLabel}
          </a>
        </div>
      </article>
    `;
  }

  function infoBlock(title, items) {
    const list = arrayList(items).filter(Boolean);

    if (!list.length) return "";

    return `
      <div class="info-block">
        <h4>${escapeHtml(l(title))}</h4>

        <ul class="clean">
          ${list.map((item) => `<li>${escapeHtml(l(item))}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  function renderHtmlPreview(title, description, htmlSource) {
    const responsiveHtml = prepareResponsiveHtml(htmlSource);

    if (!responsiveHtml) {
      return `
        <div class="custom-preview">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>

          <div class="preview-image-error">
            <strong>No HTML preview added.</strong>
            <p>
              Paste raw HTML, or paste base64 HTML such as
              <code>data:text/html;base64,...</code>.
            </p>
          </div>
        </div>
      `;
    }

    return `
      <div class="custom-preview html-preview-wrap">
        <div class="html-preview-header">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description)}</p>
          </div>

          <span>Live HTML preview</span>
        </div>

        <div class="html-preview-device">
          <iframe
            class="html-preview-frame"
            sandbox=""
            srcdoc="${escapeAttribute(responsiveHtml)}"
            title="${escapeAttribute(title)}"
          ></iframe>
        </div>
      </div>
    `;
  }

  function renderImagePreview(title, description, source) {
    const imageSource = normalizeImageSource(source);

    return `
      <div class="custom-preview">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>

        ${
          imageSource
            ? `
              <img
                class="image-preview"
                src="${escapeAttribute(imageSource)}"
                alt="${escapeAttribute(title)}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
              >

              <div class="preview-image-error" style="display:none;">
                <strong>Preview image could not load.</strong>
                <p>
                  Use a public image URL, or paste base64 starting with
                  <code>data:image/png;base64,</code>.
                </p>
              </div>
            `
            : `
              <div class="preview-image-error">
                <strong>No preview image added.</strong>
                <p>Add a screenshot URL or base64 image in the product editor.</p>
              </div>
            `
        }
      </div>
    `;
  }

  function renderPreview(product, customization) {
    const customizationIndex = Array.isArray(product.customizations)
      ? product.customizations.indexOf(customization)
      : -1;
    const localizedCustomization = customization
      ? localizeCustomization(product, customization, Math.max(customizationIndex, 0))
      : null;
    const mode =
      customization?.preview_mode ||
      product.preview_mode ||
      product.preview_type ||
      "template";

    const code = customization?.preview_code || product.preview_code || "";
    const image = customization?.preview_image_url || product.preview_image_url || "";
    const base64 = customization?.preview_base64 || product.preview_base64 || "";

    const title =
      localizedCustomization?.name ||
      product.preview_title ||
      localizeRecord(product, "title") ||
      "Automation preview";

    const description =
      localizedCustomization?.description ||
      product.preview_description ||
      localizeRecord(product, "short_description") ||
      "";

    const normalizedMode = String(mode || "").toLowerCase();

    const htmlFromCode = normalizeHtmlSource(code);
    const htmlFromBase64 = normalizeHtmlSource(base64);
    const htmlFromImageField = normalizeHtmlSource(image);
    const finalHtmlSource = htmlFromCode || htmlFromBase64 || htmlFromImageField;

    if (
      normalizedMode === "html" ||
      normalizedMode === "html_base64" ||
      normalizedMode === "html-base64" ||
      normalizedMode === "website" ||
      normalizedMode === "iframe"
    ) {
      return renderHtmlPreview(title, description, finalHtmlSource || code || base64);
    }

    if (normalizedMode === "code") {
      if (looksLikeHtml(code)) {
        return renderHtmlPreview(title, description, code);
      }

      return `
        <div class="custom-preview">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>

          <pre class="code-preview">${escapeHtml(code || "// Add preview code in admin product editor.")}</pre>
        </div>
      `;
    }

    if (normalizedMode === "image" || normalizedMode === "screenshot") {
      return renderImagePreview(title, description, image || base64);
    }

    if (normalizedMode === "base64") {
      if (finalHtmlSource) {
        return renderHtmlPreview(title, description, finalHtmlSource);
      }

      return renderImagePreview(title, description, base64 || image);
    }

    if (product.preview_type === "listening") {
      return `
        <div class="preview-kpis">
          <div class="preview-kpi">
            <span>Mentions</span>
            <strong>1,284</strong>
          </div>

          <div class="preview-kpi">
            <span>Sentiment</span>
            <strong>+8%</strong>
          </div>

          <div class="preview-kpi">
            <span>Risk</span>
            <strong>Queue time</strong>
          </div>
        </div>

        <div class="preview-row">
          <strong>Top positive theme</strong>
          <span>Family experience</span>
        </div>

        <div class="preview-row">
          <strong>Top complaint</strong>
          <span>Waiting time</span>
        </div>

        <div class="preview-row">
          <strong>Recommended action</strong>
          <span>Reply to queue complaints</span>
        </div>
      `;
    }

    if (product.preview_type === "reports") {
      return `
        <div class="preview-kpis">
          <div class="preview-kpi">
            <span>Reach</span>
            <strong>+14%</strong>
          </div>

          <div class="preview-kpi">
            <span>Best content</span>
            <strong>Short video</strong>
          </div>

          <div class="preview-kpi">
            <span>Weak point</span>
            <strong>CTA clicks</strong>
          </div>
        </div>

        <div class="preview-row">
          <strong>What worked</strong>
          <span>Behind-the-scenes clips</span>
        </div>

        <div class="preview-row">
          <strong>Next action</strong>
          <span>Test stronger CTA</span>
        </div>
      `;
    }

    if (product.preview_type === "chatbot") {
      return `
        <div class="info-block">
          <h4>AI Chatbot Preview</h4>

          <p><strong>Customer:</strong> What time are you open?</p>
          <p><strong>Bot:</strong> We are open daily. Would you like ticket information, directions, or current promotions?</p>
        </div>

        <div class="preview-row">
          <strong>Captured intent</strong>
          <span>Booking question</span>
        </div>

        <div class="preview-row">
          <strong>Escalation</strong>
          <span>Available</span>
        </div>
      `;
    }

    if (finalHtmlSource) {
      return renderHtmlPreview(title, description, finalHtmlSource);
    }

    if (base64 || image) {
      return renderImagePreview(title, description, base64 || image);
    }

    return `
      <div class="preview-row">
        <strong>Current process</strong>
        <span>Manual workflow</span>
      </div>

      <div class="preview-row">
        <strong>Recommended path</strong>
        <span>Nexus scoping + setup</span>
      </div>
    `;
  }

  function renderCustomizations(product, target = "modal") {
    const customizations = product.customizations || [];

    if (!Array.isArray(customizations) || !customizations.length) {
      return "";
    }

    return `
      <div class="info-block">
        <h4>Customization options</h4>

        <div class="customization-grid">
          ${customizations
            .map((customization, index) => {
              const localizedCustomization = localizeCustomization(product, customization, index);
              return `
                <div
                  class="customization-card"
                  onclick="NexusApp.selectCustomization(${index}, '${escapeAttribute(target)}')"
                >
                  <strong>${escapeHtml(localizedCustomization.name || "Option")}</strong>
                  <p>${escapeHtml(localizedCustomization.description || "")}</p>
                  <span class="tag">${escapeHtml(localizedCustomization.price_note || "")}</span>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  function reviewsBlock(reviews) {
    const approved = (reviews || []).filter((review) => {
      return review.status === "approved";
    });

    if (!approved.length) return "";

    return `
      <div class="info-block">
        <h4>Reviews</h4>

        ${approved
          .map((review) => {
            return `
              <p>
                <strong>${ratingStars(review.rating)} ${escapeHtml(review.rating)}/5 - ${escapeHtml(review.reviewer_name)}</strong><br>
                ${escapeHtml(review.review_text)}
              </p>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function openModal(side, main) {
    const modal = document.getElementById("productModal");

    if (!modal) return;

    const modalSide = document.getElementById("modalSide");
    const modalMain = document.getElementById("modalMain");

    if (!modalSide || !modalMain) return;

    modalSide.innerHTML = side;
    modalMain.innerHTML = main;
    applyTranslations(modal);

    modal.classList.add("open");
  }

  function closeModal() {
    const modal = document.getElementById("productModal");

    if (modal) {
      modal.classList.remove("open");
    }
  }

  function wireModal() {
    const modal = document.getElementById("productModal");

    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target.id === "productModal") {
          closeModal();
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModal();
      }
    });
  }

  function ratingStars(rating) {
  const value = Math.max(0, Math.min(5, Number(rating || 0)));
  const full = Math.round(value);
  return "\u2605".repeat(full) + "\u2606".repeat(5 - full);
}

function reviewStats(reviews) {
  const approved = (reviews || []).filter((review) => review.status === "approved");

  if (!approved.length) {
    return {
      count: 0,
      average: 0,
      label: "No reviews yet"
    };
  }

  const total = approved.reduce((sum, review) => {
    return sum + Number(review.rating || 0);
  }, 0);

  const average = total / approved.length;

  return {
    count: approved.length,
    average,
    label: `${average.toFixed(1)} average from ${approved.length} review${approved.length === 1 ? "" : "s"}`
  };
}

function publicReviewsBlock(title, reviews) {
  const approved = (reviews || []).filter((review) => review.status === "approved");

  if (!approved.length) {
    return "";
  }

  const stats = reviewStats(approved);

  return `
    <div class="reviews-section">
      <div class="reviews-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(stats.label)}</p>
        </div>

        <div class="reviews-score">
          <strong>${Number(stats.average).toFixed(1)}</strong>
          <span>${ratingStars(stats.average)}</span>
        </div>
      </div>

      <div class="reviews-list">
        ${approved
          .map((review) => {
            const meta = [
              review.reviewer_role,
              review.reviewer_company,
              review.verified_purchase ? "Verified purchase" : ""
            ].filter(Boolean).join(" | ");

            return `
              <article class="review-card">
                <div class="review-card-top">
                  <div>
                    <strong>${escapeHtml(review.reviewer_name || "Anonymous")}</strong>
                    ${meta ? `<span>${escapeHtml(meta)}</span>` : ""}
                  </div>

                  <div class="review-stars">
                    ${ratingStars(review.rating)}
                  </div>
                </div>

                <p>${escapeHtml(review.review_text || "")}</p>
              </article>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}


/* =========================================================
   LANGUAGE + GLOBAL NAV
   ========================================================= */

const I18N = {
  en: {
    nav_home: "Home",
    nav_marketplace: "Marketplace",
    nav_developers: "Developers",
    nav_about: "About",
    nav_contact: "Contact",
    nav_dashboard: "Dashboard",
    nav_admin: "Admin",
    nav_login: "Login",
    nav_logout: "Logout",
    nav_currency: "Currency",
    nav_language: "Language",

    common_browse_automations: "Browse automations",
    common_get_support: "Get support",
    common_buy: "Buy",
    common_preview: "Preview",
    common_view: "View",
    common_view_setup: "View setup",
    common_view_output: "View output",
    common_complete_setup: "Complete setup",

    dashboard_buyer_title: "Your automation dashboard.",
    dashboard_buyer_subtitle:
      "Track your automations, view outputs, complete setup, and monitor important activity from one clean dashboard.",
    dashboard_overview: "Overview",
    dashboard_automations: "My Automations",
    dashboard_outputs: "Outputs",
    dashboard_activity: "Activity",
    dashboard_orders: "Orders"
  },

  th: {
    nav_home: "à¸«à¸™à¹‰à¸²à¹à¸£à¸",
    nav_marketplace: "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
    nav_developers: "à¸ªà¸³à¸«à¸£à¸±à¸šà¸™à¸±à¸à¸žà¸±à¸’à¸™à¸²",
    nav_about: "à¹€à¸à¸µà¹ˆà¸¢à¸§à¸à¸±à¸šà¹€à¸£à¸²",
    nav_contact: "à¸•à¸´à¸”à¸•à¹ˆà¸­",
    nav_dashboard: "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”",
    nav_admin: "à¹à¸­à¸”à¸¡à¸´à¸™",
    nav_login: "à¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆà¸£à¸°à¸šà¸š",
    nav_logout: "à¸­à¸­à¸à¸ˆà¸²à¸à¸£à¸°à¸šà¸š",
    nav_currency: "à¸ªà¸à¸¸à¸¥à¹€à¸‡à¸´à¸™",
    nav_language: "à¸ à¸²à¸©à¸²",

    common_browse_automations: "à¸”à¸¹à¸£à¸°à¸šà¸šà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´",
    common_get_support: "à¸•à¸´à¸”à¸•à¹ˆà¸­à¸—à¸µà¸¡à¸‹à¸±à¸žà¸žà¸­à¸£à¹Œà¸•",
    common_buy: "à¸‹à¸·à¹‰à¸­",
    common_preview: "à¸”à¸¹à¸•à¸±à¸§à¸­à¸¢à¹ˆà¸²à¸‡",
    common_view: "à¸”à¸¹",
    common_view_setup: "à¸”à¸¹à¸à¸²à¸£à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸²",
    common_view_output: "à¸”à¸¹à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ",
    common_complete_setup: "à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸²à¹ƒà¸«à¹‰à¹€à¸ªà¸£à¹‡à¸ˆ",

    dashboard_buyer_title: "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¸£à¸°à¸šà¸šà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´à¸‚à¸­à¸‡à¸„à¸¸à¸“",
    dashboard_buyer_subtitle:
      "à¸•à¸´à¸”à¸•à¸²à¸¡à¸£à¸°à¸šà¸šà¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´ à¸”à¸¹à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸² à¹à¸¥à¸°à¸•à¸£à¸§à¸ˆà¸ªà¸­à¸šà¸à¸´à¸ˆà¸à¸£à¸£à¸¡à¸ªà¸³à¸„à¸±à¸à¹„à¸”à¹‰à¹ƒà¸™à¸—à¸µà¹ˆà¹€à¸”à¸µà¸¢à¸§",
    dashboard_overview: "à¸ à¸²à¸žà¸£à¸§à¸¡",
    dashboard_automations: "à¸£à¸°à¸šà¸šà¸‚à¸­à¸‡à¸‰à¸±à¸™",
    dashboard_outputs: "à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ",
    dashboard_activity: "à¸à¸´à¸ˆà¸à¸£à¸£à¸¡",
    dashboard_orders: "à¸„à¸³à¸ªà¸±à¹ˆà¸‡à¸‹à¸·à¹‰à¸­"
  }
};

let languageNavigationGuardStarted = false;
let mobileNavDismissGuardStarted = false;
let lastLocalizedLinkLanguage = "";
let translationObserver = null;
let isApplyingTranslations = false;
const originalTextNodes = new WeakMap();
const originalAttributeValues = new WeakMap();

Object.assign(I18N.en, {
  nav_browse_developers: "Browse developers",
  nav_join_waitlist: "Join waitlist",
  nav_toggle: "Toggle navigation",
  common_explore_marketplace: "Explore marketplace",
  common_request_custom_automation: "Request custom automation",
  common_join_developer_waitlist: "Join developer waitlist",
  common_message_developer: "Message developer",
  common_message_nexus: "Message Nexus",
  dashboard_messages: "Messages"
});

Object.assign(I18N.th, {
  nav_home: "à¸«à¸™à¹‰à¸²à¹à¸£à¸",
  nav_marketplace: "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  nav_developers: "à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  nav_browse_developers: "à¸”à¸¹à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  nav_join_waitlist: "à¹€à¸‚à¹‰à¸²à¸£à¹ˆà¸§à¸¡à¹€à¸§à¸•à¸¥à¸´à¸ªà¸•à¹Œ",
  nav_about: "à¹€à¸à¸µà¹ˆà¸¢à¸§à¸à¸±à¸šà¹€à¸£à¸²",
  nav_contact: "à¸•à¸´à¸”à¸•à¹ˆà¸­",
  nav_dashboard: "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”",
  nav_admin: "à¹à¸­à¸”à¸¡à¸´à¸™",
  nav_login: "à¸¥à¹‡à¸­à¸à¸­à¸´à¸™",
  nav_logout: "à¸­à¸­à¸à¸ˆà¸²à¸à¸£à¸°à¸šà¸š",
  nav_currency: "à¸ªà¸à¸¸à¸¥à¹€à¸‡à¸´à¸™",
  nav_language: "à¸ à¸²à¸©à¸²",
  nav_toggle: "à¹€à¸›à¸´à¸”à¹€à¸¡à¸™à¸¹",
  common_browse_automations: "à¸”à¸¹à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  common_explore_marketplace: "à¸”à¸¹à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  common_request_custom_automation: "à¸‚à¸­ Custom Automation",
  common_join_developer_waitlist: "à¹€à¸‚à¹‰à¸²à¸£à¹ˆà¸§à¸¡à¹€à¸§à¸•à¸¥à¸´à¸ªà¸•à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  common_get_support: "à¸•à¸´à¸”à¸•à¹ˆà¸­à¸‹à¸±à¸žà¸žà¸­à¸£à¹Œà¸•",
  common_buy: "à¸‹à¸·à¹‰à¸­",
  common_preview: "à¸žà¸£à¸µà¸§à¸´à¸§",
  common_view: "à¸”à¸¹",
  common_message_developer: "à¸ªà¹ˆà¸‡à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸–à¸¶à¸‡à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  common_message_nexus: "à¸ªà¹ˆà¸‡à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸–à¸¶à¸‡ Nexus",
  common_view_setup: "à¸”à¸¹à¸à¸²à¸£à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸²",
  common_view_output: "à¸”à¸¹à¹€à¸­à¸²à¸•à¹Œà¸žà¸¸à¸•",
  common_complete_setup: "à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸²à¹ƒà¸«à¹‰à¹€à¸ªà¸£à¹‡à¸ˆ",
  dashboard_buyer_title: "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸‚à¸­à¸‡à¸„à¸¸à¸“",
  dashboard_buyer_subtitle: "à¸•à¸´à¸”à¸•à¸²à¸¡à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™ à¸”à¸¹à¹€à¸­à¸²à¸•à¹Œà¸žà¸¸à¸• à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸² à¹à¸¥à¸°à¸•à¸£à¸§à¸ˆà¸ªà¸­à¸šà¸à¸´à¸ˆà¸à¸£à¸£à¸¡à¸ªà¸³à¸„à¸±à¸à¹ƒà¸™à¸—à¸µà¹ˆà¹€à¸”à¸µà¸¢à¸§",
  dashboard_overview: "à¸ à¸²à¸žà¸£à¸§à¸¡",
  dashboard_automations: "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸‚à¸­à¸‡à¸‰à¸±à¸™",
  dashboard_outputs: "à¹€à¸­à¸²à¸•à¹Œà¸žà¸¸à¸•",
  dashboard_activity: "à¸à¸´à¸ˆà¸à¸£à¸£à¸¡",
  dashboard_orders: "à¸­à¸­à¹€à¸”à¸­à¸£à¹Œ",
  dashboard_messages: "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡"
});

const LITERAL_TRANSLATIONS_TH = {
  "The marketplace for trusted business automation": "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸ªà¸³à¸«à¸£à¸±à¸š Business Automation à¸—à¸µà¹ˆà¹€à¸Šà¸·à¹ˆà¸­à¸–à¸·à¸­à¹„à¸”à¹‰",
  "Find, preview, and deploy AI automations without building anything.": "à¸„à¹‰à¸™à¸«à¸² à¸žà¸£à¸µà¸§à¸´à¸§ à¹à¸¥à¸°à¹ƒà¸Šà¹‰à¸‡à¸²à¸™ AI Automation à¹„à¸”à¹‰à¹‚à¸”à¸¢à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸‡",
  "Explore marketplace": "à¸”à¸¹à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "How Nexus works": "Nexus à¸—à¸³à¸‡à¸²à¸™à¸­à¸¢à¹ˆà¸²à¸‡à¹„à¸£",
  "Browse": "à¹€à¸¥à¸·à¸­à¸à¸”à¸¹",
  "Preview": "à¸žà¸£à¸µà¸§à¸´à¸§",
  "Customize": "à¸›à¸£à¸±à¸šà¹ƒà¸«à¹‰à¹€à¸«à¸¡à¸²à¸°à¸à¸±à¸šà¸„à¸¸à¸“",
  "Deploy": "à¸™à¸³à¹„à¸›à¹ƒà¸Šà¹‰à¸‡à¸²à¸™",
  "The problem": "à¸›à¸±à¸à¸«à¸²",
  "Businesses want AI outcomes, not another tool to figure out.": "à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸•à¹‰à¸­à¸‡à¸à¸²à¸£à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸ˆà¸²à¸ AI à¹„à¸¡à¹ˆà¹ƒà¸Šà¹ˆà¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸¡à¸·à¸­à¸­à¸µà¸à¸•à¸±à¸§à¸—à¸µà¹ˆà¸•à¹‰à¸­à¸‡à¹€à¸£à¸µà¸¢à¸™à¸£à¸¹à¹‰à¹€à¸­à¸‡",
  "Old way": "à¸§à¸´à¸˜à¸µà¹€à¸”à¸´à¸¡",
  "Confusing and risky": "à¸ªà¸±à¸šà¸ªà¸™à¹à¸¥à¸°à¹€à¸ªà¸µà¹ˆà¸¢à¸‡",
  "Nexus way": "à¸§à¸´à¸˜à¸µà¸‚à¸­à¸‡ Nexus",
  "Productized and clear": "à¹€à¸›à¹‡à¸™ Product à¸Šà¸±à¸”à¹€à¸ˆà¸™",
  "Featured automations": "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹à¸™à¸°à¸™à¸³",
  "View full marketplace": "à¸”à¸¹à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸—à¸±à¹‰à¸‡à¸«à¸¡à¸”",
  "Request custom automation": "à¸‚à¸­ Custom Automation",
  "The marketplace for AI workflows, agents, and automation services.": "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸ªà¸³à¸«à¸£à¸±à¸š AI Workflow, Agent à¹à¸¥à¸° Automation Service",
  "About Nexus AI": "à¹€à¸à¸µà¹ˆà¸¢à¸§à¸à¸±à¸š Nexus AI",
  "Browse marketplace": "à¸”à¸¹à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Join developer waitlist": "à¹€à¸‚à¹‰à¸²à¸£à¹ˆà¸§à¸¡à¹€à¸§à¸•à¸¥à¸´à¸ªà¸•à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Contact Nexus AI": "à¸•à¸´à¸”à¸•à¹ˆà¸­ Nexus AI",
  "Send a message": "à¸ªà¹ˆà¸‡à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡",
  "Different inquiries need different answers.": "à¹à¸•à¹ˆà¸¥à¸°à¸„à¸³à¸–à¸²à¸¡à¸•à¹‰à¸­à¸‡à¸à¸²à¸£à¸„à¸³à¸•à¸­à¸šà¸—à¸µà¹ˆà¸•à¹ˆà¸²à¸‡à¸à¸±à¸™",
  "Tell us what you need. Nexus will route it to the right next step.": "à¸šà¸­à¸à¹€à¸£à¸²à¸§à¹ˆà¸²à¸„à¸¸à¸“à¸•à¹‰à¸­à¸‡à¸à¸²à¸£à¸­à¸°à¹„à¸£ à¹à¸¥à¹‰à¸§ Nexus à¸ˆà¸°à¸ªà¹ˆà¸‡à¸•à¹ˆà¸­à¹„à¸›à¸¢à¸±à¸‡à¸‚à¸±à¹‰à¸™à¸•à¸­à¸™à¸—à¸µà¹ˆà¹€à¸«à¸¡à¸²à¸°à¸ªà¸¡",
  "Developer waitlist": "à¹€à¸§à¸•à¸¥à¸´à¸ªà¸•à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Join the waitlist": "à¹€à¸‚à¹‰à¸²à¸£à¹ˆà¸§à¸¡à¹€à¸§à¸•à¸¥à¸´à¸ªà¸•à¹Œ",
  "Developer profiles": "à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Know who builds and operates each automation.": "à¸£à¸¹à¹‰à¸§à¹ˆà¸²à¹ƒà¸„à¸£à¸ªà¸£à¹‰à¸²à¸‡à¹à¸¥à¸°à¸”à¸¹à¹à¸¥à¹à¸•à¹ˆà¸¥à¸°à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Buyer dashboard": "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "Your automation dashboard.": "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸‚à¸­à¸‡à¸„à¸¸à¸“",
  "Browse automations": "à¸”à¸¹à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Get support": "à¸•à¸´à¸”à¸•à¹ˆà¸­à¸‹à¸±à¸žà¸žà¸­à¸£à¹Œà¸•",
  "Messages": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡",
  "Conversations": "à¹à¸Šà¸•à¹à¸¥à¸°à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡",
  "No messages yet": "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡",
  "Developer dashboard": "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Your profile is live.": "à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸‚à¸­à¸‡à¸„à¸¸à¸“à¸­à¸­à¸™à¹„à¸¥à¸™à¹Œà¹à¸¥à¹‰à¸§",
  "Marketplace profile": "à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸šà¸™à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Products": "à¸ªà¸´à¸™à¸„à¹‰à¸²",
  "Wallet": "à¸§à¸­à¸¥à¹€à¸¥à¹‡à¸•",
  "Profile": "à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œ",
  "Submit product": "à¸ªà¹ˆà¸‡à¸ªà¸´à¸™à¸„à¹‰à¸²à¹ƒà¸«à¹‰à¸•à¸£à¸§à¸ˆ",
  "Save draft": "à¸šà¸±à¸™à¸—à¸¶à¸à¸”à¸£à¸²à¸Ÿà¸•à¹Œ",
  "Submit for review": "à¸ªà¹ˆà¸‡à¹ƒà¸«à¹‰à¹à¸­à¸”à¸¡à¸´à¸™à¸•à¸£à¸§à¸ˆ",
  "Admin overview": "à¸ à¸²à¸žà¸£à¸§à¸¡à¹à¸­à¸”à¸¡à¸´à¸™",
  "Marketplace control center.": "à¸¨à¸¹à¸™à¸¢à¹Œà¸„à¸§à¸šà¸„à¸¸à¸¡à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Product Review Queue": "à¸„à¸´à¸§à¸•à¸£à¸§à¸ˆà¸ªà¸´à¸™à¸„à¹‰à¸²",
  "Finance": "à¹„à¸Ÿà¹à¸™à¸™à¸‹à¹Œ",
  "Orders": "à¸­à¸­à¹€à¸”à¸­à¸£à¹Œ",
  "Inquiries": "à¸­à¸´à¸™à¹„à¸„à¸§à¸£à¸µ",
  "Review Queue": "à¸„à¸´à¸§à¸•à¸£à¸§à¸ˆ",
  "Create Product": "à¸ªà¸£à¹‰à¸²à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸²",
  "View Marketplace": "à¸”à¸¹à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Logout": "à¸­à¸­à¸à¸ˆà¸²à¸à¸£à¸°à¸šà¸š",
  "Login": "à¸¥à¹‡à¸­à¸à¸­à¸´à¸™",
  "Home": "à¸«à¸™à¹‰à¸²à¹à¸£à¸",
  "Marketplace": "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Developers": "à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "About": "à¹€à¸à¸µà¹ˆà¸¢à¸§à¸à¸±à¸šà¹€à¸£à¸²",
  "Contact": "à¸•à¸´à¸”à¸•à¹ˆà¸­",
  "Dashboard": "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”"
};

Object.assign(LITERAL_TRANSLATIONS_TH, {
  "The marketplace for trusted business automation": "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸ªà¸³à¸«à¸£à¸±à¸šà¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸—à¸µà¹ˆà¹€à¸Šà¸·à¹ˆà¸­à¸–à¸·à¸­à¹„à¸”à¹‰",
  "Find, preview, and deploy AI automations without building anything.": "à¸„à¹‰à¸™à¸«à¸² à¸žà¸£à¸µà¸§à¸´à¸§ à¹à¸¥à¸°à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¹€à¸­à¹„à¸­à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹„à¸”à¹‰à¹‚à¸”à¸¢à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸‡",
  "Nexus AI is the marketplace where businesses find ready-made automations, understand what they do, preview the result, choose self-serve or Nexus guided install, and move toward deployment with confidence.": "Nexus AI à¸„à¸·à¸­à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸—à¸µà¹ˆà¸Šà¹ˆà¸§à¸¢à¹ƒà¸«à¹‰à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸„à¹‰à¸™à¸«à¸²à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸ªà¸³à¹€à¸£à¹‡à¸ˆà¸£à¸¹à¸› à¹€à¸‚à¹‰à¸²à¹ƒà¸ˆà¸§à¹ˆà¸²à¸—à¸³à¸­à¸°à¹„à¸£ à¸žà¸£à¸µà¸§à¸´à¸§à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¹€à¸¥à¸·à¸­à¸à¹€à¸‹à¸¥à¸Ÿà¹Œà¹€à¸‹à¸´à¸£à¹Œà¸Ÿà¸«à¸£à¸·à¸­ Nexus à¹„à¸à¸”à¹Œà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡ à¹à¸¥à¸°à¹€à¸”à¸´à¸™à¸«à¸™à¹‰à¸²à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¹„à¸”à¹‰à¸­à¸¢à¹ˆà¸²à¸‡à¸¡à¸±à¹ˆà¸™à¹ƒà¸ˆ",
  "Explore marketplace": "à¸”à¸¹à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "How Nexus works": "Nexus à¸—à¸³à¸‡à¸²à¸™à¸­à¸¢à¹ˆà¸²à¸‡à¹„à¸£",
  "Find automations by business problem, category, and setup path.": "à¸«à¸²à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸•à¸²à¸¡à¸›à¸±à¸à¸«à¸²à¸˜à¸¸à¸£à¸à¸´à¸ˆ à¸«à¸¡à¸§à¸”à¸«à¸¡à¸¹à¹ˆ à¹à¸¥à¸°à¹€à¸ªà¹‰à¸™à¸—à¸²à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž",
  "Open a product popup and see the expected output before buying.": "à¹€à¸›à¸´à¸”à¸›à¹Šà¸­à¸›à¸­à¸±à¸›à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¹à¸¥à¸°à¸”à¸¹à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸—à¸µà¹ˆà¸„à¸²à¸”à¸«à¸§à¸±à¸‡à¸à¹ˆà¸­à¸™à¸‹à¸·à¹‰à¸­",
  "Select options and see how the automation changes for your use case.": "à¹€à¸¥à¸·à¸­à¸à¸­à¸­à¸›à¸Šà¸±à¸™à¹à¸¥à¸°à¸”à¸¹à¸§à¹ˆà¸²à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¸•à¸²à¸¡à¸¢à¸¹à¸ªà¹€à¸„à¸ªà¸‚à¸­à¸‡à¸„à¸¸à¸“à¸­à¸¢à¹ˆà¸²à¸‡à¹„à¸£",
  "Choose self-serve or Nexus guided install before checkout.": "à¹€à¸¥à¸·à¸­à¸à¹€à¸‹à¸¥à¸Ÿà¹Œà¹€à¸‹à¸´à¸£à¹Œà¸Ÿà¸«à¸£à¸·à¸­ Nexus à¹„à¸à¸”à¹Œà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡à¸à¹ˆà¸­à¸™à¹€à¸Šà¹‡à¸à¹€à¸­à¸²à¸•à¹Œ",
  "Businesses want AI outcomes, not another tool to figure out.": "à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸•à¹‰à¸­à¸‡à¸à¸²à¸£à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸ˆà¸²à¸à¹€à¸­à¹„à¸­ à¹„à¸¡à¹ˆà¹ƒà¸Šà¹ˆà¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸¡à¸·à¸­à¸­à¸µà¸à¸•à¸±à¸§à¸—à¸µà¹ˆà¸•à¹‰à¸­à¸‡à¹€à¸£à¸µà¸¢à¸™à¸£à¸¹à¹‰à¹€à¸­à¸‡",
  "Most companies already know AI can help. The problem is turning that potential into something that actually works inside the business. Today, teams are forced to compare tools, hire freelancers, download templates, connect APIs, manage credentials, troubleshoot workflow errors, or trust vague AI claims.": "à¸šà¸£à¸´à¸©à¸±à¸—à¸ªà¹ˆà¸§à¸™à¹ƒà¸«à¸à¹ˆà¸£à¸¹à¹‰à¹à¸¥à¹‰à¸§à¸§à¹ˆà¸²à¹€à¸­à¹„à¸­à¸Šà¹ˆà¸§à¸¢à¹„à¸”à¹‰ à¸›à¸±à¸à¸«à¸²à¸„à¸·à¸­à¸à¸²à¸£à¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¸¨à¸±à¸à¸¢à¸ à¸²à¸žà¸™à¸±à¹‰à¸™à¹ƒà¸«à¹‰à¹€à¸›à¹‡à¸™à¸ªà¸´à¹ˆà¸‡à¸—à¸µà¹ˆà¸—à¸³à¸‡à¸²à¸™à¸ˆà¸£à¸´à¸‡à¹ƒà¸™à¸˜à¸¸à¸£à¸à¸´à¸ˆ à¸§à¸±à¸™à¸™à¸µà¹‰à¸—à¸µà¸¡à¸•à¹‰à¸­à¸‡à¹€à¸—à¸µà¸¢à¸šà¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸¡à¸·à¸­ à¸ˆà¹‰à¸²à¸‡à¸Ÿà¸£à¸µà¹à¸¥à¸™à¸‹à¹Œ à¸”à¸²à¸§à¸™à¹Œà¹‚à¸«à¸¥à¸”à¹€à¸—à¸¡à¹€à¸žà¸¥à¸• à¹€à¸Šà¸·à¹ˆà¸­à¸¡ API à¸ˆà¸±à¸”à¸à¸²à¸£ credentials à¹à¸à¹‰ error à¸‚à¸­à¸‡à¹€à¸§à¸´à¸£à¹Œà¸à¹‚à¸Ÿà¸¥à¸§à¹Œ à¸«à¸£à¸·à¸­à¹€à¸Šà¸·à¹ˆà¸­à¸„à¸³à¹‚à¸†à¸©à¸“à¸²à¹€à¸­à¹„à¸­à¸—à¸µà¹ˆà¹„à¸¡à¹ˆà¸Šà¸±à¸”à¹€à¸ˆà¸™",
  "Nexus AI changes that by turning automations into marketplace products. A business can see what the automation solves, what it outputs, who operates it, what setup requires, and whether it should be self-serve or guided.": "Nexus AI à¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¹€à¸£à¸·à¹ˆà¸­à¸‡à¸™à¸µà¹‰à¸”à¹‰à¸§à¸¢à¸à¸²à¸£à¸—à¸³à¹ƒà¸«à¹‰à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸à¸¥à¸²à¸¢à¹€à¸›à¹‡à¸™à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¹ƒà¸™à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸ˆà¸°à¹€à¸«à¹‡à¸™à¸§à¹ˆà¸²à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹à¸à¹‰à¸›à¸±à¸à¸«à¸²à¸­à¸°à¹„à¸£ à¹ƒà¸«à¹‰à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸­à¸°à¹„à¸£ à¹ƒà¸„à¸£à¹€à¸›à¹‡à¸™à¸œà¸¹à¹‰à¸”à¸¹à¹à¸¥ à¸•à¹‰à¸­à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸žà¸­à¸°à¹„à¸£ à¹à¸¥à¸°à¸„à¸§à¸£à¹ƒà¸Šà¹‰à¹à¸šà¸šà¹€à¸‹à¸¥à¸Ÿà¹Œà¹€à¸‹à¸´à¸£à¹Œà¸Ÿà¸«à¸£à¸·à¸­à¹à¸šà¸šà¹„à¸à¸”à¹Œà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡",
  "Old way": "à¸§à¸´à¸˜à¸µà¹€à¸”à¸´à¸¡",
  "Download workflow templates": "à¸”à¸²à¸§à¸™à¹Œà¹‚à¸«à¸¥à¸”à¹€à¸—à¸¡à¹€à¸žà¸¥à¸•à¹€à¸§à¸´à¸£à¹Œà¸à¹‚à¸Ÿà¸¥à¸§à¹Œ",
  "Hire someone without knowing the result": "à¸ˆà¹‰à¸²à¸‡à¸„à¸™à¹‚à¸”à¸¢à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¹€à¸«à¹‡à¸™à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ",
  "Connect tools manually": "à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸¡à¸·à¸­à¹€à¸­à¸‡",
  "Debug API and setup errors alone": "à¹à¸à¹‰ API à¹à¸¥à¸° error à¸•à¸­à¸™à¹€à¸‹à¹‡à¸•à¸­à¸±à¸žà¹€à¸­à¸‡",
  "Trust overpromised AI claims": "à¹€à¸Šà¸·à¹ˆà¸­à¸„à¸³à¹€à¸„à¸¥à¸¡à¹€à¸­à¹„à¸­à¸—à¸µà¹ˆà¹€à¸à¸´à¸™à¸ˆà¸£à¸´à¸‡",
  "Nexus way": "à¸§à¸´à¸˜à¸µà¸‚à¸­à¸‡ Nexus",
  "Browse by business outcome": "à¹€à¸¥à¸·à¸­à¸à¸”à¸¹à¸•à¸²à¸¡à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸˜à¸¸à¸£à¸à¸´à¸ˆ",
  "Preview before committing": "à¸žà¸£à¸µà¸§à¸´à¸§à¸à¹ˆà¸­à¸™à¸•à¸±à¸”à¸ªà¸´à¸™à¹ƒà¸ˆ",
  "Choose setup path upfront": "à¹€à¸¥à¸·à¸­à¸à¹€à¸ªà¹‰à¸™à¸—à¸²à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸žà¸•à¸±à¹‰à¸‡à¹à¸•à¹ˆà¹à¸£à¸",
  "Use trusted developer/operator profiles": "à¸”à¸¹à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸«à¸£à¸·à¸­à¹‚à¸­à¹€à¸›à¸­à¹€à¸£à¹€à¸•à¸­à¸£à¹Œà¸—à¸µà¹ˆà¸™à¹ˆà¸²à¹€à¸Šà¸·à¹ˆà¸­à¸–à¸·à¸­",
  "Prepare for checkout and deployment": "à¹€à¸•à¸£à¸µà¸¢à¸¡à¸žà¸£à¹‰à¸­à¸¡à¸ªà¸³à¸«à¸£à¸±à¸šà¹€à¸Šà¹‡à¸à¹€à¸­à¸²à¸•à¹Œà¹à¸¥à¸°à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¸ˆà¸£à¸´à¸‡",
  "From business problem to automation setup.": "à¸ˆà¸²à¸à¸›à¸±à¸à¸«à¸²à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸ªà¸¹à¹ˆà¸à¸²à¸£à¹€à¸‹à¹‡à¸•à¸­à¸±à¸žà¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Nexus is designed so a non-technical business user can understand the product before touching setup, payment, or implementation.": "Nexus à¸–à¸¹à¸à¸­à¸­à¸à¹à¸šà¸šà¹ƒà¸«à¹‰à¸œà¸¹à¹‰à¹ƒà¸Šà¹‰à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸—à¸µà¹ˆà¹„à¸¡à¹ˆà¹ƒà¸Šà¹ˆà¸ªà¸²à¸¢à¹€à¸—à¸„à¸™à¸´à¸„à¹€à¸‚à¹‰à¸²à¹ƒà¸ˆà¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸à¹ˆà¸­à¸™à¹à¸•à¸°à¹€à¸£à¸·à¹ˆà¸­à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¸à¸²à¸£à¸ˆà¹ˆà¸²à¸¢à¹€à¸‡à¸´à¸™ à¸«à¸£à¸·à¸­à¸à¸²à¸£à¸™à¸³à¹„à¸›à¹ƒà¸Šà¹‰à¸ˆà¸£à¸´à¸‡",
  "Search the marketplace": "à¸„à¹‰à¸™à¸«à¸²à¹ƒà¸™à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Browse automations by category, pricing model, setup type, and business outcome.": "à¹€à¸¥à¸·à¸­à¸à¸”à¸¹à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸•à¸²à¸¡à¸«à¸¡à¸§à¸”à¸«à¸¡à¸¹à¹ˆ à¹‚à¸¡à¹€à¸”à¸¥à¸£à¸²à¸„à¸² à¸›à¸£à¸°à¹€à¸ à¸—à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¹à¸¥à¸°à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸˜à¸¸à¸£à¸à¸´à¸ˆ",
  "Open the product popup": "à¹€à¸›à¸´à¸”à¸›à¹Šà¸­à¸›à¸­à¸±à¸›à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ",
  "See the product explanation, preview, required inputs, outputs, trust points, and reviews.": "à¸”à¸¹à¸„à¸³à¸­à¸˜à¸´à¸šà¸²à¸¢à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ à¸žà¸£à¸µà¸§à¸´à¸§ à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸—à¸µà¹ˆà¸•à¹‰à¸­à¸‡à¹ƒà¸Šà¹‰ à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¸ˆà¸¸à¸”à¸ªà¸£à¹‰à¸²à¸‡à¸„à¸§à¸²à¸¡à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¸±à¹ˆà¸™ à¹à¸¥à¸°à¸£à¸µà¸§à¸´à¸§",
  "Choose customization": "à¹€à¸¥à¸·à¸­à¸à¸„à¸±à¸ªà¸•à¸­à¸¡à¹„à¸¡à¸‹à¹Œ",
  "Some automations offer different versions. Click each option to preview how the output changes.": "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸šà¸²à¸‡à¸•à¸±à¸§à¸¡à¸µà¸«à¸¥à¸²à¸¢à¹€à¸§à¸­à¸£à¹Œà¸Šà¸±à¸™ à¸„à¸¥à¸´à¸à¹à¸•à¹ˆà¸¥à¸°à¸­à¸­à¸›à¸Šà¸±à¸™à¹€à¸žà¸·à¹ˆà¸­à¸žà¸£à¸µà¸§à¸´à¸§à¸§à¹ˆà¸²à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¸­à¸¢à¹ˆà¸²à¸‡à¹„à¸£",
  "Select setup path": "à¹€à¸¥à¸·à¸­à¸à¹€à¸ªà¹‰à¸™à¸—à¸²à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž",
  "Choose Self-Serve Setup or Nexus Guided Install before continuing to checkout preparation.": "à¹€à¸¥à¸·à¸­à¸ Self-Serve Setup à¸«à¸£à¸·à¸­ Nexus Guided Install à¸à¹ˆà¸­à¸™à¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆà¸à¸²à¸£à¹€à¸•à¸£à¸µà¸¢à¸¡à¹€à¸Šà¹‡à¸à¹€à¸­à¸²à¸•à¹Œ",
  "Ready-made products loaded from your marketplace database.": "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸ªà¸³à¹€à¸£à¹‡à¸ˆà¸£à¸¹à¸›à¸—à¸µà¹ˆà¹‚à¸«à¸¥à¸”à¸ˆà¸²à¸à¸à¸²à¸™à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸‚à¸­à¸‡à¸„à¸¸à¸“",
  "These cards are pulled from Supabase. Use the hidden admin dashboard to create, publish, edit, preview, customize, pause, or delete marketplace listings.": "à¸à¸²à¸£à¹Œà¸”à¹€à¸«à¸¥à¹ˆà¸²à¸™à¸µà¹‰à¸”à¸¶à¸‡à¸ˆà¸²à¸ Supabase à¹ƒà¸Šà¹‰à¹à¸­à¸”à¸¡à¸´à¸™à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¹à¸šà¸š hidden à¹€à¸žà¸·à¹ˆà¸­à¸ªà¸£à¹‰à¸²à¸‡ à¹€à¸œà¸¢à¹à¸žà¸£à¹ˆ à¹à¸à¹‰à¹„à¸‚ à¸žà¸£à¸µà¸§à¸´à¸§ à¸„à¸±à¸ªà¸•à¸­à¸¡ à¸žà¸±à¸ à¸«à¸£à¸·à¸­ à¸¥à¸š listing à¹ƒà¸™à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Every listing should explain the outcome, not hide behind technical language.": "à¸—à¸¸à¸ listing à¸„à¸§à¸£à¸­à¸˜à¸´à¸šà¸²à¸¢à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¹„à¸¡à¹ˆà¹ƒà¸Šà¹ˆà¸‹à¹ˆà¸­à¸™à¸­à¸¢à¸¹à¹ˆà¸«à¸¥à¸±à¸‡à¸ à¸²à¸©à¸²à¸—à¸²à¸‡à¹€à¸—à¸„à¸™à¸´à¸„",
  "Nexus products are designed to help businesses understand what they are buying. Each listing can include a preview, setup path, required inputs, outputs, pricing, customization options, reviews, and a developer or operator profile.": "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸‚à¸­à¸‡ Nexus à¸–à¸¹à¸à¸­à¸­à¸à¹à¸šà¸šà¹ƒà¸«à¹‰à¸˜à¸¸à¸£à¸à¸´à¸ˆà¹€à¸‚à¹‰à¸²à¹ƒà¸ˆà¸§à¹ˆà¸²à¸à¸³à¸¥à¸±à¸‡à¸‹à¸·à¹‰à¸­à¸­à¸°à¹„à¸£ à¹à¸•à¹ˆà¸¥à¸° listing à¹ƒà¸ªà¹ˆà¸žà¸£à¸µà¸§à¸´à¸§ à¹€à¸ªà¹‰à¸™à¸—à¸²à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸—à¸µà¹ˆà¸•à¹‰à¸­à¸‡à¹ƒà¸Šà¹‰ à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¸£à¸²à¸„à¸² à¸­à¸­à¸›à¸Šà¸±à¸™à¸„à¸±à¸ªà¸•à¸­à¸¡ à¸£à¸µà¸§à¸´à¸§ à¹à¸¥à¸°à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸«à¸£à¸·à¸­à¹‚à¸­à¹€à¸›à¸­à¹€à¸£à¹€à¸•à¸­à¸£à¹Œà¹„à¸”à¹‰",
  "Preview modes": "à¹‚à¸«à¸¡à¸”à¸žà¸£à¸µà¸§à¸´à¸§",
  "Template, code, screenshot URL, or base64 image.": "à¹€à¸—à¸¡à¹€à¸žà¸¥à¸• à¹‚à¸„à¹‰à¸” URL à¸£à¸¹à¸›à¸ªà¸à¸£à¸µà¸™à¸Šà¹‡à¸­à¸• à¸«à¸£à¸·à¸­à¸£à¸¹à¸› base64",
  "Customization previews": "à¸žà¸£à¸µà¸§à¸´à¸§à¸„à¸±à¸ªà¸•à¸­à¸¡à¹„à¸¡à¸‹à¹Œ",
  "Each customization can show how the automation changes.": "à¹à¸•à¹ˆà¸¥à¸°à¸„à¸±à¸ªà¸•à¸­à¸¡à¹„à¸¡à¸‹à¹Œà¸ªà¸²à¸¡à¸²à¸£à¸–à¹à¸ªà¸”à¸‡à¸§à¹ˆà¸²à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¸­à¸¢à¹ˆà¸²à¸‡à¹„à¸£",
  "Buyer-ready setup": "à¹€à¸‹à¹‡à¸•à¸­à¸±à¸žà¸žà¸£à¹‰à¸­à¸¡à¸ªà¸³à¸«à¸£à¸±à¸šà¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "Self-serve and Nexus guided install are built into the flow.": "à¹€à¸‹à¸¥à¸Ÿà¹Œà¹€à¸‹à¸´à¸£à¹Œà¸Ÿà¹à¸¥à¸° Nexus à¹„à¸à¸”à¹Œà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡à¸­à¸¢à¸¹à¹ˆà¹ƒà¸™à¹‚à¸Ÿà¸¥à¸§à¹Œà¹à¸¥à¹‰à¸§",
  "Two-sided marketplace": "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸ªà¸­à¸‡à¸à¸±à¹ˆà¸‡",
  "Built for businesses now. Built for developers next.": "à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸žà¸·à¹ˆà¸­à¸˜à¸¸à¸£à¸à¸´à¸ˆà¸•à¸­à¸™à¸™à¸µà¹‰ à¹à¸¥à¸°à¹€à¸žà¸·à¹ˆà¸­à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¹ƒà¸™à¸‚à¸±à¹‰à¸™à¸•à¹ˆà¸­à¹„à¸›",
  "Nexus starts with internal products so the buyer experience is strong. Then approved developers can join, list automations, and sell through a trusted marketplace.": "Nexus à¹€à¸£à¸´à¹ˆà¸¡à¸ˆà¸²à¸à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸ à¸²à¸¢à¹ƒà¸™à¹€à¸žà¸·à¹ˆà¸­à¹ƒà¸«à¹‰à¸›à¸£à¸°à¸ªà¸šà¸à¸²à¸£à¸“à¹Œà¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­à¹à¸‚à¹‡à¸‡à¹à¸£à¸‡ à¸ˆà¸²à¸à¸™à¸±à¹‰à¸™à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸—à¸µà¹ˆà¸œà¹ˆà¸²à¸™à¸à¸²à¸£à¸­à¸™à¸¸à¸¡à¸±à¸•à¸´à¸ˆà¸°à¹€à¸‚à¹‰à¸²à¸£à¹ˆà¸§à¸¡ à¸¥à¸‡ listing à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™ à¹à¸¥à¸°à¸‚à¸²à¸¢à¸œà¹ˆà¸²à¸™à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸—à¸µà¹ˆà¸™à¹ˆà¸²à¹€à¸Šà¸·à¹ˆà¸­à¸–à¸·à¸­à¹„à¸”à¹‰",
  "For businesses": "à¸ªà¸³à¸«à¸£à¸±à¸šà¸˜à¸¸à¸£à¸à¸´à¸ˆ",
  "Use automation without managing the workflow.": "à¹ƒà¸Šà¹‰à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹‚à¸”à¸¢à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡à¸ˆà¸±à¸”à¸à¸²à¸£à¹€à¸§à¸´à¸£à¹Œà¸à¹‚à¸Ÿà¸¥à¸§à¹Œà¹€à¸­à¸‡",
  "Businesses should not need to understand workflow builders, prompts, API failures, or hosting problems. Nexus helps them compare automation products by outcome, preview, setup path, and trust.": "à¸˜à¸¸à¸£à¸à¸´à¸ˆà¹„à¸¡à¹ˆà¸„à¸§à¸£à¸•à¹‰à¸­à¸‡à¹€à¸‚à¹‰à¸²à¹ƒà¸ˆ workflow builder, prompt, API failure à¸«à¸£à¸·à¸­à¸›à¸±à¸à¸«à¸² hosting à¹€à¸­à¸‡ Nexus à¸Šà¹ˆà¸§à¸¢à¹ƒà¸«à¹‰à¹€à¸—à¸µà¸¢à¸šà¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸•à¸²à¸¡à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¸žà¸£à¸µà¸§à¸´à¸§ à¹€à¸ªà¹‰à¸™à¸—à¸²à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¹à¸¥à¸°à¸„à¸§à¸²à¸¡à¸™à¹ˆà¸²à¹€à¸Šà¸·à¹ˆà¸­à¸–à¸·à¸­",
  "Find automation by problem": "à¸«à¸²à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸ˆà¸²à¸à¸›à¸±à¸à¸«à¸²",
  "Preview before setup": "à¸žà¸£à¸µà¸§à¸´à¸§à¸à¹ˆà¸­à¸™à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž",
  "Choose self-serve or guided install": "à¹€à¸¥à¸·à¸­à¸à¹€à¸‹à¸¥à¸Ÿà¹Œà¹€à¸‹à¸´à¸£à¹Œà¸Ÿà¸«à¸£à¸·à¸­à¹„à¸à¸”à¹Œà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡",
  "Submit checkout preparation": "à¸ªà¹ˆà¸‡à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹€à¸•à¸£à¸µà¸¢à¸¡à¹€à¸Šà¹‡à¸à¹€à¸­à¸²à¸•à¹Œ",
  "Browse products": "à¸”à¸¹à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ",
  "For developers": "à¸ªà¸³à¸«à¸£à¸±à¸šà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Turn automations into repeatable products.": "à¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹ƒà¸«à¹‰à¹€à¸›à¹‡à¸™à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸—à¸µà¹ˆà¸‚à¸²à¸¢à¸‹à¹‰à¸³à¹„à¸”à¹‰",
  "Developers will eventually be able to submit automations, add previews, define customization options, and sell through Nexus without building a marketplace or managing every customer manually.": "à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸ˆà¸°à¸ªà¸²à¸¡à¸²à¸£à¸–à¸ªà¹ˆà¸‡à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™ à¹€à¸žà¸´à¹ˆà¸¡à¸žà¸£à¸µà¸§à¸´à¸§ à¸à¸³à¸«à¸™à¸”à¸­à¸­à¸›à¸Šà¸±à¸™à¸„à¸±à¸ªà¸•à¸­à¸¡ à¹à¸¥à¸°à¸‚à¸²à¸¢à¸œà¹ˆà¸²à¸™ Nexus à¹„à¸”à¹‰à¹‚à¸”à¸¢à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡à¸ªà¸£à¹‰à¸²à¸‡à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸«à¸£à¸·à¸­à¸ˆà¸±à¸”à¸à¸²à¸£à¸¥à¸¹à¸à¸„à¹‰à¸²à¸—à¸¸à¸à¸„à¸™à¹€à¸­à¸‡",
  "Prepare automation products": "à¹€à¸•à¸£à¸µà¸¢à¸¡à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Add previews and customization options": "à¹€à¸žà¸´à¹ˆà¸¡à¸žà¸£à¸µà¸§à¸´à¸§à¹à¸¥à¸°à¸­à¸­à¸›à¸Šà¸±à¸™à¸„à¸±à¸ªà¸•à¸­à¸¡",
  "Build a public developer profile": "à¸ªà¸£à¹‰à¸²à¸‡à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸ªà¸²à¸˜à¸²à¸£à¸“à¸°",
  "Sell through the Nexus trust layer": "à¸‚à¸²à¸¢à¸œà¹ˆà¸²à¸™ trust layer à¸‚à¸­à¸‡ Nexus",
  "The long-term vision": "à¸§à¸´à¸ªà¸±à¸¢à¸—à¸±à¸¨à¸™à¹Œà¸£à¸°à¸¢à¸°à¸¢à¸²à¸§",
  "Nexus becomes the authority on which automations actually work.": "Nexus à¸ˆà¸°à¸à¸¥à¸²à¸¢à¹€à¸›à¹‡à¸™à¹à¸«à¸¥à¹ˆà¸‡à¸­à¹‰à¸²à¸‡à¸­à¸´à¸‡à¸§à¹ˆà¸²à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¹„à¸«à¸™à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¹„à¸”à¹‰à¸ˆà¸£à¸´à¸‡",
  "The AI market is filled with hype, vague promises, and tools that are hard to compare. Nexus becomes valuable by creating structure: product pages, previews, reviews, developer profiles, setup paths, and real buyer feedback.": "à¸•à¸¥à¸²à¸”à¹€à¸­à¹„à¸­à¹€à¸•à¹‡à¸¡à¹„à¸›à¸”à¹‰à¸§à¸¢ hype à¸„à¸³à¸ªà¸±à¸à¸à¸²à¸—à¸µà¹ˆà¹„à¸¡à¹ˆà¸Šà¸±à¸” à¹à¸¥à¸°à¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸¡à¸·à¸­à¸—à¸µà¹ˆà¹€à¸—à¸µà¸¢à¸šà¸à¸±à¸™à¸¢à¸²à¸ Nexus à¸¡à¸µà¸„à¸¸à¸“à¸„à¹ˆà¸²à¸”à¹‰à¸§à¸¢à¸à¸²à¸£à¸ªà¸£à¹‰à¸²à¸‡à¹‚à¸„à¸£à¸‡à¸ªà¸£à¹‰à¸²à¸‡: à¸«à¸™à¹‰à¸²à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ à¸žà¸£à¸µà¸§à¸´à¸§ à¸£à¸µà¸§à¸´à¸§ à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ à¹€à¸ªà¹‰à¸™à¸—à¸²à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¹à¸¥à¸° feedback à¸ˆà¸£à¸´à¸‡à¸ˆà¸²à¸à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "Marketplace roadmap": "à¹‚à¸£à¸”à¹à¸¡à¸›à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Built in phases so the foundation works first.": "à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸›à¹‡à¸™à¹€à¸Ÿà¸ªà¹€à¸žà¸·à¹ˆà¸­à¹ƒà¸«à¹‰à¸à¸²à¸™à¸—à¸³à¸‡à¸²à¸™à¹„à¸”à¹‰à¸à¹ˆà¸­à¸™",
  "Start with the marketplace or request a custom automation.": "à¹€à¸£à¸´à¹ˆà¸¡à¸ˆà¸²à¸à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ªà¸«à¸£à¸·à¸­à¸£à¸µà¹€à¸„à¸§à¸ªà¸•à¹Œà¸„à¸±à¸ªà¸•à¸­à¸¡à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Browse available products, open a product popup, preview the output, choose setup path, or contact Nexus if your workflow is not listed yet.": "à¸”à¸¹à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸—à¸µà¹ˆà¸¡à¸µ à¹€à¸›à¸´à¸”à¸›à¹Šà¸­à¸›à¸­à¸±à¸›à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ à¸žà¸£à¸µà¸§à¸´à¸§à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¹€à¸¥à¸·à¸­à¸à¹€à¸ªà¹‰à¸™à¸—à¸²à¸‡à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¸«à¸£à¸·à¸­ à¸•à¸´à¸”à¸•à¹ˆà¸­ Nexus à¸–à¹‰à¸²à¹€à¸§à¸´à¸£à¹Œà¸à¹‚à¸Ÿà¸¥à¸§à¹Œà¸‚à¸­à¸‡à¸„à¸¸à¸“à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¹ƒà¸™ listing",
  "Contact Nexus": "à¸•à¸´à¸”à¸•à¹ˆà¸­ Nexus",
  "Buyer dashboard": "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "Track your automations, view outputs, complete setup, and monitor important activity from one clean dashboard.": "à¸•à¸´à¸”à¸•à¸²à¸¡à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™ à¸”à¸¹à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œ à¸—à¸³à¹€à¸‹à¹‡à¸•à¸­à¸±à¸žà¹ƒà¸«à¹‰à¸„à¸£à¸š à¹à¸¥à¸°à¸”à¸¹ activity à¸ªà¸³à¸„à¸±à¸à¸ˆà¸²à¸à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¹€à¸”à¸µà¸¢à¸§",
  "Account status": "à¸ªà¸–à¸²à¸™à¸°à¸šà¸±à¸à¸Šà¸µ",
  "Checking your automation status...": "à¸à¸³à¸¥à¸±à¸‡à¹€à¸Šà¹‡à¸à¸ªà¸–à¸²à¸™à¸°à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸‚à¸­à¸‡à¸„à¸¸à¸“...",
  "My Automations": "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸‚à¸­à¸‡à¸‰à¸±à¸™",
  "Activity": "Activity",
  "What needs your attention?": "à¸­à¸°à¹„à¸£à¸—à¸µà¹ˆà¸•à¹‰à¸­à¸‡à¸”à¸¹à¸•à¸­à¸™à¸™à¸µà¹‰",
  "Your most important automation updates in one place.": "à¸­à¸±à¸›à¹€à¸”à¸•à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸ªà¸³à¸„à¸±à¸à¸‚à¸­à¸‡à¸„à¸¸à¸“à¹ƒà¸™à¸—à¸µà¹ˆà¹€à¸”à¸µà¸¢à¸§",
  "Purchased automations": "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸—à¸µà¹ˆà¸‹à¸·à¹‰à¸­à¹à¸¥à¹‰à¸§",
  "Manage setup, status, and latest results for each automation.": "à¸ˆà¸±à¸”à¸à¸²à¸£à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¸ªà¸–à¸²à¸™à¸° à¹à¸¥à¸°à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸‚à¸­à¸‡à¹à¸•à¹ˆà¸¥à¸°à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Automation outputs": "à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Reports, generated files, and workflow results from your automations.": "à¸£à¸µà¸žà¸­à¸£à¹Œà¸• à¹„à¸Ÿà¸¥à¹Œà¸—à¸µà¹ˆà¸ªà¸£à¹‰à¸²à¸‡ à¹à¸¥à¸°à¸œà¸¥à¸¥à¸±à¸žà¸˜à¹Œà¹€à¸§à¸´à¸£à¹Œà¸à¹‚à¸Ÿà¸¥à¸§à¹Œà¸ˆà¸²à¸à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸‚à¸­à¸‡à¸„à¸¸à¸“",
  "Setup and runtime logs": "à¸¥à¹‡à¸­à¸à¹€à¸‹à¹‡à¸•à¸­à¸±à¸žà¹à¸¥à¸°à¸£à¸±à¸™à¹„à¸—à¸¡à¹Œ",
  "Important status updates, setup events, and runtime errors.": "à¸­à¸±à¸›à¹€à¸”à¸•à¸ªà¸–à¸²à¸™à¸°à¸ªà¸³à¸„à¸±à¸ à¸­à¸µà¹€à¸§à¸™à¸•à¹Œà¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¹à¸¥à¸° runtime error",
  "Orders and billing": "à¸­à¸­à¹€à¸”à¸­à¸£à¹Œà¹à¸¥à¸°à¸šà¸´à¸¥à¸¥à¸´à¸‡",
  "Your purchased automations and payment status.": "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸—à¸µà¹ˆà¸„à¸¸à¸“à¸‹à¸·à¹‰à¸­à¹à¸¥à¸°à¸ªà¸–à¸²à¸™à¸°à¸à¸²à¸£à¸ˆà¹ˆà¸²à¸¢à¹€à¸‡à¸´à¸™",
  "Messages with Nexus and developers.": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸à¸±à¸š Nexus à¹à¸¥à¸°à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Developer dashboard": "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Manage your public marketplace profile, submit products for Nexus approval, handle buyer messages, and prepare payouts when payments are enabled.": "à¸ˆà¸±à¸”à¸à¸²à¸£à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª à¸ªà¹ˆà¸‡à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¹ƒà¸«à¹‰ Nexus à¸­à¸™à¸¸à¸¡à¸±à¸•à¸´ à¸•à¸­à¸šà¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­ à¹à¸¥à¸°à¹€à¸•à¸£à¸µà¸¢à¸¡ payout à¹€à¸¡à¸·à¹ˆà¸­à¹€à¸›à¸´à¸”à¸£à¸°à¸šà¸šà¸ˆà¹ˆà¸²à¸¢à¹€à¸‡à¸´à¸™",
  "View public profile": "à¸”à¸¹à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸ªà¸²à¸˜à¸²à¸£à¸“à¸°",
  "Your profile is active in the developer directory.": "à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸‚à¸­à¸‡à¸„à¸¸à¸“à¹à¸ªà¸”à¸‡à¹ƒà¸™à¹„à¸”à¹€à¸£à¸à¸—à¸­à¸£à¸µà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¹à¸¥à¹‰à¸§",
  "Admin verification is system-controlled.": "à¸à¸²à¸£ verify à¹‚à¸”à¸¢à¹à¸­à¸”à¸¡à¸´à¸™à¹€à¸›à¹‡à¸™à¸„à¹ˆà¸²à¸—à¸µà¹ˆà¸£à¸°à¸šà¸šà¸„à¸§à¸šà¸„à¸¸à¸¡",
  "Your public builder identity on Nexus.": "à¸•à¸±à¸§à¸•à¸™ builder à¸ªà¸²à¸˜à¸²à¸£à¸“à¸°à¸‚à¸­à¸‡à¸„à¸¸à¸“à¸šà¸™ Nexus",
  "Admin overview": "à¸ à¸²à¸žà¸£à¸§à¸¡à¹à¸­à¸”à¸¡à¸´à¸™",
  "Marketplace control center.": "à¸¨à¸¹à¸™à¸¢à¹Œà¸„à¸§à¸šà¸„à¸¸à¸¡à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Review products, orders, developer submissions, buyer automations, contact messages, waitlist signups, and finance signals from one launch-ready command view.": "à¸•à¸£à¸§à¸ˆà¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ à¸­à¸­à¹€à¸”à¸­à¸£à¹Œ à¸‡à¸²à¸™à¸—à¸µà¹ˆà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸ªà¹ˆà¸‡ à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­ à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸´à¸”à¸•à¹ˆà¸­ waitlist à¹à¸¥à¸°à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹„à¸Ÿà¹à¸™à¸™à¸‹à¹Œà¸ˆà¸²à¸à¸«à¸™à¹‰à¸² command view à¸—à¸µà¹ˆà¸žà¸£à¹‰à¸­à¸¡ launch",
  "Review products": "à¸•à¸£à¸§à¸ˆà¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ",
  "Open messages": "à¹€à¸›à¸´à¸”à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡",
  "Launch metrics": "à¸•à¸±à¸§à¹€à¸¥à¸‚ launch",
  "Fast readout of marketplace content, developers, orders, and support load.": "à¸”à¸¹à¸ à¸²à¸žà¸£à¸§à¸¡à¸„à¸­à¸™à¹€à¸—à¸™à¸•à¹Œà¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ à¸­à¸­à¹€à¸”à¸­à¸£à¹Œ à¹à¸¥à¸°à¹‚à¸«à¸¥à¸”à¸‹à¸±à¸žà¸žà¸­à¸£à¹Œà¸•à¸­à¸¢à¹ˆà¸²à¸‡à¸£à¸§à¸”à¹€à¸£à¹‡à¸§",
  "Total products": "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸—à¸±à¹‰à¸‡à¸«à¸¡à¸”",
  "Live products": "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸—à¸µà¹ˆ live",
  "Pending reviews": "à¸£à¸µà¸§à¸´à¸§à¸—à¸µà¹ˆà¸£à¸­à¸•à¸£à¸§à¸ˆ",
  "Contact messages": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸´à¸”à¸•à¹ˆà¸­",
  "Checkout prep": "à¹€à¸•à¸£à¸µà¸¢à¸¡à¹€à¸Šà¹‡à¸à¹€à¸­à¸²à¸•à¹Œ",
  "What to handle next": "à¸ªà¸´à¹ˆà¸‡à¸—à¸µà¹ˆà¸„à¸§à¸£à¸ˆà¸±à¸”à¸à¸²à¸£à¸•à¹ˆà¸­",
  "Use these cards for the daily admin flow during MVP launch.": "à¹ƒà¸Šà¹‰à¸à¸²à¸£à¹Œà¸”à¹€à¸«à¸¥à¹ˆà¸²à¸™à¸µà¹‰à¸ªà¸³à¸«à¸£à¸±à¸šà¹‚à¸Ÿà¸¥à¸§à¹Œà¹à¸­à¸”à¸¡à¸´à¸™à¸£à¸²à¸¢à¸§à¸±à¸™à¸Šà¹ˆà¸§à¸‡ MVP launch",
  "All orders": "à¸­à¸­à¹€à¸”à¸­à¸£à¹Œà¸—à¸±à¹‰à¸‡à¸«à¸¡à¸”",
  "Review paid orders, guided install requests, pending checkouts, and completed installs.": "à¸•à¸£à¸§à¸ˆà¸­à¸­à¹€à¸”à¸­à¸£à¹Œà¸—à¸µà¹ˆà¸ˆà¹ˆà¸²à¸¢à¹à¸¥à¹‰à¸§ à¸£à¸µà¹€à¸„à¸§à¸ªà¸•à¹Œà¹„à¸à¸”à¹Œà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡ à¹€à¸Šà¹‡à¸à¹€à¸­à¸²à¸•à¹Œà¸—à¸µà¹ˆà¸£à¸­ à¹à¸¥à¸° install à¸—à¸µà¹ˆà¹€à¸ªà¸£à¹‡à¸ˆà¹à¸¥à¹‰à¸§",
  "Product review queue": "à¸„à¸´à¸§à¸•à¸£à¸§à¸ˆà¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ",
  "Approve or reject developer-submitted products before they go live.": "à¸­à¸™à¸¸à¸¡à¸±à¸•à¸´à¸«à¸£à¸·à¸­à¸›à¸à¸´à¹€à¸ªà¸˜à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸—à¸µà¹ˆà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸ªà¹ˆà¸‡à¸à¹ˆà¸­à¸™à¸‚à¸¶à¹‰à¸™ live",
  "Customer automations": "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™à¸¥à¸¹à¸à¸„à¹‰à¸²",
  "Track setup status, runtime status, cancellation requests, and product issues.": "à¸•à¸´à¸”à¸•à¸²à¸¡à¸ªà¸–à¸²à¸™à¸°à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž à¸ªà¸–à¸²à¸™à¸°à¸£à¸±à¸™à¹„à¸—à¸¡à¹Œ à¸£à¸µà¹€à¸„à¸§à¸ªà¸•à¹Œà¸¢à¸à¹€à¸¥à¸´à¸ à¹à¸¥à¸°à¸›à¸±à¸à¸«à¸²à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ",
  "Messages and inquiries": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¹à¸¥à¸°à¸­à¸´à¸™à¹„à¸„à¸§à¸£à¸µ",
  "Handle contact forms, custom requests, buyer messages, and developer conversations.": "à¸ˆà¸±à¸”à¸à¸²à¸£à¸Ÿà¸­à¸£à¹Œà¸¡à¸•à¸´à¸”à¸•à¹ˆà¸­ à¸„à¸±à¸ªà¸•à¸­à¸¡à¸£à¸µà¹€à¸„à¸§à¸ªà¸•à¹Œ à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­ à¹à¸¥à¸°à¸šà¸—à¸ªà¸™à¸—à¸™à¸²à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "Marketplace management": "à¸à¸²à¸£à¸ˆà¸±à¸”à¸à¸²à¸£à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Create content, tune trust signals, review finance, and manage onboarding.": "à¸ªà¸£à¹‰à¸²à¸‡à¸„à¸­à¸™à¹€à¸—à¸™à¸•à¹Œ à¸›à¸£à¸±à¸š trust signal à¸•à¸£à¸§à¸ˆà¹„à¸Ÿà¹à¸™à¸™à¸‹à¹Œ à¹à¸¥à¸°à¸ˆà¸±à¸”à¸à¸²à¸£ onboarding",
  "Product management": "à¸ˆà¸±à¸”à¸à¸²à¸£à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ",
  "Create, edit, pause, delete, sync, and preview automation products.": "à¸ªà¸£à¹‰à¸²à¸‡ à¹à¸à¹‰à¹„à¸‚ à¸žà¸±à¸ à¸¥à¸š sync à¹à¸¥à¸°à¸žà¸£à¸µà¸§à¸´à¸§à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™",
  "Revenue overview": "à¸ à¸²à¸žà¸£à¸§à¸¡à¸£à¸²à¸¢à¹„à¸”à¹‰",
  "Review Nexus revenue, developer earnings, and transfer status when payments are enabled.": "à¸”à¸¹à¸£à¸²à¸¢à¹„à¸”à¹‰ Nexus à¸£à¸²à¸¢à¹„à¸”à¹‰à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ à¹à¸¥à¸°à¸ªà¸–à¸²à¸™à¸° transfer à¹€à¸¡à¸·à¹ˆà¸­à¹€à¸›à¸´à¸”à¸£à¸°à¸šà¸šà¸ˆà¹ˆà¸²à¸¢à¹€à¸‡à¸´à¸™",
  "Developer waitlist": "à¹€à¸§à¸•à¸¥à¸´à¸ªà¸•à¹Œà¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ",
  "See new developer interest before opening the platform broadly.": "à¸”à¸¹à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸—à¸µà¹ˆà¸ªà¸™à¹ƒà¸ˆà¸à¹ˆà¸­à¸™à¹€à¸›à¸´à¸”à¹à¸žà¸¥à¸•à¸Ÿà¸­à¸£à¹Œà¸¡à¸à¸§à¹‰à¸²à¸‡à¸‚à¸¶à¹‰à¸™"
});

Object.assign(LITERAL_TRANSLATIONS_TH, {
  "Loading product listing...": "à¸à¸³à¸¥à¸±à¸‡à¹‚à¸«à¸¥à¸”à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ listing...",
  "Nexus is loading a live marketplace product card so this section works like the real buyer experience.": "Nexus à¸à¸³à¸¥à¸±à¸‡à¹‚à¸«à¸¥à¸”à¸à¸²à¸£à¹Œà¸”à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸ˆà¸£à¸´à¸‡à¸ˆà¸²à¸à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª à¹€à¸žà¸·à¹ˆà¸­à¹ƒà¸«à¹‰à¸ªà¹ˆà¸§à¸™à¸™à¸µà¹‰à¸—à¸³à¸‡à¸²à¸™à¹€à¸«à¸¡à¸·à¸­à¸™à¸›à¸£à¸°à¸ªà¸šà¸à¸²à¸£à¸“à¹Œà¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­à¸ˆà¸£à¸´à¸‡",
  "Marketplace product": "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª",
  "Loading...": "à¸à¸³à¸¥à¸±à¸‡à¹‚à¸«à¸¥à¸”...",
  "Standard product": "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸¡à¸²à¸•à¸£à¸à¸²à¸™",
  "Custom request": "à¸„à¸±à¸ªà¸•à¸­à¸¡à¸£à¸µà¹€à¸„à¸§à¸ªà¸•à¹Œ",
  "One-time": "à¸ˆà¹ˆà¸²à¸¢à¸„à¸£à¸±à¹‰à¸‡à¹€à¸”à¸µà¸¢à¸§",
  "Monthly": "à¸£à¸²à¸¢à¹€à¸”à¸·à¸­à¸™",
  "Setup fee": "à¸„à¹ˆà¸²à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž",
  "Custom quote": "à¹€à¸ªà¸™à¸­à¸£à¸²à¸„à¸²à¹à¸šà¸šà¸„à¸±à¸ªà¸•à¸­à¸¡",
  "Active": "à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¸­à¸¢à¸¹à¹ˆ",
  "Draft": "à¸”à¸£à¸²à¸Ÿà¸•à¹Œ",
  "Paused": "à¸žà¸±à¸à¹„à¸§à¹‰",
  "Pending": "à¸£à¸­à¸”à¸³à¹€à¸™à¸´à¸™à¸à¸²à¸£",
  "Approved": "à¸­à¸™à¸¸à¸¡à¸±à¸•à¸´à¹à¸¥à¹‰à¸§",
  "Rejected": "à¸›à¸à¸´à¹€à¸ªà¸˜à¹à¸¥à¹‰à¸§"
});

Object.assign(LITERAL_TRANSLATIONS_TH, {
  "Buyer conversations": "à¸šà¸—à¸ªà¸™à¸—à¸™à¸²à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "Buyer messages": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "Platform conversations": "à¸šà¸—à¸ªà¸™à¸—à¸™à¸²à¹à¸žà¸¥à¸•à¸Ÿà¸­à¸£à¹Œà¸¡",
  "No platform messages yet": "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¹à¸žà¸¥à¸•à¸Ÿà¸­à¸£à¹Œà¸¡",
  "Buyer and developer conversations will appear here.": "à¸šà¸—à¸ªà¸™à¸—à¸™à¸²à¸‚à¸­à¸‡à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­à¹à¸¥à¸°à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸ˆà¸°à¹à¸ªà¸”à¸‡à¸—à¸µà¹ˆà¸™à¸µà¹ˆ",
  "No buyer messages yet": "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸ˆà¸²à¸à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "When buyers message you about products or your profile, the conversations will appear here.": "à¹€à¸¡à¸·à¹ˆà¸­à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­à¸ªà¹ˆà¸‡à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¹€à¸à¸µà¹ˆà¸¢à¸§à¸à¸±à¸šà¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œà¸«à¸£à¸·à¸­à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œà¸‚à¸­à¸‡à¸„à¸¸à¸“ à¸šà¸—à¸ªà¸™à¸—à¸™à¸²à¸ˆà¸°à¹à¸ªà¸”à¸‡à¸—à¸µà¹ˆà¸™à¸µà¹ˆ",
  "Messages with Nexus and developers will appear here.": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸à¸±à¸š Nexus à¹à¸¥à¸°à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œà¸ˆà¸°à¹à¸ªà¸”à¸‡à¸—à¸µà¹ˆà¸™à¸µà¹ˆ",
  "Loading messages...": "à¸à¸³à¸¥à¸±à¸‡à¹‚à¸«à¸¥à¸”à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡...",
  "Loading conversation...": "à¸à¸³à¸¥à¸±à¸‡à¹‚à¸«à¸¥à¸”à¸šà¸—à¸ªà¸™à¸—à¸™à¸²...",
  "Please wait while Nexus loads your messages.": "à¸à¸£à¸¸à¸“à¸²à¸£à¸­à¸ªà¸±à¸à¸„à¸£à¸¹à¹ˆà¸‚à¸“à¸°à¸—à¸µà¹ˆ Nexus à¹‚à¸«à¸¥à¸”à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸‚à¸­à¸‡à¸„à¸¸à¸“",
  "Could not load messages": "à¹‚à¸«à¸¥à¸”à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¹„à¸¡à¹ˆà¹„à¸”à¹‰",
  "Could not load conversation": "à¹‚à¸«à¸¥à¸”à¸šà¸—à¸ªà¸™à¸—à¸™à¸²à¹„à¸¡à¹ˆà¹„à¸”à¹‰",
  "Please refresh and try again.": "à¸à¸£à¸¸à¸“à¸²à¸£à¸µà¹€à¸Ÿà¸£à¸Šà¹à¸¥à¹‰à¸§à¸¥à¸­à¸‡à¸­à¸µà¸à¸„à¸£à¸±à¹‰à¸‡",
  "Please try again.": "à¸à¸£à¸¸à¸“à¸²à¸¥à¸­à¸‡à¸­à¸µà¸à¸„à¸£à¸±à¹‰à¸‡",
  "Platform message": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¹à¸žà¸¥à¸•à¸Ÿà¸­à¸£à¹Œà¸¡",
  "No messages yet.": "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡",
  "Write the first reply below.": "à¹€à¸‚à¸µà¸¢à¸™à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸­à¸šà¸à¸¥à¸±à¸šà¹à¸£à¸à¸”à¹‰à¸²à¸™à¸¥à¹ˆà¸²à¸‡",
  "Write a reply...": "à¹€à¸‚à¸µà¸¢à¸™à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸­à¸šà¸à¸¥à¸±à¸š...",
  "Send reply": "à¸ªà¹ˆà¸‡à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¸­à¸šà¸à¸¥à¸±à¸š",
  "Sending...": "à¸à¸³à¸¥à¸±à¸‡à¸ªà¹ˆà¸‡...",
  "Refresh": "à¸£à¸µà¹€à¸Ÿà¸£à¸Š",
  "Conversation": "à¸šà¸—à¸ªà¸™à¸—à¸™à¸²",
  "Conversations": "à¸šà¸—à¸ªà¸™à¸—à¸™à¸²",
  "Nexus": "Nexus",
  "Buyer": "à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­",
  "Developer": "à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ"
});

const THAI_GLOSSARY_REPLACEMENTS = [
  [/\bNexus Guided Install\b/g, "Nexus à¹„à¸à¸”à¹Œà¸•à¸´à¸”à¸•à¸±à¹‰à¸‡"],
  [/\bSelf-Serve Setup\b/g, "à¹€à¸‹à¸¥à¸Ÿà¹Œà¹€à¸‹à¸´à¸£à¹Œà¸Ÿà¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž"],
  [/\bSelf-serve\b/gi, "à¹€à¸‹à¸¥à¸Ÿà¹Œà¹€à¸‹à¸´à¸£à¹Œà¸Ÿ"],
  [/\bAI\b/g, "à¹€à¸­à¹„à¸­"],
  [/\bautomations\b/gi, "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™"],
  [/\bautomation\b/gi, "à¸­à¸­à¹‚à¸•à¹€à¸¡à¸Šà¸±à¸™"],
  [/\bworkflows\b/gi, "à¹€à¸§à¸´à¸£à¹Œà¸à¹‚à¸Ÿà¸¥à¸§à¹Œ"],
  [/\bworkflow\b/gi, "à¹€à¸§à¸´à¸£à¹Œà¸à¹‚à¸Ÿà¸¥à¸§à¹Œ"],
  [/\bmarketplace\b/gi, "à¸¡à¸²à¸£à¹Œà¹€à¸à¹‡à¸•à¹€à¸žà¸¥à¸ª"],
  [/\bdevelopers\b/gi, "à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ"],
  [/\bdeveloper\b/gi, "à¸”à¸µà¹€à¸§à¸¥à¸¥à¸­à¸›à¹€à¸›à¸­à¸£à¹Œ"],
  [/\bdashboard\b/gi, "à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”"],
  [/\bproducts\b/gi, "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ"],
  [/\bproduct\b/gi, "à¹‚à¸›à¸£à¸”à¸±à¸à¸•à¹Œ"],
  [/\bpreview\b/gi, "à¸žà¸£à¸µà¸§à¸´à¸§"],
  [/\bsetup\b/gi, "à¹€à¸‹à¹‡à¸•à¸­à¸±à¸ž"],
  [/\bcheckout\b/gi, "à¹€à¸Šà¹‡à¸à¹€à¸­à¸²à¸•à¹Œ"],
  [/\bcustom\b/gi, "à¸„à¸±à¸ªà¸•à¸­à¸¡"],
  [/\brequest\b/gi, "à¸£à¸µà¹€à¸„à¸§à¸ªà¸•à¹Œ"],
  [/\brequests\b/gi, "à¸£à¸µà¹€à¸„à¸§à¸ªà¸•à¹Œ"],
  [/\border\b/gi, "à¸­à¸­à¹€à¸”à¸­à¸£à¹Œ"],
  [/\borders\b/gi, "à¸­à¸­à¹€à¸”à¸­à¸£à¹Œ"],
  [/\bmessages\b/gi, "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡"],
  [/\bmessage\b/gi, "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡"],
  [/\bprofile\b/gi, "à¹‚à¸›à¸£à¹„à¸Ÿà¸¥à¹Œ"],
  [/\breviews\b/gi, "à¸£à¸µà¸§à¸´à¸§"],
  [/\breview\b/gi, "à¸£à¸µà¸§à¸´à¸§"],
  [/\bwallet\b/gi, "à¸§à¸­à¸¥à¹€à¸¥à¹‡à¸•"],
  [/\bfinance\b/gi, "à¹„à¸Ÿà¹à¸™à¸™à¸‹à¹Œ"],
  [/\blogin\b/gi, "à¸¥à¹‡à¸­à¸à¸­à¸´à¸™"],
  [/\blogout\b/gi, "à¸­à¸­à¸à¸ˆà¸²à¸à¸£à¸°à¸šà¸š"],
  [/\bbuyer\b/gi, "à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­"],
  [/\bbuyers\b/gi, "à¸œà¸¹à¹‰à¸‹à¸·à¹‰à¸­"],
  [/\badmin\b/gi, "à¹à¸­à¸”à¸¡à¸´à¸™"],
  [/\bStripe\b/g, "Stripe"],
  [/\bn8n\b/g, "n8n"],
  [/\bAPI\b/g, "API"],
  [/\bSupabase\b/g, "Supabase"]
];

const EXTRA_I18N = {
  th: {
    nav_home: "หน้าแรก",
    nav_marketplace: "มาร์เก็ตเพลส",
    nav_developers: "นักพัฒนา",
    nav_browse_developers: "ดูนักพัฒนา",
    nav_join_waitlist: "เข้าร่วมเวตลิสต์",
    nav_about: "เกี่ยวกับเรา",
    nav_contact: "ติดต่อ",
    nav_dashboard: "แดชบอร์ด",
    nav_admin: "แอดมิน",
    nav_login: "เข้าสู่ระบบ",
    nav_logout: "ออกจากระบบ",
    nav_currency: "สกุลเงิน",
    nav_language: "ภาษา",
    nav_toggle: "เปิดเมนู",
    common_browse_automations: "ดูออโตเมชัน",
    common_explore_marketplace: "ดูมาร์เก็ตเพลส",
    common_request_custom_automation: "ขอออโตเมชันแบบกำหนดเอง",
    common_join_developer_waitlist: "เข้าร่วมเวตลิสต์นักพัฒนา",
    common_get_support: "ติดต่อซัพพอร์ต",
    common_buy: "ซื้อ",
    common_preview: "พรีวิว",
    common_view: "ดู",
    common_view_setup: "ดูการตั้งค่า",
    common_view_output: "ดูเอาต์พุต",
    common_complete_setup: "ตั้งค่าให้เสร็จ",
    common_message_developer: "ส่งข้อความถึงนักพัฒนา",
    common_message_nexus: "ส่งข้อความถึง Nexus",
    dashboard_buyer_title: "แดชบอร์ดออโตเมชันของคุณ",
    dashboard_buyer_subtitle: "ติดตามออโตเมชัน ดูเอาต์พุต ตั้งค่า และตรวจสอบกิจกรรมสำคัญได้ในที่เดียว",
    dashboard_overview: "ภาพรวม",
    dashboard_automations: "ออโตเมชันของฉัน",
    dashboard_outputs: "เอาต์พุต",
    dashboard_activity: "กิจกรรม",
    dashboard_orders: "ออร์เดอร์",
    dashboard_messages: "ข้อความ"
  },
  zh: {
    nav_home: "首页",
    nav_marketplace: "市场",
    nav_developers: "开发者",
    nav_browse_developers: "浏览开发者",
    nav_join_waitlist: "加入候补名单",
    nav_about: "关于我们",
    nav_contact: "联系",
    nav_dashboard: "仪表盘",
    nav_admin: "管理员",
    nav_login: "登录",
    nav_logout: "退出",
    nav_currency: "货币",
    nav_language: "语言",
    nav_toggle: "打开菜单",
    common_explore_marketplace: "浏览市场",
    common_request_custom_automation: "请求定制自动化",
    common_buy: "购买",
    common_preview: "预览",
    common_view: "查看",
    dashboard_messages: "消息"
  },
  es: {
    nav_home: "Inicio",
    nav_marketplace: "Marketplace",
    nav_developers: "Desarrolladores",
    nav_browse_developers: "Ver desarrolladores",
    nav_join_waitlist: "Unirse a la lista",
    nav_about: "Acerca de",
    nav_contact: "Contacto",
    nav_dashboard: "Panel",
    nav_admin: "Admin",
    nav_login: "Iniciar sesión",
    nav_logout: "Cerrar sesión",
    nav_currency: "Moneda",
    nav_language: "Idioma",
    nav_toggle: "Abrir menú",
    common_explore_marketplace: "Explorar marketplace",
    common_request_custom_automation: "Solicitar automatización personalizada",
    common_buy: "Comprar",
    common_preview: "Vista previa",
    common_view: "Ver",
    dashboard_messages: "Mensajes"
  },
  hi: {
    nav_home: "होम",
    nav_marketplace: "मार्केटप्लेस",
    nav_developers: "डेवलपर",
    nav_browse_developers: "डेवलपर देखें",
    nav_join_waitlist: "वेटलिस्ट में जुड़ें",
    nav_about: "हमारे बारे में",
    nav_contact: "संपर्क",
    nav_dashboard: "डैशबोर्ड",
    nav_admin: "एडमिन",
    nav_login: "लॉगिन",
    nav_logout: "लॉगआउट",
    nav_currency: "मुद्रा",
    nav_language: "भाषा",
    nav_toggle: "मेनू खोलें",
    common_explore_marketplace: "मार्केटप्लेस देखें",
    common_request_custom_automation: "कस्टम ऑटोमेशन का अनुरोध करें",
    common_buy: "खरीदें",
    common_preview: "प्रीव्यू",
    common_view: "देखें",
    dashboard_messages: "संदेश"
  },
  ar: {
    nav_home: "الرئيسية",
    nav_marketplace: "السوق",
    nav_developers: "المطورون",
    nav_browse_developers: "تصفح المطورين",
    nav_join_waitlist: "انضم إلى قائمة الانتظار",
    nav_about: "من نحن",
    nav_contact: "تواصل",
    nav_dashboard: "لوحة التحكم",
    nav_admin: "المدير",
    nav_login: "تسجيل الدخول",
    nav_logout: "تسجيل الخروج",
    nav_currency: "العملة",
    nav_language: "اللغة",
    nav_toggle: "فتح القائمة",
    common_explore_marketplace: "تصفح السوق",
    common_request_custom_automation: "اطلب أتمتة مخصصة",
    common_buy: "شراء",
    common_preview: "معاينة",
    common_view: "عرض",
    dashboard_messages: "الرسائل"
  },
  fr: {
    nav_home: "Accueil",
    nav_marketplace: "Marketplace",
    nav_developers: "Développeurs",
    nav_browse_developers: "Voir les développeurs",
    nav_join_waitlist: "Rejoindre la liste",
    nav_about: "À propos",
    nav_contact: "Contact",
    nav_dashboard: "Tableau de bord",
    nav_admin: "Admin",
    nav_login: "Connexion",
    nav_logout: "Déconnexion",
    nav_currency: "Devise",
    nav_language: "Langue",
    nav_toggle: "Ouvrir le menu",
    common_explore_marketplace: "Explorer le marketplace",
    common_request_custom_automation: "Demander une automatisation personnalisée",
    common_buy: "Acheter",
    common_preview: "Aperçu",
    common_view: "Voir",
    dashboard_messages: "Messages"
  }
};

Object.entries(EXTRA_I18N).forEach(([language, values]) => {
  I18N[language] = {
    ...I18N.en,
    ...(I18N[language] || {}),
    ...values
  };
});

const LITERAL_TRANSLATIONS = {
  th: {
    "Solve business bottlenecks with ready-made automation.": "แก้คอขวดทางธุรกิจด้วยออโตเมชันสำเร็จรูป",
    "Explore marketplace": "ดูมาร์เก็ตเพลส",
    "How it works": "วิธีการทำงาน",
    "Find": "ค้นหา",
    "Understand": "เข้าใจ",
    "Set up": "ตั้งค่า",
    "Run": "ใช้งาน",
    "Businesses need outcomes, not another tool to manage.": "ธุรกิจต้องการผลลัพธ์ ไม่ใช่เครื่องมืออีกตัวที่ต้องดูแล",
    "Marketplace": "มาร์เก็ตเพลส",
    "Developers": "นักพัฒนา",
    "Contact": "ติดต่อ",
    "About": "เกี่ยวกับเรา",
    "Dashboard": "แดชบอร์ด",
    "Request custom automation": "ขอออโตเมชันแบบกำหนดเอง",
    "Product reviews": "รีวิวสินค้า",
    "Developer reviews": "รีวิวนักพัฒนา",
    "Verified purchase": "ซื้อจริง"
  },
  zh: {
    "Solve business bottlenecks with ready-made automation.": "用现成自动化解决业务瓶颈。",
    "Explore marketplace": "浏览市场",
    "How it works": "工作方式",
    "Find": "寻找",
    "Understand": "了解",
    "Set up": "设置",
    "Run": "运行",
    "Businesses need outcomes, not another tool to manage.": "企业需要结果，而不是另一个要管理的工具。",
    "Marketplace": "市场",
    "Developers": "开发者",
    "Contact": "联系",
    "About": "关于我们",
    "Dashboard": "仪表盘",
    "Request custom automation": "请求定制自动化",
    "Product reviews": "产品评价",
    "Developer reviews": "开发者评价",
    "Verified purchase": "已验证购买"
  },
  es: {
    "Solve business bottlenecks with ready-made automation.": "Resuelve cuellos de botella con automatizaciones listas para usar.",
    "Explore marketplace": "Explorar marketplace",
    "How it works": "Cómo funciona",
    "Find": "Encontrar",
    "Understand": "Entender",
    "Set up": "Configurar",
    "Run": "Ejecutar",
    "Businesses need outcomes, not another tool to manage.": "Las empresas necesitan resultados, no otra herramienta que gestionar.",
    "Marketplace": "Marketplace",
    "Developers": "Desarrolladores",
    "Contact": "Contacto",
    "About": "Acerca de",
    "Dashboard": "Panel",
    "Request custom automation": "Solicitar automatización personalizada",
    "Product reviews": "Reseñas del producto",
    "Developer reviews": "Reseñas del desarrollador",
    "Verified purchase": "Compra verificada"
  },
  hi: {
    "Solve business bottlenecks with ready-made automation.": "तैयार ऑटोमेशन से बिज़नेस bottlenecks हल करें।",
    "Explore marketplace": "मार्केटप्लेस देखें",
    "How it works": "यह कैसे काम करता है",
    "Find": "खोजें",
    "Understand": "समझें",
    "Set up": "सेटअप करें",
    "Run": "चलाएँ",
    "Businesses need outcomes, not another tool to manage.": "बिज़नेस को परिणाम चाहिए, संभालने के लिए एक और टूल नहीं।",
    "Marketplace": "मार्केटप्लेस",
    "Developers": "डेवलपर",
    "Contact": "संपर्क",
    "About": "हमारे बारे में",
    "Dashboard": "डैशबोर्ड",
    "Request custom automation": "कस्टम ऑटोमेशन का अनुरोध करें",
    "Product reviews": "प्रोडक्ट रिव्यू",
    "Developer reviews": "डेवलपर रिव्यू",
    "Verified purchase": "सत्यापित खरीद"
  },
  ar: {
    "Solve business bottlenecks with ready-made automation.": "حل اختناقات العمل باستخدام أتمتة جاهزة.",
    "Explore marketplace": "تصفح السوق",
    "How it works": "كيف يعمل",
    "Find": "ابحث",
    "Understand": "افهم",
    "Set up": "إعداد",
    "Run": "تشغيل",
    "Businesses need outcomes, not another tool to manage.": "الشركات تحتاج إلى نتائج، لا إلى أداة أخرى لإدارتها.",
    "Marketplace": "السوق",
    "Developers": "المطورون",
    "Contact": "تواصل",
    "About": "من نحن",
    "Dashboard": "لوحة التحكم",
    "Request custom automation": "اطلب أتمتة مخصصة",
    "Product reviews": "مراجعات المنتج",
    "Developer reviews": "مراجعات المطور",
    "Verified purchase": "عملية شراء مؤكدة"
  },
  fr: {
    "Solve business bottlenecks with ready-made automation.": "Résolvez les blocages métier avec des automatisations prêtes à l'emploi.",
    "Explore marketplace": "Explorer le marketplace",
    "How it works": "Comment ça marche",
    "Find": "Trouver",
    "Understand": "Comprendre",
    "Set up": "Configurer",
    "Run": "Lancer",
    "Businesses need outcomes, not another tool to manage.": "Les entreprises ont besoin de résultats, pas d'un outil de plus à gérer.",
    "Marketplace": "Marketplace",
    "Developers": "Développeurs",
    "Contact": "Contact",
    "About": "À propos",
    "Dashboard": "Tableau de bord",
    "Request custom automation": "Demander une automatisation personnalisée",
    "Product reviews": "Avis produit",
    "Developer reviews": "Avis développeur",
    "Verified purchase": "Achat vérifié"
  }
};

Object.assign(LITERAL_TRANSLATIONS.th, {
  "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus ช่วยทีมค้นหาออโตเมชันที่ใช้งานได้จริงสำหรับรายงาน ซัพพอร์ต งานปฏิบัติการ ฝ่ายขาย และเวิร์กโฟลว์ภายใน เลือกจากผลลัพธ์ที่ต้องการ พรีวิวสิ่งที่สินค้าส่งมอบ และเลือกเส้นทางเซ็ตอัพที่เหมาะกับทีมของคุณ",
  "Search by business issue, outcome, category, and setup path.": "ค้นหาตามปัญหาธุรกิจ ผลลัพธ์ หมวดหมู่ และเส้นทางเซ็ตอัพ",
  "See what the product does, what it needs, and what it produces.": "ดูว่าสินค้าทำอะไร ต้องใช้อะไร และสร้างเอาต์พุตอะไร",
  "Choose self-serve or Nexus guided setup based on complexity.": "เลือกเซ็ตอัพเองหรือให้ Nexus ไกด์เซ็ตอัพตามความซับซ้อน",
  "Move from manual work to a repeatable process your team can use.": "เปลี่ยนงานแมนนวลให้เป็นโปรเซสที่ทีมใช้งานซ้ำได้",
  "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "ทีมส่วนใหญ่ไม่ได้ขาดไอเดีย แต่ติดที่การลงมือทำ รายงานยังใช้เวลาหลายชั่วโมง คำถามลูกค้ายังซ้ำๆ การติดตามฝ่ายขายยังหลุด และการส่งต่องานภายในยังต้องให้คนคัดลอกข้อมูลระหว่างเครื่องมือ",
  "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus เปลี่ยนปัญหาที่เกิดซ้ำให้เป็นสินค้าบนมาร์เก็ตเพลสที่เข้าใจง่าย ทุกลิสติ้งอธิบายปัญหาธุรกิจที่แก้ เอาต์พุตที่ได้ สิ่งที่ต้องใช้ในการเซ็ตอัพ และทีมควรเซ็ตอัพเองหรือใช้ไกด์เซ็ตอัพ",
  "Old way": "วิธีเดิม",
  "Slow and unclear": "ช้าและไม่ชัดเจน",
  "Compare disconnected tools": "เทียบเครื่องมือที่ไม่เชื่อมกัน",
  "Buy software without seeing the outcome": "ซื้อซอฟต์แวร์โดยยังไม่เห็นผลลัพธ์",
  "Hire builders without a clear product": "จ้างคนทำโดยยังไม่มีสินค้าเป็นรูปธรรม",
  "Handle setup and errors alone": "จัดการเซ็ตอัพและข้อผิดพลาดเอง",
  "Keep manual workarounds running": "ยังต้องใช้วิธีแมนนวลต่อไป",
  "Nexus way": "วิธีของ Nexus",
  "Outcome-first and clear": "เริ่มจากผลลัพธ์และชัดเจน",
  "Browse by business issue": "เลือกดูตามปัญหาธุรกิจ",
  "Understand the output before setup": "เข้าใจเอาต์พุตก่อนเซ็ตอัพ",
  "Choose the right setup path upfront": "เลือกเส้นทางเซ็ตอัพที่เหมาะตั้งแต่แรก",
  "See who built or operates the product": "เห็นว่าใครสร้างหรือดูแลสินค้า",
  "Move toward a repeatable process": "เดินหน้าไปสู่โปรเซสที่ทำซ้ำได้",
  "From business issue to working process.": "จากปัญหาธุรกิจสู่โปรเซสที่ใช้งานจริง",
  "Nexus is designed so a business user can understand the solution before dealing with setup, payment, or technical implementation.": "Nexus ถูกออกแบบให้ผู้ใช้ธุรกิจเข้าใจโซลูชันก่อนต้องจัดการเซ็ตอัพ การชำระเงิน หรือรายละเอียดทางเทคนิค",
  "Search by outcome": "ค้นหาจากผลลัพธ์",
  "Browse products by business issue, department, pricing model, setup type, and expected result.": "เลือกดูสินค้าตามปัญหาธุรกิจ แผนก โมเดลราคา ประเภทเซ็ตอัพ และผลลัพธ์ที่คาดหวัง",
  "Review the listing": "รีวิวลิสติ้ง",
  "See what the product does, what it needs from you, what it outputs, and who operates it.": "ดูว่าสินค้าทำอะไร ต้องการอะไรจากคุณ สร้างเอาต์พุตอะไร และใครดูแล",
  "Choose the fit": "เลือกสิ่งที่เหมาะ",
  "Some products offer different versions for different team sizes, reporting styles, or workflows.": "บางสินค้ามีหลายเวอร์ชันสำหรับขนาดทีม รูปแบบรายงาน หรือเวิร์กโฟลว์ที่ต่างกัน",
  "Start setup": "เริ่มเซ็ตอัพ",
  "Choose self-serve when simple or Nexus guided setup when the process needs more care.": "เลือกเซ็ตอัพเองเมื่อง่าย หรือใช้ Nexus ไกด์เซ็ตอัพเมื่อโปรเซสต้องดูแลมากขึ้น",
  "Ready-made products for common business issues.": "สินค้าสำเร็จรูปสำหรับปัญหาธุรกิจที่พบบ่อย",
  "Browse productized solutions for reporting, customer support, lead handling, content operations, social listening, and internal team workflows.": "เลือกดูโซลูชันแบบโปรดักต์สำหรับรายงาน ซัพพอร์ตลูกค้า การจัดการลีด งานคอนเทนต์ โซเชียลลิสเทนนิ่ง และเวิร์กโฟลว์ภายในทีม",
  "View full marketplace": "ดูมาร์เก็ตเพลสทั้งหมด",
  "Every listing explains the outcome first.": "ทุกลิสติ้งอธิบายผลลัพธ์ก่อน",
  "Nexus listings are built for business decisions. A product should make it clear what problem it solves, what result it creates, what information is needed, and how setup will work.": "ลิสติ้งของ Nexus ถูกสร้างเพื่อการตัดสินใจทางธุรกิจ สินค้าควรบอกให้ชัดว่าแก้ปัญหาอะไร สร้างผลลัพธ์อะไร ต้องใช้ข้อมูลอะไร และเซ็ตอัพอย่างไร",
  "Clear output": "เอาต์พุตชัดเจน",
  "Reports, alerts, summaries, dashboards, replies, or workflow actions.": "รายงาน แจ้งเตือน สรุป แดชบอร์ด การตอบกลับ หรือแอคชันในเวิร์กโฟลว์",
  "Practical options": "ตัวเลือกที่ใช้ได้จริง",
  "Choose the version that fits your team, data, and working style.": "เลือกเวอร์ชันที่เหมาะกับทีม ข้อมูล และสไตล์การทำงาน",
  "Setup support": "ซัพพอร์ตเซ็ตอัพ",
  "Use self-serve for simple cases or guided setup for more complex ones.": "ใช้เซ็ตอัพเองสำหรับเคสง่าย หรือไกด์เซ็ตอัพสำหรับเคสที่ซับซ้อนกว่า",
  "A hub for businesses and automation builders.": "ฮับสำหรับธุรกิจและนักสร้างออโตเมชัน",
  "Nexus starts by helping businesses find useful solutions. As the platform grows, approved builders can list well-packaged products that solve specific operational problems.": "Nexus เริ่มจากการช่วยธุรกิจค้นหาโซลูชันที่มีประโยชน์ เมื่อแพลตฟอร์มเติบโต นักสร้างที่ได้รับอนุมัติจะลิสต์สินค้าที่แพ็กเกจดีและแก้ปัญหางานปฏิบัติการเฉพาะทางได้",
  "A marketplace for solving business problems with automation.": "มาร์เก็ตเพลสสำหรับแก้ปัญหาธุรกิจด้วยออโตเมชัน",
  "Nexus helps businesses find packaged solutions for repeat work, reporting, support, lead handling, internal operations, and customer workflows. The goal is simple: make useful automation easy to understand, buy, set up, and trust.": "Nexus ช่วยธุรกิจค้นหาโซลูชันที่แพ็กเกจแล้วสำหรับงานซ้ำ รายงาน ซัพพอร์ต การจัดการลีด งานภายใน และเวิร์กโฟลว์ลูกค้า เป้าหมายคือทำให้ออโตเมชันที่มีประโยชน์เข้าใจง่าย ซื้อได้ เซ็ตอัพได้ และน่าเชื่อถือ",
  "Talk to Nexus": "คุยกับ Nexus",
  "Buying automation is still too confusing.": "การซื้อออโตเมชันยังซับซ้อนเกินไป",
  "Most companies can point to the work that slows them down: reports, inboxes, handoffs, customer questions, follow-ups, and data updates. The hard part is turning those problems into a reliable process without wasting weeks comparing tools or managing a custom build.": "บริษัทส่วนใหญ่รู้ว่างานอะไรทำให้ช้า เช่น รายงาน อินบ็อกซ์ การส่งต่องาน คำถามลูกค้า การติดตาม และการอัปเดตข้อมูล ส่วนที่ยากคือการเปลี่ยนปัญหาเหล่านั้นให้เป็นโปรเซสที่เชื่อถือได้โดยไม่เสียเวลาหลายสัปดาห์ไปกับการเทียบเครื่องมือหรือดูแลการสร้างแบบคัสตอม",
  "Today, a business often has to choose between hiring an agency, buying another narrow tool, downloading a technical template, or building internally. Nexus creates a clearer path: productized solutions that explain the outcome and setup before you commit.": "วันนี้ธุรกิจมักต้องเลือกระหว่างจ้างเอเจนซี ซื้อเครื่องมือเฉพาะทาง ดาวน์โหลดเทมเพลตเทคนิค หรือสร้างเองภายใน Nexus ทำให้เส้นทางชัดขึ้นด้วยโซลูชันแบบโปรดักต์ที่อธิบายผลลัพธ์และการเซ็ตอัพก่อนตัดสินใจ",
  "Current market": "ตลาดปัจจุบัน",
  "Template libraries": "ไลบรารีเทมเพลต",
  "Useful for technical users, but risky for teams that cannot debug, host, or maintain them.": "มีประโยชน์สำหรับผู้ใช้เทคนิค แต่เสี่ยงสำหรับทีมที่ดีบัก โฮสต์ หรือดูแลเองไม่ได้",
  "Vague software tools": "ซอฟต์แวร์ที่ไม่ชัดเจน",
  "Many products sound impressive but do not clearly show what they deliver or how they fit daily operations.": "หลายสินค้าฟังดูดี แต่ไม่แสดงชัดว่าส่งมอบอะไรหรือเข้ากับงานประจำวันอย่างไร",
  "Custom agencies": "เอเจนซีคัสตอม",
  "Can work, but are often slow, expensive, and hard to compare before committing.": "ทำได้ แต่อาจช้า แพง และเทียบยากก่อนตัดสินใจ",
  "A marketplace layer that packages useful automations as understandable business products.": "เลเยอร์มาร์เก็ตเพลสที่แพ็กออโตเมชันให้เป็นสินค้าธุรกิจที่เข้าใจง่าย",
  "Tell us what business process you want to improve.": "บอกเราว่าคุณอยากปรับปรุงโปรเซสธุรกิจอะไร",
  "Use this page for product questions, custom process requests, setup support, partnerships, or builder access. Nexus routes each message into the admin inbox so the right person can review it and follow up.": "ใช้หน้านี้สำหรับคำถามสินค้า คำขอโปรเซสคัสตอม ซัพพอร์ตเซ็ตอัพ พาร์ตเนอร์ชิป หรือการเข้าถึงสำหรับนักสร้าง Nexus จะส่งทุกข้อความเข้าอินบ็อกซ์แอดมินเพื่อให้คนที่เหมาะสมรีวิวและติดตามต่อ",
  "Send a message": "ส่งข้อความ",
  "Browse marketplace": "ดูมาร์เก็ตเพลส",
  "For product questions, setup support, custom requests, and marketplace help.": "สำหรับคำถามสินค้า ซัพพอร์ตเซ็ตอัพ คำขอคัสตอม และความช่วยเหลือเกี่ยวกับมาร์เก็ตเพลส",
  "Available after intake": "ติดต่อได้หลังส่งรายละเอียด",
  "Share the request first so Nexus can route it to the right support path.": "ส่งรายละเอียดก่อนเพื่อให้ Nexus ส่งต่อไปยังเส้นทางซัพพอร์ตที่เหมาะสม",
  "Business process requests": "คำขอโปรเซสธุรกิจ",
  "Reports, support handoffs, operations tasks, lead follow-up, and internal workflows.": "รายงาน การส่งต่องานซัพพอร์ต งานปฏิบัติการ การติดตามลีด และเวิร์กโฟลว์ภายใน",
  "Within 1-2 business days": "ภายใน 1-2 วันทำการ",
  "For urgent setup or launch requests, mention the timeline clearly.": "สำหรับคำขอเซ็ตอัพหรือเปิดใช้งานเร่งด่วน โปรดระบุไทม์ไลน์ให้ชัดเจน",
  "Different requests need different next steps.": "คำขอต่างกันต้องใช้ขั้นตอนถัดไปที่ต่างกัน",
  "Nexus is a hub for solving recurring business problems. Choose the path that best matches what you need so the request can be reviewed quickly.": "Nexus เป็นฮับสำหรับแก้ปัญหาธุรกิจที่เกิดซ้ำ เลือกเส้นทางที่ตรงกับสิ่งที่ต้องการเพื่อให้รีวิวคำขอได้เร็วขึ้น",
  "Business buyer": "ผู้ซื้อธุรกิจ",
  "Custom process request": "คำขอโปรเซสคัสตอม",
  "Developer or builder": "นักพัฒนาหรือนักสร้าง",
  "Partnerships": "พาร์ตเนอร์ชิป",
  "Describe the process, the problem, and the outcome you want.": "อธิบายโปรเซส ปัญหา และผลลัพธ์ที่ต้องการ",
  "Keep it practical. Explain the manual work, the tools involved, how often it happens, and what should be produced when the process is working properly.": "เขียนให้ใช้งานได้จริง อธิบายงานแมนนวล เครื่องมือที่เกี่ยวข้อง ความถี่ที่เกิดขึ้น และสิ่งที่ควรได้เมื่อโปรเซสทำงานถูกต้อง",
  "For buyers": "สำหรับผู้ซื้อ",
  "For custom process requests": "สำหรับคำขอโปรเซสคัสตอม",
  "For developers": "สำหรับนักพัฒนา",
  "Contact form": "ฟอร์มติดต่อ",
  "Name": "ชื่อ",
  "Email": "อีเมล",
  "Company": "บริษัท",
  "Inquiry type": "ประเภทคำถาม",
  "What do you need?": "คุณต้องการอะไร",
  "Send message": "ส่งข้อความ",
  "Your message is saved into the Nexus admin dashboard for review and follow-up.": "ข้อความของคุณจะถูกบันทึกในแดชบอร์ดแอดมินของ Nexus เพื่อรีวิวและติดตามต่อ",
  "What should you write?": "ควรเขียนอะไร",
  "You do not need technical details. The most useful information is the business goal, the current manual process, and what output you want the finished process to produce.": "ไม่จำเป็นต้องมีรายละเอียดเทคนิค ข้อมูลที่มีประโยชน์ที่สุดคือเป้าหมายธุรกิจ โปรเซสแมนนวลปัจจุบัน และเอาต์พุตที่ต้องการจากโปรเซสที่ทำเสร็จแล้ว"
});

const COMMON_LITERAL_TRANSLATIONS = {
  th: {
    "Fix repeat work without managing the build.": "แก้งานซ้ำโดยไม่ต้องจัดการงานสร้างเอง",
    "Businesses should not need to learn workflow builders, debug API errors, or manage hosting to improve a process. Nexus helps teams compare products by outcome, setup effort, and trust.": "ธุรกิจไม่ควรต้องเรียนรู้เครื่องมือสร้างเวิร์กโฟลว์ ดีบัก API หรือจัดการโฮสติ้งเพื่อปรับปรุงโปรเซส Nexus ช่วยทีมเปรียบเทียบสินค้าจากผลลัพธ์ ความง่ายในการเซ็ตอัพ และความน่าเชื่อถือ",
    "Find products by business issue": "ค้นหาสินค้าตามปัญหาธุรกิจ",
    "Keep setup information in one place": "เก็บข้อมูลเซ็ตอัพไว้ที่เดียว",
    "Track orders and conversations from the dashboard": "ติดตามออร์เดอร์และบทสนทนาจากแดชบอร์ด",
    "Browse products": "ดูสินค้า",
    "Turn useful builds into repeatable products.": "เปลี่ยนงานที่มีประโยชน์ให้เป็นสินค้าที่ขายซ้ำได้",
    "Builders can package working solutions with clear outcomes, setup requirements, pricing, and support expectations instead of selling every project from scratch.": "นักสร้างสามารถแพ็กโซลูชันที่ใช้งานได้พร้อมผลลัพธ์ ข้อกำหนดเซ็ตอัพ ราคา และระดับซัพพอร์ตที่ชัดเจน แทนการขายทุกโปรเจกต์ใหม่ตั้งแต่ศูนย์",
    "Create a public builder profile": "สร้างโปรไฟล์นักสร้างสาธารณะ",
    "Submit products for review": "ส่งสินค้าให้รีวิว",
    "Explain outputs and setup needs": "อธิบายเอาต์พุตและสิ่งที่ต้องใช้ในการเซ็ตอัพ",
    "Message buyers in-platform": "ส่งข้อความหาผู้ซื้อในแพลตฟอร์ม",
    "Build trust through product quality": "สร้างความน่าเชื่อถือด้วยคุณภาพสินค้า",
    "Nexus becomes a trusted place to find what works.": "Nexus เป็นที่ที่น่าเชื่อถือสำหรับค้นหาสิ่งที่ใช้งานได้จริง",
    "Business software is crowded and hard to compare. Nexus creates structure around outcomes: product pages, previews, reviews, builder profiles, setup paths, and real buyer feedback.": "ซอฟต์แวร์ธุรกิจมีเยอะและเทียบยาก Nexus จัดโครงสร้างรอบผลลัพธ์: หน้าสินค้า พรีวิว รีวิว โปรไฟล์นักสร้าง เส้นทางเซ็ตอัพ และฟีดแบ็กจากผู้ซื้อจริง",
    "Over time, better listings and real feedback help teams choose with less risk. The marketplace becomes more useful as it learns which products fit which business problems.": "เมื่อเวลาผ่านไป ลิสติ้งที่ดีขึ้นและฟีดแบ็กจริงช่วยให้ทีมเลือกได้เสี่ยงน้อยลง มาร์เก็ตเพลสจะมีประโยชน์มากขึ้นเมื่อรู้ว่าสินค้าใดเหมาะกับปัญหาธุรกิจแบบไหน",
    "Trust Layer": "เลเยอร์ความน่าเชื่อถือ",
    "Products": "สินค้า",
    "Buyers": "ผู้ซื้อ",
    "Reviews": "รีวิว",
    "Recommendations": "คำแนะนำ",
    "Automation becomes packaged and understandable.": "ออโตเมชันถูกแพ็กให้เข้าใจง่าย",
    "Businesses compare real outcomes.": "ธุรกิจเปรียบเทียบผลลัพธ์จริง",
    "Results create marketplace confidence.": "ผลลัพธ์สร้างความมั่นใจให้มาร์เก็ตเพลส",
    "Nexus learns what works for each use case.": "Nexus เรียนรู้ว่าสิ่งใดใช้ได้กับแต่ละยูสเคส",
    "Built in phases so the foundation works first.": "สร้างเป็นเฟสเพื่อให้ฐานทำงานได้ก่อน",
    "Marketplace foundation": "ฐานมาร์เก็ตเพลส",
    "Payments and orders": "การชำระเงินและออร์เดอร์",
    "Accounts and dashboards": "บัญชีและแดชบอร์ด",
    "Hosted reliability layer": "เลเยอร์ความเสถียรแบบโฮสต์",
    "Start with a product or ask for a custom solution.": "เริ่มจากสินค้า หรือขอโซลูชันคัสตอม",
    "Contact Nexus": "ติดต่อ Nexus",
    "The trusted marketplace layer for business automation.": "เลเยอร์มาร์เก็ตเพลสที่น่าเชื่อถือสำหรับออโตเมชันธุรกิจ",
    "Developer Waitlist": "เวตลิสต์นักพัฒนา",
    "Privacy": "ความเป็นส่วนตัว",
    "Price": "ราคา",
    "Setup": "เซ็ตอัพ",
    "Buy": "ซื้อ",
    "Buy / choose setup": "ซื้อ / เลือกเซ็ตอัพ",
    "View profile": "ดูโปรไฟล์",
    "Ask Nexus": "ถาม Nexus",
    "Message developer": "ส่งข้อความถึงนักพัฒนา",
    "Problem it solves": "ปัญหาที่แก้",
    "Business outcome": "ผลลัพธ์ธุรกิจ",
    "Who this is for": "เหมาะกับใคร",
    "Outputs": "เอาต์พุต",
    "Required inputs": "ข้อมูลที่ต้องใช้",
    "Ready to use this automation?": "พร้อมใช้ออโตเมชันนี้หรือยัง?",
    "No live products yet": "ยังไม่มีสินค้าที่ไลฟ์",
    "No results": "ไม่พบผลลัพธ์",
    "Try changing the filters.": "ลองเปลี่ยนตัวกรอง",
    "Choose setup path": "เลือกเส้นทางเซ็ตอัพ",
    "Setup method": "วิธีเซ็ตอัพ",
    "Continue to secure payment": "ไปต่อเพื่อชำระเงินอย่างปลอดภัย",
    "Opening secure checkout...": "กำลังเปิดเช็กเอาต์ที่ปลอดภัย...",
    "Self-Serve Setup": "เซ็ตอัพเอง",
    "Nexus Guided Install": "Nexus ไกด์เซ็ตอัพ",
    "Fastest": "เร็วที่สุด",
    "Managed setup": "เซ็ตอัพแบบดูแลให้",
    "Best for complex cases": "เหมาะกับเคสซับซ้อน",
    "Developer profiles": "โปรไฟล์นักพัฒนา",
    "View profile": "ดูโปรไฟล์",
    "Developer not found": "ไม่พบนักพัฒนา",
    "Developer rating": "คะแนนนักพัฒนา",
    "Live products": "สินค้าที่ไลฟ์",
    "No live products yet.": "ยังไม่มีสินค้าที่ไลฟ์",
    "Review developer": "รีวิวนักพัฒนา",
    "Submit review": "ส่งรีวิว",
    "Cancel": "ยกเลิก",
    "Rating": "คะแนน",
    "Your role": "บทบาทของคุณ",
    "Review": "รีวิว",
    "No reviews yet": "ยังไม่มีรีวิว",
    "Loading products...": "กำลังโหลดสินค้า...",
    "Loading developers...": "กำลังโหลดนักพัฒนา..."
  },
  zh: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus 帮助团队找到适用于报表、支持、运营、销售和内部流程的实用自动化产品。按需要的结果浏览，预览交付内容，并选择适合团队的设置方式。",
    "Search by business issue, outcome, category, and setup path.": "按业务问题、结果、类别和设置方式搜索。",
    "See what the product does, what it needs, and what it produces.": "了解产品做什么、需要什么、会产出什么。",
    "Choose self-serve or Nexus guided setup based on complexity.": "根据复杂度选择自助设置或 Nexus 指导设置。",
    "Move from manual work to a repeatable process your team can use.": "把手工工作变成团队可重复使用的流程。",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "多数团队缺的不是想法，而是执行。报表仍要花数小时，客户问题重复出现，销售跟进容易遗漏，内部交接还依赖人工在工具之间复制信息。",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus 把这些重复问题变成清晰的市场产品。每个列表都会说明解决的业务问题、产生的输出、设置要求，以及团队适合自助还是指导设置。",
    "Slow and unclear": "缓慢且不清晰",
    "Compare disconnected tools": "比较彼此割裂的工具",
    "Buy software without seeing the outcome": "在看不到结果前购买软件",
    "Hire builders without a clear product": "在产品不清晰时雇人开发",
    "Handle setup and errors alone": "独自处理设置和错误",
    "Keep manual workarounds running": "继续依赖手工变通方案",
    "Outcome-first and clear": "以结果为先，清晰透明",
    "Browse by business issue": "按业务问题浏览",
    "Understand the output before setup": "设置前先了解输出",
    "Choose the right setup path upfront": "提前选择正确的设置方式",
    "See who built or operates the product": "查看谁构建或运营产品",
    "Move toward a repeatable process": "走向可重复流程",
    "From business issue to working process.": "从业务问题到可运行流程。",
    "Ready-made products for common business issues.": "面向常见业务问题的现成产品。",
    "Every listing explains the outcome first.": "每个列表都先说明结果。",
    "A hub for businesses and automation builders.": "面向企业和自动化构建者的中心。",
    "Price": "价格",
    "Setup": "设置",
    "Buy / choose setup": "购买 / 选择设置",
    "View profile": "查看资料",
    "Ask Nexus": "询问 Nexus",
    "Message developer": "联系开发者",
    "Problem it solves": "解决的问题",
    "Business outcome": "业务结果",
    "Who this is for": "适用对象",
    "Outputs": "输出",
    "Required inputs": "所需输入",
    "Ready to use this automation?": "准备使用这个自动化了吗？",
    "Choose setup path": "选择设置方式",
    "Setup method": "设置方式",
    "Continue to secure payment": "继续安全付款",
    "Self-Serve Setup": "自助设置",
    "Nexus Guided Install": "Nexus 指导安装",
    "Developer profiles": "开发者资料",
    "No reviews yet": "暂无评价",
    "Loading products...": "正在加载产品...",
    "Loading developers...": "正在加载开发者..."
  },
  es: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus ayuda a los equipos a encontrar automatizaciones prácticas para reportes, soporte, operaciones, ventas y flujos internos. Explora por el resultado que necesitas, previsualiza lo que entrega el producto y elige la configuración que encaja con tu equipo.",
    "Search by business issue, outcome, category, and setup path.": "Busca por problema de negocio, resultado, categoría y tipo de configuración.",
    "See what the product does, what it needs, and what it produces.": "Ve qué hace el producto, qué necesita y qué produce.",
    "Choose self-serve or Nexus guided setup based on complexity.": "Elige configuración self-serve o guiada por Nexus según la complejidad.",
    "Move from manual work to a repeatable process your team can use.": "Convierte trabajo manual en un proceso repetible para tu equipo.",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "La mayoría de los equipos no tienen un problema de ideas, tienen un problema de ejecución. Los reportes siguen tomando horas, las preguntas de clientes se repiten, el seguimiento comercial se pierde y los traspasos internos dependen de copiar información entre herramientas.",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus convierte esos problemas repetibles en productos claros de marketplace. Cada ficha explica el problema que resuelve, el resultado que crea, lo que requiere la configuración y si tu equipo puede hacerlo solo o necesita guía.",
    "Slow and unclear": "Lento y poco claro",
    "Compare disconnected tools": "Comparar herramientas desconectadas",
    "Buy software without seeing the outcome": "Comprar software sin ver el resultado",
    "Hire builders without a clear product": "Contratar builders sin un producto claro",
    "Handle setup and errors alone": "Gestionar configuración y errores solo",
    "Keep manual workarounds running": "Mantener soluciones manuales",
    "Outcome-first and clear": "Claro y orientado al resultado",
    "Browse by business issue": "Explorar por problema de negocio",
    "Understand the output before setup": "Entender el resultado antes de configurar",
    "Choose the right setup path upfront": "Elegir la configuración correcta desde el inicio",
    "See who built or operates the product": "Ver quién creó u opera el producto",
    "Move toward a repeatable process": "Avanzar hacia un proceso repetible",
    "From business issue to working process.": "Del problema de negocio al proceso funcionando.",
    "Ready-made products for common business issues.": "Productos listos para problemas comunes de negocio.",
    "Every listing explains the outcome first.": "Cada ficha explica primero el resultado.",
    "A hub for businesses and automation builders.": "Un hub para empresas y builders de automatización.",
    "Price": "Precio",
    "Setup": "Configuración",
    "Buy / choose setup": "Comprar / elegir configuración",
    "View profile": "Ver perfil",
    "Ask Nexus": "Preguntar a Nexus",
    "Message developer": "Enviar mensaje al desarrollador",
    "Problem it solves": "Problema que resuelve",
    "Business outcome": "Resultado de negocio",
    "Who this is for": "Para quién es",
    "Outputs": "Resultados",
    "Required inputs": "Datos necesarios",
    "Ready to use this automation?": "¿Listo para usar esta automatización?",
    "Choose setup path": "Elige configuración",
    "Setup method": "Método de configuración",
    "Continue to secure payment": "Continuar al pago seguro",
    "Self-Serve Setup": "Configuración self-serve",
    "Nexus Guided Install": "Instalación guiada por Nexus",
    "Developer profiles": "Perfiles de desarrolladores",
    "No reviews yet": "Aún no hay reseñas",
    "Loading products...": "Cargando productos...",
    "Loading developers...": "Cargando desarrolladores..."
  },
  hi: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus टीमों को reporting, support, operations, sales और internal workflows के लिए practical automation products खोजने में मदद करता है। जिस outcome की जरूरत है उसके हिसाब से browse करें, product क्या deliver करता है preview करें, और अपनी team के लिए सही setup path चुनें।",
    "Search by business issue, outcome, category, and setup path.": "Business issue, outcome, category और setup path से खोजें।",
    "See what the product does, what it needs, and what it produces.": "देखें product क्या करता है, क्या चाहिए, और क्या output देता है।",
    "Choose self-serve or Nexus guided setup based on complexity.": "Complexity के हिसाब से self-serve या Nexus guided setup चुनें।",
    "Move from manual work to a repeatable process your team can use.": "Manual work को आपकी team के लिए repeatable process में बदलें।",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "ज्यादातर teams के पास ideas की कमी नहीं होती, execution की समस्या होती है। Reports में अब भी घंटे लगते हैं, customer questions repeat होते हैं, sales follow-up छूटता है, और internal handoffs tools के बीच copy-paste पर निर्भर रहते हैं।",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus इन repeatable problems को clear marketplace products में बदलता है। हर listing बताती है कि कौन सा business issue solve होता है, कौन सा output मिलता है, setup में क्या चाहिए, और team self-serve कर सकती है या guided setup चाहिए।",
    "Slow and unclear": "धीमा और अस्पष्ट",
    "Compare disconnected tools": "Disconnected tools की तुलना",
    "Buy software without seeing the outcome": "Outcome देखे बिना software खरीदना",
    "Hire builders without a clear product": "Clear product के बिना builders hire करना",
    "Handle setup and errors alone": "Setup और errors अकेले संभालना",
    "Keep manual workarounds running": "Manual workarounds चलाते रहना",
    "Outcome-first and clear": "Outcome-first और clear",
    "Browse by business issue": "Business issue से browse करें",
    "Understand the output before setup": "Setup से पहले output समझें",
    "Choose the right setup path upfront": "पहले से सही setup path चुनें",
    "See who built or operates the product": "देखें product किसने बनाया या operate किया",
    "Move toward a repeatable process": "Repeatable process की ओर बढ़ें",
    "From business issue to working process.": "Business issue से working process तक।",
    "Ready-made products for common business issues.": "Common business issues के लिए ready-made products.",
    "Every listing explains the outcome first.": "हर listing पहले outcome समझाती है।",
    "A hub for businesses and automation builders.": "Businesses और automation builders के लिए hub.",
    "Price": "कीमत",
    "Setup": "सेटअप",
    "Buy / choose setup": "खरीदें / setup चुनें",
    "View profile": "प्रोफाइल देखें",
    "Ask Nexus": "Nexus से पूछें",
    "Message developer": "डेवलपर को message करें",
    "Problem it solves": "यह जो समस्या हल करता है",
    "Business outcome": "Business outcome",
    "Who this is for": "यह किसके लिए है",
    "Outputs": "Outputs",
    "Required inputs": "जरूरी inputs",
    "Ready to use this automation?": "क्या आप यह automation इस्तेमाल करने के लिए ready हैं?",
    "Choose setup path": "Setup path चुनें",
    "Setup method": "Setup method",
    "Continue to secure payment": "Secure payment पर जाएं",
    "Self-Serve Setup": "Self-serve setup",
    "Nexus Guided Install": "Nexus guided install",
    "Developer profiles": "Developer profiles",
    "No reviews yet": "अभी reviews नहीं हैं",
    "Loading products...": "Products load हो रहे हैं...",
    "Loading developers...": "Developers load हो रहे हैं..."
  },
  ar: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "يساعد Nexus الفرق على العثور على منتجات أتمتة عملية للتقارير والدعم والعمليات والمبيعات وسير العمل الداخلي. تصفح حسب النتيجة المطلوبة، شاهد ما يقدمه المنتج، واختر مسار الإعداد المناسب لفريقك.",
    "Search by business issue, outcome, category, and setup path.": "ابحث حسب مشكلة العمل أو النتيجة أو الفئة أو مسار الإعداد.",
    "See what the product does, what it needs, and what it produces.": "اعرف ما يفعله المنتج وما يحتاجه وما ينتجه.",
    "Choose self-serve or Nexus guided setup based on complexity.": "اختر الإعداد الذاتي أو الإعداد الموجه من Nexus حسب درجة التعقيد.",
    "Move from manual work to a repeatable process your team can use.": "حوّل العمل اليدوي إلى عملية قابلة للتكرار يستخدمها فريقك.",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "معظم الفرق لا تعاني من نقص الأفكار، بل من صعوبة التنفيذ. التقارير ما زالت تستغرق ساعات، أسئلة العملاء تتكرر، متابعة المبيعات تفلت، والتسليمات الداخلية تعتمد على نسخ المعلومات بين الأدوات.",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "يحوّل Nexus هذه المشاكل المتكررة إلى منتجات واضحة في السوق. كل قائمة تشرح مشكلة العمل التي تحلها، والمخرجات التي تنشئها، ومتطلبات الإعداد، وما إذا كان فريقك يستطيع الإعداد ذاتيًا أو يحتاج إلى إعداد موجه.",
    "Slow and unclear": "بطيء وغير واضح",
    "Compare disconnected tools": "مقارنة أدوات غير مترابطة",
    "Buy software without seeing the outcome": "شراء برنامج دون رؤية النتيجة",
    "Hire builders without a clear product": "توظيف منفذين دون منتج واضح",
    "Handle setup and errors alone": "التعامل مع الإعداد والأخطاء وحدك",
    "Keep manual workarounds running": "الاستمرار في حلول يدوية مؤقتة",
    "Outcome-first and clear": "واضح ويركز على النتيجة أولاً",
    "Browse by business issue": "تصفح حسب مشكلة العمل",
    "Understand the output before setup": "افهم المخرجات قبل الإعداد",
    "Choose the right setup path upfront": "اختر مسار الإعداد الصحيح من البداية",
    "See who built or operates the product": "اعرف من بنى المنتج أو يديره",
    "Move toward a repeatable process": "انتقل إلى عملية قابلة للتكرار",
    "From business issue to working process.": "من مشكلة عمل إلى عملية تعمل.",
    "Ready-made products for common business issues.": "منتجات جاهزة لمشاكل العمل الشائعة.",
    "Every listing explains the outcome first.": "كل قائمة تشرح النتيجة أولاً.",
    "A hub for businesses and automation builders.": "مركز للشركات وبناة الأتمتة.",
    "Price": "السعر",
    "Setup": "الإعداد",
    "Buy / choose setup": "شراء / اختيار الإعداد",
    "View profile": "عرض الملف",
    "Ask Nexus": "اسأل Nexus",
    "Message developer": "مراسلة المطور",
    "Problem it solves": "المشكلة التي يحلها",
    "Business outcome": "نتيجة العمل",
    "Who this is for": "لمن هذا المنتج",
    "Outputs": "المخرجات",
    "Required inputs": "المدخلات المطلوبة",
    "Ready to use this automation?": "هل أنت جاهز لاستخدام هذه الأتمتة؟",
    "Choose setup path": "اختر مسار الإعداد",
    "Setup method": "طريقة الإعداد",
    "Continue to secure payment": "المتابعة إلى الدفع الآمن",
    "Self-Serve Setup": "إعداد ذاتي",
    "Nexus Guided Install": "تثبيت موجه من Nexus",
    "Developer profiles": "ملفات المطورين",
    "No reviews yet": "لا توجد مراجعات بعد",
    "Loading products...": "جاري تحميل المنتجات...",
    "Loading developers...": "جاري تحميل المطورين..."
  },
  fr: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus aide les équipes à trouver des automatisations pratiques pour les rapports, le support, les opérations, les ventes et les workflows internes. Parcourez selon le résultat recherché, prévisualisez ce que le produit livre et choisissez le mode de configuration adapté.",
    "Search by business issue, outcome, category, and setup path.": "Recherchez par problème métier, résultat, catégorie et mode de configuration.",
    "See what the product does, what it needs, and what it produces.": "Voyez ce que le produit fait, ce dont il a besoin et ce qu’il produit.",
    "Choose self-serve or Nexus guided setup based on complexity.": "Choisissez le self-serve ou l’installation guidée Nexus selon la complexité.",
    "Move from manual work to a repeatable process your team can use.": "Passez du travail manuel à un processus répétable pour votre équipe.",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "La plupart des équipes ne manquent pas d’idées, elles ont un problème d’exécution. Les rapports prennent encore des heures, les questions clients se répètent, le suivi commercial glisse et les transmissions internes reposent encore sur du copier-coller entre outils.",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus transforme ces problèmes répétitifs en produits marketplace clairs. Chaque fiche explique le problème métier résolu, le résultat créé, les besoins de configuration et si l’équipe peut se débrouiller seule ou doit être accompagnée.",
    "Slow and unclear": "Lent et peu clair",
    "Compare disconnected tools": "Comparer des outils déconnectés",
    "Buy software without seeing the outcome": "Acheter un logiciel sans voir le résultat",
    "Hire builders without a clear product": "Engager des builders sans produit clair",
    "Handle setup and errors alone": "Gérer seul la configuration et les erreurs",
    "Keep manual workarounds running": "Continuer avec des contournements manuels",
    "Outcome-first and clear": "Clair et orienté résultat",
    "Browse by business issue": "Parcourir par problème métier",
    "Understand the output before setup": "Comprendre le résultat avant configuration",
    "Choose the right setup path upfront": "Choisir le bon mode dès le départ",
    "See who built or operates the product": "Voir qui construit ou opère le produit",
    "Move toward a repeatable process": "Avancer vers un processus répétable",
    "From business issue to working process.": "Du problème métier au processus opérationnel.",
    "Ready-made products for common business issues.": "Produits prêts à l’emploi pour problèmes métier courants.",
    "Every listing explains the outcome first.": "Chaque fiche explique d’abord le résultat.",
    "A hub for businesses and automation builders.": "Un hub pour les entreprises et les builders d’automatisation.",
    "Price": "Prix",
    "Setup": "Configuration",
    "Buy / choose setup": "Acheter / choisir la configuration",
    "View profile": "Voir le profil",
    "Ask Nexus": "Demander à Nexus",
    "Message developer": "Message au développeur",
    "Problem it solves": "Problème résolu",
    "Business outcome": "Résultat métier",
    "Who this is for": "Pour qui",
    "Outputs": "Résultats",
    "Required inputs": "Entrées requises",
    "Ready to use this automation?": "Prêt à utiliser cette automatisation ?",
    "Choose setup path": "Choisir le mode de configuration",
    "Setup method": "Méthode de configuration",
    "Continue to secure payment": "Continuer vers le paiement sécurisé",
    "Self-Serve Setup": "Configuration self-serve",
    "Nexus Guided Install": "Installation guidée Nexus",
    "Developer profiles": "Profils développeurs",
    "No reviews yet": "Aucun avis pour l’instant",
    "Loading products...": "Chargement des produits...",
    "Loading developers...": "Chargement des développeurs..."
  }
};

Object.entries(COMMON_LITERAL_TRANSLATIONS).forEach(([language, values]) => {
  LITERAL_TRANSLATIONS[language] = {
    ...(LITERAL_TRANSLATIONS[language] || {}),
    ...values
  };
});

const LANGUAGE_GLOSSARY_REPLACEMENTS = {
  th: [
    [/\bautomation\b/gi, "ออโตเมชัน"],
    [/\bautomations\b/gi, "ออโตเมชัน"],
    [/\bworkflow\b/gi, "เวิร์กโฟลว์"],
    [/\bworkflows\b/gi, "เวิร์กโฟลว์"],
    [/\bmarketplace\b/gi, "มาร์เก็ตเพลส"],
    [/\bdeveloper\b/gi, "นักพัฒนา"],
    [/\bdevelopers\b/gi, "นักพัฒนา"],
    [/\bdashboard\b/gi, "แดชบอร์ด"],
    [/\breview\b/gi, "รีวิว"],
    [/\breviews\b/gi, "รีวิว"],
    [/\bsetup\b/gi, "เซ็ตอัพ"],
    [/\bproduct\b/gi, "สินค้า"],
    [/\bproducts\b/gi, "สินค้า"]
  ],
  es: [
    [/\bautomation\b/gi, "automatización"],
    [/\bautomations\b/gi, "automatizaciones"],
    [/\bworkflow\b/gi, "flujo de trabajo"],
    [/\bworkflows\b/gi, "flujos de trabajo"],
    [/\bmarketplace\b/gi, "marketplace"],
    [/\bdashboard\b/gi, "panel"],
    [/\bproduct\b/gi, "producto"],
    [/\bproducts\b/gi, "productos"],
    [/\bsetup\b/gi, "configuración"],
    [/\breview\b/gi, "reseña"],
    [/\breviews\b/gi, "reseñas"]
  ],
  fr: [
    [/\bautomation\b/gi, "automatisation"],
    [/\bautomations\b/gi, "automatisations"],
    [/\bworkflow\b/gi, "workflow"],
    [/\bworkflows\b/gi, "workflows"],
    [/\bmarketplace\b/gi, "marketplace"],
    [/\bdashboard\b/gi, "tableau de bord"],
    [/\bproduct\b/gi, "produit"],
    [/\bproducts\b/gi, "produits"],
    [/\bsetup\b/gi, "configuration"],
    [/\breview\b/gi, "avis"],
    [/\breviews\b/gi, "avis"]
  ],
  zh: [
    [/\bautomation\b/gi, "自动化"],
    [/\bautomations\b/gi, "自动化"],
    [/\bworkflow\b/gi, "工作流"],
    [/\bworkflows\b/gi, "工作流"],
    [/\bmarketplace\b/gi, "市场"],
    [/\bdashboard\b/gi, "仪表盘"],
    [/\bdeveloper\b/gi, "开发者"],
    [/\bdevelopers\b/gi, "开发者"],
    [/\bproduct\b/gi, "产品"],
    [/\bproducts\b/gi, "产品"],
    [/\bsetup\b/gi, "设置"],
    [/\breview\b/gi, "评价"],
    [/\breviews\b/gi, "评价"]
  ],
  hi: [
    [/\bautomation\b/gi, "ऑटोमेशन"],
    [/\bautomations\b/gi, "ऑटोमेशन"],
    [/\bworkflow\b/gi, "वर्कफ़्लो"],
    [/\bworkflows\b/gi, "वर्कफ़्लो"],
    [/\bmarketplace\b/gi, "मार्केटप्लेस"],
    [/\bdashboard\b/gi, "डैशबोर्ड"],
    [/\bdeveloper\b/gi, "डेवलपर"],
    [/\bdevelopers\b/gi, "डेवलपर"],
    [/\bproduct\b/gi, "प्रोडक्ट"],
    [/\bproducts\b/gi, "प्रोडक्ट"],
    [/\bsetup\b/gi, "सेटअप"],
    [/\breview\b/gi, "रिव्यू"],
    [/\breviews\b/gi, "रिव्यू"]
  ],
  ar: [
    [/\bautomation\b/gi, "الأتمتة"],
    [/\bautomations\b/gi, "الأتمتة"],
    [/\bworkflow\b/gi, "سير العمل"],
    [/\bworkflows\b/gi, "سير العمل"],
    [/\bmarketplace\b/gi, "السوق"],
    [/\bdashboard\b/gi, "لوحة التحكم"],
    [/\bdeveloper\b/gi, "المطور"],
    [/\bdevelopers\b/gi, "المطورون"],
    [/\bproduct\b/gi, "المنتج"],
    [/\bproducts\b/gi, "المنتجات"],
    [/\bsetup\b/gi, "الإعداد"],
    [/\breview\b/gi, "مراجعة"],
    [/\breviews\b/gi, "مراجعات"]
  ]
};

function normalizeLanguage(language) {
  const normalized = String(language || "en").toLowerCase();
  return SUPPORTED_LANGUAGES.includes(normalized) ? normalized : "en";
}

function getLanguage() {
  const requested = normalizeLanguage(q("lang"));

  if (q("lang")) {
    persistLanguage(requested);
    return requested;
  }

  try {
    const stored = normalizeLanguage(localStorage.getItem("nexus_language") || sessionStorage.getItem("nexus_language"));

    if (stored) {
      document.documentElement.lang = stored;
      document.documentElement.dir = RTL_LANGUAGES.includes(stored) ? "rtl" : "ltr";
      return stored;
    }
  } catch {
    // Fall through to cookie/default.
  }

  const cookieLanguage = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("nexus_language="))
    ?.split("=")[1];

  const normalized = normalizeLanguage(cookieLanguage);

  document.documentElement.lang = normalized;
  document.documentElement.dir = RTL_LANGUAGES.includes(normalized) ? "rtl" : "ltr";
  return normalized;
}

function persistLanguage(language) {
  const normalized = normalizeLanguage(language);

  try {
    localStorage.setItem("nexus_language", normalized);
    sessionStorage.setItem("nexus_language", normalized);
  } catch {
    // Cookie is still a durable fallback.
  }

  document.cookie = `nexus_language=${normalized};path=/;max-age=31536000;SameSite=Lax`;
  document.documentElement.lang = normalized;
  document.documentElement.dir = RTL_LANGUAGES.includes(normalized) ? "rtl" : "ltr";
}

function updateCurrentUrlLanguage(language) {
  if (!window.history?.replaceState) return;

  try {
    const url = new URL(window.location.href);

    const normalized = normalizeLanguage(language);

    if (normalized !== "en") {
      url.searchParams.set("lang", normalized);
    } else {
      url.searchParams.delete("lang");
    }

    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Some local/file URLs cannot be rewritten safely.
  }
}

function localizedInternalUrl(href, language = getLanguage()) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
    return href;
  }

  try {
    const url = new URL(href, location.origin);

    if (url.origin !== location.origin) return href;

    const normalized = normalizeLanguage(language);

    if (normalized !== "en") {
      url.searchParams.set("lang", normalized);
    } else {
      url.searchParams.delete("lang");
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

function localizeInternalLinks(root = document) {
  const language = getLanguage();
  const scope = root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE
    ? root
    : document;

  const links = [
    ...(scope.matches?.("a[href]") ? [scope] : []),
    ...scope.querySelectorAll("a[href]")
  ];

  links.forEach((link) => {
    const href = link.getAttribute("href") || "";
    link.setAttribute("href", localizedInternalUrl(href, language));
  });
}

function refreshLanguageState(language = getLanguage(), options = {}) {
  const normalized = normalizeLanguage(language);

  persistLanguage(normalized);
  updateCurrentUrlLanguage(normalized);

  document.querySelectorAll(".language-select").forEach((select) => {
    select.value = normalized;
  });

  if (options.force || normalized !== "en") {
    applyTranslations(document.body || document);
  }

  if (options.force || normalized !== "en" || lastLocalizedLinkLanguage !== "en") {
    localizeInternalLinks(document.body || document);
  }

  lastLocalizedLinkLanguage = normalized;

  if (normalized !== "en") {
    startTranslationObserver();
  } else {
    stopTranslationObserver();
  }
}

function setLanguage(language) {
  const normalized = normalizeLanguage(language);

  refreshLanguageState(normalized, { force: true });

  if (typeof mountGlobalNav === "function") {
    mountGlobalNav({ force: true });
  }

  document.dispatchEvent(new CustomEvent("languagechange", {
    detail: {
      language: normalized
    }
  }));
}

function startLanguageNavigationGuard() {
  if (languageNavigationGuardStarted) return;

  languageNavigationGuardStarted = true;

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = event.target.closest?.("a[href]");
    if (!link || link.target || link.hasAttribute("download")) return;

    const href = link.getAttribute("href") || "";
    const localizedHref = localizedInternalUrl(href);

    if (localizedHref && localizedHref !== href) {
      link.setAttribute("href", localizedHref);
    }
  }, true);
}

function t(key, fallback) {
  const language = getLanguage();
  return I18N[language]?.[key] || I18N.en[key] || fallback || key;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function getRecordTranslation(record, language = getLanguage()) {
  if (!record || language === "en") return {};
  const translations = parseJsonObject(record.translations);
  return parseJsonObject(translations[language]);
}

function localizeRecord(record, field, fallback = "") {
  if (!record) return fallback || "";
  const translated = getRecordTranslation(record)[field];

  if (translated !== undefined && translated !== null && String(translated).trim() !== "") {
    return translated;
  }

  const value = record[field];
  return value !== undefined && value !== null && value !== "" ? value : fallback || "";
}

function localizeArray(record, field) {
  const translated = getRecordTranslation(record)[field];
  if (Array.isArray(translated)) return translated;
  const value = record?.[field];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function localizeSchema(record, field) {
  const translated = getRecordTranslation(record)[field];
  if (Array.isArray(translated)) return translated;
  return Array.isArray(record?.[field]) ? record[field] : [];
}

function localizeCustomization(product, customization, index = 0) {
  const translated = getRecordTranslation(product).customizations?.[index] || {};
  return {
    ...customization,
    ...Object.fromEntries(
      Object.entries(translated).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    )
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function translateLiteral(value, language = getLanguage()) {
  const original = String(value || "");
  const normalized = normalizeText(original);
  const activeLanguage = normalizeLanguage(language);

  if (!normalized || activeLanguage === "en") return original;

  const exact = LITERAL_TRANSLATIONS[activeLanguage]?.[normalized] || "";
  if (exact) return exact;

  const glossary = LANGUAGE_GLOSSARY_REPLACEMENTS[activeLanguage] ||
    (activeLanguage === "th" ? THAI_GLOSSARY_REPLACEMENTS : []);

  const fallback = glossary.reduce((text, [pattern, replacement]) => {
    return text.replace(pattern, replacement);
  }, original);

  return fallback !== original ? fallback : original;
}

function l(value, fallback = "") {
  const raw = value !== undefined && value !== null && value !== "" ? value : fallback;
  return translateLiteral(raw);
}

function scheduleAutoTranslation() {}

function shouldSkipTextNode(node) {
  const parent = node?.parentElement;
  if (!parent) return true;

  const tag = parent.tagName;
  if (["SCRIPT", "STYLE", "SELECT", "OPTION", "CODE", "PRE"].includes(tag)) {
    return true;
  }

  if (parent.closest?.("[data-no-i18n], select, option, .currency-select-wrap, .language-select-wrap, .html-preview-frame, .preview-window iframe")) {
    return true;
  }

  if (parent.closest?.("[data-i18n], [data-i18n-html]")) {
    return true;
  }

  return false;
}

function shouldSkipElementTranslation(element) {
  if (!element) return true;
  const tag = element.tagName;

  if (["SCRIPT", "STYLE", "SELECT", "OPTION", "CODE", "PRE"].includes(tag)) {
    return true;
  }

  return Boolean(element.closest?.("[data-no-i18n], select, option, .currency-select-wrap, .language-select-wrap, .html-preview-frame, .preview-window iframe"));
}

function languageSwitch() {
  const language = getLanguage();

  return `
    <label class="language-select-wrap" aria-label="${escapeAttribute(t("nav_language"))}" data-no-i18n="true">
      <select class="language-select" onchange="NexusUI.setLanguage(this.value)" data-no-i18n="true">
        ${LANGUAGE_OPTIONS.map((item) => `
          <option value="${item.code}" ${language === item.code ? "selected" : ""} data-no-i18n="true">${item.label}</option>
        `).join("")}
      </select>
    </label>
  `;
}

function applyTranslations(root = document) {
  if (!root || isApplyingTranslations) return;

  isApplyingTranslations = true;

  try {
    const scope = root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE
      ? root
      : document;
    const language = getLanguage();

    const textElements = [
      ...(scope.matches?.("[data-i18n]") ? [scope] : []),
      ...scope.querySelectorAll("[data-i18n]")
    ];

    textElements.forEach((element) => {
      if (shouldSkipElementTranslation(element)) return;
      const key = element.dataset.i18n;
      const source = I18N.en[key] || element.dataset.originalI18nText || element.textContent || "";
      const translated = t(key, source);
      element.dataset.originalI18nText = source;

      const autoElement = autoTranslatedElements.get(element);
      if (
        language !== "en" &&
        translated === source &&
        autoElement?.language === language &&
        autoElement?.original === source
      ) {
        element.textContent = autoElement.translated;
        return;
      }

      element.textContent = translated;

      if (language !== "en" && translated === source) {
        scheduleAutoTranslation({
          type: "element",
          element,
          original: source,
          language
        });
      }
    });

    const htmlElements = [
      ...(scope.matches?.("[data-i18n-html]") ? [scope] : []),
      ...scope.querySelectorAll("[data-i18n-html]")
    ];

    htmlElements.forEach((element) => {
      if (shouldSkipElementTranslation(element)) return;
      const key = element.dataset.i18nHtml;
      element.innerHTML = t(key, element.innerHTML);
    });

    [
      ["placeholder", "i18nPlaceholder"],
      ["title", "i18nTitle"],
      ["aria-label", "i18nAriaLabel"]
    ].forEach(([attribute, datasetKey]) => {
      const selector = `[data-${datasetKey.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}]`;
      const elements = [
        ...(scope.matches?.(selector) ? [scope] : []),
        ...scope.querySelectorAll(selector)
      ];

      elements.forEach((element) => {
        if (shouldSkipElementTranslation(element)) return;
        const key = element.dataset[datasetKey];
        const source = I18N.en[key] || element.getAttribute(attribute) || "";
        const translated = t(key, source);

        const autoAttribute = autoTranslatedAttributes.get(element)?.[attribute];
        if (
          language !== "en" &&
          translated === source &&
          autoAttribute?.language === language &&
          autoAttribute?.original === source
        ) {
          element.setAttribute(attribute, autoAttribute.translated);
          return;
        }

        element.setAttribute(attribute, translated);

        if (language !== "en" && translated === source) {
          let stored = originalAttributeValues.get(element);
          if (!stored) {
            stored = {};
            originalAttributeValues.set(element, stored);
          }
          stored[attribute] = source;

          scheduleAutoTranslation({
            type: "attribute",
            element,
            attribute,
            original: source,
            language
          });
        }
      });
    });

    ["placeholder", "title", "aria-label"].forEach((attribute) => {
      const dataAttribute = `data-i18n-${attribute}`;
      const selector = `[${attribute}]`;
      const elements = [
        ...(scope.matches?.(selector) ? [scope] : []),
        ...scope.querySelectorAll(selector)
      ];

      elements.forEach((element) => {
        if (shouldSkipElementTranslation(element)) return;
        if (element.hasAttribute(dataAttribute)) return;

        let stored = originalAttributeValues.get(element);
        if (!stored) {
          stored = {};
          originalAttributeValues.set(element, stored);
        }

        if (!(attribute in stored)) {
          stored[attribute] = element.getAttribute(attribute) || "";
        }

        const original = stored[attribute] || "";
        const translated = language !== "en" ? translateLiteral(original, language) : original;

        const autoAttribute = autoTranslatedAttributes.get(element)?.[attribute];
        if (
          language !== "en" &&
          translated === original &&
          autoAttribute?.language === language &&
          autoAttribute?.original === original
        ) {
          element.setAttribute(attribute, autoAttribute.translated);
          return;
        }

        element.setAttribute(attribute, translated);

        if (language !== "en") {
          scheduleAutoTranslation({
            type: "attribute",
            element,
            attribute,
            original,
            language
          });
        }
      });
    });

    const walker = document.createTreeWalker(
      scope,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (shouldSkipTextNode(node)) return NodeFilter.FILTER_REJECT;
          if (!normalizeText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      if (!originalTextNodes.has(node)) {
        originalTextNodes.set(node, node.nodeValue || "");
      }

      const original = originalTextNodes.get(node) || "";
      const translated = language !== "en" ? translateLiteral(original, language) : original;

      const autoText = autoTranslatedTextNodes.get(node);
      if (
        language !== "en" &&
        translated === original &&
        autoText?.language === language &&
        autoText?.original === original
      ) {
        node.nodeValue = autoText.translated;
        return;
      }

      node.nodeValue = translated;

      if (language !== "en") {
        scheduleAutoTranslation({
          type: "text",
          node,
          original,
          language
        });
      }
    });
  } finally {
    isApplyingTranslations = false;
  }
}

function stopTranslationObserver() {
  if (!translationObserver) return;
  translationObserver.disconnect();
  translationObserver = null;
}

function startTranslationObserver() {
  // Dynamic sections call applyTranslations after they render. Avoid a global
  // observer because it repeatedly walks the whole page and slows routing.
  stopTranslationObserver();
}

async function getNavDestination(active = "") {
  const loginUrl = "/pages/buyer/login.html";

  const hasNexusDB = typeof NexusDB !== "undefined";

  if (!hasNexusDB) {
    return {
      label: t("nav_login"),
      href: loginUrl,
      action: "login",
      isAdmin: false,
      isLoggedIn: false
    };
  }

  try {
    let user = null;

    if (typeof NexusDB.getSession === "function") {
      const result = await NexusDB.getSession();
      user = result?.data?.session?.user || null;
    }

    if (!user && typeof NexusDB.getUser === "function") {
      const result = await NexusDB.getUser();
      user = result?.data || null;
    }

    if (!user) {
      return {
        label: t("nav_login"),
        href: loginUrl,
        action: "login",
        isAdmin: false,
        isLoggedIn: false
      };
    }

    /*
      On dashboard/admin pages, logged-in users should see Logout.
      On public pages, logged-in users should see Dashboard/Admin.
    */
    const isAccountArea =
      active === "dashboard" ||
      active === "admin" ||
      document.body.dataset.page === "buyer-dashboard" ||
      document.body.dataset.page === "developer-dashboard" ||
      String(location.pathname || "").includes("/dashboard") ||
      document.body.dataset.admin === "true";

    if (isAccountArea) {
      return {
        label: t("nav_logout"),
        href: "#",
        action: "logout",
        isAdmin: false,
        isLoggedIn: true
      };
    }

    let profile = null;

    if (typeof NexusDB.getProfile === "function") {
      const result = await NexusDB.getProfile(user.id);
      profile = result?.data || null;
    }

    const isAdmin = profile?.role === "admin";
    const isDeveloper = profile?.role === "developer";

    if (isAdmin) {
      return {
        label: t("nav_admin"),
        href: "/pages/admin/dashboard.html",
        action: "admin",
        isAdmin: true,
        isLoggedIn: true
      };
    }

    if (isDeveloper) {
      return {
        label: t("nav_dashboard"),
        href: "/pages/developer/dashboard.html",
        action: "dashboard",
        isAdmin: false,
        isLoggedIn: true
      };
    }

    return {
      label: t("nav_dashboard"),
      href: "/pages/buyer/dashboard.html",
      action: "dashboard",
      isAdmin: false,
      isLoggedIn: true
    };
  } catch (error) {
    console.warn("Could not resolve nav account button:", error);

    return {
      label: t("nav_login"),
      href: loginUrl,
      action: "login",
      isAdmin: false,
      isLoggedIn: false
    };
  }
}

function isCompactAccountNav(active = "") {
  const path = String(location.pathname || "");

  return (
    active === "dashboard" ||
    active === "admin" ||
    document.body?.dataset?.admin === "true" ||
    document.body?.dataset?.page === "buyer-dashboard" ||
    document.body?.dataset?.page === "developer-dashboard" ||
    path.includes("/pages/buyer/") ||
    path.includes("/pages/developer/") ||
    path.includes("/pages/admin/")
  );
}

function globalNav(active = "") {
  const compactAccountNav = isCompactAccountNav(active);
  const developerNav = compactAccountNav
    ? `
        <a class="nav-link ${active === "developers" ? "active" : ""}" href="/pages/developers/index.html" data-i18n="nav_developers">
          ${t("nav_developers")}
        </a>
      `
    : `
        <div class="nav-dropdown ${active === "developers" || active === "developer-waitlist" ? "active" : ""}">
          <button class="nav-link nav-dropdown-trigger" type="button" aria-haspopup="true">
            <span data-i18n="nav_developers">${t("nav_developers")}</span>
            <span class="nav-dropdown-caret" aria-hidden="true">&#9662;</span>
          </button>

          <div class="nav-dropdown-menu" role="menu">
            <a href="/pages/developers/index.html" role="menuitem" data-i18n="nav_browse_developers">
              ${t("nav_browse_developers")}
            </a>
            <a href="/pages/developers/waitlist.html" role="menuitem" data-i18n="nav_join_waitlist">
              ${t("nav_join_waitlist")}
            </a>
          </div>
        </div>
      `;

  return `
    <div class="container nav">
      <a class="logo" href="/index.html">
        <span>Nexus&nbsp;</span>
      </a>

      <button
        class="mobile-nav-toggle"
        id="mobileNavToggle"
        type="button"
        onclick="NexusUI.toggleMobileNav()"
        aria-expanded="false"
        aria-controls="globalNavLinks"
        aria-label="${escapeAttribute(t("nav_toggle", "Toggle navigation"))}"
      >
        &#9776;
      </button>

      <nav class="nav-links" id="globalNavLinks">
        ${
          compactAccountNav
            ? `
              <a class="nav-link ${active === "home" ? "active" : ""}" href="/index.html" data-i18n="nav_home">
                ${t("nav_home")}
              </a>
            `
            : ""
        }

        <a class="nav-link ${active === "marketplace" ? "active" : ""}" href="/pages/marketplace/index.html" data-i18n="nav_marketplace">
          ${t("nav_marketplace")}
        </a>

        ${developerNav}

        ${
          compactAccountNav
            ? ""
            : `
              <a class="nav-link ${active === "about" ? "active" : ""}" href="/pages/about/index.html" data-i18n="nav_about">
                ${t("nav_about")}
              </a>
            `
        }

        <a class="nav-link ${active === "contact" ? "active" : ""}" href="/pages/contact/index.html" data-i18n="nav_contact">
          ${t("nav_contact")}
        </a>

        <div class="nav-controls">
          ${currencySwitch()}
        </div>

        <a class="btn btn-secondary btn-small" id="navAccountButton" href="/pages/buyer/login.html">
          ${t("nav_login")}
        </a>
      </nav>
    </div>
  `;
}

async function mountGlobalNav(options = {}) {
  let header = document.getElementById("globalNav");

  if (!header) {
    header = document.querySelector(".site-header");
    if (header) header.id = "globalNav";
  }

  if (!header) return;

  const active = header.dataset.active || document.body.dataset.page || "";
  const language = getLanguage();

  if (
    !options.force &&
    header.dataset.nexusNavMounted === "true" &&
    header.dataset.nexusNavActive === active &&
    header.dataset.nexusNavLanguage === language
  ) {
    return;
  }

  header.innerHTML = globalNav(active);

  /*
    Wait briefly for nexus-db.js if the page loads scripts in different order.
  */
  if (typeof NexusDB === "undefined") {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const isAdminShell = active === "admin" || document.body.dataset.admin === "true";
  const account = isAdminShell
    ? {
        label: t("nav_logout"),
        href: "#",
        action: "logout",
        isAdmin: true,
        isLoggedIn: true
      }
    : await getNavDestination(active);
  const accountButton = document.getElementById("navAccountButton");

if (accountButton) {
  accountButton.textContent = account.label;
  accountButton.href = account.href;

  accountButton.classList.remove("btn-primary", "btn-secondary", "btn-danger");

  if (account.action === "dashboard" || account.action === "admin") {
    accountButton.classList.add("btn-primary");
  } else if (account.action === "logout") {
    accountButton.classList.add("btn-secondary");
  } else {
    accountButton.classList.add("btn-secondary");
  }

  if (account.action === "logout") {
      accountButton.onclick = async function (event) {
        event.preventDefault();

        if (typeof NexusDB !== "undefined" && typeof NexusDB.signOut === "function") {
          await NexusDB.signOut();
        }

        window.location.href = "/index.html";
      };
    } else {
      accountButton.onclick = null;
    }
  }

  applyTranslations(header);
  localizeInternalLinks(header);

  const nav = document.getElementById("globalNavLinks");
  const toggle = document.getElementById("mobileNavToggle");

  nav?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      toggle?.setAttribute("aria-expanded", "false");
      document.body.classList.remove("mobile-nav-open");
    });
  });

  if (!mobileNavDismissGuardStarted) {
    mobileNavDismissGuardStarted = true;

    document.addEventListener("click", (event) => {
      const currentNav = document.getElementById("globalNavLinks");
      const currentToggle = document.getElementById("mobileNavToggle");

      if (!currentNav?.classList.contains("open")) return;
      if (currentNav.contains(event.target) || currentToggle?.contains(event.target)) return;

      currentNav.classList.remove("open");
      currentToggle?.setAttribute("aria-expanded", "false");
      document.body.classList.remove("mobile-nav-open");
    });
  }

  header.dataset.nexusNavMounted = "true";
  header.dataset.nexusNavActive = active;
  header.dataset.nexusNavLanguage = language;
}

function toggleMobileNav() {
  const nav = document.getElementById("globalNavLinks");
  const toggle = document.getElementById("mobileNavToggle");
  if (!nav) return;

  const isOpen = nav.classList.toggle("open");
  toggle?.setAttribute("aria-expanded", isOpen ? "true" : "false");
  document.body.classList.toggle("mobile-nav-open", isOpen);
}

let activeMessageThreadId = "";
const messageCenters = new WeakMap();

function threadDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
}

function senderLabel(role) {
  const normalized = String(role || "").toLowerCase();
  if (normalized === "admin") return "Nexus";
  if (normalized === "developer") return "Developer";
  if (normalized === "buyer") return "Buyer";
  return "Message";
}

function threadUnreadCount(thread, viewerRole = "") {
  const role = String(viewerRole || "").toLowerCase();
  if (role === "admin") return Number(thread.admin_unread_count || 0);
  if (role === "developer") return Number(thread.developer_unread_count || 0);
  return Number(thread.buyer_unread_count || 0);
}

function threadSubtitle(thread = {}) {
  return [
    thread.automations?.title,
    thread.developers?.display_name,
    thread.source
  ].filter(Boolean).join(" | ");
}

function threadEmptyCopy(viewerRole = "") {
  if (viewerRole === "admin") {
    return {
      title: "No platform messages yet",
      body: "Buyer and developer conversations will appear here."
    };
  }

  if (viewerRole === "developer") {
    return {
      title: "No buyer messages yet",
      body: "When buyers message you about products or your profile, the conversations will appear here."
    };
  }

  return {
    title: "No messages yet",
    body: "Messages with Nexus and developers will appear here."
  };
}

function renderThreadList(threads = [], state = {}) {
  if (!threads.length) {
    const empty = threadEmptyCopy(state.viewerRole);
    return `
      <div class="message-center-empty">
        <h3>${escapeHtml(empty.title)}</h3>
        <p>${escapeHtml(empty.body)}</p>
      </div>
    `;
  }

  return threads.map((thread) => {
    const unread = threadUnreadCount(thread, state.viewerRole);
    const isActive = state.activeThreadId === thread.id;
    return `
      <button
        class="message-thread-item ${isActive ? "active" : ""} ${unread ? "unread" : ""}"
        type="button"
        data-thread-id="${escapeAttribute(thread.id || "")}"
      >
        <span class="message-thread-main">
          <strong>${escapeHtml(thread.subject || "Conversation")}</strong>
          <small>${escapeHtml(threadSubtitle(thread) || "Platform message")}</small>
          <p>${escapeHtml(thread.last_message_preview || "No messages yet.")}</p>
        </span>

        <span class="message-thread-meta">
          ${unread ? `<b>${unread}</b>` : ""}
          <small>${escapeHtml(threadDate(thread.last_message_at || thread.updated_at || thread.created_at))}</small>
        </span>
      </button>
    `;
  }).join("");
}

function renderMessageList(messages = []) {
  if (!messages.length) {
    return `
      <div class="message-center-empty">
        <h3>No messages yet</h3>
        <p>Write the first reply below.</p>
      </div>
    `;
  }

  return messages.map((message) => `
    <article class="message-bubble ${escapeAttribute(message.sender_role || "")}">
      <div>
        <strong>${escapeHtml(senderLabel(message.sender_role))}</strong>
        <span>${escapeHtml(threadDate(message.created_at))}</span>
      </div>
      <p>${escapeHtml(message.body || "")}</p>
    </article>
  `).join("");
}

async function loadMessageCenter(root, requestedThreadId = "") {
  const state = messageCenters.get(root) || {};

  root.innerHTML = `
    <div class="message-center">
      <aside class="message-center-list">
        <div class="message-center-loading">Loading messages...</div>
      </aside>
      <section class="message-center-detail">
        <div class="message-center-empty">
          <h3>Loading conversation...</h3>
          <p>Please wait while Nexus loads your messages.</p>
        </div>
      </section>
    </div>
  `;

  const { data, error } = await NexusDB.listMessageThreads();

  if (error) {
    root.innerHTML = `
      <div class="message-center-error">
        <h3>Could not load messages</h3>
        <p>${escapeHtml(error.message || "Please refresh and try again.")}</p>
      </div>
    `;
    return;
  }

  const threads = data?.threads || [];
  const activeThreadId = requestedThreadId || state.activeThreadId || threads[0]?.id || "";

  messageCenters.set(root, {
    ...state,
    threads,
    activeThreadId
  });

  await renderMessageCenter(root);
}

async function renderMessageCenter(root) {
  const state = messageCenters.get(root) || {};
  const threads = state.threads || [];
  const activeThreadId = state.activeThreadId || "";
  const activeThread = threads.find((thread) => thread.id === activeThreadId) || null;

  root.innerHTML = `
    <div class="message-center">
      <aside class="message-center-list">
        <div class="message-center-head">
          <div>
            <span class="eyebrow">Messages</span>
            <h3>${escapeHtml(state.title || "Conversations")}</h3>
          </div>
          <button class="btn btn-secondary btn-small" type="button" data-message-refresh>Refresh</button>
        </div>
        <div class="message-thread-list">
          ${renderThreadList(threads, state)}
        </div>
      </aside>

      <section class="message-center-detail">
        ${
          activeThread
            ? `
              <div class="message-detail-head">
                <div>
                  <span class="${escapeAttribute(activeThread.status === "closed" ? "pill" : "pill blue")}">
                    ${escapeHtml(activeThread.status || "open")}
                  </span>
                  <h3>${escapeHtml(activeThread.subject || "Conversation")}</h3>
                  <p>${escapeHtml(threadSubtitle(activeThread) || "Platform message")}</p>
                </div>
              </div>
              <div class="message-center-messages" data-message-bodies>
                <div class="message-center-loading">Loading conversation...</div>
              </div>
              <form class="message-center-reply" data-message-reply>
                <textarea class="textarea" name="message" placeholder="Write a reply..." required></textarea>
                <button class="btn btn-primary" type="submit">Send reply</button>
              </form>
            `
            : `
              <div class="message-center-empty">
                <h3>${escapeHtml(threadEmptyCopy(state.viewerRole).title)}</h3>
                <p>${escapeHtml(threadEmptyCopy(state.viewerRole).body)}</p>
              </div>
            `
        }
      </section>
    </div>
  `;

  root.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextState = messageCenters.get(root) || {};
      nextState.activeThreadId = button.dataset.threadId || "";
      messageCenters.set(root, nextState);
      await renderMessageCenter(root);
    });
  });

  root.querySelector("[data-message-refresh]")?.addEventListener("click", async () => {
    await loadMessageCenter(root, activeThreadId);
  });

  const replyForm = root.querySelector("[data-message-reply]");
  if (replyForm && activeThread) {
    replyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const textarea = replyForm.querySelector("textarea");
      const message = String(textarea?.value || "").trim();
      if (!message) return;

      const button = replyForm.querySelector("button");
      const originalText = button?.textContent || "Send reply";
      if (button) {
        button.disabled = true;
        button.textContent = "Sending...";
      }

      const { error } = await NexusDB.sendThreadMessage(activeThread.id, message);

      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }

      if (error) {
        toast(error.message || "Could not send message.");
        return;
      }

      if (textarea) textarea.value = "";
      await loadMessageCenter(root, activeThread.id);
    });
  }

  if (activeThread) {
    const body = root.querySelector("[data-message-bodies]");
    const { data, error } = await NexusDB.getMessageThread(activeThread.id);

    if (error) {
      body.innerHTML = `
        <div class="message-center-error">
          <h3>Could not load conversation</h3>
          <p>${escapeHtml(error.message || "Please try again.")}</p>
        </div>
      `;
      return;
    }

    body.innerHTML = renderMessageList(data?.messages || []);
    body.scrollTop = body.scrollHeight;
  }

  applyTranslations(root);
}

async function mountMessageCenter(target, options = {}) {
  const root = typeof target === "string" ? document.getElementById(target) : target;
  if (!root) return;

  messageCenters.set(root, {
    title: options.title || "Conversations",
    viewerRole: options.viewerRole || "buyer",
    activeThreadId: options.threadId || q("thread") || ""
  });

  await loadMessageCenter(root, options.threadId || q("thread") || "");
}

function ensureThreadModal() {
  let modal = document.getElementById("nexusThreadModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "nexusThreadModal";
  modal.className = "nexus-thread-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="nexus-thread-backdrop" onclick="NexusUI.closeThreadModal()"></div>
    <section class="nexus-thread-card">
      <button class="nexus-thread-close" type="button" onclick="NexusUI.closeThreadModal()">&times;</button>
      <span class="eyebrow" id="threadModalMeta">Messages</span>
      <h2 id="threadModalTitle">Conversation</h2>
      <div class="nexus-thread-messages" id="threadModalMessages"></div>
      <form class="nexus-thread-reply" id="threadReplyForm">
        <textarea class="textarea" id="threadReplyBody" placeholder="Write a reply..." required></textarea>
        <button class="btn btn-primary" type="submit">Send reply</button>
      </form>
    </section>
  `;

  document.body.appendChild(modal);

  const form = modal.querySelector("#threadReplyForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const textarea = modal.querySelector("#threadReplyBody");
    const message = String(textarea.value || "").trim();
    if (!activeMessageThreadId || !message) return;

    const button = form.querySelector("button");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Sending...";

    const { error } = await NexusDB.sendThreadMessage(activeMessageThreadId, message);

    button.disabled = false;
    button.textContent = originalText;

    if (error) {
      toast(error.message || "Could not send message.");
      return;
    }

    textarea.value = "";
    await openThreadModal(activeMessageThreadId);
  });

  return modal;
}

function closeThreadModal() {
  const modal = document.getElementById("nexusThreadModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

async function openThreadModal(threadId) {
  const modal = ensureThreadModal();
  activeMessageThreadId = threadId;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  modal.querySelector("#threadModalTitle").textContent = "Conversation";
  modal.querySelector("#threadModalMessages").innerHTML = `<div class="loading">Loading messages...</div>`;

  const { data, error } = await NexusDB.getMessageThread(threadId);

  if (error) {
    modal.querySelector("#threadModalMessages").innerHTML = `<div class="error">${escapeHtml(error.message || "Could not load messages.")}</div>`;
    return;
  }

  const thread = data?.thread || {};
  const messages = data?.messages || [];
  const productTitle = thread.automations?.title || "";
  const developerName = thread.developers?.display_name || "";

  modal.querySelector("#threadModalTitle").textContent = thread.subject || "Conversation";
  modal.querySelector("#threadModalMeta").textContent = [productTitle, developerName, thread.status || "open"].filter(Boolean).join(" | ") || "Messages";
  modal.querySelector("#threadModalMessages").innerHTML = messages.map((message) => `
    <article class="nexus-thread-message ${escapeAttribute(message.sender_role || "")}">
      <div>
        <strong>${escapeHtml(message.sender_role || "message")}</strong>
        <span>${message.created_at ? new Date(message.created_at).toLocaleString() : ""}</span>
      </div>
      <p>${escapeHtml(message.body || "")}</p>
    </article>
  `).join("") || `<div class="card"><h3>No messages yet</h3><p>Write the first reply below.</p></div>`;
}

function adminSidebarSections(active = "") {
  const sections = [
    {
      label: "Core",
      items: [
        { id: "dashboard", label: "Overview", href: "/pages/admin/dashboard.html" },
        { id: "orders", label: "Orders", href: "/pages/admin/orders.html" },
        { id: "finance", label: "Finance", href: "/pages/admin/finance.html" }
      ]
    },
    {
      label: "Marketplace",
      items: [
        { id: "automations", label: "Products", href: "/pages/admin/automations.html" },
        { id: "product-reviews", label: "Review Queue", href: "/pages/admin/product-reviews.html" },
        { id: "automation-form", label: "Create Product", href: "/pages/admin/product-form.html" },
        { id: "customer-automations", label: "Customer Automations", href: "/pages/admin/customer-automations.html" },
        { id: "messages", label: "Messages", href: "/pages/admin/messages.html" },
        { id: "reviews", label: "Reviews", href: "/pages/admin/reviews.html" }
      ]
    },
    {
      label: "Developers",
      items: [
        { id: "waitlist", label: "Developer Waitlist", href: "/pages/admin/waitlist.html" },
        { id: "developer-profile", label: "Nexus Profile", href: "/pages/admin/developer-profile.html" }
      ]
    },
    {
      label: "Tools",
      items: [
        { id: "checkout-intents", label: "Checkout Prep", href: "/pages/admin/checkout-intents.html" },
        { id: "marketplace", label: "View Marketplace", href: "/pages/marketplace/index.html" },
        { id: "logout", label: "Logout", href: "#", action: "logout" }
      ]
    }
  ];

  return sections.map((section) => {
    const links = section.items.map((item) => {
      const isActive = active === item.id;
      const action = item.action === "logout"
        ? ` onclick="event.preventDefault(); NexusDB.signOut()"`
        : "";

      return `
        <a class="${isActive ? "active" : ""}" href="${escapeAttribute(item.href)}"${action}>
          ${escapeHtml(item.label)}
        </a>
      `;
    }).join("");

    return `
      <div class="sidebar-section-label">${escapeHtml(section.label)}</div>
      ${links}
    `;
  }).join("");
}

function mountAdminSidebar(options = {}) {
  if (document.body?.dataset?.admin !== "true") return;

  const sidebar = document.querySelector(".dashboard .sidebar");
  if (!sidebar) return;

  const active = document.body.dataset.adminPage || "";
  const language = getLanguage();

  if (
    !options.force &&
    sidebar.dataset.nexusSidebarMounted === "true" &&
    sidebar.dataset.nexusSidebarActive === active &&
    sidebar.dataset.nexusSidebarLanguage === language
  ) {
    return;
  }

  sidebar.innerHTML = `
    <div class="sidebar-title">Nexus Admin</div>
    ${adminSidebarSections(active)}
  `;

  applyTranslations(sidebar);
  localizeInternalLinks(sidebar);

  sidebar.dataset.nexusSidebarMounted = "true";
  sidebar.dataset.nexusSidebarActive = active;
  sidebar.dataset.nexusSidebarLanguage = language;
}

  return {
  q,
  slugify,
  toast,
  getCurrency,
  setCurrency,
  currencySwitch,
  priceAmount,
  money,
  productCard,
  infoBlock,
  renderPreview,
  renderCustomizations,
  reviewsBlock,
  openModal,
  closeModal,
  wireModal,
  arrayList,
  pillClass,
  escapeHtml,
  escapeAttribute,
  normalizeImageSource,
  normalizeHtmlSource,
  prepareResponsiveHtml,
  ratingStars,
  reviewStats,
  publicReviewsBlock,
  priceAmount,
money,
formatMoney,
refreshUsdToThbRate,
getLanguage,
setLanguage,
t,
translate: translateLiteral,
languageSwitch,
applyTranslations,
refreshLanguageState,
startTranslationObserver,
startLanguageNavigationGuard,
localizedInternalUrl,
localizeInternalLinks,
localizeRecord,
localizeArray,
localizeSchema,
localizeCustomization,
globalNav,
mountGlobalNav,
toggleMobileNav,
openThreadModal,
closeThreadModal,
mountMessageCenter,
mountAdminSidebar,
};
})();
window.NexusUI = NexusUI;

let nexusUiBooted = false;

async function bootNexusUI() {
  if (nexusUiBooted) return;
  nexusUiBooted = true;

  NexusUI.refreshLanguageState?.();
  NexusUI.startLanguageNavigationGuard?.();

  try {
    await NexusUI.mountGlobalNav?.();
  } catch (error) {
    console.warn("Could not mount Nexus navigation:", error);
  }

  try {
    NexusUI.mountAdminSidebar?.();
  } catch (error) {
    console.warn("Could not mount Nexus admin sidebar:", error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootNexusUI);
} else {
  bootNexusUI();
}
