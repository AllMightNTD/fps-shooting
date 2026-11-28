# Balanced Truy Kích/CS Damage & Server-Authoritative Anti-Cheat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay thế cơ chế tính sát thương không cân bằng và hit-detection phía client bằng bảng sát thương Truy Kích/CS (có falloff theo cự ly cho M416, Glock-17, AWM dùng chung cho TDM & FFA) kết hợp Server-Authoritative Hitbox Raycast, Lag Compensation Rewind theo RTT đo từ server, và hệ thống chống cheat 5 lớp kèm auto-kick.

**Architecture:** Tách rõ 3 module thuần không phụ thuộc ngoài phía server: `server/hitreg.js` (hitbox đa vùng Stand/Crouch/Prone, ray-vs-sphere/OBB ưu tiên `head > body > limb`, và mô phỏng đạn đạo AWM), `server/lag_comp.js` (bộ đệm lịch sử tư thế 450ms + nội suy tua ngược neo theo RTT), và `server/anti_cheat.js` (kiểm tra `origin`, góc `dir`, và điểm vi phạm suy giảm theo thời gian). `server/Match.js` điều phối toàn bộ phát bắn ngay trong `handleFire`, vô hiệu hóa hoàn toàn `MSG.HIT` từ client, và `public/js/combat.js` chuyển sang gửi đủ `yaw/pitch/clientTime` trong `MSG.FIRE` đồng thời vẽ tia lửa trúng đạn từ `hitPoint` do server xác nhận.

**Tech Stack:** Node.js ESM (`node --test`), Vanilla Three.js r128 browser ES modules, RFC 6455 WebSocket thuần (`server/ws.js`), zero external runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-11-28-balanced-damage-server-anticheat-design.md](file:///d:/FPS/fps-shooting/docs/superpowers/specs/2026-11-28-balanced-damage-server-anticheat-design.md)

## Global Constraints

- Zero external runtime dependencies trong `server/` và `public/js/`; `server/weapons.js` và `server/protocol.js` phải chạy sạch trên cả Node.js và trình duyệt.
- Chỉ giữ 3 vũ khí hiện có (`m416`, `pistol`/Glock-17, `sniper`/AWM), cấu trúc cấu hình mở rộng dễ dàng khi thêm súng mới sau này.
- Dùng chung **1 bộ chỉ số sát thương & luật hitreg** cho cả TDM và FFA; không làm vỡ chế độ Solo Offline (Drone).
- Hệ tọa độ khớp Three.js `YXZ` (`forward = (-cos(pitch)*sin(yaw), sin(pitch), -cos(pitch)*cos(yaw))`), độ cao mắt `EYE_STAND = 1.70`, `EYE_CROUCH = 1.12`, `EYE_PRONE = 0.42`.
- Bảo mật OWASP (`GEMINI.md` Mục 4): kiểm tra `Number.isFinite` cho mọi input client, không tin dữ liệu client, không dùng `innerHTML`/`eval`, không log token/PII.
- Chạy `node scripts/build_static.mjs` sau khi hoàn tất để đồng bộ `dist-static/js/{weapons,protocol,combat,game}.js`.

## Review Focus

1. **Input dị dạng/độc hại (`NaN`, `Infinity`, vector `dir = (0,0,0)`, `clientTime` âm/tương lai, gửi `MSG.HIT` giả):** Server không bao giờ crash hay sinh `NaN` HP; luôn từ chối/clamp an toàn và ghi điểm vi phạm.
2. **Dịch chuyển tức thời khi hồi sinh trong cửa sổ rewind:** Khi nạn nhân chết ở vị trí A và hồi sinh ở vị trí B (`> 4m`), `sample()` không được nội suy ngang bản đồ và không cho bắn trúng người đang chết ở `evalTime` hoặc đã chết ở `now`.
3. **Bắn xuyên cửa sổ nhà kho / kính cabin xe (`moveOnly`) vs nấp sau vật cản `1.45m`:** `raycastArenaDistance` phải bỏ qua box/OBB gắn cờ `moveOnly`, trong khi đầu khi ngồi (`1.08 + 0.175 = 1.255m < 1.45m`) vẫn được che kín.
4. **Flick nhanh / Giật súng / Zeroing AWM hợp lệ không bị bắt nhầm Silent Aim:** `MSG.FIRE` cập nhật `player.yaw/pitch` trước khi đối chiếu `dir` trong nón `spread*2.5 + recoilAllowance`, nên flick 180° hợp lệ vẫn trúng 100%, còn giả mạo `dir` lệch góc nhìn bị chặn ngay.
5. **Lag mạng ngắn hạn vs Rapid-Fire / Speedhack kéo dài:** Dung sai cục bộ (`FIRE_JITTER_MS = 25ms`, quỹ `moveAllowance <= 1.2m`) cho phép người chơi thật không bị khựng, trong khi bắn đều `56ms`/viên trên M416 (`86ms`) hoặc tăng tốc kéo dài bị chặn và cộng điểm vi phạm.

---

## Bản đồ file ảnh hưởng

- **Tạo mới:**
  - `server/hitreg.js` — Hitbox Stand/Crouch/Prone, toán học ray-sphere/OBB, ưu tiên vùng `head > body > limb`, giải phát bắn hitscan & ballistic AWM.
  - `server/lag_comp.js` — Bộ đệm lịch sử tư thế 450ms, tính cửa sổ rewind theo RTT, nội suy có bảo vệ teleport hồi sinh.
  - `server/anti_cheat.js` — Kiểm tra `origin`, góc `dir`, và `AntiCheatTracker` suy giảm điểm + ngưỡng warn/kick.
  - `server/tests/test_damage_model.mjs` — Unit test AAA cho bảng sát thương Truy Kích/CS & falloff 3 vũ khí.
  - `server/tests/test_server_hitreg_anticheat.mjs` — Unit & integration test AAA cho hitbox, đạn đạo AWM, lag compensation, và toàn bộ 5 lớp chống cheat + auto-kick.
- **Chỉnh sửa:**
  - `server/weapons.js` — Cập nhật bảng damage Truy Kích/CS, thêm `damageFalloff`, `ballistics`, `computeFalloffMultiplier`, `computeWeaponDamage`.
  - `server/spawn.js` — Thêm `raycastArenaDistance` dùng chung cho `hitreg.js` và `hasLineOfSight`.
  - `server/protocol.js` — Thêm mã lỗi `ERR.CHEAT_DETECTED`, chú thích `MSG.HIT` deprecated.
  - `server/Room.js` — Thêm `kickForCheat(targetId, reason)` kèm callback `onAutoKick` và khởi tạo trường `moveAllowance`, `rttMs` cho player.
  - `server/RoomManager.js` — Ghi `session.lastPingSentAt`, tính `session.rttMs` (EMA) trong `recordPong`, truyền `onAutoKick` xuống `Room` để dọn `session.roomId` & cập nhật danh sách phòng.
  - `server/index.js` — Gọi `roomManager.recordPong` khi nhận `ws.on("pong")`; định tuyến `MSG.HIT` sang `room.match.handleDeprecatedClientHit`.
  - `server/Match.js` — Gỡ `pendingHitCredit`, tích hợp `hitreg.js` + `lag_comp.js` + `anti_cheat.js` vào `handleFire`, sửa fire-rate leaky debt & movement leaky budget trong `handleState`, dọn lịch sử khi `start`/`spawnPlayer`.
  - `public/js/combat.js` — Gỡ hoàn toàn `net.send(MSG.HIT, ...)`, bổ sung `yaw`, `pitch`, `clientTime`, `seq` trong `MSG.FIRE`, xuất `spawnHitSparks(point)`.
  - `public/js/game.js` — Truyền `INTERP_DELAY_MS` vào `createCombatSystem`; khi nhận `MSG.EVENT_HIT` có `ev.hitPoint` thì gọi `combat.spawnHitSparks(ev.hitPoint)`.
  - `server/tests/test_lan_v2.js` & `server/tests/test_military_map.mjs` — Cập nhật các case cũ đang gọi trực tiếp `handleHit` sang kiểm chứng `handleFire` server-authoritative với bảng damage mới.
  - `dist-static/*`, `README.md`, `agents/context.md` — Rebuild static bundle và cập nhật tài liệu + nhật ký bàn giao.

---

### Task 1: Bảng sát thương Truy Kích/CS & công thức Falloff trong `server/weapons.js`

**Files:**
- Modify: `server/weapons.js:48-172`
- Test: `server/tests/test_damage_model.mjs`

**Interfaces:**
- Consumes: `WEAPONS`, `resolveWeaponConfig`, `getMoveSpeedMultiplier`, `createDefaultWeaponsState` có sẵn trong `server/weapons.js`.
- Produces:
  - `WEAPONS.{m416,pistol,sniper}` bổ sung:
    - `damage`: `m416 { head: 90, body: 27, limb: 21 }`, `pistol { head: 72, body: 24, limb: 18 }`, `sniper { head: 180, body: 115, limb: 80 }`
    - `fireInterval`: `m416: 86`, `pistol: 150`, `sniper: 1300`
    - `baseSpread`: `m416: 0.0065`, `pistol: 0.0055`, `sniper: 0.042`
    - `adsSpread`: `m416: 0.0006`, `pistol: 0.0009`, `sniper: 0.0002`
    - `moveSpeedMult`: `m416: 0.95`, `pistol: 1.05`, `sniper: 0.84`
    - `equipTimeMs`: `m416: 520`, `pistol: 240`, `sniper: 780`
    - `damageFalloff`: `m416 { startDist: 30, endDist: 95, minMultiplier: 0.78 }`, `pistol { startDist: 20, endDist: 65, minMultiplier: 0.65 }`, `sniper { startDist: 65, endDist: 160, minMultiplier: 0.92 }`
    - `ballistics`: `Object.freeze({ mode: "hitscan" })` cho `m416`/`pistol`; `Object.freeze({ mode: "projectile", muzzleVelocity: 910, gravity: 9.81, dragK: 0.00015 })` cho `sniper`
  - `getMoveSpeedMultiplier(flags = 0, weaponOrId = null): number` (giữ nguyên giá trị cũ khi bỏ trống `weaponOrId` để không phá test cũ; nhân thêm `moveSpeedMult` khi truyền vũ khí)
  - `createDefaultWeaponsState()` bổ sung `equipEndsAt: 0`
  - `computeFalloffMultiplier(weaponOrId, distanceMeters: number): number`
  - `computeWeaponDamage(weaponOrId, part: "head"|"body"|"limb", distanceMeters?: number): number`

- [ ] **Step 1: Viết unit test AAA + sweep 0–200m cho bảng damage & falloff trong `server/tests/test_damage_model.mjs`**

Kiểm tra đủ 3 mảng:
1. Bảng damage cơ bản 0m (`M416 90/27/21`, `Glock 72/24/18`, `AWM 180/115/80`), `moveSpeedMult` (`1.05 > 0.95 > 0.84`), `equipTimeMs` (`240 < 520 < 780`), và `getMoveSpeedMultiplier(FLAG.PRONE) === 0.3` tương thích ngược.
2. **Sweep 0–200m từng mét (`for d = 0..200`)** khóa cứng bảng Shots-To-Kill:
   - `AWM body`: `1` viên chết (`>= 106` HP) ở mọi `d ∈ [0, 180]`, `0` khi `d > 180`.
   - `AWM limb + Glock body`: `>= 100` ở mọi `d ∈ [0, 44]`, ở `0..20m` đạt `104` (`+4 HP` margin).
   - `M416 body`: `4` viên chết (`4 * dmg >= 100`) ở `d ∈ [0, 57]`, `5` viên chết (`5 * dmg >= 105`) ở `d ∈ [58, 120]`; `1 head + 1 body >= 100` ở `d ∈ [0, 72]`.
   - `Glock-17 body`: `5` viên ở `d ∈ [0, 44]`, `6` viên ở `d ∈ [45, 60]`, `7` viên ở `d ∈ [61, 85]`, `0` khi `d > 85`.
3. Unhappy path: `invalid_part`, `NaN`, `-10m`, quá `maxRange`.

- [ ] **Step 2: Chạy test xác nhận FAIL trước khi sửa code**

Run: `node --test server/tests/test_damage_model.mjs`
Expected: FAIL (`computeFalloffMultiplier` / `computeWeaponDamage` chưa tồn tại).

- [ ] **Step 3: Cập nhật `WEAPONS` và cài đặt `computeFalloffMultiplier`, `computeWeaponDamage` trong `server/weapons.js`**

- Cập nhật 3 entry trong `WEAPONS` với đúng giá trị trong Spec Mục 3 (giữ nguyên `Object.freeze` để bất biến).
- Cài đặt `computeFalloffMultiplier(weaponOrId, distanceMeters = 0)`: xử lý `!Number.isFinite(distanceMeters)` hoặc `< 0` về `0`; nội suy tuyến tính từ `startDist` đến `endDist` và clamp vào `[minMultiplier, 1]`.
- Cài đặt `computeWeaponDamage(weaponOrId, part, distanceMeters = 0)`: trả `0` nếu không có `cfg.damage[part]` hoặc `dist > cfg.maxRange`, ngược lại trả `Math.max(1, Math.round(base * mult))`.

- [ ] **Step 4: Chạy lại test xác nhận PASS**

Run: `node --test server/tests/test_damage_model.mjs`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/weapons.js server/tests/test_damage_model.mjs
git commit -m "feat(weapons): balanced Truy Kich/CS damage and distance falloff"
```

---

### Task 2: Exact Arena Raycast (`server/spawn.js`) & Hitbox Đa Vùng + Đạn Đạo (`server/hitreg.js`)

**Files:**
- Modify: `server/spawn.js:232-255`
- Create: `server/hitreg.js`
- Test: `server/tests/test_server_hitreg_anticheat.mjs` (phần Hitreg & Ballistics)

**Interfaces:**
- Consumes: `rayIntersectsAABB`, `rayIntersectsOBB` trong `server/spawn.js`; `FLAG` từ `server/weapons.js`.
- Produces:
  - `server/spawn.js`: `raycastArenaDistance(ox, oy, oz, dx, dy, dz, maxDist, arenaOrBoxes): { dist: number } | null`
  - `server/hitreg.js`:
    - `EYE_HEIGHT_STAND = 1.70`, `EYE_HEIGHT_CROUCH = 1.12`, `EYE_HEIGHT_PRONE = 0.42`
    - `getEyeHeight(flags: number): number`
    - `forwardFromYawPitch(yaw: number, pitch: number): { x: number, y: number, z: number }`
    - `buildPlayerHitboxes(pose: { x, y, z, yaw, flags }): { head: Sphere, boxes: Array<{ part: "body"|"limb", obb }> }`
    - `rayIntersectsSphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist): number | null`
    - `raycastPlayerHitboxes(ox, oy, oz, dx, dy, dz, maxDist, pose): { dist: number, part: "head"|"body"|"limb" } | null`
    - `resolveAuthoritativeShot({ shooterId, weaponCfg, origin, dir, arena, targets }): { hit: boolean, targetId?: string, part?: "head"|"body"|"limb", dist?: number, hitPoint?: { x, y, z }, wallDist: number }`

- [ ] **Step 1: Viết test AAA cho `raycastArenaDistance` và `server/hitreg.js` trong `server/tests/test_server_hitreg_anticheat.mjs`**

Kiểm tra các kịch bản:
- `forwardFromYawPitch(0, 0)` trả `(0, 0, -1)` (khớp Three.js `YXZ`), `forwardFromYawPitch(Math.PI/2, 0)` trả `(-1, 0, 0)`, `forwardFromYawPitch(0, Math.PI/6)` có `y = 0.5`.
- Standing hitbox: bắn ở `y=1.62` trúng `"head"`, `y=1.20` trúng `"body"`, `y=0.45` trúng `"limb"`.
- Quy tắc CS/Truy Kích `head > body > limb`: tia đạn bắn ngang từ hông qua cánh tay xuyên vào ngực trả `"body"` (không bị cánh tay chặn thành `"limb"`).
- Crouching hitbox sau vật cản cao `1.45m`: bắn ngang ở `y=1.62` không trúng đầu đang ngồi (`1.08m`), bắn thấp ở `y=1.08` bị vật cản `1.45m` chặn (`hit: false`).
- Prone hitbox xoay theo `yaw`: đầu nằm lệch về phía trước `0.55m` ở `y=0.36`, chân nằm phía sau `-0.65m`.
- `raycastArenaDistance` bỏ qua box/OBB có `moveOnly: true` (cửa sổ nhà kho & kính cabin xe Military) nhưng chặn ở tường đặc.
- AWM `projectile` ray-march: có rơi đạn thực theo trọng lực `9.81` + lực cản `0.00015` (ở `150m`, tia ngang `pitch=0` rơi ~`0.13m`, khớp `stepBallisticStep` trong `scope.js` với sai số `< 0.01m`).
- Unhappy path: `dir = { x: 0, y: 0, z: 0 }` hoặc chứa `NaN` trả `{ hit: false, wallDist: 0 }`, không ném ngoại lệ.

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs`
Expected: FAIL (chưa có `server/hitreg.js` và `raycastArenaDistance`).

- [ ] **Step 3: Thêm `raycastArenaDistance` vào `server/spawn.js` và cài đặt `server/hitreg.js`**

- Trong `server/spawn.js`: `raycastArenaDistance` duyệt `boxes` và `obbs` (bỏ qua `moveOnly === true`), trả `{ dist: bestT }` với `bestT` nhỏ nhất trong `[0, maxDist]` hoặc `null`. Tái sử dụng hoặc giữ nguyên `hasLineOfSight` tương thích 100%.
- Trong `server/hitreg.js`:
  - Chuẩn hóa `dir` an toàn; nếu độ dài `< 1e-6` hoặc có `NaN` trả `{ hit: false, wallDist: 0 }`.
  - `buildPlayerHitboxes(pose)` tạo đúng kích thước theo Spec Mục 4.2.
  - `raycastPlayerHitboxes` kiểm tra cầu đầu + tất cả OBB thân/chi bằng `rayIntersectsOBB`, bỏ qua mọi va chạm có `t > maxDist`, và áp dụng ưu tiên vùng `PRIORITY = { head: 3, body: 2, limb: 1 }` trên cùng mục tiêu.
  - `resolveAuthoritativeShot`:
    - Với `mode === "hitscan"`: tính `wallDist = wallHit ? wallHit.dist : maxRange`, duyệt mọi target khác `shooterId`, chọn target trúng có `dist` nhỏ nhất `<= wallDist`, tính `hitPoint = origin + dir * dist`.
    - Với `mode === "projectile"` (AWM): khởi tạo `vel = dir * muzzleVelocity`, lặp `subStep = 0.004s` tối đa đến `maxRange` (tối đa `120` bước), cập nhật vận tốc bằng drag `-dragK * speed * vel` và trọng lực `-gravity`, mỗi đoạn kiểm tra tường và mục tiêu, dừng ngay ở va chạm đầu tiên.

- [ ] **Step 4: Chạy lại test xác nhận PASS**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/spawn.js server/hitreg.js server/tests/test_server_hitreg_anticheat.mjs
git commit -m "feat(hitreg): server-authoritative multi-zone hitboxes and AWM ballistics"
```

---

### Task 3: Lag Compensation Rewind (`server/lag_comp.js`) & Server-Measured RTT (`RoomManager.js`, `index.js`)

**Files:**
- Create: `server/lag_comp.js`
- Modify: `server/RoomManager.js:110-125,270-285`
- Modify: `server/index.js:575-586`
- Modify: `server/tests/test_server_hitreg_anticheat.mjs`

**Interfaces:**
- Consumes: `ws.sendPing()` & `ws.on("pong")` có sẵn trong `server/ws.js`.
- Produces:
  - `server/lag_comp.js`:
    - `INTERP_DELAY_MS = 100`, `MAX_REWIND_MS = 250`, `MAX_HISTORY_MS = 450`, `TELEPORT_SNAP_DIST = 4.0`
    - `computeAllowedRewindMs(rttMs: number): number`
    - `clampRewindTimestamp(clientTime: number, now: number, rttMs?: number): number`
    - `createPoseHistoryStore(): { record(player, now), prune(now), sample(playerId, evalTime, fallbackPlayer), clear(playerId?) }`
  - `server/RoomManager.js`: `recordPong(sessionId: string, now?: number): number | null` cập nhật `session.rttMs` (EMA, clamp `[0, 400]`) và đồng bộ `player.rttMs` trong phòng hiện tại.

- [ ] **Step 1: Thêm test AAA cho `lag_comp.js` và đo RTT vào `server/tests/test_server_hitreg_anticheat.mjs`**

Kiểm tra:
- `computeAllowedRewindMs(0)` trả `140` (`100 + 0 + 40`), `computeAllowedRewindMs(140)` trả `210`, `computeAllowedRewindMs(500)` bị chặn trần `250`.
- `clampRewindTimestamp(now - 240, now, 10)` bị chặn về `now - 145` (chống LAN fake-backtrack 250ms!).
- `clampRewindTimestamp(now + 5000, now, 50)` bị chặn về `now`; `clampRewindTimestamp(NaN, now, 50)` trả `now`.
- `sample(id, evalTime, fallback)` nội suy đúng vị trí `(x, y, z)` và góc `yaw` vòng qua `±π` của mục tiêu đang chạy ngang.
- **Review Focus #2 (Respawn Teleport Guard):** Mục tiêu ở `(10, 0, 10)` lúc `t=1000`, chết và hồi sinh ở `(-30, 0, -40)` lúc `t=1100` (`dist > 4m`) -> `sample(id, 1050)` KHÔNG trả điểm giữa `(-10, 0, -15)`, và nếu `alive === false` ở `h0` thì trả `{ alive: false }` (không cho bắn bóng ma).
- `RoomManager.stepHeartbeat` + `recordPong` cập nhật `session.rttMs` và `player.rttMs` đúng trong khoảng `[0, 400]`.

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs`
Expected: FAIL.

- [ ] **Step 3: Cài đặt `server/lag_comp.js` và nối đo RTT trong `server/RoomManager.js` + `server/index.js`**

- Trong `server/lag_comp.js`: mỗi player giữ mảng tối đa `24` mẫu `{ t, x, y, z, yaw, flags, alive }`, bỏ qua ghi trùng nếu `now - last.t < 10` và không đổi `alive`/teleport (`dist <= 4m`), dọn mẫu cũ hơn `now - MAX_HISTORY_MS`. `sample()` tìm cặp `[h0, h1]` bao quanh `evalTime`, trả `{ ...h1, alive: h0.alive && h1.alive }` khi nhảy `> TELEPORT_SNAP_DIST`, ngược lại lerp tuyến tính & góc ngắn nhất.
- Trong `server/RoomManager.js`: thêm `rttMs: 0, lastPingSentAt: 0` vào session trong `handleHello`; trong `stepHeartbeat` đặt `s.lastPingSentAt = now` ngay trước `s.ws.sendPing()`; thêm `recordPong(sessionId, now)` tính `sample = clamp(now - s.lastPingSentAt, 0, 400)`, cập nhật EMA `s.rttMs = s.rttMs > 0 ? Math.round(s.rttMs * 0.7 + sample * 0.3) : sample`, rồi đồng bộ `room.players.get(sessionId).rttMs = s.rttMs`.
- Trong `server/index.js`: trong `ws.on("pong")`, gọi `roomManager.recordPong(connState.session.id, nowFn())`.

- [ ] **Step 4: Chạy lại test xác nhận PASS**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lag_comp.js server/RoomManager.js server/index.js server/tests/test_server_hitreg_anticheat.mjs
git commit -m "feat(net): add RTT-bounded lag compensation pose history store"
```

---

### Task 4: Module Chống Cheat 5 Lớp (`server/anti_cheat.js`) & Mã Lỗi (`server/protocol.js`)

**Files:**
- Create: `server/anti_cheat.js`
- Modify: `server/protocol.js:83-99`
- Modify: `server/tests/test_server_hitreg_anticheat.mjs`

**Interfaces:**
- Consumes: `forwardFromYawPitch`, `getEyeHeight` từ `server/hitreg.js`; `hasLineOfSight` từ `server/spawn.js`; `computeWeaponSpread` từ `server/weapons.js`.
- Produces:
  - `server/protocol.js`: `ERR.CHEAT_DETECTED = "CHEAT_DETECTED"`
  - `server/anti_cheat.js`:
    - `ANTI_CHEAT_WEIGHTS = Object.freeze({ LEGACY_HIT_SPOOF: 15, ORIGIN_TAMPER: 20, AIM_DIR_TAMPER: 25, RAPID_FIRE: 10, SPEED_TAMPER: 10 })`
    - `ANTI_CHEAT_WARN_THRESHOLD = 40`, `ANTI_CHEAT_KICK_THRESHOLD = 100`, `DECAY_PER_10S = 5`
    - `validateShotOrigin(authEye, clientOrigin, arena): { origin, tampered: boolean, reason: string | null }`
    - `validateShotDirection(authYaw, authPitch, clientDir, weaponCfg, flags): { dir, tampered: boolean, angleDiffRad: number, maxAngleRad: number }`
    - `class AntiCheatTracker`: `recordViolation(playerId, code, now, meta?) -> { score, action: "none"|"warn"|"kick", code }`, `getScore(playerId, now): number`, `clear(playerId)`, `reset()`

- [ ] **Step 1: Viết test AAA cho `server/anti_cheat.js` trong `server/tests/test_server_hitreg_anticheat.mjs`**

Kiểm tra:
- `validateShotOrigin`: chấp nhận `clientOrigin` lệch `<= 0.75m` ngang & `<= 0.55m` dọc khi có LoS; từ chối (`tampered: true`) và ép về `authEye` khi lệch `2.0m` hoặc xuyên qua hộp tường (`wall-peek`).
- `validateShotDirection`: chấp nhận `clientDir` lệch nhỏ do spread + recoil + AWM zeroing (`<= computeWeaponSpread(cfg, flags) * 2.5 + 0.085 rad`); đánh dấu `tampered: true` khi `clientDir` chỉ ngược `90°` hoặc lệch `20°` (Silent Aim).
- `AntiCheatTracker`:
  - Cộng dồn điểm đúng theo `ANTI_CHEAT_WEIGHTS`, kích hoạt `action: "warn"` khi `score >= 40` và `action: "kick"` khi `score >= 100`.
  - Sau `40_000ms` chơi sạch, điểm suy giảm `-20` (không kick nhầm người lag cục bộ).
  - Unhappy path: `code` lạ hoặc `now` không hợp lệ không làm `score` thành `NaN`.

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs`
Expected: FAIL.

- [ ] **Step 3: Thêm `ERR.CHEAT_DETECTED` trong `server/protocol.js` và cài đặt `server/anti_cheat.js`**

- `validateShotOrigin`: nếu `!finiteVec3(clientOrigin)` trả `{ origin: authEye, tampered: false, reason: null }` (fallback hợp lệ cho gói tối giản); nếu lệch `horiz > 0.75` hoặc `|dy| > 0.55` hoặc `!hasLineOfSight(authEye.x, authEye.y, authEye.z, clientOrigin.x, clientOrigin.y, clientOrigin.z, arena)` thì trả `{ origin: authEye, tampered: true, reason }`.
- `validateShotDirection`: tính `authDir = forwardFromYawPitch(authYaw, authPitch)`. Nếu `!finiteVec3(clientDir)` trả `{ dir: authDir, tampered: false, angleDiffRad: 0, maxAngleRad }`. Chuẩn hóa `clientDir`; tính `dot = clamp(dot(authDir, normDir), -1, 1)`, `angleDiffRad = Math.acos(dot)`. Đặt `maxAngleRad = computeWeaponSpread(weaponCfg, flags) * 2.5 + 0.085` (~`4.8°` + spread để bao phủ trọn vẹn recoil kick & AWM zeroing); nếu `angleDiffRad > maxAngleRad` trả `{ dir: authDir, tampered: true, angleDiffRad, maxAngleRad }`.
- `AntiCheatTracker`: lưu `Map<playerId, { score, lastUpdatedAt, warned }>` với suy giảm tuyến tính `DECAY_PER_10S` trên khoảng `Math.max(0, now - rec.lastUpdatedAt)`.

- [ ] **Step 4: Chạy lại test xác nhận PASS**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/protocol.js server/anti_cheat.js server/tests/test_server_hitreg_anticheat.mjs
git commit -m "feat(anticheat): add origin/direction validators and decaying violation tracker"
```

---

### Task 5: Tích hợp Server-Authoritative Combat, Leaky Buckets & Auto-Kick vào `Match.js`, `Room.js`, `RoomManager.js`, `index.js`

**Files:**
- Modify: `server/Match.js:18-462`
- Modify: `server/Room.js:29-65,155-188,332-350,408-426`
- Modify: `server/RoomManager.js:173-192`
- Modify: `server/index.js:249-269`
- Modify: `server/tests/test_lan_v2.js`
- Modify: `server/tests/test_military_map.mjs`
- Modify: `server/tests/test_server_hitreg_anticheat.mjs`

**Interfaces:**
- Consumes: `computeWeaponDamage` (`weapons.js`), `getEyeHeight`/`resolveAuthoritativeShot` (`hitreg.js`), `createPoseHistoryStore`/`clampRewindTimestamp` (`lag_comp.js`), `validateShotOrigin`/`validateShotDirection`/`AntiCheatTracker` (`anti_cheat.js`).
- Produces:
  - `Room.kickForCheat(targetId: string, reason?: string): { ok: boolean }` (gửi `MSG.ROOM_KICKED` kèm `code: ERR.CHEAT_DETECTED`, gọi `this.leave(targetId)` và `onAutoKick` hook).
  - `Match.handleFire(player, msg, now)` trả `{ ok, weaponId, mag, hit?: boolean, targetId?: string, part?: string, damage?: number, hp?: number, dist?: number, shielded?: boolean, code?, message? }`.
  - `Match.handleDeprecatedClientHit(player, now)` luôn từ chối (`{ ok: false, code: ERR.INVALID_STATE }`) và ghi `LEGACY_HIT_SPOOF`.
  - `MSG.EVENT_HIT` broadcast bổ sung `{ weaponId, dist, hitPoint }`.

- [ ] **Step 1: Viết integration tests toàn trình trong `server/tests/test_server_hitreg_anticheat.mjs` và cập nhật `test_lan_v2.js` / `test_military_map.mjs`**

Thêm test trong `test_server_hitreg_anticheat.mjs`:
- **Happy path server-authoritative kill (TDM & FFA dùng chung 1 chỉ số):**
  - M416 ở `10m`: 1 viên vào đầu gây `90` (chưa chết, `hp === 10`), viên thứ 2 vào thân gây `27` -> hạ gục (`hp === 0`, `EVENT_KILL`, cộng điểm).
  - AWM ở `30m`: 1 viên vào thân gây `115` -> hạ gục ngay; 1 viên vào chân gây `80` (`hp === 20`) -> đổi sang Glock-17 (chờ `equipTimeMs` `240ms`, trong khi bắn sớm ở `100ms` bị chặn!) bắn 1 viên thân ở `10m` gây `24` -> hạ gục chính xác (`hp === 0`)!
  - Xác nhận cùng kịch bản ở FFA và TDM cho ra sát thương giống hệt nhau.
  - Xác nhận `moveSpeedMult`: cầm Glock (`1.05×`) đi nhanh hơn M416 (`0.95×`) và AWM (`0.84×`) trên cả `handleState` server lẫn `game.js` client.
- **Lag Compensation Rewind:** Mục tiêu chạy ngang từ `x=0` sang `x=5` trong `200ms`; người bắn gửi `MSG.FIRE` nhắm vào `x=2.5` với `clientTime = now - 100` (RTT=20ms) -> server tua ngược và tính trúng hợp lệ!
- **Chống cheat 5 lớp thực chiến:**
  - Gửi `MSG.HIT` trực tiếp -> bị từ chối, không trừ máu nạn nhân, tăng điểm vi phạm `+15`.
  - Silent Aim (`yaw=0` nhìn về `-Z`, nhưng gửi `dir={x:1, y:0, z:0}` hướng về nạn nhân bên phải) -> bị chặn sát thương, tăng điểm `+25`.
  - Wall-Peek (`origin` dịch ra khỏi vật cản `1.5m`) -> bị ép về `authEye`, tường chặn viên đạn, tăng điểm `+20`.
  - Rapid-Fire (spam `M416` mỗi `60ms` thay vì `86ms` liên tiếp 5 phát) -> phát đầu có thể qua jitter, các phát kế tiếp bị từ chối `ERR.RATE_LIMITED` và tăng điểm `+10`.
  - Speedhack (spam `STATE` dịch `2m` mỗi `50ms`) -> bị chặn bởi leaky bucket `moveAllowance <= 1.2m` và tăng điểm `+10`.
  - Tích lũy điểm `>= 100` -> tự động kick (`MSG.ROOM_KICKED`), `room.players.has(cheaterId) === false`, và `session.roomId === null`.

Cập nhật các đoạn gọi `handleHit` cũ trong `server/tests/test_lan_v2.js` (dòng 235–250, 304–309, 505–521) và `server/tests/test_military_map.mjs` (dòng 124–137):
- Thay cặp `handleFire(...) + handleHit(...)` bằng `handleFire(...)` truyền đúng `yaw/pitch/origin/dir` nhắm đúng độ cao đầu/thân nạn nhân (và lưu ý M416 `head = 90` cần 2 phát hoặc dùng AWM để 1-shot kill).

- [ ] **Step 2: Chạy toàn bộ test server xác nhận FAIL ở các case mới**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs server/tests/test_lan_v2.js server/tests/test_military_map.mjs`
Expected: FAIL.

- [ ] **Step 3: Cài đặt nâng cấp trong `server/Room.js`, `server/RoomManager.js`, `server/index.js`, và `server/Match.js`**

Chi tiết quyết định kỹ thuật cần khóa cứng:
1. **`server/Room.js`:**
   - Nhận optional `onAutoKick` trong `options` (hoặc callback từ `RoomManager.createRoom`).
   - Thêm trường `moveAllowance: 1.2`, `rttMs: session.rttMs || 0` trên player trong `join()`, xóa `pendingHitCredit`.
   - Thêm `kickForCheat(targetId, reason = "Phát hiện hành vi bất thường (Anti-Cheat)")`: gửi `{ type: MSG.ROOM_KICKED, roomId: this.id, code: ERR.CHEAT_DETECTED, reason }`, gọi `this.leave(targetId)`, và gọi `this.onAutoKick(this, targetId, reason)` nếu có.
   - Trong `_resetToWaiting()`, gọi `this.match.resetAntiCheatAndHistory()`.
2. **`server/RoomManager.js`:**
   - Khi tạo `new Room(...)`, truyền `onAutoKick: (room, targetId) => { const s = this.sessions.get(targetId); if (s) s.roomId = null; if (room.players.size === 0) this.rooms.delete(room.id); this.broadcastLobbyList(); }`.
3. **`server/Match.js`:**
   - Khởi tạo `this.poseHistory = createPoseHistoryStore()` và `this.antiCheat = new AntiCheatTracker()`.
   - `FIRE_JITTER_MS = 25`. Fire-rate leaky debt trong `handleFire`:
     - Nếu `now < w.nextFireAt - FIRE_JITTER_MS`: ghi vi phạm `RAPID_FIRE`, xử lý warn/kick, trả `ERR.RATE_LIMITED`.
     - Khi hợp lệ: nếu `w.nextFireAt > now` (đến sớm trong cửa sổ jitter) thì `w.nextFireAt = w.nextFireAt + cfg.fireInterval`; ngược lại `w.nextFireAt = now + cfg.fireInterval`.
   - Movement leaky bucket trong `handleState`:
     - `const dtSec = Math.min(0.5, Math.max(0.016, (now - (player.lastStateAt || now)) / 1000));`
     - `const baseMax = allowedSpeed * dtSec * 1.15;`
     - `const allowance = Number.isFinite(player.moveAllowance) ? player.moveAllowance : 1.2;`
     - Nếu `d <= baseMax`: chấp nhận và hồi quỹ `player.moveAllowance = Math.min(1.2, allowance + Math.max(0, baseMax - d) * 0.5)`.
     - Else nếu `d <= baseMax + allowance`: chấp nhận và trừ quỹ `player.moveAllowance = Math.max(0, allowance - (d - baseMax))`.
     - Else: clamp theo `maxDist = baseMax + allowance`, đặt `player.moveAllowance = 0`, và nếu vượt rõ rệt (`d > maxDist + 0.45`) thì ghi vi phạm `SPEED_TAMPER`.
     - Ghi `this.poseHistory.record(player, now)` sau khi cập nhật vị trí/tư thế.
   - Trong `handleFire(player, msg, now)`:
     - Cập nhật `player.yaw`/`player.pitch` trước nếu `msg.yaw`/`msg.pitch` là số hữu hạn (clamp `pitch` trong `[-1.48, 1.48]`).
     - Validate `origin` qua `validateShotOrigin` (nếu `tampered`, ghi `ORIGIN_TAMPER`, dùng `authEye`).
     - Validate `dir` qua `validateShotDirection` (nếu `tampered`, ghi `AIM_DIR_TAMPER`, vẫn trừ đạn/broadcast `EVENT_FIRE` hướng `authDir` nhưng **bỏ qua bước xét sát thương** để triệt tiêu Silent Aim hoàn toàn!).
     - Tính `evalTime = clampRewindTimestamp(msg.clientTime, now, player.rttMs || 0)`.
     - Thu danh sách `targets` gồm mọi player còn sống tại `now`, thỏa `modeImpl.canDamage(player, v)`, với pose tua ngược từ `poseHistory.sample(v.id, evalTime, v)` (bỏ qua nếu `sampled.alive === false`).
     - Gọi `resolveAuthoritativeShot({ shooterId: player.id, weaponCfg: cfg, origin: validOrigin, dir: validDir, arena: this.room.arena, targets })`.
     - Nếu trúng: xử lý `invulnerableUntil` (gửi `part: "shield"`), ngược lại tính `damage = computeWeaponDamage(cfg, hit.part, hit.dist)`, trừ `victim.hp`, broadcast `EVENT_HIT` (gồm `weaponId: cfg.id`, `dist: Number(hit.dist.toFixed(1))`, `hitPoint`), và xử lý kill/score/match end như hiện tại.
   - Trong `step(now)`: gọi `this.poseHistory.record(p, now)` cho mọi player sống và `this.poseHistory.prune(now)`.
   - Thêm `handleDeprecatedClientHit(player, now)`: ghi `LEGACY_HIT_SPOOF`, xử lý warn/kick, luôn trả `{ ok: false, code: ERR.INVALID_STATE, message: "Hit detection do máy chủ quyết định" }`.
   - Helper `_applyAntiCheatAction(player, res)`: nếu `res.action === "warn"` gửi `MSG.ERROR` cảnh báo và `console.warn` (chỉ log `roomId`, `playerId`, `code`, `score` — không log PII/token); nếu `res.action === "kick"` gọi `this.room.kickForCheat(player.id)`.
4. **`server/index.js`:**
   - Case `MSG.HIT`: gọi `room.match.handleDeprecatedClientHit(p, now)`.

- [ ] **Step 4: Chạy toàn bộ suite test Node.js**

Run: `node --test server/tests/test_*.js server/tests/test_*.mjs`
Expected: Toàn bộ test PASS (`0` failed).

- [ ] **Step 5: Commit**

```bash
git add server/Match.js server/Room.js server/RoomManager.js server/index.js server/tests/test_server_hitreg_anticheat.mjs server/tests/test_lan_v2.js server/tests/test_military_map.mjs
git commit -m "feat(match): move hit detection and anti-cheat enforcement to server authority"
```

---

### Task 6: Nâng cấp Client (`public/js/combat.js` & `public/js/game.js`) bỏ `MSG.HIT` & gửi `yaw/pitch/clientTime`

**Files:**
- Modify: `public/js/combat.js:5-60,466-518,650-722,940-994`
- Modify: `public/js/game.js:552-622,751-765`
- Test: `server/tests/test_server_hitreg_anticheat.mjs` (thêm static guard kiểm tra `combat.js` không còn gửi `MSG.HIT`)

**Interfaces:**
- Consumes: `INTERP_DELAY_MS` từ `public/js/game.js`, `net.clockOffsetMs` từ `public/js/net.js`.
- Produces:
  - `combat.shoot()` gửi `MSG.FIRE` gồm `{ weapon, flags, origin, dir, yaw, pitch, clientTime, seed, seq }` và **tuyệt đối không gửi `MSG.HIT`**.
  - `combat.spawnHitSparks(point: { x, y, z })` hiển thị tia lửa trúng mục tiêu từ tọa độ `ev.hitPoint` do server phát trong `MSG.EVENT_HIT`.

- [ ] **Step 1: Thêm test kiểm tra ràng buộc client vào `server/tests/test_server_hitreg_anticheat.mjs`**

Assert nguồn `public/js/combat.js`:
- Không còn chuỗi `net.send(MSG.HIT` (đảm bảo client không bao giờ tự gửi hit).
- Gửi `clientTime` và `yaw`/`pitch` trong gói `MSG.FIRE`.
- Nguồn `public/js/game.js` truyền `INTERP_DELAY_MS` vào `createCombatSystem` và xử lý `ev.hitPoint`.

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `node --test server/tests/test_server_hitreg_anticheat.mjs`
Expected: FAIL (vì `combat.js` vẫn đang gọi `net.send(MSG.HIT, ...)`).

- [ ] **Step 3: Sửa `public/js/combat.js` và `public/js/game.js`**

- Trong `public/js/combat.js`:
  - Nhận thêm `INTERP_DELAY_MS = 100` trong destructured params của `createCombatSystem`.
  - Tạo helper `buildLanFirePayload(weaponId, originVec, dirVec, shotSeed)` trả `{ weapon: weaponId, flags: ps.curFlags, origin: ..., dir: ..., yaw: +ps.yaw.toFixed(4), pitch: +(ps.pitch + kick).toFixed(4), clientTime: Math.round(Date.now() + (net.clockOffsetMs || 0) - INTERP_DELAY_MS), seed: shotSeed, seq: localShotSeq }`.
  - Dùng `buildLanFirePayload` cho cả nhánh `sniper` (dòng ~651) và nhánh `m416`/`pistol` (dòng ~704).
  - Trong `applyShotImpact` (nhánh `engineMode === "lan"`): **xóa bỏ** `net.send(MSG.HIT, ...)` và chỉ sinh hiệu ứng bề mặt tường `spawnSurfaceImpact` khi `hitWorld` (không tự giả lập blood/hitmarker trước khi server xác nhận).
  - Xuất thêm `spawnHitSparks(pt)` gọi `burst(new Vec(pt.x, pt.y, pt.z), 10, 3.2)` trong object trả về của `createCombatSystem`.
  - Giữ nguyên 100% nhánh `engineMode === "solo"` (Drone Offline).
- Trong `public/js/game.js`:
  - Truyền `INTERP_DELAY_MS` vào `createCombatSystem({ ... })`.
  - Trong `net.on(MSG.EVENT_HIT, (ev) => ...)`: nếu `ev.damage > 0 && ev.hitPoint && Number.isFinite(ev.hitPoint.x)` và `ev.targetId !== net.playerId`, gọi `combat.spawnHitSparks(ev.hitPoint)`.

- [ ] **Step 4: Chạy toàn bộ Node tests xác nhận PASS**

Run: `node --test server/tests/test_*.js server/tests/test_*.mjs`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add public/js/combat.js public/js/game.js server/tests/test_server_hitreg_anticheat.mjs
git commit -m "feat(client): remove client MSG.HIT and send lag-comp fire telemetry"
```

---

### Task 7: Rebuild `dist-static/`, Quét Bảo Mật OWASP, Nghiệm Thu E2E & Cập Nhật Tài Liệu

**Files:**
- Rebuild: `dist-static/*` (bằng `node scripts/build_static.mjs`)
- Modify: `README.md`
- Modify: `agents/context.md`

**Interfaces:**
- Consumes: tất cả thay đổi từ Task 1–6.
- Produces: bản build `dist-static/` mới nhất, tài liệu `README.md` cập nhật bảng sát thương & cơ chế chống cheat, và nhật ký bàn giao trong `agents/context.md`.

- [ ] **Step 1: Rebuild `dist-static/` và chạy trọn bộ kiểm thử Node + Python**

Run:
```powershell
node scripts/build_static.mjs; node --test server/tests/test_*.js server/tests/test_*.mjs
```
Expected: `build_static` báo thành công và 100% Node tests PASS.

- [ ] **Step 2: Chạy kiểm thử trình duyệt WebGL E2E (nếu môi trường có Playwright)**

Run: `python server/tests/verify_military_e2e.py`
Expected: PASS với `errors: []`.

- [ ] **Step 3: Rà soát bảo mật OWASP & Code Review diff**

Kiểm tra không có `eval`, `new Function`, `innerHTML`, `dangerouslySetInnerHTML`, hardcode secret, hoặc log PII/token trong toàn bộ các file mới/đã sửa.

- [ ] **Step 4: Cập nhật `README.md` và `agents/context.md`**

- Ghi bảng thông số sát thương 3 vũ khí (M416, Glock-17, AWM) + cơ chế Server-Authoritative Hitreg / Lag Compensation / 5-layer Anti-Cheat vào `README.md`.
- Ghi đè Mục 1 (Trạng thái hiện tại), bổ sung Mục 2 (Quyết định đã chốt), cập nhật Mục 3 (TODO) và thêm nhật ký mới nhất ở đầu Mục 4 của `agents/context.md`.

- [ ] **Step 5: Commit cuối cùng**

```bash
git add dist-static README.md agents/context.md
git commit -m "docs(combat): update static bundle, README, and context for server-authoritative combat"
```
