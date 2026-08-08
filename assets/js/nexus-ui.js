const NexusUI = (() => {
  const SUPPORTED_LANGUAGES = ["en", "th", "zh", "es", "hi", "ar", "fr"];
  const RTL_LANGUAGES = ["ar"];
  const LANGUAGE_OPTIONS = [
    { code: "en", label: "English" },
    { code: "th", label: "???" },
    { code: "zh", label: "??" },
    { code: "es", label: "Espa�ol" },
    { code: "hi", label: "??????" },
    { code: "ar", label: "???????" },
    { code: "fr", label: "Fran�ais" }
  ];
  const DEFAULT_CURRENCY = "USD";
  const SUPPORTED_CURRENCIES = ["USD", "THB", "EUR", "GBP", "JPY"];
  const CURRENCY_OPTIONS = [
    { code: "USD", label: "USD" },
    { code: "THB", label: "THB" },
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

  function inferNoticeType(message = "") {
    const text = String(message || "").toLowerCase();

    if (/(error|failed|could not|missing|required|invalid|not found|denied|unauthorized|blocked|too short|too large|cannot|can't|no |wrong|problem)/.test(text)) {
      return "error";
    }

    if (/(select|choose|enter|please|wait|running|important|soon|already|warning|check again)/.test(text)) {
      return "warning";
    }

    if (/(saved|submitted|sent|created|updated|approved|deleted|removed|revoked|checked|passed|complete|completed|success|requested|loaded|joined|reset|on\.|off\.)/.test(text)) {
      return "success";
    }

    return "info";
  }

  function noticeTitle(type = "info") {
    if (type === "error") return "Action needed";
    if (type === "success") return "Done";
    if (type === "warning") return "Check this";
    return "Update";
  }

  function ensureToastModal() {
    let modal = document.getElementById("nexusGlobalNoticeModal");

    if (modal) return modal;

    modal = document.createElement("div");
    modal.className = "nexus-modal-lite";
    modal.id = "nexusGlobalNoticeModal";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <div class="nexus-modal-lite-backdrop" data-nexus-toast-close></div>

      <div class="nexus-modal-lite-card nexus-global-notice-card" role="dialog" aria-modal="true" aria-labelledby="nexusGlobalNoticeTitle">
        <button class="nexus-modal-lite-close" type="button" aria-label="Close notification" data-nexus-toast-close>&times;</button>

        <span class="eyebrow" id="nexusGlobalNoticeEyebrow">Update</span>

        <h2 id="nexusGlobalNoticeTitle">Update</h2>

        <p id="nexusGlobalNoticeMessage">Something happened.</p>

        <div class="nexus-global-notice-extra" id="nexusGlobalNoticeExtra" style="display:none"></div>

        <div class="modal-lite-actions">
          <button class="btn btn-primary" type="button" data-nexus-toast-close>Done</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelectorAll("[data-nexus-toast-close]").forEach((button) => {
      button.addEventListener("click", closeToast);
    });

    if (!document.documentElement.dataset.nexusToastEscBound) {
      document.documentElement.dataset.nexusToastEscBound = "true";
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeToast();
      });
    }

    return modal;
  }

  function closeToast() {
    const modal = document.getElementById("nexusGlobalNoticeModal");
    if (!modal) return;

    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("nexus-notice-open");
  }

  function toast(message, options = {}) {
    const normalizedMessage = String(message || "Update").trim() || "Update";
    const type = options.type || inferNoticeType(normalizedMessage);
    const title = options.title || noticeTitle(type);

    if (window.NexusNotice?.open) {
      window.NexusNotice.open({
        type,
        title,
        message: normalizedMessage,
        extra: options.extra || ""
      });
      return;
    }

    const modal = ensureToastModal();
    const eyebrow = document.getElementById("nexusGlobalNoticeEyebrow");
    const titleEl = document.getElementById("nexusGlobalNoticeTitle");
    const messageEl = document.getElementById("nexusGlobalNoticeMessage");
    const extraEl = document.getElementById("nexusGlobalNoticeExtra");

    if (eyebrow) {
      if (type === "error") eyebrow.textContent = "Action needed";
      else if (type === "success") eyebrow.textContent = "Success";
      else if (type === "warning") eyebrow.textContent = "Important";
      else eyebrow.textContent = "Update";
    }

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = normalizedMessage;

    if (extraEl) {
      if (options.extra) {
        extraEl.style.display = "";
        extraEl.textContent = options.extra;
      } else {
        extraEl.style.display = "none";
        extraEl.textContent = "";
      }
    }

    modal.classList.remove("success", "error", "warning", "info");
    modal.classList.add(type);
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("nexus-notice-open");
  }

  function ensureDialogModal() {
    let modal = document.getElementById("nexusGlobalDialogModal");

    if (modal) return modal;

    modal = document.createElement("div");
    modal.className = "nexus-modal-lite";
    modal.id = "nexusGlobalDialogModal";
    modal.setAttribute("aria-hidden", "true");

    modal.innerHTML = `
      <div class="nexus-modal-lite-backdrop" data-nexus-dialog-action="cancel"></div>

      <div class="nexus-modal-lite-card nexus-global-notice-card" role="dialog" aria-modal="true" aria-labelledby="nexusGlobalDialogTitle">
        <button class="nexus-modal-lite-close" type="button" aria-label="Close dialog" data-nexus-dialog-action="cancel">&times;</button>

        <span class="eyebrow" id="nexusGlobalDialogEyebrow">Confirm</span>

        <h2 id="nexusGlobalDialogTitle">Confirm action</h2>

        <p id="nexusGlobalDialogMessage">Are you sure?</p>

        <div id="nexusGlobalDialogInputWrap" style="display:none">
          <label id="nexusGlobalDialogInputLabel" for="nexusGlobalDialogTextInput">Details</label>
          <input class="input" id="nexusGlobalDialogTextInput">
          <textarea class="textarea" id="nexusGlobalDialogInput" rows="4" style="display:none"></textarea>
        </div>

        <div class="modal-lite-actions">
          <button class="btn btn-secondary" type="button" data-nexus-dialog-action="cancel" id="nexusGlobalDialogCancel">Cancel</button>
          <button class="btn btn-primary" type="button" data-nexus-dialog-action="confirm" id="nexusGlobalDialogConfirm">Continue</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelectorAll("[data-nexus-dialog-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.getAttribute("data-nexus-dialog-action");
        closeDialog(action === "confirm");
      });
    });

    return modal;
  }

  function closeDialog(confirmed) {
    const modal = document.getElementById("nexusGlobalDialogModal");
    if (!modal) return;

    const mode = modal.dataset.mode || "confirm";
    const textarea = document.getElementById("nexusGlobalDialogInput");
    const textInput = document.getElementById("nexusGlobalDialogTextInput");
    const input = modal.dataset.inputControl === "textarea" ? textarea : textInput;
    const resolve = modal._nexusResolve;

    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("nexus-notice-open");
    modal._nexusResolve = null;

    if (typeof resolve === "function") {
      if (!confirmed) {
        resolve(mode === "prompt" ? null : false);
      } else {
        resolve(mode === "prompt" ? (input?.value || "") : true);
      }
    }
  }

  function openDialog(options = {}) {
    const modal = ensureDialogModal();
    const mode = options.mode || "confirm";
    const eyebrow = document.getElementById("nexusGlobalDialogEyebrow");
    const title = document.getElementById("nexusGlobalDialogTitle");
    const message = document.getElementById("nexusGlobalDialogMessage");
    const inputWrap = document.getElementById("nexusGlobalDialogInputWrap");
    const inputLabel = document.getElementById("nexusGlobalDialogInputLabel");
    const input = document.getElementById("nexusGlobalDialogInput");
    const textInput = document.getElementById("nexusGlobalDialogTextInput");
    const cancel = document.getElementById("nexusGlobalDialogCancel");
    const confirm = document.getElementById("nexusGlobalDialogConfirm");

    modal.dataset.mode = mode;

    if (eyebrow) eyebrow.textContent = options.eyebrow || (mode === "prompt" ? "Input needed" : "Confirm");
    if (title) title.textContent = options.title || (mode === "prompt" ? "Add details" : "Confirm action");
    if (message) message.textContent = options.message || "";
    if (cancel) cancel.textContent = options.cancelText || "Cancel";
    if (confirm) confirm.textContent = options.confirmText || "Continue";

    if (inputWrap && input && textInput) {
      const useTextarea = mode === "prompt" && options.inputType !== "password" && Number(options.rows || 4) > 1;
      modal.dataset.inputControl = useTextarea ? "textarea" : "input";
      inputWrap.style.display = mode === "prompt" ? "" : "none";
      textInput.style.display = useTextarea ? "none" : "";
      input.style.display = useTextarea ? "" : "none";
      textInput.type = options.inputType || "text";
      textInput.value = options.defaultValue || "";
      textInput.placeholder = options.placeholder || "";
      input.value = options.defaultValue || "";
      input.placeholder = options.placeholder || "";
      input.rows = Number(options.rows || 4);
    }

    if (inputLabel) {
      inputLabel.textContent = options.inputLabel || "Details";
      inputLabel.setAttribute("for", modal.dataset.inputControl === "textarea" ? "nexusGlobalDialogInput" : "nexusGlobalDialogTextInput");
    }

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("nexus-notice-open");

    setTimeout(() => {
      if (mode === "prompt") {
        const target = modal.dataset.inputControl === "textarea" ? input : textInput;
        target?.focus();
      }
      else confirm?.focus();
    }, 50);

    return new Promise((resolve) => {
      modal._nexusResolve = resolve;
    });
  }

  function confirmDialog(options = {}) {
    const normalized = typeof options === "string" ? { message: options } : options;
    return openDialog({
      mode: "confirm",
      title: normalized.title,
      message: normalized.message,
      eyebrow: normalized.eyebrow,
      confirmText: normalized.confirmText || "Confirm",
      cancelText: normalized.cancelText || "Cancel"
    });
  }

  function promptDialog(options = {}) {
    const normalized = typeof options === "string" ? { message: options } : options;
    return openDialog({
      mode: "prompt",
      title: normalized.title,
      message: normalized.message,
      eyebrow: normalized.eyebrow,
      inputLabel: normalized.inputLabel,
      placeholder: normalized.placeholder,
      defaultValue: normalized.defaultValue,
      inputType: normalized.inputType,
      rows: normalized.rows,
      confirmText: normalized.confirmText || "Save",
      cancelText: normalized.cancelText || "Cancel"
    });
  }

  function getCurrency() {
    const stored = String(localStorage.getItem("nexus_currency") || DEFAULT_CURRENCY).toUpperCase();
    return SUPPORTED_CURRENCIES.includes(stored) ? stored : DEFAULT_CURRENCY;
  }

 function setCurrency(currency) {
  const requested = String(currency || DEFAULT_CURRENCY).toUpperCase();
  const normalized = SUPPORTED_CURRENCIES.includes(requested) ? requested : DEFAULT_CURRENCY;

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

function getProductSetupFeeBaseAmount(product) {
  const productCurrency = String(product?.currency || "USD").toUpperCase();
  const usdValue = Number(product?.setup_fee_usd || 0);
  const thbValue = Number(product?.setup_fee_thb || 0);
  const genericValue = Number(product?.setup_fee || 0);

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

function guidedInstallFeeAmount(product) {
  if (!product) return 0;

  if (String(product.pricing_type || "").toLowerCase() === "setup_fee") {
    return 0;
  }

  const displayCurrency = getCurrency();
  const base = getProductSetupFeeBaseAmount(product);

  return convertAmount(base.amount, base.currency, displayCurrency);
}

function guidedInstallFeeMoney(product) {
  const amount = guidedInstallFeeAmount(product);

  if (!amount || amount <= 0) return "";

  return formatMoney(amount, getCurrency());
}

function productAllowsGuidedInstall(product) {
  if (!product) return false;

  const listingType = String(product.listing_type || "").toLowerCase();
  const pricingType = String(product.pricing_type || "").toLowerCase();

  if (listingType === "custom_request" || pricingType === "custom_quote" || pricingType === "free_demo") {
    return false;
  }

  const developerId = product.developer_id || product.developers?.id || "";
  const developerHandle = String(product.developers?.handle || "").toLowerCase();
  const developerName = String(product.developers?.display_name || "").toLowerCase();

  if (
    !developerId ||
    developerHandle === "nexus-internal" ||
    developerHandle === "nexus" ||
    developerName === "nexus internal" ||
    developerName === "nexus"
  ) {
    return true;
  }

  const raw = product.guided_install_enabled;
  const normalized = String(raw || "").toLowerCase();
  return raw === true || raw === 1 || ["true", "1", "yes", "on"].includes(normalized);
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

function productMonth(value, fallback = "June 2026") {
  if (!value) return fallback;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;

  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric"
  });
}

function productMaintainer(product) {
  const developer = product?.developers || {};
  const displayName = developer.display_name || "";
  const handle = String(developer.handle || "").toLowerCase();

  if (!product?.developer_id || handle === "nexus" || handle === "nexus-internal" || displayName.toLowerCase() === "nexus") {
    return "Nexus Verified Operator";
  }

  return displayName ? `${displayName} � Approved developer` : "Approved Nexus developer";
}

function productFreshness(product) {
  return {
    tested: productMonth(product?.health_last_checked_at || product?.n8n_last_tested_at || product?.updated_at),
    updated: productMonth(product?.updated_at || product?.n8n_last_tested_at || product?.health_last_checked_at),
    maintainer: productMaintainer(product)
  };
}

function workflowHealthStatus(product = {}, summary = {}) {
  const rawHealth = String(product?.health_status || summary?.last_health_check?.status || "").toLowerCase().trim();
  const rawTechnical = String(product?.n8n_last_test_status || summary?.last_technical_run?.status || "").toLowerCase().trim();
  const workflowId = product?.n8n_workflow_id || product?.n8n_workflow_json || product?.runtime_webhook_url || "";
  const listingType = String(product?.listing_type || "").toLowerCase();
  const pricingType = String(product?.pricing_type || "").toLowerCase();
  const productStatus = String(product?.status || "").toLowerCase();
  const isLive = ["live", "active", "published"].includes(productStatus);

  if (listingType === "custom_request" || pricingType === "custom_quote") {
    return rawHealth && rawHealth !== "unknown" ? rawHealth : "not_applicable";
  }

  if (["passed", "passed_with_expected_test_callback_error", "passed_with_expected_test_input_error", "success", "succeeded", "completed"].includes(rawTechnical)) {
    return "healthy";
  }

  if (["healthy", "warning", "failed", "paused_by_health_check", "skipped"].includes(rawHealth)) {
    return rawHealth;
  }

  if (["failed", "error", "cancelled", "canceled"].includes(rawTechnical)) {
    return "failed";
  }

  if (["running", "queued", "not_tested", "not tested", "needs_recheck"].includes(rawTechnical)) {
    return "needs_recheck";
  }

  if (rawHealth === "needs_recheck") {
    return isLive && workflowId ? "healthy" : "needs_recheck";
  }

  if (isLive && workflowId) return rawHealth && rawHealth !== "unknown" ? rawHealth : "healthy";

  if (workflowId) return "needs_recheck";

  return rawHealth || "unknown";
}

function workflowHealthLabel(status, fallback = "unknown") {
  const value = String(status || fallback || "unknown").toLowerCase();

  if (value === "healthy") return "Healthy";
  if (value === "needs_recheck") return "Needs recheck";
  if (value === "paused_by_health_check") return "Paused by health check";
  if (value === "not_applicable") return "Not applicable";
  if (value === "not_configured") return "Not configured";

  return String(status || fallback || "unknown").replaceAll("_", " ").trim() || fallback;
}

function recommendedProductLabel(product) {
  const text = [
    product?.title,
    product?.category,
    product?.badge,
    product?.short_description,
    product?.best_for
  ].join(" ").toLowerCase();

  if (String(product?.listing_type || "").toLowerCase() === "custom_request") return "Custom fit";
  if (text.includes("social") || text.includes("marketing") || text.includes("competitor")) return "Best for marketing teams";
  if (text.includes("support") || text.includes("ticket") || text.includes("inquiry")) return "Best for customer support";
  if (text.includes("lead") || text.includes("sales") || text.includes("crm")) return "Best first automation";
  if (text.includes("report") || text.includes("kpi") || text.includes("founder")) return "Most useful for founders";

  return "Easy setup";
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

    const viewportMeta = `<meta name="viewport" content="width=device-width, initial-scale=1.0">`;
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

        body {
          min-width: 0 !important;
        }

        *,
        *::before,
        *::after {
          box-sizing: border-box !important;
          max-width: 100% !important;
          min-width: 0 !important;
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

        body > *,
        main,
        section,
        article,
        .wrap,
        .wrapper,
        .container,
        .page,
        .report,
        .report-wrap,
        .report-wrapper,
        .dashboard,
        .dashboard-wrap,
        .content,
        .content-wrap,
        .card,
        .panel {
          width: 100% !important;
          max-width: 100% !important;
          margin-left: auto !important;
          margin-right: auto !important;
        }

        .wrap,
        .wrapper,
        .container,
        .page,
        .report,
        .report-wrap,
        .report-wrapper,
        .dashboard,
        .dashboard-wrap,
        .content,
        .content-wrap {
          padding-left: clamp(10px, 2.4vw, 22px) !important;
          padding-right: clamp(10px, 2.4vw, 22px) !important;
        }

        [class*="grid"],
        [class*="row"],
        [class*="columns"],
        [class*="cards"],
        [class*="metrics"],
        [class*="kpis"] {
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
            padding: 0 !important;
          }

          .wrap,
          .wrapper,
          .container,
          .page,
          .report,
          .report-wrap,
          .report-wrapper,
          .dashboard,
          .dashboard-wrap,
          .content,
          .content-wrap {
            padding-left: 8px !important;
            padding-right: 8px !important;
          }

          [class*="grid"],
          [class*="columns"],
          [class*="cards"],
          [class*="metrics"],
          [class*="kpis"] {
            display: grid !important;
            grid-template-columns: 1fr !important;
            gap: 10px !important;
          }

          [class*="row"] {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 10px !important;
          }

          h1 {
            font-size: clamp(26px, 9vw, 42px) !important;
            line-height: 1.05 !important;
          }

          h2 {
            font-size: clamp(22px, 7vw, 32px) !important;
            line-height: 1.1 !important;
          }

          h3 {
            font-size: clamp(18px, 5.5vw, 24px) !important;
            line-height: 1.15 !important;
          }
        }
      </style>
    `;

    if (source.toLowerCase().includes("</head>")) {
      const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(source);
      return source.replace("</head>", `${hasViewport ? "" : viewportMeta}${responsiveStyle}</head>`);
    }

    return `
      <!doctype html>
      <html>
        <head>
          <meta charset="UTF-8">
          ${viewportMeta}
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
    const isBundle = product.is_bundle || product.item_type === "bundle" || product.listing_type === "bundle";
    const bundleProducts = Array.isArray(product.bundle_products) ? product.bundle_products : [];
    const slug = encodeURIComponent(product.slug || "");
    const rawSlug = String(product.slug || "");
    const isCustomRequest =
      !isBundle && (
      Boolean(product.is_demo) ||
      product.listing_type === "custom_request" ||
      product.pricing_type === "custom_quote"
      );
    const showCompare = Boolean(cardOptions.showCompare) && !isBundle;
    const compareSelected = Boolean(cardOptions.compareSelected);
    const showSave = Boolean(cardOptions.showSave) && !isBundle && Boolean(product.id);
    const saveSelected = Boolean(cardOptions.savedSelected);
    const ctaHref = isBundle
      ? `/pages/checkout?bundle=${slug}&step=setup`
      : isCustomRequest
      ? `/pages/custom-request?slug=${slug}`
      : `/pages/checkout?slug=${slug}&step=setup`;
    const ctaLabel = isCustomRequest ? t("common_request_custom_automation") : t("common_buy");
    const guideLabel = recommendedProductLabel(product);
    const openAction = isBundle
      ? `NexusApp.openBundle('${escapeAttribute(product.slug || "")}')`
      : `NexusApp.openProduct('${escapeAttribute(product.slug || "")}')`;
    const developerClick = isBundle
      ? ""
      : `onclick="event.stopPropagation(); location.href='/pages/developers/profile.html?id=${developer.id || ""}'"`;
    const developerCursor = isBundle ? "" : "cursor:pointer";
    const bundleIncludedText = isBundle
      ? `${bundleProducts.length || product.active_item_count || 0} included products`
      : `${escapeHtml(l(localizeRecord(developer, "type", "Verified Operator")))} &middot; &#9733; ${escapeHtml(l(developer.rating || "New"))}`;

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

        <span class="product-guide-label">${escapeHtml(l(guideLabel))}</span>

        <h3>${escapeHtml(l(localizeRecord(product, "title")))}</h3>

        <p>${escapeHtml(l(localizeRecord(product, "short_description")))}</p>

        <div
          class="developer-mini"
          ${developerClick}
          style="${developerCursor}"
        >
          <div class="avatar">
            ${escapeHtml(developer.avatar_letter || "N")}
          </div>

          <div>
            <strong>${escapeHtml(developer.display_name || "Nexus Internal")}</strong>
            <span>${bundleIncludedText}</span>
          </div>
        </div>

        <div class="tags">
          <span class="tag">${escapeHtml(l(localizeRecord(product, "category", "Automation")))}</span>
          <span class="tag">${escapeHtml(l(localizeRecord(product, "delivery_time", "Custom")))}</span>
          <span class="tag">&#9733; ${escapeHtml(l(product.rating || "New"))} (${escapeHtml(product.review_count || 0)})</span>
        </div>

        ${showCompare || showSave ? `
          <div class="product-card-secondary-actions">
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

            ${showSave ? `
              <button
                type="button"
                class="favorite-toggle ${saveSelected ? "active" : ""}"
                aria-pressed="${saveSelected ? "true" : "false"}"
                aria-label="${saveSelected ? "Remove favorite" : "Favorite product"}"
                title="${saveSelected ? "Favorited" : "Favorite product"}"
                onclick="event.stopPropagation(); NexusApp.toggleSavedProduct('${escapeAttribute(product.id || "")}')"
              >
                <span aria-hidden="true">${saveSelected ? "&hearts;" : "&#9825;"}</span>
                <span>${saveSelected ? "Favorited" : "Favorite"}</span>
              </button>
            ` : ""}
          </div>
        ` : ""}

        <div class="meta-grid">
          <div class="meta">
            <span>${escapeHtml(l("Price"))}</span>
            <strong>${money(product)}</strong>
          </div>

          ${productAllowsGuidedInstall(product) && guidedInstallFeeMoney(product) ? `
            <div class="meta">
              <span>${escapeHtml(l("Guided install"))}</span>
              <strong>+ ${guidedInstallFeeMoney(product)}</strong>
            </div>
          ` : ""}

          <div class="meta">
            <span>${escapeHtml(l("Setup"))}</span>
            <strong>${escapeHtml(l(localizeRecord(product, "setup_type", "Self-serve or guided")))}</strong>
          </div>
        </div>

        <div class="card-actions">
          <button
            type="button"
            class="btn btn-secondary btn-small"
            onclick="event.stopPropagation(); ${openAction}"
          >
            View output</button>

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
            loading="lazy"
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
                loading="lazy"
                decoding="async"
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
    common_preview: "View output",
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
    common_preview: "?????????",
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
  nav_developer_apply: "Apply as developer",
  nav_developer_login: "Developer login",
  nav_toggle: "Toggle navigation",
  common_explore_marketplace: "Explore marketplace",
  common_request_custom_automation: "Request custom solution",
  common_join_developer_waitlist: "Join developer waitlist",
  common_message_developer: "Message developer",
  common_message_nexus: "Message Nexus",
  dashboard_messages: "Messages"
});

Object.assign(I18N.th, {
  nav_home: "หน้าแรก",
  nav_marketplace: "มาร์เก็ตเพลส",
  nav_developers: "ดีเวลลอปเปอร์",
  nav_browse_developers: "ดูดีเวลลอปเปอร์",
  nav_join_waitlist: "เข้าร่วมเวตลิสต์",
  nav_developer_apply: "Apply as developer",
  nav_developer_login: "Developer login",
  nav_about: "เกี่ยวกับเรา",
  nav_contact: "ติดต่อ",
  nav_dashboard: "แดชบอร์ด",
  nav_admin: "แอดมิน",
  nav_login: "ล็อกอิน",
  nav_logout: "ออกจากระบบ",
  nav_currency: "สกุลเงิน",
  nav_language: "ภาษา",
  nav_toggle: "เปิดเมนู",
  common_browse_automations: "ดูออโตเมชัน",
  common_explore_marketplace: "ดูมาร์เก็ตเพลส",
  common_request_custom_automation: "ขอ Custom Automation",
  common_join_developer_waitlist: "เข้าร่วมเวตลิสต์ดีเวลลอปเปอร์",
  common_get_support: "ติดต่อซัพพอร์ต",
  common_buy: "ซื้อ",
  common_preview: "?????????",
  common_view: "ดู",
  common_message_developer: "ส่งข้อความถึงดีเวลลอปเปอร์",
  common_message_nexus: "ส่งข้อความถึง Nexus",
  common_view_setup: "ดูการตั้งค่า",
  common_view_output: "ดูเอาต์พุต",
  common_complete_setup: "ตั้งค่าให้เสร็จ",
  dashboard_buyer_title: "แดชบอร์ดออโตเมชันของคุณ",
  dashboard_buyer_subtitle: "ติดตามออโตเมชัน ดูเอาต์พุต ตั้งค่า และตรวจสอบกิจกรรมสำคัญในที่เดียว",
  dashboard_overview: "ภาพรวม",
  dashboard_automations: "ออโตเมชันของฉัน",
  dashboard_outputs: "เอาต์พุต",
  dashboard_activity: "กิจกรรม",
  dashboard_orders: "ออเดอร์",
  dashboard_messages: "ข้อความ"
});

const LITERAL_TRANSLATIONS_TH = {
  "The marketplace for trusted business automation": "มาร์เก็ตเพลสสำหรับ Business Automation ที่เชื่อถือได้",
  "Find, preview, and deploy AI automations without building anything.": "ค้นหา พรีวิว และใช้งาน AI Automation ได้โดยไม่ต้องสร้างเอง",
  "Explore marketplace": "ดูมาร์เก็ตเพลส",
  "How Nexus works": "Nexus ทำงานอย่างไร",
  "Browse": "เลือกดู",
  "Preview": "?????????",
  "Customize": "ปรับให้เหมาะกับคุณ",
  "Deploy": "นำไปใช้งาน",
  "The problem": "ปัญหา",
  "Businesses want AI outcomes, not another tool to figure out.": "ธุรกิจต้องการผลลัพธ์จาก AI ไม่ใช่เครื่องมืออีกตัวที่ต้องเรียนรู้เอง",
  "Old way": "วิธีเดิม",
  "Confusing and risky": "สับสนและเสี่ยง",
  "Nexus way": "วิธีของ Nexus",
  "Productized and clear": "เป็น Product ชัดเจน",
  "Featured automations": "ออโตเมชันแนะนำ",
  "View full marketplace": "ดูมาร์เก็ตเพลสทั้งหมด",
  "Request custom solution": "ขอ Custom Automation",
  "The marketplace for AI workflows, agents, and automation services.": "มาร์เก็ตเพลสสำหรับ AI Workflow, Agent และ Automation Service",
  "About Nexus AI": "เกี่ยวกับ Nexus AI",
  "Browse marketplace": "ดูมาร์เก็ตเพลส",
  "Join developer waitlist": "เข้าร่วมเวตลิสต์ดีเวลลอปเปอร์",
  "Contact Nexus AI": "ติดต่อ Nexus AI",
  "Send a message": "ส่งข้อความ",
  "Different inquiries need different answers.": "แต่ละคำถามต้องการคำตอบที่ต่างกัน",
  "Tell us what you need. Nexus will route it to the right next step.": "บอกเราว่าคุณต้องการอะไร แล้ว Nexus จะส่งต่อไปยังขั้นตอนที่เหมาะสม",
  "Developer waitlist": "เวตลิสต์ดีเวลลอปเปอร์",
  "Join the waitlist": "เข้าร่วมเวตลิสต์",
  "Developer profiles": "โปรไฟล์ดีเวลลอปเปอร์",
  "Know who builds and operates each automation.": "รู้ว่าใครสร้างและดูแลแต่ละออโตเมชัน",
  "Buyer dashboard": "แดชบอร์ดผู้ซื้อ",
  "Your automation dashboard.": "แดชบอร์ดออโตเมชันของคุณ",
  "Browse automations": "ดูออโตเมชัน",
  "Get support": "ติดต่อซัพพอร์ต",
  "Messages": "ข้อความ",
  "Conversations": "แชตและข้อความ",
  "No messages yet": "ยังไม่มีข้อความ",
  "Developer dashboard": "แดชบอร์ดดีเวลลอปเปอร์",
  "Your profile is live.": "โปรไฟล์ของคุณออนไลน์แล้ว",
  "Marketplace profile": "โปรไฟล์บนมาร์เก็ตเพลส",
  "Products": "สินค้า",
  "Wallet": "วอลเล็ต",
  "Profile": "โปรไฟล์",
  "Submit product": "ส่งสินค้าให้ตรวจ",
  "Save draft": "บันทึกดราฟต์",
  "Submit for review": "ส่งให้แอดมินตรวจ",
  "Admin overview": "ภาพรวมแอดมิน",
  "Marketplace control center.": "ศูนย์ควบคุมมาร์เก็ตเพลส",
  "Product Review Queue": "คิวตรวจสินค้า",
  "Finance": "ไฟแนนซ์",
  "Orders": "ออเดอร์",
  "Inquiries": "อินไควรี",
  "Review Queue": "คิวตรวจ",
  "Create Product": "สร้างสินค้า",
  "View Marketplace": "ดูมาร์เก็ตเพลส",
  "Logout": "ออกจากระบบ",
  "Login": "ล็อกอิน",
  "Home": "หน้าแรก",
  "Marketplace": "มาร์เก็ตเพลส",
  "Developers": "ดีเวลลอปเปอร์",
  "About": "เกี่ยวกับเรา",
  "Contact": "ติดต่อ",
  "Dashboard": "แดชบอร์ด"
};

Object.assign(LITERAL_TRANSLATIONS_TH, {
  "The marketplace for trusted business automation": "มาร์เก็ตเพลสสำหรับออโตเมชันธุรกิจที่เชื่อถือได้",
  "Find, preview, and deploy AI automations without building anything.": "ค้นหา พรีวิว และใช้งานเอไอออโตเมชันได้โดยไม่ต้องสร้างเอง",
  "Nexus AI is the marketplace where businesses find ready-made automations, understand what they do, preview the result, choose self-serve or Nexus guided install, and move toward deployment with confidence.": "Nexus AI คือมาร์เก็ตเพลสที่ช่วยให้ธุรกิจค้นหาออโตเมชันสำเร็จรูป เข้าใจว่าทำอะไร พรีวิวผลลัพธ์ เลือกเซลฟ์เซิร์ฟหรือ Nexus ไกด์ติดตั้ง และเดินหน้าใช้งานได้อย่างมั่นใจ",
  "Explore marketplace": "ดูมาร์เก็ตเพลส",
  "How Nexus works": "Nexus ทำงานอย่างไร",
  "Find automations by business problem, category, and setup path.": "หาออโตเมชันตามปัญหาธุรกิจ หมวดหมู่ และเส้นทางเซ็ตอัพ",
  "Open a product popup and see the expected output before buying.": "เปิดป๊อปอัปโปรดักต์และดูผลลัพธ์ที่คาดหวังก่อนซื้อ",
  "Select options and see how the automation changes for your use case.": "เลือกออปชันและดูว่าออโตเมชันเปลี่ยนตามยูสเคสของคุณอย่างไร",
  "Choose self-serve or Nexus guided install before checkout.": "เลือกเซลฟ์เซิร์ฟหรือ Nexus ไกด์ติดตั้งก่อนเช็กเอาต์",
  "Businesses want AI outcomes, not another tool to figure out.": "ธุรกิจต้องการผลลัพธ์จากเอไอ ไม่ใช่เครื่องมืออีกตัวที่ต้องเรียนรู้เอง",
  "Most companies already know AI can help. The problem is turning that potential into something that actually works inside the business. Today, teams are forced to compare tools, hire freelancers, download templates, connect APIs, manage credentials, troubleshoot workflow errors, or trust vague AI claims.": "บริษัทส่วนใหญ่รู้แล้วว่าเอไอช่วยได้ ปัญหาคือการเปลี่ยนศักยภาพนั้นให้เป็นสิ่งที่ทำงานจริงในธุรกิจ วันนี้ทีมต้องเทียบเครื่องมือ จ้างฟรีแลนซ์ ดาวน์โหลดเทมเพลต เชื่อม API จัดการ credentials แก้ error ของเวิร์กโฟลว์ หรือเชื่อคำโฆษณาเอไอที่ไม่ชัดเจน",
  "Nexus AI changes that by turning automations into marketplace products. A business can see what the automation solves, what it outputs, who operates it, what setup requires, and whether it should be self-serve or guided.": "Nexus AI เปลี่ยนเรื่องนี้ด้วยการทำให้ออโตเมชันกลายเป็นโปรดักต์ในมาร์เก็ตเพลส ธุรกิจจะเห็นว่าออโตเมชันแก้ปัญหาอะไร ให้ผลลัพธ์อะไร ใครเป็นผู้ดูแล ต้องเซ็ตอัพอะไร และควรใช้แบบเซลฟ์เซิร์ฟหรือแบบไกด์ติดตั้ง",
  "Old way": "วิธีเดิม",
  "Download workflow templates": "ดาวน์โหลดเทมเพลตเวิร์กโฟลว์",
  "Hire someone without knowing the result": "จ้างคนโดยยังไม่เห็นผลลัพธ์",
  "Connect tools manually": "เชื่อมเครื่องมือเอง",
  "Debug API and setup errors alone": "แก้ API และ error ตอนเซ็ตอัพเอง",
  "Trust overpromised AI claims": "เชื่อคำเคลมเอไอที่เกินจริง",
  "Nexus way": "วิธีของ Nexus",
  "Browse by business outcome": "เลือกดูตามผลลัพธ์ธุรกิจ",
  "Preview before committing": "พรีวิวก่อนตัดสินใจ",
  "Choose setup path upfront": "เลือกเส้นทางเซ็ตอัพตั้งแต่แรก",
  "Use trusted developer/operator profiles": "ดูโปรไฟล์ดีเวลลอปเปอร์หรือโอเปอเรเตอร์ที่น่าเชื่อถือ",
  "Prepare for checkout and deployment": "เตรียมพร้อมสำหรับเช็กเอาต์และใช้งานจริง",
  "From business problem to automation setup.": "จากปัญหาธุรกิจสู่การเซ็ตอัพออโตเมชัน",
  "Nexus is designed so a non-technical business user can understand the product before touching setup, payment, or implementation.": "Nexus ถูกออกแบบให้ผู้ใช้ธุรกิจที่ไม่ใช่สายเทคนิคเข้าใจโปรดักต์ก่อนแตะเรื่องเซ็ตอัพ การจ่ายเงิน หรือการนำไปใช้จริง",
  "Search the marketplace": "ค้นหาในมาร์เก็ตเพลส",
  "Browse automations by category, pricing model, setup type, and business outcome.": "เลือกดูออโตเมชันตามหมวดหมู่ โมเดลราคา ประเภทเซ็ตอัพ และผลลัพธ์ธุรกิจ",
  "Open the product popup": "เปิดป๊อปอัปโปรดักต์",
  "See the product explanation, preview, required inputs, outputs, trust points, and reviews.": "ดูคำอธิบายโปรดักต์ พรีวิว ข้อมูลที่ต้องใช้ ผลลัพธ์ จุดสร้างความเชื่อมั่น และรีวิว",
  "Choose customization": "เลือกคัสตอมไมซ์",
  "Some automations offer different versions. Click each option to preview how the output changes.": "ออโตเมชันบางตัวมีหลายเวอร์ชัน คลิกแต่ละออปชันเพื่อพรีวิวว่าผลลัพธ์เปลี่ยนอย่างไร",
  "Select setup path": "เลือกเส้นทางเซ็ตอัพ",
  "Choose Self-Serve Setup or Nexus Guided Install before continuing to checkout preparation.": "เลือก Self-Serve Setup หรือ Nexus Guided Install ก่อนเข้าสู่การเตรียมเช็กเอาต์",
  "Ready-made products loaded from your marketplace database.": "โปรดักต์สำเร็จรูปที่โหลดจากฐานข้อมูลมาร์เก็ตเพลสของคุณ",
  "These cards are pulled from Supabase. Use the hidden admin dashboard to create, publish, edit, preview, customize, pause, or delete marketplace listings.": "การ์ดเหล่านี้ดึงจาก Supabase ใช้แอดมินแดชบอร์ดแบบ hidden เพื่อสร้าง เผยแพร่ แก้ไข พรีวิว คัสตอม พัก หรือ ลบ listing ในมาร์เก็ตเพลส",
  "Every listing should explain the outcome, not hide behind technical language.": "ทุก listing ควรอธิบายผลลัพธ์ ไม่ใช่ซ่อนอยู่หลังภาษาทางเทคนิค",
  "Nexus products are designed to help businesses understand what they are buying. Each listing can include a preview, setup path, required inputs, outputs, pricing, customization options, reviews, and a developer or operator profile.": "โปรดักต์ของ Nexus ถูกออกแบบให้ธุรกิจเข้าใจว่ากำลังซื้ออะไร แต่ละ listing ใส่พรีวิว เส้นทางเซ็ตอัพ ข้อมูลที่ต้องใช้ ผลลัพธ์ ราคา ออปชันคัสตอม รีวิว และโปรไฟล์ดีเวลลอปเปอร์หรือโอเปอเรเตอร์ได้",
  "Preview modes": "โหมดพรีวิว",
  "Template, code, screenshot URL, or base64 image.": "เทมเพลต โค้ด URL รูปสกรีนช็อต หรือรูป base64",
  "Customization previews": "พรีวิวคัสตอมไมซ์",
  "Each customization can show how the automation changes.": "แต่ละคัสตอมไมซ์สามารถแสดงว่าออโตเมชันเปลี่ยนอย่างไร",
  "Buyer-ready setup": "เซ็ตอัพพร้อมสำหรับผู้ซื้อ",
  "Self-serve and Nexus guided install are built into the flow.": "เซลฟ์เซิร์ฟและ Nexus ไกด์ติดตั้งอยู่ในโฟลว์แล้ว",
  "Two-sided marketplace": "มาร์เก็ตเพลสสองฝั่ง",
  "Built for businesses now. Built for developers next.": "สร้างเพื่อธุรกิจตอนนี้ และเพื่อดีเวลลอปเปอร์ในขั้นต่อไป",
  "Nexus starts with internal products so the buyer experience is strong. Then approved developers can join, list automations, and sell through a trusted marketplace.": "Nexus เริ่มจากโปรดักต์ภายในเพื่อให้ประสบการณ์ผู้ซื้อแข็งแรง จากนั้นดีเวลลอปเปอร์ที่ผ่านการอนุมัติจะเข้าร่วม ลง listing ออโตเมชัน และขายผ่านมาร์เก็ตเพลสที่น่าเชื่อถือได้",
  "For businesses": "สำหรับธุรกิจ",
  "Use automation without managing the workflow.": "ใช้ออโตเมชันโดยไม่ต้องจัดการเวิร์กโฟลว์เอง",
  "Businesses should not need to understand workflow builders, prompts, API failures, or hosting problems. Nexus helps them compare automation products by outcome, preview, setup path, and trust.": "ธุรกิจไม่ควรต้องเข้าใจ workflow builder, prompt, API failure หรือปัญหา hosting เอง Nexus ช่วยให้เทียบโปรดักต์ออโตเมชันตามผลลัพธ์ พรีวิว เส้นทางเซ็ตอัพ และความน่าเชื่อถือ",
  "Find automation by problem": "หาออโตเมชันจากปัญหา",
  "Preview before setup": "พรีวิวก่อนเซ็ตอัพ",
  "Choose self-serve or guided install": "เลือกเซลฟ์เซิร์ฟหรือไกด์ติดตั้ง",
  "Submit checkout preparation": "ส่งข้อมูลเตรียมเช็กเอาต์",
  "Browse products": "ดูโปรดักต์",
  "For developers": "สำหรับดีเวลลอปเปอร์",
  "Turn automations into repeatable products.": "เปลี่ยนออโตเมชันให้เป็นโปรดักต์ที่ขายซ้ำได้",
  "Developers will eventually be able to submit automations, add previews, define customization options, and sell through Nexus without building a marketplace or managing every customer manually.": "ดีเวลลอปเปอร์จะสามารถส่งออโตเมชัน เพิ่มพรีวิว กำหนดออปชันคัสตอม และขายผ่าน Nexus ได้โดยไม่ต้องสร้างมาร์เก็ตเพลสหรือจัดการลูกค้าทุกคนเอง",
  "Prepare automation products": "เตรียมโปรดักต์ออโตเมชัน",
  "Add previews and customization options": "เพิ่มพรีวิวและออปชันคัสตอม",
  "Build a public developer profile": "สร้างโปรไฟล์ดีเวลลอปเปอร์สาธารณะ",
  "Sell through the Nexus trust layer": "ขายผ่าน trust layer ของ Nexus",
  "The long-term vision": "วิสัยทัศน์ระยะยาว",
  "Nexus becomes the authority on which automations actually work.": "Nexus จะกลายเป็นแหล่งอ้างอิงว่าออโตเมชันไหนใช้งานได้จริง",
  "The AI market is filled with hype, vague promises, and tools that are hard to compare. Nexus becomes valuable by creating structure: product pages, previews, reviews, developer profiles, setup paths, and real buyer feedback.": "ตลาดเอไอเต็มไปด้วย hype คำสัญญาที่ไม่ชัด และเครื่องมือที่เทียบกันยาก Nexus มีคุณค่าด้วยการสร้างโครงสร้าง: หน้าโปรดักต์ พรีวิว รีวิว โปรไฟล์ดีเวลลอปเปอร์ เส้นทางเซ็ตอัพ และ feedback จริงจากผู้ซื้อ",
  "Marketplace roadmap": "โรดแมปมาร์เก็ตเพลส",
  "Built in phases so the foundation works first.": "สร้างเป็นเฟสเพื่อให้ฐานทำงานได้ก่อน",
  "Start with the marketplace or request a custom automation.": "เริ่มจากมาร์เก็ตเพลสหรือรีเควสต์คัสตอมออโตเมชัน",
  "Browse available products, open a product popup, preview the output, choose setup path, or contact Nexus if your workflow is not listed yet.": "ดูโปรดักต์ที่มี เปิดป๊อปอัปโปรดักต์ พรีวิวผลลัพธ์ เลือกเส้นทางเซ็ตอัพ หรือ ติดต่อ Nexus ถ้าเวิร์กโฟลว์ของคุณยังไม่มีใน listing",
  "Contact Nexus": "ติดต่อ Nexus",
  "Buyer dashboard": "แดชบอร์ดผู้ซื้อ",
  "Track your automations, view outputs, complete setup, and monitor important activity from one clean dashboard.": "ติดตามออโตเมชัน ดูผลลัพธ์ ทำเซ็ตอัพให้ครบ และดู activity สำคัญจากแดชบอร์ดเดียว",
  "Account status": "สถานะบัญชี",
  "Checking your automation status...": "กำลังเช็กสถานะออโตเมชันของคุณ...",
  "My Automations": "ออโตเมชันของฉัน",
  "Activity": "Activity",
  "What needs your attention?": "อะไรที่ต้องดูตอนนี้",
  "Your most important automation updates in one place.": "อัปเดตออโตเมชันสำคัญของคุณในที่เดียว",
  "Purchased automations": "ออโตเมชันที่ซื้อแล้ว",
  "Manage setup, status, and latest results for each automation.": "จัดการเซ็ตอัพ สถานะ และผลลัพธ์ล่าสุดของแต่ละออโตเมชัน",
  "Automation outputs": "ผลลัพธ์ออโตเมชัน",
  "Reports, generated files, and workflow results from your automations.": "รีพอร์ต ไฟล์ที่สร้าง และผลลัพธ์เวิร์กโฟลว์จากออโตเมชันของคุณ",
  "Setup and runtime logs": "ล็อกเซ็ตอัพและรันไทม์",
  "Important status updates, setup events, and runtime errors.": "อัปเดตสถานะสำคัญ อีเวนต์เซ็ตอัพ และ runtime error",
  "Orders and billing": "ออเดอร์และบิลลิง",
  "Your purchased automations and payment status.": "ออโตเมชันที่คุณซื้อและสถานะการจ่ายเงิน",
  "Messages with Nexus and developers.": "ข้อความกับ Nexus และดีเวลลอปเปอร์",
  "Developer dashboard": "แดชบอร์ดดีเวลลอปเปอร์",
  "Manage your public marketplace profile, submit products for Nexus approval, handle buyer messages, and prepare payouts when payments are enabled.": "จัดการโปรไฟล์มาร์เก็ตเพลส ส่งโปรดักต์ให้ Nexus อนุมัติ ตอบข้อความผู้ซื้อ และเตรียม payout เมื่อเปิดระบบจ่ายเงิน",
  "View public profile": "ดูโปรไฟล์สาธารณะ",
  "Your profile is active in the developer directory.": "โปรไฟล์ของคุณแสดงในไดเรกทอรีดีเวลลอปเปอร์แล้ว",
  "Admin verification is system-controlled.": "การ verify โดยแอดมินเป็นค่าที่ระบบควบคุม",
  "Your public builder identity on Nexus.": "ตัวตน builder สาธารณะของคุณบน Nexus",
  "Admin overview": "ภาพรวมแอดมิน",
  "Marketplace control center.": "ศูนย์ควบคุมมาร์เก็ตเพลส",
  "Review products, orders, developer submissions, buyer automations, contact messages, waitlist signups, and finance signals from one launch-ready command view.": "ตรวจโปรดักต์ ออเดอร์ งานที่ดีเวลลอปเปอร์ส่ง ออโตเมชันผู้ซื้อ ข้อความติดต่อ waitlist และข้อมูลไฟแนนซ์จากหน้า command view ที่พร้อม launch",
  "Review products": "ตรวจโปรดักต์",
  "Open messages": "เปิดข้อความ",
  "Launch metrics": "ตัวเลข launch",
  "Fast readout of marketplace content, developers, orders, and support load.": "ดูภาพรวมคอนเทนต์มาร์เก็ตเพลส ดีเวลลอปเปอร์ ออเดอร์ และโหลดซัพพอร์ตอย่างรวดเร็ว",
  "Total products": "โปรดักต์ทั้งหมด",
  "Live products": "โปรดักต์ที่ live",
  "Pending reviews": "รีวิวที่รอตรวจ",
  "Contact messages": "ข้อความติดต่อ",
  "Checkout prep": "เตรียมเช็กเอาต์",
  "What to handle next": "สิ่งที่ควรจัดการต่อ",
  "Use these cards for the daily admin flow during MVP launch.": "ใช้การ์ดเหล่านี้สำหรับโฟลว์แอดมินรายวันช่วง MVP launch",
  "All orders": "ออเดอร์ทั้งหมด",
  "Review paid orders, guided install requests, pending checkouts, and completed installs.": "ตรวจออเดอร์ที่จ่ายแล้ว รีเควสต์ไกด์ติดตั้ง เช็กเอาต์ที่รอ และ install ที่เสร็จแล้ว",
  "Product review queue": "คิวตรวจโปรดักต์",
  "Approve or reject developer-submitted products before they go live.": "อนุมัติหรือปฏิเสธโปรดักต์ที่ดีเวลลอปเปอร์ส่งก่อนขึ้น live",
  "Customer automations": "ออโตเมชันลูกค้า",
  "Track setup status, runtime status, cancellation requests, and product issues.": "ติดตามสถานะเซ็ตอัพ สถานะรันไทม์ รีเควสต์ยกเลิก และปัญหาโปรดักต์",
  "Messages and inquiries": "ข้อความและอินไควรี",
  "Handle contact forms, custom requests, buyer messages, and developer conversations.": "จัดการฟอร์มติดต่อ คัสตอมรีเควสต์ ข้อความผู้ซื้อ และบทสนทนาดีเวลลอปเปอร์",
  "Marketplace management": "การจัดการมาร์เก็ตเพลส",
  "Create content, tune trust signals, review finance, and manage onboarding.": "สร้างคอนเทนต์ ปรับ trust signal ตรวจไฟแนนซ์ และจัดการ onboarding",
  "Product management": "จัดการโปรดักต์",
  "Create, edit, pause, delete, sync, and preview automation products.": "สร้าง แก้ไข พัก ลบ sync และพรีวิวโปรดักต์ออโตเมชัน",
  "Revenue overview": "ภาพรวมรายได้",
  "Review Nexus revenue, developer earnings, and transfer status when payments are enabled.": "ดูรายได้ Nexus รายได้ดีเวลลอปเปอร์ และสถานะ transfer เมื่อเปิดระบบจ่ายเงิน",
  "Developer waitlist": "เวตลิสต์ดีเวลลอปเปอร์",
  "See new developer interest before opening the platform broadly.": "ดูดีเวลลอปเปอร์ที่สนใจก่อนเปิดแพลตฟอร์มกว้างขึ้น"
});

Object.assign(LITERAL_TRANSLATIONS_TH, {
  "Loading product listing...": "กำลังโหลดโปรดักต์ listing...",
  "Nexus is loading a live marketplace product card so this section works like the real buyer experience.": "Nexus กำลังโหลดการ์ดโปรดักต์จริงจากมาร์เก็ตเพลส เพื่อให้ส่วนนี้ทำงานเหมือนประสบการณ์ผู้ซื้อจริง",
  "Marketplace product": "โปรดักต์มาร์เก็ตเพลส",
  "Loading...": "กำลังโหลด...",
  "Standard product": "โปรดักต์มาตรฐาน",
  "Custom request": "คัสตอมรีเควสต์",
  "One-time": "จ่ายครั้งเดียว",
  "Monthly": "รายเดือน",
  "Setup fee": "ค่าเซ็ตอัพ",
  "Custom quote": "เสนอราคาแบบคัสตอม",
  "Active": "ใช้งานอยู่",
  "Draft": "ดราฟต์",
  "Paused": "พักไว้",
  "Pending": "รอดำเนินการ",
  "Approved": "อนุมัติแล้ว",
  "Rejected": "ปฏิเสธแล้ว"
});

Object.assign(LITERAL_TRANSLATIONS_TH, {
  "Buyer conversations": "บทสนทนาผู้ซื้อ",
  "Buyer messages": "ข้อความผู้ซื้อ",
  "Platform conversations": "บทสนทนาแพลตฟอร์ม",
  "No platform messages yet": "ยังไม่มีข้อความแพลตฟอร์ม",
  "Buyer and developer conversations will appear here.": "บทสนทนาของผู้ซื้อและดีเวลลอปเปอร์จะแสดงที่นี่",
  "No buyer messages yet": "ยังไม่มีข้อความจากผู้ซื้อ",
  "When buyers message you about products or your profile, the conversations will appear here.": "เมื่อผู้ซื้อส่งข้อความเกี่ยวกับโปรดักต์หรือโปรไฟล์ของคุณ บทสนทนาจะแสดงที่นี่",
  "Messages with Nexus and developers will appear here.": "ข้อความกับ Nexus และดีเวลลอปเปอร์จะแสดงที่นี่",
  "Loading messages...": "กำลังโหลดข้อความ...",
  "Loading conversation...": "กำลังโหลดบทสนทนา...",
  "Please wait while Nexus loads your messages.": "กรุณารอสักครู่ขณะที่ Nexus โหลดข้อความของคุณ",
  "Could not load messages": "โหลดข้อความไม่ได้",
  "Could not load conversation": "โหลดบทสนทนาไม่ได้",
  "Please refresh and try again.": "กรุณารีเฟรชแล้วลองอีกครั้ง",
  "Please try again.": "กรุณาลองอีกครั้ง",
  "Platform message": "ข้อความแพลตฟอร์ม",
  "No messages yet.": "ยังไม่มีข้อความ",
  "Write the first reply below.": "เขียนข้อความตอบกลับแรกด้านล่าง",
  "Write a reply...": "เขียนข้อความตอบกลับ...",
  "Send reply": "ส่งข้อความตอบกลับ",
  "Sending...": "กำลังส่ง...",
  "Refresh": "รีเฟรช",
  "Conversation": "บทสนทนา",
  "Conversations": "บทสนทนา",
  "Nexus": "Nexus",
  "Buyer": "ผู้ซื้อ",
  "Developer": "ดีเวลลอปเปอร์"
});

const THAI_GLOSSARY_REPLACEMENTS = [
  [/\bNexus Guided Install\b/g, "Nexus ไกด์ติดตั้ง"],
  [/\bSelf-Serve Setup\b/g, "เซลฟ์เซิร์ฟเซ็ตอัพ"],
  [/\bSelf-serve\b/gi, "เซลฟ์เซิร์ฟ"],
  [/\bAI\b/g, "เอไอ"],
  [/\bautomations\b/gi, "ออโตเมชัน"],
  [/\bautomation\b/gi, "ออโตเมชัน"],
  [/\bworkflows\b/gi, "เวิร์กโฟลว์"],
  [/\bworkflow\b/gi, "เวิร์กโฟลว์"],
  [/\bmarketplace\b/gi, "มาร์เก็ตเพลส"],
  [/\bdevelopers\b/gi, "ดีเวลลอปเปอร์"],
  [/\bdeveloper\b/gi, "ดีเวลลอปเปอร์"],
  [/\bdashboard\b/gi, "แดชบอร์ด"],
  [/\bproducts\b/gi, "โปรดักต์"],
  [/\bproduct\b/gi, "โปรดักต์"],
  [/\bpreview\b/gi, "พรีวิว"],
  [/\bsetup\b/gi, "เซ็ตอัพ"],
  [/\bcheckout\b/gi, "เช็กเอาต์"],
  [/\bcustom\b/gi, "คัสตอม"],
  [/\brequest\b/gi, "รีเควสต์"],
  [/\brequests\b/gi, "รีเควสต์"],
  [/\border\b/gi, "ออเดอร์"],
  [/\borders\b/gi, "ออเดอร์"],
  [/\bmessages\b/gi, "ข้อความ"],
  [/\bmessage\b/gi, "ข้อความ"],
  [/\bprofile\b/gi, "โปรไฟล์"],
  [/\breviews\b/gi, "รีวิว"],
  [/\breview\b/gi, "รีวิว"],
  [/\bwallet\b/gi, "วอลเล็ต"],
  [/\bfinance\b/gi, "ไฟแนนซ์"],
  [/\blogin\b/gi, "ล็อกอิน"],
  [/\blogout\b/gi, "ออกจากระบบ"],
  [/\bbuyer\b/gi, "ผู้ซื้อ"],
  [/\bbuyers\b/gi, "ผู้ซื้อ"],
  [/\badmin\b/gi, "แอดมิน"],
  [/\bStripe\b/g, "Stripe"],
  [/\bn8n\b/g, "n8n"],
  [/\bAPI\b/g, "API"],
  [/\bSupabase\b/g, "Supabase"]
];

const EXTRA_I18N = {
  th: {
    nav_home: "???????",
    nav_marketplace: "????????????",
    nav_developers: "????????",
    nav_browse_developers: "??????????",
    nav_join_waitlist: "????????????????",
    nav_developer_apply: "?????????????????",
    nav_developer_login: "???????????????",
    nav_about: "????????????",
    nav_contact: "??????",
    nav_dashboard: "????????",
    nav_admin: "??????",
    nav_login: "???????????",
    nav_logout: "??????????",
    nav_currency: "????????",
    nav_language: "????",
    nav_toggle: "????????",
    common_browse_automations: "???????????",
    common_explore_marketplace: "??????????????",
    common_request_custom_automation: "??????????????????????",
    common_join_developer_waitlist: "????????????????????????",
    common_get_support: "??????????????",
    common_buy: "????",
    common_preview: "?????????",
    common_view: "??",
    common_view_setup: "????????????",
    common_view_output: "??????????",
    common_complete_setup: "???????????????",
    common_message_developer: "?????????????????????",
    common_message_nexus: "????????????? Nexus",
    dashboard_buyer_title: "???????????????????????",
    dashboard_buyer_subtitle: "??????????????? ?????????? ??????? ???????????????????????????????????",
    dashboard_overview: "??????",
    dashboard_automations: "???????????????",
    dashboard_outputs: "????????",
    dashboard_activity: "???????",
    dashboard_orders: "?????????",
    dashboard_messages: "???????"
  },
  zh: {
    nav_home: "??",
    nav_marketplace: "??",
    nav_developers: "???",
    nav_browse_developers: "?????",
    nav_join_waitlist: "??????",
    nav_developer_apply: "???????",
    nav_developer_login: "?????",
    nav_about: "????",
    nav_contact: "??",
    nav_dashboard: "???",
    nav_admin: "???",
    nav_login: "??",
    nav_logout: "??",
    nav_currency: "??",
    nav_language: "??",
    nav_toggle: "????",
    common_explore_marketplace: "????",
    common_request_custom_automation: "???????",
    common_buy: "??",
    common_preview: "????",
    common_view: "??",
    dashboard_messages: "??"
  },
  es: {
    nav_home: "Inicio",
    nav_marketplace: "Marketplace",
    nav_developers: "Desarrolladores",
    nav_browse_developers: "Ver desarrolladores",
    nav_join_waitlist: "Unirse a la lista",
    nav_developer_apply: "Aplicar como desarrollador",
    nav_developer_login: "Login de desarrollador",
    nav_about: "Acerca de",
    nav_contact: "Contacto",
    nav_dashboard: "Panel",
    nav_admin: "Admin",
    nav_login: "Iniciar sesi�n",
    nav_logout: "Cerrar sesi�n",
    nav_currency: "Moneda",
    nav_language: "Idioma",
    nav_toggle: "Abrir men�",
    common_explore_marketplace: "Explorar marketplace",
    common_request_custom_automation: "Solicitar automatizaci�n personalizada",
    common_buy: "Comprar",
    common_preview: "Ver resultado",
    common_view: "Ver",
    dashboard_messages: "Mensajes"
  },
  hi: {
    nav_home: "???",
    nav_marketplace: "????????????",
    nav_developers: "??????",
    nav_browse_developers: "?????? ?????",
    nav_join_waitlist: "???????? ??? ??????",
    nav_developer_apply: "?????? ?????",
    nav_developer_login: "?????? ?????",
    nav_about: "????? ???? ???",
    nav_contact: "??????",
    nav_dashboard: "????????",
    nav_admin: "?????",
    nav_login: "?????",
    nav_logout: "??????",
    nav_currency: "??????",
    nav_language: "????",
    nav_toggle: "???? ?????",
    common_explore_marketplace: "???????????? ?????",
    common_request_custom_automation: "????? ??????? ?? ?????? ????",
    common_buy: "??????",
    common_preview: "?????? ?????",
    common_view: "?????",
    dashboard_messages: "?????"
  },
  ar: {
    nav_home: "????????",
    nav_marketplace: "?????",
    nav_developers: "????????",
    nav_browse_developers: "???? ????????",
    nav_join_waitlist: "???? ??? ????? ????????",
    nav_developer_apply: "??? ???????? ?????",
    nav_developer_login: "???? ??????",
    nav_about: "?? ???",
    nav_contact: "?????",
    nav_dashboard: "???? ??????",
    nav_admin: "??????",
    nav_login: "????? ??????",
    nav_logout: "????? ??????",
    nav_currency: "??????",
    nav_language: "?????",
    nav_toggle: "??? ???????",
    common_explore_marketplace: "???? ?????",
    common_request_custom_automation: "???? ????? ?????",
    common_buy: "????",
    common_preview: "??? ??????",
    common_view: "???",
    dashboard_messages: "???????"
  },
  fr: {
    nav_home: "Accueil",
    nav_marketplace: "Marketplace",
    nav_developers: "D�veloppeurs",
    nav_browse_developers: "Voir les d�veloppeurs",
    nav_join_waitlist: "Rejoindre la liste",
    nav_developer_apply: "Candidature d�veloppeur",
    nav_developer_login: "Connexion d�veloppeur",
    nav_about: "� propos",
    nav_contact: "Contact",
    nav_dashboard: "Tableau de bord",
    nav_admin: "Admin",
    nav_login: "Connexion",
    nav_logout: "D�connexion",
    nav_currency: "Devise",
    nav_language: "Langue",
    nav_toggle: "Ouvrir le menu",
    common_explore_marketplace: "Explorer le marketplace",
    common_request_custom_automation: "Demander une automatisation personnalis�e",
    common_buy: "Acheter",
    common_preview: "Voir le r�sultat",
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
    "Solve business bottlenecks with ready-made automation.": "???????????????????????????????????????",
    "Explore marketplace": "??????????????",
    "How it works": "????????????",
    "Find": "?????",
    "Understand": "??????",
    "Set up": "???????",
    "Run": "??????",
    "Businesses need outcomes, not another tool to manage.": "???????????????????? ?????????????????????????????????",
    "Marketplace": "????????????",
    "Developers": "????????",
    "Contact": "??????",
    "About": "????????????",
    "Dashboard": "????????",
    "Request custom solution": "??????????????????????",
    "Product reviews": "???????????",
    "Developer reviews": "?????????????",
    "Verified purchase": "????????"
  },
  zh: {
    "Solve business bottlenecks with ready-made automation.": "?????????????",
    "Explore marketplace": "????",
    "How it works": "????",
    "Find": "??",
    "Understand": "??",
    "Set up": "??",
    "Run": "??",
    "Businesses need outcomes, not another tool to manage.": "??????,?????????????",
    "Marketplace": "??",
    "Developers": "???",
    "Contact": "??",
    "About": "????",
    "Dashboard": "???",
    "Request custom solution": "???????",
    "Product reviews": "????",
    "Developer reviews": "?????",
    "Verified purchase": "?????"
  },
  es: {
    "Solve business bottlenecks with ready-made automation.": "Resuelve cuellos de botella con automatizaciones listas para usar.",
    "Explore marketplace": "Explorar marketplace",
    "How it works": "C�mo funciona",
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
    "Request custom solution": "Solicitar automatizaci�n personalizada",
    "Product reviews": "Rese�as del producto",
    "Developer reviews": "Rese�as del desarrollador",
    "Verified purchase": "Compra verificada"
  },
  hi: {
    "Solve business bottlenecks with ready-made automation.": "????? ??????? ?? ??????? bottlenecks ?? ?????",
    "Explore marketplace": "???????????? ?????",
    "How it works": "?? ???? ??? ???? ??",
    "Find": "?????",
    "Understand": "?????",
    "Set up": "????? ????",
    "Run": "?????",
    "Businesses need outcomes, not another tool to manage.": "??????? ?? ?????? ?????, ??????? ?? ??? ?? ?? ??? ?????",
    "Marketplace": "????????????",
    "Developers": "??????",
    "Contact": "??????",
    "About": "????? ???? ???",
    "Dashboard": "????????",
    "Request custom solution": "????? ??????? ?? ?????? ????",
    "Product reviews": "???????? ??????",
    "Developer reviews": "?????? ??????",
    "Verified purchase": "???????? ????"
  },
  ar: {
    "Solve business bottlenecks with ready-made automation.": "?? ???????? ????? ???????? ????? ?????.",
    "Explore marketplace": "???? ?????",
    "How it works": "??? ????",
    "Find": "????",
    "Understand": "????",
    "Set up": "?????",
    "Run": "?????",
    "Businesses need outcomes, not another tool to manage.": "??????? ????? ??? ?????? ?? ??? ???? ???? ????????.",
    "Marketplace": "?????",
    "Developers": "????????",
    "Contact": "?????",
    "About": "?? ???",
    "Dashboard": "???? ??????",
    "Request custom solution": "???? ????? ?????",
    "Product reviews": "??????? ??????",
    "Developer reviews": "??????? ??????",
    "Verified purchase": "????? ???? ?????"
  },
  fr: {
    "Solve business bottlenecks with ready-made automation.": "R�solvez les blocages m�tier avec des automatisations pr�tes � l'emploi.",
    "Explore marketplace": "Explorer le marketplace",
    "How it works": "Comment �a marche",
    "Find": "Trouver",
    "Understand": "Comprendre",
    "Set up": "Configurer",
    "Run": "Lancer",
    "Businesses need outcomes, not another tool to manage.": "Les entreprises ont besoin de r�sultats, pas d'un outil de plus � g�rer.",
    "Marketplace": "Marketplace",
    "Developers": "D�veloppeurs",
    "Contact": "Contact",
    "About": "� propos",
    "Dashboard": "Tableau de bord",
    "Request custom solution": "Demander une automatisation personnalis�e",
    "Product reviews": "Avis produit",
    "Developer reviews": "Avis d�veloppeur",
    "Verified purchase": "Achat v�rifi�"
  }
};

Object.assign(LITERAL_TRANSLATIONS.th, {
  "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus ????????????????????????????????????????????????? ???????? ????????????? ??????? ??????????????????? ????????????????????????? ????????????????????????? ??????????????????????????????????????????",
  "Search by business issue, outcome, category, and setup path.": "??????????????????? ??????? ???????? ?????????????????",
  "See what the product does, what it needs, and what it produces.": "????????????????? ??????????? ????????????????????",
  "Choose self-serve or Nexus guided setup based on complexity.": "?????????????????????? Nexus ?????????????????????????",
  "Move from manual work to a repeatable process your team can use.": "???????????????????????????????????????????????",
  "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "?????????????????????????? ??????????????????? ??????????????????????????? ?????????????????? ??????????????????????? ?????????????????????????????????????????????????????????????",
  "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus ?????????????????????????????????????????????????????????????? ????????????????????????????????? ?????????????? ?????????????????????????? ?????????????????????????????????????",
  "Old way": "????????",
  "Slow and unclear": "???????????????",
  "Compare disconnected tools": "??????????????????????????????",
  "Buy software without seeing the outcome": "?????????????????????????????????",
  "Hire builders without a clear product": "????????????????????????????????????",
  "Handle setup and errors alone": "?????????????????????????????",
  "Keep manual workarounds running": "?????????????????????????",
  "Nexus way": "??????? Nexus",
  "Outcome-first and clear": "????????????????????????",
  "Browse by business issue": "?????????????????????",
  "Understand the output before setup": "?????????????????????????",
  "Choose the right setup path upfront": "?????????????????????????????????????",
  "See who built or operates the product": "?????????????????????????????",
  "Move toward a repeatable process": "??????????????????????????????",
  "From business issue to working process.": "????????????????????????????????????",
  "Nexus is designed so a business user can understand the solution before dealing with setup, payment, or technical implementation.": "Nexus ?????????????????????????????????????????????????????????? ??????????? ???????????????????????",
  "Search by outcome": "???????????????",
  "Browse products by business issue, department, pricing model, setup type, and expected result.": "??????????????????????????? ???? ????????? ????????????? ????????????????????",
  "Review the listing": "????????????",
  "See what the product does, what it needs from you, what it outputs, and who operates it.": "????????????????? ????????????????? ????????????????? ??????????",
  "Choose the fit": "?????????????????",
  "Some products offer different versions for different team sizes, reporting styles, or workflows.": "???????????????????????????????????? ???????????? ?????????????????????????",
  "Start setup": "????????????",
  "Choose self-serve when simple or Nexus guided setup when the process needs more care.": "???????????????????????? ??????? Nexus ?????????????????????????????????????",
  "Ready-made products for common business issues.": "?????????????????????????????????????????",
  "Browse productized solutions for reporting, customer support, lead handling, content operations, social listening, and internal team workflows.": "????????????????????????????????????? ?????????????? ???????????? ??????????? ????????????????? ??????????????????????",
  "View full marketplace": "?????????????????????",
  "Every listing explains the outcome first.": "???????????????????????????",
  "Nexus listings are built for business decisions. A product should make it clear what problem it solves, what result it creates, what information is needed, and how setup will work.": "?????????? Nexus ????????????????????????????????? ????????????????????????????????? ???????????????? ????????????????? ?????????????????",
  "Clear output": "??????????????",
  "Reports, alerts, summaries, dashboards, replies, or workflow actions.": "?????? ????????? ???? ???????? ?????????? ???????????????????????",
  "Practical options": "?????????????????????",
  "Choose the version that fits your team, data, and working style.": "??????????????????????????? ?????? ????????????????",
  "Setup support": "???????????????",
  "Use self-serve for simple cases or guided setup for more complex ones.": "?????????????????????????? ??????????????????????????????????????",
  "A hub for businesses and automation builders.": "???????????????????????????????????",
  "Nexus starts by helping businesses find useful solutions. As the platform grows, approved builders can list well-packaged products that solve specific operational problems.": "Nexus ?????????????????????????????????????????????? ???????????????????? ????????????????????????????????????????????????????????????????????????????????????",
  "A marketplace for solving business problems with automation.": "?????????????????????????????????????????????",
  "Nexus helps businesses find packaged solutions for repeat work, reporting, support, lead handling, internal operations, and customer workflows. The goal is simple: make useful automation easy to understand, buy, set up, and trust.": "Nexus ???????????????????????????????????????????????? ?????? ???????? ???????????? ???????? ???????????????????? ???????????????????????????????????????????????? ??????? ?????????? ??????????????",
  "Talk to Nexus": "?????? Nexus",
  "Buying automation is still too confusing.": "????????????????????????????????",
  "Most companies can point to the work that slows them down: reports, inboxes, handoffs, customer questions, follow-ups, and data updates. The hard part is turning those problems into a reliable process without wasting weeks comparing tools or managing a custom build.": "??????????????????????????????????? ???? ?????? ????????? ???????????? ??????????? ????????? ?????????????????? ?????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????",
  "Today, a business often has to choose between hiring an agency, buying another narrow tool, downloading a technical template, or building internally. Nexus creates a clearer path: productized solutions that explain the outcome and setup before you commit.": "?????????????????????????????????????????? ?????????????????????? ?????????????????????? ????????????????? Nexus ??????????????????????????????????????????????????????????????????????????????????",
  "Current market": "????????????",
  "Template libraries": "??????????????",
  "Useful for technical users, but risky for teams that cannot debug, host, or maintain them.": "???????????????????????????? ?????????????????????????? ????? ?????????????????",
  "Vague software tools": "?????????????????????",
  "Many products sound impressive but do not clearly show what they deliver or how they fit daily operations.": "????????????????? ???????????????????????????????????????????????????????",
  "Custom agencies": "?????????????",
  "Can work, but are often slow, expensive, and hard to compare before committing.": "????? ????????? ??? ???????????????????????",
  "A marketplace layer that packages useful automations as understandable business products.": "???????????????????????????????????????????????????????????????????",
  "Tell us what business process you want to improve.": "????????????????????????????????????????",
  "Use this page for product questions, custom process requests, setup support, partnerships, or builder access. Nexus routes each message into the admin inbox so the right person can review it and follow up.": "??????????????????????????? ???????????????? ??????????????? ????????????? ???????????????????????????? Nexus ???????????????????????????????????????????????????????????????????????",
  "Send a message": "??????????",
  "Browse marketplace": "??????????????",
  "For product questions, setup support, custom requests, and marketplace help.": "????????????????? ??????????????? ?????????? ?????????????????????????????????????",
  "Available after intake": "??????????????????????????",
  "Share the request first so Nexus can route it to the right support path.": "????????????????????????? Nexus ????????????????????????????????????",
  "Business process requests": "????????????????",
  "Reports, support handoffs, operations tasks, lead follow-up, and internal workflows.": "?????? ???????????????????? ????????????? ???????????? ???????????????????",
  "Within 1-2 business days": "????? 1-2 ????????",
  "For urgent setup or launch requests, mention the timeline clearly.": "??????????????????????????????????????? ?????????????????????????",
  "Different requests need different next steps.": "????????????????????????????????????????",
  "Nexus is a hub for solving recurring business problems. Choose the path that best matches what you need so the request can be reviewed quickly.": "Nexus ????????????????????????????????????? ???????????????????????????????????????????????????????????????",
  "Business buyer": "?????????????",
  "Custom process request": "????????????????",
  "Developer or builder": "????????????????????",
  "Partnerships": "?????????????",
  "Describe the process, the problem, and the outcome you want.": "???????????? ????? ????????????????????",
  "Keep it practical. Explain the manual work, the tools involved, how often it happens, and what should be produced when the process is working properly.": "????????????????????? ??????????????? ??????????????????????? ?????????????????? ???????????????????????????????????????",
  "For buyers": "?????????????",
  "For custom process requests": "??????????????????????",
  "For developers": "??????????????",
  "Contact form": "???????????",
  "Name": "????",
  "Email": "?????",
  "Company": "??????",
  "Inquiry type": "???????????",
  "What do you need?": "??????????????",
  "Send message": "??????????",
  "Your message is saved into the Nexus admin dashboard for review and follow-up.": "??????????????????????????????????????????? Nexus ??????????????????????",
  "What should you write?": "????????????",
  "You do not need technical details. The most useful information is the business goal, the current manual process, and what output you want the finished process to produce.": "??????????????????????????????? ?????????????????????????????????????????? ???????????????????? ????????????????????????????????????????????"
});

const COMMON_LITERAL_TRANSLATIONS = {
  th: {
    "Fix repeat work without managing the build.": "????????????????????????????????????",
    "Businesses should not need to learn workflow builders, debug API errors, or manage hosting to improve a process. Nexus helps teams compare products by outcome, setup effort, and trust.": "?????????????????????????????????????????????????? ????? API ???????????????????????????????????? Nexus ?????????????????????????????????? ???????????????????? ??????????????????",
    "Find products by business issue": "?????????????????????????",
    "Keep setup information in one place": "????????????????????????????",
    "Track orders and conversations from the dashboard": "????????????????????????????????????",
    "Browse products": "????????",
    "Turn useful builds into repeatable products.": "????????????????????????????????????????????????",
    "Builders can package working solutions with clear outcomes, setup requirements, pricing, and support expectations instead of selling every project from scratch.": "????????????????????????????????????????????????? ??????????????? ???? ????????????????????????? ????????????????????????????????????",
    "Create a public builder profile": "???????????????????????????",
    "Submit products for review": "?????????????????",
    "Explain outputs and setup needs": "???????????????????????????????????????????",
    "Message buyers in-platform": "??????????????????????????????",
    "Build trust through product quality": "????????????????????????????????????",
    "Nexus becomes a trusted place to find what works.": "Nexus ????????????????????????????????????????????????????",
    "Business software is crowded and hard to compare. Nexus creates structure around outcomes: product pages, previews, reviews, builder profiles, setup paths, and real buyer feedback.": "???????????????????????????????? Nexus ??????????????????????: ?????????? ?????? ????? ??????????????? ?????????????? ????????????????????????",
    "Over time, better listings and real feedback help teams choose with less risk. The marketplace becomes more useful as it learns which products fit which business problems.": "??????????????? ???????????????????????????????????????????????????????????? ???????????????????????????????????????????????????????????????????????????",
    "Trust Layer": "??????????????????????",
    "Products": "??????",
    "Buyers": "???????",
    "Reviews": "?????",
    "Recommendations": "???????",
    "Automation becomes packaged and understandable.": "?????????????????????????????",
    "Businesses compare real outcomes.": "????????????????????????????",
    "Results create marketplace confidence.": "?????????????????????????????????????",
    "Nexus learns what works for each use case.": "Nexus ?????????????????????????????????????",
    "Built in phases so the foundation works first.": "???????????????????????????????????",
    "Marketplace foundation": "???????????????",
    "Payments and orders": "???????????????????????",
    "Accounts and dashboards": "????????????????",
    "Hosted reliability layer": "?????????????????????????",
    "Start with a product or ask for a custom solution.": "?????????????? ???????????????????",
    "Contact Nexus": "?????? Nexus",
    "The trusted marketplace layer for business automation.": "??????????????????????????????????????????????????????",
    "Developer Waitlist": "????????????????",
    "Privacy": "???????????????",
    "Price": "????",
    "Setup": "???????",
    "Buy": "????",
    "Buy / choose setup": "???? / ????????????",
    "View profile": "?????????",
    "Ask Nexus": "??? Nexus",
    "Message developer": "?????????????????????",
    "Problem it solves": "???????????",
    "Business outcome": "?????????????",
    "Who this is for": "???????????",
    "Outputs": "????????",
    "Required inputs": "????????????????",
    "Ready to use this automation?": "????????????????????????????",
    "No live products yet": "?????????????????????",
    "No results": "????????????",
    "Try changing the filters.": "?????????????????",
    "Choose setup path": "???????????????????",
    "Setup method": "???????????",
    "Continue to secure payment": "??????????????????????????????",
    "Opening secure checkout...": "????????????????????????????...",
    "Self-Serve Setup": "??????????",
    "Nexus Guided Install": "Nexus ???????????",
    "Fastest": "??????????",
    "Managed setup": "?????????????????",
    "Best for complex cases": "??????????????????",
    "Developer profiles": "???????????????",
    "View profile": "?????????",
    "Developer not found": "?????????????",
    "Developer rating": "?????????????",
    "Live products": "?????????????",
    "No live products yet.": "?????????????????????",
    "Review developer": "?????????????",
    "Submit review": "????????",
    "Cancel": "??????",
    "Rating": "?????",
    "Your role": "???????????",
    "Review": "?????",
    "No reviews yet": "?????????????",
    "Loading products...": "???????????????...",
    "Loading developers...": "?????????????????..."
  },
  zh: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus ??????????????????????????????????????????,??????,?????????????",
    "Search by business issue, outcome, category, and setup path.": "???????????????????",
    "See what the product does, what it needs, and what it produces.": "???????????????????",
    "Choose self-serve or Nexus guided setup based on complexity.": "???????????? Nexus ?????",
    "Move from manual work to a repeatable process your team can use.": "??????????????????",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "??????????,?????????????,????????,????????,???????????????????",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus ???????????????????????????????????????????,???????????????",
    "Slow and unclear": "??????",
    "Compare disconnected tools": "?????????",
    "Buy software without seeing the outcome": "???????????",
    "Hire builders without a clear product": "???????????",
    "Handle setup and errors alone": "?????????",
    "Keep manual workarounds running": "??????????",
    "Outcome-first and clear": "?????,????",
    "Browse by business issue": "???????",
    "Understand the output before setup": "????????",
    "Choose the right setup path upfront": "???????????",
    "See who built or operates the product": "??????????",
    "Move toward a repeatable process": "???????",
    "From business issue to working process.": "????????????",
    "Ready-made products for common business issues.": "??????????????",
    "Every listing explains the outcome first.": "???????????",
    "A hub for businesses and automation builders.": "???????????????",
    "Price": "??",
    "Setup": "??",
    "Buy / choose setup": "?? / ????",
    "View profile": "????",
    "Ask Nexus": "?? Nexus",
    "Message developer": "?????",
    "Problem it solves": "?????",
    "Business outcome": "????",
    "Who this is for": "????",
    "Outputs": "??",
    "Required inputs": "????",
    "Ready to use this automation?": "????????????",
    "Choose setup path": "??????",
    "Setup method": "????",
    "Continue to secure payment": "??????",
    "Self-Serve Setup": "????",
    "Nexus Guided Install": "Nexus ????",
    "Developer profiles": "?????",
    "No reviews yet": "????",
    "Loading products...": "??????...",
    "Loading developers...": "???????..."
  },
  es: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus ayuda a los equipos a encontrar automatizaciones pr�cticas para reportes, soporte, operaciones, ventas y flujos internos. Explora por el resultado que necesitas, previsualiza lo que entrega el producto y elige la configuraci�n que encaja con tu equipo.",
    "Search by business issue, outcome, category, and setup path.": "Busca por problema de negocio, resultado, categor�a y tipo de configuraci�n.",
    "See what the product does, what it needs, and what it produces.": "Ve qu� hace el producto, qu� necesita y qu� produce.",
    "Choose self-serve or Nexus guided setup based on complexity.": "Elige configuraci�n self-serve o guiada por Nexus seg�n la complejidad.",
    "Move from manual work to a repeatable process your team can use.": "Convierte trabajo manual en un proceso repetible para tu equipo.",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "La mayor�a de los equipos no tienen un problema de ideas, tienen un problema de ejecuci�n. Los reportes siguen tomando horas, las preguntas de clientes se repiten, el seguimiento comercial se pierde y los traspasos internos dependen de copiar informaci�n entre herramientas.",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus convierte esos problemas repetibles en productos claros de marketplace. Cada ficha explica el problema que resuelve, el resultado que crea, lo que requiere la configuraci�n y si tu equipo puede hacerlo solo o necesita gu�a.",
    "Slow and unclear": "Lento y poco claro",
    "Compare disconnected tools": "Comparar herramientas desconectadas",
    "Buy software without seeing the outcome": "Comprar software sin ver el resultado",
    "Hire builders without a clear product": "Contratar builders sin un producto claro",
    "Handle setup and errors alone": "Gestionar configuraci�n y errores solo",
    "Keep manual workarounds running": "Mantener soluciones manuales",
    "Outcome-first and clear": "Claro y orientado al resultado",
    "Browse by business issue": "Explorar por problema de negocio",
    "Understand the output before setup": "Entender el resultado antes de configurar",
    "Choose the right setup path upfront": "Elegir la configuraci�n correcta desde el inicio",
    "See who built or operates the product": "Ver qui�n cre� u opera el producto",
    "Move toward a repeatable process": "Avanzar hacia un proceso repetible",
    "From business issue to working process.": "Del problema de negocio al proceso funcionando.",
    "Ready-made products for common business issues.": "Productos listos para problemas comunes de negocio.",
    "Every listing explains the outcome first.": "Cada ficha explica primero el resultado.",
    "A hub for businesses and automation builders.": "Un hub para empresas y builders de automatizaci�n.",
    "Price": "Precio",
    "Setup": "Configuraci�n",
    "Buy / choose setup": "Comprar / elegir configuraci�n",
    "View profile": "Ver perfil",
    "Ask Nexus": "Preguntar a Nexus",
    "Message developer": "Enviar mensaje al desarrollador",
    "Problem it solves": "Problema que resuelve",
    "Business outcome": "Resultado de negocio",
    "Who this is for": "Para qui�n es",
    "Outputs": "Resultados",
    "Required inputs": "Datos necesarios",
    "Ready to use this automation?": "�Listo para usar esta automatizaci�n?",
    "Choose setup path": "Elige configuraci�n",
    "Setup method": "M�todo de configuraci�n",
    "Continue to secure payment": "Continuar al pago seguro",
    "Self-Serve Setup": "Configuraci�n self-serve",
    "Nexus Guided Install": "Instalaci�n guiada por Nexus",
    "Developer profiles": "Perfiles de desarrolladores",
    "No reviews yet": "A�n no hay rese�as",
    "Loading products...": "Cargando productos...",
    "Loading developers...": "Cargando desarrolladores..."
  },
  hi: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus ????? ?? reporting, support, operations, sales ?? internal workflows ?? ??? practical automation products ????? ??? ??? ???? ??? ??? outcome ?? ????? ?? ???? ????? ?? browse ????, product ???? deliver ???? ?? preview ????, ?? ???? team ?? ??? ??? setup path ??????",
    "Search by business issue, outcome, category, and setup path.": "Business issue, outcome, category ?? setup path ?? ??????",
    "See what the product does, what it needs, and what it produces.": "????? product ???? ???? ??, ???? ?????, ?? ???? output ???? ???",
    "Choose self-serve or Nexus guided setup based on complexity.": "Complexity ?? ????? ?? self-serve ?? Nexus guided setup ??????",
    "Move from manual work to a repeatable process your team can use.": "Manual work ?? ???? team ?? ??? repeatable process ??? ??????",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "???????? teams ?? ??? ideas ?? ??? ???? ????, execution ?? ?????? ???? ??? Reports ??? ?? ?? ???? ???? ???, customer questions repeat ???? ???, sales follow-up ????? ??, ?? internal handoffs tools ?? ??? copy-paste ?? ?????? ???? ????",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus ?? repeatable problems ?? clear marketplace products ??? ????? ??? ?? listing ????? ?? ?? ??? ?? business issue solve ???? ??, ??? ?? output ????? ??, setup ??? ???? ?????, ?? team self-serve ?? ???? ?? ?? guided setup ??????",
    "Slow and unclear": "???? ?? ???????",
    "Compare disconnected tools": "Disconnected tools ?? ?????",
    "Buy software without seeing the outcome": "Outcome ???? ???? software ??????",
    "Hire builders without a clear product": "Clear product ?? ???? builders hire ????",
    "Handle setup and errors alone": "Setup ?? errors ????? ???????",
    "Keep manual workarounds running": "Manual workarounds ????? ????",
    "Outcome-first and clear": "Outcome-first ?? clear",
    "Browse by business issue": "Business issue ?? browse ????",
    "Understand the output before setup": "Setup ?? ???? output ?????",
    "Choose the right setup path upfront": "???? ?? ??? setup path ?????",
    "See who built or operates the product": "????? product ????? ????? ?? operate ????",
    "Move toward a repeatable process": "Repeatable process ?? ?? ?????",
    "From business issue to working process.": "Business issue ?? working process ???",
    "Ready-made products for common business issues.": "Common business issues ?? ??? ready-made products.",
    "Every listing explains the outcome first.": "?? listing ???? outcome ?????? ???",
    "A hub for businesses and automation builders.": "Businesses ?? automation builders ?? ??? hub.",
    "Price": "????",
    "Setup": "?????",
    "Buy / choose setup": "?????? / setup ?????",
    "View profile": "???????? ?????",
    "Ask Nexus": "Nexus ?? ?????",
    "Message developer": "?????? ?? message ????",
    "Problem it solves": "?? ?? ?????? ?? ???? ??",
    "Business outcome": "Business outcome",
    "Who this is for": "?? ????? ??? ??",
    "Outputs": "Outputs",
    "Required inputs": "????? inputs",
    "Ready to use this automation?": "???? ?? ?? automation ???????? ???? ?? ??? ready ????",
    "Choose setup path": "Setup path ?????",
    "Setup method": "Setup method",
    "Continue to secure payment": "Secure payment ?? ????",
    "Self-Serve Setup": "Self-serve setup",
    "Nexus Guided Install": "Nexus guided install",
    "Developer profiles": "Developer profiles",
    "No reviews yet": "??? reviews ???? ???",
    "Loading products...": "Products load ?? ??? ???...",
    "Loading developers...": "Developers load ?? ??? ???..."
  },
  ar: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "????? Nexus ????? ??? ?????? ??? ?????? ????? ????? ???????? ?????? ????????? ????????? ???? ????? ???????. ???? ??? ??????? ????????? ???? ?? ????? ??????? ????? ???? ??????? ??????? ??????.",
    "Search by business issue, outcome, category, and setup path.": "???? ??? ????? ????? ?? ??????? ?? ????? ?? ???? ???????.",
    "See what the product does, what it needs, and what it produces.": "???? ?? ????? ?????? ??? ?????? ??? ?????.",
    "Choose self-serve or Nexus guided setup based on complexity.": "???? ??????? ?????? ?? ??????? ?????? ?? Nexus ??? ???? ???????.",
    "Move from manual work to a repeatable process your team can use.": "???? ????? ?????? ??? ????? ????? ??????? ???????? ?????.",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "???? ????? ?? ????? ?? ??? ???????? ?? ?? ????? ???????. ???????? ?? ???? ?????? ?????? ????? ??????? ?????? ?????? ???????? ????? ?????????? ???????? ????? ??? ??? ????????? ??? ???????.",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "????? Nexus ??? ??????? ???????? ??? ?????? ????? ?? ?????. ?? ????? ???? ????? ????? ???? ?????? ????????? ???? ??????? ???????? ???????? ??? ??? ??? ????? ?????? ??????? ?????? ?? ????? ??? ????? ????.",
    "Slow and unclear": "???? ???? ????",
    "Compare disconnected tools": "?????? ????? ??? ???????",
    "Buy software without seeing the outcome": "???? ?????? ??? ???? ???????",
    "Hire builders without a clear product": "????? ?????? ??? ???? ????",
    "Handle setup and errors alone": "??????? ?? ??????? ???????? ????",
    "Keep manual workarounds running": "????????? ?? ???? ????? ?????",
    "Outcome-first and clear": "???? ????? ??? ??????? ?????",
    "Browse by business issue": "???? ??? ????? ?????",
    "Understand the output before setup": "???? ???????? ??? ???????",
    "Choose the right setup path upfront": "???? ???? ??????? ?????? ?? ???????",
    "See who built or operates the product": "???? ?? ??? ?????? ?? ?????",
    "Move toward a repeatable process": "????? ??? ????? ????? ???????",
    "From business issue to working process.": "?? ????? ??? ??? ????? ????.",
    "Ready-made products for common business issues.": "?????? ????? ?????? ????? ???????.",
    "Every listing explains the outcome first.": "?? ????? ???? ??????? ?????.",
    "A hub for businesses and automation builders.": "???? ??????? ????? ???????.",
    "Price": "?????",
    "Setup": "???????",
    "Buy / choose setup": "???? / ?????? ???????",
    "View profile": "??? ?????",
    "Ask Nexus": "???? Nexus",
    "Message developer": "?????? ??????",
    "Problem it solves": "??????? ???? ?????",
    "Business outcome": "????? ?????",
    "Who this is for": "??? ??? ??????",
    "Outputs": "????????",
    "Required inputs": "???????? ????????",
    "Ready to use this automation?": "?? ??? ???? ???????? ??? ????????",
    "Choose setup path": "???? ???? ???????",
    "Setup method": "????? ???????",
    "Continue to secure payment": "???????? ??? ????? ?????",
    "Self-Serve Setup": "????? ????",
    "Nexus Guided Install": "????? ???? ?? Nexus",
    "Developer profiles": "????? ????????",
    "No reviews yet": "?? ???? ??????? ???",
    "Loading products...": "???? ????? ????????...",
    "Loading developers...": "???? ????? ????????..."
  },
  fr: {
    "Nexus helps teams find practical automation products for reporting, support, operations, sales, and internal workflows. Browse by the outcome you need, preview what the product delivers, and choose the setup path that fits your team.": "Nexus aide les �quipes � trouver des automatisations pratiques pour les rapports, le support, les op�rations, les ventes et les workflows internes. Parcourez selon le r�sultat recherch�, pr�visualisez ce que le produit livre et choisissez le mode de configuration adapt�.",
    "Search by business issue, outcome, category, and setup path.": "Recherchez par probl�me m�tier, r�sultat, cat�gorie et mode de configuration.",
    "See what the product does, what it needs, and what it produces.": "Voyez ce que le produit fait, ce dont il a besoin et ce qu�il produit.",
    "Choose self-serve or Nexus guided setup based on complexity.": "Choisissez le self-serve ou l�installation guid�e Nexus selon la complexit�.",
    "Move from manual work to a repeatable process your team can use.": "Passez du travail manuel � un processus r�p�table pour votre �quipe.",
    "Most teams do not have an ideas problem. They have an execution problem. Reports still take hours, customer questions still repeat, sales follow-up still slips, and internal handoffs still depend on people copying information between tools.": "La plupart des �quipes ne manquent pas d�id�es, elles ont un probl�me d�ex�cution. Les rapports prennent encore des heures, les questions clients se r�p�tent, le suivi commercial glisse et les transmissions internes reposent encore sur du copier-coller entre outils.",
    "Nexus turns those repeatable problems into clear marketplace products. Each listing explains the business issue it solves, the output it creates, what setup requires, and whether your team can self-serve or should use guided setup.": "Nexus transforme ces probl�mes r�p�titifs en produits marketplace clairs. Chaque fiche explique le probl�me m�tier r�solu, le r�sultat cr��, les besoins de configuration et si l��quipe peut se d�brouiller seule ou doit �tre accompagn�e.",
    "Slow and unclear": "Lent et peu clair",
    "Compare disconnected tools": "Comparer des outils d�connect�s",
    "Buy software without seeing the outcome": "Acheter un logiciel sans voir le r�sultat",
    "Hire builders without a clear product": "Engager des builders sans produit clair",
    "Handle setup and errors alone": "G�rer seul la configuration et les erreurs",
    "Keep manual workarounds running": "Continuer avec des contournements manuels",
    "Outcome-first and clear": "Clair et orient� r�sultat",
    "Browse by business issue": "Parcourir par probl�me m�tier",
    "Understand the output before setup": "Comprendre le r�sultat avant configuration",
    "Choose the right setup path upfront": "Choisir le bon mode d�s le d�part",
    "See who built or operates the product": "Voir qui construit ou op�re le produit",
    "Move toward a repeatable process": "Avancer vers un processus r�p�table",
    "From business issue to working process.": "Du probl�me m�tier au processus op�rationnel.",
    "Ready-made products for common business issues.": "Produits pr�ts � l�emploi pour probl�mes m�tier courants.",
    "Every listing explains the outcome first.": "Chaque fiche explique d�abord le r�sultat.",
    "A hub for businesses and automation builders.": "Un hub pour les entreprises et les builders d�automatisation.",
    "Price": "Prix",
    "Setup": "Configuration",
    "Buy / choose setup": "Acheter / choisir la configuration",
    "View profile": "Voir le profil",
    "Ask Nexus": "Demander � Nexus",
    "Message developer": "Message au d�veloppeur",
    "Problem it solves": "Probl�me r�solu",
    "Business outcome": "R�sultat m�tier",
    "Who this is for": "Pour qui",
    "Outputs": "R�sultats",
    "Required inputs": "Entr�es requises",
    "Ready to use this automation?": "Pr�t � utiliser cette automatisation ?",
    "Choose setup path": "Choisir le mode de configuration",
    "Setup method": "M�thode de configuration",
    "Continue to secure payment": "Continuer vers le paiement s�curis�",
    "Self-Serve Setup": "Configuration self-serve",
    "Nexus Guided Install": "Installation guid�e Nexus",
    "Developer profiles": "Profils d�veloppeurs",
    "No reviews yet": "Aucun avis pour l�instant",
    "Loading products...": "Chargement des produits...",
    "Loading developers...": "Chargement des d�veloppeurs..."
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
    [/\bautomation\b/gi, "?????????"],
    [/\bautomations\b/gi, "?????????"],
    [/\bworkflow\b/gi, "???????????"],
    [/\bworkflows\b/gi, "???????????"],
    [/\bmarketplace\b/gi, "????????????"],
    [/\bdeveloper\b/gi, "????????"],
    [/\bdevelopers\b/gi, "????????"],
    [/\bdashboard\b/gi, "????????"],
    [/\breview\b/gi, "?????"],
    [/\breviews\b/gi, "?????"],
    [/\bsetup\b/gi, "???????"],
    [/\bproduct\b/gi, "??????"],
    [/\bproducts\b/gi, "??????"]
  ],
  es: [
    [/\bautomation\b/gi, "automatizaci�n"],
    [/\bautomations\b/gi, "automatizaciones"],
    [/\bworkflow\b/gi, "flujo de trabajo"],
    [/\bworkflows\b/gi, "flujos de trabajo"],
    [/\bmarketplace\b/gi, "marketplace"],
    [/\bdashboard\b/gi, "panel"],
    [/\bproduct\b/gi, "producto"],
    [/\bproducts\b/gi, "productos"],
    [/\bsetup\b/gi, "configuraci�n"],
    [/\breview\b/gi, "rese�a"],
    [/\breviews\b/gi, "rese�as"]
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
    [/\bautomation\b/gi, "???"],
    [/\bautomations\b/gi, "???"],
    [/\bworkflow\b/gi, "???"],
    [/\bworkflows\b/gi, "???"],
    [/\bmarketplace\b/gi, "??"],
    [/\bdashboard\b/gi, "???"],
    [/\bdeveloper\b/gi, "???"],
    [/\bdevelopers\b/gi, "???"],
    [/\bproduct\b/gi, "??"],
    [/\bproducts\b/gi, "??"],
    [/\bsetup\b/gi, "??"],
    [/\breview\b/gi, "??"],
    [/\breviews\b/gi, "??"]
  ],
  hi: [
    [/\bautomation\b/gi, "???????"],
    [/\bautomations\b/gi, "???????"],
    [/\bworkflow\b/gi, "?????????"],
    [/\bworkflows\b/gi, "?????????"],
    [/\bmarketplace\b/gi, "????????????"],
    [/\bdashboard\b/gi, "????????"],
    [/\bdeveloper\b/gi, "??????"],
    [/\bdevelopers\b/gi, "??????"],
    [/\bproduct\b/gi, "????????"],
    [/\bproducts\b/gi, "????????"],
    [/\bsetup\b/gi, "?????"],
    [/\breview\b/gi, "??????"],
    [/\breviews\b/gi, "??????"]
  ],
  ar: [
    [/\bautomation\b/gi, "???????"],
    [/\bautomations\b/gi, "???????"],
    [/\bworkflow\b/gi, "??? ?????"],
    [/\bworkflows\b/gi, "??? ?????"],
    [/\bmarketplace\b/gi, "?????"],
    [/\bdashboard\b/gi, "???? ??????"],
    [/\bdeveloper\b/gi, "??????"],
    [/\bdevelopers\b/gi, "????????"],
    [/\bproduct\b/gi, "??????"],
    [/\bproducts\b/gi, "????????"],
    [/\bsetup\b/gi, "???????"],
    [/\breview\b/gi, "??????"],
    [/\breviews\b/gi, "???????"]
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

function cleanInternalPathname(pathname = "") {
  const raw = String(pathname || "/");
  const legacyIndexSuffix = "/" + "index.html";
  const withoutIndex = raw.toLowerCase().endsWith(legacyIndexSuffix)
    ? raw.slice(0, -legacyIndexSuffix.length) || "/"
    : raw;

  if (withoutIndex === "/") return "/";
  return withoutIndex.replace(/\/+$/, "") || "/";
}

function updateCurrentUrlLanguage(language) {
  if (!window.history?.replaceState) return;

  try {
    const url = new URL(window.location.href);
    url.pathname = cleanInternalPathname(url.pathname);

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
    url.pathname = cleanInternalPathname(url.pathname);

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

    const isAdminStaff = profile?.role === "admin_staff";
    const isAdmin = profile?.role === "admin" || isAdminStaff;
    const isDeveloper = profile?.role === "developer";

    if (isAdmin) {
      return {
        label: t("nav_admin"),
        href: isAdminStaff ? "/pages/admin/staff.html" : "/pages/admin/dashboard.html",
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
        <a class="nav-link ${active === "developers" ? "active" : ""}" href="/pages/developers" data-i18n="nav_developers">
          ${t("nav_developers")}
        </a>
      `
    : `
        <div class="nav-dropdown ${active === "developers" ? "active" : ""}">
          <button class="nav-link nav-dropdown-trigger" type="button" aria-haspopup="true">
            <span data-i18n="nav_developers">${t("nav_developers")}</span>
            <span class="nav-dropdown-caret" aria-hidden="true">&#9662;</span>
          </button>

          <div class="nav-dropdown-menu" role="menu">
            <a href="/pages/developers" role="menuitem" data-i18n="nav_browse_developers">
              ${t("nav_browse_developers")}
            </a>
            <a href="/pages/developers/waitlist.html" role="menuitem" data-i18n="nav_developer_apply">
              ${t("nav_developer_apply")}
            </a>
            <a href="/pages/developer/login.html" role="menuitem" data-i18n="nav_developer_login">
              ${t("nav_developer_login")}
            </a>
          </div>
        </div>
      `;

  return `
    <div class="container nav">
      <a class="logo" href="/">
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
              <a class="nav-link ${active === "home" ? "active" : ""}" href="/" data-i18n="nav_home">
                ${t("nav_home")}
              </a>
            `
            : ""
        }

        <a class="nav-link ${active === "marketplace" ? "active" : ""}" href="/pages/marketplace" data-i18n="nav_marketplace">
          ${t("nav_marketplace")}
        </a>

        ${developerNav}

        ${
          compactAccountNav
            ? ""
            : `
              <a class="nav-link ${active === "about" ? "active" : ""}" href="/pages/about" data-i18n="nav_about">
                ${t("nav_about")}
              </a>
            `
        }

        <a class="nav-link ${active === "contact" ? "active" : ""}" href="/pages/contact" data-i18n="nav_contact">
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

let globalNavMountPromise = null;

async function mountGlobalNav(options = {}) {
  if (globalNavMountPromise && !options.force) {
    return globalNavMountPromise;
  }

  globalNavMountPromise = mountGlobalNavInner(options).finally(() => {
    globalNavMountPromise = null;
  });

  return globalNavMountPromise;
}

async function mountGlobalNavInner(options = {}) {
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

        window.location.href = "/";
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

function messageAttachments(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function attachmentSizeLabel(size) {
  const bytes = Number(size || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderMessageAttachments(message = {}) {
  const attachments = messageAttachments(message.attachments);
  if (!attachments.length) return "";

  return `
    <div class="message-attachments">
      ${attachments.map((attachment) => {
        const href = attachment.download_url || attachment.signed_url || attachment.url || "";
        const name = attachment.file_name || attachment.name || "Attachment";
        const type = attachment.file_type || attachment.type || "";
        const size = attachmentSizeLabel(attachment.file_size || attachment.size);
        const image = href && String(type).toLowerCase().startsWith("image/");
        return `
          <a class="message-attachment ${image ? "image" : "file"}" href="${escapeAttribute(href || "#")}" target="_blank" rel="noopener" download="${escapeAttribute(name)}">
            ${image ? `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(name)}">` : `<span class="message-attachment-icon">File</span>`}
            <span>
              <strong>${escapeHtml(name)}</strong>
              <small>${escapeHtml([type, size].filter(Boolean).join(" / ") || "Attachment")}</small>
            </span>
          </a>
        `;
      }).join("")}
    </div>
  `;
}

async function hydrateMessageAttachments(threadId, messages = []) {
  const attachments = messages.flatMap((message) => messageAttachments(message.attachments));
  if (!attachments.length || typeof NexusDB.signMessageAttachmentUrls !== "function") return messages;

  const { data, error } = await NexusDB.signMessageAttachmentUrls(threadId, attachments);
  if (error || !Array.isArray(data?.attachments)) return messages;

  const byPath = new Map(data.attachments.map((attachment) => [attachment.path, attachment]));
  return messages.map((message) => ({
    ...message,
    attachments: messageAttachments(message.attachments).map((attachment) => ({
      ...attachment,
      ...(byPath.get(attachment.path) || {})
    }))
  }));
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
      ${message.body ? `<p>${escapeHtml(message.body || "")}</p>` : ""}
      ${renderMessageAttachments(message)}
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
                <textarea class="textarea" name="message" placeholder="Write a reply..."></textarea>
                <div class="message-attachment-picker">
                  <label class="btn btn-secondary btn-small">
                    Add files
                    <input type="file" data-message-files multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" hidden>
                  </label>
                  <span data-message-file-label>No files selected</span>
                </div>
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
      const fileInput = replyForm.querySelector("[data-message-files]");
      const message = String(textarea?.value || "").trim();
      const files = Array.from(fileInput?.files || []);
      if (!message && !files.length) return;

      const button = replyForm.querySelector('button[type="submit"]');
      const originalText = button?.textContent || "Send reply";
      if (button) {
        button.disabled = true;
        button.textContent = files.length ? "Uploading..." : "Sending...";
      }

      const attachments = [];
      for (const file of files) {
        const upload = await NexusDB.createMessageAttachmentUpload(activeThread.id, file);
        if (upload.error) {
          if (button) {
            button.disabled = false;
            button.textContent = originalText;
          }
          toast(upload.error.message || "Could not upload attachment.");
          return;
        }
        attachments.push(upload.data);
      }

      if (button) button.textContent = "Sending...";
      const sender = typeof NexusDB.sendThreadMessageWithAttachments === "function"
        ? NexusDB.sendThreadMessageWithAttachments
        : NexusDB.sendThreadMessage;
      const { error } = await sender(activeThread.id, message, attachments);

      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }

      if (error) {
        toast(error.message || "Could not send message.");
        return;
      }

      if (textarea) textarea.value = "";
      if (fileInput) fileInput.value = "";
      const label = replyForm.querySelector("[data-message-file-label]");
      if (label) label.textContent = "No files selected";
      await loadMessageCenter(root, activeThread.id);
    });
  }

  root.querySelector("[data-message-files]")?.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    const label = root.querySelector("[data-message-file-label]");
    if (label) {
      label.textContent = files.length
        ? `${files.length} file${files.length === 1 ? "" : "s"} selected`
        : "No files selected";
    }
  });

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

    const hydratedMessages = await hydrateMessageAttachments(activeThread.id, data?.messages || []);
    body.innerHTML = renderMessageList(hydratedMessages);
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

function adminSidebarSections(active = "", options = {}) {
  const isStaff = Boolean(options.isStaff);
  const staffAllowedIds = new Set([
    "staff",
    "orders",
    "analytics",
    "health",
    "customer-automations",
    "messages",
    "waitlist",
    "marketplace",
    "logout"
  ]);

  const sections = [
    {
      label: "Core",
      items: [
        { id: "staff", label: "Staff Overview", href: "/pages/admin/staff.html", staffOnly: true },
        { id: "dashboard", label: "Overview", href: "/pages/admin/dashboard.html" },
        { id: "orders", label: "Orders", href: "/pages/admin/orders.html" },
        { id: "pilot-grants", label: "Pilot Grants", href: "/pages/admin/pilot-grants.html" },
        { id: "analytics", label: "Analytics", href: "/pages/admin/analytics.html" },
        { id: "finance", label: "Finance", href: "/pages/admin/finance.html" },
        { id: "health", label: "System Health", href: "/pages/admin/health.html" }
      ]
    },
    {
      label: "Marketplace",
      items: [
        { id: "automations", label: "Products", href: "/pages/admin/automations.html" },
        { id: "bundles", label: "Bundles", href: "/pages/admin/bundles.html" },
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
        { id: "waitlist", label: "Developer Intake", href: "/pages/admin/waitlist.html" },
        { id: "developer-profile", label: "Nexus Profile", href: "/pages/admin/developer-profile.html" }
      ]
    },
    {
      label: "Tools",
      items: [
        { id: "checkout-intents", label: "Checkout Prep", href: "/pages/admin/checkout-intents.html" },
        { id: "marketplace", label: "View Marketplace", href: "/pages/marketplace" },
        { id: "logout", label: "Logout", href: "#", action: "logout" }
      ]
    }
  ];

  return sections.map((section) => {
    const visibleItems = section.items.filter((item) => {
      if (item.staffOnly && !isStaff) return false;
      if (!isStaff) return true;
      return staffAllowedIds.has(item.id);
    });

    if (!visibleItems.length) return "";

    const links = visibleItems.map((item) => {
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

async function mountAdminSidebar(options = {}) {
  if (document.body?.dataset?.admin !== "true") return;

  const sidebar = document.querySelector(".dashboard .sidebar");
  if (!sidebar) return;

  const active = document.body.dataset.adminPage || "";
  const language = getLanguage();
  let isStaff = false;

  try {
    if (window.NexusDB?.getUser && window.NexusDB?.getProfile) {
      const userResult = await window.NexusDB.getUser();
      const user = userResult?.data || null;
      if (user) {
        const profileResult = await window.NexusDB.getProfile(user.id);
        isStaff = profileResult?.data?.role === "admin_staff";
      }
    }
  } catch (error) {
    console.warn("Could not resolve admin sidebar role:", error);
  }

  const mode = isStaff ? "staff" : "owner";

  if (
    !options.force &&
    sidebar.dataset.nexusSidebarMounted === "true" &&
    sidebar.dataset.nexusSidebarActive === active &&
    sidebar.dataset.nexusSidebarLanguage === language &&
    sidebar.dataset.nexusSidebarMode === mode
  ) {
    return;
  }

  sidebar.innerHTML = `
    <div class="sidebar-title">${isStaff ? "Nexus Staff" : "Nexus Admin"}</div>
    ${adminSidebarSections(active, { isStaff })}
  `;

  applyTranslations(sidebar);
  localizeInternalLinks(sidebar);

  sidebar.dataset.nexusSidebarMounted = "true";
  sidebar.dataset.nexusSidebarActive = active;
  sidebar.dataset.nexusSidebarLanguage = language;
  sidebar.dataset.nexusSidebarMode = mode;
}
  return {
  q,
  slugify,
  toast,
  confirmDialog,
  promptDialog,
  getCurrency,
  setCurrency,
  currencySwitch,
  priceAmount,
  productAllowsGuidedInstall,
  guidedInstallFeeAmount,
  guidedInstallFeeMoney,
  productFreshness,
  workflowHealthStatus,
  workflowHealthLabel,
  recommendedProductLabel,
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
  colorClass,
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
convertAmount,
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
cleanInternalPathname,
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
