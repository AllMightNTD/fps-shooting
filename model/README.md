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
│   └── m416.py             # Dựng chi tiết HK416/M416 (SOPMOD stock, EOTech vát, Quad-Rail, băng đạn cong, PEQ-15)
├── characters/
│   ├── __init__.py
│   ├── fps_arms.py         # Dựng bộ tay nhân vật FPP có rig (cẳng tay spline, tay áo camo, găng hở ngón, đồng hồ, ngón trỏ)
│   └── soldier.py          # Dựng chiến binh toàn thân PBR có rig (mũ giáp + visor hitbox headshot, vest, weapon_mount, chân)
├── tests/
│   ├── __init__.py
│   ├── test_m416_model.py     # Unit test chuẩn AAA cho geometry, PBR M416 & GLB exporter (Happy & Unhappy paths)
│   ├── test_arms_model.py     # Unit test chuẩn AAA cho capsule, torus, spline tube, skin/glove PBR & rigged fps_arms.glb
│   └── test_soldier_model.py  # Unit test chuẩn AAA cho texture quân phục BDU/Kevlar & rigged soldier.glb
└── dist/
    ├── m416.glb            # Asset nhị phân glTF 2.0 chuẩn PBR cho súng M416
    ├── m416.bundle.js      # Gói Base64 JS cho M416 chạy không lỗi CORS trên file://
    ├── fps_arms.glb        # Asset nhị phân glTF 2.0 chuẩn PBR cho tay nhân vật FPP có rig
    ├── fps_arms.bundle.js  # Gói Base64 JS cho fps_arms chạy không lỗi CORS trên file://
    ├── soldier.glb         # Asset nhị phân glTF 2.0 chuẩn PBR cho chiến binh 3rd-person trên LAN
    └── soldier.bundle.js   # Gói Base64 JS cho soldier chạy không lỗi CORS trên file://
```

## Lệnh build & kiểm thử

Chạy từ thư mục gốc dự án (`/home/dev_ntd/Documents/FPS`):

```bash
# Sinh toàn bộ .glb và .bundle.js (m416 + fps_arms + soldier) trong model/dist/
python3 -m model.build

# Tùy chọn kích thước texture & thư mục đích
python3 -m model.build --tex-size 512 --seed 42 --out model/dist

# Chạy toàn bộ bộ kiểm thử đơn vị AAA (16 test cases)
python3 -m unittest discover -s model/tests -v
```

## Quy ước hệ trục & node động cho `public/FPS.html` (`public/js/game.js`)

- **Hệ trục tọa độ:** Right-handed Y-up chuẩn Three.js / glTF 2.0 (`+Y` hướng lên, `+X` sang phải, **`-Z` hướng về phía đầu nòng**).
- **M416 (`m416.glb`)**:
  - Toàn bộ bộ phận tĩnh được gộp theo vật liệu (`m416_static_gunmetal`, `m416_static_steel`, `m416_static_polymer`, `m416_static_fde`, `m416_static_dark`).
  - Các node động giữ tên riêng: `mag_group`, `trigger_group`, `charging_handle`, `bolt_vis`, `holo_lens`, `reticle_group`, `laser_lens`, `laser_origin`, `muzzle_anchor`.
- **Tay nhân vật FPP (`fps_arms.glb`)**:
  - Metadata `FPS_ARMS_METADATA` lưu trong `arms_root.userData` (`leftElbow`, `rightElbow`, `leftWristLocal`, `rightWristLocal`, `poses`, `indexBaseRotX`) để đồng bộ tư thế cầm, nạp đạn, kéo khóa nòng và góc xoay cò.
  - Các node động giữ tên riêng: `left_hand_group` (C-clamp grip + ngón tay), `left_arm_rig` (`left_arm_rig_forearm`, `left_arm_rig_sleeve`, `left_watch` gồm `watch_case`/`watch_dial`), `right_hand_group`, `right_index_joint_0` (ngón trỏ co duỗi khi bắn), `right_arm_rig` (`right_arm_rig_forearm`, `right_arm_rig_sleeve`).
- **Chiến binh 3rd-person (`soldier.glb`)**:
  - Metadata `SOLDIER_METADATA` trong `soldier_root.userData` (`height`, `bodyRadius`, `headCenterY=1.63`, `headRadius=0.145`, `weaponMountLocal`) đồng bộ hitbox với server LAN.
  - Các node động giữ tên riêng: `upper_body` (nghiêng theo `pitch`), `head_group` (hitbox Headshot gồm mũ giáp + visor + `head_team_iff`), `arms_group`, `weapon_mount` (gắn bản sao `m416.glb`), `leg_left` / `leg_right` (diễn hoạt sải chân khi chạy), và các mảng áo/mũ/vai đổi màu theo phe gắn vật liệu `TeamColor` (`head_team_iff`, `arms_team_patch`, `torso_team_strip`).

## Cách thêm model mới

1. Tạo module mới trong `model/weapons/<ten_model>.py` dùng các hàm dựng hình trong `model/core/geometry.py` và vật liệu từ `GLBMaterial`.
2. Gộp các mesh tĩnh theo vật liệu và giữ riêng các node cần animate làm `GLBNode` có tên rõ ràng.
3. Đăng ký build thêm artifact vào `build_all()` trong `model/build.py` và viết test xác minh vào `model/tests/`.

