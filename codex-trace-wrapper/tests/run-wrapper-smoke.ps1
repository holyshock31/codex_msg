$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$wrapper = Join-Path $root "dist\codex-trace-wrapper.exe"
Push-Location $root
try {
  New-Item -ItemType Directory -Force -Path ".\dist" | Out-Null
  go build -trimpath -ldflags="-s -w" -o ".\dist\codex-trace-wrapper.exe" ".\cmd\codex-trace-wrapper"
} finally {
  Pop-Location
}

$traceDir = Join-Path $root "target\smoke-trace"
if (Test-Path -Path $traceDir) {
  Remove-Item -Path $traceDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $traceDir | Out-Null

$config = Join-Path $traceDir "config.toml"
$fake = Join-Path $root "tests\fake_app_server.js"
$node = (Get-Command node).Source
$daemonCapture = Join-Path $traceDir "daemon-events.ndjson"
$daemonPort = 45129

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $daemonPort)
$listener.Start()
$listenerTask = $listener.AcceptTcpClientAsync()

$configText = @"
real_codex = "$($node -replace '\\', '\\')"
trace_dir = "$($traceDir -replace '\\', '\\')"
daemon_url = "tcp://127.0.0.1:$daemonPort"
fallback_ndjson = false
queue_capacity = 100
reasoning_summary_override = "detailed"

[rewrite]
enable_experimental_raw_events = true
"@

try {
  [System.IO.File]::WriteAllText($config, $configText, [System.Text.UTF8Encoding]::new($false))

  $inputText = '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"smoke","version":"1.0.0"},"capabilities":{}}}' + "`n" + '{"id":2,"method":"thread/list"}' + "`n" + '{"id":3,"method":"turn/start","params":{"threadId":"test-thread","summary":"none","input":[]}}' + "`n" + '{"id":4,"method":"ping"}' + "`n"

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $wrapper
  $startInfo.Arguments = "`"$fake`" app-server --analytics-default-enabled"
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables["CODEX_TRACE_WRAPPER_CONFIG"] = $config

  $wrapperProcess = [System.Diagnostics.Process]::new()
  $wrapperProcess.StartInfo = $startInfo
  [void]$wrapperProcess.Start()
  $wrapperProcess.StandardInput.Write($inputText)
  $wrapperProcess.StandardInput.Close()

  $stdoutTask = $wrapperProcess.StandardOutput.ReadToEndAsync()
  $stderrTask = $wrapperProcess.StandardError.ReadToEndAsync()

  if (-not $wrapperProcess.WaitForExit(10000)) {
    Stop-Process -Id $wrapperProcess.Id -ErrorAction SilentlyContinue
    throw "Wrapper smoke test timed out."
  }

  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  [System.IO.File]::WriteAllText((Join-Path $traceDir "wrapper.out.log"), $stdout, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText((Join-Path $traceDir "wrapper.err.log"), $stderr, [System.Text.UTF8Encoding]::new($false))

  if ($wrapperProcess.ExitCode -ne 0) {
    throw "Wrapper smoke test failed with exit code $($wrapperProcess.ExitCode). Stderr: $stderr"
  }

  if ($stdout -notmatch '"ok":true') {
    throw "Wrapper stdout did not contain fake server responses. Output: $stdout"
  }
  if ($stdout -notmatch '"method":"turn/start"' -or $stdout -notmatch '"summary":"detailed"') {
    throw "Wrapper did not rewrite turn/start summary to detailed. Output: $stdout"
  }
  if ($stdout -notmatch '"experimentalApi":true') {
    throw "Wrapper did not inject initialize capabilities.experimentalApi=true. Output: $stdout"
  }
  if ($stdout -notmatch '"experimentalRawEvents":true') {
    throw "Wrapper did not inject turn/start experimentalRawEvents=true. Output: $stdout"
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not $listenerTask.IsCompleted -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 50
  }
  if (-not $listenerTask.IsCompleted) {
    throw "Trace daemon did not receive a connection."
  }

  $client = $listenerTask.Result
  try {
    $stream = $client.GetStream()
    $buffer = New-Object byte[] 65536
    $chunks = New-Object System.Collections.Generic.List[byte]
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
      while ($stream.DataAvailable) {
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) {
          break
        }
        for ($i = 0; $i -lt $read; $i++) {
          $chunks.Add($buffer[$i])
        }
      }
      $textSoFar = [System.Text.Encoding]::UTF8.GetString($chunks.ToArray())
      if ($textSoFar -match 'client_to_server' -and $textSoFar -match 'server_to_client') {
        break
      }
      Start-Sleep -Milliseconds 50
    }
    $contents = [System.Text.Encoding]::UTF8.GetString($chunks.ToArray())
    [System.IO.File]::WriteAllText($daemonCapture, $contents, [System.Text.UTF8Encoding]::new($false))
  } finally {
    $client.Close()
  }

  if ($contents -notmatch 'client_to_server') {
    throw "Trace does not contain client_to_server events"
  }
  if ($contents -notmatch 'server_to_client') {
    throw "Trace does not contain server_to_client events"
  }
  $sawRewrittenTrace = $false
  $sawRawEventsInitialize = $false
  $sawRawEventsTurnStart = $false
  foreach ($line in ($contents -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    $event = $line | ConvertFrom-Json
    if ($event.dir -ne "client_to_server") {
      continue
    }
    $raw = $event.raw | ConvertFrom-Json
    if ($raw.method -eq "initialize" -and $raw.params.capabilities.experimentalApi -eq $true) {
      $sawRawEventsInitialize = $true
    }
    if ($raw.method -eq "turn/start" -and $raw.params.summary -eq "detailed") {
      $sawRewrittenTrace = $true
    }
    if ($raw.method -eq "turn/start" -and $raw.params.experimentalRawEvents -eq $true) {
      $sawRawEventsTurnStart = $true
    }
  }
  if (-not $sawRewrittenTrace) {
    throw "Trace does not contain rewritten turn/start summary. Contents: $contents"
  }
  if (-not $sawRawEventsInitialize) {
    throw "Trace does not contain rewritten initialize experimentalApi=true. Contents: $contents"
  }
  if (-not $sawRawEventsTurnStart) {
    throw "Trace does not contain rewritten turn/start experimentalRawEvents=true. Contents: $contents"
  }

  $events = Join-Path $traceDir "events.ndjson"
  if (Test-Path -Path $events -PathType Leaf) {
    throw "events.ndjson should not be created when fallback_ndjson=false"
  }

  Write-Host "Wrapper smoke test passed."
  Write-Host "Daemon capture: $daemonCapture"
} finally {
  $listener.Stop()
}
