# Runs RepSight on your own PC and gives it a free public https address through a Cloudflare tunnel.
# The backend also serves the website, so this one address is the whole app: no Vercel, no server, no cost.
#
#   1. one-time:   winget install --id Cloudflare.cloudflared      (then open a new PowerShell)
#   2. fill SMTP_USER and SMTP_PASSWORD in .env (Gmail app password) so sign-up codes are really emailed
#   3. activate your Python environment, then:   powershell -File deploy\run-public.ps1
#
# The address (https://something.trycloudflare.com) is printed below once the tunnel is up. It changes each time you start this.
# Press Ctrl+C to stop; the backend stops with it. Your PC must stay on and awake while people use the link.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "cloudflared is not installed. Run:  winget install --id Cloudflare.cloudflared   then open a NEW PowerShell and try again." -ForegroundColor Yellow
    exit 1
}

# Build the website once (and again whenever frontend-ts/src changed since the last build).
$dist = Join-Path $root "frontend-ts\dist\index.html"
$newest = Get-ChildItem (Join-Path $root "frontend-ts\src") -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path $dist) -or ((Get-Item $dist).LastWriteTime -lt $newest.LastWriteTime)) {
    Write-Host "Building the website..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "frontend-ts")
    if (-not (Test-Path "node_modules")) { npm install }
    npm run build
    Pop-Location
}

# Public-mode settings. SMTP_* and the Nebius key come from your .env as usual.
$env:APP_ENV = "production"            # refuses to start unless email is set up, so codes are never printed where visitors cannot see them
$env:TRUST_PROXY = "cloudflare"        # rate limits use the real visitor address that Cloudflare supplies
$env:FORCE_SECURE_COOKIES = "1"        # the login cookie travels over https only

Write-Host "Starting the backend on http://127.0.0.1:8080 ..." -ForegroundColor Cyan
$api = Start-Process -PassThru -WindowStyle Minimized -WorkingDirectory (Join-Path $root "backend") `
    -FilePath python -ArgumentList "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8080", "--proxy-headers"
Start-Sleep -Seconds 4
if ($api.HasExited) {
    Write-Host "The backend did not start. Run this to see why:  cd backend; python -m uvicorn main:app --port 8080" -ForegroundColor Red
    exit 1
}

Write-Host "Opening the tunnel. Look for the https://....trycloudflare.com address below." -ForegroundColor Cyan
try { cloudflared tunnel --url http://127.0.0.1:8080 }
finally { if (-not $api.HasExited) { Stop-Process -Id $api.Id -Force }; Write-Host "Stopped." }
