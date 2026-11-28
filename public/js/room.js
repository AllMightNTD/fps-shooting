/**
 * Waiting Room (Truy Kích 2-team / FFA roster), Host settings, Ready/Kick/Chat, and Ending Results UI.
 */

import { MSG, ROOM_STATE } from "/js/protocol.js";
import { TEAM_META } from "/js/weapons.js";

function makeEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createRoomController({ net, onNotice }) {
  const titleEl = document.getElementById("roomTitle");
  const metaEl = document.getElementById("roomMeta");
  const teamColsEl = document.getElementById("roomTeamCols");
  const ffaColEl = document.getElementById("roomFfaCol");
  const listTeamA = document.getElementById("teamAList");
  const listTeamB = document.getElementById("teamBList");
  const listFfa = document.getElementById("ffaList");
  const countdownEl = document.getElementById("roomCountdown");

  const setMapEl = document.getElementById("roomSetMap");
  const setModeEl = document.getElementById("roomSetMode");
  const setKillEl = document.getElementById("roomSetKills");
  const setTimeEl = document.getElementById("roomSetTime");
  const setMaxEl = document.getElementById("roomSetMax");
  const setPwEl = document.getElementById("roomSetPassword");
  const setSoloEl = document.getElementById("roomSetSolo");
  const btnSaveSettings = document.getElementById("btnSaveRoomSettings");

  const btnSwitchTeam = document.getElementById("btnRoomSwitchTeam");
  const btnReady = document.getElementById("btnRoomReady");
  const btnStart = document.getElementById("btnRoomStart");
  const btnLeave = document.getElementById("btnRoomLeave");
  const chatLog = document.getElementById("roomChatLog");
  const chatInput = document.getElementById("roomChatInput");
  const btnChatSend = document.getElementById("btnRoomChatSend");

  const endTitleEl = document.getElementById("endTitle");
  const endBodyEl = document.getElementById("endScoreBody");
  const endCountdownEl = document.getElementById("endAutoReturn");
  const btnReturnRoom = document.getElementById("btnReturnRoom");
  const btnEndReturnLobby = document.getElementById("btnEndReturnLobby");

  let currentRoom = null;
  let endTimerInterval = null;
  let customReplayHandler = null;
  let customLobbyHandler = null;

  function makePlayerRow(p, isHostViewer, isTdm) {
    const row = makeEl("div", "rosterRow");
    const left = makeEl("span", "", "");
    const hostBadge = p.id === currentRoom.hostId ? "👑 " : "";
    const meTag = p.id === net.playerId ? " (Bạn)" : "";
    const discTag = p.connected ? "" : " [Mất kết nối]";
    left.textContent = `${hostBadge}${p.name}${meTag}${discTag}`;
    if (!p.connected) left.style.opacity = "0.55";

    const right = makeEl("div", "rosterActions");
    if (p.id === currentRoom.hostId) {
      right.append(makeEl("span", "badgeHost", "Chủ phòng"));
    } else {
      const rBadge = makeEl("span", p.ready ? "badgeReady" : "badgeWait", p.ready ? "✓ Sẵn sàng" : "Chờ");
      right.append(rBadge);
    }

    if (isHostViewer && p.id !== net.playerId && currentRoom.state === ROOM_STATE.WAITING) {
      const kickBtn = makeEl("button", "btnKick", "Kick");
      kickBtn.type = "button";
      kickBtn.onclick = () => net.send(MSG.ROOM_KICK, { targetId: p.id });
      right.append(kickBtn);
    }

    if (isTdm && p.team === "A") row.style.borderLeft = `3px solid ${TEAM_META.A.hex}`;
    if (isTdm && p.team === "B") row.style.borderLeft = `3px solid ${TEAM_META.B.hex}`;

    row.append(left, right);
    return row;
  }

  function renderRoom(room) {
    if (!room) return;
    currentRoom = room;
    const isHost = room.hostId === net.playerId;
    const isTdm = room.mode === "TDM";
    const inWaiting = room.state === ROOM_STATE.WAITING;
    const me = room.players.find((p) => p.id === net.playerId);

    const mapLabel = room.map === "harbor" ? "Bến Cảng Mưa" : "Khu Quân Sự Cũ";
    titleEl.textContent = (room.hasPassword ? "🔐 " : "") + room.name;
    metaEl.textContent =
      `${isTdm ? "Đấu Đội (TDM)" : "Đấu Đơn (FFA)"} • ${mapLabel} • ` +
      `Mục tiêu ${room.killLimit} mạng • ${(room.timeLimit / 60) | 0} phút • ` +
      `${room.players.length}/${room.maxPlayers} người`;

    // Sync settings form controls (enabled strictly for Host during WAITING)
    if (setMapEl) setMapEl.value = room.map === "harbor" ? "harbor" : "military";
    setModeEl.value = room.mode;
    setKillEl.value = String(room.killLimit);
    setTimeEl.value = String(room.timeLimit);
    setMaxEl.value = String(room.maxPlayers);
    setSoloEl.checked = Boolean(room.allowSoloTest);
    const canEdit = isHost && inWaiting;
    for (const inp of [setMapEl, setModeEl, setKillEl, setTimeEl, setMaxEl, setPwEl, setSoloEl, btnSaveSettings]) {
      if (inp) inp.disabled = !canEdit;
    }

    teamColsEl.style.display = isTdm ? "grid" : "none";
    ffaColEl.style.display = isTdm ? "none" : "block";
    listTeamA.textContent = "";
    listTeamB.textContent = "";
    listFfa.textContent = "";

    for (const p of room.players) {
      const row = makePlayerRow(p, isHost, isTdm);
      if (!isTdm) listFfa.append(row);
      else if (p.team === "B") listTeamB.append(row);
      else listTeamA.append(row);
    }

    btnSwitchTeam.style.display = isTdm && inWaiting ? "inline-block" : "none";
    if (me) {
      btnSwitchTeam.onclick = () => {
        net.send(MSG.ROOM_TEAM, { team: me.team === "A" ? "B" : "A" });
      };
    }

    btnReady.style.display = !isHost && inWaiting ? "inline-block" : "none";
    if (me) {
      btnReady.textContent = me.ready ? "Hủy sẵn sàng" : "Sẵn sàng";
      btnReady.className = me.ready ? "sec" : "";
    }

    btnStart.style.display = isHost && inWaiting ? "inline-block" : "none";
    countdownEl.style.display = room.state === ROOM_STATE.STARTING ? "block" : "none";
    if (room.state === ROOM_STATE.STARTING) {
      countdownEl.textContent = `Trận đấu bắt đầu sau ${room.countdownSec}s...`;
    }
  }

  function appendChat(msg) {
    const line = makeEl("div", "chatLine");
    const who = makeEl("b", "", `${msg.from}: `);
    who.style.color =
      msg.team === "A" ? TEAM_META.A.hex : msg.team === "B" ? TEAM_META.B.hex : TEAM_META.FFA.hex;
    const body = makeEl("span", "", msg.text);
    line.append(who, body);
    chatLog.append(line);
    while (chatLog.children.length > 40) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function stopEndTimer() {
    if (endTimerInterval) {
      clearInterval(endTimerInterval);
      endTimerInterval = null;
    }
  }

  function renderEndScoreRows(rows, localId) {
    endBodyEl.textContent = "";
    (rows || []).forEach((p, idx) => {
      const tr = document.createElement("tr");
      if (p.id === localId) tr.style.background = "rgba(240, 180, 41, 0.14)";
      const meta = TEAM_META[p.team] || TEAM_META.FFA;
      const teamTd = makeEl("td", "", `${meta.symbol} ${meta.name}`);
      teamTd.style.color = meta.hex;
      tr.append(
        makeEl("td", "", String(idx + 1)),
        makeEl("td", "", p.name + (p.id === localId ? " (Bạn)" : "")),
        teamTd,
        makeEl("td", "", String(p.kills)),
        makeEl("td", "", String(p.deaths)),
        makeEl("td", "", String(p.headshots)),
      );
      endBodyEl.append(tr);
    });
  }

  function renderMatchEnd(ev) {
    stopEndTimer();
    customReplayHandler = null;
    customLobbyHandler = null;
    let sec = ev.returnInSec || 10;
    const isTdm = currentRoom && currentRoom.mode === "TDM";
    if (ev.winner === "DRAW") endTitleEl.textContent = "HÒA TRẬN!";
    else if (isTdm) {
      endTitleEl.textContent =
        ev.winner === "A"
          ? `${TEAM_META.A.symbol} ĐẶC NHIỆM (${TEAM_META.A.short.toUpperCase()}) CHIẾN THẮNG!`
          : `${TEAM_META.B.symbol} NỔI LOẠN (${TEAM_META.B.short.toUpperCase()}) CHIẾN THẮNG!`;
    } else {
      endTitleEl.textContent = `CHIẾN THẮNG: ${ev.winner}`;
    }

    renderEndScoreRows(ev.scoreboard || [], net.playerId);

    const isHost = currentRoom && currentRoom.hostId === net.playerId;
    btnReturnRoom.textContent = "Về phòng ngay";
    btnReturnRoom.style.display = isHost ? "inline-block" : "none";
    if (btnEndReturnLobby) btnEndReturnLobby.style.display = "none";
    endCountdownEl.textContent = `Tự động quay về phòng chờ sau ${sec}s...`;
    endTimerInterval = setInterval(() => {
      sec = Math.max(0, sec - 1);
      endCountdownEl.textContent = `Tự động quay về phòng chờ sau ${sec}s...`;
      if (sec <= 0) {
        clearInterval(endTimerInterval);
        endTimerInterval = null;
      }
    }, 1000);
  }

  function renderBotMatchEnd(ev, { onReplay, onReturnLobby } = {}) {
    stopEndTimer();
    customReplayHandler = typeof onReplay === "function" ? onReplay : null;
    customLobbyHandler = typeof onReturnLobby === "function" ? onReturnLobby : null;
    const isTdm = ev && ev.mode === "TDM";
    if (!ev || ev.winner === "DRAW") endTitleEl.textContent = "HÒA TRẬN ĐẤU MÁY!";
    else if (isTdm) {
      endTitleEl.textContent =
        ev.winner === "A"
          ? "▲ ĐỘI BẠN CHIẾN THẮNG!"
          : "● BOT ĐỊCH CHIẾN THẮNG!";
    } else {
      endTitleEl.textContent = `CHIẾN THẮNG: ${ev.winner}`;
    }
    renderEndScoreRows((ev && ev.scoreboard) || [], "human-local");
    btnReturnRoom.textContent = "Đấu lại trận mới";
    btnReturnRoom.style.display = "inline-block";
    if (btnEndReturnLobby) btnEndReturnLobby.style.display = "inline-block";
    endCountdownEl.textContent =
      isTdm && ev && ev.teamScores
        ? `Tỷ số cuối: Đội Bạn ${ev.teamScores.A} — ${ev.teamScores.B} Bot Địch`
        : "Tổng kết trận Đấu với Máy";
  }

  btnSaveSettings.onclick = () => {
    net.send(MSG.ROOM_SETTINGS, {
      map: setMapEl ? setMapEl.value : "military",
      mode: setModeEl.value,
      killLimit: Number(setKillEl.value),
      timeLimit: Number(setTimeEl.value),
      maxPlayers: Number(setMaxEl.value),
      password: setPwEl.value,
      allowSoloTest: setSoloEl.checked,
    });
  };

  btnReady.onclick = () => {
    if (!currentRoom) return;
    const me = currentRoom.players.find((p) => p.id === net.playerId);
    net.send(MSG.ROOM_READY, { ready: !(me && me.ready) });
  };

  btnStart.onclick = () => net.send(MSG.ROOM_START);
  btnLeave.onclick = () => {
    chatLog.textContent = "";
    net.send(MSG.ROOM_LEAVE);
  };
  btnReturnRoom.onclick = () => {
    if (customReplayHandler) customReplayHandler();
    else net.send(MSG.ROOM_RETURN);
  };
  if (btnEndReturnLobby) {
    btnEndReturnLobby.onclick = () => {
      if (customLobbyHandler) customLobbyHandler();
    };
  }

  function submitChat() {
    const txt = chatInput.value.trim();
    if (!txt) return;
    if (net.send(MSG.CHAT, { text: txt })) chatInput.value = "";
  }
  btnChatSend.onclick = submitChat;
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitChat();
    }
  });

  net.on(MSG.MATCH_COUNTDOWN, (msg) => {
    if (msg.cancelled) {
      countdownEl.style.display = "none";
      if (msg.reason) onNotice(msg.reason);
      return;
    }
    countdownEl.style.display = "block";
    countdownEl.textContent = `Trận đấu bắt đầu sau ${msg.secondsLeft}s...`;
  });

  return {
    renderRoom,
    appendChat,
    renderMatchEnd,
    renderBotMatchEnd,
    stopEndTimer,
    clearRoom() {
      currentRoom = null;
      countdownEl.style.display = "none";
      stopEndTimer();
    },
    getRoom: () => currentRoom,
  };
}
