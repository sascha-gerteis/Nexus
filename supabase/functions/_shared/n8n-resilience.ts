const TRANSIENT_N8N_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class N8nUnavailableError extends Error {
  status: number;
  attempts: number;
  retryable = true;
  code = "N8N_TEMPORARILY_UNAVAILABLE";

  constructor(message: string, status = 0, attempts = 1) {
    super(message);
    this.name = "N8nUnavailableError";
    this.status = status;
    this.attempts = attempts;
  }
}

export function isTransientN8nStatus(status: number) {
  return TRANSIENT_N8N_STATUSES.has(Number(status || 0));
}

export function isN8nUnavailableError(error: unknown): error is N8nUnavailableError {
  return error instanceof N8nUnavailableError || (
    Boolean(error) &&
    typeof error === "object" &&
    (error as Record<string, unknown>).code === "N8N_TEMPORARILY_UNAVAILABLE"
  );
}

function retryDelay(attempt: number) {
  return Math.min(2500, 300 * (2 ** Math.max(0, attempt - 1)));
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMethod(method: string, retryMethods: string[]) {
  return retryMethods.map((value) => value.toUpperCase()).includes(method.toUpperCase());
}

export async function fetchN8nWithRetry(
  url: string,
  options: RequestInit = {},
  config: {
    attempts?: number;
    timeoutMs?: number;
    retryMethods?: string[];
    label?: string;
  } = {},
) {
  const method = String(options.method || "GET").toUpperCase();
  const attempts = Math.max(1, Math.min(Number(config.attempts || 4), 5));
  const timeoutMs = Math.max(1000, Math.min(Number(config.timeoutMs || 12000), 30000));
  const retryMethods = config.retryMethods || ["GET", "HEAD"];
  const canRetry = safeMethod(method, retryMethods);
  const label = String(config.label || "n8n").trim() || "n8n";
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      lastStatus = response.status;

      if (!isTransientN8nStatus(response.status)) return response;
      if (!canRetry || attempt >= attempts) {
        await response.body?.cancel().catch(() => undefined);
        throw new N8nUnavailableError(
          `${label} is temporarily unavailable (HTTP ${response.status}). Nexus preserved the current workflow and credentials; try again shortly.`,
          response.status,
          attempt,
        );
      }

      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (isN8nUnavailableError(error)) throw error;
      if (!canRetry || attempt >= attempts) {
        const detail = error instanceof DOMException && error.name === "AbortError"
          ? `timed out after ${timeoutMs}ms`
          : error instanceof Error ? error.message : "request failed";
        throw new N8nUnavailableError(
          `${label} is temporarily unavailable (${detail}). Nexus preserved the current workflow and credentials; try again shortly.`,
          lastStatus,
          attempt,
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    await wait(retryDelay(attempt));
  }

  throw new N8nUnavailableError(
    `${label} is temporarily unavailable. Nexus preserved the current workflow and credentials; try again shortly.`,
    lastStatus,
    attempts,
  );
}
