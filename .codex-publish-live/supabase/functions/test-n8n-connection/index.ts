import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const N8N_BASE_URL = Deno.env.get("N8N_BASE_URL") || "";
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!N8N_BASE_URL || !N8N_API_KEY) {
    return errorResponse("Missing N8N_BASE_URL or N8N_API_KEY Supabase secret.", 500);
  }

  try {
    const url = `${N8N_BASE_URL.replace(/\/$/, "")}/api/v1/workflows?limit=1`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "X-N8N-API-KEY": N8N_API_KEY,
      },
    });

    const text = await response.text();

    let data: unknown = null;

    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      return errorResponse("n8n API test failed.", response.status, {
        status: response.status,
        response: data,
      });
    }

    return jsonResponse({
      ok: true,
      message: "Nexus can connect to n8n.",
      n8n_base_url: N8N_BASE_URL,
      response: data,
    });
  } catch (error) {
    return errorResponse(error.message || "Could not reach n8n.", 500);
  }
});