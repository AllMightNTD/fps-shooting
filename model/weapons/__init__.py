"""Weapon 3D model definitions built on top of ``model.core``."""

from .awm import AWM_METADATA, build_awm_glb
from .m416 import M416_METADATA, build_m416_nodes
from .pistol import PISTOL_METADATA, build_pistol_nodes

__all__ = [
    "AWM_METADATA",
    "M416_METADATA",
    "PISTOL_METADATA",
    "build_awm_glb",
    "build_m416_nodes",
    "build_pistol_nodes",
]

