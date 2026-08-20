import * as THREE from "three";
import { makeCharacterModel, animateCharacter } from "/arena3d/character.js";

const canvas = document.getElementById("game");
const statusEl = document.getElementById("status");
const recordBtn = document.getElementById("recordBtn");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const HORIZON = 0x7d6f96;
const scene = new THREE.Scene();
scene.background = new THREE.Color(HORIZON);
scene.fog = new THREE.Fog(HORIZON, 10, 40);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.5, 3.7);
camera.lookAt(0, 1.05, 0);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
window.addEventListener("resize", resize);
resize();

function makeCanvasTexture(size, draw) {
  const cnv = document.createElement("canvas");
  cnv.width = cnv.height = size;
  const c = cnv.getContext("2d");
  draw(c, size);
  return new THREE.CanvasTexture(cnv);
}

// dusk sky, matching the arena's palette — same mood as the reference render
const skyTex = makeCanvasTexture(128, (c, s) => {
  const g = c.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, "#1c2a52");
  g.addColorStop(0.35, "#3d3f74");
  g.addColorStop(0.6, "#7c5f8c");
  g.addColorStop(0.82, "#d98a6b");
  g.addColorStop(1, "#f7cf94");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(60, 16, 16),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
);
scene.add(sky);

scene.add(new THREE.HemisphereLight(0x6a6fb0, 0x2c3355, 0.75));
const sun = new THREE.DirectionalLight(0xffb066, 1.35);
sun.position.set(5, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);
const rim = new THREE.PointLight(0xffe9a8, 0.7, 8);
rim.position.set(-2.2, 2.3, 1.6);
scene.add(rim);

// distant snowy mountains for depth, echoing the arena
function makeMountain(x, z, r, h, color) {
  const geo = new THREE.ConeGeometry(r, h, 8, 3);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < h / 2 - 0.1) {
      const jitter = r * 0.18;
      pos.setX(i, pos.getX(i) + (Math.random() - 0.5) * jitter);
      pos.setZ(i, pos.getZ(i) + (Math.random() - 0.5) * jitter);
    }
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  m.position.set(x, h / 2 - 0.4, z);
  scene.add(m);
}
for (let i = 0; i < 9; i++) {
  const a = (i / 9) * Math.PI * 2;
  makeMountain(Math.cos(a) * 15, Math.sin(a) * 15 - 6, 4 + Math.random() * 3, 8 + Math.random() * 6, i % 2 ? 0xc7d1e0 : 0x9aa8c0);
}

const ground = new THREE.Mesh(new THREE.CircleGeometry(20, 32), new THREE.MeshStandardMaterial({ color: 0x3a4560, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// podium, matching the reference's circular pedestal
const podium = new THREE.Mesh(
  new THREE.CylinderGeometry(1.1, 1.2, 0.16, 32),
  new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.4, metalness: 0.5 })
);
podium.position.y = 0.08;
podium.receiveShadow = true;
podium.castShadow = true;
scene.add(podium);
const podiumRim = new THREE.Mesh(
  new THREE.TorusGeometry(1.13, 0.03, 8, 32),
  new THREE.MeshStandardMaterial({ color: 0xe8b23c, metalness: 0.8, roughness: 0.3 })
);
podiumRim.position.y = 0.16;
podiumRim.rotation.x = Math.PI / 2;
scene.add(podiumRim);

// the character, standing on the podium
const turnGroup = new THREE.Group();
turnGroup.position.y = 0.16;
scene.add(turnGroup);
const model = makeCharacterModel();
turnGroup.add(model.group);
animateCharacter(model, "walking", 0);

// setTimeout instead of requestAnimationFrame — rAF is paused whenever this
// tab isn't the visible/foreground one, which would silently freeze the
// canvas (and any recording of it) the moment the tab loses focus.
function loop() {
  renderer.render(scene, camera);
  setTimeout(loop, 1000 / 30);
}
loop();

// ---------- 360 turntable recording ----------
let recording = false;

async function record() {
  if (recording) return;
  recording = true;
  recordBtn.disabled = true;
  statusEl.textContent = "Recording...";

  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
    ? "video/webm;codecs=vp8"
    : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const DURATION = 8000; // ms for a full 360 turn
  const startTime = performance.now();

  function spin() {
    const t = Math.min(1, (performance.now() - startTime) / DURATION);
    turnGroup.rotation.y = t * Math.PI * 2;
    if (t < 1) setTimeout(spin, 1000 / 30);
  }

  const done = new Promise((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const reader = new FileReader();
      reader.onload = () => {
        window.__recordingDataURL = reader.result;
        window.__recordingSize = blob.size;
        window.__recordingReady = true;
        statusEl.textContent = "Done — " + Math.round(blob.size / 1024) + " KB, ready to export.";
        recording = false;
        recordBtn.disabled = false;
        resolve();
      };
      reader.readAsDataURL(blob);
    };
  });

  recorder.start();
  spin();
  setTimeout(() => recorder.stop(), DURATION + 150);
  return done;
}

recordBtn.addEventListener("click", record);
window.__triggerRecord = record;
