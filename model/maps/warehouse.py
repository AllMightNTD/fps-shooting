"""Procedural old cracked concrete warehouse (10.0m x 14.0m x 5.2m) matching reference PBR."""

from __future__ import annotations

import math

from model.core import (
    GLBMaterial,
    GLBNode,
    MeshData,
    bake_vertical_foot_ao,
    create_box,
    create_tube_along_curve,
    extrude_shape,
    merge_meshes,
    transform_mesh,
)

from .textures import MilitaryMapTextures, build_military_textures


def build_warehouse_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build 10.0m x 14.0m x 5.2m warehouse with walk-through portals & shoot-through windows."""
    tex = textures or build_military_textures()

    mat_concrete = GLBMaterial(
        name="Warehouse_Concrete",
        color=0xFFFFFF,
        metalness=0.0,
        roughness=0.90,
        base_color_png=tex.concrete_albedo,
        metallic_roughness_png=tex.concrete_mr,
        normal_png=tex.concrete_normal,
        normal_scale=1.25,
    )
    mat_steel = GLBMaterial(
        name="Warehouse_Steel",
        color=0xFFFFFF,
        metalness=0.72,
        roughness=0.58,
        base_color_png=tex.steel_albedo,
        metallic_roughness_png=tex.steel_mr,
        normal_png=tex.steel_normal,
    )
    mat_roof = GLBMaterial(
        name="Warehouse_CorrugatedRoof",
        color=0xFFFFFF,
        metalness=0.52,
        roughness=0.74,
        base_color_png=tex.roof_albedo,
        metallic_roughness_png=tex.roof_mr,
        normal_png=tex.roof_normal,
        normal_scale=1.35,
    )

    concrete_parts: list[MeshData] = []
    steel_parts: list[MeshData] = []
    roof_parts: list[MeshData] = []

    W, D = 10.0, 14.0
    t = 0.36
    ht = t * 0.5
    eave_h = 3.80
    ridge_h = 5.20

    # Interior concrete floor pad (y in [0.0, 0.04], prevents ground Z-fighting)
    concrete_parts.append(transform_mesh(create_box(W - 0.1, 0.04, D - 0.1, uv_scale=0.25), translation=(0.0, 0.02, 0.0)))

    # +Z Front Gable Wall: Large 4.4m x 3.6m vehicle portal (x in [-2.2, 2.2])
    concrete_parts.append(transform_mesh(create_box(2.8, eave_h, t, uv_scale=0.3), translation=(-3.6, eave_h * 0.5, 7.0 - ht)))
    concrete_parts.append(transform_mesh(create_box(2.8, eave_h, t, uv_scale=0.3), translation=(3.6, eave_h * 0.5, 7.0 - ht)))
    concrete_parts.append(transform_mesh(create_box(4.4, eave_h - 3.6, t, uv_scale=0.3), translation=(0.0, 3.70, 7.0 - ht)))
    # Concrete plinth along solid piers
    concrete_parts.append(transform_mesh(create_box(2.84, 0.42, 0.48, uv_scale=0.3), translation=(-3.6, 0.21, 7.0 - ht)))
    concrete_parts.append(transform_mesh(create_box(2.84, 0.42, 0.48, uv_scale=0.3), translation=(3.6, 0.21, 7.0 - ht)))
    # Rusted steel portal frame
    steel_parts.append(transform_mesh(create_box(0.10, 3.60, 0.42, uv_scale=0.5), translation=(-2.20, 1.80, 7.0 - ht)))
    steel_parts.append(transform_mesh(create_box(0.10, 3.60, 0.42, uv_scale=0.5), translation=(2.20, 1.80, 7.0 - ht)))
    steel_parts.append(transform_mesh(create_box(4.50, 0.12, 0.42, uv_scale=0.5), translation=(0.0, 3.60, 7.0 - ht)))

    # -Z Rear Gable Wall: 3.0m x 2.8m rear portal (x in [-1.5, 1.5])
    concrete_parts.append(transform_mesh(create_box(3.5, eave_h, t, uv_scale=0.3), translation=(-3.25, eave_h * 0.5, -7.0 + ht)))
    concrete_parts.append(transform_mesh(create_box(3.5, eave_h, t, uv_scale=0.3), translation=(3.25, eave_h * 0.5, -7.0 + ht)))
    concrete_parts.append(transform_mesh(create_box(3.0, eave_h - 2.8, t, uv_scale=0.3), translation=(0.0, 3.30, -7.0 + ht)))
    concrete_parts.append(transform_mesh(create_box(3.54, 0.42, 0.48, uv_scale=0.3), translation=(-3.25, 0.21, -7.0 + ht)))
    concrete_parts.append(transform_mesh(create_box(3.54, 0.42, 0.48, uv_scale=0.3), translation=(3.25, 0.21, -7.0 + ht)))
    steel_parts.append(transform_mesh(create_box(0.09, 2.80, 0.42, uv_scale=0.5), translation=(-1.50, 1.40, -7.0 + ht)))
    steel_parts.append(transform_mesh(create_box(0.09, 2.80, 0.42, uv_scale=0.5), translation=(1.50, 1.40, -7.0 + ht)))
    steel_parts.append(transform_mesh(create_box(3.08, 0.10, 0.42, uv_scale=0.5), translation=(0.0, 2.80, -7.0 + ht)))

    # Gable triangles at +Z and -Z (y from eave_h to ridge_h)
    gable_tri = extrude_shape([(-5.0, 0.0), (5.0, 0.0), (0.0, ridge_h - eave_h)], depth=t, center=False, uv_scale=0.3)
    concrete_parts.append(transform_mesh(gable_tri, translation=(0.0, eave_h, 7.0 - t)))
    concrete_parts.append(transform_mesh(gable_tri, translation=(0.0, eave_h, -7.0)))

    # Side Walls (+X and -X) with 2 open industrial windows & 1 side corridor door
    for sx in (-1.0, 1.0):
        wx = sx * (5.0 - ht)
        # Solid wall piers
        for z0, z1 in ((-7.0, -5.0), (-3.2, -1.6), (0.2, 2.0), (4.2, 7.0)):
            zc = 0.5 * (z0 + z1)
            zl = z1 - z0
            concrete_parts.append(transform_mesh(create_box(t, eave_h, zl, uv_scale=0.3), translation=(wx, eave_h * 0.5, zc)))
            concrete_parts.append(transform_mesh(create_box(0.48, 0.42, zl + 0.04, uv_scale=0.3), translation=(wx, 0.21, zc)))

        # 2 Windows (z in [-5.0, -3.2] and [-1.6, 0.2], open zone y in [1.05, 2.15])
        for wz in (-4.1, -0.7):
            # Concrete sill & lintel
            concrete_parts.append(transform_mesh(create_box(t, 1.05, 1.80, uv_scale=0.3), translation=(wx, 0.525, wz)))
            concrete_parts.append(transform_mesh(create_box(0.48, 0.42, 1.80, uv_scale=0.3), translation=(wx, 0.21, wz)))
            concrete_parts.append(transform_mesh(create_box(0.44, 0.09, 1.92, uv_scale=0.35), translation=(wx, 1.02, wz)))
            concrete_parts.append(transform_mesh(create_box(t, 1.65, 1.80, uv_scale=0.3), translation=(wx, 2.975, wz)))
            # Thin steel outer window frame (center stays open for bullet raycasts)
            steel_parts.append(transform_mesh(create_box(0.06, 1.10, 0.05, uv_scale=0.5), translation=(wx, 1.60, wz - 0.87)))
            steel_parts.append(transform_mesh(create_box(0.06, 1.10, 0.05, uv_scale=0.5), translation=(wx, 1.60, wz + 0.87)))
            steel_parts.append(transform_mesh(create_box(0.06, 0.05, 1.80, uv_scale=0.5), translation=(wx, 2.12, wz)))
            steel_parts.append(transform_mesh(create_box(0.06, 0.05, 1.80, uv_scale=0.5), translation=(wx, 1.08, wz)))

        # Side door (z in [2.0, 4.2], y in [0, 2.6])
        concrete_parts.append(transform_mesh(create_box(t, 1.20, 2.20, uv_scale=0.3), translation=(wx, 3.20, 3.1)))
        steel_parts.append(transform_mesh(create_box(0.40, 2.60, 0.08, uv_scale=0.5), translation=(wx, 1.30, 2.04)))
        steel_parts.append(transform_mesh(create_box(0.40, 2.60, 0.08, uv_scale=0.5), translation=(wx, 1.30, 4.16)))
        steel_parts.append(transform_mesh(create_box(0.40, 0.09, 2.20, uv_scale=0.5), translation=(wx, 2.60, 3.10)))

        # Exterior vertical pilasters matching reference image
        for pz in (-6.78, -2.40, 1.10, 6.78):
            concrete_parts.append(transform_mesh(create_box(0.46, eave_h, 0.44, uv_scale=0.3), translation=(wx, eave_h * 0.5, pz)))

    # Interior A-Frame Steel Roof Trusses (at z = -3.5, 0.0, +3.5)
    rafter_dx = 5.0
    rafter_dy = ridge_h - eave_h - 0.15
    rafter_len = math.hypot(rafter_dx, rafter_dy)
    rafter_ang = math.atan2(rafter_dy, rafter_dx)
    for tz in (-3.5, 0.0, 3.5):
        # Bottom tie chord
        steel_parts.append(transform_mesh(create_box(9.4, 0.12, 0.12, uv_scale=0.4), translation=(0.0, eave_h - 0.06, tz)))
        # Center king post
        steel_parts.append(transform_mesh(create_box(0.10, rafter_dy, 0.10, uv_scale=0.4), translation=(0.0, eave_h + rafter_dy * 0.5, tz)))
        # Left & Right sloped rafters
        steel_parts.append(
            transform_mesh(
                create_box(rafter_len, 0.12, 0.12, uv_scale=0.4),
                translation=(-2.5, eave_h + rafter_dy * 0.5, tz),
                rotation=(0.0, 0.0, rafter_ang),
            )
        )
        steel_parts.append(
            transform_mesh(
                create_box(rafter_len, 0.12, 0.12, uv_scale=0.4),
                translation=(2.5, eave_h + rafter_dy * 0.5, tz),
                rotation=(0.0, 0.0, -rafter_ang),
            )
        )

    # Pitched Corrugated Metal Roof Panels (with slight 0.3m overhang)
    roof_slope_dx = 5.35
    roof_slope_dy = (ridge_h - eave_h) * (5.35 / 5.0)
    roof_panel_w = math.hypot(roof_slope_dx, roof_slope_dy)
    roof_ang = math.atan2(ridge_h - eave_h, 5.0)
    roof_parts.append(
        transform_mesh(
            create_box(roof_panel_w, 0.06, D + 0.55, uv_scale=0.35),
            translation=(-roof_slope_dx * 0.5, ridge_h - roof_slope_dy * 0.5 + 0.05, 0.0),
            rotation=(0.0, 0.0, roof_ang),
        )
    )
    roof_parts.append(
        transform_mesh(
            create_box(roof_panel_w, 0.06, D + 0.55, uv_scale=0.35),
            translation=(roof_slope_dx * 0.5, ridge_h - roof_slope_dy * 0.5 + 0.05, 0.0),
            rotation=(0.0, 0.0, -roof_ang),
        )
    )
    # Ridge cap
    roof_parts.append(transform_mesh(create_box(0.28, 0.08, D + 0.58, uv_scale=0.4), translation=(0.0, ridge_h + 0.06, 0.0)))

    # Hanging exterior electrical wires & gutter brackets (matching reference concept)
    for sx in (-1.0, 1.0):
        wx_out = sx * 5.08
        for wire_y, sag in ((3.42, 0.34), (3.18, 0.42)):
            for z_a, z_b in ((-6.6, -2.5), (-2.3, 1.1), (1.3, 6.6)):
                zm = 0.5 * (z_a + z_b)
                pts = [
                    (wx_out, wire_y, z_a),
                    (wx_out + sx * 0.04, wire_y - sag * 0.72, 0.5 * (z_a + zm)),
                    (wx_out + sx * 0.05, wire_y - sag, zm),
                    (wx_out + sx * 0.04, wire_y - sag * 0.72, 0.5 * (zm + z_b)),
                    (wx_out, wire_y, z_b),
                ]
                steel_parts.append(create_tube_along_curve(pts, radius=0.015, tubular_segments=10, radial_segments=5))

    # Front & rear gable draped power cable
    for z_end, sgn in ((7.06, 1.0), (-7.06, -1.0)):
        cable_pts = [
            (-4.7, 3.45, z_end),
            (-2.6, 3.08, z_end + sgn * 0.03),
            (-0.2, 3.68, z_end + sgn * 0.02),
            (2.4, 3.12, z_end + sgn * 0.03),
            (4.7, 3.45, z_end),
        ]
        steel_parts.append(create_tube_along_curve(cable_pts, radius=0.016, tubular_segments=12, radial_segments=5))

    return [
        GLBNode(
            name="warehouse_root",
            children=[
                GLBNode(name="warehouse_concrete", mesh=bake_vertical_foot_ao(merge_meshes(concrete_parts), height=0.40, min_factor=0.46), material=mat_concrete),
                GLBNode(name="warehouse_steel", mesh=bake_vertical_foot_ao(merge_meshes(steel_parts), height=0.35, min_factor=0.55), material=mat_steel),
                GLBNode(name="warehouse_roof", mesh=merge_meshes(roof_parts), material=mat_roof),
            ],
        )
    ]

