# Context của Dự án

> File này được AI Agent đọc đầu tiên và cập nhật sau mỗi context. Không chứa bí mật.

## 1. Trạng thái hiện tại

_(ghi đè mỗi lần cập nhật)_

- **Cập nhật lần cuối:** 2026-11-26 01:56 — Tech Lead, Developer, QA & Security Engineer
- **Dự án / Giai đoạn:** FPS Web Game ("Bến cảng mưa") — Đã xử lý triệt để toàn bộ 22 conflict sau khi pull PR #1 (`cd2b57d`) lên nhánh `main` (hợp nhất pipeline PBR `fps_arms.py` + fallback `model/assets/fps_arms.glb` + test hermetic từ upstream với hệ thống socket gắn tay + camera `vmCam` + sửa lỗi `test_pistol_model.py` từ stash local); đồng thời gỡ tracking `__pycache__/*.pyc` và cập nhật `.gitignore`.
- **Nhánh Git đang làm:** `main` (đồng bộ `origin/main` `cd2b57d`, còn thay đổi đã stage gồm phần giải quyết conflict + các asset mới chưa tích hợp: `awm.glb`, `m200.glb`, `pistol.glb`, `toon_m416.glb`, `sound/{m416,pistol,m200}/*.wav`; bản sao dự phòng gốc vẫn giữ nguyên trong `stash@{0}`).
- **Đang làm dở:** Chờ người dùng xác nhận hướng thực hiện "các bước sau" (tích hợp các model `.glb` súng mới & âm thanh `.wav`, hay kiểm thử trình duyệt / commit bản hiện tại trước).
- **Blocker:** Không có (toàn bộ 23/23 test Python và 11/11 test Node.js đều PASS).

## 2. Quyết định đã chốt

- [2026-11-25] Giữ kiến trúc Procedural 3D trên Three.js r128 tích hợp trong `FPS.html` — Lý do: Chạy độc lập không phụ thuộc asset ngoài hay lỗi CORS `file://`.
- [2026-11-25] Mẫu vũ khí: **M416 / HK416 Tactical chuẩn PUBG** (báng chiến thuật, ốp M-LOK, đầu ngắm gập MBUS, khối trích khí, băng đạn cong PMAG có cửa sổ thấy đạn đồng giảm dần, hộp laser AN/PEQ-15 FDE, kính ngắm Holographic nhìn xuyên thấu, tay cầm góc AFG) — Lý do: Người dùng xác nhận lựa chọn.
- [2026-11-25] Mẫu tay nhân vật: **Găng tay chiến thuật hở ngón (da + gù carbon) + ngón tay lộ da có móng tay + cẳng tay ướt mưa + đồng hồ quân đội đeo trực tiếp trên cổ tay trái (`leftArm`) + tay áo camo xắn** — Lý do: Người dùng xác nhận phong cách đặc trưng PUBG FPP; đồng hồ gắn trên nhóm cẳng tay đảm bảo luôn ôm khít cổ tay ở mọi góc xoay.
- [2026-11-25] Tương tác Viewmodel: **Hoạt ảnh tay trái rút/lắp băng đạn & kéo khóa nòng thật + Chuột phải ngắm qua kính ngắm (ADS, FOV 75 -> 58) + phím `L` bật/tắt laser** — Lý do: Người dùng xác nhận nâng cấp trọn bộ.
- [2026-11-25] Render Viewmodel qua pass riêng (`VIEW_LAYER = 1`, `R.clearDepth()`, `cam.near = 0.03`) kèm `PMREMGenerator` environment map và 2 đèn cục bộ (`vmKey`, `vmFill`) chỉ chiếu layer 1 — Lý do: Tránh súng/tay đâm xuyên container và giữ phản xạ kim loại/da rõ nét trong đêm mưa.
- [2026-11-25] Xây dựng thư mục `model/` bằng **Python thuần + `numpy` + `Pillow`** (không phụ thuộc Blender/trimesh/pygltflib) để dựng hình học bevel/extrude, sinh texture PBR ướt mưa (`metallicRoughness` + tangent-space `normalMap`), và xuất ra cả `model/dist/m416.glb` lẫn `model/dist/m416.bundle.js` (Base64 GLB) — Lý do: Người dùng chọn phương án 1.A + 3 để vừa chuẩn glTF 2.0 PBR vừa chạy được trên cả `file://` và HTTP server không lỗi CORS.
- [2026-11-25] Dùng mẫu M416 PBR mới từ `model/` **thay thế phần thân súng** trong `FPS.html`, đồng thời giữ lại tay nhân vật FPP, animation bắn/nạp đạn/ADS, hộp laser AN/PEQ-15 và căn chỉnh lại `POSE` khớp khẩu mới — Lý do: Người dùng chọn phương án 2.A.
- [2026-11-25] Xây dựng mô hình tay cầm PBR (`fps_arms.glb` + `fps_arms.bundle.js`) trong `model/characters/fps_arms.py` bằng Python thuần + NumPy + Pillow với các khớp động tách rời (`left_arm_rig`, `left_hand_group`, `left_watch`, `right_hand_group`, `right_index_joint_0`), cân chỉnh tông da ấm không cháy sáng kèm tay áo camo xắn khuỷu — Lý do: Người dùng chọn phương án 1.A + 2.A để giữ nguyên animation nạp đạn/bóp cò trên nền `createFPSArms()`.
- [2026-11-25] Mở rộng game sang PvP mạng LAN phong cách Truy Kích và tái cấu trúc sang kiến trúc `server/` (`index.js`, `protocol.js`, `ws.js`, `RoomManager.js`, `Room.js`, `Match.js`, `spawn.js`, `modes/TDM.js`, `modes/FFA.js`) + `public/` (`FPS.html`, `js/{net,lobby,room,game}.js`), bỏ ô nhập URL/nút Kết nối, bỏ phòng mồi cứng khi khởi động, cấp session token `sessionStorage` (kèm handoff `localStorage` 28s khi đóng tab), và chọn `0.0.0.0:8090` + `autoFallback` làm cổng LAN mặc định — Lý do: Loại bỏ lỗi bạn bè LAN kết nối nhầm `localhost`, tách rõ trách nhiệm Server Authority và Client Rendering, đảm bảo 6 tình huống biên và test đa tab độc lập.
- [2026-11-25] Hợp nhất v2.1 theo lựa chọn người dùng (`1A, 2A, 3A`) + kế hoạch Input 3 lớp: dùng chung `server/weapons.js` (`/js/weapons.js`) cho 3 súng (`M416`, `Glock-17`, `AWM Sniper`) với băng dự trữ vô hạn + nạp chiến thuật/rỗng, Input `e.code` (`InputController` + `settings.js` lưu `localStorage`, `KeyC`/`ControlLeft` tránh `Ctrl+W`, `beforeunload`, click khóa chuột không bắn nhầm), vật lý `60 Hz`, đồng bộ `flags` bitmask & hitbox ngồi phía server, và vật liệu `TeamColor` (`A: #2F80FF ▲`, `B: #FF4D2E ●`, `FFA: #8A8F98`) kèm Radar + tâm đỏ trỏ địch — Lý do: Chống gian lận đạn/vị trí hoàn toàn từ server, không kẹt phím Alt+Tab/IME, và phân biệt đội rõ ở 30m trong mưa cả khi mù màu.
- [2026-11-25] Nâng cấp vũ khí phím `2` (`Glock-17 Tactical Pistol` Gen4/Gen5) theo lựa chọn `1A ; 2A`: dựng bằng pipeline Python glTF 2.0 (`model/weapons/pistol.py` -> `model/dist/pistol.glb` + `pistol.bundle.js`) với 5 cụm cơ khí tách rời (`pistol_slide`, `pistol_barrel`, `pistol_frame`, `pistol_trigger`, `pistol_mag`), texture PBR anodized bead-blasted + vết xước + giọt nước mưa + vân nhám kim tự tháp `stippling` + thước ngắm dạ quang 3 chấm `Tritium` (`#39ff14`), nâng sức chứa băng đạn tiêu chuẩn lên `15` viên (`15 / ∞`), tích hợp khóa trượt mở khi hết đạn (`slide lock`), tư thế cầm 2 tay chiến thuật FPP và hiển thị Glock-17 trên nhân vật góc nhìn thứ 3 trong LAN PvP — Lý do: Người dùng duyệt kế hoạch và chọn `1A ; 2A`.
- [2026-11-25] Thay thế mô hình tay FPP procedural trước đây trong `model/characters/fps_arms.py` bằng pipeline chuyển đổi `fps_arms.glb` có xương (`1` `SkinnedMesh` `armmesh_Mat_0`, `47` joints): `build_fps_arms_glb(texture_size=512, source_path=None)` chuyển `KHR_materials_pbrSpecularGlossiness` sang glTF 2.0 `pbrMetallicRoughness` (resize 4 texture về `texture_size`, bọc `arms_root` `scale=0.01`, `rotation=[0,1,0,0]` tức `rotY=π`, `extras=FPS_ARMS_METADATA`) và xuất `model/dist/fps_arms.glb` (`1,082,400 B`) + `fps_arms.bundle.js` (`1,443,464 B`) — Lý do: Nâng chất lượng tay găng chiến thuật thật và đồng bộ chuẩn PBR/hệ tọa độ Three.js.
- [2026-11-25] Theo dõi bản dự phòng `model/assets/fps_arms.glb` (`10,314,692 B`) trong Git làm fallback cho `build_fps_arms_glb()` khi không có `fps_arms.glb` ở thư mục gốc — Lý do: Đảm bảo `python -m model.build` và unit test luôn chạy độc lập trên mọi máy/worktree.
- [2026-11-25] Tách module IK 2 xương giải tích `public/js/arm_rig.js` (`solveTwoBoneArmIK`, `SKINNED_ARM_POSES` cho `m416`/`pistol`/`sniper`, `createSkinnedArmsController`) vận hành trên `L_arm_01/L_elbow_02/L_wrist_03`, `R_arm_023/R_elbow_024/R_wrist_025` (chiều dài `0.2587m` / `0.2543m`) kèm gập ngón & bóp cò `R_point1_030..R_point3_032`, tích hợp vào `gunAnim()` và `hydratePbrMaterial` (`aoMap`/skinning) trong `public/js/game.js` — Lý do: Điều khiển tự nhiên bộ xương 47 joints theo từng vũ khí và hoạt ảnh nạp đạn/bắn mà không phụ thuộc animation nhúng ngoài.
- [2026-11-26] Ghi công chuẩn giấy phép **CC-BY-4.0** cho model gốc `"fps arms"` của tác giả **DJMaesen** (<http://creativecommons.org/licenses/by/4.0/>, nguồn <https://sketchfab.com/3d-models/fps-arms-08ec4403a47645d8ad80633abf13d39d>) trong `model/README.md` và `README.md`, nêu rõ đã chuyển đổi/giảm cỡ texture và chuẩn hóa `arms_root` — Lý do: Tuân thủ đầy đủ điều khoản ghi công và khai báo chỉnh sửa của `CC-BY-4.0`.
- [2026-11-26] Giải quyết conflict khi pull `origin/main` (`cd2b57d`) + `stash@{0}` theo hướng giữ điểm mạnh của cả hai bản: dùng converter modular + fallback `model/assets/fps_arms.glb` + test hermetic từ PR #1, kết hợp với metadata `leftHandBasis`/`rightHandBasis`/`attribution`, hệ thống socket gắn tay trên `m416.py`/`pistol.py`, camera viewmodel riêng `vmCam` (`FOV 62->50`, `near=0.01`), IK chống xoắn + protraction vai trong `public/js/arm_rig.js` & `public/js/game.js` (giữ guard `!ctrl.ready`), đồng thời loại `__pycache__/*.pyc` khỏi Git qua `.gitignore` — Lý do: Giữ chất lượng kiểm thử & fallback của upstream mà không làm mất bản nâng cấp socket/vmCam và chặn conflict file `.pyc` tái diễn.

## 3. Việc cần làm (TODO)

- [x] Khởi tạo `agents/context.md` và khảo sát kiến trúc hiện tại của `FPS.html`
- [x] Phân tích yêu cầu (BA), lập kế hoạch kỹ thuật (Solution Architect) và nhận phê duyệt từ người dùng (Tech Lead)
- [x] Triển khai PBR Environment Map, súng M416 3D chi tiết cao, tay nhân vật giải phẫu học và hoạt ảnh nạp đạn/bóp cò/ADS trong `FPS.html` — Vai trò: Frontend Developer
- [x] Viết & chạy kiểm thử tự động theo AAA (Happy/Unhappy Path) và thẩm định hình ảnh trực tiếp trên trình duyệt — Vai trò: QA / Tester
- [x] Rà soát bảo mật OWASP & thực hiện Code Review độc lập — Vai trò: Security Engineer & Code Reviewer
- [x] Tạo mới `README.md` và cập nhật tổng kết vào `agents/context.md` — Vai trò: Technical Writer & Tech Lead
- [x] Xây dựng `model/core/` (geometry bevel/extrude, texture PBR giọt nước mưa, exporter glTF 2.0 `.glb` + `.bundle.js`) và `model/weapons/m416.py` + `model/build.py` — Vai trò: Backend/Tooling Developer (Python) — Ưu tiên: cao
- [x] Viết & chạy unit test Python theo chuẩn AAA kiểm tra `.glb` & `.bundle.js` — Vai trò: QA / Tester — Ưu tiên: cao
- [x] Tích hợp `GLTFLoader` + hydrate vật liệu `MeshPhysicalMaterial` + căn chỉnh `POSE` tay FPP & animation trong `FPS.html` — Vai trò: Frontend Developer — Ưu tiên: cao
- [x] Kiểm thử trình duyệt thực tế & thẩm định hình ảnh viewmodel M416 mới — Vai trò: QA / Tester — Ưu tiên: cao
- [x] Rà soát bảo mật, Code Review và cập nhật `model/README.md`, `README.md`, `agents/context.md` — Vai trò: Security Engineer, Code Reviewer, Technical Writer, Tech Lead — Ưu tiên: trung bình
- [x] Bổ sung `create_capsule`, `create_torus`, `create_tube_along_curve` và texture da/găng tay PBR (`create_realistic_skin_textures`, `create_glove_textures`) vào `model/core/` — Vai trò: Backend/Tooling Developer (Python) — Ưu tiên: cao
- [x] Xây dựng `model/characters/fps_arms.py`, mở rộng `model/build.py` xuất `fps_arms.glb` + `fps_arms.bundle.js` và viết unit test AAA — Vai trò: Backend/Tooling Developer & QA — Ưu tiên: cao
- [x] Tích hợp `fps_arms` GLB vào `FPS.html` (hydrate `sheen`/PBR chuẩn r128, bind animation bóp cò/nạp đạn) và kiểm thử trình duyệt + ảnh chụp — Vai trò: Frontend Developer & QA — Ưu tiên: cao
- [x] Rà soát bảo mật, Code Review và cập nhật tài liệu — Vai trò: Security Engineer, Code Reviewer, Technical Writer, Tech Lead — Ưu tiên: trung bình
- [x] Dựng mô hình nhân vật chiến binh PBR `model/characters/soldier.py` -> `soldier.glb` + `.bundle.js` và unit test AAA — Vai trò: Backend/Tooling Developer (Python) & QA — Ưu tiên: cao
- [x] Xây dựng server mạng LAN Node.js thuần `lan/` (`ws.js`, `map_data.js`, `game_room.js`, `server.js`) + suite test `node --test` — Vai trò: Backend/DevOps Engineer (Node.js) & QA — Ưu tiên: cao
- [x] Tích hợp Sảnh LAN, TDM/FFA HUD, Killfeed, bảng điểm `Tab` và `NetPlayers` (`soldier.glb` + `m416`) vào `FPS.html` (giữ chế độ Solo Drone) — Vai trò: Frontend Developer — Ưu tiên: cao
- [x] Kiểm thử ghép phòng 2 người chơi thật trên trình duyệt headless (Headshot, TDM/FFA, hồi sinh), rà soát bảo mật OWASP, Code Review & cập nhật tài liệu — Vai trò: QA, Security Engineer, Code Reviewer, Technical Writer, Tech Lead — Ưu tiên: cao
- [x] Tái cấu trúc Backend sang `server/` (`index.js`, `ws.js`, `protocol.js`, `RoomManager.js`, `Room.js`, `Match.js`, `spawn.js`, `modes/TDM.js`, `modes/FFA.js`) với vòng đời `WAITING -> STARTING -> PLAYING -> ENDING -> WAITING` & session token reconnect 30s — Vai trò: Backend Developer — Ưu tiên: cao
- [x] Tách module Frontend sang `public/` (`FPS.html`, `js/net.js`, `js/lobby.js`, `js/room.js`, `js/game.js`), bỏ ô nhập URL/nút Kết nối, thêm Phòng chờ 2 cột + Ready/Host/Kick/Password/Chat & nội suy 100ms — Vai trò: Frontend Developer — Ưu tiên: cao
- [x] Viết & chạy kiểm thử cho 6 tình huống biên (Mục 10) + kịch bản E2E 3 tab chạy trọn vòng đời trận không reload, dọn mã nguồn `lan/` cũ, rà soát bảo mật & cập nhật tài liệu — Vai trò: QA, Security Engineer, Code Reviewer, Technical Writer, Tech Lead — Ưu tiên: cao
- [x] Hoàn tất v2.1 (`R1–R5`, `T1–T4`, `I1–I8`): `server/weapons.js`, nạp đạn vô hạn dự trữ + `TOL=80ms` + `event.reload`/`ammo`/`switchWeapon`, `InputController` + `settings.js`, vật lý `60Hz` + ngồi/coyote/anti-bhop, `soldier.glb` `TeamColor` `#2F80FF ▲`/`#FF4D2E ●`/`#8A8F98` + Radar + tâm ngắm đỏ, và nghiệm thu toàn bộ unit + E2E Playwright (gồm `30m` mưa & mù màu) — Vai trò: Toàn đội IT — Ưu tiên: cao
- [x] Cài `uv` (`0.13.10`), build `model/dist/` (`m416`, `pistol`, `fps_arms`, `soldier`) và khởi động server Node.js tại `0.0.0.0:8090` trên Windows — Vai trò: DevOps Engineer — Ưu tiên: cao
- [x] Khảo sát `fps_arms.glb` mới và lập kế hoạch tích hợp (`docs/superpowers/plans/2026-11-25-skinned-fps-arms-integration.md`) — Vai trò: Tech Lead & Solution Architect — Ưu tiên: cao
- [x] Thực thi tích hợp `fps_arms.glb` (chuyển đổi PBR glTF 2.0 + IK 2 xương `public/js/arm_rig.js` + `public/js/game.js` + tài liệu & ghi công `CC-BY-4.0`) — Vai trò: Python Model Dev, Frontend Dev, QA, Security, Reviewer, Technical Writer — Ưu tiên: cao
- [x] Sửa keyword argument `outer=`/`inner=` thành `outer_pts=`/`inner_pts=` trong `model/tests/test_pistol_model.py:56,63` — Vai trò: QA / Tester — Ưu tiên: thấp
- [x] Giải quyết toàn bộ 22 merge conflict sau `git pull` (`cd2b57d` vs `stash@{0}`), gỡ tracking `__pycache__/*.pyc`, cập nhật `.gitignore`, rebuild `model/dist/` và xác minh 23/23 Python + 11/11 Node tests PASS — Vai trò: Tech Lead, Developer, QA, Security — Ưu tiên: cao
- [ ] Xác nhận & lập kế hoạch "các bước sau" với người dùng (tích hợp `toon_m416.glb`, `pistol.glb`, `awm.glb`/`m200.glb` & `sound/*/*.wav`, hoặc kiểm thử trình duyệt & commit bản hiện tại) — Vai trò: Tech Lead, BA, Solution Architect — Ưu tiên: cao

## 4. Nhật ký bàn giao (mới nhất ở trên cùng)

### [2026-11-26 01:56] Giải quyết Merge Conflict sau `git pull` & Xác minh toàn bộ test — Vai trò: Tech Lead, Developer, QA & Security Engineer

- **Đã làm:**
  - Phân tích nguyên nhân conflict: `main` fast-forward lên PR #1 (`cd2b57d`), sau đó pop `stash@{0}` (`7f2909e` tạo từ `206558d`) chứa bản nâng cấp socket gắn tay + camera `vmCam` + bộ asset súng `.glb` & âm thanh `.wav` mới, gây 22 đường dẫn unmerged (7 file nguồn/test + 15 file `__pycache__/*.pyc`).
  - Hợp nhất sạch mã nguồn Python (`model/build.py`, `model/characters/__init__.py`, `model/characters/fps_arms.py`, `model/tests/test_arms_model.py`): giữ bộ chuyển đổi PBR modular + fallback `model/assets/fps_arms.glb` + test hermetic từ PR #1, bổ sung metadata `attribution`/`leftHandBasis`/`rightHandBasis` và assert tương ứng, xóa hàm trùng lặp do merge dở.
  - Hợp nhất sạch mã nguồn JS & test (`public/js/arm_rig.js`, `public/js/game.js`, `server/tests/test_arm_rig.mjs`, `server/tests/test_lan_v2.js`): dùng kiến trúc socket 0mm-drift + camera `vmCam` + IK chống xoắn + trigger discipline từ stash, giữ guard `!ctrl || !ctrl.ready` & nhận diện vật liệu `material`/`Arms_SkinnedGlove`/`armmesh` từ upstream, và cập nhật assert hermetic trong `test_lan_v2.js`.
  - Gỡ tracking toàn bộ `model/**/__pycache__/*.pyc` khỏi Git index và thêm `__pycache__/`, `*.py[cod]`, `*$py.class` vào `.gitignore`.
  - Build lại `model/dist/` (`m416`, `pistol`, `fps_arms`, `soldier`) và chạy kiểm thử đầy đủ:
    - `git diff --check` / `git diff --cached --check`: **0 lỗi, 0 unmerged paths**.
    - Python (`unittest discover -s model/tests -v`): **23/23 PASS** (`2.995s`, bao gồm `test_pistol_model.py` đã xanh).
    - Node.js (`node --test server/tests/test_lan_v2.js server/tests/test_arm_rig.mjs`): **11/11 PASS** (`3.30s`).
    - Security grep (`innerHTML|dangerouslySetInnerHTML|eval\(|document\.write`): **0 match**.
- **File ảnh hưởng:** `.gitignore`, `model/build.py`, `model/characters/__init__.py`, `model/characters/fps_arms.py`, `model/tests/test_arms_model.py`, `public/js/arm_rig.js`, `public/js/game.js`, `server/tests/test_arm_rig.mjs`, `server/tests/test_lan_v2.js`, `agents/context.md`, và gỡ index `model/**/__pycache__/*.pyc`.
- **Đang dở / vướng:** Chưa rõ cụ thể "các bước sau" người dùng muốn ưu tiên trước (tích hợp các file `toon_m416.glb`, `pistol.glb`, `awm.glb`/`m200.glb` & `sound/*/*.wav` đang staged, hay kiểm thử trình duyệt & commit/drop `stash@{0}` trước).
- **Bước tiếp theo:** Chờ người dùng xác nhận mục tiêu tiếp theo trước khi lập kế hoạch/triển khai theo Mục 3 `GEMINI.md` (vai trò tiếp nhận: Tech Lead / BA / Solution Architect).
- **Câu hỏi còn mở:** Người dùng muốn tiếp tục tích hợp các model súng `.glb` và âm thanh `.wav` mới, hay muốn kiểm thử trình duyệt và commit bản fix conflict hiện tại trước?

### [2026-11-26 01:02] Hoàn tất tích hợp tay `fps_arms.glb` (SkinnedMesh 47 xương, IK 2 xương) & Tài liệu — Vai trò: Toàn đội (Python Model Dev, Frontend Dev, QA, Security, Technical Writer, Tech Lead)

- **Đã làm:**
  - **Pipeline chuyển đổi `model/characters/fps_arms.py` & Asset fallback:** Thay dựng tay procedural bằng `build_fps_arms_glb(texture_size=512, source_path=None)` chuyển `KHR_materials_pbrSpecularGlossiness` → `pbrMetallicRoughness`, resize 4 texture `2048×2048` → `512×512`, bọc `arms_root` (`scale=0.01`, `rotation=[0,1,0,0]`, `extras=FPS_ARMS_METADATA`), theo dõi bản fallback `model/assets/fps_arms.glb` và viết lại `model/tests/test_arms_model.py`.
  - **IK 2 xương & Tích hợp Engine (`public/js/arm_rig.js`, `public/js/game.js`):** Triển khai `solveTwoBoneArmIK`, `SKINNED_ARM_POSES` (`m416`, `pistol`, `sniper`), `createSkinnedArmsController` (gập ngón & bóp cò `R_point1_030..R_point3_032`, chuyển tiếp nạp đạn chiến thuật mượt, tắt `frustumCulled`), tích hợp vào `gunAnim()`, nâng cấp `hydratePbrMaterial` hỗ trợ `aoMap`/skinning và dọn helper tay cũ; thẩm định ảnh chụp hiệu chỉnh trên Chrome headless cho M416 / Glock-17 / AWM.
  - **Tài liệu & Ghi công (`model/README.md`, `README.md`, `agents/context.md`):** Cập nhật cây thư mục, node/bone mới của `fps_arms.glb`, hướng dẫn build/test và ghi công **DJMaesen** (`CC-BY-4.0`, nguồn Sketchfab, ghi chú đã chuyển đổi/chỉnh sửa).
  - **Kiểm thử & Bảo mật:**
    - Security grep (`innerHTML|dangerouslySetInnerHTML|eval\(|document\.write`) trên `public/js/arm_rig.js` và `public/js/game.js`: **0 match**.
    - Node.js (`node --test server/tests/test_lan_v2.js server/tests/test_arm_rig.mjs`): **8/8 PASS** (`281.83ms`, gồm `5` test LAN + `3` test `arm_rig`).
    - Python (`uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m unittest discover -s model/tests -v`): **22/23 PASS**, **1 ERROR** có sẵn từ trước ở `model/tests/test_pistol_model.py:56` (`outer=` thay vì `outer_pts=`).
- **File ảnh hưởng:** `model/characters/fps_arms.py`, `model/characters/__init__.py`, `model/build.py`, `model/assets/fps_arms.glb`, `model/tests/test_arms_model.py`, `public/js/arm_rig.js`, `public/js/game.js`, `server/tests/test_arm_rig.mjs`, `server/tests/test_lan_v2.js`, `model/README.md`, `README.md`, `agents/context.md`.
- **Đang dở / vướng:** Không có (ngoại trừ lỗi test có sẵn ở `model/tests/test_pistol_model.py:56` nằm ngoài phạm vi task này).
- **Bước tiếp theo:** Review / merge nhánh `feat/skinned-fps-arms` về `main` (hoặc sửa `test_pistol_model.py:56,63` nếu người dùng yêu cầu).
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 20:03] Lập kế hoạch tích hợp `fps_arms.glb` (SkinnedMesh 47 xương) — Vai trò: Tech Lead & Solution Architect

- **Đã làm:**
  - Kiểm tra cấu trúc nhị phân glTF 2.0 của `fps_arms.glb` gốc (`10,314,692 B`, author `DJMaesen`, `CC-BY-4.0`): `1` `SkinnedMesh` (`armmesh_Mat_0`, `4,026` đỉnh), `47` joints (`_rootJoint` → `L_arm_01`/`L_elbow_02`/`L_wrist_03` + 5 ngón, `R_arm_023`/`R_elbow_024`/`R_wrist_025` + 5 ngón), không có animation nhúng sẵn, dùng `KHR_materials_pbrSpecularGlossiness` với 4 texture `2048×2048` PNG, đơn vị centimet (`scale=0.01`) hướng `+Z` (`rotY=π` để quay về `-Z`).
  - Lập kế hoạch 4 task chi tiết tại `docs/superpowers/plans/2026-11-25-skinned-fps-arms-integration.md` (chuyển đổi PBR + chuẩn hóa root ở `model/characters/fps_arms.py`, module IK 2 xương `public/js/arm_rig.js` khớp `PUBLIC_JS_RE`, tích hợp `public/js/game.js`, tài liệu & ghi công `CC-BY-4.0`).
- **File ảnh hưởng:** `docs/superpowers/plans/2026-11-25-skinned-fps-arms-integration.md`, `agents/context.md`.
- **Đang dở / vướng:** Chờ người dùng duyệt kế hoạch và chọn phương án thực thi (`Subagent-driven` hoặc `Native`).
- **Bước tiếp theo:** Thực thi từng task theo kế hoạch đã duyệt.
- **Câu hỏi còn mở:** Người dùng chọn `Subagent-driven` hay `Native` (và có muốn giữ nguyên file gốc `fps_arms.glb` ở root làm nguồn build không).

### [2026-11-25 19:53] Build model 3D và khởi động server game trên Windows — Vai trò: Tech Lead & DevOps Engineer

- **Đã làm:**
  - Xác minh môi trường Windows có `Node.js v24.18.0`, chưa có Python nên đã cài `astral-sh.uv` `0.13.10` qua `winget` và chạy bằng Python `3.12.16` kèm `numpy`, `Pillow`.
  - Chạy `node --test server/tests/test_lan_v2.js`: **5/5 PASS** (`362.49ms`).
  - Chạy `uv run --python 3.12 --with "numpy>=1.24.0" --with "Pillow>=9.5.0" python -m unittest discover -s model/tests -v`: **19/20 PASS**, **1 ERROR** có sẵn tại `model/tests/test_pistol_model.py:56` (`extrude_hollow_profile() got an unexpected keyword argument 'outer'`, do chữ ký trong `model/core/geometry.py:632` dùng `outer_pts`, `inner_pts`).
  - Build thành công toàn bộ 4 asset vào `model/dist/` qua `python -m model.build`: `m416` (`1,589,340 B` `.glb` / `2,119,380 B` `.bundle.js`), `pistol` (`2,052,612 B` / `2,737,078 B`), `fps_arms` (`790,368 B` / `1,054,088 B`), `soldier` (`1,037,788 B` / `1,383,983 B`).
  - Khởi động daemon `node server/index.js` lắng nghe `0.0.0.0:8090` (`http://localhost:8090/FPS.html`, `http://192.168.1.161:8090/FPS.html`, `http://172.19.112.1:8090/FPS.html`).
  - Gọi subagent `browser` để mở `http://localhost:8090/FPS.html`, nhưng không kết nối được Chrome vì thiếu `DevToolsActivePort` (chưa bật remote debugging).
- **File ảnh hưởng:** `model/dist/*` (gitignored), `agents/context.md`.
- **Đang dở / vướng:** Chưa mở được tab Chrome tự động do chưa bật `chrome://inspect/#remote-debugging`.
- **Bước tiếp theo:** Người dùng mở `http://localhost:8090/FPS.html` (hoặc chia sẻ link LAN cho máy khác) để vào game; nếu muốn AI mở và kiểm tra trực tiếp trên Chrome, bật `chrome://inspect/#remote-debugging` rồi nhắn lại.
- **Câu hỏi còn mở:** Có muốn sửa lỗi keyword argument trong `model/tests/test_pistol_model.py` không?

### [2026-11-25 17:35] Hoàn tất v2.1: Đa vũ khí nạp đạn vô hạn, Phân biệt Đội 30m & Input 3 lớp 60Hz — Vai trò: Toàn bộ đội IT

- **Đã làm:**
  - **Shared Config & Assets:** Tạo `server/weapons.js` (serve tại `/js/weapons.js`) định nghĩa `M416`, `Glock-17`, `AWM Sniper` (`tacticalReloadTime` vs `reloadTime`), `FLAG` bitmask và `TEAM_META`. Nâng cấp `model/characters/soldier.py` gắn `TeamColor` lên mảng mũ, vai rộng, ngực, lưng và build lại `soldier.glb` (`1,038,544 B`) + `soldier.bundle.js` (`1,384,986 B`).
  - **Backend (`server/`):** Cập nhật `protocol.js` & `index.js` thêm `SWITCH_WEAPON`, `EVENT_RELOAD`, `AMMO`. Nâng cấp `Match.js`, `Room.js`, `RoomManager.js`: giữ `weapons` map từng súng, `tickWeapon` với `TOL = 80ms`, tự nạp khi `mag = 0`, hủy nạp khi đổi súng/chết, hồi sinh đầy mọi súng, chặn bắn khi `FLAG.SPRINT`, kiểm tốc độ và hitbox theo tư thế ngồi (`FLAG.CROUCH`, đầu `1.08m`), trả `AMMO` chỉnh lệch & giữ nguyên `mag` từng súng khi reconnect bằng token trong `30s`.
  - **Frontend (`public/`):** Tách mới `public/js/settings.js` (lưu `localStorage`, Hold/Toggle, gán phím) và `public/js/input.js` (dùng `e.code`, `blur`/`visibilitychange`/`pointerlockchange` tự `reset()`, `{ passive: false }` wheel, chặn bắn ở click khóa chuột đầu, chừa `F5/F11/F12/Alt`). Cập nhật `game.js`, `room.js`, `FPS.html`: bước vật lý `60Hz`, Jump buffer/Coyote/anti-bhop, Ngồi + ceiling raycast, HUD `mag / ∞` + SVG progress ring + `"Nạp đạn (R)"`, Sniper scope overlay, Radar đồng đội/địch nổ súng `2s`, tâm ngắm đổi đỏ khi trỏ địch, 3 shared `TeamColor` material + nameplate chỉ hiện đồng đội TDM, `Esc` trong PvP không đóng băng trận, `beforeunload` bảo vệ `Ctrl+W`.
  - **Kiểm thử & Bảo mật:** `SECURITY_GREP_CLEAN`; Python `16/16 PASS` (`1.201s`); Node.js `5/5 PASS` (`145.69ms`); Playwright `verify_lan_v2_1_e2e.py` (`LAN_V2_1_FULL_E2E_PASSED`, đã thẩm định ảnh chụp 30m trong mưa, giả lập mù màu `protanopia`, kính ngắm Sniper + tâm đỏ và màn ENDING) và `verify_lan_v2_e2e.py` (`LAN_V2_E2E_ALL_CHECKS_PASSED`, 0 console/pageerror).
- **File ảnh hưởng:** `server/weapons.js`, `server/protocol.js`, `server/index.js`, `server/Room.js`, `server/RoomManager.js`, `server/Match.js`, `server/tests/test_lan_v2.js`, `model/characters/soldier.py`, `model/dist/soldier.*`, `public/FPS.html`, `public/js/{input,settings,room,game}.js`, `README.md`, `model/README.md`, `agents/context.md`.
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Người dùng chạy `node server/index.js` tại `/home/dev_ntd/Documents/FPS` để host game cho mạng LAN.
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 16:31] Hoàn tất tái cấu trúc Truy Kích LAN PvP v2 (`server/` + `public/`) — Vai trò: Toàn bộ đội IT

- **Đã làm:**
  - **Backend (`server/`):** Xây dựng Node.js v22 thuần (`protocol.js`, `ws.js`, `spawn.js`, `modes/TDM.js`, `modes/FFA.js`, `Match.js`, `Room.js`, `RoomManager.js`, `index.js`). Áp dụng Server Authority toàn phần, không tạo phòng mồi cứng khi khởi động, giữ nguyên tên phòng/mật khẩu do Host nhập, heartbeat ping/pong `5s`/`15s`, giữ ghế & K/D trong `30s` theo token, chuyển Host hoặc hủy `STARTING` khi Host rời, xác thực đạn (`invulnerable` tự mất khi bắn, kiểm tra tốc độ `<=12 m/s`, tầm `<=120m` và đường ngắm `hasLineOfSight`), FFA spawn ưu tiên điểm khuất tầm nhìn địch.
  - **Frontend (`public/`):** Tách sạch sang `public/FPS.html` và `public/js/{net,lobby,room,game}.js` (dùng chung `/js/protocol.js`). Loại bỏ hoàn toàn `#wsUrlInput` trùng lặp và nút Kết nối thủ công; tự kết nối `ws(s)://${location.host}/ws`; đồng bộ cập nhật tên người chơi khi `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_QUICK`; khắc phục F5/`pagehide` token handoff giữa các tab; đồng nhất giao diện card tối `rgba(11, 18, 26, 0.94)` tương phản cao + hỗ trợ click/Resume khóa chuột sau `MATCH_START` bất đồng bộ.
  - **Dọn dẹp & Bảo mật:** Xóa thư mục `lan/` cũ và chuyển `FPS.html` gốc thành trang trỏ tới `public/FPS.html`; kiểm tra XSS (`0` lần dùng `innerHTML`, `dangerouslySetInnerHTML`, `eval`, `document.write`), HTTP static allowlist chặn path traversal (`/%2e%2e/server/index.js` -> `404`).
  - **Kiểm thử tổng lực sau lần sửa cuối:** Python unit tests `16/16 PASS` (`1.206s`), Node.js server tests `4/4 PASS` (`136.76ms`, gồm cả 6 edge case Mục 10), Playwright 3-tab Chrome headless E2E PASS (`LAN_V2_E2E_ALL_CHECKS_PASSED`, 0 console/pageerror, kiểm tra Lobby push realtime, sai/đúng mật khẩu, chat phòng, Host Kick, Host settings + reset ready, countdown `5s`, bắn Headshot TDM sang màn `ENDING`, `"Về phòng ngay"`, đóng & mở lại tab trong `30s` khôi phục ghế, và Offline Drone).
- **File ảnh hưởng:** `server/*`, `public/FPS.html`, `public/js/*`, `FPS.html`, `README.md`, `model/README.md`, `agents/context.md` (đã gỡ bỏ `lan/*`).
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Người dùng chạy `node server/index.js` tại thư mục gốc và chia sẻ link LAN (`http://<IP-LAN>:8090/FPS.html`) cho bạn bè.
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 15:58] Xử lý xung đột `EADDRINUSE` cổng `8080` & tự động dò cổng trống — Vai trò: DevOps Engineer, Backend Developer & QA

- **Đã làm:**
  - Kiểm tra socket hệ thống (`ss -tlnp 'sport = :8080'`): cổng `8080` trên máy đang thuộc tiến trình dịch vụ khác ngoài dự án (`dev_ntd` không sở hữu PID nên không tắt cưỡng bức để đảm bảo an toàn hệ thống).
  - Nâng cấp `lan/server.js`: chuyển `DEFAULT_PORT = 8090` (đồng bộ placeholder/fallback trong `FPS.html`), bắt sự kiện `error` trên `httpServer.listen()` để tự động tăng sang cổng rảnh kế tiếp (`8091..`) khi chạy mặc định, hoặc in thông báo tiếng Việt thân thiện khi truyền `--port` cố định bị trùng.
  - Bổ sung unit test `EADDRINUSE` + `autoFallback` vào `lan/tests/test_lan_server.js` (`5/5` PASS trong `131.7ms`) và kiểm tra khởi chạy thực tế `node lan/server.js` mở thành công `0.0.0.0:8090` (`http://10.10.0.224:8090/FPS.html`).
- **File ảnh hưởng:** `lan/server.js`, `lan/tests/test_lan_server.js`, `FPS.html`, `README.md`, `agents/context.md`.
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Người dùng chạy `node lan/server.js` trực tiếp trên terminal (lắng nghe `8090`).
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 15:52] Hoàn tất PvP Mạng LAN (Truy Kích TDM/FFA) + `soldier.glb` PBR — Vai trò: Toàn bộ đội IT

- **Đã làm:**
  - **3D Assets (`model/`):** Thêm `create_soldier_textures()` vào `model/core/textures.py` và dựng chiến binh PBR có rig trong `model/characters/soldier.py`, build thành `soldier.glb` (`1,002,400 B`) & `soldier.bundle.js` (`1,336,794 B`, `25` nodes, `18` meshes, `16,462` verts, `25,512` tris); viết 3 test AAA trong `model/tests/test_soldier_model.py` (`16/16` unit test Python PASS trong `1.160s`).
  - **LAN Server (`lan/`):** Xây dựng Node.js v22 thuần 0 thư viện ngoài (`package.json`, `ws.js` RFC 6455, `map_data.js` tất định `MAP_SEED = 11042026`, `game_room.js` tick `25 Hz` TDM/FFA + headshot `100`/body `28`/limb `20` + shield `2s` + respawn `3s`, `server.js` HTTP allowlist & `/api/lan-info`); phát hiện & sửa lỗi typo GUID RFC 6455 khi ghép nối Chromium thật và thêm assert test vector chuẩn RFC (`4/4` Node test PASS trong `124.0ms`).
  - **Client (`FPS.html`):** Đồng bộ `mapSeed = 11042026` khớp server; nạp `soldier.glb` + nhân bản `m416` gắn tay đối thủ qua nội suy `80ms`; thêm Sảnh LAN (chia sẻ link copy, tạo/vào phòng TDM/FFA, đổi phe), giữ mục **Luyện tập Offline (Drone)** không hồi quy; bổ sung HUD tỉ số/đồng hồ, Killfeed (tạo DOM an toàn bằng `textContent`), `HEADSHOT!` alert, âm thanh `snd.headshot`/`snd.remoteShot`, bảng điểm `Tab` và màn hồi sinh giữ pointer lock.
  - **QA & Security:** Chạy Playwright E2E 2 context trình duyệt thật qua HTTP + WebSocket LAN + `file://` Solo (`LAN PVP E2E VERIFICATION PASSED | killfeed='TacticalA [HEADSHOT] RivalB'`, 0 lỗi console/pageerror); rà soát XSS (`0` `innerHTML`/`eval`/`document.write`) và path traversal HTTP; cập nhật `model/README.md`, `README.md`, `agents/context.md`.
- **File ảnh hưởng:** `model/core/textures.py`, `model/core/__init__.py`, `model/characters/__init__.py`, `model/characters/soldier.py`, `model/build.py`, `model/tests/test_soldier_model.py`, `model/tests/test_m416_model.py`, `model/dist/soldier.glb`, `model/dist/soldier.bundle.js`, `lan/package.json`, `lan/ws.js`, `lan/map_data.js`, `lan/game_room.js`, `lan/server.js`, `lan/tests/test_lan_server.js`, `FPS.html`, `model/README.md`, `README.md`, `agents/context.md`.
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Người dùng chỉ cần chạy `node lan/server.js` trên máy Host và mở link LAN hiển thị trong terminal để chơi cùng bạn bè.
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 15:04] Hoàn tất `fps_arms` PBR + rig animation & kiểm thử trực quan v3 — Vai trò: QA / Security Engineer / Code Reviewer / Technical Writer / Tech Lead

- **Đã làm:**
  - Hoàn thiện `model/core/geometry.py` (`create_capsule`, `create_torus`, `create_tube_along_curve`), `model/core/textures.py` (`create_realistic_skin_textures` với Gaussian subsurface mottling + gân mảnh + giọt nước viền mềm; `create_glove_textures` với vải đan olive, camo sleeve, mặt đồng hồ `#0c1418`/`#88ffcc`), `model/core/glb_exporter.py` (xuất `sheenColor`/`sheenRoughness`), và `model/characters/fps_arms.py` (28 nodes, 18 meshes, 11.572 đỉnh, 18.896 tam giác).
  - Tinh chỉnh hình học qua 3 vòng kiểm tra ảnh chụp: sửa dây đồng hồ (`watch_strap`) khớp lát cắt cẳng tay `(0.94, 1.0, 1.07)`, chỉnh ống tay áo camo oval khớp `curve_bow_x` tại khuỷu tránh hở cổ áo, xoay ngón cái C-clamp nằm xuôi dọc ray trái ốp lót tay, và tối ưu tư thế nắm + khung hình khi kéo khóa nòng (`_LEFT_CH_POS`, `_LEFT_CH_ROT`, bù `-0.048 * chW` ở `FPS.html`).
  - Xác minh `python3 -m unittest discover -s model/tests -v` đạt 13/13 PASS (`0.747s`), `python3 -m model.build` sinh `m416.glb` (`1,592,164 B`) + `fps_arms.glb` (`791,864 B`) + `.bundle.js`, và Playwright headless Chrome xác nhận 0 lỗi cả `file://` lẫn HTTP (`ARMS V3 VERIFICATION PASSED`, `trigger_flex=0.340 rad`).
  - Rà soát bảo mật & code quality: không có secrets/PII, không dùng `eval`/`innerHTML`, cập nhật đồng bộ `model/README.md` và `README.md`.
- **File ảnh hưởng:** `model/core/geometry.py`, `model/core/textures.py`, `model/core/glb_exporter.py`, `model/core/__init__.py`, `model/characters/__init__.py`, `model/characters/fps_arms.py`, `model/build.py`, `model/tests/test_arms_model.py`, `model/tests/test_m416_model.py`, `model/dist/m416.glb`, `model/dist/m416.bundle.js`, `model/dist/fps_arms.glb`, `model/dist/fps_arms.bundle.js`, `FPS.html`, `model/README.md`, `README.md`, `agents/context.md`.
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Sẵn sàng bàn giao người dùng chơi thử hoặc phát triển tiếp vũ khí / nhân vật / AI mới nếu có yêu cầu.
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 14:32] Hoàn tất nâng cấp M416 HK416 PBR, giọt nước 3D, tay FPP & bối cảnh cảng mưa — Vai trò: Toàn bộ đội IT

- **Đã làm:**
  - Nâng cấp `model/core/geometry.py` (`create_lathe`, `create_extruded_tube_frame`), `model/core/textures.py` (620 giọt nước 3D bán cầu + gradient Sobel + `gunmetal_albedo_png` & `polymer_albedo_png` vân xước), `model/core/glb_exporter.py` (`base_color_png`), và dựng lại `model/weapons/m416.py` với báng SOPMOD/HK416 đa khối, Upper nóc tròn, Lower có bolt catch/selector/magwell lip, EOTech hood vát hình thang + tem vàng + chốt QD, Quad-Rail hở lộ nòng thép, đầu/thước ngắm gập, loa bù giật `create_lathe`, băng đạn cong STANAG có 2 gân cong liền khối.
  - Sửa lỗi trục xoay lõi bát giác Quad-Rail `(math.pi * 0.5, math.pi / 8.0, 0.0)` phát hiện qua thẩm định ảnh chụp v2.
  - Nâng cấp `FPS.html`: sửa `hydrateM416Material` truyền `map: src.map`, làm đậm màu da tay kèm `skinNormTex` giọt nước, găng tay olive sẫm có đai cổ tay, đồng hồ mặt đen sát cổ tay, `HIP_POS` gần mắt hơn, mặt đường asphalt tối có `normalMap`/`roughnessMap`/`envMap` phản chiếu vũng nước, quầng sáng đèn cột & sương mù.
  - Chạy lại `python3 -m unittest discover -s model/tests -v` (8/8 PASS), `python3 -m model.build` (`m416.glb` 1,592,164 B; `m416.bundle.js` 2,123,143 B; 20 nodes, 15 meshes, 34,789 verts, 49,442 tris), và kiểm thử Chrome headless (`file://` + HTTP) + thẩm định 6 ảnh chụp v3 hoàn chỉnh.
- **File ảnh hưởng:** `model/core/geometry.py`, `model/core/textures.py`, `model/core/glb_exporter.py`, `model/core/__init__.py`, `model/weapons/m416.py`, `model/tests/test_m416_model.py`, `model/dist/*`, `model/README.md`, `FPS.html`, `README.md`, `agents/context.md`
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Báo cáo kết quả nâng cấp cho người dùng.
- **Câu hỏi còn mở:** Không còn.

### [2026-11-25 14:15] Hoàn tất pipeline Python `model/` & tích hợp M416 GLB vào `FPS.html` — Vai trò: Security Engineer, Code Reviewer, Technical Writer & Tech Lead

- **Đã làm:**
  - Xây dựng bộ Python thuần + NumPy + Pillow trong `model/` (`core/geometry.py`, `core/textures.py`, `core/glb_exporter.py`, `weapons/m416.py`, `build.py`), xuất `model/dist/m416.glb` (996,572 B, 18 nodes, 13 meshes, 22,576 verts, 32,066 tris) và `model/dist/m416.bundle.js` (1,329,019 B).
  - Viết 7 unit test AAA trong `model/tests/test_m416_model.py` (7/7 PASS).
  - Tích hợp `GLTFLoader` + hydrate vật liệu `MeshPhysicalMaterial` (`clearcoat`, kính ngắm trong suốt) và bind `mag_group`, `trigger_group`, `charging_handle`, `bolt_vis`, `reticle_group`, `laser_lens`, `laser_origin`, `muzzle_anchor` trong `FPS.html`, dọn các helper thân súng cũ không dùng.
  - Kiểm thử trên Google Chrome headless (Playwright) ở cả `file://` và HTTP server, thẩm định trực quan ảnh chụp để sửa khoang pin `batteryBox` EOTech che nửa dưới kính khi ADS (`OPTIC_Y = 0.098`), làm mịn giọt nước mưa (`uv_scale = 5.0`), và căn chỉnh ngón trỏ phải + tư thế kéo khóa nòng.
  - Rà soát bảo mật (validate kích thước/model_key, không secrets/eval/innerHTML), Code Review và cập nhật `model/README.md`, `README.md`, `agents/context.md`.
- **File ảnh hưởng:** `model/__init__.py`, `model/requirements.txt`, `model/build.py`, `model/README.md`, `model/core/*`, `model/weapons/*`, `model/tests/*`, `model/dist/*`, `FPS.html`, `README.md`, `agents/context.md`
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Báo cáo tổng kết và hướng dẫn chạy/build cho người dùng.
- **Câu hỏi còn mở:** Không còn.

### [2026-11-25 13:20] Hoàn tất tài liệu & Tổng kết bàn giao — Vai trò: Technical Writer & Tech Lead

- **Đã làm:** Tạo `README.md` đồng bộ với các tính năng và điều khiển mới trong `FPS.html`; cập nhật `agents/context.md` hoàn tất toàn bộ hạng mục.
- **File ảnh hưởng:** `README.md`, `agents/context.md`
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Báo cáo kết quả hoàn chỉnh cho người dùng.
- **Câu hỏi còn mở:** Không còn.

### [2026-11-25 13:19] Rà soát bảo mật & Code Review — Vai trò: Security Engineer & Code Reviewer

- **Đã làm:** Kiểm tra OWASP Top 10 (không có secrets, không dùng `innerHTML`, toàn bộ HUD cập nhật qua `textContent`, `localStorage` bọc `try/catch`); review 5 tiêu chí (Correctness, Security, Architecture/Performance với `bakeStatic` gộp mesh tĩnh và tái sử dụng vector tránh GC, Testability, Readability).
- **File ảnh hưởng:** `FPS.html` (đã xác nhận đạt chuẩn)
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Bàn giao Technical Writer tạo `README.md` và Tech Lead tổng kết (vai trò tiếp nhận: Technical Writer, Tech Lead).
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 13:18] Kiểm thử trình duyệt & Tinh chỉnh thị giác — Vai trò: QA / Tester & Frontend Developer

- **Đã làm:** Chạy kiểm thử tự động trên Google Chrome headless (Playwright) và kiểm tra ảnh chụp 6 góc (hipfire, ADS, giữa pha nạp đạn rút băng/kéo khóa nòng, cận cảnh trái/phải). Phát hiện và khắc phục các lỗi thực tế: (1) Lỗi TDZ gọi `gunAnim(0,0)` trước `let recoil`; (2) 404 favicon; (3) Đồng hồ tách khỏi cổ tay -> gắn lên `leftArm` ôm khít cổ tay; (4) Cylinder tay áo trên vung che camera khi nạp đạn -> bỏ cylinder thừa và hạ khuỷu tay trái động khi rút băng/kéo khóa nòng; (5) Tinh chỉnh độ gập ngón tay phải ôm báng/cò, hạ ngón cái trái dọc ốp M-LOK, chỉnh tông da và `HIP_POS` (`z = -0.51`). Chạy lại toàn bộ 5/5 test PASS, 0 lỗi console/pageerror.
- **File ảnh hưởng:** `FPS.html`, `agents/context.md`
- **Đang dở / vướng:** Không có.
- **Bước tiếp theo:** Bàn giao Security Engineer & Code Reviewer rà soát độc lập (vai trò tiếp nhận: Security Engineer, Code Reviewer).
- **Câu hỏi còn mở:** Không có.

### [2026-11-25 13:12] Hoàn tất triển khai Viewmodel M416 & bàn giao kiểm thử — Vai trò: Frontend Developer

- **Đã làm:** Tích hợp hoàn chỉnh viewmodel M416, tay hở ngón, đồng hồ, ADS chuột phải, laser phím `L`, render 2 pass vào `FPS.html`.
- **File ảnh hưởng:** `FPS.html`, `agents/context.md`
- **Đang dở / vướng:** Chuyển QA kiểm thử.
- **Bước tiếp theo:** QA / Tester kiểm thử và chụp ảnh đối chiếu.
- **Câu hỏi còn mở:** Không còn.

## 5. Ghi chú & Bài học

- Quy ước / ngữ cảnh riêng của dự án:
  - Các hàm `gunAnim(0,0)` / `updLaser()` tại khởi tạo bắt buộc đặt sau toàn bộ khai báo `let` trạng thái game (cuối script) để tránh lỗi Temporal Dead Zone.
  - Gắn phụ kiện cổ tay (đồng hồ) trực tiếp vào nhóm xương cẳng tay (`leftArm.arm`) thay vì gắn cứng vào `hand` giúp phụ kiện luôn bám sát bề mặt cổ tay khi cổ tay xoay lệch góc với cẳng tay.
