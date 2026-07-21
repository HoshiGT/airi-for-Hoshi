#!/usr/bin/env bash

# Periodic snapshot of AIRI's Electron user-data directory.
#
# The desktop app keeps everything that matters — chat history, character cards,
# the memory (PGlite) database, and settings — under its Chromium user-data dir.
# Reinstalling or replacing the app can wipe that dir, so we snapshot it on a
# timer into a location OUTSIDE both the app dir and the git repo, where neither
# an app update nor a repo reset can take the backups with it.
#
# NOTICE:
# This is a best-effort hot copy. IndexedDB/LevelDB is archived while the app may
# be writing, so a snapshot can catch a mid-write moment. LevelDB tolerates this
# well in practice (it recovers from its log on open), and a slightly-stale but
# openable snapshot beats losing everything — but do not treat these as
# transactionally consistent dumps.

set -euo pipefail

# All three are overridable via env so the systemd unit (or a manual run) can
# point at a different install without editing the script.
#
# NOTICE:
# The dev build (`pnpm dev` / electron-vite dev) stores its Chromium user data
# under the package name `@proj-airi/stage-tamagotchi`; a packaged/production
# build would use the electron appId dir `ai.moeru.airi` instead. Day-to-day use
# here is the dev build, so default to that dir — set AIRI_DATA_DIR to back up a
# packaged install. (Verified 2026-07-21: the dev dir held the live 193M
# IndexedDB while ai.moeru.airi was two weeks stale.)
SRC="${AIRI_DATA_DIR:-$HOME/.config/@proj-airi/stage-tamagotchi}"
DEST="${AIRI_BACKUP_DIR:-$HOME/airi-backups}"
RETENTION="${AIRI_BACKUP_KEEP:-14}" # number of newest snapshots to keep

if [[ ! -d "$SRC" ]]; then
  echo "airi-backup: source data dir not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"

stamp="$(date +%Y%m%d-%H%M%S)"
archive="$DEST/airi-data-$stamp.tar.gz"

# Exclude the disposable Chromium caches: they are the bulk of the on-disk size
# (hundreds of MB) and are regenerated on next launch, so archiving them only
# wastes space and time. "Service Worker" is the PWA CacheStorage — cached app
# shell and re-downloadable model assets (TTS/ffish wasm), not user data — and
# is by far the largest of these. What is kept is the real user state:
# IndexedDB (chat/cards/memory), Local Storage, File System, blob_storage, the
# *.json config files, and the websocket certs.
tar \
  --exclude='Cache' \
  --exclude='Code Cache' \
  --exclude='GPUCache' \
  --exclude='DawnGraphiteCache' \
  --exclude='DawnWebGPUCache' \
  --exclude='ShaderCache' \
  --exclude='Service Worker' \
  --exclude='Crashpad' \
  -czf "$archive" -C "$(dirname "$SRC")" "$(basename "$SRC")"

echo "airi-backup: wrote $archive ($(du -h "$archive" | cut -f1))"

# Retention: delete everything older than the newest $RETENTION archives.
mapfile -t stale < <(ls -1t "$DEST"/airi-data-*.tar.gz 2>/dev/null | tail -n +"$((RETENTION + 1))")
if ((${#stale[@]})); then
  for f in "${stale[@]}"; do
    rm -f "$f"
    echo "airi-backup: pruned old backup $f"
  done
fi
