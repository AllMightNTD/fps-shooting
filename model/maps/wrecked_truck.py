"""Procedural wrecked military cargo truck (2.3m x 6.2m x 2.7m) matching reference PBR."""

from __future__ import annotations

import math

from model.core import (
    GLBMaterial,
    GLBNode,
    MeshData,
    create_beveled_box,
    create_box,
    create_cylinder,
    create_tube_along_curve,
    merge_meshes,
    transform_mesh,
)

from .textures import MilitaryMapTextures, build_military_textures


def _make_wheel(radius: float = 0.46, width: float = 0.27) -> tuple[MeshData, MeshData]:
    """Build a tire + steel hub centered at origin with axle along X."""
    tire = transform_mesh(
        create_cylinder(radius, radius, width, radial_segments=16, uv_scale=0.8),
        rotation=(0.0, 0.0, math.pi * 0.5),
    )
    hub = transform_mesh(
        create_cylinder(radius * 0.52, radius * 0.52, width + 0.02, radial_segments=12, uv_scale=1.0),
        rotation=(0.0, 0.0, math.pi * 0.5),
    )
    return tire, hub


def build_wrecked_truck_nodes(textures: MilitaryMapTextures | None = None) -> list[GLBNode]:
    """Build 2.3m x 6.2m x 2.7m wrecked truck (front -Z, glassless cab, popped hood, loose front-left tire)."""
    tex = textures or build_military_textures()

    mat_olive = GLBMaterial(
        name="Truck_OliveBody",
        color=0xFFFFFF,
        metalness=0.22,
        roughness=0.74,
        base_color_png=tex.olive_albedo,
        metallic_roughness_png=tex.olive_mr,
    )
    mat_chassis = GLBMaterial(
        name="Truck_SteelChassis",
        color=0xFFFFFF,
        metalness=0.70,
        roughness=0.60,
        base_color_png=tex.steel_albedo,
        metallic_roughness_png=tex.steel_mr,
        normal_png=tex.steel_normal,
    )
    mat_rubber = GLBMaterial(
        name="Truck_RubberTire",
        color=0xFFFFFF,
        metalness=0.02,
        roughness=0.88,
        base_color_png=tex.rubber_albedo,
    )

    olive_parts: list[MeshData] = []
    chassis_parts: list[MeshData] = []
    tire_parts: list[MeshData] = []

    # Mounted tires (missing front-left!) + 1 detached tire lying flat on y = 0
    mounted_locs = [
        (0.95, 0.46, -2.02),
        (-0.95, 0.46, 0.98),
        (0.95, 0.46, 0.98),
        (-0.95, 0.46, 2.08),
        (0.95, 0.46, 2.08),
    ]
    for wx, wy, wz in mounted_locs:
        t_mesh, h_mesh = _make_wheel()
        tire_parts.append(transform_mesh(t_mesh, translation=(wx, wy, wz)))
        chassis_parts.append(transform_mesh(h_mesh, translation=(wx, wy, wz)))

    # Exposed front-left brake hub & suspension strut
    chassis_parts.append(
        transform_mesh(
            create_cylinder(0.22, 0.22, 0.14, radial_segments=12),
            translation=(-0.92, 0.36, -2.02),
            rotation=(0.0, 0.0, math.pi * 0.5),
        )
    )
    # Detached front-left tire lying flat on ground beside hub (y in [0.0, 0.27])
    flat_tire = transform_mesh(
        create_cylinder(0.46, 0.46, 0.27, radial_segments=16, uv_scale=0.8),
        translation=(-0.95, 0.135, -2.18),
    )
    flat_hub = transform_mesh(
        create_cylinder(0.24, 0.24, 0.28, radial_segments=12, uv_scale=1.0),
        translation=(-0.95, 0.14, -2.18),
    )
    tire_parts.append(flat_tire)
    chassis_parts.append(flat_hub)

    # Slightly tilted body assembly (-2.4 deg roll toward missing front-left wheel)
    tilt_parts_olive: list[MeshData] = []
    tilt_parts_chassis: list[MeshData] = []

    # Chassis longitudinal frame rails, front bumper, fuel tank, engine block
    for sx in (-0.42, 0.42):
        tilt_parts_chassis.append(transform_mesh(create_box(0.14, 0.20, 5.95, uv_scale=0.5), translation=(sx, 0.62, 0.02)))
    tilt_parts_chassis.append(transform_mesh(create_box(2.14, 0.22, 0.18, uv_scale=0.6), translation=(0.0, 0.62, -3.00)))
    # Exposed engine block under popped hood
    tilt_parts_chassis.append(transform_mesh(create_box(0.76, 0.48, 0.92, uv_scale=0.6), translation=(0.0, 0.96, -2.28)))
    # Radiator grille
    tilt_parts_olive.append(transform_mesh(create_box(1.42, 0.62, 0.12, uv_scale=0.6), translation=(0.0, 1.00, -2.92)))
    for gx in (-0.45, -0.27, -0.09, 0.09, 0.27, 0.45):
        tilt_parts_chassis.append(transform_mesh(create_box(0.05, 0.50, 0.15, uv_scale=0.8), translation=(gx, 1.00, -2.94)))
    # Left & Right front fenders
    for sx in (-0.86, 0.86):
        tilt_parts_olive.append(transform_mesh(create_beveled_box(0.42, 0.24, 1.32, bevel=0.03, segments=1, uv_scale=0.6), translation=(sx, 1.04, -2.22)))
    # Fuel tank & step plates
    tilt_parts_olive.append(transform_mesh(create_box(0.38, 0.34, 0.96, uv_scale=0.6), translation=(-0.86, 0.68, 0.02)))
    tilt_parts_olive.append(transform_mesh(create_box(0.38, 0.34, 0.96, uv_scale=0.6), translation=(0.86, 0.68, 0.02)))

    # Popped open tilted hood (crouch cover height y ~ 1.35m)
    tilt_parts_olive.append(
        transform_mesh(
            create_beveled_box(1.38, 0.08, 1.36, bevel=0.02, segments=1, uv_scale=0.6),
            translation=(0.0, 1.38, -2.26),
            rotation=(0.20, 0.0, 0.0),
        )
    )

    # Cab lower bulkhead, dash, and doors (y in [0.76, 1.48], z in [-1.52, -0.14])
    tilt_parts_olive.append(transform_mesh(create_box(1.94, 0.68, 0.14, uv_scale=0.6), translation=(0.0, 1.12, -1.46)))
    tilt_parts_olive.append(transform_mesh(create_box(1.94, 0.68, 0.14, uv_scale=0.6), translation=(0.0, 1.12, -0.20)))
    tilt_parts_olive.append(transform_mesh(create_box(1.94, 0.14, 1.32, uv_scale=0.5), translation=(0.0, 0.78, -0.83)))
    # Right door closed; left driver door ajar
    tilt_parts_olive.append(transform_mesh(create_box(0.10, 0.70, 1.12, uv_scale=0.6), translation=(0.94, 1.13, -0.83)))
    tilt_parts_olive.append(
        transform_mesh(
            create_box(0.10, 0.70, 1.12, uv_scale=0.6),
            translation=(-1.04, 1.12, -0.85),
            rotation=(0.0, -0.34, 0.0),
        )
    )
    # Cab interior bench seat
    tilt_parts_chassis.append(transform_mesh(create_box(1.56, 0.24, 0.55, uv_scale=0.7), translation=(0.0, 0.96, -0.60)))

    # Slender A/B cab pillars leaving open glassless windows (y in [1.48, 2.20])
    for sx in (-0.92, 0.92):
        tilt_parts_olive.append(transform_mesh(create_box(0.09, 0.74, 0.09, uv_scale=0.7), translation=(sx, 1.84, -1.45)))
        tilt_parts_olive.append(transform_mesh(create_box(0.09, 0.74, 0.12, uv_scale=0.7), translation=(sx, 1.84, -0.20)))
    # Center windshield divider
    tilt_parts_olive.append(transform_mesh(create_box(0.06, 0.72, 0.07, uv_scale=0.7), translation=(0.0, 1.84, -1.46)))
    # Cab roof
    tilt_parts_olive.append(transform_mesh(create_beveled_box(1.96, 0.12, 1.38, bevel=0.03, segments=1, uv_scale=0.5), translation=(0.0, 2.26, -0.82)))

    # Rear cargo bed (z in [0.02, 3.00], floor y = 0.88, side rails y = 0.88..1.54)
    tilt_parts_olive.append(transform_mesh(create_box(2.14, 0.12, 2.98, uv_scale=0.45), translation=(0.0, 0.88, 1.50)))
    for sx in (-1.02, 1.02):
        tilt_parts_olive.append(transform_mesh(create_box(0.10, 0.62, 2.98, uv_scale=0.5), translation=(sx, 1.24, 1.50)))
    # Front bed bulkhead & lowered tailgate
    tilt_parts_olive.append(transform_mesh(create_box(2.10, 0.62, 0.10, uv_scale=0.5), translation=(0.0, 1.24, 0.06)))
    tilt_parts_olive.append(
        transform_mesh(
            create_box(2.08, 0.56, 0.09, uv_scale=0.5),
            translation=(0.0, 0.78, 3.08),
            rotation=(1.32, 0.0, 0.0),
        )
    )

    # 3 Curved steel canopy bow hoops arching over rear cargo bed (y up to 2.65m)
    for hz in (0.18, 1.50, 2.84):
        pts = [
            (-1.00, 1.52, hz),
            (-0.98, 2.34, hz),
            (-0.55, 2.64, hz),
            (0.0, 2.68, hz),
            (0.55, 2.64, hz),
            (0.98, 2.34, hz),
            (1.00, 1.52, hz),
        ]
        hoop = create_tube_along_curve(pts, radius=0.024, tubular_segments=14, radial_segments=6)
        tilt_parts_chassis.append(hoop)

    # Exhaust stack behind cab & rusted step plate
    tilt_parts_chassis.append(
        transform_mesh(
            create_cylinder(0.045, 0.045, 1.65, radial_segments=8, uv_scale=0.8),
            translation=(0.96, 1.85, -0.08),
        )
    )
    tilt_parts_chassis.append(transform_mesh(create_box(0.32, 0.06, 0.70, uv_scale=0.7), translation=(-0.98, 0.52, -0.82)))
    tilt_parts_chassis.append(transform_mesh(create_box(0.32, 0.06, 0.70, uv_scale=0.7), translation=(0.98, 0.52, -0.82)))

    # Apply subtle wrecked list (-0.042 rad roll around Z) to body + chassis
    roll_rot = (0.0, 0.0, 0.042)
    olive_parts.append(transform_mesh(merge_meshes(tilt_parts_olive), translation=(0.0, 0.02, 0.0), rotation=roll_rot))
    chassis_parts.append(transform_mesh(merge_meshes(tilt_parts_chassis), translation=(0.0, 0.02, 0.0), rotation=roll_rot))

    return [
        GLBNode(
            name="wrecked_truck_root",
            children=[
                GLBNode(name="truck_olive_body", mesh=merge_meshes(olive_parts), material=mat_olive),
                GLBNode(name="truck_chassis", mesh=merge_meshes(chassis_parts), material=mat_chassis),
                GLBNode(name="truck_tires", mesh=merge_meshes(tire_parts), material=mat_rubber),
            ],
        )
    ]

