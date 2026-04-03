"""
KevinAI Write Node for ComfyUI
================================
Single unified write node — outputs frames, video, or both.
Always shows video preview.

Pipeline structure:
    {outputs}/{user}/{seq}/{shot}/ai/{task}/v{NNN}/
        {fmt}/  {shot}_{task}_v{NNN}.{NNNN}.{ext}   ← frames
        mp4/    {shot}_{task}_v{NNN}.mp4             ← video
        {shot}_{task}_v{NNN}.json                    ← sidecar

Example:
    .../isaacirvin/ner/ner010/ai/comp/v001/
        png/ner010_comp_v001.1001.png
        mp4/ner010_comp_v001.mp4
        ner010_comp_v001.json
"""

import os, re, json, shutil, subprocess, tempfile
import numpy as np
from pathlib import Path
from datetime import datetime

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths

# ── Version ──────────────────────────────────────────────
KEV_VERSION = "3.0.0"
KEV_BUILD   = "2026.04.03"


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
    for var in ("KEVINAI_USER", "USER", "LOGNAME"):
        val = os.environ.get(var, "").strip()
        if val and val not in ("root", "comfyui", "nobody", "www-data"):
            return val
    for cfg in (os.path.expanduser("~/.kevinai_user"), "/tmp/.kevinai_user"):
        try:
            with open(cfg, "r") as f:
                val = f.read().strip()
                if val:
                    return val
        except (OSError, IOError):
            pass
    return None


def _resolve_user(user_input):
    if user_input and user_input.strip() and user_input.strip() != "_auto_":
        return user_input.strip()
    detected = _detect_user()
    if detected:
        return detected
    return "_unsorted"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PIPELINE NAME SANITIZATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_CLEAN_RE = re.compile(r"[^a-z0-9_]")


def _sanitize(name):
    if not name:
        return name
    s = name.strip().lower()
    s = s.replace(" ", "_").replace("-", "_")
    s = _CLEAN_RE.sub("", s)
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_") or name.strip().lower()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  VERSIONING + NAMING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_VERSION_RE = re.compile(r"^v(\d{3,})$")
_START_FRAME = 1001

# Server → workstation path translation
_PATH_TRANSLATIONS = (
    ("/mnt/comfyui/", "/kev/comfyui/"),
    ("/opt/comfyui/", "/kev/comfyui/"),
)


def _to_ws(server_path):
    """Translate server path → workstation path."""
    result = server_path
    for server_prefix, ws_prefix in _PATH_TRANSLATIONS:
        if server_prefix in result:
            result = result.replace(server_prefix, ws_prefix, 1)
            break
    return result


def _next_version_dir(task_dir):
    os.makedirs(task_dir, exist_ok=True)
    max_v = 0
    try:
        for entry in os.listdir(task_dir):
            m = _VERSION_RE.match(entry)
            if m and os.path.isdir(os.path.join(task_dir, entry)):
                max_v = max(max_v, int(m.group(1)))
    except OSError:
        pass
    next_v = max_v + 1
    ver_dir = os.path.join(task_dir, "v{:03d}".format(next_v))
    os.makedirs(ver_dir, exist_ok=True)
    return next_v, ver_dir


def _basename(shot, task, version):
    """ner010_comp_v001"""
    return "{}_{}_v{:03d}".format(shot, task, version)


def _frame_name(base, frame, ext):
    """ner010_comp_v001.1001.png"""
    return "{}.{:04d}.{}".format(base, frame, ext)


def _single_name(base, ext):
    """ner010_comp_v001.mp4"""
    return "{}.{}".format(base, ext)


def _nuke_pattern(dir, base, ext):
    """.../v001/png/ner010_comp_v001.%04d.png"""
    return os.path.join(dir, "{}.%04d.{}".format(base, ext))


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
    img_float = image_tensor.cpu().numpy().astype(np.float32)
    try:
        import cv2
        exr_bgr = img_float[:, :, ::-1].copy()
        success = cv2.imwrite(filepath, exr_bgr,
                              [cv2.IMWRITE_EXR_TYPE, cv2.IMWRITE_EXR_TYPE_FLOAT])
        if success:
            return filepath
        raise RuntimeError("cv2.imwrite returned False")
    except ImportError:
        print("[KevinAI] cv2 not available — TIFF fallback")
    except Exception as e:
        print("[KevinAI] EXR failed ({}), TIFF fallback".format(e))
    tiff_path = filepath.replace(".exr", ".tif")
    img_16 = (img_float * 65535).clip(0, 65535).astype(np.uint16)
    Image.fromarray(img_16).save(tiff_path)
    return tiff_path


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  QUALITY PRESETS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_QUALITY = {
    "highest": {"crf": 10, "preset": "slow",   "codec": "h264_10bit"},
    "high":    {"crf": 10, "preset": "slow",   "codec": "h264"},
    "medium":  {"crf": 18, "preset": "medium", "codec": "h264"},
    "low":     {"crf": 28, "preset": "fast",   "codec": "h264"},
}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  KEVINAI WRITE — UNIFIED NODE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class KevWrite:
    """
    KevinAI Write — unified output node.

    Saves frames, video, or both. Always shows video preview.

    Structure:
        .../ai/{task}/v001/
            png/  ner010_comp_v001.1001.png    (if save_frames)
            mp4/  ner010_comp_v001.mp4         (if save_video)
            ner010_comp_v001.json              (sidecar)
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
                "task": (["comp", "styleframe", "plate", "element", "texture", "video"], {
                    "default": "comp",
                }),
            },
            "optional": {
                "user": ("STRING", {"default": _detect_user() or "_auto_"}),
                "save_frames": ("BOOLEAN", {"default": True}),
                "frame_format": (["png", "jpg", "exr"], {"default": "png"}),
                "save_video": ("BOOLEAN", {"default": True}),
                "quality": (["highest", "high", "medium", "low"], {"default": "high"}),
                "fps": ("INT", {"default": 24, "min": 1, "max": 120}),
                "bt709": ("BOOLEAN", {"default": True}),
                "notes": ("STRING", {"default": "", "multiline": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT",)
    RETURN_NAMES = ("output_path", "filename", "version",)
    FUNCTION = "write"
    OUTPUT_NODE = True
    CATEGORY = "KevinAI"
    DESCRIPTION = ".../ai/comp/v001/png/ner010_comp_v001.%04d.png + mp4/"

    @classmethod
    def VALIDATE_INPUTS(cls, images=None, sequence="", shot="", task="",
                        user="", save_frames=True, frame_format="png",
                        save_video=True, quality="high", fps=24, bt709=True,
                        notes="", prompt=None, extra_pnginfo=None):
        clean_user = _sanitize(_resolve_user(user)) if user else ""
        clean_shot = _sanitize(shot) if shot else ""
        if not clean_user or clean_user in ("_unsorted", "_auto_"):
            return "KevinAI: No username set. Type your name in the 'user' field (e.g. isaacirvin)."
        if not clean_shot or clean_shot in ("comp", "shot", "ai", "show"):
            return "KevinAI: Shot is '{}' — use the job picker or type your shot name (e.g. ner010).".format(shot)
        if not save_frames and not save_video:
            return "KevinAI: Enable at least one of 'save_frames' or 'save_video'."
        return True

    def write(self, images, sequence, shot, task,
              user="_auto_", save_frames=True, frame_format="png",
              save_video=True, quality="high", fps=24, bt709=True,
              notes="", prompt=None, extra_pnginfo=None):

        resolved_user = _sanitize(_resolve_user(user)) or "_unsorted"
        sequence = _sanitize(sequence) or "show"
        shot = _sanitize(shot) or "shot"

        # Pipeline path: {outputs}/{user}/{seq}/{shot}/ai/{task}/v{NNN}/
        task_dir = os.path.join(_detect_outputs(), resolved_user, sequence, shot, "ai", task)
        version, ver_dir = _next_version_dir(task_dir)
        base = _basename(shot, task, version)

        num_frames = len(images)
        if num_frames == 0:
            raise RuntimeError("[KevinAI] Empty batch")

        h, w = images[0].shape[0], images[0].shape[1]
        is_sequence = num_frames > 1

        print("[KevinAI] Output → {}/{}/{}/ai/{}/v{:03d}/".format(
            resolved_user, sequence, shot, task, version))
        if save_frames:
            print("[KevinAI]   Frames: {} × {} ({})".format(num_frames, frame_format, "sequence" if is_sequence else "single"))
        if save_video:
            print("[KevinAI]   Video: {} quality, {}fps".format(quality, fps))

        image_results = []
        video_results = []
        frame_paths = []
        video_path = ""

        # ── SAVE FRAMES ───────────────────────────────
        if save_frames:
            fmt_dir = os.path.join(ver_dir, frame_format)
            os.makedirs(fmt_dir, exist_ok=True)

            for i, image in enumerate(images):
                img_np = (image.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
                pil_img = Image.fromarray(img_np)

                if is_sequence:
                    fname = _frame_name(base, i + _START_FRAME, frame_format)
                else:
                    fname = _single_name(base, frame_format)

                fpath = os.path.join(fmt_dir, fname)

                if frame_format == "png":
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
                elif frame_format == "jpg":
                    pil_img.save(fpath, quality=98, subsampling=0)
                elif frame_format == "exr":
                    actual = _write_exr(fpath, image)
                    if actual != fpath:
                        fpath = actual

                frame_paths.append(fpath)

                # Preview thumbnails (first + last only for sequences)
                if not is_sequence or i == 0 or i == num_frames - 1:
                    try:
                        pname = "kevprev_{}.png".format(datetime.now().strftime("%H%M%S%f"))
                        pil_img.save(os.path.join(self.temp_dir, pname), compress_level=6)
                        image_results.append({"filename": pname, "subfolder": "", "type": "temp"})
                    except Exception:
                        pass

            print("[KevinAI] Frames: {} written".format(len(frame_paths)))

        # ── SAVE VIDEO ────────────────────────────────
        if save_video:
            ffmpeg = _find_ffmpeg()
            if not ffmpeg:
                print("[KevinAI] WARNING: ffmpeg not found — skipping video")
            else:
                q = _QUALITY.get(quality, _QUALITY["high"])
                crf = q["crf"]
                preset = q["preset"]
                codec = q["codec"]
                ext = "mp4"
                pix = "yuv420p10le" if codec == "h264_10bit" else "yuv420p"

                mp4_dir = os.path.join(ver_dir, ext)
                os.makedirs(mp4_dir, exist_ok=True)
                fname = _single_name(base, ext)
                fpath = os.path.join(mp4_dir, fname)

                cmd = [ffmpeg, "-y",
                       "-f", "rawvideo", "-pix_fmt", "rgb24",
                       "-s", "{}x{}".format(w, h), "-r", str(fps),
                       "-i", "pipe:0",
                       "-c:v", "libx264", "-crf", str(crf),
                       "-preset", preset, "-pix_fmt", pix]

                if bt709:
                    cmd += ["-colorspace", "bt709",
                            "-color_primaries", "bt709",
                            "-color_trc", "bt709"]
                if w % 2 != 0 or h % 2 != 0:
                    cmd += ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"]
                cmd += ["-movflags", "+faststart", fpath]

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
                    print("[KevinAI] Encode failed: {}".format(e))
                    fpath = ""

                if fpath and os.path.isfile(fpath):
                    video_path = fpath
                    file_size = os.path.getsize(fpath)
                    duration = num_frames / fps
                    print("[KevinAI] Video: {} ({:.1f}s, {:.1f}MB)".format(
                        fname, duration, file_size / (1024 * 1024)))

                    # Copy to temp for preview
                    try:
                        pname = "kevprev_{}.mp4".format(datetime.now().strftime("%H%M%S%f"))
                        ppath = os.path.join(self.temp_dir, pname)
                        if file_size < 50 * 1024 * 1024:
                            shutil.copy2(fpath, ppath)
                        else:
                            subprocess.run([ffmpeg, "-y", "-i", fpath,
                                "-c:v", "libx264", "-crf", "23", "-preset", "fast",
                                "-pix_fmt", "yuv420p", "-vf", "scale='min(640,iw)':-2",
                                "-movflags", "+faststart", ppath],
                                capture_output=True, timeout=120)
                        video_results.append({
                            "filename": pname, "subfolder": "", "type": "temp", "format": "video/mp4"})
                    except Exception as e:
                        print("[KevinAI] Preview failed: {}".format(e))

        # ── THUMBNAIL ─────────────────────────────────
        try:
            thumb = base + "_thumb.jpg"
            first_np = (images[0].cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
            pil = Image.fromarray(first_np)
            if pil.width > 480:
                r = 480 / pil.width
                pil = pil.resize((480, int(pil.height * r)), Image.LANCZOS)
            pil.save(os.path.join(ver_dir, thumb), quality=90)
        except Exception:
            pass

        # ── SIDECAR ───────────────────────────────────
        sidecar_path = os.path.join(ver_dir, base + ".json")
        sidecar = {
            "user": resolved_user,
            "sequence": sequence, "shot": shot,
            "task": task, "version": version,
            "frames": num_frames,
            "resolution": "{}x{}".format(w, h),
            "notes": notes,
            "saved_frames": save_frames,
            "saved_video": save_video,
            "environment": _env_snapshot(),
            "kevinai_version": KEV_VERSION,
        }
        if save_frames and is_sequence:
            sidecar["frame_format"] = frame_format
            sidecar["first_frame"] = _START_FRAME
            sidecar["last_frame"] = _START_FRAME + num_frames - 1
            sidecar["nuke_path"] = _to_ws(
                _nuke_pattern(os.path.join(ver_dir, frame_format), base, frame_format))
        if save_video and video_path:
            sidecar["video_path"] = _to_ws(video_path)
            sidecar["quality"] = quality
            sidecar["fps"] = fps
            sidecar["bt709"] = bt709
        _write_sidecar(sidecar_path, sidecar)

        # ── COPY PATH (for JS button) ────────────────
        # Priority: Nuke frame path if frames saved, video path if only video
        copy_paths = []
        if save_frames and frame_paths:
            if is_sequence:
                p = _to_ws(_nuke_pattern(
                    os.path.join(ver_dir, frame_format), base, frame_format))
                p += " {}-{}".format(_START_FRAME, _START_FRAME + num_frames - 1)
                copy_paths.append(p)
            else:
                copy_paths.append(_to_ws(frame_paths[0]))
        if save_video and video_path:
            copy_paths.append(_to_ws(video_path))

        primary_path = copy_paths[0] if copy_paths else _to_ws(ver_dir)

        print("[KevinAI] v{:03d} done.".format(version))

        return {"ui": {
                    "images": image_results,
                    "gifs": video_results,
                    "filepath": copy_paths,
                },
                "result": (_to_ws(ver_dir), base, version)}


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
    "KevWrite":    KevWrite,
    "KevPathInfo": KevPathInfo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KevWrite":    "KevinAI Write",
    "KevPathInfo": "KevinAI Path Info",
}

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
    for p in _SHOTS_MANIFEST_PATHS:
        if os.path.isfile(p):
            return p
    return None


def _load_shots():
    global _shots_cache, _shots_cache_mtime
    manifest = _find_manifest()
    if not manifest:
        if _shots_cache is None:
            _shots_cache = {}
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
        })

    @PromptServer.instance.routes.get("/kevinai/jobs")
    async def kevinai_jobs(request):
        data = _load_shots()
        return web.json_response({"jobs": sorted(data.keys())})

    @PromptServer.instance.routes.get("/kevinai/sequences")
    async def kevinai_sequences(request):
        job = request.query.get("job", "")
        data = _load_shots()
        seqs = sorted(data.get(job, {}).keys())
        return web.json_response({"sequences": seqs})

    @PromptServer.instance.routes.get("/kevinai/shots")
    async def kevinai_shots(request):
        job = request.query.get("job", "")
        seq = request.query.get("seq", "")
        data = _load_shots()
        shots = sorted(data.get(job, {}).get(seq, []))
        return web.json_response({"shots": shots})

except Exception:
    pass
