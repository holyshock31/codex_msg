# Windows release signing

## Current state

Release `v0.1.0` was published before Authenticode signing was configured. Future tag releases are configured to require a SignPath signing request and will fail before publication when the required SignPath settings are absent.

The release workflow signs `codex-trace-wrapper.exe`, verifies the Authenticode certificate and trusted timestamp, rebuilds the ZIP with the signed executable, and only then creates the checksum, SBOM, provenance attestation, and GitHub Release.

## SignPath Foundation application

The repository history has been purged by GitHub Support and the repository is public. Apply at <https://signpath.org/apply>.

Suggested project fields:

- Project Name: `Codex Message Trace Viewer`
- Repository URL: `https://github.com/holyshock31/codex_msg`
- Homepage URL: `https://github.com/holyshock31/codex_msg`
- Download URL: `https://github.com/holyshock31/codex_msg/releases`
- Privacy Policy URL: `https://github.com/holyshock31/codex_msg/blob/master/PRIVACY.md`
- Tagline: `A local trace viewer for understanding Codex Desktop app-server message flows.`
- Build System: `GitHub Actions`

Suggested description:

> Codex Message Trace Viewer is an MIT-licensed Windows diagnostic tool that passively copies Codex Desktop app-server traffic into a local viewer. It organizes protocol events by session, turn, and item so developers can inspect message details, timing, tool calls, and lifecycle events that are not fully shown in the standard desktop interface.

Suggested reputation statement:

> The project publishes source code and Windows releases on GitHub under the MIT License. Releases are built by GitHub Actions with automated Go tests, JavaScript syntax checks, Windows installation smoke tests, SHA-256 checksums, a CycloneDX SBOM, and GitHub build provenance attestations. The project is new and currently maintained by its repository owner.

The maintainer must personally provide their name and email address, accept the SignPath Foundation terms and data-processing consent, and complete any CAPTCHA or account verification.

## GitHub repository configuration

After SignPath approves the project, add these repository variables:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`

Add this repository secret:

- `SIGNPATH_API_TOKEN`

The API token must belong to a SignPath user with submitter permission for the configured signing policy. Never commit the token or certificate material to the repository.

## Release verification

After publishing a release, extract the package and verify the wrapper:

```powershell
Get-AuthenticodeSignature .\CodexTrace\bin\codex-trace-wrapper.exe |
  Format-List Status,SignerCertificate,TimeStamperCertificate
```

`Status` must be `Valid`, and both certificate fields must be present.
