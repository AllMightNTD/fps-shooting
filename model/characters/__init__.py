"""Character 3D PBR builders: first-person arms and third-person tactical soldier."""

from .fps_arms import FPS_ARMS_METADATA, build_fps_arms_glb
from .soldier import SOLDIER_METADATA, build_soldier_nodes

__all__ = ["FPS_ARMS_METADATA", "SOLDIER_METADATA", "build_fps_arms_glb", "build_soldier_nodes"]

