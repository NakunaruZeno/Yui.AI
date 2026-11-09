/* ============================================================
   Yui.AI — Content Script: DOM Injection & Auto-Submit
   Clean ES6 Adapter Architecture for ChatGPT, Claude, Gemini
   Supports Image-only, Text-only, and Image + Text Multicast
   ============================================================ */

// ═══════════════════════════════════════════
// Per-AI XPath & Selector Configuration
// ═══════════════════════════════════════════
const AI_XPATH_CONFIG = {
  ChatGPT: {
    input: '//div[@id="prompt-textarea"] | //textarea[@id="prompt-textarea"] | //div[@contenteditable="true" and contains(@class, "ProseMirror")]',
    sendBtn: '//*[@data-testid="send-button" and not(@disabled)] | //button[@aria-label="Send prompt" and not(@disabled)]',
    uploadInput: '//input[@type="file" and @id="upload-files"] | //form//input[@type="file"] | //input[@type="file"]',
    uploadMethod: 'drop_to_upload',
    textMethod: 'paste',
    sendDelayMs: 200
  },
  Claude: {
    input: '//*[@data-testid="chat-input" and @contenteditable="true"] | //div[@contenteditable="true" and contains(@class, "ProseMirror")]',
    sendBtn: '//*[@id="main-content"]//button[not(@disabled)][.//*[local-name()="path" and starts-with(@d, "M208.49,120.49")]] | //button[@aria-label="Send Message" and not(@disabled)] | //button[@aria-label="Send message" and not(@disabled)]',
    uploadInput: '//input[@data-testid="file-upload"] | //input[@type="file"]',
    uploadMethod: 'paste_to_upload',
    textMethod: 'paste',
    sendDelayMs: 200
  },
  Gemini: {
    input: '//rich-textarea//*[contains(@class, "ql-editor") and @contenteditable="true"] | //div[@contenteditable="true" and @role="textbox"]',
    sendBtn: '//gem-icon-button[contains(@class, "submit") and contains(@class, "has-input") and @aria-disabled="false"]//button[not(@disabled) and not(@aria-disabled="true")][.//mat-icon[@data-mat-icon-name="arrow_upward"]] | //button[contains(@aria-label, "Send") and not(@disabled) and not(@aria-disabled="true")] | //button[contains(@class, "send-button") and not(@disabled) and not(@aria-disabled="true")]',
    uploadMethod: 'paste_to_input',
    textMethod: 'dom',
    sendDelayMs: 200
  }
};

const CHAT_URL_PATTERNS = {
  ChatGPT: /chatgpt\.com\/(c|g)\//,
  Claude: /claude\.ai\/chat\//,
  Gemini: /gemini\.google\.com\/app\/[a-f0-9]/
};

// ═══════════════════════════════════════════
// Shared DOM & Event Utilities
// ═══════════════════════════════════════════

function evaluateXPath(xpath) {
  if (!xpath) return null;
  try {
    return document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
  } catch {
    return null;
  }
}

function waitForElement(finderFn, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const existing = finderFn();
    if (existing) return resolve(existing);

    const root = document.body || document.documentElement;
    if (!root) {
      return reject(new Error('DOM root unavailable'));
    }

    const observer = new MutationObserver(() => {
      const el = finderFn();
      if (el) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(el);
      }
    });

    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element not found within ${timeoutMs}ms`));
    }, timeoutMs);

    observer.observe(root, {
      childList: true,
      subtree: true
    });
  });
}

function waitForCondition(predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const initial = predicate();
    if (initial) return resolve(initial);

    const root = document.body || document.documentElement;
    if (!root) {
      return reject(new Error('DOM root unavailable'));
    }

    const observer = new MutationObserver(() => {
      const r = predicate();
      if (r) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(r);
      }
    });

    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Condition not met within ${timeoutMs}ms`));
    }, timeoutMs);

    observer.observe(root, {
      childList: true,
      subtree: true
    });
  });
}

function createDataTransfer(file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  return dt;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pasteToInput(targetElement, file) {
  const dt = createDataTransfer(file);
  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clipboardData: dt
  });
  targetElement.dispatchEvent(pasteEvent);
}

function pasteToUpload(inputElement, file) {
  const dt = createDataTransfer(file);
  if (inputElement instanceof HTMLInputElement) {
    inputElement.files = dt.files;
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function dropToUpload(targetElement, file) {
  const dt = createDataTransfer(file);

  targetElement.dispatchEvent(new DragEvent('dragover', {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: dt
  }));

  targetElement.dispatchEvent(new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: dt
  }));
}

function pasteTextToEditor(element, text) {
  if (!element) return;
  element.focus();

  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);

  element.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData,
    bubbles: true,
    cancelable: true,
    composed: true
  }));
}

function injectTextIntoElement(element, text) {
  if (!element) return;
  element.focus();
  const tagName = element.tagName.toLowerCase();

  if (tagName === 'input' || tagName === 'textarea') {
    const oldValue = element.value;
    element.value = text;

    const tracker = element._valueTracker;
    if (tracker) {
      tracker.setValue(oldValue);
    }

    const proto = window[element.constructor.name]?.prototype;
    if (proto) {
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(element, text);
      }
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    if (element.getAttribute('data-lexical-editor') === 'true') {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      pasteTextToEditor(element, text);
      if (selection) selection.removeAllRanges();
    } else {
      element.innerText = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('keyup', { bubbles: true }));
    }
  }
}

function dispatchEnterKey(element) {
  if (!element) return;

  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    key: 'Enter',
    code: 'Enter',
    view: window
  };

  for (const type of ['keydown', 'keypress', 'keyup']) {
    const event = new KeyboardEvent(type, eventInit);
    Object.defineProperty(event, 'keyCode', { get: () => 13 });
    Object.defineProperty(event, 'which', { get: () => 13 });
    element.dispatchEvent(event);
  }
}

function dataUrlToFile(dataUrl, filename) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
    return null;
  }
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);

  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }

  return new File([u8arr], filename, { type: mime });
}

// ═══════════════════════════════════════════
// AI Adapters (ES6 Classes)
// ═══════════════════════════════════════════

class ChatGPTAdapter {
  constructor() {
    this.name = 'ChatGPT';
  }

  async injectImage(file, config) {
    const uploadInput = evaluateXPath(config.uploadInput);
    if (uploadInput) {
      dropToUpload(uploadInput, file);
      await delay(250);

      // Verify if thumbnail appeared; if not, also try pasteToUpload
      const hasAttachment = document.querySelector('[data-testid*="attachment"], [class*="attachment"], form img');
      if (!hasAttachment) {
        pasteToUpload(uploadInput, file);
      }
      await delay(250);
      return;
    }

    const editor = evaluateXPath(config.input);
    if (editor) {
      editor.focus();
      pasteToInput(editor, file);
      await delay(300);
    }
  }

  async submit(config) {
    try {
      let btn = await waitForElement(() => evaluateXPath(config.sendBtn), 10000);
      if (btn) {
        await delay(config.sendDelayMs || 200);
        btn = evaluateXPath(config.sendBtn);
        if (btn) {
          btn.click();
          return;
        }
      }
    } catch {
      // Fallback to Enter key
    }

    const input = evaluateXPath(config.input);
    if (input) {
      dispatchEnterKey(input);
    }
  }
}

class ClaudeAdapter {
  constructor() {
    this.name = 'Claude';
  }

  async injectImage(file, config) {
    const uploadInput = evaluateXPath(config.uploadInput);
    if (uploadInput) {
      pasteToUpload(uploadInput, file);
      await delay(300);

      try {
        await waitForCondition(() => {
          return document.querySelector('[data-testid="file-thumbnail"]')
            || document.querySelector('.file-thumbnail')
            || document.querySelector('.uploaded-file')
            || document.querySelector('[data-testid="uploaded-file"]')
            || document.querySelector('.attachment-preview')
            || document.querySelector('[data-testid="attachment"]')
            || document.querySelector('[data-testid="input-image-thumbnail"]')
            || document.querySelector('#main-content img[src^="blob:"]')
            || document.querySelector('#main-content img[src^="data:"]');
        }, 4500);
        return;
      } catch {
        // Fallback to editor paste
      }
    }

    const editor = evaluateXPath(config.input);
    if (editor) {
      editor.focus();
      await delay(100);
      pasteToInput(editor, file);
      await waitForCondition(() => {
        return document.querySelector('[data-testid="file-thumbnail"]')
          || document.querySelector('.file-thumbnail')
          || document.querySelector('#main-content img[src^="blob:"]');
      }, 3500).catch(() => {});
    }
  }

  async submit(config) {
    try {
      let btn = await waitForElement(() => evaluateXPath(config.sendBtn), 10000);
      if (btn) {
        await delay(config.sendDelayMs || 200);
        btn = evaluateXPath(config.sendBtn);
        if (btn) {
          btn.click();
          return;
        }
      }
    } catch {
      // Fallback
    }

    const fallbackSelectors = [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]'
    ];

    for (const selector of fallbackSelectors) {
      const btn = document.querySelector(selector);
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
    }

    const editor = evaluateXPath(config.input);
    if (editor) {
      editor.focus();
      dispatchEnterKey(editor);
    }
  }
}

class GeminiAdapter {
  constructor() {
    this.name = 'Gemini';
  }

  async injectImage(file, config, hasPromptText = false) {
    const editor = evaluateXPath(config.input);
    if (!editor) return;

    editor.focus();
    await delay(100);
    pasteToInput(editor, file);

    await waitForCondition(() => {
      return document.querySelector('.attachment-chip')
        || document.querySelector('[data-file-chip]')
        || document.querySelector('.upload-preview')
        || document.querySelector('img[data-image-id]')
        || document.querySelector('.input-area img')
        || document.querySelector('.input-area-container img');
    }, 5000).catch(() => {});

    // If no custom prompt text is supplied, inject a single space so Gemini's
    // gem-icon-button registers `has-input` and enables the submit button.
    if (!hasPromptText) {
      editor.focus();
      await delay(80);
      document.execCommand('insertText', false, ' ');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async submit(config) {
    const editor = evaluateXPath(config.input);
    if (editor) {
      editor.focus();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }

    try {
      let btn = await waitForElement(() => evaluateXPath(config.sendBtn), 10000);
      if (btn) {
        await delay(config.sendDelayMs || 200);
        btn = evaluateXPath(config.sendBtn);
        if (btn) {
          btn.click();
          return;
        }
      }
    } catch {
      // Fallback
    }

    const fallbackSelectors = [
      'button[aria-label="Send message"]',
      'button.send-button',
      '.send-button-container button',
      'button[data-at="send"]',
      'button[mattooltip="Send message"]'
    ];

    for (const selector of fallbackSelectors) {
      const btn = document.querySelector(selector);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        return;
      }
    }

    if (editor) {
      editor.focus();
      dispatchEnterKey(editor);
    }
  }
}

const AI_ADAPTERS = {
  'chatgpt.com': ChatGPTAdapter,
  'claude.ai': ClaudeAdapter,
  'gemini.google.com': GeminiAdapter
};

function getCurrentAdapter() {
  const hostname = window.location.hostname;
  for (const [domain, AdapterClass] of Object.entries(AI_ADAPTERS)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return new AdapterClass();
    }
  }
  return null;
}

// ═══════════════════════════════════════════
// Message Listener (Multi-frame Safe)
// ═══════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'inject-and-submit') return false;

  // Ignore tiny utility/challenge sub-iframes so they never hijack sendResponse
  if (window.innerWidth < 120 || window.innerHeight < 120) {
    return false;
  }

  const adapter = getCurrentAdapter();
  if (!adapter) return false;

  // If a specific AI was targeted and this frame is a different AI,
  // return false WITHOUT calling sendResponse so Chrome waits for the target frame.
  if (message.targetAI && adapter.name !== message.targetAI) {
    return false;
  }

  handleInjectAndSubmit(message.dataUrl || null, message.promptText || '')
    .then(ok => sendResponse({ success: !!ok, ai: adapter.name }))
    .catch(err => sendResponse({ success: false, error: err.message }));

  return true;
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'YUI_INJECT_IMAGE') {
    handleInjectAndSubmit(event.data.dataUrl || null, event.data.promptText || '');
  }
});

// ═══════════════════════════════════════════
// Core Injection & Auto-Submit Orchestration
// ═══════════════════════════════════════════
async function handleInjectAndSubmit(dataUrl, promptText) {
  const adapter = getCurrentAdapter();
  if (!adapter) return false;

  const config = AI_XPATH_CONFIG[adapter.name];
  if (!config) return false;

  const cleanPrompt = (promptText || '').trim();
  const file = dataUrl ? dataUrlToFile(dataUrl, 'yui-capture.png') : null;

  if (!file && !cleanPrompt) return false;

  try {
    // Step 1: Locate input element
    let inputElement = await waitForElement(
      () => evaluateXPath(config.input),
      4000
    ).catch(() => null);

    if (!inputElement) {
      return false;
    }

    // Step 2: Inject image if present
    if (file) {
      await adapter.injectImage(file, config, !!cleanPrompt);
      await delay(120);

      const readyFinder = () => evaluateXPath(config.uploadReady || config.sendBtn);
      await waitForElement(readyFinder, 8000).catch(() => {});
      await delay(180);
    }

    // Step 3: Inject prompt text if present
    if (cleanPrompt) {
      inputElement = evaluateXPath(config.input);
      if (inputElement) {
        const verifyText = () => waitForCondition(() => {
          const el = evaluateXPath(config.input);
          if (!el) return null;

          const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();
          const target = normalize(cleanPrompt).slice(0, 32);

          if ('value' in el && el.value && normalize(el.value).includes(target)) {
            return el;
          }
          if (el.textContent && normalize(el.textContent).includes(target)) {
            return el;
          }
          return null;
        }, 1800);

        const methods = config.textMethod === 'paste' ? ['paste', 'dom'] : ['dom', 'paste'];

        for (const method of methods) {
          if (method === 'paste') {
            pasteTextToEditor(inputElement, cleanPrompt);
          } else {
            injectTextIntoElement(inputElement, cleanPrompt);
          }

          await delay(80);
          try {
            await verifyText();
            break;
          } catch {
            // Try fallback method
          }
        }

        await delay(160);
      }
    }

    // Step 4: Submit
    await adapter.submit(config);
    return true;
  } catch (err) {
    console.error(`[Yui.AI] Injection failed for ${adapter.name}:`, err);
    return false;
  }
}

// ═══════════════════════════════════════════
// Chat Session URL Tracker (Isolated World Receiver)
// ═══════════════════════════════════════════
(function initUrlTracker() {
  const adapter = getCurrentAdapter();
  if (!adapter) return;

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== 'YUI_URL_CHANGED') return;

    const { aiName, url } = event.data;
    if (aiName !== adapter.name) return;

    try {
      chrome.runtime.sendMessage({
        action: 'ai-url-changed',
        aiName,
        url
      });
    } catch {
      // Context invalidated
    }
  });

  function reportUrlChange() {
    const url = window.location.href;
    const aiName = adapter.name;
    const pattern = CHAT_URL_PATTERNS[aiName];
    if (!pattern || !pattern.test(url)) return;

    try {
      chrome.runtime.sendMessage({
        action: 'ai-url-changed',
        aiName,
        url
      });
    } catch {
      // Context invalidated
    }
  }

  setTimeout(reportUrlChange, 1000);
  window.addEventListener('popstate', () => setTimeout(reportUrlChange, 0));
  window.addEventListener('hashchange', () => setTimeout(reportUrlChange, 0));
})();
