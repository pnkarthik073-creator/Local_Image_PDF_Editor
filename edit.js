import JSZip from "jszip";
import { jsPDF } from "jspdf";
import { createImageProcessingClient } from "./workerClient.js";
/* =========================================
   edit.js
   ========================================= */

// --- DOM ELEMENTS ---
let modal, carousel, filmstrip, slider, counter, infoBar;
let btnZoomIn, btnZoomOut, btnSave, btnUndo, btnRedo;
let btnRotateCCW, btnRotateCW, btnFlipH, btnFlipV, btnCrop, btnExport;
let gridView, btnToggleGrid;

// --- STATE ---
let isDirty = false;
let activeIndex = 0;
let totalPages = 1;
let selectedPages = new Set();
let currentZoom = 1;
let panX = 0, panY = 0;
let saveMode = 'original'; // Track if we are overwriting or copying
let lastSelectedGridIndex = null;
let isToolZoomMode = false;
let detachToolZoomHandlers = null;

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const CLICK_ZOOM_STEP = 0.4;
const HOLD_ZOOM_STEP = 0.05;
const WHEEL_ZOOM_STEP = 0.1;
const DOUBLE_CLICK_ZOOM = 2;

// --- VIEW MODE STATE ---
// Tracks the active mode ('carousel' or 'grid')
let currentEditorMode = 'carousel';

// Remembers the user's preference across modal closes! (Defaults to grid for PDFs)
let lastPdfPreference = 'grid';
let currentPdfDoc = null;
let currentSessionMode = 'single-image';
let currentBatchThumbs = [];
let toolInfoBar;

// Transforms & History
let editState = { rotation: 0, flipH: 1, flipV: 1 };
let pageHistory = {};
let historyPointers = {};

// Crop State
let isCropMode = false;
let cropOverlay;

// RESIZE MODULE
let isResizeMode = false;
let isRatioLocked = true;
let origImgW = 0, origImgH = 0;
const processingClient = createImageProcessingClient();

processingClient.warmup().catch((error) => {
    console.warn("Editor worker warmup skipped:", error);
});

// These will be available globally if using CDN script tags
const zip = new JSZip();
const pdf = new jsPDF();

const resizeToolbar = document.getElementById("resizeToolbar");
const resizeW = document.getElementById("resizeW");
const resizeH = document.getElementById("resizeH");
const resizeScale = document.getElementById("resizeScale");
const resizeScaleValue = document.getElementById("resizeScaleValue");
const btnLockRatio = document.getElementById("btnLockRatio");
const btnResizeTrigger = document.getElementById("btnResize");
// RESIZE MODULE

// Resize Observer to fix "Sliding" issue
let resizeObserver;

window.modeBeforeTool = null; // Remembers if we came from grid or carousel

// --- EXPORTED MAIN FUNCTION ---
export async function openImageModal(urlOrData, isPdf = false, originalThumb = null, callbacks = {}) {
    document.body.style.overflow = "hidden";
    initModalDOM();
    const isBatchImageSession = Array.isArray(callbacks.batchThumbs) && callbacks.batchThumbs.length > 0;
    currentSessionMode = isBatchImageSession ? 'image-batch' : (isPdf ? 'pdf' : 'single-image');
    currentBatchThumbs = isBatchImageSession ? callbacks.batchThumbs : [];

    resetEditorState(isPdf || isBatchImageSession, originalThumb);

    // Setup Controls
    setupNavigation(isPdf || isBatchImageSession);
    setupSaveHandler(originalThumb, isPdf, callbacks);
    setupZoomControls();
    setupTransformControls();
    setupHistoryControls();
    setupCropTool();
    setupExportHandler();

    // Load Content
    if (isPdf) {
        // 1. Save it to our global variable so the rest of the app can use it
        currentPdfDoc = urlOrData;

        // 2. Render the carousel
        await renderPdfContent(urlOrData);

        // ==========================================
        // FIX: Pass urlOrData (which is the actual PDF object) into the Grid!
        // ==========================================
        renderPdfGrid(urlOrData);
    } else if (isBatchImageSession) {
        currentPdfDoc = { numPages: currentBatchThumbs.length, isImageBatch: true };
        renderImageBatchContent(currentBatchThumbs);
        await renderImageBatchGrid(currentBatchThumbs);
    } else {
        currentPdfDoc = null;
        renderImageContent(urlOrData);
    }

    // Restore Session
    if (!isBatchImageSession && originalThumb && originalThumb._editorState) {
        restoreState(originalThumb._editorState);
    }

    modal.classList.add("active");

    // Activate Observer to keep image centered during layout changes
    if (resizeObserver) resizeObserver.observe(carousel);

    setTimeout(() => updateNav(isPdf || isBatchImageSession), 50);
}

window.updateGridControls = () => {
    const isGrid = currentEditorMode === 'grid';
    const noSelection = isGrid && selectedPages.size === 0;
    const singleSelection = isGrid && selectedPages.size === 1;

    // 1. Batch Tools (Rotate/Flip/Compress) - Require at least 1 selection in Grid Mode
    const btnCompress = document.getElementById("btnCompress");
    const transformTools = [btnRotateCCW, btnRotateCW, btnFlipH, btnFlipV, btnCompress];
    transformTools.forEach(btn => {
        if (!btn) return;
        if (isGrid && noSelection) {
            btn.style.opacity = "0.3";
            btn.style.pointerEvents = "none";
        } else {
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
        }
    });

    // 2. View Tools (Zoom) - Completely DISABLED in Grid Mode!
    const viewTools = [btnZoomIn, btnZoomOut];
    viewTools.forEach(btn => {
        if (!btn) return;
        if (isGrid) {
            btn.style.opacity = "0.3";
            btn.style.pointerEvents = "none";
        } else {
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
        }
    });

    // 3. Single-Item Tools (Crop & Resize) - Enabled in Carousel OR if exactly 1 selected in Grid
    const singleTools = [btnCrop, document.getElementById("btnResize")];
    singleTools.forEach(btn => {
        if (!btn) return;
        if (currentEditorMode === 'carousel' || singleSelection) {
            btn.disabled = false;
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
        } else {
            btn.style.opacity = "0.3";
            btn.style.pointerEvents = "none";
        }
    });

    // Sync the Undo/Redo buttons too
    if (typeof window.updateUndoRedoUI === "function") window.updateUndoRedoUI();
};

// ==========================================
// UNIFIED GRID THUMBNAIL GENERATOR
// Guarantees consistent 300px low-quality thumbs!
// ==========================================
window.updateGridThumbnail = (idx) => {
    const gridItem = gridView ? gridView.children[idx] : null;
    const carouselWrapper = carousel ? carousel.children[idx] : null;
    if (!gridItem || !carouselWrapper) return;

    const sourceImg = carouselWrapper.querySelector("img, canvas");
    const targetCanvas = gridItem.querySelector("canvas");

    if (sourceImg && targetCanvas) {
        const MAX_THUMB = 300;
        const origW = sourceImg.naturalWidth || sourceImg.width;
        const origH = sourceImg.naturalHeight || sourceImg.height;
        const scale = Math.min(MAX_THUMB / origW, MAX_THUMB / origH, 1);

        targetCanvas.width = origW * scale;
        targetCanvas.height = origH * scale;

        const ctx = targetCanvas.getContext("2d");
        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        ctx.drawImage(sourceImg, 0, 0, targetCanvas.width, targetCanvas.height);

        const ptr = historyPointers[idx] !== undefined ? historyPointers[idx] : -1;
        let safeState = { rotation: 0, flipH: 1, flipV: 1 };
        if (ptr >= 0 && pageHistory[idx] && pageHistory[idx][ptr]) {
            const histItem = pageHistory[idx][ptr];
            safeState = histItem.state || histItem.edits || { rotation: 0, flipH: 1, flipV: 1 };
        }

        // Apply rotation INSTANTLY (false = no animation)
        if (typeof window.applyGridRotation === 'function') {
            window.applyGridRotation(idx, safeState.rotation, safeState.flipH, safeState.flipV, false);
        }
    }
};

window.rotateGridThumbnail = function (pageIndex) {
    // 1. Get or initialize the state for this specific page
    const ptr = historyPointers[pageIndex] !== undefined ? historyPointers[pageIndex] : -1;
    let safeState = { rotation: 0, flipH: 1, flipV: 1 };

    if (ptr >= 0 && pageHistory[pageIndex] && pageHistory[pageIndex][ptr]) {
        safeState = pageHistory[pageIndex][ptr].state || pageHistory[pageIndex][ptr].edits || safeState;
    } else {
        // If no history exists, rely on global editState or initialize
        safeState.rotation = (typeof editState !== 'undefined') ? (editState.rotation || 0) : 0;
    }

    // 2. Add 90 degrees math
    safeState.rotation = (safeState.rotation + 90) % 360;

    // 3. Instantly spin the Grid Canvas using pure CSS (Zero lag!)
    if (typeof gridView !== 'undefined' && gridView) {
        const gridItem = gridView.children[pageIndex];
        if (gridItem) {
            const canvas = gridItem.querySelector("canvas");
            if (canvas) {
                // FIX: Removed the "scaleFix" math. Let CSS object-fit handle it!
                canvas.style.transition = "transform 0.2s ease";
                canvas.style.transform = `rotate(${safeState.rotation}deg) scale(${safeState.flipH || 1}, ${safeState.flipV || 1})`;

                // Ensure no bad inline styles are applied
                gridItem.style.height = "";
                gridItem.style.aspectRatio = "";
            }
        }
    }

    // 4. Save the state back so Compress/Export knows about it later
    isDirty = true;
    if (typeof pushToHistory === 'function') {
        // Find the base image URL to push to history
        const wrapper = carousel ? carousel.children[pageIndex] : null;
        const img = wrapper ? wrapper.querySelector("img, canvas") : null;
        if (img) {
            pushToHistory(pageIndex, img.src, safeState);
        }
    }

    // Optional: Sync UI buttons if they are active
    if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
};

/* =========================================
   PART A: DOM & INITIALIZATION
   ========================================= */

function initModalDOM() {
    modal = document.querySelector(".image-modal-overlay");
    if (modal) return;

    modal = document.createElement("div");
    modal.className = "image-modal-overlay";

    // Icons
    const iconZoomIn = `<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
    const iconZoomOut = `<svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>`;
    const iconRotateCCW = `<svg viewBox="0 0 24 24"><path d="M7.11 8.53L5.7 7.11C4.8 8.27 4.24 9.61 4.07 11h2.02c.14-.87.49-1.72 1.02-2.47zM6.09 13H4.07c.17 1.39.72 2.73 1.62 3.89l1.41-1.42c-.52-.75-.87-1.59-1.01-2.47zm1.01 5.32c1.16.9 2.51 1.44 3.9 1.61V17.9c-.87-.15-1.71-.49-2.46-1.03L7.1 18.32zM13 4.07V1L8.45 5.55 13 10V6.09c2.84.48 5 2.94 5 5.91s-2.16 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93s-3.05-7.44-7-7.93z"/></svg>`;
    const iconRotateCW = `<svg viewBox="0 0 24 24"><path d="M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42l1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.48z"/></svg>`;
    const iconFlipH = `<svg viewBox="0 0 24 24"><path d="M15 21h2v-2h-2v2zm4-12h2V7h-2v2zM3 5v14c0 1.1.9 2 2 2h4v-2H5V5h4V3H5c-1.1 0-2 .9-2 2zm16-2v2h2c0-1.1-.9-2-2-2zm-8 20h2V1h-2v22zm8-6h2v-2h-2v2zM15 5h2V3h-2v2zm4 8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2z"/></svg>`;
    const iconFlipV = `<svg viewBox="0 0 24 24"><path d="M3 15v2h2v-2H3zm12 4h2v-2h-2v2zm-2 2h2v-2h-2v2zm2-20h-2v2h2V1zM5 21h2v-2H5v2zm4 0h2v-2H9v2zm0-4h2v-2H9v2zM5 3c-1.1 0-2 .9-2 2v4h2V5h14v4h2V5c0-1.1-.9-2-2-2H5zm-2 8h22v2H3v-2zm4-8h2v2H7V3z"/></svg>`;

    modal.innerHTML = `
    <div class="modal-container" style="user-select: none;">
      
      <div class="modal-header-actions">
        <button class="toggle-sidebar-btn" id="toggleSidebarBtn" title="Hide/Show Toolbar">▶</button>
        <div class="save-btn-group">
            <button class="modal-btn" id="btnSaveToGallery">Apply to Original</button>
            <button id="btnSaveDropdownToggle" title="Save Options">▼</button>
            <div class="save-dropdown-menu" id="saveDropdownMenu">
                <div class="save-menu-item" id="btnSaveOriginal">Apply to Original</div>
                <div class="save-menu-item" id="btnSaveCopy">Save as Copy</div>
                <div class="save-menu-item" id="btnSaveAsImage">Save as Image</div> 
            </div>
        </div>
         <button class="modal-close" title="Close">×</button>
      </div>

      <div class="modal-view">
        <button class="nav-btn prev" id="editorPrev" title="Previous page">❮</button>
        <div class="modal-carousel" id="editorCarousel"></div>
        <div id="editorGridView" class="editor-grid-container" style="display: none;"></div>
        <div id="editorToast"></div>
        <button class="nav-btn next" id="editorNext" title="Next page">❯</button>
        
        <div class="editor-bottom-controls" id="pdfControls">
          <div class="modal-filmstrip" id="editorFilmstrip"></div>
          <div class="editor-slider-container">
            <span class="page-counter" id="pageCounter">Page: 1 / 1</span>
            <input type="range" class="page-slider" id="editorSlider" min="0" step="1">
          </div>
          <button class="toggle-controls-btn" id="toggleControlsBtn" title="Hide/Show Bottom bar">▼</button>
        </div>

        <div id="resizeToolbar" style="display: none; position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: #222; padding: 15px 25px; border-radius: 12px; z-index: 100; color: white; gap: 20px; align-items: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
            <div style="display: flex; gap: 10px; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 11px; color: #aaa; text-transform: uppercase;">Width</label>
                    <input type="number" id="resizeW" style="width: 70px; background: #333; border: 1px solid #555; color: white; padding: 6px; border-radius: 4px; text-align: center;">
                </div>
                
                <button id="btnLockRatio" style="background: none; border: none; color: #007bff; cursor: pointer; padding-top: 15px; display: flex; justify-content: center; align-items: center;" title="Lock Aspect Ratio">
                    <svg id="icon-locked" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
                    <svg id="icon-unlocked" style="display: none;" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6H8.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H18c1.1 0 2 .9 2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10zm-6-3c1.1 0 2-.89 2-2s-.9-2-2-2-2 .89-2 2 .9 2 2 2z"/></svg>
                </button>
                
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 11px; color: #aaa; text-transform: uppercase;">Height</label>
                    <input type="number" id="resizeH" style="width: 70px; background: #333; border: 1px solid #555; color: white; padding: 6px; border-radius: 4px; text-align: center;">
                </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 4px; border-left: 1px solid #444; padding-left: 20px;">
                <label style="font-size: 11px; color: #aaa; text-transform: uppercase;">Scale: <span id="resizeScaleValue">100%</span></label>
                <input type="range" id="resizeScale" min="10" max="200" value="100" style="width: 200px; margin-top: 5px;">
            </div>

            <div style="display: flex; gap: 12px; margin-left: 10px;">
                <button id="btnCancelResize" style="background: #dc3545; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: 0.2s;">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
                <button id="btnConfirmResize" style="background: #28a745; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: 0.2s;">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                </button>
            </div>
        </div>

        <div id="compressToolbar" style="display: none; position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: #222; padding: 15px 25px; border-radius: 12px; z-index: 100; color: white; gap: 20px; align-items: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5);">
            <div style="display: flex; flex-direction: column; gap: 4px; padding-right: 20px;">
                <label style="font-size: 11px; color: #aaa; text-transform: uppercase;">JPEG Quality: <span id="compressQualityValue">80%</span></label>
                <input type="range" id="compressQuality" min="10" max="100" value="80" style="width: 200px; margin-top: 5px;">
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 4px; border-left: 1px solid #444; padding-left: 20px;">
                <label style="font-size: 11px; color: #aaa; text-transform: uppercase;">Target Size</label>
                <select id="compressFileSizePreset" style="background: #333; border: 1px solid #555; color: white; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 13px; min-width: 140px;">
                    <option value="auto">Auto (Quality based)</option>
                    <option value="100">~100 KB</option>
                    <option value="200">~200 KB</option>
                    <option value="500">~500 KB</option>
                    <option value="1000">~1 MB</option>
                    <option value="2000">~2 MB</option>
                    <option value="3000">3+ MB</option>
                </select>
            </div>

            <!-- Action Buttons -->
            <div style="display: flex; gap: 10px; margin-left: auto; border-left: 1px solid #444; padding-left: 20px;">
                <button id="btnCancelCompress" style="background: #dc3545; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: 0.2s;">✕</button>
                <button id="btnConfirmCompress" style="background: #28a745; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: 0.2s;">✓</button>
            </div>
        </div>

        <div id="toolInfoBar" class="tool-info-bar" style="display: none;"></div>
        <div id="compressNavContainer" class="tool-nav-bar" style="display: none;">
            <button id="btnCompressPrev" class="tool-nav-btn">◀</button>
            <span id="compressBatchCounter" class="tool-nav-counter">1 / 1</span>
            <button id="btnCompressNext" class="tool-nav-btn">▶</button>
        </div>

      </div>
      
      <div class="modal-sidebar">
        
        <div class="sidebar-spacer"></div>

        <div class="sidebar-tools">
          <div class="mode-toggle-pill" id="modeTogglePill" style="display: none;">
            <button class="mode-btn" id="btnModeGrid">⊞ Grid</button>
            <button class="mode-btn" id="btnModeCarousel">🖼️ Carousel</button>
          </div>
          <div class="sidebar-undo-redo">
            <button class="undo-btn" id="btnUndo" title="Undo" disabled>↩</button>
            <button class="undo-btn" id="btnRedo" title="Redo" disabled>↪</button>
          </div>

          <div class="sidebar-row">
            <button class="modal-btn small-btn" id="btnZoomIn" title="Zoom In">${iconZoomIn}</button>
            <button class="modal-btn small-btn" id="btnZoomOut" title="Zoom Out">${iconZoomOut}</button>
          </div>

          <div class="tool-grid">
            <button class="modal-btn small-btn btn-accent" id="btnRotateCCW" title="Rotate Anti-clockwise">${iconRotateCCW}</button>
            <button class="modal-btn small-btn btn-accent" id="btnRotateCW" title="Rotate Clockwise">${iconRotateCW}</button>
            <button class="modal-btn small-btn btn-accent" id="btnFlipH" title="Flip Horizontal">${iconFlipH}</button>
            <button class="modal-btn small-btn btn-accent" id="btnFlipV" title="Flip Vertical">${iconFlipV}</button>
          </div>

            <button class="modal-btn" id="btnCrop">Crop</button>
            <button class="modal-btn" id="btnResize">Resize</button>
            <button class="modal-btn" id="btnCompress">Compress</button>
        </div>

        <div class="sidebar-spacer"></div>

        <div class="sidebar-footer">
             <div id="editorInfo"></div>
             <button class="export-btn-main" id="exportBtnMain">Export</button>
        </div>
      </div>
    </div>
        <!-- EXPORT DIALOG -->
        <div id="exportDialog" class="export-dialog-overlay" style="display: none;">
            <div class="export-dialog-container">
                <div class="export-dialog-header">
                    <h2>Export Pages</h2>
                    <button class="export-dialog-close" id="exportDialogClose">&times;</button>
                </div>
                
                <div class="export-dialog-content">
                    <!-- Page Selection -->
                    <div class="export-section">
                        <label class="export-label">Pages to Export:</label>
                        <div class="export-page-options">
                            <label class="export-radio">
                                <input type="radio" name="pageRange" value="all" checked>
                                <span>All Pages</span>
                            </label>
                            <label class="export-radio">
                                <input type="radio" name="pageRange" value="current">
                                <span>Current Page Only</span>
                            </label>
                            <label class="export-radio">
                                <input type="radio" name="pageRange" value="selected" id="selectedPagesOption">
                                <span>Selected Pages (<span id="selectedCount">0</span>)</span>
                            </label>
                        </div>
                    </div>

                    <!-- Format Selection -->
                    <div class="export-section">
                        <label class="export-label">Export Format:</label>
                        <div class="export-format-grid">
                            <button class="export-format-btn active" data-format="pdf" title="All pages in one PDF">
                                <div class="format-icon">📄</div>
                                <div class="format-name">PDF</div>
                                <div class="format-desc">All pages in one file</div>
                            </button>
                            
                            <button class="export-format-btn" data-format="png" title="Export as PNG">
                                <div class="format-icon">🖼️</div>
                                <div class="format-name">PNG</div>
                                <div class="format-desc">High quality image</div>
                            </button>
                            
                            <button class="export-format-btn" data-format="jpg" title="Export as JPG">
                                <div class="format-icon">📸</div>
                                <div class="format-name">JPG</div>
                                <div class="format-desc">Smaller file size</div>
                            </button>
                        </div>
                    </div>

                    <!-- File Info -->
                    <div class="export-section export-info">
                        <div id="exportFileInfo">
                            <span id="exportPageCount">Pages: 1</span>
                            <span id="exportEstimatedSize">Est. Size: calculating...</span>
                        </div>
                    </div>

                    <!-- Progress Bar -->
                    <div id="exportProgressContainer" class="export-progress-container" style="display: none;">
                        <div class="export-progress-label">
                            <span id="exportProgressText">Preparing export...</span>
                            <span id="exportProgressPercent">0%</span>
                        </div>
                        <div class="export-progress-bar">
                            <div id="exportProgressFill" class="export-progress-fill"></div>
                        </div>
                    </div>
                </div>

                <div class="export-dialog-footer">
                    <button class="export-btn-cancel" id="exportBtnCancel">Cancel</button>
                    <button class="export-btn-export" id="exportBtnDoExport">Export</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // References
    carousel = modal.querySelector("#editorCarousel");
    filmstrip = modal.querySelector("#editorFilmstrip");

    // Replace btnToggleGrid with these:
    gridView = modal.querySelector("#editorGridView");
    const togglePill = modal.querySelector("#modeTogglePill");
    const btnGrid = modal.querySelector("#btnModeGrid");
    const btnCarousel = modal.querySelector("#btnModeCarousel");

    // ==========================================
    // Helper to handle the Pill UI and View Swapping
    // ==========================================
    window.switchEditorMode = (mode) => {
        currentEditorMode = mode;
        lastPdfPreference = mode;

        const compressNav = document.getElementById("compressNavContainer");
        if (compressNav && mode !== "carousel") {
            compressNav.style.display = "none";
        }

        const bottomControls = document.querySelector(".editor-bottom-controls");
        const fs = document.querySelector(".modal-filmstrip") || (typeof filmstrip !== 'undefined' ? filmstrip : null);

        if (mode === 'grid') {
            if (btnGrid) btnGrid.classList.add("active");
            if (btnCarousel) btnCarousel.classList.remove("active");

            if (carousel) carousel.style.display = "none";

            // FIX: Erase inline JS display. Your CSS grid/flex wrapping will instantly work again!
            if (gridView) {
                gridView.style.display = "";
                // ==========================================
                // FIX 2: Memory-Safe Thumbnail Sync
                // ==========================================
                Array.from(carousel.children).forEach((carouselWrapper, i) => {
                    const gridItem = gridView.children[i];
                    if (!gridItem) return;

                    const sourceImg = carouselWrapper.querySelector("img, canvas");
                    const targetCanvas = gridItem.querySelector("canvas");

                    if (sourceImg && targetCanvas) {
                        // 1. Cap the grid thumbnails to 300px max to save massive amounts of RAM!
                        const MAX_THUMB = 300;
                        const origW = sourceImg.naturalWidth || sourceImg.width;
                        const origH = sourceImg.naturalHeight || sourceImg.height;
                        const scale = Math.min(MAX_THUMB / origW, MAX_THUMB / origH, 1);

                        targetCanvas.width = origW * scale;
                        targetCanvas.height = origH * scale;

                        // 2. Draw the downscaled image
                        const ctx = targetCanvas.getContext("2d");
                        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
                        ctx.drawImage(sourceImg, 0, 0, targetCanvas.width, targetCanvas.height);

                        // ==========================================
                        // 3. Sync rotations and flips (CRASH FIX APPLIED HERE)
                        // ==========================================
                        const ptr = historyPointers[i] !== undefined ? historyPointers[i] : -1;
                        let safeState = { rotation: 0, flipH: 1, flipV: 1 };

                        if (ptr >= 0 && pageHistory[i] && pageHistory[i][ptr]) {
                            const histItem = pageHistory[i][ptr];
                            // Safely grab it whether it was named 'state' or 'edits'
                            safeState = histItem.state || histItem.edits || { rotation: 0, flipH: 1, flipV: 1 };
                        }

                        // Safe transform string
                        targetCanvas.style.transform = `rotate(${safeState.rotation || 0}deg) scaleX(${safeState.flipH || 1}) scaleY(${safeState.flipV || 1})`;
                    }
                });
            }

            // FIX: Use your original CSS class to hide the bottom bar cleanly
            if (bottomControls) bottomControls.classList.add("collapsed");
            if (fs) fs.style.display = "";

            const pPrev = modal.querySelector("#editorPrev");
            const pNext = modal.querySelector("#editorNext");
            const pCtrls = modal.querySelector("#pdfControls");
            if (pPrev) {
                pPrev.style.display = "";  // Clear inline style, let CSS handle it
                pPrev.classList.add("hidden");  // Use class instead
            }
            if (pNext) {
                pNext.style.display = "";
                pNext.classList.add("hidden");
            }
            if (pCtrls) pCtrls.style.display = "none";

        } else {
            if (btnCarousel) btnCarousel.classList.add("active");
            if (btnGrid) btnGrid.classList.remove("active");

            if (gridView) gridView.style.display = "none";
            if (carousel) carousel.style.display = "flex";

            // FIX: Let CSS restore the bottom controls natively
            if (bottomControls) bottomControls.classList.remove("collapsed");
            if (fs) fs.style.display = "";

            const pPrev = modal.querySelector("#editorPrev");
            const pNext = modal.querySelector("#editorNext");
            const pCtrls = modal.querySelector("#pdfControls");

            const pill = modal.querySelector("#modeTogglePill");
            const isPdfMode = pill ? pill.style.display !== "none" : true;

            if (pPrev) {
                pPrev.style.display = "";  // Clear inline style
                pPrev.classList.remove("hidden");  // Remove hidden class
            }
            if (pNext) {
                pNext.style.display = "";
                pNext.classList.remove("hidden");
            }
            if (pCtrls) pCtrls.style.display = isPdfMode ? "flex" : "none";
        }

        if (mode === 'carousel') {
            if (typeof slider !== "undefined" && slider) {
                slider.value = (slider.min === "1") ? activeIndex + 1 : activeIndex;
            }
            scrollToPage(activeIndex, "auto", true);
            if (typeof window.syncPageState === "function") window.syncPageState();
            if (typeof window.updateFilmstrip === "function") window.updateFilmstrip();
            if (typeof updateCarouselUI === "function") updateCarouselUI();
        }

        if (typeof window.updateGridControls === "function") window.updateGridControls();
        if (typeof window.updateNav === "function") window.updateNav(true);
        if (typeof window.updateEditorSaveMenuState === "function") window.updateEditorSaveMenuState();
        if (typeof window.updateSaveButtonState === "function") window.updateSaveButtonState();
    };

    btnGrid.onclick = () => window.switchEditorMode('grid');
    btnCarousel.onclick = () => window.switchEditorMode('carousel');

    slider = modal.querySelector("#editorSlider");
    counter = modal.querySelector("#pageCounter");
    infoBar = modal.querySelector("#editorInfo");
    toolInfoBar = modal.querySelector("#toolInfoBar");

    btnZoomIn = modal.querySelector("#btnZoomIn");
    btnZoomOut = modal.querySelector("#btnZoomOut");
    btnSave = modal.querySelector("#btnSaveToGallery");
    btnUndo = modal.querySelector("#btnUndo");
    btnRedo = modal.querySelector("#btnRedo");

    btnRotateCCW = modal.querySelector("#btnRotateCCW");
    btnRotateCW = modal.querySelector("#btnRotateCW");
    btnFlipH = modal.querySelector("#btnFlipH");
    btnFlipV = modal.querySelector("#btnFlipV");
    btnCrop = modal.querySelector("#btnCrop");
    btnExport = modal.querySelector("#exportBtnMain");

    filmstrip.addEventListener("wheel", (e) => {
        if (e.deltaY !== 0) {
            e.preventDefault();
            filmstrip.scrollLeft += e.deltaY;
        }
    });

    resizeObserver = new ResizeObserver(() => {
        if (carousel.offsetWidth > 0) {
            scrollToPage(activeIndex, "auto", true);
            requestAnimationFrame(() => updateCropBoxOnResize());
        }
    });

    modal.querySelector(".modal-close").onclick = () => {
        // FIX: Now it accurately checks crops, resizes, AND rotations!
        if (typeof window.hasUnsavedEdits === 'function' && window.hasUnsavedEdits()) {
            if (!confirm("You have unsaved changes. Are you sure you want to close?")) {
                return;
            }
        }
        closeEditor();
    };

    // FIXED: Bottom Toggle Logic
    modal.querySelector("#toggleControlsBtn").onclick = (e) => {
        const c = modal.querySelector("#pdfControls");
        c.classList.toggle("collapsed");
        const isColl = c.classList.contains("collapsed");
        e.target.innerHTML = isColl ? "▲" : "▼";
        e.target.classList.toggle("is-collapsed", isColl); // Makes it fly to the corner
    };

    // FIXED: Sidebar Toggle Logic
    modal.querySelector("#toggleSidebarBtn").onclick = (e) => {
        const s = modal.querySelector(".modal-sidebar");
        s.classList.toggle("collapsed");
        const isColl = s.classList.contains("collapsed");
        e.target.innerHTML = isColl ? "◀" : "▶";
        e.target.classList.toggle("is-collapsed", isColl);

        const saveBtnMain = modal.querySelector("#btnSaveToGallery");
        const saveDropdown = modal.querySelector("#btnSaveDropdownToggle");

        if (isColl) {
            if (saveBtnMain) saveBtnMain.style.display = "none";
            if (saveDropdown) saveDropdown.style.display = "none";
        } else {
            if (saveBtnMain) saveBtnMain.style.display = "";
            if (saveDropdown) saveDropdown.style.display = "";
        }

        // ==========================================
        // ADDED: Force the Grid to shrink its width and scrollbar!
        // ==========================================
        const actualGrid = modal.querySelector("#editorGridView");
        if (actualGrid) {
            actualGrid.classList.toggle("sidebar-is-collapsed", isColl);
        }
    };
    if (typeof window.setupResizeTool === "function") window.setupResizeTool();
    if (typeof window.setupCompressTool === "function") window.setupCompressTool();
}

function resetEditorState(isPdf, originalThumb) {
    isDirty = false;
    activeIndex = 0;
    if (typeof window.syncPageState === "function") window.syncPageState();
    saveMode = 'original';
    resetZoomState();

    pageHistory = {};
    historyPointers = {};
    currentPdfDoc = isPdf ? currentPdfDoc : null;
    lastSelectedGridIndex = null;

    editState = { rotation: 0, flipH: 1, flipV: 1 };
    selectedPages.clear();

    isCropMode = false;
    toggleTools(false);
    if (cropOverlay) cropOverlay.remove();

    // FIX: Clear tool-active class in case it was left on
    modal.classList.remove("tool-active");

    carousel.innerHTML = "";
    filmstrip.innerHTML = "";
    if (gridView) gridView.innerHTML = ""; // Clear old grid

    const pdfControls = modal.querySelector("#pdfControls");
    pdfControls.style.display = isPdf ? "flex" : "none";
    /*
    pdfControls.classList.remove("collapsed");
    
    // FIX: Reset Bottom Button
    const toggleControlsBtn = modal.querySelector("#toggleControlsBtn");
    toggleControlsBtn.classList.remove("is-collapsed");
    toggleControlsBtn.innerHTML = "▼";
  
    const sidebar = modal.querySelector(".modal-sidebar");
    sidebar.classList.remove("collapsed");
    
    // FIX: Reset Sidebar Button
    const toggleSidebarBtn = modal.querySelector("#toggleSidebarBtn");
    toggleSidebarBtn.classList.remove("is-collapsed");
    toggleSidebarBtn.innerHTML = "▶";
    */
    infoBar.style.display = "block";
    updateEditorInfo();

    // ADDED: Smart Mode Initialization
    if (isPdf) {
        modal.querySelector("#modeTogglePill").style.display = "flex";
        window.switchEditorMode(lastPdfPreference); // Instantly sets the pill and view!
    } else {
        modal.querySelector("#modeTogglePill").style.display = "none";
        window.switchEditorMode('carousel');
    }

    updateSaveButtonState();
    modal.dataset.originId = currentSessionMode === 'image-batch' ? "" : (originalThumb ? originalThumb.dataset.id : "");
}

window.updateSaveButtonState = () => {
    const btnSaveMain = document.getElementById("btnSaveToGallery");
    const btnSaveDrop = document.getElementById("btnSaveDropdownToggle");
    if (!btnSaveMain) return;

    let hasRealChanges = false;

    const keys = Object.keys(historyPointers);
    for (let k of keys) {
        const ptr = historyPointers[k];
        if (ptr > 0 && pageHistory[k] && pageHistory[k][ptr]) {
            const histItem = pageHistory[k][ptr];
            const state = histItem.state || histItem.edits || { rotation: 0, flipH: 1, flipV: 1 };

            // Safe parse and normalize
            const rot = Number(state.rotation) || 0;
            const normRot = ((rot % 360) + 360) % 360;
            const fh = Number(state.flipH) || 1;
            const fv = Number(state.flipV) || 1;

            // If any page visually deviates from the default, flag it!
            if (normRot !== 0 || fh !== 1 || fv !== 1) {
                hasRealChanges = true;
                break;
            }
        }
    }

    // Standard crop checks
    if (isDirty) hasRealChanges = true;

    // FIX 1: Allow Copy and Image modes to be clickable even without edits!
    if (hasRealChanges || saveMode === 'extract_image' || saveMode === 'copy') {
        btnSaveMain.disabled = false;
        btnSaveMain.style.opacity = "1";
        btnSaveMain.style.pointerEvents = "auto";
    } else {
        btnSaveMain.disabled = true;
        btnSaveMain.style.opacity = "0.5";
        btnSaveMain.style.pointerEvents = "none";
    }

    // FIX 2: NEVER disable the dropdown arrow! It must always be clickable.
    if (btnSaveDrop) {
        btnSaveDrop.disabled = false;
        btnSaveDrop.style.opacity = "1";
        btnSaveDrop.style.pointerEvents = "auto";
    }
};

window.updateFilmstrip = () => {
    // Re-query directly from the document to guarantee we find it
    const actualFilmstrip = document.querySelector(".modal-filmstrip");
    if (!actualFilmstrip) return;

    // Find all the wrappers based strictly on your CSS
    const wrappers = actualFilmstrip.querySelectorAll(".film-thumb-wrapper");

    wrappers.forEach((wrapper, index) => {
        // Find the image or canvas inside
        const img = wrapper.querySelector(".film-thumb, img, canvas");
        if (!img) return;

        if (index === activeIndex) {
            img.classList.add("active"); // Your CSS takes over here!
            setTimeout(() => {
                wrapper.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
            }, 10);
        } else {
            img.classList.remove("active");
        }
    });
};

function markDirty() {
    if (!isDirty) {
        isDirty = true;
        updateSaveButtonState();
    }
}

function clampZoom(value) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function resetZoomState() {
    currentZoom = MIN_ZOOM;
    panX = 0;
    panY = 0;
}

function setZoomState(value) {
    currentZoom = clampZoom(value);
    if (currentZoom <= MIN_ZOOM + 0.001) {
        resetZoomState();
    }
}

function adjustZoom(delta) {
    setZoomState(currentZoom + delta);
    applyTransform();
}

function clearToolViewportState(wrapper) {
    if (!wrapper) return;
    wrapper.style.removeProperty('padding');
    wrapper.style.removeProperty('box-sizing');
    wrapper.style.removeProperty('height');
    wrapper.style.removeProperty('max-height');
    wrapper.style.removeProperty('overflow');
    delete wrapper.dataset.toolZoomPadding;
    delete wrapper.dataset.toolZoomBoxSizing;
    delete wrapper.dataset.toolZoomHeight;
    delete wrapper.dataset.toolZoomMaxHeight;
    delete wrapper.dataset.toolZoomOverflow;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isResizeToolVisible() {
    const toolbar = document.getElementById("resizeToolbar");
    return Boolean(toolbar && toolbar.style.display !== "none");
}

function isCompressToolVisible() {
    const compressToolbar = document.getElementById("compressToolbar");
    return Boolean(compressToolbar && compressToolbar.style.display !== "none");
}

function isCompressNavVisible() {
    const compressNav = document.getElementById("compressNavContainer");
    return Boolean(compressNav && compressNav.style.display !== "none");
}

let editorInfoUpdateToken = 0;
let toolInfoUpdateToken = 0;

function getEditorInfoPageIndices() {
    if (totalPages <= 1) return [];
    return Array.from(selectedPages).sort((a, b) => a - b);
}

async function updateEditorInfo() {
    if (!infoBar) return;

    const pageIndices = getEditorInfoPageIndices();
    ++editorInfoUpdateToken;

    if (totalPages <= 1) {
        infoBar.style.display = "none";
    } else {
        infoBar.style.display = "block";
        infoBar.innerHTML = `<div class="editor-info-line">Selected pages: ${pageIndices.length}/${totalPages}</div>`;
    }

    await updateToolInfo();
}

function canvasToBlobPromise(canvas, mimeType = "image/png", quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("Canvas export failed"));
        }, mimeType, quality);
    });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

async function estimateCanvasBytes(canvas, mimeType = "image/png", quality = 1) {
    const normalizedQuality = mimeType === "image/png" ? 1 : Math.max(0.1, Math.min(1, quality || 0.85));

    try {
        const { estimatedBytes } = await processingClient.estimateImageBytes({
            width: canvas.width || 1,
            height: canvas.height || 1,
            quality: normalizedQuality,
            mimeType
        });

        const multiplier = mimeType === "image/png" ? 1.35 : 1;
        return Math.max(1, Math.round(estimatedBytes * multiplier));
    } catch {
        const blob = await canvasToBlobPromise(canvas, mimeType, normalizedQuality);
        return blob.size;
    }
}

async function buildPdfBlobFromCanvasList(canvases) {
    if (!canvases.length) return new Blob([], { type: "application/pdf" });

    const pdfDoc = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4"
    });

    for (let i = 0; i < canvases.length; i++) {
        const canvas = canvases[i];
        const imgData = canvas.toDataURL("image/jpeg", 0.9);
        const pdfWidth = pdfDoc.internal.pageSize.getWidth();
        const pdfHeight = pdfDoc.internal.pageSize.getHeight();
        const ratio = Math.min(pdfWidth / canvas.width, pdfHeight / canvas.height);
        const width = canvas.width * ratio;
        const height = canvas.height * ratio;
        const x = (pdfWidth - width) / 2;
        const y = (pdfHeight - height) / 2;

        if (i > 0) pdfDoc.addPage();
        pdfDoc.addImage(imgData, "JPEG", x, y, width, height);
    }

    return pdfDoc.output("blob");
}

async function getLiveToolPreviewEstimatedBytes() {
    const wrapper = carousel.children[activeIndex];
    if (!wrapper) throw new Error("Missing active tool page");

    const media = wrapper.querySelector("img, canvas");
    if (!media) throw new Error("Missing active tool media");

    if (isResizeToolVisible()) {
        const resizeWidthInput = document.getElementById("resizeW");
        const resizeHeightInput = document.getElementById("resizeH");
        const targetW = Math.max(parseInt(resizeWidthInput?.value, 10) || media.naturalWidth || media.width || 1, 1);
        const targetH = Math.max(parseInt(resizeHeightInput?.value, 10) || media.naturalHeight || media.height || 1, 1);
        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(media, 0, 0, targetW, targetH);
        return await estimateCanvasBytes(canvas, "image/png", 1);
    }

    if (isCompressToolVisible()) {
        const width = media.naturalWidth || media.width || 1;
        const height = media.naturalHeight || media.height || 1;
        const quality = Math.max(0.1, Math.min(1, (parseInt(document.getElementById("compressQuality")?.value, 10) || 80) / 100));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(media, 0, 0, width, height);
        return await estimateCanvasBytes(canvas, "image/jpeg", quality);
    }

    throw new Error("Tool preview unavailable");
}

async function updateToolInfo() {
    if (!toolInfoBar) return;

    const toolVisible = isResizeToolVisible() || isCompressToolVisible();
    if (!toolVisible) {
        toolInfoBar.style.display = "none";
        toolInfoBar.textContent = "";
        toolInfoBar.classList.remove("with-nav");
        return;
    }

    const token = ++toolInfoUpdateToken;
    toolInfoBar.style.display = "block";
    toolInfoBar.classList.toggle("with-nav", isCompressNavVisible());
    toolInfoBar.textContent = "Size: calculating...";

    try {
        const estimatedBytes = await getLiveToolPreviewEstimatedBytes();
        if (token !== toolInfoUpdateToken || !toolInfoBar) return;
        toolInfoBar.textContent = `Size: ${formatBytes(estimatedBytes)}`;
    } catch {
        if (token !== toolInfoUpdateToken || !toolInfoBar) return;
        toolInfoBar.textContent = "Size: unavailable";
    }
}

async function applyAdvancedCompression(canvas, quality) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const paletteSize = Math.max(8, Math.min(96, Math.round(8 + (quality * 88))));

    try {
        const { pixels } = await processingClient.quantizeAndDither({
            pixels: imageData.data,
            width: canvas.width,
            height: canvas.height,
            paletteSize
        });

        const quantizedPixels = pixels instanceof Uint8ClampedArray ? pixels : new Uint8ClampedArray(pixels);
        const quantizedImage = new ImageData(quantizedPixels, canvas.width, canvas.height);
        ctx.putImageData(quantizedImage, 0, 0);
    } catch (error) {
        console.warn("Worker-based advanced compression skipped:", error);
    }

    return canvas;
}

/* =========================================
   TRANSFORMS (Smart View-Relative)
   ========================================= */

function getEffectiveRotation() {
    let r = editState.rotation % 360;
    if (r < 0) r += 360;
    return r;
}

window.applyGridRotation = function (pageIdx, rot, flipH, flipV, animate = true) {
    if (typeof gridView === 'undefined' || !gridView) return;
    const gridItem = gridView.children[pageIdx];
    if (!gridItem) return;

    const canvas = gridItem.querySelector("canvas");
    if (!canvas) return;

    const rotation = Number(rot) || 0;

    if (animate) {
        canvas.style.transition = "transform 0.2s ease";
    } else {
        canvas.style.transition = "none";
    }

    // FIX: Pure, simple transform. No math, no margins, no manual scaling!
    canvas.style.transform = `rotate(${rotation}deg) scale(${flipH || 1}, ${flipV || 1})`;

    // FIX: Clean up any old inline styles that might be lingering from previous runs
    gridItem.style.height = "";
    gridItem.style.aspectRatio = "";
    canvas.style.marginBottom = "";
};

function setupTransformControls() {
    const updateTransform = (action) => {
        const applyAction = (state, act) => {
            state.rotation = Number(state.rotation) || 0;
            state.flipH = Number(state.flipH) || 1;
            state.flipV = Number(state.flipV) || 1;

            if (act === 'ccw') state.rotation -= 90;
            if (act === 'cw') state.rotation += 90;
            if (act === 'flipH') {
                const r = ((state.rotation % 360) + 360) % 360;
                if (r === 90 || r === 270) state.flipV *= -1;
                else state.flipH *= -1;
            }
            if (act === 'flipV') {
                const r = ((state.rotation % 360) + 360) % 360;
                if (r === 90 || r === 270) state.flipH *= -1;
                else state.flipV *= -1;
            }
        };

        if (currentEditorMode === 'grid' && selectedPages.size > 0) {
            const originalActive = activeIndex;
            const pagesToEdit = Array.from(selectedPages);

            pagesToEdit.forEach(pageIdx => {
                try {
                    let currentState = { rotation: 0, flipH: 1, flipV: 1 };
                    const ptr = historyPointers[pageIdx] !== undefined ? historyPointers[pageIdx] : -1;

                    if (ptr >= 0 && pageHistory[pageIdx] && pageHistory[pageIdx][ptr]) {
                        currentState = { ...pageHistory[pageIdx][ptr].state };
                    }

                    applyAction(currentState, action);

                    let safeSrc = "";
                    if (ptr >= 0 && pageHistory[pageIdx] && pageHistory[pageIdx][ptr]) {
                        safeSrc = pageHistory[pageIdx][ptr].src;
                    }
                    if (typeof pushToHistory === 'function') pushToHistory(pageIdx, safeSrc, currentState);

                    // ==========================================
                    // FAST CSS ROTATION (True = Animate smooth)
                    // ==========================================
                    if (typeof window.applyGridRotation === 'function') {
                        window.applyGridRotation(pageIdx, currentState.rotation, currentState.flipH, currentState.flipV, true);
                    }
                } catch (err) {
                    console.error("Safely skipped an error on page", pageIdx, err);
                }
            });

            // Restore Main Viewer UI variable state so it matches
            const finalPtr = historyPointers[originalActive] !== undefined ? historyPointers[originalActive] : -1;
            if (finalPtr >= 0 && pageHistory[originalActive] && pageHistory[originalActive][finalPtr]) {
                editState = { ...pageHistory[originalActive][finalPtr].state };
            } else {
                editState = { rotation: 0, flipH: 1, flipV: 1 };
            }

            isDirty = true;
            if (typeof window.updateSaveButtonState === "function") window.updateSaveButtonState();

            return; // STOP! No heavy re-renders in Grid Mode!

        } else {
            // ==========================================
            // NORMAL CAROUSEL MODE (Remains untouched)
            // ==========================================
            applyAction(editState, action);
            if (typeof window.applyTransform === 'function') window.applyTransform();

            let fallbackSrc = "";
            const pageWrapper = carousel.children[activeIndex];
            if (pageWrapper) {
                const imgEl = pageWrapper.querySelector('img');
                if (imgEl && imgEl.src) fallbackSrc = imgEl.src;
            }

            const ptr = historyPointers[activeIndex] !== undefined ? historyPointers[activeIndex] : -1;
            const safeSrc = (ptr >= 0 && pageHistory[activeIndex] && pageHistory[activeIndex][ptr]) ? pageHistory[activeIndex][ptr].src : fallbackSrc;

            if (typeof pushToHistory === 'function') pushToHistory(activeIndex, safeSrc, editState);
        }

        if (typeof window.updateSaveButtonState === "function") window.updateSaveButtonState();
        if (typeof window.syncAllViews === 'function') window.syncAllViews();
    };

    if (btnRotateCCW) btnRotateCCW.onclick = () => updateTransform('ccw');
    if (btnRotateCW) btnRotateCW.onclick = () => updateTransform('cw');
    if (btnFlipH) btnFlipH.onclick = () => updateTransform('flipH');
    if (btnFlipV) btnFlipV.onclick = () => updateTransform('flipV');
}

window.applyTransform = function applyTransform() {
    // ==========================================
    // 1. UPDATE GRID THUMBNAILS (Forced DOM Paint)
    // ==========================================
    if (gridView) {
        const gridItem = gridView.querySelector(`.editor-grid-item[data-index="${activeIndex}"]`);
        if (gridItem) {
            const thumbCanvas = gridItem.querySelector(`canvas`);
            if (thumbCanvas) {
                // NaN Guards: Guarantee valid math
                const rot = Number(editState.rotation) || 0;
                const fH = Number(editState.flipH) || 1;
                const fV = Number(editState.flipV) || 1;

                const isSideways = rot % 180 !== 0;
                const scaleFix = isSideways ? 0.75 : 1;

                // FIX: Use direct property assignment instead of cssText +=
                thumbCanvas.style.display = "block";
                thumbCanvas.style.margin = "0 auto";
                thumbCanvas.style.transition = "transform 0.2s ease";
                thumbCanvas.style.transform = `rotate(${rot}deg) scale(${fH * scaleFix}, ${fV * scaleFix})`;
            }
        }
    }

    // ==========================================
    // 2. UPDATE CAROUSEL VIEWER
    // ==========================================
    const pageWrapper = carousel.children[activeIndex];
    if (!pageWrapper) return;

    const img = pageWrapper.querySelector("img") || pageWrapper.querySelector("canvas");
    if (!img) return;

    let rotScale = 1;
    const rot = Number(editState.rotation) || 0;
    const r = ((rot % 360) + 360) % 360;

    if (r === 90 || r === 270) {
        const wrapperW = pageWrapper.clientWidth;
        const wrapperH = pageWrapper.clientHeight;
        const imgW = img.clientWidth || img.width;
        const imgH = img.clientHeight || img.height;

        if (imgW > 0 && imgH > 0) {
            const scaleX = wrapperW / imgH;
            const scaleY = wrapperH / imgW;
            rotScale = Math.min(1, scaleX, scaleY);
        }
    }

    // FIX: Use style.transform directly instead of cssText +=
    img.style.transform = `translate(${panX}px, ${panY}px) rotate(${rot}deg) scale(${currentZoom * (Number(editState.flipH) || 1) * rotScale}, ${currentZoom * (Number(editState.flipV) || 1) * rotScale})`;
};

/* =========================================
   HISTORY & UNDO/REDO
   ========================================= */

function pushToHistory(pageIndex, src, state) {
    // 1. If this page has no history yet, create it AND save the original unedited state!
    if (!pageHistory[pageIndex]) {
        pageHistory[pageIndex] = [];
        historyPointers[pageIndex] = -1;

        // Push Baseline (Step 0)
        pageHistory[pageIndex].push({
            src: src,
            state: { rotation: 0, flipH: 1, flipV: 1 }
        });
        historyPointers[pageIndex]++;
    }

    // 2. Erase the "future" redo history if we undid and are now making a new change
    let ptr = historyPointers[pageIndex];
    if (ptr < pageHistory[pageIndex].length - 1) {
        pageHistory[pageIndex] = pageHistory[pageIndex].slice(0, ptr + 1);
    }

    // 3. Push the NEW edit (Step 1, 2, etc.)
    pageHistory[pageIndex].push({ src, state: { ...state } });
    historyPointers[pageIndex]++;

    // 4. Light up the Undo buttons instantly
    if (typeof window.updateUndoRedoUI === "function") window.updateUndoRedoUI();
    updateEditorInfo();
}

function initPageHistory(index, initialSrc) {
    if (!pageHistory[index]) {
        pageHistory[index] = [{
            src: initialSrc,
            edits: { rotation: 0, flipH: 1, flipV: 1 }
        }];
        historyPointers[index] = 0;
        updateUndoRedoUI();
        updateEditorInfo();
    }
}

function setupHistoryControls() {
    // ==========================================
    // UNIVERSAL UNDO
    // ==========================================
    btnUndo.onclick = () => {
        let affectedCount = 0;

        if (currentEditorMode === 'grid' && selectedPages.size > 0) {
            const originalActive = activeIndex;

            selectedPages.forEach(pageIdx => {
                if (historyPointers[pageIdx] > 0) {
                    activeIndex = pageIdx;
                    if (typeof window.syncPageState === "function") window.syncPageState();
                    historyPointers[activeIndex]--;

                    // Load and apply this page's previous state
                    const prevState = pageHistory[activeIndex][historyPointers[activeIndex]];
                    editState = { ...prevState.state };
                    applyTransform();
                    affectedCount++;
                }
            });

            // Restore correct state for the main viewer!
            activeIndex = originalActive;
            if (typeof window.syncPageState === "function") window.syncPageState();
            const ptr = historyPointers[activeIndex] || 0;
            if (pageHistory[activeIndex] && pageHistory[activeIndex][ptr]) {
                const snapshot = pageHistory[activeIndex][ptr];
                editState = { ...(snapshot.state || snapshot.edits || { rotation: 0, flipH: 1, flipV: 1 }) };
            }

            if (affectedCount > 0) window.showEditorToast(`Undid action on ${affectedCount} pages`);

        } else {
            // Normal Single Undo
            if (historyPointers[activeIndex] > 0) {
                historyPointers[activeIndex]--;
                const prevState = pageHistory[activeIndex][historyPointers[activeIndex]];
                editState = { ...prevState.state };
                applyTransform();
                window.showEditorToast(`Undid action`);
            }
        }

        updateSaveButtonState();
        if (typeof updateUndoRedoUI === "function") updateUndoRedoUI();
        updateEditorInfo();
    };

    // ==========================================
    // UNIVERSAL REDO
    // ==========================================
    btnRedo.onclick = () => {
        let affectedCount = 0;

        if (currentEditorMode === 'grid' && selectedPages.size > 0) {
            const originalActive = activeIndex;

            selectedPages.forEach(pageIdx => {
                const history = pageHistory[pageIdx] || [];
                const ptr = historyPointers[pageIdx] || 0;

                // Can we go forward?
                if (ptr < history.length - 1) {
                    activeIndex = pageIdx;
                    if (typeof window.syncPageState === "function") window.syncPageState();
                    historyPointers[activeIndex]++;

                    // Load and apply this page's future state
                    const nextState = pageHistory[activeIndex][historyPointers[activeIndex]];
                    editState = { ...nextState.state };
                    applyTransform();
                    affectedCount++;
                }
            });

            // Restore correct state for the main viewer!
            activeIndex = originalActive;
            if (typeof window.syncPageState === "function") window.syncPageState();
            const finalPtr = historyPointers[activeIndex] || 0;
            if (pageHistory[activeIndex] && pageHistory[activeIndex][finalPtr]) {
                editState = { ...pageHistory[activeIndex][finalPtr].state };
            }

            if (affectedCount > 0) window.showEditorToast(`Redid action on ${affectedCount} pages`);

        } else {
            // Normal Single Redo
            const history = pageHistory[activeIndex] || [];
            const ptr = historyPointers[activeIndex] || 0;

            if (ptr < history.length - 1) {
                historyPointers[activeIndex]++;
                const nextState = pageHistory[activeIndex][historyPointers[activeIndex]];
                editState = { ...nextState.state };
                applyTransform();
                window.showEditorToast(`Redid action`);
            }
        }

        updateSaveButtonState();
        if (typeof updateUndoRedoUI === "function") updateUndoRedoUI();
        updateEditorInfo();
    };
}

window.updateUndoRedoUI = () => {
    if (!btnUndo || !btnRedo) return;

    let canUndo = false;
    let canRedo = false;

    // 1. Grid Mode Logic
    if (currentEditorMode === 'grid') {
        if (selectedPages.size === 0) {
            // Lock them completely if nothing is selected in grid mode!
            btnUndo.disabled = true;
            btnRedo.disabled = true;
            return;
        }

        // If pages are selected, check if ANY of them have history to undo/redo
        selectedPages.forEach(pageIdx => {
            const ptr = historyPointers[pageIdx] || 0;
            const hist = pageHistory[pageIdx] || [];
            if (ptr > 0) canUndo = true;
            if (ptr < hist.length - 1) canRedo = true;
        });
    }
    // 2. Carousel Mode Logic
    else {
        const ptr = historyPointers[activeIndex] || 0;
        const hist = pageHistory[activeIndex] || [];
        if (ptr > 0) canUndo = true;
        if (ptr < hist.length - 1) canRedo = true;
    }

    // Apply the locked/unlocked state
    btnUndo.disabled = !canUndo;
    btnRedo.disabled = !canRedo;
};

function loadHistoryState(index) {
    const stack = pageHistory[index];
    const ptr = historyPointers[index];
    const data = stack[ptr];

    if (data) {
        editState = { ...(data.state || data.edits || { rotation: 0, flipH: 1, flipV: 1 }) };
        const pageWrapper = carousel.children[index];

        // Safely update either Image or PDF Canvas
        const img = pageWrapper.querySelector("img");
        if (img) img.src = data.src;

        applyTransform();
        if (typeof updateUndoRedoUI === "function") updateUndoRedoUI();

        // ==========================================
        // FIX 2: Give the browser 10ms to catch its breath!
        // This guarantees the DOM and Memory are fully synced before checking the math.
        // ==========================================
        setTimeout(() => {
            updateSaveButtonState();
        }, 10);
    }
}

/* =========================================
   CROP TOOL LOGIC
   ========================================= */

function setupCropTool() {
    btnCrop.onclick = async () => {
        const compressNav = document.getElementById("compressNavContainer");
        if (compressNav) compressNav.style.display = "none";
        // 1. RECORD WHERE THEY CAME FROM!
        window.modeBeforeTool = currentEditorMode;

        // Auto-jump to Carousel if in Grid Mode
        if (currentEditorMode === 'grid') {
            if (selectedPages.size > 0) activeIndex = Array.from(selectedPages)[0];
            window.switchEditorMode('carousel');
        }

        if (typeof modal !== 'undefined' && modal) {
            modal.classList.add('is-cropping');
            modal.classList.add('tool-active'); // Required to trigger CSS!
        }

        if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(false);
        if (typeof window.updateNav === 'function') window.updateNav(false);

        const modalView = document.querySelector(".modal-view");
        if (modalView) {
            modalView.style.transition = 'none';
            modalView.style.opacity = '0';
        }

        resetZoomState();
        if (typeof window.applyTransform === 'function') window.applyTransform();

        // ==========================================
        // FIX: The Smart Waiter (Solves Wrong Page & Overflow!)
        // ==========================================
        const applyCropPaddingWhenReady = () => {
            const activeWrapper = carousel.children[activeIndex];

            // Wait until the element exists AND the browser has painted its width!
            if (!activeWrapper || carousel.offsetWidth === 0) {
                setTimeout(applyCropPaddingWhenReady, 20);
                return;
            }

            // 1. Unbreakable Boundary Constraints (Fixes Overflow)
            activeWrapper.style.setProperty('padding', '40px 40px 100px 40px', 'important');
            activeWrapper.style.setProperty('box-sizing', 'border-box', 'important');
            activeWrapper.style.setProperty('height', '100%', 'important');
            activeWrapper.style.setProperty('max-height', '100%', 'important');
            activeWrapper.style.setProperty('overflow', 'hidden', 'important');

            // 2. Now that width is > 0, scroll to the correct page!
            if (typeof scrollToPage === 'function') scrollToPage(activeIndex);

            // 3. Start the crop overlay
            if (!isCropMode && typeof enableCropMode === 'function') enableCropMode();

            // 4. Fade smoothly back in
            if (modalView) {
                modalView.style.transition = 'opacity 0.2s ease';
                modalView.style.opacity = '1';
            }
        };

        applyCropPaddingWhenReady(); // Start the loop!
    };
}

async function enableCropMode() {
    isCropMode = true;
    modal.classList.add("tool-active");

    const pageWrapper = carousel.children[activeIndex];
    const img = pageWrapper.querySelector("img");

    // 1. LOCK UI
    toggleTools(true);


    // 2. Bake Transforms
    const bakedUrl = await bakeTransforms(img, editState);
    img.onload = () => {
        editState = { rotation: 0, flipH: 1, flipV: 1 };
        resetZoomState();
        applyTransform();

        createCropOverlay(pageWrapper, img);
        img.onload = null;
    };
    img.src = bakedUrl;
}

function disableCropMode(wasCanceled = false) {
    window.toggleBottomControls(true);
    isCropMode = false;
    if (cropOverlay) cropOverlay.remove();

    if (wasCanceled) {
        loadHistoryState(activeIndex);
    }

    toggleTools(false);
    if (typeof modal !== 'undefined' && modal) {
        modal.classList.remove("tool-active", "is-cropping");
    }

    // 2. RETURN THEM TO GRID IF THEY STARTED THERE!
    if (window.modeBeforeTool === 'grid') {
        window.switchEditorMode('grid');
    }
}


function createCropOverlay(wrapper, img) {
    if (wrapper.querySelector(".crop-container")) wrapper.querySelector(".crop-container").remove();
    if (wrapper.querySelector(".crop-actions")) wrapper.querySelector(".crop-actions").remove();

    const overlay = document.createElement("div");
    overlay.className = "crop-container";
    overlay.style.display = "block";

    // Start exactly at image dimensions (Full Coverage)
    const imgRect = img.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    overlay.style.width = imgRect.width + "px";
    overlay.style.height = imgRect.height + "px";

    // Calculates exact position by finding the difference between the wrapper and the image
    overlay.style.left = (imgRect.left - wrapperRect.left) + "px";
    overlay.style.top = (imgRect.top - wrapperRect.top) + "px";

    // Initialize Percentages (for resize tracking)
    overlay.dataset.pctX = 0;
    overlay.dataset.pctY = 0;
    overlay.dataset.pctW = 1;
    overlay.dataset.pctH = 1;

    overlay.innerHTML = `
        <div class="crop-grid-v" style="left:33%"></div>
        <div class="crop-grid-v" style="left:66%"></div>
        <div class="crop-grid-h" style="top:33%"></div>
        <div class="crop-grid-h" style="top:66%"></div>
        <div class="crop-handle handle-nw" data-dir="nw"></div>
        <div class="crop-handle handle-ne" data-dir="ne"></div>
        <div class="crop-handle handle-sw" data-dir="sw"></div>
        <div class="crop-handle handle-se" data-dir="se"></div>
        <div class="crop-handle handle-n" data-dir="n"></div>
        <div class="crop-handle handle-s" data-dir="s"></div>
        <div class="crop-handle handle-w" data-dir="w"></div>
        <div class="crop-handle handle-e" data-dir="e"></div>
    `;

    wrapper.appendChild(overlay);
    cropOverlay = overlay;

    // --- Button Creation ---
    const actions = document.createElement("div");
    actions.style.cssText = "position: fixed !important; bottom: 20px !important; left: 50% !important; transform: translateX(-50%) !important; display: flex !important; gap: 15px !important; z-index: 10000 !important; background: rgba(0,0,0,0.8) !important; padding: 10px 20px !important; border-radius: 40px !important; flex-direction: row !important; width: auto !important;";
    actions.className = "crop-actions visible";

    actions.innerHTML = `
        <button class="btn-cancel" title="Cancel">✖</button>
        <button class="btn-apply" title="Confirm">✔</button>
    `;

    const modalView = document.querySelector(".modal-view") || wrapper;
    modalView.appendChild(actions);

    actions.querySelector(".btn-apply").onclick = (e) => {
        e.stopPropagation();
        const pctW = parseFloat(overlay.dataset.pctW) || 1;
        const pctH = parseFloat(overlay.dataset.pctH) || 1;

        if (pctW >= 0.99 && pctH >= 0.99) {
            actions.querySelector(".btn-cancel").onclick(e);
            return;
        }

        // 1. INSTANTLY HIDE THE EXIT SHIFT
        const modalView = document.querySelector(".modal-view") || wrapper;
        if (modalView) {
            modalView.style.transition = 'none';
            modalView.style.opacity = '0';
        }

        // 2. DO HEAVY CANVAS CROP AND CLEANUP IN THE DARK
        setTimeout(async () => {
            await performCrop(overlay, img);

            isDirty = true;
            if (typeof pushToHistory === 'function') pushToHistory(activeIndex, img.src, editState);
            if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
            if (typeof window.syncAllViews === 'function') window.syncAllViews();

            actions.remove();
            if (typeof modal !== 'undefined' && modal) {
                modal.classList.remove('is-cropping');
                modal.classList.remove('tool-active');
            }

            // RESTORE CSS PADDING
            const activeWrapper = carousel.children[activeIndex];
            if (activeWrapper) {
                activeWrapper.style.removeProperty('padding');
                activeWrapper.style.removeProperty('box-sizing');
                activeWrapper.style.removeProperty('height');
                activeWrapper.style.removeProperty('max-height');
                activeWrapper.style.removeProperty('overflow');
            }

            if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(true);
            if (typeof window.updateNav === 'function') window.updateNav(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);

            // Generate the thumbnail while the carousel is still physically rendered
            if (typeof window.updateGridThumbnail === 'function') window.updateGridThumbnail(activeIndex);

            // 3. WAIT FOR BROWSER TO SETTLE, THEN SWITCH MODES!
            setTimeout(() => {
                if (window.modeBeforeTool === 'grid') window.switchEditorMode('grid');

                if (modalView) {
                    modalView.style.transition = 'opacity 0.2s ease';
                    modalView.style.opacity = '1';
                }
            }, 50);

        }, 50);
    };

    actions.querySelector(".btn-cancel").onclick = (e) => {
        e.stopPropagation();

        // 1. INSTANTLY HIDE THE EXIT SHIFT
        const modalView = document.querySelector(".modal-view") || wrapper;
        if (modalView) {
            modalView.style.transition = 'none';
            modalView.style.opacity = '0';
        }

        // 2. DO CLEANUP IN THE DARK
        setTimeout(() => {
            if (typeof disableCropMode === 'function') disableCropMode(true);
            actions.remove();

            if (typeof modal !== 'undefined' && modal) {
                modal.classList.remove('is-cropping');
                modal.classList.remove('tool-active');
            }

            // RESTORE CSS PADDING
            const activeWrapper = carousel.children[activeIndex];
            if (activeWrapper) {
                activeWrapper.style.removeProperty('padding');
                activeWrapper.style.removeProperty('box-sizing');
                activeWrapper.style.removeProperty('height');
                activeWrapper.style.removeProperty('max-height');
                activeWrapper.style.removeProperty('overflow');
            }

            if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(true);
            if (typeof window.updateNav === 'function') window.updateNav(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);
            if (typeof window.updateGridThumbnail === 'function') window.updateGridThumbnail(activeIndex);

            // 3. WAIT FOR BROWSER LAYOUT TO SETTLE, THEN SWITCH MODES!
            setTimeout(() => {
                if (window.modeBeforeTool === 'grid') window.switchEditorMode('grid');

                if (modalView) {
                    modalView.style.transition = 'opacity 0.2s ease';
                    modalView.style.opacity = '1';
                }
            }, 50);

        }, 50);
    };

    setupCropDrag(overlay, img, actions);
}

function setupCropDrag(overlay, img, actionsBar) {
    let startX, startY, startLeft, startTop, startW, startH;
    let draggingHandle = null;
    let isMovingBox = false;
    let hasInteracted = false;

    // Declare boundary variables outside so they can update dynamically
    let maxW, maxH, imgLeft, imgTop;

    overlay.onmousedown = (e) => {
        e.stopPropagation();
        const handle = e.target.closest(".crop-handle");

        startX = e.clientX;
        startY = e.clientY;
        startLeft = overlay.offsetLeft;
        startTop = overlay.offsetTop;
        startW = overlay.offsetWidth;
        startH = overlay.offsetHeight;

        // BUG FIX: Fetch current dimensions strictly on mousedown
        // This ensures resizing the window doesn't break boundaries
        maxW = img.clientWidth;
        maxH = img.clientHeight;
        imgLeft = img.offsetLeft;
        imgTop = img.offsetTop;

        if (handle) {
            draggingHandle = handle.dataset.dir;
        } else {
            isMovingBox = true;
        }

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };

    function onMove(e) {
        e.preventDefault();

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newW = startW, newH = startH, newL = startLeft, newT = startTop;

        if (isMovingBox) {
            newL = startLeft + dx;
            newT = startTop + dy;
        } else {
            if (draggingHandle.includes("e")) newW = startW + dx;
            if (draggingHandle.includes("s")) newH = startH + dy;
            if (draggingHandle.includes("w")) { newW = startW - dx; newL = startLeft + dx; }
            if (draggingHandle.includes("n")) { newH = startH - dy; newT = startTop + dy; }
        }

        // Constraints
        if (newW < 40) { newW = 40; if (draggingHandle?.includes("w")) newL = startLeft + startW - 40; }
        if (newH < 40) { newH = 40; if (draggingHandle?.includes("n")) newT = startTop + startH - 40; }

        if (newL < imgLeft) { newL = imgLeft; if (!isMovingBox) newW = startW + (startLeft - imgLeft); }
        if (newT < imgTop) { newT = imgTop; if (!isMovingBox) newH = startH + (startTop - imgTop); }

        if (newL + newW > imgLeft + maxW) { if (isMovingBox) newL = imgLeft + maxW - newW; else newW = (imgLeft + maxW) - newL; }
        if (newT + newH > imgTop + maxH) { if (isMovingBox) newT = imgTop + maxH - newH; else newH = (imgTop + maxH) - newT; }

        // SAVE PERCENTAGES FOR RESIZE OBSERVER
        overlay.dataset.pctX = (newL - imgLeft) / maxW;
        overlay.dataset.pctY = (newT - imgTop) / maxH;
        overlay.dataset.pctW = newW / maxW;
        overlay.dataset.pctH = newH / maxH;

        overlay.style.width = newW + "px";
        overlay.style.height = newH + "px";
        overlay.style.left = newL + "px";
        overlay.style.top = newT + "px";
    }

    function onUp() {
        isMovingBox = false;
        draggingHandle = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
    }
}

async function performCrop(overlay, img) {
    const displayW = img.clientWidth;
    const displayH = img.clientHeight;
    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;

    const scaleX = naturalW / displayW;
    const scaleY = naturalH / displayH;

    const imgRect = img.getBoundingClientRect();
    const cropRect = overlay.getBoundingClientRect();

    // ==========================================
    // SMART CHECK: Did they actually crop anything?
    // Math.abs handles tiny browser pixel rounding errors (< 2px difference)
    // ==========================================
    const isSameWidth = Math.abs(cropRect.width - imgRect.width) < 2;
    const isSameHeight = Math.abs(cropRect.height - imgRect.height) < 2;
    const hasNoTransforms = editState.rotation === 0 && editState.flipH === 1 && editState.flipV === 1;

    if (isSameWidth && isSameHeight && hasNoTransforms) {
        // They didn't shrink the box, and there are no rotations to bake.
        // It's a fake crop! Just close the UI and abort so we don't enable the save button.
        disableCropMode(false);
        return;
    }

    // ... If we get past the check, continue with the crop! ...
    const cropX = (cropRect.left - imgRect.left) * scaleX;
    const cropY = (cropRect.top - imgRect.top) * scaleY;
    const cropW = cropRect.width * scaleX;
    const cropH = cropRect.height * scaleY;

    const canvas = document.createElement("canvas");
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext("2d");

    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    const newBlobUrl = canvas.toDataURL("image/jpeg", 0.95);

    img.src = newBlobUrl;

    // Clean up
    disableCropMode(false);

    // FIX: WIPE LOCAL EDIT STATE & UPDATE UI!
    editState = { rotation: 0, flipH: 1, flipV: 1 };
    if (typeof applyTransform === "function") applyTransform();

    // Push the final cropped state to history
    pushToHistory(activeIndex, newBlobUrl, { ...editState });

    // NOW we mark it dirty and enable the save button!
    updateSaveButtonState();
    // Add this right after you successfully apply a crop:
    isDirty = true;
    if (typeof pushToHistory === 'function') pushToHistory(activeIndex, img.src, editState); // Ensure it goes to history!
    if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
}

function bakeTransforms(img, state) {
    return new Promise(resolve => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const isSwapped = Math.abs(state.rotation % 180) === 90;
        canvas.width = isSwapped ? img.naturalHeight : img.naturalWidth;
        canvas.height = isSwapped ? img.naturalWidth : img.naturalHeight;

        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(state.rotation * Math.PI / 180);
        ctx.scale(state.flipH, state.flipV);
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

        resolve(canvas.toDataURL());
    });
}

/* =========================================
   ZOOM
   ========================================= */

function setupZoomControls() {
    let isPanning = false;
    let startX = 0, startY = 0;
    let isZoomingActive = false;
    let zoomFrame;
    let holdTimer;
    let wasLongPress = false;

    const performZoom = (delta) => {
        adjustZoom(delta);
        if (typeof window.refreshToolZoomViewport === "function") window.refreshToolZoomViewport();
    };

    const startContinuousZoom = (delta) => {
        isZoomingActive = true;
        const loop = () => {
            if ((delta > 0 && currentZoom < 5.0) || (delta < 0 && currentZoom > 1.0)) {
                performZoom(delta);
                zoomFrame = requestAnimationFrame(loop);
            } else {
                stopContinuousZoom();
            }
        };
        zoomFrame = requestAnimationFrame(loop);
    };

    const stopContinuousZoom = () => {
        isZoomingActive = false;
        cancelAnimationFrame(zoomFrame);
    };

    const startHold = (delta) => {
        wasLongPress = false;
        holdTimer = setTimeout(() => {
            wasLongPress = true;
            startContinuousZoom(delta);
        }, 240);
    };

    const endHold = () => {
        clearTimeout(holdTimer);
        stopContinuousZoom();
    };

    const handleClick = (e, delta) => {
        e.preventDefault();
        if (wasLongPress) { wasLongPress = false; return; }
        performZoom(delta);
    };

    btnZoomIn.onmousedown = btnZoomIn.onclick = null;
    btnZoomOut.onmousedown = btnZoomOut.onclick = null;
    window.onmousemove = null;
    window.onmouseup = null;

    btnZoomIn.onmousedown = (e) => { e.preventDefault(); startHold(HOLD_ZOOM_STEP); };
    btnZoomIn.onmouseup = btnZoomIn.onmouseleave = endHold;
    btnZoomIn.onclick = (e) => handleClick(e, CLICK_ZOOM_STEP);

    btnZoomOut.onmousedown = (e) => { e.preventDefault(); startHold(-HOLD_ZOOM_STEP); };
    btnZoomOut.onmouseup = btnZoomOut.onmouseleave = endHold;
    btnZoomOut.onclick = (e) => handleClick(e, -CLICK_ZOOM_STEP);

    window.onmousemove = (e) => {
        if (!isPanning) return;
        e.preventDefault();
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        applyTransform();
    };

    window.onmouseup = () => {
        if (isPanning) {
            isPanning = false;
            const page = carousel.children[activeIndex];
            if (page) page.classList.remove("is-dragging");
        }
    };

    window.attachDragEvents = (img, wrapper) => {
        let lastClickTime = 0; // Tracks our custom double-click

        wrapper.onmousedown = (e) => {
            // ==========================================
            // FIX: Custom Flawless Double-Click logic!
            // ==========================================
            const now = Date.now();
            if (now - lastClickTime < 300) {
                // IT IS A DOUBLE CLICK!
                e.preventDefault();
                e.stopPropagation();

                if (currentZoom !== MIN_ZOOM) resetZoomState();
                else setZoomState(DOUBLE_CLICK_ZOOM);

                applyTransform();
                if (typeof window.refreshToolZoomViewport === "function") window.refreshToolZoomViewport();
                lastClickTime = 0; // Wipe memory so the next click works instantly!
                return; // Stop the drag logic from running
            }

            // Not a double click, remember the time for the next click
            lastClickTime = now;

            // ATTACH TO WRAPPER: Allows dragging even from black space if image is small/off-center
            if (currentZoom > MIN_ZOOM && !isZoomingActive && !isCropMode && !isToolZoomMode) {
                isPanning = true;
                startX = e.clientX - panX;
                startY = e.clientY - panY;
                wrapper.classList.add("is-dragging");
                e.preventDefault();
            }
        };

        // WE CAN DELETE wrapper.ondblclick COMPLETELY NOW!
    };
}

/* =========================================
   TOOL PAGE ZOOM MANAGER
   Safely manages zoom inside Resize/Compress pages
   ========================================= */

window.setupToolZoom = function () {
    let toolIsPanning = false;
    let toolStartX = 0, toolStartY = 0;
    let toolLastClickTime = 0;

    const getActiveToolWrapper = () => carousel.children[activeIndex] || null;

    const applyToolViewportRules = (wrapper) => {
        if (!wrapper) return;

        const basePadding = wrapper.dataset.toolZoomPadding;
        const baseOverflow = wrapper.dataset.toolZoomOverflow || "hidden";

        if (currentZoom > MIN_ZOOM) {
            wrapper.style.removeProperty("padding");
            wrapper.style.removeProperty("box-sizing");
            wrapper.style.removeProperty("height");
            wrapper.style.removeProperty("max-height");
            wrapper.style.setProperty("overflow", "auto", "important");
            return;
        }

        if (basePadding) wrapper.style.setProperty("padding", basePadding, "important");
        if (wrapper.dataset.toolZoomBoxSizing) wrapper.style.setProperty("box-sizing", wrapper.dataset.toolZoomBoxSizing, "important");
        if (wrapper.dataset.toolZoomHeight) wrapper.style.setProperty("height", wrapper.dataset.toolZoomHeight, "important");
        if (wrapper.dataset.toolZoomMaxHeight) wrapper.style.setProperty("max-height", wrapper.dataset.toolZoomMaxHeight, "important");
        wrapper.style.setProperty("overflow", baseOverflow, "important");
        wrapper.style.setProperty("justify-content", "center", "important");
        wrapper.style.setProperty("align-items", "center", "important");
        wrapper.scrollTop = 0;
        wrapper.scrollLeft = 0;
    };

    const clearToolZoomButtons = () => {
        document.querySelectorAll(".tool-zoom-btn").forEach(btn => btn.remove());
    };

    const removeToolZoomHandlers = () => {
        if (detachToolZoomHandlers) {
            detachToolZoomHandlers();
            detachToolZoomHandlers = null;
        }
        toolIsPanning = false;
    };

    const syncToolViewportRules = () => {
        const wrapper = getActiveToolWrapper();
        if (!wrapper) return;
        applyToolViewportRules(wrapper);
    };

    const resetToolZoom = () => {
        resetZoomState();
        applyTransform();
        syncToolViewportRules();
    };

    // Create zoom buttons for tool pages
    const createToolZoomControls = () => {
        const toolContainer = document.querySelector(".modal-view");
        if (!toolContainer) return;

        // Remove old tool zoom buttons if they exist
        clearToolZoomButtons();

        // Create zoom in button
        const btnToolZoomIn = document.createElement("button");
        btnToolZoomIn.className = "tool-zoom-btn";
        btnToolZoomIn.id = "btnToolZoomIn";
        btnToolZoomIn.style.cssText = `
            position: absolute;
            top: 20px;
            right: 100px;
            width: 40px;
            height: 40px;
            background: rgba(255,255,255,0.2);
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 20px;
            cursor: pointer;
            z-index: 1000;
            display: none;
        `;
        btnToolZoomIn.textContent = "🔍+";

        // Create zoom out button
        const btnToolZoomOut = document.createElement("button");
        btnToolZoomOut.className = "tool-zoom-btn";
        btnToolZoomOut.id = "btnToolZoomOut";
        btnToolZoomOut.style.cssText = `
            position: absolute;
            top: 20px;
            right: 50px;
            width: 40px;
            height: 40px;
            background: rgba(255,255,255,0.2);
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 20px;
            cursor: pointer;
            z-index: 1000;
            display: none;
        `;
        btnToolZoomOut.textContent = "🔍−";

        // Create reset zoom button
        const btnToolZoomReset = document.createElement("button");
        btnToolZoomReset.className = "tool-zoom-btn";
        btnToolZoomReset.id = "btnToolZoomReset";
        btnToolZoomReset.style.cssText = `
            position: absolute;
            top: 20px;
            right: 150px;
            width: 40px;
            height: 40px;
            background: rgba(255,255,255,0.2);
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 18px;
            cursor: pointer;
            z-index: 1000;
            display: none;
        `;
        btnToolZoomReset.textContent = "⊙";

        toolContainer.appendChild(btnToolZoomIn);
        toolContainer.appendChild(btnToolZoomOut);
        toolContainer.appendChild(btnToolZoomReset);

        // Zoom in handler
        btnToolZoomIn.onclick = () => {
            adjustZoom(CLICK_ZOOM_STEP);
            syncToolViewportRules();
        };

        // Zoom out handler
        btnToolZoomOut.onclick = () => {
            adjustZoom(-CLICK_ZOOM_STEP);
            syncToolViewportRules();
        };

        // Reset zoom handler
        btnToolZoomReset.onclick = () => {
            resetToolZoom();
        };
    };

    // Mouse wheel zoom
    const handleToolWheel = (e) => {
        if (!isToolZoomMode) return;
        const wrapper = getActiveToolWrapper();
        if (!wrapper || !wrapper.contains(e.target)) return;
        e.preventDefault();

        const delta = e.deltaY > 0 ? -WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
        adjustZoom(delta);
        syncToolViewportRules();
    };

    // SAME TIMING-BASED DOUBLE-CLICK AS CAROUSEL (FAST & RESPONSIVE)
    const handleToolMouseMove = (e) => {
        if (!toolIsPanning || !isToolZoomMode) return;
        panX = e.clientX - toolStartX;
        panY = e.clientY - toolStartY;
        applyTransform();
    };

    const handleToolMouseUp = () => {
        toolIsPanning = false;
    };

    const handleToolMouseDown = (e) => {
        if (!isToolZoomMode || e.target.closest(".tool-zoom-btn")) return;

        const wrapper = getActiveToolWrapper();
        if (!wrapper || !wrapper.contains(e.target)) return;

        const now = Date.now();

        if (now - toolLastClickTime < 300) {
            e.preventDefault();
            e.stopPropagation();

            // Toggle zoom 1x ↔ 1.5x
            if (currentZoom !== MIN_ZOOM) resetZoomState();
            else setZoomState(DOUBLE_CLICK_ZOOM);

            applyTransform();
            syncToolViewportRules();
            toolLastClickTime = 0;
            return;
        }

        toolLastClickTime = now;

        if (currentZoom > MIN_ZOOM) {
            toolIsPanning = true;
            toolStartX = e.clientX - panX;
            toolStartY = e.clientY - panY;
            e.preventDefault();
        }
    };

    // Show/hide tool zoom buttons
    window.toggleToolZoomButtons = (show) => {
        clearToolZoomButtons();
        removeToolZoomHandlers();
        carousel.removeEventListener("wheel", handleToolWheel);
        delete window.refreshToolZoomViewport;

        isToolZoomMode = show;

        if (show) {
            createToolZoomControls();
            carousel.addEventListener("mousedown", handleToolMouseDown);
            document.addEventListener("mousemove", handleToolMouseMove);
            document.addEventListener("mouseup", handleToolMouseUp);
            carousel.addEventListener("wheel", handleToolWheel, { passive: false });
            window.refreshToolZoomViewport = syncToolViewportRules;
            syncToolViewportRules();
            detachToolZoomHandlers = () => {
                carousel.removeEventListener("mousedown", handleToolMouseDown);
                carousel.removeEventListener("wheel", handleToolWheel);
                document.removeEventListener("mousemove", handleToolMouseMove);
                document.removeEventListener("mouseup", handleToolMouseUp);
            };
        } else {
            resetToolZoom();
        }
    };
};

/* =========================================
   RENDERING & NAVIGATION
   ========================================= */

async function renderPdfContent(pdfDoc) {
    totalPages = pdfDoc.numPages;
    slider.max = totalPages - 1;
    for (let i = 0; i < totalPages; i++) addPageSkeleton(i, true);

    const renderQueue = async (i) => {
        if (i >= totalPages) return;
        try {
            const page = await pdfDoc.getPage(i + 1);

            // FIX: Use device pixel ratio for Retina/High-Res screens, base scale of 2
            const pixelRatio = window.devicePixelRatio || 1;
            const viewport = page.getViewport({ scale: 2.0 * pixelRatio });

            const canvas = document.createElement("canvas");
            canvas.width = viewport.width; canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

            // FIX: 1.0 Quality for crystal clear text!
            const src = canvas.toDataURL("image/jpeg", 1.0);
            fillPageContent(src, i, true);
        } catch (e) { console.error(e); }
        requestAnimationFrame(() => renderQueue(i + 1));
    };
    renderQueue(0);
}

function renderImageContent(src) {
    totalPages = 1;
    slider.max = 0;
    addPageSkeleton(0, false);
    fillPageContent(src, 0, false);
}

function renderImageBatchContent(batchThumbs) {
    totalPages = batchThumbs.length;
    slider.max = Math.max(totalPages - 1, 0);

    batchThumbs.forEach((thumb, index) => {
        addPageSkeleton(index, false);
        fillPageContent(thumb.dataset.url, index, false);
    });
}

function addPageSkeleton(index, isPdf) {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-page";
    wrapper.innerHTML = `<div class="loading-spinner">Loading...</div>`;
    carousel.appendChild(wrapper);
    if (isPdf) {
        const filmWrap = document.createElement("div");
        filmWrap.className = "film-thumb-wrapper";
        if (selectedPages.has(index)) filmWrap.classList.add("selected");
        const thumb = document.createElement("img");
        thumb.className = "film-thumb";
        thumb.onclick = () => scrollToPage(index);
        /*
        const checkbox = document.createElement("div");
        checkbox.className = "film-strip-checkbox";
        checkbox.onclick = (e) => togglePageSelection(e, index, filmWrap);
        filmWrap.append(thumb, checkbox);
        filmstrip.appendChild(filmWrap);
        */
    }
}

function fillPageContent(src, index, isPdf) {
    const wrapper = carousel.children[index];
    if (!wrapper) return;
    wrapper.innerHTML = "";
    const img = document.createElement("img");
    img.onload = () => updateEditorInfo();
    img.src = src;
    img.draggable = false;
    img.style.transformOrigin = "center center";
    initPageHistory(index, src);
    window.attachDragEvents(img, wrapper);
    wrapper.appendChild(img);
    if (isPdf && filmstrip.children[index]) {
        filmstrip.children[index].querySelector("img").src = src;
    }
    if (index === activeIndex) {
        applyTransform();
        updateUndoRedoUI();
    }
}

function setupNavigation(isPdf) {
    const btnPrev = modal.querySelector("#editorPrev");
    const btnNext = modal.querySelector("#editorNext");

    if (!btnPrev || !btnNext) {
        console.warn("Navigation buttons not found");
        return;
    }

    carousel.onscroll = () => {
        if (carousel.offsetWidth === 0) return;
        const newIndex = Math.round(carousel.scrollLeft / carousel.offsetWidth);
        if (newIndex !== activeIndex) {
            activeIndex = newIndex;
            syncNavigationState(isPdf);
        }
    };

    slider.oninput = () => scrollToPage(parseInt(slider.value), "auto", true);

    btnPrev.onclick = (e) => {
        e.preventDefault();
        if (!btnPrev.disabled) scrollToPage(activeIndex - 1, "auto", true);
    };

    btnNext.onclick = (e) => {
        e.preventDefault();
        if (!btnNext.disabled) scrollToPage(activeIndex + 1, "auto", true);
    };
}


function syncNavigationState(isPdf = true) {
    if (typeof window.syncPageState === "function") window.syncPageState();
    if (currentZoom !== 1) {
        resetZoomState();
    }

    const currentStack = pageHistory[activeIndex];
    if (currentStack) {
        const ptr = historyPointers[activeIndex] || 0;
        const state = currentStack[ptr];
        if (state) {
            editState = { ...(state.state || state.edits || { rotation: 0, flipH: 1, flipV: 1 }) };
        }
    }

    applyTransform();
    if (typeof window.refreshToolZoomViewport === "function") window.refreshToolZoomViewport();
    updateNav(isPdf);
    updateUndoRedoUI();
    updateEditorInfo();
}

function scrollToPage(index, behavior = "auto", forceSync = false) {
    if (index < 0 || index >= totalPages) return;
    activeIndex = index;

    const left = index * carousel.offsetWidth;
    carousel.scrollLeft = left;
    carousel.scrollTo({ left, behavior });

    if (forceSync) {
        syncNavigationState(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);
    }
}

window.updateNav = function (isPdf) {
    const btnPrev = document.getElementById("editorPrev");
    const btnNext = document.getElementById("editorNext");

    if (!btnPrev || !btnNext) return;

    const isCarousel = (typeof currentEditorMode !== 'undefined' && currentEditorMode === 'carousel');
    const multiplePages = (typeof totalPages !== 'undefined' && totalPages > 1);

    // Hide buttons entirely if not in carousel mode OR only 1 page
    if (!isCarousel || !multiplePages) {
        btnPrev.classList.add("hidden");
        btnNext.classList.add("hidden");
    } else {
        btnPrev.classList.remove("hidden");
        btnNext.classList.remove("hidden");

        // Disable based on current position
        btnPrev.disabled = (activeIndex === 0);
        btnNext.disabled = (activeIndex === totalPages - 1);
    }

    if (typeof slider !== 'undefined' && slider) slider.value = activeIndex;

    const checkPdf = typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null;
    if (checkPdf) {
        const counter = document.getElementById("pageCounter") || document.querySelector(".page-counter");

        if (counter) counter.textContent = `Page: ${activeIndex + 1} / ${totalPages}`;

        const filmstrip = document.getElementById("editorFilmstrip");
        if (filmstrip) {
            const thumbs = filmstrip.querySelectorAll(".film-thumb-wrapper");
            thumbs.forEach((t, i) => {
                const img = t.querySelector("img");
                if (img) img.classList.toggle("active", i === activeIndex);
                if (i === activeIndex && isCarousel) {
                    t.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
                }
            });
        }
    }
    updateEditorInfo();
};

function togglePageSelection(e, index, wrapper) {
    e.stopPropagation();
    if (selectedPages.has(index)) {
        selectedPages.delete(index);
        wrapper.classList.remove("selected");
    } else {
        selectedPages.add(index);
        wrapper.classList.add("selected");
    }
    updateNav(true);
    if (typeof window.updateEditorSaveMenuState === "function") window.updateEditorSaveMenuState();
    updateEditorInfo();
}

function setupSaveHandler(originalThumb, isPdf, callbacks) {
    saveMode = 'original';
    const isBatchSession = currentSessionMode === 'image-batch';

    const btnDropdownToggle = modal.querySelector('#btnSaveDropdownToggle');
    const saveMenu = modal.querySelector('#saveDropdownMenu');
    const btnSaveOriginal = modal.querySelector('#btnSaveOriginal');
    const btnSaveCopy = modal.querySelector('#btnSaveCopy');
    const btnSaveAsImage = modal.querySelector('#btnSaveAsImage');
    const btnSaveMain = document.getElementById("btnSaveToGallery"); // Needed to change the text!

    if (btnSaveMain) {
        btnSaveMain.textContent = "Apply to Original";
    }

    const updateSaveMenuState = () => {
        if (!btnSaveAsImage) return;
        const allowSaveAsImage = isPdf && !(currentEditorMode === "grid" && selectedPages.size !== 1);
        btnSaveAsImage.style.display = allowSaveAsImage ? "block" : "none";
        if (saveMode === "extract_image" && !allowSaveAsImage) {
            setSaveMode('original', 'Apply to Original');
        }
    };

    // Only show "Save as Image" if editing a PDF and exactly one page is selected in grid mode
    updateSaveMenuState();
    if (btnSaveCopy) btnSaveCopy.style.display = isBatchSession ? "none" : "block";
    if (btnDropdownToggle) btnDropdownToggle.style.display = isBatchSession ? "none" : "";
    window.updateEditorSaveMenuState = updateSaveMenuState;

    if (btnDropdownToggle && saveMenu) {
        btnDropdownToggle.onclick = (e) => {
            e.stopPropagation();
            saveMenu.classList.toggle('active');
        };
        document.addEventListener('click', () => saveMenu.classList.remove('active'));
    }

    // FIX 3: Centralized helper to change modes, update text, and enable buttons
    const setSaveMode = (mode, text) => {
        saveMode = mode;
        if (btnSaveMain) {
            btnSaveMain.textContent = text; // Update the UI text

            if (mode === 'copy' || mode === 'extract_image') {
                // If they want a copy or extraction, enable the save button instantly
                btnSaveMain.disabled = false;
                btnSaveMain.style.opacity = "1";
                btnSaveMain.style.pointerEvents = "auto";
            } else {
                // If they go back to Original, re-check if there are actual edits
                if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
            }
        }
        if (saveMenu) saveMenu.classList.remove('active'); // Close menu
    };

    if (btnSaveOriginal) btnSaveOriginal.onclick = (e) => { e.stopPropagation(); setSaveMode('original', 'Apply to Original'); };
    if (btnSaveCopy) btnSaveCopy.onclick = (e) => { e.stopPropagation(); setSaveMode('copy', 'Save as Copy'); };
    if (btnSaveAsImage) btnSaveAsImage.onclick = (e) => { e.stopPropagation(); setSaveMode('extract_image', 'Save as Image'); };

    // THIS is where the actual saving happens
    if (btnSaveMain) {
        btnSaveMain.onclick = async () => {
            // 1. Physically check the new pointer lock
            if (btnSaveMain.disabled || btnSaveMain.style.pointerEvents === "none") return;
            if (!originalThumb && !isBatchSession) return;

            // Remember original text so we can revert if it fails
            const originalText = btnSaveMain.textContent;
            btnSaveMain.textContent = "Saving...";
            btnSaveMain.style.pointerEvents = "none"; // Lock it during processing

            try {
                if (isBatchSession && callbacks.onBatchSave) {
                    const pageBlobs = [];
                    for (let i = 0; i < currentBatchThumbs.length; i++) {
                        pageBlobs.push(await getBakedPageBlob(i));
                    }

                    await callbacks.onBatchSave(currentBatchThumbs, pageBlobs, saveMode);

                    for (let i = 0; i < pageBlobs.length; i++) {
                        const pageBlob = pageBlobs[i];
                        if (!pageBlob) continue;

                        const newUrl = URL.createObjectURL(pageBlob);
                        const pageWrapper = carousel.children[i];
                        const liveImg = pageWrapper ? pageWrapper.querySelector("img") : null;
                        if (liveImg) liveImg.src = newUrl;

                        pageHistory[i] = [{ src: newUrl, edits: { rotation: 0, flipH: 1, flipV: 1 } }];
                        historyPointers[i] = 0;
                    }

                    editState = { rotation: 0, flipH: 1, flipV: 1 };
                    isDirty = false;
                    if (typeof window.updateUndoRedoUI === "function") window.updateUndoRedoUI();
                    if (typeof window.syncAllViews === "function") window.syncAllViews();

                    btnSaveMain.textContent = "Saved!";
                    btnSaveMain.style.background = "#155724";
                    setTimeout(() => {
                        btnSaveMain.style.background = "";
                        btnSaveMain.textContent = originalText;
                        if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
                    }, 2000);
                }
                else if (callbacks.onSave) {
                    // (Assuming saveStateToThumb is globally defined)
                    if (typeof saveStateToThumb === 'function') saveStateToThumb(originalThumb, false);

                    const targetPageIndex = currentEditorMode === "grid" && selectedPages.size > 0
                        ? Array.from(selectedPages).sort((a, b) => a - b)[0]
                        : activeIndex;
                    const pageWrapper = carousel.children[targetPageIndex];
                    const elementToBake = pageWrapper.querySelector("img, canvas");
                    const bakedDataUrl = await bakeTransforms(elementToBake, editState);
                    const response = await fetch(bakedDataUrl);
                    const newBlob = await response.blob();

                    await callbacks.onSave(originalThumb, isPdf, saveMode, newBlob, targetPageIndex);

                    // ==========================================
                    // ONLY APPLY TO ORIGINAL GETS A NEW BASELINE
                    // ==========================================
                    if (saveMode === 'original') {
                        const newUrl = URL.createObjectURL(newBlob);

                        // 1. Wipe Math State
                        editState = { rotation: 0, flipH: 1, flipV: 1 };
                        if (originalThumb._editorState) originalThumb._editorState.edits = { ...editState };

                        // 2. Update Live Image
                        const liveImg = pageWrapper.querySelector("img");
                        if (liveImg) {
                            liveImg.src = newUrl;
                        } else {
                            const liveCanvas = pageWrapper.querySelector("canvas");
                            if (liveCanvas) {
                                const ctx = liveCanvas.getContext("2d");
                                const tempImg = new Image();
                                tempImg.onload = () => {
                                    liveCanvas.width = tempImg.width;
                                    liveCanvas.height = tempImg.height;
                                    ctx.drawImage(tempImg, 0, 0);
                                };
                                tempImg.src = newUrl;
                            }
                        }
                        if (typeof window.applyTransform === "function") window.applyTransform();

                        // ==========================================
                        // 3. HARD RESET THE HISTORY
                        // ==========================================
                        pageHistory[targetPageIndex] = [{ src: newUrl, edits: { rotation: 0, flipH: 1, flipV: 1 } }];
                        historyPointers[targetPageIndex] = 0;
                        isDirty = false;
                        if (typeof window.updateUndoRedoUI === "function") window.updateUndoRedoUI();

                        // Break PDF Link
                        if (originalThumb.dataset.isExtractedPage) {
                            delete originalThumb.dataset.isExtractedPage;
                            delete originalThumb.dataset.pdfPageIndex;
                            delete originalThumb.pdfDoc;
                            originalThumb.dataset.type = "image";
                            if (newBlob.type) originalThumb.dataset.mimeType = newBlob.type;
                        }

                        // Add Yellow Highlight
                        document.querySelectorAll('.is-new-copy').forEach(t => t.classList.remove('is-new-copy'));
                        originalThumb.classList.add("is-new-copy");
                        setTimeout(() => {
                            if (!originalThumb.classList.contains('selected')) {
                                const selectBox = originalThumb.querySelector('.select-box');
                                if (selectBox) selectBox.click();
                            }
                            originalThumb.scrollIntoView({ behavior: "smooth", block: "center" });
                            setTimeout(() => {
                                const removeYellow = (e) => {
                                    if (e.target.closest('.image-modal-overlay')) return;
                                    originalThumb.classList.remove('is-new-copy');
                                    document.removeEventListener('mousedown', removeYellow);
                                };
                                document.addEventListener('mousedown', removeYellow);
                            }, 500);
                        }, 50);
                    }
                    // ==========================================
                    // FIX: SAVE AS COPY LOGIC
                    // ==========================================
                    else if (saveMode === 'copy' || saveMode === 'extract_image') {
                        isDirty = false; // Clear crop/resize warnings

                        // Flag this exact point in history as "Safely Copied"
                        if (!window.savedCopyStates) window.savedCopyStates = new Set();
                        const currentPtr = historyPointers[targetPageIndex] || 0;
                        window.savedCopyStates.add(`${targetPageIndex}-${currentPtr}`);
                    }

                    btnSaveMain.textContent = "Saved!";
                    btnSaveMain.style.background = "#155724"; // Dark success green

                    // 2 seconds later, check the state. 
                    setTimeout(() => {
                        btnSaveMain.style.background = ""; // Reset background color
                        btnSaveMain.textContent = originalText; // Reset text to what it was
                        if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
                    }, 2000);
                }
            } catch (e) {
                console.error(e);
                btnSaveMain.textContent = "Error";
                setTimeout(() => {
                    btnSaveMain.textContent = originalText;
                    if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
                }, 2000);
            }
        };
    }
}

function setupExportHandler() {
    const exportDialog = document.getElementById("exportDialog");
    const exportDialogClose = document.getElementById("exportDialogClose");
    const exportBtnCancel = document.getElementById("exportBtnCancel");
    const exportBtnDoExport = document.getElementById("exportBtnDoExport");
    const exportFormatBtns = Array.from(document.querySelectorAll(".export-format-btn"));
    const pageRangeRadios = document.querySelectorAll("input[name='pageRange']");
    const selectedPagesOption = document.getElementById("selectedPagesOption");
    const originId = modal.dataset.originId;
    const originalThumb = originId ? document.querySelector(`.thumb[data-id="${originId}"]`) : null;

    let selectedFormat = "pdf";
    let selectedPageRange = "all";
    let exportEstimateToken = 0;

    function getSelectedPageCount() {
        return getPageIndices().length;
    }

    function updateExportFormatButtons(pageCount = getSelectedPageCount()) {
        exportFormatBtns.forEach((btn) => {
            const nameEl = btn.querySelector(".format-name");
            const descEl = btn.querySelector(".format-desc");
            if (!nameEl || !descEl) return;

            if (btn.dataset.format === "png") {
                const isSingle = pageCount === 1;
                nameEl.textContent = isSingle ? "PNG" : "PNG (ZIP)";
                descEl.textContent = isSingle ? "High quality image" : "High quality images";
                btn.title = isSingle ? "Export as PNG" : "Each page as PNG in ZIP";
            } else if (btn.dataset.format === "jpg") {
                const isSingle = pageCount === 1;
                nameEl.textContent = isSingle ? "JPG" : "JPG (ZIP)";
                descEl.textContent = isSingle ? "Smaller file size" : "Smaller images in ZIP";
                btn.title = isSingle ? "Export as JPG" : "Each page as JPG in ZIP";
            }
        });
    }

    function canUseOriginalPdfExport(pageIndices, format) {
        return (
            format === "pdf" &&
            currentSessionMode === "pdf" &&
            originalThumb &&
            pageIndices.length === totalPages &&
            typeof window.hasUnsavedEdits === "function" &&
            !window.hasUnsavedEdits()
        );
    }

    // Open export dialog
    btnExport.onclick = async () => {
        if (currentEditorMode === "grid" && selectedPageRange === "current") {
            selectedPageRange = "all";
            const allPagesRadio = Array.from(pageRangeRadios).find(radio => radio.value === "all");
            if (allPagesRadio) allPagesRadio.checked = true;
        }
        exportDialog.style.display = "flex";
        updateExportFormatButtons();
        await updateExportInfo();
        const currentPageRadio = Array.from(pageRangeRadios).find(radio => radio.value === "current");
        const currentPageLabel = currentPageRadio ? currentPageRadio.closest(".export-radio") : null;
        if (currentPageLabel) {
            currentPageLabel.style.display = currentEditorMode === "grid" ? "none" : "";
        }

        // Disable selected pages option if no pages selected
        if (selectedPages.size === 0) {
            selectedPagesOption.disabled = true;
            selectedPagesOption.parentElement.style.opacity = "0.5";
            selectedPagesOption.parentElement.style.pointerEvents = "none";
        } else {
            selectedPagesOption.disabled = false;
            selectedPagesOption.parentElement.style.opacity = "1";
            selectedPagesOption.parentElement.style.pointerEvents = "auto";
            document.getElementById("selectedCount").textContent = selectedPages.size;
        }
    };

    // Close dialog
    exportDialogClose.onclick = () => exportDialog.style.display = "none";
    exportBtnCancel.onclick = () => exportDialog.style.display = "none";

    // Click outside to close
    exportDialog.onclick = (e) => {
        if (e.target === exportDialog) exportDialog.style.display = "none";
    };

    // Format selection
    exportFormatBtns.forEach(btn => {
        btn.onclick = async () => {
            exportFormatBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            selectedFormat = btn.dataset.format;
            await updateExportInfo();
        };
    });

    // Page range selection
    pageRangeRadios.forEach(radio => {
        radio.onchange = async () => {
            selectedPageRange = radio.value;
            await updateExportInfo();
        };
    });

    // Export button
    exportBtnDoExport.onclick = async () => {
        exportBtnDoExport.disabled = true;
        await performExport();
        exportBtnDoExport.disabled = false;
    };

    async function updateExportInfo() {
        const pageIndices = getPageIndices();
        const pageCount = pageIndices.length;
        const currentEstimateToken = ++exportEstimateToken;

        document.getElementById("exportPageCount").textContent = `Pages: ${pageCount}`;
        updateExportFormatButtons(pageCount);

        const estimateLabel = document.getElementById("exportEstimatedSize");
        estimateLabel.textContent = "Est. Size: calculating...";

        try {
            const estimatedBytes = await estimateExportSize(pageIndices, selectedFormat);
            if (currentEstimateToken !== exportEstimateToken) return;
            estimateLabel.textContent = `Est. Size: ${formatBytes(estimatedBytes)}`;
        } catch (error) {
            if (currentEstimateToken !== exportEstimateToken) return;
            estimateLabel.textContent = "Est. Size: unavailable";
        }
    }

    async function estimateExportSize(pageIndices, format) {
        if (pageIndices.length === 0) return 0;

        if (canUseOriginalPdfExport(pageIndices, format)) {
            const blob = await fetch(originalThumb.dataset.url).then((response) => response.blob());
            return blob.size;
        }

        if (format === "pdf") {
            const canvases = [];
            for (const pageIdx of pageIndices) {
                canvases.push(await getBakedPageCanvas(pageIdx));
            }
            const blob = await buildPdfBlobFromCanvasList(canvases);
            return blob.size;
        }

        let totalBytes = 0;
        for (const pageIdx of pageIndices) {
            const canvas = await getBakedPageCanvas(pageIdx);
            const mimeType = format === "png" ? "image/png" : "image/jpeg";
            const quality = format === "png" ? 1 : 0.9;
            totalBytes += await estimateCanvasBytes(canvas, mimeType, quality);
        }

        return pageIndices.length === 1 ? totalBytes : totalBytes + (pageIndices.length * 256);
    }

    async function performExport() {
        try {
            // Get pages to export
            const pagesToExport = getPageIndices();
            if (pagesToExport.length === 0) {
                alert("No pages selected for export");
                return;
            }

            // Show progress
            showExportProgress();

            // Get filename
            const baseName = originalThumb ?
                (originalThumb.dataset.sourceName || originalThumb.dataset.filename || "export") :
                (currentBatchThumbs[0]?.dataset.sourceName || currentBatchThumbs[0]?.dataset.filename || "export");

            if (selectedFormat === "pdf") {
                await exportAsPDF(pagesToExport, baseName);
            } else if (selectedFormat === "png") {
                await exportAsImageOutput(pagesToExport, baseName, "png");
            } else if (selectedFormat === "jpg") {
                await exportAsImageOutput(pagesToExport, baseName, "jpg");
            }

            hideExportProgress();
            exportDialog.style.display = "none";
            showEditorToast("Export completed successfully!");

        } catch (error) {
            console.error("Export error:", error);
            hideExportProgress();
            alert("Export failed: " + error.message);
        }
    }

    function getPageIndices() {
        if (selectedPageRange === "all") {
            return Array.from({ length: totalPages }, (_, i) => i);
        } else if (selectedPageRange === "current" && currentEditorMode !== "grid") {
            return [activeIndex];
        } else if (selectedPageRange === "selected") {
            return Array.from(selectedPages).sort((a, b) => a - b);
        }
        return [];
    }

    async function exportAsPDF(pageIndices, baseName) {
        if (canUseOriginalPdfExport(pageIndices, "pdf")) {
            const blob = await fetch(originalThumb.dataset.url).then((response) => response.blob());
            downloadBlob(blob, `${baseName}.pdf`);
            return;
        }

        const pdf = new jsPDF({
            orientation: "portrait",
            unit: "mm",
            format: "a4"
        });

        for (let i = 0; i < pageIndices.length; i++) {
            const pageIdx = pageIndices[i];
            const canvas = await getBakedPageCanvas(pageIdx);

            if (canvas) {
                const imgData = canvas.toDataURL("image/jpeg", 0.9);
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = pdf.internal.pageSize.getHeight();

                const imgWidth = canvas.width;
                const imgHeight = canvas.height;
                const ratio = Math.min(pdfWidth / imgWidth, pdfHeight / imgHeight);

                const width = imgWidth * ratio;
                const height = imgHeight * ratio;
                const x = (pdfWidth - width) / 2;
                const y = (pdfHeight - height) / 2;

                if (i > 0) pdf.addPage();
                pdf.addImage(imgData, "JPEG", x, y, width, height);
            }

            updateExportProgress(i + 1, pageIndices.length);
        }

        const filename = `${baseName}.pdf`;
        pdf.save(filename);
    }

    async function exportAsImageOutput(pageIndices, baseName, format) {
        if (pageIndices.length === 1) {
            const canvas = await getBakedPageCanvas(pageIndices[0]);
            const mimeType = format === "png" ? "image/png" : "image/jpeg";
            const quality = format === "png" ? 1 : 0.85;
            const blob = await canvasToBlobPromise(canvas, mimeType, quality);
            downloadBlob(blob, `${baseName}.${format}`);
            updateExportProgress(1, 1);
            return;
        }

        const zip = new JSZip();
        const folder = zip.folder(baseName);

        for (let i = 0; i < pageIndices.length; i++) {
            const pageIdx = pageIndices[i];
            const canvas = await getBakedPageCanvas(pageIdx);

            if (canvas) {
                const mimeType = format === "png" ? "image/png" : "image/jpeg";
                const quality = format === "png" ? 1 : 0.85;
                const dataUrl = canvas.toDataURL(mimeType, quality);
                const base64 = dataUrl.split(",")[1];

                const pageNum = String(pageIdx + 1).padStart(3, "0");
                const filename = `page_${pageNum}.${format}`;
                folder.file(filename, base64, { base64: true });
            }

            updateExportProgress(i + 1, pageIndices.length);
        }

        const zipData = await folder.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipData);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${baseName}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async function getExportBlobForPage(pageIdx, format) {
        const canvas = await getBakedPageCanvas(pageIdx);
        const mimeType = format === "png" ? "image/png" : "image/jpeg";
        const quality = format === "png" ? 1 : 0.9;

        return await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error(`Failed to create export blob for page ${pageIdx}`));
            }, mimeType, quality);
        });
    }

    function updateExportProgress(current, total) {
        const percent = Math.round((current / total) * 100);
        document.getElementById("exportProgressPercent").textContent = percent + "%";
        document.getElementById("exportProgressFill").style.width = percent + "%";
        document.getElementById("exportProgressText").textContent =
            `Processing: Page ${current} of ${total}`;
    }

    function showExportProgress() {
        document.getElementById("exportProgressContainer").style.display = "block";
        document.getElementById("exportProgressFill").style.width = "0%";
        exportBtnDoExport.disabled = true;
    }

    function hideExportProgress() {
        document.getElementById("exportProgressContainer").style.display = "none";
        exportBtnDoExport.disabled = false;
    }
}

function getPageState(pageIdx) {
    const history = pageHistory[pageIdx];
    const pointer = historyPointers[pageIdx] || 0;
    const snapshot = history && history[pointer];
    return snapshot ? (snapshot.state || snapshot.edits || editState) : editState;
}

async function getBakedPageDataUrl(pageIdx) {
    const pageWrapper = carousel.children[pageIdx];
    if (!pageWrapper) throw new Error(`Missing editor page ${pageIdx}`);

    const img = pageWrapper.querySelector("img, canvas");
    if (!img) throw new Error(`Missing image for page ${pageIdx}`);

    return await bakeTransforms(img, getPageState(pageIdx));
}

async function getBakedPageCanvas(pageIdx) {
    const bakedDataUrl = await getBakedPageDataUrl(pageIdx);

    return await new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        const image = new Image();
        image.onload = () => {
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            resolve(canvas);
        };
        image.onerror = () => reject(new Error(`Failed to render baked page ${pageIdx}`));
        image.src = bakedDataUrl;
    });
}

async function getBakedPageBlob(pageIdx) {
    const canvas = await getBakedPageCanvas(pageIdx);
    return await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error(`Failed to bake page ${pageIdx}`));
        }, "image/png");
    });
}


// Added 'saveEdits' parameter. False by default.
function saveStateToThumb(originalThumb, saveEdits = false) {
    if (!originalThumb) return;
    const controls = modal.querySelector("#pdfControls");
    const isCollapsed = controls ? controls.classList.contains("collapsed") : false;

    const sidebar = modal.querySelector(".modal-sidebar");
    const isSidebarCollapsed = sidebar ? sidebar.classList.contains("collapsed") : false;

    originalThumb._editorState = {
        lastActiveIndex: activeIndex,
        isCollapsed: isCollapsed,
        isSidebarCollapsed: isSidebarCollapsed,
        // FIX: Only override the edits if they actually clicked Save
        edits: saveEdits ? { ...editState } : (originalThumb._editorState?.edits || null),
        selectedPages: saveEdits ? Array.from(selectedPages) : (originalThumb._editorState?.selectedPages || [])
    };
}

function restoreState(savedState) {
    if (!savedState) return;
    activeIndex = savedState.lastActiveIndex || 0;
    if (typeof window.syncPageState === "function") window.syncPageState();
    selectedPages = new Set(savedState.selectedPages || []);
    if (savedState.edits) editState = { ...savedState.edits };

    if (savedState.isCollapsed) {
        const c = modal.querySelector("#pdfControls");
        if (c) {
            c.classList.add("collapsed");
            modal.querySelector("#toggleControlsBtn").innerHTML = "▲";
        }
    }

    if (savedState.isSidebarCollapsed) {
        const s = modal.querySelector(".modal-sidebar");
        if (s) {
            s.classList.add("collapsed");
            modal.querySelector("#toggleSidebarBtn").innerHTML = "◀";
        }
    }
}

function closeEditor() {

    // FIX: Pass false so it doesn't try to push to history while closing
    if (isCropMode) disableCropMode(false);
    if (resizeObserver) resizeObserver.disconnect();

    const originId = modal.dataset.originId;
    if (originId) {
        const thumb = document.querySelector(`.thumb[data-id="${originId}"]`);
        // Pass false so we ONLY save UI layout, not unconfirmed edits
        saveStateToThumb(thumb, false);
    }

    modal.classList.remove("active");
    carousel.innerHTML = "";
    document.body.style.overflow = "";

    // ==========================================
    // FIX: WIPE THE MEMORY CLEAN! 
    // Prevents "phantom" edits from bleeding into the next opened image
    // ==========================================
    editState = { rotation: 0, flipH: 1, flipV: 1 };
    isDirty = false;
    currentBatchThumbs = [];
    currentSessionMode = 'single-image';

    pageHistory = {};
    historyPointers = {};
}

/* --- HELPER TO LOCK UI DURING CROP --- */
function toggleTools(isDisabled) {
    // Lock all sidebar tools
    const tools = [
        btnZoomIn, btnZoomOut, btnRotateCCW, btnRotateCW,
        btnFlipH, btnFlipV, btnCrop, btnExport, btnSave
    ];
    tools.forEach(btn => btn.disabled = isDisabled);

    // Lock Navigation & Sliders
    modal.querySelector("#editorPrev").disabled = isDisabled ? true : activeIndex === 0;
    modal.querySelector("#editorNext").disabled = isDisabled ? true : activeIndex === totalPages - 1;
    slider.disabled = isDisabled;

    // Lock Undo/Redo, Filmstrip, and Layout Toggles
    if (isDisabled) {
        filmstrip.style.pointerEvents = "none";
        filmstrip.style.opacity = "0.5";
        btnUndo.disabled = true;
        btnRedo.disabled = true;
        modal.querySelector("#toggleSidebarBtn").style.pointerEvents = "none";
        modal.querySelector("#toggleControlsBtn").style.pointerEvents = "none";
    } else {
        filmstrip.style.pointerEvents = "auto";
        filmstrip.style.opacity = "1";
        updateUndoRedoUI(); // Restore correct undo state
        modal.querySelector("#toggleSidebarBtn").style.pointerEvents = "auto";
        modal.querySelector("#toggleControlsBtn").style.pointerEvents = "auto";
    }
}

function updateCropBoxOnResize() {
    if (!isCropMode || !cropOverlay) return;
    const img = carousel.children[activeIndex].querySelector("img");
    if (!img) return;

    const maxW = img.clientWidth;
    const maxH = img.clientHeight;
    const imgLeft = img.offsetLeft;
    const imgTop = img.offsetTop;

    const px = parseFloat(cropOverlay.dataset.pctX) || 0;
    const py = parseFloat(cropOverlay.dataset.pctY) || 0;
    const pw = parseFloat(cropOverlay.dataset.pctW) || 1;
    const ph = parseFloat(cropOverlay.dataset.pctH) || 1;

    cropOverlay.style.left = (imgLeft + px * maxW) + "px";
    cropOverlay.style.top = (imgTop + py * maxH) + "px";
    cropOverlay.style.width = (pw * maxW) + "px";
    cropOverlay.style.height = (ph * maxH) + "px";
}

async function renderPdfGrid(pdfDoc) {
    if (!gridView) return;
    gridView.innerHTML = ""; // Clear old grid
    if (filmstrip) filmstrip.innerHTML = ""; // FIX: Clear old filmstrip!

    // Loop through every page in the PDF
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);

        // Use a tiny scale (0.3) so the grid renders blazingly fast!
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // Paint the PDF to the canvas
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        // ==========================================
        // FIX: BUILD THE FILMSTRIP THUMBNAILS HERE!
        // ==========================================
        if (filmstrip) {
            const wrapper = document.createElement("div");
            wrapper.className = "film-thumb-wrapper";

            const thumbImg = document.createElement("img");
            thumbImg.className = "film-thumb";
            // Instantly clone the painted canvas as an image!
            thumbImg.src = canvas.toDataURL();

            wrapper.appendChild(thumbImg);

            // Allow clicking the filmstrip thumbnail to jump to that page
            // Allow clicking the filmstrip thumbnail to jump to that page
            wrapper.onclick = () => {
                scrollToPage(i - 1, "smooth", true);
            };

            filmstrip.appendChild(wrapper);
        }

        // ==========================================
        // BUILD THE GRID ITEM
        // ==========================================
        const item = document.createElement("div");
        item.className = "editor-grid-item";
        item.dataset.index = i - 1; // 0-based index

        item.innerHTML = `
            <input type="checkbox" class="select-box" data-page="${i - 1}">
            <div class="page-label">Page ${i}</div>
            <div class="expand-icon" title="Open in Carousel"><i class="fas fa-expand"></i></div>
        `;

        item.insertBefore(canvas, item.firstChild);

        item.onclick = (e) => {
            // 1. Expand Icon Override (Unchanged)
            if (e.target.closest('.expand-icon')) {
                e.stopPropagation();
                activeIndex = i - 1;
                window.switchEditorMode('carousel');
                return;
            }

            const checkbox = item.querySelector('.select-box');
            const pageIdx = parseInt(checkbox.dataset.page);

            // 2. SHIFT + CLICK (Range Selection)
            if (e.shiftKey && lastSelectedGridIndex !== null) {
                // Prevent accidental text highlighting while holding Shift
                document.getSelection().removeAllRanges();

                // Calculate the range between the last clicked item and current item
                const start = Math.min(lastSelectedGridIndex, pageIdx);
                const end = Math.max(lastSelectedGridIndex, pageIdx);

                // Grab all grid items currently in the DOM
                const allItems = gridView.querySelectorAll('.editor-grid-item');

                // Loop through the range and select everything
                for (let j = start; j <= end; j++) {
                    const currentItem = allItems[j];
                    if (!currentItem) continue; // Safety check

                    const currentCheckbox = currentItem.querySelector('.select-box');

                    // Update state and UI for each item in the range
                    currentCheckbox.checked = true;
                    selectedPages.add(j);
                    currentItem.classList.add("is-selected");
                }
            }
            // 3. NORMAL CLICK (Single Selection/Deselection)
            else {
                // Toggle checkbox if clicking on the card (but not directly on the checkbox)
                if (!e.target.classList.contains('select-box')) {
                    checkbox.checked = !checkbox.checked;
                }

                // Update Set and CSS classes
                if (checkbox.checked) {
                    selectedPages.add(pageIdx);
                    item.classList.add("is-selected");
                    // Remember this item for the next potential Shift+Click
                    lastSelectedGridIndex = pageIdx;
                } else {
                    selectedPages.delete(pageIdx);
                    item.classList.remove("is-selected");
                    // If they uncheck the reference item, reset the tracker
                    if (lastSelectedGridIndex === pageIdx) {
                        lastSelectedGridIndex = null;
                    }
                }
            }

            // 4. Update UI Controls (Unchanged)
            if (typeof window.updateGridControls === "function") window.updateGridControls();
            if (typeof window.updateNav === "function") window.updateNav(true);
            if (typeof window.updateEditorSaveMenuState === "function") window.updateEditorSaveMenuState();
            updateEditorInfo();
        };

        item.ondblclick = (e) => {
            e.preventDefault();
            activeIndex = i - 1;
            window.switchEditorMode('carousel');
        };

        gridView.appendChild(item);
    }
}

async function renderImageBatchGrid(batchThumbs) {
    if (!gridView) return;
    gridView.innerHTML = "";
    if (filmstrip) filmstrip.innerHTML = "";

    for (let i = 0; i < batchThumbs.length; i++) {
        const thumb = batchThumbs[i];
        const image = await loadGridImage(thumb.dataset.url);

        const canvas = document.createElement("canvas");
        const maxThumb = 300;
        const scale = Math.min(maxThumb / image.naturalWidth, maxThumb / image.naturalHeight, 1);
        canvas.width = image.naturalWidth * scale;
        canvas.height = image.naturalHeight * scale;
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

        if (filmstrip) {
            const wrapper = document.createElement("div");
            wrapper.className = "film-thumb-wrapper";

            const thumbImg = document.createElement("img");
            thumbImg.className = "film-thumb";
            thumbImg.src = canvas.toDataURL("image/jpeg", 0.85);

            wrapper.appendChild(thumbImg);
            wrapper.onclick = () => {
                scrollToPage(i, "smooth", true);
            };

            filmstrip.appendChild(wrapper);
        }

        const item = document.createElement("div");
        item.className = "editor-grid-item";
        item.dataset.index = i;
        item.innerHTML = `
            <input type="checkbox" class="select-box" data-page="${i}">
            <div class="page-label">Image ${i + 1}</div>
            <div class="expand-icon" title="Open in Carousel"><i class="fas fa-expand"></i></div>
        `;
        item.insertBefore(canvas, item.firstChild);

        item.onclick = (e) => {
            if (e.target.closest('.expand-icon')) {
                e.stopPropagation();
                activeIndex = i;
                window.switchEditorMode('carousel');
                return;
            }

            const checkbox = item.querySelector('.select-box');
            const pageIdx = parseInt(checkbox.dataset.page);

            if (e.shiftKey && lastSelectedGridIndex !== null) {
                document.getSelection().removeAllRanges();
                const start = Math.min(lastSelectedGridIndex, pageIdx);
                const end = Math.max(lastSelectedGridIndex, pageIdx);
                const allItems = gridView.querySelectorAll('.editor-grid-item');

                for (let j = start; j <= end; j++) {
                    const currentItem = allItems[j];
                    if (!currentItem) continue;

                    const currentCheckbox = currentItem.querySelector('.select-box');
                    currentCheckbox.checked = true;
                    selectedPages.add(j);
                    currentItem.classList.add("is-selected");
                }
            } else {
                if (!e.target.classList.contains('select-box')) {
                    checkbox.checked = !checkbox.checked;
                }

                if (checkbox.checked) {
                    selectedPages.add(pageIdx);
                    item.classList.add("is-selected");
                    lastSelectedGridIndex = pageIdx;
                } else {
                    selectedPages.delete(pageIdx);
                    item.classList.remove("is-selected");
                    if (lastSelectedGridIndex === pageIdx) lastSelectedGridIndex = null;
                }
            }

            if (typeof window.updateGridControls === "function") window.updateGridControls();
            if (typeof window.updateNav === "function") window.updateNav(true);
            if (typeof window.updateEditorSaveMenuState === "function") window.updateEditorSaveMenuState();
        };

        item.ondblclick = (e) => {
            e.preventDefault();
            activeIndex = i;
            window.switchEditorMode('carousel');
        };

        gridView.appendChild(item);
    }
}

function loadGridImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image for grid"));
        img.src = src;
    });
}

window.showEditorToast = (message) => {
    const toast = document.getElementById("editorToast");
    if (!toast) return;
    toast.textContent = message;
    toast.style.opacity = "1";

    // Clear any existing timer so they don't overlap
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => {
        toast.style.opacity = "0";
    }, 2000);
};

window.syncPageState = () => {
    // 1. Find the history pointer for the currently active page
    const ptr = historyPointers[activeIndex] !== undefined ? historyPointers[activeIndex] : -1;

    // 2. Load it, or reset to default if it has no history
    if (ptr >= 0 && pageHistory[activeIndex] && pageHistory[activeIndex][ptr]) {
        const snapshot = pageHistory[activeIndex][ptr];
        editState = { ...(snapshot.state || snapshot.edits || { rotation: 0, flipH: 1, flipV: 1 }) };
    } else {
        editState = { rotation: 0, flipH: 1, flipV: 1 };
    }

    // 3. Immediately apply the visual transform so the viewer matches the math!
    if (typeof window.applyTransform === 'function') window.applyTransform();

    // 4. Update the UI buttons to match this page's specific history
    if (typeof window.updateUndoRedoUI === "function") window.updateUndoRedoUI();
};

window.toggleBottomControls = (show) => {
    const bottomControls = document.querySelector(".editor-bottom-controls");
    const fs = document.querySelector(".modal-filmstrip") || (typeof filmstrip !== 'undefined' ? filmstrip : null);

    // FIX: Never show the bottom controls if it's just a single image!
    const isSingleImage = totalPages <= 1;
    const shouldShow = show && !isSingleImage;

    if (bottomControls) {
        bottomControls.style.display = shouldShow ? "" : "none";
    }
    if (fs) {
        fs.style.display = shouldShow ? "" : "none";
    }
};

//RESIZE : THE BEGINNING

window.setupResizeTool = () => {
    const resizeToolbar = document.getElementById("resizeToolbar");
    const resizeW = document.getElementById("resizeW");
    const resizeH = document.getElementById("resizeH");
    const resizeScale = document.getElementById("resizeScale");
    const resizeScaleValue = document.getElementById("resizeScaleValue");
    const btnLockRatio = document.getElementById("btnLockRatio");
    const btnResizeTrigger = document.getElementById("btnResize");

    if (resizeToolbar) resizeToolbar.style.display = "none";

    if (btnResizeTrigger) {
        btnResizeTrigger.onclick = () => {
            const compressNav = document.getElementById("compressNavContainer");
            if (compressNav) compressNav.style.display = "none";
            window.modeBeforeTool = currentEditorMode;

            if (currentEditorMode === 'grid') {
                if (selectedPages.size > 0) activeIndex = Array.from(selectedPages)[0];
                window.switchEditorMode('carousel');
            }

            isResizeMode = true;
            if (typeof modal !== 'undefined' && modal) modal.classList.add("tool-active");
            if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(false);
            if (typeof window.updateNav === 'function') window.updateNav(false);

            // ==========================================
            // FIX 1: THE ZOOM LEAK
            // Instantly reset the zoom state before opening the tool
            // ==========================================
            resetZoomState();
            if (typeof window.applyTransform === 'function') window.applyTransform();

            resizeToolbar.style.display = "flex";
            if (typeof window.setupToolZoom === 'function') window.setupToolZoom();
            if (typeof window.toggleToolZoomButtons === 'function') window.toggleToolZoomButtons(true);

            const modalView = document.querySelector(".modal-view");
            if (modalView) {
                modalView.style.transition = 'none';
                modalView.style.opacity = '0';
            }

            const applyPaddingWhenReady = () => {
                const activeWrapper = carousel.children[activeIndex];

                if (!activeWrapper || carousel.offsetWidth === 0) {
                    setTimeout(applyPaddingWhenReady, 20);
                    return;
                }

                activeWrapper.dataset.toolZoomPadding = '40px 40px 140px 40px';
                activeWrapper.dataset.toolZoomBoxSizing = 'border-box';
                activeWrapper.dataset.toolZoomHeight = '100%';
                activeWrapper.dataset.toolZoomMaxHeight = '100%';
                activeWrapper.dataset.toolZoomOverflow = 'hidden';
                activeWrapper.style.setProperty('padding', activeWrapper.dataset.toolZoomPadding, 'important');
                activeWrapper.style.setProperty('box-sizing', activeWrapper.dataset.toolZoomBoxSizing, 'important');
                activeWrapper.style.setProperty('height', activeWrapper.dataset.toolZoomHeight, 'important');
                activeWrapper.style.setProperty('max-height', activeWrapper.dataset.toolZoomMaxHeight, 'important');

                // ==========================================
                // FIX 2: THE STRAIGHTJACKET 
                // Changed 'hidden' to 'auto' to re-enable zooming and panning!
                // ==========================================
                activeWrapper.style.setProperty('overflow', activeWrapper.dataset.toolZoomOverflow, 'important');

                if (typeof scrollToPage === 'function') scrollToPage(activeIndex);
                if (typeof window.refreshToolZoomViewport === 'function') window.refreshToolZoomViewport();
                updateToolInfo();

                const img = activeWrapper.querySelector("img, canvas");
                if (img) {
                    origImgW = img.naturalWidth || img.width;
                    origImgH = img.naturalHeight || img.height;
                    resizeW.value = origImgW;
                    resizeH.value = origImgH;
                    resizeScale.value = 100;
                    resizeScaleValue.innerText = "100%";
                }

                if (modalView) {
                    modalView.style.transition = 'opacity 0.2s ease';
                    modalView.style.opacity = '1';
                }
            };

            applyPaddingWhenReady();
        };
    }

    if (resizeScale) {
        resizeScale.oninput = (e) => {
            const scale = parseInt(e.target.value) / 100;
            resizeScaleValue.innerText = `${e.target.value}%`;
            resizeW.value = Math.round(origImgW * scale);
            resizeH.value = Math.round(origImgH * scale);
            updateToolInfo();
        };

        resizeW.oninput = (e) => {
            const newW = parseInt(e.target.value) || origImgW;
            if (isRatioLocked) {
                const ratio = origImgH / origImgW;
                resizeH.value = Math.round(newW * ratio);
                const scale = Math.round((newW / origImgW) * 100);
                resizeScale.value = scale;
                resizeScaleValue.innerText = `${scale}%`;
            }
            updateToolInfo();
        };

        resizeH.oninput = (e) => {
            const newH = parseInt(e.target.value) || origImgH;
            if (isRatioLocked) {
                const ratio = origImgW / origImgH;
                resizeW.value = Math.round(newH * ratio);
                const scale = Math.round((newH / origImgH) * 100);
                resizeScale.value = scale;
                resizeScaleValue.innerText = `${scale}%`;
            }
            updateToolInfo();
        };

        if (btnLockRatio) {
            btnLockRatio.onclick = () => {
                isRatioLocked = !isRatioLocked;
                btnLockRatio.style.color = isRatioLocked ? "#007bff" : "#555";
                document.getElementById("icon-locked").style.display = isRatioLocked ? "block" : "none";
                document.getElementById("icon-unlocked").style.display = isRatioLocked ? "none" : "block";
            };
        }

        const btnCancelResize = document.getElementById("btnCancelResize");
        if (btnCancelResize) {
            btnCancelResize.onclick = () => {
                const modalView = document.querySelector(".modal-view");
                if (modalView) {
                    modalView.style.transition = 'none';
                    modalView.style.opacity = '0';
                }

                const clearToolZoomStyles = () => {
                    for (let idx of window.pagesToCompress || [activeIndex]) {
                        const wrapper = carousel.children[idx];
                        if (wrapper) {
                            const img = wrapper.querySelector("img, canvas");
                            if (img) {
                                img.__toolZoomDblClick = false;
                                img.__toolMouseDownAttached = false;
                            }
                        }
                    }
                };

                clearToolZoomStyles();

                setTimeout(() => {
                    const compressNav = document.getElementById("compressNavContainer");
                    if (compressNav) compressNav.style.display = "none";
                    if (typeof window.toggleToolZoomButtons === 'function') window.toggleToolZoomButtons(false);
                    isResizeMode = false;
                    resizeToolbar.style.display = "none";
                    if (typeof modal !== 'undefined' && modal) modal.classList.remove("tool-active");

                    const activeWrapper = carousel.children[activeIndex];
                    clearToolViewportState(activeWrapper);

                    if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(true);
                    resetZoomState();
                    if (typeof window.applyTransform === 'function') window.applyTransform();
                    if (window.modeBeforeTool === 'grid') window.switchEditorMode('grid');
                    if (typeof window.updateNav === 'function') window.updateNav(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);

                    if (modalView) {
                        modalView.style.transition = 'opacity 0.2s ease';
                        modalView.style.opacity = '1';
                    }
                }, 50);
            };
        }

        const btnConfirmResize = document.getElementById("btnConfirmResize");
        if (btnConfirmResize) {
            // ==========================================
            // FIX 3: ADDED 'async' HERE
            // ==========================================
            btnConfirmResize.onclick = async () => {
                const finalW = parseInt(resizeW.value);
                const finalH = parseInt(resizeH.value);

                const activeWrapper = carousel.children[activeIndex];
                const modalView = document.querySelector(".modal-view");

                // --- SCENARIO A: NO CHANGES MADE ---
                if (finalW === origImgW && finalH === origImgH) {
                    if (modalView) { modalView.style.transition = 'none'; modalView.style.opacity = '0'; }

                    const clearToolZoomStyles = () => {
                        for (let idx of window.pagesToCompress || [activeIndex]) {
                            const wrapper = carousel.children[idx];
                            if (wrapper) {
                                const img = wrapper.querySelector("img, canvas");
                                if (img) {
                                    img.__toolZoomDblClick = false;
                                    img.__toolMouseDownAttached = false;
                                }
                            }
                        }
                    };

                    clearToolZoomStyles();

                    setTimeout(() => {
                        const compressNav = document.getElementById("compressNavContainer");
                        if (compressNav) compressNav.style.display = "none";
                        if (typeof window.toggleToolZoomButtons === 'function') window.toggleToolZoomButtons(false);
                        isResizeMode = false;
                        resizeToolbar.style.display = "none";
                        if (typeof modal !== 'undefined' && modal) modal.classList.remove("tool-active");

                        clearToolViewportState(activeWrapper);

                        if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(true);
                        resetZoomState();
                        if (typeof window.applyTransform === 'function') window.applyTransform();
                        updateToolInfo();
                        if (window.modeBeforeTool === 'grid') window.switchEditorMode('grid');
                        if (typeof window.updateNav === 'function') window.updateNav(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);

                        if (modalView) { modalView.style.transition = 'opacity 0.2s ease'; modalView.style.opacity = '1'; }
                    }, 50);
                    return;
                }

                // --- SCENARIO B: APPLY RESIZE ---
                if (modalView) { modalView.style.transition = 'none'; modalView.style.opacity = '0'; }

                editState.resizeW = finalW;
                editState.resizeH = finalH;

                const img = activeWrapper.querySelector("img, canvas");
                const tempCanvas = document.createElement("canvas");
                tempCanvas.width = finalW;
                tempCanvas.height = finalH;
                const ctx = tempCanvas.getContext("2d");
                ctx.drawImage(img, 0, 0, finalW, finalH);

                // ==========================================
                // FIX 4: SAFELY WAIT FOR THE IMAGE TO PAINT
                // Prevents blank thumbnails in Grid View!
                // ==========================================
                await new Promise((resolve) => {
                    if (img.tagName.toUpperCase() === 'IMG') {
                        img.onload = () => resolve();
                        img.src = tempCanvas.toDataURL("image/png");
                    } else {
                        const imgCtx = img.getContext("2d");
                        imgCtx.clearRect(0, 0, img.width, img.height);
                        imgCtx.drawImage(tempCanvas, 0, 0);
                        resolve();
                    }
                });

                if (typeof pushToHistory === 'function') {
                    const savedSrc = img.tagName.toUpperCase() === 'IMG' ? img.src : tempCanvas.toDataURL("image/png");
                    pushToHistory(activeIndex, savedSrc, editState);
                }

                isDirty = true;
                if (typeof window.showEditorToast === 'function') window.showEditorToast(`Resized to ${finalW}x${finalH}`);

                const clearToolZoomStyles = () => {
                    for (let idx of window.pagesToCompress || [activeIndex]) {
                        const wrapper = carousel.children[idx];
                        if (wrapper) {
                            const img = wrapper.querySelector("img, canvas");
                            if (img) {
                                img.__toolZoomDblClick = false;
                                img.__toolMouseDownAttached = false;
                            }
                        }
                    }
                };

                clearToolZoomStyles();

                setTimeout(() => {
                    const compressNav = document.getElementById("compressNavContainer");
                    if (compressNav) compressNav.style.display = "none";
                    if (typeof window.toggleToolZoomButtons === 'function') window.toggleToolZoomButtons(false);
                    isResizeMode = false;
                    resizeToolbar.style.display = "none";
                    if (typeof modal !== 'undefined' && modal) modal.classList.remove("tool-active");

                    clearToolViewportState(activeWrapper);

                    if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
                    if (typeof window.syncAllViews === 'function') window.syncAllViews();
                    if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(true);
                    resetZoomState();
                    if (typeof window.applyTransform === 'function') window.applyTransform();
                    updateToolInfo();
                    if (window.modeBeforeTool === 'grid') window.switchEditorMode('grid');
                    if (typeof window.updateNav === 'function') window.updateNav(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);

                    if (modalView) { modalView.style.transition = 'opacity 0.2s ease'; modalView.style.opacity = '1'; }
                }, 50);
            };
        }
    }
};

window.setupCompressTool = () => {
    const compressToolbar = document.getElementById("compressToolbar");
    const compressQuality = document.getElementById("compressQuality");
    const compressQualityValue = document.getElementById("compressQualityValue");
    const compressFileSizePreset = document.getElementById("compressFileSizePreset");
    const btnCompressTrigger = document.getElementById("btnCompress");
    let compressPreviewToken = 0;
    let applyingPresetSelection = false;

    const syncCompressQualityLabel = () => {
        if (compressQuality && compressQualityValue) {
            compressQualityValue.textContent = `${compressQuality.value}%`;
        }
    };

    const getCompressTargetBytes = (sizeTarget) => {
        const sizeMap = {
            "100": 100 * 1024,
            "200": 200 * 1024,
            "500": 500 * 1024,
            "1000": 1024 * 1024,
            "2000": 2 * 1024 * 1024
        };
        return sizeMap[sizeTarget] || null;
    };

    const findClosestPresetValue = (bytes) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return "auto";
        const presetValues = ["100", "200", "500", "1000", "2000", "3000"];

        for (const value of presetValues) {
            const target = getCompressTargetBytes(value);
            if (bytes <= target) return value;
        }

        return "3000";
    };

    const syncCompressPresetFromEstimate = (bytes) => {
        if (!compressFileSizePreset || applyingPresetSelection) return;
        compressFileSizePreset.value = findClosestPresetValue(bytes);
    };

    const getActiveCompressSourceImage = async () => {
        const activeWrapper = carousel.children[activeIndex];
        if (!activeWrapper) throw new Error("Missing active page for compression");

        const img = activeWrapper.querySelector("img, canvas");
        if (!img) throw new Error("Missing compress media");

        if (!img.dataset.pristine) {
            img.dataset.pristine = img.tagName.toUpperCase() === "CANVAS" ? img.toDataURL("image/png") : img.src;
        }

        const sourceImg = new Image();
        await new Promise((resolve, reject) => {
            sourceImg.onload = resolve;
            sourceImg.onerror = () => reject(new Error("Failed to load compress source image"));
            sourceImg.src = img.dataset.pristine;
        });

        return { img, sourceImg };
    };

    const buildCompressedPreviewCanvas = async (sourceImg, quality) => {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = sourceImg.naturalWidth;
        tempCanvas.height = sourceImg.naturalHeight;
        const ctx = tempCanvas.getContext("2d");
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        ctx.drawImage(sourceImg, 0, 0);
        await applyAdvancedCompression(tempCanvas, quality);
        return tempCanvas;
    };

    const findQualityForTargetBytes = async (targetBytes) => {
        const { sourceImg } = await getActiveCompressSourceImage();
        let bestQuality = 0.8;
        let bestBytes = Number.POSITIVE_INFINITY;
        let low = 0.1;
        let high = 1;

        for (let i = 0; i < 6; i++) {
            const mid = (low + high) / 2;
            const previewCanvas = await buildCompressedPreviewCanvas(sourceImg, mid);
            const estimatedBytes = await estimateCanvasBytes(previewCanvas, "image/jpeg", mid);

            if (estimatedBytes <= targetBytes) {
                bestQuality = mid;
                bestBytes = estimatedBytes;
                low = mid;
            } else {
                if (estimatedBytes < bestBytes) {
                    bestBytes = estimatedBytes;
                    bestQuality = mid;
                }
                high = mid;
            }
        }

        return Math.max(10, Math.min(100, Math.round(bestQuality * 100)));
    };

    const applyCompressPreview = async () => {
        if (!compressQuality) return;

        const token = ++compressPreviewToken;
        const quality = Math.max(0.1, Math.min(1, parseInt(compressQuality.value, 10) / 100 || 0.8));
        const { img, sourceImg } = await getActiveCompressSourceImage();
        if (token !== compressPreviewToken) return;

        const tempCanvas = await buildCompressedPreviewCanvas(sourceImg, quality);
        if (token !== compressPreviewToken) return;

        const estimatedBytes = await estimateCanvasBytes(tempCanvas, "image/jpeg", quality);
        if (token !== compressPreviewToken) return;

        const previewUrl = tempCanvas.toDataURL("image/jpeg", quality);
        const previewImg = new Image();
        previewImg.onload = async () => {
            if (token !== compressPreviewToken) return;

            if (img.tagName.toUpperCase() === "IMG") {
                img.onload = () => {
                    if (typeof scrollToPage === "function") scrollToPage(activeIndex);
                    if (typeof window.refreshToolZoomViewport === "function") window.refreshToolZoomViewport();
                    updateToolInfo();
                };
                img.src = previewUrl;
            } else {
                const imgCtx = img.getContext("2d");
                imgCtx.clearRect(0, 0, img.width, img.height);
                imgCtx.drawImage(previewImg, 0, 0);
                if (typeof scrollToPage === "function") scrollToPage(activeIndex);
                if (typeof window.refreshToolZoomViewport === "function") window.refreshToolZoomViewport();
                await updateToolInfo();
            }

            syncCompressPresetFromEstimate(estimatedBytes);
        };
        previewImg.src = previewUrl;
        updateToolInfo();
    };

    compressQuality.oninput = function () {
        syncCompressQualityLabel();
        applyCompressPreview();
    };

    // When dropdown preset is selected, adjust slider to match
    if (compressFileSizePreset) {
        compressFileSizePreset.onchange = async function () {
            applyingPresetSelection = true;
            try {
                let quality = 80;
                const targetBytes = getCompressTargetBytes(this.value);
                if (targetBytes) {
                    quality = await findQualityForTargetBytes(targetBytes);
                } else {
                    quality = estimateQualityForSize(this.value);
                }
                compressQuality.value = quality;
                syncCompressQualityLabel();
                await applyCompressPreview();
            } finally {
                applyingPresetSelection = false;
            }
        };
    }

    function estimateQualityForSize(sizeTarget) {
        if (sizeTarget === "auto") {
            return 80; // Default quality
        }

        // Estimates based on typical image compression
        // These are approximations - actual results vary by image content
        const sizeMap = {
            "100": 35,    // ~100 KB = ~35% quality
            "200": 50,    // ~200 KB = ~50% quality
            "500": 70,    // ~500 KB = ~70% quality
            "1000": 85,   // ~1 MB = ~85% quality
            "2000": 95,   // ~2 MB = ~95% quality
            "3000": 100
        };

        return sizeMap[sizeTarget] || 80;
    }

    const navContainer = document.getElementById("compressNavContainer");
    const btnPrev = document.getElementById("btnCompressPrev");
    const btnNext = document.getElementById("btnCompressNext");
    const batchCounter = document.getElementById("compressBatchCounter");
    let currentBatchIndex = 0;

    const updateBatchPreview = () => {
        if (!window.pagesToCompress || window.pagesToCompress.length === 0) return;
        activeIndex = window.pagesToCompress[currentBatchIndex];

        if (batchCounter) batchCounter.innerText = `${currentBatchIndex + 1} / ${window.pagesToCompress.length}`;

        if (typeof carousel !== 'undefined' && carousel) {
            carousel.scrollTo({ left: activeIndex * carousel.offsetWidth, behavior: "instant" });
        }

        // 1. Trigger the live preview immediately when swapping pages
        applyCompressPreview();
        updateToolInfo();
    };

    if (btnPrev && btnNext) {
        btnPrev.onclick = () => {
            if (currentBatchIndex > 0) {
                currentBatchIndex--;
                updateBatchPreview();
            }
        };
        btnNext.onclick = () => {
            if (currentBatchIndex < window.pagesToCompress.length - 1) {
                currentBatchIndex++;
                updateBatchPreview();
            }
        };
    }

    if (compressToolbar) compressToolbar.style.display = "none";
    if (navContainer) navContainer.style.display = "none";

    if (btnCompressTrigger) {
        btnCompressTrigger.onclick = () => {
            window.modeBeforeTool = currentEditorMode;
            window.pagesToCompress = [];

            if (currentEditorMode === 'grid') {
                if (selectedPages.size === 0) return;
                window.pagesToCompress = Array.from(selectedPages).sort((a, b) => a - b);
                currentBatchIndex = 0;
                activeIndex = window.pagesToCompress[0];
            } else {
                window.pagesToCompress = [activeIndex];
                currentBatchIndex = 0;
            }

            window.switchEditorMode('carousel');
            if (typeof modal !== 'undefined' && modal) {
                modal.classList.add("tool-active");
                modal.classList.add("is-compressing");
            }

            // ==========================================
            // FIX 1: THE ZOOM LEAK
            // Instantly reset zoom and pan to default before the tool shows up!
            // ==========================================
            resetZoomState();
            if (typeof window.applyTransform === 'function') window.applyTransform();

            const isBatch = window.pagesToCompress.length > 1;

            if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(false);
            if (typeof window.updateNav === 'function') window.updateNav(false);

            if (navContainer) {
                navContainer.style.display = isBatch ? "flex" : "none";
                if (isBatch) updateBatchPreview();
            }

            compressToolbar.style.bottom = "20px";
            compressToolbar.style.display = "flex";
            if (typeof window.setupToolZoom === 'function') window.setupToolZoom();
            if (typeof window.toggleToolZoomButtons === 'function') window.toggleToolZoomButtons(true);
            compressQuality.value = 80;
            suppressPresetReset = false;
            if (compressFileSizePreset) compressFileSizePreset.value = "auto";
            syncCompressQualityLabel();

            const modalView = document.querySelector(".modal-view");
            if (modalView) {
                modalView.style.transition = 'none';
                modalView.style.opacity = '0';
            }

            const applyPaddingWhenReady = () => {
                const targetWrapper = carousel.children[activeIndex];
                if (!targetWrapper || carousel.offsetWidth === 0) {
                    setTimeout(applyPaddingWhenReady, 20);
                    return;
                }

                const targetsToPad = isBatch ? window.pagesToCompress : [activeIndex];
                targetsToPad.forEach(idx => {
                    const wrapper = carousel.children[idx];
                    if (wrapper) {
                        // 1. Define the strict rules
                        wrapper.dataset.toolZoomPadding = '40px 40px 140px 40px';
                        wrapper.dataset.toolZoomBoxSizing = 'border-box';
                        wrapper.dataset.toolZoomHeight = '100%';
                        wrapper.dataset.toolZoomMaxHeight = '100%';
                        wrapper.dataset.toolZoomOverflow = 'hidden';
                        wrapper.style.setProperty('padding', wrapper.dataset.toolZoomPadding, 'important');
                        wrapper.style.setProperty('box-sizing', wrapper.dataset.toolZoomBoxSizing, 'important');
                        wrapper.style.setProperty('height', wrapper.dataset.toolZoomHeight, 'important');
                        wrapper.style.setProperty('max-height', wrapper.dataset.toolZoomMaxHeight, 'important');
                        wrapper.style.setProperty('overflow', wrapper.dataset.toolZoomOverflow, 'important');
                    }
                });

                if (typeof scrollToPage === 'function') scrollToPage(activeIndex);
                if (typeof window.refreshToolZoomViewport === 'function') window.refreshToolZoomViewport();
                updateToolInfo();

                if (modalView) {
                    modalView.style.transition = 'opacity 0.2s ease';
                    modalView.style.opacity = '1';
                }

                setTimeout(() => {
                    applyCompressPreview();
                }, 50);
            };

            applyPaddingWhenReady();
        };
    }

    if (compressQuality) {
        compressQuality.onchange = () => {
            applyCompressPreview();
        };

        const btnCancelCompress = document.getElementById("btnCancelCompress");
        if (btnCancelCompress) {
            btnCancelCompress.onclick = () => {
                const modalView = document.querySelector(".modal-view");
                if (modalView) { modalView.style.transition = 'none'; modalView.style.opacity = '0'; }

                if (typeof window.toggleToolZoomButtons === 'function') window.toggleToolZoomButtons(false);

                const activeWrapper = carousel.children[activeIndex];
                if (activeWrapper) {
                    const img = activeWrapper.querySelector("img, canvas");
                    if (img) {
                        img.__toolZoomDblClick = false; // Reset flag
                    }
                }

                const clearToolZoomStyles = () => {
                    for (let idx of window.pagesToCompress || [activeIndex]) {
                        const wrapper = carousel.children[idx];
                        if (wrapper) {
                            const img = wrapper.querySelector("img, canvas");
                            if (img) {
                                img.__toolZoomDblClick = false;
                                img.__toolMouseDownAttached = false;
                            }
                        }
                    }
                };

                clearToolZoomStyles();

                // 1. ADD 'async' HERE
                setTimeout(async () => {
                    if (navContainer) navContainer.style.display = "none";
                    compressToolbar.style.display = "none";
                    if (typeof modal !== 'undefined' && modal) {
                        modal.classList.remove("tool-active");
                        modal.classList.remove("is-compressing");
                    }

                    // 2. USE A STANDARD FOR-LOOP TO ALLOW 'await'
                    for (let i = 0; i < window.pagesToCompress.length; i++) {
                        const idx = window.pagesToCompress[i];
                        const wrapper = carousel.children[idx];

                        if (wrapper) {
                            clearToolViewportState(wrapper);

                            // 3. SAFELY AWAIT THE IMAGE RESTORATION
                            const img = wrapper.querySelector("img, canvas");
                            if (img && img.dataset.pristine) {
                                await new Promise((resolve) => {
                                    if (img.tagName.toUpperCase() === 'IMG') {
                                        img.onload = () => resolve();
                                        img.src = img.dataset.pristine;
                                    } else {
                                        const restoreImg = new Image();
                                        restoreImg.onload = () => {
                                            const ctx = img.getContext("2d");
                                            ctx.clearRect(0, 0, img.width, img.height);
                                            ctx.drawImage(restoreImg, 0, 0);
                                            resolve(); // Tell the loop we are fully done painting!
                                        };
                                        restoreImg.src = img.dataset.pristine;
                                    }
                                });
                                delete img.dataset.pristine;
                            }
                        }
                    }

                    if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(true);
                    resetZoomState();
                    if (typeof window.applyTransform === 'function') window.applyTransform();

                    // NOW it is 100% safe to generate the grid!
                    if (window.modeBeforeTool === 'grid') window.switchEditorMode('grid');
                    if (typeof window.updateNav === 'function') window.updateNav(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);

                    if (modalView) { modalView.style.transition = 'opacity 0.2s ease'; modalView.style.opacity = '1'; }
                }, 50);
            };
        }

        const btnConfirmCompress = document.getElementById("btnConfirmCompress");
        if (btnConfirmCompress) {
            btnConfirmCompress.onclick = () => {
                const quality = parseInt(compressQuality.value) / 100;

                const modalView = document.querySelector(".modal-view");
                if (modalView) { modalView.style.transition = 'none'; modalView.style.opacity = '0'; }

                const clearToolZoomStyles = () => {
                    for (let idx of window.pagesToCompress || [activeIndex]) {
                        const wrapper = carousel.children[idx];
                        if (wrapper) {
                            const img = wrapper.querySelector("img, canvas");
                            if (img) {
                                img.__toolZoomDblClick = false;
                                img.__toolMouseDownAttached = false;
                            }
                        }
                    }
                };

                clearToolZoomStyles();

                setTimeout(async () => {
                    if (typeof window.toggleToolZoomButtons === 'function') window.toggleToolZoomButtons(false);
                    if (navContainer) navContainer.style.display = "none";
                    for (let i = 0; i < window.pagesToCompress.length; i++) {
                        const pageIdx = window.pagesToCompress[i];

                        try {
                            const activeWrapper = carousel.children[pageIdx];
                            if (!activeWrapper) continue;

                            const img = activeWrapper.querySelector("img, canvas");
                            if (!img) continue;

                            // 6. USE PRISTINE SOURCE FOR FINAL MATH
                            const finalSourceSrc = img.dataset.pristine || (img.tagName.toUpperCase() === 'CANVAS' ? img.toDataURL("image/png") : img.src);

                            await new Promise((resolve) => {
                                const tempImg = new Image();
                                tempImg.onload = async () => {
                                    const origW = tempImg.naturalWidth;
                                    const origH = tempImg.naturalHeight;

                                    const tempCanvas = document.createElement("canvas");
                                    tempCanvas.width = origW;
                                    tempCanvas.height = origH;
                                    const ctx = tempCanvas.getContext("2d");

                                    ctx.fillStyle = "#FFFFFF";
                                    ctx.fillRect(0, 0, origW, origH);
                                    ctx.drawImage(tempImg, 0, 0);
                                    await applyAdvancedCompression(tempCanvas, quality);

                                    const finalCompressedUrl = tempCanvas.toDataURL("image/jpeg", quality);

                                    if (img.tagName.toUpperCase() === 'IMG') {
                                        img.onload = () => resolve();
                                        img.src = finalCompressedUrl;
                                    } else {
                                        const targetCtx = img.getContext("2d");
                                        targetCtx.clearRect(0, 0, img.width, img.height);
                                        targetCtx.drawImage(tempCanvas, 0, 0);
                                        resolve();
                                    }
                                };
                                tempImg.src = finalSourceSrc;
                            });

                            delete img.dataset.pristine; // Cleanup

                            const ptr = historyPointers[pageIdx] !== undefined ? historyPointers[pageIdx] : -1;
                            let safeState = { rotation: 0, flipH: 1, flipV: 1 };
                            if (ptr >= 0 && pageHistory[pageIdx] && pageHistory[pageIdx][ptr]) {
                                const histItem = pageHistory[pageIdx][ptr];
                                safeState = histItem.state || histItem.edits || { rotation: 0, flipH: 1, flipV: 1 };
                            }

                            if (typeof pushToHistory === 'function') pushToHistory(pageIdx, img.tagName.toUpperCase() === 'IMG' ? img.src : img.toDataURL("image/jpeg", quality), safeState);

                        } catch (err) {
                            console.error("Safely skipped an error while compressing page", pageIdx, err);
                        }
                    }

                    isDirty = true;
                    if (typeof window.showEditorToast === 'function') {
                        const msg = window.pagesToCompress.length > 1 ? `Compressed ${window.pagesToCompress.length} pages to ${quality * 100}%` : `Compressed to ${quality * 100}% Quality`;
                        window.showEditorToast(msg);
                    }

                    compressToolbar.style.display = "none";
                    if (typeof modal !== 'undefined' && modal) {
                        modal.classList.remove("tool-active");
                        modal.classList.remove("is-compressing");
                    }

                    window.pagesToCompress.forEach(idx => {
                        const wrapper = carousel.children[idx];
                        clearToolViewportState(wrapper);
                    });

                    if (typeof window.toggleBottomControls === 'function') window.toggleBottomControls(true);
                    resetZoomState();
                    if (typeof window.applyTransform === 'function') window.applyTransform();
                    if (typeof window.updateSaveButtonState === 'function') window.updateSaveButtonState();
                    if (typeof window.syncAllViews === 'function') window.syncAllViews();
                    if (window.modeBeforeTool === 'grid') window.switchEditorMode('grid');
                    if (typeof window.updateNav === 'function') window.updateNav(typeof currentPdfDoc !== 'undefined' && currentPdfDoc !== null);

                    if (modalView) { modalView.style.transition = 'opacity 0.2s ease'; modalView.style.opacity = '1'; }
                }, 50);
            };
        }
    }
};

window.syncAllViews = () => {
    // 1. Get current active state
    const ptr = historyPointers[activeIndex] !== undefined ? historyPointers[activeIndex] : -1;
    let currentState = { rotation: 0, flipH: 1, flipV: 1 };

    if (ptr >= 0 && pageHistory[activeIndex] && pageHistory[activeIndex][ptr]) {
        const histItem = pageHistory[activeIndex][ptr];
        // Safely check for both names!
        currentState = histItem.state || histItem.edits || { rotation: 0, flipH: 1, flipV: 1 };
    }

    // 2. Construct the CSS Transform string
    const transformString = `rotate(${currentState.rotation || 0}deg) scaleX(${currentState.flipH || 1}) scaleY(${currentState.flipV || 1})`;

    // 3. Force it onto the Carousel image
    if (carousel && carousel.children[activeIndex]) {
        const cImg = carousel.children[activeIndex].querySelector("img, canvas");
        if (cImg) cImg.style.transform = transformString;
    }

    // 4. Force it onto the Grid thumbnail
    if (gridView && gridView.children[activeIndex]) {
        const gImg = gridView.children[activeIndex].querySelector("canvas");
        if (gImg) gImg.style.transform = transformString;
    }
};

window.hasUnsavedEdits = () => {
    if (isDirty) return true;

    const keys = Object.keys(historyPointers);
    for (let k of keys) {
        const ptr = historyPointers[k];

        // ==========================================
        // FIX: Ignore edits if they were already saved as a copy!
        // ==========================================
        if (window.savedCopyStates && window.savedCopyStates.has(`${k}-${ptr}`)) {
            continue; // Skip this one!
        }

        if (ptr > 0 && pageHistory[k] && pageHistory[k][ptr]) {
            const histItem = pageHistory[k][ptr];
            const state = histItem.state || histItem.edits || { rotation: 0, flipH: 1, flipV: 1 };
            const rot = Number(state.rotation) || 0;
            const normRot = ((rot % 360) + 360) % 360;
            if (normRot !== 0 || state.flipH !== 1 || state.flipV !== 1) {
                return true;
            }
        }
    }
    return false;
};
