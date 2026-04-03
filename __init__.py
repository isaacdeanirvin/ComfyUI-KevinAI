"""
ComfyUI-KevinAI
===============
Custom nodes for Kevin VFX studio pipeline integration.

Nodes:
 - KevinAI Write     — Unified output: frames + video + preview
 - KevinAI Path Info — Show pipeline paths & env vars
"""

from .nodes.kev_write import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    KEV_VERSION,
    KEV_BUILD,
)

# Client-side JS for video preview widget + Kevin AI branding
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("\n[KevinAI] ComfyUI-KevinAI v{} ({})".format(KEV_VERSION, KEV_BUILD))
print("[KevinAI] Nodes loaded:")
for internal_name, display_name in NODE_DISPLAY_NAME_MAPPINGS.items():
    print("  → {}".format(display_name))
print()
