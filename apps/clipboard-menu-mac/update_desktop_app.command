#!/bin/zsh
set -euo pipefail

APP="$HOME/Desktop/Clipboard Menu.app"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEYCHAIN="$HOME/Library/Keychains/clipboard-menu-signing.keychain-db"
KEYCHAIN_PASSWORD="clipboard-menu-local"
IDENTITY="Clipboard Menu Local Code Signing"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

cd "$PROJECT_DIR"
swift build -c release

cp "$PROJECT_DIR/.build/arm64-apple-macosx/release/ClipboardMenuMacApp" \
  "$APP/Contents/MacOS/ClipboardMenuMacApp"
chmod +x "$APP/Contents/MacOS/ClipboardMenuMacApp"

security list-keychains -d user -s "$KEYCHAIN" "$LOGIN_KEYCHAIN" "/Library/Keychains/System.keychain"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
codesign --force --deep --keychain "$KEYCHAIN" --sign "$IDENTITY" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Updated and signed: $APP"
