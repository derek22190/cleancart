#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# HeyBroc — Production Google Play Upload Keystore Generator
# ==============================================================================
# Run this script once to generate a dedicated 2048-bit RSA upload keystore
# (`heybroc-upload.jks`) and print out the exact 4 secrets to paste into:
# GitHub Repo -> Settings -> Secrets and variables -> Actions
# ==============================================================================

KEYSTORE_PATH="${1:-/tmp/heybroc-upload.jks}"
KEY_ALIAS="heybroc_upload"
STORE_PASS="$(openssl rand -hex 16)"
KEY_PASS="$STORE_PASS"

rm -f "$KEYSTORE_PATH"

keytool -genkeypair -v \
  -keystore "$KEYSTORE_PATH" \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias "$KEY_ALIAS" \
  -storepass "$STORE_PASS" \
  -keypass "$KEY_PASS" \
  -dname "CN=HeyBroc, O=HeyBroc LLC, C=US"

KEYSTORE_B64="$(base64 -w 0 "$KEYSTORE_PATH" 2>/dev/null || base64 "$KEYSTORE_PATH" | tr -d '\n')"

echo ""
echo "========================================================================"
echo "✅ GENERATED PRODUCTION UPLOAD KEYSTORE: $KEYSTORE_PATH"
echo "========================================================================"
echo "Copy these 4 values into GitHub -> Settings -> Secrets -> Actions:"
echo ""
echo "1) KEY_ALIAS:"
echo "$KEY_ALIAS"
echo ""
echo "2) KEYSTORE_PASSWORD:"
echo "$STORE_PASS"
echo ""
echo "3) KEY_PASSWORD:"
echo "$KEY_PASS"
echo ""
echo "4) KEYSTORE_BASE64:"
echo "$KEYSTORE_B64"
echo "========================================================================"
echo "⚠️  Keep a backup copy of $KEYSTORE_PATH in a safe place (e.g., 1Password / Google Drive)!"
