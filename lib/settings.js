// probability — 共有の設定・定数モジュール
// background(module worker) と popup / options(module script) の双方から import される。

export const DEFAULTS = Object.freeze({
  language: 'auto',     // 表示言語: 'auto'(ブラウザ準拠) | 'en' | 'ja'
  threshold: 70,        // この値(%)以上で「AI 生成の可能性が高い」と判定し通知
  autoAnalyze: true,    // ページ読み込み時に自動判定(テキスト)
  analyzeMedia: true,   // ポップアップ起動時にページ内メディアを判定
  notify: true,         // しきい値超過時にデスクトップ通知を出す
  popupAlert: true,     // しきい値超過時にポップアップウィンドウを表示する
  showBadge: true,      // ツールバーアイコンにスコアバッジを表示
  minChars: 280,        // 解析に必要な最小文字数(短すぎるページはスキップ)
  maxChars: 6000,       // モデルへ渡す最大文字数
  maxMedia: 8,          // 1 ページで判定するメディアの最大数
});

// UI が持つロケール。language 設定('auto'/'en'/'ja')を実際の en/ja に解決する。
export const UI_LANGS = ['en', 'ja'];
export function resolveUiLang(setting) {
  if (setting === 'en' || setting === 'ja') return setting;
  let ui = 'en';
  try { ui = (chrome.i18n.getUILanguage() || 'en').toLowerCase(); } catch (_) {}
  return ui.startsWith('ja') ? 'ja' : 'en';
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

// スコア(0-100)としきい値から分類キーと配色を決める。
// ラベル文言は i18n(labelFor)側で解決する。
export function classify(score, threshold) {
  if (score >= threshold) return { key: 'high', color: '#ef4444' };
  if (score >= Math.max(0, threshold - 25)) return { key: 'mixed', color: '#f59e0b' };
  return { key: 'low', color: '#22c55e' };
}
