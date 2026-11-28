"""Preprocess static high-poly fsbfor_games.glb for Mixamo / AccuRIG auto-rigging.

Usage (Blender 4.2+ background):
    blender --background --python scripts/blender/prep_fsb_for_rig.py -- \
        --input fsbfor_games.glb \
        --out-fbx model/assets/fsb_ready_for_rig.fbx \
        --out-glb model/assets/fsb_ready_for_rig.glb \
        --tex-dir model/assets/fsb_textures \
        --target-tris 18000 \
        --tex-size 1024
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Vector

TARGET_HEIGHT_M = 1.76


def _parse_args(argv: list[str]) -> argparse.Namespace:
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Optimize & normalize fsbfor_games.glb for auto-rigging")
    parser.add_argument("--input", type=Path, default=repo_root / "fsbfor_games.glb")
    parser.add_argument("--out-fbx", type=Path, default=repo_root / "model" / "assets" / "fsb_ready_for_rig.fbx")
    parser.add_argument("--out-glb", type=Path, default=repo_root / "model" / "assets" / "fsb_ready_for_rig.glb")
    parser.add_argument("--tex-dir", type=Path, default=repo_root / "model" / "assets" / "fsb_textures")
    parser.add_argument("--target-tris", type=int, default=28000)
    parser.add_argument("--tex-size", type=int, default=1024)
    parser.add_argument("--merge-dist", type=float, default=0.00015)
    return parser.parse_args(argv)


def _compute_world_bounds(mesh_objs: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in mesh_objs:
        mat = obj.matrix_world
        for v in obj.data.vertices:
            w = mat @ v.co
            lo.x = min(lo.x, w.x)
            lo.y = min(lo.y, w.y)
            lo.z = min(lo.z, w.z)
            hi.x = max(hi.x, w.x)
            hi.y = max(hi.y, w.y)
            hi.z = max(hi.z, w.z)
    return lo, hi


def _clear_parent_keep_transform(objs: list[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def _join_meshes(mesh_objs: list[bpy.types.Object]) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objs[0]
    if len(mesh_objs) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = "FSB_Soldier"
    joined.data.name = "FSB_Soldier_Mesh"
    return joined


def _remove_empty_ancestors(keep_obj: bpy.types.Object) -> None:
    for obj in list(bpy.data.objects):
        if obj != keep_obj:
            bpy.data.objects.remove(obj, do_unlink=True)


def _normalize_uv_layers(obj: bpy.types.Object) -> None:
    uv_layers = obj.data.uv_layers
    if not uv_layers:
        return
    while len(uv_layers) > 1:
        uv_layers.remove(uv_layers[len(uv_layers) - 1])
    primary = uv_layers[0]
    primary.name = "UVMap"
    uv_layers.active = primary


def _normalize_scale_and_origin(obj: bpy.types.Object, target_height: float) -> float:
    lo, hi = _compute_world_bounds([obj])
    raw_h = max(1e-6, hi.z - lo.z)
    scale_factor = target_height / raw_h
    center_x = (lo.x + hi.x) * 0.5
    center_y = (lo.y + hi.y) * 0.5

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for v in bm.verts:
        v.co.x = (v.co.x - center_x) * scale_factor
        v.co.y = (v.co.y - center_y) * scale_factor
        v.co.z = (v.co.z - lo.z) * scale_factor
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return scale_factor


def _weld_seam_doubles(obj: bpy.types.Object, merge_dist: float) -> tuple[int, int]:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    before_verts = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=merge_dist)
    after_verts = len(bm.verts)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return before_verts, after_verts


def _decimate_mesh(obj: bpy.types.Object, target_tris: int) -> tuple[int, int]:
    # Ensure triangles count is computed accurately
    before_tris = sum(max(1, len(p.vertices) - 2) for p in obj.data.polygons)
    if before_tris <= target_tris:
        return before_tris, before_tris

    ratio = max(0.005, min(1.0, float(target_tris) / float(before_tris)))
    mod = obj.modifiers.new(name="FSB_Decimate", type="DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)

    after_tris = sum(max(1, len(p.vertices) - 2) for p in obj.data.polygons)
    return before_tris, after_tris


def _optimize_materials_and_textures(
    obj: bpy.types.Object, tex_size: int, tex_dir: Path
) -> dict[str, str]:
    tex_dir.mkdir(parents=True, exist_ok=True)
    saved_paths: dict[str, str] = {}

    if not obj.data.materials:
        return saved_paths

    mat = obj.data.materials[0]
    mat.name = "FSB_Operator_PBR"
    if not mat.use_nodes or not mat.node_tree:
        return saved_paths

    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)

    # Point any UVMAP helper nodes to the single consolidated UVMap
    for node in list(nt.nodes):
        if node.type == "UVMAP":
            node.uv_map = "UVMap"

    role_filenames = {
        "basecolor": "fsb_basecolor.png",
        "mr": "fsb_mr.png",
        "normal": "fsb_normal.png",
    }

    for node in list(nt.nodes):
        if node.type != "TEX_IMAGE" or not node.image:
            continue
        img = node.image
        # Identify texture role by downstream link
        out_targets = [lnk.to_node.type + ":" + lnk.to_socket.name for out in node.outputs for lnk in out.links]
        role = "basecolor"
        if any("SEPARATE" in t or "Roughness" in t or "Metallic" in t for t in out_targets):
            role = "mr"
        elif any("NORMAL" in t for t in out_targets):
            role = "normal"

        if img.size[0] != tex_size or img.size[1] != tex_size:
            img.scale(tex_size, tex_size)

        out_path = tex_dir / role_filenames[role]
        prev_colorspace = img.colorspace_settings.name
        img.filepath_raw = str(out_path)
        img.file_format = "PNG"
        img.save()

        # Replace packed 4K image datablock with freshly loaded resized PNG
        new_img = bpy.data.images.load(str(out_path), check_existing=False)
        new_img.name = f"fsb_{role}"
        new_img.colorspace_settings.name = prev_colorspace
        new_img.pack()
        node.image = new_img
        if img != new_img and img.users == 0:
            bpy.data.images.remove(img)
        saved_paths[role] = str(out_path)

    if bsdf and "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.5

    return saved_paths


def main() -> int:
    args = _parse_args(sys.argv)
    if not args.input.is_file():
        raise FileNotFoundError(f"Input GLB not found: {args.input}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input))

    mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not mesh_objs:
        raise RuntimeError(f"No mesh objects imported from {args.input}")

    _clear_parent_keep_transform(mesh_objs)
    obj = _join_meshes(mesh_objs)
    _remove_empty_ancestors(obj)
    _normalize_uv_layers(obj)

    scale_factor = _normalize_scale_and_origin(obj, TARGET_HEIGHT_M)
    v_before, v_after = _weld_seam_doubles(obj, args.merge_dist)
    tris_before, tris_after = _decimate_mesh(obj, args.target_tris)
    saved_textures = _optimize_materials_and_textures(obj, args.tex_size, args.tex_dir)

    # Smooth shading for clean silhouette after decimation
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth()

    lo, hi = _compute_world_bounds([obj])

    args.out_fbx.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=str(args.out_fbx),
        use_selection=True,
        apply_scale_options="FBX_SCALE_ALL",
        axis_forward="-Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
        mesh_smooth_type="FACE",
    )

    if args.out_glb:
        args.out_glb.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=str(args.out_glb),
            export_format="GLB",
            use_selection=True,
            export_draco_mesh_compression_enable=False,
        )

    fbx_mb = args.out_fbx.stat().st_size / (1024 * 1024)
    glb_mb = args.out_glb.stat().st_size / (1024 * 1024) if args.out_glb and args.out_glb.is_file() else 0.0
    print("=== FSB PREP SUMMARY ===")
    print(f"Scale factor applied : {scale_factor:.4f} (height -> {hi.z - lo.z:.4f} m, min_z={lo.z:.4f})")
    print(f"Seam weld vertices   : {v_before:,} -> {v_after:,}")
    print(f"Decimated triangles  : {tris_before:,} -> {tris_after:,}")
    print(f"UV layers remaining  : {[uv.name for uv in obj.data.uv_layers]}")
    print(f"Saved PBR textures   : {saved_textures}")
    print(f"Exported FBX         : {args.out_fbx} ({fbx_mb:.2f} MB)")
    if glb_mb > 0:
        print(f"Exported Preview GLB : {args.out_glb} ({glb_mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
