#!/bin/sh
set -eu
SELF=$(readlink -f -- "$0") || { echo 'Cannot resolve Whisper CLI installation.' >&2; exit 1; }
RELEASE_DIR=$(dirname -- "$SELF")
BASE=$(dirname -- "$(dirname -- "$RELEASE_DIR")")
VERSIONS="$BASE/versions"
case "$BASE" in /|/home|/root|/tmp) echo 'Refusing an unexpected installation root.' >&2; exit 1 ;; esac
[ -d "$VERSIONS" ] && [ ! -L "$VERSIONS" ] || { echo 'Cannot verify the managed installation.' >&2; exit 1; }
RELEASE_NAME=${RELEASE_DIR##*/}
[ "${#RELEASE_NAME}" -eq 64 ] || { echo 'Cannot verify the managed release path.' >&2; exit 1; }
case "$RELEASE_NAME" in *[!a-f0-9]*) echo 'Cannot verify the managed release path.' >&2; exit 1 ;; esac
[ "$(dirname -- "$RELEASE_DIR")" = "$VERSIONS" ] || { echo 'Cannot verify the managed release path.' >&2; exit 1; }
printf 'Remove Whisper CLI? Login data and public-key pins will be kept. Type yes: '
IFS= read -r answer
[ "$answer" = yes ] || { echo 'Cancelled.'; exit 0; }
for path in "$VERSIONS"/*; do
  [ -e "$path" ] || continue
  [ ! -L "$path" ] && [ -d "$path" ] || { echo 'Refusing to remove an unexpected release path.' >&2; exit 1; }
  name=${path##*/}
  [ "${#name}" -eq 64 ] || { echo 'Unexpected item in managed versions folder.' >&2; exit 1; }
  case "$name" in *[!a-f0-9]*|'') echo 'Unexpected item in managed versions folder.' >&2; exit 1 ;; esac
done
rm -rf -- "$VERSIONS"
if [ -L "$BASE/current" ]; then rm -- "$BASE/current"; elif [ -e "$BASE/current" ]; then echo 'Refusing to remove an unexpected current path.' >&2; exit 1; fi
BIN_DIR=${HOME:?HOME is required}/.local/bin
if [ -f "$BASE/bin-dir" ] && [ ! -L "$BASE/bin-dir" ]; then
  IFS= read -r stored_bin < "$BASE/bin-dir" || true
  case "$stored_bin" in /*) BIN_DIR=$stored_bin ;; *) echo 'Saved command directory is invalid.' >&2; exit 1 ;; esac
fi
launcher="$BIN_DIR/whisper"
if [ -L "$launcher" ] && [ "$(readlink -- "$launcher")" = "$BASE/current/whisper" ]; then rm -- "$launcher"; fi
launcher="$BIN_DIR/whisper-uninstall"
if [ -L "$launcher" ] && [ "$(readlink -- "$launcher")" = "$BASE/current/uninstall-linux.sh" ]; then rm -- "$launcher"; fi
echo "Whisper CLI removed. Login data and public-key pins remain in $BASE/data."
