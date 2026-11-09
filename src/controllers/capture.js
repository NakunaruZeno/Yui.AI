/* ============================================================
   Yui.AI — Capture & Lossless High-DPI Smart Crop Logic
   Maps viewport selection to native screenshot resolution,
   with inline prompt injection and instant All-Link dispatch.
   ============================================================ */

// ── State ──
let rawScreenshotDataUrl = null;
let screenshotImage = null;
let isCropping = false;
let hasCropped = false;
let submitMethod = 'ring-menu';

let cropStart = { x: 0, y: 0 };
let cropEnd = { x: 0, y: 0 };

// Exact CSS bounding box where the screenshot is rendered
let drawRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  scale: 1
};

// ── DOM Elements ──
const canvas = document.getElementById('screenshotCanvas');
const ctx = canvas.getContext('2d');
const cropOverlay = document.getElementById('cropOverlay');
const cropSelection = document.getElementById('cropSelection');
const cropSizeLabel = document.getElementById('cropSizeLabel');
const captureHud = document.getElementById('captureHud');
const captureActions = document.getElementById('captureActions');
const promptInput = document.getElementById('capturePromptInput');

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get(['theme', 'submitMethod']);
  document.documentElement.setAttribute('data-theme', settings.theme || 'dark');
  submitMethod = settings.submitMethod || 'ring-menu';

  const response = await chrome.runtime.sendMessage({ action: 'get-captured-image' });

  if (response && response.dataUrl) {
    rawScreenshotDataUrl = response.dataUrl;
    loadScreenshot(response.dataUrl);
  } else {
    showError('No screenshot buffer found. Press ESC and try capturing again.');
  }

  initCropEvents();
  initActionButtons();
  initKeyboard();
});

// ═══════════════════════════════════════════
// High-DPI Screenshot Rendering
// ═══════════════════════════════════════════
function loadScreenshot(dataUrl) {
  const img = new Image();
  img.onload = () => {
    screenshotImage = img;
    drawScreenshot();
  };
  img.src = dataUrl;
}

function drawScreenshot() {
  if (!screenshotImage) return;

  const dpr = window.devicePixelRatio || 1;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;

  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, viewW, viewH);

  const scale = Math.min(
    viewW / screenshotImage.naturalWidth,
    viewH / screenshotImage.naturalHeight
  );

  const drawWidth = screenshotImage.naturalWidth * scale;
  const drawHeight = screenshotImage.naturalHeight * scale;
  const offsetX = (viewW - drawWidth) / 2;
  const offsetY = (viewH - drawHeight) / 2;

  drawRect = {
    x: offsetX,
    y: offsetY,
    width: drawWidth,
    height: drawHeight,
    scale
  };

  ctx.drawImage(screenshotImage, offsetX, offsetY, drawWidth, drawHeight);
}

// ═══════════════════════════════════════════
// Crop Selection Events
// ═══════════════════════════════════════════
function initCropEvents() {
  const container = document.getElementById('captureContainer');

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.capture-command-panel')) return;

    // Allow immediate re-dragging on the canvas without clicking Recrop first
    if (hasCropped) {
      hasCropped = false;
      captureActions.style.display = 'none';
    }

    isCropping = true;
    cropStart.x = e.clientX;
    cropStart.y = e.clientY;
    cropEnd.x = e.clientX;
    cropEnd.y = e.clientY;

    cropOverlay.classList.add('cropping');
    captureHud.classList.add('hidden');
    cropSelection.style.display = 'block';

    updateCropSelection();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isCropping) return;

    cropEnd.x = Math.max(0, Math.min(window.innerWidth, e.clientX));
    cropEnd.y = Math.max(0, Math.min(window.innerHeight, e.clientY));

    updateCropSelection();
  });

  window.addEventListener('mouseup', () => {
    if (!isCropping) return;
    isCropping = false;

    const width = Math.abs(cropEnd.x - cropStart.x);
    const height = Math.abs(cropEnd.y - cropStart.y);

    if (width < 12 || height < 12) {
      resetCrop();
      return;
    }

    hasCropped = true;

    // If user selected "Instant" (shortcut) mode in popup settings,
    // immediately broadcast on mouse release unless holding Shift
    if (submitMethod === 'shortcut') {
      dispatchMulticast(getCroppedDataUrl(), '', null);
      return;
    }

    showCommandPanel();
  });
}

function updateCropSelection() {
  const left = Math.min(cropStart.x, cropEnd.x);
  const top = Math.min(cropStart.y, cropEnd.y);
  const width = Math.abs(cropEnd.x - cropStart.x);
  const height = Math.abs(cropEnd.y - cropStart.y);

  cropSelection.style.left = `${left}px`;
  cropSelection.style.top = `${top}px`;
  cropSelection.style.width = `${width}px`;
  cropSelection.style.height = `${height}px`;

  // Display native pixel dimensions
  const nativeW = Math.round(width / (drawRect.scale || 1));
  const nativeH = Math.round(height / (drawRect.scale || 1));
  cropSizeLabel.textContent = `${nativeW} × ${nativeH} px`;

  // Flip badge inside if too close to top edge
  cropSizeLabel.style.top = top < 32 ? '6px' : '-26px';
}

function resetCrop() {
  hasCropped = false;
  isCropping = false;
  cropSelection.style.display = 'none';
  cropOverlay.classList.remove('cropping');
  captureHud.classList.remove('hidden');
  captureActions.style.display = 'none';
  if (promptInput) promptInput.value = '';
  document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
}

// ═══════════════════════════════════════════
// Lossless Native-Resolution Extraction
// ═══════════════════════════════════════════
function getCroppedDataUrl() {
  if (!screenshotImage) return null;

  const selLeft = Math.min(cropStart.x, cropEnd.x);
  const selTop = Math.min(cropStart.y, cropEnd.y);
  const selWidth = Math.abs(cropEnd.x - cropStart.x);
  const selHeight = Math.abs(cropEnd.y - cropStart.y);

  // Clamp selection to the rendered image bounds
  const clampedLeft = Math.max(drawRect.x, Math.min(drawRect.x + drawRect.width, selLeft));
  const clampedTop = Math.max(drawRect.y, Math.min(drawRect.y + drawRect.height, selTop));
  const clampedRight = Math.max(drawRect.x, Math.min(drawRect.x + drawRect.width, selLeft + selWidth));
  const clampedBottom = Math.max(drawRect.y, Math.min(drawRect.y + drawRect.height, selTop + selHeight));

  const cssW = Math.max(1, clampedRight - clampedLeft);
  const cssH = Math.max(1, clampedBottom - clampedTop);

  // Convert CSS coordinates back to native screenshot pixel coordinates
  const scale = drawRect.scale || 1;
  const srcX = Math.round((clampedLeft - drawRect.x) / scale);
  const srcY = Math.round((clampedTop - drawRect.y) / scale);
  const srcW = Math.max(1, Math.round(cssW / scale));
  const srcH = Math.max(1, Math.round(cssH / scale));

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = srcW;
  tempCanvas.height = srcH;
  const tempCtx = tempCanvas.getContext('2d');

  tempCtx.drawImage(
    screenshotImage,
    srcX,
    srcY,
    srcW,
    srcH,
    0,
    0,
    srcW,
    srcH
  );

  return tempCanvas.toDataURL('image/png');
}

function getFullScreenDataUrl() {
  if (rawScreenshotDataUrl) return rawScreenshotDataUrl;
  if (!screenshotImage) return null;
  return canvas.toDataURL('image/png');
}

// ═══════════════════════════════════════════
// Post-Crop Command Panel & Actions
// ═══════════════════════════════════════════
function showCommandPanel() {
  const bottomEdge = Math.max(cropStart.y, cropEnd.y);
  // Flip command panel to top of viewport if selection is near the bottom
  if (bottomEdge > window.innerHeight - 135) {
    captureActions.style.bottom = 'auto';
    captureActions.style.top = '24px';
  } else {
    captureActions.style.top = 'auto';
    captureActions.style.bottom = '28px';
  }

  captureActions.style.display = 'flex';
  setTimeout(() => {
    if (promptInput) promptInput.focus();
  }, 30);
}

function dispatchMulticast(dataUrl, promptText, targetAI = null) {
  if (!dataUrl) return;
  chrome.runtime.sendMessage({
    action: 'multicast-image',
    dataUrl,
    promptText: (promptText || '').trim(),
    targetAI,
    focusDashboard: true
  });
  setTimeout(() => closeCapture(), 60);
}

function dispatchStageOnly(dataUrl, promptText) {
  if (!dataUrl) return;
  chrome.runtime.sendMessage({
    action: 'crop-complete',
    croppedDataUrl: dataUrl,
    promptText: (promptText || '').trim(),
    focusDashboard: true
  });
  setTimeout(() => closeCapture(), 60);
}

function initActionButtons() {
  // Preset prompt chips
  document.getElementById('capturePresets').addEventListener('click', (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;

    const text = chip.dataset.prompt || '';
    const wasActive = chip.classList.contains('active');
    document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));

    if (!wasActive) {
      chip.classList.add('active');
      promptInput.value = text;
    } else {
      promptInput.value = '';
    }
    promptInput.focus();
  });

  // All-Link Start (send to all active AIs)
  document.getElementById('btnSendAll').addEventListener('click', () => {
    const dataUrl = getCroppedDataUrl();
    dispatchMulticast(dataUrl, promptInput.value, null);
  });

  // Single AI Node buttons (ChatGPT, Claude, Gemini)
  document.querySelectorAll('.cap-btn-node').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetAI = btn.dataset.target;
      const dataUrl = getCroppedDataUrl();
      dispatchMulticast(dataUrl, promptInput.value, targetAI);
    });
  });

  // Stage in Dashboard Command Bar without auto-submitting
  document.getElementById('btnStageOnly').addEventListener('click', () => {
    const dataUrl = getCroppedDataUrl();
    dispatchStageOnly(dataUrl, promptInput.value);
  });

  // Copy cropped image to clipboard
  document.getElementById('btnCopyImage').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const dataUrl = getCroppedDataUrl();
    if (!dataUrl) return;

    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      btn.style.color = 'var(--sao-secondary)';
      btn.style.borderColor = 'var(--sao-secondary)';
      setTimeout(() => {
        btn.style.color = '';
        btn.style.borderColor = '';
      }, 1200);
    } catch (err) {
      console.warn('[Yui.AI] Clipboard write failed:', err);
    }
  });

  // Recrop
  document.getElementById('btnRecrop').addEventListener('click', () => {
    resetCrop();
  });

  // Cancel
  document.getElementById('btnCancel').addEventListener('click', () => {
    closeCapture();
  });
}

// ═══════════════════════════════════════════
// Keyboard Shortcuts
// ═══════════════════════════════════════════
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    const isTyping = document.activeElement === promptInput;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (hasCropped) {
        resetCrop();
      } else {
        closeCapture();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (hasCropped) {
        const dataUrl = getCroppedDataUrl();
        dispatchMulticast(dataUrl, promptInput.value, null);
      } else {
        const fullUrl = getFullScreenDataUrl();
        dispatchMulticast(fullUrl, '', null);
      }
      return;
    }

    if (e.key === ' ' && !isTyping && !hasCropped) {
      e.preventDefault();
      const fullUrl = getFullScreenDataUrl();
      if (fullUrl) {
        // Lock full screen and show command panel
        cropStart = { x: Math.round(drawRect.x), y: Math.round(drawRect.y) };
        cropEnd = {
          x: Math.round(drawRect.x + drawRect.width),
          y: Math.round(drawRect.y + drawRect.height)
        };
        cropOverlay.classList.add('cropping');
        captureHud.classList.add('hidden');
        cropSelection.style.display = 'block';
        updateCropSelection();
        hasCropped = true;
        showCommandPanel();
      }
    }
  });
}

// ═══════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════
function closeCapture() {
  window.close();
}

function showError(message) {
  const hud = document.getElementById('hudInstructions');
  if (!hud) return;
  hud.innerHTML = `
    <div class="hud-card sao-animate-fade-in" style="border-color: rgba(244, 63, 94, 0.4);">
      <span class="hud-key" style="color: var(--sao-danger);">CAPTURE ERROR</span>
      <span class="hud-desc">${message}</span>
    </div>
  `;
}

window.addEventListener('resize', () => {
  if (screenshotImage) {
    drawScreenshot();
  }
});
