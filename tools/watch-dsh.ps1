# DSH startup profiler v3 (ASCII only)
# Captures per-boot: process start, HTTP port, window visibility (MainWindowHandle), new processes,
# and remote TCP connections made by DSH processes (to spot slow/failing network waits).

$log = 'E:\Code\qqbridge-v2\state\dsh-startup.log'
$lastPid = 0

function Write-Log([string]$text) {
  Add-Content -Path $log -Value ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $text) -Encoding UTF8
}

while ($true) {
  $main = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
  if ($main -and $main.Id -ne $lastPid) {
    $lastPid = $main.Id
    $t0 = $main.StartTime
    Write-Log ('=== new DSH pid={0} started {1}' -f $main.Id, $t0.ToString('HH:mm:ss.fff'))

    $seenProc = @{}
    $seenConn = @{}
    $portLogged = $false
    $windowLogged = $false
    $deadline = (Get-Date).AddSeconds(150)

    while ((Get-Date) -lt $deadline) {
      $delta = [int]((Get-Date) - $t0).TotalMilliseconds

      if (-not $portLogged) {
        $conns = Get-NetTCPConnection -State Listen -OwningProcess $main.Id -ErrorAction SilentlyContinue
        if ($conns) {
          Write-Log ('  +{0}ms  port {1} listening' -f $delta, ($conns | Select-Object -First 1).LocalPort)
          $portLogged = $true
        }
      }

      if (-not $windowLogged) {
        $w = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($w) {
          Write-Log ('  +{0}ms  WINDOW VISIBLE (pid {1})' -f $delta, $w.Id)
          $windowLogged = $true
        }
      }

      $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CreationDate -and $_.CreationDate -gt $t0.AddSeconds(-1) }
      foreach ($p in $procs) {
        if ($seenProc.ContainsKey($p.ProcessId)) { continue }
        $seenProc[$p.ProcessId] = $true
        $cmd = $p.CommandLine
        if (-not $cmd) { $cmd = '' }
        if ($cmd.Length -gt 100) { $cmd = $cmd.Substring(0, 100) }
        Write-Log ('  +{0}ms  PROC {1} {2}' -f $delta, $p.Name, $cmd)
      }

      $pids = (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue).Id
      if ($pids) {
        $tcps = Get-NetTCPConnection -ErrorAction SilentlyContinue |
          Where-Object { $pids -contains $_.OwningProcess -and $_.RemoteAddress -and $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1' }
        foreach ($t in $tcps) {
          $key = '' + $t.RemoteAddress + ':' + $t.RemotePort
          if ($seenConn.ContainsKey($key)) { continue }
          $seenConn[$key] = $true
          Write-Log ('  +{0}ms  NET {1}:{2} state={3}' -f $delta, $t.RemoteAddress, $t.RemotePort, $t.State)
        }
      }

      if ($windowLogged -and $portLogged -and $delta -gt 20000) { break }
      Start-Sleep -Milliseconds 400
    }
    Write-Log '  --- sampling finished ---'
  }
  Start-Sleep -Milliseconds 600
}
