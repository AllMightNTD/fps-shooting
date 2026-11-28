# BEFORE THE BREACH – Web FPS (Three.js)

Trò chơi bắn súng góc nhìn thứ nhất (FPS) trên nền WebGL sử dụng Three.js r128, lấy bối cảnh bến cảng đêm mưa với các container hàng hóa, thời tiết sấm chớp, âm thanh tổng hợp Web Audio API, bộ viewmodel M416 + tay FPP chuẩn PBR, hệ thống **đa vũ khí nạp đạn băng vô hạn** (`M416`, `Glock-17`, `AWM Sniper`), **kiến trúc Input 3 lớp & vật lý 60 Hz**, và chế độ **đấu người với người qua mạng LAN phong cách Truy Kích** (Sảnh chờ → Phòng chờ → Đếm ngược → Trong trận → Tổng kết) cùng mục **Luyện tập Offline (Drone)**.

## Cấu trúc thư mục

```text
.
├── server/                 # Máy chủ PvP Mạng LAN Node.js 22+ thuần (0 thư viện ngoài)
│   ├── package.json        # Đánh dấu ES Module cục bộ cho server/
│   ├── index.js            # HTTP static allowlist (/js/weapons.js, /js/protocol.js, ...) + WebSocket /ws (0.0.0.0:8090)
│   ├── weapons.js          # Nguồn cấu hình vũ khí, falloff cự ly, moveSpeedMult, equipTimeMs & FLAG dùng chung Client/Server
│   ├── protocol.js         # Hằng số message (reload, switchWeapon, event.reload, ammo, CHEAT_DETECTED...) & sanitizeText
│   ├── ws.js               # RFC 6455 WebSocket codec, heartbeat ping/pong & chống flood 160 msg/s
│   ├── spawn.js            # Sinh map bến cảng tất định (MAP_SEED=11042026), va chạm AABB/OBB & raycastArenaDistance
│   ├── hitreg.js           # Re-export từ public/js/hitreg.js (Hitbox Stand/Crouch/Prone & đạn đạo AWM)
│   ├── spawn_rules.js      # Re-export từ public/js/spawn_rules.js (Spawn Protection, i-frames & Smart Spawn TDM/FFA)
│   ├── lag_comp.js         # Bộ đệm lịch sử tư thế 450ms, chốt spawnEpoch & Lag Compensation Rewind (tối đa 250ms)
│   ├── anti_cheat.js       # Chống cheat 5 lớp (MSG.HIT spoof, origin/wall-peek, silent aim, rapid-fire, speedhack) & auto-kick
│   ├── RoomManager.js      # Session token reconnect 30s (khôi phục cả số đạn từng súng), đo RTT qua WS pong & auto-kick
│   ├── Room.js             # Vòng đời phòng WAITING → STARTING (5s) → PLAYING → ENDING (10s) → WAITING
│   ├── Match.js            # Tick 20Hz: server-authoritative handleFire, equipTime, leaky fire/move budget, i-frames & Spawn Protection
│   ├── modes/
│   │   ├── TDM.js          # Đấu Đội (▲ Đặc Nhiệm #2F80FF vs ● Nổi Loạn #FF4D2E): hồi sinh 3.5s, Dynamic Flip 8s, bảo vệ 3.0s
│   │   └── FFA.js          # Đấu Đơn (màu trung tính #8A8F98): hồi sinh 2.0s Golden-Distance LoS, bảo vệ 2.0s
│   ├── tests/
│   │   ├── test_lan_v2.js           # Bộ kiểm thử Node.js (gồm 6 edge case + reload/switch/TOL/posture hitbox)
│   │   ├── test_spawn_protection.mjs # Unit & integration test Spawn Protection nhấp nháy, i-frames, Smart Spawn & Bot AI
│   │   ├── test_arm_rig.mjs         # Unit test AAA cho IK 2 xương & controller tay SkinnedMesh (m416 + pistol + awm sockets)
│   │   ├── test_military_map.mjs    # Unit & integration test cho Triangle-BVH, thang tháp canh 4m & đồng bộ map Khu Quân Sự Cũ
│   │   ├── test_graphics_quality.mjs # Unit test AAA cho 3 mức đồ họa Thấp/Vừa/Cao & tự động nhận diện máy yếu
│   │   └── test_loading_manager.mjs # Unit test AAA cho yieldToUI, tracker tiến độ, nạp VRAM theo lô & cache chuyển map 0ms
├── shared/
│   └── maps/               # military_layout.json & military_colliders.json dùng chung Client/Server (A:9, B:9, FFA:16 spawns)
├── public/                 # Giao diện & Engine phía Client (ES Modules)
│   ├── FPS.html            # Loading 4 bước, Lobby Luyện tập (Đấu với Máy TDM/FFA & Sinh tồn Drone), HUD bảo vệ hồi sinh & Cài đặt
│   ├── assets/             # Tài nguyên hình ảnh tối ưu (loading_bg.webp ~152KB, thumbnail bản đồ WebP)
│   └── js/
│       ├── net.js          # Tự suy ra ws(s)://${location.host}/ws, tự nối lại & sessionStorage 30s
│       ├── lobby.js        # Sảnh 5 view (Home, Practice Hub, Đấu với Máy, Sinh tồn, LAN), tiền tải & cache map 0ms
│       ├── lobby_utils.js  # Chuẩn hóa cấu hình Bot & lọc chế độ sảnh LAN
│       ├── bot_ai.js       # Bộ máy Đấu với Máy Offline (TDM & FFA, 3 độ khó, SWAT 6 tư thế, M416/Glock-17/AWM)
│       ├── spawn_rules.js  # Luật Spawn Protection (3.0s TDM / 2.0s FFA), i-frames 400ms, nhấp nháy đa tần số & Smart Spawn
│       ├── hitreg.js       # Hitbox đa vùng 3 tư thế & đạn đạo AWM dùng chung Server & Offline Bots
│       ├── room.js         # Phòng chờ 2 cột TDM / FFA, bảng tổng kết LAN & Đấu với Máy
│       ├── settings.js     # Lưu cấu hình chuột, FOV, Hold/Toggle, chất lượng đồ họa, IFF (màu/viền địch) & phím BIND qua localStorage
│       ├── iff_system.js   # Hệ thống IFF Gói A: GLSL đổi màu áo Ally/Enemy, Hero Visibility shader & marker đồng đội thông minh
│       ├── graphics_quality.js # Preset Thấp/Vừa/Cao + detectHardwareTier() tự tối ưu cho máy yếu
│       ├── loading_manager.js  # yieldToUI(), tracker tiến độ 0–100%, nạp VRAM theo lô initTexture, biên dịch shader & guard đổi map 0ms
│       ├── input.js        # Input 3 lớp dùng e.code, Alt+Tab reset(), chặn cuộn trang & click khóa chuột đầu
│       ├── arm_rig.js      # Bộ giải IK 2 xương giải tích, SKINNED_ARM_POSES (M416/Pistol/Sniper+Bolt) & gập ngón bóp cò
│       ├── map_collision.js # Triangle-BVH raycast, trượt tường AABB/OBB, sàn nâng 4m & leo thang tháp canh
│       ├── map_loader.js   # Nạp bất đồng bộ map Khu Quân Sự Cũ (yieldToUI, Sky Dome, vũng nước PBR, InstancedMesh, cây/núi & FogExp2)
│       └── game.js         # Engine Three.js r128 hỗ trợ LAN PvP, Đấu với Máy (TDM/FFA), Sinh tồn Drone, Death Cam & VFX nhấp nháy bảo vệ
├── FPS.html                # Trang chuyển hướng trỏ về public/FPS.html
├── GEMINI.md               # Quy chuẩn kỹ thuật và quy trình làm việc của dự án
├── README.md               # Tài liệu hướng dẫn dự án
├── agents/
│   └── context.md          # Bộ nhớ ngữ cảnh và nhật ký bàn giao của các vai trò AI
└── model/                  # Bộ dựng & chuyển đổi model 3D PBR bằng Python thuần + NumPy + Pillow
    ├── build.py            # CLI build ra .glb và .bundle.js
    ├── assets/             # Asset nguồn theo dõi trong Git (fps_arms.glb SkinnedMesh 47 xương, awm.glb)
    ├── core/               # Lõi hình học, texture PBR & glTF 2.0 exporter
    ├── weapons/            # Mô tả hình học & chuyển đổi PBR từng vũ khí (m416.py, pistol.py, awm.py)
    ├── characters/         # Chuyển đổi tay FPP (fps_arms.py -> pbrMetallicRoughness) & dựng chiến binh (soldier.py - TeamColor)
    ├── tests/              # Unit test AAA kiểm tra geometry, textures, chuyển đổi PBR & chuẩn binary .glb (25 test cases)
    └── dist/               # Asset đã build (m416, pistol, awm, fps_arms, soldier ở dạng .glb và .bundle.js)
```

## Yêu cầu & Cấu hình môi trường

- Trình duyệt hiện đại hỗ trợ **WebGL** và **Pointer Lock API** (Chrome, Edge, Firefox).
- Kết nối Internet (hoặc cache trình duyệt) để tải thư viện Three.js r128 và `GLTFLoader.js` từ CDN.
- Để host phòng chơi PvP qua **mạng LAN**: **Node.js 22+** (không cần cài `npm install`).
- Để build lại model 3D từ Python: **Python 3** kèm `numpy` và `Pillow` (`model/requirements.txt`). Không sử dụng biến môi trường hay tệp `.env`.

## Cách chạy & Build model

### Build model 3D bằng Python (khi chỉnh sửa trong `model/`)

```bash
python3 -m model.build
```

Lệnh trên dựng/chuyển đổi và tạo mới các cặp asset `m416`, `pistol`, `awm` (chuyển đổi `awm.glb` sang glTF 2.0 `pbrMetallicRoughness`, chuẩn hóa trục `-Z`/mét với `awm_bolt_pivot`, `awm_mag_group`, `muzzle_anchor` và 4 socket IK), `fps_arms` (chuyển đổi từ nguồn `fps_arms.glb` `SkinnedMesh` 47 xương sang glTF 2.0 `pbrMetallicRoughness`, bọc `arms_root` `scale=0.01`, `rotY=π`) và `soldier` trong `model/dist/` (`.glb` nhị phân glTF 2.0 và `.bundle.js` Base64 nhúng). Xem chi tiết tại [model/README.md](model/README.md).

### Chơi PvP Mạng LAN kiểu Truy Kích & Luyện tập Drone

Trên máy làm chủ phòng (Host), mở terminal tại thư mục gốc dự án và chạy:

```bash
node server/index.js
```

Server mặc định lắng nghe `0.0.0.0:8090` (tự động chuyển sang cổng trống kế tiếp `8091..` nếu `8090` đang bận, hoặc chỉ định `--port <cổng>`) và tự in các địa chỉ LAN (ví dụ `http://10.10.0.224:8090/FPS.html`) kèm nhắc mở tường lửa.

- **Kết nối tự động:** Client tự nối WebSocket theo `${ws|wss}://${location.host}/ws`, **không cần nhập URL hay bấm nút Kết nối**; tự nối lại và khôi phục ghế/điểm/số đạn từng súng trong vòng `30s` nếu lỡ tải lại trang hoặc rớt mạng tạm thời.
- **Vòng đời phòng Truy Kích (`WAITING → STARTING 5s → PLAYING → ENDING 10s → WAITING`):** Tạo phòng giữ đúng tên/cài đặt bạn nhập (có thể đặt mật khẩu), vào trận nhanh, đổi phe (chặn lệch ≥ 2), Sẵn sàng, Host cài đặt lại phòng (tự reset ready của thành viên), Kick người chơi, Chat phòng chờ/trong trận và tự chuyển quyền Host nếu chủ phòng thoát. Có tùy chọn **Test 1 người (Dev)** để mở trận kiểm thử một mình hoặc chọn **Luyện tập Offline (Drone)** ngay từ Sảnh chờ.
- **Lưu ý Windows Firewall (Host trên Windows):** Nếu bạn bè trong LAN không truy cập được link HTTP, mở port TCP `8090` cho mạng Private bằng PowerShell (Admin):
  ```powershell
  New-NetFirewallRule -DisplayName "FPS LAN Server 8090" -Direction Inbound -Protocol TCP -LocalPort 8090 -Action Allow -Profile Private
  ```

### Deploy Online (Render Free + Cloudflare Pages + GitHub Actions Keep-Alive)

- **Backend WebSocket trên Render Free:**
  - Start Command: `node server/index.js` (tự nhận `process.env.PORT`).
  - Biến môi trường tùy chọn: `ALLOWED_ORIGIN=https://<project>.pages.dev` (danh sách Origin cho phép nâng cấp `/ws`, phân tách bằng dấu `,`; để trống khi chạy LAN).
  - Endpoint kiểm tra sức khỏe: `GET /health` (và `HEAD /health`) trả về `200 OK` JSON `{ ok, uptimeSec, rooms, sessions }`.
- **Frontend & Asset tĩnh trên Cloudflare Pages (`dist-static/`):**
  ```bash
  FPS_WS_URL="wss://<render-service>.onrender.com/ws" node scripts/build_static.mjs
  ```
  Xuất trọn bộ HTML/JS/assets/maps/sound/GLB + `_headers` ra `dist-static/` (đã chèn `<meta name="fps-ws-url">`, bù trễ đồng hồ `RTT / 2` và tự hiển thị link mời online).
- **Giữ Render Free luôn thức:** Trong GitHub repo, vào `Settings → Secrets and variables → Actions → Variables` thêm `RENDER_HEALTH_URL=https://<render-service>.onrender.com/health` để workflow `.github/workflows/keep_alive.yml` tự gọi mỗi 10 phút (`*/10 * * * *`).

## Điều khiển mặc định & Cài đặt

_(Có thể đổi phím, độ nhạy chuột, độ nhạy ADS, đảo trục Y, FOV `65–95°` và chế độ Giữ/Bật-tắt cho Ngồi/Ngắm trong mục **Cài đặt** từ Sảnh chờ hoặc Menu `Esc`)_

| Phím / Chuột                   | Chức năng                | Ghi chú                                                                                           |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `W` `A` `S` `D`                | Di chuyển (`e.code`)     | Chuẩn hóa chéo, air control `25%`, vật lý `60 Hz`                                                 |
| `Space`                        | Nhảy                     | Jump buffer `100ms`, Coyote time `80ms`, chống bunny-hop `300ms`                                  |
| `C` / `Ctrl`                   | Ngồi                     | Camera trượt xuống `1.18m`, hitbox đầu hạ `1.18m`, raycast kiểm tra trần `1.38m`                  |
| `Shift` (trái)                 | Chạy nước rút            | Nhanh ×1.35; vẫn nạp đạn được, không bắn/ngắm được                                                |
| `Chuột trái`                   | Bắn                      | Tự động (`M416`) hoặc bán tự động (`Glock-17`, `AWM Sniper`); click khóa chuột đầu không bắn nhầm |
| `Chuột phải`                   | Ngắm (ADS)               | Thu hẹp FOV (`55°`/`60°`/`24°` ống ngắm Sniper); tự tắt khi nạp hoặc sprint                       |
| `R`                            | Nạp đạn                  | Băng đạn dự trữ vô hạn (`mag / ∞`), tự nạp khi `mag = 0`, nạp chiến thuật nhanh hơn nạp rỗng      |
| `1` `2` `3` `Q` / `Cuộn chuột` | Đổi súng / Về súng trước | Đổi khi đang nạp sẽ hủy nạp và giữ nguyên `mag` súng cũ                                           |
| `L`                            | Bật / tắt laser xanh     | Hoạt động trên `M416` AN/PEQ-15                                                                   |
| `Tab`                          | Bảng điểm PvP LAN        | Giữ để xem                                                                                        |
| `Enter`                        | Mở chat trong trận       | Tạm khóa phím di chuyển khi gõ                                                                    |
| `Esc`                          | Thả chuột & Mở Menu      | **Không đóng băng trận khi chơi mạng LAN**                                                        |

## Điểm nổi bật kỹ thuật

- **Server Authority & Chống Cheat 5 Lớp (`server/weapons.js`, `hitreg.js`, `lag_comp.js`, `anti_cheat.js`, `Match.js`):**
  - **Bảng sát thương cân bằng kiểu Truy Kích / CS (100 HP — dùng chung cho Đấu Đơn FFA & Đấu Đội TDM):**
    - `M416` (`86ms`, `moveMult 0.95×`, `equip 520ms`): `90 / 27 / 21` (head/body/limb), giảm dần `30m → 95m` xuống `0.78×` (tối đa `120m`; không 1-tap đầu, 4 viên thân gần / 5 viên xa).
    - `Glock-17` (`150ms`, `moveMult 1.05×`, `equip 240ms`): `72 / 24 / 18`, giảm dần `20m → 65m` xuống `0.65×` (tối đa `85m`; cơ động nhất, kết liễu mục tiêu dính chân AWM đến `44m`).
    - `AWM Sniper` (`1300ms`, `moveMult 0.84×`, `equip 780ms`): `180 / 115 / 80`, giảm dần `65m → 160m` xuống `0.92×` (tối đa `180m`; đạn đạo có trọng lực + drag, 1-hit đầu & thân trên toàn bản đồ, bắn chân để lại `20–26 HP`).
  - **Server-Authoritative Hitreg & Lag Compensation:** Client không còn gửi `MSG.HIT`; server tự raycast trên hitbox 3 tư thế (**Đứng / Ngồi / Nằm**, ưu tiên `head > body > limb`) và tua ngược lịch sử tư thế (`<= 250ms` neo theo RTT đo qua WS `OP_PONG`), bỏ qua `moveOnly` (bắn xuyên cửa sổ nhà kho & kính cabin xe).
  - **Chống cheat 5 lớp:** từ chối `MSG.HIT` giả (`+15`), chặn fake `origin`/wall-peek (`+20`), chặn Silent Aim lệch nón `yaw/pitch` (`+25`), chặn Rapid-Fire bằng leaky fire debt (`+10`) và Speedhack bằng leaky movement budget (`+10`); suy giảm `-5/10s` chơi sạch, cảnh báo tại `40` và tự động kick tại `100` (`ERR.CHEAT_DETECTED`).
- **Màn hình Loading 4 bước & Khởi động không khựng (`public/js/loading_manager.js`, `map_loader.js`, `game.js`, `lobby.js`, `FPS.html`):**
  - Toàn bộ tác vụ nặng lúc mở trang (dựng bản đồ mặc định, nạp 5 model GLB, tiền tạo bộ đệm `AudioContext`/Convolver, upload VRAM theo lô `renderer.initTexture(tex)`, biên dịch shader tách pha cho world + 3 súng + tay `SkinnedMesh` + Drone + Soldier + chớp lửa và render nháp 1 frame ẩn) đều chạy sau `#loadingOverlay` xen kẽ `yieldToUI()` (`requestAnimationFrame` kèm fallback cho tab nền) giúp thanh tiến độ mượt và không treo trình duyệt.
  - Cache bản đồ theo ID (`currentActiveMapId` + `mapGuard`): bấm **Luyện tập Offline (Drone)** khi trùng map đang hiển thị vào trận ngay lập tức (gọi `requestPointerLock()` đồng bộ trong sự kiện click). Đổi dropdown `#soloMapSelect` (hoặc vào phòng LAN có map khác) sẽ tải, làm nóng GPU và cache ngay lúc chọn; lần đổi lại bản đồ đã cache đạt `0ms`.
- **Phân biệt Địch – Ta Gói A (Competitive Valorant + CoD, `public/js/iff_system.js`, `asset_loader.js`, `remote_players.js`, `hud_ui.js`):**
  - **Quy ước màu tương đối (1A) & hỗ trợ Mù màu:** Đồng đội luôn Xanh (`#2F80FF` / `#42B8FF`) và luôn đứng bên trái thanh tỷ số `#pvpTop` trong TDM (kể cả khi bạn ở Đội B). Kẻ địch trong TDM và toàn bộ đối thủ trong FFA nhận màu thống nhất theo Cài đặt (**Đỏ `#FF3535`**, **Vàng mù màu `#FFE135`**, hoặc **Tím `#C84BFF`**), đồng bộ cả tâm ngắm `.targetEnemy`, Radar, Killfeed, Scoreboard và vệt đạn tracer.
  - **Đổi màu quân phục theo phe & Hero Visibility giữ 100% chi tiết PBR (`soldier_iff_pbr_v1`):** Ngoài viền Geometric-Normal Silhouette Fresnel siêu mảnh (`2B + 3B`, `28,000 tris`, `1024×1024`, `normalScale 1.28`, tắt 3 LED trên địch), shader dùng chung 1 WebGL program tích hợp thêm: (1) **GLSL Albedo Recolor** tại `#include <map_fragment>` nhuộm riêng phần vải nâu-olive sang **Hải Quân Lạnh (`#1F4E7E`)** cho Đồng đội TDM và **Xám Thép Đô Thị (`#4E5A68`)** cho Địch TDM/FFA (giữ nguyên giáp/đai/giày đen, tem `ŁOB` và cờ); (2) **Hero Fill Lift** chống bết tối ở góc râm/nhà kho + **Cool Contour** mảnh tách khối; (3) **Distance-Adaptive Rim** (`12–45m`) + **Character Fog Attenuation** giảm sương mù `FogExp2` trên nhân vật (`0` tăng size `soldier.glb`, đổi cấu hình `0ms`, `0` shader recompile). Cho phép chuyển **Viền mảnh chuẩn FPS / Siêu mảnh tự nhiên / Tắt viền** và tách riêng `protectedAlly` / `protectedEnemy` khi nhấp nháy Spawn Protection.
  - **Tỷ lệ nhân vật Heroic FPS (`1A` — `1.92 m × 1.15×`) & Đồng bộ Hitbox (`public/js/spawn_rules.js`, `hitreg.js`, `map_collision.js`, `remote_players.js`, `server/anti_cheat.js`):** Nguồn chân lý thống nhất quy mô nhân vật SWAT cao `~1.92 m` (`SOLDIER_SCALE_Y = 1.09`, `SOLDIER_SCALE_XZ = 1.15`), tầm mắt `1.84m / 1.18m / 0.45m` (đứng / ngồi / nằm), bán kính va chạm `0.50m`, giữ nguyên tốc độ chạy `5.8 m/s`, cân xứng công trình Khu Quân Sự Cũ và vẫn nấp kín sau bao cát `1.1m` khi ngồi.
- **Đồng bộ bước chạy chống trượt chân & Tư thế Ngồi cầm súng chuẩn PUBG/CoD (`build_fsb_anims.py`, `skinned_clone.js`, `remote_players.js`, `viewmodel_anim.js`):** Tinh chỉnh lại pose `crouch` ôm báng súng sát vai phải + bổ sung các clip đi ngồi 4 hướng (`10` clips NLA), đồng bộ `AnimationMixer` `timeScale` theo vận tốc di chuyển thực (`mv` liên tục + xoay hông/thân khi strafe/lùi), kết hợp gợn bước chân & nhún camera tiếp đất FPP mượt mà.
  - **Marker Đồng đội Xuyên tường Thông minh (PUBG + Valorant):** Đồng đội sau tường hiện mũi tên Cyan + mét khoảng cách (`depthTest: false`), tự mờ xuống `~0.15` khi tâm ngắm đi sát (`Crosshair Proximity Fade`) hoặc khi ngắm `ADS/AWM` để không che kẻ địch đứng phía trước; nhìn trực tiếp mới hiện tên + thanh máu mảnh. Radar 2D hiển thị đồng đội dạng mũi tên xoay đúng hướng nhìn.

- **Luyện tập Offline — Đấu với Máy (TDM & FFA `8v8`/`9v9`) & Sinh tồn Drone (`public/js/bot_ai.js`, `lobby.js`, `lobby_utils.js`, `FPS.html`):**
  - Từ Sảnh chính bấm **Luyện tập** để chọn **Đấu với Máy** (chọn chế độ **Đấu Đơn FFA** hoặc **Đấu Đội TDM**, bản đồ 3D `Khu Quân Sự Cũ` / `Bến Cảng Mưa`, 3 mức độ khó `Dễ` / `Trung bình` / `Khó`, số Bot `5/9/11/13/15/17` — mặc định `15` Bot = `8v8`, tối đa `9v9`, mục tiêu mạng `15–50`) hoặc **Sinh tồn (Drone)**. Phòng LAN hỗ trợ `4–18` người chơi (mặc định `16` = `8v8`, tối đa `9v9`), tận dụng trọn bộ `9` điểm spawn/phe TDM & `16` điểm FFA. Bot dùng chung nhân vật SWAT `10` clips (`idle/run/crouch/crouch_forward/crouch_backward/crouch_left/crouch_right/jump/prone/prone_move`) và 3 vũ khí (`M416`, `Glock-17`, `AWM`).
- **Spawn Protection nhấp nháy kiểu CS2, Invulnerability Frames & Hồi sinh TDM/FFA (`public/js/spawn_rules.js`, `server/lag_comp.js`, `server/Match.js`, `public/js/remote_players.js`, `public/js/hud_ui.js`):**
  - **Invulnerability Frames (`400ms`) & `spawnEpoch`:** Khóa bất tử khung hình đầu ngay khi xuất hiện kèm kiểm tra `spawnEpoch` trong Lag Compensation để đạn trước lúc bị hạ không xuyên sang mạng mới; bắn đạn sẽ hủy bảo vệ ngay lập tức (kèm cổng `requireFreshFireAfterRespawn` chống cướp cò khi đang giữ chuột).
  - **Nhấp nháy trực tiếp nhân vật (không còn khung trắng hộp):** Kéo dài **3.0s / bán kính 9.0m** ở **TDM** (hồi sinh `3.5s`) và **2.0s / bán kính 6.0m** ở **FFA** (hồi sinh `2.0s`); tự hủy khi bắn, rời khỏi vùng an toàn hoặc giữ ngắm `ADS > 600ms`. Loại bỏ hoàn toàn khối trụ/vòng tròn trắng che nhân vật, thay bằng **nhấp nháy trực tiếp trên thân SWAT** (`soldierBodyMats.protected` bán trong suốt + viền rìa cyan mảnh, nhịp `12Hz → 4.5Hz → 10Hz / 14Hz hit-flash`) cùng `#spawnProtectBar`, `#shieldVignette` và hitmarker cyan `hmShield`.
  - **Tối ưu hiệu năng Đấu với Máy & Ống ngắm AWM:** Gỡ bỏ CSS `filter: blur()` trên `#scopeReticleWrap` (dùng compositor GPU `transform`/`opacity` + `will-change`), bổ sung **2D Spatial Hash Grid DDA** trong `spawn_rules.js` (`raycastArenaDistance`), throttle LoS & obstacle whisker của Bot về ~`10 Hz`, cập nhật snapshot zero-GC trong `bot_ai.js`/`game.js`/`remote_players.js`, bỏ `updateMatrixWorld(true)` toàn cây xương, giới hạn bóng `SkinnedMesh` theo khoảng cách (`28m`) và throttle raycast đổi màu tâm ngắm về `20 Hz`.
  - **Hồi sinh thông minh & Death Cam:** TDM hỗ trợ 3 tầng điểm + **Dynamic Spawn Flip** (cooldown `8s`, đổi sang căn cứ an toàn kèm cảnh báo HUD khi bị ép spawn); FFA chấm điểm đa tiêu chí né `lastDeathPos < 12m`, giữ khoảng cách vàng `18–42m` và ưu tiên điểm khuất LoS, kết hợp Death Cam & thẻ thông tin hồi sinh `#respawnBanner`.

## Kiểm thử

- **Python Unit Tests (`python3 -m unittest discover -s model/tests -v`):** **30/30 PASS** (kiểm tra geometry, textures PBR, chuyển đổi PBR & chuẩn hóa `-Z`/mét cho `fps_arms.glb`, `awm.glb`, `pistol.glb`, 12 model bản đồ Khu Quân Sự Cũ và chuẩn nhị phân glTF 2.0 `.glb` + `.bundle.js`).
- **Node.js Tests (`node --test server/tests/test_*.js server/tests/test_*.mjs`):** **101/101 PASS** (gồm hệ thống IFF, đổi màu áo Ally/Enemy & Hero Visibility `test_iff_system.mjs`, Spawn Protection nhấp nháy/i-frames/Smart Spawn/Bot AI `test_spawn_protection.mjs`, bảng sát thương & sweep 0–200m `damage_model`, hitbox đa vùng/AWM ballistics/lag compensation/chống cheat 5 lớp `server_hitreg_anticheat`, LAN server `lan_v2`, `arm_rig`, `soldier_anim`, `weapon_audio`, `military_map`, `graphics_quality`, `loading_manager`, `net_utils` và `build_static`).
- **Trình duyệt Headless (Chrome/Playwright):**
  - `verify_practice_bots_protection_e2e.py` (**PASS**): Điều hướng Lobby `home → practice → survival/bot` (TDM & FFA `8v8` với `15` Bot SWAT `soldier.glb`, AWM double-zoom `10.47 ms/frame` ~`95.5 FPS`), nhấp nháy Spawn Protection (`#spawnProtectBar` + `#shieldVignette`), bắn trúng khiên (`0` damage + `hmShield`), hủy khiên khi bắn, Death Cam / `#respawnBanner` và hồi sinh lại với `i-frames` + giáp mới (`0` console/pageerror/HTTP>=400).
  - `verify_lan_v2_e2e.py` (**PASS**): 3-tab Lobby → Phòng chờ → Mật khẩu → Chat → Kick → Host Cài đặt → `STARTING` → `PLAYING` → Headshot → `ENDING` → `"Về phòng ngay"` → Reconnect tab → Solo Drone (`0` console/pageerror).
  - `verify_lan_v2_1_e2e.py` (**PASS**): Lưu cài đặt & gán phím `localStorage` qua reload, chuyển súng `1/2/3`, đổi súng hủy nạp giữ nguyên mag, `Alt+Tab`/`blur` không kẹt phím, `Shift+R` nạp khi chạy nhưng chặn bắn, phân biệt đội `30m` trong mưa + giả lập mù màu Chromium `protanopia`, nameplate chỉ hiện đồng đội, tư thế ngồi đồng bộ & hoạt ảnh nạp người chơi khác, Radar chấm địch khi bắn, chặn cheat `w.mag=99` trên console, khôi phục đúng `m416.mag = 26` khi reconnect giữa trận, ống ngắm AWM Sniper & tâm ngắm đổi đỏ (`0` console/pageerror).
  - Kiểm định trực quan viewmodel Chrome headless cho `M416`, `Glock-17` (`pistol.glb` M1911) và `AWM Sniper` với tay `SkinnedMesh` + IK 2 xương trên cả map Khu Quân Sự Cũ & Bến Cảng Mưa (`0` console/pageerror).

### Pipeline Blender Python cho nhân vật đặc nhiệm FSB (`fsbfor_games.glb`)

   - **Pha 1 — Tiền xử lý & giảm lưới để Auto-Rig (Mixamo / AccuRIG):**
   ```powershell
   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python scripts/blender/prep_fsb_for_rig.py -- --target-tris 28000 --tex-size 1024
   ```
   Gộp 5 mesh gốc (`500,000 tris`, `57.35 MB`) xuống **`28,000 tris`**, cao chuẩn `1.76 m` (`Y = 0`), 1 `UVMap`, 3 texture `1024×1024` và xuất `model/assets/fsb_ready_for_rig.fbx` + `fsb_ready_for_rig.glb` (`4.64 MB`).
2. **Upload lên Mixamo / AccuRIG** và lưu 6 clip (`idle.fbx` With Skin, `run.fbx`, `crouch.fbx`, `jump.fbx`, `prone.fbx`, `prone_move.fbx`) vào `model/assets/fsb_anims/`.
3. **Pha 2 — Gộp 7 NLA Track (`idle`, `run`, `crouch`, `crouch_move`, `jump`, `prone`, `prone_move`), nâng lưới 28k, chỉnh pose ngồi & xuất `model/dist/soldier.glb`:**
   ```powershell
   "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" --background --python scripts/blender/build_fsb_anims.py -- --tex-size 1024
   ```
   *(Tắt Draco để tương thích trực tiếp `GLTFLoader` Three.js r128; tự chuyển weight sang lưới 28k từ `fsb_ready_for_rig.glb`.)*

## Ghi công (Attribution)

- Model tay nhân vật FPP **"fps arms"** của tác giả **DJMaesen**, cấp phép theo **CC-BY-4.0** (<http://creativecommons.org/licenses/by/4.0/>), nguồn: <https://sketchfab.com/3d-models/fps-arms-08ec4403a47645d8ad80633abf13d39d> (đã chuyển đổi PBR & chuẩn hóa node gốc `arms_root`).
- Model súng lục **"Pistol"** của tác giả **DJMaesen**, cấp phép theo **CC-BY-4.0** (<http://creativecommons.org/licenses/by/4.0/>), nguồn: <https://sketchfab.com/3d-models/pistol-5f6ec54257de449cacc8c872660b40d3> (đã giảm texture `512x512`, chuẩn hóa trục `-Z`/mét, phân cấp node `pistol_slide`/`pistol_trigger`/`pistol_mag`/`pistol_muzzle` & socket IK 2 tay).
- Model đặc nhiệm 3rd-person **"FSB(For games)"** của tác giả **Quantek Studio** (<https://sketchfab.com/QuantekStudio>), cấp phép theo **CC-BY-4.0** (<http://creativecommons.org/licenses/by/4.0/>), nguồn: <https://sketchfab.com/3d-models/fsbfor-games-d8e7465fd9cd4a22a9badebfdf8e0775> (đã gộp lưới & Decimate từ `500,000` xuống `18,000` tris, chuẩn hóa chiều cao `1.76m`, giảm texture `4096×4096` xuống `1024×1024`/`512×512`, gắn socket `weapon_mount` & `TeamColor`).
