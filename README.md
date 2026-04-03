# ComfyUI-KevinAI

Pipeline-aware custom nodes for **Kevin VFX studio**. The Nuke Write node for ComfyUI.

## Nodes (4)

### KevinAI Write Image
Save PNG/JPG/EXR to a versioned pipeline directory.

```
[VAE Decode] → IMAGE → [KevinAI Write Image]
                            → v001/styleframes/sg_20260324_canny_s42.png
                            → v001/styleframes/sg_20260324_canny_s42.json (sidecar)
```

- Auto-detects job from `KEV_PROJECT_DIR`, `JOB_DIR`, etc.
- Versioned output: `{job}/output/AI/v001/styleframes/`
- Pipeline filenames with seed, tag, timestamp
- PNG metadata: embeds `KevinAI_version`, `KevinAI_seed`, workflow
- JSON sidecar with env snapshot, seed, notes, resolution
- Batch support: frame numbering (`f0000`, `f0001`, ...)

### KevinAI Write Video
Encode IMAGE batch → MP4/ProRes via ffmpeg.

```
[AnimateDiff] → IMAGE batch → [KevinAI Write Video]
                                  → v001/video/shot_20260324_depth_s42.mp4
                                  → v001/video/shot_20260324_depth_s42.json
                                  → v001/video/shot_20260324_depth_s42_thumb.jpg
```

- h264 (MP4, small) or ProRes (MOV, for comp)
- bt709 color tagging for correct RV display
- Auto-extracts first-frame thumbnail
- Studio ffmpeg: `/software/apps/ffmpeg/4.0.2/linux/ffmpeg` (falls back to system)
- Video sidecar includes: codec, fps, frames, duration, file size

### KevinAI Path Info
Debug node — shows resolved paths, env vars, ffmpeg location. No side effects.

### KevinAI Version Up
Creates next version directory with standard subdirs. Wire before Write to force a new version.

## Output Structure

```
/jobs/cologuard_12345/output/AI/
├── v001/
│   ├── manifest.json           ← audit trail (all saves)
│   ├── styleframes/            ← PNG/JPG/EXR
│   │   ├── sg_20260324_s42.png
│   │   └── sg_20260324_s42.json
│   ├── video/                  ← MP4/MOV
│   │   ├── shot_20260324_s42.mp4
│   │   ├── shot_20260324_s42.json
│   │   └── shot_20260324_s42_thumb.jpg
│   ├── comfy/                  ← general ComfyUI output
│   ├── models/                 ← 3D models
│   ├── training/               ← LORA training data
│   ├── plates/
│   └── elements/
└── v002/
    └── ...
```

## Environment Variables

Checked in order (first valid directory wins):

| Variable | Source |
|----------|--------|
| `KEV_PROJECT_DIR` | Kevin pipeline |
| `KEV_JOB_DIR` | Kevin pipeline |
| `JOB_DIR` / `JOB_PATH` / `JOB` | Generic VFX |
| `SHOW_PATH` / `SHOW_DIR` / `SHOW` | Show-level |
| `SHOT_PATH` / `SHOT_DIR` | Shot-level |
| `PROJECT_DIR` / `PROJECT_PATH` | Project-level |
| `WORKSPACE` / `WORK_DIR` | Fallback |

## Install

```bash
cp -r ComfyUI-KevinAI  /path/to/ComfyUI/custom_nodes/
# Restart ComfyUI
```

Nodes appear under **KevinAI** category.

---
*Kevin VFX · KevinAI v1.2*
