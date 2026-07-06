$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "codex-trace.ps1") disable @args
