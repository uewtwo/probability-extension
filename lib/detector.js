// probability — Chrome 組み込み AI(Prompt API / LanguageModel)を使った AI 生成判定ロジック。
// service worker・拡張ページのどちらからも利用できる。テキストと画像/動画の両方に対応。

// Prompt API がサポートする出力言語(en / es / ja)。ブラウザの UI 言語に合わせて選ぶ。
const SUPPORTED_OUT = ['en', 'es', 'ja'];
const LANG_NAMES = { en: 'English', es: 'Spanish', ja: 'Japanese' };

async function outputLanguage() {
  // language 設定('en'/'ja')があればそれを優先。'auto' はブラウザ UI 言語から解決。
  let setting = 'auto';
  try { ({ language: setting } = await chrome.storage.sync.get({ language: 'auto' })); } catch (_) {}
  if (SUPPORTED_OUT.includes(setting)) return setting;
  let ui = 'en';
  try { ui = (chrome.i18n.getUILanguage() || 'en').toLowerCase(); } catch (_) {}
  const base = ui.split('-')[0];
  return SUPPORTED_OUT.includes(base) ? base : 'en';
}

// 出力を短く保つよう明示的に指示する(出力トークン超過による切り詰めを防ぐ)。
function brevityNote(lang) {
  return `\nKeep the output very short to fit the limit: "summary" must be a single concise sentence (max ~120 characters), and "reasons" must be at most 3 items, each a short phrase (max ~12 words). Do not add anything outside the JSON. Write "summary" and "reasons" in ${LANG_NAMES[lang]}.`;
}

const TEXT_SYSTEM = `You are a detector that estimates how likely a passage of text was written by an AI language model versus a human.
Consider: unnaturally uniform style and clichés, lack of specific lived experience or idiosyncratic errors, overly mechanical structure, and thin/generic content.
Always answer strictly as the given JSON schema. "score" is an integer 0 (clearly human) to 100 (clearly AI-generated).`;

const IMAGE_SYSTEM = `You are a detector that estimates how likely an image was produced by a generative AI image model versus being a real photo or human-made artwork.
Consider: broken hands/teeth/text/symmetry and unnatural fusions, overly smooth or uniform textures, impossible structures, nonsensical fine details, and generator artifacts or watermarks.
Always answer strictly as the given JSON schema. "score" is an integer 0 (real / human-made) to 100 (AI-generated).`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string', maxLength: 160 },
    reasons: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 3 },
  },
  required: ['score', 'summary', 'reasons'],
  additionalProperties: false,
};

// LanguageModel API が利用可能かを返す
export function isSupported() {
  return typeof LanguageModel !== 'undefined';
}

// 'unavailable' | 'downloadable' | 'downloading' | 'available' | 'unsupported'
export async function getAvailability(opts) {
  if (!isSupported()) return 'unsupported';
  try {
    return await LanguageModel.availability(opts);
  } catch (e) {
    return 'unsupported';
  }
}

export function getImageAvailability() {
  return getAvailability({ expectedInputs: [{ type: 'image' }] });
}

// モデルのダウンロードを開始(要ユーザー操作)。進捗を onProgress(0..1) で通知。
export async function downloadModel(onProgress, opts = {}) {
  if (!isSupported()) throw new Error('この環境では組み込み AI を利用できません。');
  const session = await LanguageModel.create({
    expectedOutputs: [{ type: 'text', languages: [await outputLanguage()] }],
    ...opts,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        if (typeof onProgress === 'function') onProgress(e.loaded);
      });
    },
  });
  session.destroy();
  return true;
}

// 出力が途中で切れても score を救出するための寛容なパーサ。
function parseResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = salvage(raw);
  }
  if (!parsed || typeof parsed.score === 'undefined') {
    throw new Error('モデル出力を解析できませんでした(出力が途中で切れた可能性があります)。');
  }
  parsed.score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  if (!Array.isArray(parsed.reasons)) parsed.reasons = [];
  parsed.reasons = parsed.reasons.filter((r) => typeof r === 'string' && r.trim());
  if (typeof parsed.summary !== 'string') parsed.summary = '';
  return parsed;
}

// 切り詰められた JSON 文字列から score / summary / 完結している reasons を抽出する。
function salvage(raw) {
  const out = {};
  const sm = raw.match(/"score"\s*:\s*(\d{1,3})/);
  if (sm) out.score = Number(sm[1]);
  const um = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (um) { try { out.summary = JSON.parse('"' + um[1] + '"'); } catch (_) {} }
  const reasons = [];
  const rm = raw.match(/"reasons"\s*:\s*\[([\s\S]*)/);
  if (rm) {
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(rm[1]))) { try { reasons.push(JSON.parse('"' + m[1] + '"')); } catch (_) {} }
  }
  if (reasons.length) out.reasons = reasons;
  return out;
}

function downloadMonitor(onProgress) {
  return (m) => {
    m.addEventListener('downloadprogress', (e) => {
      if (typeof onProgress === 'function') onProgress(e.loaded);
    });
  };
}

// テキストを解析し {score, summary, reasons} を返す。
export async function analyzeText(text, { onProgress } = {}) {
  if (!isSupported()) {
    throw new Error('この環境では組み込み AI を利用できません(Chrome 138 以降が必要です)。');
  }
  const availability = await getAvailability();
  if (availability === 'unavailable' || availability === 'unsupported') {
    throw new Error('組み込み AI モデルを利用できません。');
  }

  const lang = await outputLanguage();
  const session = await LanguageModel.create({
    initialPrompts: [{ role: 'system', content: TEXT_SYSTEM + brevityNote(lang) }],
    expectedOutputs: [{ type: 'text', languages: [lang] }],
    monitor: downloadMonitor(onProgress),
  });

  try {
    const userPrompt = `Judge how likely the following text is AI-generated.\n\n---\n${text}\n---`;
    const raw = await session.prompt(userPrompt, { responseConstraint: RESPONSE_SCHEMA });
    return parseResult(raw);
  } finally {
    session.destroy();
  }
}

// 巨大な画像はトークン/処理削減のため最大辺 1024px に縮小する
async function fitBitmap(bitmap, max = 1024) {
  const { width: w, height: h } = bitmap;
  if (w <= max && h <= max) return bitmap;
  const scale = max / Math.max(w, h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  if (typeof OffscreenCanvas === 'undefined') return bitmap;
  const canvas = new OffscreenCanvas(nw, nh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, nw, nh);
  const resized = await createImageBitmap(canvas);
  bitmap.close && bitmap.close();
  return resized;
}

// 画像(ImageBitmap)を解析し {score, summary, reasons} を返す。
// kind: 'image' | 'video'(動画フレーム)
export async function analyzeImage(bitmap, kind = 'image', { onProgress } = {}) {
  if (!isSupported()) {
    throw new Error('この環境では組み込み AI を利用できません(Chrome 138 以降が必要です)。');
  }
  const availability = await getImageAvailability();
  if (availability === 'unavailable' || availability === 'unsupported') {
    throw new Error('画像入力に対応した組み込み AI モデルを利用できません。');
  }

  const lang = await outputLanguage();
  const session = await LanguageModel.create({
    expectedInputs: [{ type: 'image' }],
    expectedOutputs: [{ type: 'text', languages: [lang] }],
    initialPrompts: [{ role: 'system', content: IMAGE_SYSTEM + brevityNote(lang) }],
    monitor: downloadMonitor(onProgress),
  });

  let img = bitmap;
  try {
    img = await fitBitmap(bitmap);
    const subject = kind === 'video' ? 'this video frame' : 'this image';
    const promptText = `Judge how likely ${subject} was produced by a generative AI image model.`;
    const raw = await session.prompt(
      [{ role: 'user', content: [{ type: 'text', value: promptText }, { type: 'image', value: img }] }],
      { responseConstraint: RESPONSE_SCHEMA }
    );
    return parseResult(raw);
  } finally {
    session.destroy();
    if (img && img !== bitmap && img.close) img.close();
  }
}
