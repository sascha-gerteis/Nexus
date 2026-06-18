const NexusApp = (() => {
  let liveAutomations = [];
  let activeProduct = null;
  let selectedCustomizationName = "";
  let marketplaceDrawTimer = null;
  const compareSlugs = new Set();
  const MAX_COMPARE_PRODUCTS = 3;

  async function init() {
    NexusUI.wireModal();

    if (typeof NexusUI.mountGlobalNav === "function") {
  NexusUI.mountGlobalNav().catch((error) => {
    console.warn("Could not mount Nexus navigation:", error);
  });
}

    if (typeof NexusUI.mountAdminSidebar === "function") {
      NexusUI.mountAdminSidebar();
    }

    if (typeof NexusUI.refreshLanguageState === "function") {
      NexusUI.refreshLanguageState();
    }

    document.addEventListener("currencychange", () => {
      if (document.body.dataset.page === "home") renderHome();
      if (document.body.dataset.page === "marketplace") drawMarketplace();
      if (document.body.dataset.page === "checkout") renderCheckout();
    });

    document.addEventListener("languagechange", async () => {
  if (typeof NexusUI.mountGlobalNav === "function") {
    NexusUI.mountGlobalNav({ force: true }).catch((error) => {
      console.warn("Could not refresh Nexus navigation:", error);
    });
  }

  if (typeof NexusUI.mountAdminSidebar === "function") {
    NexusUI.mountAdminSidebar();
  }

  if (document.body.dataset.page === "home") renderHome();
  if (document.body.dataset.page === "marketplace") drawMarketplace();
  if (document.body.dataset.page === "checkout") renderCheckout();
  if (document.body.dataset.page === "developers") renderDevelopers();
  if (document.body.dataset.page === "developer-profile") renderDeveloperProfile();
  if (document.body.dataset.admin === "true") renderAdmin();

  NexusUI.refreshLanguageState?.();
});

    document.addEventListener("fxratechange", () => {
  if (document.body.dataset.page === "home") renderHome();
  if (document.body.dataset.page === "marketplace") drawMarketplace();
  if (document.body.dataset.page === "checkout") renderCheckout();
});
if (typeof NexusUI.refreshUsdToThbRate === "function") {
  NexusUI.refreshUsdToThbRate();
}

    if (document.body.dataset.page === "home") await renderHome();
    if (document.body.dataset.page === "marketplace") await renderMarketplace();
    if (document.body.dataset.page === "checkout") await renderCheckout();
    if (document.body.dataset.page === "developers") await renderDevelopers();
    if (document.body.dataset.page === "developer-profile") await renderDeveloperProfile();
    if (document.body.dataset.page === "developer-waitlist") wireWaitlist();
    if (document.body.dataset.page === "contact") wireContact();
    if (document.body.dataset.page === "login") wireLogin();

    if (document.body.dataset.admin === "true") {
      const profile = await NexusDB.requireAdmin();
      if (!profile) return;
      await renderAdmin();
    }

    forceBuyLinksToCheckoutPage();
  }

  function productBySlug(slug) {
    const normalized = decodeURIComponent(String(slug || ""));
    return liveAutomations.find((product) => String(product.slug || "") === normalized) || null;
  }

  function applyTranslationsIfNeeded(root) {
    if (NexusUI.getLanguage?.() !== "en") {
      NexusUI.applyTranslations?.(root);
    }
  }

  function isRequestOnlyProduct(product) {
    return Boolean(
      product?.is_demo ||
      product?.listing_type === "custom_request" ||
      product?.pricing_type === "custom_quote"
    );
  }

  function summarizeList(value, fallback = "Not specified") {
    if (Array.isArray(value)) {
      const list = value.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
      return list.length ? list.join(", ") : fallback;
    }

    const text = String(value || "").trim();
    return text || fallback;
  }

  function compareProducts() {
    return Array.from(compareSlugs)
      .map(productBySlug)
      .filter(Boolean);
  }

  function ensureCompareTray() {
    if (document.body.dataset.page !== "marketplace") return null;

    let tray = document.getElementById("compareTray");

    if (!tray) {
      tray = document.createElement("div");
      tray.id = "compareTray";
      tray.className = "compare-tray";
      document.body.appendChild(tray);
    }

    return tray;
  }

  function renderCompareTray() {
    const tray = ensureCompareTray();
    if (!tray) return;

    const products = compareProducts();

    if (!products.length) {
      tray.classList.remove("show");
      tray.innerHTML = "";
      return;
    }

    tray.classList.add("show");
    tray.innerHTML = `
      <div class="compare-tray-inner">
        <div class="compare-tray-summary">
          <strong>${products.length}/${MAX_COMPARE_PRODUCTS} selected</strong>
          <span>${products.map((product) => NexusUI.escapeHtml(NexusUI.localizeRecord(product, "title"))).join(" / ")}</span>
        </div>
        <div class="compare-tray-actions">
          <button class="btn btn-secondary btn-small" type="button" onclick="NexusApp.clearCompare()">Clear</button>
          <button class="btn btn-primary btn-small" type="button" onclick="NexusApp.openCompare()" ${products.length < 2 ? "disabled" : ""}>
            Compare
          </button>
        </div>
      </div>
    `;
  }

  function toggleCompare(slug) {
    const normalized = decodeURIComponent(String(slug || ""));

    if (!normalized || !productBySlug(normalized)) {
      NexusUI.toast("Product not found.");
      return;
    }

    if (compareSlugs.has(normalized)) {
      compareSlugs.delete(normalized);
    } else {
      if (compareSlugs.size >= MAX_COMPARE_PRODUCTS) {
        NexusUI.toast(`Compare up to ${MAX_COMPARE_PRODUCTS} products.`);
        return;
      }

      compareSlugs.add(normalized);
    }

    drawMarketplace();
  }

  function clearCompare() {
    compareSlugs.clear();
    drawMarketplace();
  }

  function scheduleMarketplaceDraw() {
    if (marketplaceDrawTimer) {
      clearTimeout(marketplaceDrawTimer);
    }

    marketplaceDrawTimer = setTimeout(() => {
      marketplaceDrawTimer = null;
      drawMarketplace();
    }, 80);
  }

  function compareCell(product, field, fallback = "Not specified") {
    if (field === "price") return NexusUI.money(product);
    if (field === "developer") return product.developers?.display_name || "Nexus Internal";
    if (field === "rating") return `${product.rating || "New"} (${product.review_count || 0})`;
    if (field === "outputs") return summarizeList(NexusUI.localizeArray?.(product, "outputs") || product.outputs, fallback);
    if (field === "required_tools") return summarizeList(NexusUI.localizeArray?.(product, "required_tools") || product.required_tools, fallback);

    return summarizeList(NexusUI.localizeRecord?.(product, field, product[field]) || product[field], fallback);
  }

  function openCompare() {
    const products = compareProducts();

    if (products.length < 2) {
      NexusUI.toast("Select at least two products to compare.");
      return;
    }

    closeCompare();

    const rows = [
      ["Price", "price"],
      ["Category", "category"],
      ["Setup", "setup_type"],
      ["Best for", "best_for"],
      ["Delivery", "delivery_time"],
      ["Outputs", "outputs"],
      ["Tools needed", "required_tools"],
      ["Builder", "developer"],
      ["Reviews", "rating"],
    ];

    const modal = document.createElement("div");
    modal.className = "compare-modal-backdrop open";
    modal.id = "compareModal";
    modal.onclick = (event) => {
      if (event.target === modal) closeCompare();
    };
    modal.innerHTML = `
      <div class="compare-modal">
        <div class="compare-modal-head">
          <div>
            <span class="marketplace-small-label">Compare</span>
            <h2>Compare automations</h2>
            <p>Check price, setup effort, outputs, and fit before choosing a product.</p>
          </div>
          <button class="close" type="button" onclick="NexusApp.closeCompare()">Close</button>
        </div>

        <div class="compare-table-wrap">
          <table class="compare-table">
            <thead>
              <tr>
                <th>Compare</th>
                ${products.map((product) => `
                  <th>
                    <strong>${NexusUI.escapeHtml(NexusUI.localizeRecord(product, "title"))}</strong>
                    <span>${NexusUI.escapeHtml(NexusUI.localizeRecord(product, "short_description", ""))}</span>
                  </th>
                `).join("")}
              </tr>
            </thead>
            <tbody>
              ${rows.map(([label, field]) => `
                <tr>
                  <td>${NexusUI.escapeHtml(label)}</td>
                  ${products.map((product) => `
                    <td>${NexusUI.escapeHtml(compareCell(product, field))}</td>
                  `).join("")}
                </tr>
              `).join("")}
              <tr>
                <td>Action</td>
                ${products.map((product) => {
                  const slug = encodeURIComponent(product.slug || "");
                  const href = isRequestOnlyProduct(product)
                    ? `/pages/custom-request/index.html?slug=${slug}`
                    : `/pages/checkout/index.html?slug=${slug}&step=setup`;
                  const label = isRequestOnlyProduct(product) ? "Request" : "Buy";

                  return `
                    <td>
                      <div class="compare-action-stack">
                        <button class="btn btn-secondary btn-small" type="button" onclick="NexusApp.closeCompare(); NexusApp.openProduct('${NexusUI.escapeAttribute(product.slug || "")}')">Preview</button>
                        <a class="btn btn-primary btn-small" href="${href}">${label}</a>
                      </div>
                    </td>
                  `;
                }).join("")}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  function closeCompare() {
    document.getElementById("compareModal")?.remove();
  }

  async function renderHome() {
    const { data, error } = await NexusDB.listLiveAutomations();
    const grid = document.getElementById("featuredGrid");

    if (!grid) return;

    if (error) {
      grid.innerHTML = `<div class="error">${error.message}</div>`;
      return;
    }

    liveAutomations = data || [];

    const currency = document.getElementById("homeCurrency");
    if (currency) currency.innerHTML = NexusUI.currencySwitch();

    grid.innerHTML =
      liveAutomations.slice(0, 3).map(NexusUI.productCard).join("") ||
      `<div class="card"><h3>No live products yet</h3><p>Use the hidden admin URL to publish your first automation.</p></div>`;

    applyTranslationsIfNeeded(grid);
    renderHomeProductVisual(liveAutomations);
    forceBuyLinksToCheckoutPage();
  }

  function pickHomeProduct(products = []) {
    return (
      products.find((product) => {
        const haystack = [
          product.slug,
          product.title,
          product.category,
          product.badge,
          product.preview_type,
          product.short_description
        ].join(" ").toLowerCase();

        return (
          haystack.includes("social") ||
          haystack.includes("listening") ||
          haystack.includes("report")
        );
      }) ||
      products.find((product) => product.featured) ||
      products[0] ||
      null
    );
  }

  function renderHomeProductVisual(products = []) {
    const root = document.getElementById("homeProductVisual");
    if (!root) return;

    const product = pickHomeProduct(products);

    if (!product) {
      root.innerHTML = `
        <div class="product-card">
          <div class="product-top">
            <div class="product-icon blue">AI</div>
            <span class="pill blue">Marketplace Listing</span>
          </div>
          <h3>No live product yet</h3>
          <p>Publish one marketplace product and this section will become a real product card.</p>
        </div>
      `;
      applyTranslationsIfNeeded(root);
      return;
    }

    root.innerHTML = NexusUI.productCard(product);
    applyTranslationsIfNeeded(root);
  }

  async function renderMarketplace() {
    const { data, error } = await NexusDB.listLiveAutomations();
    const grid = document.getElementById("marketplaceGrid");

    if (!grid) return;

    if (error) {
      grid.innerHTML = `<div class="error">${error.message}</div>`;
      return;
    }

    liveAutomations = data || [];

    const currency = document.getElementById("marketCurrency");
    if (currency) currency.innerHTML = NexusUI.currencySwitch();

    drawMarketplace();

    document.querySelectorAll("[data-filter]").forEach((element) => {
      element.addEventListener("input", scheduleMarketplaceDraw);
      element.addEventListener("change", scheduleMarketplaceDraw);
    });

    forceBuyLinksToCheckoutPage();
  }

  function drawMarketplace() {
    const grid = document.getElementById("marketplaceGrid");
    if (!grid) return;

    let items = [...liveAutomations];

    const search = (document.getElementById("searchInput")?.value || "").toLowerCase();
    const category = document.getElementById("categoryFilter")?.value || "all";
    const setup = document.getElementById("setupFilter")?.value || "all";
    const price = document.getElementById("priceFilter")?.value || "all";

    if (search) {
      items = items.filter((product) => {
        return `${product.title} ${product.short_description} ${product.category} ${product.best_for} ${product.developers?.display_name}`
          .toLowerCase()
          .includes(search);
      });
    }

    if (category !== "all") {
      items = items.filter((product) => product.category === category);
    }

    if (setup !== "all") {
      items = items.filter((product) => {
        const setupText = String(product.setup_type || "").toLowerCase();

        if (setup === "guided") {
          return setupText.includes("guided") || productAllowsGuidedInstall(product);
        }

        if (setup === "self") {
          return setupText.includes("self") || !productAllowsGuidedInstall(product);
        }

        return setupText.includes(setup);
      });
    }

    if (price !== "all") {
      items = items.filter((product) => product.pricing_type === price);
    }

    grid.innerHTML =
      items
        .map((product) => NexusUI.productCard(product, {
          showCompare: true,
          compareSelected: compareSlugs.has(String(product.slug || "")),
        }))
        .join("") ||
      `<div class="card"><h3>No results</h3><p>Try changing the filters.</p></div>`;

    applyTranslationsIfNeeded(grid);
    renderCompareTray();
    forceBuyLinksToCheckoutPage();
  }

  async function fetchProduct(slug) {
    const { data, error } = await NexusDB.getAutomationBySlug(slug);

    if (error || !data) {
      NexusUI.toast(error?.message || "Product not found.");
      return null;
    }

    activeProduct = data;
    selectedCustomizationName = "";

    return data;
  }

  async function openProduct(slug) {
    const product = await fetchProduct(slug);
    if (!product) return;

    const developer = product.developers || {};

    let productReviews = [];

    if (product.id && NexusDB.listProductReviews) {
      const { data } = await NexusDB.listProductReviews(product.id);
      productReviews = data || [];
    } else {
      productReviews = product.reviews || [];
    }

    const side = `
      <div class="modal-head">
        <div>
          <span class="${NexusUI.pillClass(product.color)}">
            ${NexusUI.escapeHtml(NexusUI.localizeRecord(product, "badge", NexusUI.localizeRecord(product, "category", "Automation")))}
          </span>

          <h2>${NexusUI.escapeHtml(NexusUI.localizeRecord(product, "title"))}</h2>

          <p>${NexusUI.escapeHtml(NexusUI.localizeRecord(product, "long_description", NexusUI.localizeRecord(product, "short_description", "")))}</p>
        </div>

        <button class="close" onclick="NexusUI.closeModal()">Close</button>
      </div>

      <div
        class="developer-mini"
        onclick="location.href='/pages/developers/profile.html?id=${developer.id || ""}'"
        style="cursor:pointer"
      >
        <div class="avatar">${developer.avatar_letter || "N"}</div>

        <div>
          <strong>${NexusUI.escapeHtml(developer.display_name || "Nexus Internal")}</strong>
          <span>${NexusUI.escapeHtml(NexusUI.localizeRecord(developer, "type", "Verified Operator"))} &middot; View profile</span>
        </div>
      </div>

      <div class="price-box">
        <span>Price</span>
        <strong>${NexusUI.money(product)}</strong>
        ${NexusUI.guidedInstallFeeMoney?.(product) ? `
          <small>Guided install: + ${NexusUI.guidedInstallFeeMoney(product)}</small>
        ` : ""}
      </div>

      ${NexusUI.infoBlock("Problem it solves", [NexusUI.localizeRecord(product, "problem")])}
      ${NexusUI.infoBlock("Business outcome", [NexusUI.localizeRecord(product, "outcome")])}
      ${NexusUI.infoBlock("Who this is for", NexusUI.localizeArray(product, "who_it_is_for"))}
      ${NexusUI.infoBlock("Outputs", NexusUI.localizeArray(product, "outputs"))}
      ${NexusUI.infoBlock("Required inputs", NexusUI.localizeArray(product, "required_inputs"))}
      ${NexusUI.renderCustomizations(product, "modal")}
    `;

    const isCustomRequest = isRequestOnlyProduct(product);
    const ctaHref = isCustomRequest
      ? `/pages/custom-request/index.html?slug=${encodeURIComponent(product.slug)}`
      : `/pages/checkout/index.html?slug=${encodeURIComponent(product.slug)}&step=setup`;
    const ctaLabel = isCustomRequest ? "Request custom automation" : "Buy / choose setup";
    const ctaText = isCustomRequest
      ? "Tell Nexus what you need and we will review scope, tools, budget, and timeline."
      : "Buy opens the dedicated setup page where the buyer chooses Self-Serve or Nexus Guided Install.";
    const isNexusProduct = !product.developer_id || String(product.developers?.handle || "").toLowerCase() === "nexus-internal";
    const messageButton = isNexusProduct
      ? `<a class="btn btn-secondary" href="/pages/contact/index.html">Ask Nexus</a>`
      : `<button class="btn btn-secondary" type="button" onclick="NexusApp.startProductMessage('${product.id}')">Message developer</button>`;

    const main = `
      <div class="preview-shell">
        <div class="browser-bar">
          <span class="browser-dot red"></span>
          <span class="browser-dot yellow"></span>
          <span class="browser-dot green-dot"></span>
          <span>nexus.ai / live-preview</span>
        </div>

        <div class="preview-window" id="livePreview">
          ${NexusUI.renderPreview(product)}
        </div>
      </div>

      ${NexusUI.publicReviewsBlock("Product reviews", productReviews)}

      <div class="card">
        <h3>Ready to use this automation?</h3>

        <p>
          ${ctaText}
        </p>

        <div class="hero-actions" style="justify-content:flex-start">
          <a
            class="btn btn-primary"
            href="${ctaHref}"
          >
            ${ctaLabel}
          </a>

          ${messageButton}
        </div>
      </div>
    `;

    NexusUI.openModal(side, main);
    NexusUI.applyTranslations?.(document.getElementById("productModal"));
  }

  async function openSetupChoice(slug) {
    window.location.href = `/pages/checkout/index.html?slug=${encodeURIComponent(slug)}&step=setup`;
  }

  async function startProductMessage(productId) {
    const { data: sessionData } = await NexusDB.getSession();

    if (!sessionData?.session?.user) {
      location.href = NexusDB.accountLoginPath("buyer", location.pathname + location.search, "message");
      return;
    }

    const { data, error } = await NexusDB.startProductMessageThread(productId, "");

    if (error) {
      NexusUI.toast(error.message || "Could not start message.");
      return;
    }

    const threadId = data?.thread?.id || data?.message?.thread_id;
    if (threadId) {
      location.href = `/pages/buyer/dashboard.html?tab=messages&thread=${encodeURIComponent(threadId)}`;
      return;
    }

    location.href = "/pages/buyer/dashboard.html?tab=messages";
  }

  function chooseInstall(type) {
    const input = document.getElementById("chosenInstallType");
    if (input) input.value = type;

    document.querySelectorAll("[data-install-choice]").forEach((element) => {
      element.classList.toggle("active", element.dataset.installChoice === type);
    });
  }

  function productAllowsGuidedInstall(product) {
    if (!product) return false;
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

    return product.guided_install_enabled === true ||
      String(product.guided_install_enabled || "").toLowerCase() === "true";
  }

  function selectCustomization(index, target = "modal") {
    if (!activeProduct) return;

    const customization = (activeProduct.customizations || [])[index];
    selectedCustomizationName = customization?.name || "";

    document.querySelectorAll(".customization-card").forEach((element, currentIndex) => {
      element.classList.toggle("active", currentIndex === index);
    });

    const livePreview = document.getElementById("livePreview");
    if (livePreview) {
      livePreview.innerHTML = NexusUI.renderPreview(activeProduct, customization);
      NexusUI.applyTranslations?.(livePreview);
    }

    const chosenCustomization = document.getElementById("chosenCustomization");
    if (chosenCustomization) {
      chosenCustomization.value = selectedCustomizationName;
    }
  }

 async function renderCheckout() {
  const slug = NexusUI.q("slug");
  const root = document.getElementById("checkoutRoot");

  if (!root) return;

  /*
    Buyer must login before choosing setup/payment.
  */
  const currentUrl = location.pathname + location.search;
  const user = await NexusDB.requireBuyer(currentUrl);

  if (!user) return;

  const { data: product, error } = await NexusDB.getAutomationBySlug(slug);

  if (error || !product) {
    root.innerHTML = `
      <div class="card">
        <h2>Product not found</h2>
        <p>Return to the marketplace and choose a product again.</p>
        <a class="btn btn-primary" href="/pages/marketplace/index.html">Back to marketplace</a>
      </div>
    `;
    return;
  }

  activeProduct = product;

  if (isRequestOnlyProduct(product)) {
    const requestHref = `/pages/custom-request/index.html?slug=${encodeURIComponent(product.slug || "")}`;

    root.innerHTML = `
      <div class="card">
        <span class="${NexusUI.pillClass(product.color)}">
          ${NexusUI.escapeHtml(product.badge || product.category || "Custom request")}
        </span>
        <h2>${NexusUI.escapeHtml(product.title || "Custom automation request")}</h2>
        <p>
          This product is handled as a custom quote, so it does not use Stripe checkout.
          Send the request and Nexus will follow up with the next steps.
        </p>
        <div class="card-actions">
          <a class="btn btn-primary" href="${requestHref}">Request custom automation</a>
          <a class="btn btn-secondary" href="/pages/marketplace/index.html">Back to marketplace</a>
        </div>
      </div>
    `;
    NexusUI.applyTranslations?.(root);
    return;
  }

  /*
    IMPORTANT:
    We no longer render the old details/request page.
    Checkout now goes:
    setup choice → Stripe → success → setup form.
  */
  renderSetupChoicePage(root, product);
}

function renderSetupChoicePage(root, product) {
  const guidedInstallEnabled = productAllowsGuidedInstall(product);
  const guidedInstallFee = NexusUI.guidedInstallFeeMoney?.(product) || "";
  const guidedInstallFeeLabel = guidedInstallFee ? `+ ${guidedInstallFee}` : "Included";
  const setupIntro = guidedInstallEnabled
    ? "Choose how you want this automation set up. After selecting a setup path, you will continue directly to secure Stripe checkout. The setup form comes after payment."
    : "This product uses self-serve setup after payment. You will continue directly to secure Stripe checkout, then submit the required setup details from your buyer dashboard.";
  const guidedInstallChoice = guidedInstallEnabled
    ? `
              <div
                class="choice-card"
                data-install-choice="nexus_guided"
                onclick="NexusApp.chooseInstall('nexus_guided')"
              >
                <h3>Nexus Guided Install</h3>
                <p>
                  Best when Nexus or the product developer should help collect access, configure the workflow, and prepare the automation.
                </p>

                <div class="tags">
                  <span class="tag">Managed setup</span>
                  <span class="tag">Best for complex cases</span>
                  <span class="tag">Guided support</span>
                </div>

                <div class="install-price-note">
                  <span>Guided install fee</span>
                  <strong>${guidedInstallFeeLabel}</strong>
                </div>
              </div>
    `
    : "";

  root.innerHTML = `
    <div class="checkout-setup-page">
      <div class="section-head">
        <span class="eyebrow">Choose setup path</span>

        <h2>${product.title}</h2>

        <p>
          ${setupIntro}
        </p>
      </div>

      <div class="grid-2">
        <div>
          <div class="card">
            <span class="${NexusUI.pillClass(product.color)}">
              ${product.badge || product.category || "Automation"}
            </span>

            <h2>${product.title}</h2>

            <p>${product.short_description || ""}</p>

            <div class="price-box">
              <span>Price</span>
              <strong>${NexusUI.money(product)}</strong>
            </div>

            <div class="tags">
              <span class="tag">${product.category || "Automation"}</span>
              <span class="tag">${product.delivery_time || "Custom"}</span>
              <span class="tag">${NexusUI.getCurrency()}</span>
            </div>
          </div>

          ${NexusUI.renderCustomizations(product, "checkout")}
        </div>

        <div class="card">
          <h2>Setup method</h2>

          <p>
            Select the setup path. After payment, the buyer dashboard will show the correct setup form.
          </p>

          <form id="setupChoicePageForm">
            <input type="hidden" id="chosenInstallType" name="install_type" value="self_serve">
            <input type="hidden" id="chosenCustomization" name="selected_customization" value="">

            <div class="choice-grid">
              <div
                class="choice-card active"
                data-install-choice="self_serve"
                onclick="NexusApp.chooseInstall('self_serve')"
              >
                <h3>Self-Serve Setup</h3>
                <p>
                  Best when the customer can submit all required setup details through the Nexus setup form after payment.
                </p>

                <div class="tags">
                  <span class="tag">Fastest</span>
                  <span class="tag">Setup form after payment</span>
                  <span class="tag">Best for simple workflows</span>
                </div>
              </div>

              ${guidedInstallChoice}
            </div>

            <button type="submit" class="btn btn-primary btn-full" style="margin-top:1rem">
              Continue to secure payment
            </button>
          </form>
        </div>
      </div>
    </div>
  `;

  NexusUI.applyTranslations?.(root);

  const form = document.getElementById("setupChoicePageForm");

  form.onsubmit = async function(event) {
    event.preventDefault();
    event.stopPropagation();

    const user = await NexusDB.requireBuyer(location.pathname + location.search);
    if (!user) return;

    if (typeof NexusDB.createStripeCheckoutSession !== "function") {
      NexusUI.toast("Stripe checkout function is missing.");
      console.error("Missing NexusDB.createStripeCheckoutSession");
      return;
    }

    const button = form.querySelector("button[type='submit']");
    const originalButtonText = button ? button.textContent : "";

    if (button) {
      button.disabled = true;
      button.textContent = "Opening secure checkout...";
    }

    let installType = document.getElementById("chosenInstallType").value || "self_serve";
    if (installType === "nexus_guided" && !productAllowsGuidedInstall(product)) {
      installType = "self_serve";
    }
    const customization =
      document.getElementById("chosenCustomization").value ||
      selectedCustomizationName ||
      "";

    const payload = {
      automation_id: product.id,
      install_type: installType,
      selected_customization: customization,
      currency: NexusUI.getCurrency(),
      buyer_name: user.user_metadata?.full_name || "",
      buyer_email: user.email || "",
      buyer_company: "",
      buyer_website: "",
      setup_notes: "",
    };

    const { data, error } = await NexusDB.createStripeCheckoutSession(payload);

    if (error) {
      NexusUI.toast(error.message || "Stripe checkout failed.");
      console.error("Stripe checkout error:", error);

      if (button) {
        button.disabled = false;
        button.textContent = originalButtonText;
      }

      return;
    }

    if (!data?.checkout_url) {
      NexusUI.toast("Stripe checkout URL was not returned.");
      console.error("Missing checkout_url:", data);

      if (button) {
        button.disabled = false;
        button.textContent = originalButtonText;
      }

      return;
    }

    window.location.href = data.checkout_url;
  };
}

  async function renderCheckoutDetailsPage(root, product, install, custom) {
  const currentUrl = location.pathname + location.search;
  const user = await NexusDB.requireBuyer(currentUrl);

  if (!user) return;

  const { data: buyerProfile } = await NexusDB.getBuyerProfile(user.id);

  const installLabel =
    install === "nexus_guided" ? "Nexus Guided Install" : "Self-Serve Setup";

  root.innerHTML = `
    <div class="grid-2">
      <div>
        <span class="eyebrow">Order request</span>

        <h1 style="font-size:clamp(3rem,5vw,5rem);line-height:.95;letter-spacing:-.07em;color:var(--navy);margin:1rem 0">
          Confirm your automation request.
        </h1>

        <p style="color:var(--muted);font-size:1.08rem;line-height:1.82">
          Stripe is not connected yet. For now, this creates a Nexus order request,
          notifies Nexus, and adds the automation to your buyer dashboard.
        </p>

        <div class="card" style="margin-top:1rem">
          <span class="${NexusUI.pillClass(product.color)}">
            ${product.badge || product.category || "Automation"}
          </span>

          <h2>${product.title}</h2>

          <p>${product.short_description || ""}</p>

          <div class="price-box">
            <span>Price</span>
            <strong>${NexusUI.money(product)}</strong>
          </div>

          <div class="tags">
            <span class="tag">${installLabel}</span>
            ${custom ? `<span class="tag">${custom}</span>` : ""}
            <span class="tag">${NexusUI.getCurrency()}</span>
          </div>
        </div>
      </div>

      <form class="card" id="checkoutPrepForm">
        <input type="hidden" name="automation_id" value="${product.id}">
        <input type="hidden" name="developer_id" value="${product.developer_id || product.developers?.id || ""}">
        <input type="hidden" name="automation_title" value="${NexusUI.escapeHtml(product.title)}">
        <input type="hidden" name="install_type" value="${install}">
        <input type="hidden" name="selected_customization" value="${NexusUI.escapeHtml(custom || "")}">

        <h2>Buyer details</h2>

        <p>
          This creates your order request and sends Nexus a notification.
        </p>

        <div class="form-grid" style="margin-top:1rem">
          <div>
            <label>Name</label>
            <input class="input" name="name" required value="${buyerProfile?.name || user.user_metadata?.full_name || ""}">
          </div>

          <div>
            <label>Email</label>
            <input class="input" type="email" name="email" required value="${buyerProfile?.email || user.email || ""}">
          </div>

          <div>
            <label>Company</label>
            <input class="input" name="company" value="${buyerProfile?.company || ""}">
          </div>

          <div>
            <label>Website</label>
            <input class="input" name="website" value="${buyerProfile?.website || ""}">
          </div>

          <div class="full">
            <label>Setup notes</label>
            <textarea
              class="textarea"
              name="notes"
              placeholder="Any setup details, questions, required accounts, integrations, or timing?"
            ></textarea>
          </div>
        </div>

        <button type="submit" class="btn btn-primary" style="margin-top:1rem">
  Continue to secure payment
</button>
      </form>
    </div>
  `;

  const checkoutForm = document.getElementById("checkoutPrepForm");

checkoutForm.onsubmit = submitCheckoutIntent;
}

async function submitCheckoutIntent(event) {
  event.preventDefault();

  const user = await NexusDB.requireBuyer(location.pathname + location.search);
  if (!user) return;

  if (!activeProduct) {
    NexusUI.toast("Product not loaded. Refresh and try again.");
    return;
  }

  if (typeof NexusDB.createStripeCheckoutSession !== "function") {
    NexusUI.toast("Stripe checkout function is missing in nexus-db.js.");
    console.error("Missing NexusDB.createStripeCheckoutSession");
    return;
  }

  const form = event.target;
  const button = form.querySelector("button[type='submit'], button");
  const originalButtonText = button ? button.textContent : "";

  if (button) {
    button.disabled = true;
    button.textContent = "Opening secure checkout...";
  }

  const formData = new FormData(form);

  const payload = {
    automation_id: String(formData.get("automation_id") || ""),
    install_type: String(formData.get("install_type") || ""),
    selected_customization: String(formData.get("selected_customization") || ""),
    currency: NexusUI.getCurrency(),
    buyer_name: String(formData.get("name") || ""),
    buyer_email: String(formData.get("email") || ""),
    buyer_company: String(formData.get("company") || ""),
    buyer_website: String(formData.get("website") || ""),
    setup_notes: String(formData.get("notes") || "")
  };

  const { data, error } = await NexusDB.createStripeCheckoutSession(payload);

  if (error) {
    NexusUI.toast(error.message || "Stripe checkout failed.");
    console.error("Stripe checkout error:", error);

    if (button) {
      button.disabled = false;
      button.textContent = originalButtonText;
    }

    return;
  }

  if (!data || !data.checkout_url) {
    NexusUI.toast("Stripe checkout URL was not returned.");
    console.error("Missing checkout_url:", data);

    if (button) {
      button.disabled = false;
      button.textContent = originalButtonText;
    }

    return;
  }

  window.location.href = data.checkout_url;
}
  async function renderDevelopers() {
    const { data, error } = await NexusDB.listDevelopers();
    const grid = document.getElementById("developerGrid");

    if (!grid) return;

    if (error) {
      grid.innerHTML = `<div class="error">${error.message}</div>`;
      return;
    }

    grid.innerHTML = (data || [])
      .map((developer) => {
        return `
          <div class="developer-hero">
            <div class="developer-banner" style="${bannerStyle(developer)}"></div>

            <div class="developer-profile-body">
              <div class="developer-avatar-large">${developer.avatar_letter || "N"}</div>

              <h3>${developer.display_name}</h3>

              <p>${developer.short_description || ""}</p>

              <div class="tags">
                <span class="tag">${developer.type || "Developer"}</span>
                <span class="tag">${developer.verified ? "Verified" : "Pending"}</span>
                <span class="tag">${developer.rating ? NexusUI.ratingStars(developer.rating) : "New"}</span>
              </div>

              <a class="btn btn-primary" href="/pages/developers/profile.html?id=${developer.id}">
                View profile
              </a>
            </div>
          </div>
        `;
      })
      .join("");

    NexusUI.applyTranslations?.(grid);
  }

  async function renderDeveloperProfile() {
    const id = NexusUI.q("id");
    const root = document.getElementById("developerProfile");

    if (!root) return;

    const { data: developer, error } = await NexusDB.getDeveloper(id);

    if (error || !developer) {
      root.innerHTML = `<div class="card"><h2>Developer not found</h2></div>`;
      return;
    }

    const [{ data: products }, { data: developerReviews }, { data: sessionData }] = await Promise.all([
      NexusDB.listDeveloperAutomations(id),
      NexusDB.listDeveloperReviews ? NexusDB.listDeveloperReviews(id) : Promise.resolve({ data: [] }),
      NexusDB.getSession ? NexusDB.getSession() : Promise.resolve({ data: null })
    ]);

    const reviewStats = NexusUI.reviewStats(developerReviews || []);
    const currentUser = sessionData?.session?.user || null;
    const isOwnDeveloperProfile = currentUser?.id && developer.profile_id && currentUser.id === developer.profile_id;
    const loginHref = NexusDB.accountLoginPath
      ? NexusDB.accountLoginPath("buyer", location.pathname + location.search)
      : `/pages/buyer/login.html?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    const developerName = NexusUI.escapeHtml(developer.display_name || "this developer");
    const developerReviewButton = !currentUser
      ? `<a class="btn btn-secondary btn-small" href="${NexusUI.escapeAttribute(loginHref)}">Review developer</a>`
      : isOwnDeveloperProfile
        ? ""
        : `<button class="btn btn-secondary btn-small" type="button" onclick="NexusApp.openDeveloperReviewModal()">Review developer</button>`;
    const developerReviewModal = currentUser && !isOwnDeveloperProfile
      ? `
        <div class="nexus-modal-lite" id="developerReviewModal" aria-hidden="true">
          <div class="nexus-modal-lite-backdrop" onclick="NexusApp.closeDeveloperReviewModal()"></div>

          <div class="nexus-modal-lite-card">
            <button class="nexus-modal-lite-close" type="button" onclick="NexusApp.closeDeveloperReviewModal()">&times;</button>

            <span class="eyebrow">Developer review</span>
            <h2>Review ${developerName}</h2>
            <p>Share feedback about delivery, communication, setup quality, or support.</p>

            <form id="developerReviewForm">
              <div class="form-grid">
                <div>
                  <label>Rating</label>
                  <select class="select" id="developerReviewRating" required>
                    <option value="5">5 - Excellent</option>
                    <option value="4">4 - Good</option>
                    <option value="3">3 - Okay</option>
                    <option value="2">2 - Needs work</option>
                    <option value="1">1 - Poor</option>
                  </select>
                </div>

                <div>
                  <label>Your role</label>
                  <input class="input" id="developerReviewRole" placeholder="Operations Manager">
                </div>

                <div class="full">
                  <label>Review</label>
                  <textarea
                    class="textarea"
                    id="developerReviewText"
                    minlength="10"
                    required
                    placeholder="What was it like working with this developer?"
                  ></textarea>
                </div>
              </div>

              <div class="modal-lite-actions">
                <button class="btn btn-secondary" type="button" onclick="NexusApp.closeDeveloperReviewModal()">
                  Cancel
                </button>

                <button class="btn btn-primary" type="submit">
                  Submit review
                </button>
              </div>
            </form>
          </div>
        </div>
      `
      : "";

    root.innerHTML = `
      <div class="developer-hero">
        <div class="developer-banner" style="${bannerStyle(developer)}"></div>

        <div class="developer-profile-body">
          <div class="developer-avatar-large">${developer.avatar_letter || "N"}</div>

          <div class="developer-profile-title-row">
            <div>
              <h1 style="font-size:3rem;line-height:1;letter-spacing:-.06em;color:var(--navy);margin:1rem 0">
                ${developer.display_name}
              </h1>

              <p>${developer.bio || ""}</p>
            </div>

            <div class="developer-rating-card">
              <strong>${reviewStats.count ? reviewStats.average.toFixed(1) : "New"}</strong>
              <span>${reviewStats.count ? NexusUI.ratingStars(reviewStats.average) : "No reviews yet"}</span>
              <small>${reviewStats.count} review${reviewStats.count === 1 ? "" : "s"}</small>
              <button class="btn btn-secondary btn-small" type="button" onclick="NexusApp.startDeveloperMessage('${developer.id}')">
                Message developer
              </button>
              ${developerReviewButton}
            </div>
          </div>

          <div class="tags">
            ${NexusUI.arrayList(developer.skills)
              .map((skill) => `<span class="tag">${skill}</span>`)
              .join("")}
          </div>
        </div>
      </div>

      <div class="grid-3" style="margin-top:1.2rem">
        <div class="card">
          <h3>${developer.type || "Developer"}</h3>
          <p>Operator type</p>
        </div>

        <div class="card">
          <h3>${reviewStats.count ? reviewStats.average.toFixed(1) : "New"}</h3>
          <p>Developer rating</p>
        </div>

        <div class="card">
          <h3>${products?.length || 0}</h3>
          <p>Live products</p>
        </div>
      </div>

      <div style="margin-top:1.2rem">
        ${NexusUI.publicReviewsBlock("Developer reviews", developerReviews || [])}
      </div>

      <div class="section-head left" style="margin-top:2rem">
        <h2>Automations by ${developer.display_name}</h2>
        <p>Every public developer profile shows the live products connected to that builder/operator.</p>
      </div>

      <div class="grid-3">
        ${(products || []).map(NexusUI.productCard).join("") || "<div class='card'><h3>No live products yet</h3></div>"}
      </div>

      ${developerReviewModal}
    `;

    NexusUI.applyTranslations?.(root);

    const developerReviewForm = document.getElementById("developerReviewForm");

    if (developerReviewForm) {
      developerReviewForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const button = developerReviewForm.querySelector("button[type='submit']");
        const originalText = button ? button.textContent : "";
        const rating = Number(document.getElementById("developerReviewRating")?.value || 5);
        const reviewerRole = String(document.getElementById("developerReviewRole")?.value || "").trim();
        const reviewText = String(document.getElementById("developerReviewText")?.value || "").trim();

        if (reviewText.length < 10) {
          NexusUI.toast("Please write at least 10 characters.");
          return;
        }

        if (button) {
          button.disabled = true;
          button.textContent = "Submitting...";
        }

        const { data, error: reviewError } = await NexusDB.submitDeveloperReview({
          developer_id: id,
          rating,
          reviewer_role: reviewerRole,
          review_text: reviewText
        });

        if (button) {
          button.disabled = false;
          button.textContent = originalText;
        }

        if (reviewError) {
          NexusUI.toast(reviewError.message || "Could not submit review.");
          return;
        }

        developerReviewForm.reset();
        NexusUI.toast(data?.message || "Review submitted for approval.");
      });
    }

    forceBuyLinksToCheckoutPage();
  }

  function bannerStyle(developer) {
    if (developer.banner_base64) return `background-image:url('${developer.banner_base64}')`;
    if (developer.banner_url) return `background-image:url('${developer.banner_url}')`;
    return `background:${developer.banner_color || "linear-gradient(135deg,#2563ff,#00c2ff)"}`;
  }

  function openDeveloperReviewModal() {
    const modal = document.getElementById("developerReviewModal");

    if (!modal) {
      NexusUI.toast("Review form is missing on this page.");
      return;
    }

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");

    setTimeout(() => {
      document.getElementById("developerReviewText")?.focus();
    }, 100);
  }

  function closeDeveloperReviewModal() {
    const modal = document.getElementById("developerReviewModal");

    if (!modal) return;

    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }

  async function startDeveloperMessage(developerId) {
    const { data: sessionData } = await NexusDB.getSession();

    if (!sessionData?.session?.user) {
      location.href = NexusDB.accountLoginPath("buyer", location.pathname + location.search, "message");
      return;
    }

    const { data, error } = await NexusDB.startDeveloperMessageThread(developerId, "");

    if (error) {
      NexusUI.toast(error.message || "Could not start message.");
      return;
    }

    const threadId = data?.thread?.id || data?.message?.thread_id;
    location.href = threadId
      ? `/pages/buyer/dashboard.html?tab=messages&thread=${encodeURIComponent(threadId)}`
      : "/pages/buyer/dashboard.html?tab=messages";
  }

  function wireLogin() {
    const form = document.getElementById("loginForm");

    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const formData = new FormData(form);

      const { error } = await NexusDB.signIn(
        String(formData.get("email")),
        String(formData.get("password"))
      );

      if (error) {
        NexusUI.toast(error.message);
        return;
      }

      window.location.href = "/pages/admin/dashboard.html";
    });
  }

  async function renderAdmin() {
    if (document.body.dataset.adminPage === "customer-automations") return;
    if (document.body.dataset.adminPage === "dashboard") await renderAdminDashboard();
    if (document.body.dataset.adminPage === "automations") await renderAdminAutomations();
    if (document.body.dataset.adminPage === "product-reviews") {
      wireProductReviewFilters();
      await renderAdminAutomations();
    }
    if (document.body.dataset.adminPage === "finance") await renderAdminFinance();
    if (document.body.dataset.adminPage === "automation-form") await wireAutomationForm();
    if (document.body.dataset.adminPage === "developer-profile") await wireDeveloperProfileForm();
    if (document.body.dataset.adminPage === "reviews") await wireReviewsPage();
    if (document.body.dataset.adminPage === "waitlist") await renderWaitlist();
    if (document.body.dataset.adminPage === "messages") await renderMessages();
    if (document.body.dataset.adminPage === "checkout-intents") await renderCheckoutIntents();
    if (document.body.dataset.adminPage === "notifications") await renderAdminNotifications();

    NexusUI.applyTranslations?.(document.body);
  }

  async function renderAdminDashboard() {
    const countValue = (result) => result?.error ? 0 : result?.data || 0;
    const [
      totalProducts,
      liveProducts,
      pendingReviews,
      developers,
      reviews,
      waitlist,
      messages,
      checkout,
      finance
    ] = await Promise.all([
      NexusDB.countAutomations ? NexusDB.countAutomations() : NexusDB.listAllAutomations(),
      NexusDB.countAutomations ? NexusDB.countAutomations("live") : NexusDB.listAllAutomations(),
      NexusDB.countAutomations ? NexusDB.countAutomations("pending_review") : NexusDB.listAllAutomations(),
      NexusDB.countDevelopers ? NexusDB.countDevelopers() : NexusDB.listDevelopers(),
      NexusDB.countReviews ? NexusDB.countReviews() : NexusDB.listReviews(),
      NexusDB.countWaitlist ? NexusDB.countWaitlist() : NexusDB.listWaitlist(),
      NexusDB.countContacts ? NexusDB.countContacts() : NexusDB.listContacts(),
      NexusDB.countCheckoutIntents ? NexusDB.countCheckoutIntents() : NexusDB.listCheckoutIntents(),
      NexusDB.getAdminFinanceSummary ? NexusDB.getAdminFinanceSummary() : Promise.resolve({ data: null, error: null }),
    ]);

    document.getElementById("totalProducts").textContent = NexusDB.countAutomations ? countValue(totalProducts) : totalProducts.data?.length || 0;
    document.getElementById("liveProducts").textContent = NexusDB.countAutomations
      ? countValue(liveProducts)
      : (liveProducts.data || []).filter((product) => product.status === "live").length;
    const pendingProductReviews = document.getElementById("pendingProductReviews");
    if (pendingProductReviews) {
      pendingProductReviews.textContent = NexusDB.countAutomations
        ? countValue(pendingReviews)
        : (pendingReviews.data || []).filter((product) => product.status === "pending_review").length;
    }
    document.getElementById("totalDevelopers").textContent = NexusDB.countDevelopers ? countValue(developers) : developers.data?.length || 0;
    document.getElementById("totalReviews").textContent = NexusDB.countReviews ? countValue(reviews) : reviews.data?.length || 0;
    document.getElementById("totalWaitlist").textContent = NexusDB.countWaitlist ? countValue(waitlist) : waitlist.data?.length || 0;
    document.getElementById("totalMessages").textContent = NexusDB.countContacts ? countValue(messages) : messages.data?.length || 0;
    document.getElementById("totalCheckout").textContent = NexusDB.countCheckoutIntents ? countValue(checkout) : checkout.data?.length || 0;
    const payoutMetric = document.getElementById("totalPayoutRequests");
    if (payoutMetric) {
      const payoutRequests = finance?.error ? [] : finance?.data?.payout_requests || [];
      payoutMetric.textContent = payoutRequests
        .filter((item) => ["pending", "approved"].includes(String(item.status || "").toLowerCase()))
        .length;
    }

    await renderDemoMarketplaceStatus();
  }

  function setDemoMarketplaceBusy(isBusy) {
    ["demoModeEnable", "demoModeDisable", "demoModeReset"].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = Boolean(isBusy);
    });
  }

  async function renderDemoMarketplaceStatus() {
    const statusEl = document.getElementById("demoModeStatus");
    const countsEl = document.getElementById("demoModeCounts");
    const pill = document.getElementById("demoModePill");
    const enableButton = document.getElementById("demoModeEnable");
    const disableButton = document.getElementById("demoModeDisable");

    if (!statusEl || !countsEl) return;

    if (typeof NexusDB.getDemoMarketplaceStatus !== "function") {
      statusEl.textContent = "Unavailable";
      countsEl.textContent = "Demo marketplace function is missing.";
      return;
    }

    const { data, error } = await NexusDB.getDemoMarketplaceStatus();

    if (error) {
      statusEl.textContent = "Unavailable";
      countsEl.textContent = error.message || "Could not load demo marketplace status.";
      pill?.classList.remove("green", "orange");
      pill?.classList.add("red");
      return;
    }

    const enabled = Boolean(data?.enabled);
    const counts = data?.counts || {};

    statusEl.textContent = enabled ? "On" : "Off";
    countsEl.textContent = `${counts.developers || 0} demo developers, ${counts.products || 0} demo products, ${counts.reviews || 0} demo reviews. Public now: ${counts.live_products || 0} products, ${counts.active_developers || 0} developers.`;

    if (pill) {
      pill.classList.remove("green", "orange", "red");
      pill.classList.add(enabled ? "green" : "orange");
      pill.textContent = enabled ? "Demo mode on" : "Demo mode off";
    }

    if (enableButton) enableButton.disabled = enabled;
    if (disableButton) disableButton.disabled = !enabled;
  }

  async function enableDemoMarketplace() {
    if (typeof NexusDB.enableDemoMarketplace !== "function") {
      NexusUI.toast("Demo marketplace function is missing.");
      return;
    }

    setDemoMarketplaceBusy(true);
    NexusUI.toast("Turning on demo marketplace...");

    const { data, error } = await NexusDB.enableDemoMarketplace();

    if (error) {
      NexusUI.toast(error.message || "Could not turn on demo marketplace.");
      setDemoMarketplaceBusy(false);
      await renderDemoMarketplaceStatus();
      return;
    }

    NexusUI.toast(data?.message || "Demo marketplace mode is on.");
    await renderAdminDashboard();
    setDemoMarketplaceBusy(false);
  }

  async function disableDemoMarketplace() {
    const confirmed = await NexusUI.confirmDialog({
      title: "Turn off demo mode?",
      message: "Synthetic demo developers, products, and reviews will be hidden. Real marketplace data will not be changed.",
      confirmText: "Turn off"
    });
    if (!confirmed) return;

    if (typeof NexusDB.disableDemoMarketplace !== "function") {
      NexusUI.toast("Demo marketplace function is missing.");
      return;
    }

    setDemoMarketplaceBusy(true);
    NexusUI.toast("Turning off demo marketplace...");

    const { data, error } = await NexusDB.disableDemoMarketplace();

    if (error) {
      NexusUI.toast(error.message || "Could not turn off demo marketplace.");
      setDemoMarketplaceBusy(false);
      await renderDemoMarketplaceStatus();
      return;
    }

    NexusUI.toast(data?.message || "Demo marketplace mode is off.");
    await renderAdminDashboard();
    setDemoMarketplaceBusy(false);
  }

  async function resetDemoMarketplace() {
    const confirmed = await NexusUI.confirmDialog({
      title: "Reset demo content?",
      message: "This restores the synthetic demo developers, products, and reviews. The current on/off status will be preserved.",
      confirmText: "Reset content"
    });
    if (!confirmed) return;

    if (typeof NexusDB.resetDemoMarketplace !== "function") {
      NexusUI.toast("Demo marketplace function is missing.");
      return;
    }

    setDemoMarketplaceBusy(true);
    NexusUI.toast("Resetting demo marketplace content...");

    const { data, error } = await NexusDB.resetDemoMarketplace();

    if (error) {
      NexusUI.toast(error.message || "Could not reset demo marketplace content.");
      setDemoMarketplaceBusy(false);
      await renderDemoMarketplaceStatus();
      return;
    }

    NexusUI.toast(data?.message || "Demo marketplace content was reset.");
    await renderAdminDashboard();
    setDemoMarketplaceBusy(false);
  }

  async function renderAdminFinance() {
    const summaryRoot = document.getElementById("financeSummary");
    const rows = document.getElementById("financeRows");
    const payoutRows = document.getElementById("payoutRows");

    if (!summaryRoot && !rows && !payoutRows) return;

    if (typeof NexusDB.getAdminFinanceSummary !== "function") {
      if (summaryRoot) summaryRoot.innerHTML = `<div class="error">Finance function is missing.</div>`;
      return;
    }

    const { data, error } = await NexusDB.getAdminFinanceSummary();

    if (error) {
      if (summaryRoot) summaryRoot.innerHTML = `<div class="error">${error.message}</div>`;
      if (rows) rows.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
      if (payoutRows) payoutRows.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
      return;
    }

    const earnings = data?.earnings || data?.recent_earnings || [];
    const paidOrders = data?.paid_orders || [];
    const orderTotals = data?.order_totals || [];
    const payoutRequests = data?.payout_requests || [];
    const moneyValue = (value, currency = "THB") => {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(value || 0));
    };
    const earningByOrder = new Map();
    (earnings || []).forEach((earning) => {
      if (earning.order_id) earningByOrder.set(earning.order_id, earning);
    });
    const fallbackOrderTotals = (() => {
      const totals = new Map();
      (paidOrders || []).forEach((order) => {
        const currency = String(order.currency || order.stripe_currency || "THB").toUpperCase();
        const current = totals.get(currency) || {
          currency,
          gross_amount: 0,
          stripe_fee_amount: 0,
          net_amount: 0,
          platform_fee_amount: 0,
          developer_amount: 0,
        };
        const earning = earningByOrder.get(order.id) || {};
        const gross =
          Number(order.stripe_amount_total || 0) ||
          Number(earning.gross_amount || 0) ||
          Number(String(order.price_display || "").replace(/[^0-9.-]+/g, "")) ||
          0;
        const stripeFee = Number(order.stripe_fee_amount || earning.stripe_fee_amount || 0);
        const developerAmount = Number(order.developer_earning_amount || earning.developer_amount || 0);
        const platformAmount = Number(order.platform_fee_amount || earning.platform_fee_amount || Math.max(0, gross - developerAmount));

        current.gross_amount += gross;
        current.stripe_fee_amount += stripeFee;
        current.net_amount += Number(order.net_amount || earning.net_amount || Math.max(0, gross - stripeFee));
        current.platform_fee_amount += platformAmount;
        current.developer_amount += developerAmount;
        totals.set(currency, current);
      });

      return Array.from(totals.values());
    })();
    const financeTotals = orderTotals.length ? orderTotals : fallbackOrderTotals;
    const payoutTotalFor = (currency, statuses) => {
      const wanted = new Set(statuses);
      const targetCurrency = String(currency || "THB").toUpperCase();
      return payoutRequests
        .filter((item) => String(item.currency || "THB").toUpperCase() === targetCurrency)
        .filter((item) => wanted.has(String(item.status || "").toLowerCase()))
        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    };

    if (summaryRoot) {
      summaryRoot.innerHTML = `
        ${
          financeTotals.map((total) => {
            const currency = total.currency || "THB";
            const gross = Number(total.gross_amount || 0);
            const stripeFees = Number(total.stripe_fee_amount || 0);
            const developerAmount = Number(total.developer_amount || 0);
            const nexusGross = Number(total.platform_fee_amount || 0) + Number(total.internal_or_unallocated_gross_amount || 0);
            const nexusNet = Number(total.net_amount || Math.max(0, gross - stripeFees)) - developerAmount;
            const requestedTotal = payoutTotalFor(currency, ["pending", "approved"]);
            const paidPayoutTotal = payoutTotalFor(currency, ["paid"]);

            return `
              <div class="finance-summary-grid">
                <div class="finance-summary-card"><span>Paid volume</span><h3>${moneyValue(gross, currency)}</h3><p>All successful Nexus checkouts.</p></div>
                <div class="finance-summary-card"><span>Stripe fees</span><h3>${moneyValue(stripeFees, currency)}</h3><p>Fees recorded by webhook data.</p></div>
                <div class="finance-summary-card"><span>Nexus gross</span><h3>${moneyValue(nexusGross, currency)}</h3><p>Nexus-owned revenue and platform share.</p></div>
                <div class="finance-summary-card"><span>Nexus net</span><h3>${moneyValue(nexusNet, currency)}</h3><p>After developer share and Stripe fees.</p></div>
                <div class="finance-summary-card"><span>Developer share</span><h3>${moneyValue(developerAmount, currency)}</h3><p>Internal balance owed to developers.</p></div>
                <div class="finance-summary-card"><span>Requested</span><h3>${moneyValue(requestedTotal, currency)}</h3><p>Payout requests waiting or approved.</p></div>
                <div class="finance-summary-card"><span>Paid out</span><h3>${moneyValue(paidPayoutTotal, currency)}</h3><p>Manual payouts marked complete.</p></div>
              </div>
            `;
          }).join("") || `
            <div class="finance-summary-grid">
              <div class="finance-summary-card"><span>Paid volume</span><h3>${moneyValue(0)}</h3><p>No paid orders recorded yet.</p></div>
              <div class="finance-summary-card"><span>Developer share</span><h3>${moneyValue(0)}</h3><p>No developer earnings yet.</p></div>
              <div class="finance-summary-card"><span>Requested</span><h3>${moneyValue(payoutTotalFor("THB", ["pending", "approved"]))}</h3><p>Payout requests waiting or approved.</p></div>
              <div class="finance-summary-card"><span>Paid out</span><h3>${moneyValue(payoutTotalFor("THB", ["paid"]))}</h3><p>Manual payouts marked complete.</p></div>
            </div>
          `
        }
      `;
    }

    if (rows) {
      rows.innerHTML = (paidOrders || [])
        .map((order) => {
          const earning = earningByOrder.get(order.id) || {};
          const currency = order.currency || order.stripe_currency || earning.currency || "THB";
          const gross =
            Number(order.stripe_amount_total || 0) ||
            Number(earning.gross_amount || 0) ||
            Number(String(order.price_display || "").replace(/[^0-9.-]+/g, "")) ||
            0;
          const developerAmount = Number(order.developer_earning_amount || earning.developer_amount || 0);
          const platformNet = order.platform_net_amount !== undefined && order.platform_net_amount !== null
            ? Number(order.platform_net_amount || 0)
            : Number(order.net_amount || earning.net_amount || gross) - developerAmount;
          const developerName = order.developers?.display_name || earning.developers?.display_name || "Nexus internal";

          return `
          <tr>
            <td>
              ${NexusUI.escapeHtml(order.buyer_email || order.buyer_name || "")}
              <br><span style="color:var(--muted);font-size:.85rem">${NexusUI.escapeHtml(developerName)}</span>
            </td>
            <td>${NexusUI.escapeHtml(order.automation_title || order.automations?.title || earning.automations?.title || "")}</td>
            <td>${moneyValue(gross, currency)}</td>
            <td>${moneyValue(platformNet, currency)}</td>
            <td>${moneyValue(developerAmount, currency)}</td>
            <td><span class="pill">${NexusUI.escapeHtml(order.revenue_share_status || earning.payout_status || order.payment_status || "paid")}</span></td>
          </tr>
        `;
        })
        .join("") || `<tr><td colspan="6">No paid orders yet.</td></tr>`;
    }

    if (payoutRows) {
      payoutRows.innerHTML = (payoutRequests || [])
        .map((request) => {
          const status = String(request.status || "pending").toLowerCase();
          const canAct = status === "pending" || status === "approved";
          const receiptHref = request.payment_receipt_base64
            ? `data:${NexusUI.escapeAttribute(request.payment_receipt_mime_type || "application/octet-stream")};base64,${NexusUI.escapeAttribute(request.payment_receipt_base64)}`
            : NexusUI.escapeAttribute(request.payment_receipt_url || "");
          const receiptLabel = request.payment_receipt_file_name || request.payment_receipt_url || "";

          return `
            <tr>
              <td>${NexusUI.escapeHtml(request.developers?.display_name || request.developer_id || "")}</td>
              <td>${moneyValue(request.amount || 0, request.currency || "THB")}</td>
              <td><span class="${status === "paid" ? "pill green" : status === "rejected" ? "pill red" : "pill orange"}">${NexusUI.escapeHtml(status)}</span></td>
              <td>
                ${NexusUI.escapeHtml(request.payout_method || "manual")}
                <br>
                <span style="color:var(--muted);font-size:.85rem">
                  ${NexusUI.escapeHtml(request.payout_details?.details || "")}
                </span>
              </td>
              <td>${request.requested_at ? new Date(request.requested_at).toLocaleString() : ""}</td>
              <td>
                ${
                  canAct
                    ? `
                      <button class="btn btn-primary btn-small" onclick="NexusApp.updatePayoutRequest('${request.id}', 'paid')">
                        Mark paid
                      </button>
                      <button class="btn btn-secondary btn-small" onclick="NexusApp.updatePayoutRequest('${request.id}', 'rejected')">
                        Reject
                      </button>
                    `
                    : `
                      ${NexusUI.escapeHtml(request.payment_reference || "")}
                      ${
                        receiptHref
                          ? `<br><a href="${receiptHref}" target="_blank" rel="noopener">${NexusUI.escapeHtml(receiptLabel || "Receipt")}</a>`
                          : ""
                      }
                    `
                }
              </td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="6">No payout requests yet.</td></tr>`;
    }
  }

  async function updatePayoutRequest(id, status) {
    let paymentReference = "";
    let paymentReceiptUrl = "";
    let paymentReceiptFile = null;
    let adminNote = "";

    if (status === "paid") {
      paymentReference = await NexusUI.promptDialog({
        title: "Mark payout paid",
        message: "Add the payment reference, bank transfer note, or receipt ID.",
        inputLabel: "Payment reference",
        rows: 1,
        confirmText: "Continue"
      }) || "";
      const attachReceipt = await NexusUI.confirmDialog({
        title: "Attach receipt?",
        message: "Attach a receipt file from this device now?",
        confirmText: "Attach file",
        cancelText: "Skip"
      });
      if (attachReceipt) {
        paymentReceiptFile = await pickPayoutReceiptFile();
      }
      paymentReceiptUrl = await NexusUI.promptDialog({
        title: "Receipt link",
        message: "Add a receipt URL or file link if you have one.",
        inputLabel: "Receipt URL",
        placeholder: "Optional",
        rows: 1,
        confirmText: "Save"
      }) || "";
    } else if (status === "rejected") {
      adminNote = await NexusUI.promptDialog({
        title: "Reject payout request",
        message: "Write the reason for rejecting this payout request.",
        inputLabel: "Admin note",
        confirmText: "Reject request"
      }) || "";
    }

    const { error } = await NexusDB.updateDeveloperPayoutRequest({
      payout_request_id: id,
      status,
      payment_reference: paymentReference,
      payment_receipt_url: paymentReceiptUrl,
      payment_receipt_file_name: paymentReceiptFile?.name || "",
      payment_receipt_mime_type: paymentReceiptFile?.type || "",
      payment_receipt_base64: paymentReceiptFile?.base64 || "",
      admin_note: adminNote
    });

    if (error) {
      NexusUI.toast(error.message || "Could not update payout request.");
      return;
    }

    NexusUI.toast(`Payout request ${status}.`);
    await renderAdminFinance();
  }

  function pickPayoutReceiptFile() {
    const input = document.getElementById("payoutReceiptInput");

    if (!input) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        window.removeEventListener("focus", onFocus);
        resolve(value);
      };
      const onFocus = () => {
        setTimeout(() => {
          if (!input.files || !input.files.length) done(null);
        }, 600);
      };

      input.value = "";
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) {
          done(null);
          return;
        }

        if (file.size > 3 * 1024 * 1024) {
          NexusUI.toast("Receipt file is too large. Use a file under 3 MB or paste a receipt link.");
          done(null);
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          done({
            name: file.name,
            type: file.type || "application/octet-stream",
            base64: result.includes(",") ? result.split(",").pop() : result,
          });
        };
        reader.onerror = () => done(null);
        reader.readAsDataURL(file);
      };
      window.addEventListener("focus", onFocus);
      timeoutId = setTimeout(() => done(null), 60000);
      input.click();
    });
  }

  function currentProductReviewFilter() {
    const value = new URLSearchParams(window.location.search).get("status") || "pending_review";
    return ["pending_review", "approved", "all"].includes(value) ? value : "pending_review";
  }

  function isDeveloperProduct(product) {
    return Boolean(product?.developer_id || product?.developers?.id);
  }

  function productMatchesReviewFilter(product, filter) {
    if (!isDeveloperProduct(product)) return false;
    const status = String(product.status || "").toLowerCase();

    if (filter === "pending_review") return status === "pending_review";
    if (filter === "approved") return status === "live" || status === "paused";
    if (filter === "all") return true;

    return status === filter;
  }

  function updateProductReviewFilters(products) {
    const isReviewPage = document.body.dataset.adminPage === "product-reviews";
    if (!isReviewPage) return;

    const filter = currentProductReviewFilter();
    const developerProducts = (products || []).filter(isDeveloperProduct);
    const pending = developerProducts.filter((product) => product.status === "pending_review").length;
    const approved = developerProducts.filter((product) => ["live", "paused"].includes(String(product.status || "").toLowerCase())).length;

    document.querySelectorAll("[data-review-status]").forEach((button) => {
      button.classList.toggle("active", button.dataset.reviewStatus === filter);
    });

    const pendingCount = document.getElementById("pendingReviewCount");
    const approvedCount = document.getElementById("approvedReviewCount");
    const allCount = document.getElementById("allReviewCount");

    if (pendingCount) pendingCount.textContent = pending;
    if (approvedCount) approvedCount.textContent = approved;
    if (allCount) allCount.textContent = developerProducts.length;
  }

  function wireProductReviewFilters() {
    const buttons = document.querySelectorAll("[data-review-status]");
    if (!buttons.length || document.body.dataset.reviewFiltersWired === "true") return;

    document.body.dataset.reviewFiltersWired = "true";

    buttons.forEach((button) => {
      button.addEventListener("click", async () => {
        const status = button.dataset.reviewStatus || "pending_review";
        const url = new URL(window.location.href);
        url.searchParams.set("status", status);
        window.history.replaceState({}, "", url);
        buttons.forEach((item) => item.classList.toggle("active", item.dataset.reviewStatus === status));
        await renderAdminAutomations();
      });
    });
  }

  async function renderAdminAutomations() {
    const { data, error } = await NexusDB.listAllAutomations();
    const body = document.getElementById("adminProductRows");
    const isReviewPage = document.body.dataset.adminPage === "product-reviews";
    const reviewFilter = currentProductReviewFilter();

    if (!body) return;

    if (error) {
      body.innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
      return;
    }

    updateProductReviewFilters(data || []);

    const filteredProducts = (data || []).filter((product) => {
      if (!isReviewPage) return true;
      return productMatchesReviewFilter(product, reviewFilter);
    });

    const emptyLabel = isReviewPage
      ? reviewFilter === "approved"
        ? "No approved developer products yet."
        : reviewFilter === "all"
          ? "No developer products yet."
          : "No pending developer products."
      : "No products yet.";

    body.innerHTML =
      filteredProducts
        .map((product) => {
          return `
            <tr>
              <td>
                <strong>${NexusUI.escapeHtml(product.title || "")}</strong>
                ${product.is_demo ? `<span class="pill orange" style="margin-left:.4rem">Demo</span>` : ""}
                <br>
                <span style="color:var(--muted);font-size:.85rem">${NexusUI.escapeHtml(product.slug || "")}</span>
              </td>

              <td>
                <span class="${product.status === "live" ? "pill green" : product.status === "paused" ? "pill orange" : "pill"}">
                  ${product.status}
                </span>
              </td>

              <td>${NexusUI.money(product)}</td>

              <td>${product.developers?.display_name || "No developer"}</td>

              <td>
  <a class="btn btn-primary btn-small" href="/pages/admin/product-form.html?id=${product.id}">Edit</a>

  ${
    product.status === "pending_review"
      ? `
        <button class="btn btn-primary btn-small" onclick="NexusApp.approveDeveloperProduct('${product.id}')">Approve</button>
        <button class="btn btn-secondary btn-small" onclick="NexusApp.rejectDeveloperProduct('${product.id}')">Reject</button>
      `
      : ""
  }

  ${
    product.status === "paused"
      ? `<span class="pill orange">Paused</span>`
      : `<button class="btn btn-secondary btn-small" onclick="NexusApp.pauseAutomation('${product.id}')">Pause</button>`
  }

  <button class="btn btn-danger btn-small" onclick="NexusApp.deleteAutomation('${product.id}')">
    Delete
  </button>
</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="5">${emptyLabel}</td></tr>`;
  }
async function pauseAutomation(id) {
  const confirmed = await NexusUI.confirmDialog({
    title: "Pause this product?",
    message: "New buyers will not be able to purchase it, but existing buyers will keep access.",
    confirmText: "Pause product"
  });

  if (!confirmed) return;

  if (typeof NexusDB.pauseAutomation !== "function") {
    NexusUI.toast("Pause function is missing in nexus-db.js.");
    return;
  }

  const { data, error } = await NexusDB.pauseAutomation(id);

  if (error) {
    NexusUI.toast(error.message || "Could not pause product.");
    console.error("Pause product error:", error);
    return;
  }

  NexusUI.toast(data?.message || "Product paused.");
  await renderAdminAutomations();
}

function normalizeSetupSchemaName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function extractRuntimeSetupKeysFromText(text) {
  const source = String(text || "");
  const patterns = [
    /NEXUS_SETUP\.([a-zA-Z0-9_.-]+)/g,
    /NEXUS_SETUP[_:-]([a-zA-Z0-9_.-]+)/gi,
    /\bsetup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /\bbody\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /\$json\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /\$json\.body\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /json\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /json\.body\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g
  ];
  const keys = new Set();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const key = normalizeSetupSchemaName(match[1]);
      if (key) keys.add(key);
    }
  }

  return [...keys].sort();
}

function inferMakeSetupKeysFromText(text) {
  const source = String(text || "").toLowerCase();
  const keys = new Set();
  const rules = [
    ["company_website", /\b(company|business|buyer|client|customer)(?:'s)?\s+(?:main\s+)?(?:website|site|url)\b|\bmain\s+website\b/],
    ["competitor_websites", /\bcompetitor(?:s)?\s+(?:websites?|sites?|urls?)\b|\bcompetitor\s+list\b/],
    ["focus_areas", /\bfocus\s+areas?\b|\bfocus\s+topics?\b|\bpricing,\s*offers,\s*messaging\b|\bpricing\s+offers\s+messaging\b/],
    ["market_or_region", /\bmarket\s*(?:or|\/)\s*region\b|\bmarket\s+region\b|\btarget\s+market\b|\blocal\s+market\b/],
    ["report_title", /\breport\s+title\b|\btitle\s+for\s+(?:the\s+)?report\b/]
  ];

  for (const [key, pattern] of rules) {
    if (pattern.test(source)) keys.add(key);
  }

  return [...keys].sort();
}

function missingSetupSchemaFieldsForProduct(product) {
  const workflowText = JSON.stringify(product?.n8n_workflow_json || product?.n8n_normalized_workflow_json || {});
  const mappingText = JSON.stringify(product?.workflow_placeholder_mappings || []);
  const blueprintText = JSON.stringify(product?.make_blueprint || {});
  const required = new Set(extractRuntimeSetupKeysFromText(`${workflowText}\n${mappingText}`));

  if (String(product?.workflow_source_platform || "").toLowerCase() === "make" || product?.make_blueprint) {
    inferMakeSetupKeysFromText(`${blueprintText}\n${workflowText}\n${mappingText}`).forEach((key) => required.add(key));
  }

  if (!required.size) return [];

  const setupSchema = Array.isArray(product?.setup_schema) ? product.setup_schema : [];
  const existing = new Set(setupSchema.map((field) => normalizeSetupSchemaName(field?.name)).filter(Boolean));

  return [...required].filter((key) => !existing.has(key));
}

async function approveDeveloperProduct(id) {
  const confirmed = await NexusUI.confirmDialog({
    title: "Approve product?",
    message: "This will publish the developer product live after the workflow checks pass.",
    confirmText: "Approve product"
  });
  if (!confirmed) return;

  let { data: product, error: productError } = await NexusDB.getAutomationById(id);

  if (productError || !product) {
    NexusUI.toast(productError?.message || "Product not found.");
    return;
  }

  if (product.listing_type !== "custom_request" && !product.n8n_workflow_json) {
    NexusUI.toast("This developer product needs an attached n8n workflow before approval.");
    return;
  }

  if (product.listing_type !== "custom_request" && product.n8n_workflow_json && product.n8n_import_status !== "imported") {
    NexusUI.toast("Importing workflow before approval...");
    const { error: importError } = await NexusDB.importN8nWorkflow(id);

    if (importError) {
      NexusUI.toast(importError.message || "Workflow import failed.");
      return;
    }

    const refreshed = await NexusDB.getAutomationById(id);
    product = refreshed.data || product;
  }

  if (
    product.listing_type !== "custom_request" &&
    !["passed", "passed_with_expected_test_callback_error"].includes(String(product.n8n_last_test_status || "").toLowerCase())
  ) {
    NexusUI.toast("Run a successful technical test before approving this developer product.");
    return;
  }

  const missingSetupFields = product.listing_type !== "custom_request"
    ? missingSetupSchemaFieldsForProduct(product)
    : [];
  if (missingSetupFields.length) {
    NexusUI.toast(`Add buyer setup schema before approval. Missing: ${missingSetupFields.join(", ")}.`);
    return;
  }

  const { error } = await NexusDB.updateAutomation(id, {
    status: "live",
    updated_at: new Date().toISOString()
  });

  if (error) {
    NexusUI.toast(error.message || "Could not approve product.");
    return;
  }

  NexusUI.toast("Product approved and live.");
  await renderAdminAutomations();
}

async function rejectDeveloperProduct(id) {
  const confirmed = await NexusUI.confirmDialog({
    title: "Reject product?",
    message: "This product will be removed from the review queue.",
    confirmText: "Reject product"
  });
  if (!confirmed) return;

  const { error } = await NexusDB.deleteAutomation(id);

  if (error) {
    NexusUI.toast(error.message || "Could not reject product.");
    return;
  }

  NexusUI.toast("Product rejected and removed.");
  await renderAdminAutomations();
}

 async function deleteAutomation(id) {
  const confirmed = await NexusUI.confirmDialog({
    title: "Delete product?",
    message: "If no buyers purchased it, Nexus will also delete the linked n8n workflow. If buyers exist, deletion will be blocked.",
    confirmText: "Delete product"
  });

  if (!confirmed) return;

  if (typeof NexusDB.safeDeleteAutomation !== "function") {
    NexusUI.toast("Safe delete function is missing in nexus-db.js.");
    return;
  }

  const { data, error } = await NexusDB.safeDeleteAutomation(id);

  if (error) {
    const details = error.details || {};

    if (details.recommended_action === "pause") {
      const pauseInstead = await NexusUI.confirmDialog({
        title: "Pause instead?",
        message: `${error.message} Do you want to pause this product instead? Existing buyers will keep access, but new buyers cannot purchase it.`,
        confirmText: "Pause product"
      });

      if (pauseInstead) {
        await pauseAutomation(id);
      }

      return;
    }

    NexusUI.toast(error.message || "Could not delete product.");
    console.error("Safe delete error:", error);
    return;
  }

  NexusUI.toast(data?.message || "Product deleted safely.");
  await renderAdminAutomations();
}

async function wireAutomationForm() {
  const form = document.getElementById("automationForm");
  const developerSelect = document.getElementById("developer_id");

  if (!form || !developerSelect) return;

  const { data: developers, error: developersError } = await NexusDB.listDevelopers();

  if (developersError) {
    NexusUI.toast(developersError.message);
    return;
  }

  developerSelect.innerHTML = (developers || [])
    .map((developer) => `<option value="${developer.id}">${developer.display_name}</option>`)
    .join("");

  const id = NexusUI.q("id");
  let existingProduct = null;

  if (id) {
    const { data: product, error: productError } = await NexusDB.getAutomationById(id);

    if (productError) {
      NexusUI.toast(productError.message);
      return;
    }

    if (product) {
      existingProduct = product;

      Object.entries(product).forEach(([key, value]) => {
        const element = form.querySelector(`[name="${key}"]`);
        if (!element) return;

        if (typeof value === "boolean") {
          element.checked = value;
          return;
        }

        if (
          key === "setup_schema" ||
key === "credential_schema" ||
key === "workflow_placeholder_mappings" ||
key === "detected_placeholders" ||
          key === "placeholder_validation_errors" ||
          key === "output_schema" ||
          key === "output_mapping" ||
          key === "n8n_workflow_json" ||
          key === "n8n_normalized_workflow_json" ||
          key === "n8n_last_import_result" ||
          key === "customizations"
        ) {
          element.value = value ? JSON.stringify(value, null, 2) : "";
          return;
        }

        if (Array.isArray(value)) {
          element.value = value.join("\n");
          return;
        }

        if (typeof value === "object" && value) {
          element.value = JSON.stringify(value, null, 2);
          return;
        }

        element.value = value ?? "";
      });

      fillCustomizations(product.customizations || []);
    }
  }

  const title = form.querySelector(`[name="title"]`);
  const slug = form.querySelector(`[name="slug"]`);

  if (title && slug) {
    title.addEventListener("blur", () => {
      if (!slug.value) slug.value = NexusUI.slugify(title.value);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector("button[type='submit'], button");
    const originalButtonText = submitButton ? submitButton.textContent : "";

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving product...";
    }

    const formData = new FormData(form);

    const lines = (name) => {
      return String(formData.get(name) || "")
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
    };

    const parseJsonField = (name, fallback) => {
      const raw = String(formData.get(name) || "").trim();

      if (!raw) return fallback;

      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`${name} must be valid JSON. ${error.message}`);
      }
    };

    let setupSchema;
let credentialSchema;
let workflowPlaceholderMappings;
let n8nWorkflowJson;
let detectedPlaceholders;
let placeholderValidationErrors;

    try {
      setupSchema = parseJsonField("setup_schema", []);
credentialSchema = parseJsonField("credential_schema", []);
workflowPlaceholderMappings = parseJsonField("workflow_placeholder_mappings", []);
n8nWorkflowJson = parseJsonField("n8n_workflow_json", null);
detectedPlaceholders = parseJsonField("detected_placeholders", {});
placeholderValidationErrors = parseJsonField("placeholder_validation_errors", []);
    } catch (jsonError) {
      NexusUI.toast(jsonError.message);

      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
      }

      return;
    }

    const payload = {
      id: id || undefined,
      developer_id: formData.get("developer_id"),

      title: String(formData.get("title") || ""),
      slug: String(formData.get("slug") || NexusUI.slugify(formData.get("title"))),
      category: String(formData.get("category") || ""),
      badge: String(formData.get("badge") || ""),
      icon: String(formData.get("icon") || "AI").slice(0, 3).toUpperCase(),
      color: String(formData.get("color") || "blue"),
      status: String(formData.get("status") || "draft"),
      featured: formData.get("featured") === "on",

      pricing_type: String(formData.get("pricing_type") || "custom_quote"),
        currency: String(formData.get("currency") || "THB"),
        guided_install_enabled:
          String(formData.get("listing_type") || "standard") === "standard" &&
          formData.get("guided_install_enabled") === "on",

      price: Number(formData.get("price") || 0),
      price_usd: Number(formData.get("price_usd") || 0),
      price_thb: Number(formData.get("price_thb") || 0),
      setup_fee: Number(formData.get("setup_fee") || 0),
      setup_fee_usd: Number(formData.get("setup_fee_usd") || 0),
      setup_fee_thb: Number(formData.get("setup_fee_thb") || 0),

      delivery_time: String(formData.get("delivery_time") || ""),
      setup_type: String(formData.get("setup_type") || ""),
      best_for: String(formData.get("best_for") || ""),

      rating: Number(formData.get("rating") || 0),
      review_count: Number(formData.get("review_count") || 0),
      sales_count: Number(formData.get("sales_count") || 0),

      preview_type: String(formData.get("preview_type") || "custom"),
      preview_mode: String(formData.get("preview_mode") || "template"),
      preview_title: String(formData.get("preview_title") || ""),
      preview_description: String(formData.get("preview_description") || ""),
      preview_code: String(formData.get("preview_code") || ""),
      preview_image_url: String(formData.get("preview_image_url") || ""),
      preview_base64: String(formData.get("preview_base64") || ""),

      short_description: String(formData.get("short_description") || ""),
      long_description: String(formData.get("long_description") || ""),
      problem: String(formData.get("problem") || ""),
      outcome: String(formData.get("outcome") || ""),

      who_it_is_for: lines("who_it_is_for"),
      outputs: lines("outputs"),
      required_inputs: lines("required_inputs"),
      required_tools: lines("required_tools"),
      setup_steps: lines("setup_steps"),
      trust_points: lines("trust_points"),

      customizations: collectCustomizations(formData),

      runtime_type: String(formData.get("runtime_type") || existingProduct?.runtime_type || "manual"),

      runtime_webhook_url: existingProduct?.runtime_webhook_url || "",
      runtime_webhook_path: existingProduct?.runtime_webhook_path || "",
      runtime_output_mode: existingProduct?.runtime_output_mode || "standard",

      setup_schema: setupSchema,
      credential_schema: credentialSchema,
      workflow_placeholder_mappings: workflowPlaceholderMappings,

      detected_placeholders: detectedPlaceholders,
      placeholder_validation_status: String(
        formData.get("placeholder_validation_status") ||
        existingProduct?.placeholder_validation_status ||
        "not_checked"
      ),
      placeholder_validation_errors: placeholderValidationErrors,

      output_schema: existingProduct?.output_schema || {},
      output_mapping: existingProduct?.output_mapping || {},

      n8n_workflow_json: n8nWorkflowJson,
      n8n_workflow_id: existingProduct?.n8n_workflow_id || "",
      n8n_workflow_name: existingProduct?.n8n_workflow_name || "",
      n8n_normalized_workflow_json: existingProduct?.n8n_normalized_workflow_json || null,
      n8n_import_status: existingProduct?.n8n_import_status || "not_imported",
      n8n_import_error: existingProduct?.n8n_import_error || null,
      n8n_last_synced_at: existingProduct?.n8n_last_synced_at || null,
      n8n_imported_at: existingProduct?.n8n_imported_at || null,
      n8n_webhook_url: existingProduct?.n8n_webhook_url || "",
      n8n_last_import_result: existingProduct?.n8n_last_import_result || {},

      admin_run_instructions: String(formData.get("admin_run_instructions") || ""),
      internal_notes: String(formData.get("internal_notes") || ""),
      updated_at: new Date().toISOString()
    };

    const { data: savedProduct, error } = await NexusDB.upsertAutomation(payload);

    if (error) {
      NexusUI.toast(error.message);

      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
      }

      return;
    }

    const shouldSyncStripe =
      savedProduct &&
      ["one_time", "setup_fee", "monthly"].includes(savedProduct.pricing_type);

    if (shouldSyncStripe && typeof NexusDB.syncStripeProduct === "function") {
      if (submitButton) {
        submitButton.textContent = "Syncing Stripe...";
      }

      const { error: stripeError } = await NexusDB.syncStripeProduct(savedProduct.id);

      if (stripeError) {
        NexusUI.toast(`Product saved, but Stripe sync failed: ${stripeError.message}`);

        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalButtonText;
        }

        return;
      }
    }

 /*
  n8n sync should NOT run on normal product edits like price/title/description.

  Rules:
  - New product + workflow JSON + automatic mode = import once.
  - Existing product + workflow JSON changed = update n8n.
  - Existing product + price/description/etc changed only = do NOT touch n8n.
*/

const stableStringify = (value) => {
  try {
    return JSON.stringify(value || null);
  } catch {
    return "";
  }
};

const productIsNew = !id;

const existingWorkflowJsonText = stableStringify(existingProduct?.n8n_workflow_json);
const currentWorkflowJsonText = stableStringify(n8nWorkflowJson);

const workflowJsonChanged =
  existingProduct &&
  existingWorkflowJsonText !== currentWorkflowJsonText;

const shouldImportN8n =
  savedProduct &&
  savedProduct.runtime_type === "n8n_managed" &&
  savedProduct.n8n_workflow_json &&
  typeof NexusDB.importN8nWorkflow === "function" &&
  (
    productIsNew ||
    workflowJsonChanged
  );

if (shouldImportN8n) {
  if (submitButton) {
    submitButton.textContent = productIsNew
      ? "Importing n8n workflow..."
      : "Updating n8n workflow...";
  }

  const { error: n8nError } = await NexusDB.importN8nWorkflow(savedProduct.id);

  if (n8nError) {
    NexusUI.toast(`Product saved, but n8n sync failed: ${n8nError.message}`);

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText;
    }

    return;
  }
}
    NexusUI.toast(
      shouldImportN8n
        ? "Product saved and n8n workflow synced."
        : "Product saved."
    );

    setTimeout(() => {
      window.location.href = "/pages/admin/automations.html";
    }, 900);
  });
}

  function collectCustomizations(formData) {
    const customizations = [];

    for (let i = 1; i <= 3; i++) {
      const name = String(formData.get(`custom_${i}_name`) || "").trim();

      if (!name) continue;

      customizations.push({
        name,
        description: String(formData.get(`custom_${i}_description`) || ""),
        price_note: String(formData.get(`custom_${i}_price_note`) || ""),
        preview_mode: String(formData.get(`custom_${i}_preview_mode`) || "template"),
        preview_code: String(formData.get(`custom_${i}_preview_code`) || ""),
        preview_image_url: String(formData.get(`custom_${i}_preview_image_url`) || ""),
        preview_base64: String(formData.get(`custom_${i}_preview_base64`) || ""),
      });
    }

    return customizations;
  }

  function fillCustomizations(customizations) {
    for (let i = 1; i <= 3; i++) {
      const customization = customizations[i - 1] || {};

      ["name", "description", "price_note", "preview_mode", "preview_code", "preview_image_url", "preview_base64"].forEach((key) => {
        const element = document.querySelector(`[name="custom_${i}_${key}"]`);
        if (element) element.value = customization[key] || "";
      });
    }
  }

  async function wireDeveloperProfileForm() {
    const form = document.getElementById("developerForm");
    if (!form) return;

    const { data: developers } = await NexusDB.listDevelopers();
    const developer = developers?.[0];

    if (!developer) {
      form.innerHTML = `<div class="error">No developer profile found. Run the install SQL first.</div>`;
      return;
    }

    Object.entries(developer).forEach(([key, value]) => {
      const element = form.querySelector(`[name="${key}"]`);

      if (!element) return;

      if (Array.isArray(value)) {
        element.value = value.join("\n");
      } else {
        element.value = value ?? "";
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const formData = new FormData(form);

      const payload = {
        display_name: String(formData.get("display_name") || ""),
        handle: String(formData.get("handle") || ""),
        type: String(formData.get("type") || ""),
        avatar_letter: String(formData.get("avatar_letter") || "N").slice(0, 2).toUpperCase(),
        short_description: String(formData.get("short_description") || ""),
        bio: String(formData.get("bio") || ""),
        website: String(formData.get("website") || ""),
        banner_url: String(formData.get("banner_url") || ""),
        banner_base64: String(formData.get("banner_base64") || ""),
        banner_color: String(formData.get("banner_color") || ""),
        skills: String(formData.get("skills") || "")
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        verified: formData.get("verified") === "on" || formData.get("verified") === "true",
        rating: Number(formData.get("rating") || 0),
        review_count: Number(formData.get("review_count") || 0),
      };

      const { error } = await NexusDB.updateDeveloper(developer.id, payload);

      if (error) {
        NexusUI.toast(error.message);
        return;
      }

      NexusUI.toast("Developer profile saved.");
    });
  }

  async function wireReviewsPage() {
    await populateReviewTargets();
    await drawReviews();

    const typeSelect = document.getElementById("review_type");
    const form = document.getElementById("reviewForm");

    function updateReviewTargetVisibility() {
      const type = typeSelect?.value || "product";

      const productField = document.getElementById("productReviewField");
      const developerField = document.getElementById("developerReviewField");

      if (productField) productField.style.display = type === "product" ? "block" : "none";
      if (developerField) developerField.style.display = type === "developer" ? "block" : "none";
    }

    if (typeSelect) {
      typeSelect.addEventListener("change", updateReviewTargetVisibility);
      updateReviewTargetVisibility();
    }

    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const formData = new FormData(form);
      const reviewType = String(formData.get("review_type") || "product");

      const automationId = String(formData.get("automation_id") || "");
      const developerId = String(formData.get("developer_id") || "");

      if (reviewType === "product" && !automationId) {
        NexusUI.toast("Choose a product for a product review.");
        return;
      }

      if (reviewType === "developer" && !developerId) {
        NexusUI.toast("Choose a developer for a developer review.");
        return;
      }

      const payload = {
        review_type: reviewType,
        automation_id: reviewType === "product" ? automationId : null,
        developer_id: reviewType === "developer" ? developerId : null,
        reviewer_name: String(formData.get("reviewer_name") || ""),
        reviewer_company: String(formData.get("reviewer_company") || ""),
        reviewer_role: String(formData.get("reviewer_role") || ""),
        rating: Number(formData.get("rating") || 5),
        review_text: String(formData.get("review_text") || ""),
        status: String(formData.get("status") || "approved")
      };

      const { error } = await NexusDB.createReview(payload);

      if (error) {
        NexusUI.toast(error.message);
        return;
      }

      NexusUI.toast("Review added.");
      form.reset();

      if (typeSelect) typeSelect.value = "product";

      await populateReviewTargets();
      await drawReviews();

      const productField = document.getElementById("productReviewField");
      const developerField = document.getElementById("developerReviewField");

      if (productField) productField.style.display = "block";
      if (developerField) developerField.style.display = "none";
    });
  }

  async function populateReviewTargets() {
    const productSelect = document.getElementById("automation_id");
    const developerSelect = document.getElementById("developer_id");

    const [{ data: products }, { data: developers }] = await Promise.all([
      NexusDB.listAllAutomations(),
      NexusDB.listDevelopers()
    ]);

    if (productSelect) {
      productSelect.innerHTML =
        `<option value="">Choose product</option>` +
        (products || [])
          .map((product) => {
            return `<option value="${product.id}">${product.title}</option>`;
          })
          .join("");
    }

    if (developerSelect) {
      developerSelect.innerHTML =
        `<option value="">Choose developer</option>` +
        (developers || [])
          .map((developer) => {
            return `<option value="${developer.id}">${developer.display_name}</option>`;
          })
          .join("");
    }
  }

  async function drawReviews() {
    const body = document.getElementById("reviewRows");

    if (!body) return;

    const { data, error } = NexusDB.listAllReviewsDetailed
      ? await NexusDB.listAllReviewsDetailed()
      : await NexusDB.listReviews();

    if (error) {
      body.innerHTML = `<tr><td colspan="7">${error.message}</td></tr>`;
      return;
    }

    body.innerHTML =
      (data || [])
        .map((review) => {
          const type = review.review_type || "product";
          const target =
            type === "developer"
              ? review.developers?.display_name || "Developer"
              : review.automations?.title || "Product";
          const reviewerMeta = [
            review.reviewer_role,
            review.reviewer_company,
            review.verified_purchase ? "Verified purchase" : ""
          ].filter(Boolean).join(" | ");
          const status = review.status || "pending";

          return `
            <tr>
              <td>
                <strong>${NexusUI.escapeHtml(review.reviewer_name || "Anonymous")}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">
                  ${NexusUI.escapeHtml(reviewerMeta || "No company/role")}
                </span>
              </td>

              <td>
                <span class="${type === "developer" ? "pill purple" : "pill blue"}">
                  ${NexusUI.escapeHtml(type)}
                </span>
              </td>

              <td>${NexusUI.escapeHtml(target)}</td>

              <td>
                <strong>${NexusUI.escapeHtml(review.rating || "")}/5</strong><br>
                <span style="color:#f59e0b">${NexusUI.ratingStars(review.rating)}</span>
              </td>

              <td>${NexusUI.escapeHtml(review.review_text || "")}</td>

              <td>
                <span class="${
                  status === "approved"
                    ? "pill green"
                    : status === "pending"
                      ? "pill orange"
                      : "pill"
                }">
                  ${NexusUI.escapeHtml(status)}
                </span>
              </td>

              <td>
                ${
                  status !== "approved"
                    ? `
                      <button class="btn btn-primary btn-small" onclick="NexusApp.updateReviewStatus('${review.id}', 'approved')">
                        Approve
                      </button>
                    `
                    : ""
                }

                ${
                  status !== "hidden"
                    ? `
                      <button class="btn btn-secondary btn-small" onclick="NexusApp.updateReviewStatus('${review.id}', 'hidden')">
                        Hide
                      </button>
                    `
                    : ""
                }

                <button class="btn btn-danger btn-small" onclick="NexusApp.deleteReview('${review.id}')">
                  Delete
                </button>
              </td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="7">No reviews yet.</td></tr>`;
    return;

    body.innerHTML =
      (data || [])
        .map((review) => {
          const type = review.review_type || "product";

          const target =
            type === "developer"
              ? review.developers?.display_name || "Developer"
              : review.automations?.title || "Product";

          const reviewerMeta = [
            review.reviewer_role,
            review.reviewer_company
          ].filter(Boolean).join(" · ");

          return `
            <tr>
              <td>
                <strong>${review.reviewer_name}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">
                  ${reviewerMeta || "No company/role"}
                </span>
              </td>

              <td>
                <span class="${type === "developer" ? "pill purple" : "pill blue"}">
                  ${type}
                </span>
              </td>

              <td>${target}</td>

              <td>
                <strong>${review.rating}/5</strong><br>
                <span style="color:#f59e0b">${NexusUI.ratingStars(review.rating)}</span>
              </td>

              <td>${review.review_text || ""}</td>

              <td>
                <span class="${
                  review.status === "approved"
                    ? "pill green"
                    : review.status === "pending"
                      ? "pill orange"
                      : "pill"
                }">
                  ${review.status}
                </span>
              </td>

              <td>
                <button class="btn btn-danger btn-small" onclick="NexusApp.deleteReview('${review.id}')">
                  Delete
                </button>
              </td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="7">No reviews yet.</td></tr>`;
  }

  async function updateReviewStatus(id, status) {
    const { error } = await NexusDB.updateReviewStatus({
      review_id: id,
      status
    });

    if (error) {
      NexusUI.toast(error.message || "Could not update review.");
      return;
    }

    NexusUI.toast(`Review ${status}.`);
    await drawReviews();
  }

  async function deleteReview(id) {
    const confirmed = await NexusUI.confirmDialog({
      title: "Delete review?",
      message: "This permanently removes the review from Nexus.",
      confirmText: "Delete review"
    });
    if (!confirmed) return;

    const { error } = await NexusDB.deleteReview(id);

    if (error) {
      NexusUI.toast(error.message);
      return;
    }

    NexusUI.toast("Review deleted.");
    await drawReviews();
  }

  function wireWaitlist() {
    const form = document.getElementById("waitlistForm");

    if (!form) return;

    form.querySelectorAll(".dropdown-multiselect").forEach((dropdown) => {
      const label = dropdown.querySelector("[data-multiselect-label]");
      const inputs = Array.from(dropdown.querySelectorAll("input[type='checkbox']"));
      const updateLabel = () => {
        const selected = inputs
          .filter((input) => input.checked)
          .map((input) => input.closest("label")?.querySelector("span")?.textContent?.trim() || input.value)
          .filter(Boolean);

        if (!label) return;
        if (!selected.length) {
          label.textContent = label.dataset.empty || "Select options";
          return;
        }

        label.textContent = selected.length <= 2
          ? selected.join(", ")
          : `${selected.slice(0, 2).join(", ")} +${selected.length - 2}`;
      };

      inputs.forEach((input) => input.addEventListener("change", updateLabel));
      updateLabel();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const submitButton = form.querySelector("button[type='submit'], button:not([type])");
      const originalButtonText = submitButton?.textContent || "Join waitlist";
      const formData = new FormData(event.target);
      const name = String(formData.get("name") || "").trim();
      const email = String(formData.get("email") || "").trim();

      if (!name || !email) {
        NexusUI.toast("Please enter your name and email.");
        return;
      }

      const selectedCategories = formData
        .getAll("automation_categories")
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      const selectedStack = formData
        .getAll("build_stack")
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      const otherPlatforms = String(formData.get("platforms_other") || "").trim();
      const categorySummary = selectedCategories.join(", ");
      const stackSummary = [...selectedStack, otherPlatforms].filter(Boolean).join(", ");
      const legacyAutomationType = [
        categorySummary ? `Types: ${categorySummary}` : "",
        stackSummary ? `Stack: ${stackSummary}` : "",
      ].filter(Boolean).join("\n");

      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Joining...";
      }

      const { error } = await NexusDB.createWaitlist({
        name,
        email,
        company: "",
        website: "",
        automation_type: "",
        automation_categories: selectedCategories,
        build_stack: selectedStack,
        build_stack_other: otherPlatforms,
        __fallback_automation_type: legacyAutomationType,
        experience: String(formData.get("experience") || ""),
        status: "new",
      });

      if (error) {
        NexusUI.toast(error.message || "Could not join the waitlist. Please try again.");
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalButtonText;
        }
        return;
      }

      form.innerHTML = `
        <div class="success">
          <strong>You're on the waitlist.</strong><br>
          Nexus will review developer access when submissions open.
        </div>
      `;
    });
  }

  function wireContact() {
    const form = document.getElementById("contactForm");

    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const formData = new FormData(event.target);

      const { error } = await NexusDB.createContact({
        name: String(formData.get("name") || ""),
        email: String(formData.get("email") || ""),
        company: String(formData.get("company") || ""),
        inquiry_type: String(formData.get("inquiry_type") || ""),
        message: String(formData.get("message") || ""),
        status: "new",
      });

      if (error) {
        NexusUI.toast(error.message);
        return;
      }

      form.innerHTML = `
        <div class="success">
          <strong>Message sent.</strong><br>
          Nexus received your inquiry.
        </div>
      `;
    });
  }

  async function renderWaitlist() {
    await Promise.all([
      renderDeveloperWaitlistRows(),
      renderDeveloperAccounts()
    ]);
  }

  async function renderDeveloperWaitlistRows() {
    const { data, error } = await NexusDB.listWaitlist();
    const body = document.getElementById("waitlistRows");

    if (!body) return;

    if (error) {
      body.innerHTML = `<tr><td colspan="6">${NexusUI.escapeHtml(error.message)}</td></tr>`;
      return;
    }

    body.innerHTML =
      (data || [])
        .map((waitlist) => {
          const formatList = (value) => Array.isArray(value)
            ? value.filter(Boolean).join(", ")
            : String(value || "");
          const categories = formatList(waitlist.automation_categories);
          const stack = [formatList(waitlist.build_stack), waitlist.build_stack_other]
            .filter(Boolean)
            .join(", ");
          const sourceLabel = waitlist.source === "contact_messages"
            ? `<br><span style="color:var(--muted);font-size:.75rem">Fallback capture</span>`
            : "";
          const legacyFocus = !categories && !stack
            ? NexusUI.escapeHtml(waitlist.automation_type || "").replace(/\n/g, "<br>")
            : "";
          const experience = NexusUI.escapeHtml(waitlist.experience || "").replace(/\n/g, "<br>");
          return `
            <tr>
              <td>
                <strong>${NexusUI.escapeHtml(waitlist.name || "")}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">${NexusUI.escapeHtml(waitlist.email || "")}</span>${sourceLabel}
              </td>

              <td>${NexusUI.escapeHtml(categories) || legacyFocus}</td>
              <td>${NexusUI.escapeHtml(stack)}</td>
              <td>${experience}</td>
              <td>${NexusUI.escapeHtml(waitlist.status || "")}</td>
              <td>${new Date(waitlist.created_at).toLocaleString()}</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="6">No waitlist signups yet.</td></tr>`;
  }

  function developerApprovalLabel(status) {
    const value = String(status || "").toLowerCase();
    if (value === "active") return "Approved";
    if (value === "pending") return "Pending approval";
    if (value === "hidden") return "Hidden";
    return value ? value.replace(/_/g, " ") : "Unknown";
  }

  function developerApprovalClass(status) {
    const value = String(status || "").toLowerCase();
    if (value === "active") return "pill green";
    if (value === "hidden") return "pill red";
    return "pill orange";
  }

  async function renderDeveloperAccounts() {
    const body = document.getElementById("developerAccountRows");
    if (!body) return;

    if (!NexusDB.listAllDevelopers) {
      body.innerHTML = `<tr><td colspan="5">Developer approval tools are not available.</td></tr>`;
      return;
    }

    const { data, error } = await NexusDB.listAllDevelopers();

    if (error) {
      body.innerHTML = `<tr><td colspan="5">${NexusUI.escapeHtml(error.message)}</td></tr>`;
      return;
    }

    const developers = (data || []).slice().sort((a, b) => {
      const priority = { pending: 0, active: 1, hidden: 2 };
      const aStatus = priority[String(a.status || "").toLowerCase()] ?? 3;
      const bStatus = priority[String(b.status || "").toLowerCase()] ?? 3;
      if (aStatus !== bStatus) return aStatus - bStatus;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    body.innerHTML = developers.map((developer) => {
      const status = String(developer.status || "pending").toLowerCase();
      const canApprove = status !== "active";
      const canHide = status !== "hidden";
      const skills = Array.isArray(developer.skills) ? developer.skills : String(developer.skills || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);

      return `
        <tr>
          <td>
            <strong>${NexusUI.escapeHtml(developer.display_name || "Unnamed developer")}</strong><br>
            <span style="color:var(--muted);font-size:.85rem">${NexusUI.escapeHtml(developer.handle ? `@${developer.handle}` : developer.website || "")}</span>
          </td>
          <td>
            <strong>${NexusUI.escapeHtml(developer.type || "Automation builder")}</strong><br>
            <span style="color:var(--muted);font-size:.85rem">${NexusUI.escapeHtml(developer.short_description || skills.slice(0, 4).join(", ") || "No positioning added yet.")}</span>
          </td>
          <td><span class="${developerApprovalClass(status)}">${NexusUI.escapeHtml(developerApprovalLabel(status))}</span></td>
          <td>${developer.created_at ? new Date(developer.created_at).toLocaleString() : ""}</td>
          <td>
            <div class="button-row">
              ${
                canApprove
                  ? `<button class="btn btn-primary btn-small" type="button" onclick="NexusApp.updateDeveloperApproval('${NexusUI.escapeAttribute(developer.id)}','active')">Approve</button>`
                  : `<a class="btn btn-secondary btn-small" href="/pages/developers/profile.html?id=${encodeURIComponent(developer.id)}" target="_blank">View profile</a>`
              }
              ${
                canHide
                  ? `<button class="btn btn-secondary btn-small" type="button" onclick="NexusApp.updateDeveloperApproval('${NexusUI.escapeAttribute(developer.id)}','hidden')">Hide</button>`
                  : ""
              }
            </div>
          </td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="5">No developer accounts yet.</td></tr>`;
  }

  async function updateDeveloperApproval(id, status) {
    if (!id || !status || !NexusDB.updateDeveloperStatus) return;

    const labels = {
      active: "approve this developer account",
      hidden: "hide this developer account"
    };

    const confirmed = await NexusUI.confirmDialog({
      title: "Update developer account?",
      message: `Are you sure you want to ${labels[status] || "update this developer account"}?`,
      confirmText: status === "active" ? "Approve developer" : "Update developer"
    });
    if (!confirmed) return;

    const { error } = await NexusDB.updateDeveloperStatus(id, status);

    if (error) {
      NexusUI.toast(error.message || "Could not update developer account.");
      return;
    }

    NexusUI.toast(status === "active" ? "Developer approved." : "Developer hidden.");
    await renderDeveloperAccounts();
  }

  async function renderMessages() {
    const { data, error } = await NexusDB.listContacts();
    const body = document.getElementById("messageRows");

    if (!body) return;

    if (error) {
      body.innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
      return;
    }

    body.innerHTML =
      (data || [])
        .map((message) => {
          return `
            <tr>
              <td>
                <strong>${message.name}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">${message.email}</span>
              </td>

              <td>${message.company || ""}</td>
              <td>${message.inquiry_type || ""}</td>
              <td>${message.message || ""}</td>
              <td>${new Date(message.created_at).toLocaleString()}</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="5">No messages yet.</td></tr>`;
  }

  async function renderCheckoutIntents() {
    const { data, error } = await NexusDB.listCheckoutIntents();
    const body = document.getElementById("checkoutRows");

    if (!body) return;

    if (error) {
      body.innerHTML = `<tr><td colspan="7">${error.message}</td></tr>`;
      return;
    }

    body.innerHTML =
      (data || [])
        .map((checkout) => {
          return `
            <tr>
              <td>
                <strong>${checkout.name}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">${checkout.email}</span>
              </td>

              <td>${checkout.automation_title}</td>
              <td>${checkout.install_type}</td>
              <td>${checkout.selected_customization || ""}</td>
              <td>${checkout.currency}</td>
              <td>${checkout.price_display || ""}</td>
              <td>${new Date(checkout.created_at).toLocaleString()}</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="7">No checkout intents yet.</td></tr>`;
  }

  async function renderAdminNotifications() {
    const body = document.getElementById("notificationRows");
    if (!body || !NexusDB.listAdminNotifications) return;

    const { data, error } = await NexusDB.listAdminNotifications();

    if (error) {
      body.innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
      return;
    }

    body.innerHTML =
      (data || [])
        .map((item) => {
          return `
            <tr>
              <td>
                <strong>${item.title || "Notification"}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">${item.notification_type || ""}</span>
              </td>
              <td>${item.message || ""}</td>
              <td>${item.orders?.buyer_name || item.orders?.buyer_email || ""}</td>
              <td><span class="${item.status === "unread" ? "pill orange" : "pill green"}">${item.status}</span></td>
              <td>${new Date(item.created_at).toLocaleString()}</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="5">No notifications yet.</td></tr>`;
  }

  function forceBuyLinksToCheckoutPage() {
    document.querySelectorAll(".product-card").forEach((card) => {
      const buttons = card.querySelectorAll("button, a");

      buttons.forEach((button) => {
        const text = (button.textContent || "").trim().toLowerCase();

        if (text === "buy" || text.includes("buy") || text.includes("choose setup")) {
          const onclick = button.getAttribute("onclick") || "";
          const slugMatch = onclick.match(/openSetupChoice\(['"](.+?)['"]\)/);
          const href = button.getAttribute("href") || "";
          const hrefMatch = href.match(/slug=([^&]+)/);

          let slug = "";

          if (slugMatch && slugMatch[1]) {
            slug = slugMatch[1];
          } else if (hrefMatch && hrefMatch[1]) {
            slug = decodeURIComponent(hrefMatch[1]);
          } else {
            const previewButton = card.querySelector("[onclick*='openProduct']");
            const previewOnclick = previewButton?.getAttribute("onclick") || "";
            const previewSlugMatch = previewOnclick.match(/openProduct\(['"](.+?)['"]\)/);

            if (previewSlugMatch && previewSlugMatch[1]) {
              slug = previewSlugMatch[1];
            }
          }

          if (!slug) return;

          const link = document.createElement("a");
          link.className = button.className || "btn btn-primary btn-small";
          link.href = `/pages/checkout/index.html?slug=${encodeURIComponent(slug)}&step=setup`;
          link.textContent = "Buy";

          button.replaceWith(link);
        }
      });
    });
  }

 return {
  init,
  openProduct,
  toggleCompare,
  clearCompare,
  openCompare,
  closeCompare,
  openSetupChoice,
  startProductMessage,
  startDeveloperMessage,
  openDeveloperReviewModal,
  closeDeveloperReviewModal,
  chooseInstall,
  selectCustomization,
  deleteAutomation,
  pauseAutomation,
  approveDeveloperProduct,
  rejectDeveloperProduct,
  enableDemoMarketplace,
  disableDemoMarketplace,
  resetDemoMarketplace,
  updateReviewStatus,
  updatePayoutRequest,
  updateDeveloperApproval,
  deleteReview,
  
};
})();

document.addEventListener("DOMContentLoaded", NexusApp.init);
