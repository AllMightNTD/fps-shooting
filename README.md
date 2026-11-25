# Bến Cảng Mưa – Web FPS (Three.js)

Trò chơi bắn súng góc nhìn thứ nhất (FPS) trên nền WebGL sử dụng Three.js r128, lấy bối cảnh bến cảng đêm mưa với các container hàng hóa, thời tiết sấm chớp, âm thanh tổng hợp Web Audio API, bộ viewmodel M416 + tay FPP chuẩn PBR, hệ thống **đa vũ khí nạp đạn băng vô hạn** (`M416`, `Glock-17`, `AWM Sniper`), **kiến trúc Input 3 lớp & vật lý 60 Hz**, và chế độ **đấu người với người qua mạng LAN phong cách Truy Kích** (Sảnh chờ → Phòng chờ → Đếm ngược → Trong trận → Tổng kết) cùng mục **Luyện tập Offline (Drone)**.

## Cấu trúc thư mục

```text
.
├── server/                 # Máy chủ PvP Mạng LAN Node.js 22+ thuần (0 thư viện ngoài)
│   ├── package.json        # Đánh dấu ES Module cục bộ cho server/
│   ├── index.js            # HTTP static allowlist (/js/weapons.js, /js/protocol.js, ...) + WebSocket /ws (0.0.0.0:8090)
│   ├── weapons.js          # Nguồn cấu hình vũ khí, FLAG tư thế & luật tốc độ/spread dùng chung Client/Server
│   ├── protocol.js         # Hằng số message (reload, switchWeapon, event.reload, ammo, ...) & sanitizeText
│   ├── ws.js               # RFC 6455 WebSocket codec, heartbeat ping/pong & chống flood 160 msg/s
│   ├── spawn.js            # Sinh map bến cảng tất định (MAP_SEED=11042026), va chạm AABB & LoS spawn
│   ├── RoomManager.js      # Session token reconnect 30s (khôi phục cả số đạn từng súng), quickJoin & dọn phòng
│   ├── Room.js             # Vòng đời phòng WAITING → STARTING (5s) → PLAYING → ENDING (10s) → WAITING
│   ├── Match.js            # Tick 20Hz: tickWeapon (TOL 80ms), nạp chiến thuật/rỗng, hitbox ngồi, khiên 2.5s
│   ├── modes/
│   │   ├── TDM.js          # Đấu Đội (▲ Đặc Nhiệm #2F80FF vs ● Nổi Loạn #FF4D2E): khóa lệch >=2, cấm bắn đồng đội
│   │   └── FFA.js          # Đấu Đơn (màu trung tính #8A8F98): xếp theo killLimit/hết giờ, spawn khuất LoS
│   └── tests/
│       ├── test_lan_v2.js  # Bộ kiểm thử Node.js (5 test, gồm 6 edge case + reload/switch/TOL/posture hitbox)
│       └── test_arm_rig.mjs # Unit test AAA cho IK 2 xương & controller tay SkinnedMesh (3 test)
├── public/                 # Giao diện & Engine phía Client (ES Modules)
│   ├── FPS.html            # HUD vô hạn đạn, vòng tiến độ nạp, Radar, ống ngắm Sniper & Modal Cài đặt
│   └── js/
│       ├── net.js          # Tự suy ra ws(s)://${location.host}/ws, tự nối lại & sessionStorage 30s
│       ├── lobby.js        # Danh sách phòng thời gian thực, tạo phòng theo tên nhập, Vào nhanh, Mật khẩu
│       ├── room.js         # Phòng chờ 2 cột TDM / FFA, Sẵn sàng, Đổi phe, Kick, Chat & Cài đặt Host
│       ├── settings.js     # Lưu cấu hình chuột, FOV, Hold/Toggle, gán lại phím BIND qua localStorage
│       ├── input.js        # Input 3 lớp dùng e.code, Alt+Tab reset(), chặn cuộn trang & click khóa chuột đầu
│       ├── arm_rig.js      # Bộ giải IK 2 xương giải tích, SKINNED_ARM_POSES (M416/Pistol/Sniper) & gập ngón bóp cò
│       └── game.js         # Engine Three.js r128: vật lý 60Hz, M416/Pistol/Sniper, tay SkinnedMesh, TeamColor & Radar
├── FPS.html                # Trang chuyển hướng trỏ về public/FPS.html
├── GEMINI.md               # Quy chuẩn kỹ thuật và quy trình làm việc của dự án
├── README.md               # Tài liệu hướng dẫn dự án
├── agents/
│   └── context.md          # Bộ nhớ ngữ cảnh và nhật ký bàn giao của các vai trò AI
└── model/                  # Bộ dựng & chuyển đổi model 3D PBR bằng Python thuần + NumPy + Pillow
    ├── build.py            # CLI build ra .glb và .bundle.js
    ├── assets/             # Asset nguồn theo dõi trong Git (fps_arms.glb SkinnedMesh 47 xương)
    ├── core/               # Lõi hình học, texture PBR & glTF 2.0 exporter
    ├── weapons/            # Mô tả hình học từng vũ khí (m416.py, pistol.py)
    ├── characters/         # Chuyển đổi tay FPP (fps_arms.py -> pbrMetallicRoughness) & dựng chiến binh (soldier.py - TeamColor)
    ├── tests/              # Unit test AAA kiểm tra geometry, textures, chuyển đổi PBR & chuẩn binary .glb (23 test cases)
    └── dist/               # Asset đã build (m416, pistol, fps_arms, soldier ở dạng .glb và .bundle.js)
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

Lệnh trên dựng/chuyển đổi và tạo mới các cặp asset `m416`, `pistol`, `fps_arms` (chuyển đổi từ nguồn `fps_arms.glb` `SkinnedMesh` 47 xương sang glTF 2.0 `pbrMetallicRoughness`, bọc `arms_root` `scale=0.01`, `rotY=π`) và `soldier` trong `model/dist/` (`.glb` nhị phân glTF 2.0 và `.bundle.js` Base64 nhúng). Xem chi tiết tại [model/README.md](model/README.md).

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

## Điều khiển mặc định & Cài đặt

*(Có thể đổi phím, độ nhạy chuột, độ nhạy ADS, đảo trục Y, FOV `65–95°` và chế độ Giữ/Bật-tắt cho Ngồi/Ngắm trong mục **Cài đặt** từ Sảnh chờ hoặc Menu `Esc`)*

| Phím / Chuột | Chức năng | Ghi chú |
| --- | --- | --- |
| `W` `A` `S` `D` | Di chuyển (`e.code`) | Chuẩn hóa chéo, air control `25%`, vật lý `60 Hz` |
| `Space` | Nhảy | Jump buffer `100ms`, Coyote time `80ms`, chống bunny-hop `300ms` |
| `C` / `Ctrl` | Ngồi | Camera trượt xuống `1.12m`, hitbox đầu hạ `1.08m`, raycast kiểm tra trần |
| `Shift` (trái) | Chạy nước rút | Nhanh ×1.35; vẫn nạp đạn được, không bắn/ngắm được |
| `Chuột trái` | Bắn | Tự động (`M416`) hoặc bán tự động (`Glock-17`, `AWM Sniper`); click khóa chuột đầu không bắn nhầm |
| `Chuột phải` | Ngắm (ADS) | Thu hẹp FOV (`55°`/`60°`/`24°` ống ngắm Sniper); tự tắt khi nạp hoặc sprint |
| `R` | Nạp đạn | Băng đạn dự trữ vô hạn (`mag / ∞`), tự nạp khi `mag = 0`, nạp chiến thuật nhanh hơn nạp rỗng |
| `1` `2` `3` `Q` / `Cuộn chuột` | Đổi súng / Về súng trước | Đổi khi đang nạp sẽ hủy nạp và giữ nguyên `mag` súng cũ |
| `L` | Bật / tắt laser xanh | Hoạt động trên `M416` AN/PEQ-15 |
| `Tab` | Bảng điểm PvP LAN | Giữ để xem |
| `Enter` | Mở chat trong trận | Tạm khóa phím di chuyển khi gõ |
| `Esc` | Thả chuột & Mở Menu | **Không đóng băng trận khi chơi mạng LAN** |

## Điểm nổi bật kỹ thuật

- **Server Authority toàn phần (`server/weapons.js`, `server/Match.js`):**
  - Nguồn cấu hình vũ khí duy nhất (`M416`, `Glock-17`, `AWM Sniper`) chia sẻ giữa server và client. Server chỉ dùng `Date.now()` phía server, kiểm tra lười `tickWeapon` với `RELOAD_TOLERANCE_MS = 80ms`, chặn bắn khi đang nạp / chạy nước rút / hết đạn, tự nạp khi bắn viên cuối, gửi `AMMO` chỉnh lệch nếu console client bị sửa, hủy nạp khi chết hoặc đổi súng, và nạp đầy mọi súng khi hồi sinh.
  - Bắn dùng **client raycast + server validate**: kiểm tra tốc độ di chuyển theo tư thế (`flags` bitmask), tầm bắn từng súng, đường ngắm `hasLineOfSight` tính cả độ cao cúi ngồi trên `MAP_SEED = 11042026`.
- **Phân biệt Hai Đội thân thiện Mù Màu (`model/characters/soldier.py` & `public/js/game.js`):**
  - Vật liệu `TeamColor` phủ lên mảng mũ FAST, giáp vai rộng, ngực và lưng dùng đúng 3 material dùng chung (`▲ Đặc Nhiệm #2F80FF`, `● Nổi Loạn #FF4D2E`, `◆ Đấu Đơn #8A8F98`) kèm `emissiveIntensity` nổi rõ từ `30m` trong mưa và an toàn dưới `protanopia`/`deuteranopia`.
  - Bổ sung nhận diện đa tầng: nameplate chỉ hiện cho đồng đội TDM, tâm ngắm đổi đỏ khi trỏ vào hitbox kẻ địch, killfeed/bảng điểm đồng bộ màu + ký hiệu hình học, và Radar góc trên-trái lộ chấm địch trong `2s` khi nổ súng.

## Kiểm thử

- **Python Unit Tests (`uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m unittest discover -s model/tests -v`):** **22/23 PASS**, **1 ERROR** có sẵn từ trước ở `model/tests/test_pistol_model.py:56` (`extrude_hollow_profile` nhận `outer=` thay vì `outer_pts=`); kiểm tra geometry, textures PBR, chuyển đổi Spec-Gloss → Metallic-Roughness `fps_arms.glb` và chuẩn nhị phân glTF 2.0 `.glb` + `.bundle.js`.
- **Node.js Server & Arm Rig Tests (`node --test server/tests/test_lan_v2.js server/tests/test_arm_rig.mjs`):** **8/8 PASS** (gồm `5` test LAN server: LoS FFA spawn, trọn vòng đời phòng, 6 tình huống biên, HTTP static allowlist `/js/weapons.js`, `/js/arm_rig.js`, `/model/dist/fps_arms.bundle.js`, chặn traversal, nạp chiến thuật/rỗng, `TOL=80ms`, `switchWeapon`, crouch hitbox; và `3` test `arm_rig`: IK 2 xương giải tích trên 18 pose M416/Glock-17/AWM, edge cases không `NaN`, biến đổi `arms_root` cm/`rotY=π`, và gập ngón bóp cò).
- **Trình duyệt Headless (Chrome/Playwright):**
  - `verify_lan_v2_e2e.py` (**PASS**): 3-tab Lobby → Phòng chờ → Mật khẩu → Chat → Kick → Host Cài đặt → `STARTING` → `PLAYING` → Headshot → `ENDING` → `"Về phòng ngay"` → Reconnect tab → Solo Drone (`0` console/pageerror).
  - `verify_lan_v2_1_e2e.py` (**PASS**): Lưu cài đặt & gán phím `localStorage` qua reload, chuyển súng `1/2/3`, đổi súng hủy nạp giữ nguyên mag, `Alt+Tab`/`blur` không kẹt phím, `Shift+R` nạp khi chạy nhưng chặn bắn, phân biệt đội `30m` trong mưa + giả lập mù màu Chromium `protanopia`, nameplate chỉ hiện đồng đội, tư thế ngồi đồng bộ & hoạt ảnh nạp người chơi khác, Radar chấm địch khi bắn, chặn cheat `w.mag=99` trên console, khôi phục đúng `m416.mag = 26` khi reconnect giữa trận, ống ngắm AWM Sniper & tâm ngắm đổi đỏ (`0` console/pageerror).
  - Kiểm định trực quan viewmodel Chrome headless cho `M416`, `Glock-17` và `AWM Sniper` với tay `SkinnedMesh` + IK 2 xương (`0` console/pageerror).

## Ghi công (Attribution)

- Model tay nhân vật FPP **"fps arms"** của tác giả **DJMaesen**, cấp phép theo **CC-BY-4.0** (<http://creativecommons.org/licenses/by/4.0/>), nguồn: <https://sketchfab.com/3d-models/fps-arms-08ec4403a47645d8ad80633abf13d39d> (đã chuyển đổi PBR & chuẩn hóa node gốc `arms_root`).
