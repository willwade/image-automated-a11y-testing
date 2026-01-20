#!/usr/bin/env node
/**
 * symbol_contrast.js
 *
 * Contrast audit for multi-colour symbols (PNG/JPG/JPEG) against solid backgrounds.
 *
 * Segmentation:
 *  - Flood-fill "near-white" pixels from the image border to identify background
 *  - Foreground = not-background
 *
 * Contrast evaluation:
 *  - Only evaluate pixels in an "edge band": foreground pixels within N px of background
 *  - Compute per-pixel WCAG contrast ratio vs solid white and solid black backgrounds
 *  - Summarize using min, median, p05 (default), and % below threshold
 *
 * Usage:
 *   node symbol_contrast.js <file-or-folder>
 *
 * Options:
 *   --nearWhiteDist 160   Background threshold for flood fill (higher = more permissive)
 *   --nearBgDist 160      Alias for --nearWhiteDist
 *   --bandRadius 2        Pixels inward from silhouette edge to treat as "edge band"
 *   --threshold 3         Contrast threshold (3 for WCAG 1.4.11 non-text)
 *   --maxPctBelow 2       Max % of tested pixels allowed below threshold
 *   --p 0.05              Percentile to use (default 0.05 -> p05)
 *   --requireBoth         Require pass on BOTH white and black (default: pass if either)
 *   --bg <color>          Background color to test (repeatable). Default: white + black
 *   --segBg <color>       Background color used for flood-fill segmentation (default: first --bg or white)
 *   --alphaBg 10          Treat pixels with alpha <= this as background in segmentation
 *   --svgDensity 300      Density for SVG rasterization
 *   --vectorDensity 300   Density for EMF/WMF rasterization (ImageMagick)
 *   --csv <path>          Write CSV report to path (folder or single file)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const sharp = require("sharp");

const getArg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const getArgs = (name) => {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && i + 1 < process.argv.length) {
      out.push(process.argv[i + 1]);
      i++;
    }
  }
  return out;
};
const hasFlag = (name) => process.argv.includes(name);

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLuminance(r8, g8, b8) {
  const r = srgbToLinear(r8 / 255);
  const g = srgbToLinear(g8 / 255);
  const b = srgbToLinear(b8 / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function composite(r8, g8, b8, a8, bg) {
  const a = a8 / 255;
  return [
    Math.round(a * r8 + (1 - a) * bg[0]),
    Math.round(a * g8 + (1 - a) * bg[1]),
    Math.round(a * b8 + (1 - a) * bg[2]),
  ];
}
function contrastRatioPixelVsBg(r8, g8, b8, a8, bg) {
  const [cr, cg, cb] = composite(r8, g8, b8, a8, bg);
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
function statsForRatios(ratios, p = 0.05, below = 3) {
  if (!ratios.length) {
    return { count: 0, min: null, pX: null, median: null, pctBelow: 0 };
  }
  const s = [...ratios].sort((a, b) => a - b);
  const pctBelow = (100 * ratios.filter((x) => x < below).length) / ratios.length;
  return {
    count: ratios.length,
    min: s[0],
    pX: percentile(s, p),
    median: percentile(s, 0.5),
    pctBelow,
  };
}
function passByStats(st, threshold = 3, maxPctBelow = 2) {
  if (!st || !st.count) return false;
  return st.pX >= threshold && st.pctBelow <= maxPctBelow;
}

function parseColor(input) {
  const s = String(input).trim().toLowerCase();
  if (s === "white") return { label: "white", rgb: [255, 255, 255] };
  if (s === "black") return { label: "black", rgb: [0, 0, 0] };
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { label: s, rgb: [r, g, b] };
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { label: s, rgb: [r, g, b] };
  }
  const rgbMatch = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  if (rgbMatch) {
    const r = Math.min(255, parseInt(rgbMatch[1], 10));
    const g = Math.min(255, parseInt(rgbMatch[2], 10));
    const b = Math.min(255, parseInt(rgbMatch[3], 10));
    return { label: `rgb(${r},${g},${b})`, rgb: [r, g, b] };
  }
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length === 3 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const r = Math.min(255, parseInt(parts[0], 10));
    const g = Math.min(255, parseInt(parts[1], 10));
    const b = Math.min(255, parseInt(parts[2], 10));
    return { label: `${r},${g},${b}`, rgb: [r, g, b] };
  }
  throw new Error(`Invalid color: ${input}`);
}

let cachedMagickCmd;
function findMagickCmd() {
  if (cachedMagickCmd !== undefined) return cachedMagickCmd;
  for (const cmd of ["magick", "convert"]) {
    const res = spawnSync(cmd, ["-version"], { stdio: "ignore" });
    if (!res.error && res.status === 0) {
      cachedMagickCmd = cmd;
      return cachedMagickCmd;
    }
  }
  cachedMagickCmd = null;
  return cachedMagickCmd;
}

function convertVectorToPng(file, opts) {
  const cmd = findMagickCmd();
  if (!cmd) throw new Error("ImageMagick not found (magick/convert) for EMF/WMF conversion");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symbol-contrast-"));
  const outPath = path.join(tmpDir, `${path.basename(file)}.png`);
  const args =
    cmd === "magick"
      ? ["-density", String(opts.vectorDensity), file, "-background", "none", "-alpha", "on", outPath]
      : ["-density", String(opts.vectorDensity), file, "-background", "none", "-alpha", "on", outPath];
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    const msg = res.error ? res.error.message : res.stderr;
    throw new Error(`ImageMagick convert failed for ${file}: ${msg}`);
  }
  return {
    path: outPath,
    cleanup: () => {
      try {
        fs.unlinkSync(outPath);
      } catch {}
      try {
        fs.rmdirSync(tmpDir);
      } catch {}
    },
  };
}

async function openImage(file, opts) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") {
    return { image: sharp(file, { density: opts.svgDensity }), cleanup: null };
  }
  if (ext === ".emf" || ext === ".wmf") {
    const conv = convertVectorToPng(file, opts);
    return { image: sharp(conv.path), cleanup: conv.cleanup };
  }
  return { image: sharp(file), cleanup: null };
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function analyzeOne(file, opts) {
  const nearBgDist = opts.nearBgDist;
  const bandRadius = opts.bandRadius;
  const threshold = opts.threshold;
  const maxPctBelow = opts.maxPctBelow;
  const p = opts.p;

  const { image, cleanup } = await openImage(file, opts);
  try {
    const meta = await image.metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height) throw new Error(`Could not read image size: ${file}`);

    const raw = await image.ensureAlpha().raw().toBuffer(); // RGBA
    const idx = (x, y) => (y * width + x) * 4;

    // Background segmentation: flood fill from borders using "near background" test
    const segBg = opts.segBg.rgb;
    const alphaBg = opts.alphaBg;
    const isNearBg = (r, g, b, a) => {
      if (a <= alphaBg) return true;
      const dr = segBg[0] - r,
        dg = segBg[1] - g,
        db = segBg[2] - b;
      return Math.sqrt(dr * dr + dg * dg + db * db) <= nearBgDist;
    };

    const bg = new Uint8Array(width * height);
    const q = [];
    const pushIf = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const p = y * width + x;
      if (bg[p]) return;
      const i = idx(x, y);
      if (isNearBg(raw[i], raw[i + 1], raw[i + 2], raw[i + 3])) {
        bg[p] = 1;
        q.push([x, y]);
      }
    };

    for (let x = 0; x < width; x++) {
      pushIf(x, 0);
      pushIf(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      pushIf(0, y);
      pushIf(width - 1, y);
    }

    while (q.length) {
      const [x, y] = q.pop();
      pushIf(x + 1, y);
      pushIf(x - 1, y);
      pushIf(x, y + 1);
      pushIf(x, y - 1);
    }

    const fg = new Uint8Array(width * height);
    let fgCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!bg[p]) {
          fg[p] = 1;
          fgCount++;
        }
      }
    }

    // Edge band: fg pixels within bandRadius of bg (simple neighborhood scan)
    const band = new Uint8Array(width * height);
    let bandCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!fg[p]) continue;
        let near = false;
        for (let dy = -bandRadius; dy <= bandRadius && !near; dy++) {
          for (let dx = -bandRadius; dx <= bandRadius; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            if (bg[yy * width + xx]) {
              near = true;
              break;
            }
          }
        }
        if (near) {
          band[p] = 1;
          bandCount++;
        }
      }
    }

    function collectRatios(mask, bgColor) {
      const ratios = [];
      let worst = Infinity;
      let worstPixel = null;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x;
          if (!mask[p]) continue;
          const i = idx(x, y);
          const r = raw[i],
            g = raw[i + 1],
            b = raw[i + 2],
            a = raw[i + 3];
          const cr = contrastRatioPixelVsBg(r, g, b, a, bgColor);
          ratios.push(cr);
          if (cr < worst) {
            worst = cr;
            worstPixel = { r, g, b, a, x, y };
          }
        }
      }

      const st = statsForRatios(ratios, p, threshold);
      return {
        ...st,
        pass: passByStats(st, threshold, maxPctBelow),
        worst: worst === Infinity ? null : worst,
        worstPixel,
      };
    }

    const perBg = {};
    for (const bg of opts.backgrounds) {
      perBg[bg.label] = collectRatios(band, bg.rgb);
    }

    const requireBoth = opts.requireBoth;
    const passes = opts.backgrounds.map((bg) => perBg[bg.label].pass);
    const overall = requireBoth ? passes.every(Boolean) : passes.some(Boolean);
    const byBackground = {};
    for (const bg of opts.backgrounds) {
      byBackground[bg.label] = perBg[bg.label].pass;
    }

    return {
      file,
      size: { width, height },
      params: { ...opts },
      segmentation: { fgPixels: fgCount, bandPixels: bandCount },
      backgrounds: perBg,
      pass: { overall, byBackground },
    };
  } finally {
    if (cleanup) cleanup();
  }
}

function listImagesRec(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listImagesRec(p));
    else if (/\.(png|jpe?g|svg|emf|wmf)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node symbol_contrast.js <file-or-folder> [options]");
    process.exit(1);
  }

  const bgArgs = getArgs("--bg");
  const backgrounds =
    bgArgs.length > 0 ? bgArgs.map(parseColor) : [parseColor("white"), parseColor("black")];
  const segBgArg = getArg("--segBg", null);
  const segBg = segBgArg ? parseColor(segBgArg) : backgrounds[0] || parseColor("white");

  const opts = {
    nearBgDist: parseInt(getArg("--nearBgDist", getArg("--nearWhiteDist", "160")), 10),
    bandRadius: parseInt(getArg("--bandRadius", "2"), 10),
    threshold: parseFloat(getArg("--threshold", "3")),
    maxPctBelow: parseFloat(getArg("--maxPctBelow", "2")),
    p: parseFloat(getArg("--p", "0.05")),
    requireBoth: hasFlag("--requireBoth"),
    backgrounds,
    segBg,
    alphaBg: parseInt(getArg("--alphaBg", "10"), 10),
    svgDensity: parseInt(getArg("--svgDensity", "300"), 10),
    vectorDensity: parseInt(getArg("--vectorDensity", "300"), 10),
  };

  const st = fs.statSync(target);
  const files = st.isDirectory() ? listImagesRec(target) : [target];

  const results = [];
  for (const f of files) {
    try {
      results.push(await analyzeOne(f, opts));
    } catch (e) {
      results.push({ file: f, error: String(e) });
    }
  }

  const csvPath = getArg("--csv", null);
  if (csvPath) {
    const header = ["file", "width", "height", "overall", "error"];
    for (const bg of opts.backgrounds) {
      header.push(
        `${bg.label}_pass`,
        `${bg.label}_pX`,
        `${bg.label}_pctBelow`,
        `${bg.label}_min`,
        `${bg.label}_median`,
        `${bg.label}_count`,
        `${bg.label}_worst`
      );
    }
    const lines = [header.map(csvEscape).join(",")];
    for (const r of results) {
      if (r.error) {
        lines.push(
          [r.file, "", "", "", r.error, ...opts.backgrounds.flatMap(() => ["", "", "", "", "", "", ""])]
            .map(csvEscape)
            .join(",")
        );
        continue;
      }
      const row = [r.file, r.size.width, r.size.height, r.pass.overall, ""];
      for (const bg of opts.backgrounds) {
        const st = r.backgrounds[bg.label];
        row.push(
          st.pass,
          st.pX == null ? "" : st.pX.toFixed(3),
          st.pctBelow == null ? "" : st.pctBelow.toFixed(2),
          st.min == null ? "" : st.min.toFixed(3),
          st.median == null ? "" : st.median.toFixed(3),
          st.count,
          st.worst == null ? "" : st.worst.toFixed(3)
        );
      }
      lines.push(row.map(csvEscape).join(","));
    }
    fs.writeFileSync(csvPath, lines.join(os.EOL), "utf8");
    console.log(`Wrote CSV report to ${csvPath}`);
    process.exit(0);
  }

  // If a folder: print a compact summary line per file, plus full JSON for failures.
  if (files.length > 1) {
    const header = ["file", "overall"];
    for (const bg of opts.backgrounds) {
      header.push(`pass(${bg.label})`, `pX_${bg.label}`, `pctBelow_${bg.label}`);
    }
    console.log(header.join("\t"));
    for (const r of results) {
      if (r.error) {
        console.log([r.file, "ERR", ...opts.backgrounds.flatMap(() => ["ERR", "-", "-"])].join("\t"));
        continue;
      }
      const row = [r.file, r.pass.overall];
      for (const bg of opts.backgrounds) {
        const st = r.backgrounds[bg.label];
        row.push(st.pass, st.pX?.toFixed(3), st.pctBelow?.toFixed(2));
      }
      console.log(row.join("\t"));
    }
    process.exit(0);
  }

  // Single file: print full JSON
  console.log(JSON.stringify(results[0], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
