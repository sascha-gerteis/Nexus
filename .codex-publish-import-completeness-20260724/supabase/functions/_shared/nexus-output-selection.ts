function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function nodeParametersText(node: any) {
  try {
    return JSON.stringify(node?.parameters || {});
  } catch {
    return "";
  }
}

function normalizedNodeName(value: unknown) {
  return lower(value)
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isWebhookOrTriggerNode(node: any) {
  const type = lower(node?.type);
  return type.includes("webhook") || type.includes("trigger");
}

export function isExplicitNexusFinalOutputNode(node: any) {
  return normalizedNodeName(node?.name) === "nexus_final_output";
}

export function isIgnoredBuyerOutputNode(node: any) {
  const name = lower(node?.name);
  const type = lower(node?.type);

  return (
    !cleanString(node?.name) ||
    name === "nexus submit output" ||
    name === "nexus runtime context" ||
    name === "nexus runtime merge" ||
    name === "nexus webhook trigger" ||
    name.includes("sticky note") ||
    type.includes("stickynote") ||
    isWebhookOrTriggerNode(node)
  );
}

function outgoingMainTargets(connections: any, nodeName: string) {
  const groups = Array.isArray(connections?.[nodeName]?.main)
    ? connections[nodeName].main
    : [];

  return groups.flatMap((group: any) => (
    Array.isArray(group)
      ? group.map((connection: any) => cleanString(connection?.node)).filter(Boolean)
      : []
  ));
}

export function buyerOutputTerminalNames(nodes: any[], connections: any) {
  return (nodes || [])
    .filter((node: any) => (
      !isIgnoredBuyerOutputNode(node) &&
      outgoingMainTargets(connections, cleanString(node?.name))
        .every((target) => target === "Nexus Submit Output")
    ))
    .map((node: any) => cleanString(node?.name))
    .filter(Boolean);
}

function includesHtmlMarkup(text: string) {
  return (
    /<!doctype\s+html/i.test(text) ||
    /<html[\s>]/i.test(text) ||
    /<(?:body|main|section|article|table|div|h1|h2|p)[\s>]/i.test(text)
  );
}

export function scoreBuyerOutputCandidate(node: any, terminal = true) {
  const name = lower(node?.name);
  const type = lower(node?.type);
  const params = lower(nodeParametersText(node));
  let score = terminal ? 100 : 0;

  if (isExplicitNexusFinalOutputNode(node)) score += 10000;

  if (name.includes("buyer output") || name.includes("customer output")) score += 900;
  if (name.includes("final output") || name.includes("final report")) score += 850;
  if (name.includes("final")) score += 320;
  if (name.includes("report")) score += 260;
  if (name.includes("output")) score += 240;
  if (name.includes("result")) score += 180;
  if (name.includes("html")) score += 220;
  if (name.includes("preview")) score += 80;

  if (type.includes("html")) score += 600;
  if (type.includes("code") || type.includes("function")) score += 90;
  if (type.includes("converttofile") || type.includes("readwritefile")) score += 420;

  if (params.includes("content_html") || params.includes("contenthtml")) score += 850;
  if (params.includes("report_html") || params.includes("reporthtml")) score += 760;
  if (includesHtmlMarkup(params)) score += 700;
  if (params.includes("file_url") || params.includes("storage_path")) score += 520;
  if (params.includes("content_json") || params.includes("output_type")) score += 260;
  if (params.includes("title") && params.includes("summary")) score += 160;
  if (params.includes("content_text") || params.includes("output_text")) score += 90;

  /*
    Delivery/notification nodes are valid terminal nodes when they are the only
    result, but they must lose to a real report/HTML/file branch when both exist.
  */
  if (
    type.includes("gmail") ||
    type.includes("email") ||
    type.includes("smtp") ||
    type.includes("telegram") ||
    type.includes("slack") ||
    name.includes("send email") ||
    name.includes("notify")
  ) {
    score -= 500;
  }

  if (
    name.includes("debug") ||
    name.includes("log") ||
    name.includes("error handler") ||
    name.includes("credential") ||
    name.includes("config") ||
    name.includes("input")
  ) {
    score -= 450;
  }

  if (type.includes("httprequest") && !/(output|callback|submit|report)/i.test(name)) {
    score -= 80;
  }

  return score;
}

export function selectBuyerOutputNode(workflow: any) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const connections = workflow?.connections && typeof workflow.connections === "object"
    ? workflow.connections
    : {};

  const explicit = nodes.find(isExplicitNexusFinalOutputNode);
  if (explicit) {
    return {
      node: explicit,
      candidates: [{ name: cleanString(explicit.name), score: 10000, terminal: true }],
      ambiguous: false,
      reason: "explicit_nexus_final_output",
    };
  }

  const terminalNames = new Set(buyerOutputTerminalNames(nodes, connections));
  let candidates = nodes
    .filter((node: any) => terminalNames.has(cleanString(node?.name)))
    .map((node: any, index: number) => ({
      node,
      index,
      terminal: true,
      score: scoreBuyerOutputCandidate(node, true),
    }));

  if (!candidates.length) {
    candidates = nodes
      .filter((node: any) => !isIgnoredBuyerOutputNode(node))
      .map((node: any, index: number) => ({
        node,
        index,
        terminal: false,
        score: scoreBuyerOutputCandidate(node, false),
      }));
  }

  candidates.sort((left, right) => (
    right.score - left.score ||
    Number(right.node?.position?.[0] || 0) - Number(left.node?.position?.[0] || 0) ||
    right.index - left.index
  ));

  const first = candidates[0] || null;
  const second = candidates[1] || null;
  const ambiguous = Boolean(
    first &&
    second &&
    first.score < 700 &&
    first.score - second.score < 120
  );

  return {
    node: ambiguous ? null : first?.node || null,
    candidates: candidates.map((candidate) => ({
      name: cleanString(candidate.node?.name),
      score: candidate.score,
      terminal: candidate.terminal,
    })),
    ambiguous,
    reason: ambiguous
      ? "ambiguous_candidates"
      : first
        ? "scored_candidate"
        : "no_candidate",
  };
}

export function buildBuyerOutputBodyParameters() {
  return {
    parameters: [
      { name: "customer_automation_id", value: '={{ $("Nexus Runtime Context").first().json.system.customer_automation_id }}' },
      { name: "run_id", value: '={{ $("Nexus Runtime Context").first().json.system.run_id || "" }}' },
      { name: "run_key", value: '={{ $("Nexus Runtime Context").first().json.system.run_key || "" }}' },
      { name: "status", value: '={{ $json.status || $json.output?.status || $json.result?.status || "success" }}' },
      { name: "output_type", value: '={{ $json.output_type || $json.outputType || $json.output?.output_type || $json.result?.output_type || $json.report?.output_type || "report" }}' },
      { name: "title", value: '={{ $json.title || $json.report_title || $json.reportTitle || $json.output?.title || $json.result?.title || $json.report?.title || $json.data?.title || $json.name || "Automation output" }}' },
      { name: "summary", value: '={{ $json.summary || $json.description || $json.output?.summary || $json.result?.summary || $json.report?.summary || $json.data?.summary || "" }}' },
      { name: "content_html", value: '={{ $json.content_html || $json.contentHtml || $json.html || $json.HTML || $json.report_html || $json.reportHtml || $json.output?.content_html || $json.output?.contentHtml || $json.output?.html || $json.result?.content_html || $json.result?.html || $json.report?.content_html || $json.report?.html || $json.data?.content_html || $json.data?.html || ((typeof $json.output === "string" && /<[a-z][\\s\\S]*>/i.test($json.output)) ? $json.output : "") || ((typeof $json.result === "string" && /<[a-z][\\s\\S]*>/i.test($json.result)) ? $json.result : "") || "" }}' },
      { name: "content_text", value: '={{ $json.content_text || $json.contentText || $json.text || $json.markdown || $json.output_text || $json.outputText || $json.output?.content_text || $json.output?.text || $json.result?.content_text || $json.result?.text || $json.report?.content_text || $json.report?.text || $json.data?.content_text || $json.data?.text || ((typeof $json.output === "string" && !/<[a-z][\\s\\S]*>/i.test($json.output)) ? $json.output : "") || ((typeof $json.result === "string" && !/<[a-z][\\s\\S]*>/i.test($json.result)) ? $json.result : "") || "" }}' },
      { name: "file_url", value: '={{ $json.file_url || $json.fileUrl || $json.output?.file_url || $json.result?.file_url || $json.report?.file_url || $json.data?.file_url || "" }}' },
      { name: "storage_path", value: '={{ $json.storage_path || $json.storagePath || $json.output?.storage_path || $json.result?.storage_path || $json.report?.storage_path || $json.data?.storage_path || "" }}' },
      { name: "content_json", value: '={{ JSON.stringify($json.content_json || $json.contentJson || $json.output?.content_json || $json.result?.content_json || $json.report?.content_json || $json.json || $json.data || $json) }}' },
    ],
  };
}