#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
gates=0
fail() { echo "VERIFY {\"verdict\":\"fail\",\"failed\":\"$1\"}"; exit 1; }
npm install --no-audit --no-fund >&2 || fail install; gates=$((gates+1))
npm run --silent build >&2 || fail build; gates=$((gates+1))
npm run --silent typecheck >&2 || fail typecheck; gates=$((gates+1))
npm test >&2 || fail test; gates=$((gates+1))
echo "VERIFY {\"verdict\":\"pass\",\"gates\":$gates}"
