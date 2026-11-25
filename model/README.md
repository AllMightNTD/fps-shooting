# `model/` — Procedural 3D PBR Asset Pipeline (Python)

Thư mục này chứa bộ mã nguồn **Python thuần + NumPy + Pillow** dùng để dựng mô hình 3D chuẩn PBR (Metallic-Roughness + Normal Map giọt nước mưa + metadata `clearcoat` / `transmission`), xuất ra file nhị phân **glTF 2.0 (`.glb`)** và gói JS Base64 (`.bundle.js`) phục vụ cho [public/FPS.html](../public/FPS.html).

## Cấu trúc thư mục

```text
model/
├── __init__.py
├── build.py                # CLI sinh .glb và .bundle.js vào model/dist/
├── requirements.txt        # Phụ thuộc Python (numpy, Pillow)
├── README.md               # Tài liệu thư mục model
├── core/
│   ├── __init__.py
│   ├── geometry.py         # MeshData, beveled box, extrude 2D polygon, lathe, capsule, torus, spline tube, merge_meshes
│   ├── textures.py         # Texture giọt nước kim loại, da ướt mưa, vải găng/camo/đồng hồ và quân phục BDU/Kevlar chiến binh
│   └── glb_exporter.py     # Đóng gói glTF 2.0 binary (.glb, hỗ trợ clearcoat/transmission/sheen) và export_js_bundle()
├── weapons/
│   ├── __init__.py
│   ├── m416.py             # Dựng chi tiết HK416/M416 (SOPMOD stock, EOTech vát, Quad-Rail, băng đạn cong, PEQ-15)
│   └── pistol.py           # Dựng Glock-17 Tactical Gen4/Gen5 (slide, barrel, frame stippling, trigger, mag, Tritium)
├── assets/
│   └── fps_arms.glb        # Model nguồn SkinnedMesh tay chiến thuật 47 xương (DJMaesen, CC-BY-4.0)
├── characters/
│   ├── __init__.py
│   ├── fps_arms.py         # Chuyển đổi fps_arms.glb (Spec-Gloss -> Metallic-Roughness, resize, bọc arms_root cm->m)
│   └── soldier.py          # Dựng chiến binh toàn thân PBR có rig (mũ giáp + visor hitbox headshot, vest, weapon_mount, chân)
├── tests/
│   ├── __init__.py
│   ├── test_m416_model.py     # Unit test chuẩn AAA cho geometry, PBR M416 & GLB exporter (Happy & Unhappy paths)
│   ├── test_pistol_model.py   # Unit test chuẩn AAA cho geometry, textures PBR & GLB Glock-17
│   ├── test_arms_model.py     # Unit test chuẩn AAA cho chuyển đổi Spec-Gloss -> PBR, bufferView & skinned fps_arms.glb
│   └── test_soldier_model.py  # Unit test chuẩn AAA cho texture quân phục BDU/Kevlar & rigged soldier.glb
└── dist/
    ├── m416.glb            # Asset nhị phân glTF 2.0 chuẩn PBR cho súng M416
    ├── m416.bundle.js      # Gói Base64 JS cho M416 chạy không lỗi CORS trên file://
    ├── pistol.glb          # Asset nhị phân glTF 2.0 chuẩn PBR cho súng lục Glock-17
    ├── pistol.bundle.js    # Gói Base64 JS cho Glock-17 chạy không lỗi CORS trên file://
    ├── fps_arms.glb        # Asset nhị phân glTF 2.0 chuẩn PBR (đã chuẩn hóa arms_root) cho tay nhân vật FPP
    ├── fps_arms.bundle.js  # Gói Base64 JS cho fps_arms chạy không lỗi CORS trên file://
    ├── soldier.glb         # Asset nhị phân glTF 2.0 chuẩn PBR cho chiến binh 3rd-person trên LAN
    └── soldier.bundle.js   # Gói Base64 JS cho soldier chạy không lỗi CORS trên file://
```

## Lệnh build & kiểm thử

Chạy từ thư mục gốc dự án:

```bash
# Sinh toàn bộ .glb và .bundle.js (m416 + pistol + fps_arms + soldier) trong model/dist/
python3 -m model.build

# Tùy chọn kích thước texture & thư mục đích (fps_arms tự đọc fps_arms.glb ở root nếu có, fallback về model/assets/fps_arms.glb)
python3 -m model.build --tex-size 512 --seed 42 --out model/dist

# Trên Windows (dùng uv)
uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m model.build

# Chạy bộ kiểm thử đơn vị AAA (23 test cases; hiện 22 PASS, 1 ERROR có sẵn tại test_pistol_model.py:56)
uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m unittest discover -s model/tests -v
```

> Lưu ý: `build_fps_arms_glb(texture_size=512, source_path=None)` ưu tiên đọc `fps_arms.glb` ở thư mục gốc nếu tồn tại, ngược lại dùng bản tracked `model/assets/fps_arms.glb`, xuất ra `model/dist/fps_arms.glb` (`1,082,400 B`, ~1.08 MB) và `model/dist/fps_arms.bundle.js` (`1,443,464 B`).

## Quy ước hệ trục & node động cho `public/FPS.html` (`public/js/game.js`)

- **Hệ trục tọa độ:** Right-handed Y-up chuẩn Three.js / glTF 2.0 (`+Y` hướng lên, `+X` sang phải, **`-Z` hướng về phía đầu nòng**).
- **M416 (`m416.glb`)**:
  - Toàn bộ bộ phận tĩnh được gộp theo vật liệu (`m416_static_gunmetal`, `m416_static_steel`, `m416_static_polymer`, `m416_static_fde`, `m416_static_dark`).
  - Các node động giữ tên riêng: `mag_group`, `trigger_group`, `charging_handle`, `bolt_vis`, `holo_lens`, `reticle_group`, `laser_lens`, `laser_origin`, `muzzle_anchor`.
- **Tay nhân vật FPP (`fps_arms.glb`)**:
  - Được chuyển đổi bởi `model/characters/fps_arms.py` (`build_fps_arms_glb`): gỡ extension `KHR_materials_pbrSpecularGlossiness` khỏi `extensionsUsed`/`extensionsRequired` và material; chuyển 4 ảnh nguồn `2048×2048` về `texture_size` (`512×512`) và chuyển map specular-glossiness thành `metallicRoughnessTexture` chuẩn glTF 2.0 (`pbrMetallicRoughness`, kèm `occlusionTexture` `strength=0.41` và `extras.pbrPhysical`: `clearcoat=0.16`, `clearcoatRoughness=0.36`, `sheenColor=0x8A9280`, `sheenRoughness=0.72`).
  - Node gốc `arms_root` bọc toàn bộ scene gốc với `scale = [0.01, 0.01, 0.01]` (cm → m) và `rotation = [0.0, 1.0, 0.0, 0.0]` (`rotY = π`, quay hướng `+Z` về `-Z`), gắn `extras = FPS_ARMS_METADATA` (`character: "FPS_Arms_Tactical"`, `rigType: "skinned"`, `upperLen: 0.2587`, `forearmLen: 0.2543`, `bones`).
  - Gồm `1` `SkinnedMesh` (`armmesh_Mat_0`, `4,026` đỉnh, `7,028` tam giác) và `47` joints dưới `_rootJoint`:
    - **Tay trái (2-bone IK + ngón):** `L_arm_01`, `L_elbow_02`, `L_wrist_03`, cùng 20 xương ngón (`L_thumb1_04..L_thumb4_07`, `L_point1_08..L_point4_011`, `L_middle1_012..L_middle4_014`, `L_ring1_015..L_ring4_018`, `L_pink1_019..L_pink4_022`).
    - **Tay phải (2-bone IK + ngón & bóp cò):** `R_arm_023`, `R_elbow_024`, `R_wrist_025`, xương ngón trỏ bóp cò `R_point1_030`, `R_point2_031`, `R_point3_032` (`R_point4_033` ở đầu ngón), cùng các xương ngón `R_thumb1..4`, `R_middle1..4`, `R_ring1..4`, `R_pink1..4`.
  - Ở client, `public/js/arm_rig.js` (`createSkinnedArmsController(root, THREE)`) tắt `frustumCulled` trên `SkinnedMesh`, giải IK 2 xương giải tích (`solveTwoBoneArmIK`) theo các pose `SKINNED_ARM_POSES` (`m416`, `pistol`, `sniper`) và gập ngón tay theo `triggerPull` / tiến độ nạp đạn.

### Ghi công (Attribution)

- **Model gốc:** `"fps arms"` của tác giả **DJMaesen**
- **Giấy phép:** **CC-BY-4.0** (<http://creativecommons.org/licenses/by/4.0/>)
- **Nguồn:** <https://sketchfab.com/3d-models/fps-arms-08ec4403a47645d8ad80633abf13d39d>
- **Chỉnh sửa (Modified):** Đã chuyển đổi vật liệu từ `KHR_materials_pbrSpecularGlossiness` sang glTF 2.0 `pbrMetallicRoughness`, giảm kích thước texture từ `2048×2048` xuống `512×512` (mặc định), và bọc node chuẩn hóa `arms_root` (`scale=0.01`, `rotY=π`, `extras=FPS_ARMS_METADATA`) để phù hợp với hệ tọa độ viewmodel Three.js.
- **Chiến binh 3rd-person (`soldier.glb`)**:
  - Metadata `SOLDIER_METADATA` trong `soldier_root.userData` (`height`, `bodyRadius`, `headCenterY=1.63`, `headRadius=0.145`, `weaponMountLocal`) đồng bộ hitbox với server LAN.
  - Các node động giữ tên riêng: `upper_body` (nghiêng theo `pitch`), `head_group` (hitbox Headshot gồm mũ giáp + visor + `head_team_iff`), `arms_group`, `weapon_mount` (gắn bản sao `m416.glb`), `leg_left` / `leg_right` (diễn hoạt sải chân khi chạy), và các mảng áo/mũ/vai đổi màu theo phe gắn vật liệu `TeamColor` (`head_team_iff`, `arms_team_patch`, `torso_team_strip`).

## Cách thêm model mới

1. Tạo module mới trong `model/weapons/<ten_model>.py` dùng các hàm dựng hình trong `model/core/geometry.py` và vật liệu từ `GLBMaterial`.
2. Gộp các mesh tĩnh theo vật liệu và giữ riêng các node cần animate làm `GLBNode` có tên rõ ràng.
3. Đăng ký build thêm artifact vào `build_all()` trong `model/build.py` và viết test xác minh vào `model/tests/`.

