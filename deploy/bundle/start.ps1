# stubyard: load the image (first time only) and start it. Windows PowerShell.
# Run:  powershell -ExecutionPolicy Bypass -File .\start.ps1
#   -Reload                 load a newer image from stubyard-image.tar.gz
#   -Restore <backup.tgz>   restore a data backup into the devhub-data volume first (replaces existing stubyard data)
# Ports come from .env next to this script (STUBYARD_HTTP_PORT etc.), default 4000 / 4443 / 1025.
param([switch]$Reload, [string]$Restore)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Read STUBYARD_HTTP_PORT from .env (docker compose reads the same file).
$port = 4000
if (Test-Path .env) {
  foreach ($line in Get-Content .env) {
    if ($line -match '^\s*STUBYARD_HTTP_PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] }
  }
}

docker image inspect stubyard:latest *> $null
if ($LASTEXITCODE -ne 0 -or $Reload) {
  Write-Host "Loading stubyard image (one time, ~30 s)..."
  docker load -i stubyard-image.tar.gz
}

if ($Restore) {
  if (-not (Test-Path $Restore)) { throw "Backup file not found: $Restore" }
  $full = (Resolve-Path $Restore).Path
  $dir = Split-Path $full -Parent
  $file = Split-Path $full -Leaf
  Write-Host "Restoring $file into the devhub-data volume..."
  docker compose down 2>$null
  docker volume create devhub-data | Out-Null
  docker run --rm --user 0 --entrypoint sh -v devhub-data:/data -v "${dir}:/backup:ro" stubyard:latest -c "rm -rf /data/* && tar xzf /backup/$file -C /data && chown -R node:node /data"
  if ($LASTEXITCODE -ne 0) { throw "Restore failed" }
}

docker compose up -d
Write-Host -NoNewline "Waiting for stubyard"
for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-RestMethod "http://localhost:$port/api/system" -TimeoutSec 2 | Out-Null
    Write-Host ""; Write-Host "stubyard is running -> http://localhost:$port"; exit 0
  } catch { Write-Host -NoNewline "."; Start-Sleep -Seconds 1 }
}
Write-Host ""; Write-Host "stubyard did not respond on port $port; check: docker compose logs stubyard"; exit 1
