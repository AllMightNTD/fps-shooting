"""CLI builder that generates .glb and CORS-free .bundle.js assets in model/dist/."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import struct
from typing import Sequence

from model.characters import build_fps_arms_nodes, build_soldier_nodes
from model.core import export_glb, export_js_bundle
from model.weapons import build_m416_nodes, build_pistol_nodes


@dataclass(frozen=True)
class BuildArtifact:
    """Summary of a generated 3D weapon asset."""

    name: str
    glb_path: Path
    bundle_path: Path
    glb_bytes_len: int
    bundle_bytes_len: int
    node_count: int
    mesh_count: int
    total_vertices: int
    total_triangles: int


def inspect_glb_stats(glb_bytes: bytes) -> dict[str, int]:
    """Parse GLB header and JSON chunk to verify format compliance and gather stats."""
    if len(glb_bytes) < 20:
        raise ValueError("GLB payload too small")
    magic, version, total_len = struct.unpack_from("<III", glb_bytes, 0)
    if magic != 0x46546C67:
        raise ValueError(f"Invalid GLB magic: 0x{magic:08x}")
    if version != 2:
        raise ValueError(f"Unsupported glTF version: {version}")
    if total_len != len(glb_bytes):
        raise ValueError(f"GLB length mismatch: header={total_len}, actual={len(glb_bytes)}")

    json_len, json_type = struct.unpack_from("<II", glb_bytes, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("First GLB chunk must be JSON")
    gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8"))

    accessors = gltf.get("accessors", [])
    total_verts = 0
    total_tris = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            pos_idx = prim["attributes"]["POSITION"]
            total_verts += accessors[pos_idx]["count"]
            if "indices" in prim:
                total_tris += accessors[prim["indices"]]["count"] // 3

    return {
        "nodes": len(gltf.get("nodes", [])),
        "meshes": len(gltf.get("meshes", [])),
        "materials": len(gltf.get("materials", [])),
        "textures": len(gltf.get("textures", [])),
        "vertices": total_verts,
        "triangles": total_tris,
    }


def build_all(output_dir: Path, texture_size: int = 512, seed: int = 42) -> list[BuildArtifact]:
    """Build all registered 3D weapon and character models into ``output_dir``."""
    output_dir.mkdir(parents=True, exist_ok=True)
    glove_size = max(64, texture_size // 2)
    models_spec = [
        ("m416", "M416_PBR_Scene", build_m416_nodes(texture_size=texture_size, seed=seed)),
        ("pistol", "Pistol_PBR_Scene", build_pistol_nodes(texture_size=texture_size, seed=seed)),
        ("fps_arms", "FPS_Arms_PBR_Scene", build_fps_arms_nodes(skin_size=texture_size, glove_size=glove_size, seed=seed)),
        ("soldier", "Soldier_PBR_Scene", build_soldier_nodes(tex_size=glove_size, seed=seed)),
    ]
    artifacts: list[BuildArtifact] = []

    for name, scene_name, nodes in models_spec:
        glb_bytes = export_glb(nodes, scene_name=scene_name)
        stats = inspect_glb_stats(glb_bytes)

        glb_path = output_dir / f"{name}.glb"
        bundle_path = output_dir / f"{name}.bundle.js"
        glb_path.write_bytes(glb_bytes)
        export_js_bundle(glb_bytes, bundle_path, model_key=name)

        artifacts.append(
            BuildArtifact(
                name=name,
                glb_path=glb_path,
                bundle_path=bundle_path,
                glb_bytes_len=len(glb_bytes),
                bundle_bytes_len=bundle_path.stat().st_size,
                node_count=stats["nodes"],
                mesh_count=stats["meshes"],
                total_vertices=stats["vertices"],
                total_triangles=stats["triangles"],
            )
        )
    return artifacts


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build procedural PBR 3D models for FPS.html")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent / "dist",
        help="Output directory for .glb and .bundle.js files",
    )
    parser.add_argument("--tex-size", type=int, default=512, help="PBR texture size (power of 2)")
    parser.add_argument("--seed", type=int, default=42, help="Deterministic RNG seed")
    args = parser.parse_args(argv)

    results = build_all(output_dir=args.out, texture_size=args.tex_size, seed=args.seed)
    for item in results:
        print(
            f"[model.build] {item.name}: "
            f"{item.glb_path} ({item.glb_bytes_len:,} B), "
            f"{item.bundle_path} ({item.bundle_bytes_len:,} B) | "
            f"nodes={item.node_count}, meshes={item.mesh_count}, "
            f"verts={item.total_vertices:,}, tris={item.total_triangles:,}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

