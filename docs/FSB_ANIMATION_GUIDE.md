# Hướng dẫn Bước 2: Rig & Tích hợp 4 Cử chỉ (`idle`, `run`, `crouch`, `jump`) cho Đặc nhiệm FSB

Tài liệu này lưu lại các bước còn lại để bạn có thể thực hiện bất cứ lúc nào sau này nhằm đưa nhân vật đặc nhiệm 3D **FSB** (`fsbfor_games.glb`) vào game **BEFORE THE BREACH** với đầy đủ 4 cử chỉ **đứng, chạy, ngồi, nhảy**.

---

## Trạng thái đã chuẩn bị sẵn

Mọi công việc tiền xử lý (Pha 1) và nâng cấp Engine game (Pha 3) đã hoàn tất:

- **File nhẹ sẵn sàng upload Auto-Rig:** `model/assets/fsb_ready_for_rig.fbx` (`3.49 MB`, đã giảm từ `500,000` → `18,000` tris, cao chuẩn `1.76 m`, chân chạm `Y = 0`, 1 `UVMap`).
- **Bộ 3 texture PBR chuẩn `1024×1024`:** `model/assets/fsb_textures/` (`fsb_basecolor.png`, `fsb_mr.png`, `fsb_normal.png`) — sẽ được tự động gắn lại ở Bước 2.3 kể cả khi Mixamo làm mất Normal/Roughness.
- **Script Blender gộp animation:** `scripts/blender/build_fsb_anims.py` (đã test pass trên Blender 4.2.22 LTS).
- **Frontend Three.js r128:** `public/js/skinned_clone.js`, `public/js/asset_loader.js`, `public/js/remote_players.js` đã sẵn sàng nhận `SkinnedMesh` + `THREE.AnimationMixer` + hitbox Head/Body/Limb bám xương + màu đội `TeamColor`.

---

## Bước 2.1 — Auto-Rig trên Mixamo (hoặc AccuRIG)

1. Truy cập **Mixamo**: https://www.mixamo.com (đăng nhập tài khoản Adobe miễn phí).
   *(Hoặc dùng phần mềm **AccuRIG** trên Windows nếu muốn tinh chỉnh khớp thủ công chi tiết hơn.)*
2. Bấm **Upload Character** và chọn file:
   ```text
   G:\fps-shooting\model\assets\fsb_ready_for_rig.fbx
   ```
3. Ở màn hình **Auto-Rigger**, đặt các chấm khớp (`Chin`, `Wrists`, `Elbows`, `Knees`, `Groin`):
   > **Mẹo quan trọng:** Hai cánh tay của model FSB hơi xuôi gần hông, hãy đặt chấm `Wrists` (cổ tay) và `Elbows` (khuỷu tay) thật gọn đúng tâm cánh tay để tránh dính skin weight vào vùng sườn/nách.
4. Chọn **Skeleton LOD: Standard Skeleton (65)** (hoặc mặc định) và bấm **Next** để hoàn tất gắn xương.

---

## Bước 2.2 — Tải 4 file chuyển động vào `model/assets/fsb_anims/`

Tìm và tải 4 animation trên Mixamo với thiết lập:
- **Format:** `FBX Binary (.fbx)`
- **Frames per Second:** `30`
- **Keyframe Reduction:** `none`

Lưu 4 file tải về vào thư mục **`G:\fps-shooting\model\assets\fsb_anims\`** theo bảng sau:

| Tên file đề xuất | Từ khóa tìm trên Mixamo | Skin | Lưu ý quan trọng |
| --- | --- | --- | --- |
| `idle.fbx` | `Rifle Idle` | **With Skin** | File này kiêm luôn bản gốc có lưới + xương (`base rigged`). |
| `run.fbx` | `Rifle Run` | **Without Skin** | Nên tick ô **In Place** *(script cũng sẽ tự khóa In-Place nếu quên)*. |
| `crouch.fbx` | `Crouch Idle` hoặc `Crouching Idle` | **Without Skin** | Giữ dáng ngồi cầm súng trường. |
| `jump.fbx` | `Jump` hoặc `Rifle Jump` | **Without Skin** | Script sẽ tự cắt gọn thời lượng ≤ `0.72s` khớp trọng lực game. |

> **Ghi chú:** Script `build_fsb_anims.py` tự nhận diện cả tên gốc của Mixamo (ví dụ `Rifle Idle.fbx`, `Rifle Run.fbx`, `Crouch Idle.fbx`, `Jump.fbx`) hoặc định dạng `.glb`, nhưng đặt gọn đúng `idle.fbx`, `run.fbx`, `crouch.fbx`, `jump.fbx` là sạch và dễ quản lý nhất.

---

## Bước 2.3 — Chạy lệnh Blender Python gộp 4 NLA Track & xuất vào game

Mở **PowerShell** tại thư mục gốc dự án `G:\fps-shooting` và chạy **1 trong 2 lệnh** sau:

### Tùy chọn A — Mức Cân bằng (Khuyên dùng, texture `1024×1024`, ~`3.5–4 MB`)
```powershell
& "C:\Program Files\Blender Foundation\Blender 4.2\blender.exe" --background --python scripts/blender/build_fsb_anims.py -- --tex-size 1024
```

### Tùy chọn B — Mức Siêu nhẹ cho máy yếu / mạng chậm (texture `512×512`, ~`1.1 MB`)
```powershell
& "C:\Program Files\Blender Foundation\Blender 4.2\blender.exe" --background --python scripts/blender/build_fsb_anims.py -- --tex-size 512
```

**Script sẽ tự động làm toàn bộ:**
- Chuẩn hóa chiều cao nhân vật về `1.76 m`, chân tại `Y = 0`, hướng mặt về `-Z` (khớp trục Three.js & nòng súng).
- Khóa **In-Place** trên xương `Hips` (triệt tiêu trôi X/Z, giữ nhún Y), lặp kín vòng cho `idle`/`run`/`crouch`, cắt gọn `jump`.
- Khôi phục đủ 3 texture PBR (`BaseColor`, `MetallicRoughness`, `Normal`) từ `model/assets/fsb_textures/`.
- Gắn socket `weapon_mount` vào xương bàn tay phải (`mixamorig:RightHand`) và gắn dải nhận diện phe `TeamColor` lên mũ + 2 tay áo.
- Đẩy đủ 4 clip (`idle`, `run`, `crouch`, `jump`) vào 4 NLA Track, xuất thẳng ra:
  - `model/dist/soldier.glb` *(tắt Draco để tương thích trực tiếp `GLTFLoader` Three.js r128)*
  - `model/dist/soldier.bundle.js`

---

## Bước 2.4 — Kiểm tra & Chạy game

1. **Kiểm tra dòng log xác minh** cuối lệnh ở Bước 2.3 phải hiển thị tương tự:
   ```text
   === EXPORTED SOLDIER GLB VERIFICATION ===
   Extensions req   : []
   Skins / Joints   : 1 skins, ... joints
   Animation clips  : ['idle', 'run', 'crouch', 'jump']
   Has weapon_mount : True
   Materials        : ['FSB_Operator_PBR', 'TeamColor']
   ```
2. **Đóng gói lại `dist-static/`** *(chỉ cần nếu bạn deploy online lên Cloudflare Pages)*:
   ```powershell
   & "C:\Program Files\nodejs\node.exe" scripts/build_static.mjs
   ```
3. **Chạy lại bộ test Node.js** để chắc chắn không lỗi hồi quy:
   ```powershell
   $tests = Get-ChildItem server\tests -File | Where-Object { $_.Name -match '^test_.*\.(js|mjs)$' } | ForEach-Object { $_.FullName }
   & "C:\Program Files\nodejs\node.exe" --test $tests
   ```
4. **Mở game và kiểm thử thực tế:**
   - Khởi động server (nếu chưa chạy):
     ```powershell
     & "C:\Program Files\nodejs\node.exe" server/index.js
     ```
   - Mở 2 tab trình duyệt tới `http://localhost:8090/FPS.html` (nhấn `Ctrl + F5` để xóa cache model cũ), tạo 1 phòng LAN và cho 2 tab vào cùng trận để nhìn nhân vật FSB đứng, chạy, ngồi (`C`/`Ctrl`), nhảy (`Space`), cầm súng và kiểm tra bắn Headshot.

---

## Mẹo xử lý sự cố (nếu cần tinh chỉnh sau khi xem trong game)

- **Nếu khẩu súng trên tay phải bị lệch góc hoặc vị trí:**
  Chỉnh `mount.location` / `mount.rotation_euler` trong `scripts/blender/build_fsb_anims.py` (hàm `_attach_socket_and_team_patches`) rồi chạy lại lệnh Bước 2.3.
- **Nếu muốn giảm lưới nhẹ hơn nữa (ví dụ `12,000` tris trước khi lên Mixamo):**
  Chạy lại Pha 1 với `--target-tris 12000`:
  ```powershell
  & "C:\Program Files\Blender Foundation\Blender 4.2\blender.exe" --background --python scripts/blender/prep_fsb_for_rig.py -- --target-tris 12000 --tex-size 1024
  ```
- **Ghi công bản quyền (`CC-BY-4.0`):**
  Model gốc *"FSB(For games)"* của tác giả **Quantek Studio** (https://sketchfab.com/QuantekStudio), nguồn: https://sketchfab.com/3d-models/fsbfor-games-d8e7465fd9cd4a22a9badebfdf8e0775.
