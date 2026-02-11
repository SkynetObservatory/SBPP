Skynet Batch Post Processing (SBPP)
Concise Workflow Guide – Updated Version
New User Interface Overview
The updated SBPP interface is organized into clear operational sections: File Selection & Statistics, Run Workflow, and Configuration Controls.
File Selection & Statistics:
• Select Master Files according to Mode (SHO or RGB).
• Files are automatically renamed to canonical channel IDs.
• Robust statistics (Mean, Median, Delta = Mean − Median) are computed.
• LinearFit reference can be chosen explicitly or by signal policy.
• Strict WCS validation is enforced. If any master lacks a valid astrometric solution, a critical error is shown, all opened images are closed, and the selection is cleared.
Run Workflow Tab:
• Displays step-by-step execution with timing.
• Logs key events including master load and WCS validation.
• Prevents execution without valid inputs.
Safety & Persistence:
• Configuration persistence between runs.
• Dialog close-guard during execution.
• Deterministic output naming and structured processing order.
Core Workflow Philosophy
SBPP is built for repeatability, stability, and predictable results. Corrective operations are performed in linear space first, irreversible steps are delayed, and automation is deterministic and transparent.
Processing Stages (Condensed)
1. File Selection & Statistical Analysis
Masters are analyzed using robust statistics. Delta (Mean − Median) acts as a signal proxy and drives LinearFit reference selection.
2. Background Extraction (GraXpert)
Gradients are removed early to prevent bias in channel normalization.
3. LinearFit
Channels are normalized to a selected statistical reference to ensure consistent scaling.
4. PSF Correction (BlurXTerminator – Correct Only)
Applied in linear space after normalization to safely correct optical blur.
5. Channel Combination
Channels are combined via ChannelCombination or PixelMath. Palette mapping (SHO, HSO, HOO, RGB) defines semantic color intent.
6. Color Calibration (SPCC)
Spectrophotometric Color Calibration is applied after combination on balanced linear data.
7–8. Linear Noise Reduction & Sharpening
Conservative NoiseXTerminator and optional sharpening are applied before stretch.
9. Optional Star Extraction
StarXTerminator separates stars and starless components once data is stable.
10. Stretching
HistogramTransformation or Multiscale Adaptive Stretch converts data to nonlinear space.
11–12. Optional Nonlinear Refinement
Final polish steps for noise reduction or sharpening.
Astrometric Integrity Enforcement
All masters must contain valid WCS metadata usable by SPCC. Validation checks for embedded astrometric properties or FITS WCS keywords. Failure triggers a critical error, clears selections, and closes all opened views.
Final Notes
SBPP does not impose an artistic style. It produces reliable, calibrated, well-conditioned data so that creative decisions can be made safely afterward.
