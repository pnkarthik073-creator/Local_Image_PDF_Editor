function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function estimateImageBytes({ width, height, quality = 0.8, mimeType = "image/jpeg" }) {
  const safeWidth = Math.max(1, width || 1);
  const safeHeight = Math.max(1, height || 1);
  const safeQuality = Math.max(0.1, Math.min(1, quality || 0.8));
  const entropyFactor = mimeType === "image/png" ? 0.72 : 0.42;
  return Math.max(1, Math.round(safeWidth * safeHeight * Math.max(0.12, safeQuality) * entropyFactor));
}

function createLeafNode(pixel) {
  return {
    pixels: [pixel],
    rMin: pixel.r,
    rMax: pixel.r,
    gMin: pixel.g,
    gMax: pixel.g,
    bMin: pixel.b,
    bMax: pixel.b
  };
}

function makeColorBox(pixels) {
  const box = createLeafNode(pixels[0]);
  box.pixels = pixels.slice();

  for (let i = 1; i < pixels.length; i++) {
    const pixel = pixels[i];
    box.rMin = Math.min(box.rMin, pixel.r);
    box.rMax = Math.max(box.rMax, pixel.r);
    box.gMin = Math.min(box.gMin, pixel.g);
    box.gMax = Math.max(box.gMax, pixel.g);
    box.bMin = Math.min(box.bMin, pixel.b);
    box.bMax = Math.max(box.bMax, pixel.b);
  }

  return box;
}

function getBoxRange(box, channel) {
  if (channel === "r") return box.rMax - box.rMin;
  if (channel === "g") return box.gMax - box.gMin;
  return box.bMax - box.bMin;
}

function chooseSplitChannel(box) {
  const rRange = getBoxRange(box, "r");
  const gRange = getBoxRange(box, "g");
  const bRange = getBoxRange(box, "b");

  if (rRange >= gRange && rRange >= bRange) return "r";
  if (gRange >= rRange && gRange >= bRange) return "g";
  return "b";
}

function splitColorBox(box) {
  if (box.pixels.length <= 1) return [box];

  const channel = chooseSplitChannel(box);
  const sorted = box.pixels.slice().sort((a, b) => a[channel] - b[channel]);
  const midpoint = Math.floor(sorted.length / 2);

  if (midpoint <= 0 || midpoint >= sorted.length) return [box];

  return [
    makeColorBox(sorted.slice(0, midpoint)),
    makeColorBox(sorted.slice(midpoint))
  ];
}

function buildMedianCutPalette(sourcePixels, targetPaletteSize) {
  const boxes = [makeColorBox(sourcePixels)];
  const targetSize = Math.max(2, Math.min(256, targetPaletteSize || 32));

  while (boxes.length < targetSize) {
    boxes.sort((a, b) => {
      const aRange = Math.max(getBoxRange(a, "r"), getBoxRange(a, "g"), getBoxRange(a, "b"));
      const bRange = Math.max(getBoxRange(b, "r"), getBoxRange(b, "g"), getBoxRange(b, "b"));
      return bRange - aRange || b.pixels.length - a.pixels.length;
    });

    const nextBox = boxes.shift();
    if (!nextBox) break;

    const splitBoxes = splitColorBox(nextBox);
    if (splitBoxes.length === 1) {
      boxes.push(nextBox);
      break;
    }

    boxes.push(...splitBoxes);
  }

  return boxes.map((box) => {
    let rTotal = 0;
    let gTotal = 0;
    let bTotal = 0;

    for (const pixel of box.pixels) {
      rTotal += pixel.r;
      gTotal += pixel.g;
      bTotal += pixel.b;
    }

    const count = Math.max(1, box.pixels.length);
    return [
      clampChannel(rTotal / count),
      clampChannel(gTotal / count),
      clampChannel(bTotal / count)
    ];
  });
}

function findNearestPaletteColor(palette, r, g, b) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const distance = ((r - pr) ** 2) + ((g - pg) ** 2) + ((b - pb) ** 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return palette[bestIndex];
}

function diffuseFloydSteinberg(buffer, width, height, x, y, errR, errG, errB) {
  const neighbors = [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16]
  ];

  for (const [dx, dy, weight] of neighbors) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

    const index = (ny * width + nx) * 4;
    buffer[index] = clampChannel(buffer[index] + errR * weight);
    buffer[index + 1] = clampChannel(buffer[index + 1] + errG * weight);
    buffer[index + 2] = clampChannel(buffer[index + 2] + errB * weight);
  }
}

function buildPalette({ pixels, width, height, paletteSize = 32 }) {
  if (!pixels || !width || !height) throw new Error("Invalid build-palette payload");
  const source = new Uint8ClampedArray(pixels);
  const samples = [];
  const stride = Math.max(1, Math.floor((width * height) / 12000));
  for (let i = 0; i < width * height; i += stride) {
    const offset = i * 4;
    samples.push({ r: source[offset], g: source[offset + 1], b: source[offset + 2] });
  }
  if (!samples.length) throw new Error("Unable to sample pixels for quantization");
  return buildMedianCutPalette(samples, paletteSize);
}

function ditherChunk({ pixels, width, height, palette }) {
  if (!pixels || !width || !height || !palette) throw new Error("Invalid dither-chunk payload");
  const source = new Uint8ClampedArray(pixels);
  const working = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) working[i] = source[i];
  
  const output = new Uint8ClampedArray(source);

  // Standard sequential pass, boundary errors bleed freely into the padded halo
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const oldR = working[index];
      const oldG = working[index + 1];
      const oldB = working[index + 2];
      const [newR, newG, newB] = findNearestPaletteColor(palette, oldR, oldG, oldB);

      output[index] = newR;
      output[index + 1] = newG;
      output[index + 2] = newB;
      output[index + 3] = source[index + 3];

      const errR = oldR - newR;
      const errG = oldG - newG;
      const errB = oldB - newB;

      // diffuseFloydSteinberg updates the 'working' float array for succeeding pixels
      diffuseFloydSteinberg(working, width, height, x, y, errR, errG, errB);
    }
  }

  return { pixels: output };
}

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data || {};

  try {
    let result;

    switch (type) {
      case "ping":
        result = { ok: true };
        break;
      case "estimate-image-bytes":
        result = { estimatedBytes: estimateImageBytes(payload || {}) };
        break;
      case "build-palette":
        result = { palette: buildPalette(payload || {}) };
        break;
      case "dither-chunk": {
        const chunk = ditherChunk(payload || {});
        result = {
          pixels: chunk.pixels,
          width: payload.width,
          height: payload.height
        };
        self.postMessage({ id, result }, [chunk.pixels.buffer]);
        return;
      }
      default:
        throw new Error(`Unsupported worker task: ${type}`);
    }

    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
