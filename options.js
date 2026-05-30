// probability — 設定画面ロジック
import { getSettings, setSettings } from './lib/settings.js';
import { getImageAvailability, downloadModel } from './lib/detector.js';
import { t, localizeDom, loadI18n } from './lib/i18n.js';

const $ = (id) => document.getElementById(id);
let savedTimer = null;

function flashSaved() {
  const el = $('saved');
  el.hidden = false; el.style.opacity = '1';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => (el.hidden = true), 300); }, 1200);
}

// ---- モデル状態 ----
async function refreshModelStatus() {
  const pill = $('modelStatus');
  const btn = $('downloadBtn');
  const hint = $('modelHint');
  // 画像対応(マルチモーダル)モデルの状態をまとめて確認する
  const availability = await getImageAvailability();

  pill.className = 'status-pill';
  btn.hidden = true;

  switch (availability) {
    case 'available':
      pill.textContent = t('opt_model_available'); pill.classList.add('ok');
      hint.textContent = t('opt_model_available_hint');
      break;
    case 'downloadable':
      pill.textContent = t('opt_model_downloadable'); pill.classList.add('warn');
      btn.hidden = false; btn.textContent = t('opt_btn_download'); btn.disabled = false;
      hint.textContent = t('opt_model_downloadable_hint');
      break;
    case 'downloading':
      pill.textContent = t('opt_model_downloading'); pill.classList.add('warn');
      hint.textContent = t('opt_model_downloading_hint');
      break;
    case 'unsupported':
      pill.textContent = t('opt_model_unsupported'); pill.classList.add('err');
      hint.innerHTML = t('opt_model_unsupported_hint');
      break;
    default:
      pill.textContent = t('opt_model_unavailable'); pill.classList.add('err');
      hint.textContent = t('opt_model_unavailable_hint');
  }
}

async function onDownload() {
  const btn = $('downloadBtn');
  const wrap = $('progressWrap');
  const bar = $('progressBar');
  btn.disabled = true; btn.textContent = t('opt_btn_preparing');
  wrap.hidden = false; bar.style.width = '0%';
  try {
    // 画像入力対応モデルを取得(テキストも同モデルでカバーされる)
    await downloadModel((loaded) => {
      const pct = Math.round((loaded || 0) * 100);
      bar.style.width = pct + '%';
      btn.textContent = t('opt_btn_downloading', { pct });
    }, { expectedInputs: [{ type: 'image' }] });
    bar.style.width = '100%';
    await refreshModelStatus();
    setTimeout(() => { wrap.hidden = true; }, 800);
  } catch (e) {
    btn.disabled = false; btn.textContent = t('opt_btn_retry');
    $('modelHint').textContent = t('opt_download_failed', { error: (e && e.message) || e });
  }
}

// ---- サイトへのアクセス(任意ホスト権限) ----
const ALL_URLS = { origins: ['<all_urls>'] };

async function refreshAccess() {
  const granted = await chrome.permissions.contains(ALL_URLS).catch(() => false);
  const pill = $('accessStatus');
  const btn = $('accessBtn');
  pill.className = 'status-pill';
  if (granted) {
    pill.textContent = t('opt_access_granted'); pill.classList.add('ok');
    btn.textContent = t('opt_access_revoke_btn');
    btn.dataset.action = 'revoke';
  } else {
    pill.textContent = t('opt_access_notgranted'); pill.classList.add('warn');
    btn.textContent = t('opt_access_grant_btn');
    btn.dataset.action = 'grant';
  }
}

async function onAccessClick() {
  const action = $('accessBtn').dataset.action;
  try {
    if (action === 'grant') await chrome.permissions.request(ALL_URLS);
    else await chrome.permissions.remove(ALL_URLS);
  } catch (_) {}
  await refreshAccess();
}

// ---- 通知テスト ----
async function onTestNotification() {
  const result = $('testNotifResult');
  try {
    await chrome.runtime.sendMessage({ type: 'TEST_NOTIFICATION' });
    result.textContent = t('opt_testNotif_ok');
  } catch (e) {
    result.textContent = t('opt_testNotif_fail', { error: (e && e.message) || e });
  }
  result.hidden = false;
}

// ---- 設定の読み書き ----
async function load() {
  const s = await getSettings();
  $('language').value = s.language;
  $('threshold').value = s.threshold;
  $('thresholdVal').textContent = s.threshold + '%';
  $('minChars').value = s.minChars;
  $('minCharsVal').textContent = s.minChars;
  $('autoAnalyze').checked = s.autoAnalyze;
  $('analyzeMedia').checked = s.analyzeMedia;
  $('notify').checked = s.notify;
  $('popupAlert').checked = s.popupAlert;
  $('showBadge').checked = s.showBadge;
}

function wire() {
  $('threshold').addEventListener('input', (e) => { $('thresholdVal').textContent = e.target.value + '%'; });
  $('threshold').addEventListener('change', async (e) => { await setSettings({ threshold: Number(e.target.value) }); flashSaved(); });

  $('minChars').addEventListener('input', (e) => { $('minCharsVal').textContent = e.target.value; });
  $('minChars').addEventListener('change', async (e) => { await setSettings({ minChars: Number(e.target.value) }); flashSaved(); });

  for (const id of ['autoAnalyze', 'analyzeMedia', 'notify', 'popupAlert', 'showBadge']) {
    $(id).addEventListener('change', async (e) => { await setSettings({ [id]: e.target.checked }); flashSaved(); });
  }

  // 言語変更: 保存後にページを再読み込みして全 UI を選択言語で再描画
  $('language').addEventListener('change', async (e) => {
    await setSettings({ language: e.target.value });
    location.reload();
  });

  $('accessBtn').addEventListener('click', onAccessClick);
  $('downloadBtn').addEventListener('click', onDownload);
  $('testNotifBtn').addEventListener('click', onTestNotification);
  chrome.permissions.onAdded.addListener(refreshAccess);
  chrome.permissions.onRemoved.addListener(refreshAccess);
}

(async function init() {
  await loadI18n();
  localizeDom();
  await load();
  wire();
  await refreshAccess();
  await refreshModelStatus();
})();
