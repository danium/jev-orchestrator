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

$codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
if ($codexCommand) {
  $codexPath = $codexCommand.Source
} else {
  $localAppData = $env:LOCALAPPDATA
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
  }
  $codexBin = Join-Path $localAppData "OpenAI\Codex\bin"
  $codexPath = Get-ChildItem -LiteralPath $codexBin -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $codexPath) {
    throw "Could not find codex.exe on PATH or under $codexBin. Install or update the Codex desktop app first."
  }
}

$state = $null
try {
  $raw = & $codexPath plugin list --marketplace jev-orchestrator --available --json 2>$null
  if ($LASTEXITCODE -eq 0) {
    $state = $raw | ConvertFrom-Json
  }
} catch {
  $state = $null
}

$known = @($state.installed) + @($state.available) |
  Where-Object { $_.name -eq "jev-orchestrator" }
if (-not $known) {
  & $codexPath plugin marketplace add $root
  if ($LASTEXITCODE -ne 0) {
    throw "Codex could not add the Jev Orchestrator marketplace."
  }
  $raw = & $codexPath plugin list --marketplace jev-orchestrator --available --json
  if ($LASTEXITCODE -ne 0) {
    throw "Codex did not expose the Jev Orchestrator marketplace after adding it."
  }
  $state = $raw | ConvertFrom-Json
}

if (-not $SkipPluginInstall) {
  & $codexPath plugin add "jev-orchestrator@jev-orchestrator"
  if ($LASTEXITCODE -ne 0) {
    throw "Codex could not install jev-orchestrator from its marketplace."
  }
}

Write-Host "Jev Orchestrator is installed. Start a new Codex thread to load the skill."
