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
from unittest import mock

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
    def test_build_all_converts_skinned_fps_arms_to_standard_pbr_and_bundle(self) -> None:
        # Arrange
        required_nodes = {
            "arms_root",
            "_rootJoint",
            "L_arm_01",
            "L_elbow_02",
            "L_wrist_03",
            "R_arm_023",
            "R_elbow_024",
            "R_wrist_025",
            "R_point1_030",
            "R_point2_031",
            "R_point3_032",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir)

            # Act
            artifacts = build_all(output_dir=out_dir, texture_size=128, seed=42)
            arms_art = next(a for a in artifacts if a.name == "fps_arms")
            glb_bytes = arms_art.glb_path.read_bytes()
            bundle_text = arms_art.bundle_path.read_text(encoding="utf-8")

            # Assert GLB binary structure, standard PBR conversion, and meter/-Z root transform
            stats = inspect_glb_stats(glb_bytes)
            self.assertGreater(stats["vertices"], 3000)
            json_len, _ = struct.unpack_from("<II", glb_bytes, 12)
            gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8"))

            for bv in gltf["bufferViews"]:
                self.assertEqual(bv["byteOffset"] % 4, 0)

            self.assertNotIn("KHR_materials_pbrSpecularGlossiness", gltf.get("extensionsUsed", []))
            self.assertNotIn("KHR_materials_pbrSpecularGlossiness", gltf.get("extensionsRequired", []))

            self.assertEqual(len(gltf["skins"]), 1)
            self.assertEqual(len(gltf["skins"][0]["joints"]), 47)

            prim = gltf["meshes"][0]["primitives"][0]
            self.assertIn("JOINTS_0", prim["attributes"])
            self.assertIn("WEIGHTS_0", prim["attributes"])

            mat = gltf["materials"][0]
            self.assertNotIn("KHR_materials_pbrSpecularGlossiness", mat.get("extensions", {}))
            self.assertIn("pbrMetallicRoughness", mat)
            self.assertIn("baseColorTexture", mat["pbrMetallicRoughness"])
            self.assertIn("metallicRoughnessTexture", mat["pbrMetallicRoughness"])
            self.assertIn("normalTexture", mat)
            self.assertIn("occlusionTexture", mat)
            self.assertAlmostEqual(mat["occlusionTexture"]["strength"], 0.41, places=2)
            self.assertEqual(mat["extras"]["pbrPhysical"]["sheenColor"], 0x8A9280)
            self.assertAlmostEqual(mat["extras"]["pbrPhysical"]["clearcoat"], 0.16)

            node_names = {n["name"] for n in gltf["nodes"]}
            self.assertTrue(required_nodes.issubset(node_names))

            root_node = next(n for n in gltf["nodes"] if n["name"] == "arms_root")
            self.assertEqual(root_node["scale"], [0.01, 0.01, 0.01])
            self.assertEqual(root_node["rotation"], [0.0, 1.0, 0.0, 0.0])
            self.assertEqual(root_node["extras"]["rigType"], "skinned")
            self.assertIn("attribution", root_node["extras"])
            self.assertIn("leftHandBasis", root_node["extras"])
            self.assertIn("rightHandBasis", root_node["extras"])
            self.assertAlmostEqual(root_node["extras"]["upperLen"], 0.2587, places=4)
            self.assertAlmostEqual(root_node["extras"]["forearmLen"], 0.2543, places=4)
            self.assertEqual(root_node["extras"]["bones"]["leftArm"], "L_arm_01")
            self.assertEqual(
                root_node["extras"]["bones"]["rightIndex"],
                ["R_point1_030", "R_point2_031", "R_point3_032"],
            )

            # Assert downscaled image dimensions and converted modes
            bin_off = 20 + json_len + 8
            for idx, img_meta in enumerate(gltf["images"]):
                bv = gltf["bufferViews"][img_meta["bufferView"]]
                raw = glb_bytes[bin_off + bv["byteOffset"] : bin_off + bv["byteOffset"] + bv["byteLength"]]
                img = Image.open(io.BytesIO(raw))
                self.assertEqual(img.size, (128, 128))
                if idx == 1:
                    self.assertEqual(img.mode, "RGB")
                if idx == 3:
                    self.assertEqual(img.mode, "L")

            match = re.search(r'FPS_MODELS\["fps_arms"\]\s*=\s*"([^"]+)"', bundle_text)
            self.assertIsNotNone(match)
            self.assertEqual(base64.b64decode(match.group(1)), glb_bytes)

    def test_build_fps_arms_glb_rejects_invalid_inputs(self) -> None:
        # Arrange
        from model.characters import build_fps_arms_glb

        with tempfile.TemporaryDirectory() as tmpdir:
            bad_glb = Path(tmpdir) / "corrupt.glb"
            bad_glb.write_bytes(b"NOT_A_GLB_FILE_00000000")
            short_glb = Path(tmpdir) / "short.glb"
            short_glb.write_bytes(b"glTF")
            missing_glb = Path(tmpdir) / "missing.glb"

            # Act / Assert (Unhappy Paths)
            with self.assertRaises(ValueError):
                build_fps_arms_glb(texture_size=100)
            with self.assertRaises(ValueError):
                build_fps_arms_glb(texture_size=32)
            with self.assertRaises(ValueError):
                build_fps_arms_glb(texture_size=4096)
            with self.assertRaises(FileNotFoundError):
                build_fps_arms_glb(texture_size=128, source_path=missing_glb)
            with self.assertRaises(ValueError):
                build_fps_arms_glb(texture_size=128, source_path=bad_glb)
            with self.assertRaises(ValueError):
                build_fps_arms_glb(texture_size=128, source_path=short_glb)

    def test_build_fps_arms_glb_converts_spec_gloss_pixels_and_preserves_geometry_views(self) -> None:
        # Arrange: build a minimal hermetic synthetic Specular-Glossiness GLB in memory
        from model.characters import build_fps_arms_glb

        geom_bytes = b"\x01\x02\x03\x04\x11\x12\x13\x14" * 16  # 128 B
        skin_bytes = b"\xa1\xa2\xa3\xa4\xb1\xb2\xb3\xb4" * 8   # 64 B

        def _png_bytes(img: Image.Image) -> bytes:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue()

        diffuse_png = _png_bytes(Image.new("RGB", (64, 64), (10, 20, 30)))

        sg_arr = np.zeros((64, 64, 4), dtype=np.uint8)
        sg_arr[:, :32] = [40, 40, 40, 200]    # dielectric (B=0), gloss=200*0.8 -> G=95
        sg_arr[:, 32:] = [240, 240, 240, 10]  # metallic, gloss=10*0.8 -> G=238 (clamped)
        spec_gloss_png = _png_bytes(Image.fromarray(sg_arr, mode="RGBA"))

        normal_png = _png_bytes(Image.new("RGB", (64, 64), (128, 128, 255)))
        occ_gray = Image.new("L", (64, 64), 200)
        occ_palette = occ_gray.convert("P")
        occ_png = _png_bytes(occ_palette)

        slices = [geom_bytes, skin_bytes, diffuse_png, spec_gloss_png, normal_png, occ_png]
        bin_buf = bytearray()
        buffer_views = []
        for idx, data in enumerate(slices):
            pad = (-len(bin_buf)) % 4
            bin_buf.extend(b"\x00" * pad)
            bv: dict[str, object] = {"buffer": 0, "byteLength": len(data)}
            if idx != 0:
                bv["byteOffset"] = len(bin_buf)  # Mirror glTF optional byteOffset=0 on first view
            bin_buf.extend(data)
            buffer_views.append(bv)
        bin_buf.extend(b"\x00" * ((-len(bin_buf)) % 4))

        synth_gltf = {
            "asset": {"version": "2.0"},
            "extensionsUsed": ["KHR_materials_pbrSpecularGlossiness"],
            "extensionsRequired": ["KHR_materials_pbrSpecularGlossiness"],
            "scene": 0,
            "scenes": [{"name": "SynthScene", "nodes": [0]}],
            "nodes": [{"name": "_rootJoint"}],
            "materials": [
                {
                    "name": "SynthMat",
                    "extensions": {
                        "KHR_materials_pbrSpecularGlossiness": {
                            "diffuseTexture": {"index": 0},
                            "glossinessFactor": 0.8,
                            "specularFactor": [0.5, 0.5, 0.5],
                            "specularGlossinessTexture": {"index": 1},
                        }
                    },
                    "normalTexture": {"index": 2},
                    "occlusionTexture": {"index": 3, "strength": 0.41},
                }
            ],
            "textures": [{"source": 0}, {"source": 1}, {"source": 2}, {"source": 3}],
            "images": [
                {"bufferView": 2, "mimeType": "image/png"},
                {"bufferView": 3, "mimeType": "image/png"},
                {"bufferView": 4, "mimeType": "image/png"},
                {"bufferView": 5, "mimeType": "image/png"},
            ],
            "bufferViews": buffer_views,
            "buffers": [{"byteLength": len(bin_buf)}],
        }
        json_raw = json.dumps(synth_gltf, separators=(",", ":")).encode("utf-8")
        json_bytes = json_raw + b" " * ((-len(json_raw)) % 4)
        total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_buf)
        synth_glb_bytes = (
            struct.pack("<III", 0x46546C67, 2, total_len)
            + struct.pack("<II", len(json_bytes), 0x4E4F534A)
            + json_bytes
            + struct.pack("<II", len(bin_buf), 0x004E4942)
            + bytes(bin_buf)
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            synth_path = Path(tmpdir) / "synth.glb"
            synth_path.write_bytes(synth_glb_bytes)

            # Act
            out_glb = build_fps_arms_glb(texture_size=64, source_path=synth_path)

            # Assert: geometry/skinning bufferViews are preserved byte-for-byte & pixels match exact spec-gloss math
            jlen, _ = struct.unpack_from("<II", out_glb, 12)
            out_gltf = json.loads(out_glb[20 : 20 + jlen].decode("utf-8"))
            out_bin = out_glb[20 + jlen + 8 :]

            bv0 = out_gltf["bufferViews"][0]
            bv1 = out_gltf["bufferViews"][1]
            self.assertEqual(out_bin[bv0["byteOffset"] : bv0["byteOffset"] + bv0["byteLength"]], geom_bytes)
            self.assertEqual(out_bin[bv1["byteOffset"] : bv1["byteOffset"] + bv1["byteLength"]], skin_bytes)

            mr_bv = out_gltf["bufferViews"][out_gltf["images"][1]["bufferView"]]
            mr_arr = np.asarray(Image.open(io.BytesIO(out_bin[mr_bv["byteOffset"] : mr_bv["byteOffset"] + mr_bv["byteLength"]])))
            self.assertEqual(mr_arr.shape, (64, 64, 3))
            self.assertTrue(np.all(mr_arr[:, :, 0] == 255))
            np.testing.assert_array_equal(mr_arr[32, 8], [255, 95, 0])

            expected_spec_lin = ((240.0 * 0.5) / 255.0) ** 2.2
            expected_b = int(np.clip(np.round(((expected_spec_lin - 0.08) / 0.28) * 255.0), 0, 220))
            np.testing.assert_array_equal(mr_arr[32, 56], [255, 238, expected_b])

            occ_bv = out_gltf["bufferViews"][out_gltf["images"][3]["bufferView"]]
            occ_img = Image.open(io.BytesIO(out_bin[occ_bv["byteOffset"] : occ_bv["byteOffset"] + occ_bv["byteLength"]]))
            self.assertEqual(occ_img.mode, "L")
            self.assertEqual(int(np.asarray(occ_img)[32, 32]), 200)

    def test_build_fps_arms_glb_falls_back_to_tracked_model_asset(self) -> None:
        # Arrange
        import model.characters.fps_arms as fps_arms_mod

        with tempfile.TemporaryDirectory() as tmpdir:
            missing_root = Path(tmpdir) / "no_root_fps_arms.glb"
            missing_asset = Path(tmpdir) / "no_asset_fps_arms.glb"

            # Act / Assert: fallback resolves to tracked model/assets/fps_arms.glb when root file is absent
            with mock.patch.object(fps_arms_mod, "_ROOT_SOURCE_GLB", missing_root):
                glb_bytes = fps_arms_mod.build_fps_arms_glb(texture_size=64)
                stats = inspect_glb_stats(glb_bytes)
                self.assertGreater(stats["vertices"], 3000)

            with (
                mock.patch.object(fps_arms_mod, "_ROOT_SOURCE_GLB", missing_root),
                mock.patch.object(fps_arms_mod, "_ASSET_SOURCE_GLB", missing_asset),
            ):
                with self.assertRaises(FileNotFoundError):
                    fps_arms_mod.build_fps_arms_glb(texture_size=64)


if __name__ == "__main__":
    unittest.main()

