param(
    [string]$ServiceName = "RoonController",
    [string]$InstallPath = "C:\\Program Files\\RoonController",
    [string]$NodePath = "C:\\Program Files\\nodejs\\node.exe"
)

Write-Host "Creating Windows service '$ServiceName' for Roon Controller" -ForegroundColor Cyan

if (!(Test-Path $InstallPath)) {
    Write-Error "Install path '$InstallPath' does not exist. Copy the build output there before running this script."
    exit 1
}

$distPath = Join-Path $InstallPath "dist\index.js"
if (!(Test-Path $distPath)) {
    Write-Error "dist/index.js not found at $distPath. Run 'npm run build' and deploy the output to '$InstallPath'."
    exit 1
}

if (!(Test-Path $NodePath)) {
    Write-Error "node.exe not found at '$NodePath'. Install Node.js or update the script parameter."
    exit 1
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Service already exists. Stopping and removing..."
    Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

$binPath = "\"$NodePath\" \"$distPath\""

sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "Roon Controller" | Out-Null
sc.exe description $ServiceName "Roon Controller backend service" | Out-Null
sc.exe failure $ServiceName reset= 30 actions= restart/60000 | Out-Null

$envValues = "NODE_ENV=production", "HOST=0.0.0.0", "PORT=3333", "LOG_LEVEL=info", "ROON_TOKEN_PATH=$InstallPath\\config\\roon-token.json"
$envRegPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$ServiceName"
New-ItemProperty -Path $envRegPath -Name Environment -PropertyType MultiString -Value $envValues -Force | Out-Null

Write-Host "Service created. Start it with: Start-Service -Name $ServiceName" -ForegroundColor Green
