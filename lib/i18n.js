// probability — 国際化(i18n)ユーティリティ。
// ブラウザの言語設定に従い chrome.i18n がメッセージを解決する(default_locale = en)。

// メッセージ取得。vars で {name} 形式のプレースホルダを置換する。
export function t(key, vars) {
  let s = chrome.i18n.getMessage(key) || key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split(`{${k}}`).join(String(vars[k]));
    }
  }
  return s;
}

// 分類キー(high/mixed/low)から表示ラベルを得る
export function labelFor(key) {
  return t(`label_${key}`);
}

// DOM 内の [data-i18n] / [data-i18n-title] / [data-i18n-html] を一括で翻訳
export function localizeDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
}
