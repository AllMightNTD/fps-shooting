/**
 * Team Deathmatch (TDM) mode rules: balanced squads, no friendly fire, team score victory.
 */

import { ERR } from "../protocol.js";
import { pickTeamSpawn } from "../spawn.js";

export const TDMMode = {
  id: "TDM",
  label: "Đấu Đội (TDM)",

  assignTeamOnJoin(room, preferredTeam = null) {
    const capPerTeam = Math.max(1, Math.floor(room.maxPlayers / 2));
    const counts = this.getTeamCounts(room);
    if (
      (preferredTeam === "A" || preferredTeam === "B") &&
      counts[preferredTeam] < capPerTeam
    ) {
      const other = preferredTeam === "A" ? "B" : "A";
      if (counts[preferredTeam] - counts[other] < 1) {
        return preferredTeam;
      }
    }
    if (counts.A <= counts.B && counts.A < capPerTeam) return "A";
    if (counts.B < capPerTeam) return "B";
    return counts.A < capPerTeam ? "A" : "A";
  },

  getTeamCounts(room) {
    let A = 0;
    let B = 0;
    for (const p of room.players.values()) {
      if (p.team === "A") A++;
      else if (p.team === "B") B++;
    }
    return { A, B };
  },

  canSwitchTeam(room, player, targetTeam) {
    if (targetTeam !== "A" && targetTeam !== "B") {
      return { ok: false, code: ERR.BAD_REQUEST, message: "Đội không hợp lệ" };
    }
    if (player.team === targetTeam) {
      return { ok: true };
    }
    const capPerTeam = Math.max(1, Math.floor(room.maxPlayers / 2));
    const counts = this.getTeamCounts(room);
    if (counts[targetTeam] >= capPerTeam) {
      return { ok: false, code: ERR.TEAM_FULL, message: `Đội ${targetTeam} đã đủ ${capPerTeam} người` };
    }
    const other = targetTeam === "A" ? "B" : "A";
    const afterTarget = counts[targetTeam] + 1;
    const afterOther = counts[other] - 1;
    // Block joining a team that would lead the other by >= 2 players
    if (afterTarget - afterOther >= 2) {
      return {
        ok: false,
        code: ERR.TEAM_IMBALANCE,
        message: "Không thể chuyển sang đội đang nhiều hơn từ 2 người trở lên",
      };
    }
    return { ok: true };
  },

  canStart(room) {
    const counts = this.getTeamCounts(room);
    if (!room.allowSoloTest && (counts.A < 1 || counts.B < 1)) {
      return {
        ok: false,
        code: ERR.NOT_ENOUGH_PLAYERS,
        message: "Đấu Đội cần mỗi phe ít nhất 1 người (hoặc bật Test 1 người)",
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
    return shooter.id !== victim.id && shooter.team !== victim.team;
  },

  pickSpawn(room, player) {
    return pickTeamSpawn(room.arena, player.team, room.players, player.id);
  },

  onKill(room, killer) {
    room.teamScores[killer.team] = (room.teamScores[killer.team] || 0) + 1;
    if (room.teamScores[killer.team] >= room.killLimit) {
      return { matchWinner: killer.team };
    }
    return null;
  },

  resolveTimeExpiredWinner(room) {
    if (room.teamScores.A > room.teamScores.B) return "A";
    if (room.teamScores.B > room.teamScores.A) return "B";
    return "DRAW";
  },
};

