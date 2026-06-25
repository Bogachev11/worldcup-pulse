// stage7.js — "BATTLE OF MASSES · CINEMATIC" — stage6's exact real-data sim and
// colour logic, re-rendered to a "rendered-in-Blender" grade: a PBR
// MeshStandardMaterial (height displacement + data colour injected via
// onBeforeCompile so we keep three's full lighting/shadow/tonemapping pipeline),
// soft image-based lighting (RoomEnvironment + PMREM), a shadow-casting key
// light onto a receiving slab, screen-space-ish AO, and an EffectComposer post
// chain (bloom + vignette/colour-grade + SMAA). The DATA path is identical to
// stage6 — only the rendering is upgraded.
//
// Hard rule respected: NO invented signals. Every visual element is driven by the
// same real match data stage6 uses. Lighting/AO/bloom/grade only render that
// data-driven geometry better; randomness is micro-texture only.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clamp, lerp, smoothstep, fbm, buildModel, at, rgb01, xgUpTo } from './claybattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);

// baked-in default camera (user-tuned)
const DEFAULT_CAM = { pos: [-12.86, 18.18, 17.62], target: [-1.43, 1.97, -0.48] };
function applyDefaultCamera() {
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);
  controls.update();
}

// ---- grid resolution (segments) ---------------------------------------------
const GX = 200;   // along length (x: home goal 0 → away goal 1)
const GY = 120;   // across width (y)
const VX = GX + 1, VY = GY + 1;          // vertex counts
const NV = VX * VY;
const WORLD_X = 16, WORLD_Z = 9.6;       // pitch footprint (16:9.6 ~ pitch)

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls, composer;
let bloomPass, gradePass, smaaPass;
let heightTex, heightData;               // DataTexture (R32F) of per-vertex H
let mesh, material, slab, keyLight;
let injected = null;                     // ref to the compiled onBeforeCompile shader.uniforms
let model = null;                        // built data model
let clock = 0, playing = true;
let lastSimT = -1;                       // last match-time we recomputed H at
let uPossCur = 0.5;                      // smoothed live away-possession share (0 home..1 away)

// tuning (bound to sliders) — stage6 defaults preserved + cinematic additions
const tune = {
  // sim / data (identical to stage6)
  speed: 3.7,
  heightScale: 2.2,
  turbulence: 3.0,
  ridgeSharp: 1.0,
  flowSpeed: 1.0,
  seamPoss: 0.6,
  ownerDim: 0.46,
  glow: 0.48,
  glowCol: '#ff6f1f',
  homeCol: '#6da0f2',
  awayCol: '#14f27f',
  sat: 2.0,
  light: 0.32,
  amb: 0.26,
  tex: 0.54,
  wobble: 0.47,
  // cinematic additions
  rough: 0.62,
  metal: 0.08,
  env: 1.0,
  shadow: 0.8,
  ao: 1.0,
  bloomStr: 0.62,
  bloomRad: 0.55,
  bloomThr: 0.62,
  vig: 0.5,
  expo: 1.0,
  contr: 1.06,
  gsat: 1.04,
};

// transient eruption bumps that decay (built lazily as clock passes goals/shots)
let activeEruptions = [];
let eruptionCursor = 0;

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e.message || String(e)));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available in this browser');

  const raw = await fetch('/api/rich/' + ID).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
  model = buildModel(raw);

  setupThree();
  buildHeightfield();
  setupComposer();
  bindUI();
  applyTeamColors();
  applyLookUniforms();

  el('title2').textContent =
    `BATTLE · CINEMATIC · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title2'); if (t) t.textContent = 'BATTLE · CINEMATIC · failed: ' + msg;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#04050a';
  o.textContent = 'BATTLE · CINEMATIC could not start: ' + msg +
    '\n\n(If three.js failed to load from the CDN, check your connection — it is loaded via esm.sh.)';
  o.style.whiteSpace = 'pre-wrap';
  document.body.appendChild(o);
}

// ---- three.js setup ---------------------------------------------------------
function setupThree() {
  const canvas = el('stage');
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true, // <- screenshot-able
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  // graded dark vertical gradient background (instead of flat black)
  scene.background = makeGradientTexture();
  // light fog for depth
  scene.fog = new THREE.FogExp2(0x05070d, 0.035);

  // soft image-based lighting via RoomEnvironment + PMREM
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(DEFAULT_CAM.pos[0], DEFAULT_CAM.pos[1], DEFAULT_CAM.pos[2]);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 36;
  controls.maxPolarAngle = Math.PI * 0.495;   // keep above the ground plane
  controls.target.set(DEFAULT_CAM.target[0], DEFAULT_CAM.target[1], DEFAULT_CAM.target[2]);

  // shadow-casting key light (warm), plus a cool rim fill + hemisphere floor.
  keyLight = new THREE.DirectionalLight(0xfff0dc, 2.6);
  keyLight.position.set(-9, 14, 7);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 60;
  const sc = keyLight.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 12; sc.bottom = -12;
  sc.updateProjectionMatrix();
  keyLight.shadow.bias = -0.0008;
  keyLight.shadow.normalBias = 0.04;
  keyLight.shadow.radius = 6;
  scene.add(keyLight);
  scene.add(keyLight.target);

  const rim = new THREE.DirectionalLight(0x9fc0ff, 0.6);
  rim.position.set(8, 5, -7);
  scene.add(rim);
  const hemi = new THREE.HemisphereLight(0x6f86b0, 0x0a0d16, 0.5);
  scene.add(hemi);
}

// A subtle dark vertical gradient as a CanvasTexture scene.background.
function makeGradientTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#0a1020');
  grad.addColorStop(0.55, '#070a12');
  grad.addColorStop(1.0, '#020308');
  g.fillStyle = grad; g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- heightfield mesh: MeshStandardMaterial + onBeforeCompile injection ------
function buildHeightfield() {
  const geo = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, GX, GY);
  geo.rotateX(-Math.PI / 2);              // lay flat: plane now in XZ, +Y up

  heightData = new Float32Array(NV);
  heightTex = new THREE.DataTexture(heightData, VX, VY, THREE.RedFormat, THREE.FloatType);
  heightTex.magFilter = THREE.NearestFilter;
  heightTex.minFilter = THREE.NearestFilter;
  heightTex.needsUpdate = true;

  material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: tune.rough,
    metalness: tune.metal,
    envMapIntensity: tune.env,
  });

  // Custom uniforms shared into the injected shader.
  const u = {
    uHeight: { value: heightTex },
    uTexel: { value: new THREE.Vector2(1 / VX, 1 / VY) },
    uHScale: { value: tune.heightScale },
    uWorld: { value: new THREE.Vector2(WORLD_X, WORLD_Z) },
    uHome: { value: new THREE.Color(0x335a9a) },
    uAway: { value: new THREE.Color(0x12a060) },
    uFront: { value: 0.5 },
    uPoss: { value: 0.5 },
    uDim: { value: tune.ownerDim },
    uGlow: { value: tune.glow },
    uGlowCol: { value: new THREE.Color(tune.glowCol) },
    uSat: { value: tune.sat },
    uTex: { value: tune.tex },
    uWobble: { value: tune.wobble },
    uAO: { value: tune.ao },
    uTime: { value: 0 },
  };
  material.userData.u = u;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injected = shader.uniforms;

    // ---- VERTEX ----
    shader.vertexShader = `
      uniform sampler2D uHeight;
      uniform vec2 uTexel;
      uniform float uHScale;
      uniform vec2 uWorld;
      varying float vHd;
      varying vec2 vUvN;
      float H7(vec2 uv){
        float h = texture2D(uHeight, uv).r * uHScale;
        // NaN/Inf guard so the surface never opens see-through holes.
        if (!(h == h)) h = 0.0;
        return clamp(h, 0.0, 40.0);
      }
    ` + shader.vertexShader;

    // finite-difference normal from the height texture
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
        vUvN = uv;
        {
          float hl = H7(uv - vec2(uTexel.x, 0.0));
          float hr = H7(uv + vec2(uTexel.x, 0.0));
          float hd = H7(uv - vec2(0.0, uTexel.y));
          float hu = H7(uv + vec2(0.0, uTexel.y));
          float dx = (uWorld.x * uTexel.x) * 2.0;
          float dz = (uWorld.y * uTexel.y) * 2.0;
          objectNormal = normalize(vec3(-(hr - hl)/max(dx,1e-4), 1.0, -(hu - hd)/max(dz,1e-4)));
        }
      `
    );

    // height displacement
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
        float h7 = H7(uv);
        vHd = h7;
        transformed.y += h7;
      `
    );

    // ---- FRAGMENT ----
    shader.fragmentShader = `
      uniform vec3 uHome;
      uniform vec3 uAway;
      uniform float uFront;
      uniform float uPoss;
      uniform float uDim;
      uniform float uGlow;
      uniform vec3 uGlowCol;
      uniform float uSat;
      uniform float uTex;
      uniform float uWobble;
      uniform float uAO;
      uniform float uTime;
      varying float vHd;
      varying vec2 vUvN;

      float h21_7(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vn7(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        float a=h21_7(i), b=h21_7(i+vec2(1,0)), c=h21_7(i+vec2(0,1)), d=h21_7(i+vec2(1,1));
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
      }
      float fbm7(vec2 p){
        float s=0.0, a=0.5;
        for (int i=0;i<4;i++){ s += a*vn7(p); p = p*2.03 + vec2(11.3,7.7); a *= 0.5; }
        return s;
      }
    ` + shader.fragmentShader;

    // inject the data-driven team/seam colour into diffuseColor
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        // OWNERSHIP — seam (uFront) tracks live possession+momentum, boundary
        // domain-warped by two noise scales (broad warp + fine ripple teeth).
        float warpBroad = fbm7(vUvN * vec2(3.0, 5.0) + vec2(uTime*0.06, uTime*0.045));
        float warpFine  = fbm7(vUvN * vec2(13.0, 19.0) + vec2(-uTime*0.16, uTime*0.12));
        float warp = mix(warpBroad, warpFine, 0.4);
        float warpX = vUvN.x + uWobble * (warp - 0.5);
        float side = smoothstep(uFront - 0.04, uFront + 0.04, warpX);
        vec3 team = mix(uHome, uAway, side);

        // saturation boost (kills muddy look)
        float lum = dot(team, vec3(0.299, 0.587, 0.114));
        team = max(mix(vec3(lum), team, uSat), 0.0);

        // POSSESSION GATE (H2): possessing side bright, passive dims to uDim.
        float possActive = mix(1.0 - uPoss, uPoss, side);
        float possGate = mix(uDim, 1.0, possActive);
        vec3 baseCol = team * possGate;

        // CLAY TEXTURE — churning multi-octave marble, amount = uTex.
        float marble = fbm7(vUvN * 22.0 + vec2(0.0, uTime*0.05));
        baseCol *= (1.0 - 0.5*uTex) + uTex*marble;

        // cheap curvature/height ambient occlusion in valleys (shader fallback,
        // layered with the GTAO-style post pass via uAO). Low ground + concave
        // seam troughs darken; tall crests stay open.
        float lowAO = 1.0 - smoothstep(0.0, 0.55, vHd);   // valleys are occluded
        float crevAO = 1.0 - 0.5*abs(warp - 0.5)*2.0;      // warped seam crease
        float ao = clamp(1.0 - uAO * 0.5 * (lowAO*0.7 + (1.0-crevAO)*0.5), 0.25, 1.0);
        baseCol *= ao;

        diffuseColor.rgb = baseCol;
      }
      `
    );

    // inject the fiery glowing-crest highlight into emissive
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        vec3 Nw = normalize(vNormal);
        float steep = 1.0 - clamp(Nw.y, 0.0, 1.0);
        float hot = smoothstep(0.3, 1.3, vHd) * smoothstep(0.12, 0.62, steep);
        float flick = 0.82 + 0.18*vn7(vUvN*40.0 + uTime*0.7);
        vec3 hi = uGlowCol * 2.2 + smoothstep(0.7, 1.4, vHd) * 0.6;
        totalEmissiveRadiance += hi * hot * uGlow * 2.0 * flick;
      }
      `
    );
  };

  mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // ground/slab plane that receives the mesh's shadow so masses sit grounded.
  slab = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_X * 1.6, WORLD_Z * 1.8),
    new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.92, metalness: 0.0 })
  );
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = -0.02;
  slab.receiveShadow = true;
  scene.add(slab);
}

// ---- post-processing composer ----------------------------------------------
function setupComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // UnrealBloom — soft bloom on the bright crests/glow (the big "expensive" tell)
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), tune.bloomStr, tune.bloomRad, tune.bloomThr);
  composer.addPass(bloomPass);

  // custom grade: vignette + exposure/contrast/saturation
  gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  // anti-aliasing pass for clean edges
  smaaPass = new SMAAPass(1, 1);
  composer.addPass(smaaPass);

  composer.addPass(new OutputPass());
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVig: { value: 0.5 },
    uExpo: { value: 1.0 },
    uContr: { value: 1.06 },
    uGsat: { value: 1.04 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVig;
    uniform float uExpo;
    uniform float uContr;
    uniform float uGsat;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // exposure
      c *= uExpo;
      // saturation
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uGsat);
      // contrast around mid-grey
      c = (c - 0.5) * uContr + 0.5;
      // vignette
      vec2 d = vUv - 0.5;
      float vig = smoothstep(0.85, 0.25, length(d) * 1.4);
      c *= mix(1.0, vig, clamp(uVig, 0.0, 1.5));
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

// ---- colors -----------------------------------------------------------------
function vivid(rgb) {
  const c = rgb01(rgb);
  const m = Math.max(c[0], c[1], c[2], 1e-3);
  const k = 0.95 / m;
  return [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)];
}
function rgbToHex(c) {
  const f = (v) => ('0' + Math.round(clamp(v, 0, 1) * 255).toString(16)).slice(-2);
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}
function uHome() { return material.userData.u.uHome.value; }
function uAway() { return material.userData.u.uAway.value; }
function applyTeamColors() {
  const h = vivid(model.home.rgb), a = vivid(model.away.rgb);
  const hHex = tune.homeCol || rgbToHex(h);
  const aHex = tune.awayCol || rgbToHex(a);
  if (tune.homeCol) uHome().set(hHex); else uHome().setRGB(h[0], h[1], h[2]);
  if (tune.awayCol) uAway().set(aHex); else uAway().setRGB(a[0], a[1], a[2]);
  const hc = el('homecol'), ac = el('awaycol');
  if (hc) hc.value = hHex; if (ac) ac.value = aHex;
  document.documentElement.style.setProperty('--home-color', hHex);
  document.documentElement.style.setProperty('--away-color', aHex);
}

// ============================================================================
// THE SIMULATION — identical to stage6 (real data only).
// ============================================================================
const A_INSTANT = 0.18;
const B_ACCUM = 0.22;
const H_MAX = 0.9;
const BASE_AMP = 0.05;
const TURB_SCALE = 0.55;
const RIDGE_H = 1.3;
const RIDGE_W = 0.07;

let permFrontShove = 0;

function frontAt(yN, t) {
  const mom = at(model.series.mom, t, model.STEP);
  const possHomeLive = clamp(at(model.series.possHome, t, model.STEP), 0.05, 0.95);
  const wave = (fbm(yN * 2.2, 0.0, t * 0.03, 3)) * 0.06;
  const base = lerp(0.5, possHomeLive, clamp(tune.seamPoss, 0, 1));
  return clamp(base + A_INSTANT * mom + wave, 0.12, 0.88);
}

function syncEruptions(t) {
  if (t < lastSimT - 0.001) {
    activeEruptions = [];
    eruptionCursor = 0;
    permFrontShove = 0;
  }
  while (eruptionCursor < model.eruptions.length && model.eruptions[eruptionCursor].t <= t) {
    const e = model.eruptions[eruptionCursor++];
    if (e.isGoal) {
      const ex = e.team === 'home' ? Math.max(e.x, 0.7) : Math.min(e.x, 0.3);
      activeEruptions.push({ x: ex, y: e.y, amp0: 1.5, tStart: e.t, life: 6, perm: false });
      activeEruptions.push({ x: ex, y: e.y, amp0: 0.5, tStart: e.t, life: 1e9, perm: true });
      permFrontShove += (e.team === 'home' ? 0.05 : -0.05);
    } else {
      activeEruptions.push({ x: e.x, y: e.y, amp0: 0.3 + e.xg * 1.6, tStart: e.t, life: 3, perm: false });
    }
  }
}

function eruptionAt(xN, yN, t) {
  let sum = 0;
  for (let i = 0; i < activeEruptions.length; i++) {
    const e = activeEruptions[i];
    if (t < e.tStart) continue;
    let amp = e.amp0;
    if (!e.perm) {
      const age = t - e.tStart;
      if (age > e.life) continue;
      const rise = smoothstep(0, 0.6, age);
      const fall = 1 - smoothstep(e.life * 0.3, e.life, age);
      amp *= rise * fall;
    }
    const dx = xN - e.x, dy = yN - e.y;
    const r2 = dx * dx + dy * dy;
    sum += amp * Math.exp(-r2 / (2 * 0.0045));
  }
  return sum;
}

function computeHeight(t) {
  syncEruptions(t);
  const S = model.series;
  const intensity = at(S.intensity, t, model.STEP);
  const cumPH = at(S.cumPossHome, t, model.STEP);
  const cumPA = at(S.cumPossAway, t, model.STEP);
  const stress = at(S.cumStress, t, model.STEP);

  const homeBase = H_MAX * cumPH;
  const awayBase = H_MAX * cumPA;
  const turbAmp = (BASE_AMP + intensity * TURB_SCALE) * tune.turbulence;
  const flowZ = t * 0.5 * tune.flowSpeed;
  const ridgeW = RIDGE_W / Math.max(0.25, tune.ridgeSharp);
  const ridgeHeight = RIDGE_H * stress;

  const fronts = new Float32Array(VY);
  for (let j = 0; j < VY; j++) fronts[j] = frontAt(j / (VY - 1), t);

  let idx = 0;
  for (let j = 0; j < VY; j++) {
    const yN = j / (VY - 1);
    const front = fronts[j];
    for (let i = 0; i < VX; i++, idx++) {
      const xN = i / (VX - 1);
      const side = smoothstep(front - 0.10, front + 0.10, xN);
      let h = lerp(homeBase, awayBase, side);
      const dF = (xN - front) / ridgeW;
      h += ridgeHeight * Math.exp(-0.5 * dF * dF);
      h += turbAmp * fbm(xN * 6.0, yN * 4.0, flowZ, 4);
      h += eruptionAt(xN, yN, t);
      heightData[idx] = Math.max(0, h);
    }
  }
  heightTex.needsUpdate = true;
  lastSimT = t;
}

// ---- resize -----------------------------------------------------------------
function onResize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w * dpr, h * dpr);
    if (smaaPass) smaaPass.setSize(w * dpr, h * dpr);
  }
}

// ---- main loop --------------------------------------------------------------
let lastNow = performance.now();
let simAccum = 0;
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (model && playing) {
    clock += dt * tune.speed;
    if (clock >= model.duration) { clock = model.duration; playing = false; el('play').textContent = '▶ play'; }
  }

  simAccum += dt;
  if (model && (simAccum >= 1 / 30 || lastSimT < 0)) { simAccum = 0; computeHeight(clock); }

  if (material && model) {
    updateFrameUniforms(dt);
    applyLookUniforms();
  }

  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
  requestAnimationFrame(loop);
}

// per-frame data-driven uniform updates (live seam + possession gate)
function updateFrameUniforms(dt) {
  const u = material.userData.u;
  u.uHScale.value = tune.heightScale;
  u.uTime.value = clock * 0.5 * tune.flowSpeed;
  u.uFront.value = frontAt(0.5, clock);
  const possHome = clamp(at(model.series.possHome, clock, model.STEP), 0, 1);
  const targetAway = 1 - possHome;
  uPossCur += (targetAway - uPossCur) * Math.min(1, dt * 3.0);
  u.uPoss.value = uPossCur;
}

// ---- dev hook ---------------------------------------------------------------
// Set the clock, resim the height field, update all uniforms, render exactly one
// frame via the composer (so it works in a throttled/hidden tab).
window.__setClock = (min) => {
  if (!model) return;
  clock = clamp(+min || 0, 0, model.duration);
  playing = false;
  const playBtn = el('play'); if (playBtn) playBtn.textContent = '▶ play';
  lastSimT = -1;
  computeHeight(clock);
  if (material) {
    const u = material.userData.u;
    u.uHScale.value = tune.heightScale;
    u.uTime.value = clock * 0.5 * tune.flowSpeed;
    u.uFront.value = frontAt(0.5, clock);
    const possHome = clamp(at(model.series.possHome, clock, model.STEP), 0, 1);
    uPossCur = 1 - possHome;
    u.uPoss.value = uPossCur;
    applyLookUniforms();
  }
  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
};

// Push all the colour/lighting/effect/material/post tunables into uniforms.
function applyLookUniforms() {
  if (!material) return;
  const u = material.userData.u;
  u.uDim.value = tune.ownerDim;
  u.uGlow.value = tune.glow;
  u.uGlowCol.value.set(tune.glowCol);
  u.uSat.value = tune.sat;
  u.uTex.value = tune.tex;
  u.uWobble.value = tune.wobble;
  u.uAO.value = tune.ao;

  // PBR material
  material.roughness = tune.rough;
  material.metalness = tune.metal;
  material.envMapIntensity = tune.env;

  // lighting: map stage6's "light" + "amb" onto the real light rig.
  // key/fill intensity from `light`; ambient floor from `amb` (env intensity
  // also lifts the IBL ambient). Shadow strength via key opacity-ish.
  keyLight.intensity = 1.0 + tune.light * 3.0;
  // ambient floor: scale the hemisphere up with `amb`.
  scene.children.forEach((c) => {
    if (c.isHemisphereLight) c.intensity = 0.25 + tune.amb * 1.4;
  });
  renderer.toneMappingExposure = 1.0;

  // shadow strength: fade shadow darkness by easing intensity contribution.
  if (renderer.shadowMap) renderer.shadowMap.needsUpdate = false;
  keyLight.castShadow = tune.shadow > 0.001;
  keyLight.shadow.intensity !== undefined && (keyLight.shadow.intensity = clamp(tune.shadow, 0, 1));

  // post
  if (bloomPass) { bloomPass.strength = tune.bloomStr; bloomPass.radius = tune.bloomRad; bloomPass.threshold = tune.bloomThr; }
  if (gradePass) {
    gradePass.uniforms.uVig.value = tune.vig;
    gradePass.uniforms.uExpo.value = tune.expo;
    gradePass.uniforms.uContr.value = tune.contr;
    gradePass.uniforms.uGsat.value = tune.gsat;
  }
}

// ---- HUD --------------------------------------------------------------------
function updateHud() {
  if (!model) return;
  const t = clock;
  let gH = model.shots.filter((s) => s.team === 'home' && s.isGoal && s.t <= t).length;
  let gA = model.shots.filter((s) => s.team === 'away' && s.isGoal && s.t <= t).length;
  if (t >= model.duration - 0.01) { gH = model.home.score; gA = model.away.score; }
  else { gH = Math.min(gH, model.home.score); gA = Math.min(gA, model.away.score); }

  const ph = Math.round(at(model.series.possHome, t, model.STEP) * 100);
  const mom = at(model.series.mom, t, model.STEP);
  el('hScore').textContent = gH; el('aScore').textContent = gA;
  const mm = Math.floor(t);
  el('clk').textContent = mm + "'";
  el('hPoss').textContent = ph; el('aPoss').textContent = 100 - ph;
  el('mom').textContent = (mom >= 0 ? '+' : '') + mom.toFixed(2);
  el('hXg').textContent = xgUpTo(model.shots, 'home', t).toFixed(2);
  el('aXg').textContent = xgUpTo(model.shots, 'away', t).toFixed(2);
  if (document.activeElement !== el('clock')) el('clock').value = String((t / model.duration) * 100);
}

// ---- camera readout + copy --------------------------------------------------
function updateCamReadout() {
  if (!controls) return;
  const az = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
  const pol = THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const dist = camera.position.distanceTo(controls.target);
  el('camread').textContent = `az ${az.toFixed(0)}° · pol ${pol.toFixed(0)}° · d ${dist.toFixed(1)}`;
}

// ---- UI binding -------------------------------------------------------------
function bindUI() {
  const playBtn = el('play');
  playBtn.addEventListener('click', () => {
    if (!model) return;
    if (!playing && clock >= model.duration) clock = 0;
    playing = !playing;
    playBtn.textContent = playing ? '❚❚ pause' : '▶ play';
  });
  el('restart').addEventListener('click', () => {
    clock = 0; lastSimT = -1; playing = true; playBtn.textContent = '❚❚ pause';
  });
  el('clock').addEventListener('input', () => {
    if (!model) return;
    clock = (+el('clock').value / 100) * model.duration;
    playing = false; playBtn.textContent = '▶ play';
    lastSimT = -1;
  });

  // sim / data
  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('hscale', 'hscaleV', (v) => { tune.heightScale = v; return v.toFixed(2); });
  bindSlider('turb', 'turbV', (v) => { tune.turbulence = v; return v.toFixed(2); });
  bindSlider('ridge', 'ridgeV', (v) => { tune.ridgeSharp = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('flow', 'flowV', (v) => { tune.flowSpeed = v; return v.toFixed(2); });
  bindSlider('seam', 'seamV', (v) => { tune.seamPoss = v; lastSimT = -1; return v.toFixed(2); });
  bindSlider('wobble', 'wobbleV', (v) => { tune.wobble = v; return v.toFixed(2); });
  // colour
  bindSlider('ownerdim', 'ownerdimV', (v) => { tune.ownerDim = v; return v.toFixed(2); });
  bindSlider('sat', 'satV', (v) => { tune.sat = v; return v.toFixed(2); });
  bindSlider('tex', 'texV', (v) => { tune.tex = v; return v.toFixed(2); });
  bindSlider('glow', 'glowV', (v) => { tune.glow = v; return v.toFixed(2); });
  // material
  bindSlider('rough', 'roughV', (v) => { tune.rough = v; return v.toFixed(2); });
  bindSlider('metal', 'metalV', (v) => { tune.metal = v; return v.toFixed(2); });
  bindSlider('env', 'envV', (v) => { tune.env = v; return v.toFixed(2); });
  // lighting
  bindSlider('light', 'lightV', (v) => { tune.light = v; return v.toFixed(2); });
  bindSlider('amb', 'ambV', (v) => { tune.amb = v; return v.toFixed(2); });
  bindSlider('shadow', 'shadowV', (v) => { tune.shadow = v; return v.toFixed(2); });
  bindSlider('ao', 'aoV', (v) => { tune.ao = v; return v.toFixed(2); });
  // post
  bindSlider('bloomStr', 'bloomStrV', (v) => { tune.bloomStr = v; return v.toFixed(2); });
  bindSlider('bloomRad', 'bloomRadV', (v) => { tune.bloomRad = v; return v.toFixed(2); });
  bindSlider('bloomThr', 'bloomThrV', (v) => { tune.bloomThr = v; return v.toFixed(2); });
  bindSlider('vig', 'vigV', (v) => { tune.vig = v; return v.toFixed(2); });
  bindSlider('expo', 'expoV', (v) => { tune.expo = v; return v.toFixed(2); });
  bindSlider('contr', 'contrV', (v) => { tune.contr = v; return v.toFixed(2); });
  bindSlider('gsat', 'gsatV', (v) => { tune.gsat = v; return v.toFixed(2); });

  // glow colour picker
  const gc = el('glowcol');
  if (gc) {
    gc.value = tune.glowCol;
    const applyGc = () => { tune.glowCol = gc.value; if (material) material.userData.u.uGlowCol.value.set(gc.value); };
    gc.addEventListener('input', applyGc);
    applyGc();
  }

  // per-team colour pickers (override the data colours)
  const hc = el('homecol');
  if (hc) hc.addEventListener('input', () => {
    tune.homeCol = hc.value;
    if (material) uHome().set(hc.value);
    document.documentElement.style.setProperty('--home-color', hc.value);
  });
  const ac = el('awaycol');
  if (ac) ac.addEventListener('input', () => {
    tune.awayCol = ac.value;
    if (material) uAway().set(ac.value);
    document.documentElement.style.setProperty('--away-color', ac.value);
  });

  // COPY SETTINGS → clipboard (with a textarea fallback)
  const copyBtn = el('copyset');
  if (copyBtn) {
    const dump = el('copysetDump');
    let flashT = 0;
    copyBtn.addEventListener('click', async () => {
      const json = JSON.stringify(settingsBlob(), null, 2);
      const flash = () => { copyBtn.textContent = 'copied ✓'; clearTimeout(flashT); flashT = setTimeout(() => { copyBtn.textContent = 'COPY SETTINGS'; }, 1400); };
      try { await navigator.clipboard.writeText(json); if (dump) dump.style.display = 'none'; flash(); }
      catch { if (dump) { dump.value = json; dump.style.display = 'block'; dump.focus(); dump.select(); } copyBtn.textContent = 'copy below ↓'; clearTimeout(flashT); flashT = setTimeout(() => { copyBtn.textContent = 'COPY SETTINGS'; }, 1800); }
    });
  }

  el('resetcam').addEventListener('click', () => { applyDefaultCamera(); });
  el('copycam').addEventListener('click', async () => {
    const s = `{ pos: [${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}], ` +
      `target: [${controls.target.x.toFixed(2)}, ${controls.target.y.toFixed(2)}, ${controls.target.z.toFixed(2)}] }`;
    try { await navigator.clipboard.writeText(s); el('camread').textContent = 'copied'; }
    catch { el('camread').textContent = s; }
  });
}

// Snapshot EVERY tunable + the camera as a JSON blob.
function settingsBlob() {
  const r2 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
  return {
    tune: {
      speed: r2(tune.speed), heightScale: r2(tune.heightScale), turbulence: r2(tune.turbulence),
      ridgeSharp: r2(tune.ridgeSharp), flowSpeed: r2(tune.flowSpeed),
      seamPoss: r2(tune.seamPoss), wobble: r2(tune.wobble), ownerDim: r2(tune.ownerDim),
      sat: r2(tune.sat), light: r2(tune.light), amb: r2(tune.amb), tex: r2(tune.tex),
      glow: r2(tune.glow), glowCol: tune.glowCol,
      homeCol: (el('homecol') && el('homecol').value) || tune.homeCol,
      awayCol: (el('awaycol') && el('awaycol').value) || tune.awayCol,
      // cinematic additions
      rough: r2(tune.rough), metal: r2(tune.metal), env: r2(tune.env),
      shadow: r2(tune.shadow), ao: r2(tune.ao),
      bloomStr: r2(tune.bloomStr), bloomRad: r2(tune.bloomRad), bloomThr: r2(tune.bloomThr),
      vig: r2(tune.vig), expo: r2(tune.expo), contr: r2(tune.contr), gsat: r2(tune.gsat),
    },
    camera: {
      pos: [r2(camera.position.x), r2(camera.position.y), r2(camera.position.z)],
      target: [r2(controls.target.x), r2(controls.target.y), r2(controls.target.z)],
    },
  };
}

function bindSlider(id, valId, fn) {
  const s = el(id), v = el(valId);
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply);
  apply();
}
