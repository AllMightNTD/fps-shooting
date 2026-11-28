#!/usr/bin/env python3
"""Headless Chrome WebGL E2E verification for:
1) Practice Hub -> Bot Setup (TDM & FFA, 3 difficulties, map thumbnails) & Survival navigation
2) Live Offline SWAT Bot Match (TDM & FFA) with soldier.glb animations
3) Spawn Protection blinking halo/body shader/HUD, Shield hitmarker, fire-cancel, Death Cam & Respawn Card
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent.parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from verify_swat_states_e2e import ErrorTracker, _launch_chrome  # noqa: E402


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_ready(page, url: str) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=35000)
    page.wait_for_function("() => window.__fpsReady === true", timeout=40000)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir",
        default=os.path.join(tempfile.gettempdir(), "fps_bots_protection_e2e"),
    )
    args = parser.parse_args()
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    port = _find_free_port()
    proc = subprocess.Popen(
        ["node", "server/index.js", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(1.0)

    tracker = ErrorTracker()
    report: dict[str, Any] = {"port": port, "out_dir": out_dir}
    try:
        base_url = f"http://127.0.0.1:{port}/FPS.html"
        with sync_playwright() as p:
            browser, launcher_used = _launch_chrome(p)
            report["launcher"] = launcher_used
            ctx = browser.new_context(viewport={"width": 1280, "height": 720})
            page = ctx.new_page()
            tracker.attach(page, "main")

            _wait_ready(page, base_url)
            tracker.assert_clean("lobby_ready")

            # 1. Verify Practice Hub & Bot Setup + Survival UI Flow & Animations
            page.click("#btnModePractice")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyPracticeView')).opacity === '1' && window.__fpsApp.lobby.getState().activeView === 'practice'",
                timeout=8000,
            )
            practice_cards = page.evaluate(
                """() => ({
                  hasBotsCard: !!document.getElementById('btnPracticeBots'),
                  hasSurvivalCard: !!document.getElementById('btnPracticeSurvival'),
                  view: window.__fpsApp.lobby.getState().activeView,
                })"""
            )
            assert practice_cards["hasBotsCard"] and practice_cards["hasSurvivalCard"]

            # Visit Survival view & go back to Practice
            page.click("#btnPracticeSurvival")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbySurvivalView')).opacity === '1' && window.__fpsApp.lobby.getState().activeView === 'survival'",
                timeout=8000,
            )
            assert page.evaluate("() => !!document.getElementById('btnSoloMode')")
            page.click("#btnSurvivalBack")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyPracticeView')).opacity === '1'",
                timeout=8000,
            )

            # Enter Bot Setup View -> inspect TDM/FFA, Quick Settings & Maps
            page.click("#btnPracticeBots")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyBotView')).opacity === '1' && window.__fpsApp.lobby.getState().activeView === 'bot'",
                timeout=8000,
            )
            tdm_summary = page.text_content("#botTeamSummary") or ""
            assert "3v3" in tdm_summary, f"Unexpected default TDM summary: {tdm_summary}"

            # Test FFA toggle & revert to TDM + Hard difficulty
            page.click("#btnBotModeFFA")
            page.wait_for_timeout(120)
            ffa_summary = page.text_content("#botTeamSummary") or ""
            assert "5 Bot" in ffa_summary, f"Unexpected FFA summary: {ffa_summary}"
            page.click("#btnBotModeTDM")
            page.click("[data-bot-diff='hard']")
            page.select_option("#botKillsSelect", "15")
            page.screenshot(path=os.path.join(out_dir, "01_lobby_bot_setup.png"), animations="disabled")
            report["lobby_flow"] = {
                "tdm_summary": tdm_summary,
                "ffa_summary": ffa_summary,
                "state": page.evaluate("() => window.__fpsApp.lobby.getState()"),
            }

            # 2. Launch TDM Bot Match
            page.click("#btnBotStart")
            page.wait_for_function(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  return st.engineMode === 'bots' && st.activeState === 'play' && st.getRemotePlayers().size === 5;
                }""",
                timeout=12000,
            )

            # Wait briefly for SWAT soldier.glb rigs to finish attaching
            page.wait_for_function(
                """() => {
                  const remotes = Array.from(window.__fpsApp.game.getState().getRemotePlayers().values());
                  return remotes.length === 5 && remotes.every((r) => r.rig && r.rig.isSkinned && r.shieldDome && r.shieldBaseRing);
                }""",
                timeout=10000,
            )

            # Check initial Spawn Protection + iFrames + #spawnProtectBar + #shieldVignette
            page.wait_for_function(
                """() => {
                  const bar = document.getElementById('spawnProtectBar');
                  const vig = document.getElementById('shieldVignette');
                  return bar && getComputedStyle(bar).display !== 'none' && vig && parseFloat(getComputedStyle(vig).opacity || '0') > 0;
                }""",
                timeout=4000,
            )
            spawn_check = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const me = st.getMe();
                  const bar = document.getElementById('spawnProtectBar');
                  const vig = document.getElementById('shieldVignette');
                  return {
                    meInvuln: me.meInvuln,
                    prot: me.meProtState,
                    barVisible: bar ? getComputedStyle(bar).display !== 'none' : false,
                    vigOpacity: vig ? parseFloat(getComputedStyle(vig).opacity || '0') : 0,
                    barText: document.getElementById('spawnProtectText')?.textContent || '',
                  };
                }"""
            )
            assert spawn_check["meInvuln"] is True
            assert spawn_check["prot"]["active"] is True and spawn_check["prot"]["iFrames"] is True
            assert spawn_check["barVisible"] is True and spawn_check["vigOpacity"] > 0, f"Spawn check failed: {spawn_check}"
            report["tdm_spawn_protection"] = spawn_check

            # Position an enemy SWAT bot directly in front of camera while shielded to observe blinking halo & shoot it
            shield_probe = page.evaluate(
                """() => {
                  const app = window.__fpsApp.game;
                  const st = app.getState();
                  const match = st.getBotMatch();
                  const human = match.getHuman();
                  const now = performance.now();
                  // Keep both human & first enemy bot inside fresh spawn zone
                  Object.assign(human, {
                    alive: true, hp: 100, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0,
                    spawnOrigin: { x: 0, y: 0, z: 0 },
                    invulnerableUntil: now + 3000,
                    iFramesUntil: now + 400,
                  });
                  st.setPose(0, 0, 0, 0, 0);
                  const enemy = Array.from(match.players.values()).find((p) => p.isBot && p.team === 'B');
                  Object.assign(enemy, {
                    alive: true, hp: 100, x: 0, y: 0, z: -4.2, yaw: Math.PI, pitch: 0, flags: 0,
                    spawnOrigin: { x: 0, y: 0, z: -4.2 },
                    invulnerableUntil: now + 3000,
                    iFramesUntil: now + 400,
                  });
                  return { enemyId: enemy.id };
                }"""
            )
            # Sample blink state across frames so we see shieldDome + shieldBaseRing visible & cyan blinking
            page.wait_for_function(
                f"""() => {{
                  const av = window.__fpsApp.game.getState().getRemotePlayers().get({json.dumps(shield_probe["enemyId"])});
                  return av && av.shieldDome && av.shieldDome.visible === true && av.shieldBaseRing && av.shieldBaseRing.visible === true;
                }}""",
                timeout=4000,
            )
            page.wait_for_timeout(120)
            page.screenshot(path=os.path.join(out_dir, "02_tdm_bot_shield_blink.png"))

            # Fire at shielded enemy SWAT bot in the same tick (zero movement drift) -> human protection cancels, enemy takes 0 dmg + hmShield triggers!
            page.evaluate(
                f"""() => {{
                  const st = window.__fpsApp.game.getState();
                  const match = st.getBotMatch();
                  const enemy = match.players.get({json.dumps(shield_probe["enemyId"])});
                  const now = performance.now();
                  Object.assign(enemy, {{
                    alive: true, hp: 100, x: 0, y: 0, z: -3.0, yaw: Math.PI, pitch: 0, flags: 0,
                    spawnOrigin: {{ x: 0, y: 0, z: -3.0 }},
                    invulnerableUntil: now + 3000,
                    iFramesUntil: now + 400,
                  }});
                  st.setTestCombat({{ locked: true }});
                  st.setPose(0, 0, 0, 0, -0.16);
                  window.__fpsApp.game.shoot();
                }}"""
            )
            page.wait_for_function(
                "() => document.getElementById('hm').classList.contains('hmShield')",
                timeout=3000,
            )
            post_shield_shot = page.evaluate(
                f"""() => {{
                  const st = window.__fpsApp.game.getState();
                  const me = st.getMe();
                  const match = st.getBotMatch();
                  const enemy = match.players.get({json.dumps(shield_probe["enemyId"])});
                  const hm = document.getElementById('hm');
                  const bar = document.getElementById('spawnProtectBar');
                  return {{
                    humanProtActive: me.meProtState.active,
                    humanInvuln: me.meInvuln,
                    barVisible: bar ? getComputedStyle(bar).display !== 'none' : false,
                    enemyHp: enemy.hp,
                    hmShieldClass: hm.classList.contains('hmShield'),
                  }};
                }}"""
            )
            assert post_shield_shot["humanProtActive"] is False, f"Human shield failed to cancel on fire: {post_shield_shot}"
            assert post_shield_shot["enemyHp"] == 100, f"Protected enemy took damage: {post_shield_shot}"
            assert post_shield_shot["hmShieldClass"] is True, f"Shield hitmarker class missing: {post_shield_shot}"
            report["shield_shot_behavior"] = post_shield_shot

            # Clear enemy protection, shoot again in same tick -> kills enemy!
            page.wait_for_timeout(140)
            page.evaluate(
                f"""() => {{
                  const st = window.__fpsApp.game.getState();
                  const match = st.getBotMatch();
                  const enemy = match.players.get({json.dumps(shield_probe["enemyId"])});
                  enemy.invulnerableUntil = 0;
                  enemy.iFramesUntil = 0;
                  enemy.hp = 25;
                  Object.assign(enemy, {{ alive: true, x: 0, y: 0, z: -3.0, yaw: Math.PI, pitch: 0, flags: 0 }});
                  st.setPose(0, 0, 0, 0, -0.16);
                  window.__fpsApp.game.shoot();
                }}"""
            )
            page.wait_for_function(
                f"""() => {{
                  const enemy = window.__fpsApp.game.getState().getBotMatch().players.get({json.dumps(shield_probe["enemyId"])});
                  return enemy && enemy.alive === false && window.__fpsApp.game.getState().getBotMatch().getHuman().kills >= 1;
                }}""",
                timeout=4000,
            )

            # Simulate human getting eliminated -> verify Death Cam / Respawn Card -> automatic Respawn with fresh protection
            page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const match = st.getBotMatch();
                  const human = match.getHuman();
                  const killer = Array.from(match.players.values()).find((p) => p.isBot && p.team === 'B' && p.alive) || Array.from(match.players.values()).find((p) => p.isBot && p.team === 'B');
                  Object.assign(killer, { alive: true, hp: 82, x: 0, y: 0, z: -6, yaw: Math.PI, pitch: 0, flags: 0, activeWeaponId: 'm416', invulnerableUntil: 0, iFramesUntil: 0, targetId: human.id, targetSeenAt: 0, burstPauseUntil: 0 });
                  if (killer.weapons && killer.weapons.m416) {
                    killer.weapons.m416.mag = 30;
                    killer.weapons.m416.reloadEndsAt = 0;
                    killer.weapons.m416.equipEndsAt = 0;
                  }
                  Object.assign(human, { alive: true, hp: 10, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, invulnerableUntil: 0, iFramesUntil: 0 });
                  st.setPose(0, 0, 0, 0, 0);
                  match.syncHumanState({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, flags: 0 });
                }"""
            )
            # Let bot spot & eliminate 10-HP human cleanly inside live step loop (hard difficulty reaction ~145ms)
            t0 = time.time()
            try:
                page.wait_for_function(
                    "() => { const st = window.__fpsApp.game.getState().getMe(); return st.meAlive === false && getComputedStyle(document.getElementById('respawnBanner')).display !== 'none'; }",
                    timeout=6000,
                )
            except Exception as exc:
                diag = page.evaluate(
                    """() => {
                      const st = window.__fpsApp.game.getState();
                      const m = st.getBotMatch();
                      const h = m.getHuman();
                      const banner = document.getElementById('respawnBanner');
                      return {
                        engineMode: st.engineMode,
                        activeState: st.activeState,
                        me: st.getMe(),
                        human: { alive: h.alive, hp: h.hp, x: h.x, z: h.z, inv: h.invulnerableUntil },
                        bannerDisplay: banner ? getComputedStyle(banner).display : null,
                        botsB: Array.from(m.players.values()).filter(b => b.team === 'B').map(b => ({ id: b.id, alive: b.alive, x: b.x, z: b.z, mag: b.weapons[b.activeWeaponId].mag })),
                      };
                    }"""
                )
                raise RuntimeError(f"Death wait failed: {exc} | diag={json.dumps(diag)}") from exc
            t1 = time.time()
            death_ui = page.evaluate(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const me = st.getMe();
                  const h = st.getBotMatch().getHuman();
                  const banner = document.getElementById('respawnBanner');
                  return {
                    meAlive: me.meAlive,
                    humanAlive: h.alive,
                    respawnAt: h.respawnAt,
                    nowMs: performance.now(),
                    bannerVisible: banner ? getComputedStyle(banner).display !== 'none' : false,
                    bannerDisplay: banner ? getComputedStyle(banner).display : '',
                    meta: document.getElementById('respawnKillerMeta')?.textContent || '',
                    hp: document.getElementById('respawnKillerHp')?.textContent || '',
                    timer: document.getElementById('respawnTimerText')?.textContent || '',
                    respawnMs: me.respawnMs,
                  };
                }"""
            )
            t2 = time.time()
            assert death_ui["bannerVisible"] is True and death_ui["respawnMs"] > 0 and "BỊ HẠ" in death_ui["meta"], (
                f"Death UI unexpected (wait={t1-t0:.2f}s eval={t2-t1:.2f}s): {death_ui}"
            )
            page.screenshot(path=os.path.join(out_dir, "03_tdm_death_respawn_card.png"), animations="disabled")
            report["death_respawn_card"] = death_ui

            # Wait for 3.5s TDM respawn -> confirm fresh alive + fresh iFrames + shield restored
            page.wait_for_function(
                "() => window.__fpsApp.game.getState().getMe().meAlive === true",
                timeout=7000,
            )
            respawned_state = page.evaluate(
                """() => {
                  const me = window.__fpsApp.game.getState().getMe();
                  return {
                    meAlive: me.meAlive,
                    hp: me.hp,
                    meInvuln: me.meInvuln,
                    protActive: me.meProtState.active,
                  };
                }"""
            )
            assert respawned_state["meAlive"] is True and respawned_state["hp"] == 100 and respawned_state["protActive"] is True
            report["tdm_respawned_state"] = respawned_state

            # 3. Also test FFA Bot Match Launch cleanly via real Lobby UI
            _wait_ready(page, base_url)
            page.click("#btnModePractice")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyPracticeView')).opacity === '1'",
                timeout=8000,
            )
            page.click("#btnPracticeBots")
            page.wait_for_function(
                "() => getComputedStyle(document.getElementById('lobbyBotView')).opacity === '1'",
                timeout=8000,
            )
            page.click("#btnBotModeFFA")
            page.click("#btnBotStart")
            page.wait_for_function(
                """() => {
                  const st = window.__fpsApp.game.getState();
                  const m = st.getBotMatch();
                  return st.engineMode === 'bots' && m && m.config.mode === 'FFA' && st.getRemotePlayers().size === 5;
                }""",
                timeout=10000,
            )
            ffa_info = page.evaluate(
                """() => {
                  const m = window.__fpsApp.game.getState().getBotMatch();
                  const me = window.__fpsApp.game.getState().getMe();
                  return {
                    mode: m.config.mode,
                    protectMs: m.modeRule.protectMs,
                    respawnMs: m.modeRule.respawnDelayMs,
                    totalMs: me.meProtState.totalMs,
                    enemies: Array.from(m.players.values()).filter((p) => p.isBot).length,
                  };
                }"""
            )
            assert ffa_info["mode"] == "FFA" and ffa_info["protectMs"] == 2000 and ffa_info["respawnMs"] == 2000
            page.screenshot(path=os.path.join(out_dir, "04_ffa_bots_match.png"))
            report["ffa_bot_match"] = ffa_info

            tracker.assert_clean("e2e_complete")
            report["errors_clean"] = True
            ctx.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except Exception:
            proc.kill()
        if tracker.console_errors or tracker.pageerrors or tracker.http_errors or tracker.request_failed:
            print("TRACKER ERRORS:", json.dumps({
                "console_errors": tracker.console_errors,
                "pageerrors": tracker.pageerrors,
                "http_errors": tracker.http_errors,
                "request_failed": tracker.request_failed,
            }, indent=2, ensure_ascii=False), file=sys.stderr)

    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
