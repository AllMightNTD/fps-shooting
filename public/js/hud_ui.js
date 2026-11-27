/**
 * HUD DOM Cache, Killfeed, Chat, Scoreboard, Radar & Pause/Perf Overlays.
 */

export function createHudUi({
  $,
  el,
  formatClock,
  sanitizeText,
  TEAM_META,
  WEAPON_SLOTS,
  MSG,
  R,
  settings,
  input,
  net,
  ray,
  cam,
  getActiveQualityLabel,
  getHudState,
  onStartSolo,
  onStopEngine,
  onRequestExitToLobby,
  initAudio,
}) {
  const _hudCache = Object.create(null);
  const _radarEnemyMeshes = [];
  const _radarAllTargets = [];
  let _crossEnemyHover = false;
  let _lastRadarDrawMs = 0;

  let hm = 0;
  let dmgV = 0;
  let killAlertT = 0;
  let chatOpen = false;
  let testLocked = false;

  let perfHudVisible = Boolean(settings && settings.get && settings.get().showPerfHud);
  let perfFrameCount = 0;
  let perfLastSampleMs = performance.now();
  let perfStats = { fps: 0, frameMs: 0, calls: 0, triangles: 0, programs: 0 };

  function syncPerfHudVisibility() {
    const elPerf = $("perfHud");
    if (!elPerf) return;
    elPerf.style.display = perfHudVisible ? "block" : "none";
    if (perfHudVisible && !elPerf.textContent) {
      elPerf.textContent = `FPS: -- | ${getActiveQualityLabel()}`;
    }
  }
  syncPerfHudVisibility();

  window.addEventListener("keydown", (e) => {
    if (e.code !== "F3" || e.repeat) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    if (settings && typeof settings.update === "function") {
      settings.update({ showPerfHud: !settings.get().showPerfHud });
    } else {
      perfHudVisible = !perfHudVisible;
      syncPerfHudVisibility();
    }
  });

  if (settings && typeof settings.onChange === "function") {
    settings.onChange((st) => {
      if (st && typeof st.showPerfHud === "boolean" && st.showPerfHud !== perfHudVisible) {
        perfHudVisible = st.showPerfHud;
        syncPerfHudVisibility();
      }
    });
  }

  $("hudChatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const txt = sanitizeText($("hudChatInput").value, "", 120);
      if (txt) net.send(MSG.CHAT, { text: txt });
      $("hudChatInput").value = "";
      chatOpen = false;
      $("hudChatInput").style.display = "none";
      input.setTextFocusBlocked(false);
      input.tryLock();
    } else if (e.key === "Escape") {
      e.preventDefault();
      chatOpen = false;
      $("hudChatInput").style.display = "none";
      input.setTextFocusBlocked(false);
      input.tryLock();
    }
  });

  R.domElement.addEventListener("click", () => {
    const { activeState } = getHudState();
    if (activeState === "play" && !input.active && !chatOpen) {
      initAudio();
      $("pauseOverlay").style.display = "none";
      input.tryLock();
    }
  });

  function showPauseOverlay(title, sub) {
    const { engineMode } = getHudState();
    $("pauseTitle").textContent = title;
    $("pauseSub").textContent = sub;
    $("btnPauseResume").textContent = "Tiếp tục";
    $("btnPauseLeave").textContent = engineMode === "lan" ? "Rời phòng" : "Về sảnh chính";
    $("pauseOverlay").style.display = "grid";
  }

  function onPointerLockChanged(isLocked) {
    if (isLocked) {
      $("pauseOverlay").style.display = "none";
      testLocked = true;
    } else {
      testLocked = false;
      $("scoreboard").style.display = "none";
    }
  }

  function onPointerUnlocked() {
    const { activeState, engineMode } = getHudState();
    if (activeState === "play" && !chatOpen) {
      if (engineMode === "lan") {
        showPauseOverlay(
          "Menu trận đấu (Trận đang chạy)",
          "Esc chỉ thả chuột — Trận PvP vẫn tiếp tục trực tiếp trên LAN.",
        );
      } else {
        showPauseOverlay("Tạm dừng (Offline)", "Bấm Tiếp tục để quay lại luyện tập Drone.");
      }
    }
  }

  function onPointerLockFailed() {
    const { activeState } = getHudState();
    if (activeState === "play" && !input.active && !chatOpen) {
      showPauseOverlay(
        "Trận đấu đã sẵn sàng",
        "Bấm Tiếp tục hoặc click màn hình để khóa chuột và chiến đấu.",
      );
    }
  }

  $("btnPauseResume").onclick = () => {
    const { activeState, engineMode } = getHudState();
    initAudio();
    if (activeState === "over" && engineMode === "solo") {
      onStartSolo();
      return;
    }
    $("pauseOverlay").style.display = "none";
    input.tryLock();
  };

  $("btnPauseLeave").onclick = () => {
    onStopEngine();
    onRequestExitToLobby();
  };

  function hud() {
    const nowMs = performance.now();
    const {
      activeWeapon,
      activeSlot,
      hp,
      meInvuln,
      activeState,
      meAlive,
      isSprinting,
      crouched,
      grounded,
      ads,
      engineMode,
      soloWave,
      soloScore,
      respawnMs,
      currentMode,
      timeLeftSec,
      killLimit,
      teamScores,
      lastPlayers,
    } = getHudState();

    const { cfg, st } = activeWeapon();
    const isReloading = st.reloadEndsAt > nowMs;

    const hpW = Math.max(0, hp) + "%";
    const hpBg = meInvuln ? "#64c8ff" : hp > 35 ? "#4ec3b0" : "#e85445";
    const hpText = `MÁU ${Math.max(0, Math.round(hp))} / 100`;
    if (_hudCache.hpW !== hpW) { _hudCache.hpW = hpW; $("hpb").style.width = hpW; }
    if (_hudCache.hpBg !== hpBg) { _hudCache.hpBg = hpBg; $("hpb").style.background = hpBg; }
    if (_hudCache.hpText !== hpText) {
      _hudCache.hpText = hpText;
      const hpLbl = $("hpLabel");
      if (hpLbl) hpLbl.textContent = hpText;
    }

    const isLow = st.mag <= Math.ceil(cfg.magSize * 0.3);
    const amText = isReloading ? "Nạp đạn…" : `${st.mag} / ∞`;
    const amLow = isLow && !isReloading;
    const relHint = amLow && activeState === "play" && meAlive ? "block" : "none";
    if (_hudCache.amText !== amText) { _hudCache.amText = amText; $("am").textContent = amText; }
    if (_hudCache.amLow !== amLow) { _hudCache.amLow = amLow; $("am").classList.toggle("amLow", amLow); }
    if (_hudCache.relHint !== relHint) { _hudCache.relHint = relHint; $("reloadHint").style.display = relHint; }

    if (_hudCache.activeSlot !== activeSlot) {
      _hudCache.activeSlot = activeSlot;
      for (const s of WEAPON_SLOTS) {
        const pNode = $(`slotPill${s}`);
        if (pNode) pNode.classList.toggle("active", s === activeSlot);
      }
    }

    const postureLabel = isSprinting
      ? "Chạy nước rút"
      : crouched
        ? "Ngồi"
        : !grounded
          ? "Trên không"
          : ads > 0.3
            ? "Đang ngắm"
            : "Đứng";
    const postureText = `${cfg.name} • ${postureLabel}`;
    if (_hudCache.postureText !== postureText) {
      _hudCache.postureText = postureText;
      $("postureBadge").textContent = postureText;
    }

    if (_hudCache.engineMode !== engineMode) {
      _hudCache.engineMode = engineMode;
      $("top").style.display = engineMode === "solo" ? "block" : "none";
      $("pvpTop").style.display = engineMode === "lan" ? "flex" : "none";
      $("radarCanvas").style.display = engineMode === "lan" ? "block" : "none";
    }
    if (_hudCache.soloWave !== soloWave) { _hudCache.soloWave = soloWave; $("wv").textContent = soloWave; }
    if (_hudCache.soloScore !== soloScore) { _hudCache.soloScore = soloScore; $("sc").textContent = soloScore; }

    if (engineMode === "lan") {
      const showRespawn = !meAlive && activeState === "play";
      const respDisp = showRespawn ? "block" : "none";
      if (_hudCache.respDisp !== respDisp) { _hudCache.respDisp = respDisp; $("respawnBanner").style.display = respDisp; }
      if (showRespawn) {
        const respText = `Đã bị hạ — Hồi sinh sau ${(respawnMs / 1000).toFixed(1)}s`;
        if (_hudCache.respText !== respText) { _hudCache.respText = respText; $("respawnBanner").textContent = respText; }
      }
      if (currentMode === "TDM") {
        const metaText = `${formatClock(timeLeftSec)} | ${killLimit} Mạng`;
        if (_hudCache.scA !== teamScores.A) { _hudCache.scA = teamScores.A; $("scA").textContent = teamScores.A; }
        if (_hudCache.scB !== teamScores.B) { _hudCache.scB = teamScores.B; $("scB").textContent = teamScores.B; }
        if (_hudCache.pvpMeta !== metaText) { _hudCache.pvpMeta = metaText; $("pvpMeta").textContent = metaText; }
      } else {
        const topP = lastPlayers.slice().sort((a, b) => b.kills - a.kills)[0];
        const aVal = topP ? topP.kills : 0;
        const metaText = `FFA ${formatClock(timeLeftSec)} | Dẫn đầu: ${topP ? topP.name : "-"}`;
        if (_hudCache.scA !== aVal) { _hudCache.scA = aVal; $("scA").textContent = aVal; }
        if (_hudCache.scB !== killLimit) { _hudCache.scB = killLimit; $("scB").textContent = killLimit; }
        if (_hudCache.pvpMeta !== metaText) { _hudCache.pvpMeta = metaText; $("pvpMeta").textContent = metaText; }
      }
    } else if (_hudCache.respDisp !== "none") {
      _hudCache.respDisp = "none";
      $("respawnBanner").style.display = "none";
    }
  }

  function setHitmarker(headshot) {
    hm = 1;
    $("hm").style.borderColor = headshot ? "#ff3b3b" : "var(--amber)";
    $("hm").style.borderWidth = headshot ? "3px" : "2px";
  }

  function showKillAlert(text, color = "#ff4747") {
    const node = $("killAlert");
    node.textContent = text;
    node.style.color = color;
    node.style.opacity = "1";
    killAlertT = 1.6;
  }

  function stepTransientFeedback(dt) {
    if (hm > 0) {
      hm = Math.max(0, hm - dt * 5);
      $("hm").style.opacity = hm;
    }
    if (dmgV > 0) {
      dmgV = Math.max(0, dmgV - dt * 1.6);
      $("dmg").style.opacity = dmgV;
    }
    if (killAlertT > 0) {
      killAlertT -= dt;
      if (killAlertT <= 0) $("killAlert").style.opacity = "0";
    }
  }

  function pushKillfeed(ev) {
    const kf = $("killfeed");
    const row = el("div", "kfRow");
    const kMeta = TEAM_META[ev.killerTeam] || TEAM_META.FFA;
    const vMeta = TEAM_META[ev.victimTeam] || TEAM_META.FFA;
    const kSpan = el("span", "", `${kMeta.symbol} ${ev.killer}`);
    kSpan.style.color = kMeta.hex;
    const wTag = ev.weapon || "M416";
    const mid = el("span", "", ev.head ? ` [HEADSHOT • ${wTag}] ` : ` [${wTag}] `);
    mid.style.color = ev.head ? "#ff5252" : "#cfd8df";
    mid.style.fontWeight = "700";
    const vSpan = el("span", "", `${vMeta.symbol} ${ev.victim}`);
    vSpan.style.color = vMeta.hex;
    row.append(kSpan, mid, vSpan);
    kf.prepend(row);
    while (kf.children.length > 5) kf.lastChild.remove();
    setTimeout(() => row.remove(), 5500);
  }

  function pushHudChat(ev) {
    const log = $("hudChatLog");
    const line = el("div", "hudChatRow");
    const meta = TEAM_META[ev.team] || TEAM_META.FFA;
    const who = el("b", "", `${meta.symbol} ${ev.from}: `);
    who.style.color = meta.hex;
    line.append(who, el("span", "", ev.text));
    log.append(line);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => line.remove(), 7000);
  }

  function renderScoreboardTable() {
    const { lastPlayers, currentMode, killLimit, timeLeftSec } = getHudState();
    const tbody = $("sbBody");
    tbody.textContent = "";
    const rows = lastPlayers.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.headshots - a.headshots);
    for (const p of rows) {
      const tr = document.createElement("tr");
      if (p.id === net.playerId) tr.style.background = "rgba(240, 180, 41, 0.14)";
      const meta = TEAM_META[p.team] || TEAM_META.FFA;
      const tdTeam = el("td", "", `${meta.symbol} ${meta.name}`);
      tdTeam.style.color = meta.hex;
      tr.append(
        el("td", "", p.name + (p.id === net.playerId ? " (Bạn)" : "")),
        tdTeam,
        el("td", "", String(p.kills)),
        el("td", "", String(p.deaths)),
        el("td", "", String(p.headshots)),
        el("td", "", p.alive ? "Sống" : "Hồi sinh"),
      );
      tbody.append(tr);
    }
    $("sbTitle").textContent = `${currentMode === "FFA" ? "Đấu Đơn (FFA)" : "Đấu Đội (TDM)"} — Mục tiêu ${killLimit} mạng (Còn ${formatClock(timeLeftSec)})`;
  }

  function updateRadarAndCrosshair(nowMs) {
    const {
      engineMode,
      remotePlayers,
      currentMode,
      meTeam,
      activeCollision,
      ground,
      solid,
      P,
      yaw,
    } = getHudState();

    if (engineMode !== "lan") {
      if (_crossEnemyHover) {
        _crossEnemyHover = false;
        $("cross").classList.remove("targetEnemy");
      }
      return;
    }

    _radarEnemyMeshes.length = 0;
    for (const av of remotePlayers.values()) {
      if (!av.alive) continue;
      if (currentMode === "TDM" && av.team === meTeam) continue;
      for (let i = 0; i < av.hitMeshes.length; i++) _radarEnemyMeshes.push(av.hitMeshes[i]);
    }
    ray.far = 160;
    ray.setFromCamera({ x: 0, y: 0 }, cam);
    let hover = null;
    if (activeCollision) {
      const targetHit = _radarEnemyMeshes.length ? ray.intersectObjects(_radarEnemyMeshes, false)[0] : null;
      const worldHit = activeCollision.raycastShot(
        ray.ray.origin.x,
        ray.ray.origin.y,
        ray.ray.origin.z,
        ray.ray.direction.x,
        ray.ray.direction.y,
        ray.ray.direction.z,
        ray.far,
      );
      if (targetHit && (!worldHit || targetHit.distance <= worldHit.dist)) {
        hover = targetHit;
      }
    } else {
      _radarAllTargets.length = 0;
      if (ground) _radarAllTargets.push(ground);
      for (let i = 0; i < solid.length; i++) _radarAllTargets.push(solid[i]);
      for (let i = 0; i < _radarEnemyMeshes.length; i++) _radarAllTargets.push(_radarEnemyMeshes[i]);
      hover = ray.intersectObjects(_radarAllTargets, false)[0];
    }
    const nextEnemyHover = Boolean(hover && hover.object.userData.hitTarget);
    if (nextEnemyHover !== _crossEnemyHover) {
      _crossEnemyHover = nextEnemyHover;
      $("cross").classList.toggle("targetEnemy", nextEnemyHover);
    }

    if (nowMs - _lastRadarDrawMs < 50) return;
    _lastRadarDrawMs = nowMs;

    const canvas = $("radarCanvas");
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const cx = 62, cy = 62, range = 45, scale = 54 / range;
    g.clearRect(0, 0, 124, 124);
    g.strokeStyle = "rgba(180,210,230,0.16)";
    g.beginPath(); g.arc(cx, cy, 27, 0, Math.PI * 2); g.stroke();

    const sn = Math.sin(yaw), cs = Math.cos(yaw);
    for (const av of remotePlayers.values()) {
      if (!av.alive) continue;
      const isTeammate = currentMode === "TDM" && av.team === meTeam;
      if (!isTeammate && nowMs > av.radarBlipUntil) continue;
      const dx = av.container.position.x - P.x;
      const dz = av.container.position.z - P.z;
      const rx = dx * cs - dz * sn;
      const rz = dx * sn + dz * cs;
      let px = cx + rx * scale;
      let py = cy + rz * scale;
      const d = Math.hypot(px - cx, py - cy);
      if (d > 54) {
        px = cx + ((px - cx) / d) * 54;
        py = cy + ((py - cy) / d) * 54;
      }
      g.fillStyle = (TEAM_META[av.team] || TEAM_META.FFA).hex;
      g.beginPath();
      g.arc(px, py, isTeammate ? 4.2 : 3.6, 0, Math.PI * 2);
      g.fill();
    }

    g.fillStyle = "#f0b429";
    g.beginPath();
    g.moveTo(cx, cy - 6);
    g.lineTo(cx - 4.5, cy + 4.5);
    g.lineTo(cx + 4.5, cy + 4.5);
    g.closePath();
    g.fill();
  }

  function samplePerfStats(totalCalls, totalTris) {
    perfFrameCount++;
    const nowPerf = performance.now();
    const dtPerf = nowPerf - perfLastSampleMs;
    if (dtPerf >= 500) {
      const fps = Math.round((perfFrameCount * 1000) / dtPerf);
      const frameMs = +(dtPerf / Math.max(1, perfFrameCount)).toFixed(1);
      const programs = R.info && R.info.programs ? R.info.programs.length : 0;
      perfStats = { fps, frameMs, calls: totalCalls, triangles: totalTris, programs };
      perfFrameCount = 0;
      perfLastSampleMs = nowPerf;
      if (perfHudVisible) {
        const elPerf = $("perfHud");
        if (elPerf) {
          elPerf.textContent =
            `FPS: ${fps} (${frameMs} ms) • ${getActiveQualityLabel()}\n` +
            `Calls: ${totalCalls} | Tris: ${totalTris.toLocaleString("en-US")} | Prog: ${programs}`;
        }
      }
    }
  }

  function openChat() {
    chatOpen = true;
    input.setTextFocusBlocked(true);
    if (document.pointerLockElement === R.domElement) document.exitPointerLock();
    $("hudChatInput").style.display = "block";
    $("hudChatInput").focus();
  }

  return {
    hud,
    setHitmarker,
    triggerDamageVignette: () => { dmgV = 1; },
    showKillAlert,
    stepTransientFeedback,
    pushKillfeed,
    pushHudChat,
    renderScoreboardTable,
    updateRadarAndCrosshair,
    syncPerfHudVisibility,
    samplePerfStats,
    getPerfStats: () => ({ ...perfStats, visible: perfHudVisible }),
    showPauseOverlay,
    onPointerLockChanged,
    onPointerUnlocked,
    onPointerLockFailed,
    openChat,
    isChatOpen: () => chatOpen,
    setChatOpen: (v) => { chatOpen = Boolean(v); },
    isControlActive: () => input.active || testLocked,
    setTestLocked: (v) => { testLocked = Boolean(v); },
  };
}

