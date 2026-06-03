const NexusDB = (() => {
  function readConfigValue(names) {
    for (const name of names) {
      if (typeof window[name] !== "undefined" && window[name]) {
        return window[name];
      }
    }

    if (typeof NEXUS_CONFIG !== "undefined") {
      for (const name of names) {
        if (NEXUS_CONFIG[name]) return NEXUS_CONFIG[name];
      }
    }

    if (typeof window.NEXUS_CONFIG !== "undefined") {
      for (const name of names) {
        if (window.NEXUS_CONFIG[name]) return window.NEXUS_CONFIG[name];
      }
    }

    return "";
  }

  const SUPABASE_URL = readConfigValue([
    "SUPABASE_URL",
    "NEXUS_SUPABASE_URL",
    "supabaseUrl",
    "NEXUS_DB_URL"
  ]);

  const SUPABASE_ANON_KEY = readConfigValue([
    "SUPABASE_ANON_KEY",
    "NEXUS_SUPABASE_ANON_KEY",
    "supabaseAnonKey",
    "NEXUS_DB_ANON_KEY"
  ]);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Missing Supabase config. Check assets/js/config.js");
  }

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const AUTH_CACHE_TTL_MS = 30 * 1000;
  let sessionCache = { result: null, promise: null, expiresAt: 0 };
  const profileCache = new Map();

  function clearAuthCaches() {
    sessionCache = { result: null, promise: null, expiresAt: 0 };
    profileCache.clear();
  }

  supabase.auth.onAuthStateChange(() => {
    clearAuthCaches();
  });

  async function getUser() {
    const { data, error } = await getSession();

    if (error) {
      return { data: null, error };
    }

    return { data: data?.session?.user || null, error: null };
  }

  async function getSession() {
    const now = Date.now();

    if (sessionCache.result && sessionCache.expiresAt > now) {
      return sessionCache.result;
    }

    if (sessionCache.promise) {
      return sessionCache.promise;
    }

    sessionCache.promise = supabase.auth
      .getSession()
      .then((result) => {
        sessionCache = {
          result,
          promise: null,
          expiresAt: Date.now() + AUTH_CACHE_TTL_MS
        };

        return result;
      })
      .catch((error) => {
        sessionCache.promise = null;
        throw error;
      });

    return sessionCache.promise;
  }

  async function getProfile(userId) {
    const id = userId || (await getUser()).data?.id;

    if (!id) {
      return { data: null, error: null };
    }

    const cached = profileCache.get(id);
    const now = Date.now();

    if (cached?.result && cached.expiresAt > now) {
      return cached.result;
    }

    if (cached?.promise) {
      return cached.promise;
    }

    const promise = supabase
      .from("profiles")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then((result) => {
        profileCache.set(id, {
          result,
          promise: null,
          expiresAt: Date.now() + AUTH_CACHE_TTL_MS
        });

        return result;
      })
      .catch((error) => {
        profileCache.delete(id);
        throw error;
      });

    profileCache.set(id, {
      result: null,
      promise,
      expiresAt: 0
    });

    return promise;
  }

  async function upsertProfile(payload) {
    if (payload?.id) profileCache.delete(payload.id);

    return supabase
      .from("profiles")
      .upsert(payload, { onConflict: "id" })
      .select()
      .single();
  }

  async function requireAdmin() {
    const { data: user, error: userError } = await getUser();

    if (userError || !user) {
      location.href = "/pages/auth/login.html";
      return null;
    }

    const { data: profile, error: profileError } = await getProfile(user.id);

    if (profileError || !profile || profile.role !== "admin") {
      alert("Admin access required.");
      location.href = "/index.html";
      return null;
    }

    return profile;
  }

  async function requireBuyer(nextUrl = "") {
    const { data: user, error } = await getUser();

    if (error || !user) {
      const next = nextUrl || location.pathname + location.search;
      location.href = `/pages/buyer/login.html?next=${encodeURIComponent(next)}`;
      return null;
    }

    return user;
  }

  async function signIn(email, password) {
    clearAuthCaches();

    const result = await supabase.auth.signInWithPassword({
      email,
      password
    });

    clearAuthCaches();
    return result;
  }

  async function buyerSignIn(email, password) {
    clearAuthCaches();

    const result = await supabase.auth.signInWithPassword({
      email,
      password
    });

    clearAuthCaches();
    return result;
  }

  async function buyerSignUp(email, password, metadata = {}) {
    clearAuthCaches();

    const result = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: metadata
      }
    });

    clearAuthCaches();
    return result;
  }

  function friendlyAuthMessage(error, fallback = "Something went wrong. Please try again.") {
    const raw = typeof error === "string"
      ? error
      : [
          error?.message,
          error?.error_description,
          error?.error,
          error?.details?.message,
          error?.details?.error
        ].filter(Boolean).join(" ");
    const message = String(raw || "").trim();
    const lower = message.toLowerCase();

    if (!message) return fallback;
    if (lower.includes("unsupported provider")) return "This login provider is not enabled yet.";
    if (lower.includes("invalid login credentials")) return "Email or password is incorrect.";
    if (lower.includes("email not confirmed")) return "Please confirm your email before logging in.";
    if (lower.includes("already registered") || lower.includes("already exists")) return "An account with this email already exists.";
    if (lower.includes("password")) return message;
    if (lower.includes("expired") || lower.includes("invalid token") || lower.includes("recovery")) {
      return "This reset link is invalid or has expired. Please request a new one.";
    }
    if (lower.includes("popup") || lower.includes("closed") || lower.includes("cancelled") || lower.includes("canceled") || lower.includes("access_denied")) {
      return "Login was cancelled. Please try again.";
    }
    if (lower.includes("failed to fetch") || lower.includes("network")) {
      return "Network issue. Please check your connection and try again.";
    }

    return message || fallback;
  }

  function safeNextPath(nextUrl = "", fallback = "/pages/buyer/dashboard.html") {
    const raw = String(nextUrl || "").trim();
    if (!raw) return fallback;

    try {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) return fallback;
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return raw.startsWith("/") ? raw : fallback;
    }
  }

  function accountLoginPath(accountType = "buyer", nextUrl = "") {
    const account = String(accountType || "buyer").toLowerCase() === "developer"
      ? "developer"
      : "buyer";
    const loginPath = account === "developer"
      ? "/pages/developer/login.html"
      : "/pages/buyer/login.html";
    const fallbackNext = account === "developer"
      ? "/pages/developer/dashboard.html"
      : "/pages/buyer/dashboard.html";

    return `${loginPath}?next=${encodeURIComponent(safeNextPath(nextUrl, fallbackNext))}`;
  }

  function buyerAuthRedirectUrl(nextUrl = "") {
    const redirectUrl = new URL("/pages/buyer/login.html", location.origin);
    redirectUrl.searchParams.set("next", nextUrl || "/pages/buyer/dashboard.html");
    return redirectUrl.toString();
  }

  function passwordResetRedirectUrl(accountType = "buyer", nextUrl = "") {
    const account = String(accountType || "buyer").toLowerCase() === "developer"
      ? "developer"
      : "buyer";
    const redirectUrl = new URL("/pages/auth/reset-password.html", location.origin);
    redirectUrl.searchParams.set("account", account);
    redirectUrl.searchParams.set("mode", "recovery");
    redirectUrl.searchParams.set("next", nextUrl || (account === "developer" ? "/pages/developer/dashboard.html" : "/pages/buyer/dashboard.html"));
    return redirectUrl.toString();
  }

  async function buyerSignInWithOAuth(provider, nextUrl = "") {
    const cleanProvider = String(provider || "").toLowerCase();

    if (cleanProvider !== "google") {
      return {
        data: null,
        error: { message: "Unsupported login provider." }
      };
    }

    clearAuthCaches();

    return supabase.auth.signInWithOAuth({
      provider: cleanProvider,
      options: {
        redirectTo: buyerAuthRedirectUrl(nextUrl),
        queryParams: {
          prompt: "select_account"
        }
      }
    });
  }

  async function sendPasswordResetEmail(email, accountType = "buyer", nextUrl = "") {
    return supabase.auth.resetPasswordForEmail(email, {
      redirectTo: passwordResetRedirectUrl(accountType, nextUrl)
    });
  }

  async function exchangePasswordRecoveryCode(code) {
    return supabase.auth.exchangeCodeForSession(code);
  }

  async function updateCurrentUserPassword(password) {
    clearAuthCaches();
    const result = await supabase.auth.updateUser({ password });
    clearAuthCaches();
    return result;
  }

  async function developerSignIn(email, password) {
    clearAuthCaches();

    const result = await supabase.auth.signInWithPassword({
      email,
      password
    });

    clearAuthCaches();
    return result;
  }

  async function developerSignUp(email, password, metadata = {}) {
    clearAuthCaches();

    const result = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          ...metadata,
          account_type: "developer"
        }
      }
    });

    clearAuthCaches();
    return result;
  }

  async function signOut() {
    clearAuthCaches();
    await supabase.auth.signOut();
    clearAuthCaches();
    location.href = "/index.html";
  }

  async function ensureBuyerProfileFromUser(user) {
  if (!user) return { data: null, error: null };

  const email = user.email || "";
  const name =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    "";

  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  await upsertProfile({
    id: user.id,
    email,
    full_name: existingProfile?.full_name || name,
    role: existingProfile?.role || "buyer"
  });

  return supabase
    .from("buyer_profiles")
    .upsert({
      user_id: user.id,
      email,
      name
    }, { onConflict: "user_id" })
    .select()
    .single();
}

  async function upsertBuyerProfile(payload) {
    return supabase
      .from("buyer_profiles")
      .upsert(payload, { onConflict: "user_id" })
      .select()
      .single();
  }

  async function getBuyerProfile(userId) {
    return supabase
      .from("buyer_profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
  }

  async function listLiveAutomations() {
    return supabase
      .from("automations")
      .select("*, developers(*)")
      .eq("status", "live")
      .order("created_at", { ascending: false });
  }

  async function countRows(table, configureQuery) {
    let query = supabase
      .from(table)
      .select("*", { count: "exact", head: true });

    if (typeof configureQuery === "function") {
      query = configureQuery(query);
    }

    const { count, error } = await query;

    return {
      data: error ? null : count || 0,
      error
    };
  }

  async function countAutomations(status = "") {
    return countRows("automations", (query) => status ? query.eq("status", status) : query);
  }

  async function countDevelopers() {
    return countRows("developers");
  }

  async function countReviews() {
    return countRows("reviews");
  }

  async function countWaitlist() {
    return countRows("developer_waitlist");
  }

  async function countContacts() {
    return countRows("contact_messages");
  }

  async function countCheckoutIntents() {
    return countRows("checkout_intents");
  }

  async function listAllAutomations() {
    return supabase
      .from("automations")
      .select("*, developers(*)")
      .order("created_at", { ascending: false });
  }

  async function getAutomationBySlug(slug) {
    return supabase
      .from("automations")
      .select("*, developers(*)")
      .eq("slug", slug)
      .maybeSingle();
  }

  async function getAutomationById(id) {
    return supabase
      .from("automations")
      .select("*, developers(*)")
      .eq("id", id)
      .maybeSingle();
  }

  async function upsertAutomation(payload) {
    return supabase
      .from("automations")
      .upsert(payload)
      .select()
      .single();
  }

  async function deleteAutomation(id) {
    return supabase
      .from("automations")
      .delete()
      .eq("id", id);
  }

  async function listDevelopers() {
    return supabase
      .from("developers")
      .select("*")
      .order("created_at", { ascending: true });
  }

  async function getDeveloper(id) {
    return supabase
      .from("developers")
      .select("*")
      .eq("id", id)
      .maybeSingle();
  }

  async function updateDeveloper(id, payload) {
    return supabase
      .from("developers")
      .update(payload)
      .eq("id", id)
      .select()
      .single();
  }

  async function listDeveloperAutomations(developerId) {
    return supabase
      .from("automations")
      .select("*, developers(*)")
      .eq("developer_id", developerId)
      .eq("status", "live")
      .order("created_at", { ascending: false });
  }

  async function listReviews() {
    return supabase
      .from("reviews")
      .select("*, automations(title, slug), developers(display_name, handle)")
      .order("created_at", { ascending: false });
  }

  async function listApprovedReviews() {
    return supabase
      .from("reviews")
      .select("*, automations(title, slug, developer_id), developers(display_name, handle)")
      .eq("status", "approved")
      .order("created_at", { ascending: false });
  }

  async function listProductReviews(automationId) {
    return supabase
      .from("reviews")
      .select("*")
      .eq("automation_id", automationId)
      .eq("review_type", "product")
      .eq("status", "approved")
      .order("created_at", { ascending: false });
  }

  async function listDeveloperReviews(developerId) {
    return supabase
      .from("reviews")
      .select("*, automations(title, slug)")
      .eq("developer_id", developerId)
      .eq("review_type", "developer")
      .eq("status", "approved")
      .order("created_at", { ascending: false });
  }

  async function listAllReviewsDetailed() {
    return supabase
      .from("reviews")
      .select("*, automations(title, slug), developers(display_name, handle)")
      .order("created_at", { ascending: false });
  }

  async function createReview(payload) {
    return supabase
      .from("reviews")
      .insert(payload)
      .select()
      .single();
  }

  async function submitProductReview(payload = {}) {
    return callNexusFunction("submit-review", {
      action: "submit_product_review",
      ...payload
    });
  }

  async function submitDeveloperReview(payload = {}) {
    return callNexusFunction("submit-review", {
      action: "submit_developer_review",
      ...payload
    });
  }

  async function updateReviewStatus(payload = {}) {
    return callNexusFunction("submit-review", {
      action: "admin_update_status",
      ...payload
    });
  }

  async function deleteReview(id) {
    return supabase
      .from("reviews")
      .delete()
      .eq("id", id);
  }

  async function createWaitlist(payload) {
    return supabase
      .from("developer_waitlist")
      .insert(payload)
      .select()
      .single();
  }

  async function listWaitlist() {
    return supabase
      .from("developer_waitlist")
      .select("*")
      .order("created_at", { ascending: false });
  }

  async function createContact(payload) {
    return supabase
      .from("contact_messages")
      .insert(payload)
      .select()
      .single();
  }

  async function listContacts() {
    return supabase
      .from("contact_messages")
      .select("*")
      .order("created_at", { ascending: false });
  }

  async function createCheckoutIntent(payload) {
    return supabase
      .from("checkout_intents")
      .insert(payload)
      .select()
      .single();
  }

  async function listCheckoutIntents() {
    return supabase
      .from("checkout_intents")
      .select("*")
      .order("created_at", { ascending: false });
  }

  async function createBuyerOrder(payload) {
    return supabase
      .from("orders")
      .insert(payload)
      .select()
      .single();
  }

  async function listBuyerOrders(userId) {
    return supabase
      .from("orders")
      .select("*, automations(title, slug, category, icon, color), developers(display_name, avatar_letter)")
      .eq("buyer_id", userId)
      .order("created_at", { ascending: false });
  }

  async function listAllOrders() {
    return supabase
      .from("orders")
      .select("*, automations(title, slug), developers(display_name, handle)")
      .order("created_at", { ascending: false });
  }

  async function createCustomerAutomation(payload) {
    return supabase
      .from("customer_automations")
      .insert(payload)
      .select()
      .single();
  }

  async function listBuyerCustomerAutomations(userId) {
    return supabase
      .from("customer_automations")
      .select("*, automations(title, slug, category, icon, color), developers(display_name, avatar_letter)")
      .eq("buyer_id", userId)
      .order("created_at", { ascending: false });
  }

  async function listAllCustomerAutomations() {
    return supabase
      .from("customer_automations")
      .select("*, orders(buyer_name, buyer_email, buyer_company), automations(title, slug), developers(display_name, handle)")
      .order("created_at", { ascending: false });
  }

  async function createAutomationEvent(payload) {
    return supabase
      .from("automation_events")
      .insert(payload)
      .select()
      .single();
  }

  async function listBuyerAutomationEvents(userId) {
    return supabase
      .from("automation_events")
      .select("*, customer_automations(name)")
      .eq("buyer_id", userId)
      .order("created_at", { ascending: false });
  }

  async function createAdminNotification(payload) {
    return supabase
      .from("admin_notifications")
      .insert(payload)
      .select()
      .single();
  }

  async function listAdminNotifications() {
    return supabase
      .from("admin_notifications")
      .select("*, orders(automation_title, buyer_name, buyer_email, buyer_company)")
      .order("created_at", { ascending: false });
  }

  async function markAdminNotificationRead(id) {
    return supabase
      .from("admin_notifications")
      .update({ status: "read" })
      .eq("id", id);
  }
  function getFunctionsBaseUrl() {
  if (typeof NEXUS_FUNCTIONS_BASE_URL !== "undefined" && NEXUS_FUNCTIONS_BASE_URL) {
    return NEXUS_FUNCTIONS_BASE_URL.replace(/\/$/, "");
  }

  if (typeof window.NEXUS_FUNCTIONS_BASE_URL !== "undefined" && window.NEXUS_FUNCTIONS_BASE_URL) {
    return window.NEXUS_FUNCTIONS_BASE_URL.replace(/\/$/, "");
  }

  return `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1`;
}

async function callNexusFunction(functionName, payload = {}) {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    const response = await fetch(`${getFunctionsBaseUrl()}/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": token ? `Bearer ${token}` : `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      return {
        data: null,
        error: {
          message: data.error || `Function ${functionName} failed.`,
          details: data,
        },
      };
    }

    return {
      data,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: {
        message: error.message || `Could not call ${functionName}.`,
        details: error,
      },
    };
  }
}

async function syncStripeProduct(automationId) {
  return callNexusFunction("sync-stripe-product", {
    automation_id: automationId,
  });
}

async function createStripeCheckoutSession(payload) {
  return callNexusFunction("create-checkout-session", payload);
}

async function getBuyerAccount(payload = {}) {
  return callNexusFunction("buyer-account", payload);
}

async function getCurrentBuyerAccount() {
  return getBuyerAccount({ action: "get_profile" });
}

async function updateCurrentBuyerAccount(payload = {}) {
  return getBuyerAccount({
    action: "update_profile",
    ...payload
  });
}

async function getDeveloperAccount(payload = {}) {
  return callNexusFunction("developer-account", payload);
}

async function ensureDeveloperProfile(payload = {}) {
  return getDeveloperAccount({
    action: "ensure_profile",
    ...payload
  });
}

async function getCurrentDeveloperProfile() {
  return getDeveloperAccount({ action: "get_profile" });
}

async function updateCurrentDeveloperProfile(payload = {}) {
  return getDeveloperAccount({
    action: "update_profile",
    ...payload
  });
}

async function callDeveloperProducts(payload = {}) {
  return callNexusFunction("developer-products", payload);
}

async function listDeveloperProducts() {
  return callDeveloperProducts({ action: "list" });
}

async function getDeveloperProduct(id) {
  return callDeveloperProducts({ action: "get", id });
}

async function saveDeveloperProduct(payload = {}) {
  return callDeveloperProducts({
    action: "save_draft",
    ...payload
  });
}

async function submitDeveloperProduct(payload = {}) {
  return callDeveloperProducts({
    action: "submit_for_review",
    ...payload
  });
}

async function removeDeveloperProduct(id) {
  return callDeveloperProducts({
    action: "remove",
    id
  });
}

async function callMessages(payload = {}) {
  return callNexusFunction("messages", payload);
}

async function listMessageThreads() {
  return callMessages({ action: "list_threads" });
}

async function getMessageThread(threadId) {
  return callMessages({
    action: "get_thread",
    thread_id: threadId
  });
}

async function sendThreadMessage(threadId, message) {
  return callMessages({
    action: "send_message",
    thread_id: threadId,
    message
  });
}

async function markMessageThreadRead(threadId) {
  return callMessages({
    action: "mark_read",
    thread_id: threadId
  });
}

async function startProductMessageThread(productId, message = "") {
  return callMessages({
    action: "start_product_thread",
    automation_id: productId,
    message
  });
}

async function startDeveloperMessageThread(developerId, message = "") {
  return callMessages({
    action: "start_developer_thread",
    developer_id: developerId,
    message
  });
}

async function getDeveloperStripeStatus() {
  return callNexusFunction("developer-stripe-account", {
    action: "get_status"
  });
}

async function refreshDeveloperStripeAccount() {
  return callNexusFunction("developer-stripe-account", {
    action: "refresh_account"
  });
}

async function createDeveloperStripeOnboardingLink() {
  return callNexusFunction("developer-stripe-account", {
    action: "create_onboarding_link"
  });
}

async function createDeveloperStripeDashboardLink() {
  return callNexusFunction("developer-stripe-account", {
    action: "create_dashboard_login_link"
  });
}

async function getDeveloperWalletSummary() {
  return callNexusFunction("developer-stripe-account", {
    action: "get_wallet_summary"
  });
}

async function getAdminFinanceSummary() {
  return callNexusFunction("developer-stripe-account", {
    action: "admin_get_finance_summary"
  });
}

async function requestDeveloperManualPayout(payload = {}) {
  return callNexusFunction("developer-stripe-account", {
    action: "request_manual_payout",
    ...payload
  });
}

async function updateDeveloperPayoutRequest(payload = {}) {
  return callNexusFunction("developer-stripe-account", {
    action: "admin_update_payout_request",
    ...payload
  });
}

async function getBuyerOrderById(orderId) {
  const { data: user } = await getUser();

  if (!user) {
    return { data: null, error: { message: "Login required." } };
  }

  return supabase
    .from("orders")
    .select("*, automations(title, slug, category, icon, color), developers(display_name)")
    .eq("id", orderId)
    .eq("buyer_id", user.id)
    .maybeSingle();
}

async function getCustomerAutomationByOrderId(orderId) {
  const user = await getCurrentUser();

  if (!user) {
    return {
      data: null,
      error: { message: "You must be logged in." }
    };
  }

  return supabase
    .from("customer_automations")
    .select(`
      *,
      automations(*),
      orders(*)
    `)
    .eq("order_id", orderId)
    .eq("buyer_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

async function getBuyerOrderById(orderId) {
  const { data: user } = await getUser();

  if (!user) {
    return {
      data: null,
      error: { message: "Login required." }
    };
  }

  return supabase
    .from("orders")
    .select("*, automations(title, slug, category, icon, color), developers(display_name)")
    .eq("id", orderId)
    .eq("buyer_id", user.id)
    .maybeSingle();
}

async function getCustomerAutomationByOrderId(orderId) {
  const { data: user } = await getUser();

  if (!user) {
    return {
      data: null,
      error: { message: "Login required." }
    };
  }

  return supabase
    .from("customer_automations")
    .select("*, automations(title, slug, setup_schema, runtime_type), orders(payment_status, order_status)")
    .eq("order_id", orderId)
    .eq("buyer_id", user.id)
    .maybeSingle();
}
async function getBuyerCustomerAutomationById(customerAutomationId) {
  const { data: user } = await getUser();

  if (!user) {
    return {
      data: null,
      error: { message: "Login required." }
    };
  }

  return supabase
    .from("customer_automations")
    .select(`
      *,
      automations(
        id,
        title,
        slug,
        category,
        icon,
        color,
        badge,
        short_description,
        long_description,
        setup_schema,
        runtime_type,
        runtime_webhook_url,
        n8n_workflow_id
        
      ),
      orders(
        id,
        payment_status,
        order_status,
        price_display,
        currency,
        install_type,
        selected_customization
      ),
      developers(
        display_name,
        avatar_letter
      )
    `)
    .eq("id", customerAutomationId)
    .eq("buyer_id", user.id)
    .maybeSingle();
}

async function getLatestSetupSubmission(customerAutomationId) {
  const { data: user } = await getUser();

  if (!user) {
    return {
      data: null,
      error: { message: "Login required." }
    };
  }

  return supabase
    .from("automation_setup_submissions")
    .select("*")
    .eq("customer_automation_id", customerAutomationId)
    .eq("buyer_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

async function createSetupSubmission(payload) {
  return supabase
    .from("automation_setup_submissions")
    .insert(payload)
    .select()
    .single();
}

async function listBuyerOutputs(userId) {
  return supabase
    .from("automation_outputs")
    .select(`
      *,
      customer_automations(name, status, setup_status),
      automations(title, slug, icon, color)
    `)
    .eq("buyer_id", userId)
    .eq("status", "published")
    .order("created_at", { ascending: false });
}

async function listOutputsForCustomerAutomation(customerAutomationId) {
  const { data: user } = await getUser();

  if (!user) {
    return {
      data: null,
      error: { message: "Login required." }
    };
  }

  return supabase
    .from("automation_outputs")
    .select("*")
    .eq("customer_automation_id", customerAutomationId)
    .eq("buyer_id", user.id)
    .eq("status", "published")
    .order("created_at", { ascending: false });
}
async function importN8nWorkflow(automationId) {
  return callNexusFunction("import-n8n-workflow", {
    automation_id: automationId
  });
}
async function listBuyerCustomerAutomations(userId) {
  let buyerId = userId || "";

  if (!buyerId) {
    const { data: authData, error: authError } = await supabase.auth.getUser();

    if (authError || !authData?.user) {
      return {
        data: [],
        error: { message: "You must be logged in." }
      };
    }

    buyerId = authData.user.id;
  }

  const { data, error } = await supabase
    .from("customer_automations")
    .select(`
      *,
      automations(
        id,
        title,
        slug,
        icon,
        color,
        short_description,
        category,
        status
      ),
      orders(
        id,
        automation_title,
        buyer_name,
        buyer_email,
        buyer_company,
        price_display,
        payment_status,
        order_status,
        install_type,
        created_at
      )
    `)
    .eq("buyer_id", buyerId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("listBuyerCustomerAutomations error:", error);

    return {
      data: [],
      error
    };
  }

  return {
    data: data || [],
    error: null
  };
}

async function listBuyerAutomationOutputs() {
  const { data: user } = await getUser();

  if (!user) {
    return {
      data: [],
      error: { message: "Login required." }
    };
  }

  return supabase
    .from("automation_outputs")
    .select(`
      *,
      automations(
        id,
        title,
        slug,
        icon,
        color,
        category
      ),
      customer_automations(
        id,
        name,
        status,
        setup_status,
        runtime_status,
        health_status
      )
    `)
    .eq("buyer_id", user.id)
    .eq("status", "published")
    .order("created_at", { ascending: false });
}

async function getBuyerAutomationOutput(outputId) {
  const { data: user } = await getUser();

  if (!user) {
    return {
      data: null,
      error: { message: "Login required." }
    };
  }

  return supabase
    .from("automation_outputs")
    .select(`
      *,
      automations(
        id,
        title,
        slug,
        icon,
        color,
        category
      ),
      customer_automations(
        id,
        name,
        status,
        setup_status,
        runtime_status,
        health_status
      )
    `)
    .eq("id", outputId)
    .eq("buyer_id", user.id)
    .maybeSingle();
}

async function submitAutomationSetup(payload) {
  return callNexusFunction("submit-automation-setup", payload);
}

async function provisionCustomerWorkflow(customerAutomationId) {
  return callNexusFunction("provision-customer-workflow", {
    customer_automation_id: customerAutomationId
  });
}

async function runScheduledAutomation(payload = {}) {
  return callNexusFunction("run-scheduled-automations", payload);
}

async function manageAutomationLifecycle(payload) {
  return callNexusFunction("manage-automation-lifecycle", payload);
}

async function safeDeleteAutomation(automationId) {
  return manageAutomationLifecycle({
    action: "delete",
    automation_id: automationId
  });
}

async function pauseAutomation(automationId) {
  return manageAutomationLifecycle({
    action: "pause",
    automation_id: automationId
  });
}

async function requestAutomationCancellation(payload) {
  return callNexusFunction("request-automation-cancellation", payload);
}

async function reviewAutomationCancellation(payload) {
  return callNexusFunction("review-automation-cancellation", payload);
}

async function listCancellationRequests() {
  const { data, error } = await callNexusFunction("list-cancellation-requests", {});

  if (error) {
    return { data: null, error };
  }

  return {
    data: data?.requests || [],
    error: null
  };
}


async function createContactMessage(payload) {
  return callNexusFunction("submit-contact-message", {
    name: payload.name || "",
    email: payload.email || "",
    company: payload.company || "",
    phone: payload.phone || "",
    subject: payload.subject || "Website inquiry",
    message: payload.message || "",
    source: payload.source || "website_form",
    page_url: payload.page_url || window.location.href,
    inquiry_type: payload.inquiry_type || "general",
    priority: payload.priority || "normal",
    metadata: payload.metadata || {}
  });
}

async function submitContactMessage(payload) {
  return createContactMessage(payload);
}

async function sendContactMessage(payload) {
  return createContactMessage(payload);
}

async function listContactMessages() {
  return supabase
    .from("contact_messages")
    .select("*")
    .order("created_at", { ascending: false });
}

async function updateContactMessage(id, updates) {
  return supabase
    .from("contact_messages")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
}
async function submitContactMessage(payload) {
  return createContactMessage(payload);
}

async function sendContactMessage(payload) {
  return createContactMessage(payload);
}


async function listContactMessages() {
  return supabase
    .from("contact_messages")
    .select("*")
    .order("created_at", { ascending: false });
}

async function updateContactMessage(id, updates) {
  return supabase
    .from("contact_messages")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
}


async function getNexusInstallRequest(customerAutomationId) {
  return callNexusFunction("nexus-install-request", {
    action: "get",
    customer_automation_id: customerAutomationId || ""
  });
}

async function submitNexusInstallRequest(payload) {
  return callNexusFunction("nexus-install-request", {
    action: "submit",
    ...payload
  });
}

async function listAdminOrders() {
  const { data, error } = await callNexusFunction("nexus-install-request", {
    action: "admin_list"
  });

  if (error) return { data: null, error };

  return {
    data: data?.rows || [],
    error: null
  };
}

async function updateAdminInstallRequest(payload) {
  return callNexusFunction("nexus-install-request", {
    action: "admin_update",
    ...payload
  });
}

async function ensureCustomerAutomations(orderId) {
  return callNexusFunction("ensure-customer-automations", {
    order_id: orderId || ""
  });
}


async function listAdminOrders() {
  const { data, error } = await callNexusFunction("nexus-install-request", {
    action: "admin_list"
  });

  if (error) {
    return {
      data: [],
      error
    };
  }

  return {
    data: data?.rows || [],
    error: null
  };
}

async function updateAdminInstallRequest(payload) {
  return callNexusFunction("nexus-install-request", {
    action: "admin_update",
    ...payload
  });
}


  return {
    supabase,

    getUser,
    getSession,
    getProfile,
    upsertProfile,
    requireAdmin,
    requireBuyer,
    signIn,
    buyerSignIn,
    buyerSignUp,
    friendlyAuthMessage,
    buyerSignInWithOAuth,
    safeNextPath,
    accountLoginPath,
    sendPasswordResetEmail,
    exchangePasswordRecoveryCode,
    updateCurrentUserPassword,
    developerSignIn,
    developerSignUp,
    signOut,
    ensureBuyerProfileFromUser,
    getBuyerAccount,
    getCurrentBuyerAccount,
    updateCurrentBuyerAccount,
    getDeveloperAccount,
    ensureDeveloperProfile,
    getCurrentDeveloperProfile,
    updateCurrentDeveloperProfile,
    listMessageThreads,
    getMessageThread,
    sendThreadMessage,
    markMessageThreadRead,
    startProductMessageThread,
    startDeveloperMessageThread,
    listDeveloperProducts,
    getDeveloperProduct,
    saveDeveloperProduct,
    submitDeveloperProduct,
    removeDeveloperProduct,
    getDeveloperStripeStatus,
    refreshDeveloperStripeAccount,
    createDeveloperStripeOnboardingLink,
    createDeveloperStripeDashboardLink,
    getDeveloperWalletSummary,
    getAdminFinanceSummary,
    requestDeveloperManualPayout,
    updateDeveloperPayoutRequest,

    upsertBuyerProfile,
    getBuyerProfile,

    listLiveAutomations,
    countAutomations,
    countDevelopers,
    countReviews,
    countWaitlist,
    countContacts,
    countCheckoutIntents,
    listAllAutomations,
    getAutomationBySlug,
    getAutomationById,
    upsertAutomation,
    deleteAutomation,

    listDevelopers,
    getDeveloper,
    updateDeveloper,
    listDeveloperAutomations,

    listReviews,
    listApprovedReviews,
    listProductReviews,
    listDeveloperReviews,
    listAllReviewsDetailed,
    createReview,
    submitProductReview,
    submitDeveloperReview,
    updateReviewStatus,
    deleteReview,

    createWaitlist,
    listWaitlist,
    createContact,
    listContacts,
    createCheckoutIntent,
    listCheckoutIntents,

    createBuyerOrder,
    listBuyerOrders,
    listAllOrders,
    createCustomerAutomation,
    listBuyerCustomerAutomations,
    listAllCustomerAutomations,
    createAutomationEvent,
    listBuyerAutomationEvents,
    createAdminNotification,
    listAdminNotifications,
    markAdminNotificationRead,
    syncStripeProduct,
createStripeCheckoutSession,
getBuyerOrderById,
getCustomerAutomationByOrderId,
getBuyerCustomerAutomationById,
getLatestSetupSubmission,
createSetupSubmission,
listBuyerOutputs,
listOutputsForCustomerAutomation,
importN8nWorkflow,
listBuyerCustomerAutomations,
listBuyerAutomationOutputs,
getBuyerAutomationOutput,
submitAutomationSetup,
provisionCustomerWorkflow,
runScheduledAutomation,
manageAutomationLifecycle,
safeDeleteAutomation,
pauseAutomation,
requestAutomationCancellation,
reviewAutomationCancellation,
listCancellationRequests,
createContactMessage,
listContactMessages,
createContactMessage,
submitContactMessage,
sendContactMessage,
listContactMessages,
updateContactMessage,
getNexusInstallRequest,
submitNexusInstallRequest,
listAdminOrders,
updateAdminInstallRequest,
ensureCustomerAutomations,
listAdminOrders,
updateAdminInstallRequest,
  };
})();
window.NexusDB = NexusDB;
