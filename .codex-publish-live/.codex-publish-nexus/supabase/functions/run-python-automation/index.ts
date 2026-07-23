import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";
const PYTHON_RUNNER_URL = (Deno.env.get("PYTHON_RUNNER_URL") || "").replace(/\/+$/, "");
const PYTHON_RUNNER_SECRET = Deno.env.get("PYTHON_RUNNER_SECRET") || "";

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function numberValue(value: unknown, fallback = 120) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(5, Math.min(300, Math.round(parsed)));
}

function boolValue(value: unknown) {
  if (typeof value === "boolean") return value;
  const normalized = cleanString(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function runtimeSecretFrom(req: Request, body: Record<string, any>) {
  return cleanString(req.headers.get("x-nexus-runtime-secret")) ||
    cleanString(asObject(body.system).runtime_secret) ||
    cleanString(body.runtime_secret);
}

function callbackUrlFrom(body: Record<string, any>) {
  return cleanString(body.callback_url) ||
    cleanString(asObject(body.system).callback_url) ||
    `${SUPABASE_URL}/functions/v1/runtime-submit-output`;
}

async function fetchAutomation(adminClient: any, automationId: string) {
  const { data, error } = await adminClient
    .from("automations")
    .select(`
      id,
      title,
      slug,
      status,
      runtime_type,
      workflow_source_platform,
      python_script_code,
      python_requirements,
      python_entrypoint,
      python_runtime_version,
      python_timeout_seconds
    `)
    .eq("id", automationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return errorResponse("POST required.", 405);
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Supabase service configuration is missing.", 500);
    }

    if (!PYTHON_RUNNER_URL || !PYTHON_RUNNER_SECRET) {
      return errorResponse("Python runner is not configured.", 500);
    }

    const body = asObject(await req.json().catch(() => ({})));
    const incomingSecret = runtimeSecretFrom(req, body);

    if (!NEXUS_RUNTIME_SECRET || incomingSecret !== NEXUS_RUNTIME_SECRET) {
      return errorResponse("Invalid runtime secret.", 401);
    }

    const automationId = cleanString(body.automation_id || asObject(body.system).automation_id);
    if (!automationId) {
      return errorResponse("automation_id is required for Python automation runs.", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const automation = await fetchAutomation(adminClient, automationId);

    if (!automation?.id) {
      return errorResponse("Python automation product was not found.", 404);
    }

    const sourcePlatform = cleanString(automation.workflow_source_platform).toLowerCase();
    const runtimeType = cleanString(automation.runtime_type).toLowerCase();
    if (sourcePlatform !== "python" && runtimeType !== "python_runner") {
      return errorResponse("This automation is not configured for the Python runner.", 400);
    }

    const scriptCode = cleanString(automation.python_script_code);
    if (!scriptCode) {
      return errorResponse("This Python automation has no script saved.", 400);
    }

    const incomingSystem = asObject(body.system);
    const technicalTestOnly = boolValue(body.technical_test_only) || boolValue(incomingSystem.technical_test_only);

    const system = {
      ...asObject(body.system),
      automation_id: automation.id,
      automation_title: automation.title || "",
      automation_slug: automation.slug || "",
      runtime_type: "python_runner",
      technical_test_only: technicalTestOnly,
      callback_url: technicalTestOnly ? "" : callbackUrlFrom(body),
      runtime_secret: NEXUS_RUNTIME_SECRET,
    };

    const runnerPayload = {
      ...body,
      automation_id: automation.id,
      script_code: automation.python_script_code || "",
      requirements: automation.python_requirements || "",
      entrypoint: automation.python_entrypoint || "run",
      timeout_seconds: numberValue(automation.python_timeout_seconds),
      callback_url: system.callback_url,
      runtime_secret: NEXUS_RUNTIME_SECRET,
      system,
    };

    const response = await fetch(`${PYTHON_RUNNER_URL}/v1/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-python-runner-secret": PYTHON_RUNNER_SECRET,
      },
      body: JSON.stringify(runnerPayload),
    });

    const text = await response.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw_response: text };
    }

    if (!response.ok) {
      return errorResponse("Python runner request failed.", response.status, {
        runner_status: response.status,
        runner_response: data,
      });
    }

    return jsonResponse({
      ok: true,
      runtime_type: "python_runner",
      runner: data,
    });
  } catch (error) {
    return errorResponse((error as Error)?.message || "Python automation failed.", 500);
  }
});
