$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$proxyTrace = Join-Path $root "dist\codex-proxy-trace.exe"
Push-Location $root
try {
  New-Item -ItemType Directory -Force -Path ".\dist" | Out-Null
  go build -trimpath -ldflags="-s -w" -o ".\dist\codex-proxy-trace.exe" ".\cmd\codex-proxy-trace"
} finally {
  Pop-Location
}

$traceDir = Join-Path $root "target\proxy-smoke-trace"
if (Test-Path -Path $traceDir) {
  Remove-Item -Path $traceDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $traceDir | Out-Null

$fake = Join-Path $root "tests\fake_ws_proxy.js"
$node = (Get-Command node).Source
$daemonCapture = Join-Path $traceDir "daemon-events.ndjson"
$daemonPort = 45130

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $daemonPort)
$listener.Start()
$listenerTask = $listener.AcceptTcpClientAsync()

function New-ClientWebSocketFrame([string]$Text) {
  $payload = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $mask = [byte[]](0x11, 0x22, 0x33, 0x44)
  $header = New-Object System.Collections.Generic.List[byte]
  $header.Add(0x81)
  if ($payload.Length -lt 126) {
    $header.Add([byte](0x80 -bor $payload.Length))
  } elseif ($payload.Length -le 65535) {
    $header.Add(0xFE)
    $header.Add([byte](($payload.Length -shr 8) -band 0xFF))
    $header.Add([byte]($payload.Length -band 0xFF))
  } else {
    throw "Test payload too large."
  }
  foreach ($b in $mask) { $header.Add($b) }
  for ($i = 0; $i -lt $payload.Length; $i++) {
    $header.Add([byte]($payload[$i] -bxor $mask[$i % 4]))
  }
  return $header.ToArray()
}

try {
  $requestJson = '{"jsonrpc":"2.0","id":1,"method":"thread/list","params":{"threadId":"remote-thread"}}'
  $handshake = @"
GET / HTTP/1.1
Host: local
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
"@ -replace "`r?`n", "`r`n"
  $handshake = $handshake + "`r`n`r`n"
  $inputBytes = [System.Text.Encoding]::ASCII.GetBytes($handshake) + (New-ClientWebSocketFrame $requestJson)
  $inputPath = Join-Path $traceDir "proxy-input.bin"
  [System.IO.File]::WriteAllBytes($inputPath, $inputBytes)

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $proxyTrace
  $startInfo.Arguments = "--real-codex `"$node`" `"$fake`" app-server proxy"
  $startInfo.RedirectStandardInput = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = $root
  $startInfo.EnvironmentVariables["CODEX_TRACE_DIR"] = $traceDir
  $startInfo.EnvironmentVariables["CODEX_TRACE_DAEMON_URL"] = "tcp://127.0.0.1:$daemonPort"
  $startInfo.EnvironmentVariables["CODEX_TRACE_FALLBACK_NDJSON"] = "false"
  $startInfo.EnvironmentVariables["CODEX_TRACE_SOURCE"] = "remote"
  $startInfo.EnvironmentVariables["CODEX_TRACE_SOURCE_ID"] = "ssh:smoke:1"
  $startInfo.EnvironmentVariables["CODEX_TRACE_CONNECTION_ID"] = "smoke-connection"

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $startInfo.FileName = "cmd.exe"
  $startInfo.Arguments = "/c `"`"$proxyTrace`" --real-codex `"$node`" `"$fake`" app-server proxy < `"$inputPath`"`""
  [void]$process.Start()

  $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
  $stderrTask = $process.StandardError.ReadToEndAsync()

  if (-not $process.WaitForExit(10000)) {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    throw "Proxy trace smoke test timed out."
  }
  $stdoutTask.Wait(2000) | Out-Null
  $stderr = $stderrTask.Result
  [System.IO.File]::WriteAllText((Join-Path $traceDir "proxy.err.log"), $stderr, [System.Text.UTF8Encoding]::new($false))

  if ($process.ExitCode -ne 0) {
    throw "Proxy trace smoke test failed with exit code $($process.ExitCode). Stderr: $stderr"
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
      if ($textSoFar -match 'client_to_server' -and $textSoFar -match 'server_to_client' -and $textSoFar -match 'ssh:smoke:1') {
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
    throw "Trace does not contain client_to_server JSON-RPC events."
  }
  if ($contents -notmatch 'server_to_client') {
    throw "Trace does not contain server_to_client JSON-RPC events."
  }
  if ($contents -notmatch 'thread/list') {
    throw "Trace does not contain decoded client JSON-RPC method."
  }
  if ($contents -notmatch 'item/agentMessage/delta') {
    throw "Trace does not contain decoded server JSON-RPC method."
  }
  if ($contents -notmatch 'ssh:smoke:1') {
    throw "Trace does not contain remote source id."
  }

  Write-Host "Proxy trace smoke test passed."
  Write-Host "Daemon capture: $daemonCapture"
} finally {
  $listener.Stop()
}
