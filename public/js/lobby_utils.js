/**
 * Pure helper utilities for the 3D Tactical Lobby controller.
 * Kept dependency-free so both browser ESM and Node tests can import directly.
 */

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
 * @returns {"home" | "practice" | "lan"}
 */
export function normalizeLobbyView(viewName) {
  return viewName === "practice" || viewName === "lan" ? viewName : "home";
}

