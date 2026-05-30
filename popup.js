// probability — popup ロジック(テキスト + メディア)
import { classify } from './lib/settings.js';
import { t, labelFor, localizeDom, loadI18n } from './lib/i18n.js';

const CIRC = 2 * Math.PI * 52;
let currentTabId = null;
let textTimer = null;
let mediaTimer = null;

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---------- タブ切替 ----------
function setTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('panel-text').hidden = name !== 'text';
  $('panel-media').hidden = name !== 'media';
}

// ---------- テキスト表示 ----------
function showText(which) {
  $('gaugeWrap').hidden = which !== 'result';
  $('label').hidden = which !== 'result';
  $('summary').hidden = which !== 'result';
  $('reasons').hidden = which !== 'result';
  $('message').hidden = which !== 'message';
}

function renderTextResult(state, settings) {
  showText('result');
  const c = classify(state.score, settings.threshold);
  $('scoreText').textContent = state.score;
  const arc = $('gaugeArc');
  arc.style.stroke = c.color;
  arc.style.strokeDashoffset = String(CIRC * (1 - state.score / 100));
  const label = $('label');
  label.textContent = labelFor(c.key);
  label.style.color = c.color;
  const summary = $('summary');
  summary.textContent = state.summary || '';
  summary.hidden = !state.summary;
  const ul = $('reasons');
  ul.innerHTML = '';
  (state.reasons || []).forEach((r) => {
    const li = document.createElement('li');
    li.textContent = r;
    ul.appendChild(li);
  });
  ul.hidden = !(state.reasons && state.reasons.length);
  $('meta').textContent = state.analyzedChars
    ? t('metaAnalyzedChars', { count: state.analyzedChars.toLocaleString() }) : '';
}

function renderTextMessage({ big, title, body, action }) {
  showText('message');
  const box = $('message');
  box.innerHTML = '';
  if (big) { const d = document.createElement('div'); d.className = 'big'; d.textContent = big; box.appendChild(d); }
  if (title) { const x = document.createElement('div'); x.className = 'title'; x.textContent = title; box.appendChild(x); }
  const p = document.createElement('div'); p.textContent = body || ''; box.appendChild(p);
  if (action) { const b = document.createElement('button'); b.className = 'link-btn'; b.textContent = action.label; b.onclick = action.onClick; box.appendChild(b); }
  $('meta').textContent = '';
}

function renderTextSpinner(text) {
  showText('message');
  const box = $('message');
  box.innerHTML = '<div class="spinner"></div>';
  const p = document.createElement('div'); p.textContent = text; box.appendChild(p);
  $('meta').textContent = '';
}

function stopTextPoll() { if (textTimer) { clearInterval(textTimer); textTimer = null; } }

async function refreshText() {
  const res = await send({ type: 'GET_RESULT', tabId: currentTabId });
  if (!res) return;
  const { state, availability, settings } = res;

  if (availability === 'unsupported') {
    stopTextPoll();
    renderTextMessage({ big: '🚫', title: t('st_unsupported_title'), body: t('st_unsupported_body') });
    $('reanalyze').disabled = true;
    return;
  }
  if (availability === 'downloadable' || availability === 'downloading' || (state && state.status === 'needs-download')) {
    stopTextPoll();
    renderTextMessage({ big: '⬇️', title: t('st_download_title'), body: t('st_download_body'),
      action: { label: t('st_openSettings'), onClick: () => chrome.runtime.openOptionsPage() } });
    return;
  }
  if (!state) {
    stopTextPoll();
    renderTextMessage({ big: '📄', title: t('st_notYet_title'), body: t('st_notYet_body') });
    return;
  }

  switch (state.status) {
    case 'analyzing':
      renderTextSpinner(t('st_analyzing'));
      if (!textTimer) textTimer = setInterval(refreshText, 700);
      break;
    case 'done':
      stopTextPoll(); renderTextResult(state, settings); break;
    case 'skipped':
      stopTextPoll(); renderTextMessage({ big: '✋', title: t('st_skipped_title'), body: state.message || t('st_skipped_default') }); break;
    case 'error':
      stopTextPoll(); renderTextMessage({ big: '⚠️', title: t('st_error_title'), body: state.message || t('st_error_default') }); break;
    case 'unavailable':
      stopTextPoll(); renderTextMessage({ big: '🚫', title: t('st_unavailable_title'), body: t('st_unavailable_body') }); break;
    default:
      stopTextPoll(); renderTextMessage({ big: '📄', title: t('st_ready_title'), body: t('st_ready_body') });
  }
}

// ---------- メディア表示 ----------
function stopMediaPoll() { if (mediaTimer) { clearInterval(mediaTimer); mediaTimer = null; } }

function showMedia(which) {
  $('mediaStatus').hidden = which !== 'message';
  $('mediaGrid').hidden = which !== 'grid';
}

function renderMediaMessage({ big, title, body, action, spinner }) {
  showMedia('message');
  const box = $('mediaStatus');
  box.innerHTML = '';
  if (spinner) { const s = document.createElement('div'); s.className = 'spinner'; box.appendChild(s); }
  if (big) { const d = document.createElement('div'); d.className = 'big'; d.textContent = big; box.appendChild(d); }
  if (title) { const x = document.createElement('div'); x.className = 'title'; x.textContent = title; box.appendChild(x); }
  if (body) { const p = document.createElement('div'); p.textContent = body; box.appendChild(p); }
  if (action) { const b = document.createElement('button'); b.className = 'link-btn'; b.textContent = action.label; b.onclick = action.onClick; box.appendChild(b); }
}

function renderMediaGrid(mstate, settings) {
  showMedia('grid');
  const grid = $('mediaGrid');
  grid.innerHTML = '';
  mstate.items.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'media-card';

    const thumb = document.createElement('div');
    thumb.className = 'media-thumb';
    if (it.thumb) {
      const img = document.createElement('img');
      img.src = it.thumb; img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      thumb.classList.add('no-thumb');
      thumb.textContent = it.kind === 'video' ? '🎬' : '🖼️';
    }

    const kindTag = document.createElement('span');
    kindTag.className = 'kind-tag';
    kindTag.textContent = t(it.kind === 'video' ? 'media_kind_video' : 'media_kind_image');
    thumb.appendChild(kindTag);

    const badge = document.createElement('span');
    badge.className = 'media-badge';
    if (it.status === 'done') {
      const c = classify(it.score, settings.threshold);
      badge.textContent = it.score;
      badge.style.background = c.color;
      card.title = it.summary || '';
    } else if (it.status === 'error') {
      badge.textContent = t('media_item_error');
      badge.classList.add('na');
    } else if (it.status === 'analyzing') {
      badge.textContent = t('media_item_analyzing');
      badge.classList.add('na');
    } else {
      badge.textContent = t('media_item_pending');
      badge.classList.add('na');
    }
    thumb.appendChild(badge);
    card.appendChild(thumb);

    if (it.status === 'done') {
      const c = classify(it.score, settings.threshold);
      const lbl = document.createElement('div');
      lbl.className = 'media-label';
      lbl.textContent = labelFor(c.key);
      lbl.style.color = c.color;
      card.appendChild(lbl);
    }
    grid.appendChild(card);
  });
}

async function refreshMedia() {
  const res = await send({ type: 'GET_MEDIA', tabId: currentTabId });
  if (!res) return;
  const { mstate, imageAvailability, settings } = res;

  if (imageAvailability === 'unsupported') {
    stopMediaPoll();
    renderMediaMessage({ big: '🚫', title: t('st_unsupported_title'), body: t('st_unsupported_body') });
    $('reanalyzeMedia').disabled = true;
    return;
  }
  if (!mstate) { renderMediaMessage({ spinner: true, body: t('media_analyzing') }); return; }

  switch (mstate.status) {
    case 'disabled':
      stopMediaPoll();
      renderMediaMessage({ big: '🎛️', title: t('media_disabled_title'), body: t('media_disabled_body'),
        action: { label: t('st_openSettings'), onClick: () => chrome.runtime.openOptionsPage() } });
      break;
    case 'needs-download':
      stopMediaPoll();
      renderMediaMessage({ big: '⬇️', title: t('media_download_title'), body: t('media_download_body'),
        action: { label: t('st_openSettings'), onClick: () => chrome.runtime.openOptionsPage() } });
      break;
    case 'unavailable':
      stopMediaPoll();
      renderMediaMessage({ big: '🚫', title: t('st_unavailable_title'), body: t('st_unavailable_body') });
      break;
    case 'empty':
      stopMediaPoll();
      renderMediaMessage({ big: '🖼️', title: t('media_empty_title'), body: t('media_empty_body') });
      break;
    case 'collecting':
      renderMediaMessage({ spinner: true, body: t('media_analyzing') });
      if (!mediaTimer) mediaTimer = setInterval(refreshMedia, 800);
      break;
    case 'analyzing':
      if (mstate.items && mstate.items.length) {
        renderMediaGrid(mstate, settings);
      } else {
        renderMediaMessage({ spinner: true, body: t('media_progress', { done: mstate.doneCount || 0, total: mstate.total || 0 }) });
      }
      if (!mediaTimer) mediaTimer = setInterval(refreshMedia, 800);
      break;
    case 'done':
      stopMediaPoll();
      renderMediaGrid(mstate, settings);
      break;
    case 'error':
      stopMediaPoll();
      renderMediaMessage({ big: '⚠️', title: t('st_error_title'), body: mstate.message || t('st_error_default') });
      break;
    default:
      renderMediaMessage({ spinner: true, body: t('media_analyzing') });
  }
}

// ---------- 初期化 ----------
async function init() {
  await loadI18n();
  localizeDom();

  // アラートウィンドウとして開かれた場合は対象タブ ID をクエリから受け取る
  const params = new URLSearchParams(location.search);
  const forcedTabId = params.get('tabId');
  const isAlert = params.get('src') === 'alert';
  const initialTab = params.get('tab') === 'media' ? 'media' : 'text';

  // アラートウィンドウとして開かれた場合、ESC で閉じられるようにする
  if (isAlert) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        chrome.windows.getCurrent()
          .then((w) => chrome.windows.remove(w.id))
          .catch(() => window.close());
      }
    });
  }

  let tab = null;
  try {
    if (forcedTabId) tab = await chrome.tabs.get(Number(forcedTabId));
    else tab = await getActiveTab();
  } catch (_) { tab = null; }

  if (!tab || !/^https?:/.test(tab.url || '')) {
    setTab('text');
    renderTextMessage({ big: '🌐', title: t('st_notHttp_title'), body: t('st_notHttp_body') });
    $('reanalyze').disabled = true;
    $('reanalyzeMedia').disabled = true;
    return;
  }
  currentTabId = tab.id;

  // タブ
  document.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => { setTab(b.dataset.tab); if (b.dataset.tab === 'media') refreshMedia(); };
  });

  $('settings').onclick = () => chrome.runtime.openOptionsPage();

  // テキスト: 判定/再判定
  $('reanalyze').onclick = async () => {
    $('reanalyze').disabled = true;
    renderTextSpinner(t('st_analyzing'));
    await send({ type: 'ANALYZE', tabId: currentTabId });
    setTimeout(() => { $('reanalyze').disabled = false; }, 1200);
    if (!textTimer) textTimer = setInterval(refreshText, 700);
    refreshText();
  };

  // メディア: 再判定
  $('reanalyzeMedia').onclick = async () => {
    renderMediaMessage({ spinner: true, body: t('media_analyzing') });
    await send({ type: 'ANALYZE_MEDIA', tabId: currentTabId, force: true });
    if (!mediaTimer) mediaTimer = setInterval(refreshMedia, 800);
    refreshMedia();
  };

  const res = await send({ type: 'GET_RESULT', tabId: currentTabId });
  const done = res && res.state && res.state.status === 'done';
  $('reanalyze').textContent = t(done ? 'btnReanalyze' : 'btnAnalyze');

  // 通常のアイコンクリック起動時はメディア判定を開始する。
  // アラートウィンドウ起動時は再解析ループを避けるため自動開始しない。
  if (!isAlert) send({ type: 'ANALYZE_MEDIA', tabId: currentTabId });

  // 初期タブ(アラートが画像・動画起因なら media タブを表示)
  if (initialTab === 'media') {
    setTab('media');
    if (isAlert) send({ type: 'ANALYZE_MEDIA', tabId: currentTabId });
    refreshMedia();
  }

  refreshText();
}

init();
