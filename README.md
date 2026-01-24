# Skynet Batch Post Processing – Workflow Guide

This document explains the philosophy, structure, and rationale behind the **Skynet Batch Post Processing (SBPP)** workflow. The goal is not only to describe *what* each step does, but *why the sequence matters* and how each stage prepares the data for the next.

The workflow is designed for **repeatability, stability, and predictability** when processing SHO or RGB master frames in PixInsight. Each step is intentionally placed to minimize artifacts, avoid destructive operations, and keep decisions transparent.

---

## Core Design Principles

Before diving into individual steps, it helps to understand the principles that shaped this workflow:

* **Linear-first discipline**: All corrective and balancing operations are performed while the data is still linear. This preserves photometric relationships and avoids amplifying artifacts.
* **Reference-based normalization**: Channels are aligned to a statistically chosen reference to ensure consistent brightness and contrast across filters.
* **Late commitment**: Irreversible operations (stretching, nonlinear sharpening) are delayed until the data is well behaved.
* **Deterministic automation**: The same inputs produce the same outputs. Automation reduces human error without hiding what is happening.

---

## Step 1 – File Selection and Analysis

### What happens

* Master files are selected (SHO or RGB).
* Files are identified and renamed to canonical channel IDs.
* Robust statistics are computed for each channel:

  * **μ (Mean)**
  * **m (Median)**
  * **Δ = Mean − Median**

### Why it matters

This step establishes *situational awareness*. The statistics are not decorative; they provide an early, quantitative view of signal strength and background behavior per channel.

The use of **Δ (Mean minus Median)** acts as a practical signal proxy:

* The median tracks background level.
* The mean is influenced by bright structures.
* Their difference correlates well with usable signal while being relatively stable against gradients.

These stats drive **LinearFit reference selection** later and help avoid subjective guesswork.

---

## Step 2 – Background Extraction (GraXpert)

### What happens

* Large-scale gradients are removed independently from each channel.
* Background smoothing is user-controlled but bounded to safe values.

### Why it comes here

Background extraction must happen **before LinearFit**. Gradients distort channel statistics and bias normalization if left in place.

Performing this step early:

* Improves the reliability of channel-to-channel comparisons.
* Prevents LinearFit from compensating for gradients instead of true signal differences.

---

## Step 3 – Linear Fit

### What happens

* One channel is selected as a reference using a clear policy:

  * Lowest signal
  * Medium signal
  * Highest signal
* All other channels are linearly matched to this reference.

### Why this approach

LinearFit enforces consistent brightness scaling across channels *without altering structure*.

Choosing the reference based on **post-background Δ statistics** ensures:

* The reference represents real signal, not gradient bias.
* The normalization is repeatable and defensible.

This step is foundational. Everything downstream assumes channels are already on a common intensity footing.

---

## Step 4 – PSF Correction (BlurXTerminator, Correct Only)

### What happens

* Point-spread-function correction is applied in linear space.
* Only corrective sharpening is performed (no deconvolution-style enhancement).

### Why it belongs here

PSF correction works best:

* On linear data
* After gradients are removed
* After channel scaling is consistent

Doing this too early risks amplifying background defects. Doing it too late risks nonlinear artifacts. This position is the safest and most effective.

---

## Step 5 – Channel Combination

### What happens

* Channels are combined using either:

  * **ChannelCombination**, or
  * **PixelMath**
* A **Palette** (SHO, HSO, HOO, RGB) defines how channels map to RGB.
* PixelMath expressions automatically rearrange when the palette changes, preserving user edits.

### Why palette-driven mapping

The palette is treated as *semantic intent*, not just UI decoration. By centralizing mapping:

* ChannelCombination and PixelMath stay consistent.
* Switching palettes never destroys custom expressions.
* Color strategy becomes explicit and reproducible.

---

## Step 6 – Color Calibration (SPCC)

### What happens

* Spectrophotometric Color Calibration is applied using mode-appropriate settings.

### Why here

SPCC assumes:

* Balanced channels
* Corrected gradients
* Linear data

Placing it immediately after combination ensures color calibration operates on the cleanest possible signal.

---

## Step 7 – Noise Reduction (Linear)

### What happens

* NoiseXTerminator is applied conservatively in linear space.

### Why now

Linear noise reduction:

* Preserves faint structure
* Avoids blotchy artifacts common in nonlinear denoise

This step reduces background noise *before* stretch amplifies it.

---

## Step 8 – Sharpening (Linear)

### What happens

* BlurXTerminator sharpening is applied to stars and/or non-stellar structures.

### Why it is optional and restrained

Sharpening in linear space is powerful but dangerous. This step is deliberately conservative and optional to avoid ringing, halos, or artificial texture.

---

## Step 9 – Star Extraction (Optional)

### What happens

* StarXTerminator separates stars and starless components.

### Why it is delayed

Star extraction benefits from:

* Clean backgrounds
* Controlled noise
* Balanced channels

Earlier extraction increases the risk of residual artifacts leaking into either layer.

---

## Step 10 – Stretching (HistogramTransformation / MAS)

### What happens

* Linear data is converted to nonlinear using either:

  * HistogramTransformation (STF-style), or
  * Multiscale Adaptive Stretch

### Why stretching is late

Stretching is irreversible. By postponing it:

* All corrective work is finished first.
* Stretch parameters can be chosen with confidence.

---

## Step 11–12 – Nonlinear Refinement (Optional)

### What happens

* Optional nonlinear noise reduction and sharpening are applied.

### Why optional

At this stage, the image is already viable. These steps are final polish, not structural corrections.

---

## Safety and Stability Features

* **Run Workflow gating** prevents execution without valid inputs.
* **Dialog close-guard** blocks closing the script while processing, preventing PixInsight lockups.
* **Persistent configuration** allows repeatable runs without manual re-entry.

---

## Final Thoughts

This workflow is not about producing a specific “look”. It is about **producing reliable data states**.

Once the data is clean, balanced, and well behaved, artistic decisions become easier, safer, and more intentional.

The Skynet Batch Post Processing pipeline exists to remove uncertainty... not creativity.
