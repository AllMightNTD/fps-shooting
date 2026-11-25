"""AAA unit tests (Happy & Unhappy paths) for model geometry, textures, and GLB export."""

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
    GLBNode,
    create_beveled_box,
    create_box,
    create_cylinder,
    create_extruded_tube_frame,
    create_lathe,
    create_rain_and_metal_textures,
    create_ring,
    export_glb,
    export_js_bundle,
    extrude_shape,
)
from model.weapons.m416 import _STOCK_SHAPE


class TestGeometryPrimitives(unittest.TestCase):
    def test_create_beveled_box_exact_bounds_and_unit_normals(self) -> None:
        # Arrange
        w, h, d, bevel = 0.052, 0.044, 0.24, 0.004

        # Act
        mesh = create_beveled_box(w, h, d, bevel=bevel, segments=3)

        # Assert
        bmin = mesh.positions.min(axis=0)
        bmax = mesh.positions.max(axis=0)
        np.testing.assert_allclose(bmax - bmin, [w, h, d], atol=1e-5)
        norm_len = np.linalg.norm(mesh.normals, axis=1)
        np.testing.assert_allclose(norm_len, np.ones_like(norm_len), atol=1e-5)
        self.assertEqual(len(mesh.indices) % 3, 0)
        self.assertLess(int(mesh.indices.max()), mesh.positions.shape[0])

    def test_extrude_shape_stock_profile_valid_mesh(self) -> None:
        # Arrange
        depth, bevel = 0.042, 0.004

        # Act
        mesh = extrude_shape(_STOCK_SHAPE, depth=depth, bevel_size=bevel, bevel_thickness=bevel, bevel_segments=3)

        # Assert
        bmin = mesh.positions.min(axis=0)
        bmax = mesh.positions.max(axis=0)
        self.assertAlmostEqual(float(bmin[2]), -bevel, places=5)
        self.assertAlmostEqual(float(bmax[2]), depth + bevel, places=5)
        self.assertGreater(float(bmax[0] - bmin[0]), 0.18)
        self.assertLess(int(mesh.indices.max()), mesh.positions.shape[0])

    def test_create_lathe_and_extruded_tube_frame_valid(self) -> None:
        # Arrange
        profile = [(0.01, 0.0), (0.015, 0.02), (0.012, 0.05)]
        outer = [(-0.02, 0.0), (0.02, 0.0), (0.015, 0.04), (-0.015, 0.04)]
        inner = [(-0.014, 0.005), (0.014, 0.005), (0.010, 0.035), (-0.010, 0.035)]

        # Act
        lathe = create_lathe(profile, segments=16)
        hood = create_extruded_tube_frame(outer, inner, depth=0.05)

        # Assert
        np.testing.assert_allclose(np.linalg.norm(lathe.normals, axis=1), np.ones(len(lathe.normals)), atol=1e-5)
        np.testing.assert_allclose(np.linalg.norm(hood.normals, axis=1), np.ones(len(hood.normals)), atol=1e-5)
        self.assertLess(int(hood.indices.max()), hood.positions.shape[0])

    def test_geometry_invalid_dimensions_raise_value_error(self) -> None:
        # Arrange / Act / Assert
        with self.assertRaises(ValueError):
            create_box(0.0, 1.0, 1.0)
        with self.assertRaises(ValueError):
            create_beveled_box(1.0, 1.0, 1.0, bevel=-0.01)
        with self.assertRaises(ValueError):
            extrude_shape([(0.0, 0.0), (1.0, 0.0)], depth=0.1)
        with self.assertRaises(ValueError):
            create_cylinder(0.0, 0.0, 1.0)
        with self.assertRaises(ValueError):
            create_ring(1.0, 0.5)


class TestPBRTexturesAndExporter(unittest.TestCase):
    def test_create_rain_and_metal_textures_valid_png_dimensions(self) -> None:
        # Arrange
        tex_size = 128

        # Act
        tex = create_rain_and_metal_textures(size=tex_size, droplet_count=120, seed=7)
        rough_img = Image.open(io.BytesIO(tex.roughness_png))
        normal_img = Image.open(io.BytesIO(tex.normal_png))
        mr_img = Image.open(io.BytesIO(tex.gunmetal_mr_png))

        # Assert
        self.assertEqual(rough_img.size, (tex_size, tex_size))
        self.assertEqual(normal_img.size, (tex_size, tex_size))
        self.assertEqual(normal_img.mode, "RGB")
        self.assertEqual(mr_img.mode, "RGB")
        self.assertGreater(len(tex.gunmetal_albedo_png), 100)
        self.assertGreater(len(tex.polymer_albedo_png), 100)
        rough_arr = np.asarray(rough_img)
        self.assertLess(int(rough_arr.min()), 25)  # Rain droplets create glossy low-roughness spots

    def test_textures_invalid_size_raises_value_error(self) -> None:
        # Arrange / Act / Assert
        with self.assertRaises(ValueError):
            create_rain_and_metal_textures(size=100)
        with self.assertRaises(ValueError):
            create_rain_and_metal_textures(size=64, droplet_count=-5)

    def test_exporter_rejects_empty_nodes_and_missing_material(self) -> None:
        # Arrange
        box = create_box(0.1, 0.1, 0.1)
        bad_node = GLBNode(name="missing_mat", mesh=box, material=None)

        # Act / Assert
        with self.assertRaises(ValueError):
            export_glb([])
        with self.assertRaises(ValueError):
            export_glb([bad_node])
        with self.assertRaises(ValueError):
            export_js_bundle(b"1234", Path("/tmp/unused.js"), model_key="bad-key!")


class TestM416BuildPipeline(unittest.TestCase):
    def test_build_all_generates_valid_glb_and_js_bundle(self) -> None:
        # Arrange
        required_nodes = {
            "m416_root",
            "m416_static_gunmetal",
            "m416_static_steel",
            "m416_static_polymer",
            "m416_static_fde",
            "holo_lens",
            "reticle_group",
            "trigger_group",
            "bolt_vis",
            "charging_handle",
            "mag_group",
            "laser_lens",
            "laser_origin",
            "muzzle_anchor",
            "socket_handguard",
            "socket_grip",
            "socket_mag",
            "socket_charging",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir)

            # Act
            artifacts = build_all(output_dir=out_dir, texture_size=128, seed=42)
            self.assertEqual({a.name for a in artifacts}, {"m416", "pistol", "fps_arms", "soldier"})
            m416_art = next(a for a in artifacts if a.name == "m416")
            glb_bytes = m416_art.glb_path.read_bytes()
            bundle_text = m416_art.bundle_path.read_text(encoding="utf-8")

            # Assert GLB binary structure & glTF 2.0 spec compliance
            stats = inspect_glb_stats(glb_bytes)
            self.assertGreater(stats["triangles"], 5000)
            self.assertLess(stats["meshes"], 20)  # Static meshes merged by material

            json_len, _ = struct.unpack_from("<II", glb_bytes, 12)
            gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8"))

            for bv in gltf["bufferViews"]:
                self.assertEqual(bv["byteOffset"] % 4, 0)

            for mesh in gltf["meshes"]:
                for prim in mesh["primitives"]:
                    pos_acc = gltf["accessors"][prim["attributes"]["POSITION"]]
                    self.assertIn("min", pos_acc)
                    self.assertIn("max", pos_acc)

            node_names = {n["name"] for n in gltf["nodes"]}
            self.assertTrue(required_nodes.issubset(node_names))

            gunmetal_mat = next(m for m in gltf["materials"] if m["name"] == "M416_GunMetal")
            self.assertAlmostEqual(gunmetal_mat["extras"]["pbrPhysical"]["clearcoat"], 0.85)

            # Assert Base64 JS bundle decodes identically to .glb
            match = re.search(r'FPS_MODELS\["m416"\]\s*=\s*"([^"]+)"', bundle_text)
            self.assertIsNotNone(match)
            decoded = base64.b64decode(match.group(1))
            self.assertEqual(decoded, glb_bytes)


if __name__ == "__main__":
    unittest.main()

