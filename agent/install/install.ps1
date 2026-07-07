param(
  [string]$Target = "windows-amd64",
  [Parameter(Mandatory = $true)][string]$DownloadBaseUrl,
  [Parameter(Mandatory = $true)][string]$ControlPlaneUrl,
  [Parameter(Mandatory = $true)][string]$PairingToken,
  [string]$InstallDir = "$env:ProgramData\KUBI\Agent"
)

$ErrorActionPreference = "Stop"

if ($Target -ne "windows-amd64") {
  throw "Unsupported Windows target: $Target"
}

$artifact = "kubi-agent-windows-amd64.exe"
$temp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("kubi-agent-" + [Guid]::NewGuid()))
$binary = Join-Path $temp.FullName "kubi-agent.exe"
$checksum = Join-Path $temp.FullName "kubi-agent.exe.sha256"

try {
  Invoke-WebRequest -Uri "$DownloadBaseUrl/$artifact" -OutFile $binary
  Invoke-WebRequest -Uri "$DownloadBaseUrl/$artifact.sha256" -OutFile $checksum
  $expected = (Get-Content $checksum -Raw).Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[0].Trim()
  $actual = (Get-FileHash -Algorithm SHA256 $binary).Hash.ToLowerInvariant()
  if ($expected.ToLowerInvariant() -ne $actual) {
    throw "Checksum verification failed for $artifact."
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $installed = Join-Path $InstallDir "kubi-agent.exe"
  Copy-Item $binary $installed -Force
  & $installed pair --control-plane-url $ControlPlaneUrl --pairing-token $PairingToken

  $existing = Get-Service -Name "kubi-agent" -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-Service -Name "kubi-agent" -ErrorAction SilentlyContinue
    sc.exe delete "kubi-agent" | Out-Null
    Start-Sleep -Seconds 1
  }

  New-Service -Name "kubi-agent" -BinaryPathName "`"$installed`" run" -DisplayName "KUBI Agent" -StartupType Automatic | Out-Null
  Start-Service -Name "kubi-agent"
  Write-Host "Installed and started Windows service kubi-agent."
} finally {
  Remove-Item $temp.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
