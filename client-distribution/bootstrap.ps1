#requires -Version 5.1
[CmdletBinding()]
param([string]$Server = 'https://whisper.leonz03.dpdns.org', [switch]$NoPath)
$ErrorActionPreference = 'Stop'
function Read-BoundedResponse([string]$Url, [int]$Limit) {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(45)
    try {
        $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        try {
            if ([int]$response.StatusCode -ne 200) { throw "Download returned HTTP $([int]$response.StatusCode)." }
            if ($response.Content.Headers.ContentLength -gt $Limit) { throw 'Download exceeds the allowed size.' }
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            try {
                $memory = New-Object IO.MemoryStream
                try {
                    $buffer = New-Object byte[] 8192
                    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        if ($memory.Length + $count -gt $Limit) { throw 'Download exceeds the allowed size.' }
                        $memory.Write($buffer, 0, $count)
                    }
                    return ,$memory.ToArray()
                } finally { $memory.Dispose() }
            } finally { $stream.Dispose() }
        } finally { $response.Dispose() }
    } finally { $client.Dispose(); $handler.Dispose() }
}
$uri = [Uri]$Server
if (!$uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or
    ($uri.Scheme -ne 'https' -and !($uri.Scheme -eq 'http' -and $uri.Host -in @('127.0.0.1','localhost','[::1]')))) {
    throw 'Use an HTTPS server origin without a path or credentials.'
}
$origin = $uri.GetLeftPart([UriPartial]::Authority)
$work = Join-Path ([IO.Path]::GetTempPath()) ('whisper-bootstrap-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
try {
    Write-Host 'Preparing Whisper CLI setup: checking the installer...'
    $manifestBytes = Read-BoundedResponse "$origin/downloads/manifest.json" 32768
    $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
    if ($manifest.platform -ne 'windows-x64' -or $manifest.installerSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid Windows release manifest.' }
    $installerBytes = Read-BoundedResponse "$origin/install.ps1" 262144
    $installerPath = Join-Path $work 'install.ps1'
    [IO.File]::WriteAllBytes($installerPath, $installerBytes)
    $actual = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $manifest.installerSha256) { throw 'Installer hash mismatch; nothing was run.' }
    Write-Host 'Installer verified. Starting the existing package installer...'
    $installArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$installerPath,'-Server',$origin)
    if ($NoPath) { $installArgs += '-NoPath' }
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @installArgs
    if ($LASTEXITCODE -ne 0) { throw 'Whisper installation failed.' }
    $bin = Join-Path $env:LOCALAPPDATA 'WhisperCLI\bin'
    $pathParts = @($env:Path -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $bin.TrimEnd('\') })
    $env:Path = @($bin) + $pathParts -join ';'
    Write-Host 'This PowerShell session can now run whisper.'
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
