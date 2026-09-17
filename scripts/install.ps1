[CmdletBinding()]
param(
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$SkipPluginInstall
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$marketplace = Join-Path $root ".agents\plugins\marketplace.json"
if (-not (Test-Path -LiteralPath $marketplace -PathType Leaf)) {
  throw "No marketplace manifest found at $marketplace"
}

$codex = Get-Command codex.exe -ErrorAction Stop
$state = $null
try {
  $raw = & $codex.Source plugin list --marketplace jev-orchestrator --available --json 2>$null
  if ($LASTEXITCODE -eq 0) {
    $state = $raw | ConvertFrom-Json
  }
} catch {
  $state = $null
}

$known = @($state.installed) + @($state.available) |
  Where-Object { $_.name -eq "jev-orchestrator" }
if (-not $known) {
  & $codex.Source plugin marketplace add $root
  if ($LASTEXITCODE -ne 0) {
    throw "Codex could not add the Jev Orchestrator marketplace."
  }
  $raw = & $codex.Source plugin list --marketplace jev-orchestrator --available --json
  if ($LASTEXITCODE -ne 0) {
    throw "Codex did not expose the Jev Orchestrator marketplace after adding it."
  }
  $state = $raw | ConvertFrom-Json
}

$installed = @($state.installed) | Where-Object { $_.name -eq "jev-orchestrator" }
if (-not $SkipPluginInstall -and -not $installed) {
  & $codex.Source plugin add "jev-orchestrator@jev-orchestrator"
  if ($LASTEXITCODE -ne 0) {
    throw "Codex could not install jev-orchestrator from its marketplace."
  }
}

Write-Host "Jev Orchestrator is installed. Start a new Codex thread to load the skill."
