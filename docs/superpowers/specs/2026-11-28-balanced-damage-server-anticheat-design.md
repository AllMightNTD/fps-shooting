# Design Spec: Cơ chế Sát thương Cân bằng (Truy Kích / CS) & Chống Cheat Server-Authoritative

- **Ngày:** 2026-11-28
- **Phạm vi:** 3 vũ khí hiện có (`m416`, `pistol`/Glock-17, `sniper`/AWM), mở rộng dễ dàng cho vũ khí mới về sau.
- **Chế độ áp dụng:** Dùng chung **1 bộ chỉ số sát thương & luật hitreg** cho cả **Đấu Đơn (FFA)** và **Đấu Đội (TDM)**; giữ nguyên chế độ luyện tập Offline (Drone).

---

## 1. Mục tiêu & Ràng buộc

### Mục tiêu
1. **Cân bằng theo phong cách Truy Kích / CS (HP chuẩn = 100):**
   - Mỗi khẩu súng có vai trò rõ ràng theo cự ly và vùng trúng (`head`, `body`, `limb`).
   - `M416` không còn 1-tap headshot ở 120m (tránh lấn sân AWM); đổi lại thưởng mạnh cho 1 đầu + 1 thân/tay-chân và ổn định 4 viên thân ở cự ly gần–trung bình.
   - `AWM Sniper` là vũ khí duy nhất 1-hit hạ gục khi trúng đầu **hoặc thân trên** toàn bản đồ, nhưng bắn trúng tay/chân để đối thủ còn 22 HP (tạo combo quen thuộc AWM tag + đổi Glock-17 kết liễu).
   - `Glock-17` sắc bén ở cự ly gần (`<= 18m`), rơi sát thương mạnh khi bắn xa (`> 40m`).
2. **Chống cheat triệt để theo nguyên tắc Zero Client Trust:**
   - Xóa bỏ hoàn toàn cơ chế client tự gửi `MSG.HIT { targetId, part }`.
   - Server tự tính raycast (hitscan cho M416/Glock-17; quỹ đạo đạn đạo có trọng lực + cản không khí cho AWM) trên hitbox đa vùng theo tư thế (Đứng / Ngồi / Nằm) và kiểm tra che khuất địa hình (`shared/maps/military_colliders.json` & Harbor boxes).
   - Triển khai **Lag Compensation (Rewind)** có chặn trần theo RTT đo từ server để bắn mượt ở ping 10–250ms nhưng chống fake-backtrack.
   - Khóa lỗ hổng rapid-fire (leaky fire debt), speedhack (leaky movement budget), fake origin/wall-peek, silent aim, và tự động cảnh báo / kick khi vượt ngưỡng vi phạm.

### Không nằm trong phạm vi (Non-goals)
- Chưa thêm vũ khí thứ 4 (`m200.glb` để giai đoạn sau; kiến trúc khai báo dữ liệu sẵn sàng thêm ngay chỉ bằng 1 entry trong `WEAPONS`).
- Chưa thêm cơ chế mua giáp/mũ theo vòng hay xuyên tường wallbang (có thể mở rộng sau trên cùng pipeline `resolveAuthoritativeShot`).
- Không thay đổi cơ chế trừ máu Drone Offline (`combat.js`).

### Ràng buộc kỹ thuật toàn dự án
- **Zero external runtime dependencies** cho `server/` và các module chia sẻ (`server/weapons.js`, `server/protocol.js`) để chạy được trên cả Node.js ESM lẫn trình duyệt và Cloudflare Pages (`dist-static/`).
- Hệ tọa độ khớp tuyệt đối Three.js camera `YXZ` (`forward = (-cos(pitch)*sin(yaw), sin(pitch), -cos(pitch)*cos(yaw))`), độ cao mắt `1.70m` (đứng), `1.12m` (ngồi), `0.42m` (nằm).
- Giữ tương thích ngược cho luồng kết nối WS hiện tại, 20Hz snapshot, và `node scripts/build_static.mjs`.
- Tuân thủ OWASP (`GEMINI.md` Mục 4): validate chặt mọi trường số/vector từ client (`Number.isFinite`), không tin dữ liệu client, không log PII/token.

---

## 2. Phương án kiến trúc đã chọn

- **Phương án A (Đã chốt):** Server-Authoritative Instant Raycast + Ballistic Arc Trace (AWM) kết hợp Lag Compensation Rewind (250ms cap, neo theo server-measured RTT) + Multi-layer Anti-Cheat.
  - *Lý do chọn:* Ở tick server `20 Hz` (`50ms`), mô phỏng AWM (`910 m/s`) theo đường cong đạn đạo ngay tại `evalTime` (rewound) vừa bảo toàn rơi đạn + zeroing như `scope.js`, vừa khớp hoàn hảo với khung hình nội suy 100ms của người bắn, chi phí CPU `< 0.1ms`/phát bắn và không tạo state rác giữa các tick.
- *Phương án đã loại:*
  - Giữ `MSG.HIT` từ client và chỉ kiểm tra thêm góc nhìn: vẫn cho phép spoof vùng `head` / magic bullet trong hình nón.
  - Tick đạn vật lý AWM qua nhiều tick `50ms` không rewind: gây lệch cảm giác bắn trên mục tiêu đang di chuyển ở ping > 40ms.

---

## 3. Bảng thông số sát thương chuẩn (Truy Kích / CS — 100 HP)

Công thức chuẩn trong `server/weapons.js`:

```
mult(d) = 1.0                                                    nếu d <= startDist
mult(d) = minMultiplier                                          nếu d >= endDist
mult(d) = 1.0 - ((d - startDist) / (endDist - startDist)) * (1 - minMultiplier)
damage  = Math.max(1, Math.round(baseDamage[part] * mult(d)))    (0 nếu d > maxRange hoặc part không hợp lệ)
```

| Vũ khí | Slot | RPM / Interval | `head` | `body` | `limb` | Falloff (`start` → `end`, `minMult`) | `moveMult` | `equipTime` | Max Range | Kiểu đạn đạo | Thang STK (thân) & Vai trò |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **M416** | 1 | ~697 RPM (`86ms`) | **90** | **27** | **21** | `30m → 95m`, `0.78` | `0.95×` | `520ms` | `120m` | `hitscan` | 4 (`0–57m`) → 5 (`58–120m`, sàn `105`). `1 đầu + 1 thân >= 100` đến `72m`. |
| **Glock-17** (`pistol`) | 2 | ~400 RPM (`150ms`) | **72** | **24** | **18** | `20m → 65m`, `0.65` | `1.05×` | `240ms` | `85m` | `hitscan` | 5 (`0–44m`) → 6 (`45–60m`) → 7 (`61–85m`, sàn `112`). Chạy nhanh nhất, rút tức thì, kết liễu mục tiêu dính chân AWM đến `44m` (`80 + 20 = 100`). |
| **AWM Sniper** (`sniper`) | 3 | Bolt (`1300ms`) | **180** | **115** | **80** | `65m → 160m`, `0.92` | `0.84×` | `780ms` | `180m` | `projectile` (`v=910, g=9.81, k=0.00015`) | 1 thân toàn map (sàn `106`, dư `+6 HP`); chân `80` (còn `20 HP`). `head: 180` giữ dự phòng có chủ đích cho mở rộng wallbang/giáp sau này. |

---

## 4. Kiến trúc Hitbox, Lag Compensation & Chống Cheat

### 4.1 Luồng dữ liệu một phát bắn (LAN PvP)

```
Client shoot()
  └─ Gửi MSG.FIRE { weapon, flags, origin, dir, yaw, pitch, clientTime, seed, seq }
       (KHÔNG gửi MSG.HIT)
        │
        ▼
Server Match.handleFire(player, msg, now)
  1. Kiểm tra trạng thái phòng (PLAYING), sống, không sprint, không reload, còn đạn.
  2. Kiểm tra Fire-Rate Leaky Debt (jitter <= 25ms nhưng tốc độ trung bình <= RPM thật).
  3. Cập nhật yaw/pitch hợp lệ từ MSG.FIRE; xác thực origin (<= 0.75m ngang, <= 0.55m dọc, có LoS từ mắt server)
     và xác thực dir nằm trong nón spread + recoil + zeroing tối đa của súng.
     -> Nếu vượt ngưỡng: ghi điểm AntiCheatTracker, clamp/từ chối phát bắn.
  4. Tính evalTime = clampRewindTimestamp(msg.clientTime, now, player.rttMs)
     với cửa sổ tối đa clamp(100 + ceil(rttMs/2) + 40, 120, 250) ms.
  5. Tua ngược (sample) tư thế mọi mục tiêu hợp lệ (khác đội ở TDM, sống cả ở evalTime và now) -> buildPlayerHitboxes.
  6. resolveAuthoritativeShot():
     - hitscan: raycastArenaDistance (bỏ qua moveOnly) + raycastPlayerHitboxes (ưu tiên head > body > limb trên cùng mục tiêu, chọn mục tiêu gần nhất trước tường).
     - projectile (AWM): ray-march từng bước dt = 0.004s theo trọng lực + drag đến maxRange, dừng tại va chạm đầu tiên (tường hoặc người).
  7. Nếu trúng:
     - Khiên hồi sinh -> broadcast EVENT_HIT { part: "shield", damage: 0 }.
     - Ngược lại -> computeWeaponDamage(weaponCfg, part, dist), trừ HP, broadcast EVENT_HIT (kèm hitPoint, dist, weaponId) và EVENT_KILL / MATCH_SCORE nếu HP <= 0.
  8. Nếu AntiCheatTracker đạt ngưỡng >= 40 (cảnh báo) / >= 100 (auto-kick qua Room.kickForCheat).
```

### 4.2 Hitbox đa vùng theo tư thế (`server/hitreg.js`)
Khớp chặt với avatar trong `public/js/remote_players.js` và chiều cao collider trong `server/spawn.js`:
- **Đứng (`1.78m`):**
  - `head`: cầu tâm `(x, y + 1.62, z)`, `r = 0.175`
  - `body`: OBB xoay theo `yaw`, `y ∈ [0.86, 1.46]`, `hx = 0.24, hz = 0.16`
  - `limb`: OBB chân `y ∈ [0.00, 0.86]`, `hx = 0.20, hz = 0.15` + 2 OBB cánh tay hai bên `localX = ±0.29, y ∈ [0.92, 1.42], hx = 0.08, hz = 0.11`
- **Ngồi (`1.22m`):**
  - `head`: cầu `(x, y + 1.08, z)`, `r = 0.175` *(đỉnh đầu `1.255m < 1.45m` nên nấp kín sau vật cản 1.45m)*
  - `body`: OBB `y ∈ [0.48, 0.94]`, `hx = 0.24, hz = 0.18`
  - `limb`: OBB `y ∈ [0.00, 0.48]`, `hx = 0.22, hz = 0.18`
- **Nằm (`0.58m`, nằm dọc trục tiến `fx = -sin(yaw), fz = -cos(yaw)`):**
  - `head`: cầu `(x + fx * 0.55, y + 0.36, z + fz * 0.55)`, `r = 0.17`
  - `body`: OBB xoay theo `yaw`, tâm `(x, y + 0.24, z)`, `hx = 0.24, hy = 0.20, hz = 0.42`
  - `limb`: OBB xoay theo `yaw`, tâm `(x - fx * 0.65, y + 0.20, z - fz * 0.65)`, `hx = 0.22, hy = 0.18, hz = 0.36`
- **Quy tắc ưu tiên vùng trúng (CS/Truy Kích):** Một tia đạn xuyên qua nhiều hộp của cùng 1 người (ví dụ tay → ngực) sẽ lấy vùng có độ ưu tiên cao nhất (`head > body > limb`) miễn là khoảng cách vào hộp đó nhỏ hơn khoảng cách tới tường gần nhất.

### 4.3 Chống cheat 5 lớp (`server/anti_cheat.js` + `Match.js`)
| Lớp | Gian lận bị chặn | Cơ chế xử lý | Điểm vi phạm |
| :--- | :--- | :--- | :---: |
| 1 | Fake `MSG.HIT` (Client cũ / hack console) | Luôn từ chối (`ERR.INVALID_STATE`), không gây sát thương | `+15` |
| 2 | Wall-peek / Fake `origin` | Kiểm tra khoảng cách so với `authEye` (`<= 0.75m` ngang, `<= 0.55m` dọc) + LoS không xuyên tường; sai thì ép về `authEye` | `+20` |
| 3 | Silent Aim / Magic Bullet (`dir` lệch `yaw/pitch`) | Kiểm tra góc lệch `dir` so với `forward(yaw, pitch)` trong giới hạn `spread*2.5 + recoilAllowance`; sai thì hủy sát thương phát bắn | `+25` |
| 4 | Rapid-Fire (bắn nhanh hơn RPM) | Fire debt tích lũy `nextFireAt = Math.max(now, nextFireAt) + fireInterval` (chỉ dung sai jitter `25ms` cục bộ) | `+10` |
| 5 | Speedhack / Teleport (`STATE`) | Quỹ di chuyển leaky-bucket (`burst <= 1.2m`, bước thường `allowedSpeed * dt * 1.15`), cộng kiểm tra độ cao ngoài thang | `+10` |

- **Suy giảm điểm (Decay):** Giảm `-5` điểm mỗi `10s` chơi sạch để người chơi bị lag cục bộ không bao giờ bị kick nhầm.
- **Ngưỡng hành động:** `>= 40` ghi log cảnh báo server (`console.warn`, không log token/PII); `>= 100` tự động kick khỏi phòng (`MSG.ROOM_KICKED`, `ERR.CHEAT_DETECTED`).

---

## 5. Rủi ro & Hiệu năng
- **CPU Server (`20Hz` tick, tối đa 12 người/phòng):** Mỗi phát bắn chỉ duyệt tối đa 11 đối thủ (broadphase khoảng cách + tối đa 4 hộp/người) và danh sách box/OBB bản đồ (~`0.05–0.15ms`/phát), hoàn toàn nhẹ trên Node.js Render Free.
- **RAM History Buffer:** 12 người × 24 mẫu × ~64 bytes ≈ `18 KB`/phòng (không đáng kể).
- **Cảm giác bắn khi ping cao:** Bù trễ Rewind theo RTT giúp phát bắn trúng trên màn hình đăng ký chính xác ở ping lên tới `300ms`; client chỉ hiển thị hitmarker khi server xác nhận `MSG.EVENT_HIT` để tránh "hitmarker ảo".
