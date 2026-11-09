/* ============================================================
   Yui.AI — Dashboard Logic
   Manages AI panels, functional 1/2/3 split layouts, session
   persistence, Omni-Command Bar, and SAO Radial Ring Menu.
   ============================================================ */

// ── AI Provider Configuration (Vector SVGs, Zero Emojis) ──
const AI_CONFIGS = {
  ChatGPT: {
    url: 'https://chatgpt.com',
    newChatUrl: 'https://chatgpt.com',
    accent: '#10a37f',
    svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4.5 4.5 0 0 0-3.89 2.25L4.2 11a4.5 4.5 0 0 0 0 4.5l3.91 6.75a4.5 4.5 0 0 0 7.78 0L19.8 15.5a4.5 4.5 0 0 0 0-4.5L15.89 4.25A4.5 4.5 0 0 0 12 2Z"/><circle cx="12" cy="12" r="3"/></svg>`
  },
  Claude: {
    url: 'https://claude.ai',
    newChatUrl: 'https://claude.ai/new',
    accent: '#d97757',
    svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>`
  },
  Gemini: {
    url: 'https://gemini.google.com/app',
    newChatUrl: 'https://gemini.google.com/app',
    accent: '#38bdf8',
    svg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C12 7.52 16.48 12 22 12C16.48 12 12 16.48 12 22C12 16.48 7.52 12 2 12C7.52 12 12 7.52 12 2Z"/></svg>`
  }
};

const ALL_AI_NAMES = Object.keys(AI_CONFIGS);

// ── State ──
let panels = [];
let currentLayout = 3;
let previousMultiLayout = 3;
let focusedPanelName = 'ChatGPT';
let croppedImageData = null;
let savedChatUrls = {};

let pendingIframeLoads = 0;
let onAllIframesLoaded = null;
let statusResetTimer = null;

// ── Initialization ──
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get([
    'theme',
    'dashboardLayout',
    'activePanels',
    'chatUrls'
  ]);

  const theme = settings.theme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  savedChatUrls = settings.chatUrls || {};

  initToolbar();
  initNodeTabs();
  initLayoutControls();
  initOmniCommandBar();
  initAddPanelModal();
  initRingMenu();
  initMessageListener();
  initStorageListener();

  const savedPanels = Array.isArray(settings.activePanels) ? settings.activePanels : ['ChatGPT', 'Claude', 'Gemini'];
  const savedLayout = parseInt(settings.dashboardLayout, 10) || Math.max(1, savedPanels.length);

  if (savedPanels.length > 0) {
    await restorePanels(savedPanels, savedLayout);
  } else {
    renderEmptyState();
    setLayout(1, { skipEnsurePanels: true });
    showAddPanelModal();
  }

  signalDashboardReady();
  updateStatus(`CARDINAL READY // ${panels.length} NODE(S) LINKED`, false);
});

function signalDashboardReady() {
  try {
    chrome.runtime.sendMessage({ action: 'dashboard-ready' });
  } catch {
    // Ignore if background is idle
  }
}

// ═══════════════════════════════════════════
// State Persistence & Panel Restoration
// ═══════════════════════════════════════════
function savePanelState() {
  const activeNames = panels.map(p => p.name);
  chrome.storage.local.set({ activePanels: activeNames });
  syncNodeTabsUI();
  syncModalCardsUI();
}

async function restorePanels(aiNames, targetLayout) {
  const validNames = [...new Set(aiNames.filter(name => AI_CONFIGS[name]))];
  if (validNames.length === 0) {
    renderEmptyState();
    return;
  }

  focusedPanelName = validNames[0];
  pendingIframeLoads = validNames.length;

  const readyPromise = new Promise((resolve) => {
    onAllIframesLoaded = resolve;
  });

  for (const name of validNames) {
    addPanel(name, { skipSave: true, skipLayoutUpdate: true });
  }

  const resolvedLayout = Math.min(3, Math.max(1, targetLayout || validNames.length));
  setLayout(resolvedLayout, { skipEnsurePanels: true });

  const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 10000));
  await Promise.race([readyPromise, timeoutPromise]);
}

function onIframeLoaded() {
  pendingIframeLoads = Math.max(0, pendingIframeLoads - 1);
  if (pendingIframeLoads === 0 && onAllIframesLoaded) {
    onAllIframesLoaded();
    onAllIframesLoaded = null;
  }
}

// ═══════════════════════════════════════════
// Toolbar & Node Tabs
// ═══════════════════════════════════════════
function initToolbar() {
  document.getElementById('btnToolbarCapture').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'start-capture' });
  });

  document.getElementById('btnMulticast').addEventListener('click', (e) => {
    const promptVal = document.getElementById('omniPromptInput')?.value.trim() || '';
    if (!croppedImageData && !promptVal) {
      updateStatus('STAGE AN IMAGE OR TYPE A PROMPT FIRST');
      document.getElementById('omniPromptInput')?.focus();
      return;
    }
    showRingMenu(e.clientX, e.clientY);
  });

  document.getElementById('btnDashTheme').addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    await chrome.storage.local.set({ theme: next });
  });

  document.getElementById('btnAddPanel').addEventListener('click', showAddPanelModal);
}

function initNodeTabs() {
  const container = document.getElementById('nodeTabsContainer');
  container.addEventListener('click', (e) => {
    const tab = e.target.closest('.node-tab');
    if (!tab) return;
    const aiName = tab.dataset.ai;
    handleNodeTabClick(aiName);
  });
}

function handleNodeTabClick(aiName) {
  const existing = panels.find(p => p.name === aiName);

  if (!existing) {
    addPanel(aiName);
    focusedPanelName = aiName;
    if (currentLayout === 1) {
      applyLayoutView();
    } else {
      setLayout(Math.min(3, panels.length), { skipEnsurePanels: true });
    }
    return;
  }

  // If already open: focus it
  focusedPanelName = aiName;

  if (currentLayout === 1) {
    applyLayoutView();
    updateStatus(`FOCUSED NODE // ${aiName}`);
  } else if (currentLayout === 2 && panels.length > 2) {
    // Reorder panels array so the clicked panel is among the first 2 visible
    const idx = panels.findIndex(p => p.name === aiName);
    if (idx >= 2) {
      const [moved] = panels.splice(idx, 1);
      panels.unshift(moved);
      const container = document.getElementById('panelsContainer');
      const el = document.getElementById(moved.id);
      if (el && container.firstChild) {
        container.insertBefore(el, container.firstChild);
        rebuildResizers();
      }
      savePanelState();
    }
    applyLayoutView();
    updateStatus(`ACTIVE IN SPLIT // ${aiName}`);
  } else {
    // Highlight / focus in 3-col mode
    syncNodeTabsUI();
    updateStatus(`NODE ACTIVE // ${aiName}`);
  }
}

function syncNodeTabsUI() {
  document.querySelectorAll('.node-tab').forEach((tab) => {
    const aiName = tab.dataset.ai;
    const isOpen = panels.some(p => p.name === aiName);
    const isFocused = isOpen && (
      (currentLayout === 1 && focusedPanelName === aiName) ||
      ( panels.length === 1 && panels[0].name === aiName )
    );

    tab.classList.toggle('is-open', isOpen);
    tab.classList.toggle('is-focused', isFocused);
  });
}

// ═══════════════════════════════════════════
// Functional Layout Controls (1 / 2 / 3 Columns)
// ═══════════════════════════════════════════
function initLayoutControls() {
  document.querySelectorAll('.layout-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const count = parseInt(btn.dataset.layout, 10);
      setLayout(count, { skipEnsurePanels: false });
    });
  });
}

function setLayout(count, { skipEnsurePanels = false } = {}) {
  const validCount = Math.min(3, Math.max(1, count || 1));
  if (validCount > 1) {
    previousMultiLayout = validCount;
  }
  currentLayout = validCount;

  // If user explicitly clicked 2 or 3 columns and fewer panels are open,
  // automatically open the remaining AI nodes so the layout has panels to show
  if (!skipEnsurePanels && panels.length < validCount) {
    for (const aiName of ALL_AI_NAMES) {
      if (panels.length >= validCount) break;
      if (!panels.some(p => p.name === aiName)) {
        addPanel(aiName, { skipSave: true, skipLayoutUpdate: true });
      }
    }
    savePanelState();
  }

  document.querySelectorAll('.layout-btn').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.layout, 10) === validCount);
  });

  resetPanelWidthsToEqual();
  applyLayoutView();
  chrome.storage.local.set({ dashboardLayout: validCount.toString() });
}

function resetPanelWidthsToEqual() {
  document.querySelectorAll('.ai-panel').forEach((el) => {
    el.style.flex = '1 1 0%';
    el.style.width = '';
  });
}

/**
 * Updates visibility of panels and resizers according to `currentLayout`
 * WITHOUT destroying or reloading any iframe.
 */
function applyLayoutView() {
  if (panels.length === 0) {
    syncNodeTabsUI();
    return;
  }

  if (!panels.some(p => p.name === focusedPanelName)) {
    focusedPanelName = panels[0].name;
  }

  let visibleIds = [];
  if (currentLayout === 1) {
    const target = panels.find(p => p.name === focusedPanelName) || panels[0];
    visibleIds = [target.id];
  } else if (currentLayout === 2) {
    visibleIds = panels.slice(0, 2).map(p => p.id);
  } else {
    visibleIds = panels.map(p => p.id);
  }

  panels.forEach((p) => {
    const el = document.getElementById(p.id);
    if (!el) return;
    const isVisible = visibleIds.includes(p.id);
    el.classList.toggle('panel-hidden', !isVisible);
  });

  // Only show a resizer if BOTH the panel before it and a visible panel after it are visible
  const container = document.getElementById('panelsContainer');
  const children = Array.from(container.children);

  children.forEach((child, idx) => {
    if (!child.classList.contains('panel-resizer')) return;
    const prev = children[idx - 1];
    const next = children[idx + 1];
    const prevVisible = prev && prev.classList.contains('ai-panel') && !prev.classList.contains('panel-hidden');
    const nextVisible = next && next.classList.contains('ai-panel') && !next.classList.contains('panel-hidden');
    child.classList.toggle('resizer-hidden', !(prevVisible && nextVisible));
  });

  syncNodeTabsUI();
}

// ═══════════════════════════════════════════
// Panel Creation, Removal & Resizer Management
// ═══════════════════════════════════════════
function addPanel(aiName, { skipSave = false, skipLayoutUpdate = false } = {}) {
  const config = AI_CONFIGS[aiName];
  if (!config) return;

  const existing = panels.find(p => p.name === aiName);
  if (existing) {
    focusedPanelName = aiName;
    applyLayoutView();
    hideAddPanelModal();
    updateStatus(`${aiName} IS ALREADY LINKED`);
    return;
  }

  const panelId = `panel-${aiName.toLowerCase()}-${Date.now().toString(36)}`;
  const panel = { id: panelId, name: aiName, config };
  panels.push(panel);
  focusedPanelName = aiName;

  appendPanelElement(panel);

  if (!skipLayoutUpdate) {
    const nextLayout = Math.min(3, Math.max(currentLayout, panels.length));
    setLayout(nextLayout, { skipEnsurePanels: true });
  } else {
    applyLayoutView();
  }

  updateStatus(`LINKED NODE // ${aiName}`);
  hideAddPanelModal();

  if (!skipSave) {
    savePanelState();
  } else {
    syncNodeTabsUI();
    syncModalCardsUI();
  }
}

function removePanel(panelId) {
  const index = panels.findIndex(p => p.id === panelId);
  if (index === -1) return;

  const removedName = panels[index].name;
  const el = document.getElementById(panelId);

  if (el) {
    // Fix: remove adjacent resizer whether this is the first panel or a later panel
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    if (prev && prev.classList.contains('panel-resizer')) {
      prev.remove();
    } else if (next && next.classList.contains('panel-resizer')) {
      next.remove();
    }
    el.remove();
  }

  panels.splice(index, 1);

  if (panels.length === 0) {
    renderEmptyState();
    savePanelState();
    updateStatus(`DISCONNECTED // ${removedName}`);
    return;
  }

  if (focusedPanelName === removedName) {
    focusedPanelName = panels[0].name;
  }

  resetPanelWidthsToEqual();
  const adjustedLayout = Math.min(currentLayout, panels.length);
  setLayout(adjustedLayout, { skipEnsurePanels: true });
  savePanelState();
  updateStatus(`DISCONNECTED // ${removedName}`);
}

function rebuildResizers() {
  const container = document.getElementById('panelsContainer');
  container.querySelectorAll('.panel-resizer').forEach(r => r.remove());

  const panelEls = Array.from(container.querySelectorAll('.ai-panel'));
  panelEls.forEach((panelEl, idx) => {
    if (idx > 0) {
      const resizer = document.createElement('div');
      resizer.className = 'panel-resizer';
      resizer.title = 'Drag to resize (Double-click to equalize)';
      container.insertBefore(resizer, panelEl);
      initResizer(resizer);
    }
  });
}

function renderEmptyState() {
  const container = document.getElementById('panelsContainer');
  container.innerHTML = `
    <div class="panel-empty" id="emptyPanel">
      <div class="panel-empty-icon">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="12 2 22 12 12 22 2 12 12 2"/>
          <line x1="12" y1="8" x2="12" y2="16"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
      </div>
      <span class="panel-empty-title">Initialize Neural Links</span>
      <span class="panel-empty-sub">Click to link ChatGPT, Claude, or Gemini into the Cardinal Workspace</span>
    </div>
  `;
  document.getElementById('emptyPanel').addEventListener('click', showAddPanelModal);
}

function appendPanelElement(panel) {
  const container = document.getElementById('panelsContainer');

  const empty = document.getElementById('emptyPanel');
  if (empty) empty.remove();

  if (container.querySelectorAll('.ai-panel').length > 0) {
    const resizer = document.createElement('div');
    resizer.className = 'panel-resizer';
    resizer.title = 'Drag to resize (Double-click to equalize)';
    container.appendChild(resizer);
    initResizer(resizer);
  }

  container.appendChild(createPanelElement(panel));
}

function createPanelElement(panel) {
  const el = document.createElement('div');
  el.className = 'ai-panel';
  el.id = panel.id;
  el.dataset.ai = panel.name;
  el.style.setProperty('--panel-accent', panel.config.accent);

  const hasSavedSession = !!savedChatUrls[panel.name];

  el.innerHTML = `
    <div class="panel-header">
      <div class="panel-title">
        <span class="panel-icon">${panel.config.svg}</span>
        <span class="panel-name">${panel.name}</span>
        <span class="panel-session-badge ${hasSavedSession ? 'saved' : ''}" id="badge-${panel.id}">
          ${hasSavedSession ? 'SESSION' : 'LIVE'}
        </span>
      </div>
      <div class="panel-actions">
        <button type="button" class="panel-action-btn new-chat-btn sao-tooltip sao-tooltip-bottom" data-tooltip="New Chat Session">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <span>New</span>
        </button>
        <button type="button" class="panel-action-btn focus-btn sao-tooltip sao-tooltip-bottom" data-tooltip="Toggle Focus View">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 3 21 3 21 9"/>
            <polyline points="9 21 3 21 3 15"/>
            <line x1="21" y1="3" x2="14" y2="10"/>
            <line x1="3" y1="21" x2="10" y2="14"/>
          </svg>
        </button>
        <button type="button" class="panel-action-btn ext-btn sao-tooltip sao-tooltip-bottom" data-tooltip="Open in Standalone Tab">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </button>
        <button type="button" class="panel-action-btn reload-btn sao-tooltip sao-tooltip-bottom" data-tooltip="Reload Node">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <button type="button" class="panel-action-btn close-btn sao-tooltip sao-tooltip-bottom" data-tooltip="Close Node">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="panel-iframe-wrapper">
      <div class="panel-loading" id="loading-${panel.id}">
        <div class="loading-spinner"></div>
        <span class="loading-text">LINKING // ${panel.name}</span>
      </div>
      <iframe
        class="panel-iframe"
        id="iframe-${panel.id}"
        src="${getPanelUrl(panel.name)}"
        sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads allow-top-navigation-by-user-activation allow-storage-access-by-user-activation"
        allow="clipboard-read; clipboard-write; microphone"
      ></iframe>
    </div>
  `;

  const iframe = el.querySelector('.panel-iframe');
  const loading = el.querySelector('.panel-loading');

  iframe.addEventListener('load', () => {
    loading.classList.add('hidden');
    onIframeLoaded();
  });

  // New Chat: clears saved session URL and loads fresh chat
  el.querySelector('.new-chat-btn').addEventListener('click', async () => {
    delete savedChatUrls[panel.name];
    await chrome.runtime.sendMessage({ action: 'clear-ai-url', aiName: panel.name });
    updatePanelBadge(panel.name);
    loading.classList.remove('hidden');
    iframe.src = panel.config.newChatUrl;
    updateStatus(`NEW SESSION // ${panel.name}`);
  });

  // Toggle Focus View (1-Col <-> Multi-Col)
  el.querySelector('.focus-btn').addEventListener('click', () => {
    focusedPanelName = panel.name;
    if (currentLayout === 1 && panels.length > 1) {
      setLayout(Math.min(panels.length, previousMultiLayout || 3), { skipEnsurePanels: true });
      updateStatus('RESTORED MULTI-NODE VIEW');
    } else {
      setLayout(1, { skipEnsurePanels: true });
      updateStatus(`FOCUS MODE // ${panel.name}`);
    }
  });

  // Open in External Browser Tab
  el.querySelector('.ext-btn').addEventListener('click', () => {
    const targetUrl = savedChatUrls[panel.name] || panel.config.url;
    chrome.tabs.create({ url: targetUrl, active: true });
  });

  // Reload Node
  el.querySelector('.reload-btn').addEventListener('click', () => {
    loading.classList.remove('hidden');
    iframe.src = getPanelUrl(panel.name);
  });

  // Close Node
  el.querySelector('.close-btn').addEventListener('click', () => {
    removePanel(panel.id);
  });

  return el;
}

function updatePanelBadge(aiName) {
  const panel = panels.find(p => p.name === aiName);
  if (!panel) return;
  const badge = document.getElementById(`badge-${panel.id}`);
  if (!badge) return;
  const hasSaved = !!savedChatUrls[aiName];
  badge.textContent = hasSaved ? 'SESSION' : 'LIVE';
  badge.classList.toggle('saved', hasSaved);
}

// ═══════════════════════════════════════════
// Proportional Flex-Ratio Panel Resizer
// ═══════════════════════════════════════════
function initResizer(resizerEl) {
  let isResizing = false;
  let startX = 0;
  let prevPanel = null;
  let nextPanel = null;
  let prevStartWidth = 0;
  let nextStartWidth = 0;
  let combinedFlex = 2;

  resizerEl.addEventListener('dblclick', () => {
    resetPanelWidthsToEqual();
    updateStatus('COLUMNS EQUALIZED');
  });

  resizerEl.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    resizerEl.classList.add('active');

    prevPanel = resizerEl.previousElementSibling;
    nextPanel = resizerEl.nextElementSibling;

    if (prevPanel && nextPanel) {
      prevStartWidth = prevPanel.getBoundingClientRect().width;
      nextStartWidth = nextPanel.getBoundingClientRect().width;
      const prevFlex = parseFloat(prevPanel.style.flexGrow) || 1;
      const nextFlex = parseFloat(nextPanel.style.flexGrow) || 1;
      combinedFlex = prevFlex + nextFlex;
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    document.querySelectorAll('.panel-iframe').forEach((f) => {
      f.style.pointerEvents = 'none';
    });
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizing || !prevPanel || !nextPanel) return;

    const dx = e.clientX - startX;
    const totalW = prevStartWidth + nextStartWidth;
    const newPrevW = prevStartWidth + dx;
    const newNextW = nextStartWidth - dx;

    if (newPrevW >= 220 && newNextW >= 220 && totalW > 0) {
      const prevRatio = (newPrevW / totalW) * combinedFlex;
      const nextRatio = (newNextW / totalW) * combinedFlex;
      prevPanel.style.flex = `${prevRatio.toFixed(4)} 1 0%`;
      nextPanel.style.flex = `${nextRatio.toFixed(4)} 1 0%`;
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizerEl.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    document.querySelectorAll('.panel-iframe').forEach((f) => {
      f.style.pointerEvents = '';
    });
  });
}

// ═══════════════════════════════════════════
// All-Link Omni-Command Bar (Prompt + Image Broadcast)
// ═══════════════════════════════════════════
function initOmniCommandBar() {
  const omniInput = document.getElementById('omniPromptInput');
  const sendBtn = document.getElementById('btnOmniSend');
  const attachBtn = document.getElementById('btnAttachImage');
  const fileInput = document.getElementById('omniFileInput');
  const clearStagedBtn = document.getElementById('btnClearStaged');
  const presets = document.getElementById('omniPresets');

  // Attach image via file picker
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readFileAsDataUrl(file);
    fileInput.value = '';
  });

  // Global paste listener on Dashboard for quick Ctrl+V image staging
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          readFileAsDataUrl(file);
          omniInput.focus();
          return;
        }
      }
    }
  });

  // Clear staged image
  clearStagedBtn.addEventListener('click', () => {
    setStagedImage(null);
    updateStatus('STAGED IMAGE CLEARED');
  });

  // Quick prompt preset chips
  presets.addEventListener('click', (e) => {
    const chip = e.target.closest('.omni-chip');
    if (!chip) return;
    omniInput.value = chip.dataset.prompt || '';
    omniInput.focus();
  });

  // Send on button click or Enter
  sendBtn.addEventListener('click', () => {
    triggerOmniBroadcast(null);
  });

  omniInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      triggerOmniBroadcast(null);
    }
  });
}

function readFileAsDataUrl(file) {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      setStagedImage(reader.result);
      updateStatus('IMAGE STAGED // READY FOR ALL-LINK');
    }
  };
  reader.readAsDataURL(file);
}

function setStagedImage(dataUrl) {
  croppedImageData = dataUrl || null;
  const container = document.getElementById('stagedAttachment');
  const thumb = document.getElementById('stagedThumb');

  if (croppedImageData) {
    thumb.src = croppedImageData;
    container.style.display = 'inline-flex';
  } else {
    thumb.removeAttribute('src');
    container.style.display = 'none';
  }
}

async function triggerOmniBroadcast(targetAI = null) {
  const omniInput = document.getElementById('omniPromptInput');
  const promptText = (omniInput?.value || '').trim();

  if (!croppedImageData && !promptText) {
    updateStatus('ENTER A PROMPT OR CAPTURE AN IMAGE FIRST');
    omniInput?.focus();
    return;
  }

  const payloadImage = croppedImageData;
  const targetLabel = targetAI || 'ALL LINKED NODES';
  updateStatus(`ALL-LINK START // SENDING TO ${targetLabel}...`);

  if (omniInput) omniInput.value = '';
  setStagedImage(null);

  try {
    await chrome.runtime.sendMessage({
      action: 'multicast-image',
      dataUrl: payloadImage,
      promptText,
      targetAI,
      focusDashboard: false
    });
    updateStatus(`DISPATCHED TO ${targetLabel}`);
  } catch (err) {
    console.warn('[Yui.AI] Broadcast error:', err);
    updateStatus('DISPATCH ERROR // CHECK NODE STATUS');
  }
}

// ═══════════════════════════════════════════
// Add / Manage Nodes Modal
// ═══════════════════════════════════════════
function initAddPanelModal() {
  const overlay = document.getElementById('addPanelOverlay');

  document.querySelectorAll('.ai-select-card').forEach((card) => {
    card.addEventListener('click', () => {
      const aiName = card.dataset.ai;
      addPanel(aiName);
    });
  });

  document.getElementById('btnLinkAllNodes').addEventListener('click', () => {
    for (const aiName of ALL_AI_NAMES) {
      if (!panels.some(p => p.name === aiName)) {
        addPanel(aiName, { skipSave: true, skipLayoutUpdate: true });
      }
    }
    setLayout(3, { skipEnsurePanels: true });
    savePanelState();
    hideAddPanelModal();
    updateStatus('ALL 3 NEURAL NODES LINKED');
  });

  document.getElementById('btnCloseAddPanel').addEventListener('click', hideAddPanelModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideAddPanelModal();
  });
}

function syncModalCardsUI() {
  document.querySelectorAll('.ai-select-card').forEach((card) => {
    const aiName = card.dataset.ai;
    const isOpen = panels.some(p => p.name === aiName);
    card.classList.toggle('active-node', isOpen);
    const stateEl = card.querySelector('.ai-select-state');
    if (stateEl) {
      stateEl.textContent = isOpen ? 'LINKED' : 'CLICK TO LINK';
    }
  });
}

function showAddPanelModal() {
  syncModalCardsUI();
  document.getElementById('addPanelOverlay').style.display = 'flex';
}

function hideAddPanelModal() {
  document.getElementById('addPanelOverlay').style.display = 'none';
}

// ═══════════════════════════════════════════
// Minimalist SAO Radial Ring Menu (Viewport Clamped)
// ═══════════════════════════════════════════
function initRingMenu() {
  const overlay = document.getElementById('ringMenuOverlay');

  document.querySelectorAll('.ring-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      handleRingAction(action);
      hideRingMenu();
    });
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideRingMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideRingMenu();
      hideAddPanelModal();
    }
  });
}

function showRingMenu(x, y) {
  const overlay = document.getElementById('ringMenuOverlay');
  const menu = document.getElementById('ringMenu');

  // Clamp coordinates so the 220x220 radial ring never clips outside viewport edges
  const margin = 135;
  const clampedX = Math.max(margin, Math.min(window.innerWidth - margin, x || window.innerWidth / 2));
  const clampedY = Math.max(margin, Math.min(window.innerHeight - margin, y || window.innerHeight / 2));

  menu.style.left = `${clampedX}px`;
  menu.style.top = `${clampedY}px`;
  overlay.style.display = 'block';
}

function hideRingMenu() {
  document.getElementById('ringMenuOverlay').style.display = 'none';
}

function handleRingAction(action) {
  switch (action) {
    case 'send-all':
      triggerOmniBroadcast(null);
      break;
    case 'send-chatgpt':
      sendToSpecificAI('ChatGPT');
      break;
    case 'send-claude':
      sendToSpecificAI('Claude');
      break;
    case 'send-gemini':
      sendToSpecificAI('Gemini');
      break;
  }
}

function sendToSpecificAI(aiName) {
  if (!panels.some(p => p.name === aiName)) {
    addPanel(aiName);
  }
  triggerOmniBroadcast(aiName);
}

// ═══════════════════════════════════════════
// Runtime & Storage Listeners
// ═══════════════════════════════════════════
function initMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'receive-cropped-image') {
      if (message.autoSent) {
        updateStatus('ALL-LINK DISPATCHED FROM CAPTURE');
      } else {
        setStagedImage(message.dataUrl);
        if (message.promptText) {
          const omniInput = document.getElementById('omniPromptInput');
          if (omniInput) omniInput.value = message.promptText;
        }
        updateStatus('IMAGE LOCKED // PRESS ENTER OR CLICK ALL-LINK SEND');
        document.getElementById('omniPromptInput')?.focus();
      }
      sendResponse({ ack: true });
      return false;
    }

    if (message.action === 'focus-or-add-panel' && message.aiName) {
      const aiName = message.aiName;
      if (!panels.some(p => p.name === aiName)) {
        addPanel(aiName);
      } else {
        focusedPanelName = aiName;
        applyLayoutView();
      }
      sendResponse({ ack: true });
      return false;
    }

    return false;
  });
}

function getPanelUrl(aiName) {
  const savedUrl = savedChatUrls[aiName];
  if (savedUrl) return savedUrl;
  return AI_CONFIGS[aiName]?.url || '#';
}

function initStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.chatUrls) {
      savedChatUrls = changes.chatUrls.newValue || {};
      ALL_AI_NAMES.forEach(name => updatePanelBadge(name));
    }

    if (changes.theme && changes.theme.newValue) {
      document.documentElement.setAttribute('data-theme', changes.theme.newValue);
    }
  });
}

// ═══════════════════════════════════════════
// Status Bar Readout
// ═══════════════════════════════════════════
function updateStatus(text, autoReset = true) {
  const statusEl = document.getElementById('statusText');
  if (!statusEl) return;
  statusEl.textContent = text;

  clearTimeout(statusResetTimer);
  if (autoReset) {
    statusResetTimer = setTimeout(() => {
      statusEl.textContent = `CARDINAL READY // ${panels.length} NODE(S)`;
    }, 4500);
  }
}
