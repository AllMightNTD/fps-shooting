"""Detailed PBR third-person tactical soldier model with articulated limbs and headshot rig."""

from __future__ import annotations

import math

from model.core import (
    GLBMaterial,
    GLBNode,
    MeshData,
    create_beveled_box,
    create_capsule,
    create_cylinder,
    create_glove_textures,
    create_realistic_skin_textures,
    create_soldier_textures,
    merge_meshes,
    transform_mesh,
)

# Hitbox constants shared between soldier mesh, Node.js LAN server, and FPS.html.
SOLDIER_METADATA: dict[str, object] = {
    "character": "Soldier_Tactical_PBR",
    "height": 1.76,
    "bodyRadius": 0.34,
    "bodyHeight": 1.48,
    "headCenterY": 1.63,
    "headRadius": 0.145,
    "weaponMountLocal": [0.105, -0.115, -0.295],
}


def _create_materials(tex_size: int = 256, seed: int = 303) -> dict[str, GLBMaterial]:
    soldier_tex = create_soldier_textures(size=tex_size, seed=seed)
    glove_tex = create_glove_textures(size=max(64, tex_size), seed=seed + 11)
    skin_tex = create_realistic_skin_textures(size=max(64, tex_size), pore_count=1200, droplet_count=60, seed=seed + 23)

    return {
        "uniform": GLBMaterial(
            name="Soldier_Uniform",
            color=0xFFFFFF,
            metalness=0.04,
            roughness=0.82,
            base_color_png=soldier_tex.uniform_albedo_png,
            metallic_roughness_png=soldier_tex.uniform_mr_png,
            normal_png=soldier_tex.uniform_normal_png,
            normal_scale=0.80,
            clearcoat=0.22,
            clearcoat_roughness=0.35,
            sheen_color=0x5B665D,
            sheen_roughness=0.78,
        ),
        "armor": GLBMaterial(
            name="Soldier_Armor",
            color=0xFFFFFF,
            metalness=0.20,
            roughness=0.52,
            base_color_png=soldier_tex.armor_albedo_png,
            metallic_roughness_png=soldier_tex.armor_mr_png,
            normal_png=soldier_tex.uniform_normal_png,
            normal_scale=0.45,
            clearcoat=0.48,
            clearcoat_roughness=0.22,
        ),
        "glove": GLBMaterial(
            name="Soldier_Glove",
            color=0xFFFFFF,
            metalness=0.05,
            roughness=0.85,
            base_color_png=glove_tex.glove_albedo_png,
            metallic_roughness_png=glove_tex.glove_mr_png,
            normal_png=glove_tex.glove_normal_png,
            normal_scale=0.85,
        ),
        "skin": GLBMaterial(
            name="Soldier_Skin",
            color=0xFFFFFF,
            metalness=0.0,
            roughness=0.55,
            base_color_png=skin_tex.albedo_png,
            metallic_roughness_png=skin_tex.mr_png,
            normal_png=skin_tex.normal_png,
            normal_scale=0.55,
            clearcoat=0.40,
            clearcoat_roughness=0.24,
        ),
        "visor": GLBMaterial(
            name="Soldier_Visor",
            color=0x162430,
            metalness=0.85,
            roughness=0.10,
            clearcoat=1.0,
            clearcoat_roughness=0.05,
        ),
        "team_accent": GLBMaterial(
            name="TeamColor",
            color=0x2F80FF,
            metalness=0.14,
            roughness=0.38,
            emissive=0x2F80FF,
            emissive_intensity=0.25,
        ),
        "boot": GLBMaterial(
            name="Soldier_Boot",
            color=0x171A1D,
            metalness=0.10,
            roughness=0.58,
            clearcoat=0.55,
            clearcoat_roughness=0.22,
        ),
    }


def _build_leg_node(name: str, hip_x: float, mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build articulated leg anchored at hip joint with boots touching world Y=0."""
    cloth_parts = [
        transform_mesh(create_capsule(0.078, 0.062, 0.32, cap_segments=5, radial_segments=14), (0.0, -0.20, 0.0)),
        transform_mesh(create_capsule(0.060, 0.048, 0.30, cap_segments=5, radial_segments=14), (0.0, -0.55, 0.015)),
        # Cargo thigh pocket
        transform_mesh(create_beveled_box(0.036, 0.14, 0.11, bevel=0.006), (math.copysign(0.072, hip_x), -0.22, 0.0)),
    ]
    armor_parts = [
        # Hard tactical kneepad
        transform_mesh(create_beveled_box(0.11, 0.11, 0.045, bevel=0.010), (0.0, -0.39, -0.056)),
    ]
    boot_parts = [
        # Combat boot + thick tread sole touching ground at local Y = -0.86 (hip at Y = 0.86 -> foot at Y = 0.0)
        transform_mesh(create_beveled_box(0.102, 0.12, 0.14, bevel=0.012), (0.0, -0.76, -0.005)),
        transform_mesh(create_beveled_box(0.106, 0.072, 0.24, bevel=0.012), (0.0, -0.824, -0.055)),
    ]
    return GLBNode(
        name=name,
        translation=(hip_x, 0.86, 0.0),
        children=[
            GLBNode(name=f"{name}_cloth", mesh=merge_meshes(cloth_parts), material=mats["uniform"], extras={"hitZone": "limb"}),
            GLBNode(name=f"{name}_pad", mesh=merge_meshes(armor_parts), material=mats["armor"], extras={"hitZone": "limb"}),
            GLBNode(name=f"{name}_boot", mesh=merge_meshes(boot_parts), material=mats["boot"], extras={"hitZone": "limb"}),
        ],
    )


def _build_head_node(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build tactical helmet, ComTac headset, visor & head hitbox centered near world Y=1.63."""
    skin_parts = [
        # Lower jaw / nose bridge visible beneath visor
        transform_mesh(create_capsule(0.086, 0.078, 0.08, cap_segments=6, radial_segments=16), (0.0, 0.11, -0.006)),
    ]
    armor_parts = [
        # Balaclava neck & lower mask
        transform_mesh(create_capsule(0.068, 0.074, 0.06, cap_segments=5, radial_segments=14), (0.0, 0.03, 0.0)),
        transform_mesh(create_beveled_box(0.155, 0.072, 0.14, bevel=0.014), (0.0, 0.082, -0.024)),
        # FAST ballistic helmet dome + rear nape shell
        transform_mesh(create_capsule(0.108, 0.116, 0.045, cap_segments=7, radial_segments=20), (0.0, 0.175, 0.012)),
        transform_mesh(create_beveled_box(0.228, 0.085, 0.238, bevel=0.018), (0.0, 0.185, 0.016)),
        # Helmet side ARC rails, ComTac ear cups, and NVG front shroud
        transform_mesh(create_beveled_box(0.020, 0.030, 0.16, bevel=0.004), (-0.118, 0.165, 0.015)),
        transform_mesh(create_beveled_box(0.020, 0.030, 0.16, bevel=0.004), (0.118, 0.165, 0.015)),
        transform_mesh(create_beveled_box(0.046, 0.056, 0.018, bevel=0.004), (0.0, 0.185, -0.108)),
        transform_mesh(create_cylinder(0.034, 0.034, 0.034, 14), (-0.116, 0.118, 0.008), (0.0, 0.0, math.pi * 0.5)),
        transform_mesh(create_cylinder(0.034, 0.034, 0.034, 14), (0.116, 0.118, 0.008), (0.0, 0.0, math.pi * 0.5)),
        # Helmet rear counterweight pouch
        transform_mesh(create_beveled_box(0.11, 0.065, 0.04, bevel=0.006), (0.0, 0.155, 0.132)),
    ]
    visor_parts = [
        # Ballistic tactical goggles wrapping eye line
        transform_mesh(create_beveled_box(0.172, 0.052, 0.055, bevel=0.010), (0.0, 0.132, -0.086)),
    ]
    accent_parts = [
        # Prominent TeamColor helmet crown stripe, wide headband wrap & ear cup caps for 30m rain clarity
        transform_mesh(create_beveled_box(0.11, 0.036, 0.228, bevel=0.008), (0.0, 0.225, 0.015)),
        transform_mesh(create_beveled_box(0.244, 0.034, 0.252, bevel=0.008), (0.0, 0.172, 0.016)),
        transform_mesh(create_cylinder(0.038, 0.038, 0.016, 14), (-0.132, 0.118, 0.008), (0.0, 0.0, math.pi * 0.5)),
        transform_mesh(create_cylinder(0.038, 0.038, 0.016, 14), (0.132, 0.118, 0.008), (0.0, 0.0, math.pi * 0.5)),
    ]

    return GLBNode(
        name="head_group",
        translation=(0.0, 0.50, 0.0),
        extras={"hitZone": "head"},
        children=[
            GLBNode(name="head_skin", mesh=merge_meshes(skin_parts), material=mats["skin"], extras={"hitZone": "head"}),
            GLBNode(name="head_helmet", mesh=merge_meshes(armor_parts), material=mats["armor"], extras={"hitZone": "head"}),
            GLBNode(name="head_visor", mesh=merge_meshes(visor_parts), material=mats["visor"], extras={"hitZone": "head"}),
            GLBNode(name="head_team_iff", mesh=merge_meshes(accent_parts), material=mats["team_accent"], extras={"hitZone": "head"}),
        ],
    )


def _build_arms_group(mats: dict[str, GLBMaterial]) -> GLBNode:
    """Build tactical firing-stance arms + empty weapon_mount aligned to M416 rifle."""
    cloth_parts = [
        # Right upper arm + forearm holding pistol grip near (0.10, -0.17, -0.22)
        transform_mesh(create_capsule(0.054, 0.048, 0.22, cap_segments=5, radial_segments=12), (0.20, -0.07, 0.01), (-0.28, 0.0, -0.25)),
        transform_mesh(create_capsule(0.046, 0.038, 0.22, cap_segments=5, radial_segments=12), (0.145, -0.17, -0.11), (-1.22, -0.25, 0.08)),
        # Left upper arm + forearm reaching forward to handguard near (0.04, -0.13, -0.46)
        transform_mesh(create_capsule(0.054, 0.048, 0.22, cap_segments=5, radial_segments=12), (-0.20, -0.07, -0.02), (-0.52, 0.12, 0.22)),
        transform_mesh(create_capsule(0.046, 0.038, 0.27, cap_segments=5, radial_segments=12), (-0.075, -0.14, -0.29), (-1.45, 0.56, 0.0)),
    ]
    glove_parts = [
        # Gloved hands gripping pistol grip & handguard
        transform_mesh(create_beveled_box(0.056, 0.072, 0.074, bevel=0.010), (0.102, -0.175, -0.225)),
        transform_mesh(create_beveled_box(0.062, 0.058, 0.078, bevel=0.010), (0.048, -0.132, -0.505)),
    ]
    accent_parts = [
        # Broad shoulder pauldrons & forearm cuff bands clearly visible at 30m from every angle
        transform_mesh(create_beveled_box(0.048, 0.115, 0.128, bevel=0.010), (0.236, -0.025, 0.005), (-0.24, 0.0, -0.18)),
        transform_mesh(create_beveled_box(0.048, 0.115, 0.128, bevel=0.010), (-0.236, -0.025, -0.015), (-0.42, 0.08, 0.18)),
        transform_mesh(create_beveled_box(0.068, 0.045, 0.088, bevel=0.008), (0.135, -0.17, -0.145), (-0.4, -0.25, 0.0)),
        transform_mesh(create_beveled_box(0.068, 0.045, 0.088, bevel=0.008), (-0.062, -0.135, -0.35), (-0.2, 0.45, 0.0)),
    ]
    return GLBNode(
        name="arms_group",
        translation=(0.0, 0.43, -0.01),
        extras={"hitZone": "body"},
        children=[
            GLBNode(name="arms_sleeves", mesh=merge_meshes(cloth_parts), material=mats["uniform"], extras={"hitZone": "body"}),
            GLBNode(name="arms_gloves", mesh=merge_meshes(glove_parts), material=mats["glove"], extras={"hitZone": "body"}),
            GLBNode(name="arms_team_patch", mesh=merge_meshes(accent_parts), material=mats["team_accent"], extras={"hitZone": "body"}),
            GLBNode(
                name="weapon_mount",
                translation=(0.105, -0.115, -0.295),
                rotation_xyz=(0.02, 0.14, 0.0),
            ),
        ],
    )


def build_soldier_nodes(tex_size: int = 256, seed: int = 303) -> list[GLBNode]:
    """Assemble the complete rigged PBR third-person tactical soldier scene graph."""
    mats = _create_materials(tex_size=tex_size, seed=seed)

    # Hips & tactical drop belt (world Y ~ 0.88)
    hips_uniform = [
        transform_mesh(create_beveled_box(0.31, 0.16, 0.21, bevel=0.018), (0.0, 0.89, 0.0)),
    ]
    hips_gear = [
        transform_mesh(create_beveled_box(0.335, 0.055, 0.235, bevel=0.008), (0.0, 0.94, 0.0)),
        transform_mesh(create_beveled_box(0.06, 0.11, 0.10, bevel=0.007), (-0.175, 0.89, 0.02)),
        transform_mesh(create_beveled_box(0.05, 0.13, 0.09, bevel=0.007), (0.178, 0.85, 0.0)),
    ]

    # Upper torso + Kevlar plate carrier + magazine pouches + comms radio
    torso_uniform = [
        transform_mesh(create_beveled_box(0.34, 0.44, 0.21, bevel=0.024), (0.0, 0.26, 0.0)),
        transform_mesh(create_beveled_box(0.41, 0.14, 0.19, bevel=0.022), (0.0, 0.41, 0.0)),
    ]
    vest_armor = [
        # Front & back ballistic plates + shoulder straps
        transform_mesh(create_beveled_box(0.31, 0.34, 0.255, bevel=0.016), (0.0, 0.29, 0.0)),
        transform_mesh(create_beveled_box(0.075, 0.06, 0.22, bevel=0.008), (-0.11, 0.46, 0.0)),
        transform_mesh(create_beveled_box(0.075, 0.06, 0.22, bevel=0.008), (0.11, 0.46, 0.0)),
        # Triple chest M416 mag pouches on front vest
        transform_mesh(create_beveled_box(0.068, 0.13, 0.048, bevel=0.006), (-0.082, 0.20, -0.145)),
        transform_mesh(create_beveled_box(0.068, 0.13, 0.048, bevel=0.006), (0.0, 0.20, -0.145)),
        transform_mesh(create_beveled_box(0.068, 0.13, 0.048, bevel=0.006), (0.082, 0.20, -0.145)),
        # Rear hydration backpack & comms radio + antenna
        transform_mesh(create_beveled_box(0.22, 0.28, 0.085, bevel=0.012), (0.0, 0.29, 0.15)),
        transform_mesh(create_cylinder(0.0045, 0.003, 0.22, 8), (-0.11, 0.48, 0.14)),
    ]
    torso_accent = [
        # Prominent TeamColor ballistic vest chest/back/side cummerbund panels
        transform_mesh(create_beveled_box(0.28, 0.16, 0.022, bevel=0.006), (0.0, 0.34, -0.134)),
        transform_mesh(create_beveled_box(0.26, 0.18, 0.024, bevel=0.006), (0.0, 0.35, 0.194)),
        transform_mesh(create_beveled_box(0.355, 0.11, 0.18, bevel=0.008), (0.0, 0.25, 0.0)),
    ]

    upper_body = GLBNode(
        name="upper_body",
        translation=(0.0, 0.96, 0.0),
        extras={"hitZone": "body"},
        children=[
            GLBNode(name="torso_uniform", mesh=merge_meshes(torso_uniform), material=mats["uniform"], extras={"hitZone": "body"}),
            GLBNode(name="torso_vest", mesh=merge_meshes(vest_armor), material=mats["armor"], extras={"hitZone": "body"}),
            GLBNode(name="torso_team_strip", mesh=merge_meshes(torso_accent), material=mats["team_accent"], extras={"hitZone": "body"}),
            _build_head_node(mats),
            _build_arms_group(mats),
        ],
    )

    return [
        GLBNode(
            name="soldier_root",
            extras=dict(SOLDIER_METADATA),
            children=[
                GLBNode(name="hips_uniform", mesh=merge_meshes(hips_uniform), material=mats["uniform"], extras={"hitZone": "body"}),
                GLBNode(name="hips_gear", mesh=merge_meshes(hips_gear), material=mats["armor"], extras={"hitZone": "body"}),
                _build_leg_node("leg_left", -0.105, mats),
                _build_leg_node("leg_right", 0.105, mats),
                upper_body,
            ],
        )
    ]
