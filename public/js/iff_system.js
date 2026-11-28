/**
 * Competitive IFF (Identification Friend or Foe) System — Package A (Valorant + CoD):
 * - Relative Friend/Foe resolution (TDM: Allies = Blue, Enemies = Selected Color; FFA: All remote = Enemy)
 * - Colorblind-safe enemy highlight presets (Red default / Yellow / Purple) + Rim strength presets (Strong default / Crisp / Off)
 * - Single-program Geometric-Normal Silhouette Fresnel GLSL injection for Three.js r128 SkinnedMesh PBR:
 *   keeps 80-90% interior PBR detail (1024px albedo, normalMap, roughness, AO) 100% untouched & razor-sharp!
 * - PUBG-style Smart Friendly Marker layout (occluded chevron + distance, Crosshair Proximity Fade, ADS Fade)
 *
 * Pure helpers stay DOM/WebGL-free for deterministic Node.js AAA testing.
 */

export const ALLY_IFF_META = Object.freeze({
  id: "ally",
  label: "Đồng đội",
  hex: "#2F80FF",
  markerHex: "#42B8FF",
  colorNum: 0x2f80ff,
  tracerHex: 0xcbe8ff,
  shieldHex: 0x2f80ff,
  symbol: "▲",
});

export const ENEMY_HIGHLIGHT_PRESETS = Object.freeze({
  red: Object.freeze({
    id: "red",
    label: "Đỏ (Valorant)",
    hex: "#FF3535",
    colorNum: 0xff3535,
    rimRgbSrgb: Object.freeze([1.0, 0.14, 0.14]),
    tracerHex: 0xff8c69,
    shieldHex: 0xff3535,
  }),
  yellow: Object.freeze({
    id: "yellow",
    label: "Vàng (Mù màu Đỏ-Lục)",
    hex: "#FFE135",
    colorNum: 0xffe135,
    rimRgbSrgb: Object.freeze([1.0, 0.87, 0.14]),
    tracerHex: 0xffe670,
    shieldHex: 0xffe135,
  }),
  purple: Object.freeze({
    id: "purple",
    label: "Tím (Tương phản cao)",
    hex: "#C84BFF",
    colorNum: 0xc84bff,
    rimRgbSrgb: Object.freeze([0.82, 0.24, 1.0]),
    tracerHex: 0xd98aff,
    shieldHex: 0xc84bff,
  }),
});

export const ENEMY_HIGHLIGHT_IDS = Object.freeze(["red", "yellow", "purple"]);

// User-approved 2B default: "strong" (bold crisp Valorant silhouette while keeping interior 100% pure PBR)
export const ENEMY_RIM_PRESETS = Object.freeze({
  strong: Object.freeze({
    id: "strong",
    label: "Rõ kiểu Valorant (Mặc định)",
    intensity: 0.98,
    hdrBoost: 1.72,
    // (nearLo, farLo, nearHi, farHi) on (1.0 - abs(dot(geomN, V)))
    nearLo: 0.56,
    farLo: 0.42,
    nearHi: 0.84,
    farHi: 0.74,
  }),
  crisp: Object.freeze({
    id: "crisp",
    label: "Mảnh sắc nét",
    intensity: 0.74,
    hdrBoost: 1.48,
    nearLo: 0.66,
    farLo: 0.52,
    nearHi: 0.90,
    farHi: 0.82,
  }),
  off: Object.freeze({
    id: "off",
    label: "Tắt viền (Chỉ HUD & Radar)",
    intensity: 0.0,
    hdrBoost: 1.0,
    nearLo: 0.75,
    farLo: 0.75,
    nearHi: 0.95,
    farHi: 0.95,
  }),
});

export const ENEMY_RIM_IDS = Object.freeze(["strong", "crisp", "off"]);

export const DEFAULT_ENEMY_HIGHLIGHT_COLOR = "red";
export const DEFAULT_ENEMY_RIM_STRENGTH = "strong";
export const SOLDIER_IFF_CACHE_KEY = "soldier_iff_pbr_v1";

export function normalizeEnemyHighlightColor(raw) {
  return typeof raw === "string" && ENEMY_HIGHLIGHT_PRESETS[raw]
    ? raw
    : DEFAULT_ENEMY_HIGHLIGHT_COLOR;
}

export function normalizeEnemyRimStrength(raw) {
  return typeof raw === "string" && ENEMY_RIM_PRESETS[raw]
    ? raw
    : DEFAULT_ENEMY_RIM_STRENGTH;
}

export function getEnemyHighlightPreset(colorId) {
  return ENEMY_HIGHLIGHT_PRESETS[normalizeEnemyHighlightColor(colorId)];
}

export function getEnemyRimPreset(strengthId) {
  return ENEMY_RIM_PRESETS[normalizeEnemyRimStrength(strengthId)];
}

/**
 * Resolves a remote player's relation relative to the local player:
 * - TDM: same team ("A" or "B") -> "ally"; different team -> "enemy"
 * - FFA (or any non-TDM mode): every remote player -> "enemy"
 */
export function resolvePlayerRelation({ currentMode = "TDM", meTeam = "A", targetTeam = "B" } = {}) {
  if (currentMode === "TDM" && (meTeam === "A" || meTeam === "B") && targetTeam === meTeam) {
    return "ally";
  }
  return "enemy";
}

function srgbChannelToLinear(c) {
  const x = Math.max(0, Math.min(1, Number(c) || 0));
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * Computes map-calibrated uniform values for the Geometric-Normal Fresnel rim shader.
 * - On `military` (THREE.sRGBEncoding + exposure 0.86): converts sRGB highlight color to true Linear RGB
 *   so `#FF3535` stays deep saturated Valorant red instead of washing out to salmon pink!
 * - On `harbor` (THREE.LinearEncoding + exposure 1.08, dark night rain): applies mild gamma tightening
 *   and 0.88x gain to stay vivid without over-blooming in darkness.
 */
export function computeIffUniformValues({
  enemyColor = DEFAULT_ENEMY_HIGHLIGHT_COLOR,
  rimStrength = DEFAULT_ENEMY_RIM_STRENGTH,
  mapId = "military",
} = {}) {
  const colorPreset = getEnemyHighlightPreset(enemyColor);
  const rimPreset = getEnemyRimPreset(rimStrength);
  const isHarbor = mapId === "harbor";
  const [sr, sg, sb] = colorPreset.rimRgbSrgb;

  const rgb = isHarbor
    ? [Math.pow(sr, 1.35), Math.pow(sg, 1.35), Math.pow(sb, 1.35)]
    : [srgbChannelToLinear(sr), srgbChannelToLinear(sg), srgbChannelToLinear(sb)];

  const mapGain = isHarbor ? 0.88 : 1.08;
  return {
    colorPreset,
    rimPreset,
    rgb,
    intensity: rimPreset.intensity,
    hdrBoost: rimPreset.hdrBoost * mapGain,
    edgeParams: [rimPreset.nearLo, rimPreset.farLo, rimPreset.nearHi, rimPreset.farHi],
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / Math.max(1e-5, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * PUBG + Valorant Smart Friendly Marker layout:
 * - Behind wall (`occluded`): compact chevron + distance (`18m`), lower opacity (`0.56`)
 * - Direct LoS (`!occluded`): full clean chevron + name + slim HP bar (`0.94`)
 * - Crosshair Proximity Fade: fades marker down to `0.14` when near screen center so a teammate
 *   behind cover NEVER hides an enemy standing in front of you!
 * - ADS Fade: softens distant/occluded markers when aiming down sights or AWM scope.
 */
export function computeFriendlyMarkerLayout({
  dist = 10,
  occluded = false,
  ndcDist = 1.0,
  ads = 0,
  behindCamera = false,
} = {}) {
  if (behindCamera) {
    return { visible: false, compact: true, opacity: 0, scale: 0.85 };
  }
  const safeDist = Math.max(0.5, Number.isFinite(Number(dist)) ? Number(dist) : 10);
  const safeNdc = Math.max(0, Number.isFinite(Number(ndcDist)) ? Number(ndcDist) : 1);
  const safeAds = clamp01(Number.isFinite(Number(ads)) ? Number(ads) : 0);

  const compact = Boolean(occluded || safeDist > 26);
  let opacity = occluded ? 0.78 : 0.96;

  // Crosshair Proximity Fade (prevents occluded/far ally icons covering an enemy near the reticle)
  if ((occluded || safeDist > 11) && safeNdc < 0.17) {
    const proxT = smoothstep(0.03, 0.17, safeNdc);
    const minCrossOpacity = occluded ? 0.15 : 0.24;
    opacity *= minCrossOpacity + (1 - minCrossOpacity) * proxT;
  }

  // ADS / Scope attenuation so ally indicators stay unobtrusive during precision aiming
  if (safeAds > 0.05) {
    const adsMin = occluded ? 0.22 : safeDist > 16 ? 0.36 : 0.62;
    opacity *= 1 - (1 - adsMin) * safeAds;
  }

  // Distance-clamped world scale: neat at 5m (won't block head), readable through walls at 12-45m
  const scale = Math.max(0.84, Math.min(2.75, 0.74 + safeDist * 0.044));

  return {
    visible: true,
    compact,
    opacity: Number(clamp01(opacity).toFixed(3)),
    scale: Number(scale.toFixed(3)),
  };
}

/**
 * Relative top scoreboard model (1A):
 * - TDM: Left is ALWAYS your team (Blue), Right is ALWAYS enemy team (Enemy Color).
 * - FFA: Left shows leader score, Right shows match kill limit target.
 */
export function resolveTopScoreboardView({
  currentMode = "TDM",
  meTeam = "A",
  teamScores = { A: 0, B: 0 },
  topKills = 0,
  topName = "-",
  killLimit = 30,
  clockText = "10:00",
  enemyColor = DEFAULT_ENEMY_HIGHLIGHT_COLOR,
} = {}) {
  const enemyMeta = getEnemyHighlightPreset(enemyColor);
  if (currentMode !== "TDM") {
    return {
      leftLabel: "◆ DẪN ĐẦU",
      leftScore: Number(topKills) || 0,
      leftColor: "#f0b429",
      rightLabel: "MỤC TIÊU",
      rightScore: Number(killLimit) || 30,
      rightColor: "#cbd5e1",
      metaText: `FFA ${clockText} | Dẫn đầu: ${topName || "-"}`,
    };
  }
  const mySide = meTeam === "B" ? "B" : "A";
  const foeSide = mySide === "A" ? "B" : "A";
  const mySym = mySide === "A" ? "▲" : "●";
  const foeSym = foeSide === "A" ? "▲" : "●";
  return {
    leftLabel: `${mySym} ĐỘI BẠN`,
    leftScore: Number(teamScores && teamScores[mySide]) || 0,
    leftColor: ALLY_IFF_META.hex,
    rightLabel: `ĐỘI ĐỊCH ${foeSym}`,
    rightScore: Number(teamScores && teamScores[foeSide]) || 0,
    rightColor: enemyMeta.hex,
    metaText: `${clockText} | ${killLimit} Mạng`,
  };
}

/**
 * Creates a Three.js uniform container for the soldier IFF rim shader.
 */
export function createSoldierIffUniforms(THREE, initialOpts = {}) {
  const vals = computeIffUniformValues(initialOpts);
  return {
    uIffColor: { value: new THREE.Color(vals.rgb[0], vals.rgb[1], vals.rgb[2]) },
    uIffIntensity: { value: vals.intensity },
    uIffHdrBoost: { value: vals.hdrBoost },
    uIffEdgeParams: {
      value: new THREE.Vector4(
        vals.edgeParams[0],
        vals.edgeParams[1],
        vals.edgeParams[2],
        vals.edgeParams[3],
      ),
    },
  };
}

/**
 * Updates an existing soldier IFF uniform container in-place (0ms, 0 shader recompile).
 */
export function syncSoldierIffUniforms(uniforms, opts = {}) {
  if (!uniforms) return null;
  const vals = computeIffUniformValues(opts);
  if (uniforms.uIffColor && uniforms.uIffColor.value && typeof uniforms.uIffColor.value.setRGB === "function") {
    uniforms.uIffColor.value.setRGB(vals.rgb[0], vals.rgb[1], vals.rgb[2]);
  }
  if (uniforms.uIffIntensity) uniforms.uIffIntensity.value = vals.intensity;
  if (uniforms.uIffHdrBoost) uniforms.uIffHdrBoost.value = vals.hdrBoost;
  if (uniforms.uIffEdgeParams && uniforms.uIffEdgeParams.value && typeof uniforms.uIffEdgeParams.value.set === "function") {
    uniforms.uIffEdgeParams.value.set(
      vals.edgeParams[0],
      vals.edgeParams[1],
      vals.edgeParams[2],
      vals.edgeParams[3],
    );
  }
  return vals;
}

const IFF_FRAG_UNIFORMS = `
#include <common>
uniform vec3 uIffColor;
uniform float uIffIntensity;
uniform float uIffHdrBoost;
uniform vec4 uIffEdgeParams;
`;

const IFF_FRAG_CAPTURE_NORMAL = `
#include <normal_fragment_begin>
vec3 iffGeomNormal = normal;
`;

const IFF_FRAG_RIM_APPLY = `
if (uIffIntensity > 0.001) {
  vec3 iffN = normalize(iffGeomNormal);
  float iffViewDist = max(length(vViewPosition), 0.001);
  vec3 iffV = vViewPosition / iffViewDist;
  float iffNdotV = clamp(abs(dot(iffN, iffV)), 0.0, 1.0);
  float iffDistT = smoothstep(8.0, 40.0, iffViewDist);
  float iffEdgeLo = mix(uIffEdgeParams.x, uIffEdgeParams.y, iffDistT);
  float iffEdgeHi = mix(uIffEdgeParams.z, uIffEdgeParams.w, iffDistT);
  float iffRim = smoothstep(iffEdgeLo, iffEdgeHi, 1.0 - iffNdotV);
  // Subtle close-range preservation (keeps interior 100% pure PBR, stronger contour at 15-45m & prone)
  float iffDistGain = mix(0.84, 1.18, iffDistT);
  float iffMask = clamp(iffRim * uIffIntensity * iffDistGain, 0.0, 1.0);
  vec3 iffEdgeCol = gl_FragColor.rgb * 0.36 + uIffColor * uIffHdrBoost;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, iffEdgeCol, iffMask);
}
#include <tonemapping_fragment>
`;

/**
 * Patches a Three.js r128 MeshPhysicalMaterial / MeshStandardMaterial with Geometric-Normal
 * Silhouette Fresnel rim highlighting. Both Ally (uIffIntensity = 0) and Enemy materials share
 * the exact same `customProgramCacheKey` so WebGL compiles only ONE program total!
 */
export function applySoldierIffShader(material, uniforms) {
  if (!material || !uniforms) return material;
  const prevCompile = material.onBeforeCompile;
  material.customProgramCacheKey = () => SOLDIER_IFF_CACHE_KEY;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof prevCompile === "function") prevCompile(shader, renderer);
    shader.uniforms.uIffColor = uniforms.uIffColor;
    shader.uniforms.uIffIntensity = uniforms.uIffIntensity;
    shader.uniforms.uIffHdrBoost = uniforms.uIffHdrBoost;
    shader.uniforms.uIffEdgeParams = uniforms.uIffEdgeParams;
    if (!shader.fragmentShader.includes("uIffEdgeParams")) {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", IFF_FRAG_UNIFORMS)
        .replace("#include <normal_fragment_begin>", IFF_FRAG_CAPTURE_NORMAL)
        .replace("#include <tonemapping_fragment>", IFF_FRAG_RIM_APPLY);
    }
  };
  material.userData = material.userData || {};
  material.userData.iffUniforms = uniforms;
  return material;
}
