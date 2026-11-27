"""External Sketchfab pistol (.glb) metric normalizer and weapon exporter."""

from __future__ import annotations

import copy
import io
import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from model.core import euler_xyz_to_quat, pack_glb, parse_glb, socket_euler_xyz

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ROOT_SOURCE_GLB = _REPO_ROOT / "pistol.glb"
_ASSET_SOURCE_GLB = _REPO_ROOT / "model" / "assets" / "pistol.glb"

DEFAULT_TEXTURE_SIZE = 512
_MIN_TEXTURE_SIZE = 64
_MAX_TEXTURE_SIZE = 2048

# Normalize the centimeter-scale Sketchfab M1911 (+Z forward) into viewmodel metric space (-Z forward).
_SOURCE_SCALE = 0.0078
_WORLD_OFFSET = np.array([0.0, -0.011, 0.018], dtype=np.float64)
_TRIGGER_PIVOT = (0.0, 0.0221, -0.0338)
_MUZZLE_POS = (0.0, 0.0482, -0.156)

# Narrow only the trigger-guard loop slightly along X toward the compact tactical silhouette while leaving
# clearance around trigger_pistol_0 (|x| <= 0.0045).
_GUARD_X_SCALE = 0.80

PISTOL_METADATA: dict[str, object] = {
    "weapon": "Pistol-M1911",
    "author": "DJMaesen",
    "license": "CC-BY-4.0",
    "sightY": 0.0662,
    "sightFrontZ": -0.140,
    "sightRearZ": 0.041,
    "slideBlowbackZ": 0.044,
    "slideLockZ": 0.042,
    "triggerPivot": list(_TRIGGER_PIVOT),
    "muzzlePos": list(_MUZZLE_POS),
    "magDropAxis": [0.0, -1.0, 0.32],
    "sockets": {
        "handguard": "socket_handguard",
        "grip": "socket_grip",
        "mag": "socket_mag",
        "slide": "socket_slide",
    },
}

_SOCKET_SPECS: tuple[tuple[str, tuple[float, float, float], tuple[float, float, float], tuple[float, float, float], bool], ...] = (
    (
        "socket_handguard",
        (-0.021, -0.031, 0.024),
        (-0.12, 0.02, -0.992),
        (0.92, 0.28, 0.26),
        False,
    ),
    (
        "socket_grip",
        (0.018, -0.025, 0.041),
        (0.08, -0.02, -0.996),
        (-0.96, 0.08, 0.25),
        True,
    ),
    (
        "socket_mag",
        (-0.014, -0.072, 0.040),
        (0.54, -0.18, -0.82),
        (0.78, 0.32, 0.54),
        False,
    ),
    (
        "socket_slide",
        (-0.016, 0.048, 0.015),
        (0.66, 0.06, -0.75),
        (0.35, -0.90, 0.26),
        False,
    ),
)

_SOURCE_MESH_PARTS: tuple[tuple[str, str, bool], ...] = (
    ("lower_pistol_0", "pistol_frame", True),
    ("mag_pistol_0", "pistol_mag_body", False),
    ("bullet_pistol_0", "pistol_bullet", False),
    ("bullet_1_pistol_0", "pistol_bullet_1", False),
    ("trigger_pistol_0", "pistol_trigger_shoe", False),
    ("slide_pistol_0", "pistol_slide_body", False),
)


def _validate_texture_size(texture_size: int) -> int:
    if isinstance(texture_size, bool) or not isinstance(texture_size, int):
        raise ValueError(f"texture_size must be an integer, got {texture_size!r}")
    if texture_size < _MIN_TEXTURE_SIZE or texture_size > _MAX_TEXTURE_SIZE or (texture_size & (texture_size - 1)) != 0:
        raise ValueError(
            f"texture_size must be a power of 2 in [{_MIN_TEXTURE_SIZE}, {_MAX_TEXTURE_SIZE}], got {texture_size}"
        )
    return texture_size


def _resolve_default_source_glb() -> Path:
    if _ROOT_SOURCE_GLB.is_file():
        return _ROOT_SOURCE_GLB
    if _ASSET_SOURCE_GLB.is_file():
        return _ASSET_SOURCE_GLB
    raise FileNotFoundError(
        f"Source pistol GLB not found at {_ROOT_SOURCE_GLB} or {_ASSET_SOURCE_GLB}"
    )


def _node_local_matrix(node: dict[str, Any]) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    mat = np.eye(4, dtype=np.float64)
    if "scale" in node:
        sx, sy, sz = node["scale"]
        mat = np.diag([float(sx), float(sy), float(sz), 1.0]) @ mat
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        rot = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0.0],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0.0],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        )
        mat = rot @ mat
    if "translation" in node:
        tx, ty, tz = node["translation"]
        tr = np.eye(4, dtype=np.float64)
        tr[:3, 3] = [float(tx), float(ty), float(tz)]
        mat = tr @ mat
    return mat


def _compute_world_matrices(gltf: dict[str, Any]) -> dict[int, np.ndarray]:
    nodes = gltf.get("nodes", [])
    scenes = gltf.get("scenes", [])
    if not nodes or not scenes:
        raise ValueError("Source pistol GLB missing nodes or scenes")
    scene_idx = int(gltf.get("scene", 0))
    world: dict[int, np.ndarray] = {}

    def walk(node_idx: int, parent: np.ndarray) -> None:
        mat = parent @ _node_local_matrix(nodes[node_idx])
        world[node_idx] = mat
        for child_idx in nodes[node_idx].get("children", []):
            walk(int(child_idx), mat)

    for root_idx in scenes[scene_idx].get("nodes", []):
        walk(int(root_idx), np.eye(4, dtype=np.float64))
    return world


def _accessor_slice(gltf: dict[str, Any], acc_idx: int) -> tuple[int, int, str]:
    acc = gltf["accessors"][acc_idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    offset = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    return offset, int(acc["count"]) * comps, acc["type"]


def _normalize_rows(vec: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vec, axis=1, keepdims=True)
    safe = np.where(norms > 1e-8, norms, 1.0)
    return (vec / safe).astype(np.float32)


def _shape_lower_guard_x(pos: np.ndarray) -> None:
    """Subtly refine only the lower trigger-guard bar along X while smoothly tapering into frame rails."""
    # Guard spans roughly z in [-0.068, -0.020], y in [-0.015, 0.018]. Apply smooth cosine taper for y in [0.006, 0.016].
    in_z = (pos[:, 2] >= -0.068) & (pos[:, 2] <= -0.022)
    in_y = pos[:, 1] <= 0.016
    mask = in_z & in_y
    if not np.any(mask):
        return
    y_sub = pos[mask, 1]
    taper = np.where(y_sub <= 0.006, 1.0, 0.5 * (1.0 + np.cos(math.pi * (y_sub - 0.006) / 0.010)))
    scale_x = 1.0 - (1.0 - _GUARD_X_SCALE) * taper
    pos[mask, 0] *= scale_x


def _transform_primitive_geometry(
    gltf: dict[str, Any],
    bin_buf: bytearray,
    prim: dict[str, Any],
    world_mat: np.ndarray,
    post_shift: tuple[float, float, float] | None = None,
    refine_guard: bool = False,
) -> None:
    """Bake source node world transform -> metric -Z forward in-place inside glTF vertex buffers."""
    metric_align = np.diag([-_SOURCE_SCALE, _SOURCE_SCALE, -_SOURCE_SCALE, 1.0])
    metric_align[:3, 3] = _WORLD_OFFSET
    total = metric_align @ world_mat
    rot_scaled = total[:3, :3]
    rot_unit = rot_scaled / _SOURCE_SCALE
    shift = total[:3, 3].copy()
    if post_shift is not None:
        shift += np.array(post_shift, dtype=np.float64)

    attrs = prim["attributes"]

    pos_idx = int(attrs["POSITION"])
    pos_off, pos_floats, _ = _accessor_slice(gltf, pos_idx)
    pos_arr = np.frombuffer(bin_buf, dtype="<f4", count=pos_floats, offset=pos_off).reshape(-1, 3).astype(np.float64)
    pos_out = pos_arr @ rot_scaled.T + shift
    if refine_guard:
        _shape_lower_guard_x(pos_out)
    pos_f32 = pos_out.astype("<f4")
    bin_buf[pos_off : pos_off + pos_f32.nbytes] = pos_f32.tobytes()
    gltf["accessors"][pos_idx]["min"] = [round(float(v), 6) for v in pos_f32.min(axis=0)]
    gltf["accessors"][pos_idx]["max"] = [round(float(v), 6) for v in pos_f32.max(axis=0)]

    if "NORMAL" in attrs:
        nrm_idx = int(attrs["NORMAL"])
        nrm_off, nrm_floats, _ = _accessor_slice(gltf, nrm_idx)
        nrm_arr = np.frombuffer(bin_buf, dtype="<f4", count=nrm_floats, offset=nrm_off).reshape(-1, 3).astype(np.float64)
        nrm_f32 = _normalize_rows(nrm_arr @ rot_unit.T).astype("<f4")
        bin_buf[nrm_off : nrm_off + nrm_f32.nbytes] = nrm_f32.tobytes()
        gltf["accessors"][nrm_idx]["min"] = [round(float(v), 6) for v in nrm_f32.min(axis=0)]
        gltf["accessors"][nrm_idx]["max"] = [round(float(v), 6) for v in nrm_f32.max(axis=0)]

    if "TANGENT" in attrs:
        tan_idx = int(attrs["TANGENT"])
        tan_off, tan_floats, _ = _accessor_slice(gltf, tan_idx)
        tan_arr = np.frombuffer(bin_buf, dtype="<f4", count=tan_floats, offset=tan_off).reshape(-1, 4).astype(np.float64)
        tan_xyz = _normalize_rows(tan_arr[:, :3] @ rot_unit.T)
        tan_out = np.column_stack([tan_xyz, tan_arr[:, 3].astype(np.float32)]).astype("<f4")
        bin_buf[tan_off : tan_off + tan_out.nbytes] = tan_out.tobytes()
        gltf["accessors"][tan_idx]["min"] = [round(float(v), 6) for v in tan_out.min(axis=0)]
        gltf["accessors"][tan_idx]["max"] = [round(float(v), 6) for v in tan_out.max(axis=0)]


def _resize_png_bytes(png_bytes: bytes, texture_size: int) -> bytes:
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", getattr(Image, "BICUBIC", 3))
    with Image.open(io.BytesIO(png_bytes)) as img:
        if img.size == (texture_size, texture_size) and img.mode in ("RGB", "RGBA"):
            return png_bytes
        mode = "RGBA" if img.mode == "RGBA" else "RGB"
        resized = img.convert(mode).resize((texture_size, texture_size), resample)
        out = io.BytesIO()
        resized.save(out, format="PNG", optimize=True)
        return out.getvalue()


def _rebuild_buffer_with_resized_images(gltf: dict[str, Any], bin_buf: bytearray, texture_size: int) -> bytes:
    """Pack geometry bufferViews + resized image bufferViews into a single 4-byte-aligned BIN chunk."""
    image_bv_indices = {int(im["bufferView"]) for im in gltf.get("images", []) if "bufferView" in im}
    old_bvs = gltf["bufferViews"]
    new_buf = bytearray()
    bv_remap: list[tuple[int, int]] = []

    for bv_idx, bv in enumerate(old_bvs):
        pad = (-len(new_buf)) % 4
        if pad:
            new_buf.extend(b"\x00" * pad)
        new_off = len(new_buf)
        src_off = int(bv.get("byteOffset", 0))
        src_len = int(bv["byteLength"])
        chunk = bytes(bin_buf[src_off : src_off + src_len])
        if bv_idx in image_bv_indices:
            chunk = _resize_png_bytes(chunk, texture_size)
        new_buf.extend(chunk)
        bv_remap.append((new_off, len(chunk)))

    for bv, (new_off, new_len) in zip(old_bvs, bv_remap):
        bv["byteOffset"] = new_off
        bv["byteLength"] = new_len

    gltf["buffers"] = [{"byteLength": len(new_buf)}]
    return bytes(new_buf)


def _make_socket_node(
    name: str,
    translation: tuple[float, float, float],
    distal: tuple[float, float, float],
    palm_normal: tuple[float, float, float],
    is_right_hand: bool,
) -> dict[str, Any]:
    rx, ry, rz = socket_euler_xyz(distal=distal, palm_normal=palm_normal, is_right_hand=is_right_hand)
    return {
        "name": name,
        "translation": [round(float(v), 6) for v in translation],
        "rotation": euler_xyz_to_quat(rx, ry, rz),
    }


def _configure_material(gltf: dict[str, Any]) -> None:
    mats = gltf.get("materials", [])
    if not mats:
        raise ValueError("Source pistol GLB has no materials")
    mat = mats[0]
    mat["name"] = "Pistol_PBR"
    pbr = mat.setdefault("pbrMetallicRoughness", {})
    pbr["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
    pbr["metallicFactor"] = 1.0
    pbr["roughnessFactor"] = 1.0
    if "occlusionTexture" in mat:
        mat["occlusionTexture"]["strength"] = 0.65
    if "normalTexture" in mat:
        mat["normalTexture"]["scale"] = 1.0
    mat["extras"] = {
        "pbrPhysical": {
            "clearcoat": 0.14,
            "clearcoatRoughness": 0.36,
        }
    }


def build_pistol_glb(texture_size: int = DEFAULT_TEXTURE_SIZE, source_path: Path | None = None) -> bytes:
    """Convert Sketchfab ``pistol.glb`` to metric (-Z) viewmodel orientation with sockets and resized textures."""
    tex_sz = _validate_texture_size(texture_size)
    src = Path(source_path) if source_path is not None else _resolve_default_source_glb()
    if not src.is_file():
        raise FileNotFoundError(f"Source pistol GLB not found: {src}")

    raw_gltf, raw_bin = parse_glb(src.read_bytes())
    gltf = copy.deepcopy(raw_gltf)
    bin_buf = bytearray(raw_bin)
    world_mats = _compute_world_matrices(gltf)

    nodes_by_name = {
        node["name"]: (idx, node)
        for idx, node in enumerate(gltf["nodes"])
        if isinstance(node.get("name"), str)
    }

    part_mesh_indices: dict[str, int] = {}
    for src_node_name, dst_node_name, refine_guard in _SOURCE_MESH_PARTS:
        if src_node_name not in nodes_by_name:
            raise ValueError(f"Source pistol GLB missing expected node '{src_node_name}'")
        src_idx, src_node = nodes_by_name[src_node_name]
        if "mesh" not in src_node:
            raise ValueError(f"Source pistol node '{src_node_name}' has no mesh")
        mesh_idx = int(src_node["mesh"])
        prims = gltf["meshes"][mesh_idx].get("primitives", [])
        if not prims:
            raise ValueError(f"Mesh for '{src_node_name}' has no primitives")
        post_shift = (-_TRIGGER_PIVOT[0], -_TRIGGER_PIVOT[1], -_TRIGGER_PIVOT[2]) if dst_node_name == "pistol_trigger_shoe" else None
        _transform_primitive_geometry(
            gltf=gltf,
            bin_buf=bin_buf,
            prim=prims[0],
            world_mat=world_mats[src_idx],
            post_shift=post_shift,
            refine_guard=refine_guard,
        )
        gltf["meshes"][mesh_idx]["name"] = dst_node_name
        part_mesh_indices[dst_node_name] = mesh_idx

    _configure_material(gltf)

    sockets = {
        spec[0]: _make_socket_node(*spec)
        for spec in _SOCKET_SPECS
    }

    # Build clean flat metric node hierarchy preserving animated sub-assemblies and sockets.
    # Node indices:
    # 0: pistol_root
    # 1: pistol_frame
    # 2: pistol_slide (contains 3: socket_slide)
    # 4: pistol_trigger (contains 5: pistol_trigger_shoe)
    # 6: pistol_mag (contains 7: pistol_mag_body, 8: pistol_bullet, 9: pistol_bullet_1, 10: socket_mag)
    # 11: pistol_muzzle
    # 12: socket_handguard
    # 13: socket_grip
    gltf["nodes"] = [
        {"name": "pistol_root", "extras": PISTOL_METADATA, "children": [1, 2, 4, 6, 11, 12, 13]},
        {"name": "pistol_frame", "mesh": part_mesh_indices["pistol_frame"]},
        {"name": "pistol_slide", "mesh": part_mesh_indices["pistol_slide_body"], "children": [3]},
        sockets["socket_slide"],
        {"name": "pistol_trigger", "translation": list(_TRIGGER_PIVOT), "children": [5]},
        {"name": "pistol_trigger_shoe", "mesh": part_mesh_indices["pistol_trigger_shoe"]},
        {"name": "pistol_mag", "children": [7, 8, 9, 10]},
        {"name": "pistol_mag_body", "mesh": part_mesh_indices["pistol_mag_body"]},
        {"name": "pistol_bullet", "mesh": part_mesh_indices["pistol_bullet"]},
        {"name": "pistol_bullet_1", "mesh": part_mesh_indices["pistol_bullet_1"]},
        sockets["socket_mag"],
        {"name": "pistol_muzzle", "translation": list(_MUZZLE_POS)},
        sockets["socket_handguard"],
        sockets["socket_grip"],
    ]
    gltf["scene"] = 0
    gltf["scenes"] = [{"name": "Pistol_PBR_Scene", "nodes": [0]}]

    asset = gltf.setdefault("asset", {"version": "2.0"})
    asset["generator"] = "FPS Python Metric Pistol Converter (DJMaesen CC-BY-4.0)"

    final_bin = _rebuild_buffer_with_resized_images(gltf, bin_buf, tex_sz)
    return pack_glb(gltf, final_bin)
