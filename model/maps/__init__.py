"""Procedural PBR military map assets and shared layout/collider definitions."""

from .container import build_container_nodes
from .layout_spec import (
    MILITARY_BOUNDS,
    build_military_colliders,
    build_military_layout,
    export_military_shared_json,
)
from .props import (
    build_barbed_wire_nodes,
    build_concrete_wall_nodes,
    build_fence_nodes,
    build_oil_barrel_nodes,
    build_sandbag_nodes,
    build_tire_stack_nodes,
    build_wood_crate_nodes,
    build_wood_pallet_nodes,
)
from .textures import MilitaryMapTextures, build_military_textures
from .warehouse import build_warehouse_nodes
from .watchtower import build_watchtower_nodes
from .wrecked_truck import build_wrecked_truck_nodes

__all__ = [
    "MILITARY_BOUNDS",
    "MilitaryMapTextures",
    "build_barbed_wire_nodes",
    "build_concrete_wall_nodes",
    "build_container_nodes",
    "build_fence_nodes",
    "build_military_colliders",
    "build_military_layout",
    "build_military_textures",
    "build_oil_barrel_nodes",
    "build_sandbag_nodes",
    "build_tire_stack_nodes",
    "build_warehouse_nodes",
    "build_watchtower_nodes",
    "build_wood_crate_nodes",
    "build_wood_pallet_nodes",
    "build_wrecked_truck_nodes",
    "export_military_shared_json",
]
