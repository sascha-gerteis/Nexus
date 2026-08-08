[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$Destination,

  [string]$CommitMessage = "Update site",

  [switch]$ForceWithLease
)

$ErrorActionPreference = "Stop"

function Resolve-Directory([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "$Label directory does not exist: $PathValue"
  }

  return (Resolve-Path -LiteralPath $PathValue).Path.TrimEnd("\")
}

function Path-Contains([string]$Parent, [string]$Child) {
  return $Child.StartsWith("$Parent\", [StringComparison]::OrdinalIgnoreCase)
}

$sourcePath = Resolve-Directory $Source "Source"
$destinationPath = Resolve-Directory $Destination "Destination"

if ($sourcePath.Equals($destinationPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Source and destination must be different directories."
}

if ((Path-Contains $sourcePath $destinationPath) -or (Path-Contains $destinationPath $sourcePath)) {
  throw "Source and destination must not be inside one another. Use a separate sibling publish directory."
}

$destinationGit = Join-Path $destinationPath ".git"
if (-not (Test-Path -LiteralPath $destinationGit)) {
  throw "Destination is not the Nexus Git checkout: $destinationPath"
}

$origin = (& git -C $destinationPath remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -notmatch "sascha-gerteis/Nexus(?:\.git)?$") {
  throw "Destination origin is not sascha-gerteis/Nexus: $origin"
}

Write-Host "Publishing from: $sourcePath"
Write-Host "Publishing to:   $destinationPath"

# Preserve only the Git repository and its existing custom-domain file.
Get-ChildItem -Force -LiteralPath $destinationPath |
  Where-Object { $_.Name -ne ".git" -and $_.Name -ne "CNAME" } |
  Remove-Item -Recurse -Force

$robocopyArguments = @(
  $sourcePath,
  $destinationPath,
  "/E",
  "/XD",
  ".git",
  "node_modules",
  ".codex-*",
  ".codex-backups",
  ".agents",
  ".p29",
  "nexus-phase1-final",
  "/XF",
  "CNAME",
  ".env",
  ".env.local",
  "dev-server.out.log",
  "dev-server.err.log",
  "*.pyc"
)

& robocopy @robocopyArguments
$robocopyExitCode = $LASTEXITCODE
if ($robocopyExitCode -ge 8) {
  throw "Robocopy failed with exit code $robocopyExitCode."
}

Push-Location $destinationPath
try {
  $forbiddenTracked = @(
    git ls-files |
      Where-Object {
        $_ -match "^(\.codex-|\.codex-backups/|\.agents/|\.p29/|nexus-phase1-final/|dev-server\.(out|err)\.log$)"
      }
  )
  if ($forbiddenTracked.Count -gt 0) {
    throw "Publishing stopped because local tooling files are tracked: $($forbiddenTracked[0..([Math]::Min(9, $forbiddenTracked.Count - 1))] -join ', ')"
  }

  git add -A
  if ($LASTEXITCODE -ne 0) { throw "git add failed." }

  git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "The staged publish contains whitespace errors." }

  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host "No site changes to publish."
    return
  }

  git commit -m $CommitMessage
  if ($LASTEXITCODE -ne 0) { throw "git commit failed." }

  if ($ForceWithLease) {
    git push --force-with-lease origin HEAD:main
  }
  else {
    git push origin HEAD:main
  }
  if ($LASTEXITCODE -ne 0) { throw "git push failed. The remote branch was not overwritten." }

  git fetch origin
  if ($LASTEXITCODE -ne 0) { throw "The push succeeded, but the final fetch failed." }
}
finally {
  Pop-Location
}
