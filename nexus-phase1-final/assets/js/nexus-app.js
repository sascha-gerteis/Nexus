const NexusApp = (() => {
  let liveAutomations = [];
  let activeProduct = null;
  let selectedCustomizationName = "";

  async function init() {
    NexusUI.wireModal();

    if (typeof NexusUI.mountGlobalNav === "function") {
  await NexusUI.mountGlobalNav();
}

    document.addEventListener("currencychange", () => {
      if (document.body.dataset.page === "home") renderHome();
      if (document.body.dataset.page === "marketplace") drawMarketplace();
      if (document.body.dataset.page === "checkout") renderCheckout();
    });

    document.addEventListener("languagechange", async () => {
  if (typeof NexusUI.mountGlobalNav === "function") {
    await NexusUI.mountGlobalNav();
  }

  if (document.body.dataset.page === "home") renderHome();
  if (document.body.dataset.page === "marketplace") drawMarketplace();
  if (document.body.dataset.page === "checkout") renderCheckout();
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

    forceBuyLinksToCheckoutPage();
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
      element.addEventListener("input", drawMarketplace);
      element.addEventListener("change", drawMarketplace);
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
        return String(product.setup_type || "").toLowerCase().includes(setup);
      });
    }

    if (price !== "all") {
      items = items.filter((product) => product.pricing_type === price);
    }

    grid.innerHTML =
      items.map(NexusUI.productCard).join("") ||
      `<div class="card"><h3>No results</h3><p>Try changing the filters.</p></div>`;

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
            ${product.badge || product.category || "Automation"}
          </span>

          <h2>${product.title}</h2>

          <p>${product.long_description || product.short_description || ""}</p>
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
          <strong>${developer.display_name || "Nexus Internal"}</strong>
          <span>${developer.type || "Verified Operator"} · View profile</span>
        </div>
      </div>

      <div class="price-box">
        <span>Price</span>
        <strong>${NexusUI.money(product)}</strong>
      </div>

      ${NexusUI.infoBlock("Problem it solves", [product.problem])}
      ${NexusUI.infoBlock("Business outcome", [product.outcome])}
      ${NexusUI.infoBlock("Who this is for", product.who_it_is_for)}
      ${NexusUI.infoBlock("Outputs", product.outputs)}
      ${NexusUI.infoBlock("Required inputs", product.required_inputs)}
      ${NexusUI.renderCustomizations(product, "modal")}
    `;

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
          Buy opens the dedicated setup page where the buyer chooses Self-Serve or Nexus Guided Install.
        </p>

        <div class="hero-actions" style="justify-content:flex-start">
          <a
            class="btn btn-primary"
            href="/pages/checkout/index.html?slug=${encodeURIComponent(product.slug)}&step=setup"
          >
            Buy / choose setup
          </a>

          <a class="btn btn-secondary" href="/pages/contact/index.html">
            Ask Nexus
          </a>
        </div>
      </div>
    `;

    NexusUI.openModal(side, main);
  }

  async function openSetupChoice(slug) {
    window.location.href = `/pages/checkout/index.html?slug=${encodeURIComponent(slug)}&step=setup`;
  }

  function chooseInstall(type) {
    const input = document.getElementById("chosenInstallType");
    if (input) input.value = type;

    document.querySelectorAll("[data-install-choice]").forEach((element) => {
      element.classList.toggle("active", element.dataset.installChoice === type);
    });
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

  /*
    IMPORTANT:
    We no longer render the old details/request page.
    Checkout now goes:
    setup choice → Stripe → success → setup form.
  */
  renderSetupChoicePage(root, product);
}

function renderSetupChoicePage(root, product) {
  root.innerHTML = `
    <div class="checkout-setup-page">
      <div class="section-head">
        <span class="eyebrow">Choose setup path</span>

        <h2>${product.title}</h2>

        <p>
          Choose how you want this automation set up. After selecting a setup path,
          you will continue directly to secure Stripe checkout. The setup form comes after payment.
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

              <div
                class="choice-card"
                data-install-choice="nexus_guided"
                onclick="NexusApp.chooseInstall('nexus_guided')"
              >
                <h3>Nexus Guided Install</h3>
                <p>
                  Best when Nexus should help collect access, configure the workflow, and prepare the automation.
                </p>

                <div class="tags">
                  <span class="tag">Managed setup</span>
                  <span class="tag">Best for complex cases</span>
                  <span class="tag">Nexus support</span>
                </div>
              </div>
            </div>

            <button type="submit" class="btn btn-primary btn-full" style="margin-top:1rem">
              Continue to secure payment
            </button>
          </form>
        </div>
      </div>
    </div>
  `;

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

    const installType = document.getElementById("chosenInstallType").value || "self_serve";
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

    console.log("Creating Stripe checkout from setup choice:", payload);

    const { data, error } = await NexusDB.createStripeCheckoutSession(payload);

    console.log("Stripe checkout response:", { data, error });

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

checkoutForm.onsubmit = async function(event) {
  console.log("CHECKOUT FORM SUBMIT CAPTURED");
  await submitCheckoutIntent(event);
};
}

async function submitCheckoutIntent(event) {
  event.preventDefault();

  console.log("STRIPE CHECKOUT SUBMIT FUNCTION RUNNING");

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

  console.log("Sending Stripe checkout payload:", payload);

  const { data, error } = await NexusDB.createStripeCheckoutSession(payload);

  console.log("Stripe checkout response:", { data, error });

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
                <span class="tag">★ ${developer.rating || "New"}</span>
              </div>

              <a class="btn btn-primary" href="/pages/developers/profile.html?id=${developer.id}">
                View profile
              </a>
            </div>
          </div>
        `;
      })
      .join("");
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

    const [{ data: products }, { data: developerReviews }] = await Promise.all([
      NexusDB.listDeveloperAutomations(id),
      NexusDB.listDeveloperReviews ? NexusDB.listDeveloperReviews(id) : Promise.resolve({ data: [] })
    ]);

    const reviewStats = NexusUI.reviewStats(developerReviews || []);

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
    `;

    forceBuyLinksToCheckoutPage();
  }

  function bannerStyle(developer) {
    if (developer.banner_base64) return `background-image:url('${developer.banner_base64}')`;
    if (developer.banner_url) return `background-image:url('${developer.banner_url}')`;
    return `background:${developer.banner_color || "linear-gradient(135deg,#2563ff,#00c2ff)"}`;
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
    if (document.body.dataset.adminPage === "automation-form") await wireAutomationForm();
    if (document.body.dataset.adminPage === "developer-profile") await wireDeveloperProfileForm();
    if (document.body.dataset.adminPage === "reviews") await wireReviewsPage();
    if (document.body.dataset.adminPage === "waitlist") await renderWaitlist();
    if (document.body.dataset.adminPage === "messages") await renderMessages();
    if (document.body.dataset.adminPage === "checkout-intents") await renderCheckoutIntents();
    if (document.body.dataset.adminPage === "notifications") await renderAdminNotifications();
  }

  async function renderAdminDashboard() {
    const [automations, developers, reviews, waitlist, messages, checkout] = await Promise.all([
      NexusDB.listAllAutomations(),
      NexusDB.listDevelopers(),
      NexusDB.listReviews(),
      NexusDB.listWaitlist(),
      NexusDB.listContacts(),
      NexusDB.listCheckoutIntents(),
    ]);

    document.getElementById("totalProducts").textContent = automations.data?.length || 0;
    document.getElementById("liveProducts").textContent =
      (automations.data || []).filter((product) => product.status === "live").length;
    document.getElementById("totalDevelopers").textContent = developers.data?.length || 0;
    document.getElementById("totalReviews").textContent = reviews.data?.length || 0;
    document.getElementById("totalWaitlist").textContent = waitlist.data?.length || 0;
    document.getElementById("totalMessages").textContent = messages.data?.length || 0;
    document.getElementById("totalCheckout").textContent = checkout.data?.length || 0;
  }

  async function renderAdminAutomations() {
    const { data, error } = await NexusDB.listAllAutomations();
    const body = document.getElementById("adminProductRows");

    if (!body) return;

    if (error) {
      body.innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
      return;
    }

    body.innerHTML =
      (data || [])
        .map((product) => {
          return `
            <tr>
              <td>
                <strong>${product.title}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">${product.slug}</span>
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
        .join("") || `<tr><td colspan="5">No products yet.</td></tr>`;
  }
async function pauseAutomation(id) {
  const confirmed = confirm(
    "Pause this product?\n\nNew buyers will not be able to purchase it, but existing buyers will keep access."
  );

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

 async function deleteAutomation(id) {
  const confirmed = confirm(
    "Delete this product?\n\nIf no buyers purchased it, Nexus will also delete the linked n8n workflow. If buyers exist, deletion will be blocked."
  );

  if (!confirmed) return;

  if (typeof NexusDB.safeDeleteAutomation !== "function") {
    NexusUI.toast("Safe delete function is missing in nexus-db.js.");
    return;
  }

  const { data, error } = await NexusDB.safeDeleteAutomation(id);

  if (error) {
    const details = error.details || {};

    if (details.recommended_action === "pause") {
      const pauseInstead = confirm(
        `${error.message}\n\nDo you want to pause this product instead? Existing buyers will keep access, but new buyers cannot purchase it.`
      );

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
      currency: String(formData.get("currency") || "USD"),

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

  async function deleteReview(id) {
    if (!confirm("Delete review?")) return;

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

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const formData = new FormData(event.target);

      const { error } = await NexusDB.createWaitlist({
        name: String(formData.get("name") || ""),
        email: String(formData.get("email") || ""),
        company: String(formData.get("company") || ""),
        website: String(formData.get("website") || ""),
        automation_type: String(formData.get("automation_type") || ""),
        experience: String(formData.get("experience") || ""),
        message: String(formData.get("message") || ""),
        status: "new",
      });

      if (error) {
        NexusUI.toast(error.message);
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
    const { data, error } = await NexusDB.listWaitlist();
    const body = document.getElementById("waitlistRows");

    if (!body) return;

    if (error) {
      body.innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
      return;
    }

    body.innerHTML =
      (data || [])
        .map((waitlist) => {
          return `
            <tr>
              <td>
                <strong>${waitlist.name}</strong><br>
                <span style="color:var(--muted);font-size:.85rem">${waitlist.email}</span>
              </td>

              <td>${waitlist.company || ""}</td>
              <td>${waitlist.automation_type || ""}</td>
              <td>${waitlist.status}</td>
              <td>${new Date(waitlist.created_at).toLocaleString()}</td>
            </tr>
          `;
        })
        .join("") || `<tr><td colspan="5">No waitlist signups yet.</td></tr>`;
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
  openSetupChoice,
  chooseInstall,
  selectCustomization,
  deleteAutomation,
  pauseAutomation,
  deleteReview,
  
};
})();

document.addEventListener("DOMContentLoaded", NexusApp.init);