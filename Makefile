# probability — ビルドタスク
# 使い方: make build / make icons / make clean / make check

.PHONY: build icons clean check help

help:
	@echo "make build  - ストア用 ZIP を dist/ に生成(検証込み)"
	@echo "make icons  - アイコン(icons/*.png)を再生成"
	@echo "make check  - JSON / JS の検証のみ実行"
	@echo "make clean  - dist/ と zip を削除"

build:
	@bash scripts/build.sh

icons:
	@python3 gen_icons.py

check:
	@python3 -c "import json; json.load(open('manifest.json')); print('manifest.json OK')"
	@for f in _locales/*/messages.json; do python3 -c "import json,sys; json.load(open(sys.argv[1])); print(sys.argv[1], 'OK')" "$$f"; done
	@for f in background.js popup.js options.js lib/*.js; do node --check --input-type=module < "$$f" && echo "$$f OK"; done

clean:
	@rm -rf dist *.zip
	@echo "cleaned"
