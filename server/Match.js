/**
 * Authoritative active-match engine: posture-aware movement clamping,
 * multi-weapon reload/switch state machine, crouch hitbox LoS, respawn, and scoring.
 */

import { ERR, MSG, ROOM_STATE } from "./protocol.js";
import { clampAndResolvePlayerPos, hasLineOfSight } from "./spawn.js";
import {
  BASE_MOVE_SPEED,
  FLAG,
  WEAPONS,
  createDefaultWeaponsState,
  getMoveSpeedMultiplier,
  getReloadDurationMs,
  resolveWeaponConfig,
} from "./weapons.js";

export const RESPAWN_DELAY_MS = 4000;
export const INVULNERABLE_MS = 2500;
export const RELOAD_TOLERANCE_MS = 80;
export const FIRE_JITTER_MS = 30;

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
  }

  start(now) {
    this.matchEndsAt = now + this.room.timeLimit * 1000;
    this.room.teamScores = { A: 0, B: 0 };
    for (const p of this.room.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.headshots = 0;
      p.activeWeaponId = "m416";
      this.spawnPlayer(p, now);
    }
  }

  spawnPlayer(player, now) {
    const sp = this.room.modeImpl.pickSpawn(this.room, player);
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
    player.lastFiredWeaponId = player.activeWeaponId;
    player.weapons = createDefaultWeaponsState();
    player.respawnAt = 0;
    player.invulnerableUntil = now + INVULNERABLE_MS;
    player.lastStateAt = now;
    player.lastShotAt = 0;
    player.pendingHitCredit = 0;
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
    this.room.sendTo(player.id, {
      type: MSG.AMMO,
      id: player.activeWeaponId,
      mag: activeW ? activeW.mag : 0,
      activeWeaponId: player.activeWeaponId,
      reloadingMs,
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

    let incomingFlags = Number.isInteger(msg.flags) ? (msg.flags & 0x3f) : player.flags || 0;
    if (incomingFlags & FLAG.CROUCH) incomingFlags &= ~FLAG.SPRINT;
    if (isReloadingServer) {
      incomingFlags = (incomingFlags | FLAG.RELOADING) & ~FLAG.ADS;
    } else {
      incomingFlags &= ~FLAG.RELOADING;
    }

    const prevMult = getMoveSpeedMultiplier(player.prevFlags || 0);
    const curMult = getMoveSpeedMultiplier(incomingFlags);
    const allowedSpeed = BASE_MOVE_SPEED * Math.max(prevMult, curMult);

    const pos = msg.pos;
    if (finiteVec3(pos)) {
      const clamped = clampAndResolvePlayerPos(pos, this.room.arena, 0.45, incomingFlags);
      const dtSec = Math.max(0.05, (now - (player.lastStateAt || now)) / 1000);
      const maxDist = allowedSpeed * dtSec + 1.35;
      const d = Math.hypot(clamped.x - player.x, clamped.z - player.z);
      if (d <= maxDist) {
        player.x = clamped.x;
        player.y = clamped.y;
        player.z = clamped.z;
      } else {
        const k = maxDist / d;
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
      }
      player.lastStateAt = now;
    }

    if (Number.isFinite(msg.yaw)) player.yaw = Number(msg.yaw);
    if (Number.isFinite(msg.pitch)) {
      player.pitch = Math.max(-1.48, Math.min(1.48, Number(msg.pitch)));
    }
    player.prevFlags = player.flags;
    player.flags = incomingFlags;
    player.ads = Boolean(incomingFlags & FLAG.ADS);

    const anim = msg.anim;
    if (anim && typeof anim === "object") {
      if (Number.isFinite(anim.mv)) player.mv = Math.max(0, Math.min(2, Number(anim.mv)));
      if (typeof anim.laser === "boolean") player.laser = anim.laser;
    }
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
    player.activeWeaponId = targetCfg.id;

    this.syncPlayerWeapons(player, now);
    this.room.broadcast({
      type: MSG.SWITCH_WEAPON,
      playerId: player.id,
      weaponId: targetCfg.id,
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

  handleFire(player, msg = {}, now) {
    if (this.room.state !== ROOM_STATE.PLAYING) {
      return { ok: false, code: ERR.MATCH_ENDED, message: "Trận đấu đã kết thúc" };
    }
    if (!player.alive) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Đang chờ hồi sinh" };
    }

    this.tickWeapon(player, now);
    const w = player.weapons[player.activeWeaponId];
    const cfg = resolveWeaponConfig(player.activeWeaponId);

    const sentFlags = Number.isInteger(msg.flags) ? (msg.flags & 0x3f) : player.flags || 0;
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

    if (now < w.nextFireAt - FIRE_JITTER_MS) {
      return { ok: false, code: ERR.RATE_LIMITED, message: "Bắn quá nhanh" };
    }

    // Firing cancels spawn invulnerability immediately per Truy Kích rules
    player.invulnerableUntil = 0;
    w.mag--;
    w.nextFireAt = now + cfg.fireInterval;
    player.lastShotAt = now;
    player.lastFiredWeaponId = w.id;
    player.pendingHitCredit = 1;

    const origin = finiteVec3(msg.origin)
      ? msg.origin
      : { x: player.x, y: player.y + (player.flags & FLAG.CROUCH ? 1.12 : 1.7), z: player.z };
    const dir = finiteVec3(msg.dir) ? msg.dir : { x: 0, y: 0, z: -1 };

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
      origin,
      dir,
    });

    if (w.mag === 0) {
      this.handleReload(player, now);
    }

    return { ok: true, weaponId: w.id, mag: w.mag };
  }

  handleHit(shooter, msg, now) {
    if (this.room.state !== ROOM_STATE.PLAYING) {
      return { ok: false, code: ERR.MATCH_ENDED, message: "Trận đấu đã kết thúc" };
    }
    if (!shooter.alive || shooter.pendingHitCredit <= 0) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Phát bắn không hợp lệ" };
    }

    const victim = this.room.players.get(String(msg.targetId || ""));
    if (!victim || !victim.alive) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Mục tiêu không tồn tại hoặc đã bị hạ" };
    }
    if (!this.room.modeImpl.canDamage(shooter, victim)) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Không thể gây sát thương lên đồng đội" };
    }
    if (now < victim.invulnerableUntil) {
      shooter.pendingHitCredit = 0;
      this.room.sendTo(shooter.id, {
        type: MSG.EVENT_HIT,
        shooterId: shooter.id,
        targetId: victim.id,
        part: "shield",
        damage: 0,
        hp: victim.hp,
      });
      return { ok: true, shielded: true };
    }

    const weaponCfg = resolveWeaponConfig(shooter.lastFiredWeaponId || shooter.activeWeaponId);
    const dist = Math.hypot(victim.x - shooter.x, victim.y - shooter.y, victim.z - shooter.z);
    if (dist > weaponCfg.maxRange) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Ngoài tầm bắn vũ khí" };
    }

    // Posture-aware wall occlusion check (crouching lowers both head and torso hitboxes)
    const arena = this.room.arena;
    const shooterEyeY = shooter.y + (shooter.flags & FLAG.CROUCH ? 1.12 : 1.7);
    const victimCrouch = Boolean(victim.flags & FLAG.CROUCH);
    const victimTorsoY = victim.y + (victimCrouch ? 0.72 : 1.25);
    const victimHeadY = victim.y + (victimCrouch ? 1.08 : 1.63);
    const canHitTorso = hasLineOfSight(shooter.x, shooterEyeY, shooter.z, victim.x, victimTorsoY, victim.z, arena);
    const canHitHead = hasLineOfSight(shooter.x, shooterEyeY, shooter.z, victim.x, victimHeadY, victim.z, arena);
    if (!canHitTorso && !canHitHead) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Bị vật cản che khuất" };
    }

    shooter.pendingHitCredit = 0;
    const part = msg.part === "head" || msg.part === "limb" ? msg.part : "body";
    const damage = weaponCfg.damage[part];
    victim.hp = Math.max(0, victim.hp - damage);

    this.room.broadcast({
      type: MSG.EVENT_HIT,
      shooterId: shooter.id,
      targetId: victim.id,
      part,
      damage,
      hp: victim.hp,
    });

    if (victim.hp <= 0) {
      victim.alive = false;
      this._cancelReload(victim);
      victim.flags = 0;
      victim.prevFlags = 0;
      victim.ads = false;
      victim.deaths++;
      victim.respawnAt = now + RESPAWN_DELAY_MS;
      shooter.kills++;
      if (part === "head") shooter.headshots++;

      const res = this.room.modeImpl.onKill(this.room, shooter);
      this.room.broadcast({
        type: MSG.EVENT_KILL,
        killerId: shooter.id,
        killer: shooter.name,
        killerTeam: shooter.team,
        victimId: victim.id,
        victim: victim.name,
        victimTeam: victim.team,
        weapon: weaponCfg.name,
        weaponId: weaponCfg.id,
        head: part === "head",
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

    return { ok: true, damage, hp: victim.hp };
  }

  step(now) {
    if (this.room.state !== ROOM_STATE.PLAYING) return;

    for (const p of this.room.players.values()) {
      if (p.alive) {
        this.tickWeapon(p, now);
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
          invulnerableMs: INVULNERABLE_MS,
        });
      }
    }

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
      players.push({
        id: p.id,
        name: p.name,
        team: p.team,
        connected: p.connected,
        x: Number(p.x.toFixed(3)),
        y: Number(p.y.toFixed(3)),
        z: Number(p.z.toFixed(3)),
        yaw: Number(p.yaw.toFixed(4)),
        pitch: Number(p.pitch.toFixed(4)),
        mv: Number((p.mv || 0).toFixed(2)),
        ads: Boolean(p.ads),
        laser: Boolean(p.laser),
        flags: p.flags || 0,
        weaponId: p.activeWeaponId || "m416",
        alive: p.alive,
        hp: p.hp,
        ammo: activeW ? activeW.mag : 0,
        reloading,
        invulnerable: p.alive && now < p.invulnerableUntil,
        respawnMs: p.alive ? 0 : Math.max(0, p.respawnAt - now),
        kills: p.kills,
        deaths: p.deaths,
        headshots: p.headshots,
      });
    }
    return {
      type: MSG.SNAPSHOT,
      t: now,
      roomId: this.room.id,
      state: this.room.state,
      mode: this.room.mode,
      killLimit: this.room.killLimit,
      timeLeftSec:
        this.room.state === ROOM_STATE.PLAYING
          ? Math.max(0, Math.ceil((this.matchEndsAt - now) / 1000))
          : 0,
      teamScores: { ...this.room.teamScores },
      players,
    };
  }
}
