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
from mathutils import Euler, Matrix, Vector

TARGET_HEIGHT_M = 1.76
MAX_JUMP_DURATION_S = 0.72
MIN_JUMP_DURATION_S = 0.45

CLIP_ALIASES: dict[str, tuple[str, ...]] = {
    "idle": ("idle", "rifle_idle", "rifle idle", "standing_idle", "standing idle"),
    "run": ("run", "rifle_run", "rifle run", "sprint", "jog"),
    "crouch": ("crouch", "crouch_idle", "crouch idle", "crouching_idle", "crouching idle"),
    "jump": ("jump", "rifle_jump", "rifle jump", "jump_up", "jump up"),
    "prone": ("prone", "prone_idle", "prone idle", "rifle_prone", "rifle prone"),
    "prone_move": ("prone_move", "prone move", "prone_forward", "prone forward", "crawl", "crawling"),
}

CYCLIC_CLIPS: tuple[str, ...] = ("idle", "run", "crouch", "prone", "prone_move")

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

    for obj in meshes:
        if not obj.data.materials:
            mat = bpy.data.materials.new("FSB_Operator_PBR")
            obj.data.materials.append(mat)
        mat = obj.data.materials[0]
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
        mount.location = (0.0, 0.04, 0.0)
        mount.rotation_euler = Euler((0.0, 3.141592653589793 - 0.35, 0.0), "XYZ")
    else:
        mount.parent = root_empty
        mount.location = (0.105, 0.115, 1.26)

    # Shared TeamColor material overridden per team (A: #2F80FF, B: #FF4D2E, FFA: #8A8F98)
    team_mat = bpy.data.materials.new("TeamColor")
    team_mat.use_nodes = True
    bsdf = next(n for n in team_mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.184, 0.502, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.52
    bsdf.inputs["Metallic"].default_value = 0.08
    if "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (0.184, 0.502, 1.0, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 0.22

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
    bone_map = {}
    for sb in src_arm.data.bones:
        mapped = _map_bone_name(sb.name, dst_bones)
        if mapped:
            bone_map[sb.name] = mapped

    hips_name = _resolve_bone_name(target_armature, HIPS_BONE_CANDIDATES)

    # Determine which local axis of Hips corresponds to Blender World Z (vertical bounce)
    vertical_local_axis = 1
    if hips_name:
        hips_bone = target_armature.data.bones[hips_name]
        world_z_in_local = hips_bone.matrix_local.to_3x3().inverted() @ Vector((0.0, 0.0, 1.0))
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
    first_frame_quats: dict[str, tuple[float, ...]] = {}
    first_frame_locs: dict[str, tuple[float, ...]] = {}
    total_steps = max(1, len(src_frames) - 1)
    out_frame = 1

    for idx, src_f in enumerate(src_frames):
        scene.frame_set(src_f)
        bpy.context.view_layer.update()

        for s_name, t_name in bone_map.items():
            spb = src_arm.pose.bones[s_name]
            tpb = target_armature.pose.bones[t_name]
            tpb.rotation_mode = "QUATERNION"

            if spb.rotation_mode == "QUATERNION":
                q = tuple(spb.rotation_quaternion)
            else:
                q = tuple(spb.rotation_euler.to_quaternion())
            tpb.rotation_quaternion = q
            tpb.keyframe_insert(data_path="rotation_quaternion", frame=out_frame)
            if out_frame == 1:
                first_frame_quats[t_name] = q

            if t_name == hips_name and base_hip_loc is not None and end_hip_loc is not None:
                loc = raw_hip_locs[idx].copy()
                if clip_name == "prone_move":
                    # Preserve organic crawling body sway while canceling any linear planar travel
                    alpha = idx / float(total_steps)
                    for ax in range(3):
                        if ax != vertical_local_axis:
                            linear_drift = (end_hip_loc[ax] - base_hip_loc[ax]) * alpha
                            loc[ax] = loc[ax] - linear_drift
                else:
                    # Enforce strict In-Place: zero horizontal planar drift while keeping vertical bounce
                    for ax in range(3):
                        if ax != vertical_local_axis:
                            loc[ax] = base_hip_loc[ax]
                tpb.location = loc
                tpb.keyframe_insert(data_path="location", frame=out_frame)
                if out_frame == 1:
                    first_frame_locs[t_name] = tuple(loc)

        out_frame += 1

    # Enforce seamless loop closure on cyclic clips
    if clip_name in CYCLIC_CLIPS and out_frame > 2:
        last_f = out_frame - 1
        for t_name, q in first_frame_quats.items():
            tpb = target_armature.pose.bones[t_name]
            tpb.rotation_quaternion = q
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
    for clip_name, aliases in CLIP_ALIASES.items():
        excl = ("move", "crawl", "forward") if clip_name == "prone" else ()
        clip_path = _find_asset_file(args.anims_dir, aliases, exclude_tokens=excl)
        if clip_path is None:
            print(f"[WARN] Clip '{clip_name}' not found in {args.anims_dir}; skipping.")
            continue
        act = _extract_action_for_clip(clip_name, clip_path, armature, args.fps)
        built_actions.append(act)
        print(f"[OK] Built clip '{clip_name}' from {clip_path.name} ({int(act.frame_range[1])} frames)")

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
