"""Single source of truth for Khu Quân Sự Cũ 5v5 (70m x 90m) layout & colliders.

Compass & Coordinate Convention (unified across layout, shaders, sun & docs):
- Right-handed Y-up, 1 unit = 1 meter, ground at y = 0.
- North (-Z): Team A base at Z = -40 (facing South +Z, yaw = pi); perimeter wall at Z = -45.4.
- South (+Z): Team B base at Z = +40 (facing North -Z, yaw = 0); perimeter wall at Z = +45.4.
- West  (-X): Lane A twin warehouses at X = -22; afternoon cross-sun sits West (-X, Z = 0) for 100% N-S team fairness.
- East  (+X): Lane B container yard at X = +22; perimeter wall at X = +35.4.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

MILITARY_BOUNDS = {
    "minX": -35.0,
    "maxX": 35.0,
    "minZ": -45.0,
    "maxZ": 45.0,
    "wallHeight": 3.5,
}

# Parametric dimensions (width X, depth Z, height Y) matching reference assets
ASSET_DIMS = {
    "container": (6.0, 2.4, 2.6),
    "warehouse": (10.0, 14.0, 5.2),
    "wrecked_truck": (2.3, 6.2, 2.7),
    "watchtower": (3.2, 3.2, 6.8),
    "sandbag": (1.8, 0.75, 1.1),
    "concrete_wall": (4.0, 0.45, 2.4),
    "fence": (4.0, 0.15, 2.4),
    "wood_crate": (1.2, 1.2, 1.2),
    "oil_barrel": (0.58, 0.58, 0.88),
    "wood_pallet": (1.20, 1.00, 0.16),
    "tire_stack": (0.94, 0.94, 0.62),
    "barbed_wire": (4.0, 0.45, 0.52),
}


def _rotate_y_xz(x: float, z: float, yaw: float) -> tuple[float, float]:
    """Rotate local (x, z) around +Y using Three.js convention (x' = x*cos + z*sin, z' = -x*sin + z*cos)."""
    c = math.cos(yaw)
    s = math.sin(yaw)
    return (x * c + z * s, -x * s + z * c)


def _local_box_to_world_aabb(
    cx: float,
    cy: float,
    cz: float,
    hx: float,
    hy: float,
    hz: float,
    px: float,
    py: float,
    pz: float,
    yaw: float,
    tag: str,
    bullet_only: bool = False,
    move_only: bool = False,
) -> dict[str, Any]:
    """Transform a local centered box into a tight world-space AABB."""
    rx, rz = _rotate_y_xz(cx, cz, yaw)
    wx = px + rx
    wy = py + cy
    wz = pz + rz
    c = abs(math.cos(yaw))
    s = abs(math.sin(yaw))
    whx = hx * c + hz * s
    whz = hx * s + hz * c
    box: dict[str, Any] = {
        "x0": round(wx - whx, 4),
        "x1": round(wx + whx, 4),
        "y0": round(wy - hy, 4),
        "y1": round(wy + hy, 4),
        "z0": round(wz - whz, 4),
        "z1": round(wz + whz, 4),
        "tag": tag,
    }
    if bullet_only:
        box["bulletOnly"] = True
    if move_only:
        box["moveOnly"] = True
    return box


def _warehouse_local_subboxes() -> list[tuple[float, float, float, float, float, float, str]]:
    """Decomposed wall/roof/lintel AABBs for warehouse.glb (10.0m x 14.0m x 5.2m).

    Openings preserved cleanly:
    - +Z large garage portal: x in [-2.2, +2.2], y in [0, 3.6]
    - -Z rear portal: x in [-1.5, +1.5], y in [0, 2.8]
    - +X & -X side corridor doors: z in [2.0, 4.2], y in [0, 2.6]
    - +X & -X 2 industrial windows: z in [-5.0, -3.2] and [-1.6, 0.2], y in [1.05, 2.15]
    """
    t = 0.36
    ht = t * 0.5
    eave_h = 3.80
    boxes: list[tuple[float, float, float, float, float, float, str]] = []

    # +Z front gable wall (portal x in [-2.2, 2.2], y in [0, 3.6])
    boxes.append((-3.6, eave_h * 0.5, 7.0 - ht, 1.4, eave_h * 0.5, ht, "warehouse_wall"))
    boxes.append((3.6, eave_h * 0.5, 7.0 - ht, 1.4, eave_h * 0.5, ht, "warehouse_wall"))
    boxes.append((0.0, 4.35, 7.0 - ht, 2.2, 0.75, ht, "warehouse_lintel"))

    # -Z rear gable wall (portal x in [-1.5, 1.5], y in [0, 2.8])
    boxes.append((-3.25, eave_h * 0.5, -7.0 + ht, 1.75, eave_h * 0.5, ht, "warehouse_wall"))
    boxes.append((3.25, eave_h * 0.5, -7.0 + ht, 1.75, eave_h * 0.5, ht, "warehouse_wall"))
    boxes.append((0.0, 3.9, -7.0 + ht, 1.5, 1.1, ht, "warehouse_lintel"))

    # Both +X and -X side walls with 2 shoot-through windows + 1 side door
    for sx in (-1.0, 1.0):
        wx = sx * (5.0 - ht)
        # Piers along Z: [-7.0, -5.0], [-3.2, -1.6], [0.2, 2.0], [4.2, 7.0]
        for z0, z1 in ((-7.0, -5.0), (-3.2, -1.6), (0.2, 2.0), (4.2, 7.0)):
            zc = 0.5 * (z0 + z1)
            zh = 0.5 * (z1 - z0)
            boxes.append((wx, eave_h * 0.5, zc, ht, eave_h * 0.5, zh, "warehouse_wall"))
        # Below & above window 1 (z in [-5.0, -3.2], opening y in [1.05, 2.15])
        boxes.append((wx, 0.525, -4.1, ht, 0.525, 0.9, "warehouse_sill"))
        boxes.append((wx, 2.975, -4.1, ht, 0.825, 0.9, "warehouse_lintel"))
        # Below & above window 2 (z in [-1.6, 0.2], opening y in [1.05, 2.15])
        boxes.append((wx, 0.525, -0.7, ht, 0.525, 0.9, "warehouse_sill"))
        boxes.append((wx, 2.975, -0.7, ht, 0.825, 0.9, "warehouse_lintel"))
        # Above side door (z in [2.0, 4.2], door y in [0, 2.6])
        boxes.append((wx, 3.20, 3.1, ht, 0.60, 1.1, "warehouse_lintel"))

    # Pitched roof slabs (approximated as 2 upper tiers so bullets/grenades don't clip sky)
    boxes.append((-2.5, 4.45, 0.0, 2.5, 0.35, 7.0, "warehouse_roof"))
    boxes.append((2.5, 4.45, 0.0, 2.5, 0.35, 7.0, "warehouse_roof"))
    boxes.append((0.0, 4.95, 0.0, 1.3, 0.25, 7.0, "warehouse_roof"))
    return boxes


def _wrecked_truck_subboxes() -> list[tuple[float, float, float, float, float, float, str, bool]]:
    """Decomposed sub-AABBs for wrecked_truck.glb (2.3m x 6.2m x 2.7m, facing -Z).

    Leaves cab window zone y in [1.48, 2.18] open for bullet raycasts!
    Tuple format: (cx, cy, cz, hx, hy, hz, tag, move_only)
    """
    return [
        # Front bumper + engine + tilted open hood (crouch cover y = 1.38m)
        (0.0, 0.69, -2.25, 1.05, 0.69, 0.78, "truck_hood", False),
        # Lower cab doors & dash (crouch cover y = 1.46m)
        (0.0, 0.73, -0.82, 1.08, 0.73, 0.70, "truck_cab_lower", False),
        # Cab roof (solid overhead, leaving y in [1.46, 2.16] open glassless window!)
        (0.0, 2.26, -0.82, 1.04, 0.10, 0.68, "truck_cab_roof", False),
        # Movement blocker for cab window height so players don't walk inside cab
        (0.0, 1.81, -0.82, 1.05, 0.35, 0.68, "truck_cab_body_block", True),
        # Rear cargo bed + side rails (y up to 1.56m)
        (0.0, 0.78, 1.48, 1.08, 0.78, 1.52, "truck_bed", False),
    ]


def _watchtower_subboxes() -> list[tuple[float, float, float, float, float, float, str]]:
    """Decomposed sub-AABBs for watchtower.glb (3.2m x 3.2m x 6.8m, ladder on -X)."""
    boxes: list[tuple[float, float, float, float, float, float, str]] = []
    # 4 corner steel legs & concrete footings (walkable underneath!)
    for sx in (-1.30, 1.30):
        for sz in (-1.30, 1.30):
            boxes.append((sx, 1.90, sz, 0.24, 1.90, 0.24, "watchtower_leg"))
    # Concrete deck at y in [3.75, 4.00]
    boxes.append((0.0, 3.875, 0.0, 1.60, 0.125, 1.60, "watchtower_deck"))
    # Parapets on y=4.00m deck:
    # - North (-Z) & South (+Z): 1.10m frontal crouch cover (y in [4.00, 5.10])
    # - East (+X) & West (-X): 0.72m waist rail (y in [4.00, 4.72]) leaving upper flanks open to counter-fire!
    boxes.append((0.0, 4.55, -1.52, 1.60, 0.55, 0.08, "watchtower_parapet"))
    boxes.append((0.0, 4.55, 1.52, 1.60, 0.55, 0.08, "watchtower_parapet"))
    boxes.append((1.52, 4.36, 0.0, 0.08, 0.36, 1.60, "watchtower_parapet"))
    boxes.append((-1.52, 4.36, -1.075, 0.08, 0.36, 0.525, "watchtower_parapet"))
    boxes.append((-1.52, 4.36, 1.075, 0.08, 0.36, 0.525, "watchtower_parapet"))
    # Roof at y in [6.35, 6.75]
    boxes.append((0.0, 6.55, 0.0, 1.70, 0.20, 1.70, "watchtower_roof"))
    return boxes


def build_military_layout() -> dict[str, Any]:
    """Return the complete data-driven layout JSON for Khu Quân Sự Cũ 5v5."""
    objects: list[dict[str, Any]] = []

    def add_obj(
        obj_id: str,
        asset: str,
        x: float,
        y: float,
        z: float,
        rot_y: float = 0.0,
        variant: int = 0,
        cast_shadow: bool = True,
        bvh_collision: bool = False,
        scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    ) -> None:
        objects.append({
            "id": obj_id,
            "asset": asset,
            "position": [round(x, 3), round(y, 3), round(z, 3)],
            "rotationY": round(rot_y, 6),
            "scale": [round(scale[0], 3), round(scale[1], 3), round(scale[2], 3)],
            "variant": variant,
            "castShadow": cast_shadow,
            "bvhCollision": bvh_collision,
        })

    # ---- Spawn L-Walls (6m in front of Team A z=-40 and Team B z=+40) ----
    add_obj("spawn_a_wall_l", "concrete_wall", -4.0, 0.0, -34.0, 0.0, variant=0)
    add_obj("spawn_a_wall_c", "concrete_wall", 0.0, 0.0, -34.0, 0.0, variant=0)
    add_obj("spawn_a_wall_r", "concrete_wall", 4.0, 0.0, -34.0, 0.0, variant=0)
    add_obj("spawn_a_wing", "concrete_wall", -6.0, 0.0, -36.2, math.pi * 0.5, variant=0)
    add_obj("spawn_a_sandbag_r", "sandbag", 7.2, 0.0, -34.2, 0.18, variant=0, cast_shadow=False)
    add_obj("spawn_a_crate", "wood_crate", -7.2, 0.0, -35.2, 0.12, variant=0, cast_shadow=True)
    # Foreground spawn & wave-survival tactical cover (flanking exits without blocking spawn points)
    add_obj("spawn_a_fg_barrel1", "oil_barrel", -4.2, 0.0, -35.4, 0.0, variant=1, cast_shadow=True)
    add_obj("spawn_a_fg_barrel2", "oil_barrel", -3.5, 0.0, -35.6, 0.4, variant=0, cast_shadow=True)
    add_obj("spawn_a_fg_tires", "tire_stack", 5.2, 0.0, -35.6, 0.5, cast_shadow=False)
    add_obj("spawn_a_fg_wire", "barbed_wire", -12.5, 0.0, -35.2, -0.25, cast_shadow=False)
    add_obj("spawn_a_fg_sandbag_far", "sandbag", 11.0, 0.0, -33.2, -0.32, cast_shadow=False)
    add_obj("spawn_a_fg_pallet", "wood_pallet", -2.2, 0.0, -36.8, 0.18, cast_shadow=False)

    add_obj("spawn_b_wall_l", "concrete_wall", -4.0, 0.0, 34.0, math.pi, variant=0)
    add_obj("spawn_b_wall_c", "concrete_wall", 0.0, 0.0, 34.0, math.pi, variant=0)
    add_obj("spawn_b_wall_r", "concrete_wall", 4.0, 0.0, 34.0, math.pi, variant=0)
    add_obj("spawn_b_wing", "concrete_wall", 6.0, 0.0, 36.2, math.pi * 0.5, variant=0)
    add_obj("spawn_b_sandbag_l", "sandbag", -7.2, 0.0, 34.2, math.pi + 0.18, variant=0, cast_shadow=False)
    add_obj("spawn_b_crate", "wood_crate", 7.2, 0.0, 35.2, -0.15, variant=0, cast_shadow=True)
    add_obj("spawn_b_fg_barrel1", "oil_barrel", 4.2, 0.0, 35.4, 0.2, variant=1, cast_shadow=True)
    add_obj("spawn_b_fg_tires", "tire_stack", -5.2, 0.0, 35.6, 1.1, cast_shadow=False)
    add_obj("spawn_b_fg_wire", "barbed_wire", 12.5, 0.0, 35.2, -0.25, cast_shadow=False)

    # ---- Lane A: Khu Nhà Kho (X = -22) ----
    add_obj("warehouse_north", "warehouse", -22.0, 0.0, -14.0, 0.0, cast_shadow=True, bvh_collision=True)
    add_obj("warehouse_south", "warehouse", -22.0, 0.0, 14.0, math.pi, cast_shadow=True, bvh_collision=True)

    # Interior & Lane-A corridor tactical cover
    add_obj("wh_n_crate_in", "wood_crate", -24.2, 0.0, -13.0, 0.2, cast_shadow=True)
    add_obj("wh_n_crate_in2", "wood_crate", -19.8, 0.0, -16.8, -0.1, cast_shadow=True)
    add_obj("wh_s_crate_in", "wood_crate", -24.2, 0.0, 13.0, -0.2, cast_shadow=True)
    add_obj("wh_s_crate_in2", "wood_crate", -19.8, 0.0, 16.8, 0.15, cast_shadow=True)
    add_obj("lane_a_mid_sandbag", "sandbag", -15.2, 0.0, 0.0, math.pi * 0.5, cast_shadow=False)
    # Protective container blocking watchtower 5.7m sightline into Lane A outer West flank (x=-31, z=0)
    add_obj("lane_a_flank_cont", "container", -25.5, -0.025, 0.0, math.pi * 0.5 + 0.02, variant=1, cast_shadow=True)
    add_obj("lane_a_flank_wall_n", "concrete_wall", -31.5, 0.0, -24.0, 0.0, cast_shadow=True)
    add_obj("lane_a_flank_wall_s", "concrete_wall", -31.5, 0.0, 24.0, 0.0, cast_shadow=True)
    add_obj("lane_a_sandbag_n", "sandbag", -15.5, 0.0, -24.5, -0.35, cast_shadow=False)
    add_obj("lane_a_sandbag_s", "sandbag", -15.5, 0.0, 24.5, 0.35, cast_shadow=False)

    # ---- Mid: Sân Duyệt Binh (X = 0) ----
    add_obj("watchtower_mid", "watchtower", 4.0, 0.0, 0.0, 0.0, cast_shadow=True, bvh_collision=True)
    add_obj("truck_mid_n", "wrecked_truck", -6.0, 0.0, -12.0, 0.58, cast_shadow=True, bvh_collision=True)
    add_obj("truck_mid_s", "wrecked_truck", 7.0, 0.0, 13.0, -2.56, cast_shadow=True, bvh_collision=True)

    # Mid connector & gap-filling tactical cover (cover every 8-12m along lanes)
    add_obj("mid_sandbag_w", "sandbag", -9.5, 0.0, 1.5, math.pi * 0.42, cast_shadow=False)
    add_obj("mid_sandbag_fg_n", "sandbag", -5.8, 0.0, -25.8, -0.28, cast_shadow=False)
    add_obj("mid_tires_fg_n", "tire_stack", -4.0, 0.0, -26.4, 0.6, cast_shadow=False)
    add_obj("mid_wire_fg_n", "barbed_wire", 7.8, 0.0, -24.2, 0.32, cast_shadow=False)
    add_obj("mid_crate_cluster_n", "wood_crate", 3.5, 0.0, -21.0, 0.35, cast_shadow=True)
    add_obj("mid_crate_cluster_s", "wood_crate", -3.5, 0.0, 21.0, -0.35, cast_shadow=True)
    add_obj("mid_barrier_n", "concrete_wall", -1.5, 0.0, -23.5, 0.25, cast_shadow=True)
    add_obj("mid_barrier_s", "concrete_wall", 1.5, 0.0, 23.5, 0.25, cast_shadow=True)
    add_obj("mid_fence_e", "fence", 11.2, 0.0, -2.5, math.pi * 0.5, cast_shadow=False)

    # Full-height 2.4m spawn-exit cover walls symmetrically shielding all 4 spawn exits from watchtower 5.7m sightline
    add_obj("jersey_a_west", "concrete_wall", -8.8, 0.0, -29.0, 0.36, scale=(1.05, 1.0, 1.0), cast_shadow=True)
    add_obj("jersey_a_east", "concrete_wall", 9.6, 0.0, -29.0, -0.22, scale=(1.05, 1.0, 1.0), cast_shadow=True)
    add_obj("jersey_b_west", "concrete_wall", -8.8, 0.0, 29.0, -0.36, scale=(1.05, 1.0, 1.0), cast_shadow=True)
    add_obj("jersey_b_east", "concrete_wall", 9.6, 0.0, 29.0, 0.22, scale=(1.05, 1.0, 1.0), cast_shadow=True)
    add_obj("jersey_mid_nw", "concrete_wall", -11.8, 0.0, -6.5, math.pi * 0.38, scale=(0.75, 0.52, 1.0), cast_shadow=True)
    add_obj("jersey_mid_se", "concrete_wall", 10.8, 0.0, 6.5, math.pi * 0.38, scale=(0.75, 0.52, 1.0), cast_shadow=True)

    # Oil barrel clusters (3 weathered color variants: 0=olive, 1=rust-red, 2=steel-grey)
    add_obj("barrel_n1", "oil_barrel", -10.2, 0.0, -18.5, 0.0, variant=0, cast_shadow=True)
    add_obj("barrel_n2", "oil_barrel", -9.5, 0.0, -18.8, 0.4, variant=1, cast_shadow=True)
    add_obj("barrel_n3", "oil_barrel", -9.9, 0.0, -17.9, 0.9, variant=2, cast_shadow=True)
    add_obj("barrel_s1", "oil_barrel", 9.8, 0.0, 18.5, 0.2, variant=1, cast_shadow=True)
    add_obj("barrel_s2", "oil_barrel", 10.5, 0.0, 18.9, 0.6, variant=0, cast_shadow=True)
    add_obj("barrel_s3", "oil_barrel", 10.2, 0.0, 17.9, 1.1, variant=2, cast_shadow=True)
    add_obj("barrel_mid_w1", "oil_barrel", -1.4, 0.0, 7.8, 0.3, variant=1, cast_shadow=True)
    add_obj("barrel_mid_w2", "oil_barrel", -0.8, 0.0, 8.2, 0.9, variant=0, cast_shadow=True)
    add_obj("barrel_mid_e1", "oil_barrel", 1.2, 0.0, -7.8, 0.1, variant=2, cast_shadow=True)
    add_obj("barrel_mid_e2", "oil_barrel", 1.9, 0.0, -7.4, 0.7, variant=1, cast_shadow=True)
    add_obj("barrel_wh_a1", "oil_barrel", -16.4, 0.0, -7.4, 0.0, variant=0, cast_shadow=True)
    add_obj("barrel_wh_a2", "oil_barrel", -16.4, 0.0, 7.4, 0.3, variant=1, cast_shadow=True)

    # Wood pallets & mud-caked tire stacks near cover clusters (low, no castShadow)
    add_obj("pallet_1", "wood_pallet", 13.6, 0.0, -22.8, 0.22, cast_shadow=False)
    add_obj("pallet_2", "wood_pallet", -16.2, 0.0, -19.8, 0.12, cast_shadow=False)
    add_obj("pallet_3", "wood_pallet", -16.2, 0.0, 19.8, -0.15, cast_shadow=False)
    add_obj("pallet_4", "wood_pallet", 20.8, 0.0, -7.0, 0.55, cast_shadow=False)
    add_obj("pallet_5", "wood_pallet", 4.6, 0.0, -21.8, -0.35, cast_shadow=False)
    add_obj("pallet_6", "wood_pallet", -4.6, 0.0, 21.8, 0.42, cast_shadow=False)
    add_obj("tires_1", "tire_stack", 13.4, 0.0, -21.2, 0.4, cast_shadow=False)
    add_obj("tires_2", "tire_stack", -16.0, 0.0, -13.5, 1.1, cast_shadow=False)
    add_obj("tires_3", "tire_stack", -16.0, 0.0, 13.5, 2.0, cast_shadow=False)
    add_obj("tires_4", "tire_stack", 22.0, 0.0, 11.2, 0.8, cast_shadow=False)
    add_obj("tires_5", "tire_stack", -7.8, 0.0, -34.8, 0.2, cast_shadow=False)
    add_obj("tires_6", "tire_stack", 7.8, 0.0, 34.8, 2.5, cast_shadow=False)

    # Extra sandbag arcs, barrels & foreground cover props breaking up open yard spans
    add_obj("sandbag_mid_nw", "sandbag", -1.2, 0.0, -15.5, 0.18, cast_shadow=False)
    add_obj("sandbag_mid_se", "sandbag", 1.2, 0.0, 15.5, math.pi + 0.18, cast_shadow=False)
    add_obj("sandbag_lane_a_fg", "sandbag", -11.2, 0.0, -9.2, 0.52, cast_shadow=False)
    add_obj("barrel_lane_a_fg1", "oil_barrel", -10.3, 0.0, -8.5, 0.3, variant=2, cast_shadow=True)
    add_obj("barrel_lane_a_fg2", "oil_barrel", -17.4, 0.0, -2.6, 0.7, variant=1, cast_shadow=True)
    add_obj("pallet_lane_a_fg", "wood_pallet", -17.0, 0.0, -3.7, 0.36, cast_shadow=False)
    add_obj("barrel_lane_b_fg1", "oil_barrel", 21.6, 0.0, -23.6, 0.4, variant=1, cast_shadow=True)
    add_obj("barrel_lane_b_fg2", "oil_barrel", 22.3, 0.0, -23.1, 1.1, variant=0, cast_shadow=True)
    add_obj("tires_lane_b_fg", "tire_stack", 14.2, 0.0, -26.2, 0.9, cast_shadow=False)
    add_obj("sandbag_lane_b_fg", "sandbag", 23.8, 0.0, -26.8, -0.35, cast_shadow=False)
    add_obj("barbed_flank_w", "barbed_wire", -30.5, 0.0, 0.0, 0.0, cast_shadow=False)
    add_obj("barbed_flank_e", "barbed_wire", 30.8, 0.0, -8.5, math.pi * 0.5, cast_shadow=False)

    # ---- Lane B: Bãi Container (X = +22, symmetric N/S entry shields & outer East flank cover) ----
    add_obj("cont_b1", "container", 17.0, -0.025, -22.0, 0.026, variant=0, cast_shadow=True)
    add_obj("cont_b2_bot", "container", 24.0, -0.025, -14.0, math.pi * 0.5 - 0.018, variant=1, cast_shadow=True)
    add_obj("cont_b2_top", "container", 24.0, 2.575, -14.0, math.pi * 0.5 - 0.018, variant=2, cast_shadow=True)
    add_obj("cont_b3", "container", 16.0, -0.025, -4.0, -0.024, variant=2, cast_shadow=True)
    # Centered mid-east container shielding Lane B outer flank (x=+30, z=0) from watchtower 5.7m sniper
    add_obj("cont_b4", "container", 24.5, -0.025, 0.0, math.pi * 0.5 + 0.022, variant=0, cast_shadow=True)
    add_obj("cont_b5_bot", "container", 17.0, -0.025, 14.0, math.pi * 0.5 + 0.016, variant=1, cast_shadow=True)
    add_obj("cont_b5_top", "container", 17.0, 2.575, 14.0, math.pi * 0.5 + 0.016, variant=0, cast_shadow=True)
    # Exact South mirror of cont_b1 so Team B approaching Lane B (+20, +26) has identical watchtower cover as Team A
    add_obj("cont_b6", "container", 17.0, -0.025, 22.0, -0.028, variant=2, cast_shadow=True)
    add_obj("cont_b7", "container", 29.0, -0.025, -28.0, math.pi * 0.5 - 0.025, variant=1, cast_shadow=True)
    add_obj("cont_b8", "container", 29.0, -0.025, 28.0, math.pi * 0.5 + 0.025, variant=0, cast_shadow=True)

    # Lane B close-quarters crouch props
    add_obj("lane_b_crate_1", "wood_crate", 20.5, 0.0, -8.5, 0.4, cast_shadow=True)
    add_obj("lane_b_sandbag_1", "sandbag", 29.2, 0.0, -4.0, 0.0, cast_shadow=False)
    add_obj("lane_b_crate_2", "wood_crate", 21.0, 0.0, 10.0, -0.25, cast_shadow=True)
    add_obj("lane_b_sandbag_2", "sandbag", 13.5, 0.0, 23.0, math.pi * 0.5, cast_shadow=False)
    add_obj("lane_b_fence_n", "fence", 13.0, 0.0, -14.0, math.pi * 0.5, cast_shadow=False)

    # ---- Perimeter Walls (3.5m high, 70m x 90m boundary) + Barbed Wire coils on top ----
    # North (Z = -45.4) and South (Z = +45.4): 18 segments of 4m across [-34..+34]
    for i in range(18):
        wx = -34.0 + i * 4.0
        add_obj(f"perim_n_{i}", "concrete_wall", wx, 0.0, -45.4, 0.0, scale=(1.0, 1.46, 1.78), cast_shadow=True)
        add_obj(f"perim_s_{i}", "concrete_wall", wx, 0.0, 45.4, math.pi, scale=(1.0, 1.46, 1.78), cast_shadow=True)
        add_obj(f"perim_wire_n_{i}", "barbed_wire", wx, 3.46, -45.4, 0.0, cast_shadow=False)
        add_obj(f"perim_wire_s_{i}", "barbed_wire", wx, 3.46, 45.4, 0.0, cast_shadow=False)
    # West (X = -35.4) and East (X = +35.4): 23 segments of 4m across [-44..+44]
    for i in range(23):
        wz = -44.0 + i * 4.0
        add_obj(f"perim_w_{i}", "concrete_wall", -35.4, 0.0, wz, math.pi * 0.5, scale=(1.0, 1.46, 1.78), cast_shadow=True)
        add_obj(f"perim_e_{i}", "concrete_wall", 35.4, 0.0, wz, -math.pi * 0.5, scale=(1.0, 1.46, 1.78), cast_shadow=True)
        add_obj(f"perim_wire_w_{i}", "barbed_wire", -35.4, 3.46, wz, math.pi * 0.5, cast_shadow=False)
        add_obj(f"perim_wire_e_{i}", "barbed_wire", 35.4, 3.46, wz, math.pi * 0.5, cast_shadow=False)

    return {
        "mapId": "military",
        "name": "Khu Quân Sự Cũ",
        "bounds": MILITARY_BOUNDS,
        "spawns": {
            "A": [
                {"x": -3.5, "y": 0.0, "z": -40.5, "yaw": round(math.pi, 6)},
                {"x": -1.75, "y": 0.0, "z": -40.0, "yaw": round(math.pi, 6)},
                {"x": 0.0, "y": 0.0, "z": -40.5, "yaw": round(math.pi, 6)},
                {"x": 1.75, "y": 0.0, "z": -40.0, "yaw": round(math.pi, 6)},
                {"x": 3.5, "y": 0.0, "z": -40.5, "yaw": round(math.pi, 6)},
                {"x": -10.0, "y": 0.0, "z": -43.0, "yaw": round(math.pi, 6)},
                {"x": 16.0, "y": 0.0, "z": -41.5, "yaw": round(math.pi + 0.14, 6)},
                {"x": -26.0, "y": 0.0, "z": -43.0, "yaw": round(math.pi - 0.12, 6)},
                {"x": -31.0, "y": 0.0, "z": -40.0, "yaw": round(math.pi - 0.18, 6)},
            ],
            "B": [
                {"x": -3.5, "y": 0.0, "z": 40.5, "yaw": 0.0},
                {"x": -1.75, "y": 0.0, "z": 40.0, "yaw": 0.0},
                {"x": 0.0, "y": 0.0, "z": 40.5, "yaw": 0.0},
                {"x": 1.75, "y": 0.0, "z": 40.0, "yaw": 0.0},
                {"x": 3.5, "y": 0.0, "z": 40.5, "yaw": 0.0},
                {"x": -10.0, "y": 0.0, "z": 43.0, "yaw": 0.0},
                {"x": 16.0, "y": 0.0, "z": 41.5, "yaw": -0.14},
                {"x": -26.0, "y": 0.0, "z": 43.0, "yaw": 0.12},
                {"x": -31.0, "y": 0.0, "z": 40.0, "yaw": 0.18},
            ],
            "FFA": [
                {"x": 0.0, "y": 0.0, "z": -40.5, "yaw": round(math.pi, 6)},
                {"x": 0.0, "y": 0.0, "z": 40.5, "yaw": 0.0},
                {"x": -29.0, "y": 0.0, "z": -35.0, "yaw": round(math.pi * 0.8, 6)},
                {"x": 29.0, "y": 0.0, "z": -36.0, "yaw": round(-math.pi * 0.8, 6)},
                {"x": -29.0, "y": 0.0, "z": 35.0, "yaw": round(math.pi * 0.2, 6)},
                {"x": 29.0, "y": 0.0, "z": 36.0, "yaw": round(-math.pi * 0.2, 6)},
                {"x": -22.0, "y": 0.0, "z": -14.0, "yaw": round(-math.pi * 0.5, 6)},
                {"x": -22.0, "y": 0.0, "z": 14.0, "yaw": round(-math.pi * 0.5, 6)},
                {"x": 20.5, "y": 0.0, "z": -19.0, "yaw": round(math.pi * 0.5, 6)},
                {"x": 21.0, "y": 0.0, "z": 19.0, "yaw": round(math.pi * 0.5, 6)},
                {"x": -12.0, "y": 0.0, "z": 0.0, "yaw": round(-math.pi * 0.5, 6)},
                {"x": 11.0, "y": 0.0, "z": -9.0, "yaw": round(math.pi * 0.5, 6)},
                {"x": -31.0, "y": 0.0, "z": -14.0, "yaw": 0.0},
                {"x": 31.0, "y": 0.0, "z": 14.0, "yaw": round(math.pi, 6)},
                {"x": -12.0, "y": 0.0, "z": -28.0, "yaw": round(math.pi, 6)},
                {"x": 30.0, "y": 0.0, "z": 0.0, "yaw": round(math.pi * 0.5, 6)},
            ],
        },
        "objects": objects,
    }


def build_military_colliders(layout: dict[str, Any] | None = None) -> dict[str, Any]:
    """Generate decomposed AABB/OBB colliders, walkable slabs, and ladders from layout."""
    if layout is None:
        layout = build_military_layout()

    boxes: list[dict[str, Any]] = []
    obbs: list[dict[str, Any]] = []
    walkable_slabs: list[dict[str, Any]] = []
    ladders: list[dict[str, Any]] = []
    bvh_targets: list[str] = []

    # 4 perimeter walls (solid 3.5m high)
    boxes.extend([
        {"x0": -35.8, "x1": 35.8, "y0": 0.0, "y1": 3.5, "z0": -45.8, "z1": -45.0, "tag": "perimeter"},
        {"x0": -35.8, "x1": 35.8, "y0": 0.0, "y1": 3.5, "z0": 45.0, "z1": 45.8, "tag": "perimeter"},
        {"x0": -35.8, "x1": -35.0, "y0": 0.0, "y1": 3.5, "z0": -45.0, "z1": 45.0, "tag": "perimeter"},
        {"x0": 35.0, "x1": 35.8, "y0": 0.0, "y1": 3.5, "z0": -45.0, "z1": 45.0, "tag": "perimeter"},
    ])

    wh_sub = _warehouse_local_subboxes()
    tr_sub = _wrecked_truck_subboxes()
    wt_sub = _watchtower_subboxes()

    for obj in layout["objects"]:
        obj_id = obj["id"]
        if obj_id.startswith("perim_"):
            continue
        asset = obj["asset"]
        if asset == "wood_pallet":
            # Players walk smoothly across low 16cm pallets
            continue
        px, py, pz = obj["position"]
        yaw = obj["rotationY"]
        sx, sy, sz = obj.get("scale", [1.0, 1.0, 1.0])

        if asset == "warehouse":
            bvh_targets.append(obj_id)
            for cx, cy, cz, hx, hy, hz, tag in wh_sub:
                boxes.append(
                    _local_box_to_world_aabb(
                        cx * sx, cy * sy, cz * sz,
                        hx * sx, hy * sy, hz * sz,
                        px, py, pz, yaw, tag,
                    )
                )
        elif asset == "wrecked_truck":
            bvh_targets.append(obj_id)
            for cx, cy, cz, hx, hy, hz, tag, move_only in tr_sub:
                boxes.append(
                    _local_box_to_world_aabb(
                        cx * sx, cy * sy, cz * sz,
                        hx * sx, hy * sy, hz * sz,
                        px, py, pz, yaw, tag,
                        move_only=move_only,
                    )
                )
                obbs.append({
                    "id": f"{obj_id}_{tag}",
                    "cx": round(px + _rotate_y_xz(cx * sx, cz * sz, yaw)[0], 4),
                    "cy": round(py + cy * sy, 4),
                    "cz": round(pz + _rotate_y_xz(cx * sx, cz * sz, yaw)[1], 4),
                    "hx": round(hx * sx, 4),
                    "hy": round(hy * sy, 4),
                    "hz": round(hz * sz, 4),
                    "yaw": round(yaw, 6),
                    "tag": tag,
                    "moveOnly": move_only,
                })
        elif asset == "watchtower":
            bvh_targets.append(obj_id)
            for cx, cy, cz, hx, hy, hz, tag in wt_sub:
                boxes.append(
                    _local_box_to_world_aabb(
                        cx * sx, cy * sy, cz * sz,
                        hx * sx, hy * sy, hz * sz,
                        px, py, pz, yaw, tag,
                    )
                )
            # Walkable platform deck at y = 4.00m
            walkable_slabs.append(
                _local_box_to_world_aabb(
                    0.0, 3.875 * sy, 0.0,
                    1.55 * sx, 0.125 * sy, 1.55 * sz,
                    px, py, pz, yaw, "watchtower_deck",
                )
            )
            # Ladder volume on local -X edge (x = -1.56, z in [-0.55, 0.55], y in [0, 4.10])
            lx, lz = _rotate_y_xz(-1.56 * sx, 0.0, yaw)
            nx, nz = _rotate_y_xz(-1.0, 0.0, yaw)
            ladders.append({
                "id": f"{obj_id}_ladder",
                "x": round(px + lx, 4),
                "z": round(pz + lz, 4),
                "minY": round(py, 4),
                "maxY": round(py + 4.02 * sy, 4),
                "radius": 0.68,
                "normalX": round(nx, 4),
                "normalZ": round(nz, 4),
                "exitX": round(px + _rotate_y_xz(-0.95 * sx, 0.0, yaw)[0], 4),
                "exitZ": round(pz + _rotate_y_xz(-0.95 * sx, 0.0, yaw)[1], 4),
            })
        else:
            w, d, h = ASSET_DIMS[asset]
            hx = w * 0.5 * sx
            hy = h * 0.5 * sy
            hz = d * 0.5 * sz
            boxes.append(
                _local_box_to_world_aabb(
                    0.0, hy, 0.0,
                    hx, hy, hz,
                    px, py, pz, yaw, asset,
                )
            )

    return {
        "mapId": "military",
        "bounds": MILITARY_BOUNDS,
        "boxes": boxes,
        "obbs": obbs,
        "walkableSlabs": walkable_slabs,
        "ladders": ladders,
        "bvhTargets": bvh_targets,
        "spawns": layout["spawns"],
    }


def export_military_shared_json(out_dir: Path, js_out_path: Path | None = None) -> tuple[Path, Path]:
    """Write military_layout.json, military_colliders.json, and browser ES module fallback."""
    out_dir.mkdir(parents=True, exist_ok=True)
    layout = build_military_layout()
    colliders = build_military_colliders(layout)
    layout_path = out_dir / "military_layout.json"
    colliders_path = out_dir / "military_colliders.json"
    layout_json = json.dumps(layout, indent=2, ensure_ascii=False)
    colliders_json = json.dumps(colliders, indent=2, ensure_ascii=False)
    layout_path.write_text(layout_json + "\n", encoding="utf-8")
    colliders_path.write_text(colliders_json + "\n", encoding="utf-8")

    target_js = js_out_path or (Path(__file__).resolve().parents[2] / "public" / "js" / "military_map_data.js")
    target_js.parent.mkdir(parents=True, exist_ok=True)
    target_js.write_text(
        "// Auto-generated by model/maps/layout_spec.py from shared/maps/military_*.json\n"
        f"export const MILITARY_LAYOUT = {layout_json};\n"
        f"export const MILITARY_COLLIDERS = {colliders_json};\n",
        encoding="utf-8",
    )
    return layout_path, colliders_path


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2] / "shared" / "maps"
    lp, cp = export_military_shared_json(root)
    print(f"Exported {lp} and {cp}")

