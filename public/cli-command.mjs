// Shared by the host launcher and install-help page. No remote script evaluation.
export function installCommand(value, release) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('Invalid installation origin');
  if (!/^[a-f0-9]{64}$/.test(release.installerSha256)) throw new Error('Invalid installer hash');
  const q = (s) => "'" + s.replaceAll("'", "''") + "'";
  return `& { $ErrorActionPreference='Stop'; $u=${q(u.origin)}; $p=Join-Path $env:TEMP ('whisper-install-'+[guid]::NewGuid()+'.ps1'); try { ` +
    `if (![uri]::IsWellFormedUriString($u,[UriKind]::Absolute)) { throw 'Use a plain URL, not a Markdown link' }; ` +
    `try { Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30 "$u/install.ps1" -OutFile $p } catch { if ($null -ne $_.Exception.Response) { throw }; Write-Host 'Default download failed; retrying direct with HTTPS verification'; $c=Join-Path $env:SystemRoot 'System32\\curl.exe'; if (!(Test-Path -LiteralPath $c)) { throw 'Windows curl.exe is unavailable; check proxy settings' }; $s=& $c -q --fail --silent --show-error --noproxy '*' --connect-timeout 10 --max-time 45 --max-redirs 0 --output $p --write-out '%{http_code}' "$u/install.ps1"; if ($LASTEXITCODE -ne 0 -or [string]$s -ne '200') { throw 'Default and direct downloads failed; check server URL and proxy' } }; ` +
    `if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne '${release.installerSha256}') { throw 'Installer hash mismatch' }; ` +
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -Server $u; if ($LASTEXITCODE -ne 0) { throw 'Whisper installation failed' }; ` +
    `$b=Join-Path $env:LOCALAPPDATA 'WhisperCLI\\bin'; $env:Path=$b+';'+(($env:Path -split ';' | Where-Object { $_ -and $_ -ne $b }) -join ';') ` +
    `} finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } }`;
}
export function cliInstructions(server, release) {
  return `CLI 首次安装 / 更新（Windows x64，朋友在自己的 PowerShell 执行）：\n${installCommand(server, release)}\n\n` +
    `CLI 连接（已经安装，无需再次下载）：\nwhisper --server '${new URL(server).origin}'\n\n` +
    `默认连接：whisper\n卸载：whisper --uninstall\n安装帮助：${new URL(server).origin}/cli.html\n`;
}
