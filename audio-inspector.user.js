// ==UserScript==
// @name         Epidemic Sound Audio Inspector + Accurate Name Downloader
// @namespace    https://github.com/raselmuntasir/audio-source-inspector
// @version      1.3.0
// @description  Captures Epidemic Sound audio sources and automatically names files as "Artist - Track Title.mp3".
// @author       raselmuntasir
// @match        *://*.epidemicsound.com/*
// @match        *://*/*
// @run-at       document-start
// @grant        GM_download
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const W = unsafeWindow;
  if (W.__audioSourceInspectorInstalled) return;
  W.__audioSourceInspectorInstalled = true;

  const PANEL_ID = 'audio-source-inspector-panel';
  const INCLUDE_VIDEO = false;
  const AUTO_DOWNLOAD_DEFAULT = false;
  const AUTO_DL_NETWORK = false;
  const AUDIO_EXT_RE = /\.(mp3|wav|aac|m4a|ogg|oga|opus|flac)(?:[?#]|$)/i;
  const AUDIO_MIME_RE = /^audio\//i;

  const found = new Map();
  const downloaded = new Set();
  let autoDownload = AUTO_DOWNLOAD_DEFAULT;

  let panelEl = null;
  let listEl = null;
  let countEl = null;

  const log = (...args) => console.debug('[AudioInspector]', ...args);

  function toAbsolute(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
      return new URL(raw, location.href).href;
    } catch (err) {
      return null;
    }
  }

  function looksLikeAudio(absUrl) {
    if (!absUrl) return false;
    return absUrl.startsWith('data:audio/') || AUDIO_EXT_RE.test(absUrl);
  }

  function isTrackedMedia(el) {
    return el instanceof W.HTMLAudioElement || (INCLUDE_VIDEO && el instanceof W.HTMLVideoElement);
  }

  /* ------------------------------------------------------------------
   * Smart Track Title & Artist Detection (Epidemic Sound Specific + Generic)
   * ------------------------------------------------------------------ */
  function getTrackTitle() {
    try {
      // 1. Actively playing row in the track list (highest accuracy)
      const pauseBtn = document.querySelector('button[aria-label*="Pause" i], button[data-testid*="pause" i], [aria-label*="Pause" i]');
      if (pauseBtn) {
        const row = pauseBtn.closest('tr, div[role="row"], li, [data-testid*="track-row"], [class*="trackRow"]');
        if (row) {
          const titleEl = row.querySelector('a[href*="/track/"], [data-testid*="track-title"], [class*="title"], h3, h4');
          const artistEl = row.querySelector('a[href*="/artists/"], a[href*="/creators/"], [data-testid*="artist"], [class*="artist"]');

          const t = titleEl ? titleEl.textContent.trim() : '';
          const a = artistEl ? artistEl.textContent.trim() : '';

          if (t && a && !isGenericText(t)) {
            return `${a} - ${t}`;
          } else if (t && !isGenericText(t)) {
            return t;
          }
        }
      }

      // 2. Bottom persistent player dock
      const bottomPlayer = document.querySelector('footer, [data-testid*="player"], [class*="Player_"], [class*="bottomBar"], [class*="dock"]');
      if (bottomPlayer) {
        const titleEl = bottomPlayer.querySelector('a[href*="/track/"], [data-testid*="track-title"], h3, h4, [class*="trackTitle"]');
        const artistEl = bottomPlayer.querySelector('a[href*="/artists/"], a[href*="/creators/"], [data-testid*="artist-name"], [class*="artist"]');

        let t = titleEl ? titleEl.textContent.trim() : '';
        let a = artistEl ? artistEl.textContent.trim() : '';

        if (!t) {
          const infoContainer = bottomPlayer.querySelector('[class*="trackInfo"], [class*="nowPlaying"], [class*="meta"]');
          if (infoContainer) {
            const texts = Array.from(infoContainer.querySelectorAll('a, span, p, div'))
              .map(el => el.textContent.trim())
              .filter(text => text.length > 0 && !isGenericText(text));
            if (texts.length >= 2) {
              t = texts[0];
              a = texts[1];
            } else if (texts.length === 1) {
              t = texts[0];
            }
          }
        }

        if (t && a && !isGenericText(t)) {
          return `${a} - ${t}`;
        } else if (t && !isGenericText(t)) {
          return t;
        }
      }
    } catch (err) {
      log('DOM track scraping failed:', err);
    }

    // 3. MediaSession API
    try {
      const meta = W.navigator.mediaSession && W.navigator.mediaSession.metadata;
      if (meta && meta.title && !isGenericText(meta.title)) {
        return meta.artist ? `${meta.artist} - ${meta.title}` : meta.title;
      }
    } catch (err) {
      log('mediaSession read failed:', err);
    }

    // 4. Fallback: document title
    let fallback = document.title || '';
    fallback = fallback.replace(/\s*[-|•]\s*Epidemic Sound.*$/i, '').trim();
    if (isGenericText(fallback)) {
      fallback = '';
    }
    return fallback;
  }

  function isGenericText(str) {
    if (!str) return true;
    const lower = str.toLowerCase();
    const badPhrases = [
      'cookie', 'we use cookies', 'discover', 'epidemic sound',
      'music', 'sound effects', 'sign in', 'log in', 'start free trial',
      'search', 'playback', 'pause', 'play'
    ];
    return badPhrases.some(phrase => lower.includes(phrase));
  }

  function sanitizeName(name) {
    return String(name || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
  }

  function getExtension(url) {
    const m = url.match(/\.(mp3|wav|aac|m4a|ogg|oga|opus|flac)(?:[?#]|$)/i);
    return m ? m[1].toLowerCase() : 'mp3';
  }

  function makeFileName(entry) {
    const ext = getExtension(entry.url);
    const rawTitle = (entry.title && !isGenericText(entry.title)) ? entry.title : getTrackTitle();
    const title = sanitizeName(rawTitle);
    if (title) return `${title}.${ext}`;

    let fallback = '';
    try {
      fallback = decodeURIComponent(new URL(entry.url).pathname.split('/').pop() || '');
    } catch (err) {}
    return `${sanitizeName(fallback) || 'audio_' + Date.now()}.${ext}`;
  }

  /* ------------------------------------------------------------------
   * Download (cache-first Blob download + GM_download fallback)
   * ------------------------------------------------------------------ */
  async function downloadEntry(entry, force = false, statusCallback = null) {
    if (!force && downloaded.has(entry.url)) return;
    downloaded.add(entry.url);

    if (!entry.title || isGenericText(entry.title)) {
      const fresh = getTrackTitle();
      if (fresh && !isGenericText(fresh)) {
        entry.title = fresh;
      }
    }

    const finalName = makeFileName(entry);
    log('Starting download for:', finalName);
    if (statusCallback) statusCallback('Downloading...');

    // Method 1: Blob download
    try {
      const res = await fetch(entry.url, { mode: 'cors', credentials: 'omit' });
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = finalName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(blobUrl);
          a.remove();
        }, 3000);
        log('Blob download complete:', finalName);
        if (statusCallback) statusCallback('Saved!');
        return;
      }
    } catch (fetchErr) {
      log('Fetch blob download failed (CORS), falling back to GM_download:', fetchErr);
    }

    // Method 2: GM_download fallback
    try {
      GM_download({
        url: entry.url,
        name: finalName,
        saveAs: false,
        onload: () => {
          if (statusCallback) statusCallback('Saved!');
        },
        onerror: (err) => {
          downloaded.delete(entry.url);
          log('Download failed:', err);
          if (statusCallback) statusCallback('Failed');
        },
        ontimeout: () => {
          downloaded.delete(entry.url);
          log('Download timed out:', entry.url);
          if (statusCallback) statusCallback('Timeout');
        },
      });
    } catch (err) {
      downloaded.delete(entry.url);
      log('GM_download threw:', err);
      if (statusCallback) statusCallback('Error');
    }
  }

  function addSource(rawUrl, origin, opts = {}) {
    const abs = toAbsolute(rawUrl);
    if (!abs || abs.startsWith('blob:') || found.has(abs)) return;

    const currentTitle = getTrackTitle();
    const entry = { url: abs, origin, title: currentTitle, time: new Date() };
    found.set(abs, entry);
    log(`Captured (${origin}):`, abs, 'Initial Title:', currentTitle);

    if (!currentTitle || isGenericText(currentTitle)) {
      setTimeout(() => {
        const lateTitle = getTrackTitle();
        if (lateTitle && !isGenericText(lateTitle)) {
          entry.title = lateTitle;
          render();
        }
      }, 300);
      setTimeout(() => {
        const lateTitle = getTrackTitle();
        if (lateTitle && !isGenericText(lateTitle)) {
          entry.title = lateTitle;
          render();
        }
      }, 800);
    }

    if (autoDownload && (!opts.network || AUTO_DL_NETWORK)) {
      downloadEntry(entry);
    }

    ensurePanel();
    render();
  }

  function collectMediaSources(el) {
    const urls = [];
    if (el.currentSrc) urls.push(el.currentSrc);
    if (el.getAttribute('src')) urls.push(el.getAttribute('src'));
    el.querySelectorAll('source').forEach((s) => {
      if (s.getAttribute('src')) urls.push(s.getAttribute('src'));
    });
    return urls;
  }

  function scanNode(node) {
    if (!node || node.nodeType !== 1) return;
    try {
      if (node.tagName === 'SOURCE') {
        addSource(node.getAttribute('src'), 'DOM <source>');
      } else if (isTrackedMedia(node)) {
        collectMediaSources(node).forEach((u) =>
          addSource(u, 'DOM <' + node.tagName.toLowerCase() + '>')
        );
      }
    } catch (err) {
      log('scanNode failed:', err);
    }
  }

  function ensurePanel() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', ensurePanel, { once: true });
      return;
    }
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      panelEl = existing;
      return;
    }
    if (panelEl) return;

    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    Object.assign(panelEl.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: '2147483647',
      width: '320px',
      maxHeight: '60vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'rgba(20, 20, 24, 0.94)',
      color: '#eee',
      font: '12px/1.4 system-ui, sans-serif',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 8px',
      background: 'rgba(255,255,255,0.06)',
    });

    const title = document.createElement('strong');
    title.textContent = '🎵 Audio Inspector';
    title.style.flex = '1';

    countEl = document.createElement('span');
    countEl.style.opacity = '0.7';

    const autoLabel = document.createElement('label');
    Object.assign(autoLabel.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '3px',
      cursor: 'pointer',
    });
    const autoBox = document.createElement('input');
    autoBox.type = 'checkbox';
    autoBox.checked = autoDownload;
    autoBox.addEventListener('change', () => {
      autoDownload = autoBox.checked;
    });
    autoLabel.append(autoBox, document.createTextNode('Auto'));

    const clearBtn = makeButton('Clear', () => {
      found.clear();
      downloaded.clear();
      render();
    });

    const body = document.createElement('div');
    body.style.overflowY = 'auto';
    listEl = body;

    let collapsed = false;
    const toggleBtn = makeButton('–', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '+' : '–';
    });

    header.append(title, countEl, autoLabel, clearBtn, toggleBtn);
    panelEl.append(header, body);
    document.body.appendChild(panelEl);
    render();
  }

  function makeButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    Object.assign(btn.style, {
      font: 'inherit',
      padding: '2px 6px',
      border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: '4px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function render() {
    if (!listEl) return;
    countEl.textContent = `(${found.size})`;
    listEl.textContent = '';

    if (found.size === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No audio sources yet.';
      Object.assign(empty.style, { padding: '8px', opacity: '0.6' });
      listEl.appendChild(empty);
      return;
    }
    for (const entry of found.values()) {
      listEl.appendChild(buildRow(entry));
    }
  }

  function buildRow(entry) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      padding: '6px 8px',
      borderTop: '1px solid rgba(255,255,255,0.08)',
    });

    const meta = document.createElement('div');
    const labelTitle = (entry.title && !isGenericText(entry.title)) ? entry.title : 'Loading Title...';
    meta.textContent = `${labelTitle}`;
    Object.assign(meta.style, { color: '#00e676', fontWeight: 'bold', fontSize: '11px', lineHeight: '1.3' });

    const urlEl = document.createElement('div');
    urlEl.textContent = entry.url;
    urlEl.title = entry.url;
    Object.assign(urlEl.style, {
      wordBreak: 'break-all',
      margin: '2px 0 4px',
      fontFamily: 'monospace',
      fontSize: '10px',
      opacity: '0.6',
      maxHeight: '2em',
      overflow: 'hidden',
    });

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const dlBtn = makeButton(downloaded.has(entry.url) ? 'Re-download' : 'Download', () => {
      downloadEntry(entry, true, (statusText) => {
        dlBtn.textContent = statusText;
        if (statusText === 'Saved!') {
          setTimeout(() => (dlBtn.textContent = 'Re-download'), 2000);
        }
      });
    });

    const copyBtn = makeButton('Copy Link', async (e) => {
      const ok = await copyText(entry.url);
      e.currentTarget.textContent = ok ? 'Copied!' : 'Failed';
      setTimeout(() => (e.currentTarget.textContent = 'Copy Link'), 1200);
    });

    actions.append(dlBtn, copyBtn);
    row.append(meta, urlEl, actions);
    return row;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {}
    finally {
      ta.remove();
    }
    return ok;
  }

  function patchMediaPlay() {
    try {
      const proto = W.HTMLMediaElement.prototype;
      const originalPlay = proto.play;
      if (typeof originalPlay !== 'function') return;

      proto.play = function patchedPlay(...args) {
        try {
          collectMediaSources(this).forEach((u) => addSource(u, 'play()'));
        } catch (err) {
          log('play() capture failed:', err);
        }
        return originalPlay.apply(this, args);
      };
    } catch (err) {
      log('Failed to patch HTMLMediaElement.play:', err);
    }
  }

  function listenMediaEvents() {
    ['loadstart', 'play'].forEach((type) => {
      document.addEventListener(
        type,
        (e) => {
          if (e.target instanceof W.HTMLMediaElement && isTrackedMedia(e.target)) {
            collectMediaSources(e.target).forEach((u) => addSource(u, `event:${type}`));
          }
        },
        true
      );
    });
  }

  function observeDom() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          scanNode(m.target);
        } else if (m.type === 'childList') {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            scanNode(node);
            node.querySelectorAll?.('audio, video, source').forEach(scanNode);
          });
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }

  function patchFetch() {
    try {
      if (typeof W.fetch !== 'function') return;
      const originalFetch = W.fetch;

      W.fetch = function patchedFetch(input, init) {
        let reqUrl = '';
        try {
          reqUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
        } catch (err) {}

        const promise = originalFetch.apply(this, arguments);
        const abs = toAbsolute(reqUrl);
        if (looksLikeAudio(abs)) addSource(abs, 'fetch URL', { network: true });

        promise
          .then((res) => {
            const ct = res.headers.get('content-type') || '';
            if (AUDIO_MIME_RE.test(ct)) {
              addSource(res.url || reqUrl, 'fetch MIME', { network: true });
            }
          })
          .catch(() => {});

        return promise;
      };
    } catch (err) {
      log('Failed to patch fetch:', err);
    }
  }

  function patchXHR() {
    try {
      const proto = W.XMLHttpRequest.prototype;
      const originalOpen = proto.open;

      proto.open = function patchedOpen(method, url, ...rest) {
        const abs = toAbsolute(url);
        if (looksLikeAudio(abs)) addSource(abs, 'XHR URL', { network: true });

        const xhr = this;
        xhr.addEventListener('readystatechange', function () {
          if (xhr.readyState !== W.XMLHttpRequest.HEADERS_RECEIVED) return;
          try {
            const ct = xhr.getResponseHeader('Content-Type') || '';
            if (AUDIO_MIME_RE.test(ct)) {
              addSource(xhr.responseURL || abs, 'XHR MIME', { network: true });
            }
          } catch (err) {}
        });

        return originalOpen.call(this, method, url, ...rest);
      };
    } catch (err) {
      log('Failed to patch XMLHttpRequest:', err);
    }
  }

  function init() {
    patchMediaPlay();
    patchFetch();
    patchXHR();
    listenMediaEvents();
    observeDom();

    document.addEventListener(
      'DOMContentLoaded',
      () => {
        document.querySelectorAll('audio, video, source').forEach(scanNode);
      },
      { once: true }
    );

    log('Audio Inspector active.');
  }

  try {
    init();
  } catch (err) {
    console.error('[AudioInspector] Initialization failed:', err);
  }
})();
