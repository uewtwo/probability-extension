// probability — background service worker。
// テキスト/メディアの AI 生成判定、通知、バッジ管理を行う。
import { getSettings, classify } from './lib/settings.js';
import { analyzeText, analyzeImage, getAvailability, getImageAvailability } from './lib/detector.js';
import { t, labelFor, loadI18n } from './lib/i18n.js';

const keyOf = (tabId) => `tab:${tabId}`;
const mkeyOf = (tabId) => `media:${tabId}`;
const inFlight = new Set();       // テキスト解析中の tabId
const mediaInFlight = new Set();  // メディア解析中の tabId

// <all_urls> の任意ホスト権限を保有しているか
async function hasHostAccess() {
  try { return await chrome.permissions.contains({ origins: ['<all_urls>'] }); }
  catch (_) { return false; }
}

// ---------- ページ内で実行する抽出関数(executeScript で注入。自己完結が必須) ----------
function pageExtractText() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SVG']);
  function collect(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.offsetParent === null && p.tagName !== 'BODY') return NodeFilter.FILTER_REJECT;
        const t = node.textContent.trim();
        return t.length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      parts.push(n.textContent.trim());
      if (parts.join(' ').length > 8000) break;
    }
    return parts.join(' ');
  }
  const cands = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.body,
  ].filter(Boolean);
  let best = '';
  for (const r of cands) {
    const t = collect(r);
    if (t.length > best.length) best = t;
    if (best.length > 1200) break;
  }
  return { text: best.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), url: location.href, title: document.title };
}

function pageCollectMedia(limit, capture) {
  function visible(el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 80 && r.height >= 80;
  }
  function snap(el, w, h) {
    try {
      const max = 768;
      const s = Math.min(1, max / Math.max(w, h));
      const cw = Math.round(w * s), ch = Math.round(h * s);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(el, 0, 0, cw, ch);
      return c.toDataURL('image/jpeg', 0.85); // クロスオリジン汚染時は throw → null
    } catch (_) { return null; }
  }
  const items = [];
  const seen = new Set();
  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:image/svg') || seen.has(src)) return;
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (w < 128 || h < 128 || !visible(img)) return;
    seen.add(src);
    items.push({ kind: 'image', src, thumb: src, dataUrl: capture ? snap(img, w, h) : null, w, h, area: w * h, frame: false });
  });
  document.querySelectorAll('video').forEach((v) => {
    if (!visible(v)) return;
    const w = v.videoWidth || v.clientWidth || 0, h = v.videoHeight || v.clientHeight || 0;
    const frame = (v.readyState >= 2 && v.videoWidth) ? snap(v, v.videoWidth, v.videoHeight) : null;
    const src = frame || v.poster || v.currentSrc || (v.querySelector('source') && v.querySelector('source').src) || '';
    if (!src || seen.has(src)) return;
    seen.add(src);
    items.push({ kind: 'video', src, thumb: frame || v.poster || '', dataUrl: frame, w, h, area: (w || 480) * (h || 360), frame: !!frame });
  });
  items.sort((a, b) => b.area - a.area);
  return items.slice(0, limit);
}

// executeScript でページから抽出(activeTab か <all_urls> 権限が必要)
async function extractText(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageExtractText });
    return r && r.result;
  } catch (_) { return null; }
}
async function collectMedia(tabId, limit, capture) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageCollectMedia, args: [limit, capture] });
    return (r && r.result) || [];
  } catch (_) { return null; }
}

// ---------- session ストレージ ----------
async function getState(tabId) {
  const r = await chrome.storage.session.get(keyOf(tabId));
  return r[keyOf(tabId)] || null;
}
async function setState(tabId, patch) {
  const cur = (await getState(tabId)) || {};
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [keyOf(tabId)]: next });
  return next;
}
async function getMediaState(tabId) {
  const r = await chrome.storage.session.get(mkeyOf(tabId));
  return r[mkeyOf(tabId)] || null;
}
async function setMediaState(tabId, patch) {
  const cur = (await getMediaState(tabId)) || {};
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [mkeyOf(tabId)]: next });
  return next;
}

// ---------- バッジ ----------
async function updateBadge(tabId, state, settings) {
  try {
    if (!settings.showBadge || !state || state.status !== 'done' || state.score == null) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const c = classify(state.score, settings.threshold);
    await chrome.action.setBadgeText({ tabId, text: String(state.score) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: c.color });
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
  } catch (_) {}
}

// ---------- 通知 ----------
function fireNotification(id, options) {
  try {
    chrome.notifications.create(id, { requireInteraction: false, silent: false, ...options }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[probability] 通知の作成に失敗:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn('[probability] 通知の例外:', e);
  }
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function notifyText(tabId, state, settings) {
  if (!settings.notify || state.score == null || state.score < settings.threshold) return;
  await loadI18n();
  const c = classify(state.score, settings.threshold);
  fireNotification(`prob-${tabId}-${state.updatedAt}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t('notif_text_title', { score: state.score }),
    message: `${truncate(state.title || '', 60)}\n${labelFor(c.key)}`,
    contextMessage: state.summary ? truncate(state.summary, 120) : undefined,
    priority: 1,
  });
}

async function notifyMedia(tabId, mstate, settings) {
  if (!settings.notify) return;
  const hits = (mstate.items || []).filter((i) => i.status === 'done' && i.score >= settings.threshold);
  if (hits.length === 0) return;
  await loadI18n();
  fireNotification(`probmedia-${tabId}-${mstate.updatedAt}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: t('notif_media_title'),
    message: t('notif_media_msg', { count: hits.length, total: mstate.items.length }),
    priority: 1,
  });
}

// ---------- ポップアップウィンドウ表示 ----------
// しきい値超過時に「アイコンクリックと同じ画面」をウィンドウとして開く。
// 既に開いていれば再利用してフォーカスする。
async function openAlertWindow(tabId, which) {
  const url = chrome.runtime.getURL(
    `popup.html?tabId=${tabId}&src=alert${which === 'media' ? '&tab=media' : ''}`
  );
  try {
    const { alertWindow } = await chrome.storage.session.get('alertWindow');
    if (alertWindow != null) {
      try {
        await chrome.windows.get(alertWindow); // 存在確認(なければ throw)
        const tabs = await chrome.tabs.query({ windowId: alertWindow });
        if (tabs[0]) await chrome.tabs.update(tabs[0].id, { url });
        await chrome.windows.update(alertWindow, { focused: true, drawAttention: true });
        return;
      } catch (_) { /* 閉じられている → 新規作成 */ }
    }
    const win = await chrome.windows.create({ url, type: 'popup', width: 372, height: 600, focused: true });
    await chrome.storage.session.set({ alertWindow: win.id });
  } catch (e) {
    console.warn('[probability] ポップアップ表示に失敗:', e);
  }
}

async function maybeAlert(tabId, exceeded, settings, which) {
  if (!settings.popupAlert || !exceeded) return;
  await openAlertWindow(tabId, which);
}

// ---------- テキスト解析 ----------
async function runAnalysis(tabId, text, meta) {
  if (inFlight.has(tabId)) return;
  const settings = await getSettings();
  const clean = (text || '').trim();

  if (clean.length < settings.minChars) {
    const st = await setState(tabId, {
      ...meta, status: 'skipped', score: null,
      message: t('st_skipped_default'),
    });
    await updateBadge(tabId, st, settings);
    return;
  }

  const availability = await getAvailability();
  if (availability !== 'available') {
    const needsDownload = availability === 'downloadable' || availability === 'downloading';
    const st = await setState(tabId, {
      ...meta, status: needsDownload ? 'needs-download' : 'unavailable', score: null, availability,
    });
    await updateBadge(tabId, st, settings);
    return;
  }

  inFlight.add(tabId);
  await setState(tabId, { ...meta, status: 'analyzing', score: null });
  try {
    const input = clean.slice(0, settings.maxChars);
    const result = await analyzeText(input);
    const st = await setState(tabId, {
      ...meta, status: 'done',
      score: result.score, summary: result.summary, reasons: result.reasons,
      analyzedChars: input.length,
    });
    await updateBadge(tabId, st, settings);
    await notifyText(tabId, st, settings);
    await maybeAlert(tabId, st.score != null && st.score >= settings.threshold, settings, 'text');
  } catch (e) {
    const st = await setState(tabId, { ...meta, status: 'error', message: String((e && e.message) || e) });
    await updateBadge(tabId, st, settings);
  } finally {
    inFlight.delete(tabId);
  }
}

// ---------- メディア解析 ----------
// メディア1件を ImageBitmap 化する。
// dataUrl(ページ内でキャプチャ済み)があれば優先。なければ host 権限がある場合のみ src を fetch。
async function bitmapForItem(item, hasHost) {
  const source = item.dataUrl || ((hasHost || (item.src || '').startsWith('data:')) ? item.src : null);
  if (!source) {
    const e = new Error('cross-origin'); e.code = 'NO_HOST'; throw e;
  }
  const resp = await fetch(source);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

async function runMediaAnalysis(tabId, { force } = {}) {
  if (mediaInFlight.has(tabId)) return;
  const settings = await getSettings();

  if (!settings.analyzeMedia) {
    await setMediaState(tabId, { status: 'disabled', items: [] });
    return;
  }

  // 画像対応モデルの状態確認
  const availability = await getImageAvailability();
  if (availability !== 'available') {
    const needsDownload = availability === 'downloadable' || availability === 'downloading';
    await setMediaState(tabId, {
      status: needsDownload ? 'needs-download' : 'unavailable', items: [], availability,
    });
    return;
  }

  // 既に同一 URL で完了済みなら再実行しない
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) {}
  const url = tab && tab.url;
  const prev = await getMediaState(tabId);
  if (!force && prev && prev.url === url && prev.status === 'done') return;

  mediaInFlight.add(tabId);
  try {
    const hasHost = await hasHostAccess();
    await setMediaState(tabId, { status: 'collecting', url, items: [], total: 0, doneCount: 0 });
    // host 権限が無い場合はページ内で画素をキャプチャ(同一オリジン/CORS可のみ)
    const found = await collectMedia(tabId, settings.maxMedia, !hasHost);
    if (found === null) {
      await setMediaState(tabId, { status: 'error', url, items: [], message: t('media_no_access') });
      return;
    }
    if (found.length === 0) {
      await setMediaState(tabId, { status: 'empty', url, items: [], total: 0, doneCount: 0 });
      return;
    }

    const items = found.map((m) => ({
      kind: m.kind, src: m.src, thumb: m.thumb || m.src, dataUrl: m.dataUrl, w: m.w, h: m.h, frame: m.frame,
      status: 'pending', score: null, summary: '', reasons: [],
    }));
    await setMediaState(tabId, { status: 'analyzing', url, items, total: items.length, doneCount: 0 });

    let done = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const bitmap = await bitmapForItem(it, hasHost);
        const result = await analyzeImage(bitmap, it.kind);
        bitmap.close && bitmap.close();
        items[i] = { ...it, status: 'done', score: result.score, summary: result.summary, reasons: result.reasons };
      } catch (e) {
        items[i] = { ...it, status: 'error', message: e && e.code === 'NO_HOST' ? t('media_item_cors') : String((e && e.message) || e) };
      }
      // dataUrl は容量が大きいので保存時には落とす
      delete items[i].dataUrl;
      done++;
      await setMediaState(tabId, { status: 'analyzing', url, items: items.slice(), total: items.length, doneCount: done });
    }

    const final = await setMediaState(tabId, { status: 'done', url, items, total: items.length, doneCount: done });
    await notifyMedia(tabId, final, settings);
    const mediaExceeded = final.items.some((i) => i.status === 'done' && i.score >= settings.threshold);
    await maybeAlert(tabId, mediaExceeded, settings, 'media');
  } catch (e) {
    await setMediaState(tabId, { status: 'error', message: String((e && e.message) || e) });
  } finally {
    mediaInFlight.delete(tabId);
  }
}

// テキストをページから抽出して解析を起動する共通処理
async function analyzeTab(tabId) {
  const extracted = await extractText(tabId);
  if (!extracted) {
    await setState(tabId, { status: 'error', message: t('st_extract_failed') });
    return;
  }
  const meta = { url: extracted.url, title: extracted.title, text: extracted.text };
  await runAnalysis(tabId, extracted.text, meta);
}

// ---------- メッセージ処理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'GET_RESULT') {
      const state = await getState(msg.tabId);
      const availability = await getAvailability();
      const settings = await getSettings();
      return sendResponse({ state, availability, settings });
    }

    if (msg.type === 'ANALYZE') {
      analyzeTab(msg.tabId);
      return sendResponse({ ok: true });
    }

    if (msg.type === 'GET_MEDIA') {
      const mstate = await getMediaState(msg.tabId);
      const imageAvailability = await getImageAvailability();
      const settings = await getSettings();
      return sendResponse({ mstate, imageAvailability, settings });
    }

    if (msg.type === 'ANALYZE_MEDIA') {
      runMediaAnalysis(msg.tabId, { force: msg.force });
      return sendResponse({ ok: true });
    }

    if (msg.type === 'TEST_NOTIFICATION') {
      await loadI18n();
      fireNotification(`probtest-${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: t('notif_test_title'),
        message: t('notif_test_msg'),
        priority: 2,
      });
      return sendResponse({ ok: true });
    }
  })();
  return true;
});

// タブ更新でバッジとメディア結果をクリア
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'loading' && info.url) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (_) {}
    await chrome.storage.session.remove([keyOf(tabId), mkeyOf(tabId)]).catch(() => {});
  }
  // 自動判定: 全サイト権限がある場合のみ(無い場合はクリック起点でのみ動作)
  if (info.status === 'complete' && /^https?:/.test(tab.url || '')) {
    const settings = await getSettings();
    if (!settings.autoAnalyze) return;
    if (!(await hasHostAccess())) return;
    const prev = await getState(tabId);
    if (prev && prev.url === tab.url && prev.status === 'done') return;
    analyzeTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([keyOf(tabId), mkeyOf(tabId)]).catch(() => {});
});

// アラートウィンドウが閉じられたら記録を破棄
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { alertWindow } = await chrome.storage.session.get('alertWindow');
  if (alertWindow === windowId) await chrome.storage.session.remove('alertWindow').catch(() => {});
});

// 通知クリックで該当タブをアクティブに
chrome.notifications.onClicked.addListener((id) => {
  const m = /^prob(?:media)?-(\d+)-/.exec(id);
  if (m) {
    const tabId = Number(m[1]);
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
    chrome.notifications.clear(id).catch(() => {});
  }
});
