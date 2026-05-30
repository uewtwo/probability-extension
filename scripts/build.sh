#!/usr/bin/env bash
# probability — Chrome ウェブストア用 ZIP を生成する。
# manifest.json を ZIP ルート直下に置き、拡張の実行に必要なファイルのみを同梱する。
set -euo pipefail

# リポジトリルートへ移動(このスクリプトは scripts/ 配下にある想定)
cd "$(dirname "$0")/.."

NAME="probability-extension"
DIST="dist"

# 同梱するファイル/ディレクトリ(これ以外は ZIP に含めない)
FILES=(
  manifest.json
  background.js
  popup.html popup.js popup.css
  options.html options.js options.css
  theme.css
  lib
  _locales
  icons
)

# --- バージョン取得(manifest.json が単一ソース) ---
if command -v node >/dev/null 2>&1; then
  VERSION="$(node -p "require('./manifest.json').version")"
else
  VERSION="$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")"
fi
OUT="${DIST}/${NAME}-v${VERSION}.zip"

# --- 存在チェック ---
for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "ERROR: 必要なファイルがありません: $f" >&2; exit 1; }
done

# --- 検証(JSON / JS 構文) ---
echo "▶ 検証中..."
python3 -c "import json; json.load(open('manifest.json'))" \
  || { echo "ERROR: manifest.json が不正な JSON です" >&2; exit 1; }
for f in _locales/*/messages.json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" \
    || { echo "ERROR: 不正な JSON: $f" >&2; exit 1; }
done
if command -v node >/dev/null 2>&1; then
  # ES モジュール(stdin 経由で module 扱い)と通常スクリプト(content.js)を分けて検査
  for f in background.js popup.js options.js lib/*.js; do
    node --check --input-type=module < "$f" || { echo "ERROR: 構文エラー: $f" >&2; exit 1; }
  done
else
  echo "  (node が無いため JS 構文チェックはスキップ)"
fi

# --- ZIP 生成 ---
mkdir -p "$DIST"
rm -f "$OUT"
zip -rq "$OUT" "${FILES[@]}" -x '*.DS_Store'

echo "✅ 生成: $OUT"
echo "──────────────────────────────"
unzip -l "$OUT"
