#!/usr/bin/env python3
"""
Opaque-Box 4-Tier E2E Verification Suite for FPS ("Bến Cảng Mưa").

Targets the live server at --url / --base-url (default http://localhost:8090/FPS.html)
without modifying any implementation code under public/, model/, or server/*.js.
Writes all screenshots and report.json exclusively into --out-dir.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from typing import Any

import numpy as np
from PIL import Image
from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

REPO_ROOT = "/home/dev_ntd/Documents/FPS"
DEFAULT_URL = "http://localhost:8090/FPS.html"
VIEWPORT = {"width": 1280, "height": 720}
WEBGL_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
]

THREE_INIT_HOOK_JS = r"""
(() => {
  if (window.__e2eHookInstalled) return;
  window.__e2eHookInstalled = true;
  window.__e2eContextLost = false;
  window.__e2eScene = null;
  window.__e2eRenderer = null;
  window.__e2eTexRecords = [];
  window.__e2eLastRender = {
    world: null,
    vm: null,
    memory: { geometries: 0, textures: 0 },
    programs: 0,
    frameCount: 0,
    frameTimes: [],
    jsTimes: [],
    heapSamplesMB: [],
    _worldJsMs: 0,
    _lastWorldTs: 0,
  };

  window.__e2eResetPerf = () => {
    const s = window.__e2eLastRender;
    s.frameTimes = [];
    s.jsTimes = [];
    s.heapSamplesMB = [];
    s._lastWorldTs = 0;
    s._worldJsMs = 0;
  };

  window.addEventListener("webglcontextlost", () => {
    window.__e2eContextLost = true;
  }, true);

  // ---- Non-invasive WebGL texImage2D / texParameteri REPEAT texture capture ----
  const texMetaMap = new WeakMap();
  const ctxBoundTex = new WeakMap();
  const TEXTURE_2D = 0x0DE1;
  const TEXTURE_WRAP_S = 0x2802;
  const TEXTURE_WRAP_T = 0x2803;
  const REPEAT = 0x2901;

  function ensureTexRecord(tex) {
    if (!tex) return null;
    let rec = texMetaMap.get(tex);
    if (!rec) {
      rec = {
        id: window.__e2eTexRecords.length,
        width: 0,
        height: 0,
        wrapS: null,
        wrapT: null,
        isRepeat: false,
        sourceType: null,
        edgeMaxLumaDiff: null,
        edgeMeanLumaDiff: null,
        edgeMaxChanDiff: null,
        horizMaxLumaDiff: null,
        vertMaxLumaDiff: null,
      };
      texMetaMap.set(tex, rec);
      window.__e2eTexRecords.push(rec);
    }
    return rec;
  }

  function computeEdgeMetrics(rgba, w, h) {
    const luma = (idx) => 0.2126 * rgba[idx] + 0.7152 * rgba[idx + 1] + 0.0722 * rgba[idx + 2];
    let hMaxL = 0, hSumL = 0, hMaxC = 0;
    for (let y = 0; y < h; y++) {
      const i0 = (y * w) * 4;
      const i1 = (y * w + (w - 1)) * 4;
      const dl = Math.abs(luma(i0) - luma(i1));
      if (dl > hMaxL) hMaxL = dl;
      hSumL += dl;
      for (let c = 0; c < 3; c++) {
        const dc = Math.abs(rgba[i0 + c] - rgba[i1 + c]);
        if (dc > hMaxC) hMaxC = dc;
      }
    }
    let vMaxL = 0, vSumL = 0, vMaxC = 0;
    for (let x = 0; x < w; x++) {
      const i0 = x * 4;
      const i1 = ((h - 1) * w + x) * 4;
      const dl = Math.abs(luma(i0) - luma(i1));
      if (dl > vMaxL) vMaxL = dl;
      vSumL += dl;
      for (let c = 0; c < 3; c++) {
        const dc = Math.abs(rgba[i0 + c] - rgba[i1 + c]);
        if (dc > vMaxC) vMaxC = dc;
      }
    }
    return {
      edgeMaxLumaDiff: Math.max(hMaxL, vMaxL),
      edgeMeanLumaDiff: (hSumL / h + vSumL / w) * 0.5,
      edgeMaxChanDiff: Math.max(hMaxC, vMaxC),
      horizMaxLumaDiff: hMaxL,
      vertMaxLumaDiff: vMaxL,
    };
  }

  function hookWebGLProto(Proto) {
    if (!Proto || Proto.__e2eTexHooked) return;
    Proto.__e2eTexHooked = true;
    const origBind = Proto.bindTexture;
    const origParam = Proto.texParameteri;
    const origTexImage2D = Proto.texImage2D;

    Proto.bindTexture = function (target, tex) {
      try {
        if (target === TEXTURE_2D) {
          ctxBoundTex.set(this, tex || null);
          if (tex) ensureTexRecord(tex);
        }
      } catch (_) {}
      return origBind.apply(this, arguments);
    };

    Proto.texParameteri = function (target, pname, param) {
      try {
        if (target === TEXTURE_2D && (pname === TEXTURE_WRAP_S || pname === TEXTURE_WRAP_T)) {
          const tex = ctxBoundTex.get(this);
          const rec = ensureTexRecord(tex);
          if (rec) {
            if (pname === TEXTURE_WRAP_S) rec.wrapS = param;
            if (pname === TEXTURE_WRAP_T) rec.wrapT = param;
            rec.isRepeat = rec.wrapS === REPEAT || rec.wrapT === REPEAT;
          }
        }
      } catch (_) {}
      return origParam.apply(this, arguments);
    };

    Proto.texImage2D = function (...args) {
      try {
        const target = args[0];
        const level = args[1];
        if (target === TEXTURE_2D && level === 0) {
          const tex = ctxBoundTex.get(this);
          const rec = ensureTexRecord(tex);
          if (rec) {
            let w = 0, h = 0, rgba = null, srcType = null;
            if (args.length === 6) {
              const src = args[5];
              if (src && typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement) {
                w = src.width;
                h = src.height;
                srcType = "canvas";
                if (w === h && w >= 128) {
                  const ctx2d = src.getContext("2d");
                  if (ctx2d) rgba = ctx2d.getImageData(0, 0, w, h).data;
                }
              } else if (src && typeof ImageData !== "undefined" && src instanceof ImageData) {
                w = src.width;
                h = src.height;
                srcType = "imagedata";
                if (w === h && w >= 128) rgba = src.data;
              }
            } else if (args.length >= 9) {
              w = Number(args[3]) || 0;
              h = Number(args[4]) || 0;
              const px = args[8];
              srcType = px ? px.constructor.name : "null";
              if (w === h && w >= 128 && px && (px instanceof Uint8Array || px instanceof Uint8ClampedArray) && px.length >= w * h * 4) {
                rgba = px;
              }
            }
            if (w > 0 && h > 0) {
              rec.width = w;
              rec.height = h;
              rec.sourceType = srcType;
            }
            if (rgba && w === h && w >= 128) {
              const m = computeEdgeMetrics(rgba, w, h);
              Object.assign(rec, m);
            }
          }
        }
      } catch (_) {}
      return origTexImage2D.apply(this, args);
    };
  }

  if (typeof WebGL2RenderingContext !== "undefined") hookWebGLProto(WebGL2RenderingContext.prototype);
  if (typeof WebGLRenderingContext !== "undefined") hookWebGLProto(WebGLRenderingContext.prototype);

  // ---- Non-invasive THREE.WebGLRenderer capture ----
  function makeWrappedRenderer(OrigRenderer) {
    if (typeof OrigRenderer !== "function" || OrigRenderer.__e2eWrapped) return OrigRenderer;
    function WrappedWebGLRenderer(...args) {
      const inst = new OrigRenderer(...args);
      window.__e2eRenderer = inst;
      if (inst && inst.domElement) {
        inst.domElement.addEventListener("webglcontextlost", () => {
          window.__e2eContextLost = true;
        });
      }
      const origRender = inst.render.bind(inst);
      inst.render = function wrappedRender(scene, camera) {
        const t0 = performance.now();
        const out = origRender(scene, camera);
        const t1 = performance.now();
        try {
          const mask = camera && camera.layers ? camera.layers.mask : 1;
          const passKey = mask === 2 ? "vm" : "world";
          const info = inst.info || {};
          const rInfo = info.render || {};
          const mInfo = info.memory || {};
          const state = window.__e2eLastRender;
          state[passKey] = {
            calls: rInfo.calls || 0,
            triangles: rInfo.triangles || 0,
            points: rInfo.points || 0,
            lines: rInfo.lines || 0,
          };
          state.memory = {
            geometries: mInfo.geometries || 0,
            textures: mInfo.textures || 0,
          };
          state.programs = Array.isArray(info.programs) ? info.programs.length : 0;
          if (passKey === "world") {
            if (state._lastWorldTs > 0) {
              state.frameTimes.push(t0 - state._lastWorldTs);
              if (state.frameTimes.length > 200) state.frameTimes.shift();
            }
            state._lastWorldTs = t0;
            state._worldJsMs = t1 - t0;
            state.frameCount += 1;
          } else {
            state.jsTimes.push(state._worldJsMs + (t1 - t0));
            if (state.jsTimes.length > 200) state.jsTimes.shift();
            if (performance.memory && typeof performance.memory.usedJSHeapSize === "number") {
              state.heapSamplesMB.push(performance.memory.usedJSHeapSize / (1024 * 1024));
              if (state.heapSamplesMB.length > 200) state.heapSamplesMB.shift();
            }
          }
          // Skip PMREMGenerator sky-sphere helper scenes (~7 children, no fog) so __e2eScene is always main scene S
          if (passKey === "world" && scene && scene.children && (scene.children.length > 12 || scene.fog)) {
            window.__e2eScene = scene;
          }
        } catch (_) {}
        return out;
      };
      return inst;
    }
    WrappedWebGLRenderer.prototype = OrigRenderer.prototype;
    WrappedWebGLRenderer.__e2eWrapped = true;
    return WrappedWebGLRenderer;
  }

  function wrapThreeNamespace(t) {
    if (!t || typeof t !== "object") return t;
    if (typeof t.WebGLRenderer === "function" && !t.WebGLRenderer.__e2eWrapped) {
      try {
        t.WebGLRenderer = makeWrappedRenderer(t.WebGLRenderer);
        t.__e2eWrapped = true;
      } catch (_) {}
    } else if (!t.__e2eSetterInstalled) {
      t.__e2eSetterInstalled = true;
      let _wr = t.WebGLRenderer;
      try {
        Object.defineProperty(t, "WebGLRenderer", {
          configurable: true,
          enumerable: true,
          get() { return _wr; },
          set(val) {
            _wr = makeWrappedRenderer(val);
            if (_wr && _wr.__e2eWrapped) t.__e2eWrapped = true;
          },
        });
      } catch (_) {}
    }
    return t;
  }

  let _threeObj = window.THREE ? wrapThreeNamespace(window.THREE) : undefined;
  try {
    Object.defineProperty(window, "THREE", {
      configurable: true,
      enumerable: true,
      get() {
        if (_threeObj) wrapThreeNamespace(_threeObj);
        return _threeObj;
      },
      set(val) {
        _threeObj = wrapThreeNamespace(val);
      },
    });
  } catch (_) {}
})();
"""


def normalize_url(url_arg: str) -> str:
    url = url_arg.strip()
    if not url.endswith(".html") and "/" not in url.split("://", 1)[-1]:
        return url.rstrip("/") + "/FPS.html"
    if url.endswith("/"):
        return url + "FPS.html"
    return url


def launch_browser(p) -> tuple[Browser, str]:
    attempts: list[tuple[str, dict[str, Any]]] = [
        ("channel=chrome", {"headless": True, "channel": "chrome", "args": WEBGL_ARGS}),
    ]
    if os.path.exists("/usr/bin/google-chrome"):
        attempts.append((
            "/usr/bin/google-chrome",
            {"headless": True, "executable_path": "/usr/bin/google-chrome", "args": WEBGL_ARGS},
        ))
    cached_shells = sorted(
        glob.glob(
            os.path.expanduser(
                "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"
            )
        ),
        reverse=True,
    )
    for shell_path in cached_shells:
        if os.path.exists(shell_path):
            attempts.append((
                shell_path,
                {"headless": True, "executable_path": shell_path, "args": WEBGL_ARGS},
            ))
    attempts.append(("default", {"headless": True, "args": WEBGL_ARGS}))

    errors: list[str] = []
    for label, kwargs in attempts:
        try:
            browser = p.chromium.launch(**kwargs)
            return browser, label
        except Exception as exc:
            errors.append(f"{label}: {exc}")
    raise RuntimeError("Failed to launch headless WebGL browser:\n" + "\n".join(errors))


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
            lambda resp: self.http_errors.append(f"[{label}] HTTP {resp.status} {resp.url}")
            if resp.status >= 400
            else None,
        )
        page.on(
            "requestfailed",
            lambda req: self.request_failed.append(
                f"[{label}] {req.url} ({req.failure})"
            ),
        )

    def snapshot(self) -> dict[str, list[str]]:
        return {
            "console_errors": list(self.console_errors),
            "pageerrors": list(self.pageerrors),
            "http_errors": list(self.http_errors),
            "request_failed": list(self.request_failed),
        }

    def assert_clean(self, stage: str) -> None:
        problems: list[str] = []
        if self.console_errors:
            problems.append(f"console.error={self.console_errors}")
        if self.pageerrors:
            problems.append(f"pageerror={self.pageerrors}")
        if self.http_errors:
            problems.append(f"http>=400={self.http_errors}")
        if self.request_failed:
            problems.append(f"requestfailed={self.request_failed}")
        if problems:
            raise AssertionError(f"Runtime/network errors during {stage}: " + "; ".join(problems))


def new_tracked_context(browser: Browser, tracker: ErrorTracker, label: str) -> tuple[BrowserContext, Page]:
    ctx = browser.new_context(viewport=VIEWPORT)
    ctx.add_init_script(THREE_INIT_HOOK_JS)
    page = ctx.new_page()
    tracker.attach(page, label)
    return ctx, page


def take_screenshot(page: Page, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    page.screenshot(path=path, timeout=60000, animations="allow")


def wait_fps_ready(page: Page, url: str) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_function(
        """() => Boolean(
          window.__fpsReady &&
          window.__m416Loaded &&
          window.__pistolLoaded &&
          window.__awmLoaded &&
          window.__armsLoaded &&
          window.__soldierLoaded &&
          window.__fpsApp &&
          window.__fpsApp.game
        )""",
        timeout=25000,
    )


def ensure_combat_locked(page: Page) -> None:
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
    page.wait_for_function(
        """() => {
          const ov = document.getElementById("pauseOverlay");
          const ovHidden = !ov || getComputedStyle(ov).display === "none";
          return ovHidden && window.__fpsApp.input.active === true;
        }""",
        timeout=5000,
    )


def wait_frames(page: Page, count: int = 3) -> None:
    start_fc = page.evaluate("() => (window.__e2eLastRender && window.__e2eLastRender.frameCount) || 0")
    page.wait_for_function(
        "(target) => ((window.__e2eLastRender && window.__e2eLastRender.frameCount) || 0) >= target",
        arg=start_fc + count,
        timeout=15000,
    )


def start_solo_session(page: Page, url: str) -> None:
    wait_fps_ready(page, url)
    page.click("#btnModePractice")
    page.wait_for_timeout(450)
    page.click("#btnSoloMode")
    page.wait_for_function(
        """() => {
          const st = window.__fpsApp.game.getState();
          return st.engineMode === "solo" && st.activeState === "play";
        }""",
        timeout=10000,
    )
    wait_frames(page, 2)
    ensure_combat_locked(page)


def get_me(page: Page) -> dict[str, Any]:
    return page.evaluate("() => window.__fpsApp.game.getState().getMe()")


def get_weapons(page: Page) -> dict[str, Any]:
    return page.evaluate("() => window.__fpsApp.game.getState().getWeapons()")


def get_vm_state(page: Page) -> dict[str, Any]:
    return page.evaluate("() => window.__fpsApp.game.getState().getViewmodelState()")


def switch_weapon_and_wait(page: Page, key_code: str, expected_slot: int, expected_wid: str) -> None:
    page.keyboard.press(key_code)
    page.wait_for_function(
        """([slot, wid]) => {
          const w = window.__fpsApp.game.getState().getWeapons();
          const pill = document.getElementById(`slotPill${slot}`);
          return w.activeSlot === slot && w.activeWeaponId === wid && pill && pill.classList.contains("active");
        }""",
        arg=[expected_slot, expected_wid],
        timeout=15000,
    )


def fire_auto_once(page: Page, prev_mag: int) -> int:
    page.mouse.move(640, 360)
    page.mouse.down(button="left")
    try:
        page.wait_for_function(
            "(prev) => window.__fpsApp.game.getState().getMe().ammo < prev",
            arg=prev_mag,
            timeout=15000,
        )
    finally:
        page.mouse.up(button="left")
    return int(get_me(page)["ammo"])


def fire_semi_once(page: Page, prev_mag: int) -> int:
    page.mouse.move(640, 360)
    page.mouse.click(640, 360, button="left")
    page.wait_for_function(
        "(prev) => window.__fpsApp.game.getState().getMe().ammo < prev",
        arg=prev_mag,
        timeout=15000,
    )
    return int(get_me(page)["ammo"])


def reload_and_wait(page: Page, expected_full_mag: int) -> None:
    page.keyboard.press("KeyR")
    page.wait_for_function(
        """() => {
          const me = window.__fpsApp.game.getState().getMe();
          const am = document.getElementById("am");
          const ring = document.getElementById("reloadRingWrap");
          return me.reloading === true && am && am.textContent.includes("Nạp đạn") && ring && getComputedStyle(ring).display === "block";
        }""",
        timeout=6000,
    )
    page.wait_for_function(
        """(fullMag) => {
          const me = window.__fpsApp.game.getState().getMe();
          const am = document.getElementById("am");
          const ring = document.getElementById("reloadRingWrap");
          return me.reloading === false && me.ammo === fullMag && am && am.textContent === `${fullMag} / ∞` && (!ring || getComputedStyle(ring).display === "none");
        }""",
        arg=expected_full_mag,
        timeout=10000,
    )


def run_unit_suites() -> dict[str, Any]:
    results: dict[str, Any] = {}

    py_cmd = ["python3", "-B", "-m", "unittest", "discover", "-s", "model/tests", "-v"]
    t0 = time.time()
    py_proc = subprocess.run(
        py_cmd, cwd=REPO_ROOT, capture_output=True, text=True, timeout=180
    )
    py_dur = round(time.time() - t0, 3)
    py_combined = (py_proc.stdout or "") + "\n" + (py_proc.stderr or "")
    py_match = re.search(r"Ran\s+(\d+)\s+tests?", py_combined)
    py_total = int(py_match.group(1)) if py_match else 0
    py_ok = py_proc.returncode == 0
    results["python_model_tests"] = {
        "command": " ".join(py_cmd),
        "exit_code": py_proc.returncode,
        "passed": py_ok,
        "tests_ran": py_total,
        "duration_s": py_dur,
        "tail": py_combined.strip().splitlines()[-8:],
    }

    node_cmd = ["node", "--test", "server/tests/test_lan_v2.js", "server/tests/test_arm_rig.mjs"]
    t1 = time.time()
    node_proc = subprocess.run(
        node_cmd, cwd=REPO_ROOT, capture_output=True, text=True, timeout=120
    )
    node_dur = round(time.time() - t1, 3)
    node_combined = (node_proc.stdout or "") + "\n" + (node_proc.stderr or "")
    tests_m = re.search(r"tests\s+(\d+)", node_combined)
    pass_m = re.search(r"pass\s+(\d+)", node_combined)
    fail_m = re.search(r"fail\s+(\d+)", node_combined)
    node_ok = node_proc.returncode == 0
    results["node_server_rig_tests"] = {
        "command": " ".join(node_cmd),
        "exit_code": node_proc.returncode,
        "passed": node_ok,
        "tests_ran": int(tests_m.group(1)) if tests_m else 0,
        "tests_passed": int(pass_m.group(1)) if pass_m else 0,
        "tests_failed": int(fail_m.group(1)) if fail_m else (0 if node_ok else 1),
        "duration_s": node_dur,
        "tail": node_combined.strip().splitlines()[-10:],
    }

    return results


def inspect_ground_teximage2d_wrap(page: Page) -> dict[str, Any]:
    """
    Inspect REPEAT square ground textures captured via WebGL texImage2D/texParameteri,
    plus direct ground mesh canvas edge wrap if available.
    """
    raw = page.evaluate(
        """() => {
          const allTex = (window.__e2eTexRecords || []).filter(
            (r) => r.isRepeat && r.width === r.height && r.width >= 256 && r.edgeMaxLumaDiff !== null
          );
          let groundMeta = null;
          if (window.__e2eScene) {
            window.__e2eScene.traverse((o) => {
              if (!groundMeta && o.isMesh && o.geometry && o.geometry.type === "PlaneGeometry") {
                const p = o.geometry.parameters || {};
                if (p.width >= 100 && o.material) {
                  const map = o.material.map;
                  groundMeta = {
                    mapSize: map && map.image ? [map.image.width, map.image.height] : null,
                    normalSize: o.material.normalMap && o.material.normalMap.image
                      ? [o.material.normalMap.image.width, o.material.normalMap.image.height] : null,
                    roughSize: o.material.roughnessMap && o.material.roughnessMap.image
                      ? [o.material.roughnessMap.image.width, o.material.roughnessMap.image.height] : null,
                    repeat: map ? [map.repeat.x, map.repeat.y] : null,
                  };
                }
              }
            });
          }
          return { repeatSquareTextures: allTex, groundMeta };
        }"""
    )
    recs = raw["repeatSquareTextures"]
    assert len(recs) >= 1, f"No REPEAT square ground texImage2D records captured: {raw}"
    max_luma_diff = max(float(r["edgeMaxLumaDiff"]) for r in recs)
    max_chan_diff = max(int(r["edgeMaxChanDiff"]) for r in recs)
    min_dim = min(int(r["width"]) for r in recs)
    passed = max_luma_diff <= 8.0 and min_dim >= 512
    return {
        "record_count": len(recs),
        "min_dimension": min_dim,
        "max_edge_luma_diff_255": round(max_luma_diff, 3),
        "max_edge_chan_diff_255": max_chan_diff,
        "records": recs,
        "ground_meta": raw["groundMeta"],
        "thresholds": {"max_edge_luma_diff_255_le": 8.0, "min_dimension_ge": 512},
        "passed": passed,
    }


def inspect_scene_materials(page: Page) -> dict[str, Any]:
    """
    Non-invasive scene graph traversal auditing viewmodel & harbor materials,
    streetlamp color temperature, rain ripple InstancedMesh vs Points, and contact shadow planes.
    """
    data = page.evaluate(
        """() => {
          const s = window.__e2eScene;
          if (!s) return { hasScene: false };
          const vmMats = {};
          let magBodyMat = null;
          const streetlamps = [];
          let pointsSplashCount = 0;
          let instancedRippleCount = 0;
          let contactShadowPlaneCount = 0;
          let containerCount = 0;

          s.traverse((obj) => {
            if (obj.isLight && obj.isPointLight && obj.position && obj.position.y > 4.0) {
              streetlamps.push({
                x: Number(obj.position.x.toFixed(2)),
                y: Number(obj.position.y.toFixed(2)),
                z: Number(obj.position.z.toFixed(2)),
                r: Number(obj.color.r.toFixed(3)),
                g: Number(obj.color.g.toFixed(3)),
                b: Number(obj.color.b.toFixed(3)),
                intensity: Number(obj.intensity.toFixed(3)),
              });
            }
            if (obj.isPoints && obj.material && obj.material.color && obj.material.color.getHex() === 0xcfe6f5) {
              pointsSplashCount += 1;
            }
            if (obj.isInstancedMesh && obj.position && obj.position.y < 0.5 && obj.count >= 16) {
              instancedRippleCount += 1;
            }
            if (obj.isMesh && obj.geometry) {
              const p = obj.geometry.parameters || {};
              if (obj.geometry.type === "BoxGeometry" && Math.abs((p.width || 0) - 6.1) < 0.1) {
                containerCount += 1;
              }
              if (obj.position && Math.abs(obj.position.y) < 0.08 && obj.geometry.type === "PlaneGeometry" && (p.width || 0) < 20) {
                contactShadowPlaneCount += 1;
              }
            }
            if (obj.isMesh && obj.layers && obj.layers.mask === 2 && obj.material) {
              const m = obj.material;
              const key = m.name || obj.name || "unnamed";
              if (obj.name === "mag_body") magBodyMat = m.name || "";
              if (!vmMats[key]) {
                let sheenLuma = 0;
                if (m.sheen && m.sheen.isColor) {
                  sheenLuma = 0.299 * m.sheen.r + 0.587 * m.sheen.g + 0.114 * m.sheen.b;
                }
                vmMats[key] = {
                  type: m.type,
                  metalness: m.metalness !== undefined ? Number(m.metalness.toFixed(3)) : null,
                  roughness: m.roughness !== undefined ? Number(m.roughness.toFixed(3)) : null,
                  clearcoat: m.clearcoat !== undefined ? Number(m.clearcoat.toFixed(3)) : null,
                  aoMapIntensity: m.aoMapIntensity !== undefined ? Number(m.aoMapIntensity.toFixed(3)) : null,
                  hasAoMap: Boolean(m.aoMap),
                  opacity: m.opacity !== undefined ? Number(m.opacity.toFixed(3)) : null,
                  envMapIntensity: m.envMapIntensity !== undefined ? Number(m.envMapIntensity.toFixed(3)) : null,
                  sheenLuma: Number(sheenLuma.toFixed(4)),
                };
              }
            }
          });

          return {
            hasScene: true,
            streetlamps,
            pointsSplashCount,
            instancedRippleCount,
            containerCount,
            contactShadowPlaneCount,
            magBodyMat,
            vmMats,
          };
        }"""
    )
    assert data.get("hasScene"), "window.__e2eScene missing during material audit"
    vm = data["vmMats"]

    arms_mat = None
    for k, v in vm.items():
        if "armmesh" in k.lower() or k in ("material", "Arms_SkinnedGlove", "Arms_TacticalGlove"):
            arms_mat = v
            break
    poly_mat = vm.get("M416_Polymer")
    gun_mat = vm.get("M416_GunMetal")
    glass_mat = vm.get("M416_HoloGlass") or vm.get("holo_lens")
    pistol_poly = vm.get("Pistol_Polymer") or vm.get("Pistol_GripStipple")
    awm_mat = vm.get("AWM_RiflePBR")

    warm_lamps = [l for l in data["streetlamps"] if l["r"] > l["b"] + 0.05]

    checks = {
        "arms_no_clay_sheen_high_ao": bool(
            arms_mat
            and (arms_mat["sheenLuma"] <= 0.08)
            and (arms_mat["aoMapIntensity"] is not None and arms_mat["aoMapIntensity"] >= 0.85)
        ),
        "m416_polymer_matte_and_mag_body": bool(
            poly_mat
            and gun_mat
            and data["magBodyMat"] == "M416_Polymer"
            and (poly_mat["clearcoat"] is not None and poly_mat["clearcoat"] <= 0.10)
        ),
        "m416_holo_glass_clear": bool(
            glass_mat and (glass_mat["opacity"] is not None and glass_mat["opacity"] <= 0.16)
        ),
        "pistol_awm_materials_present": bool(pistol_poly and awm_mat),
        "rain_ripples_instanced_no_points": bool(
            data["instancedRippleCount"] >= 1 and data["pointsSplashCount"] == 0
        ),
        "warm_harbor_streetlamps": len(warm_lamps) >= 2,
        "container_contact_shadow_planes": data["contactShadowPlaneCount"] >= 4,
    }
    return {
        "checks": checks,
        "passed": all(checks.values()),
        "summary": {
            "arms_mat": arms_mat,
            "m416_polymer": poly_mat,
            "m416_gunmetal": gun_mat,
            "m416_holo_glass": glass_mat,
            "mag_body_mat": data["magBodyMat"],
            "pistol_polymer": pistol_poly,
            "awm_rifle": awm_mat,
            "warm_lamp_count": len(warm_lamps),
            "total_lamp_count": len(data["streetlamps"]),
            "points_splash_count": data["pointsSplashCount"],
            "instanced_ripple_count": data["instancedRippleCount"],
            "container_count": data["containerCount"],
            "contact_shadow_plane_count": data["contactShadowPlaneCount"],
        },
    }


def run_tier1(browser: Browser, url: str, tracker: ErrorTracker) -> dict[str, Any]:
    checks: dict[str, Any] = {}

    # Solo Drone startup + Slots 1, 2, 3
    ctx, page = new_tracked_context(browser, tracker, "T1_Solo")
    try:
        start_solo_session(page, url)
        me0 = get_me(page)
        vm0 = get_vm_state(page)
        assert me0["hp"] == 100 and me0["meAlive"] is True, f"Unexpected Solo start me={me0}"
        assert vm0["armsReady"] and vm0["armsVisible"] and vm0["skinningEnabled"], f"Arms rig not ready: {vm0}"
        checks["solo_startup"] = {"passed": True, "hp": me0["hp"], "armsReady": vm0["armsReady"]}

        # Slot 1: M416 (default Toggle ADS: click RMB on -> click RMB off)
        switch_weapon_and_wait(page, "Digit1", 1, "m416")
        assert get_me(page)["ammo"] == 30 and get_me(page)["ads"] < 0.1
        page.mouse.click(640, 360, button="right")
        page.wait_for_function(
            """() => {
              const me = window.__fpsApp.game.getState().getMe();
              const vm = window.__fpsApp.game.getState().getViewmodelState();
              const scope = document.getElementById("sniperScope");
              return me.ads > 0.85 && vm.worldFov < 60 && getComputedStyle(scope).display === "none";
            }""",
            timeout=8000,
        )
        m416_ads_val = get_me(page)["ads"]
        page.mouse.click(640, 360, button="right")
        page.wait_for_function("() => window.__fpsApp.game.getState().getMe().ads < 0.1", timeout=8000)
        m416_after_fire = fire_auto_once(page, 30)
        assert 25 <= m416_after_fire <= 29, f"Expected M416 ammo 30->29 (or <=29), got {m416_after_fire}"
        reload_and_wait(page, 30)
        checks["slot1_m416"] = {"passed": True, "ads": round(m416_ads_val, 3), "after_fire": m416_after_fire, "reloaded": 30}

        # Slot 2: Glock-17
        switch_weapon_and_wait(page, "Digit2", 2, "pistol")
        assert get_me(page)["ammo"] == 15 and get_me(page)["ads"] < 0.1
        page.mouse.click(640, 360, button="right")
        page.wait_for_function(
            """() => {
              const me = window.__fpsApp.game.getState().getMe();
              const vm = window.__fpsApp.game.getState().getViewmodelState();
              return me.ads > 0.85 && vm.worldFov < 65;
            }""",
            timeout=8000,
        )
        glock_ads_val = get_me(page)["ads"]
        page.mouse.click(640, 360, button="right")
        page.wait_for_function("() => window.__fpsApp.game.getState().getMe().ads < 0.1", timeout=8000)
        glock_after_fire = fire_semi_once(page, 15)
        assert glock_after_fire == 14, f"Expected Glock ammo 14, got {glock_after_fire}"
        reload_and_wait(page, 15)
        checks["slot2_glock17"] = {"passed": True, "ads": round(glock_ads_val, 3), "after_fire": glock_after_fire, "reloaded": 15}

        # Slot 3: AWM (Valorant Double Zoom: RMB -> 2.5x -> 5.0x -> Off)
        switch_weapon_and_wait(page, "Digit3", 3, "sniper")
        assert get_me(page)["ammo"] == 5 and get_me(page)["ads"] < 0.1
        page.mouse.click(640, 360, button="right")
        page.wait_for_function(
            """() => {
              const me = window.__fpsApp.game.getState().getMe();
              const vm = window.__fpsApp.game.getState().getViewmodelState();
              const scope = document.getElementById("sniperScope");
              return me.ads > 0.85 && getComputedStyle(scope).display === "block" && vm.worldFov < 35 && vm.armsVisible === false;
            }""",
            timeout=8000,
        )
        awm_ads_val = get_me(page)["ads"]
        page.mouse.click(640, 360, button="right")
        page.wait_for_function("() => window.__fpsApp.game.getState().getAwmScopeState().level === 2", timeout=8000)
        page.mouse.click(640, 360, button="right")
        page.wait_for_function(
            """() => {
              const me = window.__fpsApp.game.getState().getMe();
              const vm = window.__fpsApp.game.getState().getViewmodelState();
              const scope = document.getElementById("sniperScope");
              return me.ads < 0.1 && getComputedStyle(scope).display === "none" && vm.armsVisible === true;
            }""",
            timeout=8000,
        )
        awm_after_fire = fire_semi_once(page, 5)
        assert awm_after_fire == 4, f"Expected AWM ammo 4, got {awm_after_fire}"
        time.sleep(1.35)
        reload_and_wait(page, 5)
        checks["slot3_awm"] = {"passed": True, "ads": round(awm_ads_val, 3), "after_fire": awm_after_fire, "reloaded": 5}
        tracker.assert_clean("Tier 1 Solo")
    finally:
        ctx.close()

    # LAN PvP Dev-Solo Room Creation & Match Start (WAITING -> STARTING -> PLAYING)
    ctx_lan, page_lan = new_tracked_context(browser, tracker, "T1_LAN_DevSolo")
    try:
        wait_fps_ready(page_lan, url)
        page_lan.wait_for_function("() => window.__fpsApp.net.connected === true", timeout=10000)
        page_lan.fill("#nickInput", "T1_SoloHost")
        page_lan.click("#btnModeTDM")
        page_lan.wait_for_timeout(450)
        page_lan.click("#btnOpenCreate")
        page_lan.fill("#createRoomName", f"T1_Room_{int(time.time()) % 100000}")
        page_lan.check("#createAllowSolo")
        page_lan.click("#btnCreateSubmit")
        page_lan.wait_for_function(
            """() => {
              const sr = document.getElementById("screenRoom");
              const rm = window.__fpsApp.roomCtrl.getRoom();
              return sr && getComputedStyle(sr).display === "grid" && rm && rm.state === "WAITING";
            }""",
            timeout=8000,
        )
        page_lan.click("#btnRoomStart")
        page_lan.wait_for_function(
            """() => {
              const rm = window.__fpsApp.roomCtrl.getRoom();
              const cd = document.getElementById("roomCountdown");
              return rm && rm.state === "STARTING" && cd && getComputedStyle(cd).display !== "none";
            }""",
            timeout=5000,
        )
        page_lan.wait_for_function(
            """() => {
              const st = window.__fpsApp.game.getState();
              return st.engineMode === "lan" && st.activeState === "play";
            }""",
            timeout=12000,
        )
        page_lan.wait_for_timeout(250)
        page_lan.evaluate(
            """() => {
              const btn = document.getElementById("btnPauseLeave");
              if (btn) btn.click();
            }"""
        )
        page_lan.wait_for_function(
            """() => {
              const st = window.__fpsApp.game.getState();
              const lb = document.getElementById("screenLobby");
              return st.engineMode === "idle" && lb && getComputedStyle(lb).display === "grid" && window.__fpsApp.roomCtrl.getRoom() === null;
            }""",
            timeout=8000,
        )
        checks["lan_dev_solo_lifecycle"] = {"passed": True, "transitions": "WAITING->STARTING->PLAYING->LOBBY"}
        tracker.assert_clean("Tier 1 LAN Dev-Solo")
    finally:
        ctx_lan.close()

    return {"passed": True, "checks": checks}


def run_tier2(browser: Browser, url: str, tracker: ErrorTracker, out_dir: str) -> dict[str, Any]:
    checks: dict[str, Any] = {}
    ctx, page = new_tracked_context(browser, tracker, "T2_Boundary")
    try:
        start_solo_session(page, url)

        # 1. Rapid weapon switching (1 / 2 / 3 / Q)
        sequence = [
            ("Digit2", 2, "pistol", "15 / ∞"),
            ("Digit3", 3, "sniper", "5 / ∞"),
            ("KeyQ", 2, "pistol", "15 / ∞"),
            ("Digit1", 1, "m416", "30 / ∞"),
            ("KeyQ", 2, "pistol", "15 / ∞"),
            ("Digit3", 3, "sniper", "5 / ∞"),
            ("Digit1", 1, "m416", "30 / ∞"),
        ]
        for key_code, exp_slot, exp_wid, exp_am in sequence:
            switch_weapon_and_wait(page, key_code, exp_slot, exp_wid)
            am_text = page.locator("#am").text_content()
            assert am_text == exp_am, f"HUD ammo mismatch after {key_code}: expected {exp_am}, got {am_text}"
        checks["rapid_weapon_switching"] = {"passed": True, "steps": len(sequence)}

        # 2. Empty-mag reload recovery (deplete AWM 5 rounds -> auto-reload -> 5)
        switch_weapon_and_wait(page, "Digit3", 3, "sniper")
        assert get_me(page)["ammo"] == 5
        for expected_rem in [4, 3, 2, 1, 0]:
            deadline = time.time() + 6.0
            while time.time() < deadline:
                page.mouse.click(640, 360, button="left")
                wait_frames(page, 1)
                cur = int(get_me(page)["ammo"])
                if cur == expected_rem:
                    break
                time.sleep(0.25)
            cur = int(get_me(page)["ammo"])
            assert cur == expected_rem, f"Failed to decrement AWM to {expected_rem}, current={cur}"
        page.wait_for_function(
            "() => window.__fpsApp.game.getState().getMe().reloading === true",
            timeout=5000,
        )
        page.wait_for_function(
            "() => { const me = window.__fpsApp.game.getState().getMe(); return me.reloading === false && me.ammo === 5; }",
            timeout=10000,
        )
        checks["empty_mag_auto_reload"] = {"passed": True, "weapon": "sniper", "refilled_to": 5}

        # 3. Crouch (KeyC hold & release)
        assert get_me(page)["crouched"] is False
        page.keyboard.down("KeyC")
        page.wait_for_function(
            """() => {
              const me = window.__fpsApp.game.getState().getMe();
              const badge = document.getElementById("postureBadge");
              return me.crouched === true && me.eyeHeight < 1.2 && badge && badge.textContent.includes("Ngồi");
            }""",
            timeout=8000,
        )
        crouch_eye = get_me(page)["eyeHeight"]
        page.keyboard.up("KeyC")
        page.wait_for_function(
            "() => { const me = window.__fpsApp.game.getState().getMe(); return me.crouched === false && me.eyeHeight > 1.5; }",
            timeout=8000,
        )
        stand_eye = get_me(page)["eyeHeight"]
        checks["crouch_toggle"] = {"passed": True, "crouch_eyeHeight": round(crouch_eye, 3), "stand_eyeHeight": round(stand_eye, 3)}

        # 4. Laser toggle (KeyL on Slot 1)
        switch_weapon_and_wait(page, "Digit1", 1, "m416")
        page.evaluate("() => window.__fpsApp.game.getState().setPose(-1.5, 0, 3.0, 0.72, -0.13)")
        wait_frames(page, 2)

        def read_laser_vis() -> dict[str, Any]:
            return page.evaluate(
                """() => {
                  const s = window.__e2eScene;
                  let lens = null, beam = null;
                  if (s) {
                    s.traverse((o) => {
                      if (o.name === "laser_lens") lens = o;
                      if (o.isLine && o.material && o.material.color && o.material.color.getHex() === 0x5dff7a) beam = o;
                    });
                  }
                  return {
                    hasLens: Boolean(lens),
                    hasBeam: Boolean(beam),
                    lensVis: lens ? lens.visible : null,
                    beamVis: beam ? beam.visible : null,
                  };
                }"""
            )

        l0 = read_laser_vis()
        assert l0["hasLens"] and l0["hasBeam"], f"Laser nodes missing from scene: {l0}"
        assert l0["lensVis"] is True and l0["beamVis"] is True, f"Expected laser initially ON: {l0}"

        page.keyboard.press("KeyL")
        page.wait_for_function(
            """() => {
              const s = window.__e2eScene;
              let lens = null, beam = null;
              if (s) {
                s.traverse((o) => {
                  if (o.name === "laser_lens") lens = o;
                  if (o.isLine && o.material && o.material.color && o.material.color.getHex() === 0x5dff7a) beam = o;
                });
              }
              return lens && beam && lens.visible === false && beam.visible === false;
            }""",
            timeout=6000,
        )
        page.keyboard.press("KeyL")
        page.wait_for_function(
            """() => {
              const s = window.__e2eScene;
              let lens = null, beam = null;
              if (s) {
                s.traverse((o) => {
                  if (o.name === "laser_lens") lens = o;
                  if (o.isLine && o.material && o.material.color && o.material.color.getHex() === 0x5dff7a) beam = o;
                });
              }
              return lens && beam && lens.visible === true && beam.visible === true;
            }""",
            timeout=6000,
        )
        checks["laser_toggle"] = {"passed": True, "cycle": "true->false->true"}

        # 5. Ground texImage2D REPEAT periodic wrap + dual downward pose seam check + zero errors
        tex_wrap = inspect_ground_teximage2d_wrap(page)
        seam_results: list[dict[str, Any]] = []
        for idx, pose in enumerate([(0.0, 0.0, 1.0, 0.0, -0.55), (4.5, 0.0, 1.0, 0.35, -0.55)], start=1):
            page.evaluate(
                """(pose) => {
                  const st = window.__fpsApp.game.getState();
                  st.setPose(pose[0], pose[1], pose[2], pose[3], pose[4]);
                  st.setTestCombat({ locked: true, aimHeld: false, adsSteps: 80 });
                  window.__fpsApp.game.gunAnim(0, 0);
                }""",
                arg=list(pose),
            )
            wait_frames(page, 3)
            seam_tmp = os.path.join(out_dir, "screenshots", f"tier2_ground_seam_{idx}.png")
            take_screenshot(page, seam_tmp)
            seam_results.append(analyze_ground_seam(seam_tmp))

        tracker.assert_clean("Tier 2 Boundary")
        checks["ground_tiling_and_zero_errors"] = {
            "passed": True,
            "teximage2d_repeat_wrap": tex_wrap,
            "dual_pose_seam_telemetry": seam_results,
        }
    finally:
        ctx.close()

    return {"passed": True, "checks": checks}


def capture_lan_pvp_3p_session(
    browser: Browser,
    url: str,
    tracker: ErrorTracker,
    out_path: str,
    full_sync_checks: bool = True,
) -> dict[str, Any]:
    """
    Spin up 2 isolated BrowserContexts (Host + Guest), execute LAN TDM room lifecycle,
    optionally verify weapon sync / movement / firing / Tab scoreboard, capture 10_lan_pvp_3p.png,
    and cleanly tear down via #btnPauseLeave so zero server rooms leak.
    """
    ctx_host, host = new_tracked_context(browser, tracker, "LAN_Host")
    ctx_guest, guest = new_tracked_context(browser, tracker, "LAN_Guest")
    room_name = f"E2E_PvP_{int(time.time()) % 100000}"
    try:
        wait_fps_ready(host, url)
        wait_fps_ready(guest, url)
        host.wait_for_function("() => window.__fpsApp.net.connected === true", timeout=10000)
        guest.wait_for_function("() => window.__fpsApp.net.connected === true", timeout=10000)

        host.fill("#nickInput", "HostE2E")
        host.click("#btnModeTDM")
        host.wait_for_timeout(450)
        host.click("#btnOpenCreate")
        host.fill("#createRoomName", room_name)
        host.select_option("#createMode", "TDM")
        host.select_option("#createMaxPlayers", "4")
        host.click("#btnCreateSubmit")
        host.wait_for_function(
            """() => {
              const sr = document.getElementById("screenRoom");
              const rm = window.__fpsApp.roomCtrl.getRoom();
              return sr && getComputedStyle(sr).display === "grid" && rm && rm.state === "WAITING";
            }""",
            timeout=14000,
        )

        guest.fill("#nickInput", "GuestE2E")
        guest.wait_for_function(
            """(rname) => {
              const rows = Array.from(document.querySelectorAll("#lobbyRoomBody tr"));
              return rows.some((tr) => tr.textContent.includes(rname));
            }""",
            arg=room_name,
            timeout=14000,
        )
        guest.evaluate(
            """(rname) => {
              const rows = Array.from(document.querySelectorAll("#lobbyRoomBody tr"));
              const row = rows.find((tr) => tr.textContent.includes(rname));
              const btn = row && row.querySelector("button");
              if (btn) btn.click();
            }""",
            arg=room_name,
        )
        guest.wait_for_function(
            """() => {
              const sr = document.getElementById("screenRoom");
              const rm = window.__fpsApp.roomCtrl.getRoom();
              return sr && getComputedStyle(sr).display === "grid" && rm && rm.players.length === 2;
            }""",
            timeout=14000,
        )
        guest.click("#btnRoomReady")
        guest.wait_for_function(
            """() => {
              const btn = document.getElementById("btnRoomReady");
              return btn && btn.textContent.includes("Hủy sẵn sàng");
            }""",
            timeout=5000,
        )

        host.click("#btnRoomStart")
        host.wait_for_function(
            """() => {
              const rm = window.__fpsApp.roomCtrl.getRoom();
              const cd = document.getElementById("roomCountdown");
              return rm && rm.state === "STARTING" && cd && getComputedStyle(cd).display !== "none";
            }""",
            timeout=5000,
        )
        for p in (host, guest):
            p.wait_for_function(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const pvp = document.getElementById("pvpTop");
                  const rad = document.getElementById("radarCanvas");
                  return st.engineMode === "lan" && st.activeState === "play" &&
                    pvp && getComputedStyle(pvp).display === "flex" &&
                    rad && getComputedStyle(rad).display === "block";
                }""",
                timeout=14000,
            )

        host.wait_for_timeout(220)
        ensure_combat_locked(host)
        ensure_combat_locked(guest)

        for p in (host, guest):
            p.wait_for_function(
                "() => window.__fpsApp.game.getState().getRemotePlayers().size >= 1",
                timeout=15000,
            )

        synced_weapons: list[str] = []
        host_ammo_after = 30
        scoreboard_ok = False
        if full_sync_checks:
            for key_code, exp_slot, exp_wid in [("Digit2", 2, "pistol"), ("Digit3", 3, "sniper"), ("Digit1", 1, "m416")]:
                switch_weapon_and_wait(host, key_code, exp_slot, exp_wid)
                guest.wait_for_function(
                    """(expectedWid) => {
                      const map = window.__fpsApp.game.getState().getRemotePlayers();
                      for (const av of map.values()) {
                        if (av.weaponId === expectedWid) return true;
                      }
                      return false;
                    }""",
                    arg=exp_wid,
                    timeout=15000,
                )
                synced_weapons.append(exp_wid)

            rem0 = guest.evaluate(
                """() => {
                  const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                  return { x: av.container.position.x, z: av.container.position.z };
                }"""
            )
            host.keyboard.down("KeyW")
            guest.wait_for_function(
                """([rx, rz]) => {
                  const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
                  if (!av) return false;
                  return Math.hypot(av.container.position.x - rx, av.container.position.z - rz) > 0.25;
                }""",
                arg=[rem0["x"], rem0["z"]],
                timeout=15000,
            )
            host.keyboard.up("KeyW")

            host_ammo_after = fire_auto_once(host, 30)
            host.wait_for_function(
                """(expected) => {
                  const am = document.getElementById("am");
                  return am && am.textContent === `${expected} / ∞`;
                }""",
                arg=host_ammo_after,
                timeout=5000,
            )

            # Tab scoreboard check
            host.keyboard.down("Tab")
            host.wait_for_function(
                "() => getComputedStyle(document.getElementById('scoreboard')).display === 'block'",
                timeout=5000,
            )
            host.keyboard.up("Tab")
            host.wait_for_function(
                "() => getComputedStyle(document.getElementById('scoreboard')).display === 'none'",
                timeout=5000,
            )
            scoreboard_ok = True

        # Deterministic facing poses for 3rd-person soldier.glb + TeamColor + HUD capture
        host.evaluate(
            """() => {
              const st = window.__fpsApp.game.getState();
              st.setPose(0.0, 0.0, 3.8, 0.0, -0.05);
              st.setTestCombat({ locked: true, aimHeld: false, adsSteps: 80 });
              window.__fpsApp.game.gunAnim(0, 0);
            }"""
        )
        guest.evaluate(
            """() => {
              const st = window.__fpsApp.game.getState();
              st.setPose(0.0, 0.0, -1.8, Math.PI, 0.0);
              st.setTestCombat({ locked: true, aimHeld: false, adsSteps: 80 });
              window.__fpsApp.game.gunAnim(0, 0);
            }"""
        )
        host.wait_for_function(
            """() => {
              const av = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values())[0];
              return av && Math.hypot(av.container.position.x - 0.0, av.container.position.z - (-1.8)) < 0.9;
            }""",
            timeout=18000,
        )
        wait_frames(host, 3)
        take_screenshot(host, out_path)
        std_val = verify_non_blank_png(out_path)

        # Clean teardown via #btnPauseLeave on both tabs
        for p in (guest, host):
            p.evaluate(
                """() => {
                  const btn = document.getElementById("btnPauseLeave");
                  if (btn) btn.click();
                }"""
            )
            p.wait_for_function(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const lb = document.getElementById("screenLobby");
                  return st.engineMode === "idle" && lb && getComputedStyle(lb).display === "grid" && window.__fpsApp.roomCtrl.getRoom() === null;
                }""",
                timeout=15000,
            )

        tracker.assert_clean("LAN PvP 2-Tab")
        return {
            "passed": True,
            "synced_weapons": synced_weapons,
            "host_ammo_after_fire": host_ammo_after,
            "scoreboard_toggled": scoreboard_ok,
            "screenshot_10_lan_pvp_3p": out_path,
            "std_luma_255": std_val,
        }
    finally:
        ctx_guest.close()
        ctx_host.close()


def run_tier3(browser: Browser, url: str, tracker: ErrorTracker, out_dir: str) -> dict[str, Any]:
    checks: dict[str, Any] = {}

    # 3.1 Solo Drone combined flow: WASD + crouch + ADS + switch 1/2/3/Q + fire + reload
    ctx_s, page_s = new_tracked_context(browser, tracker, "T3_SoloCombo")
    try:
        start_solo_session(page_s, url)
        p0 = page_s.evaluate("() => { const p = window.__fpsApp.game.getState().P; return { x: p.x, z: p.z }; }")
        page_s.keyboard.down("KeyW")
        page_s.keyboard.down("KeyA")
        page_s.wait_for_function(
            """([x0, z0]) => {
              const p = window.__fpsApp.game.getState().P;
              return Math.hypot(p.x - x0, p.z - z0) > 0.6;
            }""",
            arg=[p0["x"], p0["z"]],
            timeout=15000,
        )
        page_s.keyboard.up("KeyW")
        page_s.keyboard.up("KeyA")
        p1 = page_s.evaluate("() => { const p = window.__fpsApp.game.getState().P; return { x: p.x, z: p.z }; }")
        moved_dist = math.hypot(p1["x"] - p0["x"], p1["z"] - p0["z"])

        page_s.keyboard.down("KeyC")
        page_s.mouse.click(640, 360, button="right")
        page_s.wait_for_function(
            """() => {
              const me = window.__fpsApp.game.getState().getMe();
              return me.crouched === true && me.eyeHeight < 1.2 && me.ads > 0.85 && (me.flags & 3) === 3;
            }""",
            timeout=15000,
        )
        page_s.mouse.click(640, 360, button="right")
        page_s.keyboard.up("KeyC")
        page_s.wait_for_function(
            "() => { const me = window.__fpsApp.game.getState().getMe(); return me.crouched === false && me.ads < 0.1; }",
            timeout=15000,
        )

        # Switch 2 -> 3 -> Q (back to 2) -> fire -> reload -> 3 -> ADS -> fire -> reload -> 1 -> fire -> reload
        switch_weapon_and_wait(page_s, "Digit2", 2, "pistol")
        switch_weapon_and_wait(page_s, "Digit3", 3, "sniper")
        switch_weapon_and_wait(page_s, "KeyQ", 2, "pistol")
        fire_semi_once(page_s, 15)
        reload_and_wait(page_s, 15)

        switch_weapon_and_wait(page_s, "Digit3", 3, "sniper")
        page_s.mouse.click(640, 360, button="right")
        page_s.wait_for_function(
            "() => getComputedStyle(document.getElementById('sniperScope')).display === 'block'",
            timeout=15000,
        )
        page_s.mouse.click(640, 360, button="right")
        page_s.wait_for_function("() => window.__fpsApp.game.getState().getAwmScopeState().level === 2", timeout=15000)
        page_s.mouse.click(640, 360, button="right")
        page_s.wait_for_function(
            "() => window.__fpsApp.game.getState().getMe().ads < 0.1",
            timeout=15000,
        )
        fire_semi_once(page_s, 5)
        reload_and_wait(page_s, 5)

        switch_weapon_and_wait(page_s, "Digit1", 1, "m416")
        m416_after = fire_auto_once(page_s, 30)
        reload_and_wait(page_s, 30)

        tracker.assert_clean("Tier 3 Solo Combo")
        checks["solo_combined_flow"] = {
            "passed": True,
            "moved_dist_m": round(moved_dist, 3),
            "m416_after_fire": m416_after,
            "switched_with_Q": True,
        }
    finally:
        ctx_s.close()

    # 3.2 LAN PvP 2-context multi-tab workflow + 10_lan_pvp_3p.png
    p10 = os.path.join(out_dir, "screenshots", "10_lan_pvp_3p.png")
    checks["lan_pvp_2tab_sync"] = capture_lan_pvp_3p_session(
        browser, url, tracker, p10, full_sync_checks=True
    )

    return {"passed": True, "checks": checks}


def _load_rgb01(path: str) -> np.ndarray:
    with Image.open(path) as img:
        rgb = img.convert("RGB")
        return np.asarray(rgb, dtype=np.float32) / 255.0


def _compute_1d_seam_metrics(luma_2d: np.ndarray, axis: int) -> tuple[float, float, float]:
    """
    Measure signed step coherence across candidate straight-line tiling seams.
    axis=1 scans vertical lines (columns x); axis=0 scans horizontal lines (rows y).
    Returns (best_score, max_abs_step_01, max_coherent_seam_jump_255).
    """
    arr = luma_2d if axis == 1 else luma_2d.T
    h, w = arr.shape
    if w < 24 or h < 12:
        return 0.0, 0.0, 0.0

    best_score = 0.0
    max_abs_step = 0.0
    max_coh_jump_255 = 0.0
    for x in range(10, w - 10):
        left_near = arr[:, x - 3:x].mean(axis=1)
        right_near = arr[:, x + 1:x + 4].mean(axis=1)
        diff = right_near - left_near
        step = float(np.mean(diff))

        left_far = arr[:, x - 10:x - 3].mean(axis=1)
        right_far = arr[:, x + 4:x + 11].mean(axis=1)
        far_shift = float(np.mean(right_far - left_far))

        if step * far_shift <= 0:
            continue
        sgn = 1.0 if step > 0 else -1.0
        row_coherence = float(np.mean((diff * sgn) > 0.008))

        bg_diff = np.abs(arr[:, 1:] - arr[:, :-1]).mean(axis=0)
        med_grad = float(np.median(bg_diff)) + 1e-6
        local_grad = float(np.mean(np.abs(arr[:, x + 1] - arr[:, x])))
        sharp_ratio = local_grad / med_grad

        score = min(abs(step), abs(far_shift)) * row_coherence * min(sharp_ratio / 4.0, 2.0)
        if score > best_score:
            best_score = score
        if row_coherence >= 0.6 and sharp_ratio >= 3.0:
            if abs(step) > max_abs_step:
                max_abs_step = abs(step)
            if abs(step) * 255.0 > max_coh_jump_255:
                max_coh_jump_255 = abs(step) * 255.0

    return round(best_score, 5), round(max_abs_step, 5), round(max_coh_jump_255, 2)


def analyze_ground_seam(path: str) -> dict[str, Any]:
    arr = _load_rgb01(path)
    h, w, _ = arr.shape
    luma = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
    # Open ground region avoiding weapon/hands on the right (x > 0.60) and HUD strips
    roi = luma[int(0.28 * h):int(0.82 * h), int(0.12 * w):int(0.58 * w)]
    v_score, v_step, v_jump255 = _compute_1d_seam_metrics(roi, axis=1)
    h_score, h_step, h_jump255 = _compute_1d_seam_metrics(roi, axis=0)
    seam_score = max(v_score, h_score)
    max_abs_step = max(v_step, h_step)
    max_coh_jump = max(v_jump255, h_jump255)
    passed = seam_score < 0.025 and max_abs_step < 0.035 and max_coh_jump <= 4.0
    return {
        "seam_score": seam_score,
        "max_abs_step": max_abs_step,
        "max_coherent_vertical_seam_jump_255": v_jump255,
        "max_coherent_seam_jump_255": max_coh_jump,
        "vertical": {"score": v_score, "step": v_step, "jump_255": v_jump255},
        "horizontal": {"score": h_score, "step": h_step, "jump_255": h_jump255},
        "thresholds": {"seam_score_lt": 0.025, "max_abs_step_lt": 0.035, "max_coherent_seam_jump_255_le": 4.0},
        "passed": passed,
    }


def analyze_rain_ripples(path: str, scene_audit: dict[str, Any]) -> dict[str, Any]:
    """
    Analyze wet-ground ROI for wide concentric ripple arcs vs flat square PointsMaterial dots,
    combined with scene-level InstancedMesh vs Points verification.
    """
    arr = _load_rgb01(path)
    h, w, _ = arr.shape
    luma = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
    roi = luma[int(0.54 * h):int(0.86 * h), int(0.10 * w):int(0.55 * w)]
    pad = 6
    padded = np.pad(roi, pad, mode="edge")
    rh, rw = roi.shape
    bg = np.zeros_like(roi)
    for dy in range(-pad, pad + 1):
        for dx in range(-pad, pad + 1):
            bg += padded[pad + dy:pad + dy + rh, pad + dx:pad + dx + rw]
    bg /= float((2 * pad + 1) ** 2)
    diff = roi - bg

    dot_mask = (roi > 0.65) & (diff > 0.22)
    arc_mask = (diff > 0.045) & (roi > 0.16)

    def _components(mask: np.ndarray) -> list[tuple[int, int, int, float]]:
        pts = set(zip(*np.where(mask)))
        comps: list[tuple[int, int, int, float]] = []
        while pts:
            start = pts.pop()
            comp = [start]
            q = [start]
            while q:
                cy, cx = q.pop()
                for ny in (cy - 1, cy, cy + 1):
                    for nx in (cx - 1, cx, cx + 1):
                        if (ny, nx) in pts:
                            pts.remove((ny, nx))
                            comp.append((ny, nx))
                            q.append((ny, nx))
            ys = [k[0] for k in comp]
            xs = [k[1] for k in comp]
            bw = max(xs) - min(xs) + 1
            bh = max(ys) - min(ys) + 1
            comps.append((len(comp), bw, bh, len(comp) / float(bw * bh)))
        return comps

    flat_dots = [c for c in _components(dot_mask) if c[0] <= 18 and c[1] <= 5 and c[2] <= 5 and c[3] >= 0.70]
    wide_arcs = [c for c in _components(arc_mask) if c[1] >= 7 and c[1] > c[2] * 1.4 and c[3] < 0.72 and c[0] >= 7]
    scene_instanced_ok = bool(scene_audit["checks"].get("rain_ripples_instanced_no_points"))
    passed = scene_instanced_ok and (len(wide_arcs) >= 4) and (len(flat_dots) <= 2)
    return {
        "wide_arc_component_count": len(wide_arcs),
        "flat_square_dot_count": len(flat_dots),
        "scene_instanced_ripples_ok": scene_instanced_ok,
        "thresholds": {"wide_arc_ge": 4, "flat_square_dot_le": 2, "scene_instanced_ripples_ok": True},
        "passed": passed,
    }


def analyze_container_contact_shadow(path: str) -> dict[str, Any]:
    """
    Analyze vertical luminance strip across the left HALDEN container in 09_container_contact_shadow.png
    (posed at (-5.5, 0.0, 3.5, 0.96, -0.14) where container spans x=[0.24..0.54], wall y=[0.32..0.56], base y~0.56..0.60).
    """
    arr = _load_rgb01(path)
    h, w, _ = arr.shape
    luma = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
    strip = luma[:, int(0.26 * w):int(0.48 * w)].mean(axis=1)

    upper_wall = float(strip[int(0.32 * h):int(0.42 * h)].mean())
    band_h = max(4, int(0.02 * h))
    y0, y1 = int(0.46 * h), int(0.62 * h)
    rolling = [float(strip[y:y + band_h].mean()) for y in range(y0, max(y0 + 1, y1 - band_h + 1))]
    contact_min = min(rolling)
    below_floor = float(strip[int(0.61 * h):int(0.68 * h)].mean())
    ratio = contact_min / max(upper_wall, 1e-6)
    drop_ratio = (below_floor - contact_min) / max(below_floor, 1e-6)
    contact_min_255 = contact_min * 255.0
    has_trough = contact_min < below_floor * 0.85
    passed = (ratio <= 0.45) and (drop_ratio >= 0.15 or contact_min_255 <= 35.0) and has_trough
    return {
        "upper_wall_luma": round(upper_wall, 4),
        "contact_min_luma": round(contact_min, 4),
        "contact_strip_min_row_luma_255": round(contact_min_255, 2),
        "below_floor_luma": round(below_floor, 4),
        "contact_to_upper_ratio": round(ratio, 4),
        "floor_to_contact_drop_ratio": round(drop_ratio, 4),
        "has_dark_trough": has_trough,
        "thresholds": {
            "ratio_le": 0.45,
            "contact_lt_below_floor_x0_85": True,
            "contact_strip_min_luma_255_le_35_or_drop_ge_0_15": True,
        },
        "passed": passed,
    }


def analyze_warm_cool_balance(path: str) -> dict[str, Any]:
    arr = _load_rgb01(path)
    h, _, _ = arr.shape
    roi = arr[int(0.12 * h):int(0.88 * h), :, :]
    r, b = roi[:, :, 0], roi[:, :, 2]
    warm_mask = ((r - b) > 0.06) & (r > 0.18)
    cool_mask = ((b - r) > 0.04) & (b > 0.08)
    warm_pct = float(warm_mask.mean() * 100.0)
    cool_pct = float(cool_mask.mean() * 100.0)
    p95_rb = float(np.percentile(r - b, 95))
    p05_rb = float(np.percentile(r - b, 5))
    p95_rb_255 = p95_rb * 255.0
    p05_rb_255 = p05_rb * 255.0
    passed = (
        warm_pct >= 5.0
        and cool_pct >= 5.0
        and p95_rb_255 >= 12.0
        and p05_rb_255 <= -8.0
    )
    return {
        "warm_pct": round(warm_pct, 2),
        "cool_pct": round(cool_pct, 2),
        "p95_R_minus_B": round(p95_rb, 4),
        "p05_R_minus_B": round(p05_rb, 4),
        "p95_R_minus_B_255": round(p95_rb_255, 2),
        "p05_R_minus_B_255": round(p05_rb_255, 2),
        "thresholds": {
            "warm_pct_ge": 5.0,
            "cool_pct_ge": 5.0,
            "p95_R_minus_B_255_ge": 12.0,
            "p05_R_minus_B_255_le": -8.0,
        },
        "passed": passed,
    }


def analyze_red_dot(path: str) -> dict[str, Any]:
    arr = _load_rgb01(path)
    h, w, _ = arr.shape
    cx, cy = w // 2, h // 2
    dx, dy = int(0.08 * w), int(0.10 * h)
    crop = arr[cy - dy:cy + dy, cx - dx:cx + dx, :]
    r, g, b = crop[:, :, 0], crop[:, :, 1], crop[:, :, 2]
    mask = (r > 0.45) & ((r - g) > 0.22) & ((r - b) > 0.22)
    ys, xs = np.where(mask)
    count = int(len(xs))
    if count == 0:
        return {
            "count": 0,
            "core_r6_px": 0,
            "outer_ring_r9_45_px": 0,
            "max_radius_px": 999.0,
            "centroid_offset_px": 999.0,
            "bbox_w": 0,
            "bbox_h": 0,
            "radial_std": 999.0,
            "fill_ratio": 0.0,
            "thresholds": {
                "core_r6_px_ge": 4,
                "outer_ring_r9_45_px_le": 15,
                "max_radius_px_le": 8.0,
                "centroid_offset_px_le": 3.0,
            },
            "passed": False,
        }
    bbox_w = int(xs.max() - xs.min() + 1)
    bbox_h = int(ys.max() - ys.min() + 1)
    mx, my = float(xs.mean()), float(ys.mean())
    crop_cx, crop_cy = float(dx), float(dy)
    centroid_offset = math.hypot(mx - crop_cx, my - crop_cy)
    dist_center = np.sqrt((xs - crop_cx) ** 2 + (ys - crop_cy) ** 2)
    dist_centroid = np.sqrt((xs - mx) ** 2 + (ys - my) ** 2)
    core_r6 = int(np.sum(dist_center <= 6.0))
    outer_r9_45 = int(np.sum((dist_center >= 9.0) & (dist_center <= 45.0)))
    max_radius = float(dist_centroid.max())
    radial_std = float(np.std(dist_centroid))
    fill_ratio = float(count / max(1, bbox_w * bbox_h))
    passed = (
        (4 <= count <= 120)
        and (core_r6 >= 4)
        and (outer_r9_45 <= 15)
        and (max_radius <= 8.0)
        and (centroid_offset <= 3.0)
        and (bbox_w <= 16)
        and (bbox_h <= 16)
        and (radial_std <= 4.5)
        and (fill_ratio >= 0.45)
    )
    return {
        "count": count,
        "core_r6_px": core_r6,
        "outer_ring_r9_45_px": outer_r9_45,
        "max_radius_px": round(max_radius, 3),
        "centroid_offset_px": round(centroid_offset, 3),
        "bbox_w": bbox_w,
        "bbox_h": bbox_h,
        "radial_std": round(radial_std, 3),
        "fill_ratio": round(fill_ratio, 3),
        "thresholds": {
            "core_r6_px_ge": 4,
            "outer_ring_r9_45_px_le": 15,
            "max_radius_px_le": 8.0,
            "centroid_offset_px_le": 3.0,
            "bbox_le": 16,
            "radial_std_le": 4.5,
            "fill_ratio_ge": 0.45,
        },
        "passed": passed,
    }


def analyze_arms_gloves_thumb(path: str) -> dict[str, Any]:
    arr = _load_rgb01(path)
    h, w, _ = arr.shape

    def region_stats(x0: float, x1: float, y0: float, y1: float) -> tuple[np.ndarray, float]:
        patch = arr[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w), :]
        mean_rgb = patch.reshape(-1, 3).mean(axis=0)
        luma = float(0.299 * mean_rgb[0] + 0.587 * mean_rgb[1] + 0.114 * mean_rgb[2])
        return mean_rgb, luma

    # Diagonal olive ripstop sleeve vs right-hand charcoal tactical glove
    sleeve_rgb, sleeve_luma = region_stats(0.46, 0.55, 0.82, 0.96)
    glove_rgb, glove_luma = region_stats(0.70, 0.78, 0.86, 0.95)
    rgb_dist = float(np.linalg.norm(sleeve_rgb - glove_rgb))
    sleeve_g_minus_b = float(sleeve_rgb[1] - sleeve_rgb[2])

    # Right exposed thumb ROI excluding warm asphalt floor gap (x < 0.62) & weapon HUD pills (x >= 0.72)
    thumb_roi = arr[int(0.87 * h):int(0.96 * h), int(0.62 * w):int(0.72 * w), :]
    tr, tg, tb = thumb_roi[:, :, 0], thumb_roi[:, :, 1], thumb_roi[:, :, 2]
    skin_mask = (tr > tg) & (tg > tb) & ((tr - tb) > 0.10) & (tr > 0.30)
    if np.any(skin_mask):
        skin_px = thumb_roi[skin_mask]
        skin_lumas = 0.299 * skin_px[:, 0] + 0.587 * skin_px[:, 1] + 0.114 * skin_px[:, 2]
        right_thumb_luma = float(skin_lumas.mean())
        right_thumb_p95 = float(np.percentile(skin_lumas, 95))
    else:
        _, right_thumb_luma = region_stats(0.62, 0.72, 0.86, 0.96)
        right_thumb_p95 = right_thumb_luma

    passed = (
        rgb_dist >= 0.08
        and sleeve_g_minus_b > 0.015
        and glove_luma <= 0.25
        and right_thumb_luma <= 0.55
        and right_thumb_p95 <= 0.68
    )
    return {
        "rgb_dist_sleeve_glove": round(rgb_dist, 4),
        "sleeve_G_minus_B": round(sleeve_g_minus_b, 4),
        "sleeve_luma": round(sleeve_luma, 4),
        "glove_luma": round(glove_luma, 4),
        "right_thumb_luma": round(right_thumb_luma, 4),
        "right_thumb_p95_luma": round(right_thumb_p95, 4),
        "thresholds": {
            "rgb_dist_ge": 0.08,
            "sleeve_G_minus_B_gt": 0.015,
            "glove_luma_le": 0.25,
            "right_thumb_luma_le": 0.55,
            "right_thumb_p95_luma_le": 0.68,
        },
        "passed": passed,
    }


def verify_non_blank_png(path: str) -> float:
    arr = _load_rgb01(path)
    assert arr.shape == (720, 1280, 3), f"Expected 1280x720 RGB screenshot, got {arr.shape} at {path}"
    std_val = float(np.std(arr) * 255.0)
    assert std_val > 5.0, f"Screenshot appears blank/uniform (std={std_val:.2f}): {path}"
    return round(std_val, 2)


def run_tier4(
    browser: Browser,
    url: str,
    tracker: ErrorTracker,
    out_dir: str,
    strict_visual: bool,
) -> dict[str, Any]:
    ss_dir = os.path.join(out_dir, "screenshots")
    os.makedirs(ss_dir, exist_ok=True)
    ctx, page = new_tracked_context(browser, tracker, "T4_VisualPerf")
    captures: dict[str, Any] = {}

    def capture_pose(
        filename: str,
        slot: int,
        wid: str,
        pose: tuple[float, float, float, float, float],
        aim_held: bool,
        toggle_laser_off: bool = False,
    ) -> str:
        if int(get_me(page)["hp"]) < 100:
            start_solo_session(page, url)
        # Always clear ADS before switching weapons so cam.fov resets cleanly
        page.evaluate(
            """() => {
              const st = window.__fpsApp.game.getState();
              st.setTestCombat({ locked: true, aimHeld: false, adsSteps: 80 });
              window.__fpsApp.game.gunAnim(0, 0);
            }"""
        )
        if int(get_weapons(page)["activeSlot"]) != slot:
            switch_weapon_and_wait(page, f"Digit{slot}", slot, wid)
        if toggle_laser_off and slot == 1:
            page.keyboard.press("KeyL")
            wait_frames(page, 1)

        page.evaluate(
            """([pose, aimHeld]) => {
              const st = window.__fpsApp.game.getState();
              st.setPose(pose[0], pose[1], pose[2], pose[3], pose[4]);
              st.setTestCombat({ locked: true, aimHeld, adsSteps: 80 });
              window.__fpsApp.game.gunAnim(0, 0);
            }""",
            arg=[list(pose), aim_held],
        )
        page.wait_for_function(
            """(aimHeld) => {
              const ads = window.__fpsApp.game.getState().getMe().ads;
              return aimHeld ? ads > 0.99 : ads < 0.01;
            }""",
            arg=aim_held,
            timeout=6000,
        )
        wait_frames(page, 3)
        me = get_me(page)
        vm = get_vm_state(page)
        assert me["hp"] == 100, f"Expected hp===100 for deterministic screenshot {filename}, got {me['hp']}"
        if not aim_held:
            assert vm["worldFov"] >= 70.0, f"Expected hipfire worldFov >= 70, got {vm['worldFov']} for {filename}"
        out_path = os.path.join(ss_dir, filename)
        take_screenshot(page, out_path)
        std_val = verify_non_blank_png(out_path)
        captures[filename] = {
            "path": out_path,
            "std_luma_255": std_val,
            "slot": slot,
            "ads": round(me["ads"], 3),
            "worldFov": round(vm["worldFov"], 2),
        }

        if toggle_laser_off and slot == 1:
            page.keyboard.press("KeyL")
            wait_frames(page, 1)
        return out_path

    try:
        start_solo_session(page, url)
        pose_harbor = (-1.5, 0.0, 3.0, 0.72, -0.13)
        pose_wide = (0.0, 0.0, 8.5, 0.42, -0.15)
        pose_seam = (0.0, 0.0, 1.0, 0.0, -0.55)
        pose_container = (-5.5, 0.0, 3.5, 0.96, -0.14)

        p01 = capture_pose("01_m416_hipfire.png", 1, "m416", pose_harbor, False)
        p02 = capture_pose("02_m416_ads_reddot.png", 1, "m416", pose_harbor, True)
        capture_pose("03_glock_hipfire.png", 2, "pistol", pose_harbor, False)
        capture_pose("04_glock_ads.png", 2, "pistol", pose_harbor, True)
        capture_pose("05_awm_hipfire.png", 3, "sniper", pose_harbor, False)
        capture_pose("06_awm_ads_scope.png", 3, "sniper", pose_harbor, True)
        p07 = capture_pose("07_wide_harbor_view.png", 1, "m416", pose_wide, False, toggle_laser_off=True)
        p08 = capture_pose("08_ground_seam_check.png", 1, "m416", pose_seam, False)
        p09 = capture_pose("09_container_contact_shadow.png", 1, "m416", pose_container, False, toggle_laser_off=True)

        tex_wrap_t4 = inspect_ground_teximage2d_wrap(page)
        scene_mat_audit = inspect_scene_materials(page)

        # Renderer resource & frame-time stability soak (3 warmup + >=30 steady frames)
        page.evaluate(
            """() => {
              const st = window.__fpsApp.game.getState();
              st.setPose(-1.5, 0.0, 3.0, 0.72, -0.13);
              st.setTestCombat({ locked: true, aimHeld: false, adsSteps: 80 });
              window.__fpsApp.game.gunAnim(0, 0);
            }"""
        )
        wait_frames(page, 3)
        page.evaluate("() => window.__e2eResetPerf()")

        samples: list[dict[str, Any]] = []
        base_fc = page.evaluate("() => window.__e2eLastRender.frameCount")
        target_fc = base_fc + 32
        deadline = time.time() + 35.0
        while time.time() < deadline:
            snap = page.evaluate(
                """() => ({
                  r: window.__e2eLastRender,
                  lost: Boolean(window.__e2eContextLost),
                })"""
            )
            r = snap["r"]
            if r and r.get("world") and r.get("vm"):
                samples.append({
                    "frameCount": r["frameCount"],
                    "world_calls": r["world"]["calls"],
                    "vm_calls": r["vm"]["calls"],
                    "total_calls": r["world"]["calls"] + r["vm"]["calls"],
                    "world_triangles": r["world"]["triangles"],
                    "vm_triangles": r["vm"]["triangles"],
                    "total_triangles": r["world"]["triangles"] + r["vm"]["triangles"],
                    "geometries": r["memory"]["geometries"],
                    "textures": r["memory"]["textures"],
                    "programs": r["programs"],
                    "context_lost": snap["lost"],
                })
                if r["frameCount"] >= target_fc and len(samples) >= 30:
                    break
            time.sleep(0.15)

        assert len(samples) >= 30, f"Soak collected only {len(samples)} samples (<30)"
        frames_advanced = samples[-1]["frameCount"] - samples[0]["frameCount"]
        assert frames_advanced >= 30, f"Insufficient steady frame progression during soak: {frames_advanced}"

        geom_vals = [s["geometries"] for s in samples]
        tex_vals = [s["textures"] for s in samples]
        call_vals = [s["total_calls"] for s in samples]
        tri_vals = [s["total_triangles"] for s in samples]
        geom_delta = max(geom_vals) - min(geom_vals)
        tex_delta = max(tex_vals) - min(tex_vals)
        calls_mean = float(np.mean(call_vals))
        tris_mean = float(np.mean(tri_vals))
        max_calls = max(call_vals)
        any_lost = any(s["context_lost"] for s in samples)

        perf_arrays = page.evaluate(
            """() => ({
              ft: (window.__e2eLastRender && window.__e2eLastRender.frameTimes) || [],
              jt: (window.__e2eLastRender && window.__e2eLastRender.jsTimes) || [],
              heap: (window.__e2eLastRender && window.__e2eLastRender.heapSamplesMB) || [],
            })"""
        )
        finite_fts = [float(x) for x in perf_arrays["ft"] if isinstance(x, (int, float)) and math.isfinite(x) and x > 0]
        finite_jts = [float(x) for x in perf_arrays["jt"] if isinstance(x, (int, float)) and math.isfinite(x) and x >= 0]
        heap_vals = [float(x) for x in perf_arrays["heap"] if isinstance(x, (int, float)) and math.isfinite(x)]

        assert len(finite_fts) >= 20, f"Insufficient finite frame times recorded: {len(finite_fts)}"
        assert len(finite_jts) >= 20, f"Insufficient finite JS render times recorded: {len(finite_jts)}"

        js_p50 = float(np.percentile(finite_jts, 50))
        js_p95 = float(np.percentile(finite_jts, 95))
        ft_p50 = float(np.percentile(finite_fts, 50))
        ft_p95 = float(np.percentile(finite_fts, 95))
        heap_growth_mb = (max(heap_vals) - min(heap_vals)) if len(heap_vals) >= 2 else 0.0

        assert calls_mean <= 450.0, f"Mean draw call budget exceeded: {calls_mean:.1f} (>450)"
        assert tris_mean <= 180000.0, f"Mean triangle budget exceeded: {tris_mean:.1f} (>180000)"
        assert js_p50 <= 25.0, f"JS render p50 exceeded: {js_p50:.2f}ms (>25ms)"
        assert js_p95 <= 60.0, f"JS render p95 exceeded: {js_p95:.2f}ms (>60ms)"
        assert ft_p95 < 1500.0, f"Frame dtMs p95 stalled: {ft_p95:.2f}ms (>=1500ms)"
        assert heap_growth_mb <= 15.0, f"JS heap leak detected: growth={heap_growth_mb:.2f}MB (>15MB)"
        assert geom_delta <= 2, f"Geometry count unstable during soak: delta={geom_delta} ({geom_vals})"
        assert tex_delta <= 2, f"Texture count unstable during soak: delta={tex_delta} ({tex_vals})"
        assert not any_lost, "WebGL context lost during perf soak"

        perf_stability = {
            "passed": True,
            "samples": len(samples),
            "frames_advanced": frames_advanced,
            "total_calls_mean": round(calls_mean, 1),
            "total_calls_max": max_calls,
            "total_triangles_mean": round(tris_mean, 1),
            "world_triangles_mean": round(float(np.mean([s["world_triangles"] for s in samples])), 1),
            "vm_triangles_mean": round(float(np.mean([s["vm_triangles"] for s in samples])), 1),
            "geometries_min_max": [min(geom_vals), max(geom_vals)],
            "geometries_delta": geom_delta,
            "textures_min_max": [min(tex_vals), max(tex_vals)],
            "textures_delta": tex_delta,
            "programs": samples[-1]["programs"],
            "js_time_ms_p50": round(js_p50, 2),
            "js_time_ms_p95": round(js_p95, 2),
            "frame_time_ms_p50": round(ft_p50, 2),
            "frame_time_ms_p95": round(ft_p95, 2),
            "heap_growth_mb": round(heap_growth_mb, 2),
            "context_lost": any_lost,
        }

        tracker.assert_clean("Tier 4 Visual & Perf")
    finally:
        ctx.close()

    # Ensure 10_lan_pvp_3p.png also exists if Tier 4 was run standalone (--only-tier 4)
    p10 = os.path.join(ss_dir, "10_lan_pvp_3p.png")
    if not os.path.exists(p10):
        lan_cap = capture_lan_pvp_3p_session(browser, url, tracker, p10, full_sync_checks=False)
        captures["10_lan_pvp_3p.png"] = {
            "path": p10,
            "std_luma_255": lan_cap["std_luma_255"],
            "mode": "lan_pvp_3p",
        }
    else:
        captures["10_lan_pvp_3p.png"] = {
            "path": p10,
            "std_luma_255": verify_non_blank_png(p10),
            "mode": "lan_pvp_3p",
        }

    # Automated visual / material / seam telemetry
    visual_telemetry = {
        "ground_seam_08": analyze_ground_seam(p08),
        "teximage2d_repeat_wrap": tex_wrap_t4,
        "rain_ripples_07": analyze_rain_ripples(p07, scene_mat_audit),
        "container_contact_shadow_09": analyze_container_contact_shadow(p09),
        "warm_cool_01_m416_hip": analyze_warm_cool_balance(p01),
        "warm_cool_07_wide": analyze_warm_cool_balance(p07),
        "red_dot_compactness_02": analyze_red_dot(p02),
        "arms_gloves_thumb_01": analyze_arms_gloves_thumb(p01),
        "scene_material_audit": scene_mat_audit,
    }
    visual_all_passed = all(v["passed"] for v in visual_telemetry.values())
    tier4_passed = perf_stability["passed"] and (visual_all_passed if strict_visual else True)

    return {
        "passed": tier4_passed,
        "visual_gate_enforced": strict_visual,
        "visual_all_passed": visual_all_passed,
        "captures": captures,
        "visual_telemetry": visual_telemetry,
        "perf_stability": perf_stability,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FPS Rainy Harbor 4-Tier Opaque-Box E2E Suite")
    parser.add_argument("--url", "--base-url", dest="url", default=DEFAULT_URL, help="Target FPS.html URL")
    parser.add_argument("--out-dir", default="", help="External output directory for screenshots and report.json")
    parser.add_argument(
        "--strict-visual",
        "--enforce-visual",
        dest="strict_visual",
        action="store_true",
        help="Gate exit code on visual/material/seam telemetry thresholds",
    )
    parser.add_argument("--skip-unit", action="store_true", help="Skip Python & Node unit suites")
    parser.add_argument(
        "--only-tier",
        default="",
        help="Comma-separated tiers to run (1,2,3,4), e.g. --only-tier 1 or --only-tier 1,4",
    )
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    url = normalize_url(args.url)
    out_dir = os.path.abspath(args.out_dir) if args.out_dir else tempfile.mkdtemp(prefix="fps_e2e_")
    repo_abs = os.path.abspath(REPO_ROOT)
    if out_dir == repo_abs or out_dir.startswith(repo_abs + os.sep):
        raise ValueError(f"--out-dir must be outside git working directory {repo_abs}, got {out_dir}")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(out_dir, "screenshots"), exist_ok=True)

    selected_tiers = {1, 2, 3, 4}
    if args.only_tier.strip():
        parsed = set()
        for tok in args.only_tier.split(","):
            tok = tok.strip()
            if tok not in {"1", "2", "3", "4"}:
                raise ValueError(f"Invalid tier '{tok}' in --only-tier (expected 1..4)")
            parsed.add(int(tok))
        selected_tiers = parsed

    report: dict[str, Any] = {
        "url": url,
        "out_dir": out_dir,
        "strict_visual": args.strict_visual,
        "selected_tiers": sorted(selected_tiers),
        "unit_suites": None,
        "tiers": {},
        "errors": {},
        "overall_passed": False,
    }

    overall_ok = True
    try:
        if not args.skip_unit:
            print("[UNIT] Running Python model tests and Node server/rig tests...")
            unit_res = run_unit_suites()
            report["unit_suites"] = unit_res
            for name, info in unit_res.items():
                status = "PASS" if info["passed"] else "FAIL"
                print(f"  - {name}: {status} (exit={info['exit_code']}, tests={info['tests_ran']}, {info['duration_s']}s)")
                if not info["passed"]:
                    overall_ok = False

        tracker = ErrorTracker()
        with sync_playwright() as p:
            browser, launcher_used = launch_browser(p)
            report["browser_launcher"] = launcher_used
            print(f"[BROWSER] Launched headless WebGL via {launcher_used}")
            try:
                if 1 in selected_tiers:
                    print("[TIER 1] Running feature coverage (Solo M416/Glock/AWM + LAN Dev-Solo)...")
                    try:
                        report["tiers"]["tier1"] = run_tier1(browser, url, tracker)
                        print("  -> Tier 1: PASS")
                    except Exception as exc:
                        report["tiers"]["tier1"] = {"passed": False, "error": str(exc)}
                        print(f"  -> Tier 1: FAIL ({exc})")
                        overall_ok = False

                if 2 in selected_tiers:
                    print("[TIER 2] Running boundary & corner cases (rapid switch, empty reload, crouch, laser, seam)...")
                    try:
                        report["tiers"]["tier2"] = run_tier2(browser, url, tracker, out_dir)
                        print("  -> Tier 2: PASS")
                    except Exception as exc:
                        report["tiers"]["tier2"] = {"passed": False, "error": str(exc)}
                        print(f"  -> Tier 2: FAIL ({exc})")
                        overall_ok = False

                if 3 in selected_tiers:
                    print("[TIER 3] Running cross-feature combinations (Solo combo + 2-tab LAN PvP)...")
                    try:
                        report["tiers"]["tier3"] = run_tier3(browser, url, tracker, out_dir)
                        print("  -> Tier 3: PASS")
                    except Exception as exc:
                        report["tiers"]["tier3"] = {"passed": False, "error": str(exc)}
                        print(f"  -> Tier 3: FAIL ({exc})")
                        overall_ok = False

                if 4 in selected_tiers:
                    print("[TIER 4] Running real-world poses, 1280x720 screenshots, visual telemetry & perf soak...")
                    try:
                        t4 = run_tier4(browser, url, tracker, out_dir, args.strict_visual)
                        report["tiers"]["tier4"] = t4
                        for k, v in t4["visual_telemetry"].items():
                            v_st = "PASS" if v["passed"] else "FAIL"
                            print(f"  - visual[{k}]: {v_st}")
                        print(f"  - perf_stability: PASS -> {t4['perf_stability']}")
                        print(f"  -> Tier 4: {'PASS' if t4['passed'] else 'FAIL (strict-visual)'}")
                        if not t4["passed"]:
                            overall_ok = False
                    except Exception as exc:
                        report["tiers"]["tier4"] = {"passed": False, "error": str(exc)}
                        print(f"  -> Tier 4: FAIL ({exc})")
                        overall_ok = False
            finally:
                browser.close()

        report["errors"] = tracker.snapshot()
        if any(report["errors"].values()):
            overall_ok = False
    finally:
        report["overall_passed"] = overall_ok
        report_path = os.path.join(out_dir, "report.json")
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, ensure_ascii=False)
        print(f"[REPORT] Written to {report_path}")

    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
