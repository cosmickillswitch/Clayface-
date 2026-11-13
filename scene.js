/* Clayframe scene: keyframes, object hierarchy, bones (skinning, automatic weights, IK) and shape keys.
   Units: one unit ≈ a person's head. Rotations are Euler degrees on objects and quaternions on bones. */
window.CScene = (function () {
  'use strict';
  const { v3, q, m4, clamp, RATE } = window.CM;
  const MAX_BONES = 48;

  // ---------- keyframes ----------
  const rateFn = name => {
    if (typeof name === 'string' && name.startsWith('cb:')) return cubic(name);
    return RATE[name] || RATE.smooth;
  };
  const cbc = new Map();
  function cubic(name) {
    let f = cbc.get(name);
    if (f) return f;
    const [x1, y1, x2, y2] = name.slice(3).split(',').map(Number);
    const B = (s, a, b) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
    f = t => { if (t <= 0) return 0; if (t >= 1) return 1; let lo = 0, hi = 1, s = t; for (let i = 0; i < 22; i++) { s = (lo + hi) / 2; if (B(s, x1, x2) < t) lo = s; else hi = s; } return B(s, y1, y2); };
    cbc.set(name, f); return f;
  }
  function hex(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const n = m ? parseInt(m[1], 16) : 0xffffff; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  const toHex = rgb => '#' + rgb.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
  function mixVal(a, b, u) {
    if (typeof a === 'number') return a + (b - a) * u;
    if (typeof a === 'string') return toHex(v3.lerp(hex(a), hex(b), u));
    if (a.length === 4) return q.slerp(a, b, u);
    return a.map((x, i) => x + (b[i] - x) * u);
  }
  function keyVal(keys, name, t, fallback) {
    const k = keys && keys[name];
    if (!k || !k.length) return fallback;
    if (t <= k[0].t) return k[0].v;
    const L = k[k.length - 1];
    if (t >= L.t) return L.v;
    for (let i = 1; i < k.length; i++) if (t <= k[i].t) {
      const a = k[i - 1], b = k[i];
      if (b.ease === 'hold') return a.v;
      return mixVal(a.v, b.v, rateFn(b.ease)((t - a.t) / (b.t - a.t || 1)));
    }
    return fallback;
  }
  function setKey(keys, name, t, v, ease) {
    const k = keys[name] || (keys[name] = []);
    const ex = k.find(x => Math.abs(x.t - t) < 1e-3);
    if (ex) { ex.v = v; if (ease) ex.ease = ease; } else { k.push({ t, v, ease }); k.sort((a, b) => a.t - b.t); }
  }
  function keyTimes(o) { const s = new Set(); for (const k of Object.values(o.keys || {})) for (const x of k) s.add(Math.round(x.t * 1000) / 1000); return [...s].sort((a, b) => a - b); }

  // ---------- bones ----------
  // rest frame of a bone = translation to its head (no rotation); its pose adds a local rotation
  function boneOrder(bones) {
    const out = [], seen = new Set(), by = new Map(bones.map(b => [b.id, b]));
    const visit = b => { if (seen.has(b.id)) return; if (b.parent && by.has(b.parent)) visit(by.get(b.parent)); seen.add(b.id); out.push(b); };
    bones.forEach(visit);
    return out;
  }
  // pose: map boneId → quaternion. Returns { P: map id → pose matrix, S: map id → skin matrix, tail: map id → posed tail }
  function poseBones(bones, pose) {
    const P = new Map(), S = new Map(), tail = new Map(), head = new Map(), by = new Map(bones.map(b => [b.id, b]));
    for (const b of boneOrder(bones)) {
      const r = (pose && pose.get(b.id)) || b.rot || [0, 0, 0, 1];
      const par = b.parent && by.get(b.parent);
      const local = m4.mul(m4.translate(par ? v3.sub(b.head, par.head) : b.head), m4.fromQuat(r));
      const M = par ? m4.mul(P.get(par.id), local) : local;
      P.set(b.id, M);
      S.set(b.id, m4.mul(M, m4.translate(v3.scale(b.head, -1))));
      head.set(b.id, m4.point(M, [0, 0, 0]));
      tail.set(b.id, m4.point(M, v3.sub(b.tail, b.head)));
    }
    return { P, S, tail, head };
  }
  // automatic weights: closeness to each bone, smoothed across the surface, best four kept
  function autoWeights(mesh, bones) {
    const n = mesh.pos.length / 3, B = bones.length, p = mesh.pos;
    const W = new Float32Array(n * B);
    bones.forEach((b, j) => {
      const a = b.head, d = v3.sub(b.tail, b.head), L2 = v3.dot(d, d) || 1e-9, len = Math.sqrt(L2);
      for (let i = 0; i < n; i++) {
        const px = p[i * 3] - a[0], py = p[i * 3 + 1] - a[1], pz = p[i * 3 + 2] - a[2];
        const u = clamp((px * d[0] + py * d[1] + pz * d[2]) / L2, 0, 1);
        const dist = Math.hypot(px - d[0] * u, py - d[1] * u, pz - d[2] * u) / Math.max(0.05, len * 0.5 + 0.1);
        W[i * B + j] = 1 / Math.pow(dist + 0.05, 4);
      }
    });
    // normalise, then smooth over neighbours so joints bend softly
    const normalise = () => { for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < B; j++) s += W[i * B + j]; if (s > 0) for (let j = 0; j < B; j++) W[i * B + j] /= s; } };
    normalise();
    for (let it = 0; it < 3; it++) {
      const C = W.slice();
      for (let i = 0; i < n; i++) {
        const s0 = mesh.nbStart[i], s1 = mesh.nbStart[i + 1], c = s1 - s0;
        if (!c) continue;
        for (let j = 0; j < B; j++) { let s = 0; for (let k = s0; k < s1; k++) s += C[mesh.nb[k] * B + j]; W[i * B + j] = C[i * B + j] * 0.5 + s / c * 0.5; }
      }
    }
    const bi = new Float32Array(n * 4), bw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const top = [];
      for (let j = 0; j < B; j++) { const w = W[i * B + j]; if (top.length < 4 || w > top[3][1]) { top.push([j, w]); top.sort((a, b) => b[1] - a[1]); if (top.length > 4) top.pop(); } }
      const s = top.reduce((a, x) => a + x[1], 0) || 1;
      top.forEach(([j, w], k) => { bi[i * 4 + k] = j; bw[i * 4 + k] = w / s; });
    }
    return { bi, bw, bones: bones.map(b => b.id) };
  }
  // CCD inverse kinematics: turn up to `chain` bones so the end of `tipId` reaches `target` (object space)
  function solveIK(bones, pose, tipId, target, chain) {
    const by = new Map(bones.map(b => [b.id, b]));
    const list = [];
    let b = by.get(tipId);
    while (b && list.length < chain) { list.push(b); b = b.parent && by.get(b.parent); }
    for (let it = 0; it < 12; it++) {
      for (const bone of list) {
        const ps = poseBones(bones, pose);
        const tip = ps.tail.get(tipId), h = ps.head.get(bone.id);
        const toTip = v3.norm(v3.sub(tip, h)), toT = v3.norm(v3.sub(target, h));
        if (v3.dist(tip, target) < 1e-3) return pose;
        // rotation in object space, converted into the bone's parent frame
        const rw = q.between(toTip, toT);
        const PM = bone.parent ? ps.P.get(bone.parent) : m4.id();
        const pr = window.CM.decompose(PM).r;
        const local = q.mul(q.mul(q.inv(pr), rw), pr);
        const cur = pose.get(bone.id) || bone.rot || [0, 0, 0, 1];
        pose.set(bone.id, q.norm(q.mul(local, cur)));
      }
    }
    return pose;
  }

  // ---------- evaluating a frame ----------
  // returns Map id → { world, pose (bone map), skin (Float32Array of matrices), morphW, color, visible }
  // Repeat: after its last keyframe an object can loop its animation, or go back and forth
  function keyRange(o) { let a = Infinity, b = -Infinity; for (const k of Object.values(o.keys || {})) if (k.length) { a = Math.min(a, k[0].t); b = Math.max(b, k[k.length - 1].t); } return [a, b]; }
  function localTime(o, t) {
    if (!o.repeat || o.repeat === 'none') return t;
    const [a, b] = keyRange(o), span = b - a;
    if (!(span > 1e-3) || t <= b) return t;
    const u = (t - a) / span;
    if (o.repeat === 'loop') return a + (u - Math.floor(u)) * span;
    const f = u % 2; return a + (f <= 1 ? f : 2 - f) * span;
  }
  function evaluate(scene, T0, opt) {
    opt = opt || {};
    const out = new Map(), by = new Map(scene.objects.map(o => [o.id, o]));
    const ov = opt.over;   // live overrides from Stage mode: { id, pos, rot, morph: { id: w } }
    const local = (o, t) => {
      const K = o.keys || {};
      let pos = keyVal(K, 'pos', t, o.pos), rot = keyVal(K, 'rot', t, o.rot), scl = keyVal(K, 'scl', t, o.scl);
      if (ov && ov.id === o.id) { if (ov.pos) pos = ov.pos; if (ov.rot) rot = ov.rot; }
      return m4.trs(pos, q.fromEuler(rot), scl);
    };
    const visit = (o, depth) => {
      if (out.has(o.id)) return out.get(o.id);
      const K = o.keys || {};
      const t = localTime(o, T0);
      const pose = new Map();
      for (const b of o.bones || []) pose.set(b.id, opt.rest ? [0, 0, 0, 1] : keyVal(K, 'bone:' + b.id, t, b.rot || [0, 0, 0, 1]));
      if (opt.pose && opt.pose.id === o.id) for (const [k, v] of opt.pose.map) pose.set(k, v);
      const morphW = {};
      for (const mo of o.morphs || []) morphW[mo.id] = opt.rest ? 0 : keyVal(K, 'morph:' + mo.id, t, mo.w || 0);
      if (ov && ov.id === o.id && ov.morph) for (const id in ov.morph) morphW[id] = ov.morph[id];
      const rec = { world: null, pose, bones: null, morphW, color: keyVal(K, 'color', t, o.color || '#d9d4cf'), visible: o.visible !== false };
      out.set(o.id, rec);
      rec.bones = (o.bones && o.bones.length) ? poseBones(o.bones, pose) : null;
      let parentM = m4.id();
      const par = o.parent && by.get(o.parent);
      if (par && depth < 32) {
        const pr = visit(par, depth + 1);
        parentM = pr.world;
        if (o.parentBone && pr.bones && pr.bones.S.has(o.parentBone)) parentM = m4.mul(parentM, pr.bones.S.get(o.parentBone));
        if (!pr.visible) rec.visible = false;
      }
      rec.world = m4.mul(parentM, local(o, t));
      return rec;
    };
    scene.objects.forEach(o => visit(o, 0));
    return out;
  }
  // display positions with shape keys mixed in (base + Σ weight × delta)
  function morphed(mesh, deltas, weights) {
    let any = false;
    for (const id in weights) if (Math.abs(weights[id]) > 1e-4 && deltas[id]) { any = true; break; }
    if (!any) return null;
    const out = mesh.pos.slice();
    for (const id in weights) { const w = weights[id], d = deltas[id]; if (!d || Math.abs(w) < 1e-4) continue; for (let i = 0; i < out.length; i++) out[i] += d[i] * w; }
    return out;
  }
  // the camera track: { target, yaw, pitch, dist } blended between keys
  function camAt(scene, t) {
    const k = scene.camKeys || [];
    if (!k.length) return null;
    const ks = { c: k };
    const pick = f => keyVal({ c: k.map(x => ({ t: x.t, v: f(x.v), ease: x.ease })) }, 'c', t, f(k[0].v));
    return { target: pick(v => v.target), yaw: pick(v => v.yaw), pitch: pick(v => v.pitch), dist: pick(v => v.dist), fov: pick(v => v.fov || 40) };
  }
  return { keyVal, setKey, keyTimes, localTime, keyRange, rateFn, hex, toHex, poseBones, boneOrder, autoWeights, solveIK, evaluate, morphed, camAt, MAX_BONES };
})();
