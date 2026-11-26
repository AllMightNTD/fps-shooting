/**
 * LAN Lobby UI controller: real-time room list, password join prompt, room creation, and quick join.
 */

import { MSG } from "/js/protocol.js";

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

export function createLobbyController({ net, getNickFn, onEnterSolo, onSelectSoloMap, onError }) {
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

  try {
    const qpMap = new URLSearchParams(location.search).get("map");
    if (qpMap === "harbor" || qpMap === "military") {
      if (soloMapEl) soloMapEl.value = qpMap;
      if (createMapEl) createMapEl.value = qpMap;
    }
  } catch {}

  let pendingJoinRoomId = null;
  let currentRooms = [];

  function fetchLanUrls() {
    if (!location.protocol.startsWith("http")) return;
    fetch("/api/lan-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info || !Array.isArray(info.urls) || !info.urls.length) return;
        const primary = info.urls[0];
        shareBanner.style.display = "flex";
        shareText.textContent = `Link LAN cho bạn bè: ${primary}`;
        copyBtn.onclick = () => {
          if (navigator.clipboard) navigator.clipboard.writeText(primary).catch(() => {});
          copyBtn.textContent = "Đã copy!";
          setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
        };
      })
      .catch(() => {});
  }

  function renderRooms(rooms) {
    currentRooms = Array.isArray(rooms) ? rooms : [];
    tbody.textContent = "";
    emptyNote.style.display = currentRooms.length ? "none" : "block";

    for (const r of currentRooms) {
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

  document.getElementById("btnOpenCreate").onclick = () => {
    const shown = createForm.style.display === "block";
    createForm.style.display = shown ? "none" : "block";
  };

  document.getElementById("btnCreateSubmit").onclick = () => {
    if (!net.connected) {
      onError("Chưa kết nối được tới máy chủ LAN.");
      return;
    }
    const roomName = document.getElementById("createRoomName").value.trim() || "Phòng Khu Quân Sự";
    const mapId = createMapEl ? createMapEl.value : "military";
    const mode = document.getElementById("createMode").value;
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
      onError("Chưa kết nối được tới máy chủ LAN.");
      return;
    }
    net.send(MSG.ROOM_QUICK, { playerName: getNickFn() });
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

  const btnSoloMode = document.getElementById("btnSoloMode");
  const defaultSoloBtnText = btnSoloMode ? btnSoloMode.textContent : "Luyện tập Offline (Drone)";
  let soloMapSwitchToken = 0;
  let isSwitchingSoloMap = false;

  // Step 4: Preload, warmup & cache map immediately when dropdown changes (before Pointer Lock click!)
  if (soloMapEl && typeof onSelectSoloMap === "function") {
    soloMapEl.addEventListener("change", () => {
      const targetMap = soloMapEl.value;
      const token = ++soloMapSwitchToken;
      isSwitchingSoloMap = true;
      if (btnSoloMode) {
        btnSoloMode.disabled = true;
        btnSoloMode.textContent = "Đang tải bản đồ...";
      }
      Promise.resolve(onSelectSoloMap(targetMap))
        .catch((err) => {
          console.error("Solo map switch failed:", err);
          if (typeof onError === "function") {
            onError("Không thể chuyển bản đồ, vui lòng thử lại.");
          }
        })
        .finally(() => {
          if (token !== soloMapSwitchToken) return;
          isSwitchingSoloMap = false;
          if (btnSoloMode) {
            btnSoloMode.disabled = false;
            btnSoloMode.textContent = defaultSoloBtnText;
          }
        });
    });
  }

  if (btnSoloMode) {
    btnSoloMode.onclick = () => {
      if (isSwitchingSoloMap) return;
      onEnterSolo(soloMapEl ? soloMapEl.value : "military");
    };
  }

  net.on(MSG.WELCOME, (msg) => renderRooms(msg.rooms));
  net.on(MSG.ROOM_LIST, (msg) => renderRooms(msg.rooms));

  fetchLanUrls();

  return {
    renderRooms,
    getRooms: () => currentRooms,
  };
}

