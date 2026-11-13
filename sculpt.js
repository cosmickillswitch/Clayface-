/* Clayframe sculpting brushes. Every dab works in the mesh's own space on the vertices inside the brush sphere. */
window.CSculpt = (function () {
  'use strict';
  const BRUSHES = {
    clay: { label: 'Clay', icon: '◒', hint: 'Builds up flat layers, like adding clay' },
    draw: { label: 'Draw', icon: '✎', hint: 'Raises a ridge along the stroke' },
    inflate: { label: 'Inflate', icon: '◍', hint: 'Puffs the surface outwards' },
    smooth: { label: 'Smooth', icon: '≈', hint: 'Evens out bumps' },
    flatten: { label: 'Flatten', icon: '▭', hint: 'Presses towards a flat plane' },
    pinch: { label: 'Pinch', icon: '⋈', hint: 'Pulls the surface together into sharp edges' },
    crease: { label: 'Crease', icon: '⌄', hint: 'Cuts a sharp groove' },
    move: { label: 'Move', icon: '✥', hint: 'Grabs and drags a whole region' },
    snake: { label: 'Snake hook', icon: '⟆', hint: 'Pulls out horns, tentacles and limbs that keep their thickness' },
    mask: { label: 'Mask', icon: '▒', hint: 'Protects areas from other brushes (shown darker)' },
    paint: { label: 'Paint', icon: '🖌', hint: 'Paints colour onto the surface' }
  };
  const fall = x => { const k = 1 - x * x; return k > 0 ? k * k : 0; };
  // vertices within radius r of point P that are joined to the touched spot by the surface:
  // [index, falloff] pairs. Walking the mesh (instead of taking everything in a ball) keeps
  // brushes off hidden overlapping parts and the far side of thin pieces.
  function nearest(mesh, P) {
    const p = mesh.pos; let best = -1, bd = Infinity;
    for (let i = 0, n = p.length / 3; i < n; i++) { const dx = p[i * 3] - P[0], dy = p[i * 3 + 1] - P[1], dz = p[i * 3 + 2] - P[2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function gather(mesh, P, r, seed) {
    const p = mesh.pos, out = [], r2 = r * r, n = p.length / 3;
    if (seed == null || seed < 0 || seed >= n) seed = nearest(mesh, P);
    if (seed < 0) return out;
    if (!mesh._stamp || mesh._stamp.length !== n) { mesh._stamp = new Uint32Array(n); mesh._gen = 0; }
    const st = mesh._stamp, gen = ++mesh._gen;
    if (gen > 4e9) { st.fill(0); mesh._gen = 1; }
    const stack = [seed]; st[seed] = mesh._gen;
    const d2 = i => { const dx = p[i * 3] - P[0], dy = p[i * 3 + 1] - P[1], dz = p[i * 3 + 2] - P[2]; return dx * dx + dy * dy + dz * dz; };
    while (stack.length) {
      const i = stack.pop(), dd = d2(i);
      // the seed may sit just outside a tiny brush; still walk from it
      if (dd < r2) out.push(i, fall(Math.sqrt(dd) / r));
      else if (i !== seed) continue;
      for (let k = mesh.nbStart[i]; k < mesh.nbStart[i + 1]; k++) { const j = mesh.nb[k]; if (st[j] !== mesh._gen) { st[j] = mesh._gen; if (d2(j) < r2) stack.push(j); } }
    }
    return out;
  }
  // one dab. opt: { tool, P, N, r, s (0..1), invert, color [r,g,b] }. Returns changed vertex indices.
  function dab(mesh, opt) {
    const { tool, P, r } = opt, s = opt.s, sgn = opt.invert ? -1 : 1;
    const p = mesh.pos, nr = mesh.nor, mk = mesh.mask, g = gather(mesh, P, r, opt.seed), changed = [];
    if (!g.length) return changed;
    if (tool === 'mask') {
      for (let k = 0; k < g.length; k += 2) { const i = g[k]; mk[i] = Math.max(0, Math.min(1, mk[i] + sgn * g[k + 1] * s)); changed.push(i); }
      mesh.cver = (mesh.cver || 0) + 1;
      return changed;
    }
    if (tool === 'paint') {
      const c = opt.color || [1, 1, 1];
      for (let k = 0; k < g.length; k += 2) { const i = g[k], a = g[k + 1] * s * (1 - mk[i]); for (let j = 0; j < 3; j++) mesh.col[i * 3 + j] += (c[j] - mesh.col[i * 3 + j]) * a; changed.push(i); }
      mesh.cver = (mesh.cver || 0) + 1;
      return changed;
    }
    // area-weighted centre and normal of the brush region
    let cx = 0, cy = 0, cz = 0, wsum = 0;
    for (let k = 0; k < g.length; k += 2) { const i = g[k], w = g[k + 1]; cx += p[i * 3] * w; cy += p[i * 3 + 1] * w; cz += p[i * 3 + 2] * w; wsum += w; }
    cx /= wsum; cy /= wsum; cz /= wsum;
    // the brush's own normal: the region's average, which is steadier than the single hit normal
    let ax = 0, ay = 0, az = 0;
    for (let k = 0; k < g.length; k += 2) { const i = g[k] * 3, w = g[k + 1]; ax += nr[i] * w; ay += nr[i + 1] * w; az += nr[i + 2] * w; }
    const al = Math.hypot(ax, ay, az);
    const N = al > 1e-6 && (ax * opt.N[0] + ay * opt.N[1] + az * opt.N[2]) > 0 ? [ax / al, ay / al, az / al] : opt.N;
    const old = tool === 'smooth' ? p.slice() : null;
    for (let k = 0; k < g.length; k += 2) {
      const i = g[k], f = g[k + 1] * (1 - mk[i]);
      if (f <= 0) continue;
      const o = i * 3;
      let dx = 0, dy = 0, dz = 0;
      switch (tool) {
        case 'draw': { const a = sgn * s * r * 0.11 * f; dx = N[0] * a; dy = N[1] * a; dz = N[2] * a; break; }
        case 'inflate': { const a = sgn * s * r * 0.09 * f; dx = nr[o] * a; dy = nr[o + 1] * a; dz = nr[o + 2] * a; break; }
        case 'clay': {
          // push up to a plane just above the surface, so strokes build flat layers
          const off = sgn * r * 0.14 * s;
          const d = (cx + N[0] * off - p[o]) * N[0] + (cy + N[1] * off - p[o + 1]) * N[1] + (cz + N[2] * off - p[o + 2]) * N[2];
          if (sgn * d > 0) { const a = d * f * 0.5; dx = N[0] * a; dy = N[1] * a; dz = N[2] * a; }
          break;
        }
        case 'flatten': { const d = (p[o] - cx) * N[0] + (p[o + 1] - cy) * N[1] + (p[o + 2] - cz) * N[2], a = -d * f * s * 0.5; dx = N[0] * a; dy = N[1] * a; dz = N[2] * a; break; }
        case 'pinch': case 'crease': {
          let tx = P[0] - p[o], ty = P[1] - p[o + 1], tz = P[2] - p[o + 2];
          const dn = tx * N[0] + ty * N[1] + tz * N[2]; tx -= N[0] * dn; ty -= N[1] * dn; tz -= N[2] * dn;
          const a = sgn * f * s * (tool === 'pinch' ? 0.22 : 0.16);
          dx = tx * a; dy = ty * a; dz = tz * a;
          if (tool === 'crease') { const b = -sgn * s * r * 0.07 * f; dx += N[0] * b; dy += N[1] * b; dz += N[2] * b; }
          break;
        }
        case 'smooth': {
          let ax = 0, ay = 0, az = 0, c = 0;
          for (let j = mesh.nbStart[i]; j < mesh.nbStart[i + 1]; j++) { const u = mesh.nb[j] * 3; ax += old[u]; ay += old[u + 1]; az += old[u + 2]; c++; }
          if (c) { const a = f * Math.min(1, s * 1.2); dx = (ax / c - old[o]) * a; dy = (ay / c - old[o + 1]) * a; dz = (az / c - old[o + 2]) * a; }
          break;
        }
      }
      p[o] += dx; p[o + 1] += dy; p[o + 2] += dz;
      changed.push(i);
    }
    return changed;
  }
  // Move brush: remember the region at the start, then follow the finger.
  // With mirroring, both sides are one grab: each point gets its own pull plus the mirrored pull,
  // so where the two regions overlap in the middle they add up instead of fighting.
  // mirror: axis index to mirror across (0 = X, 1 = Y, 2 = Z), or null
  const mir = (v, ax) => { const o = v.slice(); o[ax] = -o[ax]; return o; };
  function grabStart(mesh, P, r, seed, mirror) {
    const W = new Map();
    const add = (g, slot) => { for (let k = 0; k < g.length; k += 2) { const i = g[k]; let e = W.get(i); if (!e) { e = [0, 0]; W.set(i, e); } e[slot] = Math.max(e[slot], g[k + 1]); } };
    add(gather(mesh, P, r, seed), 0);
    if (mirror != null && mirror !== false) add(gather(mesh, mir(P, mirror === true ? 0 : mirror), r), 1);
    const idx = [], w = [], orig = [];
    for (const [i, e] of W) {
      const m = 1 - mesh.mask[i];
      // on the mirror line the two pulls share one sideways motion, so the middle stays put across X
      idx.push(i); w.push(e[0] * m, e[1] * m); orig.push(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]);
    }
    return { idx, w, orig, axis: mirror === true ? 0 : mirror };
  }
  function grabMove(mesh, grab, d) {
    const p = mesh.pos, md = grab.axis != null && grab.axis !== false ? mir(d, grab.axis) : [0, 0, 0];
    grab.idx.forEach((i, k) => {
      let a = grab.w[k * 2], b = grab.w[k * 2 + 1];
      // where both sides reach the same point, blend rather than double the pull
      const s = a + b; if (s > 1) { a /= s; b /= s; }
      p[i * 3] = grab.orig[k * 3] + d[0] * a + md[0] * b;
      p[i * 3 + 1] = grab.orig[k * 3 + 1] + d[1] * a + md[1] * b;
      p[i * 3 + 2] = grab.orig[k * 3 + 2] + d[2] * a + md[2] * b;
    });
    return grab.idx;
  }
  // Snake hook: each step grabs the region at the tip and carries it along, so the pull keeps going
  function snakeStep(mesh, P, r, d, seed) {
    const g = gather(mesh, P, r, seed), p = mesh.pos, out = [];
    for (let k = 0; k < g.length; k += 2) { const i = g[k], f = Math.min(1, g[k + 1] * 1.25) * (1 - mesh.mask[i]); if (f <= 0) continue; p[i * 3] += d[0] * f; p[i * 3 + 1] += d[1] * f; p[i * 3 + 2] += d[2] * f; out.push(i); }
    return out;
  }
  // weight painting: add to (or take from) one bone's share of each vertex, keeping the best four
  function weightDab(mesh, skin, P, r, seed, bone, amount, smooth) {
    const g = gather(mesh, P, r, seed), bi = skin.bi, bw = skin.bw, out = [];
    const read = i => { const W = new Map(); for (let k = 0; k < 4; k++) { const w = bw[i * 4 + k]; if (w > 0) W.set(bi[i * 4 + k], (W.get(bi[i * 4 + k]) || 0) + w); } return W; };
    const write = (i, W) => { const top = [...W].filter(x => x[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4); const s = top.reduce((a, x) => a + x[1], 0); for (let k = 0; k < 4; k++) { bi[i * 4 + k] = top[k] && s ? top[k][0] : 0; bw[i * 4 + k] = top[k] && s ? top[k][1] / s : (k === 0 && !s ? 1 : 0); } };
    const prev = smooth ? new Map() : null;
    if (smooth) for (let k = 0; k < g.length; k += 2) { const i = g[k]; prev.set(i, read(i)); for (let j = mesh.nbStart[i]; j < mesh.nbStart[i + 1]; j++) { const u = mesh.nb[j]; if (!prev.has(u)) prev.set(u, read(u)); } }
    for (let k = 0; k < g.length; k += 2) {
      const i = g[k], f = g[k + 1];
      let W;
      if (smooth) {
        W = new Map(); const self = prev.get(i); let c = 0;
        for (let j = mesh.nbStart[i]; j < mesh.nbStart[i + 1]; j++) { c++; for (const [b, w] of prev.get(mesh.nb[j])) W.set(b, (W.get(b) || 0) + w); }
        for (const [b, w] of W) W.set(b, w / (c || 1));
        const out2 = new Map(); for (const b of new Set([...W.keys(), ...self.keys()])) out2.set(b, (self.get(b) || 0) * (1 - f * amount) + (W.get(b) || 0) * f * amount);
        W = out2;
      } else {
        W = read(i);
        const cur = W.get(bone) || 0, nv = Math.max(0, Math.min(1, cur + amount * f));
        // scale the others so the total stays 1
        const rest = 1 - cur, want = 1 - nv;
        for (const [b, w] of W) if (b !== bone) W.set(b, rest > 1e-6 ? w * want / rest : 0);
        W.set(bone, nv);
        if (rest <= 1e-6 && want > 0 && W.size === 1) { /* only this bone: nothing to hand the rest to */ }
      }
      write(i, W); out.push(i);
    }
    return out;
  }
  // even out stretched triangles after a big pull, sliding points along the surface only
  function relax(mesh, idx, weights, passes) {
    const p = mesh.pos, nr = mesh.nor;
    for (let it = 0; it < (passes || 2); it++) {
      const old = p.slice();
      idx.forEach((i, k) => {
        const f = Math.min(1, weights ? weights[k] : 1) * 0.5 * (1 - mesh.mask[i]);
        if (f <= 0.01) return;
        let ax = 0, ay = 0, az = 0, c = 0;
        for (let j = mesh.nbStart[i]; j < mesh.nbStart[i + 1]; j++) { const u = mesh.nb[j] * 3; ax += old[u]; ay += old[u + 1]; az += old[u + 2]; c++; }
        if (!c) return;
        const o = i * 3;
        let lx = ax / c - old[o], ly = ay / c - old[o + 1], lz = az / c - old[o + 2];
        const dn = lx * nr[o] + ly * nr[o + 1] + lz * nr[o + 2];
        lx -= nr[o] * dn; ly -= nr[o + 1] * dn; lz -= nr[o + 2] * dn;
        p[o] += lx * f; p[o + 1] += ly * f; p[o + 2] += lz * f;
      });
    }
  }
  // whole-mesh helpers
  function smoothAll(mesh, passes) {
    for (let it = 0; it < (passes || 1); it++) {
      const old = mesh.pos.slice(), p = mesh.pos;
      for (let i = 0, n = p.length / 3; i < n; i++) {
        const f = 0.5 * (1 - mesh.mask[i]); if (!f) continue;
        let ax = 0, ay = 0, az = 0, c = 0;
        for (let j = mesh.nbStart[i]; j < mesh.nbStart[i + 1]; j++) { const u = mesh.nb[j] * 3; ax += old[u]; ay += old[u + 1]; az += old[u + 2]; c++; }
        if (c) { p[i * 3] += (ax / c - old[i * 3]) * f; p[i * 3 + 1] += (ay / c - old[i * 3 + 1]) * f; p[i * 3 + 2] += (az / c - old[i * 3 + 2]) * f; }
      }
    }
  }
  return { BRUSHES, dab, grabStart, grabMove, snakeStep, weightDab, relax, smoothAll, gather, nearest, mir };
})();
