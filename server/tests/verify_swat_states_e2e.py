#!/usr/bin/env python3
"""Headless WebGL 2-player LAN E2E verification & video capture for the 6-state SWAT model.

Tests all 6 integrated SWAT animations & player postures in live gameplay:
  1. Đứng (idle)
  2. Ngồi (crouch — KeyC)
  3. Nhảy (jump — Space)
  4. Chạy (run — ShiftLeft + KeyW)
  5. Nằm (prone — KeyZ)
  6. Bò (prone_move — KeyZ + KeyW)

Records a continuous 1280x720 WebM video from the Observer's perspective (with live
diagnostic banner & clean framing), trims lobby setup via Playwright's FFmpeg, saves
per-state screenshots + report.json, and asserts WebSocket sync, AnimationMixer state,
bone hitbox heights, and zero runtime/WebGL errors.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
]


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _find_playwright_ffmpeg() -> str | None:
    local_app = os.environ.get("LOCALAPPDATA", "")
    candidates = sorted(
        glob.glob(os.path.join(local_app, "ms-playwright", "ffmpeg-*", "ffmpeg-win64.exe")),
        reverse=True,
    )
    candidates.extend(
        sorted(
            glob.glob(os.path.expanduser("~/.cache/ms-playwright/ffmpeg-*/ffmpeg-linux")),
            reverse=True,
        )
    )
    for c in candidates:
        if os.path.isfile(c):
            return c
    return shutil.which("ffmpeg")


def _launch_chrome(p, prefer_sw: bool = False) -> tuple[Browser, str]:
    anti_throttle = [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
    ]
    hw_args = ["--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox", *anti_throttle]
    sw_args = [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-webgl",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--no-sandbox",
        *anti_throttle,
    ]
    attempts: list[tuple[str, dict[str, Any]]] = []
    for exe in CHROME_CANDIDATES:
        if os.path.isfile(exe):
            if prefer_sw:
                attempts.append((f"sw:{Path(exe).name}", {"headless": True, "executable_path": exe, "args": sw_args}))
            else:
                attempts.append((f"hw:{Path(exe).name}", {"headless": True, "executable_path": exe, "args": hw_args}))
                attempts.append((f"sw:{Path(exe).name}", {"headless": True, "executable_path": exe, "args": sw_args}))
    attempts.append(("default_sw", {"headless": True, "args": sw_args}))

    errors: list[str] = []
    for label, kwargs in attempts:
        try:
            browser = p.chromium.launch(**kwargs)
            return browser, label
        except Exception as exc:
            errors.append(f"{label}: {exc}")
    raise RuntimeError("Could not launch WebGL Chrome:\n" + "\n".join(errors))


class ErrorTracker:
    def __init__(self) -> None:
        self.console_errors: list[str] = []
        self.pageerrors: list[str] = []
        self.http_errors: list[str] = []
        self.request_failed: list[str] = []

    def attach(self, page: Page, label: str) -> None:
        page.on(
            "console",
            lambda msg: self.console_errors.append(f"[{label}] {msg.text}")
            if msg.type == "error"
            else None,
        )
        page.on("pageerror", lambda err: self.pageerrors.append(f"[{label}] {err}"))
        page.on(
            "response",
            lambda res: self.http_errors.append(f"[{label}] HTTP {res.status} {res.url}")
            if res.status >= 400 and "favicon" not in res.url
            else None,
        )
        page.on(
            "requestfailed",
            lambda req: self.request_failed.append(f"[{label}] {req.url} ({req.failure})")
            if "Before_the_Breach" not in req.url
            else None,
        )

    def assert_clean(self, stage: str) -> None:
        issues: list[str] = []
        if self.console_errors:
            issues.append(f"console_errors={self.console_errors}")
        if self.pageerrors:
            issues.append(f"pageerrors={self.pageerrors}")
        if self.http_errors:
            issues.append(f"http_errors={self.http_errors}")
        if self.request_failed:
            issues.append(f"request_failed={self.request_failed}")
        if issues:
            raise AssertionError(f"Runtime errors during {stage}: " + "; ".join(issues))


def _wait_ready(page: Page, url: str) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    try:
        page.wait_for_function(
            """() => Boolean(
              window.__fpsReady &&
              window.__militaryMapLoaded &&
              window.__m416Loaded &&
              window.__armsLoaded &&
              window.__soldierLoaded &&
              window.__fpsApp &&
              window.__fpsApp.game
            )""",
            polling=150,
            timeout=40000,
        )
    except Exception as exc:
        diag = page.evaluate(
            """() => ({
              fpsReady: Boolean(window.__fpsReady),
              mil: Boolean(window.__militaryMapLoaded),
              m416: Boolean(window.__m416Loaded),
              arms: Boolean(window.__armsLoaded),
              soldier: Boolean(window.__soldierLoaded),
              app: Boolean(window.__fpsApp),
              loading: document.getElementById("loadingDetail")?.textContent,
            })"""
        )
        raise RuntimeError(f"_wait_ready timeout for {url}: diag={diag}") from exc


def _lock_controls(page: Page) -> None:
    page.evaluate(
        """() => {
          const ov = document.getElementById("pauseOverlay");
          if (ov && getComputedStyle(ov).display !== "none") {
            const btn = document.getElementById("btnPauseResume");
            if (btn) btn.click();
            ov.style.display = "none";
          }
          window.__fpsApp.game.getState().setTestCombat({ locked: true });
        }"""
    )
    page.wait_for_function("() => window.__fpsApp.input.active === true", timeout=6000)


def _install_observer_overlay(page: Page) -> None:
    page.evaluate(
        """() => {
          if (document.getElementById("swatShowcaseBanner")) return;
          const wrap = document.createElement("div");
          wrap.id = "swatShowcaseBanner";
          wrap.style.cssText = [
            "position:fixed",
            "left:18px",
            "top:66px",
            "z-index:9999",
            "padding:10px 14px",
            "border-radius:10px",
            "background:rgba(8,14,22,0.82)",
            "border:1px solid rgba(78,195,176,0.55)",
            "color:#e8f2f8",
            "font-family:'Segoe UI',system-ui,sans-serif",
            "pointer-events:none",
            "min-width:290px",
            "box-shadow:0 6px 20px rgba(0,0,0,0.45)",
          ].join(";");
          const title = document.createElement("div");
          title.id = "swatShowcaseTitle";
          title.style.cssText = "font-size:15px;font-weight:700;color:#4ec3b0;letter-spacing:0.3px;";
          const meta = document.createElement("div");
          meta.id = "swatShowcaseMeta";
          meta.style.cssText = "font-size:12.5px;color:#c7d8e4;margin-top:4px;font-family:Consolas,monospace;";
          wrap.append(title, meta);
          document.body.appendChild(wrap);
        }"""
    )


def _set_observer_banner(page: Page, title_text: str, meta_text: str) -> None:
    page.evaluate(
        """([titleText, metaText]) => {
          const t = document.getElementById("swatShowcaseTitle");
          const m = document.getElementById("swatShowcaseMeta");
          if (t) t.textContent = titleText;
          if (m) m.textContent = metaText;
        }""",
        [title_text, meta_text],
    )


def _get_remote_telemetry(observer: Page) -> dict[str, Any]:
    return observer.evaluate(
        """() => {
          const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
          if (!av) return null;
          av.container.updateMatrixWorld(true);
          const rig = av.rig || {};
          const headBox = (av.hitMeshes || []).find((m) => m.name === "hitbox_head");
          let headWorldY = null;
          if (headBox) {
            const p = headBox.getWorldPosition(new window.THREE.Vector3());
            headWorldY = Number(p.y.toFixed(3));
          }
          let crownY = null;
          const crown = rig.root ? rig.root.getObjectByName("head_team_iff") : null;
          if (crown) {
            const cp = crown.getWorldPosition(new window.THREE.Vector3());
            crownY = Number(cp.y.toFixed(3));
          }
          let weaponForwardDot = null;
          let weaponUpY = null;
          if (rig.weaponMount) {
            const mQuat = rig.weaponMount.getWorldQuaternion(new window.THREE.Quaternion());
            const mBarrel = new window.THREE.Vector3(0, 0, -1).applyQuaternion(mQuat).normalize();
            const mUp = new window.THREE.Vector3(0, 1, 0).applyQuaternion(mQuat).normalize();
            const cFwd = new window.THREE.Vector3(0, 0, -1).applyQuaternion(av.container.quaternion).normalize();
            weaponForwardDot = Number(mBarrel.dot(cFwd).toFixed(3));
            weaponUpY = Number(mUp.y.toFixed(3));
          }
          return {
            name: av.name,
            team: av.team,
            alive: av.alive,
            flags: av.flags || 0,
            isSkinned: Boolean(rig.isSkinned),
            actionKeys: rig.actions ? Object.keys(rig.actions) : [],
            activeState: rig.activeState || "",
            weaponAttached: Boolean(av.weaponAttached),
            weaponId: av.weaponId,
            weaponForwardDot,
            weaponUpY,
            pos: {
              x: Number(av.container.position.x.toFixed(3)),
              y: Number(av.container.position.y.toFixed(3)),
              z: Number(av.container.position.z.toFixed(3)),
            },
            headWorldY,
            crownY,
            invulnerable: Boolean(av.shieldDome && av.shieldDome.visible),
          };
        }"""
    )


def _get_actor_telemetry(actor: Page) -> dict[str, Any]:
    return actor.evaluate(
        """() => {
          const st = window.__fpsApp.game.getState();
          const me = st.getMe();
          const badge = document.getElementById("postureBadge");
          return {
            x: Number(st.P.x.toFixed(3)),
            y: Number(st.P.y.toFixed(3)),
            z: Number(st.P.z.toFixed(3)),
            crouched: Boolean(me.crouched),
            prone: Boolean(me.prone),
            grounded: Boolean(me.grounded),
            isSprinting: Boolean(me.isSprinting),
            flags: me.flags,
            eyeHeight: Number(me.eyeHeight.toFixed(3)),
            postureBadge: badge ? badge.textContent : "",
          };
        }"""
    )


def _aim_observer_at(observer: Page, obs_pos: tuple[float, float, float], target_xz: tuple[float, float], pitch: float = -0.22) -> None:
    ox, oy, oz = obs_pos
    tx, tz = target_xz
    dx = tx - ox
    dz = tz - oz
    # Shift slightly right (+yaw? no, -yaw turns right in Three.js) so actor sits cleanly left-of-center away from 1P gun
    yaw = math.atan2(-dx, -dz) - 0.14
    observer.evaluate(
        """([ox, oy, oz, yaw, pitch]) => {
          const st = window.__fpsApp.game.getState();
          st.setPose(ox, oy, oz, yaw, pitch);
          st.setTestCombat({ locked: true, aimHeld: false, adsSteps: 80 });
          window.__fpsApp.game.gunAnim(0, 0);
        }""",
        [ox, oy, oz, yaw, pitch],
    )


def _set_actor_pose(actor: Page, x: float, y: float, z: float, yaw: float) -> None:
    actor.evaluate(
        """([x, y, z, yaw]) => {
          const st = window.__fpsApp.game.getState();
          st.setPose(x, y, z, yaw, 0.0);
        }""",
        [x, y, z, yaw],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", required=True, help="Directory to write video, screenshots, and report.json")
    args = parser.parse_args()

    out_dir = Path(args.out_dir).resolve()
    raw_video_dir = out_dir / "_raw_video"
    ss_dir = out_dir / "screenshots"
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_video_dir.mkdir(parents=True, exist_ok=True)
    ss_dir.mkdir(parents=True, exist_ok=True)

    port = _find_free_port()
    node_exe = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    proc = subprocess.Popen(
        [node_exe, "server/index.js", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(1.0)

    tracker = ErrorTracker()
    report: dict[str, Any] = {"port": port, "out_dir": str(out_dir), "states": {}}
    raw_video_path: Path | None = None
    match_ready_t0 = 0.0
    video_start_t0 = 0.0

    try:
        base_url = f"http://127.0.0.1:{port}/FPS.html"
        with sync_playwright() as p:
            browser_obs, launcher = _launch_chrome(p, prefer_sw=False)
            browser_act, actor_launcher = _launch_chrome(p, prefer_sw=True)
            report["launcher"] = launcher
            report["actor_launcher"] = actor_launcher

            ctx_obs: BrowserContext = browser_obs.new_context(
                viewport={"width": 1280, "height": 720},
                record_video_dir=str(raw_video_dir),
                record_video_size={"width": 1280, "height": 720},
            )
            ctx_obs.add_init_script(
                "localStorage.setItem('fps_user_settings_v2', JSON.stringify({ graphicsQuality: 'high' }));"
            )
            ctx_act: BrowserContext = browser_act.new_context(viewport={"width": 960, "height": 540})
            ctx_act.add_init_script(
                "localStorage.setItem('fps_user_settings_v2', JSON.stringify({ graphicsQuality: 'low' }));"
            )

            observer = ctx_obs.new_page()
            video_start_t0 = time.monotonic()
            actor = ctx_act.new_page()
            tracker.attach(observer, "Observer")
            tracker.attach(actor, "SwatActor")

            try:
                _wait_ready(observer, base_url)
                _wait_ready(actor, base_url)
                observer.bring_to_front()

                # Host (Observer) creates a TDM room on Khu Quân Sự Cũ
                room_name = f"SWAT_6STATES_{port}"
                observer.fill("#nickInput", "CameraMan")
                observer.click("#btnModeTDM")
                observer.wait_for_function(
                    "() => getComputedStyle(document.getElementById('lobbyLanView')).opacity === '1'",
                    timeout=10000,
                )
                observer.click("#btnOpenCreate")
                observer.fill("#createRoomName", room_name)
                observer.click("#btnCreateSubmit")
                observer.wait_for_function(
                    "() => getComputedStyle(document.getElementById('screenRoom')).display === 'grid'",
                    timeout=12000,
                )

                # Guest (SwatActor, auto-assigned Team B) joins, readies, and Host starts match
                actor.fill("#nickInput", "SWAT_Operator")
                actor.click("#btnModeTDM")
                actor.wait_for_function(
                    "(rn) => Array.from(document.querySelectorAll('#lobbyRoomBody tr')).some(tr => tr.textContent.includes(rn))",
                    arg=room_name,
                    timeout=12000,
                )
                actor.evaluate(
                    "(rn) => { const tr = Array.from(document.querySelectorAll('#lobbyRoomBody tr')).find(r => r.textContent.includes(rn)); tr?.querySelector('button')?.click(); }",
                    room_name,
                )
                actor.wait_for_function(
                    "() => getComputedStyle(document.getElementById('screenRoom')).display === 'grid' && window.__fpsApp.roomCtrl.getRoom()?.players?.length === 2",
                    timeout=12000,
                )
                actor.click("#btnRoomReady")
                actor.wait_for_function(
                    "() => document.getElementById('btnRoomReady')?.textContent.includes('Hủy sẵn sàng')",
                    timeout=5000,
                )
                observer.click("#btnRoomStart")

                for pg in (observer, actor):
                    pg.wait_for_function(
                        "() => { const st = window.__fpsApp.game.getState(); return st.engineMode === 'lan' && st.activeState === 'play'; }",
                        timeout=15000,
                    )

                observer.wait_for_timeout(200)
                _lock_controls(observer)
                _lock_controls(actor)

                observer.wait_for_function(
                    "() => window.__fpsApp.game.getState().getRemotePlayers().size >= 1",
                    timeout=15000,
                )

                # Position Observer right in Team B sunlit courtyard across from SwatActor
                obs_pos = (-1.65, 0.0, 41.15)
                act_center = (0.35, 0.0, 39.15)
                _aim_observer_at(observer, obs_pos, (act_center[0], act_center[2]), pitch=-0.22)
                _set_actor_pose(actor, act_center[0], act_center[1], act_center[2], yaw=1.92)
                _install_observer_overlay(observer)

                # Wait for 2.5s spawn shield dome to fade and interpolation to settle cleanly
                observer.wait_for_function(
                    """() => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && !av.shieldDome.visible && Math.hypot(av.container.position.x - 0.35, av.container.position.z - 39.15) < 0.85;
                    }""",
                    timeout=12000,
                )
                observer.wait_for_timeout(350)
                match_ready_t0 = time.monotonic()

                # Verify remote SWAT rig & all 6 clips loaded
                init_rem = _get_remote_telemetry(observer)
                assert init_rem and init_rem["isSkinned"] is True, f"Remote SWAT is not SkinnedMesh: {init_rem}"
                for req_clip in ("idle", "run", "crouch", "jump", "prone", "prone_move"):
                    assert req_clip in init_rem["actionKeys"], f"Missing action '{req_clip}': {init_rem}"
                assert init_rem["weaponAttached"] is True, f"Weapon not attached to SWAT rig: {init_rem}"
                report["rig_info"] = init_rem

                # ---- STATE 1: ĐỨNG (idle) ----
                _set_observer_banner(
                    observer,
                    "1/6 — ĐỨNG (idle)",
                    "Phím: Mặc định | Clip: idle | SkinnedMesh 41 xương + M416",
                )
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'idle'",
                    timeout=6000,
                )
                observer.wait_for_timeout(1600)
                rem_idle = _get_remote_telemetry(observer)
                act_idle = _get_actor_telemetry(actor)
                assert rem_idle["activeState"] == "idle", rem_idle
                assert 1.30 <= rem_idle["headWorldY"] <= 1.85, rem_idle
                assert rem_idle["weaponForwardDot"] > 0.90 and rem_idle["weaponUpY"] > 0.90, rem_idle
                ss1 = ss_dir / "01_idle_dung.png"
                observer.screenshot(path=str(ss1))
                report["states"]["idle"] = {"remote": rem_idle, "actor": act_idle, "screenshot": str(ss1)}

                # ---- STATE 2: NGỒI (crouch) ----
                _set_observer_banner(
                    observer,
                    "2/6 — NGỒI (crouch)",
                    "Phím: Giữ C | Clip: crouch | Hạ trọng tâm & hitbox",
                )
                actor.keyboard.down("KeyC")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'crouch'",
                    timeout=6000,
                )
                observer.wait_for_timeout(1400)
                rem_crouch = _get_remote_telemetry(observer)
                act_crouch = _get_actor_telemetry(actor)
                assert rem_crouch["activeState"] == "crouch", rem_crouch
                assert act_crouch["crouched"] is True and act_crouch["eyeHeight"] < 1.22, act_crouch
                assert rem_crouch["headWorldY"] < rem_idle["headWorldY"] - 0.30, (rem_crouch, rem_idle)
                assert rem_crouch["weaponForwardDot"] > 0.72 and rem_crouch["weaponUpY"] > 0.88, rem_crouch
                ss2 = ss_dir / "02_crouch_ngoi.png"
                observer.screenshot(path=str(ss2))
                report["states"]["crouch"] = {"remote": rem_crouch, "actor": act_crouch, "screenshot": str(ss2)}

                actor.keyboard.up("KeyC")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'idle'",
                    timeout=6000,
                )
                observer.wait_for_timeout(500)

                # ---- STATE 3: NHẢY (jump) ----
                _set_observer_banner(
                    observer,
                    "3/6 — NHẢY (jump)",
                    "Phím: Space | Clip: jump (nhịp tiếp đất nhanh 0.07s)",
                )
                actor.keyboard.press("Space")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'jump'",
                    timeout=6000,
                )
                observer.wait_for_timeout(120)
                rem_jump = _get_remote_telemetry(observer)
                act_jump = _get_actor_telemetry(actor)
                assert rem_jump["activeState"] == "jump", rem_jump
                assert rem_jump["headWorldY"] > rem_idle["headWorldY"] + 0.12 or rem_jump["pos"]["y"] > 0.12, rem_jump
                assert rem_jump["weaponForwardDot"] > 0.82 and rem_jump["weaponUpY"] > 0.88, rem_jump
                ss3 = ss_dir / "03_jump_nhay.png"
                observer.screenshot(path=str(ss3))
                # Wait landing and perform a second clean jump for clear video review
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'idle'",
                    timeout=6000,
                )
                observer.wait_for_timeout(450)
                actor.keyboard.press("Space")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'idle'",
                    timeout=6000,
                )
                observer.wait_for_timeout(450)
                report["states"]["jump"] = {"remote": rem_jump, "actor": act_jump, "screenshot": str(ss3)}

                # ---- STATE 4: CHẠY (run) ----
                _set_observer_banner(
                    observer,
                    "4/6 — CHẠY (run)",
                    "Phím: Shift + W | Clip: run | Tốc độ 1.35x In-Place",
                )
                run_start = (-1.1, 0.0, 38.0)
                run_yaw = math.atan2(-(1.5 - run_start[0]), -(39.8 - run_start[2]))
                _set_actor_pose(actor, run_start[0], 0.0, run_start[2], run_yaw)
                observer.wait_for_function(
                    """([tx, tz]) => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && Math.hypot(av.container.position.x - tx, av.container.position.z - tz) < 0.25;
                    }""",
                    arg=[run_start[0], run_start[2]],
                    polling=100,
                    timeout=8000,
                )
                run_pos_before = _get_remote_telemetry(observer)["pos"]

                actor.keyboard.down("ShiftLeft")
                actor.keyboard.down("KeyW")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'run'",
                    polling=100,
                    timeout=6000,
                )
                observer.wait_for_function(
                    """([x0, z0]) => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && Math.hypot(av.container.position.x - x0, av.container.position.z - z0) >= 0.9;
                    }""",
                    arg=[run_pos_before["x"], run_pos_before["z"]],
                    polling=100,
                    timeout=8000,
                )
                rem_run = _get_remote_telemetry(observer)
                act_run = _get_actor_telemetry(actor)
                ss4 = ss_dir / "04_run_chay.png"
                observer.screenshot(path=str(ss4))
                observer.wait_for_function(
                    """([x0, z0]) => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && Math.hypot(av.container.position.x - x0, av.container.position.z - z0) >= 1.8;
                    }""",
                    arg=[run_pos_before["x"], run_pos_before["z"]],
                    polling=100,
                    timeout=8000,
                )
                actor.keyboard.up("KeyW")
                actor.keyboard.up("ShiftLeft")
                run_pos_after = _get_remote_telemetry(observer)["pos"]
                run_dist = math.hypot(run_pos_after["x"] - run_pos_before["x"], run_pos_after["z"] - run_pos_before["z"])
                assert rem_run["activeState"] == "run", rem_run
                assert rem_run["weaponForwardDot"] > 0.72 and rem_run["weaponUpY"] > 0.85, rem_run
                assert run_dist >= 1.5, f"Expected SWAT to run >=1.5m, moved {run_dist:.2f}m"
                report["states"]["run"] = {
                    "remote": rem_run,
                    "actor": act_run,
                    "moved_m": round(run_dist, 3),
                    "screenshot": str(ss4),
                }

                # Return to center before Prone
                _set_actor_pose(actor, act_center[0], 0.0, act_center[2], yaw=1.45)
                observer.wait_for_function(
                    """([tx, tz]) => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && av.rig?.activeState === 'idle' && Math.hypot(av.container.position.x - tx, av.container.position.z - tz) < 0.25;
                    }""",
                    arg=[act_center[0], act_center[2]],
                    polling=100,
                    timeout=8000,
                )
                observer.wait_for_timeout(400)

                # ---- STATE 5: NẰM (prone) ----
                _set_observer_banner(
                    observer,
                    "5/6 — NẰM (prone)",
                    "Phím: Z | Clip: prone | Hạ mắt 0.42m & giảm giật 0.65x",
                )
                actor.keyboard.press("KeyZ")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'prone'",
                    polling=100,
                    timeout=6000,
                )
                observer.wait_for_timeout(1600)
                rem_prone = _get_remote_telemetry(observer)
                act_prone = _get_actor_telemetry(actor)
                assert rem_prone["activeState"] == "prone", rem_prone
                assert act_prone["prone"] is True and act_prone["eyeHeight"] < 0.50, act_prone
                assert rem_prone["headWorldY"] < 0.72, rem_prone
                assert rem_prone["weaponForwardDot"] > 0.88 and rem_prone["weaponUpY"] > 0.85, rem_prone
                assert "Nằm" in act_prone["postureBadge"], act_prone
                ss5 = ss_dir / "05_prone_nam.png"
                observer.screenshot(path=str(ss5))
                report["states"]["prone"] = {"remote": rem_prone, "actor": act_prone, "screenshot": str(ss5)}

                # ---- STATE 6: BÒ (prone_move) ----
                _set_observer_banner(
                    observer,
                    "6/6 — BÒ (prone_move)",
                    "Phím: Z + W | Clip: prone_move | Tốc độ bò 0.30x",
                )
                crawl_start = (-1.1, 0.0, 38.2)
                crawl_yaw = math.atan2(-(1.6 - crawl_start[0]), -(39.8 - crawl_start[2]))
                _set_actor_pose(actor, crawl_start[0], 0.0, crawl_start[2], crawl_yaw)
                observer.wait_for_function(
                    """([tx, tz]) => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && Math.hypot(av.container.position.x - tx, av.container.position.z - tz) < 0.25;
                    }""",
                    arg=[crawl_start[0], crawl_start[2]],
                    polling=100,
                    timeout=8000,
                )
                crawl_pos_before = _get_remote_telemetry(observer)["pos"]

                actor.keyboard.down("KeyW")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'prone_move'",
                    polling=100,
                    timeout=6000,
                )
                observer.wait_for_function(
                    """([x0, z0]) => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && Math.hypot(av.container.position.x - x0, av.container.position.z - z0) >= 0.75;
                    }""",
                    arg=[crawl_pos_before["x"], crawl_pos_before["z"]],
                    polling=100,
                    timeout=12000,
                )
                rem_crawl = _get_remote_telemetry(observer)
                act_crawl = _get_actor_telemetry(actor)
                ss6 = ss_dir / "06_prone_move_bo.png"
                observer.screenshot(path=str(ss6))
                observer.wait_for_function(
                    """([x0, z0]) => {
                      const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                      return av && Math.hypot(av.container.position.x - x0, av.container.position.z - z0) >= 1.5;
                    }""",
                    arg=[crawl_pos_before["x"], crawl_pos_before["z"]],
                    polling=100,
                    timeout=12000,
                )
                actor.keyboard.up("KeyW")
                crawl_pos_after = _get_remote_telemetry(observer)["pos"]
                crawl_dist = math.hypot(crawl_pos_after["x"] - crawl_pos_before["x"], crawl_pos_after["z"] - crawl_pos_before["z"])
                assert rem_crawl["activeState"] == "prone_move", rem_crawl
                assert act_crawl["prone"] is True and rem_crawl["headWorldY"] < 0.72, (rem_crawl, act_crawl)
                assert rem_crawl["weaponForwardDot"] > 0.85 and rem_crawl["weaponUpY"] > 0.85, rem_crawl
                assert "Bò" in act_crawl["postureBadge"], act_crawl
                assert crawl_dist >= 1.3, f"Expected SWAT to crawl >=1.3m, moved {crawl_dist:.2f}m"
                report["states"]["prone_move"] = {
                    "remote": rem_crawl,
                    "actor": act_crawl,
                    "moved_m": round(crawl_dist, 3),
                    "screenshot": str(ss6),
                }

                # Stand back up via Z -> idle cleanly at end of video
                _set_observer_banner(
                    observer,
                    "HOÀN TẤT 6/6 TRẠNG THÁI — ĐỨNG DẬY (Z -> idle)",
                    "Kiểm tra đứng dậy an toàn + đồng bộ FPS/Server OK",
                )
                actor.keyboard.press("KeyZ")
                observer.wait_for_function(
                    "() => Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0]?.rig?.activeState === 'idle'",
                    timeout=6000,
                )
                observer.wait_for_timeout(900)
                act_stand_end = _get_actor_telemetry(actor)
                assert act_stand_end["prone"] is False and act_stand_end["crouched"] is False, act_stand_end

                tracker.assert_clean("SWAT 6-state video E2E")
                raw_video_path = Path(observer.video.path())
            finally:
                ctx_act.close()
                ctx_obs.close()
                browser_act.close()
                browser_obs.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    # Trim lobby setup from raw Playwright WebM so video opens right inside the live match
    final_video_path = out_dir / "swat_6_states_test.webm"
    if raw_video_path and raw_video_path.is_file():
        trim_offset = max(0.0, (match_ready_t0 - video_start_t0) - 0.35)
        ffmpeg_exe = _find_playwright_ffmpeg()
        if ffmpeg_exe and trim_offset > 0.8:
            cmd = [
                ffmpeg_exe,
                "-y",
                "-ss",
                f"{trim_offset:.2f}",
                "-i",
                str(raw_video_path),
                "-c:v",
                "libvpx-vp9",
                "-crf",
                "26",
                "-b:v",
                "0",
                str(final_video_path),
            ]
            conv = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if conv.returncode == 0 and final_video_path.is_file() and final_video_path.stat().st_size > 10_000:
                report["video_trim_offset_s"] = round(trim_offset, 2)
            else:
                shutil.copy2(raw_video_path, final_video_path)
                report["video_trim_fallback"] = conv.stderr[-400:] if conv.stderr else "copy"
        else:
            shutil.copy2(raw_video_path, final_video_path)
        shutil.rmtree(raw_video_dir, ignore_errors=True)
        report["video_path"] = str(final_video_path)
        report["video_bytes"] = final_video_path.stat().st_size

    report_path = out_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
