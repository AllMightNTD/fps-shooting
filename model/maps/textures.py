"""Procedural weathered PBR textures for Khu Quân Sự Cũ map assets."""

from __future__ import annotations

from dataclasses import dataclass
import io

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def _encode_png(arr_u8: np.ndarray) -> bytes:
    img = Image.fromarray(arr_u8)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _periodic_fbm(size: int, seed: int, octaves: tuple[int, ...] = (4, 8, 16, 32)) -> np.ndarray:
    """Fast vectorized seamless periodic value noise in [0, 1]."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((size, size), dtype=np.float32)
    weight_sum = 0.0
    for idx, period in enumerate(octaves):
        w = 0.5 ** idx
        grid = rng.random((period, period), dtype=np.float32)
        ys = (np.arange(size, dtype=np.float32) / size) * period
        xs = (np.arange(size, dtype=np.float32) / size) * period
        y0 = np.floor(ys).astype(np.int32) % period
        x0 = np.floor(xs).astype(np.int32) % period
        y1 = (y0 + 1) % period
        x1 = (x0 + 1) % period
        fy = (ys - np.floor(ys))[:, None]
        fx = (xs - np.floor(xs))[None, :]
        sy = fy * fy * (3.0 - 2.0 * fy)
        sx = fx * fx * (3.0 - 2.0 * fx)

        c00 = grid[np.ix_(y0, x0)]
        c10 = grid[np.ix_(y0, x1)]
        c01 = grid[np.ix_(y1, x0)]
        c11 = grid[np.ix_(y1, x1)]
        interp = (c00 * (1.0 - sx) + c10 * sx) * (1.0 - sy) + (c01 * (1.0 - sx) + c11 * sx) * sy
        acc += interp * w
        weight_sum += w
    return np.clip(acc / weight_sum, 0.0, 1.0)


def _height_to_normal_png(height: np.ndarray, strength: float = 2.2) -> bytes:
    """Convert periodic heightmap [0, 1] into tangent-space RGB normal map PNG."""
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength
    nx = -gx
    ny = -gy
    nz = np.ones_like(height, dtype=np.float32)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([
        np.clip((nx * inv_len * 0.5 + 0.5) * 255.0, 0, 255),
        np.clip((ny * inv_len * 0.5 + 0.5) * 255.0, 0, 255),
        np.clip((nz * inv_len * 0.5 + 0.5) * 255.0, 0, 255),
    ], axis=-1).astype(np.uint8)
    return _encode_png(rgb)


def _make_mr_png(roughness: np.ndarray, metalness: np.ndarray) -> bytes:
    """Pack glTF 2.0 metallicRoughnessTexture (G=roughness, B=metalness, R=AO=1)."""
    h, w = roughness.shape
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[:, :, 0] = 255
    rgb[:, :, 1] = np.clip(roughness * 255.0, 10, 250).astype(np.uint8)
    rgb[:, :, 2] = np.clip(metalness * 255.0, 0, 255).astype(np.uint8)
    return _encode_png(rgb)


@dataclass(frozen=True)
class MilitaryMapTextures:
    """Compact PBR texture bundle shared across military map models."""

    container_albedo: bytes
    container_mr: bytes
    container_normal: bytes
    container_stencil: bytes

    concrete_albedo: bytes
    concrete_mr: bytes
    concrete_normal: bytes

    roof_albedo: bytes
    roof_mr: bytes
    roof_normal: bytes

    steel_albedo: bytes
    steel_mr: bytes
    steel_normal: bytes

    olive_albedo: bytes
    olive_mr: bytes

    rubber_albedo: bytes
    wood_albedo: bytes
    sandbag_albedo: bytes
    sandbag_normal: bytes
    camo_net_albedo: bytes
    barrel_albedo: bytes
    barrel_mr: bytes


def build_military_textures(tex_size: int = 256, seed: int = 101) -> MilitaryMapTextures:
    """Generate all weathered military PBR maps at ``tex_size``."""
    s = max(64, int(tex_size))
    c_size = min(512, max(256, s * 2))

    # 1. Container weathered metal (gravity-fed vertical rust drips, bare steel scratches, bottom grime)
    fbm1 = _periodic_fbm(c_size, seed + 1, (8, 24, 64, 128))
    fbm2 = _periodic_fbm(c_size, seed + 2, (16, 48, 96))
    drip_col = _periodic_fbm(c_size, seed + 21, (12, 32, 64))
    drip_col = 0.35 * drip_col + 0.65 * np.mean(drip_col, axis=0, keepdims=True)
    scratch_raw = _periodic_fbm(c_size, seed + 29, (32, 96, 160))
    scratch = np.clip((scratch_raw - 0.70) * 5.5, 0.0, 1.0)
    v = np.linspace(0.0, 1.0, c_size, dtype=np.float32)[:, None]
    # Vertical edge bands (top rain-drip rust + bottom splashed grime) that tile smoothly across UV seams
    edge_drip = np.exp(-np.minimum(v, 1.0 - v) * 9.5)
    vertical_drip = np.clip((drip_col - 0.44) * 3.4, 0.0, 1.0) * (0.38 + 0.85 * edge_drip)
    patch_rust = np.clip((fbm1 - 0.58) * 3.8 + np.maximum(0.0, fbm2 - 0.68) * 1.8, 0.0, 1.0)
    rust_mask = np.clip(vertical_drip * 0.85 + patch_rust * 0.72, 0.0, 1.0)
    grime_band = np.clip((0.28 - np.minimum(v, 1.0 - v)) / 0.28, 0.0, 1.0) * (0.45 + 0.55 * fbm1)
    # Deeper chalky industrial paint value so tinted containers keep rich saturation under sun
    paint_val = np.clip(0.68 + 0.14 * fbm2 - 0.18 * grime_band - 0.12 * rust_mask + 0.16 * scratch, 0.28, 0.92)
    c_alb = np.zeros((c_size, c_size, 3), dtype=np.float32)
    c_alb[:, :, 0] = paint_val * (1.0 - rust_mask * 0.48) + rust_mask * 0.33 + scratch * 0.10
    c_alb[:, :, 1] = paint_val * (1.0 - rust_mask * 0.74) + rust_mask * 0.14 + scratch * 0.10
    c_alb[:, :, 2] = paint_val * (1.0 - rust_mask * 0.84) + rust_mask * 0.07 + scratch * 0.11
    container_albedo = _encode_png(np.clip(c_alb * 255.0, 0, 255).astype(np.uint8))
    container_mr = _make_mr_png(
        roughness=np.clip(0.62 + 0.30 * rust_mask + 0.10 * grime_band - 0.34 * scratch + 0.05 * fbm2, 0.24, 0.96),
        metalness=np.clip(0.16 * (1.0 - rust_mask) * (1.0 - grime_band) + 0.74 * scratch + 0.05 * rust_mask, 0.04, 0.88),
    )
    container_normal = _height_to_normal_png(fbm2 * 0.45 + rust_mask * 0.48 - scratch * 0.28, strength=2.3)

    # Stencil decal plate for container doors/sides (crisp military markings)
    st_img = Image.new("RGBA", (256, 128), (38, 42, 46, 255))
    st_draw = ImageDraw.Draw(st_img)
    st_draw.rectangle([4, 4, 251, 123], outline=(165, 162, 148, 220), width=3)
    st_draw.text((16, 16), "USAF  408219  4", fill=(215, 212, 198, 240))
    st_draw.text((16, 46), "MAX GROSS 30480 KG", fill=(195, 190, 175, 225))
    st_draw.text((16, 74), "TARE  2240 KG   CU.M 33", fill=(185, 180, 165, 210))
    # Subtle weathering noise over stencil plate
    st_arr = np.asarray(st_img, dtype=np.float32)
    st_n = _periodic_fbm(128, seed + 31, (8, 24))
    st_n = np.repeat(st_n, 2, axis=1)
    st_arr[:, :, :3] *= (0.78 + 0.28 * st_n[:, :, None])
    container_stencil = _encode_png(np.clip(st_arr, 0, 255).astype(np.uint8))

    # 2. Weathered architectural concrete (formwork joints, tie-rod recesses, rain streaks, spalling — zero contour loops)
    c_macro = _periodic_fbm(s, seed + 3, (4, 8, 16))
    c_fine = _periodic_fbm(s, seed + 4, (16, 32, 64, 128))
    c_grit = _periodic_fbm(s, seed + 5, (32, 64, 128))
    # Formwork horizontal & vertical panel seams + subtle tie-rod bolt holes
    ys_f = np.linspace(0.0, 1.0, s, dtype=np.float32)[:, None]
    xs_f = np.linspace(0.0, 1.0, s, dtype=np.float32)[None, :]
    seam_h = np.clip(1.0 - np.abs(ys_f - 0.50) / 0.011, 0.0, 1.0)
    seam_v = np.clip(1.0 - np.abs(xs_f - 0.50) / 0.009, 0.0, 1.0)
    seam = np.maximum(seam_h, seam_v) * (0.55 + 0.45 * c_fine)
    # 4 recessed formwork tie holes per panel
    tie_holes = np.zeros((s, s), dtype=np.float32)
    for hy in (0.25, 0.75):
        for hx in (0.25, 0.75):
            d2 = (xs_f - hx) ** 2 + (ys_f - hy) ** 2
            tie_holes = np.maximum(tie_holes, np.clip(1.0 - np.sqrt(d2) / 0.018, 0.0, 1.0))
    # Spalled rough aggregate pockets & vertical rain-water stain streaks (no closed contour rings!)
    spall = np.clip((c_macro * 0.65 + c_fine * 0.35 - 0.62) * 3.2, 0.0, 1.0) * c_grit
    drip_raw = _periodic_fbm(s, seed + 33, (8, 24, 48))
    drip = np.clip((0.35 * drip_raw + 0.65 * np.mean(drip_raw, axis=0, keepdims=True) - 0.44) * 2.4, 0.0, 1.0)
    moss = np.clip((c_macro - 0.56) * 2.4, 0.0, 1.0) * (0.40 + 0.60 * c_fine) * (0.35 + 0.65 * drip)
    conc_luma = np.clip(
        0.37 + 0.10 * c_macro + 0.11 * c_fine + 0.05 * (c_grit - 0.5)
        - 0.11 * seam - 0.15 * tie_holes - 0.09 * drip - 0.10 * spall,
        0.13,
        0.58,
    )
    conc_rgb = np.stack([
        conc_luma * (1.02 - 0.10 * moss) + 0.025 * spall,
        conc_luma * (1.00 + 0.04 * moss) + 0.015 * spall + 0.025 * moss,
        conc_luma * (0.94 - 0.12 * moss) + 0.008 * spall,
    ], axis=-1)
    concrete_albedo = _encode_png(np.clip(conc_rgb * 255.0, 0, 255).astype(np.uint8))
    concrete_mr = _make_mr_png(
        roughness=np.clip(0.84 + 0.10 * c_fine + 0.06 * spall, 0.74, 0.98),
        metalness=np.zeros((s, s), dtype=np.float32),
    )
    concrete_normal = _height_to_normal_png(
        c_fine * 0.65 + c_grit * 0.25 - spall * 0.24 - seam * 0.20 - tie_holes * 0.22,
        strength=1.95,
    )

    # 3. Rusty corrugated iron roof (longitudinal rust streaks along ribs)
    u_s = np.linspace(0.0, 1.0, s, dtype=np.float32)[None, :]
    rib_wave = 0.5 + 0.5 * np.sin(u_s * 2.0 * np.pi * 16.0)
    r_fine = _periodic_fbm(s, seed + 7, (8, 24, 64, 128))
    r_streak = np.mean(_periodic_fbm(s, seed + 27, (8, 24)), axis=0, keepdims=True)
    r_rust = np.clip((r_fine * 0.55 + r_streak * 0.45 - 0.40) * 2.5, 0.0, 1.0)
    r_rgb = np.stack([
        0.28 * (1.0 - r_rust) + 0.42 * r_rust + 0.04 * rib_wave,
        0.29 * (1.0 - r_rust) + 0.20 * r_rust + 0.03 * rib_wave,
        0.31 * (1.0 - r_rust) + 0.12 * r_rust + 0.03 * rib_wave,
    ], axis=-1)
    roof_albedo = _encode_png(np.clip(r_rgb * 255.0, 0, 255).astype(np.uint8))
    roof_mr = _make_mr_png(
        roughness=np.clip(0.54 + 0.38 * r_rust, 0.40, 0.96),
        metalness=np.clip(0.64 * (1.0 - r_rust) + 0.14 * r_rust, 0.10, 0.76),
    )
    roof_normal = _height_to_normal_png(rib_wave * 0.65 + r_fine * 0.35, strength=2.6)

    # 4. Weathered structural steel with brushed metallic edge sheen (reads clearly, not flat black)
    st_noise = _periodic_fbm(s, seed + 8, (8, 24, 64))
    st_fine = _periodic_fbm(s, seed + 38, (24, 64, 128))
    st_rust = np.clip((st_noise - 0.62) * 3.0, 0.0, 1.0)
    st_wear = np.clip((st_fine - 0.64) * 3.2, 0.0, 1.0) * (1.0 - st_rust)
    st_rgb = np.stack([
        0.24 + 0.11 * st_noise + 0.16 * st_wear + 0.18 * st_rust,
        0.26 + 0.11 * st_noise + 0.17 * st_wear + 0.06 * st_rust,
        0.29 + 0.11 * st_noise + 0.18 * st_wear + 0.01 * st_rust,
    ], axis=-1)
    steel_albedo = _encode_png(np.clip(st_rgb * 255.0, 0, 255).astype(np.uint8))
    steel_mr = _make_mr_png(
        roughness=np.clip(0.42 + 0.44 * st_rust - 0.16 * st_wear + 0.08 * st_noise, 0.24, 0.94),
        metalness=np.clip(0.80 * (1.0 - st_rust) + 0.12 * st_wear + 0.14 * st_rust, 0.15, 0.92),
    )
    steel_normal = _height_to_normal_png(st_noise * 0.55 + st_fine * 0.25 + st_rust * 0.30, strength=2.0)

    # 5. Olive military paint (heavy rust scratches & mud grime for truck/parapet)
    ol_n = _periodic_fbm(s, seed + 9, (8, 24, 64))
    ol_chip = np.clip((ol_n - 0.58) * 3.4, 0.0, 1.0)
    ol_rgb = np.stack([
        0.28 * (1.0 - ol_chip) + 0.36 * ol_chip,
        0.32 * (1.0 - ol_chip) + 0.21 * ol_chip,
        0.21 * (1.0 - ol_chip) + 0.12 * ol_chip,
    ], axis=-1)
    olive_albedo = _encode_png(np.clip(ol_rgb * 255.0, 0, 255).astype(np.uint8))
    olive_mr = _make_mr_png(
        roughness=np.clip(0.64 + 0.26 * ol_chip + 0.08 * ol_n, 0.50, 0.95),
        metalness=np.clip(0.18 + 0.35 * ol_chip, 0.12, 0.60),
    )

    # 6. Mud-caked tire rubber, wood crate, burlap sandbag
    tr_n = _periodic_fbm(s, seed + 10, (8, 24, 64))
    mud = np.clip((tr_n - 0.55) * 2.8, 0.0, 1.0)
    tread = 0.5 + 0.5 * np.sin(u_s * 2.0 * np.pi * 20.0)
    rb_rgb = np.stack([
        0.10 + 0.05 * tr_n + 0.04 * tread + 0.22 * mud,
        0.10 + 0.05 * tr_n + 0.04 * tread + 0.17 * mud,
        0.11 + 0.05 * tr_n + 0.04 * tread + 0.11 * mud,
    ], axis=-1)
    rubber_albedo = _encode_png(np.clip(rb_rgb * 255.0, 0, 255).astype(np.uint8))

    wd_n = _periodic_fbm(s, seed + 11, (8, 24, 64))
    v_s = np.linspace(0.0, 1.0, s, dtype=np.float32)[:, None]
    plank = np.abs(np.sin(v_s * np.pi * 6.0))
    grain = np.sin(u_s * 2.0 * np.pi * 12.0 + wd_n * 6.0) * 0.5 + 0.5
    wd_rgb = np.stack([
        0.36 + 0.10 * grain + 0.06 * wd_n - 0.10 * (1.0 - np.clip(plank * 4.0, 0.0, 1.0)),
        0.28 + 0.08 * grain + 0.05 * wd_n - 0.08 * (1.0 - np.clip(plank * 4.0, 0.0, 1.0)),
        0.18 + 0.05 * grain + 0.03 * wd_n - 0.06 * (1.0 - np.clip(plank * 4.0, 0.0, 1.0)),
    ], axis=-1)
    wood_albedo = _encode_png(np.clip(wd_rgb * 255.0, 0, 255).astype(np.uint8))

    sb_n = _periodic_fbm(s, seed + 12, (8, 24, 64))
    weave = (np.sin(u_s * 2.0 * np.pi * 28.0) * np.sin(v_s * 2.0 * np.pi * 28.0)) * 0.5 + 0.5
    sb_rgb = np.stack([
        0.42 + 0.10 * sb_n + 0.05 * weave,
        0.37 + 0.09 * sb_n + 0.04 * weave,
        0.27 + 0.07 * sb_n + 0.03 * weave,
    ], axis=-1)
    sandbag_albedo = _encode_png(np.clip(sb_rgb * 255.0, 0, 255).astype(np.uint8))
    sandbag_normal = _height_to_normal_png(weave * 0.55 + sb_n * 0.45, strength=2.4)

    # 7. Camouflage netting RGBA (alpha cutout mesh holes for watchtower parapet)
    cn1 = _periodic_fbm(s, seed + 41, (8, 24, 48))
    cn2 = _periodic_fbm(s, seed + 42, (16, 48))
    hole_wave = np.sin(u_s * 2.0 * np.pi * 18.0 + cn1 * 4.0) * np.sin(v_s * 2.0 * np.pi * 18.0 + cn2 * 4.0)
    alpha = np.where((hole_wave > -0.18) | (cn1 > 0.62), 245, 0).astype(np.uint8)
    cn_rgb = np.stack([
        np.clip((0.18 + 0.16 * cn1) * 255.0, 0, 255),
        np.clip((0.23 + 0.16 * cn1 - 0.04 * cn2) * 255.0, 0, 255),
        np.clip((0.13 + 0.08 * cn2) * 255.0, 0, 255),
    ], axis=-1).astype(np.uint8)
    camo_net_albedo = _encode_png(np.dstack([cn_rgb, alpha]))

    # 8. Rusty oil barrel (neutral tintable metal + rib grime + horizontal rust rings)
    br_n = _periodic_fbm(s, seed + 51, (8, 24, 64))
    br_rust = np.clip((br_n - 0.56) * 3.4 + np.maximum(0.0, np.abs(v_s - 0.5) - 0.35) * 1.4, 0.0, 1.0)
    br_val = 0.78 + 0.14 * br_n - 0.22 * br_rust
    br_rgb = np.stack([
        br_val * (1.0 - br_rust * 0.40) + br_rust * 0.36,
        br_val * (1.0 - br_rust * 0.68) + br_rust * 0.16,
        br_val * (1.0 - br_rust * 0.80) + br_rust * 0.08,
    ], axis=-1)
    barrel_albedo = _encode_png(np.clip(br_rgb * 255.0, 0, 255).astype(np.uint8))
    barrel_mr = _make_mr_png(
        roughness=np.clip(0.45 + 0.45 * br_rust, 0.30, 0.95),
        metalness=np.clip(0.68 * (1.0 - br_rust) + 0.15 * br_rust, 0.12, 0.82),
    )

    return MilitaryMapTextures(
        container_albedo=container_albedo,
        container_mr=container_mr,
        container_normal=container_normal,
        container_stencil=container_stencil,
        concrete_albedo=concrete_albedo,
        concrete_mr=concrete_mr,
        concrete_normal=concrete_normal,
        roof_albedo=roof_albedo,
        roof_mr=roof_mr,
        roof_normal=roof_normal,
        steel_albedo=steel_albedo,
        steel_mr=steel_mr,
        steel_normal=steel_normal,
        olive_albedo=olive_albedo,
        olive_mr=olive_mr,
        rubber_albedo=rubber_albedo,
        wood_albedo=wood_albedo,
        sandbag_albedo=sandbag_albedo,
        sandbag_normal=sandbag_normal,
        camo_net_albedo=camo_net_albedo,
        barrel_albedo=barrel_albedo,
        barrel_mr=barrel_mr,
    )
