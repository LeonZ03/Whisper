#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Server, [string]$InstallDir, [switch]$NoPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
function Assert-NoLink([string]$Path) {
    $p = [IO.Path]::GetFullPath($Path)
    while ($p) {
        if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a linked installation path.' }
        $parent = [IO.Directory]::GetParent($p)
        if ($null -eq $parent) { break }; $p = $parent.FullName
    }
}
function Save-WhisperDownload([string]$Url, [string]$Path, [int]$TimeoutSec) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -MaximumRedirection 0 -TimeoutSec $TimeoutSec -OutFile $Path | Out-Null
        return
    } catch {
        # HTTP errors/redirects are not proxy transport failures. Do not hide them.
        if ($null -ne $_.Exception.Response) { throw }
    }
    Write-Host 'Default download path failed; retrying directly with HTTPS verification. System proxy settings are unchanged.'
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (!(Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'Download failed and Windows curl.exe is unavailable. Check the current server URL and proxy.' }
    # -q ignores curlrc; no redirects, no TLS verification bypass, and no credentials.
    $status = & $curl -q --fail --silent --show-error --noproxy '*' --connect-timeout 10 --max-time $TimeoutSec --max-redirs 0 --output $Path --write-out '%{http_code}' $Url
    if ($LASTEXITCODE -ne 0 -or [string]$status -ne '200') { throw 'Download failed on default and direct paths. Check the server and proxy; nothing was activated.' }
}

$uri = [Uri]$Server
if (!$uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Use a server origin, without a path or credentials.' }
if ($uri.Scheme -ne 'https' -and !($uri.Scheme -eq 'http' -and $uri.Host -in @('127.0.0.1','localhost','[::1]'))) { throw 'Remote servers must use HTTPS.' }
$Server = $uri.GetLeftPart([UriPartial]::Authority)
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or ![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This release requires Windows x64.' }
if (!$InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'WhisperCLI' }
if (![IO.Path]::IsPathRooted($InstallDir)) { throw 'InstallDir must be absolute.' }
$homeDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($homeDir -eq [IO.Path]::GetPathRoot($homeDir).TrimEnd('\')) { throw 'Cannot install into a drive root.' }
Assert-NoLink $homeDir
$statePath = Join-Path $homeDir 'installed.json'; $previous = $null
if (Test-Path -LiteralPath $statePath) { $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json; if ($previous.app -ne 'WhisperCLI') { throw 'This directory belongs to another application.' } }
if ((Test-Path -LiteralPath $homeDir) -and !$previous) {
    $unknown = @(Get-ChildItem -LiteralPath $homeDir -Force | Where-Object { $_.Name -notin @('data','versions') })
    if ($unknown.Count) { throw 'Non-empty unmanaged installation directory; choose a different InstallDir.' }
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('whisper-install-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
$lockStream = $null
try {
    Write-Host "Whisper CLI: downloading from $Server"
    $manifestPath = Join-Path $work "manifest.json"
    Save-WhisperDownload "$Server/downloads/manifest.json" $manifestPath 30
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.platform -ne 'windows-x64' -or $manifest.filename -ne 'whisper-cli-windows-x64.zip' -or $manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.installerSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid release manifest.' }
    if ([long]$manifest.bytes -lt 1000000 -or [long]$manifest.bytes -gt 100000000) { throw 'Unexpected release size.' }
    if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ne $manifest.installerSha256) { throw 'Installer version changed. Ask the host for the latest installation command.' }
    [void][IO.Directory]::CreateDirectory($homeDir)
    $lockStream = [IO.File]::Open((Join-Path $homeDir '.install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $zip = Join-Path $work 'client.zip'
    Save-WhisperDownload "$Server/downloads/$($manifest.filename)" $zip 180
    if ((Get-Item -LiteralPath $zip).Length -ne [long]$manifest.bytes -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'Package integrity check failed; nothing activated.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $total = 0L; $names = @{}
        if ($archive.Entries.Count -gt 500) { throw 'Too many archive entries.' }
        foreach ($entry in $archive.Entries) {
            $n = $entry.FullName.Replace('\','/')
            if (!$n.StartsWith('Whisper-CLI/') -or $n -match '(^|/)\.\.(/|$)|:|[\x00-\x1f]' -or $names.ContainsKey($n)) { throw 'Unsafe archive path.' }
            if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive links are not allowed.' }
            $names[$n] = $true; $total += $entry.Length
            if ($total -gt 268435456) { throw 'Archive expands beyond the size limit.' }
        }
    } finally { $archive.Dispose() }
    $stage = Join-Path $work 'stage'
    Expand-Archive -LiteralPath $zip -DestinationPath $stage
    $client = Join-Path $stage 'Whisper-CLI'
    $inventory = Get-Content -LiteralPath (Join-Path $client 'FILES-SHA256.json') -Raw | ConvertFrom-Json
    $entries = @($inventory.PSObject.Properties)
    if ($entries.Count -lt 5 -or $entries.Count -gt 500) { throw 'Invalid file inventory.' }
    if (@(Get-ChildItem -LiteralPath $client -Recurse -File).Count -ne $entries.Count + 1) { throw 'Unlisted package files.' }
    foreach ($entry in $entries) {
        if ($entry.Name -match '(^|[\\/])\.\.([\\/]|$)|:|^[\\/]' -or $entry.Value -notmatch '^[a-f0-9]{64}$') { throw 'Invalid inventory entry.' }
        $file = Join-Path $client $entry.Name; Assert-NoLink $file
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) { throw 'Extracted file integrity check failed.' }
    }
    $versions = Join-Path $homeDir 'versions'; Assert-NoLink $versions
    [void][IO.Directory]::CreateDirectory($versions)
    $release = Join-Path $versions $manifest.sha256; Assert-NoLink $release
    if (Test-Path -LiteralPath $release) {
        foreach ($entry in $entries) {
            $file = Join-Path (Join-Path $release 'Whisper-CLI') $entry.Name; Assert-NoLink $file
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) { throw 'Existing installation was modified. Refusing to overwrite it.' }
        }
    } else { Move-Item -LiteralPath $stage -Destination $release }
    $bin = Join-Path $homeDir 'bin'; Assert-NoLink $bin
    [void][IO.Directory]::CreateDirectory($bin)
    foreach ($name in @('settings.json','installed.json','uninstall.ps1','bin\whisper.cmd')) { Assert-NoLink (Join-Path $homeDir $name) }
    $wrapper = @'
@echo off
setlocal
if /I "%~1"=="--uninstall" (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\uninstall.ps1"
  exit /b
)
set "WHISPER_CLI_HOME=%~dp0.."
if not defined WHISPER_CLI_DATA_DIR set "WHISPER_CLI_DATA_DIR=%~dp0..\data"
"%~dp0..\versions\RELEASE_HASH\Whisper-CLI\runtime\node.exe" --no-warnings "%~dp0..\versions\RELEASE_HASH\Whisper-CLI\cli\remote-entry.mjs" %*
exit /b %errorlevel%
'@
    Write-Utf8 (Join-Path $bin 'whisper.cmd.new') ($wrapper.Replace('RELEASE_HASH', $manifest.sha256).Replace("`n","`r`n"))
    Copy-Item -LiteralPath (Join-Path $release 'Whisper-CLI\uninstall.ps1') -Destination (Join-Path $homeDir 'uninstall.ps1') -Force
    Write-Utf8 (Join-Path $homeDir 'settings.json') (@{server=$Server} | ConvertTo-Json)
    $pathAdded = [bool]$previous.pathAdded
    if (!$NoPath) {
        $userPath = [Environment]::GetEnvironmentVariable('Path','User')
        $parts = @($userPath -split ';' | Where-Object { $_ })
        if ($bin.TrimEnd('\') -notin @($parts | ForEach-Object { $_.TrimEnd('\') })) {
            [Environment]::SetEnvironmentVariable('Path', (@($bin) + $parts -join ';'), 'User'); $pathAdded = $true
        }
    }
    Move-Item -LiteralPath (Join-Path $bin 'whisper.cmd.new') -Destination (Join-Path $bin 'whisper.cmd') -Force
    Write-Utf8 $statePath (@{app='WhisperCLI';version=$manifest.version;sha256=$manifest.sha256;releases=@(@($previous.releases) + @($manifest.sha256) | Where-Object { $_ } | Select-Object -Unique);pathAdded=$pathAdded} | ConvertTo-Json)
    Write-Host "Installed: $bin\whisper.cmd"
    Write-Host "Connect: whisper --server $Server"
    Write-Host 'Run whisper with no arguments to use the saved server. --uninstall removes the app, keeping public-key pins.'
    Write-Host 'Existing PowerShell sessions need a PATH refresh; the host-provided command does this automatically.'
    Write-Host 'Client and runtime only. No server, administrator rights, global Node.js or global policy changes.'
    Write-Host 'Only install from a host you trust. SHA-256 is an integrity check, not a publisher signature.'
} finally {
    if ($lockStream) { $lockStream.Dispose(); Remove-Item -LiteralPath (Join-Path $homeDir '.install.lock') -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
