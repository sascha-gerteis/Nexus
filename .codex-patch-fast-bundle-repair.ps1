$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot 'pages\buyer\dashboard.html'
$content = [System.IO.File]::ReadAllText($path)
$before = '      }, 10000);'
$after = '      }, bundleStatusRefreshCycles === 0 ? 1200 : 10000);'
$anchor = '    function scheduleTrackedBundleStatusRefresh(user) {'
$start = $content.IndexOf($anchor)
if ($start -lt 0) { throw 'Bundle refresh function not found.' }
$end = $content.IndexOf('    async function loadBuyerDashboardRecords(user) {', $start)
if ($end -lt 0) { throw 'Bundle refresh function end not found.' }
$block = $content.Substring($start, $end - $start)
if (-not $block.Contains($before)) { throw 'Bundle refresh timer line not found.' }
$updatedBlock = $block.Replace($before, $after)
$content = $content.Substring(0, $start) + $updatedBlock + $content.Substring($end)
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
Write-Output 'Applied fast initial bundle reconciliation.'
