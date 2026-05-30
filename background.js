// probability — background service worker。
// テキスト/メディアの AI 生成判定、通知、バッジ管理を行う。
import { getSettings, classify } from './lib/settings.js';
import { analyzeText, analyzeImage, getAvailability, getImageAvailability } from './lib/detector.js';
import { t, labelFor } from './lib/i18n.js';

const keyOf = (tabId) => `tab:${tabId}`;
const mkeyOf = (tabId) => `media:${tabId}`;
const inFlight = new Set();       // テキスト解析中の tabId
const mediaInFlight = new Set();  // メディア解析中の tabId

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
async function requestMedia(tabId, limit) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_MEDIA', limit });
  } catch (_) {
    return null;
  }
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
    await setMediaState(tabId, { status: 'collecting', url, items: [], total: 0, doneCount: 0 });
    const res = await requestMedia(tabId, settings.maxMedia);
    const found = (res && res.media) || [];
    if (found.length === 0) {
      await setMediaState(tabId, { status: 'empty', url, items: [], total: 0, doneCount: 0 });
      return;
    }

    const items = found.map((m) => ({
      kind: m.kind, src: m.src, thumb: m.thumb || m.src, w: m.w, h: m.h, frame: m.frame,
      status: 'pending', score: null, summary: '', reasons: [],
    }));
    await setMediaState(tabId, { status: 'analyzing', url, items, total: items.length, doneCount: 0 });

    let done = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const resp = await fetch(it.src);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        const result = await analyzeImage(bitmap, it.kind);
        bitmap.close && bitmap.close();
        items[i] = { ...it, status: 'done', score: result.score, summary: result.summary, reasons: result.reasons };
      } catch (e) {
        items[i] = { ...it, status: 'error', message: String((e && e.message) || e) };
      }
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

async function fetchContent(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_CONTENT' });
  } catch (_) {
    return null;
  }
}

// ---------- メッセージ処理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'PAGE_CONTENT') {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) return sendResponse({ ok: false });
      const meta = { url: msg.url, title: msg.title, text: msg.text };
      const prev = await getState(tabId);
      const settings = await getSettings();
      if (prev && prev.url === msg.url && prev.status === 'done') {
        await setState(tabId, { text: msg.text });
        return sendResponse({ ok: true, skipped: true });
      }
      await setState(tabId, meta);
      if (settings.autoAnalyze) {
        runAnalysis(tabId, msg.text, meta);
      }
      return sendResponse({ ok: true });
    }

    if (msg.type === 'GET_RESULT') {
      const state = await getState(msg.tabId);
      const availability = await getAvailability();
      const settings = await getSettings();
      return sendResponse({ state, availability, settings });
    }

    if (msg.type === 'ANALYZE') {
      const tabId = msg.tabId;
      let state = await getState(tabId);
      let text = state && state.text;
      if (!text) {
        const fetched = await fetchContent(tabId);
        if (fetched) {
          text = fetched.text;
          state = await setState(tabId, { url: fetched.url, title: fetched.title, text });
        }
      }
      runAnalysis(tabId, text, {
        url: (state && state.url) || '', title: (state && state.title) || '', text,
      });
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
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading' && info.url) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (_) {}
    await chrome.storage.session.remove(mkeyOf(tabId)).catch(() => {});
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
