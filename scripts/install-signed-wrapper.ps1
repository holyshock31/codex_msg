[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SignedArtifactDirectory,

  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

$ErrorActionPreference = "Stop"

$artifactRoot = (Resolve-Path -LiteralPath $SignedArtifactDirectory).Path
$signedFiles = @(
  Get-ChildItem -LiteralPath $artifactRoot -Recurse -File -Filter "codex-trace-wrapper.exe"
)

if ($signedFiles.Count -ne 1) {
  throw "Expected exactly one signed codex-trace-wrapper.exe in '$artifactRoot', found $($signedFiles.Count)."
}

$signedPath = $signedFiles[0].FullName
$verifyScript = Join-Path $PSScriptRoot "verify-authenticode.ps1"

& $verifyScript -Path $signedPath -RequireTimestamp | Format-List

$destinationFullPath = [System.IO.Path]::GetFullPath($DestinationPath)
$destinationDirectory = Split-Path -Parent $destinationFullPath
New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null

if (Test-Path -LiteralPath $destinationFullPath -PathType Leaf) {
  $unsignedHash = (Get-FileHash -LiteralPath $destinationFullPath -Algorithm SHA256).Hash
  $signedHash = (Get-FileHash -LiteralPath $signedPath -Algorithm SHA256).Hash
  if ($unsignedHash -eq $signedHash) {
    throw "The artifact returned by SignPath is identical to the unsigned wrapper."
  }
}

Copy-Item -LiteralPath $signedPath -Destination $destinationFullPath -Force
& $verifyScript -Path $destinationFullPath -RequireTimestamp | Format-List

Write-Host "Installed signed wrapper: $destinationFullPath"
