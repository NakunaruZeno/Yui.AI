/* ============================================================
   Yui.AI — Popup Logic
   Manages theme toggle, live AI node status, and quick launch
   ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  // ── Load Settings ──
  const settings = await chrome.storage.local.get(['theme', 'submitMethod']);
  const theme = settings.theme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  const method = settings.submitMethod || 'ring-menu';
  updateToggleUI(method);

  // ── Check AI Status ──
  await refreshAIStatus();

  // ── Theme Toggle ──
  document.getElementById('btnThemeToggle').addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    await chrome.storage.local.set({ theme: next });
  });

  // ── Clicking an AI Card opens Dashboard with that AI active ──
  document.getElementById('aiStatusGrid').addEventListener('click', async (e) => {
    const card = e.target.closest('.ai-card');
    if (!card) return;
    const aiName = card.dataset.ai;
    await chrome.runtime.sendMessage({
      action: 'open-dashboard',
      targetAI: aiName
    });
    window.close();
  });

  // ── Open Dashboard ──
  document.getElementById('btnOpenDashboard').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'open-dashboard' });
    window.close();
  });

  // ── Capture & Send ──
  document.getElementById('btnCapture').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'start-capture' });
    window.close();
  });

  // ── Submit Method Toggle ──
  document.getElementById('submitMethodToggle').addEventListener('click', async (e) => {
    const btn = e.target.closest('.toggle-opt');
    if (!btn) return;
    const value = btn.dataset.value;
    updateToggleUI(value);
    await chrome.storage.local.set({ submitMethod: value });
  });
});

// ── Refresh AI Connection Status ──
async function refreshAIStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'get-ai-status' });
    const grid = document.getElementById('aiStatusGrid');
    const cards = grid.querySelectorAll('.ai-card');
    let activeCount = 0;

    cards.forEach((card) => {
      const aiName = card.dataset.ai;
      const dot = card.querySelector('.ai-status-dot');
      const stateText = card.querySelector('.ai-state-text');
      const info = status ? status[aiName] : null;

      card.classList.remove('online', 'configured');
      dot.classList.remove('online', 'configured', 'offline');

      if (info && info.online) {
        activeCount++;
        card.classList.add('online');
        dot.classList.add('online');
        stateText.textContent = info.inDashboard ? 'LINKED' : 'TAB OPEN';
      } else if (info && info.isConfigured) {
        card.classList.add('configured');
        dot.classList.add('configured');
        stateText.textContent = info.hasSession ? 'SAVED' : 'READY';
      } else {
        dot.classList.add('offline');
        stateText.textContent = 'STANDBY';
      }
    });

    const countLabel = document.getElementById('onlineCountLabel');
    if (countLabel) {
      countLabel.textContent = `${activeCount} / 3 ACTIVE`;
    }
  } catch (e) {
    console.warn('[Yui.AI] Could not get AI status:', e);
  }
}

// ── Update Toggle Group UI ──
function updateToggleUI(activeValue) {
  const toggles = document.querySelectorAll('#submitMethodToggle .toggle-opt');
  toggles.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === activeValue);
  });
}
