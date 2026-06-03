console.log("NEXUS UI RECOVERY VERSION LOADED");
console.log("NEXUS UI TEST FILE LOADED - 1234");
const NexusUI = (() => {
  const FX_FALLBACK = 36;
const FX_CACHE_KEY = "nexus_usd_thb_rate_cache";
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
    return localStorage.getItem("nexus_currency") || "USD";
  }

 function setCurrency(currency) {
  const normalized = currency === "THB" ? "THB" : "USD";

  localStorage.setItem("nexus_currency", normalized);

  document.querySelectorAll("[data-currency-btn]").forEach((button) => {
    button.classList.toggle("active", button.dataset.currencyBtn === normalized);
  });

  if (typeof mountGlobalNav === "function") {
    mountGlobalNav();
  }

  document.dispatchEvent(new CustomEvent("currencychange"));
}

  function currencySwitch() {
    const currency = getCurrency();

    return `
      <div class="currency-switch">
        <button
          data-currency-btn="USD"
          onclick="NexusUI.setCurrency('USD')"
          class="${currency === "USD" ? "active" : ""}"
        >
          USD
        </button>

        <button
          data-currency-btn="THB"
          onclick="NexusUI.setCurrency('THB')"
          class="${currency === "THB" ? "active" : ""}"
        >
          THB
        </button>
      </div>
    `;
  }

function getCachedUsdToThbRate() {
  try {
    const cached = localStorage.getItem(FX_CACHE_KEY);

    if (!cached) return FX_FALLBACK;

    const parsed = JSON.parse(cached);

    if (
      parsed &&
      parsed.rate &&
      parsed.created_at &&
      Date.now() - parsed.created_at < FX_CACHE_TTL_MS
    ) {
      return Number(parsed.rate);
    }

    return FX_FALLBACK;
  } catch {
    return FX_FALLBACK;
  }
}

async function refreshUsdToThbRate() {
  try {
    const response = await fetch("https://api.frankfurter.dev/v2/rate/USD/THB");
    const data = await response.json();

    const rate = Number(data.rate || 0);

    if (!response.ok || !rate || rate <= 0) {
      throw new Error("Invalid FX response");
    }

    localStorage.setItem(
      FX_CACHE_KEY,
      JSON.stringify({
        rate,
        created_at: Date.now(),
        source: "frankfurter_live"
      })
    );

    document.dispatchEvent(new CustomEvent("fxratechange"));

    return rate;
  } catch {
    return getCachedUsdToThbRate();
  }
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
      currency: productCurrency === "THB" ? "THB" : "USD"
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
  const rate = getCachedUsdToThbRate();

  if (!amount || amount <= 0) return 0;

  if (from === to) return Number(amount);

  if (from === "USD" && to === "THB") {
    return Math.round(Number(amount) * rate);
  }

  if (from === "THB" && to === "USD") {
    return Math.round((Number(amount) / rate) * 100) / 100;
  }

  return Number(amount);
}

function formatMoney(amount, currency) {
  const selectedCurrency = String(currency || getCurrency() || "USD").toUpperCase();

  if (selectedCurrency === "THB") {
    return `฿${Math.round(Number(amount || 0)).toLocaleString("en-US")}`;
  }

  return `$${Number(amount || 0).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(Number(amount)) ? 0 : 2,
    maximumFractionDigits: 2
  })}`;
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

  function productCard(product) {
    const developer = product.developers || {};
    const slug = encodeURIComponent(product.slug || "");

    return `
      <article class="product-card color-${colorClass(product.color)}">
        <div class="product-top">
          <div class="product-icon ${colorClass(product.color)}">
            ${escapeHtml(product.icon || "AI")}
          </div>

          <span class="${pillClass(product.color)}">
            ${escapeHtml(product.badge || product.category || "Automation")}
          </span>
        </div>

        <h3>${escapeHtml(product.title)}</h3>

        <p>${escapeHtml(product.short_description || "")}</p>

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
            <span>${escapeHtml(developer.type || "Verified Operator")} · ★ ${escapeHtml(developer.rating || "New")}</span>
          </div>
        </div>

        <div class="tags">
          <span class="tag">${escapeHtml(product.category || "Automation")}</span>
          <span class="tag">${escapeHtml(product.delivery_time || "Custom")}</span>
          <span class="tag">★ ${escapeHtml(product.rating || "New")} (${escapeHtml(product.review_count || 0)})</span>
        </div>

        <div class="meta-grid">
          <div class="meta">
            <span>Price</span>
            <strong>${money(product)}</strong>
          </div>

          <div class="meta">
            <span>Setup</span>
            <strong>${escapeHtml(product.setup_type || "Self-serve or guided")}</strong>
          </div>
        </div>

        <div class="card-actions">
          <button
            type="button"
            class="btn btn-secondary btn-small"
            onclick="event.stopPropagation(); NexusApp.openProduct('${escapeAttribute(product.slug || "")}')"
          >
            Preview
          </button>

          <a
            class="btn btn-primary btn-small"
            href="/pages/checkout/index.html?slug=${slug}&step=setup"
            onclick="event.stopPropagation();"
          >
            Buy
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
        <h4>${escapeHtml(title)}</h4>

        <ul class="clean">
          ${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
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
    const mode =
      customization?.preview_mode ||
      product.preview_mode ||
      product.preview_type ||
      "template";

    const code = customization?.preview_code || product.preview_code || "";
    const image = customization?.preview_image_url || product.preview_image_url || "";
    const base64 = customization?.preview_base64 || product.preview_base64 || "";

    const title =
      customization?.name ||
      product.preview_title ||
      product.title ||
      "Automation preview";

    const description =
      customization?.description ||
      product.preview_description ||
      product.short_description ||
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
              return `
                <div
                  class="customization-card"
                  onclick="NexusApp.selectCustomization(${index}, '${escapeAttribute(target)}')"
                >
                  <strong>${escapeHtml(customization.name || "Option")}</strong>
                  <p>${escapeHtml(customization.description || "")}</p>
                  <span class="tag">${escapeHtml(customization.price_note || "")}</span>
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
                <strong>★ ${escapeHtml(review.rating)}/5 — ${escapeHtml(review.reviewer_name)}</strong><br>
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
  return "★".repeat(full) + "☆".repeat(5 - full);
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
              review.reviewer_company
            ].filter(Boolean).join(" · ");

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
    nav_home: "หน้าแรก",
    nav_marketplace: "มาร์เก็ตเพลส",
    nav_developers: "สำหรับนักพัฒนา",
    nav_about: "เกี่ยวกับเรา",
    nav_contact: "ติดต่อ",
    nav_dashboard: "แดชบอร์ด",
    nav_admin: "แอดมิน",
    nav_login: "เข้าสู่ระบบ",
    nav_logout: "ออกจากระบบ",
    nav_currency: "สกุลเงิน",
    nav_language: "ภาษา",

    common_browse_automations: "ดูระบบอัตโนมัติ",
    common_get_support: "ติดต่อทีมซัพพอร์ต",
    common_buy: "ซื้อ",
    common_preview: "ดูตัวอย่าง",
    common_view: "ดู",
    common_view_setup: "ดูการตั้งค่า",
    common_view_output: "ดูผลลัพธ์",
    common_complete_setup: "ตั้งค่าให้เสร็จ",

    dashboard_buyer_title: "แดชบอร์ดระบบอัตโนมัติของคุณ",
    dashboard_buyer_subtitle:
      "ติดตามระบบอัตโนมัติ ดูผลลัพธ์ ตั้งค่า และตรวจสอบกิจกรรมสำคัญได้ในที่เดียว",
    dashboard_overview: "ภาพรวม",
    dashboard_automations: "ระบบของฉัน",
    dashboard_outputs: "ผลลัพธ์",
    dashboard_activity: "กิจกรรม",
    dashboard_orders: "คำสั่งซื้อ"
  }
};

function getLanguage() {
  return localStorage.getItem("nexus_language") || "en";
}

function setLanguage(language) {
  const normalized = language === "th" ? "th" : "en";

  localStorage.setItem("nexus_language", normalized);

  document.querySelectorAll("[data-language-btn]").forEach((button) => {
    button.classList.toggle("active", button.dataset.languageBtn === normalized);
  });

  applyTranslations();

  if (typeof mountGlobalNav === "function") {
    mountGlobalNav();
  }

  document.dispatchEvent(new CustomEvent("languagechange", {
    detail: {
      language: normalized
    }
  }));
}

function t(key, fallback) {
  const language = getLanguage();
  return I18N[language]?.[key] || I18N.en[key] || fallback || key;
}

function languageSwitch() {
  const language = getLanguage();

  return `
    <div class="language-switch" aria-label="${escapeAttribute(t("nav_language"))}">
      <button
        type="button"
        data-language-btn="en"
        onclick="NexusUI.setLanguage('en')"
        class="${language === "en" ? "active" : ""}"
      >
        EN
      </button>

      <button
        type="button"
        data-language-btn="th"
        onclick="NexusUI.setLanguage('th')"
        class="${language === "th" ? "active" : ""}"
      >
        TH
      </button>
    </div>
  `;
}

function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    element.textContent = t(key, element.textContent);
  });

  root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.dataset.i18nPlaceholder;
    element.setAttribute("placeholder", t(key, element.getAttribute("placeholder") || ""));
  });

  root.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const key = element.dataset.i18nTitle;
    element.setAttribute("title", t(key, element.getAttribute("title") || ""));
  });
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

    if (typeof NexusDB.getUser === "function") {
      const result = await NexusDB.getUser();
      user = result?.data || null;
    }

    if (!user && typeof NexusDB.getSession === "function") {
      const result = await NexusDB.getSession();
      user = result?.data?.session?.user || null;
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

    let profile = null;

    if (typeof NexusDB.getProfile === "function") {
      const result = await NexusDB.getProfile(user.id);
      profile = result?.data || null;
    }

    const isAdmin = profile?.role === "admin";

    /*
      On dashboard/admin pages, logged-in users should see Logout.
      On public pages, logged-in users should see Dashboard/Admin.
    */
    const isAccountArea =
      active === "dashboard" ||
      active === "admin" ||
      document.body.dataset.page === "buyer-dashboard" ||
      document.body.dataset.admin === "true";

    if (isAccountArea) {
      return {
        label: t("nav_logout"),
        href: "#",
        action: "logout",
        isAdmin,
        isLoggedIn: true
      };
    }

    if (isAdmin) {
      return {
        label: t("nav_admin"),
        href: "/pages/admin/dashboard.html",
        action: "admin",
        isAdmin: true,
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

function globalNav(active = "") {
  return `
    <div class="container nav">
      <a class="logo" href="/index.html">
        <span>Nexus AI</span>
      </a>

      <button
        class="mobile-nav-toggle"
        type="button"
        onclick="NexusUI.toggleMobileNav()"
        aria-label="Toggle navigation"
      >
        ☰
      </button>

      <nav class="nav-links" id="globalNavLinks">
        <a class="nav-link ${active === "home" ? "active" : ""}" href="/index.html" data-i18n="nav_home">
          ${t("nav_home")}
        </a>

        <a class="nav-link ${active === "marketplace" ? "active" : ""}" href="/pages/marketplace/index.html" data-i18n="nav_marketplace">
          ${t("nav_marketplace")}
        </a>

        <a class="nav-link ${active === "developers" ? "active" : ""}" href="/pages/developers/index.html" data-i18n="nav_developers">
          ${t("nav_developers")}
        </a>

        <a class="nav-link ${active === "about" ? "active" : ""}" href="/pages/about/index.html" data-i18n="nav_about">
          ${t("nav_about")}
        </a>

        <a class="nav-link ${active === "contact" ? "active" : ""}" href="/pages/contact/index.html" data-i18n="nav_contact">
          ${t("nav_contact")}
        </a>

        <div class="nav-controls">
          ${currencySwitch()}
          ${languageSwitch()}
        </div>

        <a class="btn btn-secondary btn-small" id="navAccountButton" href="/pages/buyer/login.html">
          ${t("nav_login")}
        </a>
      </nav>
    </div>
  `;
}

async function mountGlobalNav() {
  const header = document.getElementById("globalNav");

  if (!header) return;

  const active = header.dataset.active || document.body.dataset.page || "";
  header.innerHTML = globalNav(active);

  /*
    Wait briefly for nexus-db.js if the page loads scripts in different order.
  */
  if (typeof NexusDB === "undefined") {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const account = await getNavDestination(active);
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
}

function toggleMobileNav() {
  const nav = document.getElementById("globalNavLinks");
  if (nav) nav.classList.toggle("open");
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
languageSwitch,
applyTranslations,
globalNav,
mountGlobalNav,
toggleMobileNav,
};
})();
document.addEventListener("DOMContentLoaded", async () => {
  if (window.NexusUI && typeof NexusUI.mountGlobalNav === "function") {
    await NexusUI.mountGlobalNav();
  }

  if (window.NexusUI && typeof NexusUI.applyTranslations === "function") {
    NexusUI.applyTranslations();
  }
});