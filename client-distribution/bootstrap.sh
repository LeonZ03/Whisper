#!/usr/bin/env bash
set -euo pipefail

SERVER='https://whisper.leonz03.dpdns.org'
while (($#)); do
  case "$1" in
    --server) (($# >= 2)) || { echo 'Missing value for --server.' >&2; exit 2; }; SERVER=$2; shift 2 ;;
    -h|--help) echo 'Usage: bootstrap.sh [--server HTTPS_ORIGIN]'; exit 0 ;;
    *) echo 'Unsupported bootstrap option.' >&2; exit 2 ;;
  esac
done
if [[ ! "$SERVER" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ && ! "$SERVER" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$ ]] || [[ "$SERVER" == *..* ]]; then
  echo 'Server must be a valid HTTPS origin without a path.' >&2; exit 2
fi
for tool in curl mktemp rm wc grep sed awk bash; do command -v "$tool" >/dev/null || { echo "Required system tool missing: $tool" >&2; exit 1; }; done
if command -v sha256sum >/dev/null; then HASHER=(sha256sum); elif command -v shasum >/dev/null; then HASHER=(shasum -a 256); else echo 'Install sha256sum or shasum and retry.' >&2; exit 1; fi
TMP=$(mktemp -d "${TMPDIR:-/tmp}/whisper-bootstrap.XXXXXXXX")
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$(uname -m)" in
  x86_64|amd64) MANIFEST=manifest-linux-x64.json; PLATFORM=linux-x64 ;;
  aarch64|arm64) MANIFEST=manifest-linux-arm64.json; PLATFORM=linux-arm64 ;;
  *) echo 'This installer supports Linux x86_64 and arm64.' >&2; exit 1 ;;
esac
MANIFEST_FILE="$TMP/manifest.json"
INSTALLER="$TMP/install.sh"
echo 'Preparing Whisper CLI setup: checking the installer...'
curl -q --fail --location --max-redirs 0 --silent --show-error --max-time 30 --proto '=https,http' --max-filesize 32768 --output "$MANIFEST_FILE" "$SERVER/downloads/$MANIFEST"
manifest_bytes=$(wc -c < "$MANIFEST_FILE")
((manifest_bytes > 0 && manifest_bytes <= 32768)) || { echo 'Release manifest exceeds the allowed size.' >&2; exit 1; }
[[ $(grep -c '"installerSha256"' "$MANIFEST_FILE") -eq 1 ]] || { echo 'Invalid release manifest.' >&2; exit 1; }
[[ $(grep -c '"platform"' "$MANIFEST_FILE") -eq 1 ]] || { echo 'Invalid release manifest.' >&2; exit 1; }
installer_hash=$(sed -n 's/^[[:space:]]*"installerSha256"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{64\}\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$MANIFEST_FILE")
manifest_platform=$(sed -n 's/^[[:space:]]*"platform"[[:space:]]*:[[:space:]]*"\([a-z0-9-]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$MANIFEST_FILE")
[[ "$installer_hash" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid installer hash in release manifest.' >&2; exit 1; }
[[ "$manifest_platform" == "$PLATFORM" ]] || { echo 'Release manifest platform mismatch.' >&2; exit 1; }
curl -q --fail --location --max-redirs 0 --silent --show-error --max-time 45 --proto '=https,http' --max-filesize 262144 --output "$INSTALLER" "$SERVER/install.sh"
installer_bytes=$(wc -c < "$INSTALLER")
((installer_bytes > 0 && installer_bytes <= 262144)) || { echo 'Installer exceeds the allowed size.' >&2; exit 1; }
actual_hash=$("${HASHER[@]}" "$INSTALLER" | awk '{print $1}')
[[ "$actual_hash" == "$installer_hash" ]] || { echo 'Installer hash mismatch; nothing was run.' >&2; exit 1; }
echo 'Installer verified. Starting the existing package installer...'
bash "$INSTALLER" --server "$SERVER"
