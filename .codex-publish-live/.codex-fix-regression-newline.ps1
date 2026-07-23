$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '.codex-tmp-bundle-regression.js'
$content = [System.IO.File]::ReadAllText($path)
$bad = '  staleLinkedOutput: staleLinked.outputCount,`r`n  newestAttempt: newestAttempt?.id || null,'
$good = "  staleLinkedOutput: staleLinked.outputCount,$([Environment]::NewLine)  newestAttempt: newestAttempt?.id || null,"
if (-not $content.Contains($bad)) { throw 'Broken regression line not found.' }
[System.IO.File]::WriteAllText($path, $content.Replace($bad, $good), [System.Text.UTF8Encoding]::new($false))
Write-Output 'Fixed regression fixture newline.'
