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

GL_SWITCH_HOOK_JS = """
(() => {
  const stats = {
    compileShader: 0,
    linkProgram: 0,
    texImage2D: 0,
    pbrTexUploads: 0,
    shadowTargetAllocs: 0,
    generateMipmap: 0,
  };
  window.__glStats = stats;
  window.__resetGlStats = () => {
    stats.compileShader = 0;
    stats.linkProgram = 0;
    stats.texImage2D = 0;
    stats.pbrTexUploads = 0;
    stats.shadowTargetAllocs = 0;
    stats.generateMipmap = 0;
  };
  const wrapProto = (Proto) => {
    if (!Proto) return;
    for (const key of ["compileShader", "linkProgram", "generateMipmap"]) {
      const orig = Proto[key];
      if (typeof orig !== "function" || orig.__qswitchWrapped) continue;
      const wrapped = function (...args) {
        stats[key]++;
        return orig.apply(this, args);
      };
      wrapped.__qswitchWrapped = true;
      Proto[key] = wrapped;
    }
    const origTex = Proto.texImage2D;
    if (typeof origTex === "function" && !origTex.__qswitchWrapped) {
      const wrappedTex = function (...args) {
        stats.texImage2D++;
        if (args.length >= 9 && args[8] === null) {
          stats.shadowTargetAllocs++;
        } else {
          // Ignore 16x16 RGBA32F SkinnedMesh bone matrix textures updated per animation frame
          const isBoneTex = args.length >= 9 && args[2] === 34836 && args[3] <= 32 && args[4] <= 32;
          if (!isBoneTex) stats.pbrTexUploads++;
        }
        return origTex.apply(this, args);
      };
      wrappedTex.__qswitchWrapped = true;
      Proto.texImage2D = wrappedTex;
    }
  };
  wrapProto(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  wrapProto(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
})();
"""


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

            # Hook WebGL render stats & shader/texture counters non-invasively
            page.add_init_script(THREE_INIT_HOOK_JS)
            page.add_init_script(GL_SWITCH_HOOK_JS)
            page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_function(
                "() => window.__fpsReady === true && window.__militaryMapLoaded === true",
                timeout=30000,
            )

            # Verify 3D Lobby layout (Top-Left Name, Top-Right Settings, Center 3 Modes), Practice Map Thumbnails & LAN Mode Filter
            lobby_home = page.evaluate(
                """() => {
                  const g = window.__fpsApp.game.getState();
                  const l = window.__fpsApp.lobby.getState();
                  const nickRect = document.getElementById("nickInput").getBoundingClientRect();
                  const setRect = document.getElementById("btnOpenSettingsLobby").getBoundingClientRect();
                  const ffa = document.getElementById("btnModeFFA").getBoundingClientRect();
                  const tdm = document.getElementById("btnModeTDM").getBoundingClientRect();
                  const prac = document.getElementById("btnModePractice").getBoundingClientRect();
                  return {
                    view: l.activeView,
                    orbitBefore: g.getLobbyViewState().orbitAngle,
                    camBefore: g.getLobbyViewState().camPos,
                    nickLeftOfSet: nickRect.left < setRect.left && nickRect.top < 140 && setRect.top < 140,
                    threeModesCentered: ffa.width > 120 && tdm.width > 120 && prac.width > 120,
                  };
                }"""
            )
            assert lobby_home["view"] == "home"
            assert lobby_home["nickLeftOfSet"] is True, f"Top-left name / Top-right settings alignment failed: {lobby_home}"
            assert lobby_home["threeModesCentered"] is True, f"3 modes missing: {lobby_home}"
            page.wait_for_function(
                f"() => window.__fpsApp.game.getState().getLobbyViewState().orbitAngle > {lobby_home['orbitBefore']} + 0.01",
                timeout=10000,
            )
            lobby_orbit = page.evaluate("() => window.__fpsApp.game.getState().getLobbyViewState()")
            assert lobby_orbit["camPos"] != lobby_home["camBefore"], f"Expected 3D lobby camera to orbit smoothly: before={lobby_home} after={lobby_orbit}"
            page.screenshot(path=os.path.join(out_dir, "lobby_01_home.png"))

            # Click ĐẤU ĐỘI -> filtered LAN view + thumbnail map selector
            page.click("#btnModeTDM")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyLanView')).opacity === '1' && getComputedStyle(document.getElementById('lobbyHomeView')).opacity === '0'",
                timeout=10000,
            )
            lan_tdm_state = page.evaluate("() => window.__fpsApp.lobby.getState()")
            assert lan_tdm_state["activeView"] == "lan" and lan_tdm_state["activeModeFilter"] == "TDM"
            page.screenshot(path=os.path.join(out_dir, "lobby_03_lan_tdm.png"))

            # Return home, click LUYỆN TẬP -> 3D Practice view with 2 map thumbnail cards centered
            page.click("#btnLanBack")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyHomeView')).opacity === '1' && getComputedStyle(document.getElementById('lobbyLanView')).opacity === '0'",
                timeout=10000,
            )
            # Verify hover keeps outer button hitbox stationary (0 edge-jitter flicker)
            prac_btn_before = page.evaluate("() => document.getElementById('btnModePractice').getBoundingClientRect().top")
            page.hover("#btnModePractice")
            page.wait_for_timeout(120)
            prac_btn_after = page.evaluate("() => document.getElementById('btnModePractice').getBoundingClientRect().top")
            assert abs(prac_btn_before - prac_btn_after) < 0.5, f"Mode card hitbox shifted on hover: {prac_btn_before} -> {prac_btn_after}"

            page.click("#btnModePractice")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyPracticeView')).opacity === '1' && getComputedStyle(document.getElementById('lobbyHomeView')).opacity === '0'",
                timeout=10000,
            )
            assert page.evaluate("() => window.__fpsApp.lobby.getState().activeView") == "practice"
            page.click("#btnPracticeSurvival")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbySurvivalView')).opacity === '1' && getComputedStyle(document.getElementById('lobbyPracticeView')).opacity === '0'",
                timeout=10000,
            )
            practice_state = page.evaluate(
                """() => {
                  const imgs = Array.from(document.querySelectorAll("#practiceMapGrid .mapThumbCard img"));
                  return {
                    lobby: window.__fpsApp.lobby.getState(),
                    thumbCount: imgs.length,
                    thumbsLoaded: imgs.every((img) => img.complete && img.naturalWidth >= 800),
                  };
                }"""
            )
            assert practice_state["lobby"]["activeView"] == "survival"
            assert practice_state["thumbCount"] == 2 and practice_state["thumbsLoaded"] is True, f"Map thumbnails broken: {practice_state}"

            # Hover & select Harbor without flashing full-screen loadingOverlay, then switch back to Military
            harbor_card_sel = "#practiceMapGrid .mapThumbCard[data-map='harbor']"
            mil_card_sel = "#practiceMapGrid .mapThumbCard[data-map='military']"
            h_before = page.evaluate(f"() => document.querySelector(\"{harbor_card_sel}\").getBoundingClientRect().top")
            page.hover(harbor_card_sel)
            page.wait_for_timeout(120)
            h_after = page.evaluate(f"() => document.querySelector(\"{harbor_card_sel}\").getBoundingClientRect().top")
            assert abs(h_before - h_after) < 0.5, f"Map card hitbox shifted on hover: {h_before} -> {h_after}"
            page.click(harbor_card_sel)
            overlay_during_select = page.evaluate("() => getComputedStyle(document.getElementById('loadingOverlay')).display")
            assert overlay_during_select == "none", f"Expected no loadingOverlay flash on card click, got {overlay_during_select}"
            page.wait_for_function(
                "() => window.__fpsApp.lobby.getState().selectedPracticeMap === 'harbor' && window.__fpsApp.game.getState().getMapInfo().mapId === 'harbor'",
                timeout=15000,
            )
            page.click(mil_card_sel)
            page.wait_for_function(
                "() => window.__fpsApp.lobby.getState().selectedPracticeMap === 'military' && window.__fpsApp.game.getState().getMapInfo().mapId === 'military'",
                timeout=8000,
            )
            page.screenshot(path=os.path.join(out_dir, "lobby_02_practice_maps.png"))
            report["lobby_3d_ui"] = {"home": lobby_home, "orbit": lobby_orbit, "practice": practice_state}

            # Verify Lobby music controller is armed & set for Main Lobby before entering match
            lobby_music_on_lobby = page.evaluate(
                "() => window.__fpsApp.lobbyMusic.getState()"
            )
            assert lobby_music_on_lobby["shouldPlay"] is True, f"Lobby music not active in Main Lobby: {lobby_music_on_lobby}"
            assert lobby_music_on_lobby["url"] == "/sound/Before_the_Breach.mp3"

            # Start Solo on default map (3A: military) from Practice view
            page.click("#btnSoloMode")
            page.wait_for_function(
                "() => window.__fpsApp.game.getState().activeState === 'play' && window.__fpsApp.game.getState().getMapInfo().mapId === 'military'",
                timeout=10000,
            )
            lobby_music_in_match = page.evaluate(
                "() => window.__fpsApp.lobbyMusic.getState()"
            )
            assert lobby_music_in_match["shouldPlay"] is False, f"Lobby music kept playing inside match: {lobby_music_in_match}"
            report["lobby_music"] = {"on_lobby": lobby_music_on_lobby, "in_match": lobby_music_in_match}

            # Verify M416 WAV audio bank preloaded & decoded 4/4 assets cleanly
            weapon_audio_stats = page.evaluate(
                """async () => {
                  const st = window.__fpsApp.game.getState();
                  return st.getWeaponAudioStats();
                }"""
            )
            report["weapon_audio_stats"] = weapon_audio_stats
            assert weapon_audio_stats["totalCount"] == 11 and weapon_audio_stats["loadedCount"] == 11, (
                f"Multi-weapon audio bank incomplete: {weapon_audio_stats}"
            )
            by_w = weapon_audio_stats.get("byWeapon", {})
            assert by_w.get("m416", {}).get("loadedCount") == 4
            assert by_w.get("pistol", {}).get("loadedCount") == 3
            assert by_w.get("sniper", {}).get("loadedCount") == 4

            # Verify automatic weak-hardware detection (SwiftShader -> low) & 3-tier hot-switching
            page.wait_for_function(
                "() => window.__e2eLastRender && window.__e2eLastRender.world && window.__e2eLastRender.frameCount >= 5",
                timeout=15000,
            )
            quality_tiers: dict[str, Any] = {}
            quality_tiers["auto_initial"] = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  st.setTestCombat({ locked: true, aimHeld: false, crouched: false, hp: 100 });
                  st.setPose(3.2, 0.0, -25.5, -3.06, -0.03);
                  return st.getGraphicsQuality();
                }"""
            )
            assert quality_tiers["auto_initial"]["choice"] == "auto"
            assert quality_tiers["auto_initial"]["effectiveTier"] == "low", f"Expected SwiftShader auto->low: {quality_tiers['auto_initial']}"
            assert quality_tiers["auto_initial"]["shadowMapEnabled"] is False
            assert quality_tiers["auto_initial"]["rendererShadowMapEnabled"] is True
            assert quality_tiers["auto_initial"]["mapQualityStats"]["shadowMapSize"] == 16
            assert quality_tiers["auto_initial"]["mapQualityStats"]["dynamicShadowsActive"] is False
            assert quality_tiers["auto_initial"]["mapQualityStats"]["sunPos"]["z"] == 0, "Sun must sit on Z=0 cross-axis for 5v5 N-S team fairness"
            assert quality_tiers["auto_initial"]["mapQualityStats"]["farTreeLodCount"] == 0
            assert quality_tiers["auto_initial"]["mapQualityStats"]["slopeForestCount"] == 0
            page.wait_for_timeout(160)
            low_shot = os.path.join(out_dir, "00_quality_low.png")
            page.screenshot(path=low_shot)

            # Measure frame time on Low preset
            low_perf = page.evaluate(
                """() => new Promise(res => {
                  const dts = []; let last = performance.now();
                  const step = (now) => {
                    dts.push(now - last); last = now;
                    if (dts.length >= 10) {
                      const s = dts.slice(2).sort((a,b) => a - b);
                      const avg = s.reduce((a,b) => a + b, 0) / s.length;
                      res({ avg_ms: +avg.toFixed(1), p50_ms: +s[Math.floor(s.length/2)].toFixed(1) });
                    } else requestAnimationFrame(step);
                  };
                  requestAnimationFrame(step);
                })"""
            )
            quality_tiers["low_perf"] = low_perf

            # Helper: switch quality via actual Settings <select> DOM onchange & measure sync hitch + GL calls
            switch_metrics: dict[str, Any] = {}
            def run_ui_quality_switch(target_choice: str) -> tuple[dict[str, Any], dict[str, Any]]:
                res = page.evaluate(
                    """async (choice) => {
                      const sel = document.getElementById("setGraphicsQuality");
                      const hint = document.getElementById("setGraphicsHint");
                      const st = window.__fpsApp.game.getState();
                      window.__resetGlStats();
                      const t0 = performance.now();
                      sel.value = choice;
                      sel.dispatchEvent(new Event("change", { bubbles: true }));
                      const syncCallMs = +(performance.now() - t0).toFixed(2);
                      const hintDuringApply = hint ? hint.textContent : "";
                      const pendingRightAfter = st.getGraphicsQuality().pendingApply;
                      await st.waitForQualityApply();
                      // Wait 3 animation frames so renderFrame() executes any shadow map update / resize
                      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
                      const settleMs = +(performance.now() - t0).toFixed(1);
                      return {
                        metrics: {
                          syncCallMs,
                          settleMs,
                          pendingRightAfter,
                          hintDuringApply,
                          hintAfterApply: hint ? hint.textContent : "",
                          gl: { ...window.__glStats },
                        },
                        quality: st.getGraphicsQuality(),
                      };
                    }""",
                    target_choice,
                )
                return res["metrics"], res["quality"]

            # Hot-switch low -> medium via Settings dropdown (verify 0 shader compiles, 0 mipmaps, non-blocking UI!)
            m_low_med, quality_tiers["medium"] = run_ui_quality_switch("medium")
            switch_metrics["low_to_medium"] = m_low_med
            assert quality_tiers["medium"]["effectiveTier"] == "medium"
            assert quality_tiers["medium"]["shadowMapEnabled"] is True
            assert quality_tiers["medium"]["mapQualityStats"]["shadowMapSize"] == 1024
            med_shot = os.path.join(out_dir, "00b_quality_medium.png")
            page.screenshot(path=med_shot)

            # Hot-switch medium -> high via Settings dropdown
            m_med_high, quality_tiers["high"] = run_ui_quality_switch("high")
            switch_metrics["medium_to_high"] = m_med_high
            assert quality_tiers["high"]["effectiveTier"] == "high"
            assert quality_tiers["high"]["shadowMapEnabled"] is True
            assert quality_tiers["high"]["mapQualityStats"]["shadowMapSize"] == 2048

            # Hot-switch high -> low & back to high via rapid debounce test
            m_high_low, quality_tiers["back_to_low"] = run_ui_quality_switch("low")
            switch_metrics["high_to_low"] = m_high_low
            assert quality_tiers["back_to_low"]["effectiveTier"] == "low"
            assert quality_tiers["back_to_low"]["shadowMapEnabled"] is False
            assert quality_tiers["back_to_low"]["mapQualityStats"]["shadowMapSize"] == 16

            # Rapid toggle debounce (low -> medium -> high synchronously before rAF settles)
            rapid_res = page.evaluate(
                """async () => {
                  const sel = document.getElementById("setGraphicsQuality");
                  const st = window.__fpsApp.game.getState();
                  window.__resetGlStats();
                  const t0 = performance.now();
                  sel.value = "medium";
                  sel.dispatchEvent(new Event("change", { bubbles: true }));
                  sel.value = "high";
                  sel.dispatchEvent(new Event("change", { bubbles: true }));
                  const syncCallMs = +(performance.now() - t0).toFixed(2);
                  await st.waitForQualityApply();
                  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
                  return {
                    syncCallMs,
                    settleMs: +(performance.now() - t0).toFixed(1),
                    gl: { ...window.__glStats },
                    quality: st.getGraphicsQuality(),
                  };
                }"""
            )
            switch_metrics["rapid_low_med_high"] = {
                "syncCallMs": rapid_res["syncCallMs"],
                "settleMs": rapid_res["settleMs"],
                "gl": rapid_res["gl"],
            }
            quality_tiers["high"] = rapid_res["quality"]
            quality_tiers["switch_metrics"] = switch_metrics

            for tr_name, tr in switch_metrics.items():
                assert tr["syncCallMs"] < 50.0, f"UI onchange blocked >50ms on {tr_name}: {tr}"
                assert tr["gl"]["compileShader"] == 0, f"Unexpected shader recompile on {tr_name}: {tr}"
                assert tr["gl"]["linkProgram"] == 0, f"Unexpected program link on {tr_name}: {tr}"
                assert tr["gl"]["generateMipmap"] == 0, f"Unexpected texture mipmap rebuild on {tr_name}: {tr}"
                assert tr["gl"]["pbrTexUploads"] == 0, f"Unexpected PBR texture re-upload on {tr_name}: {tr}"
                assert tr["gl"]["shadowTargetAllocs"] <= 2, f"Unexpected shadow target reallocations on {tr_name}: {tr}"

            assert quality_tiers["high"]["effectiveTier"] == "high"
            assert quality_tiers["high"]["shadowMapEnabled"] is True
            assert quality_tiers["high"]["mapQualityStats"]["shadowMapSize"] == 2048
            assert quality_tiers["high"]["mapQualityStats"]["farTreeLodCount"] > 0, "High tier should render distant trees via billboard LOD"
            assert quality_tiers["high"]["mapQualityStats"]["slopeForestCount"] >= 350, "High tier should render dense mountain-slope conifer forest"
            assert quality_tiers["high"]["mapQualityStats"]["grassCount"] > quality_tiers["medium"]["mapQualityStats"]["grassCount"]
            assert quality_tiers["medium"]["mapQualityStats"]["grassCount"] > quality_tiers["auto_initial"]["mapQualityStats"]["grassCount"]
            assert quality_tiers["high"]["mapQualityStats"]["broadleafCount"] >= quality_tiers["medium"]["mapQualityStats"]["broadleafCount"]
            assert quality_tiers["medium"]["mapQualityStats"]["broadleafCount"] >= quality_tiers["auto_initial"]["mapQualityStats"]["broadleafCount"]
            assert quality_tiers["auto_initial"]["mapQualityStats"]["fogDensity"] > quality_tiers["medium"]["mapQualityStats"]["fogDensity"] > quality_tiers["high"]["mapQualityStats"]["fogDensity"]
            assert quality_tiers["auto_initial"]["pixelRatio"] < quality_tiers["high"]["pixelRatio"]

            high_perf = page.evaluate(
                """() => new Promise(res => {
                  const dts = []; let last = performance.now();
                  const step = (now) => {
                    dts.push(now - last); last = now;
                    if (dts.length >= 10) {
                      const s = dts.slice(2).sort((a,b) => a - b);
                      const avg = s.reduce((a,b) => a + b, 0) / s.length;
                      res({ avg_ms: +avg.toFixed(1), p50_ms: +s[Math.floor(s.length/2)].toFixed(1) });
                    } else requestAnimationFrame(step);
                  };
                  requestAnimationFrame(step);
                })"""
            )
            quality_tiers["high_perf"] = high_perf
            report["quality_tiers"] = quality_tiers

            # Verify F3 Perf HUD toggle displays live FPS, draw calls, triangles & programs cleanly
            page.keyboard.press("F3")
            page.wait_for_function(
                "() => { const el = document.getElementById('perfHud'); return el && el.textContent.includes('Calls:') && el.textContent.includes('Tris:'); }",
                timeout=8000,
            )
            perf_hud_on = page.evaluate(
                """() => {
                  const el = document.getElementById("perfHud");
                  const st = window.__fpsApp.game.getState();
                  return {
                    display: el ? getComputedStyle(el).display : "",
                    text: el ? el.textContent : "",
                    stats: st.getPerfStats(),
                  };
                }"""
            )
            page.keyboard.press("F3")
            page.wait_for_timeout(80)
            perf_hud_off = page.evaluate(
                """() => ({
                  display: getComputedStyle(document.getElementById("perfHud")).display,
                  visible: window.__fpsApp.game.getState().getPerfStats().visible,
                })"""
            )
            report["perf_hud_check"] = {"on": perf_hud_on, "off": perf_hud_off}
            assert perf_hud_on["display"] == "block" and perf_hud_on["stats"]["visible"] is True
            assert "FPS:" in perf_hud_on["text"] and "Calls:" in perf_hud_on["text"] and "Tris:" in perf_hud_on["text"]
            assert perf_hud_on["stats"]["calls"] > 0 and perf_hud_on["stats"]["triangles"] > 0
            assert perf_hud_off["display"] == "none" and perf_hud_off["visible"] is False

            # Verify raycast through warehouse window, truck cab, draw call / triangle budget, & consolidated shader count
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
                  const cnv = document.querySelector("canvas");
                  return {
                    mapId: mi.mapId,
                    bounds: mi.bounds,
                    whWindowCleared: whWindow === null,
                    whPierHitDist: whPier ? Number(whPier.dist.toFixed(2)) : null,
                    truckCabCleared: truckCab === null,
                    truckHoodHitDist: truckHood ? Number(truckHood.dist.toFixed(2)) : null,
                    worldCalls: r.world ? r.world.calls : null,
                    worldTriangles: r.world ? r.world.triangles : null,
                    programs: window.__e2eRenderer && window.__e2eRenderer.info && window.__e2eRenderer.info.programs
                      ? window.__e2eRenderer.info.programs.length : null,
                    normalPlayCanvasFilter: cnv ? cnv.style.filter : null,
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
            assert telemetry["normalPlayCanvasFilter"] == "", f"Normal gameplay should not apply slow CSS canvas filter: {telemetry}"
            assert telemetry["contextLost"] is False

            # Capture 6 key map & combat poses (02 faces West sunlit facade + South shaded facade of warehouse_north)
            poses = [
                ("01_spawn_l_wall.png", (0.0, 0.0, -40.0, 3.1416, -0.05), False),
                ("02_lane_a_warehouse.png", (-32.2, 0.0, -2.5, -0.746, 0.02), False),
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

            # Verify Ballistics VFX live firing across muzzle flash, traveling tracer & 5 surfaces with 0 shader recompile
            # Pause RAF loop briefly during deterministic mid-flight/impact snapshots so 48ms muzzle flash & 320m/s tracer
            # don't expire while headless Chrome encodes the PNG!
            vfx_report = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const g = window.__fpsApp.game;
                  window.__resetGlStats();
                  st.setLoopPaused(true);
                  st.setTestCombat({ locked: true, aimHeld: false, crouched: false, hp: 100, adsSteps: 20 });
                  const initial = st.getVfxStats();
                  // 1. Long-range open shot down Mid lane (clear 35m sightline) for Muzzle Flash + Mid-Flight Cross-Quad Tracer
                  st.setPose(3.2, 0.0, -25.5, -3.06, -0.02);
                  g.gunAnim(0, 0);
                  const fired1 = g.shoot();
                  st.stepVfx(0.028);
                  g.renderFrame();
                  const afterShot1 = st.getVfxStats();
                  const rMid = window.__e2eLastRender;
                  return {
                    initial,
                    fired1,
                    afterShot1,
                    worldCallsDuringFire: rMid && rMid.world ? rMid.world.calls : null,
                    worldTrisDuringFire: rMid && rMid.world ? rMid.world.triangles : null,
                  };
                }"""
            )
            page.screenshot(path=os.path.join(out_dir, "vfx_01_muzzle_tracer.png"))
            screenshots.append(os.path.join(out_dir, "vfx_01_muzzle_tracer.png"))

            # 2. Concrete wall burst (holes + sunlit gray dust + concrete pebbles)
            vfx_concrete = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const g = window.__fpsApp.game;
                  const holesBefore = st.getVfxStats().activeHoles;
                  for (let i = 0; i < 4; i++) {
                    st.setPose(-0.35 + i * 0.24, 0.0, -38.6, 3.1416, -0.04 + (i % 2) * 0.03);
                    g.getState().getWeapons().weapons.m416.nextFireAt = 0;
                    g.shoot();
                    st.stepVfx(0.06);
                  }
                  st.setPose(0.0, 0.0, -36.8, 3.1416, -0.04);
                  g.gunAnim(0, 0);
                  g.renderFrame();
                  const after = st.getVfxStats();
                  return { holesBefore, after };
                }"""
            )
            page.screenshot(path=os.path.join(out_dir, "vfx_02_concrete_impact.png"))
            screenshots.append(os.path.join(out_dir, "vfx_02_concrete_impact.png"))

            # 3. Metal container impact (golden velocity-stretched reflection sparks + impact flash + steel dents)
            vfx_metal = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const g = window.__fpsApp.game;
                  const holesBefore = st.getVfxStats().activeHoles;
                  for (let i = 0; i < 3; i++) {
                    st.setPose(16.4 + i * 0.3, 0.0, -27.2, 3.1416, -0.04);
                    g.getState().getWeapons().weapons.m416.nextFireAt = 0;
                    g.shoot();
                    st.stepVfx(0.018);
                  }
                  // Grazing remote metal shot to guarantee dense golden reflection sparks + impact flash
                  const remMetal = st.triggerRemoteFireTest({
                    playerId: "test_remote",
                    weapon: "m416",
                    origin: { x: 13.0, y: 1.4, z: -26.5 },
                    dir: { x: 0.72, y: 0.0, z: 0.69 },
                    seed: 12345,
                  });
                  st.stepVfx(0.022);
                  st.setPose(16.8, 0.0, -26.4, 3.1416, -0.04);
                  g.gunAnim(0, 0);
                  g.renderFrame();
                  return {
                    holesBefore,
                    after: st.getVfxStats(),
                    remoteHitSurface: remMetal && remMetal.worldHit ? remMetal.worldHit.surface : null,
                  };
                }"""
            )
            page.screenshot(path=os.path.join(out_dir, "vfx_03_metal_sparks.png"))
            screenshots.append(os.path.join(out_dir, "vfx_03_metal_sparks.png"))

            # 4. Wood crate splinter holes + tan sawdust + elongated wood splinters
            vfx_wood = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const g = window.__fpsApp.game;
                  const holesBefore = st.getVfxStats().activeHoles;
                  for (let i = 0; i < 3; i++) {
                    st.setPose(-7.45 + i * 0.25, 0.0, -38.8, 3.1416, -0.26);
                    g.getState().getWeapons().weapons.m416.nextFireAt = 0;
                    g.shoot();
                    st.stepVfx(0.04);
                  }
                  st.setPose(-7.2, 0.0, -37.8, 3.1416, -0.28);
                  g.gunAnim(0, 0);
                  g.renderFrame();
                  return { holesBefore, after: st.getVfxStats() };
                }"""
            )
            page.screenshot(path=os.path.join(out_dir, "vfx_04_wood_crate.png"))
            screenshots.append(os.path.join(out_dir, "vfx_04_wood_crate.png"))

            # 5. Open-ground water puddle splash + silver droplets + expanding concentric ripple rings
            vfx_water = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const g = window.__fpsApp.game;
                  const ray = st.getMapInfo().raycastShot;
                  // Locate an unobstructed reflective puddle in open courtyard (clear line of sight from z-3.6)
                  let px = 0, pz = -20, foundWater = false;
                  for (let z = -26; z <= 18 && !foundWater; z += 1.5) {
                    for (let x = -14; x <= 14 && !foundWater; x += 1.5) {
                      const probe = st.triggerRemoteFireTest({
                        playerId: "probe",
                        weapon: "pistol",
                        origin: { x, y: 2.2, z },
                        dir: { x: 0, y: -1, z: 0 },
                        seed: 7,
                      });
                      if (probe && probe.worldHit && probe.worldHit.surface === "water") {
                        const dx = 0, dy = -1.7, dz = 3.6;
                        const dl = Math.hypot(dx, dy, dz);
                        const los = ray(x, 1.7, z - 3.6, dx / dl, dy / dl, dz / dl, dl + 0.5);
                        if (los && los.tag === "ground") {
                          px = x; pz = z; foundWater = true;
                        }
                      }
                    }
                  }
                  // Step away old probe puffs briefly before shooting the puddle cleanly
                  for (let k = 0; k < 25; k++) st.stepVfx(0.05);
                  const holesBeforeWater = st.getVfxStats().activeHoles;
                  st.setPose(px, 0.0, pz - 3.6, 3.1416, -0.44);
                  g.gunAnim(0, 0);
                  g.getState().getWeapons().weapons.m416.nextFireAt = 0;
                  g.shoot();
                  st.stepVfx(0.05);
                  g.getState().getWeapons().weapons.m416.nextFireAt = 0;
                  g.shoot();
                  st.stepVfx(0.11);
                  g.renderFrame();
                  const holesAfterWater = st.getVfxStats().activeHoles;
                  return {
                    foundWater,
                    puddlePos: { x: px, z: pz },
                    holesBeforeWater,
                    holesAfterWater,
                    waterDidNotPlaceHole: holesAfterWater === holesBeforeWater,
                    after: st.getVfxStats(),
                  };
                }"""
            )
            page.screenshot(path=os.path.join(out_dir, "vfx_05_water_puddle.png"))
            screenshots.append(os.path.join(out_dir, "vfx_05_water_puddle.png"))

            vfx_whiz = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  // Test remote bullet whiz-by + wall occlusion, then resume live loop
                  st.setPose(0.0, 0.0, -37.0, 3.1416, 0.0);
                  const whizRes = st.triggerRemoteFireTest({
                    playerId: "sniper_enemy",
                    weapon: "sniper",
                    origin: { x: 1.8, y: 1.6, z: -43.0 },
                    dir: { x: 0, y: 0, z: 1 },
                    seed: 99,
                  });
                  st.setLoopPaused(false);
                  const rEnd = window.__e2eLastRender;
                  return {
                    whizDist: whizRes && whizRes.whiz ? Number(whizRes.whiz.dist.toFixed(2)) : null,
                    whizPan: whizRes && whizRes.whiz ? Number(whizRes.whiz.pan.toFixed(2)) : null,
                    remoteStoppedAtWall: Boolean(whizRes && whizRes.worldHit && whizRes.worldHit.distance < 12),
                    glDuringFire: { ...window.__glStats },
                    worldCallsAfterBurst: rEnd && rEnd.world ? rEnd.world.calls : null,
                    worldTrisAfterBurst: rEnd && rEnd.world ? rEnd.world.triangles : null,
                  };
                }"""
            )
            vfx_water.update(vfx_whiz)

            report["ballistics_vfx"] = {
                "muzzle_tracer": vfx_report,
                "concrete": vfx_concrete,
                "metal": vfx_metal,
                "wood": vfx_wood,
                "water_and_whiz": vfx_water,
            }
            assert vfx_report["fired1"] is True
            assert vfx_report["initial"]["flashLightVisible"] is True
            assert vfx_report["afterShot1"]["muzzleFlashVisible"] is True, f"Muzzle flash missing: {vfx_report}"
            assert vfx_report["afterShot1"]["flashLightIntensity"] > 0, f"Muzzle PointLight inactive: {vfx_report}"
            assert vfx_report["afterShot1"]["activeTracers"] >= 1, f"Tracer missing: {vfx_report}"
            assert vfx_concrete["after"]["activeHoles"] >= vfx_concrete["holesBefore"] + 3, f"Concrete holes missing: {vfx_concrete}"
            assert vfx_metal["after"]["activeSparks"] >= 6, f"Metal sparks missing: {vfx_metal}"
            assert vfx_metal["remoteHitSurface"] == "metal", f"Container not metal: {vfx_metal}"
            assert vfx_wood["after"]["activeHoles"] >= vfx_wood["holesBefore"] + 2, f"Wood holes missing: {vfx_wood}"
            assert vfx_water["foundWater"] is True, f"No puddle located: {vfx_water}"
            assert vfx_water["waterDidNotPlaceHole"] is True, f"Water should not place bullet hole decals: {vfx_water}"
            assert vfx_water["remoteStoppedAtWall"] is True, f"Remote tracer pierced concrete wall: {vfx_water}"
            assert vfx_water["whizDist"] is not None and vfx_water["whizDist"] < 4.6, f"Bullet whiz-by missed: {vfx_water}"
            assert vfx_water["glDuringFire"]["compileShader"] == 0, f"Shader compiled during live fire: {vfx_water}"
            assert vfx_water["glDuringFire"]["linkProgram"] == 0, f"Program linked during live fire: {vfx_water}"
            assert vfx_report["worldCallsDuringFire"] <= 90, f"World calls exceeded 90 during fire: {vfx_report}"
            assert vfx_report["worldTrisDuringFire"] <= 120000, f"World tris exceeded 120k during fire: {vfx_report}"
            assert vfx_water["worldCallsAfterBurst"] <= 90, f"World calls exceeded 90 after burst: {vfx_water}"
            assert vfx_water["worldTrisAfterBurst"] <= 120000, f"World tris exceeded 120k after burst: {vfx_water}"

            # Verify M416 Recoil System (700 RPM pattern kick + SmoothDamp + trigger release partial recovery)
            recoil_after_spray = page.evaluate(
                """async () => {
                  const g = window.__fpsApp.game;
                  const st = g.getState();
                  st.setPose(0.0, 0.0, 28.0, 0.0, 0.0);
                  st.setTestCombat({ locked: true, aimHeld: false, crouched: false, hp: 100, recoilSeed: 4242, fireHeld: true });
                  const startPitch = st.getPitch();
                  for (let i = 0; i < 4; i++) {
                    g.shoot();
                    if (i < 3) await new Promise((r) => setTimeout(r, 95));
                  }
                  const burstRec = st.getM416RecoilState();
                  st.setTestCombat({ fireHeld: false });
                  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                  const peakPitch = st.getPitch();
                  const rec = st.getM416RecoilState();
                  return { startPitch, peakPitch, burstRec, rec, ammo: st.getMe().ammo };
                }"""
            )
            page.wait_for_function(
                "() => window.__fpsApp.game.getState().getM416RecoilState().firing === false && window.__fpsApp.game.getState().getM416RecoilState().recoveryBudget < 0.05",
                timeout=8000,
            )
            recoil_recovered = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  return { endPitch: st.getPitch(), rec: st.getM416RecoilState() };
                }"""
            )
            report["m416_recoil"] = {
                "spray": recoil_after_spray,
                "recovered": recoil_recovered,
            }
            assert recoil_after_spray["burstRec"]["shotIndex"] >= 4, f"Expected >= 4 M416 shots: {report['m416_recoil']}"
            assert recoil_after_spray["burstRec"]["target"]["y"] > 1.3, f"Expected upward M416 target pitch: {report['m416_recoil']}"
            assert recoil_recovered["endPitch"] > recoil_after_spray["startPitch"] + 0.014, f"Expected live camera upward recoil: {report['m416_recoil']}"
            assert abs(recoil_recovered["rec"]["target"]["y"] - recoil_after_spray["burstRec"]["target"]["y"] * 0.65) < 0.05, f"Expected 35% partial recovery on target.y: {report['m416_recoil']}"

            # Verify Toggle ADS default + Valorant Double Zoom AWM (2.5x -> 5.0x -> Off) + Zeroing + Ballistics + Auto Re-scope & Quick-switch
            ads_default_mode = page.evaluate("() => window.__fpsApp.settings.get().adsMode")
            assert ads_default_mode == "toggle", f"Expected default adsMode=toggle, got {ads_default_mode}"

            # Switch to AWM (Digit3) and verify Valorant Double Zoom via RMB clicks (Toggle)
            page.keyboard.press("Digit3")
            page.wait_for_function("() => window.__fpsApp.game.getState().getWeapons().activeWeaponId === 'sniper'", timeout=8000)

            page.mouse.click(640, 360, button="right")
            page.wait_for_function(
                """() => {
                  const sc = window.__fpsApp.game.getState().getAwmScopeState();
                  const scope = document.getElementById("sniperScope");
                  return sc.level === 1 && sc.lastOut.zoom > 2.2 && getComputedStyle(scope).display === "block";
                }""",
                timeout=8000,
            )
            zoom1_state = page.evaluate("() => ({ sc: window.__fpsApp.game.getState().getAwmScopeState(), fov: window.__fpsApp.game.getState().getViewmodelState().worldFov, zoomText: document.getElementById('scopeZoomBadge').textContent, zeroText: document.getElementById('scopeZeroBadge').textContent })")

            # Wait settleTime -> Scope Blur settles sharp; Press ']' -> Zeroing 200m
            page.wait_for_timeout(600)
            page.keyboard.press("BracketRight")
            page.mouse.click(640, 360, button="right")
            page.wait_for_function(
                "() => { const sc = window.__fpsApp.game.getState().getAwmScopeState(); return sc.level === 2 && sc.lastOut.zoom > 4.4; }",
                timeout=8000,
            )
            zoom2_state = page.evaluate("() => ({ sc: window.__fpsApp.game.getState().getAwmScopeState(), fov: window.__fpsApp.game.getState().getViewmodelState().worldFov, zoomText: document.getElementById('scopeZoomBadge').textContent, zeroText: document.getElementById('scopeZeroBadge').textContent })")

            # Shoot while at Zoom Level 2 -> immediately un-scopes for bolt cycle, then Auto Re-scopes back to Level 2
            awm_fired = page.evaluate(
                """() => {
                  const g = window.__fpsApp.game;
                  g.shoot();
                  return { afterShotScoped: g.getState().getAwmScopeState().scoped, pending: g.getState().getAwmScopeState().pendingRescopeLevel };
                }"""
            )
            assert awm_fired["afterShotScoped"] is False and awm_fired["pending"] == 2, f"Expected bolt unscope & pendingresc=2: {awm_fired}"
            page.wait_for_function(
                "() => { const sc = window.__fpsApp.game.getState().getAwmScopeState(); return sc.scoped === true && sc.level === 2; }",
                timeout=8000,
            )

            # RMB 3rd click -> exits Zoom Level 2 -> Off
            page.mouse.click(640, 360, button="right")
            page.wait_for_function(
                "() => { const sc = window.__fpsApp.game.getState().getAwmScopeState(); return sc.level === 0 && sc.lastOut.adsT < 0.05 && getComputedStyle(document.getElementById('sniperScope')).display === 'none'; }",
                timeout=8000,
            )
            # Reset back to M416 cleanly
            page.keyboard.press("Digit1")
            page.wait_for_function("() => window.__fpsApp.game.getState().getWeapons().activeWeaponId === 'm416'", timeout=8000)

            report["awm_scope_system"] = {
                "ads_default_mode": ads_default_mode,
                "zoom1": zoom1_state,
                "zoom2": zoom2_state,
                "after_shot_auto_rescope": awm_fired,
            }
            assert zoom1_state["zoomText"] == "2.5x" and zoom2_state["zoomText"] == "5x"
            assert "200m" in zoom2_state["zeroText"]
            assert zoom2_state["fov"] < zoom1_state["fov"] < 60, f"Expected zoom2 FOV < zoom1 FOV: {report['awm_scope_system']}"

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

            # Compute sunlit-vs-shadow contrast ratio on 02_lane_a_warehouse.png (-X sunlit West wall vs +Z shaded South wall)
            from PIL import Image
            import numpy as np
            wh_arr = np.asarray(Image.open(os.path.join(out_dir, "02_lane_a_warehouse.png")).convert("RGB"), dtype=np.float32)
            luma = 0.299 * wh_arr[:, :, 0] + 0.587 * wh_arr[:, :, 1] + 0.114 * wh_arr[:, :, 2]
            # Left sunlit warehouse -X West facade (x=595..675) vs right shaded +Z South facade (x=705..775)
            sun_patch = float(np.mean(luma[290:410, 595:675]))
            shade_patch = float(np.mean(luma[290:410, 705:775]))
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
            page.click("#btnModePractice")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyPracticeView')).opacity === '1'",
                timeout=10000,
            )
            page.click("#btnPracticeSurvival")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbySurvivalView')).opacity === '1'",
                timeout=10000,
            )
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
