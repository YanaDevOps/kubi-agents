param(
  [string]$Target = "windows-amd64",
  [Parameter(Mandatory = $true)][string]$DownloadBaseUrl,
  [string]$ControlPlaneUrl,
  [string]$PairingToken,
  [switch]$Upgrade,
  [string]$InstallDir = "$env:ProgramData\KUBI\Agent"
)

$ErrorActionPreference = "Stop"

if ($Target -ne "windows-amd64") {
  throw "Unsupported Windows target: $Target"
}
if ($Upgrade -and ($ControlPlaneUrl -or $PairingToken)) {
  throw "-Upgrade preserves the existing agent identity and must not be combined with a pairing token."
}
if (-not $Upgrade -and (-not $ControlPlaneUrl -or -not $PairingToken)) {
  throw "A control-plane URL and one-time pairing token are required for the first installation."
}

$artifact = "kubi-agent-windows-amd64.exe"
$temp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("kubi-agent-" + [Guid]::NewGuid()))
$binary = Join-Path $temp.FullName "kubi-agent.exe"
$checksum = Join-Path $temp.FullName "kubi-agent.exe.sha256"
$installed = Join-Path $InstallDir "kubi-agent.exe"
$identity = Join-Path $InstallDir "identity.json"
$legacyIdentity = Join-Path $env:APPDATA "kubi-agent\config.json"
$backup = Join-Path $temp.FullName "kubi-agent.previous.exe"

try {
  Invoke-WebRequest -Uri "$DownloadBaseUrl/$artifact" -OutFile $binary
  Invoke-WebRequest -Uri "$DownloadBaseUrl/$artifact.sha256" -OutFile $checksum
  $expected = (Get-Content $checksum -Raw).Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[0].Trim()
  $actual = (Get-FileHash -Algorithm SHA256 $binary).Hash.ToLowerInvariant()
  if ($expected.ToLowerInvariant() -ne $actual) {
    throw "Checksum verification failed for $artifact."
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  if ($Upgrade -and -not (Test-Path $identity) -and (Test-Path $legacyIdentity)) {
    Copy-Item $legacyIdentity $identity
  }
  if ($Upgrade -and (-not (Test-Path $identity) -or -not (Test-Path $installed))) {
    throw "Update requires an existing agent identity and binary. Use a replacement pairing from KUBI instead."
  }

  $existing = Get-Service -Name "kubi-agent" -ErrorAction SilentlyContinue
  if ($Upgrade) {
    Copy-Item $installed $backup
    if ($existing) { Stop-Service -Name "kubi-agent" -Force -ErrorAction SilentlyContinue }
  }
  Copy-Item $binary $installed -Force
  if (-not $Upgrade) {
    & $installed pair --identity-file $identity --control-plane-url $ControlPlaneUrl --pairing-token $PairingToken
  }

  if ($existing) {
    sc.exe delete "kubi-agent" | Out-Null
    Start-Sleep -Seconds 1
  }

  New-Service -Name "kubi-agent" -BinaryPathName "`"$installed`" run --identity-file `"$identity`"" -DisplayName "KUBI Agent" -StartupType Automatic | Out-Null
  try {
    Start-Service -Name "kubi-agent"
  } catch {
    if ($Upgrade -and (Test-Path $backup)) {
      Copy-Item $backup $installed -Force
      Start-Service -Name "kubi-agent" -ErrorAction SilentlyContinue
    }
    throw "The updated agent did not start; the previous binary was restored."
  }
  $verb = if ($Upgrade) { "Updated" } else { "Installed" }
  Write-Host "$verb and started Windows service kubi-agent."
  & $installed version
} finally {
  Remove-Item $temp.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
