/**
 * Pure helper utilities for the 3D Tactical Lobby & Bot Match setup controller.
 * Kept dependency-free so both browser ESM and Node tests can import directly.
 */

const VALID_LOBBY_VIEWS = new Set(["home", "practice", "survival", "bot", "lan"]);

/**
 * Filter room summaries by game mode ("FFA", "TDM", or "ALL").
 * @param {Array<object>} rooms
 * @param {string} modeFilter
 * @returns {Array<object>}
 */
export function filterRoomsByMode(rooms, modeFilter = "ALL") {
  const list = Array.isArray(rooms) ? rooms : [];
  if (modeFilter !== "FFA" && modeFilter !== "TDM") return list;
  return list.filter((r) => r && r.mode === modeFilter);
}

/**
 * Normalize lobby sub-view name to a supported state.
 * @param {string} viewName
 * @returns {"home" | "practice" | "survival" | "bot" | "lan"}
 */
export function normalizeLobbyView(viewName) {
  return VALID_LOBBY_VIEWS.has(viewName) ? viewName : "home";
}

/**
 * Summarize offline Bot match roster sizes cleanly for TDM (balanced NvN) and FFA.
 * @param {{ mode?: string, botCount?: number }} opts
 */
export function computeBotTeamSummary({ mode = "TDM", botCount = 5 } = {}) {
  const safeMode = mode === "FFA" ? "FFA" : "TDM";
  const raw = Number(botCount);
  let count = Number.isFinite(raw) ? Math.max(1, Math.min(11, Math.round(raw))) : 5;
  if (safeMode === "TDM" && count % 2 === 0) {
    count = count < 11 ? count + 1 : 9;
  }
  if (safeMode === "TDM") {
    const perSide = (count + 1) / 2;
    const allies = Math.max(0, perSide - 1);
    const enemies = count - allies;
    return {
      mode: "TDM",
      botCount: count,
      allies,
      enemies,
      totalPlayers: count + 1,
      teamLabel: `${perSide}v${perSide}`,
      summaryText: `${perSide}v${perSide} • Bạn + ${allies} Đồng đội vs ${enemies} Bot địch`,
    };
  }
  return {
    mode: "FFA",
    botCount: count,
    allies: 0,
    enemies: count,
    totalPlayers: count + 1,
    teamLabel: `${count + 1} Chiến binh`,
    summaryText: `Tự do • Bạn vs ${count} Bot SWAT`,
  };
}
