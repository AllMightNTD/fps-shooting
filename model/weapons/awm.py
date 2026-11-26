"""Convert and normalize awm.glb to glTF 2.0 metallic-roughness PBR with bolt-action rig & IK sockets."""

from __future__ import annotations

import io
import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from model.core import euler_xyz_to_quat, pack_glb, parse_glb, socket_euler_xyz

_SPEC_GLOSS_EXT = "KHR_materials_pbrSpecularGlossiness"
_ROOT_SOURCE_GLB = Path(__file__).resolve().parents[2] / "awm.glb"
_ASSET_SOURCE_GLB = Path(__file__).resolve().parents[1] / "assets" / "awm.glb"

# Bolt centerline & root normalization constants derived from awm.glb RootNode cm coordinates.
_BOLT_AXIS_CM: tuple[float, float, float] = (0.0, 1.099, -23.12)
_AWM_ROOT_TRANS: tuple[float, float, float] = (0.0, 0.01217, -0.198)
_AWM_ROOT_ROT_QUAT: list[float] = [0.0, 1.0, 0.0, 0.0]  # rotY = PI (-Z forward muzzle, +X right bolt)
_AWM_ROOT_SCALE: list[float] = [0.01, 0.01, 0.01]       # cm -> m

AWM_METADATA: dict[str, object] = {
    "weapon": "AWM Sniper",
    "muzzlePos": [0.0, 0.020, -0.802],
    "scopeEyePos": [0.0, 0.0947, -0.058],
    "boltAxisLocalCm": list(_BOLT_AXIS_CM),
    "boltPullCm": 11.0,
    "boltLiftRad": -0.88,
    "magDropCm": 14.0,
    "sockets": {
        "handguard": "socket_handguard",
        "grip": "socket_grip",
        "mag": "socket_mag",
        "charging": "socket_charging",
        "boltHandle": "socket_bolt_right",
    },
}


def _validate_texture_size(texture_size: int) -> int:
    if isinstance(texture_size, bool) or not isinstance(texture_size, int):
        raise ValueError(f"texture_size must be an integer, got {type(texture_size).__name__}")
    if texture_size < 64 or texture_size > 2048 or (texture_size & (texture_size - 1)) != 0:
        raise ValueError(f"texture_size must be a power of two in [64, 2048], got {texture_size}")
    return texture_size


def _resolve_default_source_glb() -> Path:
    if _ROOT_SOURCE_GLB.is_file():
        return _ROOT_SOURCE_GLB
    return _ASSET_SOURCE_GLB


def _encode_png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _resize_rgb(img_bytes: bytes, texture_size: int) -> Image.Image:
    resampling = getattr(Image, "Resampling", Image)
    with Image.open(io.BytesIO(img_bytes)) as opened:
        resized = opened.convert("RGB").resize((texture_size, texture_size), resampling.LANCZOS)
        # Subtle unsharp mask preserves close-up cheek-rest & chassis edge crispness without inflating bundle size
        return resized.filter(ImageFilter.UnsharpMask(radius=1.1, percent=115, threshold=2))


def _enhance_rifle_pbr_maps(rgb_img: Image.Image) -> tuple[Image.Image, bytes, bytes]:
    """Separate OD-green polymer from steel, paint seam crevice AO + polymer grain, and derive PBR maps."""
    arr = np.asarray(rgb_img, dtype=np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    luma = 0.299 * r + 0.587 * g + 0.114 * b

    # Green polymer chassis has subtle OD green lift (g - b > 0.008); barrel, receiver & bolt are neutral dark gray.
    green_polymer = np.clip((g - b - 0.008) * 55.0, 0.0, 1.0) * np.clip((g - r + 0.015) * 65.0, 0.0, 1.0)
    neutral = 1.0 - np.clip((max_c - min_c) * 4.5, 0.0, 1.0)
    metal_mask = np.clip(neutral * (1.0 - green_polymer), 0.0, 1.0)

    # Detect seams between green polymer chassis and black steel bolt/magwell/cheek-rest for crevice AO
    seam = (
        np.abs(np.roll(green_polymer, 1, axis=0) - np.roll(green_polymer, -1, axis=0))
        + np.abs(np.roll(green_polymer, 1, axis=1) - np.roll(green_polymer, -1, axis=1))
        + np.abs(np.roll(luma, 2, axis=0) - np.roll(luma, -2, axis=0)) * 0.65
        + np.abs(np.roll(luma, 2, axis=1) - np.roll(luma, -2, axis=1)) * 0.65
    )
    seam_ao = np.clip(seam * 0.85, 0.0, 1.0)
    # Widen subtle contact shadow 2px around polymer/mag/receiver boundaries
    seam_dilated = np.maximum.reduce([
        seam_ao,
        np.roll(seam_ao, 1, axis=0) * 0.72,
        np.roll(seam_ao, -1, axis=0) * 0.72,
        np.roll(seam_ao, 1, axis=1) * 0.72,
        np.roll(seam_ao, -1, axis=1) * 0.72,
    ])

    rng = np.random.default_rng(1337)
    h, w = luma.shape
    pebble_grain = rng.normal(0.0, 1.0, (h, w)).astype(np.float32)
    # Cheek-rest & grip areas are dark non-metallic polymer (dark neutral luma < 0.25)
    polymer_surface = np.clip(green_polymer + (1.0 - green_polymer) * np.clip((0.22 - luma) * 5.0, 0.0, 1.0), 0.0, 1.0)

    # Subtle micro-stipple & crevice AO darkening on albedo (sharper chassis & cheek-rest)
    albedo_mod = (1.0 - 0.42 * seam_dilated) * (1.0 + 0.045 * pebble_grain * polymer_surface)
    enhanced_rgb = np.clip(arr * albedo_mod[..., None] * 255.0, 0, 255).astype(np.uint8)
    enhanced_img = Image.fromarray(enhanced_rgb, mode="RGB")

    rough = (
        (0.90 - 0.10 * luma + 0.04 * pebble_grain) * green_polymer
        + (0.44 - 0.16 * luma) * (1.0 - green_polymer)
        + 0.06 * seam_dilated
    )
    metal = 0.03 * green_polymer + (0.86 * metal_mask) * (1.0 - green_polymer)

    mr = np.zeros((h, w, 3), dtype=np.uint8)
    mr[..., 0] = 255
    mr[..., 1] = np.clip(rough * 255.0, 52, 240).astype(np.uint8)
    mr[..., 2] = np.clip(metal * 255.0, 8, 235).astype(np.uint8)
    mr_png = _encode_png(Image.fromarray(mr, mode="RGB"))

    # Tangent-space normal map combining polymer micro-grain + recessed crevice grooves
    height = 0.16 * pebble_grain * polymer_surface - 0.45 * seam_dilated
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 1.45
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 1.45
    nx, ny, nz = -dx, -dy, np.ones_like(height, dtype=np.float32)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    norm_rgb = np.empty((h, w, 3), dtype=np.uint8)
    norm_rgb[..., 0] = np.clip((nx * inv_len * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    norm_rgb[..., 1] = np.clip((ny * inv_len * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    norm_rgb[..., 2] = np.clip((nz * inv_len * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    norm_png = _encode_png(Image.fromarray(norm_rgb, mode="RGB"))

    return enhanced_img, mr_png, norm_png


def _derive_scope_mr_png(rgb_img: Image.Image) -> bytes:
    """Create anodized aluminum metallic-roughness map for the AWM sniper scope body."""
    luma = np.asarray(rgb_img, dtype=np.float32).mean(axis=2) / 255.0
    mr = np.zeros((*luma.shape, 3), dtype=np.uint8)
    mr[..., 0] = 255
    mr[..., 1] = np.clip((0.48 - 0.16 * luma) * 255.0, 64, 165).astype(np.uint8)
    mr[..., 2] = 210
    return _encode_png(Image.fromarray(mr, mode="RGB"))


def _extract_image_bytes(gltf: dict[str, Any], orig_bin: bytes, img_idx: int) -> bytes:
    images = gltf.get("images")
    bvs = gltf.get("bufferViews")
    if not isinstance(images, list) or not isinstance(bvs, list):
        raise ValueError("awm.glb must contain images and bufferViews")
    if img_idx < 0 or img_idx >= len(images):
        raise ValueError(f"Missing image[{img_idx}] in awm.glb")
    bv_idx = images[img_idx].get("bufferView")
    if not isinstance(bv_idx, int) or bv_idx < 0 or bv_idx >= len(bvs):
        raise ValueError(f"Invalid bufferView for image[{img_idx}]")
    bv = bvs[bv_idx]
    off = int(bv.get("byteOffset", 0))
    length = int(bv.get("byteLength", 0))
    if off < 0 or length <= 0 or off + length > len(orig_bin):
        raise ValueError(f"bufferView[{bv_idx}] out of BIN bounds")
    return orig_bin[off : off + length]


def _append_bin_and_rebuild_images(
    gltf: dict[str, Any],
    orig_bin: bytes,
    replaced_bv_bytes: dict[int, bytes],
    extra_images: list[tuple[str, bytes]],
) -> tuple[bytes, list[int]]:
    """Rebuild existing bufferViews aligned on 4-byte boundaries and append new PNG texture slices."""
    new_bin = bytearray()
    bvs = gltf["bufferViews"]
    for bv_idx, bv in enumerate(bvs):
        pad = (-len(new_bin)) % 4
        if pad:
            new_bin.extend(b"\x00" * pad)
        new_off = len(new_bin)
        if bv_idx in replaced_bv_bytes:
            payload = replaced_bv_bytes[bv_idx]
        else:
            orig_off = int(bv.get("byteOffset", 0))
            orig_len = int(bv["byteLength"])
            if orig_off < 0 or orig_off + orig_len > len(orig_bin):
                raise ValueError(f"bufferView[{bv_idx}] slice exceeds BIN chunk")
            payload = orig_bin[orig_off : orig_off + orig_len]
        new_bin.extend(payload)
        bv["buffer"] = 0
        bv["byteOffset"] = new_off
        bv["byteLength"] = len(payload)

    new_tex_indices: list[int] = []
    images = gltf.setdefault("images", [])
    textures = gltf.setdefault("textures", [])
    for name, png_bytes in extra_images:
        pad = (-len(new_bin)) % 4
        if pad:
            new_bin.extend(b"\x00" * pad)
        new_off = len(new_bin)
        new_bin.extend(png_bytes)
        bv_idx = len(bvs)
        bvs.append({"buffer": 0, "byteOffset": new_off, "byteLength": len(png_bytes), "name": name})
        img_idx = len(images)
        images.append({"bufferView": bv_idx, "mimeType": "image/png", "name": name})
        tex_idx = len(textures)
        textures.append({"sampler": 0, "source": img_idx, "name": name})
        new_tex_indices.append(tex_idx)

    end_pad = (-len(new_bin)) % 4
    if end_pad:
        new_bin.extend(b"\x00" * end_pad)
    gltf["buffers"] = [{"byteLength": len(new_bin)}]
    return bytes(new_bin), new_tex_indices


def _upgrade_materials_to_pbr(
    gltf: dict[str, Any],
    orig_bin: bytes,
    texture_size: int,
) -> bytes:
    materials = gltf.get("materials")
    textures = gltf.get("textures")
    images = gltf.get("images")
    if not isinstance(materials, list) or len(materials) < 3:
        raise ValueError("awm.glb must contain 3 materials (lambert3, lambert2, lambert1)")
    if not isinstance(textures, list) or not isinstance(images, list) or len(images) < 2:
        raise ValueError("awm.glb missing required texture images")

    # Identify materials by name safely (fallback to source indices 0, 1, 2)
    by_name = {m.get("name"): m for m in materials if isinstance(m, dict)}
    mat_rifle = by_name.get("lambert3", materials[0])
    mat_scope = by_name.get("lambert2", materials[1])
    mat_lens = by_name.get("lambert1", materials[2])

    # Remove KHR_materials_pbrSpecularGlossiness extension declarations
    for ext_key in ("extensionsUsed", "extensionsRequired"):
        ext_list = gltf.get(ext_key)
        if isinstance(ext_list, list):
            kept = [e for e in ext_list if e != _SPEC_GLOSS_EXT]
            if kept:
                gltf[ext_key] = kept
            else:
                del gltf[ext_key]

    def resolve_diffuse_img(mat: dict[str, Any]) -> tuple[int, int]:
        spec_ext = mat.get("extensions", {}).get(_SPEC_GLOSS_EXT)
        if not isinstance(spec_ext, dict) or "diffuseTexture" not in spec_ext:
            raise ValueError(f"Material '{mat.get('name')}' missing {_SPEC_GLOSS_EXT} diffuseTexture")
        tex_idx = int(spec_ext["diffuseTexture"]["index"])
        img_idx = int(textures[tex_idx]["source"])
        return tex_idx, img_idx

    rifle_tex_idx, rifle_img_idx = resolve_diffuse_img(mat_rifle)
    scope_tex_idx, scope_img_idx = resolve_diffuse_img(mat_scope)

    rifle_rgb_raw = _resize_rgb(_extract_image_bytes(gltf, orig_bin, rifle_img_idx), texture_size)
    scope_rgb = _resize_rgb(_extract_image_bytes(gltf, orig_bin, scope_img_idx), texture_size)
    rifle_rgb, rifle_mr_png, rifle_norm_png = _enhance_rifle_pbr_maps(rifle_rgb_raw)

    replaced_bvs = {
        int(images[rifle_img_idx]["bufferView"]): _encode_png(rifle_rgb),
        int(images[scope_img_idx]["bufferView"]): _encode_png(scope_rgb),
    }
    images[rifle_img_idx]["mimeType"] = "image/png"
    images[scope_img_idx]["mimeType"] = "image/png"

    new_bin, extra_tex = _append_bin_and_rebuild_images(
        gltf,
        orig_bin,
        replaced_bvs,
        extra_images=[
            ("awm_rifle_mr.png", rifle_mr_png),
            ("awm_scope_mr.png", _derive_scope_mr_png(scope_rgb)),
            ("awm_rifle_normal.png", rifle_norm_png),
        ],
    )
    rifle_mr_tex_idx, scope_mr_tex_idx, rifle_norm_tex_idx = extra_tex

    for m in materials:
        exts = m.get("extensions")
        if isinstance(exts, dict):
            exts.pop(_SPEC_GLOSS_EXT, None)
            if not exts:
                del m["extensions"]

    mat_rifle["name"] = "AWM_RiflePBR"
    mat_rifle["pbrMetallicRoughness"] = {
        "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
        "baseColorTexture": {"index": rifle_tex_idx},
        "metallicFactor": 1.0,
        "roughnessFactor": 1.0,
        "metallicRoughnessTexture": {"index": rifle_mr_tex_idx},
    }
    mat_rifle["normalTexture"] = {"index": rifle_norm_tex_idx, "scale": 0.65}
    mat_rifle["extras"] = {"pbrPhysical": {"clearcoat": 0.12, "clearcoatRoughness": 0.58}}

    mat_scope["name"] = "AWM_ScopePBR"
    mat_scope["pbrMetallicRoughness"] = {
        "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
        "baseColorTexture": {"index": scope_tex_idx},
        "metallicFactor": 1.0,
        "roughnessFactor": 1.0,
        "metallicRoughnessTexture": {"index": scope_mr_tex_idx},
    }
    mat_scope["extras"] = {"pbrPhysical": {"clearcoat": 0.18, "clearcoatRoughness": 0.32}}

    mat_lens["name"] = "AWM_OpticLens"
    mat_lens["pbrMetallicRoughness"] = {
        "baseColorFactor": [0.025, 0.055, 0.095, 1.0],
        "metallicFactor": 0.28,
        "roughnessFactor": 0.05,
    }
    mat_lens["extras"] = {"pbrPhysical": {"clearcoat": 0.95, "clearcoatRoughness": 0.04}}

    return new_bin


def _world_to_root_cm_socket_rot(
    distal: tuple[float, float, float],
    palm_normal: tuple[float, float, float],
    is_right_hand: bool,
) -> list[float]:
    """Compute socket quaternion inside a node rotated by rotY = PI relative to awm_root."""
    # Because rotY(PI) negates X and Z in parent space, mirror X and Z before building local socket rotation.
    local_distal = (-distal[0], distal[1], -distal[2])
    local_palm = (-palm_normal[0], palm_normal[1], -palm_normal[2])
    rx, ry, rz = socket_euler_xyz(local_distal, local_palm, is_right_hand=is_right_hand)
    return euler_xyz_to_quat(rx, ry, rz)


def _normalize_hierarchy_and_sockets(gltf: dict[str, Any]) -> None:
    """Replace turntable root with metric -Z awm_root, bolt/mag pivots, muzzle anchor, and IK sockets."""
    nodes = gltf.get("nodes")
    scenes = gltf.get("scenes")
    if not isinstance(nodes, list) or not isinstance(scenes, list) or not scenes:
        raise ValueError("awm.glb missing valid scenes/nodes")

    name_to_idx = {n.get("name"): i for i, n in enumerate(nodes) if isinstance(n, dict) and n.get("name")}
    required = ("RootNode", "frame", "bolt", "bolt_handle", "mag")
    for req in required:
        if req not in name_to_idx:
            raise ValueError(f"awm.glb missing expected node '{req}'")

    root_node_idx = name_to_idx["RootNode"]
    frame_idx = name_to_idx["frame"]
    bolt_idx = name_to_idx["bolt"]
    bolt_handle_idx = name_to_idx["bolt_handle"]
    mag_idx = name_to_idx["mag"]

    # 1. Attach bolt_handle knob IK socket directly onto bolt_handle so right hand rides bolt throw
    bolt_socket_idx = len(nodes)
    nodes.append(
        {
            "name": "socket_bolt_right",
            "translation": [-6.04, -3.11, -21.60],
            "rotation": _world_to_root_cm_socket_rot(
                distal=(0.12, 0.16, -0.98),
                palm_normal=(-0.88, -0.42, 0.22),
                is_right_hand=True,
            ),
        }
    )
    nodes[bolt_handle_idx].setdefault("children", []).append(bolt_socket_idx)

    # 2. Wrap bolt + bolt_handle under a coaxial bolt-axis pivot (`awm_bolt_pivot`)
    bolt_offset_idx = len(nodes)
    nodes.append(
        {
            "name": "awm_bolt_offset",
            "translation": [-_BOLT_AXIS_CM[0], -_BOLT_AXIS_CM[1], -_BOLT_AXIS_CM[2]],
            "children": [bolt_idx, bolt_handle_idx],
        }
    )
    bolt_pivot_idx = len(nodes)
    nodes.append(
        {
            "name": "awm_bolt_pivot",
            "translation": list(_BOLT_AXIS_CM),
            "children": [bolt_offset_idx],
        }
    )

    # 3. Wrap magazine under `awm_mag_group` with attached `socket_mag` positioned outside left/lower mag face for clean reload grip
    mag_socket_idx = len(nodes)
    nodes.append(
        {
            "name": "socket_mag",
            "translation": [4.00, -10.20, -10.40],
            "rotation": _world_to_root_cm_socket_rot(
                distal=(0.34, -0.18, -0.923),
                palm_normal=(0.89, 0.26, 0.37),
                is_right_hand=False,
            ),
        }
    )
    mag_group_idx = len(nodes)
    nodes.append(
        {
            "name": "awm_mag_group",
            "children": [mag_idx, mag_socket_idx],
        }
    )

    # Swap bolt/bolt_handle and mag inside `frame.children` for the new pivot groups cleanly
    frame_children = list(nodes[frame_idx].get("children", []))
    frame_children = [c for c in frame_children if c not in (bolt_idx, bolt_handle_idx, mag_idx)]
    frame_children.extend([bolt_pivot_idx, mag_group_idx])
    nodes[frame_idx]["children"] = frame_children

    # 4. Create metric (-Z forward, +Y up) anchors and grip/forend sockets directly under `awm_root`
    def make_metric_socket(name: str, pos: tuple[float, float, float], distal: tuple[float, float, float], palm: tuple[float, float, float], is_right: bool) -> int:
        rx, ry, rz = socket_euler_xyz(distal, palm, is_right_hand=is_right)
        idx = len(nodes)
        nodes.append(
            {
                "name": name,
                "translation": list(pos),
                "rotation": euler_xyz_to_quat(rx, ry, rz),
            }
        )
        return idx

    muzzle_idx = len(nodes)
    nodes.append({"name": "muzzle_anchor", "translation": list(AWM_METADATA["muzzlePos"])})  # type: ignore[arg-type]

    eye_idx = len(nodes)
    nodes.append({"name": "scope_eye", "translation": list(AWM_METADATA["scopeEyePos"])})  # type: ignore[arg-type]

    sock_hg_idx = make_metric_socket(
        "socket_handguard",
        pos=(-0.028, -0.044, -0.275),
        distal=(-0.20, -0.18, -0.963),
        palm=(0.64, 0.77, -0.04),
        is_right=False,
    )
    sock_grip_idx = make_metric_socket(
        "socket_grip",
        pos=(0.036, -0.062, 0.065),
        distal=(0.14, -0.06, -0.988),
        palm=(-0.95, 0.14, 0.28),
        is_right=True,
    )
    sock_ch_idx = make_metric_socket(
        "socket_charging",
        pos=(0.0604, -0.019, 0.018),
        distal=(0.12, 0.16, -0.98),
        palm=(-0.88, -0.42, 0.22),
        is_right=True,
    )

    # Transform RootNode in cm -> metric -Z via clean TRS (skipping Sketchfab turntable rotation)
    nodes[root_node_idx]["translation"] = list(_AWM_ROOT_TRANS)
    nodes[root_node_idx]["rotation"] = list(_AWM_ROOT_ROT_QUAT)
    nodes[root_node_idx]["scale"] = list(_AWM_ROOT_SCALE)

    awm_root_idx = len(nodes)
    nodes.append(
        {
            "name": "awm_root",
            "children": [root_node_idx, muzzle_idx, eye_idx, sock_hg_idx, sock_grip_idx, sock_ch_idx],
            "extras": dict(AWM_METADATA),
        }
    )

    scene_idx = int(gltf.get("scene", 0))
    scenes[scene_idx]["name"] = "AWM_PBR_Scene"
    scenes[scene_idx]["nodes"] = [awm_root_idx]


def build_awm_glb(texture_size: int = 512, source_path: Path | None = None) -> bytes:
    """Convert raw Sketchfab awm.glb to glTF 2.0 PBR and normalize orientation, bolt pivot, and IK sockets."""
    _validate_texture_size(texture_size)
    glb_path = _resolve_default_source_glb() if source_path is None else Path(source_path)
    if not glb_path.is_file():
        raise FileNotFoundError(f"Source awm GLB not found: {glb_path}")

    gltf, orig_bin = parse_glb(glb_path.read_bytes())
    new_bin = _upgrade_materials_to_pbr(gltf, orig_bin, texture_size=texture_size)
    _normalize_hierarchy_and_sockets(gltf)
    return pack_glb(gltf, new_bin)

