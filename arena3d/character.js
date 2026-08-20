import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

// Shared character model — gold-skinned, black-and-gold tactical suit,
// matching the reference render. Used by both the game (arena3d.js) and the
// standalone turntable capture (showcase.html), so they never drift apart.
//
// Two ways to get a model:
//  - makeCharacterModel() below: the original procedural build (raw Three.js
//    primitives), still used by showcase.js.
//  - loadCharacterModel() at the bottom: loads the Blender-authored
//    character.glb (see blender/build_character.py) — real organic geometry
//    (boolean-merged head, subsurf, beveled hard-surface suit) instead of
//    primitives, built with a joint hierarchy that matches the procedural
//    model exactly so animateCharacter() drives either one unchanged.

function makeCanvasTexture(size, draw) {
  const cnv = document.createElement("canvas");
  cnv.width = cnv.height = size;
  const cctx = cnv.getContext("2d");
  draw(cctx, size);
  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const camoTex = makeCanvasTexture(128, (c, s) => {
  c.fillStyle = "#2b2f22";
  c.fillRect(0, 0, s, s);
  const blobColors = ["#3d4530", "#17190f", "#5a4a1e", "#242017"];
  for (let i = 0; i < 22; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    c.fillStyle = blobColors[Math.floor(Math.random() * blobColors.length)];
    c.beginPath();
    c.moveTo(x, y);
    for (let k = 0; k < 5; k++) c.lineTo(x + (Math.random() - 0.5) * 42, y + (Math.random() - 0.5) * 42);
    c.closePath();
    c.fill();
  }
});

export const WHITE = new THREE.Color(0xffffff);

export function makeCharacterModel() {
  const group = new THREE.Group();

  const goldBase = new THREE.Color(0xe8b23c);
  const suitBase = new THREE.Color(0x151519);
  const goldMat = new THREE.MeshStandardMaterial({ color: goldBase.clone(), metalness: 0.75, roughness: 0.32 });
  const goldDarkMat = new THREE.MeshStandardMaterial({ color: 0xb8842a, metalness: 0.7, roughness: 0.4 });
  const suitMat = new THREE.MeshStandardMaterial({ color: suitBase.clone(), roughness: 0.55, metalness: 0.05 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x1a140a, roughness: 0.4 });
  const gunBodyMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.5, metalness: 0.3 });
  const beltMat = new THREE.MeshStandardMaterial({ color: 0x0e0e10, roughness: 0.6 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x8a6a20, roughness: 0.5, metalness: 0.4 });
  const camoTexInst = camoTex.clone();
  camoTexInst.needsUpdate = true;
  camoTexInst.repeat.set(2, 2);
  const bootMat = new THREE.MeshStandardMaterial({ map: camoTexInst, roughness: 0.85 });
  const soleMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.8 });

  const hipY = 0.48;
  function makeLeg() {
    const pivot = new THREE.Group();
    pivot.position.set(0, hipY, 0);
    const pants = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.066, hipY * 0.78, 8), suitMat);
    pants.position.y = -hipY * 0.4;
    pivot.add(pants);
    const knee = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.06), goldMat);
    knee.position.set(0, -hipY * 0.62, 0.06);
    pivot.add(knee);
    const boot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), bootMat);
    boot.scale.set(1, 0.6, 1.5);
    boot.position.set(0, -hipY + 0.02, 0.07);
    pivot.add(boot);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.035, 0.28), soleMat);
    sole.position.set(0, -hipY - 0.05, 0.07);
    pivot.add(sole);
    return pivot;
  }
  const legL = makeLeg(); legL.position.x = -0.1; group.add(legL);
  const legR = makeLeg(); legR.position.x = 0.1; group.add(legR);

  const torsoH = 0.5;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, torsoH * 0.5, 4, 10), suitMat);
  torso.position.set(0, hipY + torsoH / 2, 0);
  group.add(torso);

  const chestPanel = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.32, 4), goldMat);
  chestPanel.rotation.x = Math.PI / 2;
  chestPanel.rotation.z = Math.PI / 4;
  chestPanel.scale.set(1, 1, 0.35);
  chestPanel.position.set(0, hipY + torsoH * 0.62, 0.17);
  group.add(chestPanel);

  const tie = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.28, 0.02), goldMat);
  tie.position.set(0, hipY + torsoH * 0.78, 0.19);
  group.add(tie);

  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.07, 10), beltMat);
  belt.position.set(0, hipY + 0.02, 0);
  group.add(belt);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.02), goldMat);
  buckle.position.set(0, hipY + 0.02, 0.18);
  group.add(buckle);
  const holster = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.06), suitMat);
  holster.position.set(0.18, hipY - 0.06, 0.05);
  group.add(holster);
  const pistolGrip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.03), gunBodyMat);
  pistolGrip.position.set(0.18, hipY + 0.02, 0.05);
  group.add(pistolGrip);

  const shoulderY = hipY + torsoH;

  function makePauldron(sign) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.135, 10, 8), goldMat);
    p.scale.set(1, 0.85, 1.1);
    p.position.set(sign * 0.26, shoulderY + 0.06, 0);
    group.add(p);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 8), suitMat);
    base.position.set(sign * 0.24, shoulderY - 0.02, 0);
    group.add(base);

    // lion-mane fan of gold spikes around the outer/back arc of the pauldron —
    // left as an open arc (not a full ring) so nothing pokes through the neck
    const maneCenter = new THREE.Vector3(sign * 0.26, shoulderY + 0.06, 0);
    const spikeCount = 7;
    for (let i = 0; i < spikeCount; i++) {
      const t = i / (spikeCount - 1) - 0.5; // -0.5..0.5
      const theta = t * 2.5; // ~143 degree fan
      const pivot = new THREE.Group();
      pivot.position.copy(maneCenter);
      pivot.rotation.y = (sign > 0 ? 0 : Math.PI) + theta;
      group.add(pivot);
      const len = 0.13 + Math.abs(t) * 0.05;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.024, len, 6), goldDarkMat);
      spike.rotation.z = -Math.PI / 2 + 0.4;
      spike.position.set(0.14, 0.03 - Math.abs(t) * 0.03, 0);
      pivot.add(spike);
    }
  }
  makePauldron(-1); makePauldron(1);

  // small tactical tassets hanging off the back of the belt — a nod to the
  // reference render's back detail, kept short so it reads as gear rather
  // than a fantasy cape
  function makeTasset(offsetX) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 0.025), suitMat);
    strip.position.set(offsetX, hipY - 0.14, -0.13);
    strip.rotation.x = 0.15;
    group.add(strip);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.03), goldMat);
    tip.position.set(offsetX, hipY - 0.25, -0.14);
    group.add(tip);
  }
  makeTasset(-0.09); makeTasset(0); makeTasset(0.09);

  const UPPER_ARM_LEN = 0.17;
  const FOREARM_LEN = 0.19;

  function makeHand() {
    const hand = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.08, 0.058), goldMat);
    palm.position.y = -0.03;
    hand.add(palm);
    for (let i = 0; i < 4; i++) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.055, 0.05), goldMat);
      finger.position.set(-0.028 + i * 0.019, -0.09, 0.004);
      hand.add(finger);
    }
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.045, 0.03), goldMat);
    thumb.position.set(0.046, -0.03, 0.028);
    thumb.rotation.z = -0.5;
    hand.add(thumb);
    return hand;
  }

  function makeArm() {
    const pivot = new THREE.Group(); // shoulder joint
    pivot.position.set(0, shoulderY - 0.04, 0);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.054, UPPER_ARM_LEN, 8), suitMat);
    sleeve.position.y = -UPPER_ARM_LEN / 2;
    pivot.add(sleeve);

    const elbow = new THREE.Group(); // elbow joint, hinges relative to the shoulder
    elbow.position.y = -UPPER_ARM_LEN;
    pivot.add(elbow);

    const elbowCap = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), suitMat);
    elbow.add(elbowCap);
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.046, FOREARM_LEN, 8), goldMat);
    forearm.position.y = -FOREARM_LEN / 2;
    elbow.add(forearm);

    const hand = makeHand();
    hand.position.y = -FOREARM_LEN;
    elbow.add(hand);

    pivot.elbow = elbow;
    pivot.hand = hand;
    return pivot;
  }
  const armL = makeArm(); armL.position.x = -0.22; group.add(armL);
  const armR = makeArm(); armR.position.x = 0.22; group.add(armR);
  armL.rotation.x = -1.0;
  armR.rotation.x = -1.0;
  armL.elbow.rotation.x = -0.55;
  armR.elbow.rotation.x = -0.55;

  const watch = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.013, 6, 10), goldMat);
  watch.rotation.x = Math.PI / 2;
  watch.position.set(0, -0.15, 0);
  armL.elbow.add(watch);

  const gunGroup = new THREE.Group();
  const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.34), gunBodyMat);
  gunGroup.add(gunBody);
  const gunTrim = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.02, 0.3), goldDarkMat);
  gunTrim.position.y = 0.045;
  gunGroup.add(gunTrim);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.14, 0.05), goldDarkMat);
  mag.position.set(0, -0.1, 0.04);
  mag.rotation.x = 0.25;
  gunGroup.add(mag);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.28, 8), gunBodyMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, 0.3);
  gunGroup.add(barrel);
  const barrelTip = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.006, 6, 10), goldMat);
  barrelTip.position.set(0, 0.01, 0.44);
  gunGroup.add(barrelTip);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.14, 8), gunBodyMat);
  scope.rotation.x = Math.PI / 2;
  scope.position.set(0, 0.075, 0.02);
  gunGroup.add(scope);
  gunGroup.position.set(0, -0.05, 0.07);
  gunGroup.rotation.x = 0.1;
  armR.hand.add(gunGroup);

  const neckH = 0.1;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, neckH, 8), goldMat);
  neck.position.set(0, shoulderY + neckH / 2, 0);
  group.add(neck);

  const headR = 0.37;
  const headScale = { x: 0.92, y: 1.14, z: 0.92 };
  const headY = shoulderY + neckH + headR * headScale.y * 0.62;
  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 16, 14), goldMat);
  head.scale.set(headScale.x, headScale.y, headScale.z);
  head.position.set(0, headY, 0);
  group.add(head);

  function makeEar(sign) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), goldMat);
    ear.scale.set(0.5, 1, 1.05);
    ear.position.set(sign * headR * headScale.x * 0.95, headY - 0.02, -0.01);
    group.add(ear);
  }
  makeEar(-1); makeEar(1);

  const noseBridge = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.24, 9), goldMat);
  noseBridge.rotation.x = Math.PI * 0.36;
  noseBridge.position.set(0, headY + 0.01, headR * headScale.z * 0.92);
  group.add(noseBridge);
  const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), goldMat);
  noseTip.position.set(0, headY - 0.11, headR * headScale.z * 1.05);
  group.add(noseTip);

  function makeEye(sign) {
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), pupilMat);
    pupil.position.set(sign * 0.14, headY + 0.08, headR * headScale.z * 0.92);
    group.add(pupil);
  }
  makeEye(-1); makeEye(1);

  function makeBrow(sign) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.026, 0.045), goldDarkMat);
    brow.position.set(sign * 0.14, headY + 0.15, headR * headScale.z * 0.89);
    brow.rotation.z = -sign * 0.18;
    brow.rotation.x = -0.15;
    group.add(brow);
  }
  makeBrow(-1); makeBrow(1);

  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.02), pupilMat);
  mouth.position.set(0, headY - 0.2, headR * headScale.z * 0.97);
  group.add(mouth);

  const chin = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), goldMat);
  chin.scale.set(0.85, 0.75, 0.8);
  chin.position.set(0, headY - 0.31, headR * headScale.z * 0.7);
  group.add(chin);

  for (let i = 0; i < 3; i++) {
    const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.17, 6), hairMat);
    tuft.position.set((i - 1) * 0.06, headY + headR * headScale.y * 0.85, -0.04 + i * 0.02);
    tuft.rotation.z = (i - 1) * 0.35;
    tuft.rotation.x = -0.2;
    group.add(tuft);
  }

  group.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  return { group, legL, legR, armL, armR, goldMat, suitMat, goldBase, suitBase };
}

export function animateCharacter(model, poseKey, phase) {
  const { legL, legR, armL, armR } = model;
  legL.rotation.x = 0; legR.rotation.x = 0;
  armL.rotation.x = -1.0; armR.rotation.x = -1.0;
  armL.elbow.rotation.x = -0.55; armR.elbow.rotation.x = -0.55;
  model.group.scale.y = 1;

  if (poseKey === "ducking") {
    model.group.scale.y = 0.62;
    legL.rotation.x = 0.5; legR.rotation.x = 0.5;
    armL.rotation.x = -0.6; armR.rotation.x = -0.6;
    armL.elbow.rotation.x = -0.75; armR.elbow.rotation.x = -0.75;
  } else if (poseKey === "jumping") {
    legL.rotation.x = -0.7; legR.rotation.x = -0.35;
    armL.rotation.x = -0.9; armR.rotation.x = -0.9;
    armL.elbow.rotation.x = -0.4; armR.elbow.rotation.x = -0.4;
  } else if (poseKey === "running" || poseKey === "walking") {
    const amp = poseKey === "running" ? 0.8 : 0.45;
    const speed = poseKey === "running" ? 9 : 6;
    const swing = Math.sin(phase * speed) * amp;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -1.0 - swing * 0.2;
    armR.rotation.x = -1.0 + swing * 0.2;
    armL.elbow.rotation.x = -0.55 - Math.max(0, swing) * 0.3;
    armR.elbow.rotation.x = -0.55 + Math.min(0, swing) * 0.3;
  }
}

// ---------- Blender-built model loader ----------
const CHARACTER_GLB_URL = "/arena3d/assets/character.glb";
const gltfLoader = new GLTFLoader();

// Loaded fresh per call (not shared/cloned) so each fighter instance gets its
// own independent Gold/Suit material objects -- required for hitFlash tinting
// to affect only the fighter that got hit, matching makeCharacterModel()'s
// per-instance `new THREE.MeshStandardMaterial(...)` behavior.
export async function loadCharacterModel() {
  const gltf = await gltfLoader.loadAsync(CHARACTER_GLB_URL);
  const group = gltf.scene;

  const legL = group.getObjectByName("LegL");
  const legR = group.getObjectByName("LegR");
  const armL = group.getObjectByName("ArmL");
  const armR = group.getObjectByName("ArmR");
  armL.elbow = group.getObjectByName("ElbowL");
  armR.elbow = group.getObjectByName("ElbowR");
  if (!legL || !legR || !armL || !armR || !armL.elbow || !armR.elbow) {
    throw new Error("character.glb is missing an expected joint node (LegL/LegR/ArmL/ArmR/ElbowL/ElbowR)");
  }

  let goldMat = null, suitMat = null;
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.name === "Gold" && !goldMat) goldMat = m;
      if (m.name === "Suit" && !suitMat) suitMat = m;
    }
  });
  if (!goldMat || !suitMat) {
    throw new Error("character.glb is missing the expected Gold/Suit materials");
  }

  return { group, legL, legR, armL, armR, goldMat, suitMat, goldBase: goldMat.color.clone(), suitBase: suitMat.color.clone() };
}

// ---------- rigged shooter-pack model (real skeleton + AnimationMixer) ----------
// Loads shooter_character.glb (see arena3d/blender/ pipeline): the "Neegy"
// character body-scanned into a proper Mixamo-style rig with a gun bone-
// parented to the right hand and 17 named animation clips baked in. Unlike
// makeCharacterModel()/loadCharacterModel() above (which drive a handful of
// named pivot nodes via direct rotation), this model has a real THREE.Skeleton
// and is driven by crossfading THREE.AnimationAction clips through a mixer.
//
// Used for every fighter in the arena now (player and all bots, both teams).
// The glb itself (~20MB) is fetched exactly once via loadRiggedCharacterAsset()
// and cached; each fighter gets its own instance via instantiateRiggedCharacter(),
// which uses SkeletonUtils.clone() (a plain Object3D.clone() does not correctly
// re-link a SkinnedMesh's skeleton/bone bindings) plus cloned materials, so
// every fighter has an independent skeleton pose, AnimationMixer, and
// hit-flash-tintable body color without re-downloading or re-parsing the asset.
// The ?a= marker is this asset's OWN version, independent of the site-wide
// ?v= used for scripts: it tells the server the URL is immutable, so this 19MB
// model is downloaded once and then served from cache instead of being
// refetched on every page load (the lobby -> match navigation is every match).
// Bump it only when shooter_character.glb itself is re-exported.
const RIGGED_CHARACTER_GLB_URL = "/arena3d/assets/shooter_character.glb?a=2";
let riggedCharacterAssetPromise = null;

// The source mocap (Mixamo-style) bakes real forward travel into the Hips
// bone for clips like Walking/RifleRun -- the character physically walked
// across the capture volume. Since our game code ALSO moves the fighter's
// group position every frame from input/AI, that's double motion: the mesh
// drifts extra during the clip, then the Hips bone snaps back to its start
// offset the instant a looping clip restarts, which reads as the character
// lurching away from the camera and snapping back every loop. Freezing the
// Hips bone's two *horizontal* position axes -- leaving the vertical one
// alone so the run/walk bob still plays -- makes every clip "in place" and
// leaves world movement entirely to the game code, which is the only thing
// that should be moving the fighter.
//
// Which axis is vertical is NOT a given, and getting it wrong is the exact
// bug this replaced: this glb's Armature node carries a +90-degree X
// rotation (Blender's Z-up -> glTF Y-up conversion applied at the object
// level rather than baked into the bones), so in Hips-bone-local space the
// axes are still Blender's: X = sideways, Y = forward/back, Z = up. An
// earlier version assumed the glTF convention (Y = up) and froze X/Z,
// which killed the strafe travel and the vertical bob while leaving the
// forward/back travel -- ~0.98 units of un-stripped drift per RifleRun
// loop, multiplied by RIGGED_MODEL_SCALE, with the camera only 2.4 units
// away. Hence "forward/back is broken, strafing is fine". So detect the
// vertical axis from the rig's actual world orientation instead of
// assuming, and a future re-export with different axis conventions stays
// correct on its own.
function detectVerticalAxisIndex(scene) {
  // NB: GLTFLoader sanitizes node names, stripping the colon out of Mixamo's
  // "mixamorig:Hips" -- match against the bone list instead of a literal name.
  let hips = null, firstBone = null;
  scene.traverse((o) => {
    if (!o.isBone) return;
    if (!firstBone) firstBone = o;
    if (!hips && /hips/i.test(o.name)) hips = o;
  });
  hips = hips || firstBone;
  const space = hips && hips.parent;
  if (!space) return 1; // no rig to measure -- fall back to the glTF convention
  space.updateWorldMatrix(true, false);
  const rot = new THREE.Quaternion().setFromRotationMatrix(space.matrixWorld);
  // whichever local axis ends up most aligned with world up is the vertical one
  let best = 1, bestDot = -Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const v = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)
      .applyQuaternion(rot);
    const dot = Math.abs(v.y);
    if (dot > bestDot) { bestDot = dot; best = axis; }
  }
  return best;
}

function stripHorizontalRootMotion(clip, verticalAxis) {
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position") || !/hips/i.test(track.name)) continue;
    const values = track.values;
    for (let axis = 0; axis < 3; axis++) {
      if (axis === verticalAxis) continue;
      const first = values[axis];
      for (let i = axis; i < values.length; i += 3) values[i] = first;
    }
  }
  return clip;
}

// Separately from root motion: the source mocap clips (Mixamo-style) weren't
// necessarily authored as perfect loops -- a clip's last frame pose can be
// slightly off from its first frame pose. THREE.LoopRepeat does not blend
// across that seam, it just jumps, so every time a clip like RifleRun or
// Walking restarts it visibly snaps -- reads exactly like a stutter-step
// backward. Strafe clips apparently loop cleanly (hence "sideways is fine"),
// but rather than track down which specific clips are bad, force every
// track's last keyframe to exactly match its first, for every clip -- that
// guarantees a seamless loop regardless of how the source was authored.
function forceSeamlessLoop(clip) {
  for (const track of clip.tracks) {
    const itemSize = track.getValueSize();
    const values = track.values;
    const frameCount = values.length / itemSize;
    if (frameCount < 2) continue;
    for (let k = 0; k < itemSize; k++) {
      values[(frameCount - 1) * itemSize + k] = values[k];
    }
  }
  return clip;
}

function findHipsPositionTrack(clip) {
  return clip.tracks.find((t) => t.name.endsWith(".position") && /hips/i.test(t.name));
}

// The clips also weren't all captured at the same rig calibration -- each
// one's Hips bone sits at its own baseline offset, so a clip switch (e.g.
// RifleAimingIdle -> RifleRun) would pop the whole body to a slightly
// different place even with root motion stripped. Shifting every clip's
// Hips keyframes by a constant so they all share one common baseline (the
// first clip's first-frame position) removes that pop regardless of which
// two clips are crossfading. On the two horizontal axes this just makes the
// already-constant values identical across clips; on the vertical axis it
// aligns hip height while leaving the within-clip bob intact.
function normalizeHipsPosition(clip, reference) {
  const track = findHipsPositionTrack(clip);
  if (!track) return clip;
  const offsetX = reference[0] - track.values[0];
  const offsetY = reference[1] - track.values[1];
  const offsetZ = reference[2] - track.values[2];
  for (let i = 0; i < track.values.length; i += 3) {
    track.values[i] += offsetX;
    track.values[i + 1] += offsetY;
    track.values[i + 2] += offsetZ;
  }
  return clip;
}

export function loadRiggedCharacterAsset() {
  if (!riggedCharacterAssetPromise) {
    riggedCharacterAssetPromise = gltfLoader
      .loadAsync(RIGGED_CHARACTER_GLB_URL)
      .then((gltf) => {
        const verticalAxis = detectVerticalAxisIndex(gltf.scene);
        const animations = gltf.animations
          .map((clip) => stripHorizontalRootMotion(clip, verticalAxis))
          .map(forceSeamlessLoop);
        const referenceTrack = findHipsPositionTrack(animations[0]);
        const reference = referenceTrack
          ? [referenceTrack.values[0], referenceTrack.values[1], referenceTrack.values[2]]
          : [0, 0, 0];
        animations.forEach((clip) => normalizeHipsPosition(clip, reference));
        return { scene: gltf.scene, animations };
      });
  }
  return riggedCharacterAssetPromise;
}

export function instantiateRiggedCharacter(asset) {
  const group = SkeletonUtils.clone(asset.scene);

  let bodyMat = null;
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const wasArray = Array.isArray(o.material);
    const srcMats = wasArray ? o.material : [o.material];
    const clonedMats = srcMats.map((m) => m.clone());
    o.material = wasArray ? clonedMats : clonedMats[0];
    if (!bodyMat) bodyMat = clonedMats[0];
  });
  if (!bodyMat) throw new Error("shooter_character.glb instance has no mesh material to tint for hit-flash");

  const mixer = new THREE.AnimationMixer(group);
  const actions = {};
  for (const clip of asset.animations) {
    actions[clip.name] = mixer.clipAction(clip);
  }

  let current = null;
  function play(name, { fade = 0.15, loop = true, clampWhenFinished = false, timeScale = 1 } = {}) {
    const action = actions[name];
    if (!action) return null;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = clampWhenFinished;
    action.timeScale = timeScale;
    if (current !== action) {
      action.reset().fadeIn(fade).play();
      if (current) current.fadeOut(fade);
      current = action;
    }
    return action;
  }

  return {
    group, mixer, actions, play,
    rigged: true,
    bodyMat, bodyBase: bodyMat.color.clone(),
  };
}

// Convenience one-shot wrapper (fetch-once-cached asset + a single instance).
export async function loadRiggedCharacterModel() {
  const asset = await loadRiggedCharacterAsset();
  return instantiateRiggedCharacter(asset);
}
