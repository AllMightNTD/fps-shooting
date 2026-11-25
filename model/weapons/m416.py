"""Detailed HK416 / M416 Tactical PBR 3D model builder matched to the harbor-rain demo."""

from __future__ import annotations

import math

from model.core import (
    GLBMaterial,
    GLBNode,
    MeshData,
    create_beveled_box,
    create_box,
    create_circle,
    create_cylinder,
    create_extruded_tube_frame,
    create_lathe,
    create_plane,
    create_rain_and_metal_textures,
    create_ring,
    extrude_shape,
    merge_meshes,
    transform_mesh,
)

M416_METADATA: dict[str, object] = {
    "weapon": "M416",
    "opticY": 0.097,
    "opticZ": -0.024,
    "magRest": [0.0, -0.042, -0.064],
    "magRestRotX": 0.0,
    "chRestZ": 0.118,
    "muzzlePos": [0.0, 0.020, -0.615],
    "laserOriginPos": [0.046, 0.025, -0.350],
}

# SOPMOD / HK416 angled lower stock profile (XY plane before rotating -90° around Y)
_STOCK_SHAPE: list[tuple[float, float]] = [
    (0.0, 0.014),
    (0.185, 0.016),
    (0.185, -0.092),
    (0.118, -0.092),
    (0.024, -0.024),
]

# Curved 30-round STANAG steel magazine side profile (in Z-Y plane -> extruded along X)
_MAG_PROFILE: list[tuple[float, float]] = [
    (0.032, 0.024),
    (0.031, -0.032),
    (0.024, -0.095),
    (0.011, -0.158),
    (-0.048, -0.168),
    (-0.038, -0.095),
    (-0.032, -0.032),
    (-0.032, 0.024),
]


def _create_materials(texture_size: int = 512, seed: int = 42) -> dict[str, GLBMaterial]:
    tex = create_rain_and_metal_textures(size=texture_size, droplet_count=620, seed=seed)
    return {
        "gunmetal": GLBMaterial(
            name="M416_GunMetal",
            color=0xC2CBD4,
            metalness=0.86,
            roughness=0.38,
            base_color_png=tex.gunmetal_albedo_png,
            metallic_roughness_png=tex.gunmetal_mr_png,
            normal_png=tex.normal_png,
            normal_scale=1.15,
            clearcoat=0.85,
            clearcoat_roughness=0.08,
        ),
        "steel": GLBMaterial(
            name="M416_Steel",
            color=0x58626E,
            metalness=0.95,
            roughness=0.22,
            normal_png=tex.normal_png,
            normal_scale=0.55,
            clearcoat=0.65,
            clearcoat_roughness=0.08,
        ),
        "polymer": GLBMaterial(
            name="M416_Polymer",
            color=0xB2BAC4,
            metalness=0.14,
            roughness=0.58,
            base_color_png=tex.polymer_albedo_png,
            metallic_roughness_png=tex.polymer_mr_png,
            normal_png=tex.normal_png,
            normal_scale=1.25,
            clearcoat=0.80,
            clearcoat_roughness=0.10,
        ),
        "rubber": GLBMaterial(
            name="M416_Rubber",
            color=0x16181A,
            metalness=0.05,
            roughness=0.82,
            clearcoat=0.35,
            clearcoat_roughness=0.25,
        ),
        "glass": GLBMaterial(
            name="M416_HoloGlass",
            color=0x90CEFF,
            metalness=0.10,
            roughness=0.05,
            opacity=0.30,
            transparent=True,
            double_sided=True,
            transmission=0.85,
            ior=1.5,
        ),
        "reticle": GLBMaterial(
            name="M416_HoloReticle",
            color=0xFF2A00,
            metalness=0.0,
            roughness=0.2,
            emissive=0xFF2A00,
            emissive_intensity=2.3,
            double_sided=True,
            unlit=True,
        ),
        "eotech_yellow": GLBMaterial(
            name="M416_EOTechWarning",
            color=0xD8A820,
            metalness=0.10,
            roughness=0.45,
        ),
        "fde": GLBMaterial(
            name="M416_PEQ15_FDE",
            color=0x9C865E,
            metalness=0.08,
            roughness=0.60,
            metallic_roughness_png=tex.polymer_mr_png,
            normal_png=tex.normal_png,
            normal_scale=0.55,
            clearcoat=0.40,
            clearcoat_roughness=0.22,
        ),
        "dark": GLBMaterial(
            name="M416_DarkAccent",
            color=0x0A0B0D,
            metalness=0.20,
            roughness=0.85,
        ),
        "laser_lens": GLBMaterial(
            name="M416_LaserLens",
            color=0x6DFF85,
            metalness=0.0,
            roughness=0.2,
            emissive=0x6DFF85,
            emissive_intensity=2.4,
            unlit=True,
        ),
    }


def _build_eotech_hood_mesh() -> MeshData:
    """Build the characteristic tapered trapezoidal EOTech EXPS3 protective hood."""
    # Rounded-corner trapezoidal arch in XY centered at X=0, Y in [0.020..0.064]
    outer = [
        (-0.025, 0.015),
        (-0.025, 0.024),
        (-0.021, 0.056),
        (-0.015, 0.062),
        (0.015, 0.062),
        (0.021, 0.056),
        (0.025, 0.024),
        (0.025, 0.015),
    ]
    inner = [
        (-0.019, 0.021),
        (-0.019, 0.025),
        (-0.016, 0.052),
        (-0.012, 0.056),
        (0.012, 0.056),
        (0.016, 0.052),
        (0.019, 0.025),
        (0.019, 0.021),
    ]
    return create_extruded_tube_frame(outer, inner, depth=0.060, bevel=0.002)


def _build_static_parts() -> dict[str, list[MeshData]]:
    buckets: dict[str, list[MeshData]] = {
        "gunmetal": [],
        "steel": [],
        "polymer": [],
        "rubber": [],
        "eotech_yellow": [],
        "fde": [],
        "dark": [],
    }
    add_gm = buckets["gunmetal"].append
    add_st = buckets["steel"].append
    add_py = buckets["polymer"].append
    add_rb = buckets["rubber"].append
    add_yl = buckets["eotech_yellow"].append
    add_fde = buckets["fde"].append
    add_dk = buckets["dark"].append

    # --- 1. UPPER RECEIVER (rounded spine + beveled walls + brass deflector + forward assist) ---
    add_gm(transform_mesh(create_beveled_box(0.050, 0.028, 0.240, 0.004), (0.0, 0.014, 0.0)))
    add_gm(
        transform_mesh(
            create_cylinder(0.0245, 0.0245, 0.238, 18),
            (0.0, 0.024, 0.0),
            (math.pi * 0.5, 0.0, 0.0),
        )
    )
    # Ejection port recess + open dust cover + brass deflector (right side)
    add_dk(transform_mesh(create_box(0.006, 0.020, 0.066), (0.0245, 0.023, -0.025)))
    add_gm(transform_mesh(create_beveled_box(0.003, 0.018, 0.066, 0.001), (0.028, 0.009, -0.025), (0.0, 0.0, 0.45)))
    add_gm(transform_mesh(create_beveled_box(0.010, 0.020, 0.018, 0.003), (0.028, 0.022, 0.020)))
    add_gm(transform_mesh(create_cylinder(0.0085, 0.0105, 0.032, 12), (0.028, 0.018, 0.056), (math.pi * 0.5, 0.0, -0.35)))
    add_st(transform_mesh(create_cylinder(0.0075, 0.0075, 0.008, 12), (0.033, 0.018, 0.071), (math.pi * 0.5, 0.0, -0.35)))

    # --- 2. LOWER RECEIVER & LEFT-SIDE CONTROLS (visible in FPP) ---
    add_gm(transform_mesh(create_beveled_box(0.048, 0.044, 0.210, 0.0035), (0.0, -0.017, -0.010)))
    # Flared Magwell & beveled magazine well lip + front horizontal grip grooves
    add_gm(transform_mesh(create_beveled_box(0.052, 0.054, 0.090, 0.0035), (0.0, -0.046, -0.064)))
    add_gm(transform_mesh(create_beveled_box(0.056, 0.012, 0.094, 0.003), (0.0, -0.069, -0.064)))
    for y_rib in (-0.030, -0.039, -0.048, -0.057):
        add_gm(transform_mesh(create_beveled_box(0.044, 0.004, 0.006, 0.001), (0.0, y_rib, -0.109)))

    # Bolt Catch (ping-pong paddle on left receiver), Fire Selector (left & right), Pins & Mag Release
    add_st(transform_mesh(create_beveled_box(0.006, 0.026, 0.014, 0.002), (-0.026, -0.002, -0.032)))
    add_st(transform_mesh(create_beveled_box(0.005, 0.010, 0.008, 0.0015), (-0.027, -0.014, -0.032)))
    add_st(transform_mesh(create_cylinder(0.009, 0.009, 0.056, 14), (0.0, -0.016, 0.048), (0.0, 0.0, math.pi * 0.5)))
    add_st(transform_mesh(create_beveled_box(0.005, 0.007, 0.026, 0.0015), (-0.0275, -0.016, 0.048), (0.45, 0.0, 0.0)))
    add_st(transform_mesh(create_beveled_box(0.005, 0.012, 0.018, 0.002), (0.0265, -0.022, -0.042)))
    pin_geo = create_cylinder(0.0045, 0.0045, 0.054, 12)
    for z_pos in (-0.082, 0.062):
        add_st(transform_mesh(pin_geo, (0.0, -0.024, z_pos), (0.0, 0.0, math.pi * 0.5)))

    # --- 3. HK416 QUAD-RAIL HANDGUARD (core shroud + 4 raised Picatinny rails exposing steel barrel) ---
    # Rotate around Y (cylinder axis) before tilting Y->Z so octagonal shroud aligns cleanly with -Z.
    add_gm(
        transform_mesh(
            create_cylinder(0.020, 0.020, 0.268, 8),
            (0.0, 0.018, -0.260),
            (math.pi * 0.5, math.pi / 8.0, 0.0),
        )
    )
    # Receiver-to-handguard locking lug
    add_st(transform_mesh(create_beveled_box(0.030, 0.016, 0.018, 0.002), (0.0, -0.012, -0.132)))
    # Top Picatinny rail spine + teeth (continuous from receiver to front sight)
    add_gm(transform_mesh(create_box(0.023, 0.008, 0.515), (0.0, 0.048, -0.145)))
    top_tooth = create_beveled_box(0.026, 0.006, 0.007, 0.001, segments=2)
    z = 0.098
    while z >= -0.392 - 1e-6:
        if not ((-0.072 < z < 0.012) or (0.044 < z < 0.088) or (-0.390 < z < -0.358)):
            add_gm(transform_mesh(top_tooth, (0.0, 0.053, z)))
        z -= 0.0135

    # Bottom & Left/Right raised Picatinny rail bars + teeth (open gap around core lets light catch barrel)
    add_gm(transform_mesh(create_box(0.022, 0.008, 0.260), (0.0, -0.010, -0.260)))
    bot_tooth = create_beveled_box(0.025, 0.005, 0.007, 0.001, segments=2)
    for x_side in (-0.024, 0.024):
        add_gm(transform_mesh(create_box(0.007, 0.020, 0.260), (x_side, 0.018, -0.260)))
    side_tooth = create_beveled_box(0.006, 0.022, 0.007, 0.001, segments=2)
    z = -0.140
    while z >= -0.382 - 1e-6:
        add_gm(transform_mesh(bot_tooth, (0.0, -0.015, z)))
        for x_side in (-0.0285, 0.0285):
            add_gm(transform_mesh(side_tooth, (x_side, 0.018, z)))
        z -= 0.0135

    # --- 4. BARREL, GAS BLOCK & LATHE-TURNED BIRDCAGE COMPENSATOR ---
    add_st(transform_mesh(create_cylinder(0.0105, 0.0115, 0.450, 16), (0.0, 0.020, -0.340), (math.pi * 0.5, 0.0, 0.0)))
    add_st(transform_mesh(create_beveled_box(0.024, 0.032, 0.030, 0.003), (0.0, 0.026, -0.415)))
    comp_profile = [
        (0.006, 0.0),
        (0.0135, 0.0),
        (0.0135, 0.006),
        (0.0155, 0.009),
        (0.0155, 0.048),
        (0.0135, 0.055),
        (0.009, 0.058),
        (0.006, 0.058),
        (0.006, 0.002),
    ]
    add_gm(transform_mesh(create_lathe(comp_profile, segments=20), (0.0, 0.020, -0.562), (-math.pi * 0.5, 0.0, 0.0)))
    for z_port in (-0.578, -0.592, -0.606):
        add_dk(transform_mesh(create_box(0.011, 0.004, 0.008), (0.0, 0.0345, z_port)))
        for sx in (-1.0, 1.0):
            add_dk(transform_mesh(create_box(0.004, 0.009, 0.009), (sx * 0.0145, 0.020, z_port)))

    # --- 5. EOTECH EXPS3 (tapered hood, QD mount, yellow warning badge) + FRONT & REAR FLIP SIGHTS ---
    hx, hy, hz = 0.0, 0.056, -0.030
    add_gm(transform_mesh(create_beveled_box(0.036, 0.012, 0.074, 0.002), (hx, hy + 0.006, hz)))
    add_py(transform_mesh(_build_eotech_hood_mesh(), (hx, hy, hz + 0.006)))
    # Battery cap & forward housing seated cleanly below optical window
    add_py(transform_mesh(create_beveled_box(0.038, 0.016, 0.032, 0.003), (hx, hy + 0.015, hz - 0.026)))
    add_st(transform_mesh(create_cylinder(0.007, 0.007, 0.010, 12), (hx + 0.020, hy + 0.016, hz - 0.028), (math.pi * 0.5, 0.0, 0.0)))
    # Left-side QD lever & signature yellow EOTech badge
    add_st(transform_mesh(create_beveled_box(0.006, 0.008, 0.022, 0.0015), (hx - 0.021, hy + 0.007, hz + 0.008)))
    add_yl(transform_mesh(create_box(0.002, 0.0055, 0.013), (hx - 0.0235, hy + 0.020, hz + 0.006)))

    # Rear Flip-up Iron Sight (z=0.066) & Front Flip-up Sight (z=-0.375)
    add_gm(transform_mesh(create_beveled_box(0.034, 0.012, 0.040, 0.002), (0.0, 0.061, 0.066)))
    for sx in (-1.0, 1.0):
        add_gm(transform_mesh(create_beveled_box(0.006, 0.013, 0.018, 0.0015), (sx * 0.011, 0.070, 0.073)))
    add_st(transform_mesh(create_cylinder(0.0045, 0.0045, 0.010, 12), (0.019, 0.063, 0.068), (0.0, 0.0, math.pi * 0.5)))

    add_py(transform_mesh(create_beveled_box(0.028, 0.012, 0.032, 0.002), (0.0, 0.061, -0.374)))
    for sx in (-1.0, 1.0):
        add_py(transform_mesh(create_beveled_box(0.0045, 0.011, 0.014, 0.001), (sx * 0.009, 0.069, -0.378)))
    add_st(transform_mesh(create_cylinder(0.002, 0.002, 0.010, 8), (0.0, 0.069, -0.378)))

    # --- 6. BUFFER TUBE, CASTLE NUT & HK416 / SOPMOD CONTOURED STOCK ---
    add_gm(transform_mesh(create_cylinder(0.017, 0.017, 0.140, 20), (0.0, 0.020, 0.180), (math.pi * 0.5, 0.0, 0.0)))
    add_st(transform_mesh(create_cylinder(0.0215, 0.0215, 0.015, 16), (0.0, 0.020, 0.125), (math.pi * 0.5, 0.0, 0.0)))
    add_gm(transform_mesh(create_beveled_box(0.044, 0.044, 0.006, 0.002), (0.0, 0.016, 0.118)))

    # Contoured cylindrical upper stock sleeve + flared SOPMOD cheek welds + lower body + grooved rubber buttpad
    add_py(transform_mesh(create_cylinder(0.0245, 0.0245, 0.188, 22), (0.0, 0.021, 0.274), (math.pi * 0.5, 0.0, 0.0)))
    for sx in (-1.0, 1.0):
        add_py(
            transform_mesh(
                create_beveled_box(0.018, 0.036, 0.178, 0.006),
                (sx * 0.016, 0.006, 0.274),
                (0.0, 0.0, sx * -0.24),
            )
        )
    stock_raw = extrude_shape(_STOCK_SHAPE, depth=0.034, bevel_size=0.004, bevel_thickness=0.004, bevel_segments=3)
    add_py(transform_mesh(stock_raw, (0.017, 0.018, 0.182), (0.0, -math.pi * 0.5, 0.0)))
    # Adjustment latch under stock & textured rubber buttpad
    add_st(transform_mesh(create_beveled_box(0.014, 0.014, 0.052, 0.002), (0.0, -0.026, 0.275), (0.48, 0.0, 0.0)))
    add_rb(transform_mesh(create_beveled_box(0.046, 0.124, 0.016, 0.005), (0.0, -0.016, 0.371)))

    # --- 7. PISTOL GRIP & TRIGGER GUARD ---
    add_py(transform_mesh(create_beveled_box(0.033, 0.112, 0.048, 0.005), (0.0, -0.080, 0.068), (0.34, 0.0, 0.0)))
    add_py(transform_mesh(create_beveled_box(0.034, 0.012, 0.050, 0.004), (0.0, -0.132, 0.088), (0.28, 0.0, 0.0)))
    add_gm(transform_mesh(create_beveled_box(0.013, 0.005, 0.056, 0.0015), (0.0, -0.054, 0.012)))

    # --- 8. AN/PEQ-15 TACTICAL LASER MODULE (on right handguard rail) ---
    add_fde(transform_mesh(create_beveled_box(0.014, 0.018, 0.034, 0.002), (0.036, 0.018, -0.310)))
    add_fde(transform_mesh(create_beveled_box(0.022, 0.028, 0.066, 0.004), (0.046, 0.019, -0.312)))
    add_dk(transform_mesh(create_cylinder(0.0048, 0.0048, 0.004, 14), (0.046, 0.025, -0.346), (math.pi * 0.5, 0.0, 0.0)))
    add_dk(transform_mesh(create_cylinder(0.0036, 0.0036, 0.004, 14), (0.046, 0.013, -0.346), (math.pi * 0.5, 0.0, 0.0)))
    add_dk(transform_mesh(create_cylinder(0.0052, 0.0052, 0.010, 14), (0.046, 0.019, -0.276), (math.pi * 0.5, 0.0, 0.0)))
    add_dk(transform_mesh(create_beveled_box(0.008, 0.004, 0.012, 0.001), (0.046, 0.034, -0.304)))

    return buckets


def _build_magazine_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build a gently curved 30-round STANAG steel magazine with smooth curved stamped ribs."""
    mag_body = transform_mesh(
        extrude_shape(_MAG_PROFILE, depth=0.024, bevel_size=0.0025, bevel_thickness=0.0025, bevel_segments=3),
        (-0.012, 0.0, 0.0),
        (0.0, -math.pi * 0.5, 0.0),
    )
    # Two continuous curved stamped ribs conforming strictly to the curved magazine contour
    rib_front = [
        (0.020, -0.020),
        (0.015, -0.095),
        (-0.002, -0.156),
        (-0.014, -0.158),
        (0.003, -0.095),
        (0.008, -0.020),
    ]
    rib_rear = [
        (-0.006, -0.020),
        (-0.012, -0.095),
        (-0.028, -0.160),
        (-0.040, -0.162),
        (-0.024, -0.095),
        (-0.018, -0.020),
    ]
    ribs = [
        transform_mesh(
            extrude_shape(prof, depth=0.029, bevel_size=0.001, bevel_thickness=0.001, bevel_segments=2),
            (-0.0145, 0.0, 0.0),
            (0.0, -math.pi * 0.5, 0.0),
        )
        for prof in (rib_front, rib_rear)
    ]
    mag_metal = merge_meshes([mag_body, *ribs])
    mag_base = transform_mesh(create_beveled_box(0.031, 0.010, 0.068, 0.0015), (0.0, -0.168, -0.018), (-0.28, 0.0, 0.0))

    return GLBNode(
        name="mag_group",
        translation=(0.0, -0.042, -0.064),
        children=[
            GLBNode(name="mag_body", mesh=mag_metal, material=mats["gunmetal"]),
            GLBNode(name="mag_base", mesh=mag_base, material=mats["steel"]),
        ],
    )


def _build_charging_handle_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    shaft = transform_mesh(create_beveled_box(0.015, 0.007, 0.052, 0.0015), (0.0, 0.0, -0.012))
    latch_bar = transform_mesh(create_beveled_box(0.054, 0.009, 0.014, 0.002), (0.0, 0.0, 0.014))
    latch_tab = transform_mesh(create_beveled_box(0.014, 0.008, 0.015, 0.002), (-0.029, 0.0, 0.013))
    ch_mesh = merge_meshes([shaft, latch_bar, latch_tab])
    return GLBNode(
        name="charging_handle",
        mesh=ch_mesh,
        material=mats["gunmetal"],
        translation=(0.0, 0.039, 0.118),
    )


def build_m416_nodes(texture_size: int = 512, seed: int = 42) -> list[GLBNode]:
    """Assemble the upgraded HK416/M416 scene graph with named dynamic sub-nodes."""
    mats = _create_materials(texture_size=texture_size, seed=seed)
    static_buckets = _build_static_parts()

    children: list[GLBNode] = []
    for bucket_name, meshes in static_buckets.items():
        if meshes:
            children.append(
                GLBNode(
                    name=f"m416_static_{bucket_name}",
                    mesh=merge_meshes(meshes),
                    material=mats[bucket_name],
                )
            )

    children.append(
        GLBNode(
            name="holo_lens",
            mesh=create_plane(0.035, 0.033),
            material=mats["glass"],
            translation=(0.0, 0.097, -0.025),
        )
    )
    reticle_mesh = merge_meshes(
        [
            create_ring(0.0044, 0.0056, 24),
            create_circle(0.0012, 12),
        ]
    )
    children.append(
        GLBNode(
            name="reticle_group",
            mesh=reticle_mesh,
            material=mats["reticle"],
            translation=(0.0, 0.097, -0.024),
        )
    )
    children.append(
        GLBNode(
            name="trigger_group",
            translation=(0.0, -0.030, 0.012),
            children=[
                GLBNode(
                    name="trigger_blade",
                    mesh=transform_mesh(create_box(0.004, 0.022, 0.006), (0.0, -0.011, 0.003), (-0.3, 0.0, 0.0)),
                    material=mats["steel"],
                )
            ],
        )
    )
    children.append(
        GLBNode(
            name="bolt_vis",
            mesh=create_beveled_box(0.003, 0.016, 0.058, 0.0008),
            material=mats["steel"],
            translation=(0.0262, 0.023, -0.025),
        )
    )
    children.append(_build_charging_handle_node(mats))
    children.append(_build_magazine_node(mats))
    children.append(
        GLBNode(
            name="laser_lens",
            mesh=create_circle(0.0030, 16),
            material=mats["laser_lens"],
            translation=(0.046, 0.025, -0.3482),
            rotation_xyz=(0.0, math.pi, 0.0),
        )
    )
    children.append(GLBNode(name="laser_origin", translation=(0.046, 0.025, -0.350)))
    children.append(GLBNode(name="muzzle_anchor", translation=(0.0, 0.020, -0.615)))

    return [
        GLBNode(
            name="m416_root",
            children=children,
            extras=dict(M416_METADATA),
        )
    ]
