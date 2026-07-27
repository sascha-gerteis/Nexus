$ErrorActionPreference = 'Stop'

function Replace-Exact([string]$Path, [string]$Before, [string]$After) {
  $content = [System.IO.File]::ReadAllText($Path)
  if (-not $content.Contains($Before)) {
    throw "Expected source block was not found in $Path"
  }
  [System.IO.File]::WriteAllText($Path, $content.Replace($Before, $After), [System.Text.UTF8Encoding]::new($false))
}

$dashboard = Join-Path $PSScriptRoot 'pages\buyer\dashboard.html'
$runtime = Join-Path $PSScriptRoot 'supabase\functions\runtime-submit-output\index.ts'

$oldDashboardMap = @'
      const latestRunByAutomation = new Map();

      runs
        .slice()
        .sort((a, b) => latestTimestampMs(b?.created_at, b?.started_at, b?.updated_at) - latestTimestampMs(a?.created_at, a?.started_at, a?.updated_at))
        .forEach(run => {
          const key = String(run?.customer_automation_id || "");
          if (key && !latestRunByAutomation.has(key)) latestRunByAutomation.set(key, run);
        });

'@
Replace-Exact $dashboard $oldDashboardMap ''

$oldLatestOnly = @'
          const globallyLatestRun = latestRunByAutomation.get(customerAutomationId);
          if (!globallyLatestRun?.id || String(globallyLatestRun.id) !== String(exactRun.id)) return;

'@
Replace-Exact $dashboard $oldLatestOnly ''

$oldCallback = @'
    if (error) {
      console.warn("automation_runs callback context lookup failed:", error.message);
    } else if (data?.id) {
      return data;
    }
  }

  const since = new Date(Date.now() - CALLBACK_RUN_MATCH_WINDOW_MS).toISOString();
'@
$newCallback = @'
    if (error) {
      console.warn("automation_runs callback context lookup failed:", error.message);
    } else if (data?.id) {
      return data;
    }

    // Explicit Nexus run identity is authoritative. Never attach this callback
    // to a nearby run if the referenced row cannot be found.
    return null;
  }

  const since = new Date(Date.now() - CALLBACK_RUN_MATCH_WINDOW_MS).toISOString();
'@
Replace-Exact $runtime $oldCallback $newCallback

Write-Output 'Applied exact bundle verification and callback fail-closed patch.'
