$ErrorActionPreference = 'Stop'

function Replace-Exact([string]$Path, [string]$Before, [string]$After) {
  $content = [System.IO.File]::ReadAllText($Path)
  if (-not $content.Contains($Before)) {
    throw "Expected source block was not found in $Path"
  }
  [System.IO.File]::WriteAllText($Path, $content.Replace($Before, $After), [System.Text.UTF8Encoding]::new($false))
}

$checker = Join-Path $PSScriptRoot 'supabase\functions\check-n8n-execution\index.ts'

$oldExecutionLookup = @'
    let execution: any = null;

    if (explicitExecutionId) {
      execution = await n8nFetch(`/api/v1/executions/${encodeURIComponent(explicitExecutionId)}?includeData=true`);
    } else {
      const workflowId = cleanString(
        body.workflow_id ||
          body.workflowId ||
          customerAutomation.n8n_workflow_id ||
          product.n8n_workflow_id,
      );

      if (!workflowId) {
        return errorResponse(
          "No n8n workflow ID found. Re-import the workflow or store n8n_workflow_id on the automation.",
          400,
        );
      }

      const executionMatch = await findExecutionForRunContext(workflowId, latestRun);

      if (!executionMatch.execution) {
        const now = new Date().toISOString();
        const message = "No n8n execution matched this exact Nexus run yet.";

        await runUpdateQuery(
          adminClient,
          customerAutomation.id,
          latestRun,
          "",
          {
            status: "running",
            updated_at: now,
            response_payload: {
              status: "waiting_for_matching_execution",
              message,
              inspected_executions: executionMatch.inspected,
              candidate_ids: executionMatch.candidate_ids,
            },
          },
        );

        await updateBundleRunItemFromRun(adminClient, latestRun, {
          status: "running",
          error_message: null,
          finished_at: null,
        });

        return jsonResponse({
          ok: true,
          status: "waiting_for_matching_execution",
          message,
          inspected_executions: executionMatch.inspected,
          candidate_ids: executionMatch.candidate_ids,
        });
      }

      execution = executionMatch.execution;
    }
'@

$newExecutionLookup = @'
    let execution: any = null;
    let rejectedStoredExecutionId = "";
    const exactRunIdentityRequired = Boolean(
      requestedRunId || latestRun?.bundle_run_attempt_id || latestRun?.bundle_run_item_id,
    );

    if (explicitExecutionId) {
      const storedExecution = await n8nFetch(
        `/api/v1/executions/${encodeURIComponent(explicitExecutionId)}?includeData=true`,
      );

      if (!exactRunIdentityRequired || executionMatchesRunContext(storedExecution, latestRun)) {
        execution = storedExecution;
      } else {
        // Older matcher versions could persist a nearby execution ID. Do not
        // trust it unless the execution payload proves the exact Nexus run.
        rejectedStoredExecutionId = explicitExecutionId;
      }
    }

    if (!execution) {
      const workflowId = cleanString(
        body.workflow_id ||
          body.workflowId ||
          customerAutomation.n8n_workflow_id ||
          product.n8n_workflow_id,
      );

      if (!workflowId) {
        return errorResponse(
          "No n8n workflow ID found. Re-import the workflow or store n8n_workflow_id on the automation.",
          400,
        );
      }

      const executionMatch = await findExecutionForRunContext(workflowId, latestRun);

      if (!executionMatch.execution) {
        const now = new Date().toISOString();
        const message = rejectedStoredExecutionId
          ? "The stored n8n execution belonged to a different Nexus run. Waiting for the exact execution."
          : "No n8n execution matched this exact Nexus run yet.";

        await runUpdateQuery(
          adminClient,
          customerAutomation.id,
          latestRun,
          "",
          {
            status: "running",
            n8n_execution_id: null,
            updated_at: now,
            response_payload: {
              status: "waiting_for_matching_execution",
              message,
              rejected_execution_id: rejectedStoredExecutionId || null,
              inspected_executions: executionMatch.inspected,
              candidate_ids: executionMatch.candidate_ids,
            },
          },
        );

        await updateBundleRunItemFromRun(adminClient, latestRun, {
          status: "running",
          output_id: null,
          error_message: null,
          finished_at: null,
        });

        return jsonResponse({
          ok: true,
          status: "waiting_for_matching_execution",
          message,
          rejected_execution_id: rejectedStoredExecutionId || null,
          inspected_executions: executionMatch.inspected,
          candidate_ids: executionMatch.candidate_ids,
        });
      }

      execution = executionMatch.execution;
    }
'@

Replace-Exact $checker $oldExecutionLookup $newExecutionLookup
Write-Output 'Applied poisoned execution-ID repair path.'
