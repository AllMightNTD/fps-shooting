"""Procedural PBR texture synthesis (3D rain droplets & brushed gunmetal) using Pillow and NumPy."""

from __future__ import annotations

from dataclasses import dataclass
import io
import random

import numpy as np
from PIL import Image, ImageDraw


@dataclass(frozen=True)
class RainMetalTextures:
    """PNG-encoded PBR textures compatible with glTF 2.0 Metallic-Roughness & Normal maps."""

    roughness_png: bytes
    bump_png: bytes
    normal_png: bytes
    gunmetal_albedo_png: bytes
    polymer_albedo_png: bytes
    gunmetal_mr_png: bytes
    polymer_mr_png: bytes
    size: int
    polymer_normal_png: bytes = b""


@dataclass(frozen=True)
class SkinTextures:
    """Realistic wet-skin PBR maps (pores, faint veins, rain droplets)."""

    albedo_png: bytes
    normal_png: bytes
    mr_png: bytes
    size: int


@dataclass(frozen=True)
class GloveTextures:
    """Tactical woven-fabric glove & camo sleeve PBR maps."""

    glove_albedo_png: bytes
    glove_normal_png: bytes
    glove_mr_png: bytes
    camo_albedo_png: bytes
    watch_dial_png: bytes
    size: int


@dataclass(frozen=True)
class SoldierTextures:
    """Third-person tactical BDU uniform and Kevlar armor PBR texture maps."""

    uniform_albedo_png: bytes
    uniform_normal_png: bytes
    uniform_mr_png: bytes
    armor_albedo_png: bytes
    armor_mr_png: bytes
    size: int


@dataclass(frozen=True)
class PistolTextures:
    """Anodized bead-blasted gunmetal with holster wear, rain droplets, and pyramid grip stippling."""

    slide_albedo_png: bytes
    slide_mr_png: bytes
    slide_normal_png: bytes
    polymer_albedo_png: bytes
    polymer_mr_png: bytes
    stipple_albedo_png: bytes
    stipple_mr_png: bytes
    stipple_normal_png: bytes
    size: int
    polymer_normal_png: bytes = b""


def _encode_png(arr: np.ndarray, mode: str) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _height_to_normal(height: np.ndarray, strength: float = 4.2) -> np.ndarray:
    """Convert seamless tileable [0, 1] height map into tangent-space RGB normal map."""
    # Sobel-weighted toroidal gradients yield cleaner specular rim highlights around spherical droplets.
    h_xm = np.roll(height, 1, axis=1)
    h_xp = np.roll(height, -1, axis=1)
    h_ym = np.roll(height, 1, axis=0)
    h_yp = np.roll(height, -1, axis=0)

    dx = (
        (np.roll(h_xp, 1, axis=0) + 2.0 * h_xp + np.roll(h_xp, -1, axis=0))
        - (np.roll(h_xm, 1, axis=0) + 2.0 * h_xm + np.roll(h_xm, -1, axis=0))
    ) * (0.125 * strength)
    dy = (
        (np.roll(h_yp, 1, axis=1) + 2.0 * h_yp + np.roll(h_yp, -1, axis=1))
        - (np.roll(h_ym, 1, axis=1) + 2.0 * h_ym + np.roll(h_ym, -1, axis=1))
    ) * (0.125 * strength)

    nx = -dx
    ny = -dy
    nz = np.ones_like(height, dtype=np.float32)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)

    rgb = np.empty((height.shape[0], height.shape[1], 3), dtype=np.uint8)
    rgb[..., 0] = np.clip((nx * inv_len * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    rgb[..., 1] = np.clip((ny * inv_len * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    rgb[..., 2] = np.clip((nz * inv_len * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    return rgb


def _build_metallic_roughness_png(rough_norm: np.ndarray, base_rough: float) -> bytes:
    """Encode glTF 2.0 MetallicRoughness map (G = roughness, B = 1.0 for factor multiplication).

    Wet droplets drop to ~0.04 roughness so they catch sharp specular highlights under directional
    harbor lamps while surrounding brushed metal/polymer retains natural diffuse-specular balance.
    """
    scale = base_rough / 0.38
    eff_rough = np.where(rough_norm < 0.25, rough_norm, np.clip(rough_norm * scale, 0.0, 1.0))
    rgb = np.zeros((rough_norm.shape[0], rough_norm.shape[1], 3), dtype=np.uint8)
    rgb[..., 1] = np.clip(eff_rough * 255.0, 0, 255).astype(np.uint8)  # G = Roughness
    rgb[..., 2] = 255  # B = Metallic (multiplied by material metallicFactor)
    return _encode_png(rgb, mode="RGB")


def _build_brushed_albedo_png(
    base_rgb: tuple[int, int, int],
    streak: np.ndarray,
    droplet_mask: np.ndarray,
) -> bytes:
    """Synthesize subtle brushed metal/polymer albedo with faint dark wet-spot rim tinting."""
    h, w = streak.shape
    albedo = np.empty((h, w, 3), dtype=np.float32)
    # Brushed streaks modulate brightness subtly; wet regions darken slightly like wet steel/polymer.
    mod = 1.0 + streak * 0.45 - droplet_mask * 0.08
    for c in range(3):
        albedo[..., c] = np.clip(base_rgb[c] * mod, 0, 255)
    return _encode_png(albedo.astype(np.uint8), mode="RGB")


def create_rain_and_metal_textures(
    size: int = 512,
    droplet_count: int = 620,
    seed: int = 42,
    normal_strength: float = 4.2,
) -> RainMetalTextures:
    """Generate tileable 3D rain-droplet roughness, bump, normal, albedo, and glTF MR textures."""
    if size <= 0 or (size & (size - 1)) != 0:
        raise ValueError("texture size must be a positive power of two")
    if droplet_count < 0:
        raise ValueError("droplet_count must be non-negative")

    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    # Anisotropic brushed-metal micro-streaks across X + isotropic micro-grain for CNC anodized finish.
    row_streak = np_rng.normal(0.0, 0.018, (size, 1)).astype(np.float32)
    col_wave = (np.sin(np.linspace(0.0, 14.0 * np.pi, size, dtype=np.float32))[None, :] * 0.008)
    streak = row_streak + col_wave
    micro_grain = np_rng.normal(0.0, 0.022, (size, size)).astype(np.float32)

    rough = np.full((size, size), 0.46, dtype=np.float32) + streak * 0.65 + micro_grain * 0.70
    bump = np.full((size, size), 0.35, dtype=np.float32) + micro_grain * 0.15
    metal = np.full((size, size), 230.0, dtype=np.float32)
    droplet_mask = np.zeros((size, size), dtype=np.float32)

    # Edge wear & subtle wrapped micro-scratches exposing bare alloy under anodized finish.
    scratch_img = Image.new("L", (size, size), 0)
    s_draw = ImageDraw.Draw(scratch_img)
    for _ in range(55):
        sx = rng.random() * size
        sy = rng.random() * size
        slen = (10.0 + rng.random() * 44.0) * (size / 512.0)
        sdy = (rng.random() - 0.5) * 6.0 * (size / 512.0)
        val = int(165 + rng.random() * 90)
        for ox in (-size, 0, size):
            s_draw.line([(sx + ox, sy), (sx + ox + slen, sy + sdy)], fill=val, width=1)
    edge_wear = (np.asarray(scratch_img, dtype=np.float32) / 255.0)
    wear_hit = edge_wear > 0.1
    rough = np.where(wear_hit, 0.25 - 0.03 * edge_wear, rough)
    bump = np.where(wear_hit, 0.295, bump)
    metal = np.where(wear_hit, 255.0, metal)

    for i in range(droplet_count):
        cx = rng.random() * size
        cy = rng.random() * size
        # Mix fine mist micro-droplets with sparse domed raindrops.
        is_large = (i % 7) == 0
        rx = max(0.75, ((1.4 + rng.random() * 1.1) if is_large else (0.7 + rng.random() * 0.9)) * (size / 512.0))
        ry = rx * (1.2 + rng.random() * 0.5 if (i % 11) == 0 else (0.95 + rng.random() * 0.22))

        r_ceil_x = int(np.ceil(rx)) + 1
        r_ceil_y = int(np.ceil(ry)) + 1
        x_idx = np.arange(int(cx) - r_ceil_x, int(cx) + r_ceil_x + 1) % size
        y_idx = np.arange(int(cy) - r_ceil_y, int(cy) + r_ceil_y + 1) % size

        dx = ((x_idx - cx + size * 0.5) % size - size * 0.5) / rx
        dy = ((y_idx - cy + size * 0.5) % size - size * 0.5) / ry
        t2 = (dx[None, :] ** 2) + (dy[:, None] ** 2)
        inside = t2 <= 1.0

        # Smooth spherical-cap height profile -> sharp normal rim catches specular glints!
        dome = np.where(inside, 0.35 + 0.48 * np.sqrt(np.maximum(0.0, 1.0 - t2)), 0.0).astype(np.float32)

        patch_r = rough[np.ix_(y_idx, x_idx)]
        patch_r[inside] = 0.045
        rough[np.ix_(y_idx, x_idx)] = patch_r

        patch_b = bump[np.ix_(y_idx, x_idx)]
        patch_b[inside] = np.maximum(patch_b[inside], dome[inside])
        bump[np.ix_(y_idx, x_idx)] = patch_b

        patch_m = droplet_mask[np.ix_(y_idx, x_idx)]
        patch_m[inside] = 1.0
        droplet_mask[np.ix_(y_idx, x_idx)] = patch_m

    rough = np.clip(rough, 0.0, 1.0)
    bump = np.clip(bump, 0.0, 1.0)

    rough_u8 = (rough * 255.0).astype(np.uint8)
    bump_u8 = (bump * 255.0).astype(np.uint8)
    normal_rgb = _height_to_normal(bump, strength=normal_strength)

    # Anodized gunmetal albedo with edge wear
    gm_base = np.array([82.0, 88.0, 96.0], dtype=np.float32)
    gm_mod = (1.0 + streak * 0.45 + micro_grain * 0.35 - droplet_mask * 0.08)[..., None]
    gm_albedo = gm_base[None, None, :] * gm_mod
    wear_rgb = np.array([182.0, 188.0, 196.0], dtype=np.float32)[None, None, :]
    gm_albedo = np.clip(gm_albedo * (1.0 - 0.65 * edge_wear[..., None]) + wear_rgb * (0.65 * edge_wear[..., None]), 0, 255).astype(np.uint8)

    gm_mr_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    gm_mr_rgb[..., 1] = np.clip(rough * 255.0, 0, 255).astype(np.uint8)
    gm_mr_rgb[..., 2] = np.clip(metal, 0, 255).astype(np.uint8)

    # Matte polymer: isotropic mold micro-grain only (no brushed streaks, no glossy droplets, B=0)
    poly_grain = np_rng.normal(0.0, 0.032, (size, size)).astype(np.float32)
    poly_base = np.array([64.0, 68.0, 74.0], dtype=np.float32)
    poly_albedo = np.clip(poly_base[None, None, :] * (1.0 + poly_grain[..., None] * 1.1), 0, 255).astype(np.uint8)

    poly_mr_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    poly_mr_rgb[..., 1] = np.clip((0.84 + poly_grain * 1.1) * 255.0, 194, 232).astype(np.uint8)
    poly_mr_rgb[..., 2] = 0
    poly_normal_rgb = _height_to_normal(np.clip(0.50 + poly_grain * 1.4, 0.0, 1.0), strength=1.8)

    return RainMetalTextures(
        roughness_png=_encode_png(rough_u8, mode="L"),
        bump_png=_encode_png(bump_u8, mode="L"),
        normal_png=_encode_png(normal_rgb, mode="RGB"),
        gunmetal_albedo_png=_encode_png(gm_albedo, mode="RGB"),
        polymer_albedo_png=_encode_png(poly_albedo, mode="RGB"),
        gunmetal_mr_png=_encode_png(gm_mr_rgb, mode="RGB"),
        polymer_mr_png=_encode_png(poly_mr_rgb, mode="RGB"),
        size=size,
        polymer_normal_png=_encode_png(poly_normal_rgb, mode="RGB"),
    )


def create_realistic_skin_textures(
    size: int = 512,
    pore_count: int = 4000,
    droplet_count: int = 180,
    seed: int = 101,
    base_rgb: tuple[int, int, int] = (142, 94, 72),
) -> SkinTextures:
    """Generate realistic wet skin albedo, normal (pores + droplets), and metallic-roughness maps."""
    if size <= 0 or (size & (size - 1)) != 0:
        raise ValueError("skin texture size must be a positive power of two")
    if pore_count < 0 or droplet_count < 0:
        raise ValueError("pore_count and droplet_count must be non-negative")

    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    # Smooth radial subsurface warm/cool skin mottling (soft Gaussian falloff, no hard ellipse borders)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    color_arr = np.tile(np.array(base_rgb, dtype=np.float32), (size, size, 1))
    for _ in range(36):
        cx = rng.random() * size
        cy = rng.random() * size
        rad = 20.0 + rng.random() * 44.0
        dx = (xx - cx + size * 0.5) % size - size * 0.5
        dy = (yy - cy + size * 0.5) % size - size * 0.5
        falloff = np.exp(-((dx * dx + dy * dy) / (2.0 * (rad * 0.48) ** 2)))[..., None]
        if rng.random() < 0.5:
            target = np.array([112.0, 62.0, 45.0], dtype=np.float32)
            strength = 0.18
        else:
            target = np.array([162.0, 115.0, 90.0], dtype=np.float32)
            strength = 0.13
        color_arr = color_arr * (1.0 - falloff * strength) + target * (falloff * strength)

    color_img = Image.fromarray(np.clip(color_arr, 0, 255).astype(np.uint8), mode="RGB").convert("RGBA")
    c_draw = ImageDraw.Draw(color_img, "RGBA")

    # Subtle subcutaneous forearm veins drawn as soft narrow cubic Bezier curves
    for v in range(4):
        sx = (size * (86 + v * 112)) / 512.0
        pts: list[tuple[float, float]] = []
        p0 = (sx, 0.0)
        p1 = (sx + 16.0 * size / 512.0, size * 0.3)
        p2 = (sx - 18.0 * size / 512.0, size * 0.7)
        p3 = (sx + 4.0 * size / 512.0, float(size))
        for step in range(25):
            t = step / 24.0
            mt = 1.0 - t
            bx = (mt**3) * p0[0] + 3 * (mt**2) * t * p1[0] + 3 * mt * (t**2) * p2[0] + (t**3) * p3[0]
            by = (mt**3) * p0[1] + 3 * (mt**2) * t * p1[1] + 3 * mt * (t**2) * p2[1] + (t**3) * p3[1]
            pts.append((bx, by))
        c_draw.line(pts, fill=(96, 86, 80, 9), width=max(1, round(3 * size / 512)))
        c_draw.line(pts, fill=(84, 86, 84, 11), width=max(1, round(1.5 * size / 512)))

    # Skin pores & micro-texture
    color_arr = np.asarray(color_img.convert("RGB"), dtype=np.float32) + np_rng.normal(0.0, 2.0, (size, size, 1))
    height = np.full((size, size), 0.50, dtype=np.float32)
    rough = np.full((size, size), 0.54, dtype=np.float32)

    for _ in range(pore_count):
        px = int(rng.random() * size) % size
        py = int(rng.random() * size) % size
        px2 = (px + 1) % size
        py2 = (py + 1) % size
        if rng.random() > 0.5:
            color_arr[py : py + 1, px : px + 1] = color_arr[py, px] * 0.88 + np.array([108, 62, 44]) * 0.12
        else:
            color_arr[py : py + 1, px : px + 1] = color_arr[py, px] * 0.90 + np.array([180, 134, 108]) * 0.10
        height[py, px] = 0.44
        height[py, px2] = 0.47
        height[py2, px] = 0.47

    # Rain droplets resting on wet skin (soft-edged glossy domes)
    for _ in range(droplet_count):
        cx = rng.random() * size
        cy = rng.random() * size
        rad = 0.9 + rng.random() * 1.5
        r_ceil = int(np.ceil(rad)) + 1
        x_idx = np.arange(int(cx) - r_ceil, int(cx) + r_ceil + 1) % size
        y_idx = np.arange(int(cy) - r_ceil, int(cy) + r_ceil + 1) % size

        dx = ((x_idx - cx + size * 0.5) % size - size * 0.5) / rad
        dy = ((y_idx - cy + size * 0.5) % size - size * 0.5) / rad
        t2 = (dx[None, :] ** 2) + (dy[:, None] ** 2)
        inside = t2 <= 1.0

        dome = np.where(inside, 0.50 + 0.42 * np.sqrt(np.maximum(0.0, 1.0 - t2)), 0.50).astype(np.float32)
        patch_h = height[np.ix_(y_idx, x_idx)]
        patch_h[inside] = np.maximum(patch_h[inside], dome[inside])
        height[np.ix_(y_idx, x_idx)] = patch_h

        blend = np.where(inside, np.maximum(0.0, 1.0 - t2), 0.0).astype(np.float32)
        patch_r = rough[np.ix_(y_idx, x_idx)]
        patch_r[inside] = np.minimum(patch_r[inside], 0.54 - 0.40 * blend[inside])
        rough[np.ix_(y_idx, x_idx)] = patch_r

    mr_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    mr_rgb[..., 1] = np.clip(rough * 255.0, 0, 255).astype(np.uint8)
    mr_rgb[..., 2] = 0

    normal_rgb = _height_to_normal(height, strength=2.6)
    return SkinTextures(
        albedo_png=_encode_png(np.clip(color_arr, 0, 255).astype(np.uint8), mode="RGB"),
        normal_png=_encode_png(normal_rgb, mode="RGB"),
        mr_png=_encode_png(mr_rgb, mode="RGB"),
        size=size,
    )


def create_glove_textures(size: int = 256, seed: int = 202) -> GloveTextures:
    """Generate woven olive tactical glove maps, camo sleeve albedo, and military watch dial."""
    if size <= 0 or (size & (size - 1)) != 0:
        raise ValueError("glove texture size must be a positive power of two")

    rng = random.Random(seed)
    # 1. Woven fabric grid matching createGloveTexture()
    weave_h = np.full((size, size), 0.50, dtype=np.float32)
    albedo = np.zeros((size, size, 3), dtype=np.float32)
    base_olive = np.array([59.0, 64.0, 51.0], dtype=np.float32)  # #3b4033

    yy, xx = np.mgrid[0:size, 0:size]
    cell = ((xx // 4 + yy // 4) % 2) == 0
    sub_x = (xx % 4) < 2
    sub_y = (yy % 4) < 2
    dot = sub_x & sub_y

    weave_h[dot & cell] = 0.64
    weave_h[dot & ~cell] = 0.38

    mod = np.where(dot & cell, 1.12, np.where(dot & ~cell, 0.86, 0.98))[..., None]
    albedo[:] = np.clip(base_olive * mod, 0, 255)

    glove_normal = _height_to_normal(weave_h, strength=2.4)
    glove_mr = np.zeros((size, size, 3), dtype=np.uint8)
    glove_mr[..., 1] = np.where(dot & cell, 205, 224)  # ~0.80..0.88 roughness
    glove_mr[..., 2] = 255

    # 2. Camo rolled-up sleeve texture
    camo_img = Image.new("RGB", (size, size), (74, 75, 56))
    camo_draw = ImageDraw.Draw(camo_img)
    palette = [(92, 92, 68), (56, 64, 41), (39, 40, 30), (109, 104, 79), (66, 72, 49)]
    for i in range(90):
        cx, cy = rng.random() * size, rng.random() * size
        rx, ry = 6 + rng.random() * 22, 4 + rng.random() * 12
        camo_draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=palette[i % len(palette)])
    for x in range(0, size, 2):
        camo_draw.line([(x, 0), (x, size)], fill=(35, 38, 28), width=1)

    # 3. Military watch dial (#0c1418 dark dial + crisp ticks + #88ffcc luminous hands)
    dial_sz = 128
    dial_img = Image.new("RGB", (dial_sz, dial_sz), (12, 20, 24))
    d_draw = ImageDraw.Draw(dial_img)
    mid = dial_sz * 0.5
    for i in range(12):
        ang = i * (np.pi / 6.0) - np.pi * 0.5
        r_in = 40.0 if (i % 3 == 0) else 46.0
        r_out = 55.0
        p0 = (mid + r_in * np.cos(ang), mid + r_in * np.sin(ang))
        p1 = (mid + r_out * np.cos(ang), mid + r_out * np.sin(ang))
        d_draw.line([p0, p1], fill=(205, 226, 232), width=3 if (i % 3 == 0) else 2)
    # Hour and minute luminous hands
    d_draw.line([(mid, mid), (mid + 24, mid - 16)], fill=(136, 255, 204), width=4)
    d_draw.line([(mid, mid), (mid - 8, mid - 40)], fill=(136, 255, 204), width=3)
    d_draw.ellipse((mid - 4, mid - 4, mid + 4, mid + 4), fill=(195, 210, 215))

    return GloveTextures(
        glove_albedo_png=_encode_png(albedo.astype(np.uint8), mode="RGB"),
        glove_normal_png=_encode_png(glove_normal, mode="RGB"),
        glove_mr_png=_encode_png(glove_mr, mode="RGB"),
        camo_albedo_png=_encode_png(np.asarray(camo_img, dtype=np.uint8), mode="RGB"),
        watch_dial_png=_encode_png(np.asarray(dial_img, dtype=np.uint8), mode="RGB"),
        size=size,
    )


def create_soldier_textures(size: int = 256, seed: int = 303) -> SoldierTextures:
    """Generate night-ops BDU uniform weave + Kevlar armor PBR maps."""
    if size <= 0 or (size & (size - 1)) != 0:
        raise ValueError("soldier texture size must be a positive power of two")

    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    # 1. Digital tactical night-slate camo uniform
    uni_img = Image.new("RGB", (size, size), (42, 49, 52))
    u_draw = ImageDraw.Draw(uni_img)
    palette = [(56, 65, 64), (30, 36, 40), (66, 72, 58), (48, 56, 62)]
    block = max(4, size // 32)
    for i in range(180):
        bx = int(rng.random() * (size // block)) * block
        by = int(rng.random() * (size // block)) * block
        bw = (1 + (i % 4)) * block
        bh = (1 + ((i * 3) % 3)) * block
        u_draw.rectangle((bx, by, bx + bw, by + bh), fill=palette[i % len(palette)])

    uni_arr = np.asarray(uni_img, dtype=np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    ripstop = (((xx % 4) == 0) | ((yy % 4) == 0)).astype(np.float32)
    uni_arr = np.clip(uni_arr * (1.0 - 0.12 * ripstop[..., None]) + np_rng.normal(0.0, 2.2, (size, size, 1)), 0, 255)

    uni_h = 0.50 + 0.08 * ripstop + np_rng.uniform(-0.03, 0.03, (size, size)).astype(np.float32)
    uni_rough = np.full((size, size), 0.78, dtype=np.float32)
    for _ in range(45):
        cx, cy = rng.random() * size, rng.random() * size
        rad = 6.0 + rng.random() * 14.0
        dx = (xx - cx + size * 0.5) % size - size * 0.5
        dy = (yy - cy + size * 0.5) % size - size * 0.5
        wet = np.exp(-((dx * dx + dy * dy) / (2.0 * (rad * 0.5) ** 2))).astype(np.float32)
        uni_rough = np.minimum(uni_rough, 0.78 - 0.44 * wet)
        uni_arr *= (1.0 - 0.14 * wet[..., None])

    uni_mr = np.zeros((size, size, 3), dtype=np.uint8)
    uni_mr[..., 1] = np.clip(uni_rough * 255.0, 0, 255).astype(np.uint8)
    uni_normal = _height_to_normal(np.clip(uni_h, 0.0, 1.0), strength=2.2)

    # 2. Tactical Kevlar armor plate & helmet shell (charcoal olive + micro weave)
    armor_base = np.full((size, size, 3), np.array([34.0, 38.0, 41.0], dtype=np.float32), dtype=np.float32)
    armor_base += np_rng.normal(0.0, 2.5, (size, size, 1)) - 3.5 * ripstop[..., None]
    armor_mr = np.zeros((size, size, 3), dtype=np.uint8)
    armor_mr[..., 1] = np.clip((0.52 - 0.18 * ripstop) * 255.0, 0, 255).astype(np.uint8)
    armor_mr[..., 2] = 40  # subtle metallic sheen on fasteners/helmet

    return SoldierTextures(
        uniform_albedo_png=_encode_png(np.clip(uni_arr, 0, 255).astype(np.uint8), mode="RGB"),
        uniform_normal_png=_encode_png(uni_normal, mode="RGB"),
        uniform_mr_png=_encode_png(uni_mr, mode="RGB"),
        armor_albedo_png=_encode_png(np.clip(armor_base, 0, 255).astype(np.uint8), mode="RGB"),
        armor_mr_png=_encode_png(armor_mr, mode="RGB"),
        size=size,
    )


def create_pistol_textures(
    size: int = 512,
    scratch_count: int = 65,
    droplet_count: int = 190,
    seed: int = 404,
) -> PistolTextures:
    """Synthesize Glock Gen4/Gen5 bead-blasted anodized slide, wet droplets, and pyramid stippling maps."""
    if size <= 0 or (size & (size - 1)) != 0:
        raise ValueError("pistol texture size must be a positive power of two")
    if scratch_count < 0 or droplet_count < 0:
        raise ValueError("scratch_count and droplet_count must be non-negative")

    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    # 1. Anodized bead-blasted finish + longitudinal slide holster micro-scratches
    grain = np_rng.uniform(-0.5, 0.5, (size, size)).astype(np.float32) * 26.0
    rough_img = Image.fromarray(np.clip(92.0 + grain, 40.0, 180.0).astype(np.uint8), mode="L")
    bump_img = Image.fromarray(np.clip(128.0 + grain * 0.6, 95.0, 165.0).astype(np.uint8), mode="L")
    albedo_img = Image.fromarray(np.clip(236.0 + grain * 0.45, 210.0, 255.0).astype(np.uint8), mode="L")

    r_draw = ImageDraw.Draw(rough_img)
    b_draw = ImageDraw.Draw(bump_img)
    a_draw = ImageDraw.Draw(albedo_img)

    for _ in range(scratch_count):
        x = rng.random() * size
        y = rng.random() * size
        length = (18.0 + rng.random() * 85.0) * (size / 512.0)
        dy = (rng.random() - 0.5) * 4.0 * (size / 512.0)
        # Draw wrapped strokes so UV tiling stays seamless
        for ox in (-size, 0, size):
            p0 = (x + ox, y)
            p1 = (x + ox + length, y + dy)
            r_draw.line([p0, p1], fill=int(52 + rng.random() * 24), width=1)
            b_draw.line([p0, p1], fill=int(158 + rng.random() * 22), width=1)
            a_draw.line([p0, p1], fill=252, width=1)

    rough = np.asarray(rough_img, dtype=np.float32) / 255.0  # ~0.36..0.44 bead-blasted roughness
    height = np.asarray(bump_img, dtype=np.float32) / 255.0
    slide_mod = np.asarray(albedo_img, dtype=np.float32) / 255.0

    # 2. Fine wet rain droplets beading across anodized slide
    for _ in range(droplet_count):
        cx = rng.random() * size
        cy = rng.random() * size
        rad = max(0.85, (0.9 + rng.random() * 1.8) * (size / 512.0))
        r_ceil = int(np.ceil(rad)) + 1
        x_idx = np.arange(int(cx) - r_ceil, int(cx) + r_ceil + 1) % size
        y_idx = np.arange(int(cy) - r_ceil, int(cy) + r_ceil + 1) % size

        dx = ((x_idx - cx + size * 0.5) % size - size * 0.5) / rad
        dy = ((y_idx - cy + size * 0.5) % size - size * 0.5) / rad
        t2 = (dx[None, :] ** 2) + (dy[:, None] ** 2)
        inside = t2 <= 1.0

        dome = np.where(inside, 0.52 + 0.44 * np.sqrt(np.maximum(0.0, 1.0 - t2)), 0.0).astype(np.float32)
        patch_h = height[np.ix_(y_idx, x_idx)]
        patch_h[inside] = np.maximum(patch_h[inside], dome[inside])
        height[np.ix_(y_idx, x_idx)] = patch_h

        patch_r = rough[np.ix_(y_idx, x_idx)]
        patch_r[inside] = 0.055
        rough[np.ix_(y_idx, x_idx)] = patch_r

        patch_a = slide_mod[np.ix_(y_idx, x_idx)]
        patch_a[inside] *= 0.92
        slide_mod[np.ix_(y_idx, x_idx)] = patch_a

    slide_normal_rgb = _height_to_normal(np.clip(height, 0.0, 1.0), strength=3.0)

    slide_albedo_rgb = np.repeat(np.clip(slide_mod * 255.0, 0, 255).astype(np.uint8)[..., None], 3, axis=2)
    slide_mr_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    slide_mr_rgb[..., 1] = np.clip(rough * 1.18 * 255.0, 0, 255).astype(np.uint8)  # ~0.46 base, 0.06 droplets
    slide_mr_rgb[..., 2] = 255

    # Decoupled matte polymer frame/mag (no slide holster scratches, no glossy droplets, B=0)
    poly_grain = np_rng.normal(0.0, 0.032, (size, size)).astype(np.float32)
    poly_rough = np.clip(0.84 + poly_grain, 0.76, 0.90)
    poly_mr_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    poly_mr_rgb[..., 1] = np.clip(poly_rough * 255.0, 192, 232).astype(np.uint8)
    poly_mr_rgb[..., 2] = 0
    poly_albedo_rgb = np.repeat(np.clip(226.0 + poly_grain * 180.0, 195, 248).astype(np.uint8)[..., None], 3, axis=2)
    polymer_normal_rgb = _height_to_normal(np.clip(0.50 + poly_grain * 1.4, 0.0, 1.0), strength=1.8)

    # 3. Gen4/Gen5 Glock square-pyramid grip stippling pattern (step = 8px)
    step = max(4, (8 * size) // 512)
    stipple_h = np.full((size, size), 0.22, dtype=np.float32)
    stipple_rough = np.full((size, size), 0.86, dtype=np.float32)
    stipple_alb = np.full((size, size), 205.0, dtype=np.float32)

    cells_y = size // step
    cells_x = size // step
    for cy_i in range(cells_y):
        for cx_i in range(cells_x):
            jitter = (rng.random() - 0.5) * 0.08
            y0, x0 = cy_i * step, cx_i * step
            for py in range(1, step - 1):
                for px in range(1, step - 1):
                    # Pyramid peak toward cell center for crisp angled specular micro-facets
                    dist_edge = min(px, py, step - 1 - px, step - 1 - py) / max(1.0, (step - 2) * 0.5)
                    h_val = 0.56 + 0.34 * dist_edge + jitter
                    stipple_h[y0 + py, x0 + px] = h_val
                    stipple_rough[y0 + py, x0 + px] = 0.74 - 0.08 * dist_edge
                    stipple_alb[y0 + py, x0 + px] = 232.0 + 18.0 * dist_edge

    stipple_normal_rgb = _height_to_normal(np.clip(stipple_h, 0.0, 1.0), strength=3.8)
    stipple_mr_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    stipple_mr_rgb[..., 1] = np.clip(stipple_rough * 255.0, 0, 255).astype(np.uint8)
    stipple_mr_rgb[..., 2] = 0
    stipple_alb_rgb = np.repeat(np.clip(stipple_alb, 0, 255).astype(np.uint8)[..., None], 3, axis=2)

    return PistolTextures(
        slide_albedo_png=_encode_png(slide_albedo_rgb, mode="RGB"),
        slide_mr_png=_encode_png(slide_mr_rgb, mode="RGB"),
        slide_normal_png=_encode_png(slide_normal_rgb, mode="RGB"),
        polymer_albedo_png=_encode_png(poly_albedo_rgb, mode="RGB"),
        polymer_mr_png=_encode_png(poly_mr_rgb, mode="RGB"),
        stipple_albedo_png=_encode_png(stipple_alb_rgb, mode="RGB"),
        stipple_mr_png=_encode_png(stipple_mr_rgb, mode="RGB"),
        stipple_normal_png=_encode_png(stipple_normal_rgb, mode="RGB"),
        size=size,
        polymer_normal_png=_encode_png(polymer_normal_rgb, mode="RGB"),
    )
