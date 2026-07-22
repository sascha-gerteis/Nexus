$ErrorActionPreference = 'Stop'
$path = 'C:\Users\sascha.g\Desktop\nexus-phase1-final\.codex-tmp-bundle-regression.js'
$text = [System.IO.File]::ReadAllText($path)
$text = $text.Replace('function scenario(statuses, withExactOutputs = true) {', 'function scenario(statuses, withExactOutputs = true, staleLinkedOutputs = false) {')
$text = $text.Replace('output_id: withExactOutputs ? `output-${index + 1}` : null,', 'output_id: withExactOutputs ? `${staleLinkedOutputs ? "old-" : ""}output-${index + 1}` : null,')
$text = $text.Replace('const running = scenario(["running", "running", "running", "running"]);', "const running = scenario([`"running`", `"running`", `"running`", `"running`"]);`r`nconst staleLinked = scenario([`"success`", `"cancelled`", `"cancelled`", `"cancelled`"], true, true);")
$text = $text.Replace('  runningEarlyOutput: running.outputCount,', "  runningEarlyOutput: running.outputCount,`r`n  staleLinkedOutput: staleLinked.outputCount,")
[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
Write-Output 'Stale bundle output regression case added.'
