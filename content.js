// probability — コンテンツスクリプト。
// ページの本文テキストと、判定対象のメディア(画像・動画)を抽出して background へ渡す。

(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SVG']);

  // ---------- テキスト抽出 ----------
  function extractText() {
    const candidates = [
      document.querySelector('article'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.body,
    ].filter(Boolean);

    let best = '';
    for (const root of candidates) {
      const text = collect(root);
      if (text.length > best.length) best = text;
      if (best.length > 1200) break;
    }
    return best.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

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

  // ---------- メディア抽出 ----------
  function isVisible(el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 80 && r.height >= 80;
  }

  // 動画の現在フレームを dataURL 化(クロスオリジンで汚染される場合は null)
  function captureFrame(video) {
    if (video.readyState < 2 || !video.videoWidth) return null;
    try {
      const max = 768;
      const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.85); // 汚染時は SecurityError を投げる
    } catch (_) {
      return null;
    }
  }

  function collectMedia(limit = 12) {
    const items = [];
    const seen = new Set();

    document.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:image/svg') || seen.has(src)) return;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < 128 || h < 128) return;
      if (!isVisible(img)) return;
      seen.add(src);
      items.push({ kind: 'image', src, thumb: src, w, h, area: w * h, frame: false });
    });

    document.querySelectorAll('video').forEach((v) => {
      if (!isVisible(v)) return;
      const w = v.videoWidth || v.clientWidth || 0;
      const h = v.videoHeight || v.clientHeight || 0;
      const frame = captureFrame(v);
      const src = frame || v.poster || v.currentSrc ||
        (v.querySelector('source') && v.querySelector('source').src) || '';
      if (!src || seen.has(src)) return;
      seen.add(src);
      items.push({
        kind: 'video', src,
        thumb: frame || v.poster || '',
        w, h, area: (w || 480) * (h || 360),
        frame: !!frame,
      });
    });

    items.sort((a, b) => b.area - a.area);
    return items.slice(0, limit);
  }

  // ---------- メッセージ ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'REQUEST_CONTENT') {
      sendResponse({ text: extractText(), url: location.href, title: document.title });
      return true;
    }
    if (msg.type === 'REQUEST_MEDIA') {
      sendResponse({ media: collectMedia(msg.limit || 12), url: location.href });
      return true;
    }
  });

  function send() {
    chrome.runtime.sendMessage({
      type: 'PAGE_CONTENT',
      text: extractText(),
      url: location.href,
      title: document.title,
    }).catch(() => {});
  }

  if (document.readyState === 'complete') {
    setTimeout(send, 400);
  } else {
    window.addEventListener('load', () => setTimeout(send, 400), { once: true });
  }
})();
