[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [switch]$RequireTimestamp
)

$ErrorActionPreference = "Stop"

$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
$signature = Get-AuthenticodeSignature -FilePath $resolvedPath

if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode signature is not valid for '$resolvedPath': $($signature.Status) - $($signature.StatusMessage)"
}

if ($null -eq $signature.SignerCertificate) {
  throw "Authenticode signature for '$resolvedPath' does not include a signer certificate."
}

$codeSigningOid = "1.3.6.1.5.5.7.3.3"
$hasCodeSigningEku = $false
foreach ($extension in $signature.SignerCertificate.Extensions) {
  if ($extension.Oid.Value -ne "2.5.29.37") {
    continue
  }

  foreach ($usage in $extension.EnhancedKeyUsages) {
    if ($usage.Value -eq $codeSigningOid) {
      $hasCodeSigningEku = $true
      break
    }
  }
}

if (-not $hasCodeSigningEku) {
  throw "Signer certificate for '$resolvedPath' does not include the Code Signing EKU."
}

if ($RequireTimestamp -and $null -eq $signature.TimeStamperCertificate) {
  throw "Authenticode signature for '$resolvedPath' does not include a trusted timestamp."
}

[pscustomobject]@{
  Path = $resolvedPath
  Status = $signature.Status.ToString()
  SignerSubject = $signature.SignerCertificate.Subject
  SignerThumbprint = $signature.SignerCertificate.Thumbprint
  SignerNotAfter = $signature.SignerCertificate.NotAfter
  TimestampSubject = if ($signature.TimeStamperCertificate) {
    $signature.TimeStamperCertificate.Subject
  } else {
    $null
  }
}
