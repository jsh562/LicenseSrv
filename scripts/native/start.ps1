#Requires -Version 5.1
<#
.SYNOPSIS
  Build, migrate, and serve the API natively (no Docker) on Windows. See docs/native-setup.md.

.DESCRIPTION
  WHY IT ALWAYS REBUILDS: `dist/` is committed to this repository, and committed build output goes stale
  whenever a change lands without a rebuild (it was several features behind when this script was written).
  The Docker path is immune - the image compiles from `src/` and `.dockerignore` excludes `dist/` - but the
  native path runs `dist/` DIRECTLY, so a stale tree would silently serve old code. `tsc` is incremental
  enough that rebuilding every time is the right trade against that class of bug.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\native\start.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$EnvFile = '.env.native'

function Write-Ok   { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[!] $m" -ForegroundColor Yellow }
function Die      { param($m) Write-Host "[!!] $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $EnvFile)) {
  Die "$EnvFile not found. Run setup first:  powershell -ExecutionPolicy Bypass -File scripts\native\setup.ps1"
}

# 1. Compile TypeScript and copy the wasm signer package into dist/ (see scripts/copy-wasm.mjs for why the
#    copy is a separate, mandatory step - without it the signer cannot load).
& npm run build:native
if ($LASTEXITCODE -ne 0) { Die 'build failed' }
Write-Ok 'build complete'

# 2. Re-check the port. Setup may have run hours ago and `docker compose up` since then, so the port
#    recorded in .env.native is not necessarily still free. On a collision we relocate, WRITE THE NEW VALUE
#    BACK, and say so loudly - a silently moved port is worse than a loud one, and persisting it is what
#    keeps migrate:native and the admin-ui dev proxy (which reads this same file) in agreement.
$wantedPort = '8080'
$m = Select-String -Path $EnvFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($m) { $wantedPort = $m.Matches[0].Groups[1].Value }

$actualPort = & node scripts/native/find-port.mjs $wantedPort
if ($LASTEXITCODE -ne 0) { Die "no free port near $wantedPort" }

if ($actualPort -ne $wantedPort) {
  # Rewrite only the PORT line so every other setting and comment in the file survives untouched.
  $rewritten = Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^PORT=') { "PORT=$actualPort" } else { $_ }
  }
  [System.IO.File]::WriteAllText((Join-Path $PWD $EnvFile), (($rewritten -join "`n") + "`n"))
  Write-Warn "port $wantedPort is in use - relocated to $actualPort (saved to $EnvFile)"
} else {
  Write-Ok "port $actualPort is free"
}

# 3. Migrations are a SEPARATE, GATED step and never run on app boot (DDR-004) - the same contract the
#    compose `migrate` job enforces.
& node "--env-file=$EnvFile" dist/server/db/migrate.js
if ($LASTEXITCODE -ne 0) { Die 'migrations failed' }
Write-Ok 'migrations applied'

# 4. Serve. `--import` preloads the tracing module so the OTel SDK can patch pg/fastify/http before the app
#    imports them (HINT-001). With OTEL_EXPORTER_OTLP_ENDPOINT empty this is nearly free: the SDK packages
#    are never loaded at all.
Write-Ok "starting API on http://127.0.0.1:$actualPort - Ctrl+C to stop"
& node "--env-file=$EnvFile" --import ./dist/server/observability/tracing.js dist/server/main.js
exit $LASTEXITCODE
