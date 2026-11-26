#!/usr/bin/env python3
"""Headless Playwright WebGL verification & visual capture for Khu Quân Sự Cũ 5v5."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any

from playwright.sync_api import sync_playwright

from verify_e2e_suite import THREE_INIT_HOOK_JS, launch_browser

REPO_ROOT = "/home/dev_ntd/Documents/FPS"


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="/tmp/military_e2e_out")
    args = parser.parse_args()
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    port = _find_free_port()
    proc = subprocess.Popen(
        ["node", "server/index.js", "--host", "127.0.0.1", "--port", str(port)],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(1.0)

    errors: list[str] = []
    report: dict[str, Any] = {"port": port, "out_dir": out_dir}
    try:
        base_url = f"http://127.0.0.1:{port}/FPS.html"
        with sync_playwright() as p:
            browser, launcher_used = launch_browser(p)
            report["launcher"] = launcher_used
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            page = ctx.new_page()

            page.on("pageerror", lambda err: errors.append(f"pageerror: {err}"))
            page.on(
                "console",
                lambda msg: errors.append(f"console.{msg.type}: {msg.text}")
                if msg.type == "error"
                else None,
            )
            page.on(
                "response",
                lambda res: errors.append(f"http {res.status}: {res.url}")
                if res.status >= 400 and "favicon" not in res.url
                else None,
            )

            # Hook WebGL render stats non-invasively via shared THREE_INIT_HOOK_JS
            page.add_init_script(THREE_INIT_HOOK_JS)
            page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_function(
                "() => window.__fpsReady === true && window.__militaryMapLoaded === true",
                timeout=30000,
            )

            # Start Solo on default map (3A: military)
            page.click("#btnSoloMode")
            page.wait_for_function(
                "() => window.__fpsApp.game.getState().activeState === 'play' && window.__fpsApp.game.getState().getMapInfo().mapId === 'military'",
                timeout=10000,
            )

            # Verify raycast through warehouse window, truck cab, and draw call / triangle budget
            page.wait_for_function(
                "() => window.__e2eLastRender && window.__e2eLastRender.world && window.__e2eLastRender.frameCount >= 5",
                timeout=15000,
            )
            telemetry = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const mi = st.getMapInfo();
                  const ray = mi.raycastShot;
                  const whWindow = ray(-19.0, 1.65, -18.1, 1, 0, 0, 10);
                  const whPier = ray(-19.0, 1.65, -16.4, 1, 0, 0, 10);
                  const truckCab = ray(-8.5, 1.80, -11.5, 0.928, 0, -0.371, 6);
                  const truckHood = ray(-8.5, 1.05, -13.1, 0.928, 0, -0.371, 6);
                  const r = window.__e2eLastRender;
                  return {
                    mapId: mi.mapId,
                    bounds: mi.bounds,
                    whWindowCleared: whWindow === null,
                    whPierHitDist: whPier ? Number(whPier.dist.toFixed(2)) : null,
                    truckCabCleared: truckCab === null,
                    truckHoodHitDist: truckHood ? Number(truckHood.dist.toFixed(2)) : null,
                    worldCalls: r.world ? r.world.calls : null,
                    worldTriangles: r.world ? r.world.triangles : null,
                    vmCalls: r.vm ? r.vm.calls : null,
                    vmTriangles: r.vm ? r.vm.triangles : null,
                    contextLost: Boolean(window.__e2eContextLost),
                  };
                }"""
            )
            report["telemetry"] = telemetry
            assert telemetry["mapId"] == "military"
            assert telemetry["whWindowCleared"] is True, f"Warehouse window blocked: {telemetry}"
            assert telemetry["whPierHitDist"] is not None and telemetry["whPierHitDist"] < 3.0
            assert telemetry["truckCabCleared"] is True, f"Truck cab window blocked: {telemetry}"
            assert telemetry["truckHoodHitDist"] is not None and telemetry["truckHoodHitDist"] < 4.0
            assert telemetry["worldCalls"] is not None and telemetry["worldCalls"] <= 90, f"World draw calls > 90: {telemetry}"
            assert telemetry["worldTriangles"] is not None and telemetry["worldTriangles"] <= 120000, f"World tris > 120k: {telemetry}"
            assert telemetry["contextLost"] is False

            # Capture 6 key map & combat poses
            poses = [
                ("01_spawn_l_wall.png", (0.0, 0.0, -40.0, 3.1416, -0.05), False),
                ("02_lane_a_warehouse.png", (-13.5, 0.0, -2.0, 0.78, -0.08), False),
                ("03_warehouse_interior.png", (-21.0, 0.0, -17.0, -1.35, -0.04), False),
                ("04_mid_watchtower_trucks.png", (3.2, 0.0, -25.5, -3.06, -0.03), False),
                ("05_lane_b_containers.png", (19.5, 0.0, -29.0, 2.95, -0.06), False),
                ("06_watchtower_top_overlook.png", (4.0, 4.0, 0.0, 0.65, -0.22), True),
            ]
            screenshots: list[str] = []
            for fname, (x, y, z, yaw, pitch), crouch in poses:
                page.evaluate(
                    """([x, y, z, yaw, pitch, crouch]) => {
                      const st = window.__fpsApp.game.getState();
                      st.setTestCombat({ locked: true, aimHeld: false, crouched: crouch, hp: 100, adsSteps: 40 });
                      st.setPose(x, y, z, yaw, pitch);
                      window.__fpsApp.game.gunAnim(0, 0);
                    }""",
                    [x, y, z, yaw, pitch, crouch],
                )
                page.wait_for_timeout(180)
                shot_path = os.path.join(out_dir, fname)
                page.screenshot(path=shot_path)
                screenshots.append(shot_path)

            # Verify low-HP visual feedback (damage vignette + desaturation/blur at 10/100 HP)
            low_hp_state = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  st.setPose(19.5, 0.0, -29.0, 2.95, -0.06);
                  st.setTestCombat({ locked: true, aimHeld: false, crouched: false, hp: 10 });
                  const cnv = document.querySelector("canvas");
                  const lowOv = document.getElementById("lowHpOverlay");
                  return {
                    filter: cnv ? cnv.style.filter : "",
                    lowHpOpacity: lowOv ? parseFloat(lowOv.style.opacity || "0") : 0,
                  };
                }"""
            )
            page.wait_for_timeout(120)
            low_hp_shot = os.path.join(out_dir, "06b_low_hp_10.png")
            page.screenshot(path=low_hp_shot)
            screenshots.append(low_hp_shot)
            report["low_hp_state"] = low_hp_state
            assert low_hp_state["lowHpOpacity"] > 0.25, f"Low-HP overlay inactive: {low_hp_state}"
            assert "blur(" in low_hp_state["filter"], f"Low-HP blur/desat missing: {low_hp_state}"

            # Compute sunlit-vs-shadow contrast ratio on 02_lane_a_warehouse.png (+X sunlit side wall vs +Z shaded front wall)
            from PIL import Image
            import numpy as np
            wh_arr = np.asarray(Image.open(os.path.join(out_dir, "02_lane_a_warehouse.png")).convert("RGB"), dtype=np.float32)
            luma = 0.299 * wh_arr[:, :, 0] + 0.587 * wh_arr[:, :, 1] + 0.114 * wh_arr[:, :, 2]
            # Right sunlit warehouse +X facade vs front shaded +Z facade
            sun_patch = float(np.mean(luma[220:340, 745:845]))
            shade_patch = float(np.mean(luma[220:340, 595:695]))
            contrast_ratio = round(sun_patch / max(1.0, shade_patch), 2)
            report["lighting_contrast"] = {
                "sunlit_wall_luma": round(sun_patch, 1),
                "shadow_wall_luma": round(shade_patch, 1),
                "sun_to_shadow_ratio": contrast_ratio,
            }
            assert sun_patch >= 90.0 and shade_patch >= 30.0, f"Wall brightness out of realistic range: {report['lighting_contrast']}"
            assert contrast_ratio >= 1.55, f"Sun-to-shadow wall contrast too flat: {report['lighting_contrast']}"
            report["screenshots"] = screenshots

            # Test LAN room creation defaults to military & Harbor fallback ?map=harbor has zero military grading leak
            page.goto(f"{base_url}?map=harbor", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_function("() => window.__fpsReady === true", timeout=20000)
            page.click("#btnSoloMode")
            page.wait_for_function(
                "() => window.__fpsApp.game.getState().activeState === 'play' && window.__fpsApp.game.getState().getMapInfo().mapId === 'harbor'",
                timeout=10000,
            )
            harbor_state = page.evaluate(
                """() => {
                  const cnv = document.querySelector("canvas");
                  const vig = document.getElementById("vignette");
                  const lowOv = document.getElementById("lowHpOverlay");
                  return {
                    filter: cnv ? cnv.style.filter : "",
                    vigOpacity: vig ? vig.style.opacity : "",
                    lowHpOpacity: lowOv ? lowOv.style.opacity : "",
                  };
                }"""
            )
            report["harbor_state"] = harbor_state
            assert harbor_state["filter"] == "", f"Military filter leaked to harbor: {harbor_state}"
            assert harbor_state["vigOpacity"] == "0", f"Military vignette leaked to harbor: {harbor_state}"
            harbor_shot = os.path.join(out_dir, "07_harbor_regression.png")
            page.wait_for_timeout(200)
            page.screenshot(path=harbor_shot)
            report["harbor_regression_ok"] = True

            ctx.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    report["errors"] = errors
    report_path = os.path.join(out_dir, "report.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if errors:
        print("ERRORS DETECTED:", errors)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
