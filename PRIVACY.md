# Privacy

Codex Message Trace Viewer is a local diagnostic tool. It does not provide a hosted service, user account system, analytics service, advertising service, or project-controlled telemetry endpoint.

## Data processed

The tool can capture and display Codex Desktop app-server traffic. Depending on the conversation and tools used, traces may contain prompts, generated responses, file contents, file paths, command output, tool arguments, identifiers, timestamps, and other locally processed diagnostic information.

## Data storage and network access

- The viewer and trace ingest service listen on `127.0.0.1` by default.
- Review data is stored locally under `%USERPROFILE%\.codex-trace` by default.
- The project does not upload collected traces to the project maintainers or to a project-operated service.
- The wrapper preserves the existing Codex Desktop communication path; use of Codex itself remains subject to the applicable OpenAI terms and privacy policies.

## User control

Users can stop the viewer, disable tracing, and remove locally stored trace data. Trace files should not be committed to source control or shared without reviewing and redacting their contents.

## Security reports

Privacy or security concerns can be reported through the repository's GitHub security advisory feature.
