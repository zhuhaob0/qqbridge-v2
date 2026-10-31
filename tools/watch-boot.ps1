# DSH boot CPU/IO timeline profiler (ASCII only)
# Started via WMI (parent = WmiPrvSE) so it survives DSH restarts.
# Logs every second: total CPU seconds of all DSH processes, process count,
# new child processes, and the moment the window becomes visible.

$log = 'E:\Code\qqbridge-v2\state\dsh-boot.log'
$lastPid = 0

function Write-Log([string]$text) {
  Add-Content -Path $log -Value ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $text) -Encoding UTF8
}

while ($true) {
  $main = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
  if ($main -and $main.Id -ne $lastPid) {
    $lastPid = $main.Id
    $t0 = $main.StartTime
    Write-Log ('=== boot pid={0} at {1}' -f $main.Id, $t0.ToString('HH:mm:ss.fff'))
    $seen = @{}
    $elapsed = 0
    $windowAt = -1
    while ($elapsed -lt 150) {
      Start-Sleep -Seconds 1
      $elapsed += 1
      $procs = Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue
      $cpu = 0.0
      $mem = 0.0
      foreach ($p in $procs) {
        try { $cpu += $p.CPU } catch {}
        try { $mem += ($p.WorkingSet64 / 1MB) } catch {}
      }
      $win = $null
      foreach ($p in $procs) { if ($p.MainWindowHandle -ne 0) { $win = $p.Id; break } }
      if ($win -and $windowAt -lt 0) {
        $windowAt = $elapsed
        Write-Log ('  +{0}s  WINDOW VISIBLE (pid {1})  cpu={2:N1}s mem={3:N0}MB procs={4}' -f $elapsed, $win, $cpu, $mem, $procs.Count)
      } else {
        Write-Log ('  +{0}s  cpu={1:N1}s mem={2:N0}MB procs={3}' -f $elapsed, $cpu, $mem, $procs.Count)
      }
      $new = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $main.Id -and -not $seen.ContainsKey($_.ProcessId) }
      foreach ($n in $new) {
        $seen[$n.ProcessId] = $true
        $c = $n.CommandLine
        if (-not $c) { $c = '' }
        if ($c.Length -gt 90) { $c = $c.Substring(0, 90) }
        Write-Log ('  +{0}s  CHILD {1} {2}' -f $elapsed, $n.Name, $c)
      }
      if ($windowAt -gt 0 -and $elapsed -gt ($windowAt + 5)) { break }
    }
    Write-Log ('  === boot sampling done (window at +{0}s)' -f $windowAt)
  }
  Start-Sleep -Milliseconds 700
}
