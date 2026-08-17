#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for the NATIVE (no-Docker) path on Windows. See docs/native-setup.md.

.DESCRIPTION
  Creates the `licensesrv` role + database, fills in any missing secret files, and writes `.env.native`.
  The PowerShell counterpart of scripts/native/setup.sh — same steps, same guarantees:

   * DETECT, NEVER INSTALL. A PostgreSQL or Node install is a system-level change and stays the operator's
     decision; this script checks for them and prints instructions if absent.
   * IDEMPOTENT. Safe to re-run. Existing secrets and an existing role/database are left alone. It never
     regenerates secrets/custodian_shares, because the signing master key is envelope-encrypted under it
     and replacing it would orphan every provisioned signing key (see scripts/gen-custody.ts).
   * SHARES SECRETS WITH THE DOCKER PATH, so you generate once. Only DATABASE_URL differs, because Docker
     resolves the `db` hostname inside the compose network while a native run needs `localhost`.

.PARAMETER SuperUser
  PostgreSQL superuser to connect as. Defaults to `postgres`.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\native\setup.ps1
#>
[CmdletBinding()]
param(
  [string]$SuperUser = $(if ($env:PGSUPERUSER) { $env:PGSUPERUSER } else { 'postgres' }),
  [string]$PgHost    = $(if ($env:PGHOST)      { $env:PGHOST }      else { 'localhost' }),
  [int]   $PgPort    = $(if ($env:PGPORT)      { [int]$env:PGPORT }  else { 5432 })
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$DbName  = 'licensesrv'
$DbRole  = 'licensesrv'
$EnvFile = '.env.native'

function Write-Ok   { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "     $m" }
function Die        { param($m) Write-Host "[!!] $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== LicenseSrv native setup ===`n"

# --- 1. Prerequisites ------------------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die "node not found. Install Node.js >= 22 (https://nodejs.org)." }

$nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) { Die "Node $(& node -v) is too old - this project requires >= 22 (package.json engines)." }
Write-Ok "Node $(& node -v)"

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  Die @"
psql not found on PATH. Install PostgreSQL 16, then re-run.
    winget install PostgreSQL.PostgreSQL.16
  or download the installer from https://www.postgresql.org/download/windows/

  The installer does not add psql to PATH. Add its bin directory, e.g.:
    `$env:PATH += ';C:\Program Files\PostgreSQL\16\bin'
"@
}
Write-Ok "psql $((& psql --version) -split ' ' | Select-Object -Index 2)"

# Native psql exit codes are what we branch on, so stderr redirection is deliberately avoided here
# (in PS 5.1, redirecting a native command's stderr wraps lines in ErrorRecords and clobbers $?).
function Invoke-Pg {
  param([string[]]$PsqlArgs)
  & psql -h $PgHost -p $PgPort -U $SuperUser -d postgres -v ON_ERROR_STOP=1 @PsqlArgs
}

$probe = Invoke-Pg @('-tAc', 'SELECT 1')
if ($LASTEXITCODE -ne 0) {
  Die @"
Cannot connect to PostgreSQL at ${PgHost}:${PgPort} as '$SuperUser'.
  Is the service running?  Get-Service postgresql*
  Wrong superuser?         re-run with -SuperUser <name>
  Needs a password?        `$env:PGPASSWORD = '...'   (or configure %APPDATA%\postgresql\pgpass.conf)
"@
}
Write-Ok "Connected to PostgreSQL at ${PgHost}:${PgPort}"

# --- 2. Secrets (reuse the Docker path's files) ----------------------------------------------------
if (-not (Test-Path secrets)) { New-Item -ItemType Directory secrets | Out-Null }

# Node rather than openssl: node is already a hard prerequisite, openssl generally is not on Windows.
function New-RandomHex {
  param([int]$Bytes)
  & node -e 'console.log(require("node:crypto").randomBytes(+process.argv[1]).toString("hex"))' $Bytes
}

# -NoNewline matters: readSecret() trims a single trailing newline, but a stray CRLF or extra blank line
# would corrupt the value. Encoding is forced to ASCII so no BOM is prepended (Set-Content defaults to the
# system ANSI codepage, and a BOM would become part of the secret).
if ((Test-Path secrets/db_password) -and (Get-Item secrets/db_password).Length -gt 0) {
  Write-Ok "secrets/db_password exists - reusing it"
} else {
  [System.IO.File]::WriteAllText((Join-Path $PWD 'secrets/db_password'), (New-RandomHex 24).Trim())
  Write-Ok "secrets/db_password generated"
}
$DbPassword = [System.IO.File]::ReadAllText((Join-Path $PWD 'secrets/db_password')).Trim()

if ((Test-Path secrets/api_key_secret) -and (Get-Item secrets/api_key_secret).Length -gt 0) {
  Write-Ok "secrets/api_key_secret exists - reusing it"
} else {
  [System.IO.File]::WriteAllText((Join-Path $PWD 'secrets/api_key_secret'), (New-RandomHex 32).Trim())
  Write-Ok "secrets/api_key_secret generated"
}

# gen-custody.ts is itself idempotent and refuses to overwrite - call it unconditionally and let it decide.
& npx tsx scripts/gen-custody.ts
if ($LASTEXITCODE -ne 0) { Die "scripts/gen-custody.ts failed - the signer cannot unlock without it." }
Write-Ok "signer custodian shares ready (secrets/custodian_shares)"

# --- 3. Role + database ----------------------------------------------------------------------------
# Only the OWNER role and the database are created here. The non-owner `licensesrv_app` role that RLS
# depends on is created idempotently by migrations/0002_rls_roles_grants.sql - do not duplicate it.
$roleExists = (Invoke-Pg @('-tAc', "SELECT 1 FROM pg_roles WHERE rolname='$DbRole'")) -join ''
if ($roleExists.Trim() -eq '1') {
  Write-Ok "role '$DbRole' exists - updating its password to match secrets/db_password"
  Invoke-Pg @('-c', "ALTER ROLE $DbRole WITH LOGIN PASSWORD '$DbPassword'") | Out-Null
} else {
  Invoke-Pg @('-c', "CREATE ROLE $DbRole WITH LOGIN PASSWORD '$DbPassword'") | Out-Null
  Write-Ok "role '$DbRole' created"
}

$dbExists = (Invoke-Pg @('-tAc', "SELECT 1 FROM pg_database WHERE datname='$DbName'")) -join ''
if ($dbExists.Trim() -eq '1') {
  Write-Ok "database '$DbName' exists - leaving it alone"
} else {
  Invoke-Pg @('-c', "CREATE DATABASE $DbName OWNER $DbRole") | Out-Null
  Write-Ok "database '$DbName' created (owner: $DbRole)"
}

# --- 4. .env.native -------------------------------------------------------------------------------
if (Test-Path $EnvFile) {
  Write-Ok "$EnvFile exists - leaving it alone (delete it to regenerate)"
} else {
  if (-not (Test-Path .env.native.example)) { Die ".env.native.example is missing - cannot generate $EnvFile." }
  # Substitute only the DATABASE_URL line; every other setting keeps the example's documented default.
  $url = "postgres://${DbRole}:${DbPassword}@${PgHost}:${PgPort}/${DbName}"
  $lines = Get-Content .env.native.example | ForEach-Object {
    if ($_ -match '^DATABASE_URL=') { "DATABASE_URL=$url" } else { $_ }
  }
  # LF endings and no BOM: Node's --env-file parser is tolerant, but keeping both env files byte-identical
  # in shape across platforms avoids surprises when the same repo is used from WSL and Windows.
  [System.IO.File]::WriteAllText((Join-Path $PWD $EnvFile), (($lines -join "`n") + "`n"))
  Write-Ok "$EnvFile written (gitignored)"
}

Write-Host ''
Write-Ok 'Setup complete.'
Write-Info 'Next:  npm run start:native      (builds, migrates, then serves on 127.0.0.1:8080)'
Write-Info 'Optional, lower Postgres memory: see scripts/native/postgres-tuning.conf'
Write-Host ''
