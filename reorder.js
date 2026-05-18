// ----- REORDER STATE -----
let reorderState = null;
let autoScrollRAF = null;
let lastScrollY = window.scrollY;
let lastPlaceholderRef = null;
let activeRowBounds = null;

export function startReorder(thumb, e) {
  e.preventDefault();
  e.stopPropagation();

  document.body.classList.remove("drag-selecting");
  gallery.classList.add("is-reordering");

  const group = selected.has(thumb) ? [...selected] : [thumb];
  const thumbs = [...gallery.querySelectorAll(".thumb")];

  // Hide originals but KEEP layout
  group.forEach(t => {
    t.style.visibility = "hidden";
    t.style.pointerEvents = "none";
    t.classList.add("reordering");
  });

  const rect = thumb.getBoundingClientRect();

  const placeholder = document.createElement("div");
  placeholder.className = "thumb placeholder";
  placeholder.style.width = rect.width + "px";
  placeholder.style.height = rect.height + "px";

  const startIndex = Math.min(...group.map(t => thumbs.indexOf(t)));
  gallery.insertBefore(placeholder, thumbs[startIndex]);

  const proxy = createDragProxy(group);

  reorderState = {
    group,
    placeholder,
    proxy,
    offsetX: rect.width / 2,
    offsetY: rect.height / 2
  };

  moveProxy(e);

  document.addEventListener("mousemove", onReorderMove);
  document.addEventListener("mouseup", onReorderEnd);
}

function onReorderMove(e) {
  if (!reorderState) return;

  autoScroll(e);
  moveProxy(e);

  // Resnapshot only if scroll changed
  if (window.scrollY !== lastScrollY) {
    lastScrollY = window.scrollY;
  }

  resolveInsertion(e);
}

function onReorderEnd() {
  if (!reorderState) return;

  const { group, placeholder, proxy } = reorderState;

  // Preserve internal order of multi-selection
  const orderedGroup = [...group].sort(
    (a, b) =>
      [...gallery.children].indexOf(a) -
      [...gallery.children].indexOf(b)
  );

  orderedGroup.forEach(t => {
    t.style.visibility = "";
    t.style.pointerEvents = "";
    t.classList.remove("reordering");
    gallery.insertBefore(t, placeholder);
  });

  placeholder.remove();
  proxy.remove();

  gallery.classList.remove("is-reordering");

  reorderState = null;
  activeRowBounds = null;
  lastPlaceholderRef = null;

  document.removeEventListener("mousemove", onReorderMove);
  document.removeEventListener("mouseup", onReorderEnd);
}

function resolveInsertion(e) {
  const { placeholder, group } = reorderState;

  const galleryRect = gallery.getBoundingClientRect();
  const thumbs = [...gallery.querySelectorAll(".thumb:not(.placeholder)")];

  if (!thumbs.length) return;

  /* 1️⃣ Absolute rules */
  if (e.clientY < galleryRect.top) {
    gallery.insertBefore(placeholder, thumbs[0]);
    return;
  }

  if (e.clientY > galleryRect.bottom) {
    gallery.appendChild(placeholder);
    return;
  }

  /* 2️⃣ Build rows */
  const rows = [];

  for (const el of thumbs) {
    if (group.includes(el)) continue;

    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;

    let row = rows.find(row =>
      Math.abs(row.cy - cy) < r.height * 0.6
    );

    if (!row) {
      row = { cy, top: r.top, bottom: r.bottom, items: [] };
      rows.push(row);
    }

    row.items.push(el);
  }

  if (!rows.length) return;

  /* 3️⃣ Lock row by vertical cursor */
  let row =
    rows.find(r => e.clientY >= r.top && e.clientY <= r.bottom) ||
    rows[rows.length - 1];

  /* 4️⃣ Sort row horizontally */
  row.items.sort(
    (a, b) =>
      a.getBoundingClientRect().left -
      b.getBoundingClientRect().left
  );

  /* 5️⃣ Before first */
  const first = row.items[0];
  const firstRect = first.getBoundingClientRect();

  if (e.clientX < firstRect.left) {
    const rowIndex = rows.indexOf(row);
    if (rowIndex > 0) {
      const prevRow = rows[rowIndex - 1];
      const lastPrev = prevRow.items[prevRow.items.length - 1];
      gallery.insertBefore(placeholder, lastPrev.nextSibling);
      return;
    }
    gallery.insertBefore(placeholder, first);
    return;
  }

  /* 6️⃣ Normal placement */
  for (const el of row.items) {
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left + r.width / 2) {
      gallery.insertBefore(placeholder, el);
      return;
    }
  }

  /* 7️⃣ End of row */
  gallery.insertBefore(
    placeholder,
    row.items[row.items.length - 1].nextSibling
  );
}

function moveProxy(e) {
  const { proxy, offsetX, offsetY } = reorderState;
  proxy.style.left = e.clientX - offsetX + "px";
  proxy.style.top  = e.clientY - offsetY + "px";
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

export function autoScroll(e) {
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
  if (reorderState) {
    onReorderEnd();
  }
});

