import JSZip from "jszip";
import { jsPDF } from "jspdf";

import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
import { openImageModal } from './edit.js';
import { PDFDocument } from 'pdf-lib';
import './edit_style.css';
import { initPwaSupport } from "./pwa.js";
import { createImageProcessingClient } from "./workerClient.js";

/* =========================================
   SETUP & GLOBAL STATE
   ========================================= */

const root = document.documentElement;

const welcome = document.getElementById("welcome");
const editor = document.getElementById("editor");
const startBtn = document.getElementById("startBtn");
const backBtn = document.getElementById("backBtn");
const themeToggle = document.getElementById("themeToggle");
const addBtn = document.getElementById("addBtn");
const fileInput = document.getElementById("fileInput");
const gallery = document.getElementById("gallery");
const dropHint = document.getElementById("dropHint");
const rotateBtn = document.getElementById("rotateBtn");
const editBatchBtn = document.getElementById("editBatchBtn");
const exportBtn = document.getElementById("exportBtn");
const removeBtn = document.getElementById("removeBtn");
const selectToggle = document.getElementById("selectToggle");
const galleryExportDialog = document.getElementById("galleryExportDialog");
const galleryExportDialogClose = document.getElementById("galleryExportDialogClose");
const galleryExportBtnCancel = document.getElementById("galleryExportBtnCancel");
const galleryExportBtnDoExport = document.getElementById("galleryExportBtnDoExport");
const galleryExportFormatGrid = document.getElementById("galleryExportFormatGrid");
const galleryExportSummary = document.getElementById("galleryExportSummary");
const galleryExportItemCount = document.getElementById("galleryExportItemCount");
const galleryExportEstimatedSize = document.getElementById("galleryExportEstimatedSize");
const galleryExportProgressContainer = document.getElementById("galleryExportProgressContainer");
const galleryExportProgressText = document.getElementById("galleryExportProgressText");
const galleryExportProgressPercent = document.getElementById("galleryExportProgressPercent");
const galleryExportProgressFill = document.getElementById("galleryExportProgressFill");
const processingClient = createImageProcessingClient();

initPwaSupport();
processingClient.warmup().catch((error) => {
  console.warn("Image processing worker warmup skipped:", error);
});

let selected = new Set();
let dragSelected = new Set();
let lastClickedThumb = null;
let autoScrollRAF = null;
let reorderState = null;
let isFramePending = false;
let dragStartScrollY = 0;
let isDragging = false;
let dragStart = null;
let selectionRect = null;
let dragCounter = 0;
let pendingThumbDrag = null;
let selectedGalleryExportFormat = null;

const GALLERY_EXPORT_FORMATS = {
  pdf: {
    label: "PDF",
    desc: "All images in one file",
    icon: "📄"
  },
  png: {
    label: "PNG",
    desc: "High quality image",
    icon: "🖼️"
  },
  jpg: {
    label: "JPG",
    desc: "Smaller file size",
    icon: "📸"
  },
  "png-zip": {
    label: "PNG (ZIP)",
    desc: "High quality images",
    icon: "🖼️"
  },
  "jpg-zip": {
    label: "JPG (ZIP)",
    desc: "Smaller file size",
    icon: "📸"
  },
  "merge-pdf": {
    label: "Merge PDF",
    desc: "Combine PDFs into one file",
    icon: "📚"
  },
  "pdf-zip": {
    label: "PDF ZIP",
    desc: "Original PDFs in one ZIP",
    icon: "🗂️"
  },
  "mixed-zip": {
    label: "ZIP",
    desc: "Bundle all selected files",
    icon: "🧳"
  }
};

/* =========================================
   REORDER & COPY LOGIC
   ========================================= */

export function startReorder(thumb, e, isCopyMode = false) {
  e.preventDefault();
  e.stopPropagation();

  document.body.classList.remove("drag-selecting");
  gallery.classList.add("is-reordering");

  gallery.style.pointerEvents = "none";
  document.body.style.cursor = isCopyMode ? "copy" : "grabbing";

  // Show Cancel Zone
  const cancelZone = getCancelZone();
  cancelZone.classList.add("active");

  const group = selected.has(thumb) ? Array.from(selected) : [thumb];
  const thumbs = Array.from(gallery.querySelectorAll(".thumb:not(.hidden-thumb)"));
  const groupSet = new Set(group);

  const staticThumbs = isCopyMode
    ? thumbs.filter(t => !t.classList.contains('placeholder'))
    : thumbs.filter(t => !groupSet.has(t));

  const rect = thumb.getBoundingClientRect();

  const placeholder = document.createElement("div");
  placeholder.className = "thumb placeholder";
  placeholder.style.width = rect.width + "px";
  placeholder.style.height = rect.height + "px";

  const startIndex = Math.min(...group.map(t => thumbs.indexOf(t)));
  gallery.insertBefore(placeholder, thumbs[startIndex]);

  if (!isCopyMode) {
    group.forEach(t => {
      t.classList.add("hidden-thumb");
      t.classList.add("reordering");
    });
  }

  const proxy = createDragProxy(group);

  reorderState = {
    group,
    groupSet,
    staticThumbs,
    placeholder,
    proxy,
    isCopyMode,
    offsetX: 0,
    offsetY: 0,
    cancelled: false
  };

  moveProxy(e);

  document.addEventListener("mousemove", onReorderMove);
  document.addEventListener("mouseup", onReorderEnd);
}

function onReorderMove(e) {
  if (!reorderState || !reorderState.proxy) return;

  moveProxy(e);

  // Check collision with Cancel Zone
  const cancelZone = getCancelZone();
  const r = cancelZone.getBoundingClientRect();

  if (e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom) {
    cancelZone.classList.add("hovered");
    reorderState.cancelled = true;
    reorderState.placeholder.style.display = "none";
  } else {
    cancelZone.classList.remove("hovered");
    reorderState.cancelled = false;
    reorderState.placeholder.style.display = "";

    autoScroll(e);
    if (!isFramePending) {
      isFramePending = true;
      requestAnimationFrame(() => {
        if (reorderState && !reorderState.cancelled) resolveInsertion(e);
        isFramePending = false;
      });
    }
  }
}

function onReorderEnd() {
  if (!reorderState || !reorderState.proxy) return;
  const { group, placeholder, proxy, isCopyMode, cancelled } = reorderState;

  const cancelZone = getCancelZone();
  cancelZone.classList.remove("active", "hovered");

  gallery.style.pointerEvents = "";
  document.body.style.cursor = "";

  if (cancelled) {
    if (!isCopyMode) {
      group.forEach(t => {
        t.classList.remove("hidden-thumb", "reordering");
      });
    }
    placeholder.remove();
    proxy.remove();

  } else {
    const orderedGroup = [...group].sort(
      (a, b) => [...gallery.children].indexOf(a) - [...gallery.children].indexOf(b)
    );

    orderedGroup.forEach(t => {
      if (isCopyMode) {
        const clone = t.cloneNode(true);
        clone.classList.remove("selected", "hidden-thumb", "reordering");
        
        clone.dataset.id = Date.now() + Math.random();
        delete clone.dataset.batchId; 

        // 1. Get the absolute root source name
        const sourceName = t.dataset.sourceName || t.dataset.filename || "Unknown";
        
        // 2. Let your built-in function find the next flat number globally
        const newHoverName = generateNextName(sourceName, 'copy');
        
        // 3. Give the clone its new identity
        clone.dataset.sourceName = sourceName; // Keeps the true root alive
        clone.title = newHoverName;

        const isImage = t.dataset.type === "image";
        const fileURL = t.dataset.url;
        const pdfDoc = t.pdfDoc;

        if (t.dataset.type === "pdf") {
          clone.dataset.filename = newHoverName; // Internal name
          const newAccentColor = getRandomAccentColor();
          clone.dataset.accent = newAccentColor;
          // ... 
          const marker = clone.querySelector(".pdf-marker");
          if (marker) {
            marker.setAttribute("data-tooltip", newHoverName);
            if (typeof setupTooltipEvents === "function") setupTooltipEvents(marker, newHoverName);
            const dot = marker.querySelector(".pdf-accent-dot");
            if (dot) dot.style.setProperty("--accent-color", newAccentColor);
          }
          const oldCanvas = t.querySelector('canvas');
          const newCanvas = clone.querySelector('canvas');
          if (oldCanvas && newCanvas) {
              newCanvas.width = oldCanvas.width;
              newCanvas.height = oldCanvas.height;
              const ctx = newCanvas.getContext('2d');
              ctx.drawImage(oldCanvas, 0, 0);
          }
        }
        else if (isImage) {
          clone.dataset.filename = newHoverName; // Internal name
          
          // CRITICAL FIX: Lock the badge! Steal it directly from the parent.
          const oldBadge = t.querySelector(".format-badge");
          const newBadge = clone.querySelector(".format-badge");
          if (oldBadge && newBadge) {
             newBadge.innerHTML = oldBadge.innerHTML; // Keep exact formatting
             newBadge.setAttribute("data-tooltip", newHoverName);
             if (typeof setupTooltipEvents === "function") setupTooltipEvents(newBadge, newHoverName);
          }
          // 2. Handle Extracted PDF Page Badges
          clone.dataset.sourceLabel = t.dataset.sourceLabel;
          const pageBadge = clone.querySelector(".page-badge");
          if (pageBadge && t.dataset.sourceLabel) {
            const label = `Source: ${t.dataset.sourceLabel}`;
            pageBadge.setAttribute("data-tooltip", label);
            if (typeof setupTooltipEvents === "function") setupTooltipEvents(pageBadge, label);
          }
        }
        else if (isImage) {
          clone.dataset.sourceLabel = t.dataset.sourceLabel;
          const badge = clone.querySelector(".page-badge");
          if (badge && t.dataset.sourceLabel) {
            const label = `Source: ${t.dataset.sourceLabel}`;
            badge.setAttribute("data-tooltip", label);
            if (typeof setupTooltipEvents === "function") setupTooltipEvents(badge, label);
          }
        }

        setupThumb(clone, fileURL, isImage, pdfDoc);
        gallery.insertBefore(clone, placeholder);
      } else {
        gallery.insertBefore(t, placeholder);
        t.classList.remove("hidden-thumb", "reordering");
      }
    });
    placeholder.remove();
    proxy.remove();
  }

  gallery.classList.remove("is-reordering");
  reorderState = null;
  document.removeEventListener("mousemove", onReorderMove);
  document.removeEventListener("mouseup", onReorderEnd);

  updateGalleryState();
}

function resolveInsertion(e) {
  const { placeholder, staticThumbs } = reorderState;

  if (!staticThumbs.length) {
    gallery.appendChild(placeholder);
    return;
  }

  const firstRect = staticThumbs[0].getBoundingClientRect();
  if (e.clientY < firstRect.top) {
    if (gallery.firstElementChild !== placeholder) {
      gallery.insertBefore(placeholder, gallery.firstElementChild);
    }
    return;
  }

  const lastRect = staticThumbs[staticThumbs.length - 1].getBoundingClientRect();
  if (e.clientY > lastRect.bottom) {
    if (gallery.lastElementChild !== placeholder) {
      gallery.appendChild(placeholder);
    }
    return;
  }

  const rows = [];
  for (const el of staticThumbs) {
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    let row = rows.find(row => Math.abs(row.cy - cy) < r.height * 0.6);
    if (!row) {
      row = { cy, items: [] };
      rows.push(row);
    }
    row.items.push(el);
  }

  const targetRow = rows.reduce((closest, curr) => {
    const currDist = Math.abs(e.clientY - curr.cy);
    const closestDist = Math.abs(e.clientY - closest.cy);
    return currDist < closestDist ? curr : closest;
  }, rows[0]);

  targetRow.items.sort((a, b) =>
    a.getBoundingClientRect().left - b.getBoundingClientRect().left
  );

  const firstInRow = targetRow.items[0];
  if (e.clientX < firstInRow.getBoundingClientRect().left) {
    const rowIndex = rows.indexOf(targetRow);
    if (rowIndex > 0) {
      const prevRow = rows[rowIndex - 1];
      const lastInPrev = prevRow.items[prevRow.items.length - 1];
      if (placeholder.previousElementSibling !== lastInPrev) {
        gallery.insertBefore(placeholder, lastInPrev.nextSibling);
      }
    } else {
      if (placeholder.nextElementSibling !== firstInRow) {
        gallery.insertBefore(placeholder, firstInRow);
      }
    }
    return;
  }

  for (const el of targetRow.items) {
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left + r.width / 2) {
      if (placeholder.nextElementSibling !== el) {
        gallery.insertBefore(placeholder, el);
      }
      return;
    }
  }

  const lastInRow = targetRow.items[targetRow.items.length - 1];
  if (placeholder.previousElementSibling !== lastInRow) {
    gallery.insertBefore(placeholder, lastInRow.nextSibling);
  }
}

function moveProxy(e) {
  const { proxy, offsetX, offsetY } = reorderState;
  proxy.style.left = e.clientX - offsetX + "px";
  proxy.style.top = e.clientY - offsetY + "px";
}

function createDragProxy(group) {
  const proxy = document.createElement("div");
  proxy.className = "drag-proxy";

  const srcThumb = group[0];
  const media = srcThumb.querySelector("img, canvas");
  const preview = document.createElement("img");

  if (media instanceof HTMLImageElement) {
    preview.src = media.src;
  } else if (media instanceof HTMLCanvasElement) {
    try {
      preview.src = media.toDataURL();
    } catch {
      preview.src = "";
    }
  }

  const r = srcThumb.getBoundingClientRect();
  Object.assign(preview.style, {
    width: r.width + "px",
    height: r.height + "px",
    objectFit: "cover",
    borderRadius: "8px",
    opacity: "0.85",
    pointerEvents: "none"
  });

  proxy.appendChild(preview);

  const count = document.createElement("div");
  count.className = "proxy-count";
  count.textContent = group.length;
  proxy.appendChild(count);

  document.body.appendChild(proxy);
  return proxy;
}

function autoScroll(e) {
  if (autoScrollRAF) return;

  autoScrollRAF = requestAnimationFrame(() => {
    autoScrollRAF = null;
    const margin = 80;
    const speed = 18;
    const y = e.clientY;
    const h = window.innerHeight;

    if (y < margin) {
      window.scrollBy(0, -speed);
    } else if (y > h - margin) {
      window.scrollBy(0, speed);
    }
  });
}

window.addEventListener("blur", () => {
  if (reorderState) onReorderEnd();
});

/* =========================================
   MAIN APP LOGIC
   ========================================= */

function updateActionButtons() {
  const hasSelection = selected.size > 0;
  const selectedThumbs = [...selected];
  const selectedImages = selectedThumbs.filter(t => t.dataset.type === "image");
  const selectedPDFs = selectedThumbs.filter(t => t.dataset.type === "pdf");
  const hasImageOnlySelection = hasSelection && selectedImages.length === selectedThumbs.length;
  const hasSinglePDFSelection = selectedThumbs.length === 1 && selectedPDFs.length === 1;
  removeBtn.disabled = !hasSelection;
  exportBtn.disabled = !hasSelection;
  rotateBtn.disabled = !hasImageOnlySelection;
  if (editBatchBtn) editBatchBtn.disabled = !(hasImageOnlySelection || hasSinglePDFSelection);
}

rotateBtn?.addEventListener("click", async () => {
  if (rotateBtn.disabled) return;

  const imageThumbs = [...selected].filter(t => t.dataset.type === "image");
  if (imageThumbs.length === 0) return;

  rotateBtn.disabled = true;

  try {
    for (const thumb of imageThumbs) {
      await rotateImageThumb(thumb);
    }
  } catch (err) {
    console.error("Failed to rotate selected images:", err);
    alert("One or more images could not be rotated.");
  } finally {
    updateActionButtons();
  }
});

editBatchBtn?.addEventListener("click", () => {
  if (editBatchBtn.disabled) return;

  const selectedThumbs = Array.from(selected);
  if (selectedThumbs.length === 1) {
    selectedThumbs[0].querySelector(".edit-btn")?.click();
    return;
  }

  const imageThumbs = getSelectedImageThumbsInGalleryOrder();
  if (imageThumbs.length === 0) return;

  openImageModal(null, false, null, {
    batchThumbs: imageThumbs,
    onBatchSave: saveBatchImagesToOriginals
  });
});

exportBtn?.addEventListener("click", () => {
  if (exportBtn.disabled) return;
  openGalleryExportDialog();
});

galleryExportDialogClose?.addEventListener("click", closeGalleryExportDialog);
galleryExportBtnCancel?.addEventListener("click", closeGalleryExportDialog);
galleryExportDialog?.addEventListener("click", (e) => {
  if (e.target === galleryExportDialog) closeGalleryExportDialog();
});
galleryExportBtnDoExport?.addEventListener("click", async () => {
  if (!selectedGalleryExportFormat) return;

  galleryExportBtnDoExport.disabled = true;
  try {
    await performGalleryExport(selectedGalleryExportFormat);
    closeGalleryExportDialog();
  } catch (error) {
    console.error("Gallery export failed:", error);
    alert("Export failed: " + error.message);
  } finally {
    hideGalleryExportProgress();
    galleryExportBtnDoExport.disabled = false;
  }
});

/* ---------- DRAG / CLICK CONTROLLER ---------- */
document.addEventListener("mousemove", (e) => {
  if (!pendingThumbDrag || pendingThumbDrag.hasStarted) return;

  const dx = Math.abs(e.clientX - pendingThumbDrag.startX);
  const dy = Math.abs(e.clientY - pendingThumbDrag.startY);

  if (dx > 5 || dy > 5) {
    pendingThumbDrag.hasStarted = true;
    const { thumb } = pendingThumbDrag;

    if (selected.has(thumb)) {
      startReorder(thumb, e, false);
    } else {
      pendingThumbDrag = null;
    }
  }
});

document.addEventListener("mouseup", () => {
  pendingThumbDrag = null;
});

const THEME_KEY = "theme";
function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
}

// A helper function that guarantees the icon changes whether you use <i> tags or emojis!
function updateThemeIcon(theme) {
    const themeBtn = document.getElementById("themeToggle"); 
    if (!themeBtn) return;
    
    const icon = themeBtn.querySelector("i");
    if (icon) {
        // If you are using FontAwesome
        if (theme === "dark") {
            icon.className = "fas fa-moon"; // (Change 'fas' to 'fa-solid' or 'bx' if you use a different icon library)
        } else {
            icon.className = "fas fa-sun";
        }
    } else {
        // Fallback: If there is no <i> tag, just use emojis!
        themeBtn.innerHTML = theme === "dark" ? "🌙" : "☀️";
    }
}

function toggleTheme() {
    const newTheme = root.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(newTheme);
    updateThemeIcon(newTheme); // Update on click
}

// Auto-run when the page loads
(() => {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initialTheme = saved || (prefersDark ? "dark" : "light");
  
  applyTheme(initialTheme);
  
  // FIX: Force the icon to perfectly match the theme the second the page loads!
  document.addEventListener("DOMContentLoaded", () => {
      updateThemeIcon(initialTheme);
  });
})();
themeToggle?.addEventListener("click", toggleTheme);

startBtn?.addEventListener("click", showEditor);
backBtn?.addEventListener("click", showWelcome);
addBtn?.addEventListener("click", () => fileInput.click());
dropHint?.addEventListener("click", () => fileInput.click());

fileInput?.addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  files.forEach(addFile);
  fileInput.value = "";
});

function clearSelection() {
  selected.forEach(t => t.classList.remove("selected"));
  selected.clear();
  updateActionButtons();
  updateSelectionInfo();
}

function revokeThumbUrl(thumb) {
  if (thumb.dataset.url) {
    URL.revokeObjectURL(thumb.dataset.url);
    thumb.dataset.url = "";
  }
}

async function setThumbFileSizeFromUrl(thumb) {
  if (!thumb?.dataset?.url) return;
  try {
    const blob = await fetchBlobFromUrl(thumb.dataset.url);
    thumb.dataset.fileSize = String(blob.size);
    updateThumbMeta(thumb);
  } catch (error) {
    console.error("Failed to read thumb size", error);
  }
}

function getSelectedImageThumbsInGalleryOrder() {
  return Array.from(gallery.querySelectorAll(".thumb")).filter(
    thumb => selected.has(thumb) && thumb.dataset.type === "image"
  );
}

function getSelectedThumbsInGalleryOrder() {
  return Array.from(gallery.querySelectorAll(".thumb")).filter(
    thumb => selected.has(thumb)
  );
}

function classifyGallerySelection(thumbs) {
  if (thumbs.length === 0) return "none";

  const imageCount = thumbs.filter(t => t.dataset.type === "image").length;
  const pdfCount = thumbs.filter(t => t.dataset.type === "pdf").length;

  if (imageCount === thumbs.length) return "image-only";
  if (pdfCount === thumbs.length) return "pdf-only";
  return "mixed";
}

function getGalleryExportFormats(selectionType) {
  const thumbs = getSelectedThumbsInGalleryOrder();
  if (selectionType === "image-only") return thumbs.length === 1 ? ["pdf", "png", "jpg"] : ["pdf", "png-zip", "jpg-zip"];
  if (selectionType === "pdf-only") return ["merge-pdf", "pdf-zip"];
  if (selectionType === "mixed") return ["mixed-zip"];
  return [];
}

let galleryExportEstimateToken = 0;

async function openGalleryExportDialog() {
  const thumbs = getSelectedThumbsInGalleryOrder();
  const selectionType = classifyGallerySelection(thumbs);
  const formats = getGalleryExportFormats(selectionType);
  if (!thumbs.length || !formats.length) return;

  selectedGalleryExportFormat = formats[0];
  renderGalleryExportFormats(formats);
  await updateGalleryExportInfo(thumbs, selectionType, selectedGalleryExportFormat);
  if (galleryExportDialog) galleryExportDialog.style.display = "flex";
}

function closeGalleryExportDialog() {
  if (galleryExportDialog) galleryExportDialog.style.display = "none";
  selectedGalleryExportFormat = null;
  hideGalleryExportProgress();
}

function renderGalleryExportFormats(formats) {
  if (!galleryExportFormatGrid) return;

  galleryExportFormatGrid.innerHTML = "";

  formats.forEach((format) => {
    const currentThumbs = getSelectedThumbsInGalleryOrder();
    const selectionType = classifyGallerySelection(currentThumbs);
    const config = getGalleryExportFormatConfig(format, selectionType, currentThumbs.length);
    if (!config) return;

    const button = document.createElement("button");
    button.className = `export-format-btn${format === selectedGalleryExportFormat ? " active" : ""}`;
    button.type = "button";
    button.dataset.format = format;
    button.innerHTML = `
      <div class="format-icon">${config.icon}</div>
      <div class="format-name">${config.label}</div>
      ${config.desc ? `<div class="format-desc">${config.desc}</div>` : ""}
    `;

    button.addEventListener("click", async () => {
      selectedGalleryExportFormat = format;
      renderGalleryExportFormats(formats);
      const thumbs = getSelectedThumbsInGalleryOrder();
      await updateGalleryExportInfo(thumbs, classifyGallerySelection(thumbs), format);
    });

    galleryExportFormatGrid.appendChild(button);
  });
}

function getGalleryExportFormatConfig(format, selectionType, count) {
  const base = GALLERY_EXPORT_FORMATS[format];
  if (!base) return null;

  if (format === "merge-pdf" && selectionType === "pdf-only" && count === 1) {
    return {
      ...base,
      label: "PDF",
      desc: ""
    };
  }

  return base;
}

async function updateGalleryExportInfo(thumbs, selectionType, format) {
  if (galleryExportSummary) {
    galleryExportSummary.textContent = getGalleryExportSummaryText(selectionType, thumbs.length);
  }

  if (galleryExportItemCount) {
    galleryExportItemCount.textContent = `Items: ${thumbs.length}`;
  }

  if (galleryExportEstimatedSize) {
    const token = ++galleryExportEstimateToken;
    galleryExportEstimatedSize.textContent = "Est. Size: calculating...";
    try {
      const estimateText = await getGalleryExportEstimateText(thumbs, format);
      if (token !== galleryExportEstimateToken) return;
      galleryExportEstimatedSize.textContent = estimateText;
    } catch {
      if (token !== galleryExportEstimateToken) return;
      galleryExportEstimatedSize.textContent = "Est. Size: unavailable";
    }
  }
}

function getGalleryExportSummaryText(selectionType, count) {
  if (selectionType === "image-only") {
    return `${count} image${count === 1 ? "" : "s"} selected. Export as one PDF or as converted image ZIPs.`;
  }
  if (selectionType === "pdf-only") {
    return `${count} PDF${count === 1 ? "" : "s"} selected. Merge them into one PDF or package the originals in a ZIP.`;
  }
  if (selectionType === "mixed") {
    return `${count} mixed items selected. ZIP keeps each image and PDF as separate files in one download.`;
  }
  return "";
}

async function getGalleryExportEstimateText(thumbs, format) {
  const estimatedBytes = await estimateGalleryExportBytes(thumbs, format);
  return `Est. Size: ${formatBytes(estimatedBytes)}`;
}

async function performGalleryExport(format) {
  const thumbs = getSelectedThumbsInGalleryOrder();
  if (!thumbs.length) throw new Error("No items selected");

  showGalleryExportProgress();

  if (format === "pdf") {
    await exportGalleryImagesAsPdf(thumbs);
  } else if (format === "png") {
    await exportGalleryImages(thumbs, "png");
  } else if (format === "jpg") {
    await exportGalleryImages(thumbs, "jpg");
  } else if (format === "png-zip") {
    await exportGalleryImagesAsZip(thumbs, "png");
  } else if (format === "jpg-zip") {
    await exportGalleryImagesAsZip(thumbs, "jpg");
  } else if (format === "merge-pdf") {
    await exportGalleryMergedPdf(thumbs);
  } else if (format === "pdf-zip" || format === "mixed-zip") {
    await exportGalleryOriginalsAsZip(thumbs);
  } else {
    throw new Error("Unsupported export format");
  }
}

async function exportGalleryImagesAsPdf(thumbs) {
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4"
  });

  for (let i = 0; i < thumbs.length; i++) {
    const canvas = await getThumbCanvasForExport(thumbs[i], "image/jpeg");
    const imgData = canvas.toDataURL("image/jpeg", 0.9);
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pdfWidth / canvas.width, pdfHeight / canvas.height);
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;
    const x = (pdfWidth - width) / 2;
    const y = (pdfHeight - height) / 2;

    if (i > 0) pdf.addPage();
    pdf.addImage(imgData, "JPEG", x, y, width, height);
    updateGalleryExportProgress(i + 1, thumbs.length, "Building PDF");
  }

  pdf.save(`${getGalleryExportBaseName(thumbs)}.pdf`);
}

async function exportGalleryImagesAsZip(thumbs, format) {
  const zip = new JSZip();
  const folderName = getGalleryExportBaseName(thumbs);
  const folder = zip.folder(folderName);
  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  const quality = format === "png" ? 1 : 0.85;

  for (let i = 0; i < thumbs.length; i++) {
    const thumb = thumbs[i];
    const canvas = await getThumbCanvasForExport(thumb, mimeType);
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const base64 = dataUrl.split(",")[1];
    const filename = window.formatNameForExport(getThumbExportName(thumb), format);
    folder.file(filename, base64, { base64: true });
    updateGalleryExportProgress(i + 1, thumbs.length, `Packing ${format.toUpperCase()} ZIP`);
  }

  await downloadZipBlob(await zip.generateAsync({ type: "blob" }), `${folderName}.zip`);
}

async function exportGalleryMergedPdf(thumbs) {
  if (thumbs.length === 1) {
    const blob = await fetchBlobFromUrl(thumbs[0].dataset.url);
    downloadBlob(blob, `${getGalleryExportBaseName(thumbs)}.pdf`);
    return;
  }

  const mergedPdf = await PDFDocument.create();

  for (let i = 0; i < thumbs.length; i++) {
    const thumb = thumbs[i];
    const sourceBytes = await fetchArrayBuffer(thumb.dataset.url);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const pageIndices = sourcePdf.getPageIndices();
    const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndices);
    copiedPages.forEach((page) => mergedPdf.addPage(page));
    updateGalleryExportProgress(i + 1, thumbs.length, "Merging PDFs");
  }

  const bytes = await mergedPdf.save();
  downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${getGalleryExportBaseName(thumbs)}.pdf`);
}

async function exportGalleryOriginalsAsZip(thumbs) {
  const zip = new JSZip();
  const folderName = getGalleryExportBaseName(thumbs);
  const folder = zip.folder(folderName);

  for (let i = 0; i < thumbs.length; i++) {
    const thumb = thumbs[i];
    const blob = await fetchBlobFromUrl(thumb.dataset.url);
    const extension = getThumbFileExtension(thumb);
    const filename = window.formatNameForExport(getThumbExportName(thumb), extension);
    folder.file(filename, blob);
    updateGalleryExportProgress(i + 1, thumbs.length, "Packing ZIP");
  }

  await downloadZipBlob(await zip.generateAsync({ type: "blob" }), `${folderName}.zip`);
}

async function estimateGalleryExportBytes(thumbs, format) {
  if (!thumbs.length) return 0;

  if (format === "pdf") {
    return await estimateGalleryPdfBytes(thumbs);
  }

  if (format === "merge-pdf") {
    return thumbs.length === 1
      ? (await fetchBlobFromUrl(thumbs[0].dataset.url)).size
      : await estimateMergedPdfBytes(thumbs);
  }

  let totalBytes = 0;

  for (const thumb of thumbs) {
    if (format === "png-zip") {
      totalBytes += await estimateThumbExportBytes(thumb, "image/png", 1) + 256;
      continue;
    }

    if (format === "png") {
      totalBytes += await estimateThumbExportBytes(thumb, "image/png", 1);
      continue;
    }

    if (format === "jpg-zip") {
      totalBytes += await estimateThumbExportBytes(thumb, "image/jpeg", 0.85) + 256;
      continue;
    }

    if (format === "jpg") {
      totalBytes += await estimateThumbExportBytes(thumb, "image/jpeg", 0.85);
      continue;
    }

    const blob = await fetchBlobFromUrl(thumb.dataset.url);
    totalBytes += blob.size + 256;
  }

  return totalBytes;
}

async function exportGalleryImages(thumbs, format) {
  const thumb = thumbs[0];
  if (!thumb) throw new Error("No image selected");

  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  const quality = format === "png" ? 1 : 0.85;
  const blob = await getThumbBlobForExport(thumb, mimeType, quality);
  const filename = window.formatNameForExport(getThumbExportName(thumb), format);
  downloadBlob(blob, filename);
}

async function estimateGalleryPdfBytes(thumbs) {
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4"
  });

  for (let i = 0; i < thumbs.length; i++) {
    const canvas = await getThumbCanvasForExport(thumbs[i], "image/jpeg");
    const imgData = canvas.toDataURL("image/jpeg", 0.9);
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pdfWidth / canvas.width, pdfHeight / canvas.height);
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;
    const x = (pdfWidth - width) / 2;
    const y = (pdfHeight - height) / 2;

    if (i > 0) pdf.addPage();
    pdf.addImage(imgData, "JPEG", x, y, width, height);
  }

  return pdf.output("blob").size;
}

async function estimateMergedPdfBytes(thumbs) {
  const mergedPdf = await PDFDocument.create();

  for (const thumb of thumbs) {
    const sourceBytes = await fetchArrayBuffer(thumb.dataset.url);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const pageIndices = sourcePdf.getPageIndices();
    const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndices);
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  const bytes = await mergedPdf.save();
  return bytes.length || bytes.byteLength || 0;
}

async function estimateThumbExportBytes(thumb, mimeType = "image/png", quality = 1) {
  const image = await loadImageElement(thumb.dataset.url);
  const normalizedQuality = mimeType === "image/png" ? 1 : Math.max(0.1, Math.min(1, quality || 0.85));

  try {
    const { estimatedBytes } = await processingClient.estimateImageBytes({
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
      quality: normalizedQuality,
      mimeType
    });

    const multiplier = mimeType === "image/png" ? 1.35 : 1;
    return Math.max(1, Math.round(estimatedBytes * multiplier));
  } catch {
    const blob = await getThumbBlobForExport(thumb, mimeType, normalizedQuality);
    return blob.size;
  }
}

async function getThumbCanvasForExport(thumb, mimeType = "image/png") {
  const image = await loadImageElement(thumb.dataset.url);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d");
  if (mimeType === "image/jpeg") {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function getThumbBlobForExport(thumb, mimeType = "image/png", quality = 1) {
  const canvas = await getThumbCanvasForExport(thumb, mimeType);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas export failed"));
    }, mimeType, quality);
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getDisplayExtensionForThumb(thumb) {
  if (!thumb) return "";
  const name = thumb.dataset.filename || "";
  if (name.includes(".")) return "";

  const ext = getThumbFileExtension(thumb);
  return ext ? `.${ext}` : "";
}

function getThumbTooltipText(thumb) {
  const fileName = thumb?.dataset?.filename || thumb?.dataset?.sourceName || "Untitled";
  const extension = getDisplayExtensionForThumb(thumb);
  const sizeBytes = Number(thumb?.dataset?.fileSize || 0);
  const sizeText = sizeBytes > 0 ? formatBytes(sizeBytes) : "calculating...";
  return `${fileName}${extension} • ${sizeText}`;
}

function refreshThumbTooltips(thumb) {
  if (!thumb) return;
  const tooltipText = getThumbTooltipText(thumb);
  thumb.querySelectorAll(".format-badge, .page-badge, .pdf-marker").forEach((el) => {
    el.dataset.tooltipText = tooltipText;
    el.setAttribute("data-tooltip", tooltipText);
  });
}

function updateThumbMeta(thumb) {
  if (!thumb) return;
  thumb.querySelector(".thumb-meta")?.remove();
  refreshThumbTooltips(thumb);
}

function getGalleryExportBaseName(thumbs) {
  const first = thumbs[0];
  const base = getThumbExportName(first) || "export";
  const safeBase = base.replace(/[\.\s]+/g, "_");
  return thumbs.length > 1 ? `${safeBase}_bundle` : safeBase;
}

function getThumbExportName(thumb) {
  return thumb.dataset.filename || thumb.dataset.sourceName || `item_${thumb.dataset.id || Date.now()}`;
}

function getThumbFileExtension(thumb) {
  const mimeType = thumb.dataset.mimeType || "";
  if (thumb.dataset.type === "pdf") return "pdf";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";

  const fileName = getThumbExportName(thumb);
  const ext = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
  return ext || "bin";
}

function showGalleryExportProgress() {
  if (galleryExportProgressContainer) galleryExportProgressContainer.style.display = "block";
  if (galleryExportProgressFill) galleryExportProgressFill.style.width = "0%";
  if (galleryExportProgressPercent) galleryExportProgressPercent.textContent = "0%";
  if (galleryExportProgressText) galleryExportProgressText.textContent = "Preparing export...";
}

function hideGalleryExportProgress() {
  if (galleryExportProgressContainer) galleryExportProgressContainer.style.display = "none";
}

function updateGalleryExportProgress(current, total, label) {
  const percent = Math.round((current / total) * 100);
  if (galleryExportProgressPercent) galleryExportProgressPercent.textContent = `${percent}%`;
  if (galleryExportProgressFill) galleryExportProgressFill.style.width = `${percent}%`;
  if (galleryExportProgressText) {
    galleryExportProgressText.textContent = `${label}: ${current} of ${total}`;
  }
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url);
  return await response.arrayBuffer();
}

async function fetchBlobFromUrl(url) {
  const response = await fetch(url);
  return await response.blob();
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

async function downloadZipBlob(blob, filename) {
  downloadBlob(blob, filename);
}

async function rotateImageThumb(thumb) {
  if (!thumb || thumb.dataset.type !== "image" || !thumb.dataset.url) return;

  const sourceUrl = thumb.dataset.url;
  const mimeType = thumb.dataset.mimeType || "image/png";
  const img = await loadImageElement(sourceUrl);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalHeight || img.height;
  canvas.height = img.naturalWidth || img.width;

  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -(img.naturalWidth || img.width) / 2, -(img.naturalHeight || img.height) / 2);

  const rotatedBlob = await canvasToBlob(canvas, mimeType);
  const rotatedUrl = URL.createObjectURL(rotatedBlob);

  thumb.dataset.url = rotatedUrl;
  thumb.dataset.mimeType = rotatedBlob.type || mimeType;
  thumb.dataset.fileSize = String(rotatedBlob.size || 0);
  delete thumb._editorState;

  const thumbImg = thumb.querySelector("img");
  if (thumbImg) {
    thumbImg.src = rotatedUrl;
  }

  URL.revokeObjectURL(sourceUrl);
}

async function saveBatchImagesToOriginals(batchThumbs, pageBlobs) {
  for (let i = 0; i < batchThumbs.length; i++) {
    const thumb = batchThumbs[i];
    const blob = pageBlobs[i];
    if (!thumb || !blob) continue;
    await overwriteImageThumbFromBlob(thumb, blob);
  }
}

async function overwriteImageThumbFromBlob(thumb, blob) {
  if (!thumb || !blob) return;

  const oldUrl = thumb.dataset.url;
  const newUrl = URL.createObjectURL(blob);

  thumb.dataset.url = newUrl;
  if (blob.type) thumb.dataset.mimeType = blob.type;
  thumb.dataset.fileSize = String(blob.size || 0);
  delete thumb._editorState;

  if (thumb.dataset.isExtractedPage) {
    delete thumb.dataset.isExtractedPage;
    delete thumb.dataset.pdfPageIndex;
    delete thumb.pdfDoc;
    thumb.dataset.type = "image";
  }

  const img = thumb.querySelector("img");
  if (img) {
    img.src = await createThumbPreviewFromBlob(blob);
  }

  updateThumbMeta(thumb);

  if (oldUrl) URL.revokeObjectURL(oldUrl);
}

function createThumbPreviewFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const tempUrl = URL.createObjectURL(blob);
    const tempImg = new Image();

    tempImg.onload = () => {
      const scale = Math.min(300 / tempImg.width, 300 / tempImg.height, 1);
      const canvas = document.createElement("canvas");
      canvas.width = tempImg.width * scale;
      canvas.height = tempImg.height * scale;

      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);

      URL.revokeObjectURL(tempUrl);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };

    tempImg.onerror = () => {
      URL.revokeObjectURL(tempUrl);
      reject(new Error("Failed to build thumbnail preview"));
    };

    tempImg.src = tempUrl;
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to load"));
    img.src = src;
  });
}

function canvasToBlob(canvas, mimeType) {
  const exportType = ["image/jpeg", "image/png", "image/webp"].includes(mimeType)
    ? mimeType
    : "image/png";

  const quality = exportType === "image/jpeg" || exportType === "image/webp" ? 0.92 : undefined;

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Canvas export failed"));
      }
    }, exportType, quality);
  });
}

function setupThumb(thumb, fileURL, isImage, pdfDoc = null) {
  if (pdfDoc) thumb.pdfDoc = pdfDoc;
  updateThumbMeta(thumb);

  // 1. Checkbox Toggle Logic
  const checkbox = thumb.querySelector(".select-box");
  if (checkbox) {
    checkbox.onclick = (e) => {
      e.stopPropagation();
      toggleSelection(thumb);
    };
  }

  // 2. Cleanup Old Buttons
  thumb.querySelectorAll(".move-btn, .thumb-btn, .extend-btn, .pdf-menu-container").forEach(el => el.remove());

  // 3. NEW: Vertical Three Dot Menu for PDF Options
  if (!isImage && thumb.dataset.type === "pdf") {
    const menuContainer = document.createElement("div");
    menuContainer.className = "pdf-menu-container";
    menuContainer.addEventListener("mousedown", (e) => e.stopPropagation());

    const menuBtn = document.createElement("button");
    menuBtn.className = "pdf-menu-btn";
    menuBtn.innerHTML = "&#8942;"; // Vertical ellipsis
    menuBtn.title = "Options";

    const dropdown = document.createElement("div");
    dropdown.className = "pdf-menu-dropdown";

    const extractOption = document.createElement("button");
    extractOption.className = "pdf-menu-option extract-btn"; 
    extractOption.textContent = "Extract Pages";
    extractOption.onclick = (e) => {
      e.stopPropagation();
      dropdown.classList.remove("show");
      extractPDFPages(thumb); 
    };

    menuBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".pdf-menu-dropdown.show").forEach(d => {
        if (d !== dropdown) d.classList.remove("show");
      });
      dropdown.classList.toggle("show");
    };

    if (!window.pdfMenuListenerAdded) {
      document.addEventListener("click", () => {
        document.querySelectorAll(".pdf-menu-dropdown.show").forEach(d => d.classList.remove("show"));
      });
      window.pdfMenuListenerAdded = true;
    }

    dropdown.appendChild(extractOption);
    menuContainer.appendChild(menuBtn);
    menuContainer.appendChild(dropdown);
    thumb.appendChild(menuContainer);
  }

  thumb.draggable = false;

  // 4. Copy Button
  const copyBtn = document.createElement("div");
  copyBtn.className = "move-btn copy-action-btn";
  copyBtn.title = "Copy and Reorder";
  copyBtn.innerHTML = "📋";
  copyBtn.draggable = false;

  copyBtn.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    startReorder(thumb, e, true);
  });

  // 5. Close Button
  const closeBtn = document.createElement("button");
  closeBtn.className = "thumb-btn close-btn";
  closeBtn.title = "Remove";
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    revokeThumbUrl(thumb);
    thumb.remove();
    selected.delete(thumb);
    updateDropHintVisibility();
    updateGalleryState();
  };

  const handleSave = async (originalThumb, isPdf, saveMode, editedBlob, activeIndex) => {
    const currentName = originalThumb.dataset.filename || "Untitled";
    let finalBlob = editedBlob;
    let finalType = isPdf ? "pdf" : "image";

    if (saveMode === 'extract_image') {
        // 1. Figure out the root name of this specific page
        const pageBaseName = `${currentName} page_${activeIndex + 1}`;
        
        // 2. Generate the next copy number (e.g., "doc.pdf page_1 copy_1")
        const newName = generateNextName(pageBaseName, 'copy');
        
        const newFile = new File([editedBlob], newName, { type: 'image/jpeg' });
        
        // Pass the badge options and the new pageBaseName as the ultimate source
        addFileFromEditor(newFile, newName, "image", originalThumb, {
            sourceName: pageBaseName 
        });
        return; 
    }

    // --- PDF MANIPULATION ---
    if (isPdf) {
        try {
            // 1. Fetch original PDF
            const origRes = await fetch(originalThumb.dataset.url);
            const origBuffer = await origRes.arrayBuffer();
            const pdfDoc = await PDFDocument.load(origBuffer);

            // 2. Embed the newly edited image dynamically
            const imgBuffer = await editedBlob.arrayBuffer();
            let image;
            if (editedBlob.type === 'image/jpeg') {
                image = await pdfDoc.embedJpg(imgBuffer);
            } else {
                image = await pdfDoc.embedPng(imgBuffer);
            }

            // ==========================================
            // FIX: Smart Aspect-Ratio Scaling
            // This prevents BOTH stretching and resolution explosions!
            // ==========================================
            const oldPage = pdfDoc.getPage(activeIndex);
            const { width: oldW, height: oldH } = oldPage.getSize(); 
            
            // Find the maximum physical paper size of the original page
            const maxPhysicalSize = Math.max(oldW, oldH);
            
            // Calculate how much we need to shrink the crisp canvas image 
            // so it perfectly fits within normal PDF paper dimensions
            let scaleFactor = 1;
            if (image.width >= image.height) {
                scaleFactor = maxPhysicalSize / image.width;
            } else {
                scaleFactor = maxPhysicalSize / image.height;
            }
            
            // Apply the perfect proportional scale
            const finalPdfWidth = image.width * scaleFactor;
            const finalPdfHeight = image.height * scaleFactor;

            // 3. Replace the page with the newly calculated dimensions
            pdfDoc.removePage(activeIndex);
            const newPage = pdfDoc.insertPage(activeIndex, [finalPdfWidth, finalPdfHeight]);
            
            // Draw it! It will never stretch, and never explode in size.
            newPage.drawImage(image, { x: 0, y: 0, width: finalPdfWidth, height: finalPdfHeight });

            // 4. Save as new PDF Blob
            const newPdfBytes = await pdfDoc.save();
            finalBlob = new Blob([newPdfBytes], { type: 'application/pdf' });
        } catch (err) {
            console.error("Error modifying PDF:", err);
            alert("Failed to update PDF document.");
            return;
        }
    }

    // --- SAVE LOGIC ---
    if (saveMode === 'copy') {
        const sourceName = originalThumb.dataset.sourceName || originalThumb.dataset.filename || "Unknown";
        const newHoverName = generateNextName(sourceName, 'copy'); 

        // ==========================================
        // FIX: Use 'finalBlob' and 'finalType' instead of undefined variables!
        // This allows your pdf-lib engine to successfully save a real PDF copy!
        // ==========================================
        const newFile = new File([finalBlob], newHoverName, { type: finalBlob.type });
        
        addFileFromEditor(newFile, newHoverName, finalType, originalThumb, {
             isEditCopy: true, 
             sourceName: sourceName 
        });
    }
    else {
      // Overwrite Original
      if (originalThumb.dataset.url) URL.revokeObjectURL(originalThumb.dataset.url);
      
      const newUrl = URL.createObjectURL(finalBlob);
      originalThumb.dataset.url = newUrl; // Keep the high-res file safe in memory!
      originalThumb.dataset.fileSize = String(finalBlob.size || 0);

      if (isPdf) {
          // Update the PDF memory and render the new first page
          pdfjsLib.getDocument(newUrl).promise.then(pdf => {
              originalThumb.pdfDoc = pdf; 
              pdf.getPage(1).then(page => {
                  const canvas = originalThumb.querySelector('canvas.pdf-preview');
                  if (canvas) {
                      // ==========================================
                      // FIX: Cap PDF Gallery Thumb to 300px exactly!
                      // ==========================================
                      const viewport = page.getViewport({ scale: 1 });
                      const scale = Math.min(300 / viewport.width, 300 / viewport.height, 1);
                      const thumbViewport = page.getViewport({ scale: scale });

                      canvas.width = thumbViewport.width;
                      canvas.height = thumbViewport.height;
                      page.render({ canvasContext: canvas.getContext("2d"), viewport: thumbViewport });
                  }
              });
          });
          updateThumbMeta(originalThumb);
      } else {
          await overwriteImageThumbFromBlob(originalThumb, finalBlob);
        }
    }
  };

  // 2. Edit Button (Click)
  const editBtn = document.createElement("button");
  editBtn.className = "thumb-btn edit-btn";
  editBtn.title = "Edit";
  editBtn.onclick = async (e) => {
    e.stopPropagation();
    
    // 1. MAIN PDF DOC
    if (thumb.dataset.type === "pdf" && !thumb.dataset.isExtractedPage) {
      if (!thumb.pdfDoc) {
          document.body.style.cursor = "wait";
          try {
              // Ensure pdfjsLib is available in this file's scope
              const loadingTask = pdfjsLib.getDocument(thumb.dataset.url);
              thumb.pdfDoc = await loadingTask.promise;
          } catch (err) {
              console.error("Failed to parse copied PDF", err);
          }
          document.body.style.cursor = "default";
      }
      openImageModal(thumb.pdfDoc, true, thumb, { onSave: handleSave });
    } 
    // 2. EXTRACTED PDF PAGE (On-Demand High-Res)
    else if (thumb.dataset.isExtractedPage === "true" && thumb.pdfDoc) {
      document.body.style.cursor = "wait"; 
      try {
        const pageNum = parseInt(thumb.dataset.pdfPageIndex);
        const page = await thumb.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 3.0 }); 
        
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        
        canvas.toBlob((blob) => {
          const highResUrl = URL.createObjectURL(blob);
          openImageModal(highResUrl, false, thumb, { onSave: handleSave });
          document.body.style.cursor = "default";
        }, "image/png");
      } catch (err) {
        console.error("Failed to load high-res page", err);
        document.body.style.cursor = "default";
      }
    } 
    // 3. STANDARD IMAGE (Safety Net)
    else {
      const tempImg = new Image();
      tempImg.onload = () => {
        openImageModal(thumb.dataset.url, false, thumb, { onSave: handleSave });
      };
      tempImg.onerror = () => {
        alert("Image memory was cleared by the browser. Please re-import the file.");
      };
      tempImg.src = thumb.dataset.url; // Triggers the load
    }
  };

  // 3. Thumbnail (Double Click) 
  thumb.addEventListener("dblclick", async (e) => {
    e.stopPropagation();

    // List all the classes/tags you want to protect here
    const ignoredElements = '.select-box, button, .format-badge, .page-badge, .pdf-marker, .action-btn, .extract-btn';
    
    // If the click happened on or inside any of those elements, stop immediately!
    if (e.target.closest(ignoredElements)) {
      return; 
    }

    // 1. MAIN PDF DOC
    if (thumb.dataset.type === "pdf" && !thumb.dataset.isExtractedPage) {
      openImageModal(thumb.pdfDoc, true, thumb, { onSave: handleSave });
    } 
    // 2. EXTRACTED PDF PAGE (On-Demand High-Res)
    else if (thumb.dataset.isExtractedPage === "true" && thumb.pdfDoc) {
      document.body.style.cursor = "wait"; 
      try {
        const pageNum = parseInt(thumb.dataset.pdfPageIndex);
        const page = await thumb.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 3.0 }); 
        
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        
        canvas.toBlob((blob) => {
          const highResUrl = URL.createObjectURL(blob);
          openImageModal(highResUrl, false, thumb, { onSave: handleSave });
          document.body.style.cursor = "default";
        }, "image/png");
      } catch (err) {
        console.error("Failed to load high-res page", err);
        document.body.style.cursor = "default";
      }
    } 
    // 3. STANDARD IMAGE (Safety Net)
    else {
      const tempImg = new Image();
      tempImg.onload = () => {
        openImageModal(thumb.dataset.url, false, thumb, { onSave: handleSave });
      };
      tempImg.onerror = () => {
        alert("Image memory was cleared by the browser. Please re-import the file.");
      };
      tempImg.src = thumb.dataset.url; 
    }
  });

  /* ... append buttons to thumb ... */
  thumb.append(copyBtn, closeBtn, editBtn);

  thumb.addEventListener("mousedown", (e) => {
    if (e.target.closest("button") || e.target.closest(".move-btn") || e.target.closest(".extract-btn")) return;

    if (selected.has(thumb)) {
      e.stopPropagation();
      pendingThumbDrag = {
        thumb,
        startX: e.clientX,
        startY: e.clientY,
        hasStarted: false
      };
    }
  });

  thumb.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest(".move-btn") || e.target.closest(".extract-btn")) return;
    if (pendingThumbDrag && pendingThumbDrag.hasStarted) return;

    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const isCtrl = isMac ? e.metaKey : e.ctrlKey;

    if (e.shiftKey && lastClickedThumb) {
      selectRange(lastClickedThumb, thumb);
    } else if (isCtrl) {
      toggleSelection(thumb);
    } else {
      clearSelection();
      toggleSelection(thumb);
    }
    lastClickedThumb = thumb;
  });

  thumb.append(copyBtn, closeBtn, editBtn);
}

function addFile(file) {
  const isImage = file.type.startsWith("image/");
  const isPDF = file.type === "application/pdf";
  if (file.type === "image/gif") {
      alert("Animated GIFs are not supported. Please upload standard images or PDFs.");
      return; 
  }
  if (!isImage && !isPDF) return;

  const uniqueName = getUniqueImportName(file.name);

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.dataset.id = Date.now() + Math.random();
  thumb.dataset.type = isPDF ? "pdf" : "image";

  const fileURL = URL.createObjectURL(file);
  thumb.dataset.url = fileURL;
  thumb.dataset.fileSize = String(file.size || 0);

  // --- NEW: Generate Identity for PDF ---
  if (isPDF) {
    // START FRESH: Just the filename, no "edit_0"
    thumb.dataset.filename = uniqueName;
    thumb.dataset.sourceName = uniqueName;
    thumb.dataset.copyCount = "0";
    thumb.dataset.accent = getRandomAccentColor();

    const marker = thumb.querySelector(".pdf-marker");
    // Ensure tooltip is set if element existed (it's created later below)
    if (marker) marker.setAttribute("data-tooltip", uniqueName);
  }

  const checkbox = document.createElement("div");
  checkbox.className = "select-box";
  thumb.appendChild(checkbox);

  if (isImage) {
    const img = document.createElement("img");
    img.src = fileURL;
    img.draggable = false;
    thumb.appendChild(img);
    
    thumb.dataset.filename = uniqueName; 
    thumb.dataset.sourceName = uniqueName;
    thumb.dataset.copyCount = "0";

    addFormatBadge(thumb, uniqueName);
    setupThumb(thumb, fileURL, true);
    gallery.appendChild(thumb);
    finalizeAdd();
  } else {
    // --- PDF VISUALS ---
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-preview";
    thumb.appendChild(canvas);

    // Add the "Glass Tab" Marker (Centered)
    const marker = document.createElement("div");
    marker.className = "pdf-marker";
    // Using the stored accent color
    marker.innerHTML = `<div class="pdf-accent-dot" style="--accent-color: ${thumb.dataset.accent}"></div> PDF`;

    // Initialize tooltip with plain filename
    if (typeof setupTooltipEvents === "function") {
      setupTooltipEvents(marker, getThumbTooltipText(thumb));
    } else {
      marker.setAttribute("data-tooltip", getThumbTooltipText(thumb));
    }

    thumb.appendChild(marker);

    pdfjsLib.getDocument(fileURL).promise.then(pdf => {
      thumb.pdfDoc = pdf;

      pdf.getPage(1).then(page => {
        const viewport = page.getViewport({ scale: 0.5 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        page.render({ canvasContext: canvas.getContext("2d"), viewport });
      });

      setupThumb(thumb, fileURL, false, pdf);
      gallery.appendChild(thumb);
      finalizeAdd();
    });
  }

  function finalizeAdd() {
    updateDropHintVisibility();
    updateGalleryState();
    updateSelectToggle();
    updateActionButtons();
    updateSelectionInfo();
  }
}

/* ---------- DRAG & DROP ---------- */
editor?.addEventListener("dragover", (e) => e.preventDefault());
editor?.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) {
    Array.from(e.dataTransfer.files).forEach(addFile);
  }
});

function updateDropHintVisibility() {
  if (gallery.children.length > 0) {
    dropHint.classList.add("hidden");
    dropHint.classList.add("collapsed");
  } else {
    dropHint.classList.remove("collapsed");
    requestAnimationFrame(() => dropHint.classList.remove("hidden"));
  }
}
updateDropHintVisibility();

document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter++;
  clearDragClasses();
  if (welcome.classList.contains("active")) {
    document.body.classList.add("drag-welcome");
    return;
  }
  if (editor.classList.contains("active")) {
    document.body.classList.add(gallery.children.length === 0 ? "drag-editor-empty" : "drag-editor-filled");
  }
});

document.addEventListener("dragleave", (e) => {
  dragCounter--;
  if (dragCounter === 0) clearDragClasses();
});

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", () => {
  dragCounter = 0;
  clearDragClasses();
});

function clearDragClasses() {
  document.body.classList.remove("drag-welcome", "drag-editor-empty", "drag-editor-filled");
}

function showEditor() {
  clearDragClasses();
  welcome.classList.remove("active");
  editor.classList.add("active");
}

function showWelcome() {
  clearDragClasses();
  editor.classList.remove("active");
  welcome.classList.add("active");
}

function toggleSelection(thumb) {
  if (thumb.classList.contains("selected")) {
    thumb.classList.remove("selected");
    selected.delete(thumb);
  } else {
    thumb.classList.add("selected");
    selected.add(thumb);
  }
  updateSelectToggle();
  updateActionButtons();
  updateSelectionInfo();
}

function selectAll() {
  document.querySelectorAll(".thumb").forEach(t => {
    t.classList.add("selected");
    selected.add(t);
  });
  updateSelectToggle();
  updateActionButtons();
  updateSelectionInfo();
}

function deselectAll() {
  document.querySelectorAll(".thumb").forEach(t => t.classList.remove("selected"));
  selected.clear();
  updateSelectToggle();
  updateActionButtons();
  updateSelectionInfo();
}

function updateSelectToggle() {
  const thumbs = document.querySelectorAll(".thumb");
  if (thumbs.length === 0) {
    selectToggle.hidden = true;
    gallery.classList.remove("has-images");
    return;
  }
  selectToggle.hidden = false;
  gallery.classList.add("has-images");

  // FIX: This triggers correct text even after copy/reorder
  selectToggle.textContent = selected.size === thumbs.length ? "Deselect all" : "Select all";
}

selectToggle.addEventListener("click", () => {
  const thumbs = document.querySelectorAll(".thumb");
  if (selected.size === thumbs.length) deselectAll();
  else selectAll();
});


/* ---------- MOUSE SELECTION ---------- */

function onSelectionMove(e) {
  if (!isDragging || !selectionRect) return;

  autoScroll(e);

  const scrollDelta = window.scrollY - dragStartScrollY;
  const x = Math.min(e.clientX, dragStart.x);
  const y = Math.min(e.clientY, dragStart.y - scrollDelta);
  const w = Math.abs(e.clientX - dragStart.x);
  const h = Math.abs(e.clientY - (dragStart.y - scrollDelta));

  Object.assign(selectionRect.style, {
    left: x + "px",
    top: y + "px",
    width: w + "px",
    height: h + "px"
  });

  let hitSomething = false;
  document.querySelectorAll(".thumb").forEach(thumb => {
    const r = thumb.getBoundingClientRect();
    const hit = r.left < x + w && r.right > x && r.top < y + h && r.bottom > y;

    if (hit) {
      hitSomething = true;
      if (!selected.has(thumb) && !dragSelected.has(thumb)) {
        dragSelected.add(thumb);
        thumb.classList.add("selected");
      }
    } else if (dragSelected.has(thumb)) {
      dragSelected.delete(thumb);
      thumb.classList.remove("selected");
    }
  });

  if (hitSomething) updateSelectionInfo();
}

editor.addEventListener("mousedown", (e) => {
  if (gallery.classList.contains("is-reordering")) return;
  if (e.button !== 0) return;
  if (e.target.closest(".topbar")) return;
  if (e.target.closest("button") || e.target.closest(".extend-btn") || e.target.closest(".move-btn")) return;
  if (e.target.closest(".tool-bar") || e.target.closest(".gallery-header")) return;

  e.preventDefault();

  isDragging = true;
  dragStart = { x: e.clientX, y: e.clientY };
  dragStartScrollY = window.scrollY;
  dragSelected.clear();

  document.body.classList.add("drag-selecting");
  selectionRect = document.createElement("div");
  selectionRect.className = "selection-rect";
  document.body.appendChild(selectionRect);

  document.addEventListener("mousemove", onSelectionMove);
  document.addEventListener("mouseup", handleSelectionUp);
});

function handleSelectionUp(upEvent) {
  const movedX = Math.abs(upEvent.clientX - dragStart.x);
  const movedY = Math.abs(upEvent.clientY - dragStart.y);

  if (movedX < 5 && movedY < 5) {
    if (!upEvent.target.closest(".thumb")) {
      clearSelection();
    }
  }

  isDragging = false;
  dragStart = null;

  if (selectionRect) {
    selectionRect.remove();
    selectionRect = null;
  }
  dragSelected.forEach(t => selected.add(t));
  dragSelected.clear();

  document.body.classList.remove("drag-selecting");
  updateSelectionInfo();
  updateSelectToggle();
  updateActionButtons();

  document.removeEventListener("mousemove", onSelectionMove);
  document.removeEventListener("mouseup", handleSelectionUp);
}

function updateGalleryState() {
  const thumbs = document.querySelectorAll(".thumb");
  const hasItems = thumbs.length > 0;
  selectToggle.hidden = !hasItems;
  removeBtn.hidden = !hasItems;
  document.getElementById("selectedInfo").hidden = !hasItems;

  if (!hasItems) {
    selected.clear();
    dragSelected.clear();
    lastClickedThumb = null;
    updateActionButtons();
  }

  updateSelectToggle();
  updateSelectionInfo();
}

removeBtn.addEventListener("click", batchDelete);

function batchDelete() {
  selected.forEach(thumb => {
    revokeThumbUrl(thumb);
    thumb.remove();
  });
  selected.clear();
  dragSelected.clear();
  updateDropHintVisibility();
  updateGalleryState();
  updateActionButtons();
}

async function renderPdfPreview(url, canvas) {
  const pdf = await pdfjsLib.getDocument(url).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 0.5 });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
}

function updateSelectionInfo() {
  const thumbs = document.querySelectorAll(".thumb");
  const info = document.getElementById("selectedInfo");

  // If there are no images at all, hide the element and clear text
  if (thumbs.length === 0) {
    info.style.display = "none"; // Hide completely
    info.textContent = "";
    return;
  }

  // If images exist, show the element and update text
  info.style.display = "block";
  const totalImages = [...thumbs].filter(t => t.dataset.type === "image").length;
  const totalPDFs = [...thumbs].filter(t => t.dataset.type === "pdf").length;
  const selImages = [...selected].filter(t => t.dataset.type === "image").length;
  const selPDFs = [...selected].filter(t => t.dataset.type === "pdf").length;

  info.textContent = `Selected ${selImages}/${totalImages} images • ${selPDFs}/${totalPDFs} PDFs`;
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;
  if (selected.size === 0) return;
  e.preventDefault();
  batchDelete();
});

document.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const isSelectAll = (isMac && e.metaKey && e.key === "a") || (!isMac && e.ctrlKey && e.key === "a");
  if (!isSelectAll) return;
  if (!editor.classList.contains("active")) return;
  if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;
  const thumbs = document.querySelectorAll(".thumb");
  if (thumbs.length === 0) return;
  e.preventDefault();
  selectAll();
});

function selectRange(fromThumb, toThumb) {
  const thumbs = [...document.querySelectorAll(".thumb")];
  const start = thumbs.indexOf(fromThumb);
  const end = thumbs.indexOf(toThumb);
  if (start === -1 || end === -1) return;
  const [min, max] = start < end ? [start, end] : [end, start];
  for (let i = min; i <= max; i++) {
    thumbs[i].classList.add("selected");
    selected.add(thumbs[i]);
  }
  updateSelectToggle();
  updateActionButtons();
  updateSelectionInfo();
}

/* --- Create Cancel Zone Element --- */
function getCancelZone() {
  let zone = document.getElementById("dragCancelZone");
  if (!zone) {
    zone = document.createElement("div");
    zone.id = "dragCancelZone";
    zone.textContent = "Drop here to Cancel";
    document.body.appendChild(zone);
  }
  return zone;
}

function getRandomAccentColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 50%)`;
}

/* --- NEW: PERMANENT EXTRACTION LOGIC --- */
async function extractPDFPages(thumb) {
  const pdfDoc = thumb.pdfDoc;
  if (!pdfDoc) return;

  const parentName = thumb.dataset.filename || "Unknown PDF";
  const accentColor = thumb.dataset.accent || "#ccc";

  // Disable button and set text
  const btn = thumb.querySelector(".extract-btn");
  if (btn) {
    btn.textContent = "Extracted";
    btn.disabled = true;
  }
  
  let lastInsertedNode = thumb;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    
    const url = URL.createObjectURL(blob);
    const child = document.createElement("div");
    child.className = "thumb";
    child.dataset.id = Date.now() + Math.random();
    child.dataset.type = "image";
    child.dataset.url = url;
    child.dataset.mimeType = "image/png";
    child.dataset.fileSize = String(blob.size || 0);

    child.pdfDoc = pdfDoc; 
    child.dataset.isExtractedPage = "true";
    child.dataset.pdfPageIndex = i;
    
    // Generate the exact new format: "filename.pdf page_x"
    const imgName = `${parentName} page_${i}`;
    child.dataset.filename = imgName;
    
    // Treat the extracted page as its own root source
    child.dataset.sourceName = imgName; 
    child.dataset.copyCount = "0";

    const img = document.createElement("img");
    img.src = url;
    img.draggable = false;

    const checkbox = document.createElement("div");
    checkbox.className = "select-box";

    child.append(img, checkbox);

    // Let our updated function handle the badge cleanly!
    if (typeof addFormatBadge === "function") {
        addFormatBadge(child, imgName, i, accentColor);
    }

    setupThumb(child, url, true);
    
    // Insert after last extracted page of this batch
    lastInsertedNode.after(child);
    lastInsertedNode = child;
  }
}

// Helper to keep extracted pages/edits in order
function getLastNodeOfBatch(parentThumb) {
  // Use the parent's batchId if it belongs to one, otherwise use its own ID as the batch root
  const targetId = parentThumb.dataset.batchId || parentThumb.dataset.id;
  
  const siblings = Array.from(document.querySelectorAll(`.thumb`)).filter(
    t => t.dataset.batchId === targetId
  );
  
  return siblings.length > 0 ? siblings[siblings.length - 1] : null;
}

const globalTooltip = document.getElementById('global-tooltip');

function setupTooltipEvents(element, text) {
  element.dataset.tooltipText = text;
  if (element.dataset.tooltipBound === "true") return;

  element.addEventListener('mouseenter', () => {
    const tooltipText = element.dataset.tooltipText || text;
    globalTooltip.textContent = tooltipText;
    globalTooltip.classList.add('active');

    const rect = element.getBoundingClientRect();
    globalTooltip.style.left = `${rect.left + rect.width / 2 - globalTooltip.offsetWidth / 2}px`;
    globalTooltip.style.top = `${rect.top - globalTooltip.offsetHeight - 10}px`;
  });

  element.addEventListener('mouseleave', () => {
    globalTooltip.classList.remove('active');
  });

  element.dataset.tooltipBound = "true";
}

function generateNextName(currentName, type) {
  const existingNames = Array.from(document.querySelectorAll('.thumb'))
    .map(el => el.dataset.filename)
    .filter(Boolean);

  if (type === 'copy') {
    // Logic: "File" -> "File copy_1", "File copy_1" -> "File copy_1 copy_1"
    // We treat the current name as the base and look for suffixes appended to IT.
    const prefix = `${currentName} copy_`;
    const regex = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);

    let maxN = 0;
    existingNames.forEach(name => {
      const match = name.match(regex);
      if (match) maxN = Math.max(maxN, parseInt(match[1]));
    });

    return `${prefix}${maxN + 1}`;
  }

  if (type === 'edit') {
    // Logic: "File" -> "File edit_1", "File edit_1" -> "File edit_2"
    // If it already ends in edit_N, we increment N. Else we start edit_1.

    let base = currentName;
    const editMatch = currentName.match(/^(.*) edit_(\d+)$/);
    if (editMatch) {
      base = editMatch[1]; // Remove the last edit suffix to find the "root"
    }

    const prefix = `${base} edit_`;
    const regex = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);

    let maxN = 0;
    existingNames.forEach(name => {
      const match = name.match(regex);
      if (match) maxN = Math.max(maxN, parseInt(match[1]));
    });

    return `${prefix}${maxN + 1}`;
  }

  return currentName;
}

// NEW: OS-Style duplicate import resolver
function getUniqueImportName(baseFilename) {
    // Look at all existing root source names in the gallery
    const existingNames = Array.from(document.querySelectorAll('.thumb'))
        .map(t => t.dataset.sourceName)
        .filter(Boolean);

    // If it's a brand new file, keep the original name
    if (!existingNames.includes(baseFilename)) return baseFilename;

    // Separate the name and the extension (e.g., "photo" and ".jpg")
    const nameParts = baseFilename.split('.');
    const ext = nameParts.length > 1 ? '.' + nameParts.pop() : '';
    const coreName = nameParts.join('.');

    // Keep adding (1), (2), etc., until we find an empty slot
    let counter = 1;
    let newName = `${coreName} (${counter})${ext}`;
    
    while (existingNames.includes(newName)) {
        counter++;
        newName = `${coreName} (${counter})${ext}`;
    }
    
    return newName;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addFileFromEditor(file, forcedName, type, sourceThumb = null, badgeOptions = null) {
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.dataset.id = Date.now() + Math.random();
  thumb.dataset.type = type;
  thumb.dataset.filename = forcedName; 
  thumb.dataset.accent = getRandomAccentColor();
  
  if (file && file.type) {
      thumb.dataset.mimeType = file.type; 
  }

  thumb.dataset.copyCount = "0";
  if (badgeOptions && badgeOptions.sourceName) {
      thumb.dataset.sourceName = badgeOptions.sourceName;
  }

  const url = URL.createObjectURL(file);
  thumb.dataset.url = url;
  thumb.dataset.fileSize = String(file.size || 0);

  const checkbox = document.createElement("div");
  checkbox.className = "select-box";
  thumb.appendChild(checkbox);

  if (type === 'pdf') {
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-preview";
    thumb.appendChild(canvas);

    const marker = document.createElement("div");
    marker.className = "pdf-marker";
    marker.setAttribute("data-tooltip", getThumbTooltipText(thumb));
    if (typeof setupTooltipEvents === "function") setupTooltipEvents(marker, getThumbTooltipText(thumb));
    marker.innerHTML = `<div class="pdf-accent-dot" style="--accent-color: ${thumb.dataset.accent}"></div> PDF`;
    thumb.appendChild(marker);

    // ==========================================
    // FIX: Insert into the gallery IMMEDIATELY, before waiting for the PDF to render.
    // This guarantees the yellow selection click won't fail!
    // ==========================================
    insertThumbnailInGallery(thumb, sourceThumb);

    pdfjsLib.getDocument(url).promise.then(pdf => {
      thumb.pdfDoc = pdf;
      pdf.getPage(1).then(page => {
        const viewport = page.getViewport({ scale: 0.5 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        page.render({ canvasContext: canvas.getContext("2d"), viewport });
      });
      setupThumb(thumb, url, false, pdf);
    });
  }
  else {
    const img = document.createElement("img");
    img.src = url;
    thumb.appendChild(img);
    
    thumb.dataset.copyCount = "0";
    
    if (badgeOptions) {
        if (badgeOptions.isEditCopy && sourceThumb) {
            thumb.dataset.sourceName = badgeOptions.sourceName;
            
            // ==========================================
            // FIX: Gracefully handle PDF -> Image transition
            // ==========================================
            if (sourceThumb.dataset.type === "pdf") {
                 // The parent was a PDF, so we give this new Image a standard badge
                 if (typeof addFormatBadge === "function") {
                     addFormatBadge(thumb, forcedName); 
                 }
            } else {
                 // It's a copy of an image, safely steal its exact badge
                 if (typeof addFormatBadge === "function") addFormatBadge(thumb, forcedName);
                 const oldBadge = sourceThumb.querySelector(".format-badge");
                 const newBadge = thumb.querySelector(".format-badge");
                 if (oldBadge && newBadge) {
                     newBadge.innerHTML = oldBadge.innerHTML; 
                     newBadge.setAttribute("data-tooltip", forcedName);
                     if (typeof setupTooltipEvents === "function") setupTooltipEvents(newBadge, forcedName);
                 }
            }
        } 
        else {
            if (typeof addFormatBadge === "function") {
                addFormatBadge(
                  thumb,
                  forcedName, 
                  badgeOptions ? badgeOptions.pageNumber : null, 
                  badgeOptions ? badgeOptions.accentColor : null
                );
            }
            if (badgeOptions && badgeOptions.sourceName) {
              thumb.dataset.sourceName = badgeOptions.sourceName;
            }
        }
    } else {
        if (typeof addFormatBadge === "function") {
            addFormatBadge(thumb, forcedName);
        }
    }
    
    setupThumb(thumb, url, true);
    insertThumbnailInGallery(thumb, sourceThumb);
  }

  // 1. Dynamically inject the CSS to guarantee it exists and overrides defaults
  if (!document.getElementById('yellow-select-style')) {
      const style = document.createElement('style');
      style.id = 'yellow-select-style';
      style.textContent = `
          .thumb.is-new-copy.selected { border-color: #ffc107 !important; box-shadow: 0 0 0 3px #ffc107 !important; }
          .thumb.is-new-copy.selected .select-box { background: #ffc107 !important; border-color: #ffc107 !important; box-shadow: 0 0 8px #ffc107 !important; }
          .thumb.is-new-copy.selected .select-box::after { color: #000 !important; font-weight: bold !important; }
      `;
      document.head.appendChild(style);
  }

  document.querySelectorAll('.is-new-copy').forEach(t => t.classList.remove('is-new-copy'));
  // 2. Add the modifier class
  thumb.classList.add("is-new-copy");

  setTimeout(() => {
      // 3. Call your native JS function directly instead of faking a click!
      if (!thumb.classList.contains('selected')) {
          toggleSelection(thumb); 
      }

      if (sourceThumb && !sourceThumb.classList.contains('selected')) {
          toggleSelection(sourceThumb);
      }
      
      // Scroll to the new file smoothly
      thumb.scrollIntoView({ behavior: "smooth", block: "center" });

      // 4. Delay the cleanup listener by 500ms so the "Save" click doesn't instantly trigger it
      setTimeout(() => {
          const removeYellow = (e) => {
              if (e.target.closest('.image-modal-overlay')) return;
              thumb.classList.remove('is-new-copy');
              document.removeEventListener('mousedown', removeYellow);
          };
          // Listen for the next mousedown anywhere on the screen to return it to normal blue
          document.addEventListener('mousedown', removeYellow);
      }, 500); 
      
  }, 50); 

  return thumb;
}

// Helper to handle the logic of where to put the new thumbnail
function insertThumbnailInGallery(thumb, sourceThumb) {
    if (sourceThumb) {
        // Link to source batch logic (keeps your data tracking intact)
        thumb.dataset.batchId = sourceThumb.dataset.batchId || sourceThumb.dataset.id;
        
        // FIX: Insert immediately after the source thumbnail!
        if (sourceThumb.nextSibling) {
            gallery.insertBefore(thumb, sourceThumb.nextSibling);
        } else {
            gallery.appendChild(thumb);
        }
    } else {
        // Standard append if no source (e.g. from file upload)
        gallery.appendChild(thumb);
    }
    updateGalleryState();
}

// Helper to add format badges to image thumbnails
function addFormatBadge(thumb, fileName, pageNumber = null, accentColor = null) {

    const existingBadges = thumb.querySelectorAll('.format-badge, .page-badge');
    existingBadges.forEach(el => el.remove());

    let ext = "IMG";
    const mime = thumb.dataset.mimeType;
    if (mime) {
        if (mime === "image/jpeg") ext = "JPG";
        else if (mime === "image/png") ext = "PNG";
        else if (mime === "image/webp") ext = "WEBP";
    }
    if (ext === "IMG" &&fileName) {
        const parts = fileName.split('.');
        if (parts.length > 1 && parts[parts.length - 1].length <= 4) {
            ext = parts.pop().toUpperCase();
        } else {
            ext = "PNG"; // Fallback for extracted pages
        }
    }
    if (ext === "JPEG") ext = "JPG"; 
    
    const badge = document.createElement("div");
    badge.className = "format-badge";

    if (pageNumber) {
        badge.innerHTML = `
            <div class="inline-page-number" style="background-color: ${accentColor || '#ccc'}">
                ${pageNumber}
            </div> 
            <span>${ext}</span>
        `;
    } else {
        badge.textContent = ext;
    }
    
    // Keep our perfect hover tooltip
    const tooltipText = getThumbTooltipText(thumb);
    badge.setAttribute("data-tooltip", tooltipText);
    if (typeof setupTooltipEvents === "function") setupTooltipEvents(badge, tooltipText);
    
    thumb.appendChild(badge);
    return badge;
}

window.formatNameForExport = function(internalName, fallbackExt = "jpg") {
    if (!internalName) return `export_${Date.now()}.${fallbackExt}`;

    // 1. Replace ALL dots and spaces with underscores globally
    // "document.pdf page_1"  -> "document_pdf_page_1"
    // "photo.png copy_1"     -> "photo_png_copy_1"
    let cleanName = internalName.replace(/[\.\s]/g, "_");

    // 2. Add the one and ONLY dot right at the end for the browser
    return `${cleanName}.${fallbackExt}`;
};
