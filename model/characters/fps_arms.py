"""Detailed PBR first-person arms, fingerless tactical gloves, and military watch builder."""

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
    create_capsule,
    create_circle,
    create_cylinder,
    create_glove_textures,
    create_realistic_skin_textures,
    create_torus,
    create_tube_along_curve,
    merge_meshes,
    transform_mesh,
)

# Rig coordinates shared with FPS.html so reload/trigger animations align cleanly with M416.
_LEFT_ELBOW: tuple[float, float, float] = (-0.30, -0.30, 0.22)
_RIGHT_ELBOW: tuple[float, float, float] = (0.17, -0.28, 0.48)


def _basis_euler_xyz(y_axis: Sequence[float], z_axis: Sequence[float]) -> tuple[float, float, float]:
    """Compute intrinsic XYZ Euler angles from desired local +Y and +Z directions."""
    y = np.asarray(y_axis, dtype=np.float64)
    y /= np.linalg.norm(y)
    z = np.asarray(z_axis, dtype=np.float64)
    z = z - y * float(np.dot(z, y))
    z /= np.linalg.norm(z)
    x = np.cross(y, z)
    x /= np.linalg.norm(x)
    mat = np.column_stack((x, y, z))

    # Extract XYZ Euler angles from rotation matrix R = Rx(rx) @ Ry(ry) @ Rz(rz)
    sy = max(-1.0, min(1.0, float(mat[0, 2])))
    ry = math.asin(sy)
    if abs(mat[0, 2]) < 0.99999:
        rx = math.atan2(-mat[1, 2], mat[2, 2])
        rz = math.atan2(-mat[0, 1], mat[0, 0])
    else:
        rx = math.atan2(mat[2, 1], mat[1, 1])
        rz = 0.0
    return (round(rx, 6), round(ry, 6), round(rz, 6))


def _rot_xyz(rx: float, ry: float, rz: float) -> np.ndarray:
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    mx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    return mx @ my @ mz


def _mat4_to_euler_xyz(mat3: np.ndarray) -> tuple[float, float, float]:
    sy = max(-1.0, min(1.0, float(mat3[0, 2])))
    ry = math.asin(sy)
    if abs(mat3[0, 2]) < 0.99999:
        rx = math.atan2(-mat3[1, 2], mat3[2, 2])
        rz = math.atan2(-mat3[0, 1], mat3[0, 0])
    else:
        rx = math.atan2(mat3[2, 1], mat3[1, 1])
        rz = 0.0
    return (round(rx, 6), round(ry, 6), round(rz, 6))


def _transform_mesh_mat4(mesh: MeshData, mat4: np.ndarray) -> MeshData:
    rot = mat4[:3, :3]
    trans = mat4[:3, 3]
    new_pos = (mesh.positions.astype(np.float64) @ rot.T) + trans
    norm_mat = np.linalg.inv(rot).T
    new_norm = mesh.normals.astype(np.float64) @ norm_mat.T
    nl = np.linalg.norm(new_norm, axis=1, keepdims=True)
    new_norm = new_norm / np.where(nl > 1e-12, nl, 1.0)
    return MeshData(
        positions=new_pos.astype(np.float32),
        normals=new_norm.astype(np.float32),
        uvs=mesh.uvs.copy(),
        indices=mesh.indices.copy(),
    )


def _make_mat4(
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> np.ndarray:
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = _rot_xyz(*rotation)
    m[:3, 3] = np.asarray(translation, dtype=np.float64)
    return m


# Left hand poses aligned cleanly around M416 handguard, curved STANAG mag, and charging handle.
_LEFT_GRIP_POS = (-0.042, -0.022, -0.236)
_LEFT_GRIP_ROT = _basis_euler_xyz(y_axis=(-0.48, -0.26, 0.84), z_axis=(-0.82, 0.44, -0.36))

_LEFT_MAG_POS = (-0.044, -0.118, -0.078)
_LEFT_MAG_ROT = _basis_euler_xyz(y_axis=(-0.78, -0.18, 0.60), z_axis=(-0.55, 0.35, -0.76))

_LEFT_CH_POS = (-0.064, 0.032, 0.122)
_LEFT_CH_ROT = _basis_euler_xyz(y_axis=(-0.80, -0.44, 0.40), z_axis=(-0.28, 0.76, 0.58))

_RIGHT_GRIP_POS = (0.012, -0.070, 0.068)
_RIGHT_GRIP_ROT = (0.34, 0.10, 0.14)

FPS_ARMS_METADATA: dict[str, object] = {
    "character": "FPS_Arms_Tactical",
    "leftElbow": list(_LEFT_ELBOW),
    "rightElbow": list(_RIGHT_ELBOW),
    "leftWristLocal": [0.0, 0.042, 0.0],
    "rightWristLocal": [0.008, -0.036, 0.024],
    "poses": {
        "grip": {"p": list(_LEFT_GRIP_POS), "r": list(_LEFT_GRIP_ROT)},
        "mag": {"p": list(_LEFT_MAG_POS), "r": list(_LEFT_MAG_ROT)},
        "out": {"p": [-0.088, -0.182, -0.042], "r": list(_LEFT_MAG_ROT)},
        "ch": {"p": list(_LEFT_CH_POS), "r": list(_LEFT_CH_ROT)},
        "chPulled": {"p": [_LEFT_CH_POS[0], _LEFT_CH_POS[1], _LEFT_CH_POS[2] + 0.055], "r": list(_LEFT_CH_ROT)},
        "rightGrip": {"p": list(_RIGHT_GRIP_POS), "r": list(_RIGHT_GRIP_ROT)},
    },
    "indexBaseRotX": -math.pi * 0.5 + 0.10,
}


def _create_materials(skin_size: int = 512, glove_size: int = 256, seed: int = 42) -> dict[str, GLBMaterial]:
    skin_tex = create_realistic_skin_textures(size=skin_size, pore_count=4000, droplet_count=180, seed=seed)
    glove_tex = create_glove_textures(size=glove_size, seed=seed + 100)

    return {
        "skin": GLBMaterial(
            name="Arms_WetSkin",
            color=0xFFFFFF,
            metalness=0.0,
            roughness=0.52,
            base_color_png=skin_tex.albedo_png,
            metallic_roughness_png=skin_tex.mr_png,
            normal_png=skin_tex.normal_png,
            normal_scale=0.65,
            clearcoat=0.45,
            clearcoat_roughness=0.22,
            sheen_color=0xFFD2B8,
            sheen_roughness=0.60,
        ),
        "nail": GLBMaterial(
            name="Arms_Fingernail",
            color=0xC28D78,
            metalness=0.0,
            roughness=0.30,
            clearcoat=0.35,
            clearcoat_roughness=0.20,
        ),
        "glove": GLBMaterial(
            name="Arms_TacticalGlove",
            color=0xFFFFFF,
            metalness=0.05,
            roughness=0.85,
            base_color_png=glove_tex.glove_albedo_png,
            metallic_roughness_png=glove_tex.glove_mr_png,
            normal_png=glove_tex.glove_normal_png,
            normal_scale=0.85,
            sheen_color=0x6E7562,
            sheen_roughness=0.75,
        ),
        "knuckle": GLBMaterial(
            name="Arms_KnuckleGuard",
            color=0x1D201B,
            metalness=0.30,
            roughness=0.45,
            clearcoat=0.35,
            clearcoat_roughness=0.25,
        ),
        "camo": GLBMaterial(
            name="Arms_CamoSleeve",
            color=0xFFFFFF,
            metalness=0.0,
            roughness=0.90,
            double_sided=True,
            base_color_png=glove_tex.camo_albedo_png,
        ),
        "watch_strap": GLBMaterial(
            name="Arms_WatchStrap",
            color=0x181A18,
            metalness=0.0,
            roughness=0.82,
        ),
        "watch_case": GLBMaterial(
            name="Arms_WatchCase",
            color=0x222629,
            metalness=0.90,
            roughness=0.25,
            clearcoat=0.80,
            clearcoat_roughness=0.12,
        ),
        "watch_dial": GLBMaterial(
            name="Arms_WatchDial",
            color=0xFFFFFF,
            metalness=0.10,
            roughness=0.22,
            base_color_png=glove_tex.watch_dial_png,
        ),
    }


def _append_finger_meshes(
    root_mat: np.ndarray,
    lengths: Sequence[float],
    radius: float,
    curl_angles: Sequence[float],
    glove_parts: list[MeshData],
    skin_parts: list[MeshData],
    nail_parts: list[MeshData],
) -> None:
    """Build articulated multi-segment fingerless glove digit transformed by ``root_mat``."""
    cur_mat = root_mat.copy()
    n_seg = len(lengths)

    for idx, seg_len in enumerate(lengths):
        curl = curl_angles[idx] if idx < len(curl_angles) else 0.0
        cur_mat = cur_mat @ _make_mat4((0.0, 0.0, 0.0), (curl, 0.0, 0.0))

        is_gloved = idx < n_seg - 1
        r_top = radius * (1.0 - idx * 0.12)
        r_bot = radius * (1.0 - (idx + 1) * 0.12)
        cap = create_capsule(r_top, r_bot, seg_len, cap_segments=5, radial_segments=12)
        seg_mat = cur_mat @ _make_mat4((0.0, -seg_len * 0.5, 0.0))
        seg_mesh = _transform_mesh_mat4(cap, seg_mat)
        (glove_parts if is_gloved else skin_parts).append(seg_mesh)

        # Stitched cuff ring at the fingerless cut line
        if idx == n_seg - 2:
            cuff = create_torus(r_bot * 1.05, 0.0014, radial_segments=8, tubular_segments=16)
            cuff_mat = cur_mat @ _make_mat4((0.0, -seg_len, 0.0), (math.pi * 0.5, 0.0, 0.0))
            glove_parts.append(_transform_mesh_mat4(cuff, cuff_mat))

        # Subtle fingernail on exposed fingertip
        if idx == n_seg - 1:
            nail_geo = transform_mesh(create_box(r_bot * 1.15, seg_len * 0.52, 0.0022), (0.0, -seg_len * 0.72, r_bot * 0.85))
            nail_parts.append(_transform_mesh_mat4(nail_geo, cur_mat))

        cur_mat = cur_mat @ _make_mat4((0.0, -seg_len, 0.0))


def _build_left_hand_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    glove_parts: list[MeshData] = []
    skin_parts: list[MeshData] = []
    nail_parts: list[MeshData] = []

    # Palm + wrist cuff + carbon knuckle guard
    glove_parts.append(create_beveled_box(0.072, 0.078, 0.026, bevel=0.006))
    glove_parts.append(transform_mesh(create_beveled_box(0.064, 0.018, 0.028, bevel=0.004), (0.0, 0.040, 0.0)))
    knuckle = transform_mesh(create_beveled_box(0.068, 0.016, 0.012, bevel=0.003), (0.0, -0.025, 0.014))

    # Four fingers wrapping from beneath handguard up along the right side
    for x_off in (-0.026, -0.009, 0.008, 0.025):
        _append_finger_meshes(
            _make_mat4((x_off, -0.036, 0.0)),
            lengths=(0.028, 0.022, 0.018),
            radius=0.0085,
            curl_angles=(0.78, 0.88, 0.62),
            glove_parts=glove_parts,
            skin_parts=skin_parts,
            nail_parts=nail_parts,
        )

    # C-clamp left thumb resting forward/inward along the upper-left handguard rail
    thumb_mat = _make_mat4((-0.032, -0.018, 0.008), (-0.1228, -0.2075, 0.1916))
    _append_finger_meshes(
        thumb_mat,
        lengths=(0.025, 0.020),
        radius=0.0092,
        curl_angles=(0.18, 0.26),
        glove_parts=glove_parts,
        skin_parts=skin_parts,
        nail_parts=nail_parts,
    )

    return GLBNode(
        name="left_hand_group",
        translation=_LEFT_GRIP_POS,
        rotation_xyz=_LEFT_GRIP_ROT,
        children=[
            GLBNode(name="left_hand_glove", mesh=merge_meshes(glove_parts), material=mats["glove"]),
            GLBNode(name="left_hand_knuckle", mesh=knuckle, material=mats["knuckle"]),
            GLBNode(name="left_hand_skin", mesh=merge_meshes(skin_parts), material=mats["skin"]),
            GLBNode(name="left_hand_nails", mesh=merge_meshes(nail_parts), material=mats["nail"]),
            GLBNode(name="left_wrist_anchor", translation=(0.0, 0.042, 0.0)),
        ],
    )


def _build_right_hand_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    glove_parts: list[MeshData] = []
    skin_parts: list[MeshData] = []
    nail_parts: list[MeshData] = []

    # Palm + wrist glove cuff + knuckle protector
    glove_parts.append(transform_mesh(create_beveled_box(0.040, 0.080, 0.072, bevel=0.007), (0.014, 0.0, 0.0)))
    glove_parts.append(transform_mesh(create_beveled_box(0.042, 0.068, 0.022, bevel=0.005), (0.012, -0.010, 0.038)))
    knuckle = transform_mesh(create_beveled_box(0.012, 0.074, 0.018, bevel=0.003), (0.035, 0.0, -0.024))

    # Middle, ring, and pinky fingers gripping firmly around pistol grip
    for y_off in (0.008, -0.011, -0.029):
        _append_finger_meshes(
            _make_mat4((0.015, y_off, -0.030), (0.0, 0.0, math.pi * 0.5 + 0.14)),
            lengths=(0.025, 0.019, 0.015),
            radius=0.0082,
            curl_angles=(1.28, 1.38, 1.02),
            glove_parts=glove_parts,
            skin_parts=skin_parts,
            nail_parts=nail_parts,
        )

    # Right thumb wrapping around left-back neck of pistol grip
    _append_finger_meshes(
        _make_mat4((-0.012, 0.022, -0.014), (-0.50, 0.0, -1.10)),
        lengths=(0.026, 0.020),
        radius=0.0095,
        curl_angles=(0.60, 0.72),
        glove_parts=glove_parts,
        skin_parts=skin_parts,
        nail_parts=nail_parts,
    )

    # Trigger index finger kept as an animated child node so shooting bends it onto the trigger!
    idx_glove: list[MeshData] = []
    idx_skin: list[MeshData] = []
    idx_nail: list[MeshData] = []
    _append_finger_meshes(
        np.eye(4, dtype=np.float64),
        lengths=(0.030, 0.022, 0.016),
        radius=0.0082,
        curl_angles=(0.14, 0.24, 0.20),
        glove_parts=idx_glove,
        skin_parts=idx_skin,
        nail_parts=idx_nail,
    )

    index_node = GLBNode(
        name="right_index_joint_0",
        translation=(0.017, 0.027, -0.032),
        rotation_xyz=(-math.pi * 0.5 + 0.10, 0.0, 0.22),
        children=[
            GLBNode(name="right_index_glove", mesh=merge_meshes(idx_glove), material=mats["glove"]),
            GLBNode(name="right_index_skin", mesh=merge_meshes(idx_skin), material=mats["skin"]),
            GLBNode(name="right_index_nail", mesh=merge_meshes(idx_nail), material=mats["nail"]),
        ],
    )

    return GLBNode(
        name="right_hand_group",
        translation=_RIGHT_GRIP_POS,
        rotation_xyz=_RIGHT_GRIP_ROT,
        children=[
            GLBNode(name="right_hand_glove", mesh=merge_meshes(glove_parts), material=mats["glove"]),
            GLBNode(name="right_hand_knuckle", mesh=knuckle, material=mats["knuckle"]),
            GLBNode(name="right_hand_skin", mesh=merge_meshes(skin_parts), material=mats["skin"]),
            GLBNode(name="right_hand_nails", mesh=merge_meshes(nail_parts), material=mats["nail"]),
            GLBNode(name="right_wrist_anchor", translation=(0.008, -0.036, 0.024)),
            index_node,
        ],
    )


def _build_arm_rig_node(
    name: str,
    elbow_pos: tuple[float, float, float],
    mats: dict[str, GLBMaterial],
    with_watch: bool,
    curve_bow_x: float,
) -> GLBNode:
    """Build unit-length (Y=0..1) muscular forearm spline rig + rolled camo cuff (+ optional watch)."""
    # Slight anatomical bow along X/Z normalized along Y in [0, 1] so aimForearm() aims & scales cleanly
    ctrl = [
        (0.0, 0.0, 0.0),
        (curve_bow_x, 0.34, 0.018),
        (curve_bow_x * 0.45, 0.72, 0.008),
        (0.0, 1.0, 0.0),
    ]
    forearm_mesh = create_tube_along_curve(
        ctrl,
        radius=0.042,
        tubular_segments=28,
        radial_segments=20,
        taper_fn=lambda t: 1.24 - t * 0.48,
        flatten_xy=(0.92, 1.08),
        uv_scale=2.2,
    )

    # Rolled camo sleeve hugging forearm bicep cleanly (oval cross-section matching forearm curve)
    sleeve_parts = [
        transform_mesh(create_torus(0.049, 0.009, radial_segments=12, tubular_segments=24), (curve_bow_x * 0.28, 0.088, 0.005), (math.pi * 0.5, 0.0, 0.0), (0.94, 1.09, 1.0)),
        transform_mesh(create_torus(0.050, 0.0085, radial_segments=12, tubular_segments=24), (curve_bow_x * 0.22, 0.072, 0.004), (math.pi * 0.5, 0.0, 0.0), (0.94, 1.09, 1.0)),
        transform_mesh(create_cylinder(0.050, 0.052, 0.088, radial_segments=20, open_ended=False), (curve_bow_x * 0.14, 0.044, 0.002), (0.0, 0.0, 0.0), (0.94, 1.0, 1.09)),
    ]

    children = [
        GLBNode(name=f"{name}_forearm", mesh=forearm_mesh, material=mats["skin"]),
        GLBNode(name=f"{name}_sleeve", mesh=merge_meshes(sleeve_parts), material=mats["camo"]),
    ]

    if with_watch:
        # Tactical watch band hugs the anatomical wrist radius (~0.033m, matching forearm flatten_xy 0.92 x 1.08)
        rx, rz = 0.0315, 0.036
        th = -0.52
        sx, sz = rx * math.sin(th), rz * math.cos(th)
        strap_mesh = transform_mesh(
            create_cylinder(0.0338, 0.0342, 0.019, radial_segments=24, open_ended=True),
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0),
            (0.94, 1.0, 1.07),
        )
        case_parts = [
            transform_mesh(create_cylinder(0.0195, 0.0195, 0.0095, 24), (0.0, 0.0, 0.004), (math.pi * 0.5, 0.0, 0.0)),
            transform_mesh(create_torus(0.0185, 0.0026, 8, 24), (0.0, 0.0, 0.0085)),
            transform_mesh(create_cylinder(0.0024, 0.0024, 0.005, 10), (0.021, 0.0, 0.004), (0.0, 0.0, math.pi * 0.5)),
        ]
        dial_mesh = transform_mesh(create_circle(0.0165, 24), (0.0, 0.0, 0.0092))

        watch_node = GLBNode(
            name="left_watch",
            translation=(0.0, 0.52, 0.0),
            children=[
                GLBNode(name="watch_strap", mesh=strap_mesh, material=mats["watch_strap"]),
                GLBNode(
                    name="watch_head",
                    translation=(sx, 0.0, sz),
                    rotation_xyz=(0.0, th, 0.0),
                    children=[
                        GLBNode(name="watch_case", mesh=merge_meshes(case_parts), material=mats["watch_case"]),
                        GLBNode(name="watch_dial", mesh=dial_mesh, material=mats["watch_dial"]),
                    ],
                ),
            ],
        )
        children.append(watch_node)

    return GLBNode(
        name=name,
        translation=elbow_pos,
        children=children,
    )


def build_fps_arms_nodes(skin_size: int = 512, glove_size: int = 256, seed: int = 42) -> list[GLBNode]:
    """Assemble the complete rigged PBR FPS arms scene graph."""
    mats = _create_materials(skin_size=skin_size, glove_size=glove_size, seed=seed)

    children = [
        _build_left_hand_node(mats),
        _build_right_hand_node(mats),
        _build_arm_rig_node("left_arm_rig", _LEFT_ELBOW, mats, with_watch=True, curve_bow_x=-0.018),
        _build_arm_rig_node("right_arm_rig", _RIGHT_ELBOW, mats, with_watch=False, curve_bow_x=0.014),
    ]
    return [
        GLBNode(
            name="arms_root",
            children=children,
            extras=dict(FPS_ARMS_METADATA),
        )
    ]
