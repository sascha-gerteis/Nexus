$ErrorActionPreference = "Stop"

$checkerPath = Join-Path $PSScriptRoot "supabase/functions/check-n8n-execution/index.ts"
$checker = Get-Content -LiteralPath $checkerPath -Raw

$statusAnchor = @'
function getExecutionStatus(execution: any) {
  const status = cleanString(execution?.status).toLowerCase();
  if (status) return status;

  if (execution?.data?.resultData?.error || execution?.resultData?.error || execution?.error) {
    return "error";
  }

  if (execution?.finished === true && execution?.stoppedAt && !execution?.data?.resultData?.error) {
    return "success";
  }

  if (execution?.finished === false && execution?.stoppedAt) {
    return "error";
  }

  if (execution?.finished === false || !execution?.stoppedAt) {
    return "running";
  }

  return "unknown";
}
'@

$statusReplacement = $statusAnchor + @'

const EXECUTION_SUCCESS_STATUSES = new Set([
  "success",
  "succeeded",
  "completed",
  "complete",
]);

const EXECUTION_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "crashed",
  "canceled",
  "cancelled",
  "aborted",
  "stopped",
]);

const EXECUTION_ACTIVE_STATUSES = new Set([
  "running",
  "waiting",
  "new",
  "unknown",
  "queued",
  "pending",
]);
'@

if (-not $checker.Contains($statusAnchor)) {
  throw "Execution status anchor not found."
}
$checker = $checker.Replace($statusAnchor, $statusReplacement)

$branchAnchor = @'
    if (["error", "failed", "failure", "crashed", "canceled", "cancelled", "aborted"].includes(executionStatus)) {
      result = await applyExecutionFailure(adminClient, customerAutomation, execution, {
        runContext: latestRun,
      });
    } else if (["running", "waiting", "new", "unknown"].includes(executionStatus)) {
      result = await applyExecutionRunning(adminClient, customerAutomation, execution, {
        runContext: latestRun,
      });
    } else {
      result = await applyExecutionSuccess(adminClient, customerAutomation, execution, {
        forceRecover: body.force_recover === true || body.forceRecover === true,
        runContext: latestRun,
      });
    }
'@

$branchReplacement = @'
    if (EXECUTION_FAILURE_STATUSES.has(executionStatus)) {
      result = await applyExecutionFailure(adminClient, customerAutomation, execution, {
        runContext: latestRun,
      });
    } else if (EXECUTION_SUCCESS_STATUSES.has(executionStatus)) {
      result = await applyExecutionSuccess(adminClient, customerAutomation, execution, {
        forceRecover: body.force_recover === true || body.forceRecover === true,
        runContext: latestRun,
      });
    } else {
      // Never turn an unfamiliar n8n status into a successful customer output.
      // If n8n has stopped, fail closed and clear any provisional bundle output;
      // otherwise keep polling until n8n reports an explicit terminal status.
      if (execution?.stoppedAt && !EXECUTION_ACTIVE_STATUSES.has(executionStatus)) {
        execution = {
          ...execution,
          status: executionStatus || "stopped",
          error: execution?.error || {
            message: `n8n execution stopped with non-success status: ${executionStatus || "unknown"}.`,
          },
        };
        result = await applyExecutionFailure(adminClient, customerAutomation, execution, {
          runContext: latestRun,
        });
      } else {
        result = await applyExecutionRunning(adminClient, customerAutomation, execution, {
          runContext: latestRun,
        });
      }
    }
'@

if (-not $checker.Contains($branchAnchor)) {
  throw "Execution branch anchor not found."
}
$checker = $checker.Replace($branchAnchor, $branchReplacement)
Set-Content -LiteralPath $checkerPath -Value $checker -NoNewline

$runtimePath = Join-Path $PSScriptRoot "supabase/functions/runtime-submit-output/index.ts"
$runtime = Get-Content -LiteralPath $runtimePath -Raw
$brokenBlock = @'
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

'@
if (-not $runtime.Contains($brokenBlock)) {
  throw "Broken callback fallback block not found."
}
$runtime = $runtime.Replace($brokenBlock, "")
Set-Content -LiteralPath $runtimePath -Value $runtime -NoNewline

Write-Output "Patched explicit n8n terminal-state handling and callback ownership fallback."
