/**
 * Free-For-All (FFA) mode rules: every warrior for themselves, killLimit or highest kills wins.
 */

import { ERR } from "../protocol.js";
import { pickFfaSpawn } from "../spawn.js";

export const FFAMode = {
  id: "FFA",
  label: "Đấu Đơn (FFA)",

  assignTeamOnJoin() {
    return null;
  },

  canSwitchTeam() {
    return { ok: false, code: ERR.INVALID_STATE, message: "Chế độ Đấu Đơn không chia đội" };
  },

  canStart(room) {
    if (!room.allowSoloTest && room.players.size < 2) {
      return {
        ok: false,
        code: ERR.NOT_ENOUGH_PLAYERS,
        message: "Đấu Đơn cần ít nhất 2 người chơi (hoặc bật Test 1 người)",
      };
    }
    if (room.players.size < 1) {
      return { ok: false, code: ERR.NOT_ENOUGH_PLAYERS, message: "Phòng chưa có người chơi" };
    }
    for (const p of room.players.values()) {
      if (p.id !== room.hostId && p.connected && !p.ready) {
        return { ok: false, code: ERR.NOT_READY, message: `${p.name} chưa bấm Sẵn sàng` };
      }
    }
    return { ok: true };
  },

  canDamage(shooter, victim) {
    return shooter.id !== victim.id;
  },

  pickSpawn(room, player, now = 0, tracker = null) {
    return pickFfaSpawn(room.arena, room.players, player.id, now, tracker, player);
  },

  onKill(room, killer) {
    if (killer.kills >= room.killLimit) {
      return { matchWinner: killer.name };
    }
    return null;
  },

  resolveTimeExpiredWinner(room) {
    const sorted = room.getScoreboard();
    if (!sorted.length || sorted[0].kills === 0) return "DRAW";
    if (sorted.length > 1 && sorted[1].kills === sorted[0].kills) return "DRAW";
    return sorted[0].name;
  },
};

