import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const {
  credentialMatchScore,
  encryptCredentialPayload,
  syncCredentialToN8n,
} = await import(pathToFileURL(path.join(
  root,
  "supabase/functions/_shared/nexus-credentials.ts",
)).href);

const credentialSecret = "nexus-credential-account-regression-secret";
const captures = [];
const originalFetch = globalThis.fetch;

const gmailSlot = {
  provider: "gmail",
  provider_label: "Gmail",
  node_name: "Email the SEO report",
  node_type: "n8n-nodes-base.gmail",
  credential_key: "gmailOAuth2",
  n8n_credential_type: "gmailOAuth2",
};
const googleSheetsSlot = {
  provider: "google_sheets",
  provider_label: "Google Sheets",
  node_name: "Load Previous Snapshot",
  node_type: "n8n-nodes-base.googleSheets",
  credential_key: "googleSheetsOAuth2Api",
  n8n_credential_type: "googleSheetsOAuth2Api",
};
const gmailCredential = {
  provider: "gmail",
  n8n_credential_type: "gmailOAuth2",
};
const googleServiceAccountCredential = {
  provider: "google_service_account",
  n8n_credential_type: "googleApi",
};

if (credentialMatchScore(gmailCredential, gmailSlot) <= 0) {
  throw new Error("Gmail OAuth no longer matches a Gmail node.");
}
if (credentialMatchScore(googleServiceAccountCredential, gmailSlot) !== 0) {
  throw new Error("Google Service Account incorrectly satisfies a Gmail OAuth node.");
}
if (credentialMatchScore(googleServiceAccountCredential, googleSheetsSlot) <= 0) {
  throw new Error("Google Service Account no longer matches a compatible Google Sheets node.");
}

const adminClient = {
  from() {
    return {
      update(patch) {
        return {
          eq() {
            return {
              select() {
                return {
                  single: async () => ({
                    data: { id: "saved-credential", ...patch },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    };
  },
};

globalThis.fetch = async (url, init = {}) => {
  captures.push({
    url: String(url),
    body: JSON.parse(init.body || "{}"),
  });
  return new Response(JSON.stringify({
    id: `n8n-credential-${captures.length}`,
    name: "Nexus regression credential",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const fixtures = [
  {
    provider: "openai",
    type: "openAiApi",
    nodeType: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
    fields: { api_key: "sk-regression" },
    assertData(data) {
      if (data.apiKey !== "sk-regression") throw new Error("OpenAI apiKey was not normalized.");
    },
  },
  {
    provider: "gmail",
    type: "gmailOAuth2",
    nodeType: "n8n-nodes-base.gmail",
    fields: {
      client_id: "google-client",
      client_secret: "google-secret",
      refresh_token: "google-refresh",
    },
    assertData(data) {
      if (data.clientId !== "google-client") throw new Error("Gmail clientId was not normalized.");
      if (data.oauthTokenData?.refresh_token !== "google-refresh") {
        throw new Error("Gmail refresh token was not stored in OAuth token data.");
      }
    },
  },
  {
    provider: "google_service_account",
    type: "googleApi",
    nodeType: "n8n-nodes-base.googleSheets",
    fields: {
      service_account_email: "nexus-regression@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nregression\\n-----END PRIVATE KEY-----",
    },
    assertData(data) {
      if (!data.email?.includes("gserviceaccount.com")) {
        throw new Error("Google service-account email was not flattened.");
      }
      if (!data.privateKey?.includes("\nregression\n")) {
        throw new Error("Google service-account private key newlines were not restored.");
      }
    },
  },
  {
    provider: "smtp",
    type: "smtp",
    nodeType: "n8n-nodes-base.emailSend",
    fields: {
      host: "smtp.example.com",
      port: "465",
      username: "sender@example.com",
      password: "smtp-password",
      secure: true,
    },
    assertData(data) {
      if (data.host !== "smtp.example.com") throw new Error("SMTP host was not preserved.");
      if (String(data.port) !== "465") throw new Error("SMTP port was not preserved.");
      if ((data.user || data.username) !== "sender@example.com") {
        throw new Error("SMTP username was not normalized.");
      }
      if (data.password !== "smtp-password") throw new Error("SMTP password was not preserved.");
    },
  },
  {
    provider: "apify",
    type: "httpBearerAuth",
    nodeType: "n8n-nodes-base.httpRequest",
    fields: { token: "apify-regression-token" },
    assertData(data) {
      if (data.token !== "apify-regression-token") {
        throw new Error("Bearer token was not normalized.");
      }
    },
  },
  {
    provider: "apify",
    type: "httpQueryAuth",
    nodeType: "n8n-nodes-base.httpRequest",
    fields: {
      query_name: "token",
      query_value: "apify-query-regression",
    },
    assertData(data) {
      if ((data.name || data.queryName) !== "token") {
        throw new Error("Query credential name was not normalized.");
      }
      if ((data.value || data.queryValue) !== "apify-query-regression") {
        throw new Error("Query credential value was not normalized.");
      }
    },
  },
];

try {
  for (const fixture of fixtures) {
    const encryptedPayload = await encryptCredentialPayload(
      fixture.fields,
      credentialSecret,
    );

    await syncCredentialToN8n({
      adminClient,
      credential: {
        id: `saved-${fixture.provider}-${fixture.type}`,
        provider: fixture.provider,
        label: `${fixture.provider} regression account`,
        encrypted_payload: encryptedPayload,
      },
      credentialSecret,
      n8nBaseUrl: "https://n8n.invalid",
      n8nApiKey: "regression-key",
      slot: {
        provider: fixture.provider,
        provider_label: fixture.provider,
        node_name: "Credential regression node",
        node_type: fixture.nodeType,
        n8n_credential_type: fixture.type,
        credential_key: fixture.type,
      },
    });

    const payload = captures.at(-1)?.body;
    if (payload?.type !== fixture.type) {
      throw new Error(`${fixture.type} created the wrong n8n credential type.`);
    }
    fixture.assertData(payload.data || {});
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  accountShapes: fixtures.map((fixture) => fixture.type),
  calls: captures.length,
  strictGmailCompatibility: true,
  passed: true,
}));
