# docconv — console launcher for the Document Converter CLI (spec F9).
#
# The packaged app is a GUI-subsystem executable: cmd/PowerShell neither wait
# for it nor see its output. Piping the native command's output forces
# PowerShell to hold the stdio pipes until the app exits, which relays
# stdout/stderr to this console and makes $LASTEXITCODE meaningful.
#
# Installed at <install>\resources\cli\docconv.ps1; the exe is two levels up.
$exe = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'DocumentConverter.exe'
if (-not (Test-Path $exe)) {
  Write-Error "DocumentConverter.exe not found at $exe"
  exit 1
}
& $exe convert @args 2>&1 | ForEach-Object { "$_" }
exit $LASTEXITCODE
