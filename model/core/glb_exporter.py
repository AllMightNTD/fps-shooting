"""Pure-Python glTF 2.0 Binary (.glb) & Base64 JS bundle exporter."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import json
import math
from pathlib import Path
import struct
from typing import Any, Sequence

import numpy as np

from .geometry import MeshData

_GLB_MAGIC = 0x46546C67  # 'glTF'
_CHUNK_JSON = 0x4E4F534A  # 'JSON'
_CHUNK_BIN = 0x004E4942  # 'BIN\0'

_COMP_UNSIGNED_SHORT = 5123
_COMP_UNSIGNED_INT = 5125
_COMP_FLOAT = 5126
_TARGET_ARRAY_BUFFER = 34962
_TARGET_ELEMENT_ARRAY_BUFFER = 34963


def _hex_to_rgba(color: int, alpha: float = 1.0) -> list[float]:
    r = ((color >> 16) & 0xFF) / 255.0
    g = ((color >> 8) & 0xFF) / 255.0
    b = (color & 0xFF) / 255.0
    # Convert sRGB hex color to linear space per glTF 2.0 PBR spec.
    def to_lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return [round(to_lin(r), 6), round(to_lin(g), 6), round(to_lin(b), 6), round(alpha, 6)]


def _hex_to_rgb(color: int) -> list[float]:
    return _hex_to_rgba(color, 1.0)[:3]


def euler_xyz_to_quat(rx: float, ry: float, rz: float) -> list[float]:
    """Convert XYZ intrinsic Euler radians to glTF quaternion [x, y, z, w]."""
    c1, s1 = math.cos(rx * 0.5), math.sin(rx * 0.5)
    c2, s2 = math.cos(ry * 0.5), math.sin(ry * 0.5)
    c3, s3 = math.cos(rz * 0.5), math.sin(rz * 0.5)

    x = s1 * c2 * c3 + c1 * s2 * s3
    y = c1 * s2 * c3 - s1 * c2 * s3
    z = c1 * c2 * s3 + s1 * s2 * c3
    w = c1 * c2 * c3 - s1 * s2 * s3
    return [round(x, 7), round(y, 7), round(z, 7), round(w, 7)]


def socket_euler_xyz(
    distal: Sequence[float],
    palm_normal: Sequence[float],
    is_right_hand: bool = False,
) -> tuple[float, float, float]:
    """Compute socket XYZ Euler rotation where -Z=distal, +Y=radial, and +/-X=palm_normal."""
    z_axis = -np.asarray(distal, dtype=np.float64)
    z_axis /= np.linalg.norm(z_axis)
    sign = -1.0 if is_right_hand else 1.0
    x_axis = np.asarray(palm_normal, dtype=np.float64) * sign
    x_axis = x_axis - z_axis * float(np.dot(x_axis, z_axis))
    x_axis /= np.linalg.norm(x_axis)
    y_axis = np.cross(z_axis, x_axis)
    y_axis /= np.linalg.norm(y_axis)
    mat = np.column_stack((x_axis, y_axis, z_axis))

    sy = max(-1.0, min(1.0, float(mat[0, 2])))
    ry = math.asin(sy)
    if abs(mat[0, 2]) < 0.99999:
        rx = math.atan2(-mat[1, 2], mat[2, 2])
        rz = math.atan2(-mat[0, 1], mat[0, 0])
    else:
        rx = math.atan2(mat[2, 1], mat[1, 1])
        rz = 0.0
    return (round(rx, 6), round(ry, 6), round(rz, 6))


def parse_glb(raw_bytes: bytes) -> tuple[dict[str, Any], bytes]:
    """Parse and validate a glTF 2.0 binary (.glb) container into (gltf_json, bin_chunk)."""
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


def pack_glb(gltf: dict[str, Any], bin_bytes: bytes) -> bytes:
    """Serialize a glTF JSON dict and raw BIN chunk into a 4-byte-aligned .glb binary."""
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


@dataclass(frozen=True)
class GLBMaterial:
    """PBR Metallic-Roughness material with optional Three.js physical extras."""

    name: str
    color: int
    metalness: float = 0.0
    roughness: float = 0.5
    opacity: float = 1.0
    transparent: bool = False
    double_sided: bool = False
    emissive: int | None = None
    emissive_intensity: float = 1.0
    base_color_png: bytes | None = None
    metallic_roughness_png: bytes | None = None
    normal_png: bytes | None = None
    normal_scale: float = 1.0
    clearcoat: float = 0.0
    clearcoat_roughness: float = 0.0
    transmission: float = 0.0
    ior: float = 1.5
    sheen_color: int | None = None
    sheen_roughness: float = 0.5
    unlit: bool = False


@dataclass
class GLBNode:
    """Scene graph node in glTF hierarchy."""

    name: str
    mesh: MeshData | None = None
    material: GLBMaterial | None = None
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    children: list[GLBNode] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)


class _BinBuilder:
    """Accumulates 4-byte aligned binary slices for the glTF BIN chunk."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.buffer_views: list[dict[str, Any]] = []

    def add_view(self, data: bytes, target: int | None = None) -> int:
        pad = (-len(self.buf)) % 4
        if pad:
            self.buf.extend(b"\x00" * pad)
        offset = len(self.buf)
        self.buf.extend(data)
        view: dict[str, Any] = {
            "buffer": 0,
            "byteOffset": offset,
            "byteLength": len(data),
        }
        if target is not None:
            view["target"] = target
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def finalize_bytes(self) -> bytes:
        pad = (-len(self.buf)) % 4
        if pad:
            self.buf.extend(b"\x00" * pad)
        return bytes(self.buf)


def export_glb(root_nodes: list[GLBNode], scene_name: str = "Scene") -> bytes:
    """Serialize a list of root GLBNodes into a valid glTF 2.0 binary (.glb) payload."""
    if not root_nodes:
        raise ValueError("root_nodes must not be empty")

    bin_builder = _BinBuilder()
    accessors: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    textures: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []
    meshes_json: list[dict[str, Any]] = []
    nodes_json: list[dict[str, Any]] = []

    image_cache: dict[bytes, int] = {}
    material_cache: dict[int, int] = {}

    def get_texture_index(png_bytes: bytes, tex_name: str) -> int:
        if png_bytes in image_cache:
            return image_cache[png_bytes]
        bv_idx = bin_builder.add_view(png_bytes, target=None)
        img_idx = len(images)
        images.append({"bufferView": bv_idx, "mimeType": "image/png", "name": tex_name})
        tex_idx = len(textures)
        textures.append({"sampler": 0, "source": img_idx, "name": tex_name})
        image_cache[png_bytes] = tex_idx
        return tex_idx

    def get_material_index(mat: GLBMaterial) -> int:
        key = id(mat)
        if key in material_cache:
            return material_cache[key]

        pbr: dict[str, Any] = {
            "baseColorFactor": _hex_to_rgba(mat.color, mat.opacity if mat.transparent else 1.0),
            "metallicFactor": round(mat.metalness, 5),
            "roughnessFactor": round(1.0 if mat.metallic_roughness_png is not None else mat.roughness, 5),
        }
        if mat.base_color_png is not None:
            bc_tex = get_texture_index(mat.base_color_png, f"{mat.name}_basecolor")
            pbr["baseColorTexture"] = {"index": bc_tex}
        if mat.metallic_roughness_png is not None:
            mr_tex = get_texture_index(mat.metallic_roughness_png, f"{mat.name}_mr")
            pbr["metallicRoughnessTexture"] = {"index": mr_tex}

        mat_dict: dict[str, Any] = {
            "name": mat.name,
            "pbrMetallicRoughness": pbr,
        }
        if mat.normal_png is not None:
            norm_tex = get_texture_index(mat.normal_png, f"{mat.name}_normal")
            mat_dict["normalTexture"] = {"index": norm_tex, "scale": round(mat.normal_scale, 4)}
        if mat.transparent:
            mat_dict["alphaMode"] = "BLEND"
        if mat.double_sided:
            mat_dict["doubleSided"] = True
        if mat.emissive is not None:
            mat_dict["emissiveFactor"] = _hex_to_rgb(mat.emissive)

        phys_extras: dict[str, Any] = {}
        if mat.clearcoat > 0.0:
            phys_extras["clearcoat"] = mat.clearcoat
            phys_extras["clearcoatRoughness"] = mat.clearcoat_roughness
        if mat.transmission > 0.0:
            phys_extras["transmission"] = mat.transmission
            phys_extras["ior"] = mat.ior
        if mat.sheen_color is not None:
            phys_extras["sheenColor"] = mat.sheen_color
            phys_extras["sheenRoughness"] = mat.sheen_roughness
        if mat.unlit:
            phys_extras["unlit"] = True
        if mat.emissive is not None and mat.emissive_intensity != 1.0:
            phys_extras["emissiveIntensity"] = mat.emissive_intensity
        if phys_extras:
            mat_dict["extras"] = {"pbrPhysical": phys_extras}

        idx = len(materials)
        materials.append(mat_dict)
        material_cache[key] = idx
        return idx

    def add_mesh(mesh: MeshData, mat: GLBMaterial, mesh_name: str) -> int:
        pos = np.ascontiguousarray(mesh.positions, dtype="<f4")
        norm = np.ascontiguousarray(mesh.normals, dtype="<f4")
        uv = np.ascontiguousarray(mesh.uvs, dtype="<f4")

        bv_pos = bin_builder.add_view(pos.tobytes(), target=_TARGET_ARRAY_BUFFER)
        bv_norm = bin_builder.add_view(norm.tobytes(), target=_TARGET_ARRAY_BUFFER)
        bv_uv = bin_builder.add_view(uv.tobytes(), target=_TARGET_ARRAY_BUFFER)

        acc_pos = len(accessors)
        accessors.append(
            {
                "bufferView": bv_pos,
                "componentType": _COMP_FLOAT,
                "count": int(pos.shape[0]),
                "type": "VEC3",
                "min": [float(v) for v in pos.min(axis=0)],
                "max": [float(v) for v in pos.max(axis=0)],
            }
        )
        acc_norm = len(accessors)
        accessors.append(
            {
                "bufferView": bv_norm,
                "componentType": _COMP_FLOAT,
                "count": int(norm.shape[0]),
                "type": "VEC3",
            }
        )
        acc_uv = len(accessors)
        accessors.append(
            {
                "bufferView": bv_uv,
                "componentType": _COMP_FLOAT,
                "count": int(uv.shape[0]),
                "type": "VEC2",
            }
        )

        max_idx = int(mesh.indices.max()) if len(mesh.indices) else 0
        if max_idx < 65535:
            idx_arr = np.ascontiguousarray(mesh.indices, dtype="<u2")
            idx_comp = _COMP_UNSIGNED_SHORT
        else:
            idx_arr = np.ascontiguousarray(mesh.indices, dtype="<u4")
            idx_comp = _COMP_UNSIGNED_INT

        bv_idx = bin_builder.add_view(idx_arr.tobytes(), target=_TARGET_ELEMENT_ARRAY_BUFFER)
        acc_idx = len(accessors)
        accessors.append(
            {
                "bufferView": bv_idx,
                "componentType": idx_comp,
                "count": int(idx_arr.shape[0]),
                "type": "SCALAR",
                "min": [int(idx_arr.min())],
                "max": [int(idx_arr.max())],
            }
        )

        mat_idx = get_material_index(mat)
        mesh_idx = len(meshes_json)
        meshes_json.append(
            {
                "name": mesh_name,
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": acc_pos,
                            "NORMAL": acc_norm,
                            "TEXCOORD_0": acc_uv,
                        },
                        "indices": acc_idx,
                        "material": mat_idx,
                    }
                ],
            }
        )
        return mesh_idx

    def add_node(node: GLBNode) -> int:
        node_idx = len(nodes_json)
        node_dict: dict[str, Any] = {"name": node.name}
        nodes_json.append(node_dict)

        if node.translation != (0.0, 0.0, 0.0):
            node_dict["translation"] = [round(v, 7) for v in node.translation]
        if node.rotation_xyz != (0.0, 0.0, 0.0):
            node_dict["rotation"] = euler_xyz_to_quat(*node.rotation_xyz)
        if node.scale != (1.0, 1.0, 1.0):
            node_dict["scale"] = [round(v, 7) for v in node.scale]
        if node.mesh is not None:
            if node.material is None:
                raise ValueError(f"GLBNode '{node.name}' with mesh must specify material")
            node_dict["mesh"] = add_mesh(node.mesh, node.material, node.name)
        if node.extras:
            node_dict["extras"] = node.extras
        if node.children:
            node_dict["children"] = [add_node(child) for child in node.children]
        return node_idx

    root_indices = [add_node(rn) for rn in root_nodes]
    bin_bytes = bin_builder.finalize_bytes()

    gltf_doc: dict[str, Any] = {
        "asset": {
            "version": "2.0",
            "generator": "FPS Python Procedural PBR Exporter",
        },
        "scene": 0,
        "scenes": [{"name": scene_name, "nodes": root_indices}],
        "nodes": nodes_json,
        "meshes": meshes_json,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": bin_builder.buffer_views,
        "buffers": [{"byteLength": len(bin_bytes)}],
    }
    if textures:
        gltf_doc["samplers"] = [
            {
                "magFilter": 9729,
                "minFilter": 9987,
                "wrapS": 10497,
                "wrapT": 10497,
            }
        ]
        gltf_doc["images"] = images
        gltf_doc["textures"] = textures

    json_raw = json.dumps(gltf_doc, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_pad = (-len(json_raw)) % 4
    json_bytes = json_raw + (b" " * json_pad)

    total_length = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    header = struct.pack("<III", _GLB_MAGIC, 2, total_length)
    json_hdr = struct.pack("<II", len(json_bytes), _CHUNK_JSON)
    bin_hdr = struct.pack("<II", len(bin_bytes), _CHUNK_BIN)

    return header + json_hdr + json_bytes + bin_hdr + bin_bytes


def export_js_bundle(glb_bytes: bytes, output_path: Path, model_key: str) -> None:
    """Write a CORS-free Base64 JS bundle attaching glb bytes under global ``FPS_MODELS``."""
    if not model_key or not model_key.replace("_", "").isalnum():
        raise ValueError("model_key must be alphanumeric/underscore")
    b64 = base64.b64encode(glb_bytes).decode("ascii")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    content = (
        "// Auto-generated by model/build.py — binary glTF 2.0 Base64 bundle for file:// compatibility\n"
        "(function (global) {\n"
        "  global.FPS_MODELS = global.FPS_MODELS || {};\n"
        f'  global.FPS_MODELS["{model_key}"] = "{b64}";\n'
        '})(typeof window !== "undefined" ? window : globalThis);\n'
    )
    output_path.write_text(content, encoding="utf-8")

