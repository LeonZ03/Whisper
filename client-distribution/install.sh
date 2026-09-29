#!/usr/bin/env bash
set -euo pipefail

SERVER='https://whisper.leonz03.dpdns.org'
INSTALL_DIR="${HOME:?HOME is required}/.local/share/WhisperCLI"
BIN_DIR="${HOME:?HOME is required}/.local/bin"
NO_PATH=0
while (($#)); do
  case "$1" in
    --server) (($# >= 2)) || { echo 'Missing value for --server.' >&2; exit 2; }; SERVER=$2; shift 2 ;;
    --install-dir) (($# >= 2)) || { echo 'Missing value for --install-dir.' >&2; exit 2; }; INSTALL_DIR=$2; shift 2 ;;
    --bin-dir) (($# >= 2)) || { echo 'Missing value for --bin-dir.' >&2; exit 2; }; BIN_DIR=$2; shift 2 ;;
    --no-path) NO_PATH=1; shift ;;
    -h|--help) echo 'Usage: install.sh [--server HTTPS_ORIGIN] [--install-dir ABSOLUTE_PATH] [--bin-dir ABSOLUTE_PATH] [--no-path]'; exit 0 ;;
    *) echo 'Unsupported installer option.' >&2; exit 2 ;;
  esac
done

if [[ ! "$SERVER" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ && ! "$SERVER" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$ ]] || [[ "$SERVER" == *..* ]]; then
  echo 'Server must be a valid HTTPS origin without a path.' >&2; exit 2
fi
[[ "$INSTALL_DIR" = /* && "$BIN_DIR" = /* && "$INSTALL_DIR" != / && "$BIN_DIR" != / ]] || { echo 'Install and bin directories must be absolute paths.' >&2; exit 2; }
for path in "$INSTALL_DIR" "$BIN_DIR"; do
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != */../* && "$path" != */.. && "$path" != */./* && "$path" != */. ]] || { echo 'Install paths must not contain dot segments or newlines.' >&2; exit 2; }
done
INSTALL_DIR=${INSTALL_DIR%/}
BIN_DIR=${BIN_DIR%/}
assert_safe_path() {
  local path=$1 current=/ part
  IFS='/' read -r -a parts <<< "$path"
  for part in "${parts[@]}"; do
    [[ -z "$part" ]] && continue
    current="${current%/}/$part"
    [[ -L "$current" ]] && { echo 'Refusing a path with a symbolic-link component.' >&2; exit 1; }
  done
  return 0
}
assert_safe_path "$INSTALL_DIR"
assert_safe_path "$BIN_DIR"
for path in "$INSTALL_DIR/versions" "$INSTALL_DIR/data" "$INSTALL_DIR/settings.json" "$INSTALL_DIR/bin-dir" "$INSTALL_DIR/bin-dir.tmp" "$INSTALL_DIR/.install.lock"; do assert_safe_path "$path"; done
if [[ -e "$INSTALL_DIR/settings.json" && ! -f "$INSTALL_DIR/settings.json" ]]; then echo 'Saved CLI settings path is unsafe.' >&2; exit 1; fi
for path in "$INSTALL_DIR" "$BIN_DIR"; do
  if [[ -e "$path" && ! -d "$path" ]]; then echo 'Refusing a non-directory install path.' >&2; exit 1; fi
done
for tool in tar mktemp awk grep sed wc find chmod mv ln readlink rm rmdir sort tail tr dirname cat diff; do command -v "$tool" >/dev/null || { echo "Required system tool missing: $tool" >&2; exit 1; }; done
if command -v curl >/dev/null; then DOWNLOADER=curl; elif command -v wget >/dev/null; then DOWNLOADER=wget; else echo 'Install curl or wget and retry.' >&2; exit 1; fi
if command -v sha256sum >/dev/null; then HASHER=(sha256sum); elif command -v shasum >/dev/null; then HASHER=(shasum -a 256); else echo 'Install sha256sum or shasum and retry.' >&2; exit 1; fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64; PLATFORM=linux-x64; ARCHIVE=whisper-cli-linux-x64.tar.gz ;;
  aarch64|arm64) ARCH=arm64; PLATFORM=linux-arm64; ARCHIVE=whisper-cli-linux-arm64.tar.gz ;;
  *) echo 'This installer supports Linux x86_64 and arm64.' >&2; exit 1 ;;
esac
TMP=$(mktemp -d "${TMPDIR:-/tmp}/whisper-install.XXXXXXXX")
STAGE=''
LOCK_HELD=0
cleanup() { [[ -z "$STAGE" || ! -e "$STAGE" ]] || rm -rf -- "$STAGE"; rm -rf -- "$TMP"; if ((LOCK_HELD)); then rmdir -- "$INSTALL_DIR/.install.lock" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p -m 700 -- "$INSTALL_DIR/versions" "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR" "$INSTALL_DIR/versions" "$INSTALL_DIR/data"
mkdir -p -- "$BIN_DIR"
LOCK="$INSTALL_DIR/.install.lock"
mkdir -- "$LOCK" 2>/dev/null || { echo 'Another Whisper CLI installation is already running.' >&2; exit 1; }
LOCK_HELD=1

download() {
  local url=$1 dest=$2 quiet=${3:-0}
  if [[ "$DOWNLOADER" == curl ]]; then
    if [[ "$quiet" == 1 ]]; then curl -q --fail --proto '=https,http' --tlsv1.2 --max-redirs 0 --connect-timeout 15 --max-time 300 --silent --show-error --output "$dest" "$url";
    else curl -q --fail --proto '=https,http' --tlsv1.2 --max-redirs 0 --connect-timeout 15 --max-time 300 --progress-bar --output "$dest" "$url"; fi
  else
    wget --no-config --max-redirect=0 --timeout=30 --tries=2 --show-progress -O "$dest" "$url"
  fi
}
sha256() { "${HASHER[@]}" "$1" | awk '{print $1}'; }
manifest_value() {
  local key=$1 file=$2 count value
  count=$(grep -Ec "^[[:space:]]*\"${key}\"[[:space:]]*:" "$file" || true)
  [[ "$count" == 1 ]] || return 1
  value=$(sed -nE "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"[,]?[[:space:]]*$/\\1/p; s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+)[,]?[[:space:]]*$/\\1/p" "$file")
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

echo '[1/5] Downloading Linux release manifest…'
download "$SERVER/downloads/manifest-linux-${ARCH}.json" "$TMP/manifest.json" 1
VERSION=$(manifest_value version "$TMP/manifest.json") || { echo 'Invalid release manifest.' >&2; exit 1; }
MANIFEST_PLATFORM=$(manifest_value platform "$TMP/manifest.json") || { echo 'Invalid release manifest.' >&2; exit 1; }
FILENAME=$(manifest_value filename "$TMP/manifest.json") || { echo 'Invalid release manifest.' >&2; exit 1; }
EXPECTED_SHA=$(manifest_value sha256 "$TMP/manifest.json") || { echo 'Invalid release manifest.' >&2; exit 1; }
BYTES=$(manifest_value bytes "$TMP/manifest.json") || { echo 'Invalid release manifest.' >&2; exit 1; }
INSTALLER_SHA=$(manifest_value installerSha256 "$TMP/manifest.json") || { echo 'Invalid release manifest.' >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ && "$MANIFEST_PLATFORM" == "$PLATFORM" && "$FILENAME" == "$ARCHIVE" && "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ && "$INSTALLER_SHA" =~ ^[a-f0-9]{64}$ && "$BYTES" =~ ^[0-9]{1,9}$ && "$BYTES" -le 268435456 ]] || { echo 'Invalid release manifest.' >&2; exit 1; }
[[ "$(sha256 "${BASH_SOURCE[0]}")" == "$INSTALLER_SHA" ]] || { echo 'Installer verification failed.' >&2; exit 1; }

OLD_VERSION=''
if [[ -L "$INSTALL_DIR/current" ]]; then
  OLD_ROOT=$(readlink -f -- "$INSTALL_DIR/current" || true)
  [[ "$OLD_ROOT" == "$INSTALL_DIR/versions/"* && -d "$OLD_ROOT" ]] || { echo 'Existing current release path is unsafe.' >&2; exit 1; }
  if [[ -f "$OLD_ROOT/BUILD-INFO.json" ]]; then OLD_VERSION=$(manifest_value version "$OLD_ROOT/BUILD-INFO.json" || true); fi
elif [[ -e "$INSTALL_DIR/current" ]]; then
  echo 'Existing current release path is not a managed symlink.' >&2; exit 1
fi
if [[ -n "$OLD_VERSION" && "$OLD_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  newest=$(printf '%s\n%s\n' "$OLD_VERSION" "$VERSION" | sort -V | tail -n 1)
  if [[ "$newest" == "$OLD_VERSION" && "$OLD_VERSION" != "$VERSION" ]]; then echo 'Refusing to install an older release over a newer version.' >&2; exit 1; fi
fi

echo '[2/5] Downloading release archive…'
download "$SERVER/downloads/$FILENAME" "$TMP/$FILENAME"
[[ "$(wc -c < "$TMP/$FILENAME" | tr -d '[:space:]')" == "$BYTES" && "$(sha256 "$TMP/$FILENAME")" == "$EXPECTED_SHA" ]] || { echo 'Release archive verification failed.' >&2; exit 1; }

echo '[3/5] Checking archive contents…'
tar -tzf "$TMP/$FILENAME" > "$TMP/list.txt"
tar -tvzf "$TMP/$FILENAME" > "$TMP/details.txt"
while IFS= read -r entry; do
  [[ "$entry" != /* && "$entry" != *'\'* && "$entry" != *'../'* && "$entry" != ../* && "$entry" != *'/..' && "$entry" == Whisper-CLI/* || "$entry" == Whisper-CLI/ ]] || { echo 'Unsafe archive path.' >&2; exit 1; }
done < "$TMP/list.txt"
while IFS= read -r line; do
  type=${line:0:1}; [[ "$type" == '-' || "$type" == 'd' ]] || { echo 'Archive contains a link or special file.' >&2; exit 1; }
done < "$TMP/details.txt"
COUNT=$(grep -vc '/$' "$TMP/list.txt" || true)
FILE_COUNT=$(manifest_value fileCount "$TMP/manifest.json") || { echo 'Invalid release manifest.' >&2; exit 1; }
[[ "$COUNT" == "$FILE_COUNT" ]] || { echo 'Unexpected archive file count.' >&2; exit 1; }

echo '[4/5] Installing verified files…'
STAGE="$INSTALL_DIR/versions/.staging-$$"
mkdir -m 700 -- "$STAGE"
tar --no-same-owner --no-same-permissions -xzf "$TMP/$FILENAME" -C "$STAGE"
[[ -d "$STAGE/Whisper-CLI" && ! -L "$STAGE/Whisper-CLI" ]] || { echo 'Release archive layout is invalid.' >&2; exit 1; }
if find "$STAGE" \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then echo 'Unexpected extracted file type.' >&2; exit 1; fi
[[ -s "$STAGE/Whisper-CLI/FILES-SHA256.json" ]] || { echo 'Release file inventory is missing.' >&2; exit 1; }
while IFS= read -r path; do
  [[ "$path" == Whisper-CLI/* ]] || { echo 'Unexpected extracted path.' >&2; exit 1; }
done < "$TMP/list.txt"
chmod 755 "$STAGE/Whisper-CLI/runtime/node"
"$STAGE/Whisper-CLI/runtime/node" --input-type=module - "$STAGE/Whisper-CLI" "$VERSION" "$PLATFORM" <<'NODE'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
const [root, version, platform] = process.argv.slice(2);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const inventory = JSON.parse(readFileSync(join(root, 'FILES-SHA256.json'), 'utf8'));
const names = Object.keys(inventory);
if (names.length < 8 || names.length > 1000) throw Error('Invalid file inventory.');
let totalBytes = 0;
for (const name of names) {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(inventory[name])) throw Error('Invalid package file inventory.');
  const path = join(root, ...name.split('/')), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || digest(path) !== inventory[name]) throw Error('Extracted file integrity check failed.');
  totalBytes += stat.size;
  if (totalBytes > 268435456) throw Error('Release expands beyond the size limit.');
}
const actual = [];
function walk(path) { for (const name of readdirSync(path)) { const file = join(path, name), stat = lstatSync(file); if (stat.isSymbolicLink()) throw Error('Archive links are not allowed.'); if (stat.isDirectory()) walk(file); else if (stat.isFile()) actual.push(relative(root, file).split(sep).join('/')); else throw Error('Archive contains a special file.'); } }
walk(root);
if (actual.length !== names.length + 1 || actual.filter(name => name !== 'FILES-SHA256.json').length !== names.length) throw Error('Unlisted package files.');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const info = JSON.parse(readFileSync(join(root, 'BUILD-INFO.json'), 'utf8'));
if (pkg.version !== version || info.version !== version || info.platform !== platform) throw Error('Package version/platform does not match the release manifest.');
NODE
RELEASE="$INSTALL_DIR/versions/$EXPECTED_SHA"
if [[ -e "$RELEASE" ]]; then
  [[ -d "$RELEASE" && ! -L "$RELEASE" ]] || { echo 'Managed release path is unsafe.' >&2; exit 1; }
  if find "$RELEASE" \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q . || ! diff -qr "$STAGE/Whisper-CLI" "$RELEASE" >/dev/null; then
    echo 'Existing release is modified. Refusing to overwrite it.' >&2; exit 1
  fi
  rm -rf -- "$STAGE"
else
  mv -- "$STAGE/Whisper-CLI" "$RELEASE"
  rmdir -- "$STAGE"
fi
STAGE=''
chmod 755 "$RELEASE/whisper" "$RELEASE/runtime/node" "$RELEASE/uninstall-linux.sh"
for command_path in "$BIN_DIR/whisper" "$BIN_DIR/whisper-uninstall"; do
  if [[ -e "$command_path" || -L "$command_path" ]]; then
    [[ -L "$command_path" ]] || { echo 'Refusing to overwrite an unrelated command.' >&2; exit 1; }
    target=$(readlink -- "$command_path")
    [[ "$target" == "$INSTALL_DIR/current/whisper" || "$target" == "$INSTALL_DIR/current/uninstall-linux.sh" ]] || { echo 'Refusing to overwrite an unrelated command.' >&2; exit 1; }
  fi
done
TMP_LINK="$INSTALL_DIR/.current-$$"
ln -s -- "$RELEASE" "$TMP_LINK"
mv -Tf -- "$TMP_LINK" "$INSTALL_DIR/current"
LAUNCHER_TMP="$BIN_DIR/.whisper-$$"
ln -s -- "$INSTALL_DIR/current/whisper" "$LAUNCHER_TMP"
mv -Tf -- "$LAUNCHER_TMP" "$BIN_DIR/whisper"
UNINSTALL_TMP="$BIN_DIR/.whisper-uninstall-$$"
ln -s -- "$INSTALL_DIR/current/uninstall-linux.sh" "$UNINSTALL_TMP"
mv -Tf -- "$UNINSTALL_TMP" "$BIN_DIR/whisper-uninstall"
if [[ ! -e "$INSTALL_DIR/settings.json" ]]; then
  SETTINGS_TMP="$INSTALL_DIR/.settings-$$"
  printf '{"server":"%s"}\n' "$SERVER" > "$SETTINGS_TMP"
  chmod 600 "$SETTINGS_TMP"
  mv -- "$SETTINGS_TMP" "$INSTALL_DIR/settings.json"
elif [[ -L "$INSTALL_DIR/settings.json" || ! -f "$INSTALL_DIR/settings.json" ]]; then
  echo 'Saved CLI settings path is unsafe.' >&2; exit 1
fi
printf '%s\n' "$BIN_DIR" > "$INSTALL_DIR/bin-dir.tmp"
chmod 600 "$INSTALL_DIR/bin-dir.tmp"
mv -f -- "$INSTALL_DIR/bin-dir.tmp" "$INSTALL_DIR/bin-dir"

if ((NO_PATH == 0)); then
  PROFILE="$HOME/.profile"
  assert_safe_path "$PROFILE"
  if [[ -e "$PROFILE" && ! -f "$PROFILE" ]]; then echo 'User profile path is not a regular file.' >&2; exit 1; fi
  if ! grep -Fq '# >>> Whisper CLI PATH >>>' "$PROFILE" 2>/dev/null; then
    PROFILE_TMP="$HOME/.profile.whisper-$$"
    printf -v BIN_DIR_LITERAL '%q' "$BIN_DIR"
    { [[ ! -f "$PROFILE" ]] || cat -- "$PROFILE"; printf '\n# >>> Whisper CLI PATH >>>\nWHISPER_CLI_BIN=%s\ncase ":$PATH:" in *":$WHISPER_CLI_BIN:"*) ;; *) PATH="$WHISPER_CLI_BIN:$PATH" ;; esac\nexport PATH\nunset WHISPER_CLI_BIN\n# <<< Whisper CLI PATH <<<\n' "$BIN_DIR_LITERAL"; } > "$PROFILE_TMP"
    chmod 600 "$PROFILE_TMP"
    mv -- "$PROFILE_TMP" "$PROFILE"
  fi
fi

echo '[5/5] Activation complete.'
if [[ -z "$OLD_VERSION" ]]; then
  echo "Installation successful! Whisper CLI v$VERSION is ready. (First installation)"
elif [[ "$OLD_VERSION" == "$VERSION" ]]; then
  echo "Reinstallation successful! Whisper CLI v$VERSION is ready. (Version unchanged)"
else
  echo "Upgrade successful! Whisper CLI v$OLD_VERSION -> v$VERSION."
fi
if ((NO_PATH == 1)); then echo "Installed: $BIN_DIR/whisper (NoPath selected; add $BIN_DIR to PATH manually)."; else echo "Installed: $BIN_DIR/whisper. New shells will find whisper on PATH."; fi
echo 'Run whisper with no arguments to use the saved server. Run whisper --uninstall to remove the CLI and keep local data.'
