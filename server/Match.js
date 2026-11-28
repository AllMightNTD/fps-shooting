/**
 * Authoritative active-match engine: posture-aware movement clamping (leaky bucket),
 * multi-weapon equip/reload/switch state machine, server-side hitbox raycast + AWM ballistics,
 * RTT-bounded lag compensation, and 5-layer anti-cheat enforcement.
 */

import { AntiCheatTracker, validateShotDirection, validateShotOrigin } from "./anti_cheat.js";
import { getEyeHeight, resolveAuthoritativeShot } from "./hitreg.js";
import { clampRewindTimestamp, createPoseHistoryStore } from "./lag_comp.js";
import { ERR, MSG, ROOM_STATE, SNAPSHOT_WEAPON_CODE } from "./protocol.js";
import {
  SPAWN_RULES,
  activateSpawnProtection,
  cancelProtectionOnFire,
  clampAndResolvePlayerPos,
  createSpawnTracker,
  evaluateProtectionTick,
  getSpawnRuleForMode,
  isPlayerProtected,
} from "./spawn_rules.js";
import {
  BASE_MOVE_SPEED,
  FLAG,
  WEAPONS,
  computeWeaponDamage,
  createDefaultWeaponsState,
  getMoveSpeedMultiplier,
  getReloadDurationMs,
  resolveWeaponConfig,
} from "./weapons.js";

export const RESPAWN_DELAY_MS = SPAWN_RULES.TDM.respawnDelayMs;
export const INVULNERABLE_MS = SPAWN_RULES.TDM.protectMs;
export const IFRAMES_MS = SPAWN_RULES.TDM.iFramesMs;
export { SPAWN_RULES, getSpawnRuleForMode };
export const RELOAD_TOLERANCE_MS = 80;
export const FIRE_JITTER_MS = 25;
export const EQUIP_TOLERANCE_MS = 30;
export const MOVE_ALLOWANCE_MAX = 1.2;

function finiteVec3(v) {
  return (
    v &&
    typeof v === "object" &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

export class Match {
  constructor(room) {
    this.room = room;
    this.matchEndsAt = 0;
    this.poseHistory = createPoseHistoryStore();
    this.antiCheat = new AntiCheatTracker();
    this.spawnTracker = createSpawnTracker();
  }

  resetAntiCheatAndHistory() {
    this.poseHistory.clear();
    this.antiCheat.reset();
    this.spawnTracker = createSpawnTracker();
  }

  _applyAntiCheatAction(player, res) {
    if (!player || !res || res.action === "none") return "none";
    if (res.action === "warn") {
      console.warn(`[AntiCheat] Warn room=${this.room.id} player=${player.id} code=${res.code} score=${res.score}`);
      if (typeof this.room.sendTo === "function") {
        this.room.sendTo(player.id, {
          type: MSG.ERROR,
          code: ERR.CHEAT_DETECTED,
          message: "Cảnh báo: phát hiện gói tin bắn hoặc di chuyển bất thường",
        });
      }
      return "warn";
    }
    if (res.action === "kick") {
      console.warn(`[AntiCheat] Kick room=${this.room.id} player=${player.id} code=${res.code} score=${res.score}`);
      if (typeof this.room.kickForCheat === "function") {
        this.room.kickForCheat(player.id);
      }
      return "kick";
    }
    return "none";
  }

  start(now) {
    this.matchEndsAt = now + this.room.timeLimit * 1000;
    this.room.teamScores = { A: 0, B: 0 };
    this.resetAntiCheatAndHistory();
    for (const p of this.room.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.headshots = 0;
      p.spawnEpoch = 0;
      p.lastDeathPos = null;
      p.activeWeaponId = "m416";
      p.prevWeaponId = "m416";
      p.moveAllowance = MOVE_ALLOWANCE_MAX;
      this.spawnPlayer(p, now);
    }
  }

  spawnPlayer(player, now) {
    const sp = this.room.modeImpl.pickSpawn(this.room, player, now, this.spawnTracker);
    player.x = sp.x;
    player.y = sp.y;
    player.z = sp.z;
    player.yaw = sp.yaw;
    player.pitch = 0;
    player.mv = 0;
    player.ads = false;
    player.laser = true;
    player.flags = 0;
    player.prevFlags = 0;
    player.hp = 100;
    player.alive = true;
    player.activeWeaponId = player.activeWeaponId && WEAPONS[player.activeWeaponId] ? player.activeWeaponId : "m416";
    player.prevWeaponId = player.activeWeaponId;
    player.lastFiredWeaponId = player.activeWeaponId;
    player.weapons = createDefaultWeaponsState();
    player.respawnAt = 0;
    player.lastSpawnReason = sp.reason || "normal";
    activateSpawnProtection(player, this.room.mode, sp, now);
    player.lastStateAt = now;
    player.lastShotAt = 0;
    player.moveAllowance = MOVE_ALLOWANCE_MAX;
    this.poseHistory.record(player, now);
    this.syncPlayerWeapons(player, now);
  }

  syncPlayerWeapons(player, now) {
    if (!player || !player.weapons) return;
    const summary = {};
    for (const [id, st] of Object.entries(player.weapons)) {
      summary[id] = st.mag;
    }
    const activeW = player.weapons[player.activeWeaponId];
    const reloadingMs =
      activeW && activeW.reloadEndsAt > now ? activeW.reloadEndsAt - now : 0;
    const equipMs =
      activeW && activeW.equipEndsAt > now ? activeW.equipEndsAt - now : 0;
    this.room.sendTo(player.id, {
      type: MSG.AMMO,
      id: player.activeWeaponId,
      mag: activeW ? activeW.mag : 0,
      activeWeaponId: player.activeWeaponId,
      reloadingMs,
      equipMs,
      weapons: summary,
    });
  }

  tickWeapon(player, now) {
    if (!player || !player.weapons) return;
    const w = player.weapons[player.activeWeaponId];
    if (!w) return;
    if (w.reloadEndsAt > 0 && now + RELOAD_TOLERANCE_MS >= w.reloadEndsAt) {
      const cfg = resolveWeaponConfig(w.id);
      w.mag = cfg.magSize;
      w.reloadEndsAt = 0;
      w.reloadDuration = 0;
      player.flags &= ~FLAG.RELOADING;
      this.room.sendTo(player.id, {
        type: MSG.AMMO,
        id: w.id,
        mag: w.mag,
        activeWeaponId: player.activeWeaponId,
        reloadingMs: 0,
      });
    }
  }

  _cancelReload(player) {
    if (!player || !player.weapons) return false;
    const w = player.weapons[player.activeWeaponId];
    const wasReloading = Boolean(w && w.reloadEndsAt > 0);
    if (w) {
      w.reloadEndsAt = 0;
      w.reloadDuration = 0;
    }
    player.flags &= ~FLAG.RELOADING;
    return wasReloading;
  }

  handleState(player, msg, now) {
    if (this.room.state !== ROOM_STATE.PLAYING || !player.alive) return;

    this.tickWeapon(player, now);
    const activeW = player.weapons[player.activeWeaponId];
    const isReloadingServer = Boolean(activeW && activeW.reloadEndsAt > 0);

    let incomingFlags = Number.isInteger(msg.flags) ? (msg.flags & 0x7f) : player.flags || 0;
    if (incomingFlags & FLAG.PRONE) incomingFlags &= ~(FLAG.SPRINT | FLAG.CROUCH);
    else if (incomingFlags & FLAG.CROUCH) incomingFlags &= ~FLAG.SPRINT;
    if (isReloadingServer) {
      incomingFlags = (incomingFlags | FLAG.RELOADING) & ~FLAG.ADS;
    } else {
      incomingFlags &= ~FLAG.RELOADING;
    }

    const prevMult = getMoveSpeedMultiplier(player.prevFlags || 0, player.prevWeaponId || player.activeWeaponId);
    const curMult = getMoveSpeedMultiplier(incomingFlags, player.activeWeaponId);
    const allowedSpeed = BASE_MOVE_SPEED * Math.max(prevMult, curMult);

    const pos = msg.pos;
    if (finiteVec3(pos)) {
      const clamped = clampAndResolvePlayerPos(pos, this.room.arena, 0.45, incomingFlags);
      const dtSec = Math.min(1.2, Math.max(0, (now - (player.lastStateAt || now)) / 1000));
      const baseMax = allowedSpeed * dtSec * 1.15;
      const allowance = Number.isFinite(player.moveAllowance) ? player.moveAllowance : MOVE_ALLOWANCE_MAX;
      const maxDist = baseMax + allowance;
      const d = Math.hypot(clamped.x - player.x, clamped.z - player.z);
      if (d <= baseMax) {
        player.x = clamped.x;
        player.y = clamped.y;
        player.z = clamped.z;
        player.moveAllowance = Math.min(MOVE_ALLOWANCE_MAX, allowance + Math.max(0, baseMax - d) * 0.5);
      } else if (d <= maxDist) {
        player.x = clamped.x;
        player.y = clamped.y;
        player.z = clamped.z;
        player.moveAllowance = Math.max(0, allowance - (d - baseMax));
      } else {
        const k = d > 0 ? maxDist / d : 0;
        const stepPos = clampAndResolvePlayerPos(
          {
            x: player.x + (clamped.x - player.x) * k,
            y: clamped.y,
            z: player.z + (clamped.z - player.z) * k,
          },
          this.room.arena,
          0.45,
          incomingFlags,
        );
        player.x = stepPos.x;
        player.y = stepPos.y;
        player.z = stepPos.z;
        player.moveAllowance = 0;
        const tamperMargin = dtSec > 0 ? 0.45 : 0.05;
        if (d > maxDist + tamperMargin) {
          const ac = this.antiCheat.recordViolation(player.id, "SPEED_TAMPER", now);
          this._applyAntiCheatAction(player, ac);
        }
      }
      player.lastStateAt = now;
    }

    if (Number.isFinite(msg.yaw)) player.yaw = Number(msg.yaw);
    if (Number.isFinite(msg.pitch)) {
      player.pitch = Math.max(-1.48, Math.min(1.48, Number(msg.pitch)));
    }
    player.prevFlags = player.flags;
    player.flags = incomingFlags;
    player.prevWeaponId = player.activeWeaponId;
    player.ads = Boolean(incomingFlags & FLAG.ADS);

    const anim = msg.anim;
    if (anim && typeof anim === "object") {
      if (Number.isFinite(anim.mv)) player.mv = Math.max(0, Math.min(2, Number(anim.mv)));
      if (typeof anim.laser === "boolean") player.laser = anim.laser;
    }

    this.poseHistory.record(player, now);
  }

  handleSwitchWeapon(player, msg = {}, now) {
    if (this.room.state !== ROOM_STATE.PLAYING || !player.alive) return false;
    this.tickWeapon(player, now);

    const targetCfg = resolveWeaponConfig(msg.slot ?? msg.id);
    if (!targetCfg || !player.weapons[targetCfg.id]) return false;
    if (player.activeWeaponId === targetCfg.id) {
      this.syncPlayerWeapons(player, now);
      return true;
    }

    // Rule A1: Switching during reload cancels reload, keeping existing mag intact
    this._cancelReload(player);
    player.flags &= ~FLAG.ADS;
    player.ads = false;
    player.prevWeaponId = player.activeWeaponId;
    player.activeWeaponId = targetCfg.id;
    player.weapons[targetCfg.id].equipEndsAt = now + (targetCfg.equipTimeMs || 0);

    this.syncPlayerWeapons(player, now);
    this.room.broadcast({
      type: MSG.SWITCH_WEAPON,
      playerId: player.id,
      weaponId: targetCfg.id,
    });
    return true;
  }

  handleScope(player, msg = {}) {
    if (this.room.state !== ROOM_STATE.PLAYING || !player.alive) return false;
    const level = Number.isInteger(msg.level) ? Math.max(0, Math.min(2, msg.level)) : 0;
    const weapon = typeof msg.weapon === "string" && msg.weapon ? msg.weapon : player.activeWeaponId;
    this.room.broadcast({
      type: MSG.EVENT_SCOPE,
      playerId: player.id,
      weapon,
      level,
      x: Number(player.x.toFixed(2)),
      y: Number(player.y.toFixed(2)),
      z: Number(player.z.toFixed(2)),
    });
    return true;
  }

  handleReload(player, now) {
    if (this.room.state !== ROOM_STATE.PLAYING || !player.alive) return false;
    this.tickWeapon(player, now);
    const w = player.weapons[player.activeWeaponId];
    const cfg = resolveWeaponConfig(player.activeWeaponId);
    if (!w || w.reloadEndsAt > 0 || w.mag >= cfg.magSize) return false;

    const dur = getReloadDurationMs(cfg, w.mag);
    w.reloadEndsAt = now + dur;
    w.reloadDuration = dur;
    player.flags = (player.flags | FLAG.RELOADING) & ~FLAG.ADS;
    player.ads = false;

    this.room.broadcast({
      type: MSG.EVENT_RELOAD,
      playerId: player.id,
      pid: player.id,
      id: w.id,
      dur,
    });
    return true;
  }

  handleDeprecatedClientHit(player, now) {
    if (player && player.id) {
      const ac = this.antiCheat.recordViolation(player.id, "LEGACY_HIT_SPOOF", now);
      this._applyAntiCheatAction(player, ac);
    }
    return {
      ok: false,
      code: ERR.INVALID_STATE,
      message: "Hit detection do máy chủ quyết định",
    };
  }

  handleFire(player, msg = {}, now) {
    if (this.room.state !== ROOM_STATE.PLAYING) {
      return { ok: false, code: ERR.MATCH_ENDED, message: "Trận đấu đã kết thúc" };
    }
    if (!player.alive) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Đang chờ hồi sinh" };
    }
    if (this.room.players && !this.room.players.has(player.id)) {
      return { ok: false, code: ERR.NOT_IN_ROOM, message: "Bạn không còn ở trong phòng" };
    }

    this.tickWeapon(player, now);
    const w = player.weapons[player.activeWeaponId];
    const cfg = resolveWeaponConfig(player.activeWeaponId);

    const sentFlags = Number.isInteger(msg.flags) ? (msg.flags & 0x7f) : player.flags || 0;
    if (sentFlags & FLAG.SPRINT) {
      this.room.sendTo(player.id, {
        type: MSG.AMMO,
        id: w.id,
        mag: w.mag,
        activeWeaponId: player.activeWeaponId,
      });
      return { ok: false, code: ERR.INVALID_STATE, message: "Không thể bắn khi đang chạy nước rút" };
    }

    if (!w || w.reloadEndsAt > 0 || w.mag <= 0) {
      const remMs = w && w.reloadEndsAt > now ? w.reloadEndsAt - now : 0;
      this.room.sendTo(player.id, {
        type: MSG.AMMO,
        id: w ? w.id : player.activeWeaponId,
        mag: w ? w.mag : 0,
        activeWeaponId: player.activeWeaponId,
        reloadingMs: remMs,
      });
      return { ok: false, code: ERR.INVALID_STATE, message: "Đang nạp đạn hoặc hết đạn" };
    }

    if (now < (w.equipEndsAt || 0) - EQUIP_TOLERANCE_MS) {
      this.room.sendTo(player.id, {
        type: MSG.AMMO,
        id: w.id,
        mag: w.mag,
        activeWeaponId: player.activeWeaponId,
        equipMs: Math.max(0, w.equipEndsAt - now),
      });
      return { ok: false, code: ERR.INVALID_STATE, message: "Đang rút súng" };
    }

    if (now < w.nextFireAt - FIRE_JITTER_MS) {
      const ac = this.antiCheat.recordViolation(player.id, "RAPID_FIRE", now);
      this._applyAntiCheatAction(player, ac);
      return { ok: false, code: ERR.RATE_LIMITED, message: "Bắn quá nhanh" };
    }

    if (Number.isFinite(msg.yaw)) player.yaw = Number(msg.yaw);
    if (Number.isFinite(msg.pitch)) {
      player.pitch = Math.max(-1.48, Math.min(1.48, Number(msg.pitch)));
    }

    // Firing cancels both i-frames & spawn protection immediately (zero-abuse rule)
    cancelProtectionOnFire(player);
    w.mag--;
    w.nextFireAt = Math.max(now, w.nextFireAt || 0) + cfg.fireInterval;
    player.lastShotAt = now;
    player.lastFiredWeaponId = w.id;

    const arena = this.room && this.room.arena ? this.room.arena : null;
    const authEye = {
      x: player.x || 0,
      y: (player.y || 0) + getEyeHeight(player.flags || 0),
      z: player.z || 0,
    };
    const originCheck = validateShotOrigin(authEye, msg.origin, arena);
    if (originCheck.tampered) {
      const ac = this.antiCheat.recordViolation(player.id, "ORIGIN_TAMPER", now);
      if (this._applyAntiCheatAction(player, ac) === "kick") {
        return { ok: false, code: ERR.CHEAT_DETECTED, message: "Phát hiện gian lận" };
      }
    }

    const dirCheck = validateShotDirection(
      player.yaw || 0,
      player.pitch || 0,
      msg.dir,
      cfg,
      sentFlags,
    );
    if (dirCheck.tampered) {
      const ac = this.antiCheat.recordViolation(player.id, "AIM_DIR_TAMPER", now);
      if (this._applyAntiCheatAction(player, ac) === "kick") {
        return { ok: false, code: ERR.CHEAT_DETECTED, message: "Phát hiện gian lận" };
      }
    }

    const seed = Number.isInteger(msg.seed)
      ? (msg.seed >>> 0) % 1000000
      : ((now ^ Math.imul(player.id.length + 1, 2654435761)) >>> 0) % 1000000;

    this.room.sendTo(player.id, {
      type: MSG.AMMO,
      id: w.id,
      mag: w.mag,
      activeWeaponId: player.activeWeaponId,
    });

    this.room.broadcast({
      type: MSG.EVENT_FIRE,
      playerId: player.id,
      weapon: w.id,
      origin: originCheck.origin,
      dir: dirCheck.dir,
      seed,
    });

    let hitOutcome = { hit: false };
    if (!dirCheck.tampered) {
      const evalTime = clampRewindTimestamp(msg.clientTime, now, player.rttMs || 0);
      const modeImpl = this.room && this.room.modeImpl;
      const targets = [];
      for (const v of this.room.players.values()) {
        if (v.id === player.id || !v.alive) continue;
        if (modeImpl && !modeImpl.canDamage(player, v)) continue;
        if (evalTime < (v.spawnedAt || 0)) continue;
        const sampled = this.poseHistory.sample(v.id, evalTime, v);
        if (!sampled || sampled.alive === false) continue;
        if ((sampled.spawnEpoch || 0) !== (v.spawnEpoch || 0)) continue;
        targets.push({ ...sampled, id: v.id });
      }

      const shotRes = resolveAuthoritativeShot({
        shooterId: player.id,
        weaponCfg: cfg,
        origin: originCheck.origin,
        dir: dirCheck.dir,
        arena,
        targets,
      });

      if (shotRes.hit && shotRes.targetId) {
        const victim = this.room.players.get(shotRes.targetId);
        if (victim && victim.alive) {
          const victimProt = evaluateProtectionTick(victim, this.room.mode, now);
          if (victimProt.active || isPlayerProtected(victim, now)) {
            this.room.broadcast({
              type: MSG.EVENT_HIT,
              shooterId: player.id,
              targetId: victim.id,
              part: "shield",
              damage: 0,
              hp: victim.hp,
              weaponId: cfg.id,
              dist: Number(shotRes.dist.toFixed(1)),
              hitPoint: shotRes.hitPoint,
              iFrames: victimProt.iFrames,
            });
            hitOutcome = {
              hit: true,
              shielded: true,
              iFrames: victimProt.iFrames,
              targetId: victim.id,
              part: "shield",
              damage: 0,
              hp: victim.hp,
              dist: shotRes.dist,
              hitPoint: shotRes.hitPoint,
            };
          } else {
            const damage = computeWeaponDamage(cfg, shotRes.part, shotRes.dist);
            if (damage > 0) {
              victim.hp = Math.max(0, victim.hp - damage);
              this.room.broadcast({
                type: MSG.EVENT_HIT,
                shooterId: player.id,
                targetId: victim.id,
                part: shotRes.part,
                damage,
                hp: victim.hp,
                weaponId: cfg.id,
                dist: Number(shotRes.dist.toFixed(1)),
                hitPoint: shotRes.hitPoint,
              });
              hitOutcome = {
                hit: true,
                targetId: victim.id,
                part: shotRes.part,
                damage,
                hp: victim.hp,
                dist: shotRes.dist,
                hitPoint: shotRes.hitPoint,
              };

              if (victim.hp <= 0) {
                victim.alive = false;
                victim.lastDeathPos = { x: victim.x, y: victim.y, z: victim.z };
                this._cancelReload(victim);
                victim.flags = 0;
                victim.prevFlags = 0;
                victim.ads = false;
                victim.iFramesUntil = 0;
                victim.invulnerableUntil = 0;
                victim.adsProtectStartAt = 0;
                victim.deaths++;
                const respawnDelayMs = getSpawnRuleForMode(this.room.mode).respawnDelayMs;
                victim.respawnAt = now + respawnDelayMs;
                this.poseHistory.record(victim, now);

                player.kills++;
                if (shotRes.part === "head") player.headshots++;

                const res = modeImpl ? modeImpl.onKill(this.room, player) : null;
                this.room.broadcast({
                  type: MSG.EVENT_KILL,
                  killerId: player.id,
                  killer: player.name,
                  killerTeam: player.team,
                  killerHp: Math.max(0, Math.round(player.hp)),
                  killerPos: {
                    x: Number((player.x || 0).toFixed(2)),
                    y: Number((player.y || 0).toFixed(2)),
                    z: Number((player.z || 0).toFixed(2)),
                  },
                  victimId: victim.id,
                  victim: victim.name,
                  victimTeam: victim.team,
                  weapon: cfg.name,
                  weaponId: cfg.id,
                  head: shotRes.part === "head",
                  respawnMs: respawnDelayMs,
                });
                this.room.broadcast({
                  type: MSG.MATCH_SCORE,
                  teamScores: { ...this.room.teamScores },
                  scoreboard: this.room.getScoreboard(),
                });

                if (res && res.matchWinner !== undefined) {
                  this.room.finishMatch(res.matchWinner, now);
                }
              }
            }
          }
        }
      }
    }

    if (w.mag === 0) {
      this.handleReload(player, now);
    }

    return { ok: true, weaponId: w.id, mag: w.mag, ...hitOutcome };
  }

  step(now) {
    if (this.room.state !== ROOM_STATE.PLAYING) return;

    const rule = getSpawnRuleForMode(this.room.mode);
    for (const p of this.room.players.values()) {
      if (p.alive) {
        this.tickWeapon(p, now);
        evaluateProtectionTick(p, this.room.mode, now);
        this.poseHistory.record(p, now);
      }
      if (!p.alive && now >= p.respawnAt) {
        this.spawnPlayer(p, now);
        this.room.broadcast({
          type: MSG.EVENT_RESPAWN,
          playerId: p.id,
          pos: { x: p.x, y: p.y, z: p.z },
          yaw: p.yaw,
          team: p.team,
          weaponId: p.activeWeaponId,
          invulnerableMs: rule.protectMs,
          iFramesMs: rule.iFramesMs,
          reason: p.lastSpawnReason || "normal",
        });
      }
    }
    this.poseHistory.prune(now);

    if (now >= this.matchEndsAt) {
      const winner = this.room.modeImpl.resolveTimeExpiredWinner(this.room);
      this.room.finishMatch(winner, now);
      return;
    }

    this.room.broadcast(this.buildSnapshot(now));
  }

  buildSnapshot(now) {
    const players = [];
    for (const p of this.room.players.values()) {
      const activeW = p.weapons && p.weapons[p.activeWeaponId];
      const reloading = Boolean(p.alive && activeW && activeW.reloadEndsAt > now);
      const flags = reloading ? ((p.flags || 0) | FLAG.RELOADING) : ((p.flags || 0) & ~FLAG.RELOADING);
      const prot = p.alive ? evaluateProtectionTick(p, this.room.mode, now) : { active: false, iFrames: false, expiring: false };
      const st =
        (p.alive ? 1 : 0) |
        (prot.active ? 2 : 0) |
        (p.laser ? 4 : 0) |
        (prot.iFrames ? 8 : 0) |
        (prot.expiring ? 16 : 0);
      const teamCode = p.team === "A" ? 0 : p.team === "B" ? 1 : 2;
      const wCode = SNAPSHOT_WEAPON_CODE[p.activeWeaponId] ?? 0;
      players.push([
        p.id,
        teamCode,
        Number(p.x.toFixed(2)),
        Number(p.y.toFixed(2)),
        Number(p.z.toFixed(2)),
        Number(p.yaw.toFixed(3)),
        Number(p.pitch.toFixed(3)),
        Number((p.mv || 0).toFixed(2)),
        flags,
        st,
        wCode,
        p.hp,
        activeW ? activeW.mag : 0,
        p.alive ? 0 : Math.max(0, p.respawnAt - now),
        p.kills,
        p.deaths,
        p.headshots,
      ]);
    }
    return {
      type: MSG.SNAPSHOT,
      t: now,
      tl:
        this.room.state === ROOM_STATE.PLAYING
          ? Math.max(0, Math.ceil((this.matchEndsAt - now) / 1000))
          : 0,
      ts: [this.room.teamScores.A || 0, this.room.teamScores.B || 0],
      p: players,
    };
  }
}
