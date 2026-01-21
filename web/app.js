const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const bgColorInput = document.getElementById("bgColor");
const segColorInput = document.getElementById("segColor");
const segMatchesBg = document.getElementById("segMatchesBg");
const thresholdInput = document.getElementById("threshold");
const maxPctBelowInput = document.getElementById("maxPctBelow");
const percentileInput = document.getElementById("percentile");
const nearBgDistInput = document.getElementById("nearBgDist");
const bandRadiusInput = document.getElementById("bandRadius");
const alphaBgInput = document.getElementById("alphaBg");
const minAlphaInput = document.getElementById("minAlpha");
const sampleModeInput = document.getElementById("sampleMode");
const strokeLumaMaxInput = document.getElementById("strokeLumaMax");
const maxSizeInput = document.getElementById("maxSize");
const svgScaleInput = document.getElementById("svgScale");
const showHighlightInput = document.getElementById("showHighlight");
const runBtn = document.getElementById("runBtn");
const statusEl = document.getElementById("status");
const fileNameEl = document.getElementById("fileName");
const fileMetaEl = document.getElementById("fileMeta");
const passBadgeEl = document.getElementById("passBadge");
const statPX = document.getElementById("statPX");
const statPctBelow = document.getElementById("statPctBelow");
const statMin = document.getElementById("statMin");
const statMedian = document.getElementById("statMedian");
const statCount = document.getElementById("statCount");
const statBand = document.getElementById("statBand");
const baseCanvas = document.getElementById("baseCanvas");
const overlayCanvas = document.getElementById("overlayCanvas");
const canvasWrap = document.querySelector(".canvas-wrap");

let currentImage = null;
let currentMask = null;

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function parseHexColor(hex) {
  const clean = hex.replace("#", "");
  const value = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relLuminance(r8, g8, b8) {
  const r = srgbToLinear(r8 / 255);
  const g = srgbToLinear(g8 / 255);
  const b = srgbToLinear(b8 / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatioPixelVsBg(r8, g8, b8, a8, bg) {
  const a = a8 / 255;
  const cr = Math.round(a * r8 + (1 - a) * bg[0]);
  const cg = Math.round(a * g8 + (1 - a) * bg[1]);
  const cb = Math.round(a * b8 + (1 - a) * bg[2]);
  const Lp = relLuminance(cr, cg, cb);
  const Lb = relLuminance(bg[0], bg[1], bg[2]);
  const L1 = Math.max(Lp, Lb);
  const L2 = Math.min(Lp, Lb);
  return (L1 + 0.05) / (L2 + 0.05);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function getSvgSize(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) return null;
    const widthAttr = svg.getAttribute("width");
    const heightAttr = svg.getAttribute("height");
    const viewBox = svg.getAttribute("viewBox");
    const parseSize = (value) => {
      if (!value) return null;
      const num = parseFloat(value);
      return Number.isFinite(num) ? num : null;
    };
    const width = parseSize(widthAttr);
    const height = parseSize(heightAttr);
    if (width && height) return { width, height };
    if (viewBox) {
      const parts = viewBox.split(/[ ,]+/).map((v) => parseFloat(v));
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        return { width: parts[2], height: parts[3] };
      }
    }
  } catch (err) {
    return null;
  }
  return null;
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image."));
    img.src = url;
  });
}

async function loadFile(file) {
  const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
  if (isSvg) {
    const text = await file.text();
    const size = getSvgSize(text);
    const blob = new Blob([text], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = await loadImageFromUrl(url);
    URL.revokeObjectURL(url);
    return { img, isSvg, size };
  }
  const url = URL.createObjectURL(file);
  const img = await loadImageFromUrl(url);
  URL.revokeObjectURL(url);
  return { img, isSvg: false, size: null };
}

function fitToMaxSize(width, height, maxSize, extraScale) {
  if (!width || !height) {
    return { width: maxSize, height: maxSize, scale: 1 };
  }
  const maxDim = Math.max(width, height);
  const baseScale = maxDim > maxSize ? maxSize / maxDim : 1;
  const scale = baseScale * extraScale;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

function renderBase(imageData, bgColor) {
  baseCanvas.width = imageData.width;
  baseCanvas.height = imageData.height;
  overlayCanvas.width = imageData.width;
  overlayCanvas.height = imageData.height;
  const ctx = baseCanvas.getContext("2d");
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, baseCanvas.width, baseCanvas.height);
  ctx.putImageData(imageData, 0, 0);
}

function renderOverlay(mask, width, height) {
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  if (!mask) return;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const off = i * 4;
    img.data[off] = 242;
    img.data[off + 1] = 80;
    img.data[off + 2] = 60;
    img.data[off + 3] = 180;
  }
  ctx.putImageData(img, 0, 0);
}

function analyze(imageData, opts) {
  const { width, height, data } = imageData;
  const total = width * height;
  const bg = new Uint8Array(total);
  const band = new Uint8Array(total);
  const failing = new Uint8Array(total);
  const segBg = opts.segBg;
  const nearBgDist = opts.nearBgDist;
  const alphaBg = opts.alphaBg;

  const isNearBg = (r, g, b, a) => {
    if (a <= alphaBg) return true;
    const dr = segBg[0] - r;
    const dg = segBg[1] - g;
    const db = segBg[2] - b;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= nearBgDist;
  };

  const queue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;

  const pushIf = (idx) => {
    if (bg[idx]) return;
    const off = idx * 4;
    if (isNearBg(data[off], data[off + 1], data[off + 2], data[off + 3])) {
      bg[idx] = 1;
      queue[qTail++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    pushIf(x);
    pushIf((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    pushIf(y * width);
    pushIf(y * width + (width - 1));
  }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) pushIf(idx - 1);
    if (x < width - 1) pushIf(idx + 1);
    if (y > 0) pushIf(idx - width);
    if (y < height - 1) pushIf(idx + width);
  }

  let bgCount = 0;
  for (let i = 0; i < total; i++) {
    if (bg[i]) bgCount++;
  }

  if (bgCount === 0) {
    for (let i = 0; i < total; i++) {
      const off = i * 4;
      if (isNearBg(data[off], data[off + 1], data[off + 2], data[off + 3])) {
        bg[i] = 1;
        bgCount++;
      }
    }
  }

  let bandCount = 0;
  if (bgCount === 0) {
    const edge = Math.max(0, opts.bandRadius);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (x <= edge || y <= edge || x >= width - 1 - edge || y >= height - 1 - edge) {
          band[idx] = 1;
          bandCount++;
        }
      }
    }
  } else {
    const radius = opts.bandRadius;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (bg[idx]) continue;
        let near = false;
        for (let dy = -radius; dy <= radius && !near; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            if (bg[yy * width + xx]) {
              near = true;
              break;
            }
          }
        }
        if (near) {
          band[idx] = 1;
          bandCount++;
        }
      }
    }
  }

  let mask = band;
  let maskCount = bandCount;
  if (opts.sampleMode === "all") {
    mask = new Uint8Array(total);
    maskCount = 0;
    for (let i = 0; i < total; i++) {
      if (!bg[i]) {
        mask[i] = 1;
        maskCount++;
      }
    }
  } else if (opts.sampleMode === "stroke") {
    mask = new Uint8Array(total);
    maskCount = 0;
    for (let i = 0; i < total; i++) {
      if (!band[i]) continue;
      const off = i * 4;
      const L = relLuminance(data[off], data[off + 1], data[off + 2]);
      if (L <= opts.strokeLumaMax) {
        mask[i] = 1;
        maskCount++;
      }
    }
  }

  const ratios = [];
  for (let i = 0; i < total; i++) {
    if (!mask[i]) continue;
    const off = i * 4;
    const a = data[off + 3];
    if (a < opts.minAlpha) continue;
    const cr = contrastRatioPixelVsBg(
      data[off],
      data[off + 1],
      data[off + 2],
      a,
      opts.bg
    );
    ratios.push(cr);
    if (cr < opts.threshold) failing[i] = 1;
  }

  ratios.sort((a, b) => a - b);
  const pctBelow =
    ratios.length === 0
      ? 0
      : (100 * ratios.filter((x) => x < opts.threshold).length) / ratios.length;
  const stats = {
    count: ratios.length,
    pX: percentile(ratios, opts.p),
    median: percentile(ratios, 0.5),
    min: ratios.length ? ratios[0] : null,
    pctBelow,
    bandCount: maskCount,
  };
  const pass =
    stats.count > 0 && stats.pX >= opts.threshold && stats.pctBelow <= opts.maxPctBelow;
  return { stats, pass, mask: failing };
}

function updateStats(stats, pass) {
  statPX.textContent = stats.pX == null ? "-" : stats.pX.toFixed(3);
  statPctBelow.textContent = stats.count ? `${stats.pctBelow.toFixed(2)}%` : "-";
  statMin.textContent = stats.min == null ? "-" : stats.min.toFixed(3);
  statMedian.textContent = stats.median == null ? "-" : stats.median.toFixed(3);
  statCount.textContent = stats.count ? String(stats.count) : "-";
  statBand.textContent = stats.bandCount ? String(stats.bandCount) : "-";
  passBadgeEl.textContent = pass ? "Pass" : "Fail";
  passBadgeEl.classList.toggle("pass", pass);
  passBadgeEl.classList.toggle("fail", !pass);
}

function getOpts() {
  const bgColor = bgColorInput.value;
  const segColor = segMatchesBg.checked ? bgColor : segColorInput.value;
  return {
    bg: parseHexColor(bgColor),
    segBg: parseHexColor(segColor),
    threshold: parseFloat(thresholdInput.value),
    maxPctBelow: parseFloat(maxPctBelowInput.value),
    p: parseFloat(percentileInput.value),
    nearBgDist: parseInt(nearBgDistInput.value, 10),
    bandRadius: parseInt(bandRadiusInput.value, 10),
    alphaBg: parseInt(alphaBgInput.value, 10),
    minAlpha: parseInt(minAlphaInput.value, 10),
    sampleMode: sampleModeInput.value,
    strokeLumaMax: parseFloat(strokeLumaMaxInput.value),
  };
}

function refreshDisplay() {
  if (!currentImage) return;
  const bgColor = bgColorInput.value;
  canvasWrap.style.setProperty("--preview-bg", bgColor);
  renderBase(currentImage.imageData, bgColor);
  if (showHighlightInput.checked) {
    renderOverlay(currentMask, currentImage.imageData.width, currentImage.imageData.height);
  } else {
    renderOverlay(null, currentImage.imageData.width, currentImage.imageData.height);
  }
}

function runAnalysis() {
  if (!currentImage) return;
  setStatus("Analyzing...", "working");
  const opts = getOpts();
  const result = analyze(currentImage.imageData, opts);
  currentMask = result.mask;
  updateStats(result.stats, result.pass);
  refreshDisplay();
  const passText = result.pass ? "Pass" : "Fail";
  setStatus(`${passText}: ${result.stats.count || 0} pixels tested.`, "ready");
}

async function handleFile(file) {
  setStatus("Loading image...", "working");
  try {
    const { img, isSvg, size } = await loadFile(file);
    const maxSize = parseInt(maxSizeInput.value, 10);
    const svgScale = isSvg ? parseFloat(svgScaleInput.value) : 1;
    const naturalWidth = size?.width || img.naturalWidth || maxSize;
    const naturalHeight = size?.height || img.naturalHeight || maxSize;
    const fitted = fitToMaxSize(naturalWidth, naturalHeight, maxSize, svgScale);

    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = fitted.width;
    analysisCanvas.height = fitted.height;
    const actx = analysisCanvas.getContext("2d");
    actx.clearRect(0, 0, fitted.width, fitted.height);
    actx.drawImage(img, 0, 0, fitted.width, fitted.height);
    const imageData = actx.getImageData(0, 0, fitted.width, fitted.height);

    currentImage = {
      imageData,
      name: file.name,
      original: { width: naturalWidth, height: naturalHeight },
      fitted,
      isSvg,
    };
    fileNameEl.textContent = file.name;
    fileMetaEl.textContent = `${fitted.width} x ${fitted.height} px`;
    setStatus("Ready to analyze.", "ready");
    runAnalysis();
  } catch (err) {
    setStatus(err.message || "Failed to load image.", "error");
  }
}

function debounce(fn, delay) {
  let t = null;
  return () => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(fn, delay);
  };
}

const debouncedRun = debounce(runAnalysis, 200);

fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) handleFile(file);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragover");
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) {
    fileInput.value = "";
    handleFile(file);
  }
});

segMatchesBg.addEventListener("change", () => {
  segColorInput.disabled = segMatchesBg.checked;
  if (segMatchesBg.checked) segColorInput.value = bgColorInput.value;
  debouncedRun();
});

bgColorInput.addEventListener("input", () => {
  if (segMatchesBg.checked) segColorInput.value = bgColorInput.value;
  refreshDisplay();
  debouncedRun();
});

segColorInput.addEventListener("input", debouncedRun);
thresholdInput.addEventListener("input", debouncedRun);
maxPctBelowInput.addEventListener("input", debouncedRun);
percentileInput.addEventListener("input", debouncedRun);
nearBgDistInput.addEventListener("input", debouncedRun);
bandRadiusInput.addEventListener("input", debouncedRun);
alphaBgInput.addEventListener("input", debouncedRun);
minAlphaInput.addEventListener("input", debouncedRun);
sampleModeInput.addEventListener("change", () => {
  strokeLumaMaxInput.disabled = sampleModeInput.value !== "stroke";
  debouncedRun();
});
strokeLumaMaxInput.addEventListener("input", debouncedRun);
maxSizeInput.addEventListener("input", debouncedRun);
svgScaleInput.addEventListener("input", debouncedRun);
showHighlightInput.addEventListener("change", refreshDisplay);
runBtn.addEventListener("click", runAnalysis);

window.addEventListener("load", () => {
  document.body.classList.add("loaded");
  segColorInput.disabled = segMatchesBg.checked;
  canvasWrap.style.setProperty("--preview-bg", bgColorInput.value);
  strokeLumaMaxInput.disabled = sampleModeInput.value !== "stroke";
});
