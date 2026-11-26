"""Procedural tactical props pack: sandbag, concrete_wall, fence, wood_crate, oil_barrel, wood_pallet, tire_stack, barbed_wire."""

from __future__ import annotations

import math

from model.core import (
    GLBMaterial,
    GLBNode,
    MeshData,
    bake_vertical_foot_ao,
    create_beveled_box,
    create_box,
    create_cylinder,
    create_torus,
    merge_meshes,
    transform_mesh,
)

from .textures import MilitaryMapTextures, build_military_textures


def build_sandbag_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build staggered burlap sandbag barrier (1.8m x 0.75m x 1.10m, bottom y = 0)."""
    tex = textures or build_military_textures()
    mat = GLBMaterial(
        name="Prop_Sandbag",
        color=0xFFFFFF,
        metalness=0.0,
        roughness=0.92,
        base_color_png=tex.sandbag_albedo,
        normal_png=tex.sandbag_normal,
        normal_scale=1.1,
    )
    parts: list[MeshData] = []
    bag_h = 0.22
    bag_d = 0.36
    courses = [
        (-0.56, 0.0, 0.56),
        (-0.30, 0.30),
        (-0.56, 0.0, 0.56),
        (-0.30, 0.30),
        (-0.54, 0.0, 0.54),
    ]
    for row_idx, xs in enumerate(courses):
        cy = bag_h * 0.5 + row_idx * bag_h
        w_each = 0.58 if len(xs) == 3 else 0.86
        for bz in (-0.18, 0.18):
            for bx in xs:
                bag = transform_mesh(
                    create_box(w_each, bag_h, bag_d, uv_scale=0.9),
                    translation=(bx, cy, bz),
                )
                parts.append(bag)
    return [GLBNode(name="sandbag_root", mesh=bake_vertical_foot_ao(merge_meshes(parts), height=0.35, min_factor=0.46), material=mat)]


def build_concrete_wall_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build weathered Jersey/T-wall concrete barrier with beveled coping cap & foot grime (4.04m x 0.48m x 2.40m)."""
    tex = textures or build_military_textures()
    mat = GLBMaterial(
        name="Prop_ConcreteWall",
        color=0xFFFFFF,
        metalness=0.0,
        roughness=0.90,
        base_color_png=tex.concrete_albedo,
        metallic_roughness_png=tex.concrete_mr,
        normal_png=tex.concrete_normal,
        normal_scale=1.25,
    )
    parts = [
        # Grounded plinth base
        transform_mesh(create_box(4.0, 0.30, 0.45, uv_scale=0.35), translation=(0.0, 0.15, 0.0)),
        # Main concrete wall slab (crisp box keeps 100-wall map triangle budget lean)
        transform_mesh(create_box(3.96, 2.02, 0.30, uv_scale=0.35), translation=(0.0, 1.31, 0.0)),
        # End & center structural pilasters dividing long boundary walls into architectural bays
        transform_mesh(create_box(0.24, 2.38, 0.43, uv_scale=0.35), translation=(-1.88, 1.19, 0.0)),
        transform_mesh(create_box(0.18, 2.34, 0.38, uv_scale=0.35), translation=(0.0, 1.17, 0.0)),
        transform_mesh(create_box(0.24, 2.38, 0.43, uv_scale=0.35), translation=(1.88, 1.19, 0.0)),
        # Overhanging beveled wall coping cap catching angled sun rim highlights
        transform_mesh(create_beveled_box(4.04, 0.085, 0.48, bevel=0.02, segments=1, uv_scale=0.35), translation=(0.0, 2.3575, 0.0)),
    ]
    return [GLBNode(name="concrete_wall_root", mesh=bake_vertical_foot_ao(merge_meshes(parts), height=0.42, min_factor=0.38), material=mat)]


def build_fence_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build rusted steel security fence (4.0m x 0.15m x 2.40m, bottom y = 0)."""
    tex = textures or build_military_textures()
    mat_steel = GLBMaterial(
        name="Prop_FenceSteel",
        color=0xFFFFFF,
        metalness=0.72,
        roughness=0.58,
        base_color_png=tex.steel_albedo,
        metallic_roughness_png=tex.steel_mr,
        normal_png=tex.steel_normal,
    )
    parts: list[MeshData] = []
    for px in (-1.94, 0.0, 1.94):
        parts.append(
            transform_mesh(create_cylinder(0.045, 0.045, 2.40, radial_segments=8), translation=(px, 1.20, 0.0))
        )
    for ry in (0.18, 1.18, 2.26):
        parts.append(transform_mesh(create_box(3.96, 0.05, 0.05, uv_scale=0.5), translation=(0.0, ry, 0.0)))
    for i in range(19):
        px = -1.80 + i * 0.20
        if abs(px) < 0.06:
            continue
        parts.append(transform_mesh(create_box(0.022, 2.15, 0.022, uv_scale=0.5), translation=(px, 1.18, 0.0)))
    return [GLBNode(name="fence_root", mesh=merge_meshes(parts), material=mat_steel)]


def build_wood_crate_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build military supply wooden crate (1.2m x 1.2m x 1.2m, bottom y = 0)."""
    tex = textures or build_military_textures()
    mat = GLBMaterial(
        name="Prop_WoodCrate",
        color=0xFFFFFF,
        metalness=0.04,
        roughness=0.84,
        base_color_png=tex.wood_albedo,
    )
    parts: list[MeshData] = [
        transform_mesh(create_beveled_box(1.12, 1.12, 1.12, bevel=0.022, segments=1, uv_scale=0.85), translation=(0.0, 0.60, 0.0)),
    ]
    b = 0.09
    for sy in (0.045, 1.155):
        for sz in (-0.555, 0.555):
            parts.append(transform_mesh(create_box(1.20, b, b, uv_scale=0.9), translation=(0.0, sy, sz)))
        for sx in (-0.555, 0.555):
            parts.append(transform_mesh(create_box(b, b, 1.20, uv_scale=0.9), translation=(sx, sy, 0.0)))
    for sx in (-0.555, 0.555):
        for sz in (-0.555, 0.555):
            parts.append(transform_mesh(create_box(b, 1.20, b, uv_scale=0.9), translation=(sx, 0.60, sz)))
    return [GLBNode(name="wood_crate_root", mesh=bake_vertical_foot_ao(merge_meshes(parts), height=0.34, min_factor=0.48), material=mat)]


def build_oil_barrel_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build rusted 200L steel oil drum (0.58m x 0.58m x 0.88m, bottom y = 0, tintable)."""
    tex = textures or build_military_textures()
    mat = GLBMaterial(
        name="Prop_OilBarrel",
        color=0xFFFFFF,
        metalness=0.58,
        roughness=0.68,
        base_color_png=tex.barrel_albedo,
        metallic_roughness_png=tex.barrel_mr,
    )
    parts = [
        transform_mesh(create_cylinder(0.285, 0.285, 0.88, radial_segments=14, uv_scale=0.9), translation=(0.0, 0.44, 0.0)),
        transform_mesh(create_cylinder(0.296, 0.296, 0.032, radial_segments=14, uv_scale=1.0), translation=(0.0, 0.30, 0.0)),
        transform_mesh(create_cylinder(0.296, 0.296, 0.032, radial_segments=14, uv_scale=1.0), translation=(0.0, 0.58, 0.0)),
        transform_mesh(create_cylinder(0.036, 0.036, 0.025, radial_segments=8, uv_scale=1.0), translation=(0.14, 0.885, 0.0)),
    ]
    return [GLBNode(name="oil_barrel_root", mesh=bake_vertical_foot_ao(merge_meshes(parts), height=0.30, min_factor=0.50), material=mat)]


def build_wood_pallet_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build weathered wooden shipping pallet (1.20m x 1.00m x 0.16m, bottom y = 0)."""
    tex = textures or build_military_textures()
    mat = GLBMaterial(
        name="Prop_WoodPallet",
        color=0xFFFFFF,
        metalness=0.02,
        roughness=0.88,
        base_color_png=tex.wood_albedo,
    )
    parts: list[MeshData] = []
    for sz in (-0.42, 0.0, 0.42):
        parts.append(transform_mesh(create_box(1.20, 0.03, 0.12, uv_scale=0.9), translation=(0.0, 0.015, sz)))
        for sx in (-0.52, 0.0, 0.52):
            parts.append(transform_mesh(create_box(0.12, 0.10, 0.12, uv_scale=0.9), translation=(sx, 0.08, sz)))
    for i in range(5):
        pz = -0.42 + i * 0.21
        parts.append(transform_mesh(create_box(1.20, 0.03, 0.13, uv_scale=0.9), translation=(0.0, 0.145, pz)))
    return [GLBNode(name="wood_pallet_root", mesh=merge_meshes(parts), material=mat)]


def build_tire_stack_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build mud-caked stacked tires (0.94m x 0.94m x 0.62m, bottom y = 0)."""
    tex = textures or build_military_textures()
    mat = GLBMaterial(
        name="Prop_TireStack",
        color=0xFFFFFF,
        metalness=0.02,
        roughness=0.88,
        base_color_png=tex.rubber_albedo,
    )
    tire_flat = create_torus(major_radius=0.31, tube_radius=0.125, radial_segments=6, tubular_segments=12)
    parts = [
        transform_mesh(tire_flat, translation=(-0.08, 0.125, 0.0), rotation=(math.pi * 0.5, 0.0, 0.0)),
        transform_mesh(tire_flat, translation=(-0.06, 0.37, 0.02), rotation=(math.pi * 0.5, 0.08, 0.0)),
        transform_mesh(tire_flat, translation=(0.24, 0.43, -0.05), rotation=(0.35, 0.42, 0.15)),
    ]
    return [GLBNode(name="tire_stack_root", mesh=bake_vertical_foot_ao(merge_meshes(parts), height=0.22, min_factor=0.46), material=mat)]


def build_barbed_wire_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build coiled concertina barbed-wire barrier (4.0m x 0.45m x 0.52m, bottom y = 0)."""
    tex = textures or build_military_textures()
    mat = GLBMaterial(
        name="Prop_BarbedWire",
        color=0xFFFFFF,
        metalness=0.72,
        roughness=0.58,
        base_color_png=tex.steel_albedo,
        metallic_roughness_png=tex.steel_mr,
    )
    parts: list[MeshData] = []
    # 2 steel X-frame supports
    for px in (-1.50, 1.50):
        parts.append(transform_mesh(create_box(0.03, 0.54, 0.03, uv_scale=0.8), translation=(px, 0.25, 0.0), rotation=(0.45, 0.0, 0.0)))
        parts.append(transform_mesh(create_box(0.03, 0.54, 0.03, uv_scale=0.8), translation=(px, 0.25, 0.0), rotation=(-0.45, 0.0, 0.0)))
    # 5 compact concertina wire rings along X (keeps total map triangle budget lean)
    coil = create_torus(major_radius=0.22, tube_radius=0.012, radial_segments=3, tubular_segments=6)
    for i in range(5):
        cx = -1.56 + i * 0.78
        tilt = 0.24 if i % 2 == 0 else -0.24
        parts.append(transform_mesh(coil, translation=(cx, 0.26, 0.0), rotation=(0.0, math.pi * 0.5 + tilt, 0.14)))
    return [GLBNode(name="barbed_wire_root", mesh=merge_meshes(parts), material=mat)]
