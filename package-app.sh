#!/usr/bin/env bash
# Build a standalone, ad-hoc-signed Orbit.app from the dev Electron binary.
# Gives Orbit its own identity so macOS Screen Recording permission works & sticks.
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

SRC="node_modules/electron/dist/Electron.app"
DEST_DIR="${ORBIT_DEST:-/Applications}"
APP="$DEST_DIR/Orbit.app"

if [ ! -d "$SRC" ]; then
  echo "❌ $SRC not found. Run: npm install"
  exit 1
fi

echo "→ Creating $APP"
mkdir -p "$DEST_DIR"
rm -rf "$APP"
cp -R "$SRC" "$APP"

# App code into Contents/Resources/app (Electron auto-loads this over default_app).
# We SYMLINK to the repo rather than copy: codesign seals the symlinks (not their
# targets), so editing the JS later doesn't change the bundle's cdhash — macOS keeps
# Screen Recording / Mic permission across code changes. Just relaunch, no re-grant.
APPDIR="$APP/Contents/Resources/app"
mkdir -p "$APPDIR"
ln -sfn "$ROOT/electron" "$APPDIR/electron"
ln -sfn "$ROOT/renderer" "$APPDIR/renderer"
ln -sfn "$ROOT/sidecar" "$APPDIR/sidecar"
ln -sfn "$ROOT/package.json" "$APPDIR/package.json"

# Brand the bundle: name + identifier + mic usage string.
PLIST="$APP/Contents/Info.plist"
P=/usr/libexec/PlistBuddy
$P -c "Set :CFBundleName Orbit" "$PLIST"
$P -c "Set :CFBundleDisplayName Orbit" 2>/dev/null "$PLIST" || $P -c "Add :CFBundleDisplayName string Orbit" "$PLIST"
$P -c "Set :CFBundleIdentifier com.orbit.copilot" "$PLIST"
$P -c "Add :NSMicrophoneUsageDescription string Orbit transcribes audio locally." 2>/dev/null "$PLIST" || true
$P -c "Add :NSCameraUsageDescription string Not used." 2>/dev/null "$PLIST" || true
# REQUIRED for desktopCapturer loopback (system) audio on macOS 14.2+.
$P -c "Add :NSAudioCaptureUsageDescription string Orbit transcribes call audio locally on-device." 2>/dev/null "$PLIST" || true
# Bake the repo path so the app finds .venv / sidecar wherever it was cloned.
$P -c "Delete :LSEnvironment" 2>/dev/null "$PLIST" || true
$P -c "Add :LSEnvironment dict" "$PLIST"
$P -c "Add :LSEnvironment:ORBIT_REPO string $ROOT" "$PLIST"

# Re-sign ad-hoc (deep) so macOS accepts the modified bundle with a stable id.
echo "→ Code-signing (ad-hoc)…"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1

echo "→ Registering with LaunchServices…"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true

echo "✅ Built $APP"
echo "   Launch it with:  open \"$APP\""
