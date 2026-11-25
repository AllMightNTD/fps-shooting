"""Procedural 3D mesh primitives, bevel/extrude builders, and transforms."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Sequence

import numpy as np


@dataclass(frozen=True)
class MeshData:
    """Indexed triangle mesh in right-handed Y-up coordinates (glTF / Three.js)."""

    positions: np.ndarray  # (N, 3) float32
    normals: np.ndarray    # (N, 3) float32
    uvs: np.ndarray        # (N, 2) float32
    indices: np.ndarray    # (M,) uint32

    def __post_init__(self) -> None:
        if self.positions.ndim != 2 or self.positions.shape[1] != 3:
            raise ValueError("positions must have shape (N, 3)")
        if self.normals.shape != self.positions.shape:
            raise ValueError("normals must match positions shape")
        if self.uvs.shape != (self.positions.shape[0], 2):
            raise ValueError("uvs must have shape (N, 2)")
        if self.indices.ndim != 1 or len(self.indices) % 3 != 0:
            raise ValueError("indices must be a 1D triangle list")


def _rotation_matrix_xyz(rx: float, ry: float, rz: float) -> np.ndarray:
    """Build 3x3 rotation matrix matching THREE.Euler(rx, ry, rz, 'XYZ')."""
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)

    mx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    return mx @ my @ mz


def _box_uv_for_face(pos: np.ndarray, dir_u: np.ndarray, dir_v: np.ndarray, uv_scale: float) -> np.ndarray:
    """Project 3D vertex positions onto face tangent axes for uniform world-scale UVs."""
    u = (pos @ dir_u) * uv_scale
    v = (pos @ dir_v) * uv_scale
    return np.column_stack((u, v)).astype(np.float32)


def transform_mesh(
    mesh: MeshData,
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> MeshData:
    """Return a transformed copy of ``mesh`` using XYZ Euler order and translation."""
    sx, sy, sz = scale
    if sx == 0.0 or sy == 0.0 or sz == 0.0:
        raise ValueError("scale components must be non-zero")

    rot = _rotation_matrix_xyz(*rotation)
    linear = rot @ np.diag([sx, sy, sz])
    t_vec = np.asarray(translation, dtype=np.float64)

    new_pos = (mesh.positions.astype(np.float64) @ linear.T) + t_vec

    # Use inverse-transpose of linear transform so non-uniform scales preserve normals.
    normal_mat = np.linalg.inv(linear).T
    new_norm = mesh.normals.astype(np.float64) @ normal_mat.T
    norms_len = np.linalg.norm(new_norm, axis=1, keepdims=True)
    norms_len = np.where(norms_len > 1e-12, norms_len, 1.0)
    new_norm = new_norm / norms_len

    indices = mesh.indices.copy()
    if np.linalg.det(linear) < 0.0:
        indices = indices.reshape(-1, 3)[:, [0, 2, 1]].reshape(-1)

    return MeshData(
        positions=new_pos.astype(np.float32),
        normals=new_norm.astype(np.float32),
        uvs=mesh.uvs.copy(),
        indices=indices,
    )


def merge_meshes(meshes: Sequence[MeshData]) -> MeshData:
    """Merge multiple meshes into a single indexed MeshData to minimize draw calls."""
    if not meshes:
        raise ValueError("meshes must not be empty")
    if len(meshes) == 1:
        m = meshes[0]
        return MeshData(m.positions.copy(), m.normals.copy(), m.uvs.copy(), m.indices.copy())

    pos_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    uv_list: list[np.ndarray] = []
    idx_list: list[np.ndarray] = []
    offset = 0

    for m in meshes:
        pos_list.append(m.positions)
        norm_list.append(m.normals)
        uv_list.append(m.uvs)
        idx_list.append(m.indices.astype(np.uint32) + offset)
        offset += m.positions.shape[0]

    return MeshData(
        positions=np.vstack(pos_list).astype(np.float32),
        normals=np.vstack(norm_list).astype(np.float32),
        uvs=np.vstack(uv_list).astype(np.float32),
        indices=np.concatenate(idx_list).astype(np.uint32),
    )


def create_box(
    width: float,
    height: float,
    depth: float,
    uv_scale: float = 5.0,
) -> MeshData:
    """Create a centered axis-aligned box with flat face normals and world-scaled UVs."""
    if width <= 0.0 or height <= 0.0 or depth <= 0.0:
        raise ValueError("box dimensions must be strictly positive")

    hx, hy, hz = width * 0.5, height * 0.5, depth * 0.5
    faces = [
        ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
        ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
        ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
        ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
    ]
    half = np.array([hx, hy, hz], dtype=np.float64)

    positions: list[np.ndarray] = []
    normals: list[np.ndarray] = []
    uvs: list[np.ndarray] = []
    indices: list[int] = []

    for fi, (n_tup, u_tup, v_tup) in enumerate(faces):
        n_vec = np.asarray(n_tup, dtype=np.float64)
        u_vec = np.asarray(u_tup, dtype=np.float64)
        v_vec = np.asarray(v_tup, dtype=np.float64)

        corners = [
            n_vec - u_vec - v_vec,
            n_vec + u_vec - v_vec,
            n_vec + u_vec + v_vec,
            n_vec - u_vec + v_vec,
        ]
        face_pos = np.array([c * half for c in corners], dtype=np.float64)
        positions.append(face_pos)
        normals.append(np.tile(n_vec, (4, 1)))
        uvs.append(_box_uv_for_face(face_pos, u_vec, v_vec, uv_scale))

        base = fi * 4
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])

    return MeshData(
        positions=np.vstack(positions).astype(np.float32),
        normals=np.vstack(normals).astype(np.float32),
        uvs=np.vstack(uvs).astype(np.float32),
        indices=np.asarray(indices, dtype=np.uint32),
    )


def create_beveled_box(
    width: float,
    height: float,
    depth: float,
    bevel: float = 0.0025,
    segments: int = 3,
    uv_scale: float = 5.0,
) -> MeshData:
    """Create a centered box with smooth rounded bevels of exact outer dimensions (w, h, d)."""
    if width <= 0.0 or height <= 0.0 or depth <= 0.0:
        raise ValueError("box dimensions must be strictly positive")
    if bevel < 0.0:
        raise ValueError("bevel must be non-negative")
    if segments < 1:
        raise ValueError("segments must be >= 1")
    if bevel == 0.0:
        return create_box(width, height, depth, uv_scale=uv_scale)

    b = min(bevel, width * 0.499, height * 0.499, depth * 0.499)
    inner = np.array([width * 0.5 - b, height * 0.5 - b, depth * 0.5 - b], dtype=np.float64)
    s = segments * 2 + 1
    hs = 0.5 / s
    coords = np.linspace(-0.5, 0.5, s + 1, dtype=np.float64)

    faces = [
        ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
        ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
        ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
        ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
    ]

    pos_all: list[np.ndarray] = []
    norm_all: list[np.ndarray] = []
    uv_all: list[np.ndarray] = []
    idx_all: list[int] = []

    stride = s + 1
    for fi, (n_tup, u_tup, v_tup) in enumerate(faces):
        n_vec = np.asarray(n_tup, dtype=np.float64)
        u_vec = np.asarray(u_tup, dtype=np.float64)
        v_vec = np.asarray(v_tup, dtype=np.float64)

        uu, vv = np.meshgrid(coords, coords, indexing="xy")
        uu_f = uu.reshape(-1, 1)
        vv_f = vv.reshape(-1, 1)
        p_cube = (n_vec * 0.5) + uu_f * u_vec + vv_f * v_vec
        sgn = np.sign(p_cube)
        n_raw = p_cube - sgn * hs
        n_len = np.linalg.norm(n_raw, axis=1, keepdims=True)
        n_unit = n_raw / np.where(n_len > 1e-12, n_len, 1.0)
        pos = sgn * inner + n_unit * b

        pos_all.append(pos)
        norm_all.append(n_unit)
        uv_all.append(_box_uv_for_face(pos, u_vec, v_vec, uv_scale))

        base = fi * stride * stride
        for iv in range(s):
            for iu in range(s):
                i00 = base + iv * stride + iu
                i10 = i00 + 1
                i01 = i00 + stride
                i11 = i01 + 1
                idx_all.extend([i00, i10, i11, i00, i11, i01])

    return MeshData(
        positions=np.vstack(pos_all).astype(np.float32),
        normals=np.vstack(norm_all).astype(np.float32),
        uvs=np.vstack(uv_all).astype(np.float32),
        indices=np.asarray(idx_all, dtype=np.uint32),
    )


def _signed_area_2d(pts: list[tuple[float, float]]) -> float:
    n = len(pts)
    return 0.5 * sum(
        pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
        for i in range(n)
    )


def _point_in_triangle_2d(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
) -> bool:
    def cross(o: tuple[float, float], u: tuple[float, float], v: tuple[float, float]) -> float:
        return (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0])

    c1 = cross(a, b, p)
    c2 = cross(b, c, p)
    c3 = cross(c, a, p)
    return c1 >= -1e-10 and c2 >= -1e-10 and c3 >= -1e-10


def _ear_clip_triangulate(pts: list[tuple[float, float]]) -> list[tuple[int, int, int]]:
    """Triangulate a simple CCW 2D polygon using ear clipping."""
    n = len(pts)
    if n < 3:
        raise ValueError("polygon must have at least 3 vertices")
    if n == 3:
        return [(0, 1, 2)]

    rem = list(range(n))
    tris: list[tuple[int, int, int]] = []
    guard = 0

    while len(rem) > 3:
        clipped = False
        m = len(rem)
        for idx in range(m):
            i_prev = rem[(idx - 1) % m]
            i_curr = rem[idx]
            i_next = rem[(idx + 1) % m]
            a, b, c = pts[i_prev], pts[i_curr], pts[i_next]
            cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            if cross <= 1e-12:
                continue
            if any(
                _point_in_triangle_2d(pts[k], a, b, c)
                for k in rem
                if k not in (i_prev, i_curr, i_next)
            ):
                continue
            tris.append((i_prev, i_curr, i_next))
            del rem[idx]
            clipped = True
            break
        if not clipped:
            guard += 1
            if guard > n:
                raise ValueError("polygon triangulation failed (possibly self-intersecting)")
    tris.append((rem[0], rem[1], rem[2]))
    return tris


def _outward_miter_vectors(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Compute outward 2D miter offset unit-scaled vectors for a CCW polygon."""
    n = len(pts)
    miters: list[tuple[float, float]] = []
    for i in range(n):
        p_prev = pts[(i - 1) % n]
        p_curr = pts[i]
        p_next = pts[(i + 1) % n]

        e0x, e0y = p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]
        e1x, e1y = p_next[0] - p_curr[0], p_next[1] - p_curr[1]
        l0 = math.hypot(e0x, e0y)
        l1 = math.hypot(e1x, e1y)
        if l0 < 1e-12 or l1 < 1e-12:
            raise ValueError("polygon contains degenerate zero-length edge")

        # CCW boundary outward normals are edge vectors rotated -90 deg: (dy, -dx).
        n0x, n0y = e0y / l0, -e0x / l0
        n1x, n1y = e1y / l1, -e1x / l1
        bx, by = n0x + n1x, n0y + n1y
        denom = bx * n1x + by * n1y
        if denom < 0.25:
            # Clamp miter spike on sharp reflex/acute corners.
            bl = math.hypot(bx, by) or 1.0
            miters.append((2.5 * bx / bl, 2.5 * by / bl))
        else:
            miters.append((bx / denom, by / denom))
    return miters


def extrude_shape(
    points_2d: Sequence[tuple[float, float]],
    depth: float,
    bevel_size: float = 0.0,
    bevel_thickness: float = 0.0,
    bevel_segments: int = 3,
    center: bool = False,
    uv_scale: float = 5.0,
) -> MeshData:
    """Extrude a 2D polygon along +Z with optional Three.js-compatible outward bevel."""
    pts = list(points_2d)
    if len(pts) >= 2 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        raise ValueError("extrude_shape requires at least 3 distinct points")
    if depth <= 0.0:
        raise ValueError("depth must be strictly positive")
    if bevel_size < 0.0 or bevel_thickness < 0.0:
        raise ValueError("bevel parameters must be non-negative")
    if bevel_segments < 1:
        raise ValueError("bevel_segments must be >= 1")

    area = _signed_area_2d(pts)
    if abs(area) < 1e-12:
        raise ValueError("polygon area is zero")
    if area < 0.0:
        pts.reverse()

    cap_tris = _ear_clip_triangulate(pts)
    miters = _outward_miter_vectors(pts)
    n = len(pts)
    has_bevel = bevel_size > 0.0 and bevel_thickness > 0.0

    # Build Z/XY-offset profile rings matching THREE.ExtrudeGeometry semantics:
    # Back cap at z=-bt (offset 0), curving outward to (z=0, offset=bs),
    # straight body to (z=depth, offset=bs), curving inward to front cap (z=depth+bt, offset=0).
    rings: list[tuple[float, float]] = []
    if has_bevel:
        for s in range(bevel_segments + 1):
            ang = (math.pi * 0.5) * (s / bevel_segments)
            z = -bevel_thickness * math.cos(ang)
            off = bevel_size * math.sin(ang)
            rings.append((z, off))
        for s in range(bevel_segments + 1):
            ang = (math.pi * 0.5) * (s / bevel_segments)
            z = depth + bevel_thickness * math.sin(ang)
            off = bevel_size * math.cos(ang)
            rings.append((z, off))
    else:
        rings = [(0.0, 0.0), (depth, 0.0)]

    pos_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    uv_list: list[np.ndarray] = []
    idx_list: list[int] = []
    v_offset = 0

    def add_cap(z_val: float, normal_z: float, reverse_winding: bool) -> None:
        nonlocal v_offset
        cap_pos = np.array([[x, y, z_val] for x, y in pts], dtype=np.float64)
        cap_norm = np.tile([0.0, 0.0, normal_z], (n, 1))
        cap_uv = np.array([[x * uv_scale, y * uv_scale] for x, y in pts], dtype=np.float64)
        pos_list.append(cap_pos)
        norm_list.append(cap_norm)
        uv_list.append(cap_uv)
        for a, b, c in cap_tris:
            if reverse_winding:
                idx_list.extend([v_offset + a, v_offset + c, v_offset + b])
            else:
                idx_list.extend([v_offset + a, v_offset + b, v_offset + c])
        v_offset += n

    add_cap(rings[0][0], -1.0, reverse_winding=True)
    add_cap(rings[-1][0], 1.0, reverse_winding=False)

    # Side walls & bevel strips with smooth bevel normals along ring transitions
    # and flat edge normals per polygon side so hard corners stay crisp.
    for edge_i in range(n):
        j = (edge_i + 1) % n
        p0, p1 = pts[edge_i], pts[j]
        m0, m1 = miters[edge_i], miters[j]
        ex, ey = p1[0] - p0[0], p1[1] - p0[1]
        elen = math.hypot(ex, ey)
        out_nx, out_ny = ey / elen, -ex / elen

        # Build strip vertices per edge: 2 vertices per ring
        edge_ring_verts: list[tuple[np.ndarray, np.ndarray, float]] = []
        cum_s = 0.0
        prev_pt0 = None
        for r_idx, (z_val, off) in enumerate(rings):
            pt0 = np.array([p0[0] + m0[0] * off, p0[1] + m0[1] * off, z_val], dtype=np.float64)
            pt1 = np.array([p1[0] + m1[0] * off, p1[1] + m1[1] * off, z_val], dtype=np.float64)
            if prev_pt0 is not None:
                cum_s += float(np.linalg.norm(pt0 - prev_pt0))
            prev_pt0 = pt0
            edge_ring_verts.append((pt0, pt1, cum_s))

        # Compute edge-local tangent-based normals across rings
        for r_idx, (pt0, pt1, arc_s) in enumerate(edge_ring_verts):
            if not has_bevel:
                nx, ny, nz = out_nx, out_ny, 0.0
            else:
                # Slope along Z vs outward offset determines normal tilt
                z_val, _ = rings[r_idx]
                if r_idx == 0:
                    nx, ny, nz = 0.0, 0.0, -1.0
                elif r_idx == len(rings) - 1:
                    nx, ny, nz = 0.0, 0.0, 1.0
                elif z_val <= 0.0:
                    ang = (math.pi * 0.5) * (r_idx / bevel_segments)
                    radial = math.sin(ang)
                    nz = -math.cos(ang)
                    nx, ny = out_nx * radial, out_ny * radial
                elif z_val >= depth:
                    step = r_idx - (bevel_segments + 1)
                    ang = (math.pi * 0.5) * (step / bevel_segments)
                    radial = math.cos(ang)
                    nz = math.sin(ang)
                    nx, ny = out_nx * radial, out_ny * radial
                else:
                    nx, ny, nz = out_nx, out_ny, 0.0

            n_vec = np.array([nx, ny, nz], dtype=np.float64)
            n_len = np.linalg.norm(n_vec)
            if n_len > 1e-12:
                n_vec /= n_len

            pos_list.append(np.vstack([pt0, pt1]))
            norm_list.append(np.vstack([n_vec, n_vec]))
            uv_list.append(np.array([[0.0, arc_s * uv_scale], [elen * uv_scale, arc_s * uv_scale]], dtype=np.float64))

        for r_idx in range(len(rings) - 1):
            b0 = v_offset + r_idx * 2
            b1 = b0 + 1
            t0 = b0 + 2
            t1 = b0 + 3
            idx_list.extend([b0, b1, t1, b0, t1, t0])

        v_offset += len(rings) * 2

    all_pos = np.vstack(pos_list)
    if center:
        bbox_mid = 0.5 * (all_pos.min(axis=0) + all_pos.max(axis=0))
        all_pos = all_pos - bbox_mid

    return MeshData(
        positions=all_pos.astype(np.float32),
        normals=np.vstack(norm_list).astype(np.float32),
        uvs=np.vstack(uv_list).astype(np.float32),
        indices=np.asarray(idx_list, dtype=np.uint32),
    )


def create_cylinder(
    radius_top: float,
    radius_bottom: float,
    height: float,
    radial_segments: int = 16,
    open_ended: bool = False,
    uv_scale: float = 3.0,
) -> MeshData:
    """Create a cylinder/frustum centered at origin aligned along the Y axis."""
    if height <= 0.0:
        raise ValueError("cylinder height must be strictly positive")
    if radius_top < 0.0 or radius_bottom < 0.0 or (radius_top == 0.0 and radius_bottom == 0.0):
        raise ValueError("cylinder radii must be non-negative and not both zero")
    if radial_segments < 3:
        raise ValueError("radial_segments must be >= 3")

    half_h = height * 0.5
    slope = (radius_bottom - radius_top) / height
    pos_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    uv_list: list[np.ndarray] = []
    idx_list: list[int] = []

    # Side surface (smooth radial normals)
    side_pos: list[list[float]] = []
    side_norm: list[list[float]] = []
    side_uv: list[list[float]] = []
    circ = math.pi * (radius_top + radius_bottom)

    for iy, (y, r) in enumerate([(-half_h, radius_bottom), (half_h, radius_top)]):
        v_coord = (iy - 0.5) * height * uv_scale
        for ix in range(radial_segments + 1):
            frac = ix / radial_segments
            theta = frac * 2.0 * math.pi
            # Match Three.js cylinder orientation (x = r*sin(theta), z = r*cos(theta))
            sin_t, cos_t = math.sin(theta), math.cos(theta)
            side_pos.append([r * sin_t, y, r * cos_t])
            nx, ny, nz = sin_t, slope, cos_t
            nl = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            side_norm.append([nx / nl, ny / nl, nz / nl])
            side_uv.append([frac * circ * uv_scale, v_coord])

    pos_list.append(np.asarray(side_pos, dtype=np.float64))
    norm_list.append(np.asarray(side_norm, dtype=np.float64))
    uv_list.append(np.asarray(side_uv, dtype=np.float64))

    stride = radial_segments + 1
    for ix in range(radial_segments):
        b0 = ix
        b1 = ix + 1
        t0 = stride + ix
        t1 = stride + ix + 1
        idx_list.extend([b0, b1, t1, b0, t1, t0])

    v_offset = 2 * stride

    def add_cap(y_val: float, r_val: float, is_top: bool) -> None:
        nonlocal v_offset
        if r_val <= 0.0:
            return
        ny = 1.0 if is_top else -1.0
        cap_pos = [[0.0, y_val, 0.0]]
        cap_norm = [[0.0, ny, 0.0]]
        cap_uv = [[0.0, 0.0]]
        for ix in range(radial_segments):
            theta = (ix / radial_segments) * 2.0 * math.pi
            x, z = r_val * math.sin(theta), r_val * math.cos(theta)
            cap_pos.append([x, y_val, z])
            cap_norm.append([0.0, ny, 0.0])
            cap_uv.append([x * uv_scale, z * uv_scale])
        pos_list.append(np.asarray(cap_pos, dtype=np.float64))
        norm_list.append(np.asarray(cap_norm, dtype=np.float64))
        uv_list.append(np.asarray(cap_uv, dtype=np.float64))

        center_idx = v_offset
        for ix in range(radial_segments):
            cur = v_offset + 1 + ix
            nxt = v_offset + 1 + ((ix + 1) % radial_segments)
            if is_top:
                idx_list.extend([center_idx, cur, nxt])
            else:
                idx_list.extend([center_idx, nxt, cur])
        v_offset += radial_segments + 1

    if not open_ended:
        add_cap(half_h, radius_top, is_top=True)
        add_cap(-half_h, radius_bottom, is_top=False)

    return MeshData(
        positions=np.vstack(pos_list).astype(np.float32),
        normals=np.vstack(norm_list).astype(np.float32),
        uvs=np.vstack(uv_list).astype(np.float32),
        indices=np.asarray(idx_list, dtype=np.uint32),
    )


def sample_quadratic_bezier(
    p0: tuple[float, float],
    ctrl: tuple[float, float],
    p1: tuple[float, float],
    segments: int = 12,
    include_start: bool = False,
) -> list[tuple[float, float]]:
    """Sample a 2D quadratic Bezier curve matching THREE.Shape.quadraticCurveTo."""
    if segments < 1:
        raise ValueError("segments must be >= 1")
    pts: list[tuple[float, float]] = []
    start_idx = 0 if include_start else 1
    for i in range(start_idx, segments + 1):
        t = i / segments
        mt = 1.0 - t
        x = (mt * mt) * p0[0] + 2.0 * mt * t * ctrl[0] + (t * t) * p1[0]
        y = (mt * mt) * p0[1] + 2.0 * mt * t * ctrl[1] + (t * t) * p1[1]
        pts.append((x, y))
    return pts


def extrude_side_profile(
    points_2d: Sequence[tuple[float, float]],
    width: float,
    bevel: float = 0.0012,
    bevel_segments: int = 3,
    uv_scale: float = 6.0,
) -> MeshData:
    """Extrude a 2D YZ side profile symmetrically along X (shapeX -> +Z, shapeY -> +Y)."""
    if width <= 0.0:
        raise ValueError("width must be strictly positive")
    if bevel < 0.0:
        raise ValueError("bevel must be non-negative")
    raw = extrude_shape(
        points_2d,
        depth=width,
        bevel_size=bevel,
        bevel_thickness=bevel,
        bevel_segments=bevel_segments,
        uv_scale=uv_scale,
    )
    centered = transform_mesh(raw, translation=(0.0, 0.0, -width * 0.5))
    return transform_mesh(centered, rotation=(0.0, -math.pi * 0.5, 0.0))


def extrude_hollow_profile(
    outer_pts: Sequence[tuple[float, float]],
    inner_pts: Sequence[tuple[float, float]],
    depth: float,
    bevel_size: float = 0.0012,
    bevel_thickness: float = 0.0012,
    bevel_segments: int = 3,
    uv_scale: float = 6.0,
) -> MeshData:
    """Create a beveled hollow 2D ring extrusion centered at Z = 0 (manifold outer + inner walls)."""
    if len(outer_pts) != len(inner_pts) or len(outer_pts) < 3:
        raise ValueError("outer_pts and inner_pts must have matching length >= 3")
    if depth <= 0.0:
        raise ValueError("depth must be strictly positive")
    if bevel_size < 0.0 or bevel_thickness < 0.0 or bevel_segments < 1:
        raise ValueError("invalid bevel parameters")

    out_list = list(outer_pts)
    in_list = list(inner_pts)
    out_area = _signed_area_2d(out_list)
    in_area = _signed_area_2d(in_list)
    if abs(out_area) <= abs(in_area) or abs(in_area) < 1e-12:
        raise ValueError("outer loop must strictly enclose non-degenerate inner loop")
    if out_area < 0.0:
        out_list.reverse()
    if _signed_area_2d(in_list) < 0.0:
        in_list.reverse()

    n = len(out_list)
    out_miters = _outward_miter_vectors(out_list)
    in_miters = _outward_miter_vectors(in_list)
    has_bevel = bevel_size > 0.0 and bevel_thickness > 0.0

    hz = depth * 0.5
    rings: list[tuple[float, float]] = []
    if has_bevel:
        for s in range(bevel_segments + 1):
            ang = (math.pi * 0.5) * (s / bevel_segments)
            rings.append((-hz - bevel_thickness * math.cos(ang), bevel_size * math.sin(ang)))
        for s in range(bevel_segments + 1):
            ang = (math.pi * 0.5) * (s / bevel_segments)
            rings.append((hz + bevel_thickness * math.sin(ang), bevel_size * math.cos(ang)))
    else:
        rings = [(-hz, 0.0), (hz, 0.0)]

    pos_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    uv_list: list[np.ndarray] = []
    idx_list: list[int] = []
    v_off = 0

    # Front (+Z) and Back (-Z) annular caps connecting inner_pts[i] <-> outer_pts[i]
    z_back, z_front = rings[0][0], rings[-1][0]
    for i in range(n):
        j = (i + 1) % n
        o0, o1 = out_list[i], out_list[j]
        i0, i1 = in_list[i], in_list[j]

        # Front cap (+Z)
        f_pts = np.array(
            [[i0[0], i0[1], z_front], [o0[0], o0[1], z_front], [o1[0], o1[1], z_front], [i1[0], i1[1], z_front]],
            dtype=np.float64,
        )
        pos_list.append(f_pts)
        norm_list.append(np.tile([0.0, 0.0, 1.0], (4, 1)))
        uv_list.append(f_pts[:, :2] * uv_scale)
        idx_list.extend([v_off, v_off + 1, v_off + 2, v_off, v_off + 2, v_off + 3])
        v_off += 4

        # Back cap (-Z)
        b_pts = np.array(
            [[o0[0], o0[1], z_back], [i0[0], i0[1], z_back], [i1[0], i1[1], z_back], [o1[0], o1[1], z_back]],
            dtype=np.float64,
        )
        pos_list.append(b_pts)
        norm_list.append(np.tile([0.0, 0.0, -1.0], (4, 1)))
        uv_list.append(b_pts[:, :2] * uv_scale)
        idx_list.extend([v_off, v_off + 1, v_off + 2, v_off, v_off + 2, v_off + 3])
        v_off += 4

    def add_wall(loop_pts: list[tuple[float, float]], miters: list[tuple[float, float]], sign: float) -> None:
        nonlocal v_off
        for edge_i in range(n):
            j = (edge_i + 1) % n
            p0, p1 = loop_pts[edge_i], loop_pts[j]
            m0, m1 = miters[edge_i], miters[j]
            ex, ey = p1[0] - p0[0], p1[1] - p0[1]
            elen = math.hypot(ex, ey) or 1.0
            nx_base, ny_base = (ey / elen) * sign, (-ex / elen) * sign

            cum_s = 0.0
            prev_pt0 = None
            for r_idx, (z_val, off) in enumerate(rings):
                pt0 = np.array([p0[0] + m0[0] * off * sign, p0[1] + m0[1] * off * sign, z_val], dtype=np.float64)
                pt1 = np.array([p1[0] + m1[0] * off * sign, p1[1] + m1[1] * off * sign, z_val], dtype=np.float64)
                if prev_pt0 is not None:
                    cum_s += float(np.linalg.norm(pt0 - prev_pt0))
                prev_pt0 = pt0

                if not has_bevel:
                    nx, ny, nz = nx_base, ny_base, 0.0
                elif r_idx == 0:
                    nx, ny, nz = 0.0, 0.0, -1.0
                elif r_idx == len(rings) - 1:
                    nx, ny, nz = 0.0, 0.0, 1.0
                elif z_val <= -hz:
                    ang = (math.pi * 0.5) * (r_idx / bevel_segments)
                    nx, ny, nz = nx_base * math.sin(ang), ny_base * math.sin(ang), -math.cos(ang)
                elif z_val >= hz:
                    step = r_idx - (bevel_segments + 1)
                    ang = (math.pi * 0.5) * (step / bevel_segments)
                    nx, ny, nz = nx_base * math.cos(ang), ny_base * math.cos(ang), math.sin(ang)
                else:
                    nx, ny, nz = nx_base, ny_base, 0.0

                n_vec = np.array([nx, ny, nz], dtype=np.float64)
                n_len = float(np.linalg.norm(n_vec)) or 1.0
                n_vec /= n_len
                pos_list.append(np.vstack([pt0, pt1]))
                norm_list.append(np.vstack([n_vec, n_vec]))
                uv_list.append(np.array([[0.0, cum_s * uv_scale], [elen * uv_scale, cum_s * uv_scale]], dtype=np.float64))

            for r_idx in range(len(rings) - 1):
                b0 = v_off + r_idx * 2
                b1 = b0 + 1
                t0 = b0 + 2
                t1 = b0 + 3
                if sign > 0:
                    idx_list.extend([b0, b1, t1, b0, t1, t0])
                else:
                    idx_list.extend([b0, t1, b1, b0, t0, t1])
            v_off += len(rings) * 2

    add_wall(out_list, out_miters, sign=1.0)
    add_wall(in_list, in_miters, sign=-1.0)

    return MeshData(
        positions=np.vstack(pos_list).astype(np.float32),
        normals=np.vstack(norm_list).astype(np.float32),
        uvs=np.vstack(uv_list).astype(np.float32),
        indices=np.asarray(idx_list, dtype=np.uint32),
    )


def create_plane(width: float, height: float) -> MeshData:
    """Create a centered XY plane facing +Z with standard [0, 1] UVs."""
    if width <= 0.0 or height <= 0.0:
        raise ValueError("plane width and height must be strictly positive")
    hw, hh = width * 0.5, height * 0.5
    positions = np.array(
        [[-hw, -hh, 0.0], [hw, -hh, 0.0], [hw, hh, 0.0], [-hw, hh, 0.0]],
        dtype=np.float32,
    )
    normals = np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (4, 1))
    uvs = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], dtype=np.float32)
    indices = np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)
    return MeshData(positions=positions, normals=normals, uvs=uvs, indices=indices)


def create_ring(
    inner_radius: float,
    outer_radius: float,
    theta_segments: int = 24,
) -> MeshData:
    """Create a flat ring in the XY plane facing +Z."""
    if inner_radius < 0.0 or outer_radius <= inner_radius:
        raise ValueError("ring requires 0 <= inner_radius < outer_radius")
    if theta_segments < 3:
        raise ValueError("theta_segments must be >= 3")

    pos: list[list[float]] = []
    uvs: list[list[float]] = []
    idx: list[int] = []

    for r in (inner_radius, outer_radius):
        for i in range(theta_segments):
            ang = (i / theta_segments) * 2.0 * math.pi
            x, y = r * math.cos(ang), r * math.sin(ang)
            pos.append([x, y, 0.0])
            uvs.append([0.5 + 0.5 * (x / outer_radius), 0.5 + 0.5 * (y / outer_radius)])

    for i in range(theta_segments):
        i_nxt = (i + 1) % theta_segments
        in0, in1 = i, i_nxt
        out0, out1 = theta_segments + i, theta_segments + i_nxt
        idx.extend([in0, out0, out1, in0, out1, in1])

    positions = np.asarray(pos, dtype=np.float32)
    normals = np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (len(pos), 1))
    return MeshData(
        positions=positions,
        normals=normals,
        uvs=np.asarray(uvs, dtype=np.float32),
        indices=np.asarray(idx, dtype=np.uint32),
    )


def create_circle(radius: float, segments: int = 12) -> MeshData:
    """Create a filled disk in the XY plane facing +Z."""
    if radius <= 0.0:
        raise ValueError("circle radius must be strictly positive")
    if segments < 3:
        raise ValueError("segments must be >= 3")

    pos = [[0.0, 0.0, 0.0]]
    uvs = [[0.5, 0.5]]
    idx: list[int] = []

    for i in range(segments):
        ang = (i / segments) * 2.0 * math.pi
        c, s = math.cos(ang), math.sin(ang)
        pos.append([radius * c, radius * s, 0.0])
        uvs.append([0.5 + 0.5 * c, 0.5 + 0.5 * s])

    for i in range(segments):
        idx.extend([0, 1 + i, 1 + ((i + 1) % segments)])

    positions = np.asarray(pos, dtype=np.float32)
    normals = np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (len(pos), 1))
    return MeshData(
        positions=positions,
        normals=normals,
        uvs=np.asarray(uvs, dtype=np.float32),
        indices=np.asarray(idx, dtype=np.uint32),
    )


def create_lathe(
    profile_rz: Sequence[tuple[float, float]],
    segments: int = 24,
    uv_scale: float = 5.0,
) -> MeshData:
    """Revolve a 2D (radius, y) profile around the Y axis (matches THREE.LatheGeometry)."""
    if len(profile_rz) < 2:
        raise ValueError("lathe profile must contain at least 2 points")
    if segments < 3:
        raise ValueError("lathe segments must be >= 3")

    pts = np.asarray(profile_rz, dtype=np.float64)
    if np.any(pts[:, 0] < 0.0):
        raise ValueError("lathe radii must be non-negative")

    n_rings = len(pts)
    rn_r = np.zeros(n_rings, dtype=np.float64)
    rn_y = np.zeros(n_rings, dtype=np.float64)
    arc_v = np.zeros(n_rings, dtype=np.float64)

    for i in range(n_rings):
        if i > 0:
            arc_v[i] = arc_v[i - 1] + math.hypot(pts[i, 0] - pts[i - 1, 0], pts[i, 1] - pts[i - 1, 1])
        p0 = pts[max(0, i - 1)]
        p1 = pts[min(n_rings - 1, i + 1)]
        dr, dy = p1[0] - p0[0], p1[1] - p0[1]
        dl = math.hypot(dr, dy) or 1.0
        rn_r[i], rn_y[i] = dy / dl, -dr / dl

    pos: list[list[float]] = []
    norm: list[list[float]] = []
    uvs: list[list[float]] = []
    idx: list[int] = []

    avg_r = max(float(np.mean(pts[:, 0])), 1e-3)
    circ = 2.0 * math.pi * avg_r

    for ir in range(n_rings):
        r, y = float(pts[ir, 0]), float(pts[ir, 1])
        nr, ny = float(rn_r[ir]), float(rn_y[ir])
        v_coord = arc_v[ir] * uv_scale
        for iseg in range(segments + 1):
            frac = iseg / segments
            theta = frac * 2.0 * math.pi
            sin_t, cos_t = math.sin(theta), math.cos(theta)
            pos.append([r * sin_t, y, r * cos_t])
            nx, nz = nr * sin_t, nr * cos_t
            nl = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            norm.append([nx / nl, ny / nl, nz / nl])
            uvs.append([frac * circ * uv_scale, v_coord])

    stride = segments + 1
    for ir in range(n_rings - 1):
        for iseg in range(segments):
            a = ir * stride + iseg
            b = a + 1
            c = a + stride
            d = c + 1
            idx.extend([a, b, d, a, d, c])

    return MeshData(
        positions=np.asarray(pos, dtype=np.float32),
        normals=np.asarray(norm, dtype=np.float32),
        uvs=np.asarray(uvs, dtype=np.float32),
        indices=np.asarray(idx, dtype=np.uint32),
    )


def create_extruded_tube_frame(
    outer_pts: Sequence[tuple[float, float]],
    inner_pts: Sequence[tuple[float, float]],
    depth: float,
    bevel: float = 0.002,
    uv_scale: float = 5.0,
) -> MeshData:
    """Create a hollow extruded frame (e.g., tapered EOTech hood) along +Z."""
    if len(outer_pts) != len(inner_pts) or len(outer_pts) < 3:
        raise ValueError("outer_pts and inner_pts must have matching length >= 3")
    if depth <= 0.0:
        raise ValueError("depth must be strictly positive")

    n = len(outer_pts)
    out_arr = np.asarray(outer_pts, dtype=np.float64)
    in_arr = np.asarray(inner_pts, dtype=np.float64)
    if _signed_area_2d(list(map(tuple, out_arr))) < 0:
        out_arr = out_arr[::-1]
        in_arr = in_arr[::-1]

    hz = depth * 0.5
    pos_list: list[np.ndarray] = []
    norm_list: list[np.ndarray] = []
    uv_list: list[np.ndarray] = []
    idx_list: list[int] = []
    v_off = 0

    def add_quad(p0: np.ndarray, p1: np.ndarray, p2: np.ndarray, p3: np.ndarray, normal: np.ndarray) -> None:
        nonlocal v_off
        pts4 = np.vstack([p0, p1, p2, p3])
        pos_list.append(pts4)
        norm_list.append(np.tile(normal, (4, 1)))
        ax = int(np.argmax(np.abs(normal)))
        if ax == 2:
            uv4 = pts4[:, :2] * uv_scale
        elif ax == 0:
            uv4 = pts4[:, [2, 1]] * uv_scale
        else:
            uv4 = pts4[:, [0, 2]] * uv_scale
        uv_list.append(uv4)
        idx_list.extend([v_off, v_off + 1, v_off + 2, v_off, v_off + 2, v_off + 3])
        v_off += 4

    for i in range(n):
        j = (i + 1) % n
        o0, o1 = out_arr[i], out_arr[j]
        i0, i1 = in_arr[i], in_arr[j]

        add_quad(
            np.array([i0[0], i0[1], hz]),
            np.array([o0[0], o0[1], hz]),
            np.array([o1[0], o1[1], hz]),
            np.array([i1[0], i1[1], hz]),
            np.array([0.0, 0.0, 1.0]),
        )
        add_quad(
            np.array([o0[0], o0[1], -hz]),
            np.array([i0[0], i0[1], -hz]),
            np.array([i1[0], i1[1], -hz]),
            np.array([o1[0], o1[1], -hz]),
            np.array([0.0, 0.0, -1.0]),
        )

        ex, ey = o1[0] - o0[0], o1[1] - o0[1]
        el = math.hypot(ex, ey) or 1.0
        add_quad(
            np.array([o0[0], o0[1], -hz]),
            np.array([o1[0], o1[1], -hz]),
            np.array([o1[0], o1[1], hz]),
            np.array([o0[0], o0[1], hz]),
            np.array([ey / el, -ex / el, 0.0]),
        )

        ix, iy = i1[0] - i0[0], i1[1] - i0[1]
        il = math.hypot(ix, iy) or 1.0
        add_quad(
            np.array([i1[0], i1[1], -hz]),
            np.array([i0[0], i0[1], -hz]),
            np.array([i0[0], i0[1], hz]),
            np.array([i1[0], i1[1], hz]),
            np.array([-iy / il, ix / il, 0.0]),
        )

    return MeshData(
        positions=np.vstack(pos_list).astype(np.float32),
        normals=np.vstack(norm_list).astype(np.float32),
        uvs=np.vstack(uv_list).astype(np.float32),
        indices=np.asarray(idx_list, dtype=np.uint32),
    )


def create_capsule(
    radius_top: float,
    radius_bottom: float,
    length: float,
    cap_segments: int = 6,
    radial_segments: int = 14,
    uv_scale: float = 5.0,
) -> MeshData:
    """Create a tapered capsule centered at origin along Y (total height = length + r_top + r_bot)."""
    if length <= 0.0 or radius_top <= 0.0 or radius_bottom <= 0.0:
        raise ValueError("capsule length and radii must be strictly positive")
    if cap_segments < 2 or radial_segments < 3:
        raise ValueError("cap_segments must be >= 2 and radial_segments >= 3")

    half_l = length * 0.5
    profile: list[tuple[float, float]] = []

    # Bottom hemisphere from south pole (r=0) up to cylinder junction (y = -half_l)
    for i in range(cap_segments + 1):
        ang = -math.pi * 0.5 + (i / cap_segments) * (math.pi * 0.5)
        profile.append((radius_bottom * math.cos(ang), -half_l + radius_bottom * math.sin(ang)))

    # Top hemisphere from cylinder junction (y = +half_l) up to north pole (r=0)
    for i in range(cap_segments + 1):
        ang = (i / cap_segments) * (math.pi * 0.5)
        profile.append((radius_top * math.cos(ang), half_l + radius_top * math.sin(ang)))

    return create_lathe(profile, segments=radial_segments, uv_scale=uv_scale)


def create_torus(
    major_radius: float,
    tube_radius: float,
    radial_segments: int = 10,
    tubular_segments: int = 20,
    uv_scale: float = 5.0,
) -> MeshData:
    """Create a torus in the XY plane (axis along +Z), matching THREE.TorusGeometry."""
    if major_radius <= 0.0 or tube_radius <= 0.0:
        raise ValueError("torus radii must be strictly positive")
    if radial_segments < 3 or tubular_segments < 3:
        raise ValueError("torus segment counts must be >= 3")

    pos: list[list[float]] = []
    norm: list[list[float]] = []
    uvs: list[list[float]] = []
    idx: list[int] = []

    u_circ = 2.0 * math.pi * major_radius
    v_circ = 2.0 * math.pi * tube_radius

    for j in range(radial_segments + 1):
        v_frac = j / radial_segments
        phi = v_frac * 2.0 * math.pi
        cos_p, sin_p = math.cos(phi), math.sin(phi)
        for i in range(tubular_segments + 1):
            u_frac = i / tubular_segments
            theta = u_frac * 2.0 * math.pi
            cos_t, sin_t = math.cos(theta), math.sin(theta)

            cx, cy = major_radius * cos_t, major_radius * sin_t
            px = (major_radius + tube_radius * cos_p) * cos_t
            py = (major_radius + tube_radius * cos_p) * sin_t
            pz = tube_radius * sin_p
            pos.append([px, py, pz])

            nx, ny, nz = px - cx, py - cy, pz
            nl = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            norm.append([nx / nl, ny / nl, nz / nl])
            uvs.append([u_frac * u_circ * uv_scale, v_frac * v_circ * uv_scale])

    stride = tubular_segments + 1
    for j in range(radial_segments):
        for i in range(tubular_segments):
            a = j * stride + i
            b = a + 1
            c = (j + 1) * stride + i
            d = c + 1
            idx.extend([a, b, d, a, d, c])

    return MeshData(
        positions=np.asarray(pos, dtype=np.float32),
        normals=np.asarray(norm, dtype=np.float32),
        uvs=np.asarray(uvs, dtype=np.float32),
        indices=np.asarray(idx, dtype=np.uint32),
    )


def _catmull_rom_sample(points: np.ndarray, t: float) -> tuple[np.ndarray, np.ndarray]:
    """Evaluate uniform Catmull-Rom spline position and unit tangent for t in [0, 1]."""
    n_seg = len(points) - 1
    scaled = min(max(t, 0.0), 1.0) * n_seg
    seg = min(int(scaled), n_seg - 1)
    u = scaled - seg

    p0 = points[max(0, seg - 1)]
    p1 = points[seg]
    p2 = points[seg + 1]
    p3 = points[min(n_seg, seg + 2)]

    u2 = u * u
    u3 = u2 * u
    pos = 0.5 * (
        (2.0 * p1)
        + (-p0 + p2) * u
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u3
    )
    tan = 0.5 * (
        (-p0 + p2)
        + 2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u
        + 3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u2
    )
    t_len = float(np.linalg.norm(tan))
    return pos, (tan / t_len if t_len > 1e-12 else np.array([0.0, 1.0, 0.0]))


def create_tube_along_curve(
    control_points: Sequence[tuple[float, float, float]],
    radius: float = 0.042,
    tubular_segments: int = 32,
    radial_segments: int = 20,
    taper_fn=None,
    flatten_xy: tuple[float, float] = (1.0, 1.0),
    uv_scale: float = 4.0,
) -> MeshData:
    """Sweeps a tapered elliptical cross-section along a Catmull-Rom curve using Bishop frames."""
    if len(control_points) < 2:
        raise ValueError("tube requires at least 2 control points")
    if radius <= 0.0 or tubular_segments < 2 or radial_segments < 3:
        raise ValueError("invalid tube parameters")

    pts = np.asarray(control_points, dtype=np.float64)
    centers: list[np.ndarray] = []
    tangents: list[np.ndarray] = []
    for s in range(tubular_segments + 1):
        p, t_vec = _catmull_rom_sample(pts, s / tubular_segments)
        centers.append(p)
        tangents.append(t_vec)

    # Parallel-transport (rotation-minimizing) frames avoid gimbal twist along 3D splines.
    t0 = tangents[0]
    ref = np.array([0.0, 0.0, 1.0]) if abs(t0[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    n0 = np.cross(ref, t0)
    n0 /= np.linalg.norm(n0)
    b0 = np.cross(t0, n0)

    normals_frame = [n0]
    binormals_frame = [b0]
    for s in range(1, tubular_segments + 1):
        prev_t, curr_t = tangents[s - 1], tangents[s]
        axis = np.cross(prev_t, curr_t)
        ax_len = float(np.linalg.norm(axis))
        if ax_len > 1e-10:
            axis /= ax_len
            ang = math.acos(max(-1.0, min(1.0, float(np.dot(prev_t, curr_t)))))
            c, sn = math.cos(ang), math.sin(ang)
            n_prev = normals_frame[-1]
            # Rodrigues rotation
            n_curr = n_prev * c + np.cross(axis, n_prev) * sn + axis * float(np.dot(axis, n_prev)) * (1.0 - c)
            n_curr -= curr_t * float(np.dot(n_curr, curr_t))
            n_curr /= np.linalg.norm(n_curr)
        else:
            n_curr = normals_frame[-1]
        normals_frame.append(n_curr)
        binormals_frame.append(np.cross(curr_t, n_curr))

    pos: list[np.ndarray] = []
    uvs: list[list[float]] = []
    idx: list[int] = []

    fx, fy = flatten_xy
    arc_len = 0.0
    circ = 2.0 * math.pi * radius

    for s in range(tubular_segments + 1):
        t_frac = s / tubular_segments
        if s > 0:
            arc_len += float(np.linalg.norm(centers[s] - centers[s - 1]))
        tap = float(taper_fn(t_frac)) if taper_fn is not None else 1.0
        n_vec, b_vec = normals_frame[s], binormals_frame[s]
        c_pt = centers[s]
        for r_i in range(radial_segments + 1):
            frac = r_i / radial_segments
            theta = frac * 2.0 * math.pi
            cos_t, sin_t = math.cos(theta), math.sin(theta)
            rx = radius * tap * fx * cos_t
            ry = radius * tap * fy * sin_t
            pt = c_pt + n_vec * rx + b_vec * ry
            pos.append(pt)
            uvs.append([frac * circ * uv_scale, arc_len * uv_scale])

    stride = radial_segments + 1
    for s in range(tubular_segments):
        for r_i in range(radial_segments):
            a = s * stride + r_i
            b = a + stride
            c = b + 1
            d = a + 1
            idx.extend([a, b, c, a, c, d])

    pos_arr = np.asarray(pos, dtype=np.float64)
    idx_arr = np.asarray(idx, dtype=np.uint32)

    # Smooth area-weighted vertex normals (welding radial seam u=0 and u=1)
    v_norm = np.zeros_like(pos_arr)
    tris = idx_arr.reshape(-1, 3)
    p_a = pos_arr[tris[:, 0]]
    p_b = pos_arr[tris[:, 1]]
    p_c = pos_arr[tris[:, 2]]
    fn = np.cross(p_b - p_a, p_c - p_a)
    for k in range(3):
        np.add.at(v_norm, tris[:, k], fn)

    for s in range(tubular_segments + 1):
        i0 = s * stride
        i_end = i0 + radial_segments
        seam = v_norm[i0] + v_norm[i_end]
        v_norm[i0] = seam
        v_norm[i_end] = seam

    n_len = np.linalg.norm(v_norm, axis=1, keepdims=True)
    v_norm = v_norm / np.where(n_len > 1e-12, n_len, 1.0)

    return MeshData(
        positions=pos_arr.astype(np.float32),
        normals=v_norm.astype(np.float32),
        uvs=np.asarray(uvs, dtype=np.float32),
        indices=idx_arr,
    )

