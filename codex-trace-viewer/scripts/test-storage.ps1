$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Port = if ($env:CODEX_TRACE_TEST_VIEWER_PORT) { [int]$env:CODEX_TRACE_TEST_VIEWER_PORT } else { 45223 }
$IngestPort = $Port + 1
$StorageDir = Join-Path $env:TEMP ("codex-trace-storage-test-" + [guid]::NewGuid().ToString("N"))
$Node = (Get-Command node -ErrorAction Stop).Source
$Process = $null

function Invoke-Json {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [string]$Method = "GET",
    [object]$Body = $null
  )

  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri
  }

  return Invoke-RestMethod `
    -Method $Method `
    -Uri $Uri `
    -Body ($Body | ConvertTo-Json -Depth 20 -Compress) `
    -ContentType "application/json"
}

function New-TraceEvent {
  param(
    [Parameter(Mandatory = $true)][int]$Seq,
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][hashtable]$Params
  )

  $raw = @{
    jsonrpc = "2.0"
    method = $Method
    params = $Params
  } | ConvertTo-Json -Depth 20 -Compress

  return @{
    schema = "codex-trace.v1"
    seq = $Seq
    ts_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $Seq
    dir = "server_to_client"
    source = "storage-smoke"
    raw = $raw
  }
}

try {
  New-Item -ItemType Directory -Force -Path $StorageDir | Out-Null

  $env:CODEX_TRACE_VIEWER_PORT = [string]$Port
  $env:CODEX_TRACE_INGEST_PORT = [string]$IngestPort
  $env:CODEX_TRACE_STORAGE_DIR = $StorageDir
  $env:CODEX_TRACE_STORAGE_FLUSH_MS = "200"
  $env:CODEX_TRACE_STORAGE_BATCH_EVENTS = "500"
  $env:CODEX_TRACE_STORAGE_BATCH_BYTES = "524288"
  $env:CODEX_TRACE_PRELOAD_NDJSON = "false"
  $env:CODEX_TRACE_STORAGE_PRELOAD = "false"

  $Process = Start-Process `
    -FilePath $Node `
    -ArgumentList @("server.js") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Milliseconds 800

  $Base = "http://127.0.0.1:$Port"
  $status = Invoke-Json -Uri "$Base/api/status"
  if (-not $status.storage.enabled) {
    throw "storage is not enabled"
  }

  $events = @()
  $events += New-TraceEvent -Seq 1 -Method "thread/started" -Params @{
    thread = @{
      id = "thread-main"
      sessionId = "session-root"
      name = "Storage smoke"
      preview = "persisted review"
      cwd = $Root.Path
    }
  }
  $events += New-TraceEvent -Seq 2 -Method "turn/started" -Params @{
    threadId = "thread-main"
    sessionId = "session-root"
    turnId = "turn-1"
    turn = @{ status = "running" }
  }
  for ($i = 3; $i -le 100; $i++) {
    $events += New-TraceEvent -Seq $i -Method "item/agentMessage/delta" -Params @{
      threadId = "thread-main"
      sessionId = "session-root"
      turnId = "turn-1"
      itemId = "msg-1"
      delta = "chunk-$i "
    }
  }
  $events += New-TraceEvent -Seq 101 -Method "turn/completed" -Params @{
    threadId = "thread-main"
    sessionId = "session-root"
    turnId = "turn-1"
    turn = @{ status = "completed"; durationMs = 1234 }
  }

  $ingest = Invoke-Json -Method "POST" -Uri "$Base/api/ingest" -Body $events
  if ($ingest.ingested -ne $events.Count) {
    throw "expected $($events.Count) ingested events, got $($ingest.ingested)"
  }

  Start-Sleep -Milliseconds 700
  $storage = Invoke-Json -Uri "$Base/api/storage?force=1"
  if ($storage.segmentCount -lt 1) {
    throw "expected at least one storage segment"
  }
  if ($storage.pendingEvents -ne 0) {
    throw "expected pendingEvents=0 after flush, got $($storage.pendingEvents)"
  }
  if ($storage.writtenEvents -lt $events.Count) {
    throw "expected at least $($events.Count) written events, got $($storage.writtenEvents)"
  }

  $conversations = Invoke-Json -Uri "$Base/api/conversations"
  if ($conversations.sessions.Count -lt 1) {
    throw "expected restored conversation model"
  }

  Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
  $Process = $null
  Start-Sleep -Milliseconds 500

  $env:CODEX_TRACE_STORAGE_PRELOAD = "true"
  $Process = Start-Process `
    -FilePath $Node `
    -ArgumentList @("server.js") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru
  Start-Sleep -Milliseconds 900

  $restored = Invoke-Json -Uri "$Base/api/status"
  if ($restored.totalRestored -lt $events.Count) {
    throw "expected startup restore to load events, got totalRestored=$($restored.totalRestored)"
  }

  $preview = Invoke-Json -Method "POST" -Uri "$Base/api/storage/cleanup" -Body @{
    keepDays = 0
    targetBytes = 1
    dryRun = $true
  }
  if ($preview.deletedSegments -lt 1) {
    throw "expected cleanup preview to find old segments"
  }

  $cleanup = Invoke-Json -Method "POST" -Uri "$Base/api/storage/cleanup" -Body @{
    keepDays = 0
    targetBytes = 1
    dryRun = $false
  }
  if ($cleanup.deletedSegments -ne $preview.deletedSegments) {
    throw "cleanup deleted $($cleanup.deletedSegments), preview expected $($preview.deletedSegments)"
  }

  [pscustomobject]@{
    ok = $true
    storageDir = $StorageDir
    writtenEvents = $storage.writtenEvents
    sizeBytes = $storage.sizeBytes
    restoredEvents = $restored.totalRestored
    deletedSegments = $cleanup.deletedSegments
    deletedBytes = $cleanup.deletedBytes
  } | ConvertTo-Json -Depth 5
} finally {
  if ($Process) {
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $StorageDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_VIEWER_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_INGEST_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_STORAGE_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_STORAGE_FLUSH_MS -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_STORAGE_BATCH_EVENTS -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_STORAGE_BATCH_BYTES -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_PRELOAD_NDJSON -ErrorAction SilentlyContinue
  Remove-Item Env:\CODEX_TRACE_STORAGE_PRELOAD -ErrorAction SilentlyContinue
}
