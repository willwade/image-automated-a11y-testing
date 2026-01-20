Param(
  [Parameter(Mandatory = $true)]
  [string]$InputRoot,
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,
  [string]$SofficePath = "C:\Program Files\LibreOffice\program\soffice.exe",
  [int]$TimeoutSec = 45,
  [string]$LogPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $SofficePath)) {
  throw "LibreOffice not found at '$SofficePath'. Pass -SofficePath with the correct path."
}

if (-not (Test-Path $InputRoot)) {
  throw "Input root not found: $InputRoot"
}

$inputRootFull = (Resolve-Path $InputRoot).Path.TrimEnd("\", "/")
$outputRootFull = (Resolve-Path $OutputRoot -ErrorAction SilentlyContinue).Path
if (-not $outputRootFull) {
  New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
  $outputRootFull = (Resolve-Path $OutputRoot).Path.TrimEnd("\", "/")
}

$files = Get-ChildItem -Path $inputRootFull -Recurse -File -Include *.emf, *.wmf
Write-Host ("Converting {0} files..." -f $files.Count)

$logFile = $LogPath
if ([string]::IsNullOrWhiteSpace($logFile)) {
  $logFile = Join-Path $outputRootFull "conversion_errors.log"
}
if (Test-Path $logFile) {
  Remove-Item -Force $logFile
}

$profileDir = Join-Path $env:TEMP ("lo_profile_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

for ($i = 0; $i -lt $files.Count; $i++) {
  $file = $files[$i]
  $rel = $file.FullName.Substring($inputRootFull.Length).TrimStart("\", "/")
  $destDir = Join-Path $outputRootFull (Split-Path $rel -Parent)
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null

  Write-Host ("[{0}/{1}] {2}" -f ($i + 1), $files.Count, $file.FullName)

  $args = @(
    "--headless",
    ("-env:UserInstallation=file:///" + ($profileDir -replace "\\", "/")),
    "--convert-to",
    "png",
    "--outdir",
    $destDir,
    $file.FullName
  )

  $proc = Start-Process -FilePath $SofficePath -ArgumentList $args -PassThru -NoNewWindow
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    try { $proc.Kill() } catch {}
    Add-Content -Path $logFile -Value ("TIMEOUT: " + $file.FullName)
    continue
  }
  if ($proc.ExitCode -ne 0) {
    Add-Content -Path $logFile -Value ("EXIT " + $proc.ExitCode + ": " + $file.FullName)
  }
}

Write-Host "Done."
