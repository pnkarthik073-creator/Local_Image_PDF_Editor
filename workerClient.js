let workers = [];
let requestId = 0;
const pendingRequests = new Map();
let currentWorkerIdx = 0;

function initWorkers() {
  if (workers.length > 0) return;
  const numWorkers = navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 6) : 4;
  for (let i = 0; i < numWorkers; i++) {
    const worker = new Worker(new URL("./image-processing.worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event) => {
      const { id, result, error } = event.data || {};
      if (!pendingRequests.has(id)) return;
      const { resolve, reject } = pendingRequests.get(id);
      pendingRequests.delete(id);
      if (error) reject(new Error(error));
      else resolve(result);
    });
    workers.push(worker);
  }
}

function callWorker(type, payload = {}, transfers = []) {
  initWorkers();
  const worker = workers[currentWorkerIdx++ % workers.length];
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfers);
  });
}

function extractPaddedChunk(sourcePixels, width, height, startX, startY, chunkW, chunkH, halo) {
  const padLeft = Math.min(halo, startX);
  const padRight = Math.min(halo, width - (startX + chunkW));
  const padTop = Math.min(halo, startY);
  const padBottom = Math.min(halo, height - (startY + chunkH));

  const paddedW = chunkW + padLeft + padRight;
  const paddedH = chunkH + padTop + padBottom;
  const chunkPixels = new Uint8ClampedArray(paddedW * paddedH * 4);

  for (let y = 0; y < paddedH; y++) {
    const srcY = startY - padTop + y;
    const srcOffset = (srcY * width + (startX - padLeft)) * 4;
    const destOffset = y * paddedW * 4;
    chunkPixels.set(sourcePixels.subarray(srcOffset, srcOffset + paddedW * 4), destOffset);
  }

  return { 
    pixels: chunkPixels.buffer, 
    paddedW, paddedH, 
    padLeft, padTop, padRight, padBottom 
  };
}

export function createImageProcessingClient() {
  return {
    warmup() {
      return callWorker("ping");
    },
    estimateImageBytes(payload) {
      return callWorker("estimate-image-bytes", payload);
    },
    async quantizeAndDither(payload) {
      initWorkers();
      const { pixels, width, height, paletteSize } = payload;
      const sourcePixels = new Uint8ClampedArray(pixels);

      // Phase 1: Offload palette building to a single worker
      console.time("Phase 1: Palette Generation");
      const sampleBuffer = new Uint8ClampedArray(sourcePixels).buffer;
      const { palette } = await callWorker("build-palette", { pixels: sampleBuffer, width, height, paletteSize }, [sampleBuffer]);
      console.timeEnd("Phase 1: Palette Generation");

      // Phase 2: Parallel Checkerboard block processing with overlapping halos
      console.time("Phase 2: Parallel Chunk Dithering");
      const chunkSize = 256;
      const halo = 4; // Overlap boundary to diffuse errors
      const blocks = [];

      for (let y = 0; y < height; y += chunkSize) {
        for (let x = 0; x < width; x += chunkSize) {
          const w = Math.min(chunkSize, width - x);
          const h = Math.min(chunkSize, height - y);
          blocks.push({ x, y, w, h, blockX: Math.floor(x/chunkSize), blockY: Math.floor(y/chunkSize) });
        }
      }

      console.log(`[WorkerClient] Image broken into ${blocks.length} chunks. Utilizing ${workers.length} Web Workers.`);

      // Schedule as Checkerboard (Even blocks first, then Odd blocks)
      const evenBlocks = blocks.filter(b => (b.blockX + b.blockY) % 2 === 0);
      const oddBlocks = blocks.filter(b => (b.blockX + b.blockY) % 2 !== 0);
      const outputPixels = new Uint8ClampedArray(width * height * 4);

      const processBlock = async (b) => {
        const { pixels, paddedW, paddedH, padLeft, padTop } = extractPaddedChunk(sourcePixels, width, height, b.x, b.y, b.w, b.h, halo);
        const result = await callWorker("dither-chunk", { pixels, width: paddedW, height: paddedH, palette }, [pixels]);
        
        // Stitch the core back without the halo 
        const resultView = new Uint8ClampedArray(result.pixels);
        for (let cy = 0; cy < b.h; cy++) {
          const srcOffset = ((cy + padTop) * paddedW + padLeft) * 4;
          const destOffset = ((b.y + cy) * width + b.x) * 4;
          // Copy precisely the row core
          outputPixels.set(resultView.subarray(srcOffset, srcOffset + (b.w * 4)), destOffset);
        }
      };

      await Promise.all(evenBlocks.map(processBlock));
      await Promise.all(oddBlocks.map(processBlock));
      console.timeEnd("Phase 2: Parallel Chunk Dithering");

      return { pixels: outputPixels, palette, width, height };
    }
  };
}
