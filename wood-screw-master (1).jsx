import React, { useState, useEffect, useRef } from 'react';

// Progressive level generator mapping up to 100 levels from easy to master
const LEVEL_PRESETS = [
  { count: 4, complexity: 'easy' },
  { count: 5, complexity: 'easy' },
  { count: 6, complexity: 'easy' },
  { count: 7, complexity: 'easy' },
  { count: 8, complexity: 'medium' },
  ...Array.from({ length: 95 }, (_, i) => ({
    count: Math.min(6 + Math.floor((i + 5) / 5), 15),
    complexity: i < 20 ? 'medium' : i < 60 ? 'hard' : 'master'
  }))
];

const WOODS = [
  { top: '#E7BC7C', bottom: '#B9814A', border: '#7C4A1E', shadow: '#4A2A0E' },
  { top: '#C98A55', bottom: '#93582C', border: '#5C3314', shadow: '#311A0A' },
  { top: '#ECCB93', bottom: '#C89A56', border: '#8C5D23', shadow: '#4D3110' },
  { top: '#D49B6A', bottom: '#A16534', border: '#693C15', shadow: '#381E09' }
];

const VW = 300, VH = 400;
const PLANK_FALL_MS = 650; // duration of plank fall animation

// A removed screw flies off as a true projectile: it launches sideways and
// slightly upward (like it's flicked loose), then gravity curves it back
// down into an actual parabolic arc — a real swing through the air, not a
// straight-line tween. SCREW_GRAVITY is in px/s^2.
const SCREW_GRAVITY = 1800;
const SCREW_FLIGHT_MS_MIN = 620;
const SCREW_FLIGHT_MS_MAX = 900;

export default function App() {
  const [gameState, setGameState] = useState({
    level: 1,
    planks: [],
    looseScrews: [],
    score: 0,
    hints: 3,
    undos: 3,
    skips: 1
  });

  const [history, setHistory] = useState([]);
  const [scaleFactor, setScaleFactor] = useState(1);
  const [toastMessage, setToastMessage] = useState(null);
  const [modalData, setModalData] = useState(null);
  const [muted, setMuted] = useState(false);
  const wrapRef = useRef(null);
  const scheduledFallsRef = useRef(new Set()); // tracks plank ids already scheduled for removal
  const scheduledHingeRef = useRef(new Set()); // tracks plank ids with an in-progress hinge-swing keyframe animation
  const hingeCssCacheRef = useRef(new Map()); // plank id -> generated @keyframes CSS text (computed once, reused every render)
  const screwCssCacheRef = useRef(new Map()); // loose-screw id -> generated @keyframes CSS text (computed once, reused every render)
  const audioCtxRef = useRef(null); // lazily-created shared AudioContext for synthesized sound effects
  const mutedRef = useRef(false); // mirrors `muted` state for use inside plain functions/closures

  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // ---- Synthesized sound effects (Web Audio API — no external audio files) ----
  // A shared AudioContext is created lazily on first real use, since browsers
  // block audio contexts from starting before a user gesture. If it's ever
  // suspended (e.g. tab was backgrounded), we nudge it to resume.
  function getAudioCtx() {
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AC();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }

  // A quick ratchet-y "screw coming loose" sound: a handful of short ticking
  // clicks with slightly rising pitch and randomized jitter (so repeated
  // clicks don't sound identical), finished off with a little downward "pop"
  // as the screw actually pulls free.
  function playScrewSound() {
    if (mutedRef.current) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const clickCount = 5;
      for (let i = 0; i < clickCount; i++) {
        const t = now + i * 0.045 + Math.random() * 0.006;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        const freq = 850 + i * 55 + Math.random() * 60;
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.55), t + 0.025);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.032);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.04);
      }
      const popT = now + clickCount * 0.045 + 0.02;
      const popOsc = ctx.createOscillator();
      const popGain = ctx.createGain();
      popOsc.type = 'sine';
      popOsc.frequency.setValueAtTime(520, popT);
      popOsc.frequency.exponentialRampToValueAtTime(140, popT + 0.12);
      popGain.gain.setValueAtTime(0.22, popT);
      popGain.gain.exponentialRampToValueAtTime(0.0001, popT + 0.15);
      popOsc.connect(popGain);
      popGain.connect(ctx.destination);
      popOsc.start(popT);
      popOsc.stop(popT + 0.16);
    } catch (e) { /* audio is best-effort — never break gameplay over it */ }
  }

  // A low wooden "thud" for a plank dropping away: a short filtered noise
  // burst (the clatter) layered with a falling low sine tone (the body/weight
  // of the plank), both decaying quickly.
  function playFallSound() {
    if (mutedRef.current) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;

      const bufferSize = Math.floor(ctx.sampleRate * 0.22);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.setValueAtTime(420, now);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.45, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noise.start(now);

      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(170, now);
      osc.frequency.exponentialRampToValueAtTime(48, now + 0.3);
      oscGain.gain.setValueAtTime(0.38, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(oscGain);
      oscGain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } catch (e) { /* audio is best-effort — never break gameplay over it */ }
  }
  // ---- end sound effects ----

  function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function deg2rad(d) { return d * Math.PI / 180; }

  function axesOf(rad) {
    return [{ x: Math.cos(rad), y: Math.sin(rad) }, { x: -Math.sin(rad), y: Math.cos(rad) }];
  }

  function projRadius(p, n) {
    const [u, v] = axesOf(p.rad);
    return p.hl * Math.abs(u.x * n.x + u.y * n.y) + p.ht * Math.abs(v.x * n.x + v.y * n.y);
  }

  function centerProj(p, n) { return p.cx * n.x + p.cy * n.y; }

  function obbOverlap(a, b) {
    const axes = [...axesOf(a.rad), ...axesOf(b.rad)];
    for (const n of axes) {
      const ca = centerProj(a, n), cb = centerProj(b, n);
      const ra = projRadius(a, n), rb = projRadius(b, n);
      if (Math.abs(ca - cb) > ra + rb + 0.5) return false;
    }
    return true;
  }

  function generateLevel(lvl) {
    const targetLevel = Math.min(Math.max(lvl, 1), 100);
    const preset = LEVEL_PRESETS[targetLevel - 1] || { count: 12, complexity: 'hard' };

    let planks = [];
    let attempts = 0;

    while (planks.length < preset.count && attempts < 300) {
      attempts++;
      const length = randInt(75, 140);
      const thickness = randInt(26, 32);
      const angleChoices = [0, 90, 45, -45, 30, -30, 60, -60];
      const angleDeg = angleChoices[randInt(0, angleChoices.length - 1)];
      const rad = deg2rad(angleDeg);

      const cx = randInt(55, VW - 55);
      const cy = randInt(65, VH - 65);

      const cand = {
        id: 'pl_' + planks.length,
        cx, cy, rad, angleDeg,
        hl: length / 2,
        ht: thickness / 2,
        length,
        thickness,
        wood: WOODS[randInt(0, WOODS.length - 1)],
        curveType: randInt(0, 4) === 0 ? 'arch' : 'rect',
        screwFrac: length > 110 ? [0.18, 0.5, 0.82] : [0.22, 0.78],
        screws: [],
        blockedBy: [],
        removed: false,
        falling: false,
        fallSpin: randInt(-45, 45),
        fallDrift: randInt(-40, 40),
        hingeFrac: null, // once set (last screw position), the hang keeps using it — doesn't reset to flat
        hingeAnimPlaying: false,
        shake: false,
        hint: false
      };
      cand.screws = cand.screwFrac.map(() => true);

      let overlapCount = 0;
      for (const p of planks) {
        if (obbOverlap(cand, p)) overlapCount++;
      }

      if (preset.complexity === 'easy' && overlapCount > 1) continue;
      if (preset.complexity === 'medium' && overlapCount > 3) continue;

      planks.push(cand);
    }

    for (let i = 0; i < planks.length; i++) {
      for (let j = i + 1; j < planks.length; j++) {
        if (obbOverlap(planks[i], planks[j])) {
          // Plank j was placed after plank i, so it sits on top of it.
          // Only the bottom plank (i) is blocked — the top plank (j) is free
          // to be cleared as soon as its own screws are out.
          planks[i].blockedBy.push(planks[j].id);
        }
      }
    }

    scheduledFallsRef.current.clear();
    scheduledHingeRef.current.clear();
    hingeCssCacheRef.current.clear();
    screwCssCacheRef.current.clear();

    setGameState(prev => ({
      ...prev,
      level: targetLevel,
      planks,
      looseScrews: []
    }));
    setHistory([]);
    setModalData(null);
  }

  useEffect(() => { generateLevel(1); }, []);

  useEffect(() => {
    function handleResize() {
      if (!wrapRef.current) return;
      let wrapW = wrapRef.current.clientWidth - 16;
      let wrapH = wrapRef.current.clientHeight - 16;
      if (!(wrapW > 20)) wrapW = window.innerWidth - 32;
      if (!(wrapH > 20)) wrapH = window.innerHeight * 0.52;
      setScaleFactor(Math.max(0.3, Math.min(wrapW / VW, wrapH / VH, 1.6)));
    }
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Whenever a plank starts falling, schedule its actual removal once the fall
  // animation has finished playing, then re-check for a win.
  useEffect(() => {
    gameState.planks.forEach(p => {
      if (p.falling && !p.removed && !scheduledFallsRef.current.has(p.id)) {
        scheduledFallsRef.current.add(p.id);
        setTimeout(() => {
          setGameState(prev => ({
            ...prev,
            planks: prev.planks.map(pl => pl.id === p.id ? { ...pl, removed: true } : pl)
          }));
          scheduledFallsRef.current.delete(p.id);
          setTimeout(() => { checkWin(); }, 30);
        }, PLANK_FALL_MS);
      }
    });
  }, [gameState.planks]);

  const HINGE_ANIM_MS = 1050; // medium-paced one-time settle swing
  // Whenever a plank's hinge-swing keyframe animation starts, schedule turning
  // it off once it's finished — after that we just render the final settled
  // pose directly (no more animation needed since the swing only ever happens once).
  useEffect(() => {
    gameState.planks.forEach(p => {
      if (p.hingeAnimPlaying && !scheduledHingeRef.current.has(p.id)) {
        scheduledHingeRef.current.add(p.id);
        setTimeout(() => {
          setGameState(prev => ({
            ...prev,
            planks: prev.planks.map(pl => pl.id === p.id ? { ...pl, hingeAnimPlaying: false } : pl)
          }));
          scheduledHingeRef.current.delete(p.id);
          hingeCssCacheRef.current.delete(p.id);
        }, HINGE_ANIM_MS + 20);
      }
    });
  }, [gameState.planks]);

  function alivePlank(id, currentPlanks) {
    const p = currentPlanks.find(pl => pl.id === id);
    // A plank that is falling is already "gone" from a blocking standpoint,
    // even though it's still animating off-board.
    return p && !p.removed && !p.falling ? p : null;
  }

  function pushHistory() {
    setHistory(prev => [...prev.slice(-24), {
      planks: JSON.parse(JSON.stringify(gameState.planks)),
      looseScrews: JSON.parse(JSON.stringify(gameState.looseScrews)),
      score: gameState.score
    }]);
  }

  const HINGE_STEPS = 36; // keyframe resolution for the swing animation below

  // The correct physics for a rigid rod pinned at a single point: it always
  // settles with its center of mass hanging directly below the pivot. Since
  // the pivot and the plank's own center both lie on the plank's own length
  // axis, "center of mass below pivot" and "the whole plank is vertical" are
  // the same thing — so the rest angle is always exactly 90° or -90°,
  // regardless of HOW far off-center the remaining screw is. (The previous
  // formula scaled the tilt by how off-center the screw was, which linearly
  // interpolated down to a rotation of exactly ZERO for a perfectly centered
  // screw — e.g. the middle screw on a 3-screw plank — so that case visibly
  // never swung at all. This fixes it uniformly for every screw position.)
  function hingeFinalAngle(plank) {
    const px = (plank.hingeFrac - 0.5) * plank.length; // pivot's local x offset from plank center
    // Which way it tips is decided by which side of the pivot the plank's
    // mass sits on. For a screw dead-center there's genuinely no torque
    // either way physically, so we just pick a consistent direction so it
    // still visibly swings shut instead of sitting frozen.
    return px <= 0 ? 90 : -90;
  }

  // Given a plank with a locked hinge fraction, returns the pose (cx, cy, rad,
  // angleDeg) for an ARBITRARY target angle while keeping the hinge screw's
  // world position exactly fixed. This is the core invariant: the hinge screw
  // never actually moves — only the plank rotates around it.
  function poseAtAngle(plank, angleDeg) {
    const px = (plank.hingeFrac - 0.5) * plank.length; // pivot's local x offset from plank center
    const worldPivotX = plank.cx + px * Math.cos(plank.rad);
    const worldPivotY = plank.cy + px * Math.sin(plank.rad);
    const rad = deg2rad(angleDeg);
    const cx = worldPivotX - px * Math.cos(rad);
    const cy = worldPivotY - px * Math.sin(rad);
    return { cx, cy, rad, angleDeg };
  }

  // Shared by both rendering and the loose-screw spawn point: given a plank's
  // locked hinge fraction (if any), returns where it's actually sitting right
  // now — pivoted around the surviving screw instead of its original flat pose.
  function getHingeAdjustedPose(plank) {
    if (plank.hingeFrac == null) {
      return { cx: plank.cx, cy: plank.cy, rad: plank.rad, angleDeg: plank.angleDeg };
    }
    return poseAtAngle(plank, hingeFinalAngle(plank));
  }

  // The hinge screw's world position never actually changes during the swing
  // — that's the whole point of the pivot invariant. So instead of animating
  // the screw at all (even a perfectly-cancelling counter-rotation still
  // depends on two separate CSS animations staying frame-perfectly in sync),
  // we just compute this fixed point once and render the screw as a plain,
  // completely static element there. Zero animation = zero possible jitter.
  function hingeWorldPoint(plank) {
    const px = (plank.hingeFrac - 0.5) * plank.length;
    return {
      x: plank.cx + px * Math.cos(plank.rad),
      y: plank.cy + px * Math.sin(plank.rad)
    };
  }

  // Precompute a dense set of true-arc keyframes for the one-time hinge swing,
  // so the pivot screw's world position stays fixed at every sampled instant —
  // not just at the two endpoints the way a plain CSS transition would.
  //
  // IMPORTANT for performance: these keyframes only ever touch `transform`
  // (translate + rotate), never `left`/`top`. Animating left/top forces the
  // browser to recompute layout on every single frame of the animation —
  // that's what was causing the lag during the hang. transform is a
  // compositor-only property; the browser can run it smoothly on the GPU
  // without ever touching layout. The plank's left/top stay fixed at its
  // original position for the entire game, and the hinge swing is expressed
  // purely as a translate offset from that fixed point.
  function generateHingeKeyframeCSS(plank) {
    const startAngle = plank.angleDeg;
    const endAngle = hingeFinalAngle(plank);
    // Real pendulum feel: overshoot the resting angle, swing back the other
    // way, and settle with decaying amplitude — a damped harmonic oscillator
    // around the target hang angle, not a one-way ease into it.
    const DAMPING = 3.4;
    const OSCILLATIONS = 2.1;
    let boxFrames = '';
    const rawDecay = (tt) => Math.exp(-DAMPING * tt) * Math.cos(2 * Math.PI * OSCILLATIONS * tt);
    const tailResidual = rawDecay(1); // the decay never mathematically hits exactly 0 by t=1
    for (let i = 0; i <= HINGE_STEPS; i++) {
      const t = i / HINGE_STEPS;
      // Linearly taper out that residual so decay(0)=1 and decay(1)=0 exactly —
      // otherwise the swing settles a hair off-target and visibly snaps into
      // place the instant it hands off to the static final pose.
      const decay = rawDecay(t) - tailResidual * t;
      const angle = endAngle + (startAngle - endAngle) * decay;
      const pose = poseAtAngle(plank, angle);
      const dx = pose.cx - plank.cx; // offset from the plank's fixed left/top, not an absolute position
      const dy = pose.cy - plank.cy;
      const pct = (t * 100).toFixed(3);
      boxFrames += `${pct}% { transform: translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${angle}deg); }\n`;
    }
    return `@keyframes hingeBox_${plank.id} {\n${boxFrames}}\n`;
  }

  const SCREW_FLIGHT_STEPS = 20; // keyframe resolution for the projectile arc below

  // Precomputes a true parabolic-arc trajectory for a loose screw's flight:
  // x(t) is straight-line drift at launch speed, y(t) follows y = v*t + 1/2*g*t^2
  // (real projectile motion), so it actually swings up and out before gravity
  // curves it back down and off the board — not a linear CSS transition.
  function generateScrewFlightKeyframeCSS(scr) {
    let frames = '';
    for (let i = 0; i <= SCREW_FLIGHT_STEPS; i++) {
      const t = i / SCREW_FLIGHT_STEPS;
      const timeSec = (t * scr.flightMs) / 1000;
      const x = scr.launchVX * timeSec;
      const y = scr.launchVY * timeSec + 0.5 * SCREW_GRAVITY * timeSec * timeSec;
      const rot = scr.spinTotal * t;
      const scale = Math.max(0.15, 1.15 - 0.9 * t);
      const opacity = t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45);
      const pct = (t * 100).toFixed(2);
      frames += `${pct}% { transform: translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${rot.toFixed(0)}deg) scale(${scale.toFixed(2)}); opacity: ${opacity.toFixed(2)}; }\n`;
    }
    return `@keyframes screwFly_${scr.id} {\n${frames}}\n`;
  }

  function getScrewWorldCoords(plank, frac) {
    const pose = getHingeAdjustedPose(plank);
    const localX = (frac - 0.5) * plank.length;
    const localY = 0;
    const cosA = Math.cos(pose.rad);
    const sinA = Math.sin(pose.rad);
    const worldX = pose.cx + (localX * cosA - localY * sinA);
    const worldY = pose.cy + (localX * sinA + localY * cosA);
    return { x: worldX, y: worldY };
  }

  function handleScrewClick(plankId, screwIdx, e) {
    e.stopPropagation();
    const plank = gameState.planks.find(p => p.id === plankId);
    if (!plank || plank.removed || plank.falling || !plank.screws[screwIdx]) return;

    pushHistory();
    const coords = getScrewWorldCoords(plank, plank.screwFrac[screwIdx]);

    // Play the "screw coming loose" sound immediately on click.
    playScrewSound();

    // Figure out — using the same logic the state updater below will apply —
    // whether removing this screw will also immediately clear the whole
    // plank (last screw gone + nothing stacked on top), so we can layer the
    // wooden fall thud in right alongside the screw sound.
    const previewScrews = [...plank.screws];
    previewScrews[screwIdx] = false;
    const willClearNow = previewScrews.every(s => !s) &&
      plank.blockedBy.every(id => !alivePlank(id, gameState.planks));
    if (willClearNow) {
      playFallSound();
    }

    // Randomize this screw's own launch so a handful coming loose at once
    // don't all swing the same way — real projectile parameters (launch
    // speed + direction), not just a drift distance.
    const flightMs = randInt(SCREW_FLIGHT_MS_MIN, SCREW_FLIGHT_MS_MAX);
    const dirSign = Math.random() < 0.5 ? -1 : 1;
    const launchVX = dirSign * randInt(90, 230); // px/s sideways — the swing
    const launchVY = -randInt(110, 230); // px/s upward at launch — gravity pulls it back down
    const spinTotal = randInt(480, 960) * (Math.random() < 0.5 ? -1 : 1); // several full tumbles mid-flight

    const newScrew = {
      id: `${plankId}_scr_${screwIdx}_${Date.now()}`,
      x: coords.x,
      y: coords.y,
      stage: 'anchored', // anchored -> flying
      flightMs, launchVX, launchVY, spinTotal
    };

    setGameState(prev => {
      let nextPlanks = prev.planks.map(p => {
        if (p.id === plankId) {
          const updatedScrews = [...p.screws];
          updatedScrews[screwIdx] = false;

          // The first time a plank drops to exactly one screw left, lock in
          // that screw's position as the permanent hinge point. It stays
          // locked even once that last screw is removed too, so the plank
          // keeps hanging at the same tilt instead of snapping back flat.
          let hingeFrac = p.hingeFrac;
          let hingeAnimPlaying = p.hingeAnimPlaying;
          if (hingeFrac == null && p.screws.length > 1) {
            const screwsLeft = updatedScrews.filter(Boolean).length;
            if (screwsLeft === 1) {
              const remIdx = updatedScrews.findIndex(s => s);
              hingeFrac = p.screwFrac[remIdx];
              hingeAnimPlaying = true; // kick off the one-time true-arc swing
            }
          }

          return { ...p, screws: updatedScrews, hingeFrac, hingeAnimPlaying };
        }
        return p;
      });

      // Automatically check if this plank now has 0 screws left and is unblocked!
      const targetPlank = nextPlanks.find(p => p.id === plankId);
      let justCleared = false;
      if (targetPlank && targetPlank.screws.every(s => !s)) {
        const canRemove = targetPlank.blockedBy.every(id => !alivePlank(id, nextPlanks));
        if (canRemove) {
          justCleared = true;
          nextPlanks = nextPlanks.map(p => p.id === plankId ? { ...p, falling: true } : p);
        }
      }

      return {
        ...prev,
        planks: nextPlanks,
        looseScrews: [...prev.looseScrews, newScrew],
        score: prev.score + 15 + (justCleared ? 100 : 0)
      };
    });

    // Next couple of frames: kick off the physics-driven flight animation
    // (paint the anchored screw first, so the keyframe animation actually
    // starts playing rather than the browser skipping straight to its end).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setGameState(prev => ({
          ...prev,
          looseScrews: prev.looseScrews.map(s => s.id === newScrew.id ? { ...s, stage: 'flying' } : s)
        }));
      });
    });

    // Clean up the loose screw from state once its flight has finished.
    setTimeout(() => {
      setGameState(prev => ({
        ...prev,
        looseScrews: prev.looseScrews.filter(s => s.id !== newScrew.id)
      }));
      screwCssCacheRef.current.delete(newScrew.id);
    }, flightMs + 60);
  }

  function handlePlankClick(plankId, e) {
    e.stopPropagation();
    const plank = gameState.planks.find(p => p.id === plankId);
    if (!plank || plank.removed || plank.falling) return;

    if (plank.screws.some(s => s)) {
      showToast('Remove all screws from this block first!');
      return;
    }

    const canRemove = plank.blockedBy.every(id => !alivePlank(id, gameState.planks));
    if (!canRemove) {
      setGameState(prev => ({
        ...prev,
        planks: prev.planks.map(p => p.id === plank.id ? { ...p, shake: true } : p)
      }));
      setTimeout(() => {
        setGameState(prev => ({
          ...prev,
          planks: prev.planks.map(p => ({ ...p, shake: false }))
        }));
      }, 400);
      showToast('Blocked — clear pieces stacked on top first!');
      return;
    }

    pushHistory();
    playFallSound();
    setGameState(prev => ({
      ...prev,
      planks: prev.planks.map(p => p.id === plankId ? { ...p, falling: true } : p),
      score: prev.score + 100
    }));
    // Win check happens automatically once the fall-tracking effect marks it removed.
  }

  function showToast(msg) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 1600);
  }

  function checkWin() {
    setGameState(prev => {
      if (prev.planks.length > 0 && prev.planks.every(p => p.removed)) {
        const bonus = 200 + prev.level * 10;
        setModalData({ score: prev.score + bonus, level: prev.level });
        return { ...prev, score: prev.score + bonus };
      }
      return prev;
    });
  }

  function handleUndo() {
    if (gameState.undos <= 0 || history.length === 0) return;
    const lastState = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    scheduledFallsRef.current.clear();
    scheduledHingeRef.current.clear();
    hingeCssCacheRef.current.clear();
    screwCssCacheRef.current.clear();
    setGameState(prev => ({
      ...prev,
      planks: lastState.planks,
      looseScrews: lastState.looseScrews,
      score: lastState.score,
      undos: prev.undos - 1
    }));
  }

  function handleHint() {
    if (gameState.hints <= 0) return;
    const remaining = gameState.planks.filter(p => !p.removed && !p.falling);
    let best = null, bestScore = 999;
    remaining.forEach(p => {
      const aliveBlockers = p.blockedBy.filter(id => alivePlank(id, gameState.planks)).length;
      const screwsLeft = p.screws.filter(s => s).length;
      const score = aliveBlockers * 10 + screwsLeft;
      if (score < bestScore) { bestScore = score; best = p; }
    });
    if (best) {
      setGameState(prev => ({
        ...prev,
        hints: prev.hints - 1,
        planks: prev.planks.map(p => p.id === best.id ? { ...p, hint: true } : p)
      }));
      setTimeout(() => {
        setGameState(prev => ({ ...prev, planks: prev.planks.map(p => ({ ...p, hint: false })) }));
      }, 2200);
      showToast('Highlighted recommended plank to clear!');
    }
  }

  const sortedPlanks = [...gameState.planks].sort((a, b) => (a.z || 0) - (b.z || 0));
  const leftCount = gameState.planks.filter(p => !p.removed).length;

  return (
    <div style={styles.appContainer}>
      <div style={styles.app}>
        {/* Header HUD */}
        <div style={styles.hud}>
          <div style={styles.brand}>
            <div style={styles.title}>Wood <span style={{ color: '#D35400' }}>Screw</span> Master</div>
            <div style={styles.sub}>Level {gameState.level} / 100</div>
          </div>
          <div style={styles.hudStats}>
            <div style={styles.stat}><div style={styles.statLabel}>Left</div><div style={styles.statValue}>{leftCount}</div></div>
            <div style={styles.stat}><div style={styles.statLabel}>Score</div><div style={styles.statValue}>{gameState.score}</div></div>
            <button
              style={{ ...styles.stat, cursor: 'pointer', border: 'none' }}
              onClick={() => setMuted(m => !m)}
              title={muted ? 'Unmute sound' : 'Mute sound'}
            >
              <div style={styles.statLabel}>Sound</div>
              <div style={styles.statValue}>{muted ? '🔇' : '🔊'}</div>
            </button>
          </div>
        </div>

        {/* Board Arena */}
        <div ref={wrapRef} style={styles.boardWrap}>
          <div style={{ ...styles.bench, width: VW * scaleFactor, height: VH * scaleFactor }}>
            <div style={{ ...styles.board, width: VW, height: VH, transform: `scale(${scaleFactor})` }}>

              {/* Render Planks */}
              {sortedPlanks.map(plank => {
                if (plank.removed) return null;
                const unlocked = plank.screws.every(s => !s);

                // Hinge physics: once a plank has locked in a hinge point (see
                // handleScrewClick), gravity swings the free end down around
                // that screw's position — and it stays that way even after
                // the last screw is gone, right up until it's cleared.
                //
                // Important: we never touch transformOrigin here, because
                // browsers don't animate that property — changing it mid-flight
                // causes an instant jump before the rotation even starts. Instead
                // we keep the origin at the plank's own center and recompute its
                // cx/cy so the hinge screw's world position stays fixed while the
                // plank rotates around it.
                //
                // Performance: `left`/`top` are ALWAYS fixed at the plank's
                // original position now — they never change, for any plank,
                // ever. Every bit of motion (hinge tilt, falling, the swing
                // itself) is expressed purely as a `transform: translate(...)
                // rotate(...)`. That's what fixed the lag during the hang:
                // animating left/top forces a full layout recalculation on
                // every frame, while transform runs on the compositor and
                // never touches layout at all.
                const pose = getHingeAdjustedPose(plank);
                const renderAngleDeg = pose.angleDeg;
                const hingeDx = pose.cx - plank.cx; // settled hinge offset from the plank's fixed position
                const hingeDy = pose.cy - plank.cy;
                const isSwinging = plank.hingeAnimPlaying && !plank.falling;

                // Falling continues smoothly from whatever tilt/position the
                // plank already had (including a hinge tilt) instead of resetting
                // to its original flat angle first.
                const baseTransform = `translate(${hingeDx.toFixed(2)}px, ${hingeDy.toFixed(2)}px) rotate(${renderAngleDeg}deg)`;
                const fallTransform = `translate(${(hingeDx + plank.fallDrift).toFixed(2)}px, ${(hingeDy + 520).toFixed(2)}px) rotate(${renderAngleDeg + plank.fallSpin}deg)`;

                let transitionStyle = 'none';
                if (plank.falling) {
                  transitionStyle = `transform ${PLANK_FALL_MS}ms cubic-bezier(0.5, 0, 0.8, 1), opacity ${PLANK_FALL_MS - 150}ms ease ${PLANK_FALL_MS * 0.3}ms`;
                } else if (plank.shake) {
                  transitionStyle = 'transform 0.1s ease-in-out';
                }
                // Note: the hinge-lock swing itself is NOT done via `transition`
                // anymore — see isSwinging below. A plain transition only
                // guarantees the pivot screw's world position at the two
                // endpoints; mid-swing it drifts slightly because CSS
                // interpolates left/top/rotate independently rather than
                // tracing the true circular arc. Precomputed keyframes fix
                // that for the block itself.

                const hingeScrewIdx = plank.hingeFrac != null ? plank.screwFrac.indexOf(plank.hingeFrac) : -1;

                return (
                  <React.Fragment key={plank.id}>
                    <div
                      onClick={(e) => handlePlankClick(plank.id, e)}
                      style={{
                        ...styles.plank,
                        background: `linear-gradient(165deg, ${plank.wood.top}, ${plank.wood.bottom})`,
                        borderColor: plank.wood.border,
                        borderRadius: plank.curveType === 'arch' ? '18px 18px 6px 6px' : '8px',
                        zIndex: plank.falling ? 500 : plank.z,
                        left: plank.cx - plank.length / 2,
                        top: plank.cy - plank.thickness / 2,
                        width: plank.length,
                        height: plank.thickness,
                        transform: plank.falling ? fallTransform : (isSwinging ? `translate(0px, 0px) rotate(${plank.angleDeg}deg)` : baseTransform),
                        animation: isSwinging ? `hingeBox_${plank.id} ${HINGE_ANIM_MS}ms linear forwards` : undefined,
                        boxShadow: unlocked
                          ? 'inset 0 2px 4px rgba(255,255,255,0.6), 0 0 16px 4px rgba(241, 196, 15, 0.9)'
                          : `inset 0 2px 3px rgba(255,255,255,0.4), inset 0 -4px 6px ${plank.wood.shadow}, 0 4px 8px rgba(0,0,0,0.4)`,
                        opacity: plank.falling ? 0 : 1,
                        pointerEvents: plank.falling ? 'none' : 'auto',
                        transition: isSwinging ? 'none' : transitionStyle,
                        willChange: 'transform',
                      }}
                    >
                      {/* Attached Screws (while swinging, the sole pivot screw is
                          rendered separately below as a fixed, unanimated sibling
                          instead — see the note above hingeWorldPoint) */}
                      {plank.screwFrac.map((frac, i) => {
                        if (!plank.screws[i]) return null;
                        if (isSwinging && i === hingeScrewIdx) return null;
                        const ss = Math.round(plank.thickness * 0.85);
                        return (
                          <div
                            key={i}
                            onClick={(e) => handleScrewClick(plank.id, i, e)}
                            style={{
                              ...styles.screw,
                              width: ss,
                              height: ss,
                              left: `${frac * plank.length}px`,
                              // Counter-rotate against the plank's own (static,
                              // non-swinging) tilt so the screw always reads as
                              // an upright cross regardless of placement angle.
                              transform: `translate(-50%,-50%) rotate(${-renderAngleDeg}deg)`,
                              transition: 'none',
                            }}
                          >
                            <div style={styles.slotCrossV} />
                            <div style={styles.slotCrossH} />
                          </div>
                        );
                      })}
                    </div>

                    {/* The pivot screw during a swing: its world position never
                        actually moves (that's the whole hinge invariant), so
                        instead of trying to keep two separate CSS animations
                        perfectly synced, we just render it once, completely
                        static, at that fixed point. Genuinely zero motion. */}
                    {isSwinging && hingeScrewIdx >= 0 && (() => {
                      const wp = hingeWorldPoint(plank);
                      const ss = Math.round(plank.thickness * 0.85);
                      return (
                        <div
                          onClick={(e) => handleScrewClick(plank.id, hingeScrewIdx, e)}
                          style={{
                            ...styles.screw,
                            width: ss,
                            height: ss,
                            left: wp.x - ss / 2,
                            top: wp.y - ss / 2,
                            transform: 'rotate(0deg)',
                            transition: 'none',
                            animation: 'none',
                            zIndex: 15,
                          }}
                        >
                          <div style={styles.slotCrossV} />
                          <div style={styles.slotCrossH} />
                        </div>
                      );
                    })()}
                  </React.Fragment>
                );
              })}

              {/* True-arc keyframes for any plank currently mid hinge-swing, so
                  the pivot screw's world position stays exactly fixed at every
                  instant of the animation, not just at its start and end.
                  Cached per plank id — this is fairly expensive trig/string
                  work, and without caching it was being redone on every React
                  re-render (toasts, hints, any unrelated state change), which
                  is what was causing the lag. */}
              <style>{gameState.planks
                .filter(p => p.hingeAnimPlaying && !p.falling)
                .map(p => {
                  if (!hingeCssCacheRef.current.has(p.id)) {
                    hingeCssCacheRef.current.set(p.id, generateHingeKeyframeCSS(p));
                  }
                  return hingeCssCacheRef.current.get(p.id);
                })
                .join('\n')}</style>

              {/* Loose screws in flight: launched sideways and slightly upward,
                  then gravity curves them back down into a real parabolic
                  swing off the board — driven by precomputed physics
                  keyframes (same technique as the plank hinge swing) rather
                  than a straight-line CSS transition. */}
              {gameState.looseScrews.map((scr) => {
                const ss = 26;
                const flying = scr.stage === 'flying';
                return (
                  <div
                    key={scr.id}
                    style={{
                      ...styles.screw,
                      width: ss,
                      height: ss,
                      left: scr.x - ss / 2,
                      top: scr.y - ss / 2,
                      transform: flying ? undefined : 'translate(0px, 0px) rotate(0deg) scale(1)',
                      animation: flying ? `screwFly_${scr.id} ${scr.flightMs}ms linear forwards` : undefined,
                      transition: 'none',
                      zIndex: 50
                    }}
                  >
                    <div style={styles.slotCrossV} />
                    <div style={styles.slotCrossH} />
                  </div>
                );
              })}

              {/* True projectile-arc keyframes for every screw currently in flight — also cached per screw id. */}
              <style>{gameState.looseScrews
                .filter(s => s.stage === 'flying')
                .map(s => {
                  if (!screwCssCacheRef.current.has(s.id)) {
                    screwCssCacheRef.current.set(s.id, generateScrewFlightKeyframeCSS(s));
                  }
                  return screwCssCacheRef.current.get(s.id);
                })
                .join('\n')}</style>

            </div>
          </div>
        </div>

        {/* Bottom Toolbars / Controls */}
        <div style={styles.controls}>
          <button style={styles.ctrl} onClick={handleHint} disabled={gameState.hints <= 0}>
            <span style={styles.icon}>💡</span><span style={styles.ctrlName}>Hint</span>
            <span style={styles.count}>{gameState.hints}</span>
          </button>
          <button style={styles.ctrl} onClick={handleUndo} disabled={gameState.undos <= 0 || history.length === 0}>
            <span style={styles.icon}>↩️</span><span style={styles.ctrlName}>Undo</span>
            <span style={styles.count}>{gameState.undos}</span>
          </button>
          <button style={styles.ctrl} onClick={() => generateLevel(gameState.level)}>
            <span style={styles.icon}>🔄</span><span style={styles.ctrlName}>Reset</span>
          </button>
          <button style={styles.ctrl} onClick={() => {
            if (gameState.skips > 0 && gameState.level < 100) {
              setGameState(p => ({ ...p, skips: p.skips - 1 }));
              generateLevel(gameState.level + 1);
            }
          }} disabled={gameState.skips <= 0 || gameState.level >= 100}>
            <span style={styles.icon}>⏭️</span><span style={styles.ctrlName}>Skip</span>
            <span style={styles.count}>{gameState.skips}</span>
          </button>
        </div>

        {toastMessage && <div style={styles.toast}>{toastMessage}</div>}

        {modalData && (
          <div style={styles.modalOverlay}>
            <div style={styles.modal}>
              <div style={{ fontSize: '46px' }}>🏆</div>
              <h2 style={{ fontFamily: 'Fredoka, sans-serif', color: '#7A3F0C', margin: '4px 0' }}>Level {modalData.level} Cleared!</h2>
              <div style={{ fontSize: '26px', margin: '6px 0 10px' }}>⭐⭐⭐</div>
              <p style={{ color: '#8A5C33', fontSize: '13px', fontWeight: '600' }}>All screws unscrewed and planks dropped safely!</p>
              <button
                style={styles.modalBtn}
                onClick={() => {
                  const nextLvl = modalData.level + 1;
                  setModalData(null);
                  generateLevel(nextLvl);
                }}
              >
                {modalData.level >= 100 ? 'Restart Campaign' : `Proceed to Level ${modalData.level + 1}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  appContainer: { margin: 0, padding: 0, height: '100vh', width: '100vw', overflow: 'hidden', userSelect: 'none', backgroundColor: '#2C1E12' },
  app: { maxWidth: '460px', margin: '0 auto', height: '100vh', height: '100dvh', position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', padding: '10px 12px', background: 'radial-gradient(circle at 50% 0%, #FCE4C8 0%, #E8A857 55%, #B86B1E 100%)' },
  hud: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 4px 6px' },
  brand: { display: 'flex', flexDirection: 'column' },
  title: { fontFamily: 'Fredoka, sans-serif', fontWeight: 700, fontSize: '20px', color: '#3E2711', textShadow: '0 1px 1px rgba(255,255,255,0.5)' },
  sub: { fontSize: '11px', letterSpacing: '1px', color: '#7A4A1E', textTransform: 'uppercase', fontWeight: 700 },
  hudStats: { display: 'flex', gap: '10px' },
  stat: { background: 'rgba(255, 243, 224, 0.65)', border: '1.5px solid rgba(255,255,255,0.7)', borderRadius: '10px', padding: '4px 10px', textAlign: 'center', backdropFilter: 'blur(2px)' },
  statLabel: { fontSize: '8px', letterSpacing: '1px', textTransform: 'uppercase', color: '#8A5C33', fontWeight: 700 },
  statValue: { fontFamily: 'Fredoka, sans-serif', fontWeight: 600, fontSize: '15px', color: '#5C3314' },
  boardWrap: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, padding: '2px 0' },
  bench: { position: 'relative', background: 'linear-gradient(155deg, #B5793E, #8C5320)', borderRadius: '18px', boxShadow: 'inset 0 0 0 4px rgba(0,0,0,0.18), inset 0 4px 12px rgba(0,0,0,0.4), 0 10px 25px rgba(0,0,0,0.35)', overflow: 'hidden' },
  board: { position: 'absolute', top: 0, left: 0, transformOrigin: 'top left' },
  plank: { position: 'absolute', borderRadius: '8px', border: '1.5px solid rgba(0,0,0,0.35)', cursor: 'pointer' },
  screw: { position: 'absolute', borderRadius: '50%', cursor: 'pointer', top: '50%', transform: 'translate(-50%,-50%)', background: 'radial-gradient(circle at 35% 28%, #FFF2CC 0%, #E6C275 45%, #C29342 78%, #8C6225 100%)', boxShadow: 'inset 0 -3px 4px rgba(0,0,0,0.45), inset 0 2px 3px rgba(255,255,255,0.7), 0 2px 5px rgba(0,0,0,0.4)', border: '1.5px solid rgba(60,35,10,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  slotCrossV: { position: 'absolute', width: '22%', height: '70%', background: '#59381A', borderRadius: '2px' },
  slotCrossH: { position: 'absolute', width: '70%', height: '22%', background: '#59381A', borderRadius: '2px' },
  controls: { display: 'flex', gap: '8px', padding: '8px 2px 6px' },
  ctrl: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', background: 'rgba(255,245,230,0.55)', border: '1.5px solid rgba(255,255,255,0.7)', borderRadius: '12px', padding: '6px 2px', fontFamily: 'Nunito, sans-serif', color: '#4A2E15', position: 'relative', cursor: 'pointer' },
  icon: { fontSize: '18px' },
  ctrlName: { fontSize: '9px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: '#7A4A1E' },
  count: { position: 'absolute', top: '-5px', right: '-5px', background: '#F1C40F', color: '#3E2711', fontFamily: 'Fredoka, sans-serif', fontWeight: 700, fontSize: '10px', width: '16px', height: '16px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #FFF' },
  toast: { position: 'fixed', left: '50%', bottom: '16px', transform: 'translateX(-50%)', background: 'rgba(50,25,10,0.92)', color: '#FFE9BE', padding: '8px 16px', borderRadius: '20px', fontSize: '12.5px', fontWeight: 700, zIndex: 1000, whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(30,15,5,0.65)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { width: '86%', maxWidth: '310px', textAlign: 'center', padding: '24px 20px', background: 'linear-gradient(180deg,#FFF6E0,#F5DFC1)', border: '2px solid rgba(255,255,255,0.7)', borderRadius: '20px', boxShadow: '0 20px 50px rgba(40,20,0,0.5)' },
  modalBtn: { width: '100%', padding: '12px', borderRadius: '12px', border: 'none', cursor: 'pointer', fontFamily: 'Fredoka, sans-serif', fontWeight: 600, fontSize: '15px', background: 'linear-gradient(180deg,#F1C40F,#D4AC0D)', color: '#3E2711', boxShadow: '0 4px 0 #9A7D0A, 0 6px 14px rgba(0,0,0,0.3)' }
};
