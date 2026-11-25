"""High-detail Glock Gen4/Gen5 Tactical Pistol PBR 3D model builder."""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from model.core import (
    GLBMaterial,
    GLBNode,
    MeshData,
    create_beveled_box,
    create_box,
    create_cylinder,
    create_pistol_textures,
    create_torus,
    extrude_hollow_profile,
    extrude_shape,
    extrude_side_profile,
    merge_meshes,
    sample_quadratic_bezier,
    transform_mesh,
)

PISTOL_METADATA: dict[str, object] = {
    "weapon": "Glock-17",
    "sightY": 0.0671,
    "sightFrontZ": -0.1297,
    "sightRearZ": 0.0488,
    "slideBlowbackZ": 0.044,
    "slideLockZ": 0.042,
    "triggerPivot": [0.0, 0.017, -0.036],
    "muzzlePos": [0.0, 0.0495, -0.172],
    "magDropAxis": [0.0, -1.0, 0.32],
    "sockets": {
        "handguard": "socket_handguard",
        "grip": "socket_grip",
        "mag": "socket_mag",
        "slide": "socket_slide",
    },
}


def _socket_euler_xyz(
    distal: Sequence[float],
    palm_normal: Sequence[float],
    is_right_hand: bool = False,
) -> tuple[float, float, float]:
    """Compute socket XYZ Euler rotation where -Z=distal, +Y=radial, and +/-X=palm_normal."""
    z_axis = -np.asarray(distal, dtype=np.float64)
    z_axis /= np.linalg.norm(z_axis)
    sign = -1.0 if is_right_hand else 1.0
    x_axis = np.asarray(palm_normal, dtype=np.float64) * sign
    x_axis = x_axis - z_axis * float(np.dot(x_axis, z_axis))
    x_axis /= np.linalg.norm(x_axis)
    y_axis = np.cross(z_axis, x_axis)
    y_axis /= np.linalg.norm(y_axis)
    mat = np.column_stack((x_axis, y_axis, z_axis))

    sy = max(-1.0, min(1.0, float(mat[0, 2])))
    ry = math.asin(sy)
    if abs(mat[0, 2]) < 0.99999:
        rx = math.atan2(-mat[1, 2], mat[2, 2])
        rz = math.atan2(-mat[0, 1], mat[0, 0])
    else:
        rx = math.atan2(mat[2, 1], mat[1, 1])
        rz = 0.0
    return (round(rx, 6), round(ry, 6), round(rz, 6))

# 45-degree top-chamfered Glock slide cross-section (XY plane -> extruded along +Z)
_SLIDE_CROSS_SECTION: list[tuple[float, float]] = [
    (-0.0138, 0.0360),
    (0.0138, 0.0360),
    (0.0138, 0.0568),
    (0.0102, 0.0618),
    (-0.0102, 0.0618),
    (-0.0138, 0.0568),
]


def _interp_line(
    p0: tuple[float, float],
    p1: tuple[float, float],
    segments: int,
    include_start: bool = False,
) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    start = 0 if include_start else 1
    for i in range(start, segments + 1):
        t = i / segments
        pts.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t))
    return pts


def _build_frame_contour() -> list[tuple[float, float]]:
    """Upper polymer frame with curved beavertail tang (in shape XY -> world ZY)."""
    pts: list[tuple[float, float]] = [(-0.141, 0.0352), (0.048, 0.0352)]
    pts.extend(sample_quadratic_bezier((0.048, 0.0352), (0.062, 0.033), (0.058, 0.024), segments=10))
    pts.extend(sample_quadratic_bezier((0.058, 0.024), (0.045, 0.019), (0.041, 0.014), segments=10))
    pts.extend([(-0.072, 0.0185), (-0.136, 0.0195), (-0.142, 0.025)])
    return pts


def _build_grip_contour() -> list[tuple[float, float]]:
    """~18-degree angled Glock ergonomic grip with curved backstrap, flared base & 3 finger grooves."""
    pts: list[tuple[float, float]] = [(-0.008, 0.020), (0.042, 0.020)]
    pts.extend(sample_quadratic_bezier((0.042, 0.020), (0.054, -0.024), (0.073, -0.088), segments=14))
    pts.append((0.023, -0.095))
    pts.extend(sample_quadratic_bezier((0.023, -0.095), (0.015, -0.072), (0.012, -0.056), segments=8))
    pts.extend(sample_quadratic_bezier((0.012, -0.056), (0.005, -0.038), (0.003, -0.022), segments=8))
    pts.extend(sample_quadratic_bezier((0.003, -0.022), (-0.003, -0.006), (-0.008, 0.005), segments=8))
    return pts


def _build_trigger_guard_loops() -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Build matched 32-vertex outer & inner loops for the square undercut Glock trigger guard."""
    # Outer loop: 4 sides with (10, 8, 10, 4) = 32 vertices
    outer: list[tuple[float, float]] = []
    outer.extend(_interp_line((-0.072, 0.020), (-0.075, -0.004), segments=5, include_start=True)[:-1])
    outer.extend(sample_quadratic_bezier((-0.075, -0.004), (-0.075, -0.010), (-0.068, -0.010), segments=5, include_start=True)[:-1])
    outer.extend(_interp_line((-0.068, -0.010), (-0.010, -0.010), segments=8, include_start=True)[:-1])
    outer.extend(sample_quadratic_bezier((-0.010, -0.010), (-0.003, -0.008), (0.001, 0.004), segments=6, include_start=True)[:-1])
    outer.extend(_interp_line((0.001, 0.004), (0.001, 0.020), segments=4, include_start=True)[:-1])
    outer.extend(_interp_line((0.001, 0.020), (-0.072, 0.020), segments=4, include_start=True)[:-1])

    # Inner loop: matched (10, 8, 10, 4) = 32 vertices around the undercut trigger opening
    inner: list[tuple[float, float]] = []
    inner.extend(_interp_line((-0.066, 0.016), (-0.068, -0.0035), segments=10, include_start=True)[:-1])
    inner.extend(_interp_line((-0.068, -0.0035), (-0.012, -0.0042), segments=8, include_start=True)[:-1])
    inner.extend(sample_quadratic_bezier((-0.012, -0.0042), (-0.007, 0.002), (-0.008, 0.016), segments=10, include_start=True)[:-1])
    inner.extend(_interp_line((-0.008, 0.016), (-0.066, 0.016), segments=4, include_start=True)[:-1])

    return outer, inner


def _build_trigger_contour() -> list[tuple[float, float]]:
    """Curved Glock trigger shoe profile relative to trigger pivot (0, 0.017, -0.036)."""
    pts: list[tuple[float, float]] = [(-0.003, 0.002), (0.003, 0.002)]
    pts.extend(sample_quadratic_bezier((0.003, 0.002), (0.001, -0.010), (-0.005, -0.0195), segments=10))
    pts.append((-0.010, -0.0185))
    pts.extend(sample_quadratic_bezier((-0.010, -0.0185), (-0.004, -0.009), (-0.003, 0.002), segments=10))
    return pts


def _create_materials(texture_size: int = 512, seed: int = 42) -> dict[str, GLBMaterial]:
    tex = create_pistol_textures(size=texture_size, scratch_count=65, droplet_count=190, seed=seed + 300)
    return {
        "slide": GLBMaterial(
            name="Pistol_Slide",
            color=0x252B34,
            metalness=0.86,
            roughness=0.42,
            base_color_png=tex.slide_albedo_png,
            metallic_roughness_png=tex.slide_mr_png,
            normal_png=tex.slide_normal_png,
            normal_scale=0.90,
            clearcoat=0.72,
            clearcoat_roughness=0.16,
        ),
        "steel": GLBMaterial(
            name="Pistol_SteelChamber",
            color=0x48505C,
            metalness=0.94,
            roughness=0.28,
            metallic_roughness_png=tex.slide_mr_png,
            normal_png=tex.slide_normal_png,
            normal_scale=0.35,
            clearcoat=0.55,
            clearcoat_roughness=0.18,
        ),
        "polymer": GLBMaterial(
            name="Pistol_Polymer",
            color=0x1D2026,
            metalness=0.06,
            roughness=0.68,
            base_color_png=tex.polymer_albedo_png,
            metallic_roughness_png=tex.polymer_mr_png,
            normal_png=tex.slide_normal_png,
            normal_scale=0.42,
            clearcoat=0.28,
            clearcoat_roughness=0.32,
        ),
        "stipple": GLBMaterial(
            name="Pistol_GripStipple",
            color=0x191C21,
            metalness=0.04,
            roughness=0.78,
            base_color_png=tex.stipple_albedo_png,
            metallic_roughness_png=tex.stipple_mr_png,
            normal_png=tex.stipple_normal_png,
            normal_scale=1.35,
            clearcoat=0.18,
            clearcoat_roughness=0.45,
        ),
        "hardware": GLBMaterial(
            name="Pistol_DarkHardware",
            color=0x2E343E,
            metalness=0.85,
            roughness=0.34,
            clearcoat=0.35,
            clearcoat_roughness=0.24,
        ),
        "recess": GLBMaterial(
            name="Pistol_Recess",
            color=0x060709,
            metalness=0.30,
            roughness=0.90,
        ),
        "sight_ring": GLBMaterial(
            name="Pistol_SightRing",
            color=0xDBE6DC,
            emissive=0xDBE6DC,
            emissive_intensity=1.0,
            unlit=True,
        ),
        "tritium": GLBMaterial(
            name="Pistol_Tritium",
            color=0x39FF14,
            emissive=0x2AFF38,
            emissive_intensity=4.5,
            unlit=True,
        ),
    }


def _build_slide_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build articulated top slide assembly (serrations, ejection port, extractor, 3-dot night sights)."""
    slide_meshes: list[MeshData] = []
    hw_meshes: list[MeshData] = []
    recess_meshes: list[MeshData] = []
    ring_meshes: list[MeshData] = []
    dot_meshes: list[MeshData] = []

    # 1. Main 45-degree chamfered slide body (z = -0.1450 .. +0.0534)
    slide_raw = extrude_shape(
        _SLIDE_CROSS_SECTION,
        depth=0.194,
        bevel_size=0.0011,
        bevel_thickness=0.0022,
        bevel_segments=4,
        uv_scale=6.5,
    )
    slide_meshes.append(transform_mesh(slide_raw, translation=(0.0, 0.0, -0.1428)))

    # 2. Rear slide cover plate + 6 fine horizontal grooves
    hw_meshes.append(
        transform_mesh(create_beveled_box(0.0205, 0.0195, 0.0025, bevel=0.0004), translation=(0.0, 0.0475, 0.0535))
    )
    line_geo = create_box(0.0165, 0.0008, 0.0008)
    for i in range(6):
        recess_meshes.append(transform_mesh(line_geo, translation=(0.0, 0.0405 + i * 0.0026, 0.0548)))

    # 3. Slide serrations (7 rear + 4 front on both left & right sides)
    groove_geo = create_box(0.0012, 0.0178, 0.0017)
    rib_geo = create_beveled_box(0.0009, 0.0178, 0.0019, bevel=0.0002, uv_scale=6.5)
    for z_start, count, spacing in ((0.012, 7, 0.0046), (-0.128, 4, 0.0046)):
        for side in (-1.0, 1.0):
            for i in range(count):
                z = z_start + i * spacing
                recess_meshes.append(transform_mesh(groove_geo, translation=(side * 0.0145, 0.0472, z)))
                slide_meshes.append(transform_mesh(rib_geo, translation=(side * 0.0147, 0.0472, z + spacing * 0.5)))

    # 4. Right-side ejection port cutout + steel extractor claw
    recess_meshes.append(transform_mesh(create_box(0.004, 0.0125, 0.036), translation=(0.0132, 0.0562, -0.034)))
    recess_meshes.append(transform_mesh(create_box(0.016, 0.0025, 0.036), translation=(0.0045, 0.0622, -0.034)))
    extractor_mesh = transform_mesh(
        create_beveled_box(0.0018, 0.0046, 0.018, bevel=0.0003),
        translation=(0.0144, 0.0525, -0.006),
    )

    # 5. Glowing 3-Dot Tritium Night Sights (rear notch + front post facing +Z)
    hw_meshes.append(
        transform_mesh(create_beveled_box(0.0195, 0.0022, 0.0095, bevel=0.0003), translation=(0.0, 0.0638, 0.044))
    )
    ring_cyl = create_cylinder(0.00145, 0.00145, 0.0006, radial_segments=16)
    dot_cyl = create_cylinder(0.00105, 0.00105, 0.0008, radial_segments=16)

    for side in (-1.0, 1.0):
        hw_meshes.append(
            transform_mesh(
                create_beveled_box(0.0064, 0.0056, 0.0092, bevel=0.0004),
                translation=(side * 0.0064, 0.0672, 0.044),
            )
        )
        ring_meshes.append(
            transform_mesh(ring_cyl, translation=(side * 0.0064, 0.0674, 0.0486), rotation=(math.pi * 0.5, 0.0, 0.0))
        )
        dot_meshes.append(
            transform_mesh(dot_cyl, translation=(side * 0.0064, 0.0674, 0.0488), rotation=(math.pi * 0.5, 0.0, 0.0))
        )

    hw_meshes.append(
        transform_mesh(create_beveled_box(0.0036, 0.0062, 0.010, bevel=0.0004), translation=(0.0, 0.0658, -0.135))
    )
    ring_meshes.append(
        transform_mesh(ring_cyl, translation=(0.0, 0.0668, -0.1299), rotation=(math.pi * 0.5, 0.0, 0.0))
    )
    dot_meshes.append(
        transform_mesh(dot_cyl, translation=(0.0, 0.0668, -0.1297), rotation=(math.pi * 0.5, 0.0, 0.0))
    )

    return GLBNode(
        name="pistol_slide",
        children=[
            GLBNode(name="pistol_slide_body", mesh=merge_meshes(slide_meshes), material=mats["slide"]),
            GLBNode(name="pistol_slide_hardware", mesh=merge_meshes(hw_meshes), material=mats["hardware"]),
            GLBNode(name="pistol_slide_recess", mesh=merge_meshes(recess_meshes), material=mats["recess"]),
            GLBNode(name="pistol_slide_extractor", mesh=extractor_mesh, material=mats["steel"]),
            GLBNode(name="pistol_sight_rings", mesh=merge_meshes(ring_meshes), material=mats["sight_ring"]),
            GLBNode(name="pistol_tritium_dots", mesh=merge_meshes(dot_meshes), material=mats["tritium"]),
            GLBNode(
                name="socket_slide",
                translation=(-0.015, 0.048, 0.022),
                rotation_xyz=_socket_euler_xyz(
                    distal=(0.66, 0.06, -0.75),
                    palm_normal=(0.35, -0.90, 0.26),
                    is_right_hand=False,
                ),
            ),
        ],
    )


def _build_barrel_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build fixed outer barrel, muzzle crown, bore hole, steel chamber hood, and recoil guide rod."""
    steel_meshes = [
        transform_mesh(
            create_cylinder(0.0072, 0.0072, 0.146, radial_segments=28),
            translation=(0.0, 0.0495, -0.0745),
            rotation=(math.pi * 0.5, 0.0, 0.0),
        ),
        transform_mesh(create_torus(0.0058, 0.0013, radial_segments=12, tubular_segments=28), translation=(0.0, 0.0495, -0.1475)),
        transform_mesh(
            create_beveled_box(0.0175, 0.0138, 0.0325, bevel=0.0006),
            translation=(0.0045, 0.0562, -0.0345),
        ),
    ]
    bore_mesh = transform_mesh(
        create_cylinder(0.0046, 0.0046, 0.018, radial_segments=20),
        translation=(0.0, 0.0495, -0.139),
        rotation=(math.pi * 0.5, 0.0, 0.0),
    )
    guide_rod_mesh = transform_mesh(
        create_cylinder(0.0041, 0.0041, 0.095, radial_segments=20),
        translation=(0.0, 0.0365, -0.098),
        rotation=(math.pi * 0.5, 0.0, 0.0),
    )

    return GLBNode(
        name="pistol_barrel",
        children=[
            GLBNode(name="pistol_barrel_steel", mesh=merge_meshes(steel_meshes), material=mats["steel"]),
            GLBNode(name="pistol_barrel_bore", mesh=bore_mesh, material=mats["recess"]),
            GLBNode(name="pistol_guide_rod", mesh=guide_rod_mesh, material=mats["hardware"]),
        ],
    )


def _build_frame_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build polymer lower frame, Picatinny rail, 18-deg stippled grip, undercut guard, and hardware."""
    poly_meshes: list[MeshData] = []
    stipple_meshes: list[MeshData] = []
    recess_meshes: list[MeshData] = []
    hw_meshes: list[MeshData] = []
    steel_meshes: list[MeshData] = []

    # 1. Upper frame + curved beavertail tang
    poly_meshes.append(extrude_side_profile(_build_frame_contour(), width=0.0246, bevel=0.0014, uv_scale=6.5))

    # 2. Under-barrel 3-slot Picatinny accessory rail
    poly_meshes.append(
        transform_mesh(create_beveled_box(0.0205, 0.0038, 0.054, bevel=0.0005), translation=(0.0, 0.0176, -0.111))
    )
    slot_geo = create_box(0.0212, 0.0024, 0.0046)
    for i in range(3):
        recess_meshes.append(transform_mesh(slot_geo, translation=(0.0, 0.0166, -0.126 + i * 0.013)))

    # 3. ~18-degree angled ergonomic grip + Gen4/Gen5 pyramid-stippled panels & front strap
    poly_meshes.append(extrude_side_profile(_build_grip_contour(), width=0.0242, bevel=0.0026, uv_scale=6.5))

    grip_tilt = math.radians(17.5)
    side_panel_geo = create_beveled_box(0.0014, 0.086, 0.036, bevel=0.0004, uv_scale=22.0)
    for side in (-1.0, 1.0):
        stipple_meshes.append(
            transform_mesh(side_panel_geo, translation=(side * 0.0144, -0.039, 0.031), rotation=(grip_tilt, 0.0, 0.0))
        )
    stipple_meshes.append(
        transform_mesh(
            create_beveled_box(0.0185, 0.082, 0.0018, bevel=0.0004, uv_scale=22.0),
            translation=(0.0, -0.044, 0.0078),
            rotation=(grip_tilt, 0.0, 0.0),
        )
    )

    # 4. Square undercut Glock trigger guard (watertight beveled outer + inner hole)
    guard_outer, guard_inner = _build_trigger_guard_loops()
    guard_raw = extrude_hollow_profile(
        guard_outer,
        guard_inner,
        depth=0.0115,
        bevel_size=0.0012,
        bevel_thickness=0.0012,
        bevel_segments=3,
        uv_scale=6.5,
    )
    poly_meshes.append(transform_mesh(guard_raw, rotation=(0.0, -math.pi * 0.5, 0.0)))

    # 5. Slide stop lever, takedown lever, 3 steel pins & left magazine release button
    hw_meshes.extend(
        [
            transform_mesh(create_beveled_box(0.0022, 0.0048, 0.021, bevel=0.0003), translation=(-0.0144, 0.0328, -0.016)),
            transform_mesh(create_beveled_box(0.0034, 0.0056, 0.0058, bevel=0.0004), translation=(-0.0151, 0.0322, -0.007)),
            transform_mesh(create_beveled_box(0.0298, 0.0062, 0.0036, bevel=0.0004), translation=(0.0, 0.0285, -0.067)),
            transform_mesh(create_beveled_box(0.0032, 0.0095, 0.0068, bevel=0.0004), translation=(-0.0146, 0.0065, -0.003)),
        ]
    )

    pin_geo = transform_mesh(
        create_cylinder(0.0018, 0.0018, 0.0284, radial_segments=16),
        rotation=(0.0, 0.0, math.pi * 0.5),
    )
    for pz, py in ((-0.038, 0.0315), (-0.035, 0.0245), (0.034, 0.0265)):
        steel_meshes.append(transform_mesh(pin_geo, translation=(0.0, py, pz)))

    return GLBNode(
        name="pistol_frame",
        children=[
            GLBNode(name="pistol_frame_polymer", mesh=merge_meshes(poly_meshes), material=mats["polymer"]),
            GLBNode(name="pistol_frame_stipple", mesh=merge_meshes(stipple_meshes), material=mats["stipple"]),
            GLBNode(name="pistol_frame_recess", mesh=merge_meshes(recess_meshes), material=mats["recess"]),
            GLBNode(name="pistol_frame_hardware", mesh=merge_meshes(hw_meshes), material=mats["hardware"]),
            GLBNode(name="pistol_frame_pins", mesh=merge_meshes(steel_meshes), material=mats["steel"]),
        ],
    )


def _build_trigger_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build articulated Glock trigger shoe & center safety blade around pivot (0, 0.017, -0.036)."""
    shoe_mesh = extrude_side_profile(_build_trigger_contour(), width=0.0058, bevel=0.0006, uv_scale=8.0)
    safety_mesh = transform_mesh(
        create_beveled_box(0.0022, 0.013, 0.0034, bevel=0.0002),
        translation=(0.0, -0.010, -0.0042),
        rotation=(0.25, 0.0, 0.0),
    )
    return GLBNode(
        name="pistol_trigger",
        translation=(0.0, 0.017, -0.036),
        children=[
            GLBNode(name="pistol_trigger_shoe", mesh=shoe_mesh, material=mats["hardware"]),
            GLBNode(name="pistol_safety_blade", mesh=safety_mesh, material=mats["steel"]),
        ],
    )


def _build_magazine_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build detachable 15-round polymer magazine & baseplate aligned with the 17.5-degree grip."""
    mag_meshes = [
        transform_mesh(
            create_beveled_box(0.0205, 0.095, 0.031, bevel=0.0010, uv_scale=6.5),
            translation=(0.0, -0.044, 0.033),
            rotation=(math.radians(17.5), 0.0, 0.0),
        ),
        transform_mesh(
            create_beveled_box(0.0285, 0.0115, 0.052, bevel=0.0012, uv_scale=6.5),
            translation=(0.0, -0.096, 0.0485),
            rotation=(math.radians(8.5), 0.0, 0.0),
        ),
    ]
    return GLBNode(
        name="pistol_mag",
        children=[
            GLBNode(name="pistol_mag_body", mesh=merge_meshes(mag_meshes), material=mats["polymer"]),
            GLBNode(
                name="socket_mag",
                translation=(-0.014, -0.072, 0.040),
                rotation_xyz=_socket_euler_xyz(
                    distal=(0.54, -0.18, -0.82),
                    palm_normal=(0.78, 0.32, 0.54),
                    is_right_hand=False,
                ),
            ),
        ],
    )


def build_pistol_nodes(texture_size: int = 512, seed: int = 42) -> list[GLBNode]:
    """Construct the articulated Tactical Pistol glTF scene graph for Slot 2 & 3rd-person soldiers."""
    mats = _create_materials(texture_size=texture_size, seed=seed)
    root = GLBNode(
        name="pistol_root",
        extras=dict(PISTOL_METADATA),
        children=[
            _build_slide_node(mats),
            _build_barrel_node(mats),
            _build_frame_node(mats),
            _build_trigger_node(mats),
            _build_magazine_node(mats),
            GLBNode(name="pistol_muzzle", translation=tuple(PISTOL_METADATA["muzzlePos"])),  # type: ignore[arg-type]
            # Two-handed thumbs-forward support socket wrapping left side of grip & undercut trigger guard
            GLBNode(
                name="socket_handguard",
                translation=(-0.024, -0.038, 0.024),
                rotation_xyz=_socket_euler_xyz(
                    distal=(-0.16, -0.12, -0.980),
                    palm_normal=(0.90, 0.34, 0.27),
                    is_right_hand=False,
                ),
            ),
            # Firing-hand socket aligned with the 17.5-deg stippled Glock grip
            GLBNode(
                name="socket_grip",
                translation=(0.020, -0.036, 0.056),
                rotation_xyz=_socket_euler_xyz(
                    distal=(0.16, -0.04, -0.986),
                    palm_normal=(-0.96, 0.08, 0.26),
                    is_right_hand=True,
                ),
            ),
        ],
    )
    return [root]
