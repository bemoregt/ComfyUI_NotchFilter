# ComfyUI Spectrum Notch Filter

A ComfyUI custom node for removing periodic noise from images via frequency-domain notch filtering.
Takes an FFT amplitude spectrum image as input, masks the noise peaks, and outputs the cleaned spectrum ready for inverse FFT.

![이미지 스펙트럼 예시](https://github.com/bemoregt/ComfyUI_NotchFilter/blob/main/ScrShot%2019.png)

---

## Nodes

### Spectrum Notch Filter (Auto)

Automatically detects periodic noise peaks in a spectrum image using local maxima analysis and applies circular notch masks.

**Inputs**

| Name | Type | Default | Description |
|---|---|---|---|
| `spectrum` | IMAGE | — | FFT amplitude spectrum image |
| `threshold_rel` | FLOAT | 0.5 | Peak detection threshold relative to the maximum value. Lower → more peaks detected |
| `min_distance` | INT | 10 | Minimum distance (px) between detected peaks. Prevents double-detection of the same peak |
| `notch_radius` | INT | 8 | Radius (px) of the circular mask applied around each peak |
| `protect_dc` | INT | 20 | Radius (px) around the DC component (image center) to ignore during detection |
| `feather` | INT | 2 | Gaussian sigma for soft mask edges. `0` = hard binary mask |

**Outputs**

| Name | Type | Description |
|---|---|---|
| `filtered_spectrum` | IMAGE | Spectrum with noise peaks zeroed out |
| `notch_mask` | IMAGE | White-on-black mask image (white = removed region) |
| `preview` | IMAGE | Input spectrum annotated with yellow rings at detected peaks and a blue ring at the DC zone |
| `peak_positions` | STRING | JSON array of detected peaks — wire this into **SpectrumNotchManual** for manual refinement |

---

### Spectrum Notch Filter (Manual)

Applies user-drawn circular notch masks to a spectrum image. Features an interactive canvas widget embedded directly in the node.

**Inputs**

| Name | Type | Default | Description |
|---|---|---|---|
| `spectrum` | IMAGE | — | FFT amplitude spectrum image |
| `notch_points` | STRING | `[]` | JSON array of notch circles. Automatically updated by the canvas widget |
| `feather` | INT | 2 | Gaussian sigma for soft mask edges |
| `protect_dc` | INT | 0 | Optional DC protection radius (applied in addition to drawn circles) |

**Outputs**

| Name | Type | Description |
|---|---|---|
| `filtered_spectrum` | IMAGE | Spectrum with selected peaks masked |
| `notch_mask` | IMAGE | Mask image |

#### Canvas Widget Controls

After running the node once, the input spectrum is displayed as the canvas background.

| Action | Effect |
|---|---|
| **Left-click** | Add a notch circle at the clicked position |
| **Right-click** | Remove the circle under the cursor |
| **Shift + drag** | Resize the nearest circle in real time |
| **Radius slider** | Set the default radius for newly added circles |
| **Symmetry checkbox** | Automatically add the conjugate-symmetric counterpart of each circle (recommended for standard FFT spectra) |
| **Clear button** | Remove all notch circles |

The blue crosshair marks the DC component (image center). Circle indices are shown inside each circle.

---

## Recommended Workflow

```
[Image → Spectrum node]
        │
        ▼
[SpectrumNotchAuto]  ──── preview ──────► [PreviewImage]  (inspect detected peaks)
        │
        │  peak_positions (STRING)
        ▼
[SpectrumNotchManual]   ◄── run once, then click to refine on canvas
        │
        │  filtered_spectrum
        ▼
[Inverse FFT node]
        │
        ▼
    [Output Image]
```

1. Connect your amplitude spectrum to **SpectrumNotchAuto**.
2. Tune `threshold_rel` and `notch_radius` until the `preview` output looks correct.
3. Wire `peak_positions` into `notch_points` of **SpectrumNotchManual**.
4. Run the Manual node — the spectrum appears on the canvas.
5. Click to add or remove individual notch circles, then re-run.

---

## Installation

```bash
# From your ComfyUI custom_nodes directory
git clone https://github.com/your-username/ComfyUI_NotchFilter
cd ComfyUI_NotchFilter
pip install -r requirements.txt
```

Restart ComfyUI. The two nodes appear under **image/frequency** in the node menu.

### Dependencies

- `numpy`
- `scipy`
- `Pillow`
- `torch` (already provided by ComfyUI)

---

## How It Works

### Peak Detection (Auto node)

```
spectrum image → grayscale → maximum_filter (size = 2·min_distance + 1)
→ local maxima where value ≥ threshold_rel · max
→ exclude DC zone
→ circular masks around each peak (+ Gaussian feather)
→ filtered = spectrum × (1 − mask)
```

Uses `scipy.ndimage.maximum_filter` — no additional dependencies beyond scipy.

### Notch `peak_positions` JSON Format

```json
[
  {"x": 128, "y":  64, "r": 8},
  {"x": 128, "y": 192, "r": 8}
]
```

- `x`, `y`: pixel coordinates in the spectrum image (origin = top-left)
- `r`: notch circle radius in pixels

You can also type or paste this JSON directly into the `notch_points` field.

---

## Example: Removing Grid Artifacts

Grid-pattern noise in an image produces a regular array of bright dots in the FFT spectrum (excluding the DC center). Set `protect_dc` to ~20, lower `threshold_rel` until all the artifact dots are highlighted in the preview, then run the filter. Wire the result to your inverse FFT node to recover the cleaned image.
