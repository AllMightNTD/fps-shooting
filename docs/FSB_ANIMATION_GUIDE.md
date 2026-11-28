# Hướng dẫn Rig & Tích hợp 6 Cử chỉ (`idle`, `run`, `crouch`, `jump`, `prone`, `prone_move`) cho Đặc nhiệm FSB / SWAT

Tài liệu này mô tả pipeline đưa nhân vật đặc nhiệm 3D **FSB / SWAT** (`fsbfor_games.glb`) vào game **BEFORE THE BREACH** với đầy đủ **6 cử chỉ**: **đứng (`idle`), chạy (`run`), ngồi (`crouch`), nhảy (`jump`), nằm (`prone`) và bò (`prone_move`)**.

---

## Trạng thái hiện tại (Đã hoàn tất 100%)

- **Pha 1 — Tiền xử lý lưới & PBR:** `model/assets/fsb_ready_for_rig.fbx` (`3.49 MB`, `18,000` tris, cao `1.76 m`, 1 `UVMap`) và bộ 3 texture `1024×1024` tại `model/assets/fsb_textures/`.
- **Pha 2 — Đóng gói 6 clip Mixamo bằng Blender 5.3 (`scripts/blender/build_fsb_anims.py`):** Đã gộp 6 file trong `model/assets/fsb_anims/` (`idle.fbx`, `run.fbx`, `crouch.fbx`, `jump.fbx`, `prone.fbx`, `prone_move.fbx` — cùng bộ xương `41` joints) và xuất thành công:
  - `model/dist/soldier.glb` (`5.10 MB`, `1` skin / `41` joints, `6` NLA clips, texture PBR `1024×1024`, `weapon_mount` căn hướng `-Z`, băng đội `TeamColor` gắn mũ + 2 bắp tay, tắt Draco).
  - `model/dist/soldier.bundle.js` & gói tĩnh `dist-static/` (`75` file, `22.51 MB`).
- **Pha 3 — Gameplay & Frontend Three.js r128:** Đã tích hợp phím **`Z`** bật/tắt nằm & bò (`FLAG.PRONE`, camera `0.42 m`, tốc độ bò `0.30×`, giảm tán xạ `0.50×`, giảm giật M416 `0.65×`, giảm rung ngắm AWM `0.25×`, hitbox & LoS nằm phía Server, và `THREE.AnimationMixer` 6 trạng thái trong `public/js/skinned_clone.js` & `public/js/remote_players.js`).

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

## Bước 2.2 — Bộ 6 file chuyển động trong `model/assets/fsb_anims/`

Tải các animation trên Mixamo với thiết lập:
- **Format:** `FBX Binary (.fbx)`
- **Frames per Second:** `30`
- **Keyframe Reduction:** `none`

Lưu vào thư mục **`model/assets/fsb_anims/`**:

| Tên file | Từ khóa tìm trên Mixamo | Skin | Lưu ý quan trọng |
| --- | --- | --- | --- |
| `idle.fbx` | `Rifle Idle` | **With Skin** | File này kiêm luôn bản gốc có lưới + xương (`base rigged`). |
| `run.fbx` | `Rifle Run` | **Without Skin** | Nên tick ô **In Place** *(script cũng tự khóa In-Place)*. |
| `crouch.fbx` | `Crouch Idle` hoặc `Crouching Idle` | **Without Skin** | Giữ dáng ngồi cầm súng trường. |
| `jump.fbx` | `Jump` hoặc `Rifle Jump` | **Without Skin** | Script tự cắt gọn thời lượng ≤ `0.72s` khớp trọng lực game. |
| `prone.fbx` | `Prone Idle` / `Rifle Prone` | **Without Skin** | Tư thế nằm yên ngắm bắn (`Y ≈ 0.48 m`). |
| `prone_move.fbx` | `Prone Forward` / `Crawl` | **Without Skin** | Tư thế bò trườn; script triệt tiêu trôi tịnh tiến mà giữ dao động tự nhiên. |

> **Ghi chú:** Script `build_fsb_anims.py` tự nhận diện cả tên gốc của Mixamo hoặc định dạng `.glb`, ưu tiên khớp chính xác tên để tránh nhầm `prone` với `prone_move`.

---

## Bước 2.3 — Chạy lệnh Blender Python gộp 6 NLA Track & xuất vào game

Mở **PowerShell** tại thư mục gốc dự án và chạy **1 trong 2 lệnh** sau *(tương thích cả Blender 4.2 LTS và Blender 5.3)*:

### Tùy chọn A — Mức Cân bằng (Khuyên dùng, texture `1024×1024`, ~`5.1 MB`)
```powershell
& "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python scripts/blender/build_fsb_anims.py -- --tex-size 1024
```

### Tùy chọn B — Mức Siêu nhẹ cho máy yếu / mạng chậm (texture `512×512`)
```powershell
& "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python scripts/blender/build_fsb_anims.py -- --tex-size 512
```

**Script tự động thực hiện toàn bộ:**
- Chuẩn hóa chiều cao nhân vật về `1.76 m`, chân tại `Y = 0`, hướng mặt về `-Z` (khớp trục Three.js & nòng súng).
- Khóa **In-Place** trên xương `Hips`, lặp kín vòng cho `idle`/`run`/`crouch`/`prone`/`prone_move`, cắt gọn `jump`.
- Khôi phục đủ 3 texture PBR (`BaseColor`, `MetallicRoughness`, `Normal`) từ `model/assets/fsb_textures/`.
- Gắn socket `weapon_mount` vào xương bàn tay phải (`mixamorig:RightHand`, căn góc thẳng hướng `-Z`) và gắn dải nhận diện phe `TeamColor` ôm sát đỉnh mũ + giữa 2 bắp tay.
- Đẩy đủ 6 clip (`idle`, `run`, `crouch`, `jump`, `prone`, `prone_move`) vào 6 NLA Track (hỗ trợ cả Slotted Actions của Blender 5.x), xuất ra:
  - `model/dist/soldier.glb` *(tắt Draco để tương thích trực tiếp `GLTFLoader` Three.js r128)*
  - `model/dist/soldier.bundle.js`

---

## Bước 2.4 — Kiểm tra & Chạy game

1. **Kiểm tra dòng log xác minh** cuối lệnh ở Bước 2.3:
   ```text
   === EXPORTED SOLDIER GLB VERIFICATION ===
   GLB size         : 5,345,888 B (5.10 MB)
   Extensions req   : []
   Skins / Joints   : 1 skins, 41 joints
   Animation clips  : ['idle', 'run', 'crouch', 'jump', 'prone', 'prone_move']
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
