# Windows release signing

## Current state

Windows releases are currently not Authenticode-signed. The release workflow builds the wrapper on GitHub Actions and publishes the following verification material:

- SHA-256 checksum for `CodexTrace.zip`
- CycloneDX SBOM
- GitHub build provenance attestation

The GitHub Release notes must state that the wrapper is unsigned. Windows SmartScreen or organization security policy can warn about or block the executable even when the checksum and provenance are valid.

## SignPath Foundation result

The project applied to SignPath Foundation but was not accepted because it does not yet have enough external adoption and public visibility. No SignPath certificate or API token was issued, so the release workflow does not submit signing requests.

The repository retains the signature verification helper scripts for future use. They are not part of the active unsigned release path.

## Future trusted signing

A future signing solution must provide a publicly trusted Authenticode certificate, protected private-key storage, a trusted timestamp, and a practical release automation path. Candidate approaches include:

- reapplying to SignPath Foundation after the project has sustained public adoption
- a paid individual code-signing certificate with a cloud HSM service
- Microsoft Store MSIX distribution, where Microsoft signs the Store package

Self-signed certificates are not suitable for public GitHub downloads because Windows does not trust them by default.

## Release verification

Verify the downloaded ZIP against the published checksum:

```powershell
$expected = (Get-Content .\CodexTrace.zip.sha256).Split()[0]
$actual = (Get-FileHash .\CodexTrace.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected.ToLowerInvariant()) { throw "Checksum mismatch" }
```

Inspect the current wrapper signing state after extraction:

```powershell
Get-AuthenticodeSignature .\CodexTrace\bin\codex-trace-wrapper.exe |
  Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

For the current unsigned release path, `Status` is expected to be `NotSigned`.
