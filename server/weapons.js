/**
 * Shared client/server weapon configuration, tactical/empty reload durations,
 * player posture flags, and speed/spread rules.
 * Must stay dependency-free so both Node.js and browser ES modules can import it.
 */

export const FLAG = Object.freeze({
  CROUCH: 1 << 0,
  ADS: 1 << 1,
  SPRINT: 1 << 2,
  AIR: 1 << 3,
  FIRING: 1 << 4,
  RELOADING: 1 << 5,
});

export const TEAM_META = Object.freeze({
  A: Object.freeze({
    id: "A",
    name: "Đặc Nhiệm",
    short: "Xanh",
    symbol: "▲",
    hex: "#2F80FF",
    colorNum: 0x2f80ff,
  }),
  B: Object.freeze({
    id: "B",
    name: "Nổi Loạn",
    short: "Cam Đỏ",
    symbol: "●",
    hex: "#FF4D2E",
    colorNum: 0xff4d2e,
  }),
  FFA: Object.freeze({
    id: "FFA",
    name: "Đấu Đơn",
    short: "Độc lập",
    symbol: "◆",
    hex: "#8A8F98",
    colorNum: 0x8a8f98,
  }),
});

export const BASE_MOVE_SPEED = 5.8;

export const WEAPON_SLOTS = Object.freeze([1, 2, 3]);

export const WEAPONS = Object.freeze({
  m416: Object.freeze({
    id: "m416",
    slot: 1,
    name: "M416",
    magSize: 30,
    fireInterval: 86,
    tacticalReloadTime: 1850,
    reloadTime: 2400,
    auto: true,
    maxRange: 120,
    baseSpread: 0.006,
    adsSpread: 0.0006,
    adsFov: 55,
    scopeOverlay: false,
    recoil: 0.07,
    kickHip: 0.014,
    kickAds: 0.0085,
    damage: Object.freeze({ head: 100, body: 28, limb: 20 }),
  }),
  pistol: Object.freeze({
    id: "pistol",
    slot: 2,
    name: "Glock-17",
    magSize: 15,
    fireInterval: 180,
    tacticalReloadTime: 1250,
    reloadTime: 1600,
    auto: false,
    maxRange: 85,
    baseSpread: 0.007,
    adsSpread: 0.001,
    adsFov: 60,
    scopeOverlay: false,
    recoil: 0.055,
    kickHip: 0.016,
    kickAds: 0.01,
    damage: Object.freeze({ head: 72, body: 22, limb: 16 }),
  }),
  sniper: Object.freeze({
    id: "sniper",
    slot: 3,
    name: "AWM Sniper",
    magSize: 5,
    fireInterval: 1300,
    tacticalReloadTime: 2550,
    reloadTime: 3200,
    auto: false,
    maxRange: 180,
    baseSpread: 0.042,
    adsSpread: 0.0002,
    adsFov: 24,
    scopeOverlay: true,
    recoil: 0.14,
    kickHip: 0.042,
    kickAds: 0.028,
    damage: Object.freeze({ head: 160, body: 95, limb: 65 }),
  }),
});

export const SLOT_TO_WEAPON_ID = Object.freeze({
  1: "m416",
  2: "pistol",
  3: "sniper",
});

export function resolveWeaponConfig(idOrSlot) {
  if (typeof idOrSlot === "number" && SLOT_TO_WEAPON_ID[idOrSlot]) {
    return WEAPONS[SLOT_TO_WEAPON_ID[idOrSlot]];
  }
  const key = String(idOrSlot || "").toLowerCase();
  if (WEAPONS[key]) return WEAPONS[key];
  const slotNum = Number(idOrSlot);
  if (Number.isInteger(slotNum) && SLOT_TO_WEAPON_ID[slotNum]) {
    return WEAPONS[SLOT_TO_WEAPON_ID[slotNum]];
  }
  return WEAPONS.m416;
}

/**
 * Tactical reload (mag > 0) skips charging handle / bolt release and finishes faster.
 */
export function getReloadDurationMs(weaponOrId, currentMag) {
  const cfg = typeof weaponOrId === "string" ? resolveWeaponConfig(weaponOrId) : weaponOrId;
  if (!cfg) return 2400;
  return currentMag > 0 && currentMag < cfg.magSize
    ? cfg.tacticalReloadTime
    : cfg.reloadTime;
}

export function createDefaultWeaponsState() {
  const out = {};
  for (const slot of WEAPON_SLOTS) {
    const wid = SLOT_TO_WEAPON_ID[slot];
    const cfg = WEAPONS[wid];
    out[wid] = {
      id: wid,
      slot,
      mag: cfg.magSize,
      nextFireAt: 0,
      reloadEndsAt: 0,
      reloadDuration: 0,
    };
  }
  return out;
}

export function getMoveSpeedMultiplier(flags = 0) {
  if (flags & FLAG.CROUCH) return 0.55;
  if (flags & FLAG.ADS) return 0.65;
  if (flags & FLAG.SPRINT) return 1.35;
  return 1.0;
}

export function computeWeaponSpread(weaponOrId, flags = 0) {
  const cfg = typeof weaponOrId === "string" ? resolveWeaponConfig(weaponOrId) : weaponOrId;
  const ads = Boolean(flags & FLAG.ADS);
  let spread = ads ? cfg.adsSpread : cfg.baseSpread;
  if (flags & FLAG.CROUCH) spread *= 0.7;
  if (flags & FLAG.AIR) spread *= 2.0;
  return spread;
}

