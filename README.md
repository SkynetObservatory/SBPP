# Skynet Batch Post Processing (SBPP)

**Concise Workflow Guide – Current Version**

SBPP is a structured, deterministic linear workflow for SHO and RGB master frames in PixInsight. Its purpose is not to impose a specific aesthetic, but to produce clean, balanced, well-conditioned data states from which creative decisions can be made safely.

---

## New User Interface Overview

The updated interface is organized around three core areas: **File Selection and Statistics**, **Run Workflow**, and **Configuration Controls**.

### File Selection and Statistics

- Select Master Files according to Mode (SHO or RGB).
- Files are automatically identified and renamed to canonical channel IDs.
- Robust statistics are computed for each channel:
  - Mean  
  - Median  
  - Delta (Mean minus Median)
- LinearFit reference can be selected manually or by signal policy.
- Strict WCS validation is enforced.

### Astrometric Integrity Enforcement

All masters must contain a valid astrometric solution usable by SPCC. Validation checks for embedded astrometric properties or required WCS keywords.

If any master fails validation:

- A **Critical error dialog** is shown.
- All opened images from the selection attempt are closed.
- The master list is cleared.

No partial state is allowed.

### Run Workflow Tab

- Displays step-by-step execution with timing.
- Logs key events including master loading and WCS validation.
- Prevents execution without valid inputs.

The log window reflects real processing state, not assumptions.

### Safety and Persistence

- Configuration persistence between runs.
- Dialog close-guard during execution.
- Deterministic naming and structured processing order.

The same inputs always produce the same outputs.

---

## Core Workflow Philosophy

### Linear-first discipline
All corrective operations are performed while the data is still linear. This preserves photometric relationships and avoids amplifying artifacts.

### Reference-based normalization
Channels are scaled against a statistically defined reference, not by eye.

### Late commitment
Irreversible operations such as stretching are delayed until the data is clean and stable.

---

## Processing Stages (Condensed)

### 1. File Selection and Statistical Analysis
Masters are analyzed using robust statistics. Delta (Mean minus Median) acts as a practical signal proxy and drives LinearFit reference selection.

### 2. Background Extraction (GraXpert)
Large-scale gradients are removed early to prevent bias in normalization and channel comparison.

### 3. LinearFit
Channels are normalized to a selected statistical reference to ensure consistent intensity scaling.

### 4. PSF Correction (BlurXTerminator – Correct Only)
Applied in linear space after normalization to safely correct optical blur without nonlinear artifacts.

### 5. Channel Combination
Channels are combined using ChannelCombination or PixelMath.  
Palette mapping (SHO, HSO, HOO, RGB) defines semantic color intent and preserves consistency across modes.

### 6. Color Calibration (SPCC)
Spectrophotometric Color Calibration is applied after combination on balanced linear data.

### 7–8. Linear Noise Reduction and Sharpening
NoiseXTerminator and optional sharpening are applied conservatively before stretch.

### 9. Optional Star Extraction
StarXTerminator separates stars and starless components once the data is stable.

### 10. Stretching
HistogramTransformation or Multiscale Adaptive Stretch converts linear data to nonlinear space.

### 11–12. Optional Nonlinear Refinement
Final polish steps for noise reduction or sharpening.

---

## Final Notes

SBPP does not attempt to create a “look.” It produces reliable, calibrated, well-conditioned data.

Once the signal is clean and balanced, artistic decisions become easier, safer, and intentional.

The pipeline exists to remove uncertainty… not creativity.
