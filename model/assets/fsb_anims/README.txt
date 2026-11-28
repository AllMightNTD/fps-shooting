Đặt 4 file animation tải từ Mixamo (hoặc AccuRIG) vào thư mục này:
  - idle.fbx    (tải "Rifle Idle" với tùy chọn With Skin — hoặc thêm file base_rigged.fbx)
  - run.fbx     (tải "Rifle Run", chọn In-Place; script cũng tự khóa In-Place)
  - crouch.fbx  (tải "Crouch Idle" / "Crouching Idle")
  - jump.fbx    (tải "Jump" / "Rifle Jump")

Sau đó chạy lệnh từ thư mục gốc dự án G:\fps-shooting:
  "C:\Program Files\Blender Foundation\Blender 4.2\blender.exe" --background --python scripts/blender/build_fsb_anims.py
