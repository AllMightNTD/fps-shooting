"""Unit tests for procedural pistol textures and normalized metric pistol.glb export."""

from __future__ import annotations

import io
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

from model.core import create_pistol_textures, parse_glb
from model.weapons import PISTOL_METADATA, build_pistol_glb
import model.weapons.pistol as pistol_mod


def _eval_node_world_mats(gltf: dict) -> dict[int, np.ndarray]:
    nodes = gltf["nodes"]
    world: dict[int, np.ndarray] = {}

    def node_local(node: dict) -> np.ndarray:
        mat = np.eye(4, dtype=np.float64)
        if "scale" in node:
            sx, sy, sz = node["scale"]
            mat = np.diag([sx, sy, sz, 1.0]) @ mat
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
            tr[:3, 3] = [tx, ty, tz]
            mat = tr @ mat
        return mat

    def walk(node_idx: int, parent: np.ndarray) -> None:
        mat = parent @ node_local(nodes[node_idx])
        world[node_idx] = mat
        for child_idx in nodes[node_idx].get("children", []):
            walk(int(child_idx), mat)

    for root_idx in gltf["scenes"][gltf["scene"]]["nodes"]:
        walk(int(root_idx), np.eye(4, dtype=np.float64))
    return world


def _world_bounds_for_node(gltf: dict, bin_bytes: bytes, world_mats: dict[int, np.ndarray], node_name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    idx_by_name = {n.get("name"): i for i, n in enumerate(gltf["nodes"])}
    node_idx = idx_by_name[node_name]
    node = gltf["nodes"][node_idx]
    prim = gltf["meshes"][node["mesh"]]["primitives"][0]
    acc = gltf["accessors"][prim["attributes"]["POSITION"]]
    bv = gltf["bufferViews"][acc["bufferView"]]
    off = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    verts = np.frombuffer(bin_bytes, dtype="<f4", count=acc["count"] * 3, offset=off).reshape(-1, 3)
    mat = world_mats[node_idx]
    wverts = (mat[:3, :3] @ verts.T).T + mat[:3, 3]
    return wverts, wverts.min(axis=0), wverts.max(axis=0)


class TestPistolTextures(unittest.TestCase):
    def test_pistol_textures_generation_is_deterministic_and_valid(self) -> None:
        # Arrange / Act
        tex_a = create_pistol_textures(size=128, seed=42)
        tex_b = create_pistol_textures(size=128, seed=42)

        # Assert
        self.assertEqual(tex_a.slide_albedo_png, tex_b.slide_albedo_png)
        self.assertEqual(tex_a.polymer_mr_png, tex_b.polymer_mr_png)
        for png_bytes in (
            tex_a.slide_albedo_png,
            tex_a.slide_mr_png,
            tex_a.slide_normal_png,
            tex_a.polymer_albedo_png,
            tex_a.polymer_mr_png,
            tex_a.polymer_normal_png,
            tex_a.stipple_albedo_png,
            tex_a.stipple_mr_png,
            tex_a.stipple_normal_png,
        ):
            with Image.open(io.BytesIO(png_bytes)) as img:
                self.assertEqual(img.size, (128, 128))
                self.assertEqual(img.mode, "RGB")

    def test_pistol_textures_reject_invalid_size(self) -> None:
        for bad in (0, -64, 100):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    create_pistol_textures(size=bad)


class TestPistolGLBConverter(unittest.TestCase):
    def test_build_pistol_glb_contains_expected_hierarchy_bounds_and_sockets(self) -> None:
        # Arrange / Act
        glb_bytes = build_pistol_glb(texture_size=512)
        gltf, bin_bytes = parse_glb(glb_bytes)
        world_mats = _eval_node_world_mats(gltf)

        # Assert metadata & required hierarchy nodes
        nodes_by_name = {n["name"]: (i, n) for i, n in enumerate(gltf["nodes"]) if "name" in n}
        for required_node in (
            "pistol_root",
            "pistol_frame",
            "pistol_slide",
            "pistol_trigger",
            "pistol_trigger_shoe",
            "pistol_mag",
            "pistol_mag_body",
            "pistol_bullet",
            "pistol_bullet_1",
            "pistol_muzzle",
            "socket_handguard",
            "socket_grip",
            "socket_mag",
            "socket_slide",
        ):
            self.assertIn(required_node, nodes_by_name)

        root_extras = nodes_by_name["pistol_root"][1]["extras"]
        self.assertEqual(root_extras["weapon"], PISTOL_METADATA["weapon"])
        self.assertEqual(root_extras["license"], "CC-BY-4.0")
        self.assertEqual(root_extras["sockets"], PISTOL_METADATA["sockets"])

        # Assert animated parent-child relationships (mag carries bullets, slide carries socket_slide)
        mag_children = {gltf["nodes"][c]["name"] for c in nodes_by_name["pistol_mag"][1]["children"]}
        self.assertTrue({"pistol_mag_body", "pistol_bullet", "pistol_bullet_1", "socket_mag"}.issubset(mag_children))
        slide_children = {gltf["nodes"][c]["name"] for c in nodes_by_name["pistol_slide"][1]["children"]}
        self.assertIn("socket_slide", slide_children)

        # Assert metric (-Z) firearm bounds and narrowed trigger guard clearance
        frame_verts, frame_min, frame_max = _world_bounds_for_node(gltf, bin_bytes, world_mats, "pistol_frame")
        _, slide_min, slide_max = _world_bounds_for_node(gltf, bin_bytes, world_mats, "pistol_slide")
        _, trig_min, trig_max = _world_bounds_for_node(gltf, bin_bytes, world_mats, "pistol_trigger_shoe")
        _, mag_min, mag_max = _world_bounds_for_node(gltf, bin_bytes, world_mats, "pistol_mag_body")

        self.assertLess(frame_min[2], -0.145)
        self.assertGreater(frame_max[2], 0.05)
        self.assertLess(slide_min[2], -0.145)
        self.assertGreater(slide_max[1], 0.065)
        self.assertLess(mag_min[1], -0.09)
        self.assertGreaterEqual(trig_min[0], -0.005)
        self.assertLessEqual(trig_max[0], 0.005)

        guard_loop = frame_verts[(frame_verts[:, 2] < -0.025) & (frame_verts[:, 2] > -0.067) & (frame_verts[:, 1] < 0.006)]
        self.assertGreater(len(guard_loop), 10)
        self.assertLess(float(np.abs(guard_loop[:, 0]).max()), 0.0072)

        # Assert single calibrated PBR material
        self.assertEqual(len(gltf["materials"]), 1)
        mat = gltf["materials"][0]
        self.assertEqual(mat["name"], "Pistol_PBR")
        self.assertIn("baseColorTexture", mat["pbrMetallicRoughness"])
        self.assertIn("metallicRoughnessTexture", mat["pbrMetallicRoughness"])
        self.assertIn("normalTexture", mat)
        self.assertIn("occlusionTexture", mat)
        self.assertAlmostEqual(mat["extras"]["pbrPhysical"]["clearcoat"], 0.14)

    def test_build_pistol_glb_resizes_textures_and_preserves_alignment(self) -> None:
        # Arrange / Act
        glb_512 = build_pistol_glb(texture_size=512)
        glb_128 = build_pistol_glb(texture_size=128)
        gltf_128, bin_128 = parse_glb(glb_128)

        # Assert size reduction & 4-byte aligned non-overlapping bufferViews
        self.assertLess(len(glb_128), len(glb_512))
        self.assertLess(len(glb_512), 1_500_000)

        for bv in gltf_128["bufferViews"]:
            self.assertEqual(bv.get("byteOffset", 0) % 4, 0)

        for im in gltf_128["images"]:
            bv = gltf_128["bufferViews"][im["bufferView"]]
            raw = bin_128[bv["byteOffset"] : bv["byteOffset"] + bv["byteLength"]]
            with Image.open(io.BytesIO(raw)) as pil:
                self.assertEqual(pil.size, (128, 128))

    def test_build_pistol_glb_falls_back_to_tracked_asset_when_root_glb_missing(self) -> None:
        # Arrange
        missing_root = Path("/tmp/nonexistent-root-pistol-check.glb")

        # Act
        with mock.patch.object(pistol_mod, "_ROOT_SOURCE_GLB", missing_root):
            glb_bytes = build_pistol_glb(texture_size=128)

        # Assert
        gltf, _ = parse_glb(glb_bytes)
        self.assertEqual(gltf["meshes"][0]["name"], "pistol_frame")

    def test_build_pistol_glb_rejects_invalid_inputs(self) -> None:
        for bad_size in (0, 32, 300, True):
            with self.subTest(bad_size=bad_size):
                with self.assertRaises(ValueError):
                    build_pistol_glb(texture_size=bad_size)  # type: ignore[arg-type]

        with self.assertRaises(FileNotFoundError):
            build_pistol_glb(texture_size=128, source_path=Path("/tmp/does-not-exist-pistol.glb"))


if __name__ == "__main__":
    unittest.main()
