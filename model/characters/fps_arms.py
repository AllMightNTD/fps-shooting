"""Convert and normalize the rigged SkinnedMesh fps_arms.glb to glTF 2.0 metallic-roughness PBR."""

from __future__ import annotations

import io
import json
from pathlib import Path
import struct
from typing import Any, Sequence

import numpy as np
from PIL import Image

_GLB_MAGIC = 0x46546C67  # 'glTF'
_CHUNK_JSON = 0x4E4F534A  # 'JSON'
_CHUNK_BIN = 0x004E4942  # 'BIN\0'
_SPEC_GLOSS_EXT = "KHR_materials_pbrSpecularGlossiness"
_ROOT_SOURCE_GLB = Path(__file__).resolve().parents[2] / "fps_arms.glb"
_ASSET_SOURCE_GLB = Path(__file__).resolve().parents[1] / "assets" / "fps_arms.glb"

FPS_ARMS_METADATA: dict[str, object] = {
    "character": "FPS_Arms_Tactical",
    "rigType": "skinned",
    "upperLen": 0.2587,
    "forearmLen": 0.2543,
    "bones": {
        "leftArm": "L_arm_01",
        "leftElbow": "L_elbow_02",
        "leftWrist": "L_wrist_03",
        "rightArm": "R_arm_023",
        "rightElbow": "R_elbow_024",
        "rightWrist": "R_wrist_025",
        "rightIndex": ["R_point1_030", "R_point2_031", "R_point3_032"],
    },
}


def _validate_texture_size(texture_size: int) -> int:
    if isinstance(texture_size, bool) or not isinstance(texture_size, int):
        raise ValueError(f"texture_size must be an integer, got {type(texture_size).__name__}")
    if texture_size < 64 or texture_size > 2048 or (texture_size & (texture_size - 1)) != 0:
        raise ValueError(f"texture_size must be a power of two in [64, 2048], got {texture_size}")
    return texture_size


def _parse_glb(raw_bytes: bytes) -> tuple[dict[str, Any], bytes]:
    if len(raw_bytes) < 20:
        raise ValueError("GLB payload too small")

    magic, version, total_len = struct.unpack_from("<III", raw_bytes, 0)
    if magic != _GLB_MAGIC:
        raise ValueError(f"Invalid GLB magic: 0x{magic:08x}")
    if version != 2:
        raise ValueError(f"Unsupported glTF version: {version}")
    if total_len != len(raw_bytes):
        raise ValueError(f"GLB length mismatch: header={total_len}, actual={len(raw_bytes)}")

    json_len, json_type = struct.unpack_from("<II", raw_bytes, 12)
    if json_type != _CHUNK_JSON:
        raise ValueError("First GLB chunk must be JSON")
    json_end = 20 + json_len
    if json_end + 8 > len(raw_bytes):
        raise ValueError("GLB JSON chunk truncated or missing BIN header")

    try:
        gltf = json.loads(raw_bytes[20:json_end].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid glTF JSON chunk") from exc

    if not isinstance(gltf, dict):
        raise ValueError("glTF root JSON must be an object")

    bin_len, bin_type = struct.unpack_from("<II", raw_bytes, json_end)
    if bin_type != _CHUNK_BIN:
        raise ValueError("Second GLB chunk must be BIN")
    bin_start = json_end + 8
    bin_end = bin_start + bin_len
    if bin_end > len(raw_bytes):
        raise ValueError("GLB BIN chunk truncated")

    return gltf, raw_bytes[bin_start:bin_end]


def _extract_image_bytes(gltf: dict[str, Any], bin_chunk: bytes, image_idx: int) -> bytes:
    images = gltf.get("images")
    buffer_views = gltf.get("bufferViews")
    if not isinstance(images, list) or not isinstance(buffer_views, list):
        raise ValueError("glTF must contain images and bufferViews")
    if image_idx < 0 or image_idx >= len(images):
        raise ValueError(f"Missing image[{image_idx}] in source GLB")

    bv_idx = images[image_idx].get("bufferView")
    if not isinstance(bv_idx, int) or bv_idx < 0 or bv_idx >= len(buffer_views):
        raise ValueError(f"image[{image_idx}] has invalid bufferView")

    bv = buffer_views[bv_idx]
    offset = int(bv.get("byteOffset", 0))
    length = int(bv.get("byteLength", 0))
    if offset < 0 or length <= 0 or offset + length > len(bin_chunk):
        raise ValueError(f"bufferView[{bv_idx}] out of BIN bounds")
    return bin_chunk[offset : offset + length]


def _resize_image(img_bytes: bytes, texture_size: int, target_mode: str) -> Image.Image:
    # Convert mode before LANCZOS resizing so palette ('P') images interpolate grayscale values cleanly.
    with Image.open(io.BytesIO(img_bytes)) as opened:
        converted = opened.convert(target_mode)
        return converted.resize((texture_size, texture_size), Image.Resampling.LANCZOS)


def _encode_png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _convert_spec_gloss_to_mr_png(
    spec_gloss_img: Image.Image,
    gloss_factor: float,
    specular_factor: Sequence[float],
) -> bytes:
    arr = np.asarray(spec_gloss_img, dtype=np.float32)
    spec_scale = np.asarray(specular_factor, dtype=np.float32)
    if spec_scale.shape != (3,):
        spec_scale = np.ones(3, dtype=np.float32)

    spec_rgb = arr[..., :3] * spec_scale
    alpha = arr[..., 3]
    spec_lin = np.power(np.clip(spec_rgb.mean(axis=2) / 255.0, 0.0, 1.0), 2.2)

    r_chan = np.full(alpha.shape, 255, dtype=np.uint8)
    g_chan = np.clip(255.0 - np.round(alpha * gloss_factor), 45, 238).astype(np.uint8)
    b_chan = np.clip(np.round(((spec_lin - 0.08) / 0.28) * 255.0), 0, 220).astype(np.uint8)

    mr_rgb = np.stack((r_chan, g_chan, b_chan), axis=-1)
    return _encode_png(Image.fromarray(mr_rgb, mode="RGB"))


def _resolve_material_textures(gltf: dict[str, Any], material: dict[str, Any]) -> tuple[int, int, int, int]:
    textures = gltf.get("textures")
    if not isinstance(textures, list):
        raise ValueError("glTF must contain textures")

    pbr_spec = material.get("extensions", {}).get(_SPEC_GLOSS_EXT)
    if not isinstance(pbr_spec, dict):
        raise ValueError(f"Material missing {_SPEC_GLOSS_EXT} extension")

    try:
        diffuse_tex_idx = int(pbr_spec["diffuseTexture"]["index"])
        spec_tex_idx = int(pbr_spec["specularGlossinessTexture"]["index"])
        normal_tex_idx = int(material["normalTexture"]["index"])
        occ_tex_idx = int(material["occlusionTexture"]["index"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Source material missing required PBR/normal/occlusion textures") from exc

    for tex_idx in (diffuse_tex_idx, spec_tex_idx, normal_tex_idx, occ_tex_idx):
        if tex_idx < 0 or tex_idx >= len(textures) or not isinstance(textures[tex_idx].get("source"), int):
            raise ValueError(f"Invalid texture[{tex_idx}] source reference")

    return diffuse_tex_idx, spec_tex_idx, normal_tex_idx, occ_tex_idx


def _rebuild_bin_and_views(
    gltf: dict[str, Any],
    orig_bin: bytes,
    converted_png_by_bv: dict[int, bytes],
) -> bytes:
    new_bin = bytearray()
    for bv_idx, bv in enumerate(gltf["bufferViews"]):
        pad = (-len(new_bin)) % 4
        if pad:
            new_bin.extend(b"\x00" * pad)

        new_offset = len(new_bin)
        if bv_idx in converted_png_by_bv:
            payload = converted_png_by_bv[bv_idx]
        else:
            orig_off = int(bv.get("byteOffset", 0))
            orig_len = int(bv["byteLength"])
            if orig_off < 0 or orig_off + orig_len > len(orig_bin):
                raise ValueError(f"bufferView[{bv_idx}] slice exceeds BIN chunk")
            payload = orig_bin[orig_off : orig_off + orig_len]

        new_bin.extend(payload)
        bv["buffer"] = 0
        bv["byteOffset"] = new_offset
        bv["byteLength"] = len(payload)

    trailing_pad = (-len(new_bin)) % 4
    if trailing_pad:
        new_bin.extend(b"\x00" * trailing_pad)

    gltf["buffers"] = [{"byteLength": len(new_bin)}]
    return bytes(new_bin)


def _upgrade_material_and_extensions(
    gltf: dict[str, Any],
    material: dict[str, Any],
    diffuse_tex_idx: int,
    mr_tex_idx: int,
    normal_tex_idx: int,
    occ_tex_idx: int,
) -> None:
    for ext_key in ("extensionsUsed", "extensionsRequired"):
        ext_list = gltf.get(ext_key)
        if isinstance(ext_list, list):
            filtered = [name for name in ext_list if name != _SPEC_GLOSS_EXT]
            if filtered:
                gltf[ext_key] = filtered
            else:
                del gltf[ext_key]

    mat_exts = material.get("extensions")
    if isinstance(mat_exts, dict):
        mat_exts.pop(_SPEC_GLOSS_EXT, None)
        if not mat_exts:
            del material["extensions"]

    material["pbrMetallicRoughness"] = {
        "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
        "baseColorTexture": {"index": diffuse_tex_idx},
        "metallicFactor": 1.0,
        "roughnessFactor": 1.0,
        "metallicRoughnessTexture": {"index": mr_tex_idx},
    }

    orig_normal = material.get("normalTexture", {})
    material["normalTexture"] = {"index": normal_tex_idx}
    if "scale" in orig_normal:
        material["normalTexture"]["scale"] = orig_normal["scale"]

    orig_occ = material.get("occlusionTexture", {})
    material["occlusionTexture"] = {
        "index": occ_tex_idx,
        "strength": float(orig_occ.get("strength", 0.41)),
    }

    material["extras"] = {
        "pbrPhysical": {
            "clearcoat": 0.16,
            "clearcoatRoughness": 0.36,
            "sheenColor": 0x8A9280,
            "sheenRoughness": 0.72,
        }
    }


def _wrap_arms_root(gltf: dict[str, Any]) -> None:
    scenes = gltf.get("scenes")
    nodes = gltf.get("nodes")
    if not isinstance(scenes, list) or not scenes or not isinstance(nodes, list):
        raise ValueError("glTF must contain non-empty scenes and nodes")

    scene_idx = int(gltf.get("scene", 0))
    if scene_idx < 0 or scene_idx >= len(scenes):
        raise ValueError("Invalid default scene index")

    orig_roots = list(scenes[scene_idx].get("nodes", []))
    if not orig_roots:
        raise ValueError("Source scene has no root nodes")

    arms_root_idx = len(nodes)
    nodes.append(
        {
            "name": "arms_root",
            "scale": [0.01, 0.01, 0.01],
            "rotation": [0.0, 1.0, 0.0, 0.0],
            "children": orig_roots,
            "extras": dict(FPS_ARMS_METADATA),
        }
    )
    scenes[scene_idx]["nodes"] = [arms_root_idx]


def _pack_glb(gltf: dict[str, Any], bin_bytes: bytes) -> bytes:
    json_raw = json.dumps(gltf, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_pad = (-len(json_raw)) % 4
    json_bytes = json_raw + (b" " * json_pad)

    bin_pad = (-len(bin_bytes)) % 4
    padded_bin = bin_bytes + (b"\x00" * bin_pad)

    total_length = 12 + 8 + len(json_bytes) + 8 + len(padded_bin)
    header = struct.pack("<III", _GLB_MAGIC, 2, total_length)
    json_hdr = struct.pack("<II", len(json_bytes), _CHUNK_JSON)
    bin_hdr = struct.pack("<II", len(padded_bin), _CHUNK_BIN)
    return header + json_hdr + json_bytes + bin_hdr + padded_bin


def _resolve_default_source_glb() -> Path:
    if _ROOT_SOURCE_GLB.is_file():
        return _ROOT_SOURCE_GLB
    return _ASSET_SOURCE_GLB


def build_fps_arms_glb(texture_size: int = 512, source_path: Path | None = None) -> bytes:
    """Load root or tracked asset fps_arms.glb, convert Specular-Glossiness textures to standard PBR, and normalize root scale/facing."""
    _validate_texture_size(texture_size)
    glb_path = _resolve_default_source_glb() if source_path is None else Path(source_path)
    if not glb_path.is_file():
        raise FileNotFoundError(f"Source fps_arms GLB not found: {glb_path}")

    gltf, orig_bin = _parse_glb(glb_path.read_bytes())

    materials = gltf.get("materials")
    if not isinstance(materials, list) or not materials:
        raise ValueError("Source GLB must contain at least one material")
    material = materials[0]

    diffuse_tex_idx, spec_tex_idx, normal_tex_idx, occ_tex_idx = _resolve_material_textures(gltf, material)
    textures = gltf["textures"]
    diffuse_img_idx = int(textures[diffuse_tex_idx]["source"])
    spec_img_idx = int(textures[spec_tex_idx]["source"])
    normal_img_idx = int(textures[normal_tex_idx]["source"])
    occ_img_idx = int(textures[occ_tex_idx]["source"])

    pbr_spec = material["extensions"][_SPEC_GLOSS_EXT]
    gloss_factor = float(pbr_spec.get("glossinessFactor", 1.0))
    specular_factor = pbr_spec.get("specularFactor", [1.0, 1.0, 1.0])

    diffuse_png = _encode_png(_resize_image(_extract_image_bytes(gltf, orig_bin, diffuse_img_idx), texture_size, "RGB"))
    spec_gloss_img = _resize_image(_extract_image_bytes(gltf, orig_bin, spec_img_idx), texture_size, "RGBA")
    mr_png = _convert_spec_gloss_to_mr_png(spec_gloss_img, gloss_factor, specular_factor)
    normal_png = _encode_png(_resize_image(_extract_image_bytes(gltf, orig_bin, normal_img_idx), texture_size, "RGB"))
    occ_png = _encode_png(_resize_image(_extract_image_bytes(gltf, orig_bin, occ_img_idx), texture_size, "L"))

    images = gltf["images"]
    converted_png_by_bv = {
        int(images[diffuse_img_idx]["bufferView"]): diffuse_png,
        int(images[spec_img_idx]["bufferView"]): mr_png,
        int(images[normal_img_idx]["bufferView"]): normal_png,
        int(images[occ_img_idx]["bufferView"]): occ_png,
    }
    for img_idx in (diffuse_img_idx, spec_img_idx, normal_img_idx, occ_img_idx):
        images[img_idx]["mimeType"] = "image/png"

    spec_bv = gltf["bufferViews"][int(images[spec_img_idx]["bufferView"])]
    spec_bv["name"] = "material_metallicRoughness.png"

    new_bin = _rebuild_bin_and_views(gltf, orig_bin, converted_png_by_bv)
    _upgrade_material_and_extensions(
        gltf,
        material,
        diffuse_tex_idx=diffuse_tex_idx,
        mr_tex_idx=spec_tex_idx,
        normal_tex_idx=normal_tex_idx,
        occ_tex_idx=occ_tex_idx,
    )
    _wrap_arms_root(gltf)
    return _pack_glb(gltf, new_bin)
