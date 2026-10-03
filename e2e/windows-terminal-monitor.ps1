param(
  [Parameter(Mandatory = $true)][string]$StopPath,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class OdentiaTerminalWindows
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static long[] VisibleHandles()
    {
        var handles = new List<long>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            Process process = null;
            try
            {
                process = Process.GetProcessById((int)processId);
                if (string.Equals(process.ProcessName, "WindowsTerminal", StringComparison.OrdinalIgnoreCase))
                    handles.Add(hWnd.ToInt64());
            }
            catch
            {
                // La ventana puede cerrarse entre EnumWindows y GetProcessById.
            }
            finally
            {
                if (process != null) process.Dispose();
            }
            return true;
        }, IntPtr.Zero);
        return handles.ToArray();
    }
}
"@

$baseline = [Collections.Generic.HashSet[long]]::new()
foreach ($handle in [OdentiaTerminalWindows]::VisibleHandles()) { [void]$baseline.Add($handle) }
$detected = [Collections.Generic.HashSet[long]]::new()
[IO.File]::WriteAllText($ReadyPath, "ready")

while (-not (Test-Path -LiteralPath $StopPath)) {
  foreach ($handle in [OdentiaTerminalWindows]::VisibleHandles()) {
    if (-not $baseline.Contains($handle)) { [void]$detected.Add($handle) }
  }
  Start-Sleep -Milliseconds 50
}

[IO.File]::WriteAllText($ReportPath, (ConvertTo-Json @($detected) -Compress))
