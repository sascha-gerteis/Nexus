$ErrorActionPreference = 'Stop'

function Replace-Exact([string]$Path, [string]$Before, [string]$After) {
  $content = [System.IO.File]::ReadAllText($Path)
  if (-not $content.Contains($Before)) {
    throw "Expected source block was not found in $Path"
  }
  [System.IO.File]::WriteAllText($Path, $content.Replace($Before, $After), [System.Text.UTF8Encoding]::new($false))
}

$checker = Join-Path $PSScriptRoot 'supabase\functions\check-n8n-execution\index.ts'
$runtime = Join-Path $PSScriptRoot 'supabase\functions\runtime-submit-output\index.ts'

$oldTokens = @'
  const tokens = [
    runContext?.id,
    runContext?.run_key,
    runContext?.bundle_run_attempt_id,
    runContext?.bundle_run_item_id,
    responsePayload?.run_id,
    responsePayload?.runId,
    responsePayload?.run_key,
    responsePayload?.runKey,
    responsePayload?.bundle_run_attempt_id,
    responsePayload?.bundleRunAttemptId,
    responsePayload?.bundle_run_item_id,
    responsePayload?.bundleRunItemId,
  ]
'@
$newTokens = @'
  // Only the unique Nexus run identity may match an n8n execution. Bundle
  // attempt/item IDs can be shared by retries and are not proof of ownership.
  const tokens = [
    runContext?.id,
    runContext?.run_key,
    responsePayload?.run_id,
    responsePayload?.runId,
    responsePayload?.run_key,
    responsePayload?.runKey,
  ]
'@
Replace-Exact $checker $oldTokens $newTokens

$oldLookupStart = @'
async function findCallbackRunContext(adminClient: any, body: any, customerAutomationId: string) {
  const { runId, runKey } = callbackRunReference(body);

  if (runId || runKey) {
'@
$newLookupStart = @'
async function findCallbackRunContext(adminClient: any, body: any, customerAutomationId: string) {
  const { runId, runKey } = callbackRunReference(body);
  const explicitBundleReference = callbackBundleReference(body, null);

  if (runId || runKey) {
'@
Replace-Exact $runtime $oldLookupStart $newLookupStart

$oldBeforeFallback = @'
  const since = new Date(Date.now() - CALLBACK_RUN_MATCH_WINDOW_MS).toISOString();
'@
$newBeforeFallback = @'
  if (explicitBundleReference.bundleRunItemId || explicitBundleReference.bundleAttemptId) {
    let bundleQuery = adminClient
      .from("automation_runs")
      .select("id, run_key, customer_automation_id, buyer_id, automation_id, order_id, bundle_run_attempt_id, bundle_run_item_id, status, n8n_execution_id, created_at, updated_at, started_at, finished_at")
      .eq("customer_automation_id", customerAutomationId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (explicitBundleReference.bundleRunItemId) {
      bundleQuery = bundleQuery.eq("bundle_run_item_id", explicitBundleReference.bundleRunItemId);
    }
    if (explicitBundleReference.bundleAttemptId) {
      bundleQuery = bundleQuery.eq("bundle_run_attempt_id", explicitBundleReference.bundleAttemptId);
    }

    const { data, error } = await bundleQuery.maybeSingle();
    if (error) {
      console.warn("automation_runs bundle callback context lookup failed:", error.message);
    }
    return data?.id ? data : null;
  }

  const since = new Date(Date.now() - CALLBACK_RUN_MATCH_WINDOW_MS).toISOString();
'@
Replace-Exact $runtime $oldBeforeFallback $newBeforeFallback

$oldBundleGuard = @'
    if (isBundleRuntimeCallback && !hasExplicitRuntimeReference) {
      return errorResponse(
        "Bundle output callback is missing Nexus run identity. Sync/reprovision the Nexus Submit Output node so it sends run_id/run_key or bundle_run_attempt_id/bundle_run_item_id. Nexus will not guess bundle ownership from customer_automation_id alone.",
        409,
      );
    }

    const callbackOrderId = cleanString(
'@
$newBundleGuard = @'
    if (isBundleRuntimeCallback && !hasExplicitRuntimeReference) {
      return errorResponse(
        "Bundle output callback is missing Nexus run identity. Sync/reprovision the Nexus Submit Output node so it sends run_id/run_key or bundle_run_attempt_id/bundle_run_item_id. Nexus will not guess bundle ownership from customer_automation_id alone.",
        409,
      );
    }

    if (isBundleRuntimeCallback && !callbackRunContext?.id) {
      return errorResponse(
        "Bundle output callback does not match an exact Nexus automation run. The output was rejected to prevent cross-purchase attribution.",
        409,
      );
    }

    const callbackOrderId = cleanString(
'@
Replace-Exact $runtime $oldBundleGuard $newBundleGuard

Write-Output 'Applied strict n8n run identity and bundle callback ownership patch.'
