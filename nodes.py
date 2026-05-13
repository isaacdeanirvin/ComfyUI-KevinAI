import os, torch

def _find_ply(ply_input):
    allowed = ["/kev/comfyui/outputs", "/kev/comfyui/input",
        os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "output")),
        os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "input"))]
    for root in [""] + allowed:
        p = os.path.normpath(os.path.join(root, ply_input) if root else ply_input)
        if not p.endswith((".ply",".splat")): continue
        if not any(p.startswith(r) for r in allowed): continue
        if os.path.isfile(p): return p
    raise FileNotFoundError(f"KSplat: not found — {ply_input}")

class KSplatLoadPly:
    CATEGORY = "Kevin VFX"
    FUNCTION = "load"
    RETURN_TYPES = ("KSPLAT_PLY", "STRING")
    RETURN_NAMES = ("ply_data", "resolved_path")
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"ply_path": ("STRING", {"default": "point_cloud.ply", "multiline": False})}}
    def load(self, ply_path):
        resolved = _find_ply(ply_path.strip())
        print(f"[KSplat] {resolved} ({os.path.getsize(resolved)/1024/1024:.1f} MB)")
        return ({"path": resolved, "filename": os.path.basename(resolved)}, resolved)

class KSplatViewer:
    CATEGORY = "Kevin VFX"
    FUNCTION = "view"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_NODE = True
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"ply_data": ("KSPLAT_PLY",), "width": ("INT", {"default": 1920, "min": 512, "max": 4096, "step": 64}), "height": ("INT", {"default": 1080, "min": 512, "max": 4096, "step": 64})}, "hidden": {"unique_id": "UNIQUE_ID"}}
    def view(self, ply_data, width, height, unique_id=None):
        return {"ui": {"gsv_viewer": [{"ply_url": f"/gsv/ply?path={ply_data['path']}", "filename": ply_data["filename"], "node_id": unique_id}]}, "result": (torch.zeros((1, height, width, 3), dtype=torch.float32),)}

NODE_CLASS_MAPPINGS = {"KSplatLoadPly": KSplatLoadPly, "KSplatViewer": KSplatViewer}
NODE_DISPLAY_NAME_MAPPINGS = {"KSplatLoadPly": "KSplat · Load PLY", "KSplatViewer": "KSplat · Viewer"}
