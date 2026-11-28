/**
 * 3D Tactical Lobby UI Controller:
 * - Main Lobby (Đấu Đơn / Đấu Đội / Luyện Tập) with animated view transitions
 * - Practice Hub (Đấu với Máy / Sinh tồn Drone)
 * - Bot Match Configurator (Đấu Đơn FFA / Đấu Đội TDM + 3D Map Cards + Quick Settings Bar)
 * - Survival Map Selection (2 visual map thumbnails: Khu Quân Sự Cũ / Bến Cảng Mưa)
 * - Filtered LAN Room List (FFA / TDM / All) + Thumbnail map picker inside "+ Tạo phòng"
 */

import { MSG } from "/js/protocol.js";
import { computeBotTeamSummary, filterRoomsByMode, normalizeLobbyView } from "./lobby_utils.js";
import { isPrivateOrLocalHost, resolveOnlineShareUrl } from "./net_utils.js";

export { computeBotTeamSummary, filterRoomsByMode, normalizeLobbyView };

function makeEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const STATE_LABEL = {
  WAITING: "Chờ",
  STARTING: "Đếm ngược",
  PLAYING: "Đang chơi",
  ENDING: "Tổng kết",
};

export function createLobbyController({
  net,
  getNickFn,
  onEnterSolo,
  onEnterBots,
  onSelectSoloMap,
  onViewChange = null,
  isMapCachedFn = null,
  onError,
}) {
  const screenLobbyEl = document.getElementById("screenLobby");
  const homeViewEl = document.getElementById("lobbyHomeView");
  const practiceViewEl = document.getElementById("lobbyPracticeView");
  const survivalViewEl = document.getElementById("lobbySurvivalView");
  const botViewEl = document.getElementById("lobbyBotView");
  const lanViewEl = document.getElementById("lobbyLanView");

  const tbody = document.getElementById("lobbyRoomBody");
  const emptyNote = document.getElementById("lobbyEmpty");
  const createForm = document.getElementById("createRoomPanel");
  const pwBox = document.getElementById("pwModal");
  const pwInput = document.getElementById("pwJoinInput");
  const shareBanner = document.getElementById("lanShare");
  const shareText = document.getElementById("lanShareText");
  const copyBtn = document.getElementById("btnCopyUrl");
  const soloMapEl = document.getElementById("soloMapSelect");
  const createMapEl = document.getElementById("createMap");
  const createModeEl = document.getElementById("createMode");
  const createNameEl = document.getElementById("createRoomName");

  const lanViewTitleEl = document.getElementById("lanViewTitle");
  const lanModeHintEl = document.getElementById("lanModeHint");
  const tabButtons = Array.from(document.querySelectorAll(".lanModeTab"));
  const practiceCards = Array.from(document.querySelectorAll("#practiceMapGrid .mapThumbCard"));
  const botMapCards = Array.from(document.querySelectorAll("#botMapGrid .mapThumbCard"));
  const createMapCards = Array.from(document.querySelectorAll("#createMapPicker .createMapThumb"));
  const milReadyChip = document.getElementById("milReadyChip");
  const harborReadyChip = document.getElementById("harborReadyChip");
  const botMilReadyChip = document.getElementById("botMilReadyChip");
  const botHarborReadyChip = document.getElementById("botHarborReadyChip");

  const botModeBtns = Array.from(document.querySelectorAll("[data-bot-mode]"));
  const botDiffBtns = Array.from(document.querySelectorAll("[data-bot-diff]"));
  const botCountEl = document.getElementById("botCountSelect");
  const botKillsEl = document.getElementById("botKillsSelect");
  const botTeamSummaryEl = document.getElementById("botTeamSummary");

  let activeView = "home"; // "home" | "practice" | "survival" | "bot" | "lan"
  let activeModeFilter = "TDM"; // "FFA" | "TDM" | "ALL"
  let selectedPracticeMap = "military";
  let botConfig = {
    mode: "TDM",
    mapId: "military",
    difficulty: "medium",
    botCount: 5,
    killLimit: 30,
  };
  let pendingJoinRoomId = null;
  let currentRooms = [];

  try {
    const qpMap = new URLSearchParams(location.search).get("map");
    if (qpMap === "harbor" || qpMap === "military") {
      selectedPracticeMap = qpMap;
      botConfig.mapId = qpMap;
      if (soloMapEl) soloMapEl.value = qpMap;
      if (createMapEl) createMapEl.value = qpMap;
    }
  } catch {}

  function syncPracticeCardUI() {
    const harborCached = typeof isMapCachedFn === "function" ? isMapCachedFn("harbor") : false;
    for (const card of practiceCards) {
      const mId = card.dataset.map;
      const isSel = mId === selectedPracticeMap;
      card.classList.toggle("selected", isSel);
      card.setAttribute("aria-pressed", isSel ? "true" : "false");
    }
    if (milReadyChip) {
      milReadyChip.textContent = selectedPracticeMap === "military" ? "ĐANG CHỌN • SẴN SÀNG" : "SẴN SÀNG";
    }
    if (harborReadyChip) {
      harborReadyChip.textContent =
        selectedPracticeMap === "harbor"
          ? (harborCached ? "ĐANG CHỌN • SẴN SÀNG" : "ĐANG NẠP...")
          : (harborCached ? "ĐÃ SẴN SÀNG" : "CHỌN ĐỂ NẠP");
    }
    if (soloMapEl && soloMapEl.value !== selectedPracticeMap) {
      soloMapEl.value = selectedPracticeMap;
    }
  }

  function syncBotSetupUI() {
    const harborCached = typeof isMapCachedFn === "function" ? isMapCachedFn("harbor") : false;
    for (const btn of botModeBtns) {
      const isSel = btn.dataset.botMode === botConfig.mode;
      btn.classList.toggle("selected", isSel);
      btn.setAttribute("aria-pressed", isSel ? "true" : "false");
    }
    for (const btn of botDiffBtns) {
      const isSel = btn.dataset.botDiff === botConfig.difficulty;
      btn.classList.toggle("active", isSel);
      btn.setAttribute("aria-pressed", isSel ? "true" : "false");
    }
    for (const card of botMapCards) {
      const isSel = card.dataset.botMap === botConfig.mapId;
      card.classList.toggle("selected", isSel);
      card.setAttribute("aria-pressed", isSel ? "true" : "false");
    }
    if (botMilReadyChip) {
      botMilReadyChip.textContent = botConfig.mapId === "military" ? "ĐANG CHỌN • SẴN SÀNG" : "SẴN SÀNG";
    }
    if (botHarborReadyChip) {
      botHarborReadyChip.textContent =
        botConfig.mapId === "harbor"
          ? (harborCached ? "ĐANG CHỌN • SẴN SÀNG" : "ĐANG NẠP...")
          : (harborCached ? "ĐÃ SẴN SÀNG" : "CHỌN ĐỂ NẠP");
    }
    if (botCountEl) botCountEl.value = String(botConfig.botCount);
    if (botKillsEl) botKillsEl.value = String(botConfig.killLimit);
    if (botTeamSummaryEl) {
      const sum = computeBotTeamSummary({ mode: botConfig.mode, botCount: botConfig.botCount });
      botTeamSummaryEl.textContent = sum.summaryText;
    }
  }

  function syncCreateMapUI(mapId) {
    const safeMap = mapId === "harbor" ? "harbor" : "military";
    if (createMapEl) createMapEl.value = safeMap;
    for (const btn of createMapCards) {
      const isSel = btn.dataset.createMap === safeMap;
      btn.classList.toggle("selected", isSel);
      const span = btn.querySelector("span");
      if (span) {
        span.textContent =
          btn.dataset.createMap === "military"
            ? `${isSel ? "✓ " : ""}Khu Quân Sự Cũ (5v5)`
            : `${isSel ? "✓ " : ""}Bến Cảng Mưa`;
      }
    }
  }

  function setLobbyView(nextView) {
    const safe = normalizeLobbyView(nextView);
    activeView = safe;
    if (screenLobbyEl) screenLobbyEl.dataset.lobbyView = safe;
    if (homeViewEl) homeViewEl.classList.toggle("active", safe === "home");
    if (practiceViewEl) practiceViewEl.classList.toggle("active", safe === "practice");
    if (survivalViewEl) survivalViewEl.classList.toggle("active", safe === "survival");
    if (botViewEl) botViewEl.classList.toggle("active", safe === "bot");
    if (lanViewEl) lanViewEl.classList.toggle("active", safe === "lan");
    if (safe === "survival") syncPracticeCardUI();
    if (safe === "bot") syncBotSetupUI();
    if (typeof onViewChange === "function") onViewChange(safe);
  }

  function setModeFilter(mode) {
    activeModeFilter = mode === "FFA" || mode === "TDM" ? mode : "ALL";
    for (const btn of tabButtons) {
      btn.classList.toggle("active", btn.dataset.filter === activeModeFilter);
    }
    if (lanViewTitleEl) {
      lanViewTitleEl.textContent =
        activeModeFilter === "FFA"
          ? "Phòng Đấu Đơn (FFA)"
          : activeModeFilter === "TDM"
            ? "Phòng Đấu Đội (TDM)"
            : "Tất cả phòng đấu";
    }
    if (lanModeHintEl) {
      lanModeHintEl.textContent =
        activeModeFilter === "ALL"
          ? "Đang hiển thị cả phòng Đấu Đội & Đấu Đơn"
          : `Đang lọc phòng chế độ ${activeModeFilter}`;
    }
    if (activeModeFilter === "FFA" || activeModeFilter === "TDM") {
      if (createModeEl) createModeEl.value = activeModeFilter;
      if (createNameEl && (!createNameEl.value || createNameEl.value.startsWith("Khu Quân Sự "))) {
        createNameEl.value = `Khu Quân Sự ${activeModeFilter}`;
      }
    }
    renderRooms(currentRooms);
  }

  function bindShareBanner(label, shareUrl) {
    if (!shareUrl) return;
    if (shareBanner) shareBanner.style.display = "flex";
    if (shareText) shareText.textContent = `${label}: ${shareUrl}`;
    if (copyBtn) {
      copyBtn.onclick = () => {
        if (navigator.clipboard) navigator.clipboard.writeText(shareUrl).catch(() => {});
        copyBtn.textContent = "Đã copy!";
        setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
      };
    }
  }

  function fetchLanUrls() {
    if (!location.protocol.startsWith("http")) return;
    if (!isPrivateOrLocalHost(location.hostname)) {
      const publicUrl = resolveOnlineShareUrl(location);
      bindShareBanner("Link mời bạn", publicUrl);
      return;
    }
    fetch("/api/lan-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info || !Array.isArray(info.urls) || !info.urls.length) {
          bindShareBanner("Link mời bạn", resolveOnlineShareUrl(location));
          return;
        }
        bindShareBanner("Link LAN", info.urls[0]);
      })
      .catch(() => {
        bindShareBanner("Link mời bạn", resolveOnlineShareUrl(location));
      });
  }

  function renderRooms(rooms) {
    currentRooms = Array.isArray(rooms) ? rooms : [];
    const visible = filterRoomsByMode(currentRooms, activeModeFilter);
    tbody.textContent = "";
    emptyNote.style.display = visible.length ? "none" : "block";

    for (const r of visible) {
      const tr = document.createElement("tr");
      const nameTd = makeEl("td", "", (r.hasPassword ? "[Khóa] " : "") + r.name);
      const modeTd = makeEl("td", "", r.mode === "FFA" ? "Đấu Đơn (FFA)" : "Đấu Đội (TDM)");
      const mapTd = makeEl("td", "", r.map === "harbor" ? "Bến Cảng Mưa" : r.map === "military" ? "Khu Quân Sự Cũ" : r.map);
      const countTd = makeEl("td", "", `${r.playerCount}/${r.maxPlayers}`);
      const stTd = makeEl("td", "", STATE_LABEL[r.state] || r.state);
      stTd.style.color = r.state === "WAITING" ? "#4ec3b0" : "#f0b429";

      const actTd = document.createElement("td");
      const btn = makeEl("button", "", "Vào phòng");
      btn.type = "button";
      btn.className = "btnSm";
      btn.disabled = r.playerCount >= r.maxPlayers || r.state === "STARTING" || r.state === "ENDING";
      btn.onclick = () => {
        if (r.hasPassword) {
          pendingJoinRoomId = r.id;
          pwInput.value = "";
          pwBox.style.display = "flex";
          pwInput.focus();
        } else {
          net.send(MSG.ROOM_JOIN, { roomId: r.id, playerName: getNickFn() });
        }
      };
      actTd.append(btn);
      tr.append(nameTd, modeTd, mapTd, countTd, stTd, actTd);
      tbody.append(tr);
    }
  }

  // Home View Navigation
  const btnModeFFA = document.getElementById("btnModeFFA");
  const btnModeTDM = document.getElementById("btnModeTDM");
  const btnModePractice = document.getElementById("btnModePractice");
  const btnPracticeBack = document.getElementById("btnPracticeBack");
  const btnPracticeBots = document.getElementById("btnPracticeBots");
  const btnPracticeSurvival = document.getElementById("btnPracticeSurvival");
  const btnSurvivalBack = document.getElementById("btnSurvivalBack");
  const btnBotBack = document.getElementById("btnBotBack");
  const btnLanBack = document.getElementById("btnLanBack");

  if (btnModeFFA) {
    btnModeFFA.onclick = () => {
      setModeFilter("FFA");
      setLobbyView("lan");
    };
  }
  if (btnModeTDM) {
    btnModeTDM.onclick = () => {
      setModeFilter("TDM");
      setLobbyView("lan");
    };
  }
  if (btnModePractice) btnModePractice.onclick = () => setLobbyView("practice");
  if (btnPracticeBack) btnPracticeBack.onclick = () => setLobbyView("home");
  if (btnPracticeBots) btnPracticeBots.onclick = () => setLobbyView("bot");
  if (btnPracticeSurvival) btnPracticeSurvival.onclick = () => setLobbyView("survival");
  if (btnSurvivalBack) btnSurvivalBack.onclick = () => setLobbyView("practice");
  if (btnBotBack) btnBotBack.onclick = () => setLobbyView("practice");
  if (btnLanBack) {
    btnLanBack.onclick = () => {
      if (createForm) createForm.style.display = "none";
      setLobbyView("home");
    };
  }
  for (const btn of tabButtons) {
    btn.onclick = () => setModeFilter(btn.dataset.filter || "ALL");
  }

  // Survival Map Selection & Instant Launch
  const btnSoloMode = document.getElementById("btnSoloMode");
  const defaultSoloBtnText = btnSoloMode ? btnSoloMode.textContent : "BẮT ĐẦU SINH TỒN";
  let soloMapSwitchToken = 0;
  let isSwitchingSoloMap = false;

  function selectPracticeMap(targetMap, triggerLaunch = false) {
    const safeMap = targetMap === "harbor" ? "harbor" : "military";
    const alreadySelected = selectedPracticeMap === safeMap;
    selectedPracticeMap = safeMap;
    syncPracticeCardUI();

    if (alreadySelected && typeof isMapCachedFn === "function" && isMapCachedFn(safeMap)) {
      if (triggerLaunch) onEnterSolo(safeMap);
      return Promise.resolve();
    }
    if (typeof onSelectSoloMap !== "function") {
      if (triggerLaunch) onEnterSolo(safeMap);
      return Promise.resolve();
    }

    const token = ++soloMapSwitchToken;
    isSwitchingSoloMap = true;
    if (btnSoloMode) {
      btnSoloMode.disabled = true;
      btnSoloMode.textContent = "Đang tải bản đồ...";
    }
    return Promise.resolve(onSelectSoloMap(safeMap))
      .then(() => {
        if (token === soloMapSwitchToken) {
          syncPracticeCardUI();
          if (triggerLaunch) onEnterSolo(safeMap);
        }
      })
      .catch((err) => {
        console.error("Solo map switch failed:", err);
        if (typeof onError === "function") onError("Không thể chuyển bản đồ, vui lòng thử lại.");
      })
      .finally(() => {
        if (token !== soloMapSwitchToken) return;
        isSwitchingSoloMap = false;
        if (btnSoloMode) {
          btnSoloMode.disabled = false;
          btnSoloMode.textContent = defaultSoloBtnText;
        }
        syncPracticeCardUI();
      });
  }

  for (const card of practiceCards) {
    card.onclick = () => selectPracticeMap(card.dataset.map, false);
    card.ondblclick = () => selectPracticeMap(card.dataset.map, true);
  }
  if (soloMapEl) {
    soloMapEl.addEventListener("change", () => selectPracticeMap(soloMapEl.value, false));
  }
  if (btnSoloMode) {
    btnSoloMode.onclick = () => {
      if (isSwitchingSoloMap) return;
      onEnterSolo(selectedPracticeMap);
    };
  }

  // Bot Mode Configuration & Launch
  const btnBotStart = document.getElementById("btnBotStart");
  const defaultBotBtnText = btnBotStart ? btnBotStart.textContent : "VÀO TRẬN ĐẤU MÁY";
  let botMapSwitchToken = 0;
  let isSwitchingBotMap = false;

  function selectBotMap(targetMap, triggerLaunch = false) {
    const safeMap = targetMap === "harbor" ? "harbor" : "military";
    const alreadySelected = botConfig.mapId === safeMap;
    botConfig.mapId = safeMap;
    syncBotSetupUI();

    if (alreadySelected && typeof isMapCachedFn === "function" && isMapCachedFn(safeMap)) {
      if (triggerLaunch && typeof onEnterBots === "function") onEnterBots({ ...botConfig });
      return Promise.resolve();
    }
    if (typeof onSelectSoloMap !== "function") {
      if (triggerLaunch && typeof onEnterBots === "function") onEnterBots({ ...botConfig });
      return Promise.resolve();
    }

    const token = ++botMapSwitchToken;
    isSwitchingBotMap = true;
    if (btnBotStart) {
      btnBotStart.disabled = true;
      btnBotStart.textContent = "Đang tải bản đồ...";
    }
    return Promise.resolve(onSelectSoloMap(safeMap))
      .then(() => {
        if (token === botMapSwitchToken) {
          syncBotSetupUI();
          if (triggerLaunch && typeof onEnterBots === "function") onEnterBots({ ...botConfig });
        }
      })
      .catch((err) => {
        console.error("Bot map switch failed:", err);
        if (typeof onError === "function") onError("Không thể chuyển bản đồ, vui lòng thử lại.");
      })
      .finally(() => {
        if (token !== botMapSwitchToken) return;
        isSwitchingBotMap = false;
        if (btnBotStart) {
          btnBotStart.disabled = false;
          btnBotStart.textContent = defaultBotBtnText;
        }
        syncBotSetupUI();
      });
  }

  for (const btn of botModeBtns) {
    btn.onclick = () => {
      botConfig.mode = btn.dataset.botMode === "FFA" ? "FFA" : "TDM";
      botConfig.killLimit = botConfig.mode === "FFA" ? 20 : 30;
      syncBotSetupUI();
    };
  }
  for (const btn of botDiffBtns) {
    btn.onclick = () => {
      botConfig.difficulty = btn.dataset.botDiff || "medium";
      syncBotSetupUI();
    };
  }
  if (botCountEl) {
    botCountEl.addEventListener("change", () => {
      botConfig.botCount = Number(botCountEl.value) || 5;
      syncBotSetupUI();
    });
  }
  if (botKillsEl) {
    botKillsEl.addEventListener("change", () => {
      botConfig.killLimit = Number(botKillsEl.value) || 30;
      syncBotSetupUI();
    });
  }
  for (const card of botMapCards) {
    card.onclick = () => selectBotMap(card.dataset.botMap, false);
    card.ondblclick = () => selectBotMap(card.dataset.botMap, true);
  }
  if (btnBotStart) {
    btnBotStart.onclick = () => {
      if (isSwitchingBotMap || typeof onEnterBots !== "function") return;
      onEnterBots({ ...botConfig });
    };
  }

  // LAN Create Room Visual Map Picker & Handlers
  for (const btn of createMapCards) {
    btn.onclick = () => syncCreateMapUI(btn.dataset.createMap);
  }
  syncCreateMapUI(selectedPracticeMap);

  document.getElementById("btnOpenCreate").onclick = () => {
    const shown = createForm.style.display === "block";
    createForm.style.display = shown ? "none" : "block";
    if (!shown && (activeModeFilter === "FFA" || activeModeFilter === "TDM") && createModeEl) {
      createModeEl.value = activeModeFilter;
    }
  };

  document.getElementById("btnCreateSubmit").onclick = () => {
    if (!net.connected) {
      onError("Chưa kết nối được tới máy chủ.");
      return;
    }
    const mode = createModeEl ? createModeEl.value : "TDM";
    const roomName = (createNameEl ? createNameEl.value.trim() : "") || `Phòng Khu Quân Sự ${mode}`;
    const mapId = createMapEl ? createMapEl.value : "military";
    const killLimit = Number(document.getElementById("createKills").value) || 30;
    const timeLimit = Number(document.getElementById("createTime").value) || 600;
    const maxPlayers = Number(document.getElementById("createMaxPlayers").value) || 10;
    const password = document.getElementById("createPassword").value.trim();
    const allowSoloTest = document.getElementById("createAllowSolo").checked;

    net.send(MSG.ROOM_CREATE, {
      playerName: getNickFn(),
      name: roomName,
      mode,
      map: mapId,
      killLimit,
      timeLimit,
      maxPlayers,
      password: password || null,
      allowSoloTest,
    });
  };

  document.getElementById("btnQuickJoin").onclick = () => {
    if (!net.connected) {
      onError("Chưa kết nối được tới máy chủ.");
      return;
    }
    const payload = { playerName: getNickFn() };
    if (activeModeFilter === "FFA" || activeModeFilter === "TDM") {
      payload.mode = activeModeFilter;
    }
    net.send(MSG.ROOM_QUICK, payload);
  };

  document.getElementById("btnPwConfirm").onclick = () => {
    if (!pendingJoinRoomId) return;
    net.send(MSG.ROOM_JOIN, {
      roomId: pendingJoinRoomId,
      password: pwInput.value,
      playerName: getNickFn(),
    });
    pendingJoinRoomId = null;
    pwBox.style.display = "none";
  };

  pwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("btnPwConfirm").click();
    }
  });

  document.getElementById("btnPwCancel").onclick = () => {
    pendingJoinRoomId = null;
    pwBox.style.display = "none";
  };

  net.on(MSG.WELCOME, (msg) => renderRooms(msg.rooms));
  net.on(MSG.ROOM_LIST, (msg) => renderRooms(msg.rooms));

  setModeFilter("TDM");
  setLobbyView("home");
  fetchLanUrls();

  return {
    renderRooms,
    setLobbyView,
    setModeFilter,
    selectPracticeMap,
    selectBotMap,
    getBotConfig: () => ({ ...botConfig }),
    getState: () => ({
      activeView,
      activeModeFilter,
      selectedPracticeMap,
      botConfig: { ...botConfig },
    }),
    getRooms: () => currentRooms,
  };
}
