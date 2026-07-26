$ErrorActionPreference = 'Stop'

function Replace-Exact([string]$Path, [string]$Before, [string]$After) {
  $content = [System.IO.File]::ReadAllText($Path)
  if (-not $content.Contains($Before)) {
    throw "Expected source block was not found in $Path"
  }
  [System.IO.File]::WriteAllText($Path, $content.Replace($Before, $After), [System.Text.UTF8Encoding]::new($false))
}

$dashboard = Join-Path $PSScriptRoot 'pages\buyer\dashboard.html'

$oldAttemptSelector = @'
function latestBundleAttemptForOrder(bundleAttempts = [], orderId = "", bundleId = "") {
  return (bundleAttempts || [])
    .filter(attempt => {
      if (!attempt?.id || String(attempt.order_id || "") !== String(orderId || "")) return false;
      return !bundleId || !attempt.bundle_id || String(attempt.bundle_id) === String(bundleId);
    })
    .sort((a, b) => latestTimestampMs(b?.created_at, b?.started_at, b?.updated_at) - latestTimestampMs(a?.created_at, a?.started_at, a?.updated_at))[0] || null;
}
'@
$newAttemptSelector = @'
function bundleAttemptSequenceMs(attempt = null) {
  // updated_at changes during polling and must never reorder purchases/runs.
  return timestampMs(attempt?.created_at) || timestampMs(attempt?.started_at) || timestampMs(attempt?.updated_at);
}

function latestBundleAttemptForOrder(bundleAttempts = [], orderId = "", bundleId = "") {
  return (bundleAttempts || [])
    .filter(attempt => {
      if (!attempt?.id || String(attempt.order_id || "") !== String(orderId || "")) return false;
      return !bundleId || !attempt.bundle_id || String(attempt.bundle_id) === String(bundleId);
    })
    .sort((a, b) => bundleAttemptSequenceMs(b) - bundleAttemptSequenceMs(a))[0] || null;
}
'@

Replace-Exact $dashboard $oldAttemptSelector $newAttemptSelector
Write-Output 'Applied stable bundle attempt ordering.'
