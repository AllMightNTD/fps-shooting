"""AAA unit tests (Happy & Unhappy paths) for Tactical Pistol PBR geometry, textures, and GLB export."""

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

from model.build import inspect_glb_stats
from model.core import (
    create_pistol_textures,
    export_glb,
    export_js_bundle,
    extrude_hollow_profile,
    extrude_side_profile,
    sample_quadratic_bezier,
)
from model.weapons import PISTOL_METADATA, build_pistol_nodes


class TestPistolGeometryAndTextures(unittest.TestCase):
    def test_sample_quadratic_and_hollow_extrude_produce_valid_manifold_normals(self) -> None:
        # Arrange
        outer = [(-0.04, 0.02), (-0.04, -0.01), (0.01, -0.01), (0.01, 0.02)]
        inner = [(-0.032, 0.014), (-0.032, -0.004), (0.002, -0.004), (0.002, 0.014)]
        curve = [(0.0, 0.0), *sample_quadratic_bezier((0.0, 0.0), (0.02, 0.01), (0.04, 0.0), segments=8), (0.02, -0.02)]

        # Act
        hollow = extrude_hollow_profile(outer, inner, depth=0.012, bevel_size=0.001, bevel_thickness=0.001, bevel_segments=3)
        side = extrude_side_profile(curve, width=0.024, bevel=0.0012, bevel_segments=3)

        # Assert
        np.testing.assert_allclose(np.linalg.norm(hollow.normals, axis=1), np.ones(len(hollow.normals)), atol=1e-5)
        np.testing.assert_allclose(np.linalg.norm(side.normals, axis=1), np.ones(len(side.normals)), atol=1e-5)
        bmin, bmax = side.positions.min(axis=0), side.positions.max(axis=0)
        self.assertAlmostEqual(float(bmin[0] + bmax[0]), 0.0, places=5)  # Symmetric across X = 0
        self.assertEqual(len(hollow.indices) % 3, 0)
        self.assertLess(int(hollow.indices.max()), len(hollow.positions))

    def test_hollow_and_side_extrude_invalid_inputs_raise_value_error(self) -> None:
        # Arrange / Act / Assert (Unhappy Paths)
        with self.assertRaises(ValueError):
            sample_quadratic_bezier((0.0, 0.0), (0.1, 0.1), (0.2, 0.0), segments=0)
        with self.assertRaises(ValueError):
            extrude_side_profile([(0.0, 0.0), (0.1, 0.0), (0.0, 0.1)], width=0.0)
        with self.assertRaises(ValueError):
            # Inner loop larger than outer loop must fail
            extrude_hollow_profile(
                outer=[(-0.01, -0.01), (0.01, -0.01), (0.01, 0.01)],
                inner=[(-0.05, -0.05), (0.05, -0.05), (0.05, 0.05)],
                depth=0.01,
            )
        with self.assertRaises(ValueError):
            # Mismatched outer/inner vertex counts must fail
            extrude_hollow_profile(
                outer=[(-0.05, -0.05), (0.05, -0.05), (0.05, 0.05), (-0.05, 0.05)],
                inner=[(-0.01, -0.01), (0.01, -0.01), (0.01, 0.01)],
                depth=0.01,
            )

    def test_create_pistol_textures_valid_anodized_droplet_and_stipple_maps(self) -> None:
        # Arrange
        tex_size = 128

        # Act
        tex = create_pistol_textures(size=tex_size, scratch_count=20, droplet_count=60, seed=99)
        slide_mr = np.asarray(Image.open(io.BytesIO(tex.slide_mr_png)))
        stipple_norm = Image.open(io.BytesIO(tex.stipple_normal_png))

        # Assert
        self.assertEqual(slide_mr.shape, (tex_size, tex_size, 3))
        self.assertEqual(stipple_norm.size, (tex_size, tex_size))
        self.assertEqual(stipple_norm.mode, "RGB")
        # Rain droplets create glossy low-roughness pixels in G channel
        self.assertLess(int(slide_mr[..., 1].min()), 30)
        self.assertGreater(int(slide_mr[..., 1].max()), 90)

        with self.assertRaises(ValueError):
            create_pistol_textures(size=100)
        with self.assertRaises(ValueError):
            create_pistol_textures(size=64, scratch_count=-1)


class TestPistolGLBExport(unittest.TestCase):
    def test_build_pistol_nodes_exports_articulated_groups_and_tritium_sights(self) -> None:
        # Arrange
        required_nodes = {
            "pistol_root",
            "pistol_slide",
            "pistol_barrel",
            "pistol_frame",
            "pistol_trigger",
            "pistol_mag",
            "pistol_muzzle",
            "pistol_tritium_dots",
            "pistol_sight_rings",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            bundle_path = Path(tmpdir) / "pistol.bundle.js"

            # Act
            nodes = build_pistol_nodes(texture_size=128, seed=42)
            glb_bytes = export_glb(nodes, scene_name="Pistol_PBR_Scene")
            export_js_bundle(glb_bytes, bundle_path, model_key="pistol")

            # Assert
            stats = inspect_glb_stats(glb_bytes)
            self.assertGreater(stats["triangles"], 2500)
            self.assertLessEqual(stats["meshes"], 20)

            json_len, _ = struct.unpack_from("<II", glb_bytes, 12)
            gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8"))

            node_names = {n["name"] for n in gltf["nodes"]}
            self.assertTrue(required_nodes.issubset(node_names))

            root_node = next(n for n in gltf["nodes"] if n["name"] == "pistol_root")
            self.assertAlmostEqual(root_node["extras"]["slideBlowbackZ"], PISTOL_METADATA["slideBlowbackZ"])
            self.assertAlmostEqual(root_node["extras"]["slideLockZ"], PISTOL_METADATA["slideLockZ"])

            slide_mat = next(m for m in gltf["materials"] if m["name"] == "Pistol_Slide")
            self.assertAlmostEqual(slide_mat["extras"]["pbrPhysical"]["clearcoat"], 0.72)

            tritium_mat = next(m for m in gltf["materials"] if m["name"] == "Pistol_Tritium")
            self.assertTrue(tritium_mat["extras"]["pbrPhysical"]["unlit"])
            self.assertAlmostEqual(tritium_mat["extras"]["pbrPhysical"]["emissiveIntensity"], 4.5)

            bundle_text = bundle_path.read_text(encoding="utf-8")
            match = re.search(r'FPS_MODELS\["pistol"\]\s*=\s*"([^"]+)"', bundle_text)
            self.assertIsNotNone(match)
            self.assertEqual(base64.b64decode(match.group(1)), glb_bytes)


if __name__ == "__main__":
    unittest.main()

