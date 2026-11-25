/**
 * Persistent player preferences stored in localStorage:
 * sensitivity, ADS sensitivity, invert Y, base FOV, hold/toggle modes, and key bindings (BIND).
 */

export const DEFAULT_BIND = Object.freeze({
  forward: ["KeyW"],
  back: ["KeyS"],
  left: ["KeyA"],
  right: ["KeyD"],
  jump: ["Space"],
  crouch: ["KeyC", "ControlLeft"],
  sprint: ["ShiftLeft"],
  reload: ["KeyR"],
  slot1: ["Digit1"],
  slot2: ["Digit2"],
  slot3: ["Digit3"],
  slot4: ["Digit4"],
  switchPrev: ["KeyQ"],
  laser: ["KeyL"],
  score: ["Tab"],
  chat: ["Enter"],
});

const STORAGE_KEY = "fps_user_settings_v2";

const DEFAULT_SETTINGS = {
  sens: 1.0,
  adsSens: 0.58,
  invertY: false,
  fov: 75,
  crouchMode: "hold",
  adsMode: "hold",
  bindings: {},
};

for (const [k, codes] of Object.entries(DEFAULT_BIND)) {
  DEFAULT_SETTINGS.bindings[k] = [...codes];
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function formatKeyCode(code) {
  if (!code) return "-";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const map = {
    ControlLeft: "Ctrl",
    ShiftLeft: "Shift",
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
  };
  return map[code] || code;
}

export function createSettingsStore() {
  let state = load();
  const listeners = new Set();

  function cloneDefaults() {
    const bindings = {};
    for (const [k, codes] of Object.entries(DEFAULT_BIND)) bindings[k] = [...codes];
    return { ...DEFAULT_SETTINGS, bindings };
  }

  function load() {
    const base = cloneDefaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      base.sens = clampNum(parsed.sens, 0.2, 3.0, 1.0);
      base.adsSens = clampNum(parsed.adsSens, 0.2, 1.2, 0.58);
      base.invertY = Boolean(parsed.invertY);
      base.fov = Math.round(clampNum(parsed.fov, 65, 95, 75));
      base.crouchMode = parsed.crouchMode === "toggle" ? "toggle" : "hold";
      base.adsMode = parsed.adsMode === "toggle" ? "toggle" : "hold";
      if (parsed.bindings && typeof parsed.bindings === "object") {
        for (const action of Object.keys(DEFAULT_BIND)) {
          const list = parsed.bindings[action];
          if (Array.isArray(list) && list.length > 0 && list.every((c) => typeof c === "string")) {
            base.bindings[action] = list.slice(0, 2);
          }
        }
      }
    } catch {
      // Ignore corrupt storage
    }
    return base;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore quota errors
    }
    for (const fn of listeners) fn(state);
  }

  return {
    get: () => state,
    getBindings: () => state.bindings,
    update(patch) {
      if (patch.sens !== undefined) state.sens = clampNum(patch.sens, 0.2, 3.0, state.sens);
      if (patch.adsSens !== undefined) state.adsSens = clampNum(patch.adsSens, 0.2, 1.2, state.adsSens);
      if (patch.invertY !== undefined) state.invertY = Boolean(patch.invertY);
      if (patch.fov !== undefined) state.fov = Math.round(clampNum(patch.fov, 65, 95, state.fov));
      if (patch.crouchMode !== undefined) state.crouchMode = patch.crouchMode === "toggle" ? "toggle" : "hold";
      if (patch.adsMode !== undefined) state.adsMode = patch.adsMode === "toggle" ? "toggle" : "hold";
      save();
    },
    rebind(action, newCode) {
      if (!DEFAULT_BIND[action] || typeof newCode !== "string" || !newCode) return;
      state.bindings[action] = [newCode];
      save();
    },
    resetDefaults() {
      state = cloneDefaults();
      save();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const ACTION_LABELS = [
  ["forward", "Tiến lên"],
  ["back", "Lùi lại"],
  ["left", "Sang trái"],
  ["right", "Sang phải"],
  ["jump", "Nhảy"],
  ["crouch", "Ngồi (Tránh Ctrl+W: nên ưu tiên C)"],
  ["sprint", "Chạy nước rút"],
  ["reload", "Nạp đạn"],
  ["switchPrev", "Về súng trước"],
  ["laser", "Bật/tắt Laser"],
  ["score", "Bảng điểm"],
  ["chat", "Mở chat"],
];

export function mountSettingsUI(store, inputCtrl) {
  const modal = document.getElementById("settingsModal");
  const sensIn = document.getElementById("setSens");
  const sensVal = document.getElementById("setSensVal");
  const adsSensIn = document.getElementById("setAdsSens");
  const adsSensVal = document.getElementById("setAdsSensVal");
  const fovIn = document.getElementById("setFov");
  const fovVal = document.getElementById("setFovVal");
  const invertYIn = document.getElementById("setInvertY");
  const crouchModeIn = document.getElementById("setCrouchMode");
  const adsModeIn = document.getElementById("setAdsMode");
  const bindList = document.getElementById("setBindList");

  let listeningAction = null;

  function render() {
    const s = store.get();
    sensIn.value = String(s.sens);
    sensVal.textContent = s.sens.toFixed(2);
    adsSensIn.value = String(s.adsSens);
    adsSensVal.textContent = s.adsSens.toFixed(2);
    fovIn.value = String(s.fov);
    fovVal.textContent = `${s.fov}°`;
    invertYIn.checked = s.invertY;
    crouchModeIn.value = s.crouchMode;
    adsModeIn.value = s.adsMode;

    bindList.textContent = "";
    for (const [action, label] of ACTION_LABELS) {
      const row = document.createElement("div");
      row.className = "bindRow";
      const lbl = document.createElement("span");
      lbl.textContent = label;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sec btnSm";
      const cur = (s.bindings[action] || []).map(formatKeyCode).join(" / ");
      btn.textContent = listeningAction === action ? "Nhấn phím mới..." : cur;
      btn.onclick = () => {
        listeningAction = action;
        render();
        inputCtrl.captureNextKey((code) => {
          listeningAction = null;
          if (code && code !== "Escape") store.rebind(action, code);
          render();
        });
      };
      row.append(lbl, btn);
      bindList.append(row);
    }
  }

  sensIn.oninput = () => store.update({ sens: Number(sensIn.value) });
  adsSensIn.oninput = () => store.update({ adsSens: Number(adsSensIn.value) });
  fovIn.oninput = () => store.update({ fov: Number(fovIn.value) });
  invertYIn.onchange = () => store.update({ invertY: invertYIn.checked });
  crouchModeIn.onchange = () => store.update({ crouchMode: crouchModeIn.value });
  adsModeIn.onchange = () => store.update({ adsMode: adsModeIn.value });

  document.getElementById("btnSetReset").onclick = () => {
    listeningAction = null;
    store.resetDefaults();
    render();
  };
  document.getElementById("btnSetClose").onclick = () => {
    listeningAction = null;
    inputCtrl.cancelKeyCapture();
    modal.style.display = "none";
  };

  store.onChange(render);
  render();

  return {
    open() {
      render();
      modal.style.display = "grid";
    },
    close() {
      listeningAction = null;
      inputCtrl.cancelKeyCapture();
      modal.style.display = "none";
    },
  };
}

