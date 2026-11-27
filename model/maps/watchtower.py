"""Procedural steel-frame military watchtower (3.2m x 3.2m x 6.8m) matching reference PBR."""

from __future__ import annotations

import math

from model.core import (
    GLBMaterial,
    GLBNode,
    MeshData,
    bake_vertical_foot_ao,
    create_box,
    create_cylinder,
    merge_meshes,
    transform_mesh,
)

from .textures import MilitaryMapTextures, build_military_textures


def _brace_between(p0: tuple[float, float, float], p1: tuple[float, float, float], thickness: float = 0.055) -> MeshData:
    """Create a square steel brace connecting 3D points p0 and p1."""
    dx = p1[0] - p0[0]
    dy = p1[1] - p0[1]
    dz = p1[2] - p0[2]
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    mx = 0.5 * (p0[0] + p1[0])
    my = 0.5 * (p0[1] + p1[1])
    mz = 0.5 * (p0[2] + p1[2])
    # Align +Y box of height=length with direction (dx, dy, dz)
    horiz = math.hypot(dx, dz)
    if horiz < 1e-6:
        rot = (0.0, 0.0, 0.0)
    else:
        pitch = math.atan2(horiz, dy)
        yaw = math.atan2(dx, dz)
        # Rotate around X by pitch, then Y by yaw -> apply via sequential transform_mesh
        m = transform_mesh(create_box(thickness, length, thickness, uv_scale=0.6), rotation=(pitch, 0.0, 0.0))
        return transform_mesh(m, translation=(mx, my, mz), rotation=(0.0, yaw, 0.0))
    return transform_mesh(create_box(thickness, length, thickness, uv_scale=0.6), translation=(mx, my, mz), rotation=rot)


def build_watchtower_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build 3.2m x 3.2m x 6.8m watchtower (4m deck, 1.1m parapet crouch cover, -X ladder)."""
    tex = textures or build_military_textures()

    mat_concrete = GLBMaterial(
        name="Watchtower_Concrete",
        color=0xFFFFFF,
        metalness=0.0,
        roughness=0.90,
        base_color_png=tex.concrete_albedo,
        metallic_roughness_png=tex.concrete_mr,
        normal_png=tex.concrete_normal,
    )
    mat_steel = GLBMaterial(
        name="Watchtower_Steel",
        color=0xFFFFFF,
        metalness=0.72,
        roughness=0.58,
        base_color_png=tex.steel_albedo,
        metallic_roughness_png=tex.steel_mr,
        normal_png=tex.steel_normal,
    )
    mat_parapet = GLBMaterial(
        name="Watchtower_OliveParapet",
        color=0xFFFFFF,
        metalness=0.28,
        roughness=0.72,
        base_color_png=tex.olive_albedo,
        metallic_roughness_png=tex.olive_mr,
    )
    mat_roof = GLBMaterial(
        name="Watchtower_Roof",
        color=0xFFFFFF,
        metalness=0.52,
        roughness=0.74,
        base_color_png=tex.roof_albedo,
        metallic_roughness_png=tex.roof_mr,
        normal_png=tex.roof_normal,
    )
    mat_camo_net = GLBMaterial(
        name="Watchtower_CamoNet",
        color=0xFFFFFF,
        metalness=0.0,
        roughness=0.92,
        transparent=True,
        double_sided=True,
        base_color_png=tex.camo_net_albedo,
    )
    mat_sandbag = GLBMaterial(
        name="Watchtower_Sandbag",
        color=0xFFFFFF,
        metalness=0.0,
        roughness=0.92,
        base_color_png=tex.sandbag_albedo,
        normal_png=tex.sandbag_normal,
    )
    mat_lamp_lens = GLBMaterial(
        name="Watchtower_FloodLens",
        color=0xFFF0D4,
        emissive=0xFFE0A8,
        emissive_intensity=1.4,
        roughness=0.2,
    )

    conc_parts: list[MeshData] = []
    steel_parts: list[MeshData] = []
    parapet_parts: list[MeshData] = []
    roof_parts: list[MeshData] = []
    camo_parts: list[MeshData] = []
    sandbag_parts: list[MeshData] = []
    lens_parts: list[MeshData] = []

    # 4 Concrete footings at (+-1.30, +-1.30), y in [0, 0.36]
    for sx in (-1.30, 1.30):
        for sz in (-1.30, 1.30):
            conc_parts.append(transform_mesh(create_box(0.48, 0.36, 0.48, uv_scale=0.5), translation=(sx, 0.18, sz)))
            # Lower steel corner leg (y in [0.34, 3.76])
            steel_parts.append(transform_mesh(create_box(0.15, 3.44, 0.15, uv_scale=0.5), translation=(sx, 2.06, sz)))
            # Upper roof support post (y in [4.00, 6.42])
            steel_parts.append(transform_mesh(create_box(0.13, 2.42, 0.13, uv_scale=0.5), translation=(sx, 5.21, sz)))

    # Horizontal girts at y = 0.55 & y = 3.70 + X-bracing on all 4 bays
    for y_tie in (0.55, 3.68):
        for sz in (-1.30, 1.30):
            steel_parts.append(transform_mesh(create_box(2.60, 0.08, 0.08, uv_scale=0.5), translation=(0.0, y_tie, sz)))
        for sx in (-1.30, 1.30):
            steel_parts.append(transform_mesh(create_box(0.08, 0.08, 2.60, uv_scale=0.5), translation=(sx, y_tie, 0.0)))

    for sz in (-1.30, 1.30):
        steel_parts.append(_brace_between((-1.30, 0.55, sz), (1.30, 3.68, sz)))
        steel_parts.append(_brace_between((1.30, 0.55, sz), (-1.30, 3.68, sz)))
    for sx in (-1.30, 1.30):
        steel_parts.append(_brace_between((sx, 0.55, -1.30), (sx, 3.68, 1.30)))
        steel_parts.append(_brace_between((sx, 0.55, 1.30), (sx, 3.68, -1.30)))

    # Concrete observation deck (3.2m x 0.25m x 3.2m, top exact y = 4.00m)
    conc_parts.append(transform_mesh(create_box(3.20, 0.25, 3.20, uv_scale=0.35), translation=(0.0, 3.875, 0.0)))

    # Vertical steel ladder on -X side (x = -1.64, z in [-0.30, +0.30], y = 0..4.15m) + handrails
    for lz in (-0.30, 0.30):
        steel_parts.append(transform_mesh(create_cylinder(0.025, 0.025, 4.18, radial_segments=8), translation=(-1.64, 2.09, lz)))
        steel_parts.append(transform_mesh(create_cylinder(0.018, 0.018, 1.05, radial_segments=6), translation=(-1.44, 4.52, lz)))
    for ri in range(13):
        ry = 0.30 + ri * 0.30
        steel_parts.append(
            transform_mesh(
                create_cylinder(0.018, 0.018, 0.60, radial_segments=8),
                translation=(-1.64, ry, 0.0),
                rotation=(math.pi * 0.5, 0.0, 0.0),
            )
        )

    # Olive steel parapet panels on 4m deck:
    # - North (-Z) & South (+Z): 1.10m frontal crouch cover (y in [4.00, 5.10])
    # - East (+X) & West (-X): breached 0.72m waist-high flank rail (y in [4.00, 4.72]) with open upper sightline
    #   so a sniper crouched on deck can be counter-fired from Lane A warehouses & Lane B containers!
    parapet_parts.append(transform_mesh(create_box(3.08, 1.10, 0.07, uv_scale=0.45), translation=(0.0, 4.55, -1.52)))
    parapet_parts.append(transform_mesh(create_box(3.08, 1.10, 0.07, uv_scale=0.45), translation=(0.0, 4.55, 1.52)))
    parapet_parts.append(transform_mesh(create_box(0.07, 0.72, 3.08, uv_scale=0.45), translation=(1.52, 4.36, 0.0)))
    parapet_parts.append(transform_mesh(create_box(0.07, 0.72, 1.02, uv_scale=0.45), translation=(-1.52, 4.36, -1.06)))
    parapet_parts.append(transform_mesh(create_box(0.07, 0.72, 1.02, uv_scale=0.45), translation=(-1.52, 4.36, 1.06)))

    # Parapet top steel trim rail + open flank safety bar (y=5.08 on +X/-X visually frames open counter-fire window)
    steel_parts.append(transform_mesh(create_box(3.14, 0.05, 0.10, uv_scale=0.5), translation=(0.0, 5.11, -1.52)))
    steel_parts.append(transform_mesh(create_box(3.14, 0.05, 0.10, uv_scale=0.5), translation=(0.0, 5.11, 1.52)))
    steel_parts.append(transform_mesh(create_box(0.10, 0.05, 3.14, uv_scale=0.5), translation=(1.52, 4.73, 0.0)))
    steel_parts.append(transform_mesh(create_box(0.04, 0.04, 3.04, uv_scale=0.5), translation=(1.52, 5.10, 0.0)))
    steel_parts.append(transform_mesh(create_box(0.10, 0.05, 1.04, uv_scale=0.5), translation=(-1.52, 4.73, -1.06)))
    steel_parts.append(transform_mesh(create_box(0.10, 0.05, 1.04, uv_scale=0.5), translation=(-1.52, 4.73, 1.06)))

    # Military camouflage netting matching exact solid parapet heights (leaves +X/-X upper flank clear!)
    camo_parts.append(transform_mesh(create_box(3.12, 1.06, 0.02, uv_scale=0.6), translation=(0.0, 4.55, -1.57)))
    camo_parts.append(transform_mesh(create_box(3.12, 1.06, 0.02, uv_scale=0.6), translation=(0.0, 4.55, 1.57)))
    camo_parts.append(transform_mesh(create_box(0.02, 0.68, 3.12, uv_scale=0.6), translation=(1.57, 4.36, 0.0)))
    camo_parts.append(transform_mesh(create_box(0.02, 0.68, 1.00, uv_scale=0.6), translation=(-1.57, 4.36, -1.06)))
    camo_parts.append(transform_mesh(create_box(0.02, 0.68, 1.00, uv_scale=0.6), translation=(-1.57, 4.36, 1.06)))

    # Sandbags stacked along the inside perimeter of the 4m deck
    for sx in (-0.9, 0.0, 0.9):
        sandbag_parts.append(transform_mesh(create_box(0.75, 0.28, 0.34, uv_scale=0.9), translation=(sx, 4.14, -1.30)))
        sandbag_parts.append(transform_mesh(create_box(0.75, 0.28, 0.34, uv_scale=0.9), translation=(sx, 4.14, 1.30)))
    for sz in (-0.75, 0.0, 0.75):
        sandbag_parts.append(transform_mesh(create_box(0.34, 0.28, 0.68, uv_scale=0.9), translation=(1.30, 4.14, sz)))

    # 2 Corner floodlights mounted under roof eaves
    for sz in (-1.34, 1.34):
        steel_parts.append(
            transform_mesh(
                create_box(0.24, 0.16, 0.24, uv_scale=0.8),
                translation=(-1.42, 6.22, sz),
                rotation=(0.0, 0.0, 0.38),
            )
        )
        lens_parts.append(
            transform_mesh(
                create_box(0.04, 0.12, 0.18, uv_scale=1.0),
                translation=(-1.53, 6.18, sz),
                rotation=(0.0, 0.0, 0.38),
            )
        )

    # Slanted corrugated metal roof (y ~ 6.35..6.80m)
    roof_parts.append(
        transform_mesh(
            create_box(3.55, 0.06, 3.55, uv_scale=0.35),
            translation=(0.0, 6.52, 0.0),
            rotation=(0.0, 0.0, -0.14),
        )
    )

    return [
        GLBNode(
            name="watchtower_root",
            children=[
                GLBNode(name="watchtower_concrete", mesh=bake_vertical_foot_ao(merge_meshes(conc_parts), height=0.35, min_factor=0.48), material=mat_concrete),
                GLBNode(name="watchtower_steel", mesh=bake_vertical_foot_ao(merge_meshes(steel_parts), height=0.35, min_factor=0.55), material=mat_steel),
                GLBNode(name="watchtower_parapet", mesh=merge_meshes(parapet_parts), material=mat_parapet),
                GLBNode(name="watchtower_roof", mesh=merge_meshes(roof_parts), material=mat_roof),
                GLBNode(name="watchtower_camo_net", mesh=merge_meshes(camo_parts), material=mat_camo_net),
                GLBNode(name="watchtower_sandbags", mesh=merge_meshes(sandbag_parts), material=mat_sandbag),
                GLBNode(name="watchtower_flood_lens", mesh=merge_meshes(lens_parts), material=mat_lamp_lens),
            ],
        )
    ]

