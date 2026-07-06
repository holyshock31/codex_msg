param(
  [string]$InstallRoot = "",
  [switch]$NoEnable,
  [switch]$NoStartViewer
)

$ErrorActionPreference = "Stop"

function Copy-CodexTraceItem {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -Path $Source)) {
    throw "Package item not found: $Source"
  }

  if ((Test-Path -Path $Source -PathType Container) -and (Test-Path -Path $Destination)) {
    $resolvedInstall = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $resolvedDestination = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
    if (-not $resolvedDestination.StartsWith($resolvedInstall, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to replace destination outside install root: $Destination"
    }
    Remove-Item -Path $Destination -Recurse -Force
  }

  $parent = Split-Path -Parent $Destination
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -Path $Source -Destination $Destination -Recurse -Force
}

function Assert-CodexTraceInstallDestination {
  param([Parameter(Mandatory = $true)][string]$Destination)

  $resolvedInstall = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $resolvedDestination = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
  $installPrefix = "$resolvedInstall\"
  if (
    -not $resolvedDestination.Equals($resolvedInstall, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $resolvedDestination.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Refusing to replace destination outside install root: $Destination"
  }
}

function Copy-CodexTraceDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$PreserveTopLevelNames = @()
  )

  if (-not (Test-Path -Path $Source -PathType Container)) {
    throw "Package directory not found: $Source"
  }

  Assert-CodexTraceInstallDestination -Destination $Destination
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  $preserve = @{}
  foreach ($name in $PreserveTopLevelNames) {
    $preserve[$name.ToLowerInvariant()] = $true
  }

  foreach ($item in Get-ChildItem -LiteralPath $Destination -Force) {
    if ($preserve.ContainsKey($item.Name.ToLowerInvariant())) {
      continue
    }
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
  }

  foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
    if ($preserve.ContainsKey($item.Name.ToLowerInvariant())) {
      continue
    }
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Destination $item.Name) -Recurse -Force
  }
}

function Copy-CodexTraceFileIfChanged {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$Label = ""
  )

  if ([string]::IsNullOrWhiteSpace($Label)) {
    $Label = Split-Path -Leaf $Destination
  }
  if (-not (Test-Path -Path $Source -PathType Leaf)) {
    throw "Package file not found: $Source"
  }

  $parent = Split-Path -Parent $Destination
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  if (Test-Path -Path $Destination -PathType Leaf) {
    try {
      $sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
      $destinationHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
      if ($sourceHash -eq $destinationHash) {
        Write-Host "$Label is already up to date."
        return
      }
    } catch {
      Write-Warning "Could not compare $Label before copying: $($_.Exception.Message)"
    }
  }

  try {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
    Write-Host "Updated $Label."
  } catch {
    throw "Cannot update $Label at $Destination. If Codex Desktop is running, quit Codex Desktop and rerun .\codex-trace.ps1 install. Original error: $($_.Exception.Message)"
  }
}

function Stop-CodexTraceViewer {
  param([Parameter(Mandatory = $true)][string]$Root)

  $viewerRoot = Join-Path $Root "codex-trace-viewer"
  $pidFile = Join-Path $viewerRoot "logs\viewer.pid"
  $viewerPort = if ($env:CODEX_TRACE_VIEWER_PORT) { [int]$env:CODEX_TRACE_VIEWER_PORT } else { 45123 }
  $ingestPort = if ($env:CODEX_TRACE_INGEST_PORT) { [int]$env:CODEX_TRACE_INGEST_PORT } else { 45124 }
  $processIds = @()

  if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $pidValue = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($pidValue -match '^\d+$') {
      $processIds += [int]$pidValue
    }
  }

  foreach ($port in @($viewerPort, $ingestPort)) {
    $connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      if ($connection.OwningProcess -and $connection.OwningProcess -ne 0) {
        $processIds += [int]$connection.OwningProcess
      }
    }
  }

  $processIds = @($processIds | Select-Object -Unique)
  if ($processIds.Count -eq 0) {
    return
  }

  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      continue
    }
    Write-Host "Stopping existing viewer process $processId ($($process.ProcessName))."
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}

$SourceRoot = (Resolve-Path $PSScriptRoot).Path
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:USERPROFILE "Documents\CodexTrace"
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$defaultRoot = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Documents\CodexTrace"))
$defaultRootLabel = "%USERPROFILE%\Documents\CodexTrace"

if ($InstallRoot -ne $defaultRoot) {
  Write-Warning "The default install path is: $defaultRootLabel"
  Write-Warning "A custom path may be restricted by Windows or organization security policy."
}

$packageWrapper = Join-Path $SourceRoot "bin\codex-trace-wrapper.exe"
$packageConfig = Join-Path $SourceRoot "bin\config.toml"
$sourceBuildWrapper = Join-Path $SourceRoot "codex-trace-wrapper\dist\codex-trace-wrapper.exe"
$sourceConfig = Join-Path $SourceRoot "codex-trace-wrapper\config.toml"
$releaseConfig = Join-Path $SourceRoot "tools\release-config.toml"
$wrapperSource = $null
if (Test-Path -Path $packageWrapper -PathType Leaf) {
  $wrapperSource = $packageWrapper
} elseif (Test-Path -Path $sourceBuildWrapper -PathType Leaf) {
  $wrapperSource = $sourceBuildWrapper
} else {
  throw "Wrapper executable not found. Expected bin\codex-trace-wrapper.exe in a release package, or codex-trace-wrapper\dist\codex-trace-wrapper.exe in a source checkout. Build the wrapper first."
}
$configSource = $null
if (Test-Path -Path $packageConfig -PathType Leaf) {
  $configSource = $packageConfig
} elseif (Test-Path -Path $sourceConfig -PathType Leaf) {
  $configSource = $sourceConfig
} elseif (Test-Path -Path $releaseConfig -PathType Leaf) {
  $configSource = $releaseConfig
} else {
  throw "Wrapper config not found. Expected bin\config.toml in a release package, or codex-trace-wrapper\config.toml in a source checkout."
}

Stop-CodexTraceViewer -Root $InstallRoot

$sameRoot = [string]::Equals($SourceRoot.TrimEnd('\'), $InstallRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
if (-not $sameRoot) {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  if (Test-Path -Path (Join-Path $SourceRoot "bin") -PathType Container) {
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "bin") | Out-Null
    Copy-CodexTraceFileIfChanged -Source $wrapperSource -Destination (Join-Path $InstallRoot "bin\codex-trace-wrapper.exe") -Label "wrapper executable"
  } else {
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "bin") | Out-Null
    Copy-CodexTraceFileIfChanged -Source $wrapperSource -Destination (Join-Path $InstallRoot "bin\codex-trace-wrapper.exe") -Label "wrapper executable"
  }
  Copy-CodexTraceDirectory -Source (Join-Path $SourceRoot "codex-trace-viewer") -Destination (Join-Path $InstallRoot "codex-trace-viewer") -PreserveTopLevelNames @("logs")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "codex-trace-wrapper") -Destination (Join-Path $InstallRoot "codex-trace-wrapper")
  Copy-CodexTraceFileIfChanged -Source $configSource -Destination (Join-Path $InstallRoot "bin\config.toml") -Label "wrapper config"
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "scripts") -Destination (Join-Path $InstallRoot "scripts")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "docs") -Destination (Join-Path $InstallRoot "docs")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "README.md") -Destination (Join-Path $InstallRoot "README.md")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "install.ps1") -Destination (Join-Path $InstallRoot "install.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "codex-trace.ps1") -Destination (Join-Path $InstallRoot "codex-trace.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "start.ps1") -Destination (Join-Path $InstallRoot "start.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "stop.ps1") -Destination (Join-Path $InstallRoot "stop.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "status.ps1") -Destination (Join-Path $InstallRoot "status.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "enable-desktop-trace.ps1") -Destination (Join-Path $InstallRoot "enable-desktop-trace.ps1")
  Copy-CodexTraceItem -Source (Join-Path $SourceRoot "disable-desktop-trace.ps1") -Destination (Join-Path $InstallRoot "disable-desktop-trace.ps1")
}

$wrapperPath = Join-Path $InstallRoot "bin\codex-trace-wrapper.exe"
$configPath = Join-Path $InstallRoot "bin\config.toml"
$traceScript = Join-Path $InstallRoot "codex-trace.ps1"
$enableScript = Join-Path $InstallRoot "scripts\enable-desktop-trace.ps1"

if (-not (Test-Path -Path $wrapperPath -PathType Leaf)) {
  Copy-CodexTraceFileIfChanged -Source $wrapperSource -Destination $wrapperPath -Label "wrapper executable"
}
Copy-CodexTraceFileIfChanged -Source $configSource -Destination $configPath -Label "wrapper config"
if (-not (Test-Path -Path $traceScript -PathType Leaf)) {
  throw "Main entry script not installed: $traceScript"
}

if (-not $NoEnable) {
  & $enableScript -InstallRoot $InstallRoot
}

if (-not $NoStartViewer) {
  & $traceScript start -InstallRoot $InstallRoot
}

Write-Host ""
Write-Host "Codex Trace installed at: $InstallRoot"
Write-Host "Viewer URL: http://127.0.0.1:45123/?v=chat-redesign"
Write-Host "Restart Codex Desktop after first install or after re-enabling trace."
