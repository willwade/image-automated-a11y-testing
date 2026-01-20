Image contrast audit for symbol/illustration files (PNG/JPEG/SVG) against solid backgrounds using WCAG 2.1 contrast math.

Quick start
1) Install dependencies
   - Node.js 18+
   - `npm install`

2) Run
```powershell
node symbol_contrast.js <file-or-folder> --csv report.csv
```

Examples
```powershell
# Default backgrounds (white + black)
node symbol_contrast.js symbols --csv contrast_report.csv

# Single file
node symbol_contrast.js symbols\arabic\wrebus\1 ar.png --csv single.csv

# Custom background(s)
node symbol_contrast.js symbols --bg "#ffffff" --bg "#222222" --csv report.csv

# Use a non-white segmentation background
node symbol_contrast.js symbols --bg "#f2f2f2" --segBg "#f2f2f2" --csv report.csv
```

What it does
- Recursively scans a folder for `png`, `jpg`, `jpeg`, `svg`
- Segments background via flood-fill from the image border
- If no background is detected from borders, uses a global near-background mask; if that fails, falls back to testing a thin band along the image border
- Measures WCAG contrast for foreground edge pixels against each background
- Reports per-background stats and a pass/fail

Options
- `--nearBgDist 160` (alias `--nearWhiteDist`) Background color distance for flood-fill segmentation
- `--segBg <color>` Background color used for segmentation (defaults to first `--bg` or white)
- `--alphaBg 10` Treat pixels with alpha <= this as background for segmentation
- `--minAlpha 200` Only evaluate pixels with alpha >= this (ignores semi-transparent edges)
- `--bandRadius 2` Edge band thickness (px)
- `--threshold 3` Contrast threshold (WCAG 1.4.11 non-text)
- `--maxPctBelow 2` Max % of tested pixels allowed below threshold
- `--p 0.05` Percentile to use (p05 by default)
- `--bg <color>` Repeatable background color(s) to test (default: white + black)
- `--requireBoth` Require pass on all backgrounds instead of any
- `--svgDensity 300` Rasterization density for SVG
- `--csv <path>` Write CSV report

Color formats
- `white`, `black`
- Hex: `#fff`, `#ffffff`
- `rgb(r,g,b)`
- Comma-separated: `240,240,240`

Converting EMF/WMF
- The contrast tool only handles PNG/JPEG/SVG. Convert EMF/WMF to PNG first.
- LibreOffice (headless) conversion helper:
```powershell
.\tools\convert_vectors_to_png.ps1 -InputRoot .\symbols -OutputRoot .\symbols_png
```
- Then run the contrast tool on the converted folder:
```powershell
node symbol_contrast.js symbols_png --csv contrast_report.csv
```
