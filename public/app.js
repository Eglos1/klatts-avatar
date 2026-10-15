/* kLattsch Avatar — 3D human body + lip-sync + llama3.2:1b + klattsch engine */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------------------------------------------------------------- *
 *  DOM
 * ---------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const sceneEl = $('scene');
const log = $('log');
const form = $('inputForm');
const input = $('input');
const sendBtn = $('sendBtn');
const modeSel = $('mode');
const emotionSel = $('emotion');
const pitchSlider = $('pitch');
const rateSlider = $('rate');
const exprSlider = $('expr');
const vibSlider = $('vib');
const brSlider = $('br');
const pitchVal = $('pitchVal');
const rateVal = $('rateVal');
const exprVal = $('exprVal');
const vibVal = $('vibVal');
const brVal = $('brVal');
const phonemesOut = $('phonemesOut');
const statusEl = $('status');
const speakingLine = $('speakingLine');
const embedToggle = $('embedToggle');
const embedWrap = $('embedWrap');

const MAX_HISTORY = 10;
let history = [];

/* ---------------------------------------------------------------- *
 *  Renderer / scene / camera
 * ---------------------------------------------------------------- */
const renderer = new THREE.WebGLRenderer({ canvas: sceneEl, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 2.1, 6.6);
camera.lookAt(0, 1.6, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1.6, 0);
controls.minDistance = 3;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI * 0.92;
controls.minPolarAngle = Math.PI * 0.12;

function resize() {
  const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ---------------------------------------------------------------- *
 *  Lights + ground
 * ---------------------------------------------------------------- */
scene.add(new THREE.HemisphereLight(0xa7b8ff, 0x141a26, 0.85));
scene.add(new THREE.AmbientLight(0xffffff, 0.18));

const key = new THREE.DirectionalLight(0xffffff, 1.9);
key.position.set(3, 6, 4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);

const fill = new THREE.DirectionalLight(0x5c8cff, 0.4);
fill.position.set(-4, 2, -3);
scene.add(fill);

// ground disc
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(6, 64),
  new THREE.MeshStandardMaterial({ color: 0x151b28, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// soft fake shadow blob under the figure
{
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(0, 0.012, 0);
  scene.add(blob);
}

/* ---------------------------------------------------------------- *
 *  Materials
 * ---------------------------------------------------------------- */
const M = {
  skin:  new THREE.MeshStandardMaterial({ color: 0xf0b08f, roughness: 0.75 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.85 }),
  pants: new THREE.MeshStandardMaterial({ color: 0x2f3d55, roughness: 0.9 }),
  shoe:  new THREE.MeshStandardMaterial({ color: 0x1e2634, roughness: 0.7 }),
  hair:  new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.8 }),
  eyeW:  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }),
  pupil: new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.2 }),
  mouth: new THREE.MeshStandardMaterial({ color: 0x572c26, roughness: 0.6 }),
  nose:  new THREE.MeshStandardMaterial({ color: 0xeaa07d, roughness: 0.8 }),
};

function capsule(r, len, mat) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 16), mat);
  m.castShadow = true;
  return m;
}
function sphere(r, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), mat);
  m.castShadow = true;
  return m;
}

/* ---------------------------------------------------------------- *
 *  Build the 3D human body (feet at y = 0, head top ~ y = 3.4)
 * ---------------------------------------------------------------- */
const figure = new THREE.Group();

/* --- legs --- */
function buildLeg(side) {
  const leg = new THREE.Group();                 // pivot at hip (y=1.58)
  const thigh = capsule(0.19, 0.62, M.pants);    // 0.88..1.58
  thigh.position.y = -0.35;
  const shin = capsule(0.16, 0.62, M.pants);     // 0.18..0.88
  shin.position.y = -1.05;
  const foot = new THREE.Mesh(                    // 0..0.18
    new THREE.BoxGeometry(0.24, 0.18, 0.46), M.shoe
  );
  foot.position.set(side * 0.03, -1.49, 0.07);
  foot.castShadow = true;
  leg.add(thigh, shin, foot);
  return leg;
}
const legL = buildLeg(-1);
legL.position.set(-0.24, 1.58, 0);
const legR = buildLeg(1);
legR.position.set(0.24, 1.58, 0);
figure.add(legL, legR);

/* --- torso --- */
const torso = new THREE.Group();
torso.position.y = 1.58;

const chest = capsule(0.48, 0.62, M.shirt);      // 1.7..2.5
chest.position.y = 0.51;
const hips = capsule(0.46, 0.22, M.shirt);       // 1.58..1.8
hips.position.y = 0.11;
torso.add(chest, hips);

/* --- arms (pivot at shoulder y=2.36) --- */
function buildArm(side) {
  const arm = new THREE.Group();
  const shoulder = sphere(0.19, M.skin);
  const upper = capsule(0.14, 0.42, M.skin);     // 1.86..2.36
  upper.position.y = -0.25;
  const forearm = capsule(0.12, 0.4, M.skin);    // 1.4..1.8
  forearm.position.y = -0.68;
  const hand = sphere(0.11, M.skin);
  hand.position.set(0, -1.0, 0);
  arm.add(shoulder, upper, forearm, hand);
  return arm;
}
const armL = buildArm(-1);
armL.position.set(-0.62, 2.36, 0);
armL.rotation.z = 0.08;
const armR = buildArm(1);
armR.position.set(0.62, 2.36, 0);
armR.rotation.z = -0.08;
torso.add(armL, armR);
figure.add(torso);

/* --- neck --- */
const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.28, 16), M.skin);
neck.position.y = 2.62;
neck.castShadow = true;
figure.add(neck);

/* --- head --- */
const head = new THREE.Group();
head.position.y = 3.0;

const skull = sphere(0.44, M.skin);
head.add(skull);

// hair: dome over the top
const hair = new THREE.Mesh(
  new THREE.SphereGeometry(0.46, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.46),
  M.hair
);
hair.position.set(0, 0.07, -0.03);
hair.castShadow = true;
head.add(hair);

// eyes (white + pupil), blink by scaling group Y
function buildEye(side) {
  const g = new THREE.Group();
  const white = sphere(0.09, M.eyeW);
  white.scale.set(1, 1.05, 0.9);
  const pupil = sphere(0.045, M.pupil);
  pupil.position.z = 0.06;
  g.add(white, pupil);
  g.position.set(side * 0.15, 0.13, 0.36);
  return g;
}
const eyeL = buildEye(-1);
const eyeR = buildEye(1);
head.add(eyeL, eyeR);

// nose
const nose = sphere(0.05, M.nose);
nose.scale.set(1, 1.15, 1);
nose.position.set(0, -0.01, 0.44);
head.add(nose);

// mouth (opens for lip-sync)
const mouth = sphere(0.1, M.mouth);
mouth.position.set(0, -0.18, 0.38);
mouth.scale.set(1.7, 0.5, 0.8);   // flattened ellipsoid (closed)
head.add(mouth);

// simple lips ring (subtle)
const lips = new THREE.Mesh(
  new THREE.TorusGeometry(0.105, 0.016, 10, 24, Math.PI),
  M.skin
);
lips.rotation.z = Math.PI / 2;
lips.rotation.y = Math.PI / 2;
lips.position.set(0, -0.18, 0.39);
head.add(lips);

figure.add(head);

// gentle default pose
figure.rotation.y = Math.PI * 0.05;
scene.add(figure);

/* ---------------------------------------------------------------- *
 *  Audio
 * ---------------------------------------------------------------- */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 512;
analyser.smoothingTimeConstant = 0.6;
analyser.connect(audioCtx.destination);
const timeData = new Uint8Array(analyser.fftSize);

let speaking = false;
let currentSource = null;

function audioLevel() {
  analyser.getByteTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / timeData.length) * 3.2);
}

async function playWavBase64(b64) {
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const buffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
  if (currentSource) {
    try { currentSource.stop(); } catch (_) {}
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser);
  src.onended = () => {
    speaking = false;
    speakingLine.classList.remove('on');
  };
  currentSource = src;
  speaking = true;
  src.start();
}

/* ---------------------------------------------------------------- *
 *  Avatar animation
 * ---------------------------------------------------------------- */
const clock = new THREE.Clock();
let blinkTimer = 2 + Math.random() * 3;
let blinkUntil = 0;
let lastBlink = 0;
let mouthLevel = 0;

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  const amp = speaking ? audioLevel() : 0;

  /* idle motion */
  torso.scale.y = 1 + 0.018 * Math.sin(t * 2.0);            // breathing
  figure.position.y = 0.012 * Math.sin(t * 1.6);            // bounce
  figure.rotation.z = 0.015 * Math.sin(t * 0.8);            // sway

  /* arm sway */
  armL.rotation.z = 0.08 + 0.06 * Math.sin(t * 1.6);
  armR.rotation.z = -0.08 - 0.06 * Math.sin(t * 1.6);

  /* head life */
  head.rotation.y = 0.12 * Math.sin(t * 0.5);
  head.rotation.x = speaking ? -0.05 - amp * 0.09 : 0.02 * Math.sin(t * 0.9);

  /* blinking */
  if (t - lastBlink > blinkTimer) {
    blinkUntil = t + 0.16;
    blinkTimer = 1.8 + Math.random() * 3.4;
    lastBlink = t;
  }
  const blink = t < blinkUntil ? 0.15 : 1;
  eyeL.scale.y = eyeR.scale.y = blink;

  /* lip-sync: ease the mouth toward the audio level */
  const target = speaking ? 0.45 + amp * 0.9 : 0;
  mouthLevel += (target - mouthLevel) * 0.32;
  mouth.scale.set(1.7, 0.5 + mouthLevel * 0.95, 0.8 + mouthLevel * 0.45);

  /* head bob in time with speech */
  if (speaking) {
    figure.position.y += 0.006 * Math.sin(t * 4.2);
    head.rotation.z = 0.03 * Math.sin(t * 3.1);
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();

/* ---------------------------------------------------------------- *
 *  UI / API
 * ---------------------------------------------------------------- */
function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}
function clearStatus() {
  statusEl.className = 'status hidden';
}

function addMsg(text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  const label = who === 'user' ? 'you' : 'avatar';
  div.innerHTML = `<span class="who">${label}</span>`;
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

async function speak(text, emotionOverride) {
  const pitch = +pitchSlider.value;
  const rate = +rateSlider.value;
  const expressiveness = +exprSlider.value / 100;
  const vibrato = +vibSlider.value;
  const breathiness = +brSlider.value;
  // "auto" -> the caller decides; null/undefined also fall back to warm
  const emotion = emotionOverride
    || (emotionSel.value === 'auto' ? undefined : emotionSel.value);

  setStatus('synthesizing…', 'busy');
  try {
    const data = await post('/api/speak', {
      text,
      emotion,
      pitch,
      rate,
      vibrato,
      breathiness,
      expressiveness,
    });
    phonemesOut.textContent = data.stream || '';
    speakingLine.textContent = text;
    speakingLine.classList.add('on');
    setStatus(`speaking — ${data.emotion || 'warm'} voice`, 'busy');
    await playWavBase64(data.wav);
  } catch (err) {
    setStatus('synthesis error: ' + err.message, 'err');
    speakingLine.classList.remove('on');
  } finally {
    clearStatus();
  }
}

async function chat(text) {
  setStatus('thinking (llama3.2:1b)…', 'busy');
  try {
    const data = await post('/api/chat', { message: text, history });
    history = [...history, { role: 'user', content: text }, { role: 'assistant', content: data.text }];
    if (history.length > MAX_HISTORY * 2) history = history.slice(-MAX_HISTORY * 2);
    addMsg(data.text, 'av');
    // let the LLM's chosen emotion drive the voice unless the user pinned one
    const emo = emotionSel.value === 'auto' ? data.emotion : undefined;
    setStatus(`synthesizing (${emo || emotionSel.value || 'warm'})…`, 'busy');
    await speak(data.text, emo);
  } catch (err) {
    setStatus('LLM error: ' + err.message, 'err');
    addMsg('⚠ ' + err.message, 'av');
  } finally {
    clearStatus();
  }
}

/* submit */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;
  input.value = '';
  addMsg(text, 'user');

  sendBtn.disabled = true;
  try {
    if (modeSel.value === 'llm') await chat(text);
    else await speak(text);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

/* Enter to send, Shift+Enter for newline */
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

/* sliders */
pitchSlider.addEventListener('input', () => { pitchVal.textContent = pitchSlider.value + ' Hz'; });
rateSlider.addEventListener('input', () => { rateVal.textContent = rateSlider.value + ' ms/ph'; });
exprSlider.addEventListener('input', () => { exprVal.textContent = exprSlider.value + '%'; });
vibSlider.addEventListener('input', () => { vibVal.textContent = vibSlider.value + ' Hz'; });
brSlider.addEventListener('input', () => { brVal.textContent = brSlider.value; });

/* klatts.ch embed toggle */
embedToggle.addEventListener('click', () => {
  embedWrap.classList.toggle('hidden');
  embedToggle.textContent = embedWrap.classList.contains('hidden')
    ? 'Show klattsch embed'
    : 'Hide klattsch embed';
});

/* first gesture resumes audio */
window.addEventListener('pointerdown', () => {
  if (audioCtx.state === 'suspended') audioCtx.resume();
});

/* fetch model tag + warm intro */
(async () => {
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    $('modelTag').textContent = info.llm;
  } catch (_) {}
  const intro =
    'Hello. I am a one billion parameter language model, speaking through a 1970s formant synthesizer. Ask me anything.';
  addMsg(intro, 'av');
  speak(intro);
})();
