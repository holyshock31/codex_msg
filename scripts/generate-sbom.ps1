param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$Version = "0.0.0"
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$GoRoot = Join-Path $Root "codex-trace-wrapper"
$ViewerPackagePath = Join-Path $Root "codex-trace-viewer\package.json"

$packageHash = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash.ToUpperInvariant()
$viewerPackage = Get-Content -LiteralPath $ViewerPackagePath -Raw | ConvertFrom-Json
$components = @(
  [ordered]@{
    type = "application"
    "bom-ref" = "pkg:golang/codex-trace-wrapper@$Version"
    name = "codex-trace-wrapper"
    version = $Version
    purl = "pkg:golang/codex-trace-wrapper@$Version"
    licenses = @(@{ license = @{ id = "MIT" } })
  },
  [ordered]@{
    type = "application"
    "bom-ref" = "pkg:npm/$($viewerPackage.name)@$($viewerPackage.version)"
    name = $viewerPackage.name
    version = $viewerPackage.version
    purl = "pkg:npm/$($viewerPackage.name)@$($viewerPackage.version)"
    licenses = @(@{ license = @{ id = "MIT" } })
    properties = @(@{ name = "codex:node-engine"; value = [string]$viewerPackage.engines.node })
  },
  [ordered]@{
    type = "file"
    "bom-ref" = "artifact:CodexTrace.zip@$Version"
    name = "CodexTrace.zip"
    version = $Version
    hashes = @(@{ alg = "SHA-256"; content = $packageHash })
  }
)

Push-Location $GoRoot
try {
  $moduleLines = @(& go list -m -f '{{if not .Main}}{{.Path}}|{{.Version}}|{{if .Replace}}{{.Replace.Path}}{{end}}|{{if .Replace}}{{.Replace.Version}}{{end}}{{end}}' all)
  if ($LASTEXITCODE -ne 0) {
    throw "go list failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

foreach ($line in $moduleLines) {
  if ([string]::IsNullOrWhiteSpace($line)) {
    continue
  }
  $fields = @($line -split '\|', 4)
  if ($fields.Count -ne 4) {
    throw "unexpected go module row: $line"
  }
  $modulePath = if ([string]::IsNullOrWhiteSpace($fields[2])) { $fields[0] } else { $fields[2] }
  $moduleVersion = if ([string]::IsNullOrWhiteSpace($fields[3])) { $fields[1] } else { $fields[3] }
  if ([string]::IsNullOrWhiteSpace($moduleVersion)) {
    $moduleVersion = "unknown"
  }
  $purl = "pkg:golang/$modulePath@$moduleVersion"
  $components += [ordered]@{
    type = "library"
    "bom-ref" = $purl
    name = $modulePath
    version = $moduleVersion
    purl = $purl
  }
}

$bom = [ordered]@{
  bomFormat = "CycloneDX"
  specVersion = "1.5"
  serialNumber = "urn:uuid:$([guid]::NewGuid())"
  version = 1
  metadata = [ordered]@{
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    tools = @{
      components = @([ordered]@{
        type = "application"
        name = "CodexTrace SBOM generator"
        version = "1"
      })
    }
    component = [ordered]@{
      type = "application"
      "bom-ref" = "pkg:github/holyshock31/codex_msg@$Version"
      group = "holyshock31"
      name = "codex_msg"
      version = $Version
      purl = "pkg:github/holyshock31/codex_msg@$Version"
      licenses = @(@{ license = @{ id = "MIT" } })
    }
  }
  components = $components
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent)) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
[System.IO.File]::WriteAllText(
  $OutputPath,
  ($bom | ConvertTo-Json -Depth 20),
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "SBOM created: $OutputPath"
