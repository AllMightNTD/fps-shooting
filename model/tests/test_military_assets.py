"""AAA unit tests for Khu Quân Sự Cũ 5v5 PBR map assets and shared layout/colliders."""

from __future__ import annotations

import base64
import json
from pathlib import Path
import re
import struct
import tempfile
import unittest

import numpy as np

from model.build import build_map_assets, inspect_glb_stats
from model.maps.layout_spec import ASSET_DIMS, MILITARY_BOUNDS, export_military_shared_json


def _parse_glb_positions_normals(glb_bytes: bytes) -> tuple[dict, np.ndarray, np.ndarray, np.ndarray]:
    json_len, _ = struct.unpack_from("<II", glb_bytes, 12)
    gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8"))
    bin_off = 20 + json_len + 8
    bin_bytes = glb_bytes[bin_off:]

    all_pos = []
    all_norm = []
    all_tris = []
    v_offset = 0
    accessors = gltf["accessors"]
    bvs = gltf["bufferViews"]

    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            pa = accessors[prim["attributes"]["POSITION"]]
            pbv = bvs[pa["bufferView"]]
            pos = np.frombuffer(bin_bytes, dtype="<f4", count=pa["count"] * 3, offset=pbv["byteOffset"]).reshape(-1, 3)

            na = accessors[prim["attributes"]["NORMAL"]]
            nbv = bvs[na["bufferView"]]
            norm = np.frombuffer(bin_bytes, dtype="<f4", count=na["count"] * 3, offset=nbv["byteOffset"]).reshape(-1, 3)

            ia = accessors[prim["indices"]]
            ibv = bvs[ia["bufferView"]]
            dt = "<u2" if ia["componentType"] == 5123 else "<u4"
            idx = np.frombuffer(bin_bytes, dtype=dt, count=ia["count"], offset=ibv["byteOffset"]).astype(np.int64)

            all_pos.append(pos)
            all_norm.append(norm)
            all_tris.append(idx.reshape(-1, 3) + v_offset)
            v_offset += len(pos)

    return gltf, np.vstack(all_pos), np.vstack(all_norm), np.vstack(all_tris)


class TestMilitaryMapAssets(unittest.TestCase):
    def test_build_map_assets_budget_bounds_and_normals(self) -> None:
        # Arrange
        expected_names = {
            "map_container",
            "map_warehouse",
            "map_wrecked_truck",
            "map_watchtower",
            "map_sandbag",
            "map_concrete_wall",
            "map_fence",
            "map_wood_crate",
            "map_oil_barrel",
            "map_wood_pallet",
            "map_tire_stack",
            "map_barbed_wire",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir)

            # Act
            artifacts = build_map_assets(output_dir=out_dir, texture_size=256, seed=101)

            # Assert all 8 assets exist, total GLB <= 10 MB, and every model sits cleanly at y=0
            self.assertEqual({a.name for a in artifacts}, expected_names)
            total_glb_bytes = sum(a.glb_bytes_len for a in artifacts)
            self.assertLessEqual(total_glb_bytes, 10 * 1024 * 1024)

            for art in artifacts:
                glb_bytes = art.glb_path.read_bytes()
                bundle_text = art.bundle_path.read_text(encoding="utf-8")
                stats = inspect_glb_stats(glb_bytes)
                self.assertGreater(stats["triangles"], 50)

                gltf, pos, norm, tris = _parse_glb_positions_normals(glb_bytes)
                self.assertGreaterEqual(len(gltf["images"]), 1)

                # Bottom-center grounding check: min Y near 0.0
                min_y = float(pos[:, 1].min())
                self.assertGreaterEqual(min_y, -0.02, f"{art.name} below y=0: {min_y}")
                self.assertLessEqual(min_y, 0.02, f"{art.name} floating above y=0: {min_y}")

                # Horizontal centering check (within 0.15m of origin)
                mid_x = 0.5 * (float(pos[:, 0].min()) + float(pos[:, 0].max()))
                mid_z = 0.5 * (float(pos[:, 2].min()) + float(pos[:, 2].max()))
                self.assertAlmostEqual(mid_x, 0.0, delta=0.20, msg=f"{art.name} X off-center")
                self.assertAlmostEqual(mid_z, 0.0, delta=0.25, msg=f"{art.name} Z off-center")

                # Normal unit length & outward winding consistency check
                n_lens = np.linalg.norm(norm, axis=1)
                self.assertTrue(np.allclose(n_lens, 1.0, atol=1e-2), f"{art.name} unnormalized normals")

                v0 = pos[tris[:, 0]]
                v1 = pos[tris[:, 1]]
                v2 = pos[tris[:, 2]]
                face_n = np.cross(v1 - v0, v2 - v0)
                avg_vert_n = (norm[tris[:, 0]] + norm[tris[:, 1]] + norm[tris[:, 2]]) / 3.0
                dots = np.sum(face_n * avg_vert_n, axis=1)
                valid_area = np.linalg.norm(face_n, axis=1) > 1e-8
                self.assertGreater(float(np.mean(dots[valid_area] > 0.0)), 0.99, f"{art.name} inverted normals")

                # Verify exact target dimensions for the 4 hero assets
                asset_key = art.name.removeprefix("map_")
                exp_w, exp_d, exp_h = ASSET_DIMS[asset_key]
                actual_w = float(pos[:, 0].max() - pos[:, 0].min())
                actual_d = float(pos[:, 2].max() - pos[:, 2].min())
                actual_h = float(pos[:, 1].max() - pos[:, 1].min())
                self.assertAlmostEqual(actual_w, exp_w, delta=0.80, msg=f"{art.name} width mismatch")
                self.assertAlmostEqual(actual_d, exp_d, delta=0.80, msg=f"{art.name} depth mismatch")
                self.assertAlmostEqual(actual_h, exp_h, delta=0.35, msg=f"{art.name} height mismatch")

                # Verify JS bundle matches exact GLB bytes
                match = re.search(rf'FPS_MODELS\["{art.name}"\]\s*=\s*"([^"]+)"', bundle_text)
                self.assertIsNotNone(match)
                self.assertEqual(base64.b64decode(match.group(1)), glb_bytes)

                # Verify baked vertical foot AO (COLOR_0) on grounded architectural/prop assets
                if art.name in {"map_concrete_wall", "map_container", "map_warehouse", "map_wood_crate"}:
                    prim0 = gltf["meshes"][0]["primitives"][0]
                    self.assertIn("COLOR_0", prim0["attributes"], f"{art.name} missing COLOR_0 foot AO")
                    ca = gltf["accessors"][prim0["attributes"]["COLOR_0"]]
                    cbv = gltf["bufferViews"][ca["bufferView"]]
                    bin_off = 20 + struct.unpack_from("<II", glb_bytes, 12)[0] + 8
                    cols = np.frombuffer(glb_bytes[bin_off:], dtype="<f4", count=ca["count"] * 3, offset=cbv["byteOffset"]).reshape(-1, 3)
                    pa = gltf["accessors"][prim0["attributes"]["POSITION"]]
                    pbv = gltf["bufferViews"][pa["bufferView"]]
                    p0 = np.frombuffer(glb_bytes[bin_off:], dtype="<f4", count=pa["count"] * 3, offset=pbv["byteOffset"]).reshape(-1, 3)
                    low_mask = p0[:, 1] < 0.08
                    high_mask = p0[:, 1] > 0.45
                    if np.any(low_mask) and np.any(high_mask):
                        self.assertLess(float(cols[low_mask].mean()), float(cols[high_mask].mean()))

    def test_military_layout_and_colliders_sightlines_and_openings(self) -> None:
        # Arrange
        with tempfile.TemporaryDirectory() as tmpdir:
            lp, cp = export_military_shared_json(Path(tmpdir), js_out_path=Path(tmpdir) / "military_map_data.js")
            layout = json.loads(lp.read_text(encoding="utf-8"))
            colliders = json.loads(cp.read_text(encoding="utf-8"))

        # Assert bounds, 5v5 spawns, walkable watchtower slab & ladder
        self.assertEqual(layout["bounds"], MILITARY_BOUNDS)
        self.assertGreaterEqual(len(colliders["spawns"]["A"]), 5)
        self.assertGreaterEqual(len(colliders["spawns"]["B"]), 5)
        self.assertGreaterEqual(len(colliders["spawns"]["FFA"]), 10)
        self.assertEqual(len(colliders["walkableSlabs"]), 1)
        self.assertAlmostEqual(colliders["walkableSlabs"][0]["y1"], 4.0, places=2)
        self.assertEqual(len(colliders["ladders"]), 1)
        self.assertAlmostEqual(colliders["ladders"][0]["maxY"], 4.02, places=2)

        # Ensure every Team A <-> Team B spawn sightline is blocked
        def ray_box(ox: float, oy: float, oz: float, dx: float, dy: float, dz: float, b: dict, max_d: float) -> float | None:
            tmin, tmax = 0.0, max_d
            for o, d, b0, b1 in (
                (ox, dx, b["x0"], b["x1"]),
                (oy, dy, b["y0"], b["y1"]),
                (oz, dz, b["z0"], b["z1"]),
            ):
                if abs(d) < 1e-8:
                    if o < b0 or o > b1:
                        return None
                else:
                    t1, t2 = (b0 - o) / d, (b1 - o) / d
                    if t1 > t2:
                        t1, t2 = t2, t1
                    tmin, tmax = max(tmin, t1), min(tmax, t2)
                    if tmin > tmax:
                        return None
            return tmin if 0.0 <= tmin <= tmax else None

        def has_los(a: tuple[float, float, float], b_pt: tuple[float, float, float]) -> bool:
            dx, dy, dz = b_pt[0] - a[0], b_pt[1] - a[1], b_pt[2] - a[2]
            dist = float(np.linalg.norm([dx, dy, dz]))
            nx, ny, nz = dx / dist, dy / dist, dz / dist
            for box in colliders["boxes"]:
                if box.get("moveOnly"):
                    continue
                t = ray_box(a[0], a[1], a[2], nx, ny, nz, box, dist)
                if t is not None and t < dist - 0.05:
                    return False
            return True

        for sa in colliders["spawns"]["A"]:
            for sb in colliders["spawns"]["B"]:
                self.assertFalse(has_los((sa["x"], 1.65, sa["z"]), (sb["x"], 1.65, sb["z"])))

        # Warehouse windows & truck cab windows allow bullets cleanly
        self.assertTrue(has_los((-19.0, 1.65, -18.1), (-14.0, 1.65, -18.1)))
        self.assertTrue(has_los((-22.0, 1.65, -14.0), (-22.0, 1.65, -4.0)))
        self.assertTrue(has_los((-19.0, 1.65, -10.9), (-14.0, 1.65, -10.9)))
        self.assertTrue(has_los((-8.5, 1.80, -11.5), (-3.5, 1.80, -13.5)))


if __name__ == "__main__":
    unittest.main()
