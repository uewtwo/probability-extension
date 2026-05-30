// probability — 国際化(i18n)ユーティリティ。
// 既定はブラウザ言語に追従(chrome.i18n)。設定 language が 'en'/'ja' のときは
// 対応するメッセージカタログを自前で読み込み、UI 言語を上書きする。
import { resolveUiLang } from './settings.js';

let _lang = null;
let _catalog = null;

// 設定を読み、必要ならカタログを(再)読み込みする。
export async function loadI18n(force = false) {
  let setting = 'auto';
  try { ({ language: setting } = await chrome.storage.sync.get({ language: 'auto' })); } catch (_) {}
  const lang = resolveUiLang(setting);
  if (!force && lang === _lang && _catalog) return lang;
  try {
    const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
    _catalog = await (await fetch(url)).json();
  } catch (_) {
    _catalog = null; // 失敗時は chrome.i18n にフォールバック
  }
  _lang = lang;
  return lang;
}

export function currentUiLang() {
  return _lang || resolveUiLang('auto');
}

// メッセージ取得。vars で {name} 形式のプレースホルダを置換する。
export function t(key, vars) {
  let s;
  if (_catalog && _catalog[key] && typeof _catalog[key].message === 'string') {
    s = _catalog[key].message;
  } else {
    s = chrome.i18n.getMessage(key) || key;
  }
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}

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
