# Skinned FPS Arms (GLB) Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the procedural FPP arms (`model/characters/fps_arms.py`) with the user's rigged, gloved `SkinnedMesh` model in `fps_arms.glb` (`47` joints, `armmesh_Mat_0`) by converting its `KHR_materials_pbrSpecularGlossiness` textures to standard glTF 2.0 `pbrMetallicRoughness` in Python and driving both arms + fingers with analytical 2-bone IK across `M416`, `Glock-17`, and `AWM Sniper`.

**Architecture:** The asset pipeline (`model/characters/fps_arms.py` invoked by `model/build.py`) ingests `fps_arms.glb` at repository root, converts its `2048×2048` Specular-Glossiness + Occlusion + Normal textures into resized standard glTF 2.0 Metallic-Roughness PBR textures (`512×512` default) while preserving all `47` skinning joints and `inverseBindMatrices`, and wraps the scene under `arms_root` (`scale = 0.01`, `rotY = Math.PI`) so coordinates match meters facing `-Z`. At runtime, a focused zero-dependency ES module `public/js/arm_rig.js` solves twist-stabilized 2-bone analytical IK (`L_arm_01` → `L_elbow_02` → `L_wrist_03` and `R_arm_023` → `R_elbow_024` → `R_wrist_025`) plus trigger/grip finger curls, and `public/js/game.js` wires it into `hydratePbrMaterial()`, `loadModelAsset("fps_arms", ...)`, and `gunAnim()`.

**Tech Stack:** Python 3.12 (`numpy`, `Pillow` via `uv`), glTF 2.0 binary (`.glb`) + Base64 `.bundle.js`, Three.js r128 (`GLTFLoader`, `SkinnedMesh`, `MeshPhysicalMaterial`), Node.js v24 ES Modules (`node --test`).

**Spec:** User request (`Tôi có 1 model 3D tay có sẵn xương + găng tay ở file @[fps_arms.glb], hãy tích hợp nó vào thay cho model tay hiện tại`) and direct binary/code inspection of `fps_arms.glb`, `model/build.py`, `server/index.js`, and `public/js/game.js`.

## Global Constraints

- Zero external `npm` runtime dependencies; frontend JS must stay pure ES Modules served by `server/index.js`.
- All frontend module filenames under `public/js/` MUST match `PUBLIC_JS_RE = /^\/js\/([a-z0-9_]+)\.js$/` in `server/index.js:23` (lowercase alphanumeric + underscore only, e.g., `arm_rig.js`).
- Preserve `file://` and HTTP compatibility via both `model/dist/fps_arms.glb` and `model/dist/fps_arms.bundle.js` (`window.FPS_MODELS["fps_arms"]`).
- Preserve `VIEW_LAYER = 1`, `cam.near = 0.03`, and existing weapon behaviors (`M416`, `Glock-17` slide-lock/mag-drop, `AWM Sniper` scope overlay, tactical/empty reloads).
- Preserve CC-BY-4.0 attribution (`author: DJMaesen`, `source: https://sketchfab.com/3d-models/fps-arms-08ec4403a47645d8ad80633abf13d39d`) in documentation.
- Do NOT break existing `model/core/` primitives/textures (`create_capsule`, `create_torus`, `create_tube_along_curve`, `create_realistic_skin_textures`, `create_glove_textures`) still tested in `model/tests/test_arms_model.py`.

## Review Focus

1. **`KHR_materials_pbrSpecularGlossiness` silently dropped by `hydratePbrMaterial()`** — `fps_arms.glb` uses `specularGlossinessTexture`, which `new THREE.MeshPhysicalMaterial(...)` in `public/js/game.js:577` ignores (`metalnessMap`/`roughnessMap` only). Pinned by `TestFPSArmsBuildPipeline` in `model/tests/test_arms_model.py` asserting standard `pbrMetallicRoughness` (`baseColorTexture` + `metallicRoughnessTexture` + `normalTexture` + `occlusionTexture`) and absence of `KHR_materials_pbrSpecularGlossiness`.
2. **Oversized `2048×2048` PNGs bloating `.bundle.js` (~13.7 MB) or invalid `texture_size` inputs** — Downscaling cleanly to `texture_size` cuts `.bundle.js` to ~1–3 MB, while invalid sizes or missing/corrupt source GLBs must fail fast with explicit errors. Pinned by happy & unhappy path tests in `model/tests/test_arms_model.py`.
3. **Inverted model facing (`+Z`) and centimeter scale (`×100`)** — Raw `fps_arms.glb` puts `L_arm_01` at `+X` and hands toward `+Z` in centimeters. Pinned by `model/tests/test_arms_model.py` asserting `arms_root` `scale=[0.01, 0.01, 0.01]` and `rotation=[0.0, 1.0, 0.0, 0.0]` (`180°` Y) so skinned arms face `-Z` in meters.
4. **Three.js `SkinnedMesh` frustum culling disappearance & IK `NaN` on extreme reach** — `SkinnedMesh` defaults to bind-pose bounding sphere culling and `acos` inputs outside `[-1, 1]` produce `NaN` bone quaternions when targets exceed `L1 + L2` (`0.513m`) or collapse to `0`. Pinned by `server/tests/test_arm_rig.mjs` testing `frustumCulled === false`, finite unit quaternions under overextension/collapse, and safe no-op when skeleton bones are missing.
5. **Serving `/js/arm_rig.js` (`404` risk) & pre-load `gunAnim(0, 0)` calls** — `server/index.js` allowlists `/js/[a-z0-9_]+.js` and `game.js:1263` runs before async GLB parsing finishes. Pinned by HTTP static serve assertion in `server/tests/test_lan_v2.js` and null-safe controller tests in `server/tests/test_arm_rig.mjs`.

---

### Task 1: Convert & Normalize `fps_arms.glb` in Python Asset Pipeline

**Files:**
- Modify: `model/characters/fps_arms.py`
- Modify: `model/characters/__init__.py`
- Modify: `model/build.py:12,73-88`
- Test: `model/tests/test_arms_model.py:85-136`

**Interfaces:**
- Consumes: root `fps_arms.glb` (`Path`), `export_js_bundle` from `model/core/glb_exporter.py`
- Produces:
  - `FPS_ARMS_METADATA: dict[str, object]` in `model/characters/fps_arms.py` (`rigType="skinned"`, `upperLen=0.2587`, `forearmLen=0.2543`, exact bone name map)
  - `build_fps_arms_glb(texture_size: int = 512, source_path: Path | None = None) -> bytes` in `model/characters/fps_arms.py`
  - `model/dist/fps_arms.glb` and `model/dist/fps_arms.bundle.js` via `model/build.py:build_all()`

- [ ] **Step 1: Write failing unit tests in `model/tests/test_arms_model.py`**

Replace `TestFPSArmsBuildPipeline` (`model/tests/test_arms_model.py:85-136`) with tests covering the skinned GLB converter (happy path + missing file / invalid size / corrupt GLB unhappy paths):

```python
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
            self.assertIn("pbrMetallicRoughness", mat)
            self.assertIn("baseColorTexture", mat["pbrMetallicRoughness"])
            self.assertIn("metallicRoughnessTexture", mat["pbrMetallicRoughness"])
            self.assertIn("normalTexture", mat)
            self.assertIn("occlusionTexture", mat)
            self.assertEqual(mat["extras"]["pbrPhysical"]["sheenColor"], 0x8A9280)

            node_names = {n["name"] for n in gltf["nodes"]}
            self.assertTrue(required_nodes.issubset(node_names))

            root_node = next(n for n in gltf["nodes"] if n["name"] == "arms_root")
            self.assertEqual(root_node["scale"], [0.01, 0.01, 0.01])
            self.assertEqual(root_node["rotation"], [0.0, 1.0, 0.0, 0.0])
            self.assertEqual(root_node["extras"]["rigType"], "skinned")

            # Assert downscaled image dimensions
            bin_off = 20 + json_len + 8
            for img_meta in gltf["images"]:
                bv = gltf["bufferViews"][img_meta["bufferView"]]
                raw = glb_bytes[bin_off + bv["byteOffset"] : bin_off + bv["byteOffset"] + bv["byteLength"]]
                self.assertEqual(Image.open(io.BytesIO(raw)).size, (128, 128))

            match = re.search(r'FPS_MODELS\["fps_arms"\]\s*=\s*"([^"]+)"', bundle_text)
            self.assertIsNotNone(match)
            self.assertEqual(base64.b64decode(match.group(1)), glb_bytes)

    def test_build_fps_arms_glb_rejects_invalid_inputs(self) -> None:
        # Arrange
        from model.characters import build_fps_arms_glb

        with tempfile.TemporaryDirectory() as tmpdir:
            bad_glb = Path(tmpdir) / "corrupt.glb"
            bad_glb.write_bytes(b"NOT_A_GLB_FILE_00000000")
            missing_glb = Path(tmpdir) / "missing.glb"

            # Act / Assert (Unhappy Paths)
            with self.assertRaises(ValueError):
                build_fps_arms_glb(texture_size=100)
            with self.assertRaises(FileNotFoundError):
                build_fps_arms_glb(texture_size=128, source_path=missing_glb)
            with self.assertRaises(ValueError):
                build_fps_arms_glb(texture_size=128, source_path=bad_glb)
```

- [ ] **Step 2: Run Python test suite to verify failure**

Run: `uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m unittest model.tests.test_arms_model -v`
Expected: FAIL with `ImportError: cannot import name 'build_fps_arms_glb' from 'model.characters'` and missing `arms_root` scale/skin assertions.

- [ ] **Step 3: Implement `build_fps_arms_glb(texture_size: int = 512, source_path: Path | None = None) -> bytes` in `model/characters/fps_arms.py`**

Implement in `model/characters/fps_arms.py`:
- Validate `texture_size` is a power of two in `[64, 2048]` (`ValueError`), `source_path` defaults to `Path(__file__).resolve().parents[2] / "fps_arms.glb"` and exists (`FileNotFoundError`), and GLB header (`magic == 0x46546C67`, `version == 2`, `JSON` + `BIN` chunks) is valid (`ValueError`).
- Parse JSON and BIN chunks from `source_path`:
  - Read `image[0]` (diffuse RGB), `image[1]` (specular-glossiness RGBA), `image[2]` (normal RGB), `image[3]` (occlusion palette `P` -> convert to `L`).
  - Resize each image to `(texture_size, texture_size)` using `Image.Resampling.LANCZOS`.
  - Convert specular-glossiness RGBA to glTF `metallicRoughness` RGB (`R = 255`, `G = np.clip(255 - np.round(alpha * gloss_factor), 45, 238)`, `B = np.clip(np.round(((spec_lin - 0.08) / 0.28) * 255), 0, 220)` where `spec_lin = (spec_rgb.mean(axis=2) / 255.0) ** 2.2`).
  - Encode the 4 converted PNGs into a fresh 4-byte-aligned BIN payload preserving all existing geometry/skin `bufferViews` verbatim while replacing the 4 image `bufferViews` and stripping obsolete extension keys (`KHR_materials_pbrSpecularGlossiness` from `extensionsUsed`/`extensionsRequired` and `material["extensions"]`).
  - Set `material["pbrMetallicRoughness"] = { "baseColorFactor": [1,1,1,1], "baseColorTexture": {"index": 0}, "metallicFactor": 1.0, "roughnessFactor": 1.0, "metallicRoughnessTexture": {"index": 1} }`, preserve `normalTexture` (`index: 2`) and `occlusionTexture` (`index: 3`, `strength: 0.41`), and set `material["extras"] = {"pbrPhysical": {"clearcoat": 0.16, "clearcoatRoughness": 0.36, "sheenColor": 0x8A9280, "sheenRoughness": 0.72}}`.
  - Prepend/append root node `arms_root` (`scale: [0.01, 0.01, 0.01]`, `rotation: [0.0, 1.0, 0.0, 0.0]`, `children: scene["nodes"]`, `extras: FPS_ARMS_METADATA`), point `scenes[0]["nodes"] = [arms_root_idx]`, and repackage 4-byte padded `JSON` + `BIN` GLB bytes.
- Define `FPS_ARMS_METADATA` with `"rigType": "skinned"`, `"upperLen": 0.2587`, `"forearmLen": 0.2543`, `"bones"` mapping (`leftArm: "L_arm_01"`, `leftElbow: "L_elbow_02"`, `leftWrist: "L_wrist_03"`, `rightArm: "R_arm_023"`, `rightElbow: "R_elbow_024"`, `rightWrist: "R_wrist_025"`, `rightIndex: ["R_point1_030", "R_point2_031", "R_point3_032"]`).

- [ ] **Step 4: Update `model/characters/__init__.py` and `model/build.py:12,73-88`**

- Export `FPS_ARMS_METADATA, build_fps_arms_glb` in `model/characters/__init__.py`.
- In `model/build.py:build_all()`, build `"fps_arms"` via `build_fps_arms_glb(texture_size=texture_size)` directly instead of `export_glb(build_fps_arms_nodes(...))`, then run `inspect_glb_stats(glb_bytes)` and `export_js_bundle(glb_bytes, bundle_path, model_key="fps_arms")`.

- [ ] **Step 5: Run tests and full asset build to verify**

Run:
`uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m unittest model.tests.test_arms_model model.tests.test_m416_model model.tests.test_soldier_model -v`
And:
`uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m model.build`
Expected: All tests in `test_arms_model`, `test_m416_model`, `test_soldier_model` PASS, and `model/dist/fps_arms.glb` + `model/dist/fps_arms.bundle.js` build cleanly (~800 KB–2 MB).

- [ ] **Step 6: Commit Task 1**

```bash
git add model/characters/fps_arms.py model/characters/__init__.py model/build.py model/tests/test_arms_model.py
git commit -m "feat(model): convert skinned fps_arms.glb to glTF 2.0 metallic-roughness PBR"
```

---

### Task 2: Analytical 2-Bone Arm IK & Skinned Finger Solver (`public/js/arm_rig.js`)

**Files:**
- Create: `public/js/arm_rig.js`
- Test: `server/tests/test_arm_rig.mjs`

**Interfaces:**
- Consumes: `THREE`-compatible math constructors (`Vector3`, `Quaternion`, `Matrix4`, `Euler`) and the loaded `fps_arms` GLTF `scene` (`L_arm_01`, `L_elbow_02`, `L_wrist_03`, `R_arm_023`, `R_elbow_024`, `R_wrist_025`, finger chains `{L,R}_{thumb,point,middle,ring,pink}{1..3}_*`)
- Produces:
  - `solveTwoBoneArmIK({ shoulderPos, targetPos, upperLen, forearmLen, poleHint, wristWorldQuat, parentWorldQuat, upperWorldMatInv, outShoulderQuat, outElbowQuat, outWristQuat }, MathApi)`
  - `SKINNED_ARM_POSES` (weapon pose presets for `m416`, `pistol`, `sniper`)
  - `createSkinnedArmsController(root, MathApi)` returning `{ ready, update(params), getBoneSummary() }`

- [ ] **Step 1: Write failing Node.js AAA tests in `server/tests/test_arm_rig.mjs`**

Create `server/tests/test_arm_rig.mjs` with a lightweight `Vector3` / `Quaternion` / `Matrix4` / `Euler` implementation matching Three.js r128 APIs (zero npm deps) to test:
1. `solveTwoBoneArmIK` places computed elbow at `L1 = 0.2587m` from shoulder and wrist at `L2 = 0.2543m` from elbow, reaching target within `< 1e-3m` for M416 grip, mag-out, charging handle, and Glock-17 poses.
2. Unhappy / edge paths: overextended target (`dist = 1.2m > L1 + L2`) and collapsed target (`dist = 0.001m`) return finite unit quaternions (`|q| ≈ 1`, no `NaN` anywhere).
3. `createSkinnedArmsController(mockRoot, MathApi)` sets `frustumCulled = false` on `SkinnedMesh` nodes, monotonically curls `R_point1_030` and `R_point2_031` when `triggerPull` increases `0 -> 1`, and returns a safe no-op controller (`ready === false`) when `root` is null or missing arm bones.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/tests/test_arm_rig.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../../public/js/arm_rig.js`.

- [ ] **Step 3: Implement `public/js/arm_rig.js`**

Implement clean, modular helpers in `public/js/arm_rig.js`:
- `solveTwoBoneArmIK(...)`:
  - Clamps distance `d` to `[Math.abs(upperLen - forearmLen) + 0.015, upperLen + forearmLen - 0.002]`.
  - Computes law-of-cosines elbow angle and elbow world position using `poleHint` orthogonalized against `(targetPos - shoulderPos)`.
  - Builds twist-stabilized orthonormal frames where local **`-Z`** points along each bone (`shoulder -> elbow`, `elbow -> wrist`), converts `outShoulderQuat` using `parentWorldQuat`, `outElbowQuat` using shoulder world quaternion, and `outWristQuat` directly from `wristWorldQuat` relative to forearm world quaternion.
  - Guards degenerate/collinear vectors (`norm < 1e-6`) with fallback axis to guarantee zero `NaN`.
- `SKINNED_ARM_POSES`:
  - `m416`: left wrist grip (`handguard C-clamp`), mag (`magwell`), out (`mag dropped`), ch/chPulled (`charging handle`), right wrist (`pistol grip`), shoulder anchors behind camera (`L: [-0.22, -0.14, 0.34]`, `R: [0.19, -0.14, 0.34]` in `gun` space), elbow poles (`L: [-0.48, -0.78, 0.12]`, `R: [0.48, -0.78, 0.12]`), and subtle relative finger curl offsets.
  - `pistol`: two-handed thumbs-forward wrap (`PISTOL_POSE` wrist targets + adjusted shoulders/poles for Glock-17 `PISTOL_HIP_POS` / `PISTOL_ADS_POS`).
  - `sniper`: forend support + bolt-action grip (`AWM Sniper`).
- `createSkinnedArmsController(root, MathApi)`:
  - Captures all bone nodes by exact prefix/name (`L_arm_01`, `L_elbow_02`, `L_wrist_03`, `R_arm_023`, `R_elbow_024`, `R_wrist_025`, and finger bones `L_*/R_*`), stores `restQ` and `restPos` per bone, sets `frustumCulled = false` on every `SkinnedMesh`.
  - If any of the 6 core arm bones (`L_arm_01..R_wrist_025`) is missing, returns `{ ready: false, update() {}, getBoneSummary: () => null }`.
  - `update({ weaponId, leftWristPos, leftWristQuat, rightWristPos, rightWristQuat, triggerPull, reloadProgress, isTactical, isSprinting, ads, hideArms })`: sets `root.visible = !hideArms`, updates shoulder positions in `arms_root` space, runs `solveTwoBoneArmIK` for left and right arms, applies relative finger curls + `triggerPull` flexion on `R_point1_030` / `R_point2_031` / `R_point3_032`, and resets matrices cleanly.

- [ ] **Step 4: Run Node.js tests to verify pass**

Run: `node --test server/tests/test_arm_rig.mjs`
Expected: PASS (all cases green, 0 failures).

- [ ] **Step 5: Commit Task 2**

```bash
git add public/js/arm_rig.js server/tests/test_arm_rig.mjs
git commit -m "feat(client): add analytical 2-bone arm IK and finger posing module"
```

---

### Task 3: Wire Skinned Arms & Material Hydration into `public/js/game.js`

**Files:**
- Modify: `public/js/game.js:9-23,561-602,728-747,801-833,1263-1389`
- Test: `server/tests/test_lan_v2.js` (extend HTTP static allowlist test to also verify `/js/arm_rig.js` returns `200`)

**Interfaces:**
- Consumes: `createSkinnedArmsController`, `SKINNED_ARM_POSES` from `/js/arm_rig.js`; `window.FPS_MODELS["fps_arms"]` / `/model/dist/fps_arms.glb`
- Produces: `window.__armsLoaded = true` and skinned FPP arms synchronized with `M416`, `Glock-17`, and `AWM Sniper` inside `gunAnim()`

- [ ] **Step 1: Add failing HTTP static allowlist test for `/js/arm_rig.js` in `server/tests/test_lan_v2.js`**

Extend the HTTP static test in `server/tests/test_lan_v2.js` to fetch `/js/arm_rig.js` (`200 OK`, `application/javascript`) and `/model/dist/fps_arms.bundle.js` (`200 OK`, non-empty).

- [ ] **Step 2: Run Node test to verify it fails or confirm baseline**

Run: `node --test server/tests/test_lan_v2.js`
Expected: Verify current state (all existing 5 tests pass; new `/js/arm_rig.js` check passes once wired or fails if checked before `arm_rig.js` exists — run before creating if reordering, or check after updating `test_lan_v2.js` + `game.js`).

- [ ] **Step 3: Update `public/js/game.js`**

1. Import `{ createSkinnedArmsController, SKINNED_ARM_POSES } from "/js/arm_rig.js";` at top of `public/js/game.js`.
2. In `hydratePbrMaterial(src, objName, envScale)` (`game.js:561-602`):
   - Detect skinned arm material (`src.name === "material"` or `objName.includes("armmesh")`) as `isArmsSkinGlove`.
   - Copy `aoMap: src.aoMap || null` and `aoMapIntensity: src.aoMapIntensity ?? 0.45`.
   - Set `envMapIntensity: isArmsSkinGlove ? 0.62 : ...`, `clearcoat: phys.clearcoat || 0`, `sheen: phys.sheenColor !== undefined ? new THREE.Color(phys.sheenColor) : undefined`.
3. Replace procedural node globals (`leftHand`, `rightHand`, `leftArmRig`, `rightArmRig`, `leftForearmMesh`, `rightForearmMesh`, `leftWatch`, `indexJoint`, `aimForearm()`) with `let armsCtrl = null;` and `let armsRoot = null;` while keeping `POSE` / `PISTOL_POSE` / `sampleLeftTrack()` wrist targets (synchronized with `SKINNED_ARM_POSES` for M416 mag-pull tracking `mag.position.add(pose.p).sub(POSE.mag.p)`!).
4. In `loadModelAsset("fps_arms", "/model/dist/fps_arms.glb", (gltf) => ...)` (`game.js:801-833`):
   - Traverse `root`: `obj.layers.set(VIEW_LAYER)`, if `obj.isMesh` set `castShadow = receiveShadow = true`, `if (obj.isSkinnedMesh) obj.frustumCulled = false`, and hydrate materials once per material UUID.
   - Instantiate `armsCtrl = createSkinnedArmsController(root, THREE);` and `armsRoot = root;`.
   - `gun.add(root);`, run `gunAnim(0, 0);`, set `window.__armsLoaded = true;`.
5. In `gunAnim(dt, mv)` (`game.js:1263-1389`):
   - Compute `pose = sampleLeftTrack(rl, activePoseSet, Boolean(st.isTactical))` and `rightWristPose = activePoseSet.rightGrip`.
   - Call `if (armsCtrl) armsCtrl.update({ weaponId: cfg.id, leftWristPos: pose.p, leftWristQuat: pose.q, rightWristPos: rightWristPose.p, rightWristQuat: rightWristPose.q, triggerPull: isPistol ? pistolTrigPull : trigPull, reloadProgress: rl, isTactical: Boolean(st.isTactical), isSprinting, ads, chPullWeight: chW, magDropWeight: dropW, hideArms: scopedSniper });`.
   - Update `gun.position` / `gun.rotation` cleanly so shoulders/cuffs never enter `cam.near = 0.03` during ADS.

- [ ] **Step 4: Run all automated checks (Node + Python)**

Run:
`node --test server/tests/test_lan_v2.js server/tests/test_arm_rig.mjs`
`uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m unittest model.tests.test_arms_model model.tests.test_m416_model model.tests.test_soldier_model -v`
Expected: All Node tests PASS, all Python tests PASS (zero regressions).

- [ ] **Step 5: Browser Visual Calibration & Verification (Playwright or Chrome DevTools)**

- Restart `node server/index.js` and inspect `http://localhost:8090/FPS.html` in browser (`window.__armsLoaded === true`, `0` console/pageerror, `0` HTTP 404s).
- Capture/verify hipfire, ADS, reload (mag out + charging handle pull), and firing trigger pull on **M416**, **Glock-17**, and **AWM Sniper**; tune `SKINNED_ARM_POSES` shoulder/wrist/finger offsets in `public/js/arm_rig.js` if any mesh clips receiver/camera.

- [ ] **Step 6: Commit Task 3**

```bash
git add public/js/game.js server/tests/test_lan_v2.js
git commit -m "feat(client): integrate skinned fps_arms rig and 2-bone IK into game engine"
```

---

### Task 4: Documentation, Attribution & Context Handover

**Files:**
- Modify: `model/README.md`
- Modify: `README.md`
- Modify: `agents/context.md`

- [ ] **Step 1: Update `model/README.md` and `README.md`**

- Document the `fps_arms.glb` conversion pipeline (`KHR_materials_pbrSpecularGlossiness` → `pbrMetallicRoughness` + `arms_root` `scale=0.01`, `rotY=π`), the new `public/js/arm_rig.js` 2-bone IK solver, and CC-BY-4.0 attribution (`DJMaesen`, `https://sketchfab.com/3d-models/fps-arms-08ec4403a47645d8ad80633abf13d39d`).

- [ ] **Step 2: Run final security & verification grep + test suite**

Run:
- Security check: verify zero `innerHTML`, `dangerouslySetInnerHTML`, `eval`, `document.write` added in `public/js/arm_rig.js` and `public/js/game.js`.
- Run `node --test server/tests/test_lan_v2.js server/tests/test_arm_rig.mjs` and Python unit tests after final edits.

- [ ] **Step 3: Update `agents/context.md` & Commit Task 4**

Update `agents/context.md` Section 1, Section 2, Section 3, and Section 4 with the completed integration, verification numbers, and any follow-up notes.

```bash
git add model/README.md README.md agents/context.md
git commit -m "docs: document skinned fps_arms pipeline, 2-bone IK, and CC-BY-4.0 attribution"
```
