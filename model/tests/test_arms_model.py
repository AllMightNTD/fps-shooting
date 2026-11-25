"""AAA unit tests (Happy & Unhappy paths) for FPS arms geometry, skin/glove PBR, and GLB export."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import re
import struct
import tempfile
import unittest

import numpy as np
from PIL import Image

from model.build import build_all, inspect_glb_stats
from model.core import (
    create_capsule,
    create_glove_textures,
    create_realistic_skin_textures,
    create_torus,
    create_tube_along_curve,
)


class TestArmsPrimitivesAndTextures(unittest.TestCase):
    def test_create_capsule_bounds_and_unit_normals(self) -> None:
        # Arrange
        r_top, r_bot, length = 0.010, 0.008, 0.032

        # Act
        mesh = create_capsule(r_top, r_bot, length)

        # Assert
        bmin = mesh.positions.min(axis=0)
        bmax = mesh.positions.max(axis=0)
        self.assertAlmostEqual(float(bmax[1] - bmin[1]), length + r_top + r_bot, places=4)
        np.testing.assert_allclose(np.linalg.norm(mesh.normals, axis=1), np.ones(len(mesh.normals)), atol=1e-5)
        self.assertLess(int(mesh.indices.max()), len(mesh.positions))

    def test_create_torus_and_tube_along_curve_valid(self) -> None:
        # Arrange
        ctrl = [(0.0, 0.0, 0.0), (-0.02, 0.35, 0.02), (0.0, 1.0, 0.0)]

        # Act
        torus = create_torus(0.032, 0.0045)
        tube = create_tube_along_curve(ctrl, radius=0.042, taper_fn=lambda t: 1.2 - 0.4 * t, flatten_xy=(0.92, 1.08))

        # Assert
        np.testing.assert_allclose(np.linalg.norm(torus.normals, axis=1), np.ones(len(torus.normals)), atol=1e-5)
        np.testing.assert_allclose(np.linalg.norm(tube.normals, axis=1), np.ones(len(tube.normals)), atol=1e-5)
        self.assertAlmostEqual(float(tube.positions[:, 1].min()), 0.0, places=2)
        self.assertAlmostEqual(float(tube.positions[:, 1].max()), 1.0, places=2)

    def test_skin_and_glove_textures_valid_maps(self) -> None:
        # Arrange
        skin_sz, glove_sz = 128, 64

        # Act
        skin = create_realistic_skin_textures(size=skin_sz, pore_count=200, droplet_count=30)
        glove = create_glove_textures(size=glove_sz)

        # Assert
        self.assertEqual(Image.open(io.BytesIO(skin.albedo_png)).size, (skin_sz, skin_sz))
        self.assertEqual(Image.open(io.BytesIO(skin.normal_png)).mode, "RGB")
        self.assertLess(int(np.asarray(Image.open(io.BytesIO(skin.mr_png)))[..., 1].min()), 40)
        self.assertEqual(Image.open(io.BytesIO(glove.glove_normal_png)).size, (glove_sz, glove_sz))
        self.assertEqual(Image.open(io.BytesIO(glove.watch_dial_png)).size, (128, 128))

    def test_invalid_arms_primitives_and_textures_raise_value_error(self) -> None:
        # Arrange / Act / Assert
        with self.assertRaises(ValueError):
            create_capsule(0.0, 0.01, 0.02)
        with self.assertRaises(ValueError):
            create_torus(0.03, -0.01)
        with self.assertRaises(ValueError):
            create_tube_along_curve([(0.0, 0.0, 0.0)])
        with self.assertRaises(ValueError):
            create_realistic_skin_textures(size=100)
        with self.assertRaises(ValueError):
            create_glove_textures(size=48)


class TestFPSArmsBuildPipeline(unittest.TestCase):
    def test_build_all_generates_rigged_fps_arms_glb_and_bundle(self) -> None:
        # Arrange
        required_nodes = {
            "arms_root",
            "left_hand_group",
            "left_wrist_anchor",
            "right_hand_group",
            "right_wrist_anchor",
            "right_index_joint_0",
            "left_arm_rig",
            "left_arm_rig_forearm",
            "left_arm_rig_sleeve",
            "left_watch",
            "watch_dial",
            "right_arm_rig",
            "right_arm_rig_forearm",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir)

            # Act
            artifacts = build_all(output_dir=out_dir, texture_size=128, seed=42)
            arms_art = next(a for a in artifacts if a.name == "fps_arms")
            glb_bytes = arms_art.glb_path.read_bytes()
            bundle_text = arms_art.bundle_path.read_text(encoding="utf-8")

            # Assert GLB validity & required rig nodes
            stats = inspect_glb_stats(glb_bytes)
            self.assertGreater(stats["triangles"], 4000)
            json_len, _ = struct.unpack_from("<II", glb_bytes, 12)
            gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8"))

            for bv in gltf["bufferViews"]:
                self.assertEqual(bv["byteOffset"] % 4, 0)

            node_names = {n["name"] for n in gltf["nodes"]}
            self.assertTrue(required_nodes.issubset(node_names))

            skin_mat = next(m for m in gltf["materials"] if m["name"] == "Arms_WetSkin")
            self.assertAlmostEqual(skin_mat["extras"]["pbrPhysical"]["clearcoat"], 0.45)
            self.assertIn("sheenColor", skin_mat["extras"]["pbrPhysical"])

            match = re.search(r'FPS_MODELS\["fps_arms"\]\s*=\s*"([^"]+)"', bundle_text)
            self.assertIsNotNone(match)
            self.assertEqual(base64.b64decode(match.group(1)), glb_bytes)


if __name__ == "__main__":
    unittest.main()

