"""
KevinAI Write Nodes for ComfyUI
=================================
Pipeline-aware output — the Nuke Write node for ComfyUI.

Nuke-style versioned directory structure:

    {outputs}/{user}/{sequence}/{shot}/{type}/v{NNN}/
        {shot}_{type}_v{NNN}.{NNNN}.{ext}   ← sequence (Nuke %04d)
        {shot}_{type}_v{NNN}.{ext}           ← single image
        {shot}_{type}_v{NNN}.json            ← one sidecar per version

Example (sequence):
    .../isaacirvin/priceline/ner010/comps/v001/ner010_comp_v001.0000.png
    Nuke Read: .../v001/ner010_comp_v001.%04d.png

Example (single):
    .../isaacirvin/priceline/ner010/styleframes/v001/ner010_styleframe_v001.png
"""

import os, re, json, shutil, subprocess, tempfile
import numpy as np
from pathlib import Path
from datetime import datetime

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths

# ── Version ──────────────────────────────────────────────
KEV_VERSION = "2.4.0"
KEV_BUILD   = "2026.04.02"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PIPELINE DETECTION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_ENV_VARS = (
    "KEV_PROJECT_DIR", "KEV_JOB_DIR",
    "JOB_DIR", "JOB_PATH", "JOB",
    "SHOW_PATH", "SHOW_DIR", "SHOW",
    "SHOT_PATH", "SHOT_DIR",
    "PROJECT_DIR", "PROJECT_PATH", "PROJECT",
    "WORKSPACE", "WORK_DIR",
)

_FFMPEG_SEARCH = (
    "/software/apps/ffmpeg/4.0.2/linux/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/kev/tools/bin/ffmpeg",
)


def _parse_pipeline():
    seq, shot = "", ""
    for var in _ENV_VARS:
        val = os.environ.get(var, "").strip()
        if not val:
            continue
        parts = val.replace("\\", "/").split("/")
        for i, p in enumerate(parts):
            if p == "shots" and i + 2 < len(parts):
                seq = parts[i + 1]
                shot = parts[i + 2]
                return seq, shot
    return seq, shot


def _detect_outputs():
    for path in ("/mnt/comfyui/outputs", "/opt/comfyui/outputs", "/opt/comfyui/output"):
        if os.path.isdir(path):
            return path
    return str(Path.home() / "KevinAI")


def _find_ffmpeg():
    for p in _FFMPEG_SEARCH:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    sys_ffmpeg = shutil.which("ffmpeg")
    if sys_ffmpeg:
        return sys_ffmpeg
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    for p in (
        "/opt/comfyui/venv/bin/ffmpeg",
        "/opt/comfyui/venv/lib/python3.13/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64",
        "/opt/comfyui/venv/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64",
        "/opt/comfyui/venv/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64",
    ):
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _detect_user():
    """Detect the current artist. Tries everything available.

    Priority:
      1. KEVINAI_USER env var (injected by KevinAI Maya)
      2. USER / LOGNAME env var (OS login)
      3. ~/.kevinai_user config file
      4. None (caller decides fallback)
    """
    for var in ("KEVINAI_USER", "USER", "LOGNAME"):
        val = os.environ.get(var, "").strip()
        if val and val not in ("root", "comfyui", "nobody", "www-data"):
            return val
    # Config file (may be on NFS-mounted home)
    for cfg in (os.path.expanduser("~/.kevinai_user"),
                "/tmp/.kevinai_user"):
        try:
            with open(cfg, "r") as f:
                val = f.read().strip()
                if val:
                    return val
        except (OSError, IOError):
            pass
    return None


def _resolve_user(user_input):
    """Resolve artist username for output routing."""
    if user_input and user_input.strip() and user_input.strip() != "_auto_":
        return user_input.strip()
    detected = _detect_user()
    if detected:
        return detected
    return "_unsorted"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PIPELINE NAME SANITIZATION
#  Kevin VFX convention: lowercase, underscores, no spaces
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_CLEAN_RE = re.compile(r"[^a-z0-9_]")


def _sanitize(name):
    """Enforce pipeline naming: lowercase, underscores only.
    'My Shot-Name 01' → 'my_shot_name_01'
    """
    if not name:
        return name
    s = name.strip().lower()
    s = s.replace(" ", "_").replace("-", "_")
    s = _CLEAN_RE.sub("", s)
    # Collapse multiple underscores
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_") or name.strip().lower()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  NUKE-STYLE VERSIONING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_VERSION_RE = re.compile(r"^v(\d{3,})$")


def _next_version_dir(type_dir):
    """Scan for existing v{NNN}/ directories, return next version number.
    Creates the type_dir if needed. Returns (version_number, version_path).

        type_dir:  .../isaacirvin/priceline/ner010/comps/
        returns:   (1, ".../comps/v001/")   or   (3, ".../comps/v003/")
    """
    os.makedirs(type_dir, exist_ok=True)
    max_v = 0
    try:
        for entry in os.listdir(type_dir):
            m = _VERSION_RE.match(entry)
            if m and os.path.isdir(os.path.join(type_dir, entry)):
                max_v = max(max_v, int(m.group(1)))
    except OSError:
        pass
    next_v = max_v + 1
    ver_dir = os.path.join(type_dir, "v{:03d}".format(next_v))
    os.makedirs(ver_dir, exist_ok=True)
    return next_v, ver_dir


def _seq_basename(shot, type_name, version):
    """Build the base name (no frame number, no extension).
        ner010_comp_v001
    """
    return "{}_{}_v{:03d}".format(shot, type_name, version)


def _seq_frame_name(basename, frame, ext):
    """Nuke-style dot-separated frame:  ner010_comp_v001.1001.png"""
    return "{}.{:04d}.{}".format(basename, frame, ext)


def _seq_single_name(basename, ext):
    """Single image (no frame):  ner010_styleframe_v001.png"""
    return "{}.{}".format(basename, ext)


def _nuke_pattern(ver_dir, basename, ext):
    """Nuke Read node pattern: .../v001/ner010_comp_v001.%04d.png"""
    return os.path.join(ver_dir, "{}.%04d.{}".format(basename, ext))


# VFX start frame — industry standard
_START_FRAME = 1001

# Server → workstation path translation
_PATH_TRANSLATIONS = (
    ("/mnt/comfyui/", "/kev/comfyui/"),
    ("/opt/comfyui/", "/kev/comfyui/"),
)


def _to_workstation_path(server_path):
    """Translate server mount path to workstation mount path.
    Handles /mnt/comfyui/ → /kev/comfyui/ in all positions.
    """
    result = server_path
    for server_prefix, ws_prefix in _PATH_TRANSLATIONS:
        if server_prefix in result:
            result = result.replace(server_prefix, ws_prefix, 1)
            break
    return result


def _write_sidecar(filepath, metadata):
    try:
        metadata["saved_at"] = datetime.now().isoformat()
        metadata["file"] = os.path.basename(filepath)
        with open(filepath, "w") as f:
            json.dump(metadata, f, indent=2)
    except Exception as e:
        print("[KevinAI] Sidecar failed: {}".format(e))


def _env_snapshot():
    return {v: os.environ[v] for v in _ENV_VARS if os.environ.get(v)}


def _write_exr(filepath, image_tensor):
    """Write EXR via OpenCV (float32, linear). Falls back to 16-bit TIFF."""
    img_float = image_tensor.cpu().numpy().astype(np.float32)
    try:
        import cv2
        exr_bgr = img_float[:, :, ::-1].copy()
        success = cv2.imwrite(filepath, exr_bgr,
                              [cv2.IMWRITE_EXR_TYPE, cv2.IMWRITE_EXR_TYPE_FLOAT])
        if success:
            print("[KevinAI] EXR (float32 linear): {}".format(filepath))
            return filepath
        raise RuntimeError("cv2.imwrite returned False")
    except ImportError:
        print("[KevinAI] cv2 not available — falling back to 16-bit TIFF")
    except Exception as e:
        print("[KevinAI] EXR write failed ({}), falling back to TIFF".format(e))

    tiff_path = filepath.replace(".exr", ".tif")
    img_16 = (img_float * 65535).clip(0, 65535).astype(np.uint16)
    Image.fromarray(img_16).save(tiff_path)
    print("[KevinAI] TIFF fallback (16-bit): {}".format(tiff_path))
    return tiff_path


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  QUALITY PRESETS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_QUALITY_PRESETS = {
    "highest": {"crf": 10, "preset": "slow",   "codec": "h264_10bit"},
    "high":    {"crf": 10, "preset": "slow",   "codec": "h264"},
    "medium":  {"crf": 18, "preset": "medium", "codec": "h264"},
    "low":     {"crf": 28, "preset": "fast",   "codec": "h264"},
}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  KEVIN WRITE IMAGE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class KevWriteImage:
    """
    KevinAI Write Image — Nuke-style versioned output.

    Single:   .../styleframes/v001/ner010_styleframe_v001.png
    Sequence: .../comps/v001/ner010_comp_v001.0000.png
    Nuke:     .../comps/v001/ner010_comp_v001.%04d.png
    """

    def __init__(self):
        self.temp_dir = folder_paths.get_temp_directory()

    @classmethod
    def INPUT_TYPES(cls):
        seq, shot = _parse_pipeline()
        return {
            "required": {
                "images": ("IMAGE",),
                "sequence": ("STRING", {"default": seq or "show"}),
                "shot": ("STRING", {"default": shot or "shot"}),
                "type": (["comp", "styleframe", "plate", "element", "texture"], {
                    "default": "comp",
                }),
                "format": (["png", "jpg", "exr"], {"default": "png"}),
            },
            "optional": {
                "user": ("STRING", {
                    "default": _detect_user() or "_auto_",
                }),
                "notes": ("STRING", {"default": "", "multiline": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT",)
    RETURN_NAMES = ("output_path", "filename", "version",)
    FUNCTION = "write_image"
    OUTPUT_NODE = True
    CATEGORY = "KevinAI"
    DESCRIPTION = "priceline/ner010/comps/v001/ner010_comp_v001.%04d.png"

    @classmethod
    def VALIDATE_INPUTS(cls, images=None, sequence="", shot="", type="", format="",
                        user="", notes="", prompt=None, extra_pnginfo=None):
        """Runs BEFORE execution — blocks the entire queue instantly."""
        clean_user = _sanitize(_resolve_user(user)) if user else ""
        clean_shot = _sanitize(shot) if shot else ""
        if not clean_user or clean_user in ("_unsorted", "_auto_"):
            return "KevinAI: No username set. Type your name in the 'user' field (e.g. isaacirvin)."
        if not clean_shot or clean_shot in ("comp", "shot", "ai", "show"):
            return "KevinAI: Shot is '{}' — use the job picker or type your shot name (e.g. ner010).".format(shot)
        return True

    def write_image(self, images, sequence, shot, type, format,
                    user="_auto_", notes="",
                    prompt=None, extra_pnginfo=None):

        resolved_user = _sanitize(_resolve_user(user)) or "_unsorted"
        sequence = _sanitize(sequence) or "show"
        shot = _sanitize(shot) or "shot"

        # Pipeline convention: {outputs}/{user}/{seq}/{shot}/ai/{task}/v{NNN}/{format}/
        # Mirrors: shots/ner/ner010/output/plates/plate_flat/v001/jpg/
        task_dir = os.path.join(_detect_outputs(), resolved_user, sequence, shot, "ai", type)

        # Create versioned directory with format subdirectory
        version, ver_dir = _next_version_dir(task_dir)
        fmt_dir = os.path.join(ver_dir, format)
        os.makedirs(fmt_dir, exist_ok=True)
        basename = _seq_basename(shot, type, version)
        is_sequence = len(images) > 1

        print("[KevinAI] Output → {}/{}/{}/ai/{}/v{:03d}/{}/  ({} frame{})".format(
            resolved_user, sequence, shot, type, version, format,
            len(images), "s" if len(images) > 1 else ""))

        results = []
        written_paths = []

        for i, image in enumerate(images):
            img_np = (image.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            pil_img = Image.fromarray(img_np)

            # Nuke-style naming — frames start at 1001
            if is_sequence:
                fname = _seq_frame_name(basename, i + _START_FRAME, format)
            else:
                fname = _seq_single_name(basename, format)

            fpath = os.path.join(fmt_dir, fname)

            if format == "png":
                pi = PngInfo()
                if prompt is not None:
                    pi.add_text("prompt", json.dumps(prompt))
                if extra_pnginfo is not None:
                    for k, v in extra_pnginfo.items():
                        pi.add_text(k, json.dumps(v))
                pi.add_text("KevinAI_shot", shot)
                pi.add_text("KevinAI_sequence", sequence)
                pi.add_text("KevinAI_version", "v{:03d}".format(version))
                pi.add_text("KevinAI_user", resolved_user)
                if is_sequence:
                    pi.add_text("KevinAI_frame", str(i + _START_FRAME))
                pil_img.save(fpath, pnginfo=pi, compress_level=1)
            elif format == "jpg":
                pil_img.save(fpath, quality=98, subsampling=0)
            elif format == "exr":
                actual_path = _write_exr(fpath, image)
                if actual_path != fpath:
                    fpath = actual_path
                    fname = os.path.basename(fpath)

            written_paths.append(fpath)

            # Preview (first + last frame only for sequences, all for singles)
            if not is_sequence or i == 0 or i == len(images) - 1:
                try:
                    pname = "kevprev_{}.png".format(datetime.now().strftime("%H%M%S%f"))
                    pil_img.save(os.path.join(self.temp_dir, pname), compress_level=6)
                    results.append({"filename": pname, "subfolder": "", "type": "temp"})
                except Exception as e:
                    print("[KevinAI] Preview failed: {}".format(e))

        # One sidecar for the entire version (lives at version level, not in format subdir)
        sidecar_path = os.path.join(ver_dir, basename + ".json")
        sidecar_meta = {
            "user": resolved_user,
            "sequence": sequence, "shot": shot,
            "type": type, "version": version,
            "format": format, "notes": notes,
            "frames": len(images),
            "is_sequence": is_sequence,
            "resolution": "{}x{}".format(
                images[0].shape[1], images[0].shape[0]),
            "environment": _env_snapshot(),
            "kevinai_version": KEV_VERSION,
        }
        if is_sequence:
            sidecar_meta["first_frame"] = _START_FRAME
            sidecar_meta["last_frame"] = _START_FRAME + len(images) - 1
            sidecar_meta["nuke_path"] = _to_workstation_path(
                _nuke_pattern(fmt_dir, basename, format))
        _write_sidecar(sidecar_path, sidecar_meta)

        # Filepath for copy button (workstation path):
        if is_sequence:
            copy_path = _to_workstation_path(
                _nuke_pattern(fmt_dir, basename, format))
            copy_path += " {}-{}".format(_START_FRAME, _START_FRAME + len(images) - 1)
        else:
            copy_path = _to_workstation_path(
                written_paths[0] if written_paths else fmt_dir)

        print("[KevinAI] v{:03d} → {} files".format(version, len(written_paths)))
        if is_sequence:
            print("[KevinAI] Nuke: {}".format(copy_path))

        return {"ui": {"images": results, "filepath": [copy_path]},
                "result": (ver_dir, basename, version)}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  KEVIN WRITE VIDEO
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class KevWriteVideo:
    """
    KevinAI Write Video — Nuke-style versioned output.

    Path:  .../video/v001/ner010_video_v001.mp4
    """

    def __init__(self):
        self.temp_dir = folder_paths.get_temp_directory()

    @classmethod
    def INPUT_TYPES(cls):
        seq, shot = _parse_pipeline()
        return {
            "required": {
                "images": ("IMAGE",),
                "sequence": ("STRING", {"default": seq or "show"}),
                "shot": ("STRING", {"default": shot or "shot"}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
            },
            "optional": {
                "user": ("STRING", {
                    "default": _detect_user() or "_auto_",
                }),
                "quality": (["highest", "high", "medium", "low"], {"default": "high"}),
                "bt709": ("BOOLEAN", {"default": True}),
                "notes": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT",)
    RETURN_NAMES = ("output_path", "filename", "version",)
    FUNCTION = "write_video"
    OUTPUT_NODE = True
    CATEGORY = "KevinAI"
    DESCRIPTION = "priceline/ner010/video/v001/ner010_video_v001.mp4"

    @classmethod
    def VALIDATE_INPUTS(cls, images=None, sequence="", shot="", fps=24,
                        user="", quality="high", bt709=True, notes=""):
        """Runs BEFORE execution — blocks the entire queue instantly."""
        clean_user = _sanitize(_resolve_user(user)) if user else ""
        clean_shot = _sanitize(shot) if shot else ""
        if not clean_user or clean_user in ("_unsorted", "_auto_"):
            return "KevinAI: No username set. Type your name in the 'user' field (e.g. isaacirvin)."
        if not clean_shot or clean_shot in ("comp", "shot", "ai", "show"):
            return "KevinAI: Shot is '{}' — use the job picker or type your shot name (e.g. ner010).".format(shot)
        return True

    def write_video(self, images, sequence, shot, fps,
                    user="_auto_", quality="high", bt709=True, notes=""):

        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("[KevinAI] ffmpeg not found")

        # Quality preset → crf/preset/codec
        q = _QUALITY_PRESETS.get(quality, _QUALITY_PRESETS["high"])
        crf = q["crf"]
        preset = q["preset"]
        codec = q["codec"]

        resolved_user = _sanitize(_resolve_user(user)) or "_unsorted"
        sequence = _sanitize(sequence) or "show"
        shot = _sanitize(shot) or "shot"

        # Pipeline convention: {outputs}/{user}/{seq}/{shot}/ai/video/v{NNN}/{ext}/
        task_dir = os.path.join(_detect_outputs(), resolved_user, sequence, shot, "ai", "video")

        # Versioned directory with format subdirectory
        version, ver_dir = _next_version_dir(task_dir)
        ext = "mov" if codec == "prores" else "mp4"
        fmt_dir = os.path.join(ver_dir, ext)
        os.makedirs(fmt_dir, exist_ok=True)
        basename = _seq_basename(shot, "video", version)
        fname = _seq_single_name(basename, ext)
        fpath = os.path.join(fmt_dir, fname)

        print("[KevinAI] Output → {}/{}/{}/ai/video/v{:03d}/{}/".format(
            resolved_user, sequence, shot, version, ext))

        num_frames = len(images)
        if num_frames == 0:
            raise RuntimeError("[KevinAI] Empty batch")

        h, w = images[0].shape[0], images[0].shape[1]
        pix = "yuv422p10le" if codec == "prores" else ("yuv420p10le" if codec == "h264_10bit" else "yuv420p")

        cmd = [ffmpeg, "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24",
               "-s", "{}x{}".format(w, h), "-r", str(fps),
               "-i", "pipe:0"]

        if codec in ("h264", "h264_10bit"):
            cmd += ["-c:v", "libx264", "-crf", str(crf),
                    "-preset", preset, "-pix_fmt", pix]
            if bt709:
                cmd += ["-colorspace", "bt709",
                        "-color_primaries", "bt709",
                        "-color_trc", "bt709"]
            if w % 2 != 0 or h % 2 != 0:
                cmd += ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"]
        elif codec == "prores":
            cmd += ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", pix]

        cmd += ["-movflags", "+faststart", fpath]

        print("[KevinAI] Encoding {} ({} frames, {}x{}, {}fps)".format(
            fname, num_frames, w, h, fps))

        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for image in images:
                frame = (image.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
                proc.stdin.write(frame.tobytes())
            proc.stdin.close()
            proc.wait(timeout=600)
            if proc.returncode != 0:
                stderr = proc.stderr.read().decode() if proc.stderr else ""
                raise RuntimeError("ffmpeg:\n" + stderr[-500:])
        except Exception as e:
            try: proc.kill()
            except: pass
            raise RuntimeError("[KevinAI] Encode failed: {}".format(e))

        file_size = os.path.getsize(fpath)
        duration = num_frames / fps
        print("[KevinAI] {} ({:.1f}s, {:.1f}MB)".format(fname, duration, file_size/(1024*1024)))

        # Preview
        preview_results = []
        try:
            pname = "kevprev_{}.mp4".format(datetime.now().strftime("%H%M%S%f"))
            ppath = os.path.join(self.temp_dir, pname)
            if ext == "mp4" and file_size < 50 * 1024 * 1024:
                shutil.copy2(fpath, ppath)
            else:
                subprocess.run([ffmpeg, "-y", "-i", fpath,
                    "-c:v", "libx264", "-crf", "23", "-preset", "fast",
                    "-pix_fmt", "yuv420p", "-vf", "scale='min(640,iw)':-2",
                    "-movflags", "+faststart", ppath],
                    capture_output=True, timeout=120)
            preview_results.append({
                "filename": pname, "subfolder": "", "type": "temp", "format": "video/mp4"})
        except Exception as e:
            print("[KevinAI] Preview failed: {}".format(e))

        # Thumbnail (first frame)
        try:
            thumb = basename + "_thumb.jpg"
            first_np = (images[0].cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(first_np)
            if pil.width > 480:
                r = 480 / pil.width
                pil = pil.resize((480, int(pil.height * r)), Image.LANCZOS)
            pil.save(os.path.join(ver_dir, thumb), quality=90)
        except Exception as e:
            print("[KevinAI] Thumbnail failed: {}".format(e))

        # Sidecar
        sidecar_path = os.path.join(ver_dir, basename + ".json")
        _write_sidecar(sidecar_path, {
            "user": resolved_user,
            "sequence": sequence, "shot": shot,
            "type": "video", "version": version,
            "quality": quality, "codec": codec, "fps": fps, "crf": crf,
            "preset": preset, "bt709": bt709,
            "frames": num_frames, "duration_sec": round(duration, 2),
            "resolution": "{}x{}".format(w, h),
            "file_size_mb": round(file_size/(1024*1024), 2),
            "notes": notes, "ffmpeg": ffmpeg,
            "environment": _env_snapshot(),
            "kevinai_version": KEV_VERSION,
        })

        return {"ui": {"gifs": preview_results, "filepath": [_to_workstation_path(fpath)]},
                "result": (ver_dir, fname, version)}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PATH INFO
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class KevPathInfo:
    """Show pipeline detection: sequence, shot, env vars, ffmpeg."""
    def __init__(self): pass

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "outputs": ("STRING", {"default": _detect_outputs()}),
        }}

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING",)
    RETURN_NAMES = ("outputs", "sequence", "shot", "env_vars", "ffmpeg",)
    FUNCTION = "info"
    CATEGORY = "KevinAI"

    def info(self, outputs):
        seq, shot = _parse_pipeline()
        ffmpeg = _find_ffmpeg() or "(not found)"
        env = "\n".join("{} = {}".format(v, os.environ[v])
                        for v in _ENV_VARS if os.environ.get(v)) or "(none)"
        print("[KevinAI] seq={} shot={} ffmpeg={}".format(seq or "?", shot or "?", ffmpeg))
        return (outputs, seq or "(none)", shot or "(none)", env, ffmpeg)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  REGISTRATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NODE_CLASS_MAPPINGS = {
    "KevWriteImage": KevWriteImage,
    "KevWriteVideo": KevWriteVideo,
    "KevPathInfo":   KevPathInfo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KevWriteImage": "KevinAI Write Image",
    "KevWriteVideo": "KevinAI Write Video",
    "KevPathInfo":   "KevinAI Path Info",
}

# Printed by __init__.py on load
__version__ = KEV_VERSION


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  API ROUTES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_SHOTS_MANIFEST_PATHS = (
    "/mnt/comfyui/outputs/kevinai_shots.json",
    "/kev/comfyui/outputs/kevinai_shots.json",
    "/opt/comfyui/outputs/kevinai_shots.json",
    "/opt/comfyui/output/kevinai_shots.json",
    "/mnt/comfyui/kevinai_shots.json",
    "/kev/comfyui/kevinai_shots.json",
    "/opt/comfyui/kevinai_shots.json",
)
_shots_cache = None
_shots_cache_mtime = 0


def _find_manifest():
    """Find the shots manifest across possible mount paths."""
    for p in _SHOTS_MANIFEST_PATHS:
        if os.path.isfile(p):
            return p
    return None


def _load_shots():
    """Load the shots manifest. Re-reads if file changed on disk."""
    global _shots_cache, _shots_cache_mtime
    manifest = _find_manifest()
    if not manifest:
        if _shots_cache is None:
            _shots_cache = {}
            print("[KevinAI] No manifest found at: {}".format(", ".join(_SHOTS_MANIFEST_PATHS)))
        return _shots_cache
    try:
        mtime = os.path.getmtime(manifest)
        if _shots_cache is None or mtime != _shots_cache_mtime:
            with open(manifest, "r") as f:
                _shots_cache = json.load(f)
            _shots_cache_mtime = mtime
            print("[KevinAI] Loaded {} jobs from {}".format(len(_shots_cache), manifest))
    except (OSError, IOError, ValueError) as e:
        print("[KevinAI] Manifest load failed: {}".format(e))
        if _shots_cache is None:
            _shots_cache = {}
    return _shots_cache


try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/kevinai/detect")
    async def kevinai_detect(request):
        seq, shot = _parse_pipeline()
        user = _detect_user()
        ffmpeg = _find_ffmpeg()
        manifest = _find_manifest()
        return web.json_response({
            "user": user or "",
            "sequence": seq or "",
            "shot": shot or "",
            "ffmpeg": ffmpeg or "(not found)",
            "version": KEV_VERSION,
            "manifest": manifest or "(not found)",
            "manifest_searched": list(_SHOTS_MANIFEST_PATHS),
        })

    @PromptServer.instance.routes.get("/kevinai/jobs")
    async def kevinai_jobs(request):
        """List available jobs from manifest."""
        data = _load_shots()
        return web.json_response({"jobs": sorted(data.keys())})

    @PromptServer.instance.routes.get("/kevinai/sequences")
    async def kevinai_sequences(request):
        """List sequences for a job."""
        job = request.query.get("job", "")
        data = _load_shots()
        seqs = sorted(data.get(job, {}).keys())
        return web.json_response({"sequences": seqs})

    @PromptServer.instance.routes.get("/kevinai/shots")
    async def kevinai_shots(request):
        """List shots for a sequence."""
        job = request.query.get("job", "")
        seq = request.query.get("seq", "")
        data = _load_shots()
        shots = sorted(data.get(job, {}).get(seq, []))
        return web.json_response({"shots": shots})
except Exception:
    pass
