"""AAA unit tests (Happy & Unhappy paths) for PBR tactical soldier textures, geometry, and GLB rig."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import re
import struct
import tempfile
import unittest

from PIL import Image

from model.build import build_all, inspect_glb_stats
from model.core import create_soldier_textures


class TestSoldierTexturesAndRig(unittest.TestCase):
    def test_create_soldier_textures_valid_maps(self) -> None:
        # Arrange
        tex_size = 128

        # Act
        tex = create_soldier_textures(size=tex_size, seed=303)

        # Assert
        self.assertEqual(Image.open(io.BytesIO(tex.uniform_albedo_png)).size, (tex_size, tex_size))
        self.assertEqual(Image.open(io.BytesIO(tex.armor_albedo_png)).size, (tex_size, tex_size))
        self.assertEqual(Image.open(io.BytesIO(tex.uniform_normal_png)).mode, "RGB")
        self.assertEqual(Image.open(io.BytesIO(tex.armor_mr_png)).mode, "RGB")

    def test_create_soldier_textures_invalid_size_raises_value_error(self) -> None:
        # Arrange / Act / Assert
        with self.assertRaises(ValueError):
            create_soldier_textures(size=96)
        with self.assertRaises(ValueError):
            create_soldier_textures(size=0)

    def test_build_all_generates_rigged_soldier_glb_and_bundle(self) -> None:
        # Arrange
        required_nodes = {
            "soldier_root",
            "upper_body",
            "head_group",
            "head_helmet",
            "head_visor",
            "arms_group",
            "weapon_mount",
            "leg_left",
            "leg_right",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir)

            # Act
            artifacts = build_all(output_dir=out_dir, texture_size=128, seed=42)
            soldier_art = next(a for a in artifacts if a.name == "soldier")
            glb_bytes = soldier_art.glb_path.read_bytes()
            bundle_text = soldier_art.bundle_path.read_text(encoding="utf-8")

            # Assert
            stats = inspect_glb_stats(glb_bytes)
            self.assertGreater(stats["triangles"], 2000)
            json_len, _ = struct.unpack_from("<II", glb_bytes, 12)
            gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8"))

            for bv in gltf["bufferViews"]:
                self.assertEqual(bv["byteOffset"] % 4, 0)

            node_names = {n["name"] for n in gltf["nodes"]}
            self.assertTrue(required_nodes.issubset(node_names))

            root_node = next(n for n in gltf["nodes"] if n["name"] == "soldier_root")
            self.assertIn("headRadius", root_node["extras"])
            self.assertIn("headCenterY", root_node["extras"])

            match = re.search(r'FPS_MODELS\["soldier"\]\s*=\s*"([^"]+)"', bundle_text)
            self.assertIsNotNone(match)
            self.assertEqual(base64.b64decode(match.group(1)), glb_bytes)


if __name__ == "__main__":
    unittest.main()

