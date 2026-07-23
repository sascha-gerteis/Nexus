$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '.codex-tmp-bundle-regression.js'
$content = [System.IO.File]::ReadAllText($path)
$before = @'
const staleLinked = scenario(["success", "cancelled", "cancelled", "cancelled"], true, true);
const result = {
'@
$after = @'
const staleLinked = scenario(["success", "cancelled", "cancelled", "cancelled"], true, true);
const newestAttempt = context.latestBundleAttemptForOrder([
  {
    id: "attempt-old",
    order_id: "order-1",
    bundle_id: "bundle-1",
    created_at: iso("2026-07-21T09:00:00Z"),
    updated_at: iso("2026-07-22T12:00:00Z")
  },
  {
    id: "attempt-current",
    order_id: "order-1",
    bundle_id: "bundle-1",
    created_at: iso("2026-07-21T10:05:00Z"),
    updated_at: iso("2026-07-21T10:06:00Z")
  }
], "order-1", "bundle-1");
const result = {
'@
if (-not $content.Contains($before)) { throw 'Regression insertion point not found.' }
$content = $content.Replace($before, $after)
$content = $content.Replace('  staleLinkedOutput: staleLinked.outputCount,', '  staleLinkedOutput: staleLinked.outputCount,`r`n  newestAttempt: newestAttempt?.id || null,')
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
Write-Output 'Added bundle attempt ordering regression.'
