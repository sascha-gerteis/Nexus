$ErrorActionPreference = 'Stop'
$root = 'C:\Users\sascha.g\Desktop\nexus-phase1-final'
$backup = Join-Path $root '.codex-backups'
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'pages\buyer\dashboard.html') -Destination (Join-Path $backup 'buyer-dashboard-before-exact-run-check-20260722.html') -Force
Copy-Item -LiteralPath (Join-Path $root 'supabase\functions\check-n8n-execution\index.ts') -Destination (Join-Path $backup 'check-n8n-execution-before-exact-run-check-20260722.ts') -Force

function Replace-One([string]$Text, [string]$Old, [string]$New, [string]$Label) {
  $count = ($Text.Split([string[]]@($Old), [System.StringSplitOptions]::None)).Count - 1
  if ($count -ne 1) { throw "$Label expected exactly one match, found $count" }
  return $Text.Replace($Old, $New)
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$dashPath = Join-Path $root 'pages\buyer\dashboard.html'
$dash = [System.IO.File]::ReadAllText($dashPath)
$old = @'
  const meta = outputRuntimeMeta(output);
  if (attemptItem.output_id) {
    return String(output.id) === String(attemptItem.output_id);
  }

  const outputItemId = String(output.bundle_run_item_id || meta.bundleRunItemId || "");
  const outputAttemptId = String(output.bundle_run_attempt_id || meta.bundleAttemptId || "");
  const outputRunId = String(output.automation_run_id || meta.runId || "");
  const expectedRunId = String(attemptItem.automation_run_id || run?.id || "");

  return Boolean(
'@
$new = @'
  const meta = outputRuntimeMeta(output);
  const outputItemId = String(output.bundle_run_item_id || meta.bundleRunItemId || "");
  const outputAttemptId = String(output.bundle_run_attempt_id || meta.bundleAttemptId || "");
  const outputRunId = String(output.automation_run_id || meta.runId || "");
  const expectedRunId = String(attemptItem.automation_run_id || run?.id || "");

  if (attemptItem.output_id && String(output.id) !== String(attemptItem.output_id)) return false;

  return Boolean(
'@
$dash = Replace-One $dash $old $new 'strict output identity'
$dash = Replace-One $dash 'if (!user?.id || bundleStatusRefreshInFlight || bundleStatusRefreshCycles >= 20) return;' 'if (!user?.id || bundleStatusRefreshInFlight || bundleStatusRefreshCycles >= 180) return;' 'poll cycle limit'
$old = @'
          checks.set(customerAutomationId, {
            customer_automation_id: customerAutomationId,
            execution_id: exactRun.n8n_execution_id || undefined
          });
'@
$new = @'
          checks.set(String(exactRun.id), {
            customer_automation_id: customerAutomationId,
            run_id: exactRun.id,
            execution_id: exactRun.n8n_execution_id || undefined,
            bundle_run_attempt_id: attempt.id,
            bundle_run_item_id: attemptItem.id
          });
'@
$dash = Replace-One $dash $old $new 'exact check payload'
$dash = Replace-One $dash '      }, 6000);' '      }, 10000);' 'poll interval'
[System.IO.File]::WriteAllText($dashPath, $dash, $utf8)

$checkPath = Join-Path $root 'supabase\functions\check-n8n-execution\index.ts'
$check = [System.IO.File]::ReadAllText($checkPath)
$old = @'
    const { data: latestRun } = await adminClient
      .from("automation_runs")
      .select("id, status, n8n_execution_id, error_message, created_at, updated_at, started_at, finished_at, run_key, order_id, bundle_run_attempt_id, bundle_run_item_id, response_payload")
      .eq("customer_automation_id", customerAutomationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

'@
$new = @'
    const requestedRunId = cleanString(body.run_id || body.runId);
    const requestedBundleAttemptId = cleanString(body.bundle_run_attempt_id || body.bundleRunAttemptId);
    const requestedBundleRunItemId = cleanString(body.bundle_run_item_id || body.bundleRunItemId);
    let runQuery = adminClient
      .from("automation_runs")
      .select("id, status, n8n_execution_id, error_message, created_at, updated_at, started_at, finished_at, run_key, order_id, bundle_run_attempt_id, bundle_run_item_id, response_payload")
      .eq("customer_automation_id", customerAutomationId);

    runQuery = requestedRunId
      ? runQuery.eq("id", requestedRunId)
      : runQuery.order("created_at", { ascending: false }).limit(1);

    const { data: latestRun, error: latestRunError } = await runQuery.maybeSingle();

    if (latestRunError || (requestedRunId && !latestRun?.id)) {
      return errorResponse(latestRunError?.message || "The requested Nexus automation run was not found.", 404);
    }

    if (
      requestedBundleAttemptId &&
      cleanString(latestRun?.bundle_run_attempt_id) !== requestedBundleAttemptId
    ) {
      return errorResponse("The requested run does not belong to this bundle attempt.", 409);
    }

    if (
      requestedBundleRunItemId &&
      cleanString(latestRun?.bundle_run_item_id) !== requestedBundleRunItemId
    ) {
      return errorResponse("The requested run does not belong to this bundle workflow item.", 409);
    }

'@
$check = Replace-One $check $old $new 'exact run query'
$old = @'
    const explicitExecutionId = cleanString(
      body.execution_id ||
        body.executionId ||
        latestRun?.n8n_execution_id,
    );

    let execution: any = null;
'@
$new = @'
    const explicitExecutionId = cleanString(
      body.execution_id ||
        body.executionId ||
        latestRun?.n8n_execution_id,
    );

    if (
      (body.execution_id || body.executionId) &&
      latestRun?.n8n_execution_id &&
      cleanString(body.execution_id || body.executionId) !== cleanString(latestRun.n8n_execution_id)
    ) {
      return errorResponse("The requested n8n execution does not belong to this Nexus run.", 409);
    }

    let execution: any = null;
'@
$check = Replace-One $check $old $new 'exact execution guard'
[System.IO.File]::WriteAllText($checkPath, $check, $utf8)

Write-Output 'Exact bundle run patches applied.'
