$Port = if ($env:CODEX_TRACE_VIEWER_PORT) { [int]$env:CODEX_TRACE_VIEWER_PORT } else { 45123 }
$connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -ErrorAction SilentlyContinue
$processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
$processes = foreach ($id in $processIds) {
  Get-Process -Id $id -ErrorAction SilentlyContinue
}

[pscustomobject]@{
  Url = "http://127.0.0.1:$Port"
  Listening = [bool]$connections
  ProcessIds = ($processIds -join ",")
  Processes = (($processes | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ",")
} | Format-List
