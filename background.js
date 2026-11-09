/* ============================================================
   Yui.AI — Background Service Worker (Manifest V3)
   Handles message routing, screen capture, session tracking,
   and resilient async multicast across Dashboard & AI tabs.
   ============================================================ */

// ── Constants & Configuration ──
const AI_PROVIDERS = {
  ChatGPT: {
    name: 'ChatGPT',
    hostname: 'chatgpt.com',
    baseUrl: 'https://chatgpt.com',
    chatPattern: /chatgpt\.com\/(c|g)\//
  },
  Claude: {
    name: 'Claude',
    hostname: 'claude.ai',
    baseUrl: 'https://claude.ai',
    chatPattern: /claude\.ai\/chat\//
  },
  Gemini: {
    name: 'Gemini',
    hostname: 'gemini.google.com',
    baseUrl: 'https://gemini.google.com/app',
    chatPattern: /gemini\.google\.com\/app\/[a-f0-9]/
  }
};

const AI_HOSTNAMES = Object.values(AI_PROVIDERS).map(p => p.hostname);
const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');

// ── Ephemeral State (with MV3 Service Worker recovery) ──
let dashboardTabId = null;
let capturedImageDataUrl = null;
let dashboardReadyResolve = null;

// ── Keyboard Commands ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-and-send') {
    await startCapture();
  } else if (command === 'open-dashboard') {
    await openDashboard();
  }
});

// ── Message Router ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'open-dashboard':
      openDashboard(message.targetAI || null)
        .then((tab) => sendResponse({ success: true, tabId: tab?.id || null }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'start-capture':
      startCapture()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'get-captured-image':
      getCapturedImage()
        .then((dataUrl) => sendResponse({ dataUrl }))
        .catch(() => sendResponse({ dataUrl: null }));
      return true;

    case 'crop-complete':
      handleCropComplete(message.croppedDataUrl, message.promptText || '', message.focusDashboard !== false)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      clearCapturedImage();
      return true;

    case 'inject-image':
      injectImageToAI(message.tabId, message.frameId, message.dataUrl, message.promptText || '');
      sendResponse({ success: true });
      return false;

    case 'multicast-image':
      clearCapturedImage();
      multicastPayload({
        dataUrl: message.dataUrl || null,
        promptText: message.text || message.promptText || '',
        targetAI: message.targetAI || null,
        focusDashboard: message.focusDashboard !== false
      })
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'get-ai-status':
      getAIStatus()
        .then((status) => sendResponse(status))
        .catch(() => sendResponse({}));
      return true;

    case 'dashboard-ready':
      if (sender.tab?.id) {
        dashboardTabId = sender.tab.id;
      }
      if (dashboardReadyResolve) {
        dashboardReadyResolve();
        dashboardReadyResolve = null;
      }
      sendResponse({ ack: true });
      return false;

    case 'ai-url-changed':
      saveAiChatUrl(message.aiName, message.url);
      sendResponse({ ack: true });
      return false;

    case 'clear-ai-url':
      clearAiChatUrl(message.aiName)
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;

    default:
      sendResponse({ error: 'Unknown action' });
      return false;
  }
});

// ═══════════════════════════════════════════
// Captured Screenshot Memory Management
// ═══════════════════════════════════════════
async function setCapturedImage(dataUrl) {
  capturedImageDataUrl = dataUrl;
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ capturedImageDataUrl: dataUrl });
    }
  } catch {
    // Session storage quota or unavailable — in-memory fallback is active
  }
}

async function getCapturedImage() {
  if (capturedImageDataUrl) return capturedImageDataUrl;
  try {
    if (chrome.storage.session) {
      const data = await chrome.storage.session.get(['capturedImageDataUrl']);
      if (data.capturedImageDataUrl) {
        capturedImageDataUrl = data.capturedImageDataUrl;
        return capturedImageDataUrl;
      }
    }
  } catch {
    // Ignore session storage errors
  }
  return null;
}

function clearCapturedImage() {
  capturedImageDataUrl = null;
  try {
    if (chrome.storage.session) {
      chrome.storage.session.remove('capturedImageDataUrl');
    }
  } catch {
    // Ignore
  }
}

// ═══════════════════════════════════════════
// Dashboard Tab Discovery & Management
// ═══════════════════════════════════════════

/**
 * Find the existing Dashboard tab even after MV3 Service Worker restarts.
 */
async function findDashboardTab() {
  if (dashboardTabId !== null) {
    try {
      const tab = await chrome.tabs.get(dashboardTabId);
      if (tab && tab.url && tab.url.startsWith(DASHBOARD_URL)) {
        return tab;
      }
    } catch {
      dashboardTabId = null;
    }
  }

  try {
    const tabs = await chrome.tabs.query({ url: `${DASHBOARD_URL}*` });
    if (tabs.length > 0) {
      dashboardTabId = tabs[0].id;
      return tabs[0];
    }
  } catch {
    // Fallback query if pattern fails
  }
  return null;
}

/**
 * Open or focus the Dashboard tab. Optionally ensure a specific AI panel is active.
 */
async function openDashboard(targetAI = null) {
  if (targetAI && AI_PROVIDERS[targetAI]) {
    const data = await chrome.storage.local.get(['activePanels']);
    const activePanels = Array.isArray(data.activePanels) ? data.activePanels : [];
    if (!activePanels.includes(targetAI)) {
      activePanels.push(targetAI);
      await chrome.storage.local.set({ activePanels });
    }
  }

  const existingTab = await findDashboardTab();
  if (existingTab) {
    await chrome.tabs.update(existingTab.id, { active: true });
    await chrome.windows.update(existingTab.windowId, { focused: true });

    if (targetAI) {
      try {
        await chrome.runtime.sendMessage({
          action: 'focus-or-add-panel',
          aiName: targetAI
        });
      } catch {
        // Dashboard might still be initializing
      }
    }
    return existingTab;
  }

  const tab = await chrome.tabs.create({
    url: DASHBOARD_URL,
    active: true
  });
  dashboardTabId = tab.id;
  return tab;
}

// ── Track Dashboard Tab Closure ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === dashboardTabId) {
    dashboardTabId = null;
    if (dashboardReadyResolve) {
      dashboardReadyResolve();
      dashboardReadyResolve = null;
    }
  }
});

// ═══════════════════════════════════════════
// Screen Capture
// ═══════════════════════════════════════════
async function startCapture() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;

    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
      format: 'png',
      quality: 100
    });

    await setCapturedImage(dataUrl);

    await chrome.tabs.create({
      url: chrome.runtime.getURL('capture/capture.html'),
      active: true
    });
  } catch (err) {
    console.error('[Yui.AI] Capture failed:', err);
  }
}

// ── Handle Crop Complete (Stage in Dashboard Command Bar) ──
async function handleCropComplete(croppedDataUrl, promptText = '', focusDashboard = true) {
  if (focusDashboard) {
    const existing = await findDashboardTab();
    if (!existing) {
      await openDashboardAndWaitReady();
    } else {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  }

  try {
    await chrome.runtime.sendMessage({
      action: 'receive-cropped-image',
      dataUrl: croppedDataUrl,
      promptText: promptText
    });
  } catch (e) {
    console.warn('[Yui.AI] No dashboard listener available:', e);
  }
}

// ═══════════════════════════════════════════
// Multicast Payload (Image + Prompt Text)
// ═══════════════════════════════════════════
async function multicastPayload({ dataUrl, promptText, targetAI, focusDashboard }) {
  if (!dataUrl && !promptText) {
    return { sentCount: 0 };
  }

  // Ensure the target panel (or default panels) exist in storage before opening dashboard
  const storageData = await chrome.storage.local.get(['activePanels']);
  let activePanels = Array.isArray(storageData.activePanels) ? storageData.activePanels : [];

  if (targetAI && AI_PROVIDERS[targetAI]) {
    if (!activePanels.includes(targetAI)) {
      activePanels = [...activePanels, targetAI];
      await chrome.storage.local.set({ activePanels });
    }
  } else if (activePanels.length === 0) {
    activePanels = ['ChatGPT', 'Claude', 'Gemini'];
    await chrome.storage.local.set({ activePanels });
  }

  const message = {
    action: 'inject-and-submit',
    dataUrl: dataUrl || null,
    promptText: promptText || '',
    targetAI: targetAI || null
  };

  let sentCount = 0;

  // ── Strategy 1: Standalone AI tabs ──
  const dashTab = await findDashboardTab();
  const allTabs = await chrome.tabs.query({});
  const aiTabs = allTabs.filter(tab => {
    if ((dashTab && tab.id === dashTab.id) || !tab.url) return false;
    try {
      const hostname = new URL(tab.url).hostname;
      if (targetAI && AI_PROVIDERS[targetAI]) {
        return hostname === AI_PROVIDERS[targetAI].hostname;
      }
      return AI_HOSTNAMES.includes(hostname);
    } catch {
      return false;
    }
  });

  for (const tab of aiTabs) {
    try {
      await sendMessageWithRetry(tab.id, message, 3, 250);
      sentCount++;
    } catch (e) {
      console.warn(`[Yui.AI] Standalone tab ${tab.id} did not respond:`, e);
    }
  }

  // ── Strategy 2: AI iframes inside the Dashboard tab ──
  let currentDashTab = await findDashboardTab();
  if (!currentDashTab) {
    await openDashboardAndWaitReady();
    currentDashTab = await findDashboardTab();
  } else {
    if (focusDashboard) {
      await chrome.tabs.update(currentDashTab.id, { active: true });
      await chrome.windows.update(currentDashTab.windowId, { focused: true });
    }
    // If targetAI was requested, make sure dashboard has that panel open
    if (targetAI) {
      try {
        await chrome.runtime.sendMessage({
          action: 'focus-or-add-panel',
          aiName: targetAI
        });
      } catch {
        // Ignore
      }
    }
  }

  if (currentDashTab) {
    // Also notify the Dashboard UI so it can show the staged image/status
    if (dataUrl) {
      try {
        await chrome.runtime.sendMessage({
          action: 'receive-cropped-image',
          dataUrl: dataUrl,
          promptText: promptText,
          autoSent: true
        });
      } catch {
        // Ignore
      }
    }

    try {
      await sendMessageWithRetry(currentDashTab.id, message, 6, 350);
      sentCount++;
    } catch (e) {
      console.warn('[Yui.AI] Dashboard frames did not acknowledge multicast:', e);
    }
  }

  return { sentCount };
}

/**
 * Send a message to a tab, retrying with linear backoff while content
 * scripts in the tab's frames are still registering their listeners.
 */
async function sendMessageWithRetry(tabId, message, retries = 5, backoffMs = 350) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      lastError = e;
      if (attempt < retries - 1) {
        await delay(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

/**
 * Open the dashboard tab and wait for the 'dashboard-ready' signal.
 * Safety net: 12-second timeout to prevent infinite waiting.
 */
async function openDashboardAndWaitReady() {
  const readyPromise = new Promise((resolve) => {
    dashboardReadyResolve = resolve;
  });

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (dashboardReadyResolve) {
        dashboardReadyResolve = null;
      }
      resolve();
    }, 12000);
  });

  await openDashboard();
  await Promise.race([readyPromise, timeoutPromise]);
  // Give newly created iframes a brief moment to initialize content scripts
  await delay(350);
}

// ── Inject Image to Specific AI Tab via scripting API ──
async function injectImageToAI(tabId, frameId, dataUrl, promptText = '') {
  try {
    const target = { tabId };
    if (frameId !== undefined) {
      target.frameIds = [frameId];
    }

    await chrome.scripting.executeScript({
      target,
      func: (imageDataUrl, text) => {
        window.postMessage({
          type: 'YUI_INJECT_IMAGE',
          dataUrl: imageDataUrl,
          promptText: text
        }, '*');
      },
      args: [dataUrl, promptText]
    });
  } catch (e) {
    console.error('[Yui.AI] Injection failed:', e);
  }
}

// ═══════════════════════════════════════════
// AI Connection Status (Dashboard Panels + Standalone Tabs)
// ═══════════════════════════════════════════
async function getAIStatus() {
  const [allTabs, dashTab, storageData] = await Promise.all([
    chrome.tabs.query({}),
    findDashboardTab(),
    chrome.storage.local.get(['activePanels', 'chatUrls'])
  ]);

  const activePanels = Array.isArray(storageData.activePanels) ? storageData.activePanels : [];
  const chatUrls = storageData.chatUrls || {};
  const isDashOpen = !!dashTab;

  const status = {};

  for (const [key, provider] of Object.entries(AI_PROVIDERS)) {
    const standaloneTab = allTabs.find(tab => {
      if (!tab.url || (dashTab && tab.id === dashTab.id)) return false;
      try {
        return new URL(tab.url).hostname === provider.hostname;
      } catch {
        return false;
      }
    });

    const inDashboard = isDashOpen && activePanels.includes(key);
    const inTab = !!standaloneTab;
    const isConfigured = activePanels.includes(key);

    status[key] = {
      online: inDashboard || inTab,
      inDashboard,
      inTab,
      isConfigured,
      hasSession: !!chatUrls[key],
      tabId: standaloneTab ? standaloneTab.id : (dashTab ? dashTab.id : null)
    };
  }

  return status;
}

// ── Utility ──
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════
// Chat Session URL Persistence
// ═══════════════════════════════════════════
async function saveAiChatUrl(aiName, url) {
  const provider = AI_PROVIDERS[aiName];
  if (!provider || !url) return;

  if (provider.chatPattern && !provider.chatPattern.test(url)) {
    return;
  }

  try {
    const data = await chrome.storage.local.get(['chatUrls']);
    const chatUrls = data.chatUrls || {};

    if (chatUrls[aiName] === url) return;

    chatUrls[aiName] = url;
    await chrome.storage.local.set({ chatUrls });
  } catch (e) {
    console.error('[Yui.AI] Failed to save chat URL:', e);
  }
}

async function clearAiChatUrl(aiName) {
  if (!aiName) return;
  try {
    const data = await chrome.storage.local.get(['chatUrls']);
    const chatUrls = data.chatUrls || {};
    if (chatUrls[aiName]) {
      delete chatUrls[aiName];
      await chrome.storage.local.set({ chatUrls });
    }
  } catch (e) {
    console.error('[Yui.AI] Failed to clear chat URL:', e);
  }
}

// ── Extension Install / Update ──
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      theme: 'dark',
      submitMethod: 'ring-menu', // 'ring-menu' or 'shortcut'
      shortcutKey: 'Ctrl+Shift+X',
      enabledAIs: ['ChatGPT', 'Claude', 'Gemini'],
      dashboardLayout: '3',
      activePanels: ['ChatGPT', 'Claude', 'Gemini'],
      chatUrls: {}
    });
    console.log('[Yui.AI] Cardinal System Initialized.');
  }
});
