# KevinAI ComfyUI Nodes — Wiki

**Version:** 1.0  
**Studio:** Kevin VFX  
**Server:** comfyui:8188  
**Install path:** /kev/comfyui/custom_nodes/ComfyUI-KevinAI/

---

## What Are These Nodes?

Every ComfyUI workflow needs an output node — something that takes the generated image or video and saves it somewhere. ComfyUI ships with "Save Image" and the community has VHS "Video Combine." Both work, but they dump files into a generic folder with meaningless names like `ComfyUI_00042_.png`.

KevinAI Write nodes are Kevin VFX's replacement. They save to a proper versioned pipeline structure with full metadata tracking — just like how Nuke's Write node writes to the pipeline, these do the same thing for ComfyUI.

---

## The Nodes

### KevinAI Write Image

**What it does:** Saves images (PNG, JPG, or EXR) to a versioned pipeline directory with a JSON sidecar that tracks exactly how that image was created.

**When to use:** Any time you'd normally use ComfyUI's "Save Image" node. Drop-in replacement.

**What you get:**

Instead of: `ComfyUI/output/ComfyUI_00042_.png`

You get:
```
/opt/comfyui/output/AI/v001/styleframes/
├── kev_20260324_143022_canny_s42.png      ← your image
└── kev_20260324_143022_canny_s42.json     ← metadata sidecar
```

The filename tells you: who made it (kev), when (20260324_143022), what technique (canny), and what seed (s42). The JSON sidecar records the full environment, resolution, seed, notes, and which version it belongs to.

**Shows a preview** of the image directly on the node, just like Save Image does.

**Key settings:**

| Setting | What it does | Default |
|---------|-------------|---------|
| job_dir | Root directory for all output | Auto-detected or `/opt/comfyui/output` |
| ai_subpath | Path under job_dir | `AI` |
| version_mode | Which version folder to use | `auto` (latest) |
| subdirectory | Where inside the version | `styleframes` |
| prefix | Start of filename | `kev` |
| format | Image format | `png` |
| file_seed | Seed number in filename | -1 (omit) |
| extra_tag | Extra label in filename | empty |
| notes | Saved to sidecar JSON | empty |

---

### KevinAI Write Video

**What it does:** Takes a batch of images (like what AnimateDiff, WAN, or LTX produces) and encodes them into an MP4 or ProRes video file using ffmpeg. Pipeline-versioned, same as Write Image but for video.

**When to use:** Any time you'd normally use VHS "Video Combine." Drop-in replacement with higher quality defaults.

**Why it's better than VHS Combine:**

| | VHS Combine | KevinAI Write Video |
|---|---|---|
| Quality (CRF) | 19 | 15 (more detail preserved) |
| Encode preset | medium | slow (better compression) |
| Color space | untagged | bt709 tagged (correct display in RV) |
| 10-bit color | no | yes (h264_10bit option) |
| Pipeline naming | no | yes (versioned + sidecar) |
| Chroma | 4:2:0 only | 4:4:4 option (no color smearing) |

**Shows a video player** directly on the node with playback controls, loop, and the Kevin logo badge. Just like VHS Combine's preview, but Kevin-branded.

**Auto-generates a thumbnail** (first frame, saved as JPG alongside the video).

**Key settings:**

| Setting | What it does | Default |
|---------|-------------|---------|
| fps | Frames per second | 24 |
| crf | Quality (lower = better) | 15 |
| preset | Encode speed/quality tradeoff | slow |
| codec | h264, h264_10bit, or prores | h264 |
| pix_fmt | Pixel format | yuv420p |
| bt709_tag | Color space tagging for RV | true |

---

### KevinAI Path Info

**What it does:** Shows you what pipeline path would be used, which environment variables are set, and where ffmpeg is installed. Does not save anything.

**When to use:** When setting up a new workstation or debugging path issues. Drop it on the canvas, run it, check the outputs. Remove it when you're done.

---

### KevinAI Version Up

**What it does:** Creates the next version folder (v001 → v002 → v003) with all standard subdirectories pre-built.

**When to use:** When you want to explicitly start a new version before saving. Wire it before a Write node. Most of the time you can just use `version_mode: version_up` on the Write node itself, so this is optional.

---

## Pipeline Output Structure

```
/opt/comfyui/output/AI/
├── v001/
│   ├── manifest.json           ← tracks every save (audit trail)
│   ├── styleframes/            ← Write Image output (PNG/JPG/EXR)
│   │   ├── kev_20260324_143022_s42.png
│   │   └── kev_20260324_143022_s42.json
│   ├── video/                  ← Write Video output (MP4/MOV)
│   │   ├── shot_20260324_150100_depth_s42.mp4
│   │   ├── shot_20260324_150100_depth_s42.json
│   │   └── shot_20260324_150100_depth_s42_thumb.jpg
│   ├── comfy/                  ← general ComfyUI output
│   ├── models/                 ← 3D model exports
│   ├── training/               ← LORA training data
│   ├── plates/
│   └── elements/
├── v002/
│   └── ...
└── v003/
    └── ...
```

---

## Filename Format

```
{prefix}_{YYYYMMDD}_{HHMMSS}_{extra_tag}_s{seed}.{ext}
```

Examples:
- `kev_20260324_143022_canny_s42.png` — image, canny technique, seed 42
- `shot_20260324_150100_depth_s99.mp4` — video, depth-based, seed 99
- `sg_20260324_160000.png` — image, no tag, no seed

---

## Sidecar JSON

Every output file gets a companion `.json` with the same name:

```json
{
  "saved_at": "2026-03-24T14:30:22",
  "file": "kev_20260324_143022_canny_s42.png",
  "type": "image",
  "job_dir": "/opt/comfyui/output",
  "version": "v001",
  "subdirectory": "styleframes",
  "seed": 42,
  "format": "png",
  "resolution": "1024x1024",
  "notes": "First pass lookdev frame",
  "environment": {
    "KEV_PROJECT_DIR": "/kev/jobs/cologuard_12345"
  }
}
```

Video sidecars include additional fields: codec, fps, crf, preset, frame count, duration, file size, bt709 status, and ffmpeg path used.

---

## Manifest

Each version folder has a `manifest.json` that records every save — an audit trail of everything generated in that version:

```json
{
  "version": "v001",
  "entries": [
    {
      "type": "styleframes",
      "filename": "kev_20260324_143022_s42.png",
      "media": "image",
      "seed": 42,
      "format": "png",
      "resolution": "1024x1024",
      "timestamp": "2026-03-24T14:30:22"
    },
    {
      "type": "video",
      "filename": "shot_20260324_150100_s42.mp4",
      "media": "video",
      "codec": "h264",
      "fps": 24,
      "frames": 81,
      "duration_sec": 3.38,
      "timestamp": "2026-03-24T15:01:01"
    }
  ]
}
```

---

## Typical Workflows

### Basic image generation
```
[KSampler] → [VAE Decode] → [KevinAI Write Image]
```
Set prefix to `kev`, format to `png`, subdirectory to `styleframes`.

### Video generation (WAN, LTX, AnimateDiff)
```
[Video Model] → [KevinAI Write Video]
```
Set prefix to `shot`, fps to match your model output (usually 16 or 24).

### Version up then save
```
[KevinAI Version Up] → version_number → [KevinAI Write Image] (set version_mode to match)
```

### Debug paths
```
[KevinAI Path Info] → run it → check terminal output
```

---

## Setup for Artists

1. Open comfyui:8188 in your browser
2. Right-click canvas → search "KevinAI"
3. On Write Image or Write Video nodes, set:
   - `job_dir`: `/opt/comfyui/output`
   - `ai_subpath`: `AI`
4. Everything else can stay default
5. Wire it where Save Image or VHS Combine would go

Your files will be at `/kev/comfyui/output/AI/v001/` from your workstation.

---

## Server Details

| Item | Value |
|------|-------|
| ComfyUI server | comfyui:8188 |
| Install path (server) | /opt/comfyui/ |
| Custom nodes (network) | /kev/comfyui/custom_nodes/ComfyUI-KevinAI/ |
| Output (server) | /opt/comfyui/output/AI/ |
| Output (workstation) | /kev/comfyui/output/AI/ |
| ffmpeg (studio) | /software/apps/ffmpeg/4.0.2/linux/ffmpeg |

---

## Future Nodes (Planned)

- **KevinAI Alpha/Matte** — Generate alpha channels from frames using SAM2/rembg for intelligent object matting
- **KevinAI Read** — Load images from the versioned pipeline structure back into ComfyUI

---

*Kevin VFX · 2026*
