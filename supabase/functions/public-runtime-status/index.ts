import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanUrl(value: string) {
  return String(value || "").replace(/\/+$/, "");
}

function component(
  name: string,
  status: "operational" | "degraded" | "issue",
  message: string,
  details: Record<string, unknown> = {},
) {
  return { name, status, message, details };
}

function publicStatus(components: ReturnType<typeof component>[]) {
  const hasIssue = components.some((item) => item.status === "issue");
  const hasDegraded = components.some((item) => item.status === "degraded");
  return hasIssue ? "issue" : hasDegraded ? "degraded" : "operational";
}

async function countRows(adminClient: any, table: string, build?: (query: any) => any) {
  let query = adminClient
    .from(table)
    .select("id", { count: "exact", head: true });

  if (build) query = build(query);

  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count || 0;
}

async function checkMarketplace(adminClient: any) {
  try {
    const liveProducts = await countRows(adminClient, "automations", (query) =>
      query.eq("status", "live")
    );

    return component(
      "Marketplace",
      liveProducts > 0 ? "operational" : "degraded",
      liveProducts > 0
        ? "Marketplace listings are available."
        : "Marketplace is reachable, but no live products are currently available.",
      { live_products: liveProducts },
    );
  } catch (_error) {
    return component("Marketplace", "issue", "Marketplace data could not be checked.");
  }
}

async function checkWorkflowHealth(adminClient: any) {
  try {
    const liveWorkflowProducts = await countRows(adminClient, "automations", (query) =>
      query.eq("status", "live").neq("listing_type", "custom_request")
    );

    const blockedProducts = await countRows(adminClient, "automations", (query) =>
      query
        .eq("status", "live")
        .neq("listing_type", "custom_request")
        .in("health_status", ["failed", "error", "unhealthy", "paused_by_health_check"])
    );

    if (!liveWorkflowProducts) {
      return component(
        "Automation runtime",
        "operational",
        "No active hosted workflow products require runtime checks right now.",
      );
    }

    return component(
      "Automation runtime",
      blockedProducts > 0 ? "degraded" : "operational",
      blockedProducts > 0
        ? "Some hosted workflow products need attention."
        : "Hosted workflow products are passing public health signals.",
      {
        live_workflow_products: liveWorkflowProducts,
        products_needing_attention: blockedProducts,
      },
    );
  } catch (_error) {
    return component("Automation runtime", "degraded", "Workflow health could not be checked.");
  }
}

async function checkN8n() {
  const baseUrl = cleanUrl(env("N8N_BASE_URL"));
  const apiKey = env("N8N_API_KEY");

  if (!baseUrl || !apiKey) {
    return component("n8n workflow host", "degraded", "Workflow host status is not publicly available.");
  }

  try {
    const response = await fetch(`${baseUrl}/api/v1/workflows?limit=1`, {
      headers: { "X-N8N-API-KEY": apiKey },
    });

    return component(
      "n8n workflow host",
      response.ok ? "operational" : "issue",
      response.ok ? "Workflow host is reachable." : "Workflow host is not responding normally.",
      { status_code: response.status },
    );
  } catch (_error) {
    return component("n8n workflow host", "issue", "Workflow host could not be reached.");
  }
}

async function checkPythonRunner() {
  const runnerUrl = cleanUrl(env("PYTHON_RUNNER_URL"));

  if (!runnerUrl) {
    return component("Python runner", "operational", "Python runner is not enabled for public products yet.");
  }

  try {
    const response = await fetch(`${runnerUrl}/health`, {
      method: "GET",
    });

    return component(
      "Python runner",
      response.ok ? "operational" : "issue",
      response.ok ? "Python runner is reachable." : "Python runner is not responding normally.",
      { status_code: response.status },
    );
  } catch (_error) {
    return component("Python runner", "issue", "Python runner could not be reached.");
  }
}

async function checkMessaging(adminClient: any) {
  try {
    await countRows(adminClient, "message_threads");
    return component("Messages", "operational", "Platform messaging is available.");
  } catch (_error) {
    return component("Messages", "degraded", "Messaging status could not be checked.");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({
      ok: false,
      status: "issue",
      checked_at: new Date().toISOString(),
      components: [
        component("Status service", "issue", "Status service is missing server configuration."),
      ],
    }, 500);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const components = await Promise.all([
    checkMarketplace(adminClient),
    checkWorkflowHealth(adminClient),
    checkN8n(),
    checkPythonRunner(),
    checkMessaging(adminClient),
  ]);

  const status = publicStatus(components);

  return jsonResponse({
    ok: status !== "issue",
    status,
    checked_at: new Date().toISOString(),
    components,
  });
});
