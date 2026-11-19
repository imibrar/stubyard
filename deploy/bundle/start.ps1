# devhub: load the image (first time only) and start it. Windows PowerShell.
# Run:  powershell -ExecutionPolicy Bypass -File .\start.ps1        (add -Reload to load a newer image)
param([switch]$Reload)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
docker image inspect devhub:latest *> $null
if ($LASTEXITCODE -ne 0 -or $Reload) {
  Write-Host "Loading devhub image (one time, ~30 s)..."
  docker load -i devhub-image.tar.gz
}
docker compose up -d
Write-Host -NoNewline "Waiting for devhub"
for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-RestMethod http://localhost:4000/api/system -TimeoutSec 2 | Out-Null
    Write-Host ""; Write-Host "devhub is running -> http://localhost:4000"; exit 0
  } catch { Write-Host -NoNewline "."; Start-Sleep -Seconds 1 }
}
Write-Host ""; Write-Host "devhub did not respond; check: docker compose logs devhub"; exit 1
