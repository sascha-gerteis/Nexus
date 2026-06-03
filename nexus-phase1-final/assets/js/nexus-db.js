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

  async function getUser() {
    const { data, error } = await supabase.auth.getUser();

    if (error) {
      return { data: null, error };
    }

    return { data: data?.user || null, error: null };
  }

  async function getSession() {
    return supabase.auth.getSession();
  }

  async function getProfile(userId) {
    const id = userId || (await getUser()).data?.id;

    if (!id) {
      return { data: null, error: null };
    }

    return supabase
      .from("profiles")
      .select("*")
      .eq("id", id)
      .maybeSingle();
  }

  async function upsertProfile(payload) {
    return supabase
      .from("profiles")
      .upsert(payload, { onConflict: "id" })
      .select()
      .single();
  }

  async function requireAdmin() {
    const { data: user, error: userError } = await getUser();

    if (userError || !user) {
      location.href = "/pages/admin/login.html";
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
    return supabase.auth.signInWithPassword({
      email,
      password
    });
  }

  async function buyerSignIn(email, password) {
    return supabase.auth.signInWithPassword({
      email,
      password
    });
  }

  async function buyerSignUp(email, password, metadata = {}) {
    return supabase.auth.signUp({
      email,
      password,
      options: {
        data: metadata
      }
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
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
    priority: payload.priority || "normal"
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
    signOut,
    ensureBuyerProfileFromUser,

    upsertBuyerProfile,
    getBuyerProfile,

    listLiveAutomations,
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