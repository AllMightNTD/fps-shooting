/**
 * Offline Tactical SWAT Bot Match Engine (TDM & FFA)
 * - Uses shared authoritative combat, hitbox, spawn & protection modules:
 *   weapons.js, hitreg.js, spawn_rules.js
 * - Reuses 6-clip SWAT animations (idle, run, crouch, jump, prone, prone_move)
 *   and all 3 weapons (M416, Glock-17, AWM Sniper) with 3 difficulty tiers.
 * - Pure JS (Zero DOM/Three dependency) so both Browser GameEngine and Node tests run it directly.
 */

import { forwardFromYawPitch, getEyeHeight, resolveAuthoritativeShot } from "./hitreg.js";
import {
  PLAYER_RADIUS,
  SPAWN_RULES,
  activateSpawnProtection,
  cancelProtectionOnFire,
  clampAndResolvePlayerPos,
  createSpawnTracker,
  evaluateProtectionTick,
  getSpawnRuleForMode,
  hasLineOfSight,
  isPlayerProtected,
  isPointClear,
  pickSmartFfaSpawn,
  pickSmartTeamSpawn,
  raycastArenaDistance,
} from "./spawn_rules.js";

export const BOT_DIFFICULTY_PRESETS = Object.freeze({
  easy: Object.freeze({
    id: "easy",
    label: "Dễ",
    reactionMs: 520,
    aimSpreadRad: 0.088,
    aimTrackSpeed: 4.5,
    burstMin: 2,
    burstMax: 4,
    burstPauseMs: 560,
    evadeChance: 0.22,
    proneChance: 0.1,
    jumpChance: 0.08,
    respectProtectChance: 0.15,
    fovHalfRad: Math.PI * 0.42,
    sightRange: 54,
  }),
  medium: Object.freeze({
    id: "medium",
    label: "Trung bình",
    reactionMs: 280,
    aimSpreadRad: 0.044,
    aimTrackSpeed: 7.5,
    burstMin: 3,
    burstMax: 6,
    burstPauseMs: 320,
    evadeChance: 0.5,
    proneChance: 0.24,
    jumpChance: 0.2,
    respectProtectChance: 0.65,
    fovHalfRad: Math.PI * 0.5,
    sightRange: 72,
  }),
  hard: Object.freeze({
    id: "hard",
    label: "Khó",
    reactionMs: 145,
    aimSpreadRad: 0.018,
    aimTrackSpeed: 12.5,
    burstMin: 4,
    burstMax: 9,
    burstPauseMs: 185,
    evadeChance: 0.78,
    proneChance: 0.36,
    jumpChance: 0.34,
    respectProtectChance: 0.96,
    fovHalfRad: Math.PI * 0.58,
    sightRange: 92,
  }),
});

const BOT_CALLSIGNS = Object.freeze([
  "Viper_AI",
  "Kestrel_AI",
  "Titan_AI",
  "Spectre_AI",
  "Bastion_AI",
  "Falcon_AI",
  "Raven_AI",
  "Nomad_AI",
  "Ajax_AI",
  "Valkyrie_AI",
  "Lynx_AI",
  "Phantom_AI",
  "Reaper_AI",
  "Atlas_AI",
  "Orion_AI",
  "Apex_AI",
  "Warden_AI",
]);

const DEFAULT_WAYPOINT_SEEDS = Object.freeze([
  [-22, 0],
  [22, 0],
  [-8, -14],
  [8, 14],
  [-14, -26],
  [14, 26],
  [0, -18],
  [0, 18],
  [-28, -22],
  [28, 22],
  [-28, 22],
  [28, -22],
  [0, -32],
  [0, 32],
  [-12, 0],
  [14, -9],
]);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function wrapAngle(a) {
  let d = (a + Math.PI) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d - Math.PI;
}

function stepAngleToward(cur, target, maxStep) {
  const diff = wrapAngle(target - cur);
  if (Math.abs(diff) <= maxStep) return target;
  return wrapAngle(cur + Math.sign(diff) * maxStep);
}

export function normalizeBotConfig(raw = {}) {
  const mode = raw.mode === "FFA" ? "FFA" : "TDM";
  const mapId = raw.mapId === "harbor" ? "harbor" : "military";
  const difficulty = BOT_DIFFICULTY_PRESETS[raw.difficulty] ? raw.difficulty : "medium";
  const rawCount = Number(raw.botCount);
  let botCount = Number.isFinite(rawCount) ? Math.round(rawCount) : 15;
  botCount = clamp(botCount, 1, 17);
  if (mode === "TDM" && botCount % 2 === 0) {
    // Odd botCount pairs cleanly with 1 human -> balanced NvN teams (e.g. 9 bots = 5v5, 15 bots = 8v8, 17 bots = 9v9)
    botCount = botCount < 17 ? botCount + 1 : 15;
  }
  const rawKillLimit = Number(raw.killLimit);
  const killLimit = Number.isFinite(rawKillLimit) ? clamp(Math.round(rawKillLimit), 5, 100) : mode === "TDM" ? 30 : 20;
  const rawTime = Number(raw.timeLimitSec);
  const timeLimitSec = Number.isFinite(rawTime) ? clamp(Math.round(rawTime), 60, 1200) : 600;
  return { mode, mapId, difficulty, botCount, killLimit, timeLimitSec };
}

export function buildArenaWaypoints(arena) {
  const pts = [];
  const seen = new Set();
  const tryAdd = (x, z) => {
    const rx = Math.round(x * 2) / 2;
    const rz = Math.round(z * 2) / 2;
    const key = `${rx},${rz}`;
    if (seen.has(key)) return;
    if (isPointClear(rx, rz, arena, 0.72)) {
      seen.add(key);
      pts.push({ x: rx, y: 0, z: rz });
    }
  };
  const sp = arena && arena.spawns ? arena.spawns : {};
  for (const list of [sp.A, sp.B, sp.FFA]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) tryAdd(p.x, p.z);
    }
  }
  for (const [x, z] of DEFAULT_WAYPOINT_SEEDS) tryAdd(x, z);
  if (pts.length === 0) pts.push({ x: 0, y: 0, z: 0 });
  return pts;
}

function assignBotPrimaryRole(idx) {
  const mod = idx % 6;
  if (mod === 2) return "sniper";
  if (mod === 5) return "pistol";
  return "m416";
}

export function createBotMatchController({
  arena,
  config = {},
  weaponsApi,
  humanId = "human-local",
  humanName = "Bạn",
  nowFn = () => performance.now(),
  rngFn = Math.random,
  callbacks = {},
} = {}) {
  const {
    BASE_MOVE_SPEED,
    FLAG,
    WEAPONS,
    computeWeaponDamage,
    computeWeaponSpread,
    createDefaultWeaponsState,
    getMoveSpeedMultiplier,
    getReloadDurationMs,
    resolveWeaponConfig,
  } = weaponsApi;
  const cfg = normalizeBotConfig(config);
  const preset = BOT_DIFFICULTY_PRESETS[cfg.difficulty];
  const modeRule = getSpawnRuleForMode(cfg.mode);
  const safeArena = arena || { bounds: { minX: -35, maxX: 35, minZ: -45, maxZ: 45 }, boxes: [], obbs: [], spawns: { A: [], B: [], FFA: [] } };
  const waypoints = buildArenaWaypoints(safeArena);
  const spawnTracker = createSpawnTracker();

  let now = nowFn();
  let matchEndsAt = now + cfg.timeLimitSec * 1000;
  let ended = false;
  let winner = null;
  let teamScores = { A: 0, B: 0 };
  const players = new Map();

  const human = {
    id: humanId,
    name: humanName || "Bạn",
    isBot: false,
    team: cfg.mode === "TDM" ? "A" : "FFA",
    alive: true,
    hp: 100,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    mv: 0,
    flags: 0,
    ads: false,
    laser: true,
    activeWeaponId: "m416",
    weapons: createDefaultWeaponsState(),
    kills: 0,
    deaths: 0,
    headshots: 0,
    respawnAt: 0,
    spawnEpoch: 0,
    spawnedAt: 0,
    iFramesUntil: 0,
    invulnerableUntil: 0,
    spawnOrigin: null,
    adsProtectStartAt: 0,
    lastDeathPos: null,
    lastSpawnReason: "normal",
    lastKillerInfo: null,
  };
  players.set(human.id, human);

  function pickBotSpawnPoint(actor, tNow) {
    if (cfg.mode === "TDM") {
      return pickSmartTeamSpawn(safeArena, actor.team, players, actor.id, tNow, spawnTracker);
    }
    return pickSmartFfaSpawn(safeArena, players, actor.id, tNow, spawnTracker, actor);
  }

  function spawnActor(actor, tNow, notify = false) {
    const sp = pickBotSpawnPoint(actor, tNow);
    actor.x = sp.x;
    actor.y = sp.y || 0;
    actor.z = sp.z;
    actor.yaw = Number.isFinite(sp.yaw) ? sp.yaw : 0;
    actor.pitch = 0;
    actor.mv = 0;
    actor.vy = 0;
    actor.grounded = true;
    actor.flags = 0;
    actor.ads = false;
    actor.hp = 100;
    actor.alive = true;
    actor.respawnAt = 0;
    actor.lastSpawnReason = sp.reason || "normal";
    actor.weapons = createDefaultWeaponsState();
    actor.activeWeaponId = actor.isBot ? actor.preferredWeaponId : actor.activeWeaponId || "m416";
    activateSpawnProtection(actor, cfg.mode, sp, tNow);

    if (actor.isBot) {
      actor.targetId = null;
      actor.targetSeenAt = 0;
      actor.lastSeenPos = null;
      actor.burstRemaining = 0;
      actor.burstCooldownUntil = tNow + 250;
      actor.pauseUntil = 0;
      actor.crouchUntil = 0;
      actor.proneUntil = 0;
      actor.jumpUntil = 0;
      actor.stuckAccum = 0;
      actor.strafeDir = rngFn() < 0.5 ? -1 : 1;
      actor.strafeSwitchAt = tNow + 1200 + rngFn() * 1400;
      actor.waypoint = waypoints[(rngFn() * waypoints.length) | 0];
    }

    if (notify && typeof callbacks.onEventRespawn === "function") {
      callbacks.onEventRespawn({
        playerId: actor.id,
        pos: { x: actor.x, y: actor.y, z: actor.z },
        yaw: actor.yaw,
        team: actor.team,
        weaponId: actor.activeWeaponId,
        invulnerableMs: modeRule.protectMs,
        iFramesMs: modeRule.iFramesMs,
        reason: actor.lastSpawnReason,
      });
    }
    return sp;
  }

  // Spawn Human + create & spawn Bots
  spawnActor(human, now, false);

  const botTeamList = [];
  if (cfg.mode === "TDM") {
    const totalEachSide = (cfg.botCount + 1) / 2;
    const alliesCount = Math.max(0, totalEachSide - 1);
    const enemiesCount = cfg.botCount - alliesCount;
    for (let i = 0; i < alliesCount; i++) botTeamList.push("A");
    for (let i = 0; i < enemiesCount; i++) botTeamList.push("B");
  } else {
    for (let i = 0; i < cfg.botCount; i++) botTeamList.push("FFA");
  }

  for (let i = 0; i < botTeamList.length; i++) {
    const team = botTeamList[i];
    const roleW = assignBotPrimaryRole(i);
    const bot = {
      id: `bot-${i + 1}`,
      name: BOT_CALLSIGNS[i % BOT_CALLSIGNS.length],
      isBot: true,
      team,
      preferredWeaponId: roleW,
      activeWeaponId: roleW,
      weapons: createDefaultWeaponsState(),
      alive: false,
      hp: 100,
      x: 0,
      y: 0,
      z: 0,
      vy: 0,
      grounded: true,
      yaw: 0,
      pitch: 0,
      mv: 0,
      flags: 0,
      ads: false,
      laser: false,
      kills: 0,
      deaths: 0,
      headshots: 0,
      respawnAt: 0,
      spawnEpoch: 0,
      spawnedAt: 0,
      iFramesUntil: 0,
      invulnerableUntil: 0,
      spawnOrigin: null,
      adsProtectStartAt: 0,
      lastDeathPos: null,
      lastSpawnReason: "normal",
      targetId: null,
      targetSeenAt: 0,
      lastSeenPos: null,
      burstRemaining: 0,
      burstCooldownUntil: now,
      pauseUntil: 0,
      crouchUntil: 0,
      proneUntil: 0,
      jumpUntil: 0,
      stuckAccum: 0,
      strafeDir: 1,
      strafeSwitchAt: now,
      waypoint: waypoints[0],
      nextLosCheckAt: now + i * 40,
      nextActiveLosAt: now + i * 25,
      cachedTargetVisible: false,
      nextWhiskerAt: now + i * 20,
      cachedSteerOffset: 0,
    };
    players.set(bot.id, bot);
    spawnActor(bot, now, false);
  }

  function finishMatch(winLabel, tNow) {
    if (ended) return;
    ended = true;
    winner = winLabel;
    if (typeof callbacks.onMatchEnd === "function") {
      callbacks.onMatchEnd({
        winner,
        mode: cfg.mode,
        teamScores: { ...teamScores },
        killLimit: cfg.killLimit,
        scoreboard: getScoreboard(),
        endedAt: tNow,
      });
    }
  }

  function getScoreboard() {
    return Array.from(players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        isBot: p.isBot,
        kills: p.kills,
        deaths: p.deaths,
        headshots: p.headshots,
        alive: p.alive,
      }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.headshots - a.headshots);
  }

  function canDamage(shooter, victim) {
    if (!shooter || !victim || shooter.id === victim.id) return false;
    if (cfg.mode === "TDM" && shooter.team === victim.team) return false;
    return true;
  }

  function applyKillOutcome(killer, victim, weaponCfg, part, tNow) {
    victim.alive = false;
    victim.lastDeathPos = { x: victim.x, y: victim.y, z: victim.z };
    victim.flags = 0;
    victim.ads = false;
    victim.iFramesUntil = 0;
    victim.invulnerableUntil = 0;
    victim.adsProtectStartAt = 0;
    victim.deaths++;
    victim.respawnAt = tNow + modeRule.respawnDelayMs;
    victim.lastKillerInfo = {
      killerId: killer.id,
      killer: killer.name,
      killerHp: Math.max(0, Math.round(killer.hp)),
      weapon: weaponCfg.name,
      head: part === "head",
      killerPos: { x: killer.x, y: killer.y, z: killer.z },
    };

    killer.kills++;
    if (part === "head") killer.headshots++;
    if (cfg.mode === "TDM") {
      teamScores[killer.team] = (teamScores[killer.team] || 0) + 1;
    }

    if (typeof callbacks.onEventKill === "function") {
      callbacks.onEventKill({
        killerId: killer.id,
        killer: killer.name,
        killerTeam: killer.team,
        killerHp: Math.max(0, Math.round(killer.hp)),
        killerPos: { x: killer.x, y: killer.y, z: killer.z },
        victimId: victim.id,
        victim: victim.name,
        victimTeam: victim.team,
        weapon: weaponCfg.name,
        weaponId: weaponCfg.id,
        head: part === "head",
        respawnMs: modeRule.respawnDelayMs,
      });
    }

    if (cfg.mode === "TDM" && teamScores[killer.team] >= cfg.killLimit) {
      finishMatch(killer.team, tNow);
    } else if (cfg.mode === "FFA" && killer.kills >= cfg.killLimit) {
      finishMatch(killer.name, tNow);
    }
  }

  function resolveShotCommon(shooter, weaponCfg, origin, dir, tNow) {
    if (ended || !shooter || !shooter.alive) return { hit: false };
    cancelProtectionOnFire(shooter);

    const targets = [];
    for (const v of players.values()) {
      if (!v.alive || !canDamage(shooter, v)) continue;
      targets.push({
        id: v.id,
        x: v.x,
        y: v.y,
        z: v.z,
        yaw: v.yaw,
        flags: v.flags || 0,
        alive: true,
      });
    }

    const res = resolveAuthoritativeShot({
      shooterId: shooter.id,
      weaponCfg,
      origin,
      dir,
      arena: safeArena,
      targets,
    });

    if (!res.hit || !res.targetId) {
      return { hit: false, wallDist: res.wallDist };
    }

    const victim = players.get(res.targetId);
    if (!victim || !victim.alive) return { hit: false, wallDist: res.wallDist };

    const prot = evaluateProtectionTick(victim, cfg.mode, tNow);
    if (prot.active || isPlayerProtected(victim, tNow)) {
      if (typeof callbacks.onEventHit === "function") {
        callbacks.onEventHit({
          shooterId: shooter.id,
          targetId: victim.id,
          part: "shield",
          damage: 0,
          hp: victim.hp,
          weaponId: weaponCfg.id,
          dist: Number(res.dist.toFixed(1)),
          hitPoint: res.hitPoint,
          iFrames: prot.iFrames,
        });
      }
      return {
        hit: true,
        shielded: true,
        iFrames: prot.iFrames,
        targetId: victim.id,
        part: "shield",
        damage: 0,
        hp: victim.hp,
        hitPoint: res.hitPoint,
        dist: res.dist,
      };
    }

    const damage = computeWeaponDamage(weaponCfg, res.part, res.dist);
    if (damage > 0) {
      victim.hp = Math.max(0, victim.hp - damage);
      if (typeof callbacks.onEventHit === "function") {
        callbacks.onEventHit({
          shooterId: shooter.id,
          targetId: victim.id,
          part: res.part,
          damage,
          hp: victim.hp,
          weaponId: weaponCfg.id,
          dist: Number(res.dist.toFixed(1)),
          hitPoint: res.hitPoint,
        });
      }

      if (victim.isBot && victim.hp > 0 && rngFn() < preset.evadeChance) {
        if (victim.hp <= 40 && rngFn() < preset.proneChance) {
          victim.proneUntil = tNow + 1100;
          victim.crouchUntil = 0;
        } else {
          victim.crouchUntil = Math.max(victim.crouchUntil || 0, tNow + 700);
        }
        if (!victim.targetId) {
          victim.targetId = shooter.id;
          victim.lastSeenPos = { x: shooter.x, y: shooter.y, z: shooter.z };
          victim.targetSeenAt = tNow - preset.reactionMs;
        }
      }

      if (victim.hp <= 0) {
        applyKillOutcome(shooter, victim, weaponCfg, res.part, tNow);
      }
    }

    return {
      hit: true,
      shielded: false,
      targetId: victim.id,
      part: res.part,
      damage,
      hp: victim.hp,
      hitPoint: res.hitPoint,
      dist: res.dist,
    };
  }

  function syncHumanState({ pos, yaw, pitch, flags, activeWeaponId } = {}, tNow = nowFn()) {
    now = tNow;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
      human.x = pos.x;
      human.y = pos.y;
      human.z = pos.z;
    }
    if (Number.isFinite(yaw)) human.yaw = yaw;
    if (Number.isFinite(pitch)) human.pitch = pitch;
    if (Number.isInteger(flags)) {
      human.flags = flags & 0x7f;
      human.ads = Boolean(human.flags & FLAG.ADS);
    }
    if (activeWeaponId && WEAPONS[activeWeaponId]) {
      human.activeWeaponId = activeWeaponId;
    }
    return evaluateProtectionTick(human, cfg.mode, now);
  }

  function handleHumanFire(weaponId, origin, dir, tNow = nowFn()) {
    now = tNow;
    const weaponCfg = resolveWeaponConfig(weaponId);
    return resolveShotCommon(human, weaponCfg, origin, dir, now);
  }

  function tickBotWeapon(bot, tNow) {
    const w = bot.weapons[bot.activeWeaponId];
    if (!w) return;
    if (w.reloadEndsAt > 0 && tNow >= w.reloadEndsAt) {
      const wc = resolveWeaponConfig(w.id);
      w.mag = wc.magSize;
      w.reloadEndsAt = 0;
      bot.flags &= ~FLAG.RELOADING;
    }
  }

  function startBotReload(bot, tNow) {
    const w = bot.weapons[bot.activeWeaponId];
    const wc = resolveWeaponConfig(bot.activeWeaponId);
    if (!w || w.reloadEndsAt > 0 || w.mag >= wc.magSize) return;
    const dur = getReloadDurationMs(wc, w.mag);
    w.reloadEndsAt = tNow + dur;
    bot.flags = (bot.flags | FLAG.RELOADING) & ~FLAG.ADS;
    if (typeof callbacks.onEventReload === "function") {
      callbacks.onEventReload({ playerId: bot.id, id: w.id, dur });
    }
  }

  function switchBotWeapon(bot, targetWeaponId, tNow) {
    if (!WEAPONS[targetWeaponId] || bot.activeWeaponId === targetWeaponId) return;
    const curW = bot.weapons[bot.activeWeaponId];
    if (curW) curW.reloadEndsAt = 0;
    bot.flags &= ~(FLAG.RELOADING | FLAG.ADS);
    bot.activeWeaponId = targetWeaponId;
    const nextCfg = resolveWeaponConfig(targetWeaponId);
    bot.weapons[targetWeaponId].equipEndsAt = tNow + (nextCfg.equipTimeMs || 240);
    if (typeof callbacks.onEventSwitchWeapon === "function") {
      callbacks.onEventSwitchWeapon({ playerId: bot.id, weaponId: targetWeaponId });
    }
  }

  function findBestVisibleEnemy(bot, tNow) {
    const eyeY = (bot.y || 0) + getEyeHeight(bot.flags);
    let best = null;
    let bestDist = Infinity;
    const fx = -Math.sin(bot.yaw);
    const fz = -Math.cos(bot.yaw);

    for (const enemy of players.values()) {
      if (!enemy.alive || !canDamage(bot, enemy)) continue;
      const dx = enemy.x - bot.x;
      const dz = enemy.z - bot.z;
      const d = Math.hypot(dx, dz);
      if (d > preset.sightRange) continue;
      if (d > 2.5) {
        const dot = (dx * fx + dz * fz) / d;
        const cosHalf = Math.cos(preset.fovHalfRad);
        if (dot < cosHalf && d > 7.5 && enemy.id !== bot.targetId) continue;
      }
      const targetEyeY = (enemy.y || 0) + getEyeHeight(enemy.flags || 0) - 0.14;
      if (!hasLineOfSight(bot.x, eyeY, bot.z, enemy.x, targetEyeY, enemy.z, safeArena)) {
        continue;
      }
      if (d < bestDist) {
        bestDist = d;
        best = { enemy, dist: d };
      }
    }
    return best;
  }

  function pickNextWaypoint(bot) {
    let chosen = waypoints[(rngFn() * waypoints.length) | 0];
    for (let attempt = 0; attempt < 4; attempt++) {
      const cand = waypoints[(rngFn() * waypoints.length) | 0];
      if (Math.hypot(cand.x - bot.x, cand.z - bot.z) >= 8.0) {
        chosen = cand;
        break;
      }
    }
    bot.waypoint = chosen;
  }

  function stepSingleBot(bot, dt, tNow) {
    tickBotWeapon(bot, tNow);
    const prot = evaluateProtectionTick(bot, cfg.mode, tNow);

    // Target acquisition & active-target LoS re-verification both throttled cleanly (~5-10Hz instead of 60Hz)
    let visibleTarget = null;
    if (tNow >= bot.nextLosCheckAt) {
      bot.nextLosCheckAt = tNow + 140 + rngFn() * 60;
      bot.nextActiveLosAt = tNow + 95;
      const found = findBestVisibleEnemy(bot, tNow);
      if (found) {
        if (bot.targetId !== found.enemy.id) {
          bot.targetId = found.enemy.id;
          bot.targetSeenAt = tNow;
          bot.burstRemaining = preset.burstMin + ((rngFn() * (preset.burstMax - bot.burstMin + 1)) | 0);
        }
        if (bot.lastSeenPos) {
          bot.lastSeenPos.x = found.enemy.x;
          bot.lastSeenPos.y = found.enemy.y;
          bot.lastSeenPos.z = found.enemy.z;
          bot.lastSeenPos.flags = found.enemy.flags || 0;
        } else {
          bot.lastSeenPos = { x: found.enemy.x, y: found.enemy.y, z: found.enemy.z, flags: found.enemy.flags || 0 };
        }
        bot.cachedTargetVisible = true;
        visibleTarget = found;
      } else {
        bot.cachedTargetVisible = false;
        if (bot.targetId && tNow - bot.targetSeenAt > 3600) {
          bot.targetId = null;
          bot.lastSeenPos = null;
        }
      }
    } else if (bot.targetId) {
      const curT = players.get(bot.targetId);
      if (curT && curT.alive) {
        const d = Math.hypot(curT.x - bot.x, curT.z - bot.z);
        if (d <= preset.sightRange) {
          if (tNow >= (bot.nextActiveLosAt || 0)) {
            bot.nextActiveLosAt = tNow + 90 + rngFn() * 30;
            const eyeY = (bot.y || 0) + getEyeHeight(bot.flags);
            const tgtY = (curT.y || 0) + getEyeHeight(curT.flags || 0) - 0.14;
            bot.cachedTargetVisible = hasLineOfSight(bot.x, eyeY, bot.z, curT.x, tgtY, curT.z, safeArena);
          }
          if (bot.cachedTargetVisible) {
            if (bot.lastSeenPos) {
              bot.lastSeenPos.x = curT.x;
              bot.lastSeenPos.y = curT.y;
              bot.lastSeenPos.z = curT.z;
              bot.lastSeenPos.flags = curT.flags || 0;
            } else {
              bot.lastSeenPos = { x: curT.x, y: curT.y, z: curT.z, flags: curT.flags || 0 };
            }
            visibleTarget = { enemy: curT, dist: d };
          }
        } else {
          bot.cachedTargetVisible = false;
        }
      } else {
        bot.targetId = null;
        bot.cachedTargetVisible = false;
      }
    }

    // Smart weapon switching: Sniper switches to Glock at close range; empty M416 in CQB switches to Glock
    const activeW = bot.weapons[bot.activeWeaponId];
    if (visibleTarget) {
      if (bot.preferredWeaponId === "sniper") {
        if (visibleTarget.dist < 13 && bot.activeWeaponId === "sniper") {
          switchBotWeapon(bot, "pistol", tNow);
        } else if (visibleTarget.dist > 18 && bot.activeWeaponId === "pistol") {
          switchBotWeapon(bot, "sniper", tNow);
        }
      } else if (
        bot.activeWeaponId === "m416" &&
        activeW &&
        activeW.mag <= 1 &&
        visibleTarget.dist < 15 &&
        bot.weapons.pistol.mag > 3
      ) {
        switchBotWeapon(bot, "pistol", tNow);
      }
    } else if (bot.activeWeaponId !== bot.preferredWeaponId && bot.weapons[bot.preferredWeaponId].mag > 0) {
      switchBotWeapon(bot, bot.preferredWeaponId, tNow);
    }

    const wState = bot.weapons[bot.activeWeaponId];
    const wCfg = resolveWeaponConfig(bot.activeWeaponId);
    const isReloading = Boolean(wState && wState.reloadEndsAt > tNow);

    // Choose Stance across all 6 SWAT clips
    if (tNow > bot.strafeSwitchAt) {
      bot.strafeDir = -bot.strafeDir;
      bot.strafeSwitchAt = tNow + 900 + rngFn() * 1400;
    }

    let wantsProne = tNow < bot.proneUntil;
    let wantsCrouch = !wantsProne && tNow < bot.crouchUntil;
    let wantsSprint = false;
    let wantsPause = tNow < bot.pauseUntil;

    if (visibleTarget) {
      if (bot.activeWeaponId === "sniper" && visibleTarget.dist > 24 && bot.grounded && !wantsProne && rngFn() < preset.proneChance * dt * 2.5) {
        bot.proneUntil = tNow + 1800;
        wantsProne = true;
      } else if (visibleTarget.dist < 22 && !wantsProne && !wantsCrouch && rngFn() < preset.evadeChance * dt * 2.0) {
        bot.crouchUntil = tNow + 650 + rngFn() * 450;
        wantsCrouch = true;
      }
      if (bot.grounded && !wantsProne && visibleTarget.dist > 8 && visibleTarget.dist < 26 && tNow > bot.jumpUntil + 2200 && rngFn() < preset.jumpChance * dt * 1.4) {
        bot.vy = 7.2;
        bot.grounded = false;
        bot.jumpUntil = tNow + 550;
      }
    } else {
      wantsProne = tNow < bot.proneUntil && bot.hp < 35;
      if (!wantsProne && !wantsCrouch && !isReloading && !wantsPause && rngFn() < 0.004) {
        bot.pauseUntil = tNow + 600 + rngFn() * 750;
        wantsPause = true;
      }
      if (!wantsProne && !wantsCrouch && !wantsPause && !isReloading && bot.grounded && !prot.active) {
        wantsSprint = true;
      }
    }

    // Movement steering
    let desiredVx = 0;
    let desiredVz = 0;
    let targetYaw = bot.yaw;
    let targetPitch = 0;

    if (visibleTarget) {
      const tgt = visibleTarget.enemy;
      const dx = tgt.x - bot.x;
      const dz = tgt.z - bot.z;
      const botEyeY = (bot.y || 0) + getEyeHeight((wantsProne ? FLAG.PRONE : wantsCrouch ? FLAG.CROUCH : 0));
      const aimOffsetY = bot.activeWeaponId === "sniper" ? 0.38 : rngFn() < 0.28 ? 0.06 : 0.45;
      const tgtAimY = (tgt.y || 0) + Math.max(0.24, getEyeHeight(tgt.flags || 0) - aimOffsetY);
      const horiz = Math.max(0.5, Math.hypot(dx, dz));
      targetYaw = Math.atan2(-dx, -dz);
      targetPitch = clamp(Math.atan2(tgtAimY - botEyeY, horiz), -1.1, 1.1);

      const moveFwd = visibleTarget.dist > 19 ? 0.75 : visibleTarget.dist < 6.5 ? -0.8 : 0.0;
      const strafeWeight = wantsProne ? 0.3 : 0.85;
      const fx = -Math.sin(targetYaw);
      const fz = -Math.cos(targetYaw);
      const rx = Math.cos(targetYaw);
      const rz = -Math.sin(targetYaw);
      desiredVx = fx * moveFwd + rx * bot.strafeDir * strafeWeight;
      desiredVz = fz * moveFwd + rz * bot.strafeDir * strafeWeight;
    } else {
      const dest = bot.lastSeenPos || bot.waypoint || waypoints[0];
      const dx = dest.x - bot.x;
      const dz = dest.z - bot.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.8) {
        bot.lastSeenPos = null;
        pickNextWaypoint(bot);
      } else if (!wantsPause) {
        const baseYaw = Math.atan2(-dx, -dz);
        // Obstacle whisker avoidance throttled to ~10Hz so bots steer smoothly without 60Hz ray spam
        if (tNow >= (bot.nextWhiskerAt || 0)) {
          bot.nextWhiskerAt = tNow + 95 + rngFn() * 30;
          let steerOffset = 0;
          const probeOriginY = (bot.y || 0) + 1.05;
          const fHit = raycastArenaDistance(bot.x, probeOriginY, bot.z, -Math.sin(baseYaw), 0, -Math.cos(baseYaw), 2.4, safeArena);
          if (fHit && fHit.dist < 2.2) {
            const lYaw = baseYaw + 0.72;
            const rYaw = baseYaw - 0.72;
            const lHit = raycastArenaDistance(bot.x, probeOriginY, bot.z, -Math.sin(lYaw), 0, -Math.cos(lYaw), 3.4, safeArena);
            const rHit = raycastArenaDistance(bot.x, probeOriginY, bot.z, -Math.sin(rYaw), 0, -Math.cos(rYaw), 3.4, safeArena);
            const lDist = lHit ? lHit.dist : 3.5;
            const rDist = rHit ? rHit.dist : 3.5;
            steerOffset = lDist >= rDist ? 0.78 : -0.78;
          }
          bot.cachedSteerOffset = steerOffset;
        }
        targetYaw = wrapAngle(baseYaw + (bot.cachedSteerOffset || 0));
        desiredVx = -Math.sin(targetYaw);
        desiredVz = -Math.cos(targetYaw);
      }
    }

    bot.yaw = stepAngleToward(bot.yaw, targetYaw, preset.aimTrackSpeed * dt);
    bot.pitch += (targetPitch - bot.pitch) * Math.min(1, 10 * dt);

    const hasMove = Math.hypot(desiredVx, desiredVz) > 0.05 && !wantsPause;
    if (wantsProne && bot.grounded) wantsCrouch = false;
    if (!bot.grounded) wantsProne = false;

    const adsNow = Boolean(visibleTarget && (bot.activeWeaponId === "sniper" || visibleTarget.dist > 14) && !isReloading && !wantsSprint);
    bot.ads = adsNow;
    bot.flags =
      (wantsCrouch ? FLAG.CROUCH : 0) |
      (wantsProne ? FLAG.PRONE : 0) |
      (adsNow ? FLAG.ADS : 0) |
      (wantsSprint && hasMove ? FLAG.SPRINT : 0) |
      (!bot.grounded ? FLAG.AIR : 0) |
      (isReloading ? FLAG.RELOADING : 0);

    const moveSpeed = BASE_MOVE_SPEED * getMoveSpeedMultiplier(bot.flags, wCfg) * 0.92;
    const prevX = bot.x;
    const prevZ = bot.z;
    if (hasMove) {
      const norm = Math.hypot(desiredVx, desiredVz) || 1;
      const nextPos = clampAndResolvePlayerPos(
        {
          x: bot.x + (desiredVx / norm) * moveSpeed * dt,
          y: bot.y,
          z: bot.z + (desiredVz / norm) * moveSpeed * dt,
        },
        safeArena,
        PLAYER_RADIUS,
        bot.flags,
      );
      bot.x = nextPos.x;
      bot.y = nextPos.y;
      bot.z = nextPos.z;
    }

    if (!bot.grounded || bot.y > 0) {
      bot.vy -= 22 * dt;
      bot.y += bot.vy * dt;
      if (bot.y <= 0) {
        bot.y = 0;
        bot.vy = 0;
        bot.grounded = true;
      }
    }

    const actualStep = Math.hypot(bot.x - prevX, bot.z - prevZ);
    const actualSpeed = dt > 1e-4 ? actualStep / dt : 0;
    bot.mv = actualSpeed > 0.25 ? clamp(actualSpeed / BASE_MOVE_SPEED, 0.35, 1.45) : 0;

    if (hasMove && actualSpeed < 0.45 && !visibleTarget) {
      bot.stuckAccum += dt;
      if (bot.stuckAccum > 0.55) {
        bot.stuckAccum = 0;
        pickNextWaypoint(bot);
      }
    } else {
      bot.stuckAccum = 0;
    }

    // Weapon firing decision
    if (visibleTarget && !isReloading && wState && tNow >= (wState.equipEndsAt || 0)) {
      if (wState.mag <= 0) {
        startBotReload(bot, tNow);
        return;
      }
      const targetEnemy = visibleTarget.enemy;
      const targetProt = isPlayerProtected(targetEnemy, tNow);
      if (targetProt && rngFn() < preset.respectProtectChance) {
        return;
      }
      if (tNow - bot.targetSeenAt < preset.reactionMs) return;
      if (tNow < bot.burstCooldownUntil || tNow < wState.nextFireAt) return;

      if (bot.burstRemaining <= 0) {
        bot.burstRemaining = preset.burstMin + ((rngFn() * (preset.burstMax - preset.burstMin + 1)) | 0);
        bot.burstCooldownUntil = tNow + preset.burstPauseMs * (0.8 + rngFn() * 0.4);
        return;
      }

      const yawDiff = Math.abs(wrapAngle(targetYaw - bot.yaw));
      if (yawDiff > 0.28) return;

      const eyeOrigin = {
        x: bot.x,
        y: (bot.y || 0) + getEyeHeight(bot.flags),
        z: bot.z,
      };
      const baseDir = forwardFromYawPitch(bot.yaw, bot.pitch);
      const effSpread = computeWeaponSpread(wCfg, bot.flags) + preset.aimSpreadRad;
      const sx = baseDir.x + (rngFn() * 2 - 1) * effSpread;
      const sy = baseDir.y + (rngFn() * 2 - 1) * effSpread * 0.8;
      const sz = baseDir.z + (rngFn() * 2 - 1) * effSpread;
      const sLen = Math.hypot(sx, sy, sz) || 1;
      const shotDir = { x: sx / sLen, y: sy / sLen, z: sz / sLen };

      wState.mag--;
      wState.nextFireAt = tNow + wCfg.fireInterval * (bot.activeWeaponId === "pistol" ? 1.55 : 1.1);
      bot.burstRemaining--;
      bot.flags |= FLAG.FIRING;

      if (typeof callbacks.onEventFire === "function") {
        callbacks.onEventFire({
          playerId: bot.id,
          weapon: wCfg.id,
          origin: eyeOrigin,
          dir: shotDir,
          seed: (tNow ^ (bot.id.charCodeAt(bot.id.length - 1) * 193)) & 0xfffff,
        });
      }

      resolveShotCommon(bot, wCfg, eyeOrigin, shotDir, tNow);
      if (wState.mag === 0) startBotReload(bot, tNow);
    }
  }

  function step(dt, tNow = nowFn(), outTarget = null) {
    now = tNow;
    if (ended) return buildSnapshot(now, outTarget);

    const safeDt = Math.min(Math.max(0, dt), 0.05);

    // Handle respawns for both human & bots
    for (const p of players.values()) {
      if (p.alive) {
        evaluateProtectionTick(p, cfg.mode, now);
      } else if (now >= p.respawnAt) {
        spawnActor(p, now, true);
      }
    }

    // Step AI decisions & locomotion for alive bots
    for (const p of players.values()) {
      if (p.isBot && p.alive && !ended) {
        stepSingleBot(p, safeDt, now);
      }
    }

    if (!ended && now >= matchEndsAt) {
      let win = "DRAW";
      if (cfg.mode === "TDM") {
        win = teamScores.A > teamScores.B ? "A" : teamScores.B > teamScores.A ? "B" : "DRAW";
      } else {
        const sorted = getScoreboard();
        if (sorted.length && sorted[0].kills > 0) {
          win = sorted.length > 1 && sorted[1].kills === sorted[0].kills ? "DRAW" : sorted[0].name;
        }
      }
      finishMatch(win, now);
    }

    return buildSnapshot(now, outTarget);
  }

  function buildSnapshot(tNow = now, outTarget = null) {
    const outPlayers = outTarget && Array.isArray(outTarget.players) ? outTarget.players : [];
    let idx = 0;
    for (const p of players.values()) {
      const prot = p.alive
        ? evaluateProtectionTick(p, cfg.mode, tNow)
        : { active: false, iFrames: false, expiring: false, remainingMs: 0, totalMs: modeRule.protectMs, progress: 0 };
      let entry = outPlayers[idx];
      if (!entry) {
        entry = {};
        outPlayers[idx] = entry;
      }
      entry.id = p.id;
      entry.name = p.name;
      entry.team = p.team;
      entry.isBot = p.isBot;
      entry.x = p.x;
      entry.y = p.y;
      entry.z = p.z;
      entry.yaw = p.yaw;
      entry.pitch = p.pitch;
      entry.mv = p.mv;
      entry.flags = p.flags;
      entry.weaponId = p.activeWeaponId;
      entry.alive = p.alive;
      entry.hp = p.hp;
      entry.reloading = Boolean(p.flags & FLAG.RELOADING);
      entry.invulnerable = prot.active;
      entry.iFrames = prot.iFrames;
      entry.protectExpiring = prot.expiring;
      entry.protectRemainingMs = prot.remainingMs;
      entry.protectTotalMs = prot.totalMs;
      entry.respawnMs = p.alive ? 0 : Math.max(0, p.respawnAt - tNow);
      entry.kills = p.kills;
      entry.deaths = p.deaths;
      entry.headshots = p.headshots;
      entry.laser = p.laser;
      idx++;
    }
    outPlayers.length = idx;
    if (outTarget) {
      outTarget.t = tNow;
      outTarget.timeLeftSec = ended ? 0 : Math.max(0, Math.ceil((matchEndsAt - tNow) / 1000));
      outTarget.mode = cfg.mode;
      outTarget.killLimit = cfg.killLimit;
      if (!outTarget.teamScores) outTarget.teamScores = { A: 0, B: 0 };
      outTarget.teamScores.A = teamScores.A;
      outTarget.teamScores.B = teamScores.B;
      outTarget.ended = ended;
      outTarget.winner = winner;
      outTarget.players = outPlayers;
      return outTarget;
    }
    return {
      t: tNow,
      timeLeftSec: ended ? 0 : Math.max(0, Math.ceil((matchEndsAt - tNow) / 1000)),
      mode: cfg.mode,
      killLimit: cfg.killLimit,
      teamScores: { ...teamScores },
      ended,
      winner,
      players: outPlayers,
    };
  }

  return {
    config: cfg,
    preset,
    modeRule,
    players,
    getHuman: () => human,
    getScoreboard,
    syncHumanState,
    handleHumanFire,
    step,
    buildSnapshot,
  };
}
