#requires -Version 5.1
[CmdletBinding()]
param([switch]$Yes)
$ErrorActionPreference = 'Stop'
$homeDir = $PSScriptRoot
$statePath = Join-Path $homeDir 'installed.json'
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($state.app -ne 'WhisperCLI' -or $state.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Not a managed Whisper CLI installation.' }
if (!$Yes -and (Read-Host 'Uninstall Whisper CLI? Public-key pins in data/ will be kept. Type yes') -ne 'yes') { Write-Host 'Cancelled.'; exit 0 }
function Assert-Tree([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return }
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to remove a linked path.' }
    foreach ($item in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to remove a linked tree.' }
    }
}
Assert-Tree (Join-Path $homeDir 'bin')
$releases = @($state.sha256) + @($state.releases) | Where-Object { $_ } | Select-Object -Unique
foreach ($release in $releases) {
    if ($release -notmatch '^[a-f0-9]{64}$') { throw 'Invalid managed release ID.' }
    Assert-Tree (Join-Path $homeDir "versions\$release")
}
foreach ($release in $releases) {
    $dir = Join-Path $homeDir "versions\$release"
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}
$bin = Join-Path $homeDir 'bin'
if ($state.pathAdded) {
    $parts = @([Environment]::GetEnvironmentVariable('Path','User') -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $bin.TrimEnd('\') })
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}
foreach ($file in @('bin\whisper.cmd','settings.json','installed.json','uninstall.ps1')) {
    $path = Join-Path $homeDir $file
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
Write-Host "Whisper CLI removed. Public-key pins kept in $homeDir\data. Unrelated files were not removed."
