// stage3.js — "COLLISION" — a genuinely VOLUMETRIC 3D WebGL stage driven by REAL
// match data (default France 3–1 Senegal, id 1953888). Two THICK masses are
// extruded from each goal end (home from x=0, away from x=1) like toothpaste/clay
// squeezed from a tube; they push toward the centre and COLLIDE. The longer the
// match runs, the BIGGER the masses grow and the HIGHER they pile up at the seam,
// and the stronger the collisions erupt. Goals are big eruptions.
//
// Core tech: MarchingCubes metaballs (true isosurface union → blobs merge),
// HDR + ACES tone mapping + UnrealBloomPass + emissive vivid colors → JUICY look.
//
// Self-contained: depends on three.js (CDN) + claybattle.js (data model) +
// massbattle.js (vivid palette). Does NOT modify any existing file.

import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildModel, at, xgUpTo } from './claybattle.js';
import { clamp, vivid, rgb01, rgbCss, easeOut } from './massbattle.js';

const ID = new URLSearchParams(location.search).get('id') || '1953888';
const el = (id) => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;

// ---- scene state ------------------------------------------------------------
let renderer, scene, camera, controls, composer, bloomPass;
let mc;                                    // MarchingCubes object (the masses)
let model = null;
let clock = 0, playing = true;
let homeColor, awayColor, seamColor;       // THREE.Color (vivid)

const tune = {
  speed: 4.0,
  mass: 1.0,        // overall mass size multiplier
  rise: 1.0,        // collision-pile height multiplier
  bloom: 0.45,      // bloom strength
  iso: 80,          // MarchingCubes isolation (smoothness)
};

// transient eruptions (goals / shots) advanced as the clock passes them
let activeEruptions = [];
let eruptionCursor = 0;
let permHome = 0, permAway = 0;            // permanent size bumps from goals

// ---- boot -------------------------------------------------------------------
init().catch((e) => fail(e && (e.message || String(e))));

async function init() {
  if (!window.WebGLRenderingContext) throw new Error('WebGL not available in this browser');

  const raw = await fetch('/api/rich/' + ID).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
  model = buildModel(raw);
  deriveColors();

  setupThree();
  setupMasses();
  bindUI();

  el('title3').textContent =
    `COLLISION · ${model.home.abbr || 'HOME'} ${model.home.score}–${model.away.score} ${model.away.abbr || 'AWAY'}`;
  el('hAbbr').textContent = model.home.abbr || 'HOME';
  el('aAbbr').textContent = model.away.abbr || 'AWAY';

  window.addEventListener('resize', onResize);
  onResize();
  requestAnimationFrame(loop);
}

function fail(msg) {
  const t = el('title3'); if (t) t.textContent = 'COLLISION · failed: ' + (msg || 'error');
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#f88;font:14px system-ui;text-align:center;padding:40px;z-index:99;background:#06070d;white-space:pre-wrap';
  o.textContent = 'COLLISION could not start: ' + (msg || 'error') +
    '\n\n(If three.js failed to load from the CDN, check your connection — it is loaded via esm.sh.)';
  document.body.appendChild(o);
}

// ---- vivid palette ----------------------------------------------------------
function deriveColors() {
  // REAL kit colours (recognisable & effective). Keyed by team abbr; fall back to
  // a vivid version of the API hex for teams we haven't tabled yet.
  const KITS = {
    FRA: { p: '#1a37c8', a: '#d4111f' },   // France — saturated royal blue + red
    SEN: { p: '#00b85a', a: '#f4f6fb' },   // Senegal — vivid green (+ white)
  };
  const toRgb = (hex) => {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const hk = KITS[model.home.abbr], ak = KITS[model.away.abbr];
  const homeV = hk ? toRgb(hk.p) : vivid(toRgb(model.home.colorHex || '#26406A'), 0.9, 0.56, 0.62);
  const awayV = ak ? toRgb(ak.p) : vivid(toRgb(model.away.colorHex || '#0c954e'), 0.9, 0.55, 0.4);
  homeColor = new THREE.Color(...rgb01(homeV));
  awayColor = new THREE.Color(...rgb01(awayV));
  // the collision pile = a blue↔green clash (keeps colour), NOT white-out
  seamColor = homeColor.clone().lerp(awayColor, 0.5);

  document.documentElement.style.setProperty('--home-color', rgbCss(homeV));
  document.documentElement.style.setProperty('--away-color', rgbCss(awayV));
}

// ---- three.js setup ---------------------------------------------------------
function setupThree() {
  const canvas = el('stage');
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070912);    // dark, not pure black
  scene.fog = new THREE.FogExp2(0x070912, 0.012);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0.0, 5.5, 16.0);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 40;
  controls.target.set(0, 1.6, 0);

  // soft lighting; most of the punch comes from emissive + bloom, but a key/fill
  // gives the volumetric masses readable form.
  const key = new THREE.DirectionalLight(0xfff2e6, 1.6);
  key.position.set(-7, 11, 6); scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.7);
  rim.position.set(8, 5, -7); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0x556688, 0x0a0c14, 0.6));
  scene.add(new THREE.AmbientLight(0x141826, 0.5));

  // a faint dark base slab so the masses sit on a ground
  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 40),
    new THREE.MeshStandardMaterial({ color: 0x080a12, roughness: 1, metalness: 0 })
  );
  slab.rotation.x = -Math.PI / 2; slab.position.y = -2.6; scene.add(slab);

  // ---- post-processing: HDR bloom for the JUICY glow (tuned so colour shows,
  // not blown to white) ----
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.6, 0.9);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

// ---- the masses (MarchingCubes metaballs) -----------------------------------
function setupMasses() {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.34, metalness: 0.0,
  });
  // emissive = vColor * emissiveK so the vivid vertex colors GLOW and bloom.
  // also add a subtle fbm clay/lava marble — secondary to the punchy color.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEmK = { value: 1.15 };
    shader.uniforms.uTime = { value: 0 };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vWPos;')
      .replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\n uniform float uEmK; uniform float uTime; varying vec3 vWPos;\n' +
        'float h31(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5);}\n' +
        'float vn3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);\n' +
        ' float n=mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),\n' +
        '   mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z);\n' +
        ' return n;}')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
        ' float marble = vn3(vWPos*1.6 + vec3(0.0,uTime*0.15,0.0))*0.5 + vn3(vWPos*4.0)*0.25;\n' +
        ' vec3 vivCol = vColor.rgb * (0.78 + 0.5*marble);\n' +
        ' totalEmissiveRadiance += vivCol * uEmK;');
  };

  // resolution 96; if perf is poor, drop the first arg to 72.
  mc = new MarchingCubes(96, material, true, true, 90000);
  mc.isolation = tune.iso;
  mc.enableColors = true;
  // map the [0,1]^3 metaball space to a wide, upward slab. NOTE MarchingCubes maps
  // field [0,1] → local [-1,1], so the field's vertical centre (0.5) is at y=0.
  mc.scale.set(11, 6.0, 7.0);     // X = pitch length, Y = up, Z = width band
  mc.position.set(0, 0.5, 0);
  // MarchingCubes' local +Y is its "up"; rotate so internal z(height) -> Y
  // Actually MarchingCubes addBall(x,y,z) maps directly to its local axes; we
  // treat ball arg #2 (y) as UP and #3 (z) as width. Default orientation already
  // has local Y up, so we pass (px, height, width).
  scene.add(mc);
}

// ============================================================================
// THE SIMULATION — rebuild the two masses at match-time t each frame.
//
//   front(t)  = collision plane along pitch length, shoved by momentum
//   homeMass  : balls over x∈[0.06 .. front], low height, vivid HOME color;
//               extent/size ∝ cumPossHome(t) (grows over match) + permHome
//   awayMass  : mirror on x∈[front .. 0.94], vivid AWAY color; ∝ cumPossAway
//   pile      : balls stacked UP at the seam; height ∝ cumStress(t), plus a
//               transient surge ∝ intensity(t) (stronger active collisions)
//   eruptions : goals = big fast-rising transient at the seam + permanent bump
// ============================================================================
function frontAt(t) {
  const mom = at(model.series.mom, t, model.STEP);
  const cum = at(model.series.cumMom, t, model.STEP);
  return clamp(0.5 + 0.18 * mom + 0.22 * cum + permFrontShove, 0.2, 0.8);
}
let permFrontShove = 0;

function syncEruptions(t) {
  if (t < lastSimT - 0.001) {     // scrubbed backwards → reset
    activeEruptions = []; eruptionCursor = 0;
    permHome = 0; permAway = 0; permFrontShove = 0;
  }
  while (eruptionCursor < model.eruptions.length && model.eruptions[eruptionCursor].t <= t) {
    const e = model.eruptions[eruptionCursor++];
    if (e.isGoal) {
      // big transient eruption at the seam, biased to the scoring side
      activeEruptions.push({ t0: e.t, life: 6, amp0: 1.0, team: e.team, kind: 'goal' });
      // permanent size bump to that team + a shove of the front into the opponent
      if (e.team === 'home') { permHome += 0.10; permFrontShove += 0.04; }
      else { permAway += 0.10; permFrontShove -= 0.04; }
    } else {
      activeEruptions.push({ t0: e.t, life: 3, amp0: 0.25 + (e.xg || 0) * 0.9, team: e.team, kind: 'shot' });
    }
  }
}
let lastSimT = -1;

// current goal-eruption strength + its biased seam offset
function eruptionState(t) {
  let goalAmp = 0, sideBias = 0, shotAmp = 0;
  for (let i = 0; i < activeEruptions.length; i++) {
    const e = activeEruptions[i];
    const age = t - e.t0;
    if (age < 0 || age > e.life) continue;
    const rise = easeOut(clamp(age / 0.7, 0, 1));      // fast rise ~0.7 min
    const fall = 1 - clamp((age - e.life * 0.35) / (e.life * 0.65), 0, 1);
    const a = e.amp0 * rise * fall;
    if (e.kind === 'goal') { goalAmp = Math.max(goalAmp, a); sideBias += (e.team === 'home' ? a : -a); }
    else shotAmp = Math.max(shotAmp, a);
  }
  return { goalAmp, sideBias, shotAmp };
}

// Build the metaball field for time t. Internal MarchingCubes space is [0,1]^3.
function buildField(t) {
  syncEruptions(t);
  mc.reset();
  const S = model.series;
  const intensity = at(S.intensity, t, model.STEP);
  const cumPH = at(S.cumPossHome, t, model.STEP);
  const cumPA = at(S.cumPossAway, t, model.STEP);
  const stress = at(S.cumStress, t, model.STEP);
  const front = frontAt(t);
  const er = eruptionState(t);

  // mass "reach" grows over the match: at kickoff the masses are short stubs near
  // their goals; by full time they reach the seam. cumPoss is normalized [0,1].
  const grow = clamp(0.25 + 0.75 * (t / model.duration), 0, 1);   // time growth
  const homeReach = lerp(0.06, front, clamp(grow * (0.7 + 0.6 * cumPH), 0, 1));
  const awayReach = lerp(0.94, front, clamp(grow * (0.7 + 0.6 * cumPA), 0, 1));
  const homeSize = (0.10 + 0.06 * cumPH + permHome) * tune.mass;
  const awaySize = (0.10 + 0.06 * cumPA + permAway) * tune.mass;

  const subtract = 12;          // smaller = fatter/softer blobs (thick tube look)
  const yBand = 0.5;            // width-axis centre
  const bandHalf = 0.30;        // how wide across the width the masses spread
  const baseZ = 0.5;            // resting height = field centre (sits at y≈0 world)

  // ---- HOME mass: thick cluster of balls from goal toward the seam ----
  addTube(0.06, homeReach, homeSize, baseZ, yBand, bandHalf, homeColor, subtract);
  // ---- AWAY mass: mirror ----
  addTube(awayReach, 0.94, awaySize, baseZ, yBand, bandHalf, awayColor, subtract);

  // ---- COLLISION PILE: stack balls UP at the seam ----
  // pile height grows with cumStress; transient surge with current intensity and
  // any active goal eruption → stronger, taller collisions through the match.
  const seamX = clamp(front + er.sideBias * 0.04, 0.18, 0.82);
  const pileH = (0.18 + 1.2 * stress + 0.9 * intensity + 1.6 * er.goalAmp) * tune.rise;
  const pileSize = (0.11 + 0.05 * stress + 0.05 * er.goalAmp + 0.04 * er.shotAmp) * tune.mass;
  const layers = 7;
  for (let l = 0; l < layers; l++) {
    const f = l / (layers - 1);
    const z = clamp(baseZ + f * pileH, 0.05, 0.96);
    // taper the stack as it rises, and jitter across the width for an organic pile
    const sz = pileSize * (1.0 - 0.42 * f);
    const ny = 1 + (l % 3);
    for (let k = 0; k < ny; k++) {
      const yy = clamp(yBand + (k - (ny - 1) / 2) * (bandHalf * 0.5), 0.12, 0.88);
      const c = seamColor.clone().lerp(z > baseZ + pileH * 0.5 ? seamColor : seamColor, 0.0);
      mc.addBall(clamp(seamX + (k % 2 ? 0.01 : -0.01), 0.05, 0.95), z, yy, sz, subtract, c);
    }
  }

  // ---- GOAL eruption fountain (extra tall transient at the seam) ----
  if (er.goalAmp > 0.01) {
    const gx = clamp(front + er.sideBias * 0.05, 0.15, 0.85);
    const top = clamp(baseZ + (1.6 + 1.2 * tune.rise) * er.goalAmp, 0.1, 0.99);
    const fountains = 5;
    for (let l = 0; l < fountains; l++) {
      const f = l / (fountains - 1);
      const z = clamp(lerp(baseZ, top, f), 0.05, 0.99);
      const sz = (0.13 - 0.05 * f) * er.goalAmp * 1.4 * tune.mass;
      const c = seamColor.clone().lerp(new THREE.Color(1.0, 0.92, 0.6), 0.4 * f);
      mc.addBall(gx, z, yBand, Math.max(0.02, sz), subtract, c);
    }
  }

  mc.update();
}

// Lay a row of fat balls between x0..x1 across the width band at a low height,
// giving the "squeezed from a tube" thick volumetric mass.
function addTube(x0, x1, size, baseZ, yBand, bandHalf, color, subtract) {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  const span = Math.max(0.001, hi - lo);
  const nx = clamp(Math.round(span / 0.06) + 2, 3, 18);
  const ny = 5;
  for (let i = 0; i < nx; i++) {
    const fx = i / (nx - 1);
    const px = clamp(lo + fx * span, 0.04, 0.96);
    // mass piles a touch higher toward the leading edge (the seam) — pushing up
    const edge = Math.abs(px - (lo === x0 ? hi : lo));   // distance from goal end
    for (let j = 0; j < ny; j++) {
      const fy = j / (ny - 1);
      const yy = clamp(yBand + (fy - 0.5) * 2 * bandHalf, 0.1, 0.9);
      // width taper: fatter in the middle of the band
      const wt = 1.0 - 0.35 * Math.abs(fy - 0.5) * 2;
      const z = clamp(baseZ * (0.7 + 0.5 * wt) + 0.05 * edge, 0.05, 0.9);
      const sz = Math.max(0.02, size * wt);
      mc.addBall(px, z, yy, sz, subtract, color);
    }
  }
}

// ---- resize -----------------------------------------------------------------
function onResize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---- main loop --------------------------------------------------------------
let lastNow = performance.now();
function loop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (model && playing) {
    clock += dt * tune.speed;
    if (clock >= model.duration) { clock = model.duration; playing = false; el('play').textContent = '▶ play'; }
  }
  simulateAndRender(dt);
  requestAnimationFrame(loop);
}

function simulateAndRender(dt) {
  if (!model) return;
  mc.isolation = tune.iso;
  buildField(clock);
  lastSimT = clock;

  const sh = mc.material.userData && mc.material.userData.shader;
  if (sh) { sh.uniforms.uTime.value = clock; sh.uniforms.uEmK.value = 0.6; }
  bloomPass.strength = tune.bloom;

  controls.update();
  composer.render();
  updateHud();
  updateCamReadout();
}

// dev hook for offscreen verification — set clock, force one sim+render.
window.__setClock = (min) => {
  if (!model) return;
  clock = clamp(Number(min) || 0, 0, model.duration);
  playing = false; lastSimT = -1;
  const pb = el('play'); if (pb) pb.textContent = '▶ play';
  simulateAndRender(0);
  return clock;
};

// ---- HUD --------------------------------------------------------------------
function updateHud() {
  const t = clock;
  let gH = model.shots.filter((s) => s.team === 'home' && s.isGoal && s.t <= t).length;
  let gA = model.shots.filter((s) => s.team === 'away' && s.isGoal && s.t <= t).length;
  if (t >= model.duration - 0.01) { gH = model.home.score; gA = model.away.score; }
  else { gH = Math.min(gH, model.home.score); gA = Math.min(gA, model.away.score); }

  const ph = Math.round(at(model.series.possHome, t, model.STEP) * 100);
  const mom = at(model.series.mom, t, model.STEP);
  el('hScore').textContent = gH; el('aScore').textContent = gA;
  el('clk').textContent = Math.floor(t) + "'";
  el('hPoss').textContent = ph; el('aPoss').textContent = 100 - ph;
  el('mom').textContent = (mom >= 0 ? '+' : '') + mom.toFixed(2);
  el('hXg').textContent = xgUpTo(model.shots, 'home', t).toFixed(2);
  el('aXg').textContent = xgUpTo(model.shots, 'away', t).toFixed(2);
  const clk = el('clock');
  if (document.activeElement !== clk) clk.value = String((t / model.duration) * 100);
  el('clockV').textContent = Math.floor(t) + "'";
}

function updateCamReadout() {
  const az = THREE.MathUtils.radToDeg(controls.getAzimuthalAngle());
  const pol = THREE.MathUtils.radToDeg(controls.getPolarAngle());
  const dist = camera.position.distanceTo(controls.target);
  el('camread').textContent = `az ${az.toFixed(0)}° · pol ${pol.toFixed(0)}° · d ${dist.toFixed(1)}`;
}

// ---- UI binding -------------------------------------------------------------
function bindUI() {
  const playBtn = el('play');
  playBtn.addEventListener('click', () => {
    if (!playing && clock >= model.duration) clock = 0;
    playing = !playing;
    playBtn.textContent = playing ? '❚❚ pause' : '▶ play';
  });
  el('restart').addEventListener('click', () => {
    clock = 0; lastSimT = -1; playing = true; playBtn.textContent = '❚❚ pause';
  });
  el('clock').addEventListener('input', () => {
    clock = (+el('clock').value / 100) * model.duration;
    playing = false; playBtn.textContent = '▶ play'; lastSimT = -1;
  });

  bindSlider('speed', 'speedV', (v) => { tune.speed = v; return v.toFixed(1) + '×'; });
  bindSlider('mass', 'massV', (v) => { tune.mass = v; return v.toFixed(2); });
  bindSlider('rise', 'riseV', (v) => { tune.rise = v; return v.toFixed(2); });
  bindSlider('bloom', 'bloomV', (v) => { tune.bloom = v; return v.toFixed(2); });
  bindSlider('iso', 'isoV', (v) => { tune.iso = v; return String(Math.round(v)); });

  el('resetcam').addEventListener('click', () => {
    camera.position.set(0.0, 5.5, 16.0); controls.target.set(0, 1.6, 0); controls.update();
  });
  el('copycam').addEventListener('click', async () => {
    const s = `{ pos: [${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}], ` +
      `target: [${controls.target.x.toFixed(2)}, ${controls.target.y.toFixed(2)}, ${controls.target.z.toFixed(2)}] }`;
    try { await navigator.clipboard.writeText(s); el('camread').textContent = 'copied'; }
    catch { el('camread').textContent = s; }
  });
}

function bindSlider(id, valId, fn) {
  const s = el(id), v = el(valId);
  const apply = () => { v.textContent = fn(+s.value); };
  s.addEventListener('input', apply);
  apply();
}
