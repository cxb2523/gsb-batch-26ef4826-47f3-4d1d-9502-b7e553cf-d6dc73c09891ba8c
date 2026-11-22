import * as THREE from 'three';
import './style.css';
import { CAMERA } from './config.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Game, STEP } from './game/game.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadModels, loadReport, modelBuilders } from './visuals/models.js';
import { registerModelBuilders } from './visuals/registry.js';
import { switchVisuals } from './visuals/switcher.js';

const params = new URLSearchParams(location.search);
const speed = Number(params.get('speed')) || 1;   // >1 only for the test bot

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a1f3d);
scene.fog = new THREE.Fog(0x2a1f3d, 18, 40);
// Environment map so PBR materials are never black (the toon materials use the lights below).
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xfff1d6, 0x3a2b55, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(4, 10, 6);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 100);
function resize() {
  const w = innerWidth, h = innerHeight, aspect = w / h;
  renderer.setSize(w, h);
  camera.aspect = aspect;
  // Keep at least ~60° of horizontal view so narrow (portrait) screens still see the fight.
  const minH = THREE.MathUtils.degToRad(60);
  const needV = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(minH / 2) / aspect));
  camera.fov = Math.min(75, Math.max(CAMERA.fov, needV));
  camera.updateProjectionMatrix();
  document.body.classList.toggle('portrait', aspect < 1);
}
addEventListener('resize', resize);
resize();

const input = new Input();
const touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.classList.toggle('touch', touch);
addEventListener('touchstart', () => document.body.classList.add('touch'), { once: true });
input.bindTouch(...['stick', 'knob', 'btn-punch', 'btn-kick'].map(id => document.getElementById(id)));

const hud = new Hud(input);
const game = new Game(scene, camera, input, hud);
window.__game = game;       // for testing in the console
window.__renderer = renderer;
window.__THREE = THREE;

if (params.has('bot')) import('./bot.js').then(m => m.startBot(game, input));

// Look switch. The game starts in greybox; the Tripo models load on demand, the first time
// models are asked for (button, V key, or ?look=models), and are never requested again after
// that one load. While they load the button shows LOADING…; clicks during the load are not
// lost — the last ask wins, and a load that finishes late never undoes a newer click.
// The Tripo link opens in a new tab; drop focus so Enter (restart) does not open it again.
document.getElementById('made-with').addEventListener('click', e => e.currentTarget.blur());
const lookBtn = document.getElementById('look');
const notice = document.getElementById('notice');
let lookWanted = 'greybox';    // what the last click asked for
let lookApplied = 'greybox';   // what is on screen
let modelsPromise = null;      // the one and only load, shared by every ask
let noticeTimer = 0;

function drawLookButton() {
  lookBtn.textContent = lookWanted === 'models' && lookApplied !== 'models' ? 'LOADING…'
    : lookApplied === 'models' ? 'MODELS' : 'GREYBOX';
}

function applyLook(mode) {
  switchVisuals(game, mode);
  lookApplied = mode;
  drawLookButton();
}

function showNotice(text) {
  notice.textContent = text;
  notice.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('show'), 6000);
}

function askLook(mode) {
  lookWanted = mode;
  drawLookButton();
  if (mode === 'greybox') {
    if (lookApplied !== 'greybox') applyLook('greybox');
    return;
  }
  modelsPromise ??= loadModels().then(protos => {
    registerModelBuilders(modelBuilders(protos));
    window.__loadReport = loadReport;
    const failed = loadReport.filter(r => !r.ok);
    for (const f of failed) console.warn(`Model ${f.file} did not load (${f.error}); showing its greybox placeholder.`);
    if (failed.length === loadReport.length) showNotice('Models did not load — every character keeps its greybox look');
    else if (failed.length) showNotice(`Missing ${failed.map(f => f.file).join(', ')} — greybox stand-in for those`);
    return loadReport;
  }).catch(e => {   // a load that fails outright still leaves a playable greybox game
    console.warn(`Models did not load (${e.message || e}); staying in greybox.`);
    showNotice('Models did not load — staying in greybox');
    return loadReport;
  });
  window.__modelsReady = modelsPromise;
  // Apply only if this is still the latest ask when the load finishes.
  modelsPromise.then(() => { if (lookWanted === 'models' && lookApplied !== 'models') applyLook('models'); });
}

lookBtn.addEventListener('click', () => { lookBtn.blur(); askLook(lookWanted === 'models' ? 'greybox' : 'models'); });
addEventListener('keydown', e => { if (e.code === 'KeyV' && !e.repeat) askLook(lookWanted === 'models' ? 'greybox' : 'models'); });
if (params.get('look') === 'models') askLook('models');
drawLookButton();

let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * speed;
  let steps = 0;
  while (acc >= STEP && steps < 8 * speed) {
    game.beforeStep?.(STEP);
    game.step(STEP);
    acc -= STEP;
    steps++;
  }
  if (steps >= 8 * speed) acc = 0;
  game.render(dt, Math.min(1, acc / STEP));
  renderer.render(scene, camera);
}
// ?manual=1: tests drive frames themselves through window.__frame(timeMs).
// __steps(n) advances only the game logic by n fixed steps (no drawing), for fast test replays.
if (params.has('manual')) {
  window.__frame = frame;
  window.__steps = n => { for (let i = 0; i < n; i++) { game.beforeStep?.(STEP); game.step(STEP); } };
  window.__spawn = (kind, side = 1, z = 0) => game.addEnemy(kind, side, z);
  last = 0;
}
else renderer.setAnimationLoop(frame);
