(function () {
  "use strict";

  const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "get", "give", "how", "i", "in", "into", "is", "it", "me", "my", "of", "on", "or", "our", "should", "that", "the", "their", "them", "this", "to", "too", "us", "we", "what", "when", "where", "with", "would", "you", "your"
  ]);

  const DOMAIN_GROUPS = {
    reporting: ["report", "reporting", "summary", "dashboard", "brief", "insight", "analysis", "analytics", "kpi", "performance"],
    competitor: ["competitor", "competition", "competitive", "benchmark", "market intelligence", "scrape website", "website scraper"],
    social: ["social", "instagram", "facebook", "linkedin", "tiktok", "meta", "post", "engagement", "listening", "mention", "sentiment"],
    sales: ["sales", "lead", "leads", "prospect", "prospecting", "apollo", "b2b", "decision maker", "outreach", "pipeline"],
    support: ["support", "inquiry", "inquiries", "customer question", "customer reply", "ticket", "helpdesk", "email response"],
    seo: ["seo", "rank", "ranking", "keyword", "search engine", "search position", "serp", "organic traffic"],
    advertising: ["ad", "ads", "advertising", "campaign", "pixel", "roas", "paid media", "ad account"],
    website: ["website", "landing page", "conversion", "cro", "page audit", "web page", "site audit"],
    reputation: ["review", "reviews", "reputation", "rating", "google maps", "customer perspective"],
    jobs: ["job", "jobs", "hiring", "career", "vacancy", "recruiting", "job alert"],
    operations: ["operations", "workflow", "routing", "approval", "data entry", "spreadsheet", "sync", "notification", "alert", "monitor"]
  };

  const FREQUENCIES = {
    one_time: { label: "One-time", occurrences: 1 },
    daily: { label: "Daily", occurrences: 22 },
    weekly: { label: "Weekly", occurrences: 4 },
    monthly: { label: "Monthly", occurrences: 1 },
    event: { label: "Whenever new data arrives", occurrences: 30 }
  };

  const state = {
    products: [],
    bundles: [],
    catalogueReady: false,
    catalogueError: "",
    assessment: null,
    requestPrepared: false
  };

  function element(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    if (window.NexusUI?.escapeHtml) return NexusUI.escapeHtml(String(value ?? ""));
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
    })[character]);
  }

  function asArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (!value) return [];
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch (_) {
        return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
      }
    }
    return [];
  }

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(value) {
    return [...new Set(normalize(value).split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token)))];
  }

  function domains(value) {
    const normalized = ` ${normalize(value)} `;
    return Object.entries(DOMAIN_GROUPS)
      .filter(([, terms]) => terms.some((term) => normalized.includes(` ${normalize(term)} `)))
      .map(([name]) => name);
  }

  function itemFields(item) {
    const children = item.is_bundle ? asArray(item.bundle_products) : [];
    return {
      title: [item.title, ...children.map((child) => child.title)].filter(Boolean).join(" "),
      category: [item.category, item.badge, ...children.flatMap((child) => [child.category, child.badge])].filter(Boolean).join(" "),
      description: [item.short_description, item.description, ...children.map((child) => child.short_description)].filter(Boolean).join(" "),
      output: [...asArray(item.outputs), ...children.flatMap((child) => asArray(child.outputs))].join(" "),
      tools: [...asArray(item.required_tools), ...children.flatMap((child) => asArray(child.required_tools))].join(" "),
      audience: [...asArray(item.best_for), ...asArray(item.who_it_is_for), ...children.flatMap((child) => asArray(child.best_for))].join(" ")
    };
  }

  function scoreItem(item, answers) {
    const fields = itemFields(item);
    const query = [answers.task_problem, answers.current_process, answers.tools, answers.desired_output, answers.consequence].join(" ");
    const queryTokens = tokens(query);
    const itemText = Object.values(fields).join(" ");
    const itemTokens = new Set(tokens(itemText));
    const sharedTokens = queryTokens.filter((token) => itemTokens.has(token));
    const queryDomains = domains(query);
    const itemDomains = domains(itemText);
    const sharedDomains = queryDomains.filter((domain) => itemDomains.includes(domain));
    const weights = { title: 7, category: 6, description: 4, output: 6, tools: 5, audience: 2 };
    let score = 0;

    Object.entries(fields).forEach(([field, value]) => {
      const fieldTokens = new Set(tokens(value));
      const matches = queryTokens.filter((token) => fieldTokens.has(token)).length;
      score += Math.min(matches, 5) * weights[field];
    });

    score += sharedDomains.length * 10;
    const desired = normalize(answers.desired_output);
    if (desired.length > 3 && normalize(itemText).includes(desired)) score += 12;

    const accepted = (
      (sharedDomains.length >= 1 && sharedTokens.length >= 2 && score >= 22) ||
      (sharedDomains.length >= 2 && score >= 18) ||
      (sharedTokens.length >= 5 && score >= 30)
    );

    return {
      item,
      score,
      accepted,
      sharedDomains,
      sharedTokens,
      confidence: score >= 48 || sharedDomains.length >= 2 ? "Strong match" : "Good match"
    };
  }

  function readAnswers(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    return {
      ...data,
      occurrences: Math.max(1, Number(data.occurrences || 1)),
      minutes: Math.max(1, Number(data.minutes || 1)),
      people: Math.max(1, Number(data.people || 1)),
      hourly_cost: Math.max(0, Number(data.hourly_cost || 0))
    };
  }

  function assessReadiness(answers) {
    let score = 38;
    const cautions = [];
    if (String(answers.task_problem).length >= 40) score += 10;
    if (String(answers.current_process).length >= 30) score += 10;
    if (String(answers.tools).length >= 3) score += 8;
    if (String(answers.desired_output).length >= 5) score += 12;
    if (answers.frequency && answers.frequency !== "one_time") score += 8;
    if (answers.occurrences >= 4) score += 8;
    if (answers.human_review === "yes") cautions.push("Keep human approval before results are used or sent");
    if (answers.human_review === "unsure") cautions.push("Decide where human review is needed");
    if (answers.sensitive_data === "customer") {
      score -= 5;
      cautions.push("Confirm access and retention for customer data");
    }
    if (["financial", "health"].includes(answers.sensitive_data)) {
      score -= 14;
      cautions.push("Sensitive data requires a security and access review");
    }
    if (answers.sensitive_data === "unsure") {
      score -= 7;
      cautions.push("Identify sensitive data before implementation");
    }
    score = Math.max(25, Math.min(96, score));
    const band = score >= 75 ? "Strong automation candidate" : score >= 55 ? "Good candidate with scoping" : "Needs careful review";
    if (!cautions.length) cautions.push("Clear inputs and output make this easier to automate");
    return { score, band, cautions };
  }

  function formatNumber(value, digits = 1) {
    return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: digits });
  }

  function formatUsd(value) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function itemPrice(item) {
    try {
      return window.NexusUI?.money ? NexusUI.money(item) : "View pricing";
    } catch (_) {
      return "View pricing";
    }
  }

  function itemLinks(item) {
    const slug = encodeURIComponent(item.slug || "");
    if (item.is_bundle) {
      return {
        view: `/pages/marketplace?bundle=${slug}`,
        checkout: `/pages/checkout?bundle=${slug}&step=setup`
      };
    }
    return {
      view: `/pages/marketplace?product=${slug}`,
      checkout: `/pages/checkout?slug=${slug}&step=setup`
    };
  }

  function matchReason(match) {
    const labels = match.sharedDomains.slice(0, 3).map((domain) => domain.replace(/_/g, " "));
    if (labels.length) return `Matches your need around ${labels.join(", ")}.`;
    return `Matches ${match.sharedTokens.slice(0, 4).join(", ")} from your description.`;
  }

  function renderMetrics(answers, readiness) {
    const monthlyHours = answers.occurrences * answers.minutes * answers.people / 60;
    const monthlyCost = monthlyHours * answers.hourly_cost;
    const annualCost = monthlyCost * 12;
    const frequency = FREQUENCIES[answers.frequency]?.label || answers.frequency;
    element("finderMetrics").innerHTML = [
      ["Manual effort represented", `${formatNumber(monthlyHours)} hrs/mo`],
      ["Estimated manual cost", `${formatUsd(monthlyCost)}/mo`],
      ["Annual cost represented", `${formatUsd(annualCost)}/yr`],
      ["Current frequency", frequency]
    ].map(([label, value]) => `<article class="finder-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");

    element("finderReadiness").innerHTML = `
      <div class="finder-readiness-score">
        <div class="finder-score-ring" style="--score:${readiness.score}" data-score="${readiness.score}"></div>
        <div><strong>${escapeHtml(readiness.band)}</strong><span>Readiness score out of 100</span></div>
      </div>
      <div class="finder-cautions">${readiness.cautions.map((item, index) => `<span class="finder-caution${index === 0 && readiness.cautions.length === 1 ? " is-positive" : ""}">${escapeHtml(item)}</span>`).join("")}</div>`;
    return { monthlyHours, monthlyCost, annualCost };
  }

  function renderMatches(matches) {
    const grid = element("finderMatchGrid");
    grid.innerHTML = matches.map((match) => {
      const item = match.item;
      const links = itemLinks(item);
      const description = item.short_description || item.description || (item.is_bundle ? `${asArray(item.bundle_products).length} included workflows.` : "View the product for output and setup details.");
      return `
        <article class="finder-match">
          <div class="finder-match-top"><span class="finder-match-type">${item.is_bundle ? "Bundle" : "Automation"}</span><span class="finder-confidence">${escapeHtml(match.confidence)}</span></div>
          <h4>${escapeHtml(item.title || "Nexus automation")}</h4>
          <p>${escapeHtml(description)}</p>
          <div class="finder-match-why"><strong>Why it fits:</strong> ${escapeHtml(matchReason(match))}</div>
          <div class="finder-match-meta"><span>${escapeHtml(item.delivery_time || (item.is_bundle ? "Included workflows" : "See delivery details"))}</span><strong>${escapeHtml(itemPrice(item))}</strong></div>
          <div class="finder-match-actions">
            <a class="btn btn-secondary btn-small" data-finder-product-click="view" data-item-id="${escapeHtml(item.id || "")}" href="${links.view}">View details</a>
            <a class="btn btn-primary btn-small" data-finder-product-click="checkout" data-item-id="${escapeHtml(item.id || "")}" href="${links.checkout}">${item.is_bundle ? "Buy bundle" : "Buy product"}</a>
          </div>
        </article>`;
    }).join("");
  }

  function concise(value, fallback) {
    const cleaned = String(value || "")
      .replace(/^(i|we)\s+(want|need|would like)\s+(to\s+)?/i, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.!?]+$/, "");
    return (cleaned || fallback).split(" ").slice(0, 11).join(" ");
  }

  function requestTitle(answers) {
    const outcome = concise(answers.desired_output, "business workflow output");
    const prefix = answers.frequency === "daily" ? "Daily" : answers.frequency === "weekly" ? "Weekly" : answers.frequency === "monthly" ? "Monthly" : "Automated";
    return `${prefix} ${outcome}`.slice(0, 120);
  }

  function requestBrief(answers, metrics, readiness) {
    return [
      "AUTOMATION REQUEST",
      "",
      `Goal / problem: ${answers.task_problem}`,
      "",
      `Current process: ${answers.current_process}`,
      "",
      `Tools and data sources: ${answers.tools}`,
      `Required output or action: ${answers.desired_output}`,
      `Frequency: ${FREQUENCIES[answers.frequency]?.label || answers.frequency} (${answers.occurrences} times per month)`,
      `People and time: ${answers.people} person/people, ${answers.minutes} minutes each time`,
      `Estimated manual effort: ${formatNumber(metrics.monthlyHours)} hours per month`,
      `Estimated manual cost: ${formatUsd(metrics.monthlyCost)} per month`,
      `Impact when missed or wrong: ${answers.consequence || "Not provided"}`,
      `Human approval: ${answers.human_review}`,
      `Sensitive data: ${answers.sensitive_data}`,
      `Urgency: ${answers.urgency}`,
      "",
      `Initial readiness: ${readiness.band} (${readiness.score}/100)`,
      "",
      "ACCEPTANCE CHECK",
      "- Uses the listed tools or clearly explains any required alternative.",
      `- Produces: ${answers.desired_output}.`,
      "- Shows the buyer exactly what setup information and credentials are required.",
      "- Includes a testable success path and a clear failure/alert path."
    ].join("\n");
  }

  function prepareCustomRequest(reason) {
    const assessment = state.assessment;
    if (!assessment) return;
    const custom = element("finderCustom");
    const form = element("finderRequestForm");
    element("finderCustomReason").textContent = reason || "Nexus will not recommend a weak match. Review the generated title and brief, then send it directly to the Nexus team.";
    if (!state.requestPrepared) {
      form.elements.request_title.value = requestTitle(assessment.answers);
      form.elements.request_brief.value = requestBrief(assessment.answers, assessment.metrics, assessment.readiness);
      state.requestPrepared = true;
    }
    custom.hidden = false;
    custom.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function track(eventName, payload) {
    try {
      await window.NexusDB?.trackAnalyticsEvent?.(eventName, payload);
    } catch (error) {
      console.warn("Automation Finder analytics failed", error);
    }
  }

  async function loadCatalogue() {
    const status = element("finderCatalogueStatus");
    const [productResult, bundleResult] = await Promise.allSettled([
      window.NexusDB?.listLiveAutomations?.(),
      window.NexusDB?.listLiveBundles?.()
    ]);
    const productsResponse = productResult.status === "fulfilled" ? productResult.value : null;
    const bundlesResponse = bundleResult.status === "fulfilled" ? bundleResult.value : null;
    state.products = asArray(productsResponse?.data).filter((item) => String(item.listing_type || "").toLowerCase() !== "custom_request");
    state.bundles = asArray(bundlesResponse?.data);
    state.catalogueReady = state.products.length + state.bundles.length > 0;
    state.catalogueError = state.catalogueReady ? "" : "The live catalogue could not be loaded.";
    status.textContent = state.catalogueReady ? `${state.products.length + state.bundles.length} live options loaded` : "Live catalogue unavailable";
    status.classList.add(state.catalogueReady ? "is-ready" : "is-warning");
  }

  async function prefillBuyer() {
    const form = element("finderRequestForm");
    try {
      const { data: sessionData } = await NexusDB.getSession();
      const user = sessionData?.session?.user;
      if (!user) return;
      form.elements.email.value = user.email || "";
      if (typeof NexusDB.getCurrentBuyerAccount !== "function") return;
      const { data } = await NexusDB.getCurrentBuyerAccount();
      const buyer = data?.buyer_profile || {};
      form.elements.name.value = buyer.name || data?.profile?.full_name || user.user_metadata?.full_name || "";
      form.elements.company.value = buyer.company || "";
    } catch (_) {
      // Prefill is optional and must never block the public Finder.
    }
  }

  function handleAssessment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const answers = readAnswers(form);
    const readiness = assessReadiness(answers);
    const resultSection = element("finderResults");
    resultSection.hidden = false;
    element("finderCustom").hidden = true;
    state.requestPrepared = false;

    const candidates = state.catalogueReady
      ? [...state.products, ...state.bundles]
        .map((item) => scoreItem(item, answers))
        .filter((match) => match.accepted)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
      : [];
    const metrics = renderMetrics(answers, readiness);
    state.assessment = { answers, readiness, metrics, matches: candidates };

    const matchSection = element("finderMatches");
    if (candidates.length) {
      element("finderResultTitle").textContent = candidates.length === 1 ? "One credible live match found." : `${candidates.length} credible live matches found.`;
      element("finderResultSummary").textContent = "These are live Nexus products whose purpose and output overlap with your request. Review the product details before buying.";
      renderMatches(candidates);
      matchSection.hidden = false;
    } else {
      matchSection.hidden = true;
      element("finderResultTitle").textContent = "No exact live product match yet.";
      element("finderResultSummary").textContent = state.catalogueReady
        ? "Your need did not clear the confidence threshold for an existing product. Nexus will not guess or send you to an unrelated listing."
        : "The live catalogue could not be verified, so Nexus did not guess a product match. You can still send a structured request.";
      prepareCustomRequest(state.catalogueReady
        ? "No live product cleared the matching threshold. Review this generated scope and send it to Nexus without retyping your process."
        : "The live catalogue could not be verified. No product was guessed; you can still send this structured scope for review.");
    }

    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
    track("automation_finder_assessment", {
      metadata: {
        source: "automation_finder",
        catalogue_available: state.catalogueReady,
        match_count: candidates.length,
        top_product_slug: candidates[0]?.item?.slug || "",
        top_item_type: candidates[0]?.item?.is_bundle ? "bundle" : candidates.length ? "automation" : "none",
        readiness_band: readiness.band,
        readiness_score: readiness.score,
        estimated_monthly_hours: Math.round(metrics.monthlyHours * 10) / 10,
        estimated_monthly_cost_band: metrics.monthlyCost < 250 ? "under_250" : metrics.monthlyCost < 1000 ? "250_999" : metrics.monthlyCost < 5000 ? "1000_4999" : "5000_plus",
        frequency: answers.frequency,
        sensitive_data_band: answers.sensitive_data
      }
    });
  }

  async function handleRequest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity() || form.dataset.submitting === "true" || !state.assessment) return;
    const submitButton = form.querySelector("button[type='submit']");
    const originalText = submitButton.textContent;
    form.dataset.submitting = "true";
    submitButton.disabled = true;
    submitButton.textContent = "Sending...";
    const fields = Object.fromEntries(new FormData(form).entries());
    const payload = {
      name: fields.name || "",
      email: fields.email || "",
      company: fields.company || "",
      inquiry_type: "custom_automation",
      source: "automation_finder",
      subject: `Automation Finder request: ${fields.request_title}`,
      message: fields.request_brief,
      metadata: {
        finder_version: "1",
        generated_title: fields.request_title,
        assessment: {
          frequency: state.assessment.answers.frequency,
          occurrences: state.assessment.answers.occurrences,
          people: state.assessment.answers.people,
          minutes: state.assessment.answers.minutes,
          hourly_cost: state.assessment.answers.hourly_cost,
          human_review: state.assessment.answers.human_review,
          sensitive_data: state.assessment.answers.sensitive_data,
          urgency: state.assessment.answers.urgency,
          readiness_score: state.assessment.readiness.score,
          estimated_monthly_hours: Math.round(state.assessment.metrics.monthlyHours * 10) / 10,
          estimated_monthly_cost: Math.round(state.assessment.metrics.monthlyCost * 100) / 100
        }
      }
    };

    try {
      const submit = NexusDB.submitContactMessage || NexusDB.createContactMessage || NexusDB.createContact;
      if (typeof submit !== "function") throw new Error("Request service is unavailable.");
      const { error } = await submit(payload);
      if (error) throw error;
      element("finderRequestStatus").className = "finder-request-success";
      element("finderRequestStatus").textContent = "Request received. Nexus will review the scope and contact you at the email provided.";
      submitButton.textContent = "Request sent";
      await track("automation_finder_custom_request_submit", {
        metadata: {
          source: "automation_finder",
          readiness_score: state.assessment.readiness.score,
          estimated_monthly_hours: Math.round(state.assessment.metrics.monthlyHours * 10) / 10,
          frequency: state.assessment.answers.frequency
        }
      });
    } catch (error) {
      element("finderRequestStatus").textContent = error?.message || "Could not send the request. Please try again.";
      form.dataset.submitting = "false";
      submitButton.disabled = false;
      submitButton.textContent = originalText;
    }
  }

  function bindEvents() {
    const assessmentForm = element("automationFinderForm");
    const requestForm = element("finderRequestForm");
    const frequency = element("finderFrequency");
    const occurrences = element("finderOccurrences");
    assessmentForm.addEventListener("submit", handleAssessment);
    requestForm.addEventListener("submit", handleRequest);
    occurrences.addEventListener("input", () => { occurrences.dataset.edited = "true"; });
    frequency.addEventListener("change", () => {
      if (occurrences.dataset.edited !== "true" && FREQUENCIES[frequency.value]) {
        occurrences.value = FREQUENCIES[frequency.value].occurrences;
      }
    });
    element("finderEditButton").addEventListener("click", () => {
      element("finder-assessment").scrollIntoView({ behavior: "smooth", block: "start" });
      assessmentForm.elements.task_problem.focus({ preventScroll: true });
    });
    element("finderRequestInstead").addEventListener("click", () => prepareCustomRequest("The live matches were not exact enough for you. Review this generated scope and send it to Nexus."));
    element("finderMatchGrid").addEventListener("click", (event) => {
      const link = event.target.closest("[data-finder-product-click]");
      if (!link || !state.assessment) return;
      const match = state.assessment.matches.find((candidate) => String(candidate.item.id || "") === String(link.dataset.itemId || ""));
      track("automation_finder_product_click", {
        automation_id: match?.item?.is_bundle ? null : match?.item?.id || null,
        product_slug: match?.item?.slug || "",
        product_title: match?.item?.title || "",
        developer_id: match?.item?.developer_id || null,
        metadata: { source: "automation_finder", action: link.dataset.finderProductClick, item_type: match?.item?.is_bundle ? "bundle" : "automation" }
      });
    });
  }

  async function initialize() {
    bindEvents();
    track("automation_finder_start", { metadata: { source: "automation_finder" } });
    await Promise.allSettled([loadCatalogue(), prefillBuyer()]);
  }

  document.addEventListener("DOMContentLoaded", initialize);
  window.NexusAutomationFinder = { scoreItem, assessReadiness, requestTitle };
})();
