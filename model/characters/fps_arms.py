"""Convert and normalize the rigged SkinnedMesh fps_arms.glb to glTF 2.0 metallic-roughness PBR."""

from __future__ import annotations

import io
import json
from pathlib import Path
import struct
from typing import Any, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

_GLB_MAGIC = 0x46546C67  # 'glTF'
_CHUNK_JSON = 0x4E4F534A  # 'JSON'
_CHUNK_BIN = 0x004E4942  # 'BIN\0'
_SPEC_GLOSS_EXT = "KHR_materials_pbrSpecularGlossiness"
_ROOT_SOURCE_GLB = Path(__file__).resolve().parents[2] / "fps_arms.glb"
_ASSET_SOURCE_GLB = Path(__file__).resolve().parents[1] / "assets" / "fps_arms.glb"

FPS_ARMS_METADATA: dict[str, object] = {
    "character": "FPS_Arms_Skinned",
    "rigType": "skinned",
    "upperLen": 0.2587,
    "forearmLen": 0.2543,
    "attribution": {
        "author": "DJMaesen",
        "license": "CC-BY-4.0",
        "source": "https://sketchfab.com/3d-models/fps-arms-08ec4403a47645d8ad80633abf13d39d",
    },
    "leftHandBasis": {
        "distal": [-0.0289, 0.5375, -0.8428],
        "radial": [0.8447, 0.4639, 0.2669],
        "palmNormal": [0.5344, -0.7042, -0.4674],
        "palmOffset": [0.0067, 0.0225, -0.0604],
    },
    "rightHandBasis": {
        "distal": [0.0289, 0.5375, -0.8428],
        "radial": [-0.8447, 0.4639, 0.2669],
        "palmNormal": [-0.5344, -0.7042, -0.4674],
        "palmOffset": [-0.0067, 0.0225, -0.0604],
    },
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
    resampling = getattr(Image, "Resampling", Image)
    with Image.open(io.BytesIO(img_bytes)) as opened:
        converted = opened.convert(target_mode)
        return converted.resize((texture_size, texture_size), resampling.LANCZOS)


def _encode_png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


_ACCESSOR_DTYPES: dict[int, np.dtype[Any]] = {
    5121: np.dtype(np.uint8),
    5123: np.dtype(np.uint16),
    5125: np.dtype(np.uint32),
    5126: np.dtype(np.float32),
}

_ACCESSOR_COMPS: dict[str, int] = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
}


def _read_accessor(gltf: dict[str, Any], bin_chunk: bytes, accessor_idx: int) -> np.ndarray:
    acc = gltf["accessors"][accessor_idx]
    bv = gltf["bufferViews"][int(acc["bufferView"])]
    offset = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    count = int(acc["count"])
    n_comp = _ACCESSOR_COMPS[acc["type"]]
    dt = _ACCESSOR_DTYPES[int(acc["componentType"])]
    elem_bytes = n_comp * dt.itemsize
    stride = int(bv.get("byteStride", elem_bytes))
    raw_bytes = np.frombuffer(bin_chunk, dtype=np.uint8, offset=offset, count=count * stride).reshape(count, stride)
    data = np.ascontiguousarray(raw_bytes[:, :elem_bytes]).view(dt)
    return data.reshape(count) if n_comp == 1 else data.reshape(count, n_comp)


def _extract_mesh_uv_data(
    gltf: dict[str, Any],
    bin_chunk: bytes,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    prim = gltf["meshes"][0]["primitives"][0]
    attrs = prim["attributes"]
    pos = _read_accessor(gltf, bin_chunk, int(attrs["POSITION"])).astype(np.float32)
    nrm = _read_accessor(gltf, bin_chunk, int(attrs["NORMAL"])).astype(np.float32)
    uv0 = _read_accessor(gltf, bin_chunk, int(attrs["TEXCOORD_0"])).astype(np.float32)
    tris = _read_accessor(gltf, bin_chunk, int(prim["indices"])).reshape(-1, 3)
    return pos, nrm, uv0, tris


def _rasterize_uv_islands(
    uv0: np.ndarray,
    nrm: np.ndarray,
    tris: np.ndarray,
    size: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Rasterize disjoint UV islands (sleeve, glove, skin) and per-skin-pixel palmar weight."""
    sleeve_img = Image.new("L", (size, size), 0)
    glove_img = Image.new("L", (size, size), 0)
    skin_img = Image.new("L", (size, size), 0)
    palmar_img = Image.new("L", (size, size), 0)

    d_sleeve = ImageDraw.Draw(sleeve_img)
    d_glove = ImageDraw.Draw(glove_img)
    d_skin = ImageDraw.Draw(skin_img)
    d_palmar = ImageDraw.Draw(palmar_img)

    tri_uv = uv0[tris]  # (T, 3, 2)
    centroids = tri_uv.mean(axis=1)  # (T, 2)
    tri_palmar = np.clip(-nrm[tris, 1].mean(axis=1), 0.0, 1.0)
    scale = float(size - 1)

    for idx in range(len(tris)):
        cu, cv = float(centroids[idx, 0]), float(centroids[idx, 1])
        pts = [(float(tri_uv[idx, k, 0]) * scale, float(tri_uv[idx, k, 1]) * scale) for k in range(3)]
        if cu < 0.675 and cv > 0.485:
            d_sleeve.polygon(pts, fill=255, outline=255)
        elif cu < 0.570 and cv < 0.485:
            d_glove.polygon(pts, fill=255, outline=255)
        else:
            d_skin.polygon(pts, fill=255, outline=255)
            p_val = int(round(float(tri_palmar[idx]) * 255.0))
            if p_val > 0:
                d_palmar.polygon(pts, fill=p_val, outline=p_val)

    m_skin = np.asarray(skin_img, dtype=np.uint8) > 0
    m_glove = (np.asarray(glove_img, dtype=np.uint8) > 0) & (~m_skin)
    m_sleeve = (np.asarray(sleeve_img, dtype=np.uint8) > 0) & (~m_skin) & (~m_glove)

    blur_r = max(1.0, 2.5 * size / 512.0)
    palmar_smooth = palmar_img.filter(ImageFilter.GaussianBlur(radius=blur_r))
    palmar_w = np.asarray(palmar_smooth, dtype=np.float32) / 255.0
    return m_sleeve, m_glove, m_skin, palmar_w


def _uv_distance_field(u_grid: np.ndarray, v_grid: np.ndarray, seam_uvs: np.ndarray) -> np.ndarray:
    if len(seam_uvs) == 0:
        return np.full_like(u_grid, 10.0, dtype=np.float32)
    su = seam_uvs[:, 0].astype(np.float32)[None, None, :]
    sv = seam_uvs[:, 1].astype(np.float32)[None, None, :]
    d2 = (u_grid[..., None] - su) ** 2 + (v_grid[..., None] - sv) ** 2
    return np.sqrt(d2.min(axis=2))


def _dilate_gutter(arr: np.ndarray, valid_mask: np.ndarray, pixels: int = 3) -> np.ndarray:
    """Dilate valid island pixels outward into empty UV gutter to prevent mipmap border bleeding."""
    out = arr.copy()
    filled = valid_mask.copy()
    for _ in range(pixels):
        next_filled = filled.copy()
        acc = np.zeros_like(out, dtype=np.float32)
        cnt = np.zeros(valid_mask.shape, dtype=np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            shifted_val = np.roll(np.roll(out, dy, axis=0), dx, axis=1)
            shifted_mask = np.roll(np.roll(filled, dy, axis=0), dx, axis=1)
            acc += shifted_val * (shifted_mask[..., None] if out.ndim == 3 else shifted_mask)
            cnt += shifted_mask.astype(np.float32)
        grow = (~filled) & (cnt > 0)
        if not np.any(grow):
            break
        if out.ndim == 3:
            out[grow] = (acc[grow] / cnt[grow, None]).astype(out.dtype)
        else:
            out[grow] = (acc[grow] / cnt[grow]).astype(out.dtype)
        next_filled[grow] = True
        filled = next_filled
    return out


def _height_delta_to_normal_rgb(
    base_normal_rgb: np.ndarray,
    height_field: np.ndarray,
    mask: np.ndarray,
    strength: float,
) -> np.ndarray:
    """Perturb an existing tangent-space normal map using central-difference height gradients inside mask."""
    hx = (np.roll(height_field, -1, axis=1) - np.roll(height_field, 1, axis=1)) * (0.5 * strength)
    hy = (np.roll(height_field, -1, axis=0) - np.roll(height_field, 1, axis=0)) * (0.5 * strength)

    nrm = (base_normal_rgb.astype(np.float32) / 255.0) * 2.0 - 1.0
    nrm[..., 0] = np.where(mask, nrm[..., 0] - hx, nrm[..., 0])
    nrm[..., 1] = np.where(mask, nrm[..., 1] - hy, nrm[..., 1])
    inv_len = 1.0 / np.maximum(1e-5, np.linalg.norm(nrm, axis=2, keepdims=True))
    nrm *= inv_len
    return np.clip((nrm * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)


def _stylize_fps_arms_textures(
    gltf: dict[str, Any],
    orig_bin: bytes,
    diffuse_img: Image.Image,
    spec_gloss_img: Image.Image,
    normal_img: Image.Image,
    occ_img: Image.Image,
) -> tuple[bytes, bytes, bytes, bytes]:
    """Apply UV-island-segmented PBR stylization (ripstop sleeve, charcoal/leather glove, skin + contact AO)."""
    size = diffuse_img.size[0]
    pos, nrm, uv0, tris = _extract_mesh_uv_data(gltf, orig_bin)
    m_sleeve, m_glove, m_skin, palmar_w = _rasterize_uv_islands(uv0, nrm, tris, size)

    orig_diff = np.asarray(diffuse_img, dtype=np.float32)
    orig_sg = np.asarray(spec_gloss_img, dtype=np.float32)
    orig_norm = np.asarray(normal_img, dtype=np.uint8)
    orig_occ = np.asarray(occ_img, dtype=np.float32)

    # 3D-adjacent seam vertex sets on Left arm (L and R share identical UVs)
    left = pos[:, 0] > 0.0
    v_sleeve = left & (uv0[:, 0] < 0.675) & (uv0[:, 1] > 0.485)
    v_glove = left & (uv0[:, 0] < 0.570) & (uv0[:, 1] < 0.485)
    v_skin = left & (~v_sleeve) & (~v_glove)

    p_sl, p_gl, p_sk = pos[v_sleeve], pos[v_glove], pos[v_skin]
    d_sl_gl = np.linalg.norm(p_sl[:, None, :] - p_gl[None, :, :], axis=2)
    sl_wrist_uvs = uv0[v_sleeve][d_sl_gl.min(axis=1) < 1.5]
    gl_wrist_uvs = uv0[v_glove][d_sl_gl.min(axis=0) < 1.5]

    d_gl_sk = np.linalg.norm(p_gl[:, None, :] - p_sk[None, :, :], axis=2)
    gl_collar_uvs = uv0[v_glove][d_gl_sk.min(axis=1) < 0.8]
    sk_collar_uvs = uv0[v_skin][d_gl_sk.min(axis=0) < 0.8]

    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    u_grid = xx / max(1.0, float(size - 1))
    v_grid = yy / max(1.0, float(size - 1))

    d_sl_wrist = _uv_distance_field(u_grid, v_grid, sl_wrist_uvs)
    d_gl_wrist = _uv_distance_field(u_grid, v_grid, gl_wrist_uvs)
    d_gl_collar = _uv_distance_field(u_grid, v_grid, gl_collar_uvs)
    d_sk_collar = _uv_distance_field(u_grid, v_grid, sk_collar_uvs)

    diff_out = orig_diff.copy()
    mr_out = np.zeros((size, size, 3), dtype=np.uint8)
    mr_out[..., 0] = 255
    norm_out = orig_norm.copy()
    occ_out = np.clip((orig_occ / 255.0 - 0.72) / 0.28, 0.25, 1.0)

    # --- F1: Dark Olive Tactical Ripstop Sleeve + Ribbed Wrist Cuff ---
    occ_t = np.clip((orig_occ - 220.0) / 34.0, 0.0, 1.0)
    orig_lum = orig_diff.mean(axis=2)
    lum_t = np.clip((orig_lum - 12.0) / 26.0, 0.0, 1.0)
    crest_t = np.clip(0.62 * occ_t + 0.38 * lum_t, 0.0, 1.0)

    step = max(2, round(4.0 * size / 512.0))
    rip_grid = (((xx.astype(np.int32) % step) == 0) | ((yy.astype(np.int32) % step) == 0)).astype(np.float32)
    rip_fine = (((xx.astype(np.int32) + yy.astype(np.int32)) % 2) == 0).astype(np.float32) * 0.025

    cuff_t = np.clip((u_grid - 0.562) / 0.020, 0.0, 1.0)
    rib_wave = np.sin(v_grid * (2.0 * np.pi * 76.0))

    olive_base = np.array([70.0, 86.0, 54.0], dtype=np.float32)  # #465636 deep matte wet olive
    cuff_base = np.array([34.0, 40.0, 29.0], dtype=np.float32)   # #22281D ribbed cuff

    sleeve_factor = (0.56 + 0.38 * crest_t) * (1.0 - 0.09 * rip_grid - rip_fine)
    sleeve_rgb = olive_base[None, None, :] * sleeve_factor[..., None]
    cuff_rgb = cuff_base[None, None, :] * (0.86 + 0.14 * rib_wave)[..., None] * (0.74 + 0.28 * crest_t)[..., None]
    sleeve_final_rgb = sleeve_rgb * (1.0 - cuff_t[..., None]) + cuff_rgb * cuff_t[..., None]

    # Stitched cuff seam border around u = 0.568
    cuff_seam = m_sleeve & (np.abs(u_grid - 0.568) < 0.0045)
    stitch_dash = ((yy.astype(np.int32) % max(3, round(5.0 * size / 512.0))) < max(2, round(3.0 * size / 512.0)))
    cuff_stitch = cuff_seam & stitch_dash
    stitch_col = np.array([84.0, 88.0, 78.0], dtype=np.float32)  # #54584E
    sleeve_final_rgb[cuff_stitch] = stitch_col

    # Keep wet ripstop cloth matte (0.68..0.96) instead of shiny nylon raincoat highlights
    sleeve_rough = 0.96 - 0.28 * (crest_t ** 1.45)
    cuff_rough = 0.88 - 0.06 * rib_wave
    sleeve_final_rough = sleeve_rough * (1.0 - cuff_t) + cuff_rough * cuff_t
    sleeve_final_rough[cuff_stitch] = 0.90

    diff_out[m_sleeve] = sleeve_final_rgb[m_sleeve]
    mr_out[m_sleeve, 1] = np.clip(sleeve_final_rough[m_sleeve] * 255.0, 170, 246).astype(np.uint8)
    mr_out[m_sleeve, 2] = 0

    sleeve_height = (0.22 * rip_grid) * (1.0 - cuff_t) + (0.28 * rib_wave) * cuff_t
    norm_out = _height_delta_to_normal_rgb(norm_out, sleeve_height, m_sleeve, strength=2.2)
    occ_out[m_sleeve] *= np.where(cuff_t[m_sleeve] > 0.2, 0.86 + 0.14 * rib_wave[m_sleeve], 1.0)

    # --- F2: Dark Charcoal / Worn Leather Gloves, Contrast Stitching & Matte Carbon Knuckles ---
    sg_lum = orig_sg[..., :3].mean(axis=2)
    knuck_w = np.clip((sg_lum - 78.0) / 28.0, 0.0, 1.0)
    leather_w = np.clip((sg_lum - 36.0) / 24.0, 0.0, 1.0) * (1.0 - knuck_w)
    fabric_w = np.clip(1.0 - knuck_w - leather_w, 0.0, 1.0)

    carbon_weave = (((xx.astype(np.int32) + yy.astype(np.int32)) % max(2, round(4.0 * size / 512.0))) == 0).astype(np.float32)
    knuck_rgb = np.array([30.0, 34.0, 40.0], dtype=np.float32)[None, None, :] * (0.86 + 0.20 * carbon_weave)[..., None]

    # Worn leather (#25292F..#333840) with subtle crest wear (#3D434C)
    glove_crest = np.clip((orig_occ - 224.0) / 30.0, 0.0, 1.0)
    leather_base = np.array([37.0, 41.0, 47.0], dtype=np.float32)
    leather_worn = np.array([56.0, 61.0, 69.0], dtype=np.float32)
    leather_rgb = (
        leather_base[None, None, :] * (1.0 - 0.55 * glove_crest[..., None])
        + leather_worn[None, None, :] * (0.55 * glove_crest[..., None])
    )
    fabric_rgb = np.array([26.0, 29.0, 34.0], dtype=np.float32)[None, None, :] * (0.88 + 0.18 * glove_crest)[..., None]

    glove_rgb = (
        knuck_rgb * knuck_w[..., None]
        + leather_rgb * leather_w[..., None]
        + fabric_rgb * fabric_w[..., None]
    )

    # Contrast stitching along material borders & wrist cuff opening
    gx = np.abs(np.roll(sg_lum, -1, axis=1) - np.roll(sg_lum, 1, axis=1))
    gy = np.abs(np.roll(sg_lum, -1, axis=0) - np.roll(sg_lum, 1, axis=0))
    panel_edge = (np.hypot(gx, gy) > 22.0) | (d_gl_wrist < 0.012)
    diag_dash = (((xx.astype(np.int32) + yy.astype(np.int32)) % max(3, round(5.0 * size / 512.0))) < max(2, round(3.0 * size / 512.0)))
    glove_stitch = m_glove & panel_edge & diag_dash
    glove_rgb[glove_stitch] = stitch_col

    glove_rough = (
        (0.41 - 0.04 * carbon_weave) * knuck_w
        + (0.64 - 0.09 * glove_crest) * leather_w
        + (0.85 - 0.04 * glove_crest) * fabric_w
    )
    glove_rough[glove_stitch] = 0.85

    glove_metal = (0.06 * knuck_w) * (~glove_stitch)

    diff_out[m_glove] = glove_rgb[m_glove]
    mr_out[m_glove, 1] = np.clip(glove_rough[m_glove] * 255.0, 92, 228).astype(np.uint8)
    mr_out[m_glove, 2] = np.clip(glove_metal[m_glove] * 255.0, 0, 28).astype(np.uint8)
    norm_out = _height_delta_to_normal_rgb(norm_out, 0.14 * carbon_weave * knuck_w, m_glove, strength=1.5)

    # --- F3: Natural Damp Exposed Skin (toned-down orange saturation) + Micro-Droplets + Strong Contact AO ---
    rng = np.random.default_rng(707)
    skin_noise = rng.normal(0.0, 0.025, (size, size)).astype(np.float32)
    skin_luma = (0.299 * orig_diff[..., 0] + 0.587 * orig_diff[..., 1] + 0.114 * orig_diff[..., 2])[..., None]
    neutral_skin = skin_luma * np.array([1.10, 0.96, 0.85], dtype=np.float32)[None, None, :]
    skin_balanced = orig_diff * 0.64 + neutral_skin * 0.36
    skin_rgb = np.clip(skin_balanced * 0.64, 0, 255)
    # Soft-knee compress hot skin highlights so thumb knuckle never blows out under overhead key light
    skin_rgb = np.where(skin_rgb > 120.0, 120.0 + (skin_rgb - 120.0) * 0.32, skin_rgb)
    # Deeper contact shadow right at glove cutout lip so exposed thumb sits naturally inside glove opening
    collar_lip = np.clip(1.0 - d_sk_collar / 0.028, 0.0, 1.0)
    skin_rgb *= (1.0 - 0.58 * collar_lip[..., None])

    skin_rough = np.clip(0.62 + skin_noise, 0.55, 0.69)
    droplet_dots = rng.random((size, size)) < 0.014
    skin_rough[droplet_dots] = 0.42

    diff_out[m_skin] = skin_rgb[m_skin]
    mr_out[m_skin, 1] = np.clip(skin_rough[m_skin] * 255.0, 82, 180).astype(np.uint8)
    mr_out[m_skin, 2] = 0

    # Paint contact AO along wrist-cuff seam (balanced to avoid visual narrowing), 5 finger collars & palmar contact
    wrist_sl_ao = 1.0 - 0.54 * np.exp(-((d_sl_wrist / 0.022) ** 2))
    wrist_gl_ao = 1.0 - 0.58 * np.exp(-((d_gl_wrist / 0.026) ** 2))
    collar_gl_ao = 1.0 - 0.72 * np.exp(-((d_gl_collar / 0.020) ** 2))
    collar_sk_ao = 1.0 - 0.90 * np.exp(-((d_sk_collar / 0.036) ** 2))
    palmar_ao = 1.0 - 0.82 * np.clip((palmar_w - 0.10) / 0.70, 0.0, 1.0)

    occ_out[m_sleeve] *= wrist_sl_ao[m_sleeve]
    occ_out[m_glove] *= np.minimum(wrist_gl_ao[m_glove], collar_gl_ao[m_glove])
    occ_out[m_skin] *= np.minimum(collar_sk_ao[m_skin], palmar_ao[m_skin])
    occ_u8 = np.clip(occ_out * 255.0, 38, 255).astype(np.uint8)

    # Dilate all 4 maps 3px into empty UV gutter so mipmaps never bleed across islands
    valid_uv = m_sleeve | m_glove | m_skin
    diff_final = _dilate_gutter(np.clip(diff_out, 0, 255).astype(np.uint8), valid_uv, pixels=3)
    mr_final = _dilate_gutter(mr_out, valid_uv, pixels=3)
    norm_final = _dilate_gutter(norm_out, valid_uv, pixels=3)
    occ_final = _dilate_gutter(occ_u8, valid_uv, pixels=3)

    return (
        _encode_png(Image.fromarray(diff_final, mode="RGB")),
        _encode_png(Image.fromarray(mr_final, mode="RGB")),
        _encode_png(Image.fromarray(norm_final, mode="RGB")),
        _encode_png(Image.fromarray(occ_final, mode="L")),
    )


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

    material["occlusionTexture"] = {
        "index": occ_tex_idx,
        "strength": 0.90,
    }

    material["extras"] = {
        "pbrPhysical": {
            "clearcoat": 0.0,
            "clearcoatRoughness": 0.45,
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

    diffuse_img = _resize_image(_extract_image_bytes(gltf, orig_bin, diffuse_img_idx), texture_size, "RGB")
    spec_gloss_img = _resize_image(_extract_image_bytes(gltf, orig_bin, spec_img_idx), texture_size, "RGBA")
    normal_img = _resize_image(_extract_image_bytes(gltf, orig_bin, normal_img_idx), texture_size, "RGB")
    occ_img = _resize_image(_extract_image_bytes(gltf, orig_bin, occ_img_idx), texture_size, "L")

    if gltf.get("meshes") and gltf.get("skins"):
        diffuse_png, mr_png, normal_png, occ_png = _stylize_fps_arms_textures(
            gltf,
            orig_bin,
            diffuse_img,
            spec_gloss_img,
            normal_img,
            occ_img,
        )
    else:
        diffuse_png = _encode_png(diffuse_img)
        mr_png = _convert_spec_gloss_to_mr_png(spec_gloss_img, gloss_factor, specular_factor)
        normal_png = _encode_png(normal_img)
        occ_png = _encode_png(occ_img)

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
