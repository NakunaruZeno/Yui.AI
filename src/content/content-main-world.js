/* ============================================================
   Yui.AI — Main-World Script: SPA URL Tracking Bridge
   Runs in MAIN world to intercept Navigation API & History API
   and forward active chat session URLs to the content script.
   ============================================================ */

(function () {
  'use strict';

  const AI_SITE_MAP = {
    'chatgpt.com': 'ChatGPT',
    'claude.ai': 'Claude',
    'gemini.google.com': 'Gemini'
  };

  const hostname = window.location.hostname;
  let currentAI = null;

  for (const [domain, name] of Object.entries(AI_SITE_MAP)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      currentAI = name;
      break;
    }
  }

  if (!currentAI) return;

  const CHAT_SESSION_PATTERNS = {
    ChatGPT: /chatgpt\.com\/(c|g)\//,
    Claude: /claude\.ai\/chat\//,
    Gemini: /gemini\.google\.com\/app\/[a-f0-9]/
  };

  let lastReportedUrl = '';

  function reportUrlChange(url) {
    if (!url || url === lastReportedUrl) return;
    const pattern = CHAT_SESSION_PATTERNS[currentAI];
    if (!pattern || !pattern.test(url)) return;

    lastReportedUrl = url;
    window.postMessage({
      type: 'YUI_URL_CHANGED',
      aiName: currentAI,
      url
    }, window.location.origin);
  }

  // Strategy 1: Modern Navigation API
  if (window.navigation) {
    window.navigation.addEventListener('navigate', (event) => {
      const destinationUrl = event?.destination?.url;
      if (destinationUrl) {
        setTimeout(() => reportUrlChange(destinationUrl), 80);
      }
    });
  }

  // Strategy 2: History pushState / replaceState Hooks
  ['pushState', 'replaceState'].forEach((method) => {
    const original = history[method];
    if (typeof original !== 'function') return;

    history[method] = function (state, title, url) {
      const result = original.apply(this, arguments);
      if (url) {
        try {
          const resolvedUrl = new URL(url, window.location.href).href;
          setTimeout(() => reportUrlChange(resolvedUrl), 50);
        } catch {
          // Ignore malformed relative URL
        }
      }
      return result;
    };
  });

  // Strategy 3: popstate listener
  window.addEventListener('popstate', () => {
    setTimeout(() => reportUrlChange(window.location.href), 50);
  });

  // Initial URL check
  setTimeout(() => reportUrlChange(window.location.href), 500);
})();
