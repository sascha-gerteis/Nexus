const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = `${fs.readFileSync(
  path.resolve(__dirname, "../assets/js/nexus-db.js"),
  "utf8",
)}\n;globalThis.__NexusDB = NexusDB;`;
const checkoutPage = fs.readFileSync(
  path.resolve(__dirname, "../pages/checkout/index.html"),
  "utf8",
);
assert.match(checkoutPage, /nexus-db\.js\?v=[^"']+/);

function createRuntime({ getSession, refreshSession, getUser, fetch }) {
  const calls = {
    fetch: 0,
    signOut: [],
    toasts: [],
  };

  const auth = {
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    getSession,
    refreshSession,
    getUser,
    async signOut(options) {
      calls.signOut.push(options);
      return { error: null };
    },
  };

  const supabaseClient = {
    auth,
    from() {
      throw new Error("Database access was not expected in this regression.");
    },
  };

  const location = {
    origin: "https://nexus-ai.software",
    pathname: "/pages/checkout",
    search: "?product=demo",
    hash: "",
    href: "",
  };

  const context = {
    AbortController,
    URL,
    URLSearchParams,
    Date,
    Map,
    Promise,
    clearTimeout,
    console,
    location,
    setTimeout,
    fetch: async (...args) => {
      calls.fetch += 1;
      return fetch(...args);
    },
    window: {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      location,
      setTimeout() {
        return 0;
      },
      NexusUI: {
        toast(message) {
          calls.toasts.push(message);
        },
      },
      supabase: {
        createClient() {
          return supabaseClient;
        },
      },
    },
  };

  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    NexusDB: context.__NexusDB,
    calls,
    location,
  };
}

const staleSession = {
  access_token: "stale-access-token",
  refresh_token: "stale-refresh-token",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "buyer-1", email: "buyer@example.com" },
};

async function verifyBuyerGateRejectsStoredStaleSession() {
  const runtime = createRuntime({
    async getSession() {
      return { data: { session: staleSession }, error: null };
    },
    async refreshSession() {
      throw new Error("Refresh was not expected.");
    },
    async getUser(token) {
      assert.equal(token, staleSession.access_token);
      return {
        data: { user: null },
        error: { status: 401, message: "invalid JWT" },
      };
    },
    async fetch() {
      throw new Error("Checkout must not run before buyer verification.");
    },
  });

  const user = await runtime.NexusDB.requireBuyer(
    "/pages/checkout?product=demo",
  );

  assert.equal(user, null);
  assert.equal(runtime.calls.signOut.length, 1);
  assert.equal(runtime.calls.signOut[0]?.scope, "local");
  assert.match(runtime.location.href, /^\/pages\/buyer\/login\.html\?next=/);
  assert.match(decodeURIComponent(runtime.location.href), /product=demo/);
  assert.deepEqual(runtime.calls.toasts, [
    "Your session expired. Please log in again to continue.",
  ]);
  assert.equal(runtime.calls.fetch, 0);
}

async function verifyFailedRefreshNeverReusesDeadToken() {
  const runtime = createRuntime({
    async getSession() {
      return { data: { session: staleSession }, error: null };
    },
    async refreshSession() {
      return {
        data: { session: null },
        error: {
          status: 400,
          message: "Invalid Refresh Token: Refresh Token Not Found",
        },
      };
    },
    async getUser() {
      throw new Error("Buyer verification was not expected in direct function call.");
    },
    async fetch() {
      return {
        ok: false,
        status: 401,
        async json() {
          return { message: "Invalid auth token" };
        },
      };
    },
  });

  const result = await runtime.NexusDB.createStripeCheckoutSession({
    automation_id: "automation-1",
  });

  assert.equal(runtime.calls.fetch, 1, "Dead access token must not be sent twice.");
  assert.equal(runtime.calls.signOut.length, 1);
  assert.equal(runtime.calls.signOut[0]?.scope, "local");
  assert.equal(result.data, null);
  assert.equal(result.error?.code, "AUTH_SESSION_EXPIRED");
  assert.equal(
    result.error?.message,
    "Your session expired. Please log in again to continue.",
  );
  assert.match(runtime.location.href, /^\/pages\/buyer\/login\.html\?/);
  assert.match(runtime.location.href, /reason=session_expired/);
  assert.match(decodeURIComponent(runtime.location.href), /product=demo/);
}

async function verifyValidBuyerStillReachesCheckout() {
  const runtime = createRuntime({
    async getSession() {
      return { data: { session: staleSession }, error: null };
    },
    async refreshSession() {
      throw new Error("Refresh was not expected for a valid session.");
    },
    async getUser(token) {
      assert.equal(token, staleSession.access_token);
      return { data: { user: staleSession.user }, error: null };
    },
    async fetch(url, options) {
      assert.match(url, /\/functions\/v1\/create-checkout-session$/);
      assert.equal(
        options?.headers?.Authorization,
        `Bearer ${staleSession.access_token}`,
      );
      return {
        ok: true,
        status: 200,
        async json() {
          return { checkout_url: "https://checkout.stripe.com/test" };
        },
      };
    },
  });

  const user = await runtime.NexusDB.requireBuyer("/pages/checkout");
  assert.equal(user?.id, staleSession.user.id);

  const result = await runtime.NexusDB.createStripeCheckoutSession({
    automation_id: "automation-1",
  });

  assert.equal(runtime.calls.fetch, 1);
  assert.equal(runtime.calls.signOut.length, 0);
  assert.equal(result.error, null);
  assert.equal(result.data?.checkout_url, "https://checkout.stripe.com/test");
}

Promise.all([
  verifyBuyerGateRejectsStoredStaleSession(),
  verifyFailedRefreshNeverReusesDeadToken(),
  verifyValidBuyerStillReachesCheckout(),
]).then(() => {
  console.log("Checkout auth-session regression checks passed.");
});
