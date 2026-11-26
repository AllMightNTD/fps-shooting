"""AAA unit tests (Happy & Unhappy paths) for AWM glTF 2.0 PBR conversion, sockets, and bolt/mag pivots."""

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

from model.build import inspect_glb_stats
from model.core import export_js_bundle
import model.weapons.awm as awm_mod
from model.weapons.awm import AWM_METADATA, build_awm_glb


def _eval_node_world_mats(gltf: dict[str, object]) -> dict[str, np.ndarray]:
    nodes = gltf["nodes"]  # type: ignore[index]
    mats: dict[int, np.ndarray] = {}

    def local_mat(n: dict[str, object]) -> np.ndarray:
        if "matrix" in n:
            return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        t = n.get("translation", [0.0, 0.0, 0.0])
        r = n.get("rotation", [0.0, 0.0, 0.0, 1.0])
        s = n.get("scale", [1.0, 1.0, 1.0])
        qx, qy, qz, qw = r
        rot = np.array(
            [
                [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
                [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
                [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
            ],
            dtype=np.float64,
        )
        m = np.eye(4, dtype=np.float64)
        m[:3, :3] = rot @ np.diag(s)
        m[:3, 3] = t
        return m

    def walk(idx: int, parent_m: np.ndarray) -> None:
        m = parent_m @ local_mat(nodes[idx])
        mats[idx] = m
        for c in nodes[idx].get("children", []):
            walk(c, m)

    for root_idx in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:  # type: ignore[index]
        walk(root_idx, np.eye(4, dtype=np.float64))

    return {nodes[i]["name"]: m for i, m in mats.items() if "name" in nodes[i]}


class TestAWMConversionAndRig(unittest.TestCase):
    def test_build_awm_glb_converts_pbr_normalizes_metric_neg_z_and_exports_sockets(self) -> None:
        # Arrange
        required_nodes = {
            "awm_root",
            "frame",
            "awm_bolt_pivot",
            "bolt",
            "bolt_handle",
            "awm_mag_group",
            "mag",
            "trigger",
            "scope",
            "lenses",
            "muzzle_anchor",
            "scope_eye",
            "socket_handguard",
            "socket_grip",
            "socket_mag",
            "socket_charging",
            "socket_bolt_right",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            bundle_path = Path(tmpdir) / "awm.bundle.js"

            # Act
            glb_bytes = build_awm_glb(texture_size=128)
            export_js_bundle(glb_bytes, bundle_path, model_key="awm")

            # Assert binary stats & PBR extension removal
            stats = inspect_glb_stats(glb_bytes)
            self.assertGreater(stats["vertices"], 5000)
            self.assertEqual(stats["meshes"], 8)

            jlen, _ = struct.unpack_from("<II", glb_bytes, 12)
            gltf = json.loads(glb_bytes[20 : 20 + jlen].decode("utf-8"))
            bin_off = 20 + jlen + 8

            self.assertNotIn("KHR_materials_pbrSpecularGlossiness", gltf.get("extensionsUsed", []))
            self.assertNotIn("KHR_materials_pbrSpecularGlossiness", gltf.get("extensionsRequired", []))
            for bv in gltf["bufferViews"]:
                self.assertEqual(bv["byteOffset"] % 4, 0)

            mats_by_name = {m["name"]: m for m in gltf["materials"]}
            self.assertEqual(set(mats_by_name.keys()), {"AWM_RiflePBR", "AWM_ScopePBR", "AWM_OpticLens"})
            rifle_mat = mats_by_name["AWM_RiflePBR"]
            self.assertIn("metallicRoughnessTexture", rifle_mat["pbrMetallicRoughness"])
            self.assertAlmostEqual(rifle_mat["extras"]["pbrPhysical"]["clearcoat"], 0.12)
            self.assertAlmostEqual(mats_by_name["AWM_ScopePBR"]["extras"]["pbrPhysical"]["clearcoat"], 0.18)

            # Verify OD-green polymer chassis vs metallic barrel/receiver/bolt mask separation
            rifle_mr_tex = rifle_mat["pbrMetallicRoughness"]["metallicRoughnessTexture"]["index"]
            rifle_mr_img_idx = gltf["textures"][rifle_mr_tex]["source"]
            rifle_mr_bv = gltf["bufferViews"][gltf["images"][rifle_mr_img_idx]["bufferView"]]
            rifle_mr_raw = glb_bytes[
                bin_off + rifle_mr_bv["byteOffset"] : bin_off + rifle_mr_bv["byteOffset"] + rifle_mr_bv["byteLength"]
            ]
            rifle_mr = np.asarray(Image.open(io.BytesIO(rifle_mr_raw)))
            poly_mask = rifle_mr[..., 2] <= 25
            metal_mask = rifle_mr[..., 2] >= 195
            self.assertGreater(float(poly_mask.mean()), 0.25)
            self.assertGreater(float(metal_mask.mean()), 0.40)
            self.assertGreaterEqual(float(rifle_mr[poly_mask, 1].mean()) / 255.0, 0.72)
            metal_rough_mean = float(rifle_mr[metal_mask, 1].mean()) / 255.0
            self.assertGreaterEqual(metal_rough_mean, 0.32)
            self.assertLessEqual(metal_rough_mean, 0.50)

            for img_meta in gltf["images"]:
                bv = gltf["bufferViews"][img_meta["bufferView"]]
                raw = glb_bytes[bin_off + bv["byteOffset"] : bin_off + bv["byteOffset"] + bv["byteLength"]]
                im = Image.open(io.BytesIO(raw))
                self.assertEqual(im.size, (128, 128))
                self.assertEqual(im.mode, "RGB")

            world_mats = _eval_node_world_mats(gltf)
            self.assertTrue(required_nodes.issubset(set(world_mats.keys())))

            # Verify transformed metric bounds: muzzle forward at -Z (~ -0.80m), stock back at +Z (~ +0.39m)
            root_node = next(n for n in gltf["nodes"] if n["name"] == "awm_root")
            self.assertEqual(root_node["extras"]["weapon"], AWM_METADATA["weapon"])

            muz_pos = world_mats["muzzle_anchor"][:3, 3]
            self.assertLess(muz_pos[2], -0.75)
            bolt_knob_pos = world_mats["socket_bolt_right"][:3, 3]
            self.assertGreater(bolt_knob_pos[0], 0.04)  # Bolt handle must be on RIGHT (+X) side!
            mag_sock_pos = world_mats["socket_mag"][:3, 3]
            self.assertLess(mag_sock_pos[1], -0.04)
            self.assertLess(mag_sock_pos[2], -0.05)

            bundle_text = bundle_path.read_text(encoding="utf-8")
            match = re.search(r'FPS_MODELS\["awm"\]\s*=\s*"([^"]+)"', bundle_text)
            self.assertIsNotNone(match)
            self.assertEqual(base64.b64decode(match.group(1)), glb_bytes)

    def test_build_awm_glb_rejects_invalid_inputs_and_uses_tracked_fallback(self) -> None:
        # Arrange
        with tempfile.TemporaryDirectory() as tmpdir:
            bad_glb = Path(tmpdir) / "bad.glb"
            bad_glb.write_bytes(b"INVALID_DATA_1234567890")
            missing = Path(tmpdir) / "missing.glb"

            # Act / Assert (Unhappy Paths)
            with self.assertRaises(ValueError):
                build_awm_glb(texture_size=100)
            with self.assertRaises(ValueError):
                build_awm_glb(texture_size=4096)
            with self.assertRaises(FileNotFoundError):
                build_awm_glb(texture_size=128, source_path=missing)
            with self.assertRaises(ValueError):
                build_awm_glb(texture_size=128, source_path=bad_glb)

            # Fallback resolves cleanly to tracked model/assets/awm.glb when root file is absent
            with mock.patch.object(awm_mod, "_ROOT_SOURCE_GLB", missing):
                fb_glb = build_awm_glb(texture_size=128)
                self.assertGreater(len(fb_glb), 50_000)


if __name__ == "__main__":
    unittest.main()

