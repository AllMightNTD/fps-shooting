"""Merge Mixamo / AccuRIG animations onto rigged FSB/SWAT soldier and export soldier.glb + soldier.bundle.js.

Expected workflow:
  1. Run prep_fsb_for_rig.py to produce model/assets/fsb_ready_for_rig.fbx.
  2. Auto-rig on Mixamo (or AccuRIG) and download animations into model/assets/fsb_anims/:
       - idle.fbx       (downloaded "With Skin" — serves as base rigged mesh + idle clip,
                         or provide base.fbx / base_rigged.fbx separately)
       - run.fbx        ("Rifle Run", In-Place recommended; script also enforces In-Place)
       - crouch.fbx     ("Crouch Idle" / "Crouching Idle")
       - jump.fbx       ("Jump")
       - prone.fbx      ("Prone Idle", optional)
       - prone_move.fbx ("Prone Forward" / "Crawl", optional)
     (Common Mixamo filenames or .glb equivalents are also auto-detected.)
  3. Run:
       blender --background --python scripts/blender/build_fsb_anims.py -- --tex-size 1024

Output:
  - model/dist/soldier.glb        (SkinnedMesh + NLA AnimationClips: idle, run, crouch, jump,
                                   prone, prone_move; NO Draco compression so Three.js r128
                                   GLTFLoader loads directly; includes weapon_mount on RightHand
                                   + TeamColor tactical patches)
  - model/dist/soldier.bundle.js  (Base64 CORS-free bundle matching model/build.py)
"""

from __future__ import annotations

import argparse
import base64
from pathlib import Path
import struct
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

TARGET_HEIGHT_M = 1.76
MAX_JUMP_DURATION_S = 0.72
MIN_JUMP_DURATION_S = 0.45

ARM_RIFLE_BONE_KEYS = (
    "leftshoulder",
    "leftarm",
    "leftforearm",
    "lefthand",
    "rightshoulder",
    "rightarm",
    "rightforearm",
    "righthand",
)

UPPER_RIFLE_BONE_KEYS = (
    "spine1",
    "spine2",
    "neck",
    "head",
    *ARM_RIFLE_BONE_KEYS,
)

CLIP_ALIASES: dict[str, tuple[str, ...]] = {
    "idle": ("idle", "rifle_idle", "rifle idle", "standing_idle", "standing idle"),
    "run": ("run", "rifle_run", "rifle run", "sprint", "jog"),
    "crouch": ("crouch", "crouch_idle", "crouch idle", "crouching_idle", "crouching idle"),
    "crouch_forward": ("walk_crouching_forward", "crouch_forward", "crouch walk forward"),
    "crouch_backward": ("walk_crouching_backward", "crouch_backward", "crouch walk backward"),
    "crouch_left": ("walk_crouching_left", "crouch_left", "crouch walk left"),
    "crouch_right": ("walk_crouching_right", "crouch_right", "crouch walk right"),
    "jump": ("jump", "rifle_jump", "rifle jump", "jump_up", "jump up"),
    "prone": ("prone", "prone_idle", "prone idle", "rifle_prone", "rifle prone"),
    "prone_move": ("prone_move", "prone move", "prone_forward", "prone forward", "crawl", "crawling"),
}

CLIP_EXCLUDE_TOKENS: dict[str, tuple[str, ...]] = {
    "run": ("crouch",),
    "crouch": ("walk", "run", "move", "forward", "backward", "left", "right"),
    "prone": ("move", "crawl", "forward"),
}

CYCLIC_CLIPS: tuple[str, ...] = (
    "idle",
    "run",
    "crouch",
    "crouch_forward",
    "crouch_backward",
    "crouch_left",
    "crouch_right",
    "crouch_move",
    "prone",
    "prone_move",
)

BASE_ALIASES: tuple[str, ...] = (
    "base_rigged",
    "base",
    "character",
    "fsb_rigged",
    "idle",
    "rifle_idle",
    "rifle idle",
)

HIPS_BONE_CANDIDATES = ("mixamorig:Hips", "Hips", "hips", "pelvis", "Pelvis", "CC_Base_Hip")
RIGHT_HAND_CANDIDATES = ("mixamorig:RightHand", "RightHand", "hand_r", "Hand_R", "R_wrist", "CC_Base_R_Hand")
HEAD_BONE_CANDIDATES = ("mixamorig:Head", "Head", "head", "CC_Base_Head")
LEFT_ARM_CANDIDATES = ("mixamorig:LeftArm", "LeftArm", "upperarm_l", "LeftShoulder", "CC_Base_L_Upperarm")
RIGHT_ARM_CANDIDATES = ("mixamorig:RightArm", "RightArm", "upperarm_r", "RightShoulder", "CC_Base_R_Upperarm")


def _parse_args(argv: list[str]) -> argparse.Namespace:
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Merge Mixamo/AccuRIG clips & export soldier.glb")
    parser.add_argument("--anims-dir", type=Path, default=repo_root / "model" / "assets" / "fsb_anims")
    parser.add_argument("--tex-dir", type=Path, default=repo_root / "model" / "assets" / "fsb_textures")
    parser.add_argument("--out-glb", type=Path, default=repo_root / "model" / "dist" / "soldier.glb")
    parser.add_argument("--out-bundle", type=Path, default=repo_root / "model" / "dist" / "soldier.bundle.js")
    parser.add_argument("--tex-size", type=int, default=1024)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--prep-glb", type=Path, default=repo_root / "model" / "assets" / "fsb_ready_for_rig.glb")
    return parser.parse_args(argv)


def _find_asset_file(anims_dir: Path, aliases: tuple[str, ...], exclude_tokens: tuple[str, ...] = ()) -> Path | None:
    if not anims_dir.is_dir():
        return None
    files = [p for p in anims_dir.iterdir() if p.is_file() and p.suffix.lower() in (".fbx", ".glb", ".gltf")]
    by_stem = {p.stem.lower().replace("-", "_"): p for p in files}
    norm_aliases = [alias.lower().replace("-", "_").replace(" ", "_") for alias in aliases]
    # Exact stem match across all aliases first (prevents 'prone' matching 'prone_move')
    for norm in norm_aliases:
        if norm in by_stem:
            return by_stem[norm]
        spaced = norm.replace("_", " ")
        if spaced in by_stem:
            return by_stem[spaced]
    # Fallback substring match excluding conflicting tokens
    for norm in norm_aliases:
        for stem, path in by_stem.items():
            if exclude_tokens and any(tok in stem for tok in exclude_tokens):
                continue
            if norm in stem or norm.replace("_", " ") in stem:
                return path
    return None


def _import_asset(path: Path) -> list[bpy.types.Object]:
    before = set(bpy.data.objects)
    ext = path.suffix.lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path), automatic_bone_orientation=False)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        raise ValueError(f"Unsupported animation asset format: {path}")
    return [o for o in bpy.data.objects if o not in before]


def _resolve_bone_name(armature: bpy.types.Object, candidates: tuple[str, ...]) -> str | None:
    bones = armature.data.bones
    for cand in candidates:
        if cand in bones:
            return cand
    lower_map = {b.name.lower(): b.name for b in bones}
    for cand in candidates:
        if cand.lower() in lower_map:
            return lower_map[cand.lower()]
    for cand in candidates:
        c_low = cand.split(":")[-1].lower()
        for b_low, b_real in lower_map.items():
            if b_low.endswith(c_low):
                return b_real
    return None


def _compute_skinned_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in meshes:
        eval_obj = obj.evaluated_get(depsgraph)
        mesh = eval_obj.to_mesh()
        mat = eval_obj.matrix_world
        for v in mesh.vertices:
            w = mat @ v.co
            lo.x = min(lo.x, w.x)
            lo.y = min(lo.y, w.y)
            lo.z = min(lo.z, w.z)
            hi.x = max(hi.x, w.x)
            hi.y = max(hi.y, w.y)
            hi.z = max(hi.z, w.z)
        eval_obj.to_mesh_clear()
    return lo, hi


def _normalize_rig_transform(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    # Ensure armature & meshes have uniform height = 1.76m, feet at Z=0, facing -Z in Three.js
    armature.data.pose_position = "REST"
    bpy.context.view_layer.update()
    lo, hi = _compute_skinned_bounds(meshes)
    cur_h = max(1e-5, hi.z - lo.z)
    scale_mul = TARGET_HEIGHT_M / cur_h

    armature.scale = tuple(s * scale_mul for s in armature.scale)
    bpy.context.view_layer.update()
    lo2, hi2 = _compute_skinned_bounds(meshes)

    cx = (lo2.x + hi2.x) * 0.5
    cy = (lo2.y + hi2.y) * 0.5
    armature.location = (armature.location.x - cx, armature.location.y - cy, armature.location.z - lo2.z)
    armature.data.pose_position = "POSE"
    bpy.context.view_layer.update()


def _restore_pbr_textures(meshes: list[bpy.types.Object], tex_dir: Path, tex_size: int) -> None:
    bc_path = tex_dir / "fsb_basecolor.png"
    mr_path = tex_dir / "fsb_mr.png"
    nm_path = tex_dir / "fsb_normal.png"
    if not bc_path.is_file():
        return

    def load_img(path: Path, colorspace: str) -> bpy.types.Image:
        img = bpy.data.images.load(str(path), check_existing=False)
        tmp_scaled: Path | None = None
        if img.size[0] != tex_size or img.size[1] != tex_size:
            img.scale(tex_size, tex_size)
            tmp_scaled = path.with_name(f"{path.stem}_{tex_size}.png")
            img.filepath_raw = str(tmp_scaled)
            img.file_format = "PNG"
            img.save()
            scaled_img = bpy.data.images.load(str(tmp_scaled), check_existing=False)
            bpy.data.images.remove(img)
            img = scaled_img
        img.colorspace_settings.name = colorspace
        img.pack()
        if tmp_scaled is not None:
            tmp_scaled.unlink(missing_ok=True)
        return img

    bc_img = load_img(bc_path, "sRGB")
    mr_img = load_img(mr_path, "Non-Color") if mr_path.is_file() else None
    nm_img = load_img(nm_path, "Non-Color") if nm_path.is_file() else None

    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)

    for obj in meshes:
        if not obj.data.materials:
            mat = bpy.data.materials.new("FSB_Operator_PBR")
            obj.data.materials.append(mat)
        mat = obj.data.materials[0]
        existing_mat = bpy.data.materials.get("FSB_Operator_PBR")
        if existing_mat and existing_mat is not mat:
            existing_mat.name = "__unused_old_pbr"
            if existing_mat.users == 0:
                bpy.data.materials.remove(existing_mat)
        mat.name = "FSB_Operator_PBR"
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()

        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

        tex_bc = nt.nodes.new("ShaderNodeTexImage")
        tex_bc.image = bc_img
        nt.links.new(tex_bc.outputs["Color"], bsdf.inputs["Base Color"])

        if mr_img is not None:
            tex_mr = nt.nodes.new("ShaderNodeTexImage")
            tex_mr.image = mr_img
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(tex_mr.outputs["Color"], sep.inputs["Color"])
            nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

        if nm_img is not None:
            tex_nm = nt.nodes.new("ShaderNodeTexImage")
            tex_nm.image = nm_img
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(tex_nm.outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])


def _build_box_mesh(name: str, sx: float, sy: float, sz: float, mat: bpy.types.Material) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name + "_Mesh")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _build_band_mesh(name: str, radius_top: float, radius_bot: float, height: float, mat: bpy.types.Material) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name + "_Mesh")
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=16,
        radius1=radius_bot,
        radius2=radius_top,
        depth=height,
    )
    # Align cylinder axis (local Z) along Blender bone axis (+Y)
    bmesh.ops.rotate(bm, cent=(0.0, 0.0, 0.0), matrix=Euler((1.5707963267948966, 0.0, 0.0), "XYZ").to_matrix(), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _attach_socket_and_team_patches(armature: bpy.types.Object, root_empty: bpy.types.Object) -> None:
    right_hand = _resolve_bone_name(armature, RIGHT_HAND_CANDIDATES)
    head_bone = _resolve_bone_name(armature, HEAD_BONE_CANDIDATES)
    l_arm_bone = _resolve_bone_name(armature, LEFT_ARM_CANDIDATES)
    r_arm_bone = _resolve_bone_name(armature, RIGHT_ARM_CANDIDATES)

    # Weapon mount empty parented to RightHand bone; child remote weapons inherit hand motion
    mount = bpy.data.objects.new("weapon_mount", None)
    mount.empty_display_type = "ARROWS"
    mount.empty_display_size = 0.08
    bpy.context.scene.collection.objects.link(mount)
    if right_hand:
        mount.parent = armature
        mount.parent_type = "BONE"
        mount.parent_bone = right_hand
        # Mixamo RightHand +Y runs toward LeftHand (barrel forward); rotating ~180 deg around Y
        # plus slight wrist roll aligns mount +Y (glTF -Z) forward and mount +Z (glTF +Y) upright.
        mount.location = (0.0, 0.028, 0.006)
        mount.rotation_euler = Euler((0.0, 3.141592653589793 - 0.32, 0.0), "XYZ")
    else:
        mount.parent = root_empty
        mount.location = (0.105, 0.115, 1.26)

    # Shared TeamColor material overridden per team (subtle tactical patch, not glaring neon)
    team_mat = bpy.data.materials.new("TeamColor")
    team_mat.use_nodes = True
    bsdf = next(n for n in team_mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.184, 0.502, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.58
    bsdf.inputs["Metallic"].default_value = 0.06
    if "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (0.184, 0.502, 1.0, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 0.08

    if head_bone:
        crown = _build_box_mesh("head_team_iff", 0.052, 0.014, 0.068, team_mat)
        crown.parent = armature
        crown.parent_type = "BONE"
        crown.parent_bone = head_bone
        # Low-profile IFF strobe strip nestled flush along upper helmet ridge
        crown.location = (0.0, -0.022, 0.018)

    for patch_name, bone_name in (
        ("team_armband_L", l_arm_bone),
        ("team_armband_R", r_arm_bone),
    ):
        if bone_name:
            bone_len = armature.data.bones[bone_name].length
            band = _build_band_mesh(patch_name, 0.068, 0.063, 0.044, team_mat)
            band.parent = armature
            band.parent_type = "BONE"
            band.parent_bone = bone_name
            # Bone parenting anchors at elbow (TAIL); pull up toward mid-bicep sleeve
            band.location = (0.0, -0.46 * bone_len, -0.014)


def _map_bone_name(src_name: str, dst_bones: set[str]) -> str | None:
    if src_name in dst_bones:
        return src_name
    short = src_name.split(":")[-1]
    for d in dst_bones:
        if d.split(":")[-1].lower() == short.lower():
            return d
    return None


def _extract_action_for_clip(
    clip_name: str,
    clip_path: Path,
    target_armature: bpy.types.Object,
    scene_fps: int,
) -> bpy.types.Action:
    before_actions = set(bpy.data.actions)
    imported = _import_asset(clip_path)
    src_armatures = [o for o in imported if o.type == "ARMATURE"]
    if not src_armatures:
        for o in imported:
            bpy.data.objects.remove(o, do_unlink=True)
        raise RuntimeError(f"No armature found in animation file: {clip_path}")

    src_arm = src_armatures[0]
    src_action = src_arm.animation_data.action if src_arm.animation_data else None
    if not src_action and src_arm.animation_data and src_arm.animation_data.nla_tracks:
        for tr in src_arm.animation_data.nla_tracks:
            if tr.strips:
                src_action = tr.strips[0].action
                break
    if not src_action:
        new_actions = [a for a in bpy.data.actions if a not in before_actions]
        if new_actions:
            src_action = new_actions[0]
    if not src_action:
        for o in imported:
            bpy.data.objects.remove(o, do_unlink=True)
        raise RuntimeError(f"No animation action found in file: {clip_path}")

    src_arm.animation_data_create()
    src_arm.animation_data.action = src_action

    f_start, f_end = src_action.frame_range
    f_start_i = int(round(f_start))
    f_end_i = max(f_start_i + 1, int(round(f_end)))

    # Retime jump clips to start right at liftoff and end before deep post-landing squat
    src_dur_s = (f_end_i - f_start_i) / float(scene_fps)
    sample_start, sample_end = f_start_i, f_end_i
    src_hips = _resolve_bone_name(src_arm, HIPS_BONE_CANDIDATES)
    if clip_name == "jump" and src_dur_s > MAX_JUMP_DURATION_S:
        if src_hips:
            scene = bpy.context.scene
            hip_zs: list[tuple[int, float]] = []
            for jf in range(f_start_i, f_end_i + 1):
                scene.frame_set(jf)
                bpy.context.view_layer.update()
                hz = (src_arm.matrix_world @ src_arm.pose.bones[src_hips].head).z
                hip_zs.append((jf, hz))
            rest_z = hip_zs[0][1]
            peak_idx = max(range(len(hip_zs)), key=lambda idx: hip_zs[idx][1])
            start_idx = peak_idx
            while start_idx > 0 and hip_zs[start_idx - 1][1] >= rest_z - 0.04:
                start_idx -= 1
            end_idx = peak_idx
            while end_idx < len(hip_zs) - 1 and hip_zs[end_idx + 1][1] >= rest_z - 0.06:
                end_idx += 1
            max_span = max(8, int(round(0.54 * scene_fps)))
            if end_idx - start_idx > max_span:
                end_idx = min(len(hip_zs) - 1, start_idx + max_span)
            sample_start = hip_zs[start_idx][0]
            sample_end = max(sample_start + 4, hip_zs[end_idx][0])
        else:
            mid = int((f_start_i + f_end_i) * 0.48)
            half_span = int(MAX_JUMP_DURATION_S * scene_fps * 0.5)
            sample_start = max(f_start_i, mid - half_span)
            sample_end = min(f_end_i, sample_start + int(MAX_JUMP_DURATION_S * scene_fps))

    dst_bones = {b.name for b in target_armature.data.bones}
    bone_map: dict[str, str] = {}
    rev_bone_map: dict[str, str] = {}
    for sb in src_arm.data.bones:
        mapped = _map_bone_name(sb.name, dst_bones)
        if mapped:
            bone_map[sb.name] = mapped
            rev_bone_map[mapped] = sb.name

    # Topological parent-first traversal order on target_armature for exact rest-basis retargeting
    dst_ordered_bones: list[bpy.types.Bone] = []
    dst_rest_rel: dict[str, Matrix] = {}

    def _collect_bone_tree(bone: bpy.types.Bone) -> None:
        dst_ordered_bones.append(bone)
        if bone.parent:
            dst_rest_rel[bone.name] = bone.parent.matrix_local.to_3x3().inverted() @ bone.matrix_local.to_3x3()
        else:
            dst_rest_rel[bone.name] = bone.matrix_local.to_3x3().copy()
        for child in bone.children:
            _collect_bone_tree(child)

    for root_bone in [b for b in target_armature.data.bones if not b.parent]:
        _collect_bone_tree(root_bone)

    # Character-space basis alignment: use armature matrix_local (excludes soldier_root 180° Z flip)
    r_src_arm_local = src_arm.matrix_local.to_3x3().normalized()
    r_dst_arm_local_inv = target_armature.matrix_local.to_3x3().normalized().inverted()
    arm_basis_xfer = r_dst_arm_local_inv @ r_src_arm_local

    hips_name = _resolve_bone_name(target_armature, HIPS_BONE_CANDIDATES)

    # Determine which local axis of Hips corresponds to Blender World Z (vertical bounce/crouch/prone drop)
    vertical_local_axis = 1
    if hips_name:
        hips_bone = target_armature.data.bones[hips_name]
        hips_world_r = target_armature.matrix_world.to_3x3().normalized() @ hips_bone.matrix_local.to_3x3().normalized()
        world_z_in_local = hips_world_r.inverted() @ Vector((0.0, 0.0, 1.0))
        vertical_local_axis = max(range(3), key=lambda idx: abs(world_z_in_local[idx]))

    action = bpy.data.actions.new(name=clip_name)
    target_armature.animation_data_create()
    target_armature.animation_data.action = action

    # Compute uniform scale ratio between source clip armature & target armature for hip location
    hip_scale = 1.0
    if src_hips and hips_name:
        s_h = (src_arm.matrix_world @ src_arm.data.bones[src_hips].head_local).z
        t_h = (target_armature.matrix_world @ target_armature.data.bones[hips_name].head_local).z
        if abs(s_h) > 1e-4:
            hip_scale = abs(t_h / s_h)

    scene = bpy.context.scene
    scene.render.fps = scene_fps
    src_frames = list(range(sample_start, sample_end + 1))

    # Pre-sample raw Hips locations so we can cleanly eliminate planar root drift
    raw_hip_locs: list[Vector] = []
    if hips_name and src_hips:
        for src_f in src_frames:
            scene.frame_set(src_f)
            bpy.context.view_layer.update()
            raw_hip_locs.append(Vector(src_arm.pose.bones[src_hips].location) * hip_scale)

    base_hip_loc: Vector | None = raw_hip_locs[0].copy() if raw_hip_locs else None
    end_hip_loc: Vector | None = raw_hip_locs[-1].copy() if raw_hip_locs else None
    mean_hip_planar: Vector | None = None
    if raw_hip_locs:
        mean_hip_planar = Vector((0.0, 0.0, 0.0))
        n_locs = float(len(raw_hip_locs))
        for idx_l, lv in enumerate(raw_hip_locs):
            alpha_l = idx_l / float(max(1, len(raw_hip_locs) - 1))
            adj = lv - (end_hip_loc - base_hip_loc) * alpha_l
            mean_hip_planar += adj
        mean_hip_planar /= n_locs

    first_frame_quats: dict[str, Quaternion] = {}
    prev_frame_quats: dict[str, Quaternion] = {}
    first_frame_locs: dict[str, tuple[float, ...]] = {}
    total_steps = max(1, len(src_frames) - 1)
    out_frame = 1
    keep_organic_sway = clip_name in ("prone_move", "run", "crouch_forward", "crouch_backward", "crouch_left", "crouch_right")

    for idx, src_f in enumerate(src_frames):
        scene.frame_set(src_f)
        bpy.context.view_layer.update()

        # Retarget every bone by matching armature-space orientation (handles A-pose vs T-pose rest mismatch)
        dst_arm_pose_r: dict[str, Matrix] = {}
        for bone in dst_ordered_bones:
            t_name = bone.name
            s_name = rev_bone_map.get(t_name)
            p_pose = dst_arm_pose_r[bone.parent.name] if bone.parent else Matrix.Identity(3)
            rest_rel = dst_rest_rel[t_name]

            if s_name is None:
                dst_arm_pose_r[t_name] = p_pose @ rest_rel
                continue

            spb = src_arm.pose.bones[s_name]
            desired_r = arm_basis_xfer @ spb.matrix.to_3x3().normalized()
            local_r = (p_pose @ rest_rel).inverted() @ desired_r
            q = local_r.to_quaternion().normalized()
            prev_q = prev_frame_quats.get(t_name)
            if prev_q is not None and q.dot(prev_q) < 0.0:
                q = -q
            prev_frame_quats[t_name] = q.copy()
            dst_arm_pose_r[t_name] = desired_r

            tpb = target_armature.pose.bones[t_name]
            tpb.rotation_mode = "QUATERNION"
            tpb.rotation_quaternion = q
            tpb.keyframe_insert(data_path="rotation_quaternion", frame=out_frame)
            if out_frame == 1:
                first_frame_quats[t_name] = q.copy()

            if t_name == hips_name and base_hip_loc is not None and end_hip_loc is not None:
                loc = raw_hip_locs[idx].copy()
                if keep_organic_sway:
                    # Preserve natural stride/crawl hip weight transfer while zeroing linear drift & centering over capsule
                    alpha = idx / float(total_steps)
                    for ax in range(3):
                        if ax != vertical_local_axis:
                            linear_drift = (end_hip_loc[ax] - base_hip_loc[ax]) * alpha
                            center_off = mean_hip_planar[ax] if mean_hip_planar is not None else 0.0
                            loc[ax] = loc[ax] - linear_drift - center_off
                else:
                    # Enforce strict In-Place: zero horizontal planar drift while keeping vertical bounce
                    for ax in range(3):
                        if ax != vertical_local_axis:
                            loc[ax] = 0.0
                tpb.location = loc
                tpb.keyframe_insert(data_path="location", frame=out_frame)
                if out_frame == 1:
                    first_frame_locs[t_name] = tuple(loc)

        out_frame += 1

    # Enforce seamless loop closure on cyclic clips (keeping shortest-arc quaternion sign)
    if clip_name in CYCLIC_CLIPS and out_frame > 2:
        last_f = out_frame - 1
        for t_name, q0 in first_frame_quats.items():
            q_close = q0.copy()
            prev_q = prev_frame_quats.get(t_name)
            if prev_q is not None and q_close.dot(prev_q) < 0.0:
                q_close = -q_close
            tpb = target_armature.pose.bones[t_name]
            tpb.rotation_quaternion = q_close
            tpb.keyframe_insert(data_path="rotation_quaternion", frame=last_f)
        if hips_name and hips_name in first_frame_locs:
            tpb = target_armature.pose.bones[hips_name]
            tpb.location = first_frame_locs[hips_name]
            tpb.keyframe_insert(data_path="location", frame=last_f)

    # Clean up temporary imported animation objects & actions
    for o in imported:
        bpy.data.objects.remove(o, do_unlink=True)
    if src_action and src_action != action and src_action.name in bpy.data.actions:
        bpy.data.actions.remove(src_action)

    return action


def _push_actions_to_nla(armature: bpy.types.Object, actions: list[bpy.types.Action]) -> None:
    armature.animation_data_create()
    armature.animation_data.action = None
    for track in list(armature.animation_data.nla_tracks):
        armature.animation_data.nla_tracks.remove(track)

    for act in actions:
        track = armature.animation_data.nla_tracks.new()
        track.name = act.name
        start_f = int(round(act.frame_range[0]))
        strip = track.strips.new(name=act.name, start=start_f, action=act)
        if hasattr(strip, "action_slot") and hasattr(act, "slots") and len(act.slots) > 0:
            strip.action_slot = act.slots[0]
        strip.action_frame_start = act.frame_range[0]
        strip.action_frame_end = act.frame_range[1]
        strip.name = act.name


def _upgrade_mesh_from_prep_glb(
    armature: bpy.types.Object,
    base_meshes: list[bpy.types.Object],
    prep_glb_path: Path,
) -> list[bpy.types.Object]:
    """Replace 18k decimated mesh with higher-detail prep GLB mesh via DataTransfer bone weights."""
    if not prep_glb_path or not prep_glb_path.is_file() or not base_meshes:
        return base_meshes
    src_mesh = base_meshes[0]
    src_tris = sum(max(1, len(p.vertices) - 2) for p in src_mesh.data.polygons)

    armature.data.pose_position = "REST"
    bpy.context.view_layer.update()

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(prep_glb_path))
    imported = [o for o in bpy.data.objects if o not in before]
    hi_candidates = [o for o in imported if o.type == "MESH"]
    if not hi_candidates:
        for o in imported:
            bpy.data.objects.remove(o, do_unlink=True)
        return base_meshes

    hi_mesh = hi_candidates[0]
    hi_tris = sum(max(1, len(p.vertices) - 2) for p in hi_mesh.data.polygons)
    if hi_tris <= src_tris:
        for o in imported:
            bpy.data.objects.remove(o, do_unlink=True)
        armature.data.pose_position = "POSE"
        return base_meshes

    # Detach GLB hierarchy keeping world alignment and transform into armature local space
    bpy.ops.object.select_all(action="DESELECT")
    hi_mesh.select_set(True)
    bpy.context.view_layer.objects.active = hi_mesh
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in imported:
        if o != hi_mesh:
            bpy.data.objects.remove(o, do_unlink=True)

    inv_arm = armature.matrix_world.inverted()
    hi_mesh.parent = armature
    hi_mesh.matrix_parent_inverse.identity()
    hi_mesh.location = (0.0, 0.0, 0.0)
    hi_mesh.rotation_euler = (0.0, 0.0, 0.0)
    hi_mesh.scale = (1.0, 1.0, 1.0)
    for v in hi_mesh.data.vertices:
        v.co = inv_arm @ v.co
    hi_mesh.data.update()

    # Copy all Mixamo bone vertex groups & transfer interpolated weights cleanly in REST space
    hi_mesh.vertex_groups.clear()
    for vg in src_mesh.vertex_groups:
        hi_mesh.vertex_groups.new(name=vg.name)

    dt_mod = hi_mesh.modifiers.new(name="WeightTransfer", type="DATA_TRANSFER")
    dt_mod.object = src_mesh
    dt_mod.use_vert_data = True
    dt_mod.data_types_verts = {"VGROUP_WEIGHTS"}
    dt_mod.vert_mapping = "POLYINTERP_NEAREST"

    bpy.ops.object.select_all(action="DESELECT")
    hi_mesh.select_set(True)
    bpy.context.view_layer.objects.active = hi_mesh
    bpy.ops.object.modifier_apply(modifier=dt_mod.name)

    arm_mod = hi_mesh.modifiers.new(name="Armature", type="ARMATURE")
    arm_mod.object = armature
    hi_mesh.name = src_mesh.name
    hi_mesh.data.name = src_mesh.data.name

    for old in base_meshes:
        bpy.data.objects.remove(old, do_unlink=True)
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)

    armature.data.pose_position = "POSE"
    bpy.context.view_layer.update()
    print(f"[OK] Upgraded SWAT mesh sharpness: {src_tris:,} -> {hi_tris:,} tris from {prep_glb_path.name}")
    return [hi_mesh]


def _is_arm_rifle_bone(bone_name: str) -> bool:
    low = bone_name.split(":")[-1].lower()
    if low in ARM_RIFLE_BONE_KEYS:
        return True
    return any(tok in low for tok in ("thumb", "index", "middle", "ring", "pinky"))


def _is_upper_rifle_bone(bone_name: str) -> bool:
    low = bone_name.split(":")[-1].lower()
    if low in UPPER_RIFLE_BONE_KEYS:
        return True
    return any(tok in low for tok in ("thumb", "index", "middle", "ring", "pinky"))


def _assign_action(armature: bpy.types.Object, action: bpy.types.Action | None) -> None:
    armature.animation_data_create()
    armature.animation_data.action = action
    if action and hasattr(armature.animation_data, "action_slot") and getattr(action, "slots", None):
        armature.animation_data.action_slot = action.slots[0]


def _collect_armature_tree(armature: bpy.types.Object) -> tuple[list[bpy.types.Bone], dict[str, Matrix]]:
    ordered: list[bpy.types.Bone] = []
    rest_rel: dict[str, Matrix] = {}

    def _walk(bone: bpy.types.Bone) -> None:
        ordered.append(bone)
        if bone.parent:
            rest_rel[bone.name] = bone.parent.matrix_local.to_3x3().inverted() @ bone.matrix_local.to_3x3()
        else:
            rest_rel[bone.name] = bone.matrix_local.to_3x3().copy()
        for ch in bone.children:
            _walk(ch)

    for rb in [b for b in armature.data.bones if not b.parent]:
        _walk(rb)
    return ordered, rest_rel


def _sample_idle_arm_targets(
    idle_act: bpy.types.Action,
    armature: bpy.types.Object,
) -> dict[str, Quaternion]:
    """Sample character-space (armature-space) arm & hand orientations from frame-1 of idle."""
    _assign_action(armature, idle_act)
    bpy.context.scene.frame_set(int(round(idle_act.frame_range[0])))
    bpy.context.view_layer.update()
    targets: dict[str, Quaternion] = {}
    for pb in armature.pose.bones:
        if _is_arm_rifle_bone(pb.name):
            targets[pb.name] = pb.matrix.to_3x3().normalized().to_quaternion()
    _assign_action(armature, None)
    return targets


def _stabilize_clip_rifle_hold(
    clip_act: bpy.types.Action,
    idle_arm_targets: dict[str, Quaternion],
    armature: bpy.types.Object,
    blend_weight: float,
    cyclic: bool = True,
) -> None:
    """Blend shoulder/arm/hand orientations in armature space toward tactical combat-ready rifle hold.

    Keeps lower body, hips, and spine torso sway 100% intact while pulling splayed/crossed elbows
    back into a shoulder-welded two-hand rifle grip pointing straight ahead.
    """
    if not clip_act or not idle_arm_targets or blend_weight <= 0.0:
        return
    ordered_bones, rest_rel = _collect_armature_tree(armature)
    f_start = int(round(clip_act.frame_range[0]))
    f_end = max(f_start + 1, int(round(clip_act.frame_range[1])))
    _assign_action(armature, clip_act)

    # Pre-sample original armature-space pose rotations across all frames before mutating keyframes
    frame_arm_quats: list[dict[str, Quaternion]] = []
    for f in range(f_start, f_end + 1):
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        snap = {pb.name: pb.matrix.to_3x3().normalized().to_quaternion() for pb in armature.pose.bones}
        frame_arm_quats.append(snap)

    prev_local_q: dict[str, Quaternion] = {}
    first_local_q: dict[str, Quaternion] = {}

    for idx, f in enumerate(range(f_start, f_end + 1)):
        src_quats = frame_arm_quats[idx]
        arm_pose_r: dict[str, Matrix] = {}
        for bone in ordered_bones:
            b_name = bone.name
            p_r = arm_pose_r[bone.parent.name] if bone.parent else Matrix.Identity(3)
            q_orig = src_quats[b_name]

            if b_name not in idle_arm_targets:
                arm_pose_r[b_name] = q_orig.to_matrix()
                continue

            q_tgt = idle_arm_targets[b_name].copy()
            if q_orig.dot(q_tgt) < 0.0:
                q_tgt = -q_tgt
            # Shoulders blend slightly gentler than forearms/hands so natural stride sway stays organic
            short = b_name.split(":")[-1].lower()
            w = blend_weight * 0.72 if "shoulder" in short else blend_weight
            q_blend = q_orig.slerp(q_tgt, w).normalized()
            arm_pose_r[b_name] = q_blend.to_matrix()

            local_r = (p_r @ rest_rel[b_name]).inverted() @ arm_pose_r[b_name]
            q_loc = local_r.to_quaternion().normalized()
            pq = prev_local_q.get(b_name)
            if pq is not None and q_loc.dot(pq) < 0.0:
                q_loc = -q_loc
            prev_local_q[b_name] = q_loc.copy()
            if idx == 0:
                first_local_q[b_name] = q_loc.copy()

            pb = armature.pose.bones[b_name]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = q_loc
            pb.keyframe_insert(data_path="rotation_quaternion", frame=f)

    if cyclic and f_end > f_start:
        for b_name, q0 in first_local_q.items():
            q_close = q0.copy()
            pq = prev_local_q.get(b_name)
            if pq is not None and q_close.dot(pq) < 0.0:
                q_close = -q_close
            pb = armature.pose.bones[b_name]
            pb.rotation_quaternion = q_close
            pb.keyframe_insert(data_path="rotation_quaternion", frame=f_end)

    _assign_action(armature, None)


def _build_tactical_crouch_idle_from_walk(
    walk_fwd_act: bpy.types.Action,
    armature: bpy.types.Object,
    scene_fps: int,
) -> bpy.types.Action:
    """Build a height-balanced tactical crouch idle (hipZ ~0.66m, headZ ~1.05m) from crouch walk.

    Matches the 4 directional walk_crouching_* clips (+24cm vs kneeling crouch.fbx) so starting
    and stopping movement has zero vertical pop and aligns with hitreg crouch head height (1.08m).
    """
    import math

    _assign_action(armature, walk_fwd_act)
    f0 = int(round(walk_fwd_act.frame_range[0]))
    f1 = max(f0 + 1, int(round(walk_fwd_act.frame_range[1])))
    lf_name = _resolve_bone_name(armature, ("mixamorig:LeftFoot", "LeftFoot"))
    rf_name = _resolve_bone_name(armature, ("mixamorig:RightFoot", "RightFoot"))
    hips_name = _resolve_bone_name(armature, HIPS_BONE_CANDIDATES)
    spine1_name = _resolve_bone_name(armature, ("mixamorig:Spine1", "Spine1"))
    spine2_name = _resolve_bone_name(armature, ("mixamorig:Spine2", "Spine2"))
    head_name = _resolve_bone_name(armature, HEAD_BONE_CANDIDATES)

    # Pick the frame with both feet most squarely planted on the ground
    best_frame = f0
    best_score = 1e9
    if lf_name and rf_name:
        for f in range(f0, f1 + 1):
            bpy.context.scene.frame_set(f)
            bpy.context.view_layer.update()
            lz = (armature.matrix_world @ armature.pose.bones[lf_name].head).z
            rz = (armature.matrix_world @ armature.pose.bones[rf_name].head).z
            score = max(lz, rz) + abs(lz - rz) * 0.5
            if score < best_score:
                best_score = score
                best_frame = f

    bpy.context.scene.frame_set(best_frame)
    bpy.context.view_layer.update()
    base_quats = {pb.name: pb.rotation_quaternion.copy() for pb in armature.pose.bones}
    base_hips_loc = armature.pose.bones[hips_name].location.copy() if hips_name else Vector((0.0, 0.0, 0.0))

    vertical_axis = 1
    if hips_name:
        hb = armature.data.bones[hips_name]
        hb_world_r = armature.matrix_world.to_3x3().normalized() @ hb.matrix_local.to_3x3().normalized()
        vz = hb_world_r.inverted() @ Vector((0.0, 0.0, 1.0))
        vertical_axis = max(range(3), key=lambda ax: abs(vz[ax]))

    # Remove old kneeling crouch action if present so NLA carries a single canonical 'crouch' clip
    old_crouch = bpy.data.actions.get("crouch")
    if old_crouch:
        bpy.data.actions.remove(old_crouch)

    out_act = bpy.data.actions.new(name="crouch")
    _assign_action(armature, out_act)
    total_frames = max(31, int(round(2.0 * scene_fps)) + 1)  # 61 frames @ 30fps (2.0s breathing cycle)

    for idx in range(total_frames):
        f = idx + 1
        t = idx / float(total_frames - 1) if total_frames > 1 else 0.0
        phase = t * math.pi * 2.0
        breath = math.sin(phase)

        for b_name, q0 in base_quats.items():
            pb = armature.pose.bones[b_name]
            pb.rotation_mode = "QUATERNION"
            q = q0.copy()
            if b_name == spine1_name:
                q = (q @ Euler((breath * 0.008, 0.0, 0.0), "XYZ").to_quaternion()).normalized()
            elif b_name == spine2_name:
                q = (q @ Euler((breath * 0.015, 0.0, 0.0), "XYZ").to_quaternion()).normalized()
            elif b_name == head_name:
                q = (q @ Euler((-breath * 0.012, 0.0, 0.0), "XYZ").to_quaternion()).normalized()
            pb.rotation_quaternion = q
            pb.keyframe_insert(data_path="rotation_quaternion", frame=f)

            if b_name == hips_name:
                loc = base_hips_loc.copy()
                # Keep pelvis centered horizontally over capsule while breathing subtly vertically
                for ax in range(3):
                    if ax != vertical_axis:
                        loc[ax] = 0.0
                loc[vertical_axis] += breath * 0.005
                pb.location = loc
                pb.keyframe_insert(data_path="location", frame=f)

    _assign_action(armature, None)
    return out_act


def _write_bundle_js(glb_path: Path, bundle_path: Path) -> None:
    glb_bytes = glb_path.read_bytes()
    b64 = base64.b64encode(glb_bytes).decode("ascii")
    payload = (
        "// Auto-generated by scripts/blender/build_fsb_anims.py\n"
        "window.FPS_MODELS = window.FPS_MODELS || {};\n"
        f'window.FPS_MODELS["soldier"] = "{b64}";\n'
    )
    bundle_path.parent.mkdir(parents=True, exist_ok=True)
    bundle_path.write_text(payload, encoding="utf-8")


def _print_glb_verification(glb_path: Path) -> None:
    import json

    raw = glb_path.read_bytes()
    magic, version, _ = struct.unpack_from("<III", raw, 0)
    json_len, _ = struct.unpack_from("<II", raw, 12)
    gltf = json.loads(raw[20 : 20 + json_len].decode("utf-8"))
    skins = gltf.get("skins", [])
    anims = [a.get("name") for a in gltf.get("animations", [])]
    nodes = [n.get("name") for n in gltf.get("nodes", [])]
    print("=== EXPORTED SOLDIER GLB VERIFICATION ===")
    print(f"GLB size         : {len(raw):,} B ({len(raw) / (1024 * 1024):.2f} MB)")
    print(f"Extensions req   : {gltf.get('extensionsRequired', [])}")
    print(f"Skins / Joints   : {len(skins)} skins, {len(skins[0]['joints']) if skins else 0} joints")
    print(f"Animation clips  : {anims}")
    print(f"Has weapon_mount : {'weapon_mount' in nodes}")
    print(f"Materials        : {[m.get('name') for m in gltf.get('materials', [])]}")


def main() -> int:
    args = _parse_args(sys.argv)
    if not args.anims_dir.is_dir():
        raise FileNotFoundError(
            f"Animation folder not found: {args.anims_dir}\n"
            "Upload model/assets/fsb_ready_for_rig.fbx to Mixamo/AccuRIG and save idle/run/crouch/jump FBX files there."
        )

    base_path = _find_asset_file(args.anims_dir, BASE_ALIASES)
    if base_path is None:
        raise FileNotFoundError(
            f"No rigged base character (e.g. idle.fbx or base_rigged.fbx) found in {args.anims_dir}"
        )

    bpy.ops.wm.read_factory_settings(use_empty=True)
    base_objs = _import_asset(base_path)
    armatures = [o for o in base_objs if o.type == "ARMATURE"]
    meshes = [o for o in base_objs if o.type == "MESH"]
    if not armatures or not meshes:
        raise RuntimeError(f"Base rigged file {base_path} must contain both an Armature and SkinnedMesh")

    armature = armatures[0]
    _normalize_rig_transform(armature, meshes)
    meshes = _upgrade_mesh_from_prep_glb(armature, meshes, args.prep_glb)
    _restore_pbr_textures(meshes, args.tex_dir, args.tex_size)

    # Wrap in soldier_root rotated 180 deg around Z (Blender) -> faces -Z in Three.js
    soldier_root = bpy.data.objects.new("soldier_root", None)
    soldier_root.rotation_euler = Euler((0.0, 0.0, 3.141592653589793), "XYZ")
    bpy.context.scene.collection.objects.link(soldier_root)
    armature.parent = soldier_root

    _attach_socket_and_team_patches(armature, soldier_root)

    # Clear any temporary action from base file before baking the 4 canonical clips
    if armature.animation_data and armature.animation_data.action:
        old_act = armature.animation_data.action
        armature.animation_data.action = None
        bpy.data.actions.remove(old_act)

    built_actions: list[bpy.types.Action] = []
    built_map: dict[str, bpy.types.Action] = {}
    for clip_name, aliases in CLIP_ALIASES.items():
        excl = CLIP_EXCLUDE_TOKENS.get(clip_name, ())
        clip_path = _find_asset_file(args.anims_dir, aliases, exclude_tokens=excl)
        if clip_path is None:
            print(f"[WARN] Clip '{clip_name}' not found in {args.anims_dir}; skipping.")
            continue
        act = _extract_action_for_clip(clip_name, clip_path, armature, args.fps)
        built_actions.append(act)
        built_map[clip_name] = act
        print(f"[OK] Built clip '{clip_name}' from {clip_path.name} ({int(act.frame_range[1])} frames)")

    # Stabilize arms/hands in armature space toward tactical combat-ready shoulder weld on moving clips
    if "idle" in built_map:
        idle_arm_targets = _sample_idle_arm_targets(built_map["idle"], armature)
        if "run" in built_map:
            _stabilize_clip_rifle_hold(built_map["run"], idle_arm_targets, armature, blend_weight=0.55, cyclic=True)
            print("[OK] Stabilized 'run' upper-limb rifle hold toward combat-ready shoulder weld")
        for c_key, w_blend in (
            ("crouch_forward", 0.82),
            ("crouch_backward", 0.72),
            ("crouch_left", 0.68),
            ("crouch_right", 0.75),
        ):
            if c_key in built_map:
                _stabilize_clip_rifle_hold(built_map[c_key], idle_arm_targets, armature, blend_weight=w_blend, cyclic=True)
                print(f"[OK] Stabilized '{c_key}' tactical shoulder-welded rifle hold (w={w_blend})")

    # Build height-balanced tactical crouch idle (+24cm vs kneeling crouch.fbx -> matches 4 crouch walks)
    if "crouch_forward" in built_map:
        old_crouch = built_map.get("crouch")
        if old_crouch and old_crouch in built_actions:
            built_actions.remove(old_crouch)
        tactical_crouch = _build_tactical_crouch_idle_from_walk(built_map["crouch_forward"], armature, args.fps)
        built_actions.append(tactical_crouch)
        built_map["crouch"] = tactical_crouch
        print(
            f"[OK] Built height-balanced tactical 'crouch' idle from 'crouch_forward' ({int(tactical_crouch.frame_range[1])} frames)"
        )
    elif "crouch" in built_map and "idle" in built_map:
        idle_arm_targets = _sample_idle_arm_targets(built_map["idle"], armature)
        _stabilize_clip_rifle_hold(built_map["crouch"], idle_arm_targets, armature, blend_weight=0.80, cyclic=True)
        print("[OK] Stabilized fallback 'crouch' rifle hold from 'idle'")

    if not built_actions:
        raise RuntimeError(f"No animation clips found in {args.anims_dir} (need idle/run/crouch/jump)")

    _push_actions_to_nla(armature, built_actions)

    # Select soldier_root hierarchy for clean GLB export without Draco
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.context.scene.objects:
        o.select_set(True)

    args.out_glb.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(args.out_glb),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_nla_strips=True,
        export_animation_mode="NLA_TRACKS",
        export_draco_mesh_compression_enable=False,
        export_skins=True,
        export_materials="EXPORT",
    )

    _write_bundle_js(args.out_glb, args.out_bundle)
    _print_glb_verification(args.out_glb)
    print(f"Bundle written   : {args.out_bundle}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
