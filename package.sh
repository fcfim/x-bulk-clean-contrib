#!/bin/bash
# package.sh — Pack the extension for Chrome Web Store
set -e

# Change directory to the root of the repository
cd "$(dirname "$0")"

# Read version from manifest
VERSION=$(grep -o '"version": "[^"]*' src/manifest.json | head -n 1 | cut -d'"' -f4)
ZIP_NAME="x-bulk-clean-v${VERSION}.zip"

# Remove any existing zip
rm -f "$ZIP_NAME"

# Zip contents of the src/ directory
cd src
zip -r "../$ZIP_NAME" . -x "*.DS_Store"

echo "Extension packaged successfully: $ZIP_NAME"
