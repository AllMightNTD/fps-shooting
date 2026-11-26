# Review & Hướng Cải thiện Đồ họa Map 3D (Python Procedural + Three.js)

Tài liệu này tổng hợp đánh giá chi tiết cho bản đồ khu quân sự hiện tại và lộ trình nâng cấp đồ họa theo hướng **chân thực hơn nhưng vẫn giữ mượt 60+ FPS**, tối ưu riêng cho quy trình **tự dựng model và texture bằng Python**.

---

## 1. Đánh giá hiện trạng bản đồ

### Điểm mạnh hiện có
* Bố cục khu quân sự rõ ràng, có điểm nhấn thị giác (tường bao, container, thùng gỗ, drone).
* Tường bê tông ở cự ly gần có vân rêu khá tự nhiên; dây thép gai trên tường bao sắc nét.
* Hệ thống bóng đổ cơ bản đã hoạt động ổn định.

### 5 điểm làm bản đồ trông "giả" nhất cần khắc phục
1. **Mặt đất quá trắng & vũng nước ngược quy luật vật lý:** Nền sân sáng màu giống đất phấn/tuyết, đường viền loang lộ rõ nhiễu toán học (noise contour). Vũng nước đang sáng hơn nền bê tông khô, trong khi thực tế **bê tông ướt luôn tối màu hơn bê tông khô 40–50%**.
2. **Tán cây lộ khối đa giác (Low-poly blobs):** Hàng cây sau tường có dạng các khối cầu gồ ghề ghép lại, thiếu độ tơi của lá và khe hở ánh sáng.
3. **Bụi cỏ dựng đứng và lệch tông:** Cỏ mọc thành cụm hình chữ nhật xanh đen tương phản gắt với nền sáng, tạo cảm giác bị dán nổi thay vì mọc tự nhiên ở chân tường/khe nứt.
4. **Bầu trời và dãy núi xa phẳng lì:** Trời xám trắng đều, núi xa là mảng xám bẹt thiếu sương mù khí quyển (*atmospheric haze*), tạo cảm giác như mô hình hộp kín.
5. **Cạnh tường sắc & thiếu bóng chân:** Tường bê tông góc vuông 90° sắc lẹm, thiếu gờ mũ tường (*wall cap*) và dải bám bẩn sát chân tường. Thân súng M416 hơi đen bệt ở mặt tối do thiếu ánh sáng phản chiếu môi trường (IBL).

---

## 2. Hướng cải thiện từ phía Python (Pipeline tạo Asset & Texture PBR)

Nguyên tắc cốt lõi: **Dồn chi tiết vào texture bake và pháp tuyến (normal), giữ lưới hình học gọn để tối ưu cho WebGL.**

### A. Mặt đất & Vũng nước chuẩn vật lý ("Wetness Darkening")
* Hạ độ sáng màu nền bê tông xuống tông xám-nâu trung tính (`#7a7770`).
* Tạo mặt nạ vũng nước (`puddle_mask` từ `0.0` đến `1.0` bằng FBM/Perlin noise làm mềm biên).
* Tại vùng ẩm/nước: tự động **làm tối kênh Albedo ~40%** ở vùng viền ẩm và **hạ kênh Roughness xuống `0.06`** ở lòng vũng nước.
* Bổ sung đường nứt mảnh (Voronoi edge) để thay thế các đường viền loang lổ hiện tại.

### B. Tán cây nhẹ và thật với "Leaf Cards" + Normal Smoothing
* Dựng thân và cành chính khoảng ~150 tam giác, sau đó rải **40–80 tấm mặt phẳng xoay ngẫu nhiên (leaf cards)** quanh đầu cành.
* Dùng Python (Pillow/Cairo) vẽ texture cành lá trong suốt, thiết lập `alphaTest: 0.5` trong Three.js *(không dùng `transparent: true` để tránh tụt FPS do overdraw)*.
* **Kỹ thuật quan trọng:** Ghi đè vector pháp tuyến (`normal`) của tất cả các tấm lá sao cho chúng **hướng tỏa tròn từ tâm tán cây ra ngoài**. Cách này giúp tán cây bắt sáng mềm mượt như game AAA nhưng chỉ tốn ~300–500 tam giác/cây.

### C. Vát cạnh (Bevel) & Vệt bẩn chân tường (Baked AO / Grime)
* Thêm **Bevel nhỏ (1–2 segments)** ở các cạnh ngoài của tường bê tông, rào chắn, thùng gỗ để bắt sáng viền nắng; bổ sung thanh gờ mũ mỏng trên đỉnh tường.
* Phủ tự động một dải **gradient tối màu** (qua Vertex Color hoặc bake vào Albedo/AO) cao khoảng `0.35m` sát chân tường, chân container và các khe lõm thùng gỗ. Cách này giúp vật thể "đè nặng" dính chặt xuống đất mà **tốn 0% hiệu năng GPU**.

### D. Cụm cỏ tự nhiên
* Cho các lá cỏ uốn cong nhẹ và xòe hình quạt không đều thay vì dựng đứng song song.
* Gán **Vertex Color** chuyển sắc từ nâu đất sẫm ở gốc lên xanh vàng úa ở ngọn để gốc cỏ hòa mượt vào nền đất.

---

## 3. Hướng cải thiện phía Three.js (Đồ họa & Giữ 60+ FPS)

| Hạng mục | Thay đổi đề xuất trong Three.js | Tác động đồ họa | Chi phí hiệu năng |
| :--- | :--- | :--- | :--- |
| **Ánh sáng & Trời** | Dùng `Sky` shader (nắng xế góc 30–35°) + `DirectionalLight` vàng ấm (`0xfff0d4`) + `HemisphereLight` xanh trời / nâu đất | Thay đổi toàn bộ không khí bản đồ, hết vẻ xám xịt | Rất nhẹ |
| **Chiều sâu núi xa** | Thêm `THREE.FogExp2(0xb8c8d8, 0.0045)` trùng màu chân trời | Dãy núi xa mờ dần tự nhiên vào không khí | Gần như 0 |
| **Phản xạ kim loại & nước** | Tạo 1 `PMREMGenerator` từ `Sky` (chạy 1 lần lúc load) gán vào `scene.environment` | Súng M416 hết đen bệt; vũng nước phản chiếu đúng nền trời | 0ms sau khi load |
| **Cỏ, đá, trụ rào, thùng** | Gom toàn bộ vật thể lặp lại vào **`THREE.InstancedMesh`** (chỉ đặt cỏ dọc chân tường, quanh đá, khe nứt) | Hết cảm giác cỏ mọc rải rác giả tạo | Giảm hàng trăm Draw Call xuống còn **3–5 Draw Call** |
| **Bóng đổ & Texture** | Tắt `castShadow` cho cỏ nhỏ và đá vụn; bật `tex.anisotropy = renderer.capabilities.getMaxAnisotropy()`; đặt `matrixAutoUpdate = false` cho mọi tường/nhà tĩnh | Sàn bê tông và tường nét căng khi nhìn xiên | Tăng FPS rõ rệt |

---

## 4. Đoạn mã Python mẫu: Tạo Texture Sân Bê Tông Ướt chuẩn vật lý

Script dùng `numpy` và `Pillow` tạo cặp bản đồ `concrete_albedo.webp` và `concrete_roughness.webp` (vùng ẩm tự tối màu, lòng vũng nước soi bóng):

```python
import numpy as np
from PIL import Image

def fbm_noise(size, octaves=4, seed=42):
    rng = np.random.default_rng(seed)
    acc = np.zeros((size, size), dtype=np.float32)
    amp, total_amp = 1.0, 0.0
    for o in range(octaves):
        grid = max(4, 2 ** (o + 2))
        low = rng.random((grid, grid), dtype=np.float32)
        img = Image.fromarray((low * 255).astype(np.uint8)).resize(
            (size, size), Image.Resampling.BICUBIC
        )
        acc += (np.asarray(img, dtype=np.float32) / 255.0) * amp
        total_amp += amp
        amp *= 0.5
    return acc / total_amp

def generate_wet_concrete_maps(size=1024):
    # 1. Hạt bê tông mịn & mảng loang ẩm lớn
    grain = fbm_noise(size, octaves=6, seed=1)
    wear = fbm_noise(size, octaves=3, seed=7)
    puddle_field = fbm_noise(size, octaves=4, seed=21)

    # Mặt nạ vùng ẩm (damp: 0->1) và lòng vũng nước (puddle: 0->1)
    damp = np.clip((puddle_field - 0.52) / 0.14, 0.0, 1.0)
    puddle = np.clip((puddle_field - 0.62) / 0.06, 0.0, 1.0)

    # 2. Albedo: Tông bê tông quân sự trung tính (không quá trắng)
    base_val = 0.44 + (grain - 0.5) * 0.14 + (wear - 0.5) * 0.10
    # Quy tắc vật lý: vùng ẩm tối đi ~42%
    darkened = base_val * (1.0 - 0.42 * damp)

    r = np.clip(darkened * 1.03, 0, 1)
    g = np.clip(darkened * 1.01, 0, 1)
    b = np.clip(darkened * 0.96, 0, 1)
    albedo = np.stack([r, g, b], axis=-1)

    # 3. Roughness: Bê tông khô ~0.85, viền ẩm ~0.38, lòng vũng nước ~0.06
    roughness = 0.85 - 0.10 * grain
    roughness = roughness * (1.0 - damp) + 0.38 * damp
    roughness = roughness * (1.0 - puddle) + 0.06 * puddle
    roughness = np.clip(roughness, 0.05, 0.95)

    Image.fromarray((albedo * 255).astype(np.uint8)).save("concrete_albedo.webp", quality=88)
    Image.fromarray((roughness * 255).astype(np.uint8)).save("concrete_roughness.webp", quality=88)

generate_wet_concrete_maps(1024)
```

> **Lưu ý khi nạp vào Three.js:** Đặt `concrete_albedo.colorSpace = THREE.SRGBColorSpace`, giữ `concrete_roughness` ở `NoColorSpace` mặc định và đặt `material.roughness = 1.0` để texture kiểm soát toàn bộ độ nhám.

---

## 5. Checklist thứ tự ưu tiên triển khai

- [ ] **Bước 1 (Tác động mạnh nhất):** Thay ánh sáng sang `Sky` + `DirectionalLight` nắng ấm + `FogExp2` + `PMREMGenerator` cho `scene.environment`.
- [ ] **Bước 2:** Tạo lại texture sân bê tông ướt bằng script Python trên và bật `anisotropy` tối đa trong Three.js.
- [ ] **Bước 3:** Cập nhật script Python thêm Bevel cạnh tường và dải gradient bám bẩn (AO) sát chân tường/vật cản.
- [ ] **Bước 4:** Thay cây khối cầu sang kỹ thuật Leaf Cards có Normal tỏa tròn và gom cỏ/đá vào `InstancedMesh`.