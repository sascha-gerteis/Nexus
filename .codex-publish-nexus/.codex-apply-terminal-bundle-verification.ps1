$ErrorActionPreference = 'Stop'
$root = 'C:\Users\sascha.g\Desktop\nexus-phase1-final'
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Replace-One([string]$Text, [string]$Old, [string]$New, [string]$Label) {
  $count = ($Text.Split([string[]]@($Old), [System.StringSplitOptions]::None)).Count - 1
  if ($count -ne 1) { throw "$Label expected exactly one match, found $count" }
  return $Text.Replace($Old, $New)
}

$dashPath = Join-Path $root 'pages\buyer\dashboard.html'
$dash = [System.IO.File]::ReadAllText($dashPath)
$dash = Replace-One $dash @'
    let bundleStatusRefreshTimer = null;
    let bundleStatusRefreshInFlight = false;
    let bundleStatusRefreshCycles = 0;
'@ @'
    let bundleStatusRefreshTimer = null;
    let bundleStatusRefreshInFlight = false;
    let bundleStatusRefreshCycles = 0;
    const bundleTerminalRunChecks = new Set();
'@ 'terminal check state'

$dash = Replace-One $dash @'
          const exactRun = exactBundleRunForItem(runs, attempt, attemptItem);
          if (!exactRun?.id || !bundleRunStatusIsActive(bundleItemEffectiveStatus(attemptItem, exactRun))) return;

          const globallyLatestRun = latestRunByAutomation.get(customerAutomationId);
'@ @'
          const exactRun = exactBundleRunForItem(runs, attempt, attemptItem);
          if (!exactRun?.id) return;

          const effectiveStatus = bundleItemEffectiveStatus(attemptItem, exactRun);
          const needsActiveRefresh = bundleRunStatusIsActive(effectiveStatus);
          const needsTerminalVerification = bundleRunStatusIsSuccess(effectiveStatus) && !bundleTerminalRunChecks.has(String(exactRun.id));
          if (!needsActiveRefresh && !needsTerminalVerification) return;

          const globallyLatestRun = latestRunByAutomation.get(customerAutomationId);
'@ 'terminal check selection'

$dash = Replace-One $dash @'
          await Promise.all(checks.map(payload =>
            NexusDB.checkN8nExecution(payload).catch(error => ({ error }))
          ));
'@ @'
          await Promise.all(checks.map(async payload => {
            try {
              const result = await NexusDB.checkN8nExecution(payload);
              if (payload.run_id && result && !result.error) {
                bundleTerminalRunChecks.add(String(payload.run_id));
              }
              return result;
            } catch (error) {
              return { error };
            }
          }));
'@ 'terminal check recording'
[System.IO.File]::WriteAllText($dashPath, $dash, $utf8)

$checkPath = Join-Path $root 'supabase\functions\check-n8n-execution\index.ts'
$check = [System.IO.File]::ReadAllText($checkPath)
$check = Replace-One $check @'
  await updateBundleRunItemFromRun(adminClient, bundleContext, {
    status: failureStatus,
    error_message: classification.customer_message || errorMessage,
'@ @'
  await updateBundleRunItemFromRun(adminClient, bundleContext, {
    status: failureStatus,
    output_id: null,
    error_message: classification.customer_message || errorMessage,
'@ 'clear failed bundle output link'
[System.IO.File]::WriteAllText($checkPath, $check, $utf8)

Write-Output 'Terminal bundle verification patch applied.'
