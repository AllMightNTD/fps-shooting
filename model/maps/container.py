"""Procedural military shipping container (6.0m x 2.4m x 2.6m) matching reference PBR."""

from __future__ import annotations

import math

import numpy as np

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


def build_container_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build a 6.0m x 2.4m x 2.6m ISO military container centered at bottom (y = 0)."""
    tex = textures or build_military_textures()

    # Neutral weathered corrugated metal base so InstancedMesh.setColorAt tints cleanly
    mat_body = GLBMaterial(
        name="Container_Corrugated",
        color=0xFFFFFF,
        metalness=0.32,
        roughness=0.80,
        base_color_png=tex.container_albedo,
        metallic_roughness_png=tex.container_mr,
        normal_png=tex.container_normal,
        normal_scale=1.25,
    )
    mat_frame = GLBMaterial(
        name="Container_SteelFrame",
        color=0xCDD4DC,
        metalness=0.78,
        roughness=0.48,
        base_color_png=tex.steel_albedo,
        metallic_roughness_png=tex.steel_mr,
        normal_png=tex.steel_normal,
        normal_scale=1.0,
    )
    # Brighter galvanized steel for door locking rods, hinges, cam keepers & corner casting accents
    mat_hardware = GLBMaterial(
        name="Container_Hardware",
        color=0xE2E8EE,
        metalness=0.86,
        roughness=0.34,
        base_color_png=tex.steel_albedo,
        metallic_roughness_png=tex.steel_mr,
        normal_png=tex.steel_normal,
        normal_scale=0.85,
    )
    mat_stencil = GLBMaterial(
        name="Container_Stencil",
        color=0xFFFFFF,
        metalness=0.10,
        roughness=0.82,
        base_color_png=tex.container_stencil,
    )

    W, D, H = 6.0, 2.4, 2.6
    body_parts: list[MeshData] = []
    frame_parts: list[MeshData] = []
    hardware_parts: list[MeshData] = []

    # Core inner hull (recessed slightly so ribs & frame stand out cleanly)
    core = transform_mesh(create_box(W - 0.14, H - 0.14, D - 0.12, uv_scale=0.35), translation=(0.0, H * 0.5, 0.0))
    body_parts.append(core)

    # Vertical corrugated steel ribs along front/back (+Z / -Z) walls
    rib_w = 0.08
    rib_d = 0.045
    n_ribs = 22
    for i in range(n_ribs):
        rx = -2.68 + i * (5.36 / (n_ribs - 1))
        for sz in (-1.0, 1.0):
            rib = transform_mesh(
                create_box(rib_w, H - 0.24, rib_d, uv_scale=0.5),
                translation=(rx, H * 0.5, sz * (D * 0.5 - 0.035)),
            )
            body_parts.append(rib)

    # Roof longitudinal ribs
    for i in range(18):
        rx = -2.64 + i * (5.28 / 17)
        roof_rib = transform_mesh(
            create_box(0.08, 0.035, D - 0.18, uv_scale=0.5),
            translation=(rx, H - 0.04, 0.0),
        )
        body_parts.append(roof_rib)

    # Double cargo doors on +X end (with horizontal corrugation & center seam)
    for sz in (-0.56, 0.56):
        door_panel = transform_mesh(
            create_box(0.06, H - 0.24, 1.06, uv_scale=0.45),
            translation=(W * 0.5 - 0.06, H * 0.5, sz),
        )
        body_parts.append(door_panel)
        for ry in (0.65, 1.30, 1.95):
            h_rib = transform_mesh(
                create_box(0.03, 0.09, 0.94, uv_scale=0.5),
                translation=(W * 0.5 - 0.025, ry, sz),
            )
            body_parts.append(h_rib)

    # Closed -X end wall corrugations
    for sz in (-0.9, -0.45, 0.0, 0.45, 0.9):
        end_rib = transform_mesh(
            create_box(0.04, H - 0.26, 0.12, uv_scale=0.5),
            translation=(-W * 0.5 + 0.04, H * 0.5, sz),
        )
        body_parts.append(end_rib)

    # Dark steel structural frame: 4 corner posts, 8 corner castings, top/bottom rails
    post_w = 0.15
    for sx in (-1.0, 1.0):
        for sz in (-1.0, 1.0):
            post = transform_mesh(
                create_box(post_w, H - 0.02, post_w, uv_scale=0.5),
                translation=(sx * (W * 0.5 - post_w * 0.5), H * 0.5, sz * (D * 0.5 - post_w * 0.5)),
            )
            frame_parts.append(post)
            for cy in (0.09, H - 0.09):
                casting = transform_mesh(
                    create_box(0.185, 0.185, 0.185, uv_scale=0.6),
                    translation=(sx * (W * 0.5 - 0.09), cy, sz * (D * 0.5 - 0.09)),
                )
                hardware_parts.append(casting)

    # Longitudinal top/bottom rails
    for sz in (-1.0, 1.0):
        for cy, rh in ((0.08, 0.16), (H - 0.06, 0.12)):
            rail = transform_mesh(
                create_box(W - 0.18, rh, 0.12, uv_scale=0.45),
                translation=(0.0, cy, sz * (D * 0.5 - 0.06)),
            )
            frame_parts.append(rail)
    # Cross end headers/sills
    for sx in (-1.0, 1.0):
        for cy, rh in ((0.08, 0.16), (H - 0.06, 0.12)):
            end_beam = transform_mesh(
                create_box(0.12, rh, D - 0.18, uv_scale=0.45),
                translation=(sx * (W * 0.5 - 0.06), cy, 0.0),
            )
            frame_parts.append(end_beam)

    # Rubber center weatherseal seam between double doors on +X face
    frame_parts.append(
        transform_mesh(create_box(0.04, H - 0.24, 0.045, uv_scale=0.6), translation=(W * 0.5 - 0.02, H * 0.5, 0.0))
    )

    # 4 vertical galvanized door locking bars + handles + cam keepers + guide brackets on +X cargo doors
    for lz in (-0.82, -0.26, 0.26, 0.82):
        bar = transform_mesh(
            create_cylinder(0.019, 0.019, H - 0.22, radial_segments=6, uv_scale=0.6),
            translation=(W * 0.5 - 0.002, H * 0.5, lz),
        )
        handle = transform_mesh(
            create_box(0.032, 0.032, 0.18, uv_scale=0.6),
            translation=(W * 0.5 + 0.016, 1.04, lz + (0.08 if lz < 0 else -0.08)),
        )
        # Handle retainer catch plate
        retainer = transform_mesh(
            create_box(0.025, 0.075, 0.055, uv_scale=0.7),
            translation=(W * 0.5 + 0.006, 1.04, lz + (0.14 if lz < 0 else -0.14)),
        )
        # Top & bottom cam lock keepers engaging header/sill
        cam_bot = transform_mesh(
            create_box(0.048, 0.075, 0.075, uv_scale=0.7),
            translation=(W * 0.5 + 0.008, 0.15, lz),
        )
        cam_top = transform_mesh(
            create_box(0.048, 0.075, 0.075, uv_scale=0.7),
            translation=(W * 0.5 + 0.008, H - 0.13, lz),
        )
        # Mid-height rod guide brackets
        guide_lo = transform_mesh(create_box(0.036, 0.05, 0.06, uv_scale=0.7), translation=(W * 0.5 + 0.004, 0.72, lz))
        guide_hi = transform_mesh(create_box(0.036, 0.05, 0.06, uv_scale=0.7), translation=(W * 0.5 + 0.004, 1.88, lz))
        hardware_parts.extend([bar, handle, retainer, cam_bot, cam_top, guide_lo, guide_hi])

    # 8 heavy-duty cargo door hinges (4 per side along +-Z outer door edges)
    for sz_sign in (-1.0, 1.0):
        hz = sz_sign * (D * 0.5 - 0.13)
        for hy in (0.42, 1.02, 1.62, 2.22):
            hinge_strap = transform_mesh(
                create_box(0.035, 0.065, 0.16, uv_scale=0.7),
                translation=(W * 0.5 - 0.005, hy, hz - sz_sign * 0.05),
            )
            hinge_pin = transform_mesh(
                create_box(0.042, 0.095, 0.042, uv_scale=0.7),
                translation=(W * 0.5 + 0.005, hy, hz + sz_sign * 0.03),
            )
            hardware_parts.extend([hinge_strap, hinge_pin])

    # Stencil data/ID plates on side walls & cargo door
    from model.core import create_plane
    stencil_parts: list[MeshData] = []
    p_front = create_plane(0.86, 0.42)
    # Normalize plane UVs to [0, 1] so military stencil reads cleanly
    p_front = MeshData(
        positions=p_front.positions,
        normals=p_front.normals,
        uvs=np.column_stack([
            (p_front.positions[:, 0] / 0.86) + 0.5,
            (p_front.positions[:, 1] / 0.42) + 0.5,
        ]).astype(np.float32),
        indices=p_front.indices,
    )
    stencil_parts.append(transform_mesh(p_front, translation=(2.15, 1.92, D * 0.5 + 0.002)))
    stencil_parts.append(transform_mesh(p_front, translation=(-2.15, 1.92, -D * 0.5 - 0.002), rotation=(0.0, math.pi, 0.0)))
    stencil_parts.append(transform_mesh(p_front, translation=(W * 0.5 + 0.004, 1.85, -0.56), rotation=(0.0, math.pi * 0.5, 0.0)))

    return [
        GLBNode(
            name="container_root",
            children=[
                GLBNode(name="container_body", mesh=bake_vertical_foot_ao(merge_meshes(body_parts), height=0.40, min_factor=0.42), material=mat_body),
                GLBNode(name="container_frame", mesh=bake_vertical_foot_ao(merge_meshes(frame_parts), height=0.40, min_factor=0.48), material=mat_frame),
                GLBNode(name="container_hardware", mesh=bake_vertical_foot_ao(merge_meshes(hardware_parts), height=0.35, min_factor=0.58), material=mat_hardware),
                GLBNode(name="container_stencil", mesh=merge_meshes(stencil_parts), material=mat_stencil),
            ],
        )
    ]

