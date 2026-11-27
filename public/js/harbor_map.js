/**
 * Rainy Harbor ("Bến Cảng Mưa") Map Builder, Procedural Textures, Weather/Rain Ripples
 * & Static Geometry Batcher (merges poles, bulbs, walls, contact shadows, and palette containers).
 */

export function tileNoise(nx, ny, period, seedOff) {
  const x0 = Math.floor(nx);
  const y0 = Math.floor(ny);
  const fx = nx - x0;
  const fy = ny - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = (ix, iy) => {
    const wx = ((ix % period) + period) % period;
    const wy = ((iy % period) + period) % period;
    let n = Math.imul(wx * 374761393 + wy * 668265263 + seedOff, 1274126177);
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

export function sampleHarborPuddle(x, z) {
  const w =
    0.5 +
    0.28 * Math.sin(x * 0.21 + 0.7) * Math.cos(z * 0.19 - 0.4) +
    0.22 * Math.sin((x + z) * 0.13);
  return Math.max(0, Math.min(1, w));
}

export function createCanvasTexture(THREE, w, h, drawFn, repeat = 0, maxAniso = 8) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  drawFn(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (repeat) t.repeat.set(repeat, repeat);
  t.anisotropy = maxAniso;
  return t;
}

/**
 * Merge an array of { geo, matrix } indexed geometries with single material into one BufferGeometry.
 * Disposes source geometries unless preserveSource is true.
 */
export function mergeStaticParts(THREE, items, preserveSource = false) {
  let totalVerts = 0;
  let totalIdx = 0;
  for (const it of items) {
    const g = it.geo;
    totalVerts += g.attributes.position.count;
    totalIdx += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);
  const idx = totalVerts > 65535 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);

  const vTmp = new THREE.Vector3();
  const nTmp = new THREE.Vector3();
  const nMat = new THREE.Matrix3();
  let vOff = 0;
  let iOff = 0;

  for (const it of items) {
    const g = it.geo;
    const mat = it.matrix;
    nMat.getNormalMatrix(mat);
    const pAttr = g.attributes.position;
    const nAttr = g.attributes.normal;
    const uAttr = g.attributes.uv;

    for (let v = 0; v < pAttr.count; v++) {
      vTmp.fromBufferAttribute(pAttr, v).applyMatrix4(mat);
      const dst3 = (vOff + v) * 3;
      pos[dst3] = vTmp.x;
      pos[dst3 + 1] = vTmp.y;
      pos[dst3 + 2] = vTmp.z;

      if (nAttr) {
        nTmp.fromBufferAttribute(nAttr, v).applyMatrix3(nMat).normalize();
        norm[dst3] = nTmp.x;
        norm[dst3 + 1] = nTmp.y;
        norm[dst3 + 2] = nTmp.z;
      }
      if (uAttr) {
        const dst2 = (vOff + v) * 2;
        uv[dst2] = uAttr.getX(v);
        uv[dst2 + 1] = uAttr.getY(v);
      }
    }

    if (g.index) {
      const gi = g.index.array;
      for (let k = 0; k < gi.length; k++) idx[iOff + k] = gi[k] + vOff;
      iOff += gi.length;
    } else {
      for (let k = 0; k < pAttr.count; k++) idx[iOff + k] = vOff + k;
      iOff += pAttr.count;
    }

    vOff += pAttr.count;
    if (!preserveSource) g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(norm, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * Merge multiple transformed copies of a multi-group BoxGeometry into one BufferGeometry
 * grouped by materialIndex (0..groups.length-1), cutting container draw calls by ~5x.
 */
export function mergeMultiGroupBoxes(THREE, baseGeo, matrices) {
  const vPerBox = baseGeo.attributes.position.count;
  const totalVerts = vPerBox * matrices.length;
  const groups = baseGeo.groups && baseGeo.groups.length
    ? baseGeo.groups
    : [{ start: 0, count: baseGeo.index.count, materialIndex: 0 }];
  const buckets = groups.map(() => []);

  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);

  const pAttr = baseGeo.attributes.position;
  const nAttr = baseGeo.attributes.normal;
  const uAttr = baseGeo.attributes.uv;
  const baseIdx = baseGeo.index.array;
  const vTmp = new THREE.Vector3();
  const nTmp = new THREE.Vector3();
  const nMat = new THREE.Matrix3();

  for (let bi = 0; bi < matrices.length; bi++) {
    const mat = matrices[bi];
    nMat.getNormalMatrix(mat);
    const vOff = bi * vPerBox;
    for (let v = 0; v < vPerBox; v++) {
      vTmp.fromBufferAttribute(pAttr, v).applyMatrix4(mat);
      const d3 = (vOff + v) * 3;
      pos[d3] = vTmp.x;
      pos[d3 + 1] = vTmp.y;
      pos[d3 + 2] = vTmp.z;

      nTmp.fromBufferAttribute(nAttr, v).applyMatrix3(nMat).normalize();
      norm[d3] = nTmp.x;
      norm[d3 + 1] = nTmp.y;
      norm[d3 + 2] = nTmp.z;

      const d2 = (vOff + v) * 2;
      uv[d2] = uAttr.getX(v);
      uv[d2 + 1] = uAttr.getY(v);
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const grp = groups[gi];
      const bucket = buckets[gi];
      for (let k = grp.start; k < grp.start + grp.count; k++) {
        bucket.push(baseIdx[k] + vOff);
      }
    }
  }

  let totalIdx = 0;
  for (const b of buckets) totalIdx += b.length;
  const mergedIdx = totalVerts > 65535 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(norm, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));

  let cursor = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const b = buckets[gi];
    for (let k = 0; k < b.length; k++) mergedIdx[cursor + k] = b[k];
    out.addGroup(cursor, b.length, groups[gi].materialIndex);
    cursor += b.length;
  }
  out.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
  return out;
}

export function createHarborMapBuilder({
  THREE,
  renderer,
  harborGroup,
  solid,
  cols,
  maxAniso,
  yieldToUI,
  rnd,
  onGroundReady,
}) {
  let harborData = null;
  let harborBuildPromise = null;

  const tex = (w, h, fn, rep) => createCanvasTexture(THREE, w, h, fn, rep, maxAniso);

  async function buildHarborSceneAsync(onProgress = null) {
    if (harborData) return harborData;
    if (harborBuildPromise) return harborBuildPromise;

    harborBuildPromise = (async () => {
      const emit = (frac, detail = "") => {
        if (typeof onProgress === "function") onProgress(frac, detail);
      };
      let hSeed = 11;
      const sr = () => (hSeed = (hSeed * 16807) % 2147483647) / 2147483647;
      const extraTextures = [];

      emit(0.04, "Dựng đèn cảng & quầng sáng sodium...");
      const lampHaloTex = tex(128, 128, (g) => {
        const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        gr.addColorStop(0, "rgba(255,208,132,.95)");
        gr.addColorStop(0.20, "rgba(255,176,84,.48)");
        gr.addColorStop(0.55, "rgba(195,120,40,.14)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(0, 0, 128, 128);
      });
      extraTextures.push(lampHaloTex);

      const poleParts = [];
      const bulbParts = [];
      const dummy = new THREE.Object3D();
      const basePoleGeo = new THREE.CylinderGeometry(0.07, 0.09, 6.2, 8);
      const baseBulbGeo = new THREE.SphereGeometry(0.14, 8, 6);

      for (const [x, z] of [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]]) {
        const L = new THREE.PointLight(0xffa94d, 1.55, 30, 1.75);
        L.position.set(x, 6.2, z);
        L.layers.enableAll();
        harborGroup.add(L);

        dummy.position.set(x, 3.1, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        poleParts.push({ geo: basePoleGeo, matrix: dummy.matrix.clone() });

        dummy.position.set(x, 6.2, z);
        dummy.updateMatrix();
        bulbParts.push({ geo: baseBulbGeo, matrix: dummy.matrix.clone() });

        const halo = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: lampHaloTex,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
            opacity: 0.90,
          }),
        );
        halo.position.set(x, 6.2, z);
        halo.scale.set(7.8, 7.8, 1);
        harborGroup.add(halo);
      }
      harborGroup.add(
        new THREE.Mesh(
          mergeStaticParts(THREE, poleParts, true),
          new THREE.MeshStandardMaterial({ color: 0x1b2128, metalness: 0.6, roughness: 0.5 }),
        ),
        new THREE.Mesh(
          mergeStaticParts(THREE, bulbParts, true),
          new THREE.MeshBasicMaterial({ color: 0xffe4be }),
        ),
      );
      basePoleGeo.dispose();
      baseBulbGeo.dispose();
      await yieldToUI();

      // Wet asphalt floor & organic puddles
      emit(0.10, "Sinh mặt nhựa đường ướt & vũng nước Bến Cảng...");
      const GROUND_TEX_SIZE = 512;
      const GROUND_REPEAT = 4;
      const puddleMask = new Float32Array(GROUND_TEX_SIZE * GROUND_TEX_SIZE);
      const puddleDefs = [];
      for (let i = 0; i < 18; i++) {
        const a = sr() * Math.PI;
        puddleDefs.push({
          cx: 0.22 + sr() * 0.56,
          cy: 0.22 + sr() * 0.56,
          rx: 0.06 + sr() * 0.07,
          ry: 0.04 + sr() * 0.05,
          cs: Math.cos(a),
          sn: Math.sin(a),
          strength: 0.80 + sr() * 0.20,
        });
      }
      for (let y = 0; y < GROUND_TEX_SIZE; y++) {
        if (y === 256) await yieldToUI();
        const py = y / GROUND_TEX_SIZE;
        for (let x = 0; x < GROUND_TEX_SIZE; x++) {
          const px = x / GROUND_TEX_SIZE;
          const edgeWarp =
            (tileNoise(px * 8, py * 8, 8, 17) - 0.5) * 0.42 +
            (tileNoise(px * 22, py * 22, 22, 43) - 0.5) * 0.18 +
            (tileNoise(px * 52, py * 52, 52, 79) - 0.5) * 0.07;
          let wMax = 0;
          for (let i = 0; i < puddleDefs.length; i++) {
            const p = puddleDefs[i];
            let dx = px - p.cx;
            let dy = py - p.cy;
            if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
            if (dy > 0.5) dy -= 1; else if (dy < -0.5) dy += 1;
            const u = (dx * p.cs + dy * p.sn) / p.rx;
            const v = (-dx * p.sn + dy * p.cs) / p.ry;
            const d = Math.sqrt(u * u + v * v) + edgeWarp;
            if (d < 0.96) {
              const tShore = Math.max(0, Math.min(1, (0.96 - d) / 0.20));
              const s = tShore * tShore * (3 - 2 * tShore) * p.strength;
              if (s > wMax) wMax = s;
            }
          }
          puddleMask[y * GROUND_TEX_SIZE + x] = wMax;
        }
      }
      await yieldToUI();

      emit(0.20, "Sinh texture Albedo mặt đường...");
      const gtex = tex(GROUND_TEX_SIZE, GROUND_TEX_SIZE, (g, w, h) => {
        const im = g.createImageData(w, h);
        const d = im.data;
        for (let y = 0; y < h; y++) {
          const u = y / h;
          for (let x = 0; x < w; x++) {
            const v = x / w;
            const idx = y * w + x;
            const nMacro = tileNoise(v * 8, u * 8, 8, 31);
            const nMid = tileNoise(v * 32, u * 32, 32, 73);
            const nFine = tileNoise(v * 128, u * 128, 128, 137);
            const wet = puddleMask[idx];
            const pebble = 0.40 * nMid + 0.60 * nFine;
            const base = (7.5 + nMacro * 4.5 + pebble * 8.5) * (1 - wet * 0.42);
            d[idx * 4] = Math.max(2, Math.min(255, Math.round(base * 0.90)));
            d[idx * 4 + 1] = Math.max(3, Math.min(255, Math.round(base * 0.98)));
            d[idx * 4 + 2] = Math.max(4, Math.min(255, Math.round(base * 1.12)));
            d[idx * 4 + 3] = 255;
          }
        }
        g.putImageData(im, 0, 0);
      }, GROUND_REPEAT);
      await yieldToUI();

      emit(0.28, "Sinh texture Normal mặt đường...");
      const gNormTex = tex(GROUND_TEX_SIZE, GROUND_TEX_SIZE, (g, w, h) => {
        const im = g.createImageData(w, h);
        const d = im.data;
        const hMap = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
          const u = y / h;
          for (let x = 0; x < w; x++) {
            const v = x / w;
            const idx = y * w + x;
            const nFine = tileNoise(v * 96, u * 96, 96, 211);
            const nMid = tileNoise(v * 32, u * 32, 32, 97);
            const smoothCalm = 1 - Math.min(1, puddleMask[idx] * 1.15);
            hMap[idx] = (0.62 * nFine + 0.38 * nMid) * smoothCalm;
          }
        }
        for (let y = 0; y < h; y++) {
          const ym = (y - 1 + h) % h;
          const yp = (y + 1) % h;
          for (let x = 0; x < w; x++) {
            const xm = (x - 1 + w) % w;
            const xp = (x + 1) % w;
            const idx = y * w + x;
            const dx = (hMap[y * w + xp] - hMap[y * w + xm]) * 1.15;
            const dy = (hMap[yp * w + x] - hMap[ym * w + x]) * 1.15;
            d[idx * 4] = Math.max(0, Math.min(255, Math.round(128 - dx * 48)));
            d[idx * 4 + 1] = Math.max(0, Math.min(255, Math.round(128 - dy * 48)));
            d[idx * 4 + 2] = 255;
            d[idx * 4 + 3] = 255;
          }
        }
        g.putImageData(im, 0, 0);
      }, GROUND_REPEAT);
      await yieldToUI();

      emit(0.36, "Sinh texture Roughness & hạt sỏi mặt đường...");
      const gRoughTex = tex(GROUND_TEX_SIZE, GROUND_TEX_SIZE, (g, w, h) => {
        const im = g.createImageData(w, h);
        const d = im.data;
        for (let y = 0; y < h; y++) {
          const u = y / h;
          for (let x = 0; x < w; x++) {
            const v = x / w;
            const idx = y * w + x;
            const dampVar = tileNoise(v * 18, u * 18, 18, 313);
            const wet = puddleMask[idx];
            const rough = (0.56 + 0.22 * dampVar) * (1 - wet) + 0.035 * wet;
            const r = Math.max(8, Math.min(225, Math.round(rough * 255)));
            d[idx * 4] = d[idx * 4 + 1] = d[idx * 4 + 2] = r;
            d[idx * 4 + 3] = 255;
          }
        }
        g.putImageData(im, 0, 0);
      }, GROUND_REPEAT);
      await yieldToUI();

      const asphaltDetailNormal = tex(512, 512, (g, w, h) => {
        const im = g.createImageData(w, h);
        const d = im.data;
        const hMap = new Float32Array(w * h);
        const detCrack = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
          const u = y / h;
          for (let x = 0; x < w; x++) {
            const v = x / w;
            const g1 = tileNoise(v * 64, u * 64, 64, 509);
            const g2 = tileNoise(v * 32, u * 32, 32, 617);
            const g3 = tileNoise(v * 16, u * 16, 16, 733);
            hMap[y * w + x] = Math.pow(g1, 1.35) * 0.55 + g2 * 0.30 + g3 * 0.15;

            const wx = (tileNoise(v * 4, u * 4, 4, 811) - 0.5) * 0.32;
            const wy = (tileNoise(v * 4, u * 4, 4, 823) - 0.5) * 0.32;
            const r1 = Math.abs(tileNoise((v + wx) * 3, (u + wy) * 3, 3, 911) - 0.5);
            const r2 = Math.abs(tileNoise((v - wy * 0.8) * 4, (u + wx * 0.8) * 4, 4, 977) - 0.5);
            const c1 = Math.max(0, 1 - r1 / 0.032);
            const c2 = Math.max(0, 1 - r2 / 0.028);
            detCrack[y * w + x] = Math.max(c1, c2);
          }
        }
        for (let y = 0; y < h; y++) {
          const ym = (y - 1 + h) % h;
          const yp = (y + 1) % h;
          for (let x = 0; x < w; x++) {
            const xm = (x - 1 + w) % w;
            const xp = (x + 1) % w;
            const idx = y * w + x;
            const hL = hMap[y * w + xm] - detCrack[y * w + xm] * 0.28;
            const hR = hMap[y * w + xp] - detCrack[y * w + xp] * 0.28;
            const hD = hMap[ym * w + x] - detCrack[ym * w + x] * 0.28;
            const hU = hMap[yp * w + x] - detCrack[yp * w + x] * 0.28;
            const dx = (hR - hL) * 1.85;
            const dy = (hU - hD) * 1.85;
            d[idx * 4] = Math.max(0, Math.min(255, Math.round(128 - dx * 60)));
            d[idx * 4 + 1] = Math.max(0, Math.min(255, Math.round(128 - dy * 60)));
            const gritVal = 150 + (hMap[idx] - 0.45) * 165 - detCrack[idx] * 95;
            d[idx * 4 + 2] = Math.max(24, Math.min(255, Math.round(gritVal)));
            d[idx * 4 + 3] = 255;
          }
        }
        g.putImageData(im, 0, 0);
      }, 1);
      extraTextures.push(gtex, gNormTex, gRoughTex, asphaltDetailNormal);
      await yieldToUI();

      const groundMat = new THREE.MeshStandardMaterial({
        map: gtex,
        normalMap: gNormTex,
        normalScale: new THREE.Vector2(0.65, 0.65),
        roughnessMap: gRoughTex,
        roughness: 1,
        metalness: 0.04,
        envMapIntensity: 0.88,
      });
      groundMat.userData.extraTextures = [asphaltDetailNormal];
      groundMat.onBeforeCompile = (shader) => {
        shader.uniforms.detailNormalMap = { value: asphaltDetailNormal };
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <normalmap_pars_fragment>",
            "#include <normalmap_pars_fragment>\nuniform sampler2D detailNormalMap;",
          )
          .replace(
            "#include <map_fragment>",
            "#include <map_fragment>\n\tfloat gritA = texture2D( detailNormalMap, vUv * 22.0 ).z;\n\tfloat gritB = texture2D( detailNormalMap, vUv * 57.0 ).z;\n\tfloat gritMix = mix(gritA, gritB, 0.48);\n\tdiffuseColor.rgb *= (0.62 + 0.68 * gritMix);",
          )
          .replace(
            "vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;\n\tmapN.xy *= normalScale;",
            "vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;\n\tmapN.xy *= normalScale;\n\tvec3 detN1 = texture2D( detailNormalMap, vUv * 22.0 ).xyz * 2.0 - 1.0;\n\tvec3 detN2 = texture2D( detailNormalMap, vUv * 57.0 ).xyz * 2.0 - 1.0;\n\tfloat puddleCalm = clamp((0.32 - roughnessFactor) * 4.5, 0.0, 1.0);\n\tmapN.xy += (detN1.xy * 1.75 + detN2.xy * 1.35) * (1.0 - puddleCalm);\n\tmapN = normalize(mapN);",
          )
          .replace(
            "#include <roughnessmap_fragment>",
            "#include <roughnessmap_fragment>\n\tvec3 detR = texture2D( detailNormalMap, vUv * 22.0 ).xyz * 2.0 - 1.0;\n\tfloat rCalm = clamp((0.32 - roughnessFactor) * 4.5, 0.0, 1.0);\n\troughnessFactor = clamp(roughnessFactor - abs(detR.x + detR.y) * 0.24 * (1.0 - rCalm), 0.035, 0.94);",
          );
      };

      const ground = new THREE.Mesh(new THREE.PlaneGeometry(130, 130), groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      ground.userData.surface = "ground";
      harborGroup.add(ground);
      if (typeof onGroundReady === "function") onGroundReady(ground);

      function cTex(col, k) {
        const t = tex(k ? 256 : 1024, 512, (g, w, h) => {
          g.fillStyle = col;
          g.fillRect(0, 0, w, h);
          const rb = [44, 12, 10, 30][k];
          for (let x = 0; x < w; x++) {
            const a = Math.cos((x / w) * 6.2832 * rb);
            g.fillStyle = a > 0 ? `rgba(255,255,255,${a * 0.12})` : `rgba(0,0,0,${-a * 0.3})`;
            g.fillRect(x, 0, 1, h);
          }
          g.fillStyle = col;
          g.fillRect(0, 0, w, h * 0.045);
          g.fillRect(0, h * 0.955, w, h * 0.045);
          for (let i = 0; i < 65; i++) {
            const x = sr() * w;
            const y = sr() * h * 0.6;
            const l = h * (0.1 + sr() * 0.5);
            const q = g.createLinearGradient(0, y, 0, y + l);
            q.addColorStop(0, "rgba(120,52,18,.45)");
            q.addColorStop(1, "rgba(120,52,18,0)");
            g.fillStyle = q;
            g.fillRect(x, y, 1 + sr() * 3, l);
          }
          if (k === 0) {
            g.fillStyle = "rgba(240,240,235,.88)";
            g.textBaseline = "top";
            g.font = "bold 56px Arial,sans-serif";
            g.fillText("MSKU " + ((100000 + sr() * 899999) | 0) + " " + ((sr() * 9) | 0), 30, h * 0.1);
            g.font = "bold 120px Arial,sans-serif";
            g.fillText("HALDEN", w * 0.42, h * 0.3);
            g.font = "bold 30px Arial,sans-serif";
            g.fillText("MAX GROSS 30480 KG   TARE 2220 KG", w * 0.42, h * 0.62);
          }
          if (k === 1) {
            g.fillStyle = "rgba(0,0,0,.45)";
            g.fillRect(w / 2 - 2, h * 0.05, 4, h * 0.9);
          }
          const gr = g.createLinearGradient(0, h, 0, h * 0.46);
          gr.addColorStop(0, "rgba(1,2,3,.99)");
          gr.addColorStop(0.32, "rgba(4,5,7,.90)");
          gr.addColorStop(0.65, "rgba(14,12,10,.45)");
          gr.addColorStop(1, "rgba(35,25,15,0)");
          g.fillStyle = gr;
          g.fillRect(0, 0, w, h);
        });
        extraTextures.push(t);
        return t;
      }

      const cPalette = [0x8c3a2b, 0x2c5878, 0x3b6a4a, 0xb08428, 0x6a7077, 0x6e3f55];
      const cMats = [];
      for (let ci = 0; ci < cPalette.length; ci++) {
        emit(0.46 + (ci / cPalette.length) * 0.30, `Sinh kết cấu container cảng (${ci + 1}/${cPalette.length})...`);
        const col = "#" + cPalette[ci].toString(16).padStart(6, "0");
        const mk = (k) => {
          const t = cTex(col, k);
          return new THREE.MeshStandardMaterial({
            map: t,
            bumpMap: t,
            bumpScale: 1.4,
            roughness: 0.74,
            metalness: 0.20,
          });
        };
        const side = mk(0);
        cMats.push([mk(1), mk(2), mk(3), new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.9 }), side, side]);
        await yieldToUI();
      }

      emit(0.78, "Gộp geometry container, tường bao & bóng chân...");
      const contactShadowTex = tex(256, 128, (g) => {
        g.filter = "blur(9px)";
        g.fillStyle = "rgba(0,0,0,0.92)";
        g.fillRect(14, 12, 228, 104);
        g.filter = "blur(2px)";
        g.fillStyle = "rgba(0,0,0,1.0)";
        g.fillRect(26, 22, 204, 84);
      });
      const contactShadowGeo = new THREE.PlaneGeometry(8.8, 5.0);
      const contactShadowMat = new THREE.MeshBasicMaterial({
        map: contactShadowTex,
        color: 0x000000,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });

      const containerReflTex = tex(128, 128, (g) => {
        const gr = g.createRadialGradient(64, 64, 12, 64, 64, 62);
        gr.addColorStop(0.0, "rgba(255,255,255,0.0)");
        gr.addColorStop(0.42, "rgba(255,255,255,0.34)");
        gr.addColorStop(0.75, "rgba(255,255,255,0.16)");
        gr.addColorStop(1.0, "rgba(255,255,255,0.0)");
        g.fillStyle = gr;
        g.fillRect(0, 0, 128, 128);
      });
      extraTextures.push(contactShadowTex, containerReflTex);

      const containerReflGeo = new THREE.PlaneGeometry(8.2, 5.2);
      containerReflGeo.rotateX(-Math.PI / 2);
      const containerReflMat = new THREE.MeshBasicMaterial({
        map: containerReflTex,
        transparent: true,
        opacity: 0.44,
        depthWrite: false,
      });

      const containerBuckets = cMats.map(() => []);
      const shadowParts = [];
      const containerReflItems = [];
      const cGeo = new THREE.BoxGeometry(6.1, 2.6, 2.44);
      let mapSeed = 11042026;
      const msr = () => (mapSeed = (mapSeed * 16807) % 2147483647) / 2147483647;

      for (let gx = -3; gx <= 3; gx++) {
        for (let gz = -3; gz <= 3; gz++) {
          if ((gx === 0 && gz === 0) || msr() < 0.42) continue;
          const x = gx * 13 + (msr() - 0.5) * 3;
          const z = gz * 13 + (msr() - 0.5) * 3;
          const rot = msr() < 0.5;
          const cIdx = (msr() * cMats.length) | 0;
          const stacked = msr() < 0.3;

          dummy.position.set(x, 1.285, z);
          dummy.rotation.set(0, rot ? Math.PI / 2 : 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          containerBuckets[cIdx].push(dummy.matrix.clone());

          if (stacked) {
            dummy.position.set(x, 3.885, z);
            dummy.updateMatrix();
            containerBuckets[cIdx].push(dummy.matrix.clone());
          }

          const hx = rot ? 1.22 : 3.05;
          const hz = rot ? 3.05 : 1.22;
          cols.push({ x0: x - hx, x1: x + hx, z0: z - hz, z1: z + hz, y1: stacked ? 5.2 : 2.6 });

          dummy.position.set(x, 0.007, z);
          dummy.rotation.set(-Math.PI / 2, 0, rot ? Math.PI / 2 : 0);
          dummy.updateMatrix();
          shadowParts.push({ geo: contactShadowGeo, matrix: dummy.matrix.clone() });
          containerReflItems.push({ x, z, rot, hex: cPalette[cIdx] });
        }
      }

      // Emit 1 merged mesh per container palette (cuts ~180 container draw calls -> ~36)
      for (let ci = 0; ci < containerBuckets.length; ci++) {
        const mats = containerBuckets[ci];
        if (!mats.length) continue;
        const merged = new THREE.Mesh(mergeMultiGroupBoxes(THREE, cGeo, mats), cMats[ci]);
        merged.castShadow = merged.receiveShadow = true;
        merged.userData.surface = "metal";
        harborGroup.add(merged);
        solid.push(merged);
      }
      cGeo.dispose();

      // Merge all ground contact shadows into 1 draw call
      if (shadowParts.length > 0) {
        const mergedShadows = new THREE.Mesh(mergeStaticParts(THREE, shadowParts, true), contactShadowMat);
        mergedShadows.renderOrder = 1;
        harborGroup.add(mergedShadows);
      }
      contactShadowGeo.dispose();

      if (containerReflItems.length > 0) {
        const reflInst = new THREE.InstancedMesh(containerReflGeo, containerReflMat, containerReflItems.length);
        reflInst.position.set(0, 0.005, 0);
        const colTmp = new THREE.Color();
        containerReflItems.forEach((it, idx) => {
          dummy.position.set(it.x, 0, it.z);
          dummy.rotation.set(0, it.rot ? Math.PI / 2 : 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          reflInst.setMatrixAt(idx, dummy.matrix);
          colTmp.setHex(it.hex).multiplyScalar(0.55);
          reflInst.setColorAt(idx, colTmp);
        });
        reflInst.instanceMatrix.needsUpdate = true;
        if (reflInst.instanceColor) reflInst.instanceColor.needsUpdate = true;
        harborGroup.add(reflInst);
      }

      // Merge 4 concrete perimeter walls into 1 mesh (4 draw calls -> 1)
      const wallParts = [];
      for (const [x, z, w, d] of [[0, -52, 100, 1], [0, 52, 100, 1], [-52, 0, 1, 100], [52, 0, 1, 100]]) {
        const wg = new THREE.BoxGeometry(w, 10, d);
        dummy.position.set(x, 5, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        wallParts.push({ geo: wg, matrix: dummy.matrix.clone() });
      }
      const wallMesh = new THREE.Mesh(
        mergeStaticParts(THREE, wallParts, false),
        new THREE.MeshStandardMaterial({ color: 0x1a2128, roughness: 0.9 }),
      );
      wallMesh.userData.surface = "concrete";
      harborGroup.add(wallMesh);
      solid.push(wallMesh);
      await yieldToUI();

      emit(0.88, "Dựng PMREM đêm mưa & lớp sương cảng...");
      const harborEnvMap = (() => {
        const es = new THREE.Scene();
        const geo = new THREE.SphereGeometry(20, 32, 16);
        const p = geo.attributes.position;
        const col = [];
        for (let i = 0; i < p.count; i++) {
          const y = p.getY(i) / 20;
          const t = Math.max(0, y);
          col.push(...(y > 0 ? [0.08 + 0.22 * t, 0.11 + 0.28 * t, 0.16 + 0.36 * t] : [0.02, 0.025, 0.03]));
        }
        geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        es.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false })));
        const panel = (r, g, b, w, h, x, y, z) => {
          const m = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), side: THREE.DoubleSide, toneMapped: false }),
          );
          m.position.set(x, y, z);
          m.lookAt(0, 0, 0);
          es.add(m);
        };
        panel(0.9, 1.35, 2.0, 14, 5, 0, 15, -4);
        for (const [x, y, z] of [[-9, 6.2, -9], [9, 6.2, -9], [-9, 6.2, 9], [9, 6.2, 9]]) {
          panel(8.8, 4.9, 1.7, 2.0, 2.0, x, y, z);
        }
        panel(1.9, 2.5, 3.6, 2.2, 2.2, 0, 14, -11);
        const pm = new THREE.PMREMGenerator(renderer);
        const rt = pm.fromScene(es, 0.025);
        pm.dispose();
        geo.dispose();
        return rt.texture;
      })();
      extraTextures.push(harborEnvMap);
      ground.material.envMap = harborEnvMap;
      ground.material.needsUpdate = true;

      const mistTex = tex(128, 128, (g) => {
        const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
        gr.addColorStop(0, "rgba(105,138,172,.22)");
        gr.addColorStop(0.5, "rgba(65,92,124,.08)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(0, 0, 128, 128);
      });
      extraTextures.push(mistTex);
      for (const [x, y, z] of [[-7, 1.8, -14], [8, 1.9, -18], [0, 2.1, -24], [-15, 2.0, -22], [14, 1.8, -12]]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.16, depthWrite: false }));
        sp.position.set(x, y, z);
        sp.scale.set(16, 6, 1);
        harborGroup.add(sp);
      }
      await yieldToUI();

      emit(0.95, "Khởi tạo hệ thống mưa & gợn sóng...");
      const rainRipples = (() => {
        const geo = new THREE.RingGeometry(0.86, 1.0, 24);
        geo.rotateX(-Math.PI / 2);
        const POOL = 112;
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 1.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const inst = new THREE.InstancedMesh(geo, mat, POOL);
        inst.position.set(0, 0.014, 0);
        inst.frustumCulled = false;
        harborGroup.add(inst);

        const rDummy = new THREE.Object3D();
        const fadeColor = new THREE.Color();
        const state = [];
        for (let i = 0; i < POOL; i++) {
          const active = i < 76;
          const inArenaCenter = i < 48;
          const rx = inArenaCenter ? (-8 + sr() * 14) : (sr() - 0.5) * 24;
          const rz = inArenaCenter ? (-6 + sr() * 12) : (sr() - 0.5) * 24;
          const maxRadius = 0.24 + sr() * 0.11;
          const life = active ? sr() * 0.34 : 0;
          const maxLife = 0.46 + sr() * 0.12;
          const t0 = life / maxLife;
          const sc0 = active ? (0.11 + (maxRadius - 0.11) * t0) : 0.001;
          state.push({ active, x: rx, z: rz, life, maxLife, size: maxRadius });
          rDummy.position.set(rx, active ? 0 : -50, rz);
          rDummy.scale.set(sc0, 1, sc0);
          rDummy.updateMatrix();
          inst.setMatrixAt(i, rDummy.matrix);
          const f0 = active ? Math.min(1, t0 / 0.14) * Math.pow(1 - t0, 1.45) * 0.29 : 0;
          inst.setColorAt(i, fadeColor.setRGB(0.70 * f0, 0.84 * f0, 0.98 * f0));
        }
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

        let next = 0;
        return {
          emit(x, z) {
            const s = state[next++ % POOL];
            s.active = true;
            s.x = x;
            s.z = z;
            s.life = 0;
            s.maxLife = rnd(0.46, 0.58);
            s.size = rnd(0.24, 0.35);
          },
          upd(dt) {
            for (let i = 0; i < POOL; i++) {
              const s = state[i];
              if (!s.active) continue;
              s.life += dt;
              const t = s.life / s.maxLife;
              if (t >= 1) {
                s.active = false;
                rDummy.position.set(0, -50, 0);
                rDummy.scale.setScalar(0.001);
                rDummy.updateMatrix();
                inst.setMatrixAt(i, rDummy.matrix);
                continue;
              }
              const sc = 0.11 + (s.size - 0.11) * t;
              rDummy.position.set(s.x, 0, s.z);
              rDummy.scale.set(sc, 1, sc);
              rDummy.updateMatrix();
              inst.setMatrixAt(i, rDummy.matrix);
              const fade = Math.min(1, t / 0.14) * Math.pow(1 - t, 1.45) * 0.29;
              inst.setColorAt(i, fadeColor.setRGB(0.70 * fade, 0.84 * fade, 0.98 * fade));
            }
            inst.instanceMatrix.needsUpdate = true;
            if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
          },
        };
      })();

      const ND2 = 3000;
      const rd = new Float32Array(ND2 * 4);
      const rp2 = new Float32Array(ND2 * 6);
      const rc2 = new Float32Array(ND2 * 6);
      for (let i = 0; i < ND2; i++) {
        rd.set([rnd(-24, 24), rnd(0, 26), rnd(-24, 24), rnd(0.6, 1.4)], i * 4);
        const b = rd[i * 4 + 3] * 0.27;
        rc2.set([0, 0, 0, b * 0.55, b * 0.68, b * 0.82], i * 6);
      }
      const rg2 = new THREE.BufferGeometry();
      rg2.setAttribute("position", new THREE.BufferAttribute(rp2, 3));
      rg2.setAttribute("color", new THREE.BufferAttribute(rc2, 3));
      const rain2 = new THREE.LineSegments(
        rg2,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      rain2.frustumCulled = false;
      harborGroup.add(rain2);

      harborData = {
        mapId: "harbor",
        group: harborGroup,
        envMap: harborEnvMap,
        extraTextures,
        updateRain(dt, tSec, px, pz) {
          const wind = Math.sin(tSec * 0.23) * 0.6 + Math.sin(tSec * 0.71) * 0.25;
          for (let i = 0; i < ND2; i++) {
            const k = i * 4;
            const v = rd[k + 3];
            const sp = 24 + 16 * v;
            let x = rd[k] + wind * 3 * dt;
            let y = rd[k + 1] - sp * dt;
            let z = rd[k + 2];
            if (x - px > 24) x -= 48; else if (x - px < -24) x += 48;
            if (z - pz > 24) z -= 48; else if (z - pz < -24) z += 48;
            if (y < 0) {
              y += 26;
              if (i % 3 !== 0 && Math.abs(x - px) < 11 && Math.abs(z - pz) < 11) rainRipples.emit(x, z);
            }
            rd[k] = x;
            rd[k + 1] = y;
            rd[k + 2] = z;
            rp2.set([x - wind * 0.07, y + sp * 0.022, z, x, y, z], i * 6);
          }
          rg2.attributes.position.needsUpdate = true;
          rainRipples.upd(dt);
        },
      };
      window.__harborMapLoaded = true;
      emit(1.0, "Hoàn tất dựng bản đồ Bến Cảng Mưa");
      return harborData;
    })().catch((err) => {
      harborBuildPromise = null;
      throw err;
    });

    return harborBuildPromise;
  }

  return {
    buildHarborSceneAsync,
    getData: () => harborData,
  };
}

