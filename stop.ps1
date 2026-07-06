$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "codex-trace.ps1") stop @args
