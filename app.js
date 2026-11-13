/* Clayframe editor: modes (Sculpt, Objects, Rig, Pose, Stage), touch navigation, gizmo, timeline, storage and export. */
(function () {
  'use strict';
  const { v3, q, m4, clamp, decompose } = window.CM;
  const S = window.CScene, MESHLIB = window.CMesh, SC = window.CSculpt, RND = window.CRender;
  const $ = id => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const round = (v, d) => { const k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; };
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'style') e.setAttribute('style', v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  let toastT = 0;
  function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 2600); }

  // ---------- state ----------
  let scene = null, projId = null;
  const MESH = new Map();          // object id → { m: mesh, morphs: { shapeId: Float32Array }, skin: { bi, bw, bones } | null }
  let sel = null, selBone = null, mode = 'sculpt';
  let time = 0, playing = false, playT0 = 0, dirty = true;
  let autoKey = false, camView = false, tlOpen = true;
  const cam = { target: [0, 0.9, 0], yaw: 0.6, pitch: 0.25, dist: 5.2, fov: 40 };
  const brush = Object.assign({ tool: 'clay', radius: 50, strength: 0.45, invert: false, sym: true, color: '#C8553D', detail: true, detailLevel: 'medium', prStr: true, prSize: false }, store.get('clayframe.brush', {}));
  let shapeEdit = null;            // { id, mid, base }
  let rigChain = null;             // { id, last: [x,y,z], parent: boneId|null, mlast, mparent }
  let ik = Object.assign({ on: true, len: 2 }, store.get('clayframe.ik', {}));
  let lastEval = null, camNow = null;
  const selObj = () => (scene && scene.objects.find(o => o.id === sel)) || null;
  const objById = id => scene.objects.find(o => o.id === id) || null;

  // ---------- storage: IndexedDB holds projects (meshes are big binary arrays) ----------
  const db = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => { try { const r = indexedDB.open('clayframe', 1); r.onupgradeneeded = () => r.result.createObjectStore('projects'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
    const tx = (mode, fn) => open().then(d => new Promise((res, rej) => { const t = d.transaction('projects', mode), st = t.objectStore('projects'); const r = fn(st); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }));
    return { put: (id, v) => tx('readwrite', s => s.put(v, id)), get: id => tx('readonly', s => s.get(id)), del: id => tx('readwrite', s => s.delete(id)) };
  })();
  let memProjects = new Map();     // fallback when IndexedDB is unavailable
  const listMeta = () => store.get('clayframe.projects', []);
  function packMeshes() {
    const out = {};
    for (const [id, M] of MESH) out[id] = { pos: M.m.pos, idx: M.m.idx, col: M.m.col, mask: M.m.mask, morphs: M.morphs, skin: M.skin };
    return out;
  }
  function unpackMeshes(meshes) {
    MESH.clear();
    for (const [id, d] of Object.entries(meshes || {})) {
      const m = MESHLIB.make(d.pos, d.idx);
      if (d.col && d.col.length === m.col.length) m.col.set(d.col);
      if (d.mask && d.mask.length === m.mask.length) m.mask.set(d.mask);
      MESH.set(id, { m, morphs: d.morphs || {}, skin: d.skin || null });
    }
  }
  let saveT = 0, saving = false;
  function saveSoon() { clearTimeout(saveT); saveT = setTimeout(saveNow, 1200); }
  let saveAgain = false;
  async function saveNow() {
    if (!scene) return;
    if (saving) { saveAgain = true; return; }
    saving = true;
    const rec = { id: projId, scene: JSON.parse(JSON.stringify(scene)), meshes: packMeshes(), at: Date.now() };
    try { await db.put(projId, rec); } catch (e) { memProjects.set(projId, rec); }
    const meta = listMeta().filter(p => p.id !== projId);
    meta.unshift({ id: projId, name: scene.name, at: rec.at });
    store.set('clayframe.projects', meta);
    store.set('clayframe.current', projId);
    saving = false;
    if (saveAgain) { saveAgain = false; await saveNow(); }
  }
  async function loadProject(id) {
    let rec = null;
    try { rec = await db.get(id); } catch (e) { rec = memProjects.get(id); }
    if (!rec) return false;
    openScene(rec.scene, rec.meshes, id);
    return true;
  }
  function openScene(sc, meshes, id) {
    scene = sc; projId = id;
    scene.camKeys = scene.camKeys || [];
    unpackMeshes(meshes);
    sel = scene.objects[0] ? scene.objects[0].id : null; selBone = null;
    time = 0; playing = false; hist.length = 0; redoStack.length = 0;
    shapeEdit = null; rigChain = null;
    Object.assign(cam, scene.view || { target: [0, 0.6, 0], yaw: 0.6, pitch: 0.3, dist: 4, fov: 40 });
    fillProjects(); setMode(mode === 'stage' ? 'objects' : mode); renderTimeline(); dirty = true;
    $('dur').textContent = scene.duration; setTime(0);
  }
  function fillProjects() {
    const sel_ = $('proj'); sel_.innerHTML = '';
    for (const p of listMeta()) sel_.append(h('option', { value: p.id }, p.name));
    sel_.value = projId;
  }

  // ---------- undo ----------
  const hist = [], redoStack = [];
  function snapScene() { return { kind: 'scene', json: JSON.stringify(scene) }; }
  function snapMesh(id) { const M = MESH.get(id); return { kind: 'mesh', id, m: M.m, pos: M.m.pos.slice(), col: M.m.col.slice(), mask: M.m.mask.slice(), morphs: Object.assign({}, M.morphs), skin: M.skin, json: JSON.stringify(scene) }; }
  function pushUndo(s) { hist.push(s); if (hist.length > 40) hist.shift(); redoStack.length = 0; updUndo(); }
  function restore(s) {
    const cur = s.kind === 'mesh' ? snapMesh(s.id) : snapScene();
    if (s.kind === 'mesh') {
      const M = MESH.get(s.id);
      if (M) {
        if (M.m !== s.m) { M.m = s.m; }
        M.m.pos.set(s.pos); M.m.col.set(s.col); M.m.mask.set(s.mask);
        M.morphs = s.morphs; M.skin = s.skin;
        MESHLIB.normals(M.m); M.m.ver++; M.m.cver = (M.m.cver || 0) + 1;
      }
    }
    if (s.json) { const keepSel = sel; scene = JSON.parse(s.json); if (!objById(keepSel)) sel = null; }
    return cur;
  }
  function undo() { const s = hist.pop(); if (!s) return; redoStack.push(restore(s)); after(); }
  function redo() { const s = redoStack.pop(); if (!s) return; hist.push(restore(s)); after(); }
  function after() { updUndo(); renderTools(); renderTimeline(); refreshSheet(); dirty = true; saveSoon(); }
  function updUndo() { $('undo').disabled = !hist.length; $('redo').disabled = !redoStack.length; }
  // record the scene before a change; call changed() after
  const before = () => pushUndo(snapScene());
  function changed(opts) { dirty = true; saveSoon(); if (!opts || opts.tl !== false) renderTimelineSoon(); updKeyBtn(); }

  // ---------- objects ----------
  function newObj(over) {
    return Object.assign({ id: uid(), name: 'Object', type: 'mesh', parent: null, parentBone: null, pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], color: '#D9D4CF', matcap: 'clay', flat: false, visible: true, keys: {}, bones: [], morphs: [] }, over || {});
  }
  function addMesh(m, over) {
    const o = newObj(over);
    MESH.set(o.id, { m, morphs: {}, skin: null });
    scene.objects.push(o);
    return o;
  }
  const countName = base => { let n = 1; while (scene.objects.some(o => o.name === base + ' ' + n)) n++; return base + ' ' + n; };
  function addPrim(kind) {
    before();
    const m = MESHLIB.PRIMS[kind].make(), b = MESHLIB.bounds(m);
    const o = addMesh(m, { name: countName(MESHLIB.PRIMS[kind].label), pos: [0, round(-b.min[1], 3), 0] });
    if (kind === 'plane') o.scl = [3, 1, 3];
    sel = o.id; selBone = null;
    changed(); renderTools(); closeSheet(); renderTimeline();
    if (scene.objects.length === 1) { draw(); frameSel(); }
    toast('Added ' + o.name + (mode === 'sculpt' ? '. One finger sculpts, two fingers move the view.' : ''));
  }
  function descendants(o) { const out = []; const walk = p => scene.objects.forEach(c => { if (c.parent === p.id && !out.includes(c)) { out.push(c); walk(c); } }); walk(o); return out; }

  // ---------- channels: static values, or keyframes when animated ----------
  function chanList(o) {
    const L = [['pos', 'Move'], ['rot', 'Turn'], ['scl', 'Size']];
    for (const b of o.bones || []) L.push(['bone:' + b.id, b.name]);
    for (const mo of o.morphs || []) L.push(['morph:' + mo.id, mo.name]);
    if ((o.keys.color || []).length) L.push(['color', 'Colour']);
    return L;
  }
  function staticVal(o, ch) {
    if (ch === 'pos' || ch === 'rot' || ch === 'scl') return o[ch];
    if (ch === 'color') return o.color;
    if (ch.startsWith('bone:')) { const b = o.bones.find(x => x.id === ch.slice(5)); return b ? (b.rot || [0, 0, 0, 1]) : [0, 0, 0, 1]; }
    if (ch.startsWith('morph:')) { const mo = o.morphs.find(x => x.id === ch.slice(6)); return mo ? mo.w || 0 : 0; }
  }
  const getChan = (o, ch, t) => S.keyVal(o.keys, ch, t == null ? time : t, staticVal(o, ch));
  function setChan(o, ch, v) {
    const keyed = o.keys[ch] && o.keys[ch].length;
    if (keyed || autoKey) { S.setKey(o.keys, ch, round(time, 3), v); return; }
    if (ch === 'pos' || ch === 'rot' || ch === 'scl') o[ch] = v;
    else if (ch === 'color') o.color = v;
    else if (ch.startsWith('bone:')) { const b = o.bones.find(x => x.id === ch.slice(5)); if (b) b.rot = v; }
    else if (ch.startsWith('morph:')) { const mo = o.morphs.find(x => x.id === ch.slice(6)); if (mo) mo.w = v; }
  }
  const keysAt = (o, t) => Object.entries(o.keys).filter(([, k]) => k.some(x => Math.abs(x.t - t) < 1e-3));
  function toggleKeyAll() {
    const o = selObj(); if (!o) { toast('Select something to keyframe'); return; }
    before();
    const t = round(time, 3), here = keysAt(o, t);
    if (here.length) { for (const [ch, k] of here) { o.keys[ch] = k.filter(x => Math.abs(x.t - t) >= 1e-3); if (!o.keys[ch].length) delete o.keys[ch]; } toast('Keyframe removed'); }
    else { for (const [ch] of chanList(o)) S.setKey(o.keys, ch, t, getChan(o, ch)); toast('Keyframed ' + o.name + ' at ' + t.toFixed(2) + 's'); }
    changed(); renderTimeline();
  }
  function updKeyBtn() {
    const o = selObj(), b = $('keyBtn');
    const at = o && keysAt(o, round(time, 3)).length, some = o && Object.keys(o.keys).length;
    b.className = 'keybtn big' + (at ? ' on' : some ? ' some' : '');
    b.textContent = at ? '◆' : '◇';
  }

  // ---------- frame evaluation and drawing ----------
  const view = $('view'), ov = $('ov'), octx = ov.getContext('2d');
  const R = RND.create(view);
  if (!R) { document.body.innerHTML = '<p style="padding:24px">This device or browser doesn’t support WebGL 2, which Clayframe needs for 3D.</p>'; return; }
  let dpr = 1, W = 1, H = 1, camObj = null;
  function resize() {
    if (exporting) return;
    const r = view.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
    if (view.width !== W || view.height !== H) { view.width = W; view.height = H; ov.width = W; ov.height = H; }
    dirty = true;
  }
  new ResizeObserver(resize).observe($('viewWrap'));
  const restMode = () => mode === 'sculpt' || mode === 'rig';
  function boneArray(M, rec) {
    const arr = new Float32Array(48 * 16);
    M.skin.bones.forEach((id, i) => { if (i < 48) arr.set(rec.bones && rec.bones.S.get(id) || m4.id(), i * 16); });
    for (let i = M.skin.bones.length; i < 48; i++) arr.set(m4.id(), i * 16);
    return arr;
  }
  function displayFor(M, w, slot) {
    const key = JSON.stringify(w) + '|' + M.m.ver + '|' + M.m.topoVer, c = M._dc || (M._dc = {}), k = slot || 'main';
    if (c[k] && c[k].key === key) return c[k].disp;
    c[k] = { key, disp: S.morphed(M.m, M.morphs, w) };
    return c[k].disp;
  }
  function viewCam() {
    if (camView || (exporting && exporting.cam)) { const c = S.camAt(scene, time); if (c) return c; }
    return cam;
  }
  let renderMode = false, wireOn = false, onion = false, weightMode = false;
  // weights of one bone as colours: blue (none) → green → yellow → red (all)
  function weightColors(M, boneId) {
    const n = M.m.pos.length / 3, key = (M.skin.ver || 0) + '|' + boneId + '|' + n + '|' + M.m.topoVer;
    if (M._wk === key) return M._wc;
    const out = new Float32Array(n * 4), j = M.skin.bones.indexOf(boneId);
    for (let i = 0; i < n; i++) {
      let w = 0; if (j >= 0) for (let k = 0; k < 4; k++) if (M.skin.bi[i * 4 + k] === j) w += M.skin.bw[i * 4 + k];
      const c = w < 0.33 ? [0.12, 0.25 + w * 1.5, 0.85 - w] : w < 0.66 ? [(w - 0.33) * 3, 0.85, 0.2] : [1, 0.85 - (w - 0.66) * 2.2, 0.15];
      out.set([c[0], c[1], c[2], 0], i * 4);
    }
    M._wk = key; M._wc = out;
    return out;
  }
  function itemFor(o, rec, rest, opt, extra) {
    const M = MESH.get(o.id);
    if (!rec || !M || !rec.visible) return null;
    const editingShape = shapeEdit && shapeEdit.id === o.id;
    const display = rest || editingShape ? null : displayFor(M, rec.morphW, extra && extra.cache);
    const bones = !rest && M.skin && o.bones.length ? boneArray(M, rec) : null;
    const it = { id: o.id, mesh: M.m, display, skin: M.skin, bones, model: rec.world, color: S.hex(rec.color), matcap: o.matcap, flat: o.flat, selected: !opt.final && o.id === sel && mode !== 'stage' && !renderMode, alpha: 1 };
    if (!opt.final && wireOn && (mode === 'sculpt' || o.id === sel)) it.wire = true;
    if (!opt.final && mode === 'rig' && weightMode && o.id === sel && M.skin && selBone) { it.colOverride = weightColors(M, selBone); it.colKey = M._wk; it.color = [1, 1, 1]; it.matcap = 'clay'; }
    return it;
  }
  function sceneSphere(items) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const it of items) {
      const M = MESH.get(it.id.replace(/^ghost\d:/, '')); if (!M) continue;
      const b = boundsOf(M), c = m4.point(it.model, b.c), r = b.r * Math.hypot(it.model[0], it.model[1], it.model[2]);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k] - r); hi[k] = Math.max(hi[k], c[k] + r); }
    }
    if (!isFinite(lo[0])) return { c: [0, 0.8, 0], r: 2 };
    return { c: v3.lerp(lo, hi, 0.5), r: v3.dist(lo, hi) / 2 };
  }
  function draw(opt) {
    opt = opt || {};
    const rest = !opt.final && restMode();
    const pose = opt.pose || null;
    const ev = S.evaluate(scene, time, { rest, pose, over: opt.over });
    lastEval = ev;
    camNow = viewCam();
    camObj = RND.camera(camNow, W, H);
    const items = [];
    for (const o of scene.objects) { if (o.type !== 'mesh') continue; const it = itemFor(o, ev.get(o.id), rest, opt); if (it) items.push(it); }
    // onion skin: the selected object at its previous and next keyframes, as tinted ghosts
    const so = selObj();
    if (onion && !opt.final && !rest && so && MESH.get(so.id)) {
      const ts = S.keyTimes(so), prev = ts.filter(t => t < time - 1e-3).pop(), next = ts.find(t => t > time + 1e-3);
      const at = [[prev != null ? prev : time - 0.25, [0.35, 0.6, 1, 0.55]], [next != null ? next : time + 0.25, [0.45, 1, 0.55, 0.55]]];
      at.forEach(([t, tint], k) => {
        if (t < 0 || t > scene.duration) return;
        const e2 = S.evaluate(scene, t, {}), it = itemFor(so, e2.get(so.id), false, { final: true }, { cache: 'g' + k });
        if (it) { it.id = 'ghost' + k + ':' + so.id; it.alpha = 0.28; it.tint = tint; items.push(it); }
      });
    }
    const lit = renderMode || (opt.final && exporting && exporting.lit);
    R.draw(items, camObj, { grid: !opt.final && scene.grid !== false, bg: S.hex(scene.bg || '#24242A'), lit, ground: lit && scene.floor !== false ? S.hex(scene.floorColor || '#6E655C') : null, groundY: 0, scene: lit ? sceneSphere(items) : null, sky: S.hex(scene.sky || '#BFD0EA'), groundCol: S.hex(scene.floorColor || '#6E655C') });
    if (!opt.final) drawOverlay(ev);
    else octx.clearRect(0, 0, W, H);
  }

  // ---------- picking ----------
  function worldOf(o) { const r = lastEval && lastEval.get(o.id); return r ? r.world : m4.id(); }
  function boundsOf(M) { if (M._bv !== M.m.ver) { M._b = MESHLIB.bounds(M.m); M._bv = M.m.ver; } return M._b; }
  // nearest mesh under a canvas pixel (only = one object id)
  function pick(px, py, only) {
    const r = camObj.ray(px, py);
    let best = null;
    for (const o of scene.objects) {
      if (o.type !== 'mesh' || (only && o.id !== only)) continue;
      const rec = lastEval.get(o.id); if (!rec || !rec.visible) continue;
      const M = MESH.get(o.id); if (!M) continue;
      const Wm = rec.world, Wi = m4.inv(Wm);
      const lo = m4.point(Wi, r.o), ld = v3.norm(m4.dir(Wi, r.d));
      const b = boundsOf(M), oc = v3.sub(b.c, lo), tc = v3.dot(oc, ld);
      if (v3.dot(oc, oc) - tc * tc > b.r * b.r * 1.02) continue;
      const hit = MESHLIB.raycast(M.m, lo, ld, true);
      if (!hit) continue;
      const wp = m4.point(Wm, hit.p), d = v3.dist(camObj.eye, wp);
      if (!best || d < best.d) best = { o, M, hit, wp, d, lo, ld, Wm, Wi };
    }
    return best;
  }

  // ---------- overlay: brush ring, gizmo, bones ----------
  let hover = null;
  const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], AXC = ['#F2685B', '#7BD389', '#5B9BFF'];
  function parentWorld(o) {
    if (!o.parent) return m4.id();
    const pr = lastEval && lastEval.get(o.parent);
    if (!pr) return m4.id();
    let M = pr.world;
    if (o.parentBone && pr.bones && pr.bones.S.has(o.parentBone)) M = m4.mul(M, pr.bones.S.get(o.parentBone));
    return M;
  }
  function gizmoGeom(o) {
    const Wm = worldOf(o), c = [Wm[12], Wm[13], Wm[14]], cs = camObj.project(c);
    if (cs[2] <= 0) return null;
    const px = camObj.pxSize(c), L = 92 * dpr * px, ringR = 62 * dpr * px;
    const axes = AX.map((e, i) => ({ i, e, tip: camObj.project(v3.add(c, v3.scale(e, L))), L }));
    const rings = AX.map((e, i) => {
      const u = AX[(i + 1) % 3], w = AX[(i + 2) % 3], pts = [];
      for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; pts.push(camObj.project(v3.add(c, v3.add(v3.scale(u, Math.cos(a) * ringR), v3.scale(w, Math.sin(a) * ringR))))); }
      return { i, e, pts };
    });
    return { c, cs, axes, rings, outer: 118 * dpr };
  }
  function bonePts(o, ev) {
    const rec = ev.get(o.id); if (!rec || !rec.bones) return [];
    return o.bones.map(b => {
      const hw = m4.point(rec.world, rec.bones.head.get(b.id)), tw = m4.point(rec.world, rec.bones.tail.get(b.id));
      return { b, hw, tw, h: camObj.project(hw), t: camObj.project(tw) };
    });
  }
  function drawOverlay(ev) {
    const x = octx; x.clearRect(0, 0, W, H);
    const k = dpr, o = selObj();
    if (camView || (scene.camKeys.length && mode === 'stage')) frameGuide(x);
    if (mode === 'sculpt' && hover && !playing) {
      x.strokeStyle = brush.invert ? '#5BC0FF' : '#FFFFFF'; x.lineWidth = 1.5 * k; x.globalAlpha = 0.8;
      x.beginPath(); x.arc(hover[0], hover[1], brush.radius * k, 0, 7); x.stroke();
      x.globalAlpha = 0.35; x.beginPath(); x.arc(hover[0], hover[1], brush.radius * k * brush.strength, 0, 7); x.stroke(); x.globalAlpha = 1;
    }
    if (mode === 'objects' && o && !playing) {
      const g = gizmoGeom(o);
      if (g) {
        x.lineCap = 'round';
        x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1.5 * k; x.beginPath(); x.arc(g.cs[0], g.cs[1], g.outer, 0, 7); x.stroke();
        g.rings.forEach(r => { x.strokeStyle = AXC[r.i]; x.globalAlpha = 0.7; x.lineWidth = 2.5 * k; x.beginPath(); r.pts.forEach((p, j) => j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.stroke(); });
        x.globalAlpha = 1;
        g.axes.forEach(a => {
          x.strokeStyle = x.fillStyle = AXC[a.i]; x.lineWidth = 3.5 * k;
          x.beginPath(); x.moveTo(g.cs[0], g.cs[1]); x.lineTo(a.tip[0], a.tip[1]); x.stroke();
          x.beginPath(); x.arc(a.tip[0], a.tip[1], 8 * k, 0, 7); x.fill();
        });
        x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.arc(g.cs[0], g.cs[1], 7 * k, 0, 7); x.fill();
      }
    }
    if ((mode === 'rig' || mode === 'pose') && o && o.bones.length) {
      for (const p of bonePts(o, ev)) {
        const on = p.b.id === selBone, dx = p.t[0] - p.h[0], dy = p.t[1] - p.h[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, w = Math.min(14 * k, L * 0.16);
        const mx = p.h[0] + dx * 0.18, my = p.h[1] + dy * 0.18;
        x.fillStyle = on ? 'rgba(91,192,255,.55)' : 'rgba(255,214,130,.38)'; x.strokeStyle = on ? '#5BC0FF' : 'rgba(255,214,130,.95)'; x.lineWidth = 1.5 * k;
        x.beginPath(); x.moveTo(p.h[0], p.h[1]); x.lineTo(mx + nx * w, my + ny * w); x.lineTo(p.t[0], p.t[1]); x.lineTo(mx - nx * w, my - ny * w); x.closePath(); x.fill(); x.stroke();
        x.fillStyle = on ? '#5BC0FF' : '#FFD682';
        x.beginPath(); x.arc(p.t[0], p.t[1], 7 * k, 0, 7); x.fill();
        if (!p.b.parent) { x.beginPath(); x.arc(p.h[0], p.h[1], 8 * k, 0, 7); x.strokeStyle = '#fff'; x.lineWidth = 2 * k; x.stroke(); }
      }
      if (mode === 'pose' && selBone && !playing) {
        const g = boneRings(o, ev);
        if (g) g.rings.forEach(r => { x.strokeStyle = AXC[r.i]; x.globalAlpha = 0.75; x.lineWidth = 2.5 * k; x.beginPath(); r.pts.forEach((p, j) => j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.stroke(); x.globalAlpha = 1; });
      }
    }
    if (mode === 'rig' && rigChain && rigChain.lastW && hover) {
      const a = camObj.project(rigChain.lastW);
      x.setLineDash([6 * k, 6 * k]); x.strokeStyle = '#FFD682'; x.lineWidth = 2 * k; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(hover[0], hover[1]); x.stroke(); x.setLineDash([]);
    }
  }
  function frameGuide(x) {
    const [aw, ah] = String(scene.aspect || '16:9').split(':').map(Number), r = aw / ah;
    let fw = W, fh = W / r; if (fh > H) { fh = H; fw = H * r; }
    const x0 = (W - fw) / 2, y0 = (H - fh) / 2;
    x.fillStyle = 'rgba(0,0,0,.45)';
    x.fillRect(0, 0, W, y0); x.fillRect(0, y0 + fh, W, H - y0 - fh); x.fillRect(0, y0, x0, fh); x.fillRect(x0 + fw, y0, W - x0 - fw, fh);
    x.strokeStyle = 'rgba(255,255,255,.4)'; x.lineWidth = dpr; x.strokeRect(x0, y0, fw, fh);
  }
  function boneRings(o, ev) {
    const pt = bonePts(o, ev).find(p => p.b.id === selBone); if (!pt) return null;
    const c = pt.hw, px = camObj.pxSize(c), R0 = 46 * dpr * px;
    return { c, cs: camObj.project(c), rings: AX.map((e, i) => { const u = AX[(i + 1) % 3], w = AX[(i + 2) % 3], pts = []; for (let k = 0; k <= 40; k++) { const a = k / 40 * Math.PI * 2; pts.push(camObj.project(v3.add(c, v3.add(v3.scale(u, Math.cos(a) * R0), v3.scale(w, Math.sin(a) * R0))))); } return { i, e, pts }; }) };
  }
  const nearPoly = (pts, x, y, tol) => { for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i]; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1, u = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1); if (Math.hypot(ax + dx * u - x, ay + dy * u - y) < tol) return true; } return false; };

  // ---------- pointer input ----------
  const pointers = new Map();
  let act = null, gest = null;
  const cpx = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  function viewChanged() {
    if (camView) { const c = S.camAt(scene, time); if (c) Object.assign(cam, JSON.parse(JSON.stringify(c))); camView = false; $('camViewBtn').setAttribute('aria-pressed', 'false'); toast('Back to the free view. 🎥◆ keyframes the camera here.'); }
    scene.view = { target: cam.target.slice(), yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, fov: cam.fov };
    dirty = true; saveSoon();
  }
  const orbitAct = (onTap) => ({ type: 'orbit', moved: false, move(px, py, e, d) { viewChanged(); cam.yaw -= d[0] / dpr * 0.008; cam.pitch = clamp(cam.pitch + d[1] / dpr * 0.008, -1.5, 1.5); }, up() { if (!this.moved && onTap) onTap(); } });
  function panBy(dx, dy) {
    const px = camObj.pxSize(cam.target), e = camObj.eye, f = v3.norm(v3.sub(cam.target, e)), r = v3.norm(v3.cross(f, [0, 1, 0])), u = v3.cross(r, f);
    cam.target = v3.add(cam.target, v3.add(v3.scale(r, -dx * px), v3.scale(u, dy * px)));
  }
  view.addEventListener('pointerdown', e => {
    if (stageOn && stageDown(e)) return;
    const p = cpx(e);
    pointers.set(e.pointerId, { x: p[0], y: p[1], sx: p[0], sy: p[1] });
    try { view.setPointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size >= 2) {
      if (act && act.cancel) act.cancel(); else if (act && act.up) act.up(true);
      act = null;
      const [a, b] = [...pointers.values()];
      gest = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      return;
    }
    if (e.button === 1 || e.button === 2 || e.altKey) { act = e.button === 1 || e.shiftKey ? { type: 'pan', move(px, py, ev, d) { viewChanged(); panBy(d[0], d[1]); } } : orbitAct(); act.last = p; return; }
    act = downFor(p[0], p[1], e) || orbitAct();
    act.last = p; act.start = p;
  });
  view.addEventListener('pointermove', e => {
    const p = cpx(e), pt = pointers.get(e.pointerId);
    if (stageOn && stageMove(e)) return;
    if (!pt) { if (e.pointerType === 'mouse') { hover = p; if (mode === 'sculpt' || mode === 'rig') dirty = true; } return; }
    pt.x = p[0]; pt.y = p[1];
    if (gest && pointers.size >= 2) {
      const [a, b] = [...pointers.values()], cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      viewChanged(); panBy(cx - gest.cx, cy - gest.cy); cam.dist = clamp(cam.dist * gest.d / d, 0.2, 200);
      gest.cx = cx; gest.cy = cy; gest.d = d;
      return;
    }
    if (!act) return;
    const d = [p[0] - act.last[0], p[1] - act.last[1]];
    if (!act.moved && Math.hypot(p[0] - act.start[0], p[1] - act.start[1]) < 6 * dpr) return;
    act.moved = true;
    if (e.pointerType !== 'mouse' || mode === 'sculpt') hover = p;
    act.move(p[0], p[1], e, d);
    act.last = p;
    dirty = true;
  });
  const endPtr = e => {
    if (stageOn && stageUp(e)) return;
    pointers.delete(e.pointerId);
    if (gest) { if (pointers.size < 2) gest = null; if (!pointers.size) act = null; return; }
    if (act) { const a = act; act = null; if (a.up) a.up(false); }
    if (e.pointerType !== 'mouse') hover = null;
    dirty = true;
  };
  view.addEventListener('pointerup', endPtr);
  view.addEventListener('pointercancel', endPtr);
  view.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pointers.size) { hover = null; dirty = true; } });
  view.addEventListener('contextmenu', e => e.preventDefault());
  view.addEventListener('wheel', e => { e.preventDefault(); viewChanged(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 0.2, 200); }, { passive: false });
  view.addEventListener('dblclick', () => frameSel());

  function selectObj(id) {
    if (sel === id) return;
    sel = id; selBone = null; rigChain = null;
    renderTools(); renderTimeline(); refreshSheet(); updKeyBtn(); dirty = true;
  }
  // what a one-finger press does, by mode
  function downFor(px, py, e) {
    if (playing && mode !== 'stage') setPlaying(false);
    const o = selObj();
    if (mode === 'sculpt') {
      const hit = o && pick(px, py, o.id);
      if (hit) return strokeAct(hit, px, py, e);
      return orbitAct(() => { const h2 = pick(px, py); if (h2) { selectObj(h2.o.id); toast('Selected ' + h2.o.name + '. Sculpt away.'); } });
    }
    if (mode === 'objects') {
      if (o) { const g = gizmoAct(o, px, py); if (g) return g; }
      const hit = pick(px, py);
      if (hit && hit.o.id === (o && o.id)) return dragObjAct(hit.o, px, py);
      return orbitAct(() => selectObj(hit ? hit.o.id : null));
    }
    if (mode === 'rig') {
      if (!o) return orbitAct(() => { const h2 = pick(px, py); if (h2) selectObj(h2.o.id); });
      const j = jointAt(o, px, py);
      if (j && weightMode) return orbitAct(() => { selBone = j.b.id; renderTools(); dirty = true; toast('Painting weights for ' + j.b.name); });
      if (j) return jointDragAct(o, j);
      if (weightMode) {
        const hit = pick(px, py, o.id);
        if (hit && selBone) return strokeAct(hit, px, py, e);
        if (hit) return orbitAct(() => toast('Tap a bone’s joint first, then paint'));
      }
      const hit = pick(px, py, o.id);
      return orbitAct(() => { if (hit) addJoint(o, hit, px, py); else { const h2 = pick(px, py); if (h2 && h2.o.id !== o.id) selectObj(h2.o.id); } });
    }
    if (mode === 'pose') {
      if (o && o.bones.length) {
        const j = jointAt(o, px, py);
        if (j) return poseDragAct(o, j, px, py);
        const r = selBone && ringAct(o, px, py);
        if (r) return r;
      }
      return orbitAct(() => { const h2 = pick(px, py); selectObj(h2 ? h2.o.id : null); if (h2 && !h2.o.bones.length) toast(h2.o.name + ' has no bones yet: add them in Rig'); });
    }
    return null;
  }
  function frameSel() {
    const o = selObj();
    if (!o || !MESH.get(o.id)) { cam.target = [0, 0.8, 0]; cam.dist = 5; viewChanged(); return; }
    const b = boundsOf(MESH.get(o.id)), Wm = worldOf(o), c = m4.point(Wm, b.c), s = Math.hypot(Wm[0], Wm[1], Wm[2]);
    cam.target = c; cam.dist = clamp(b.r * s * 3.2, 0.5, 100); viewChanged();
  }

  // ---------- sculpting ----------
  let hintedSub = false;
  const symAxis = () => brush.symAxis == null ? (brush.sym === false ? -1 : 0) : brush.symAxis;
  const symX = () => symAxis() === 0;
  // triangles near a point (for quick ray casts while a stroke moves along)
  function trisNear(m, P, r, seed) {
    const g = SC.gather(m, P, r, seed), T = new Set();
    for (let k = 0; k < g.length; k += 2) { const v = g[k]; for (let j = m.vtStart[v]; j < m.vtStart[v + 1]; j++) T.add(m.vt[j]); }
    return [...T];
  }
  // dynamic detail: after (and during long) strokes, split stretched edges where the brush went
  function refineAround(o, M, verts, rL) {
    if (!brush.detail || !verts.size) return false;
    const maxLen = rL * ({ fine: 0.12, medium: 0.2, coarse: 0.32 }[brush.detailLevel || 'medium']);
    const all = new Set(verts); for (const v of verts) for (let k = M.m.nbStart[v]; k < M.m.nbStart[v + 1]; k++) all.add(M.m.nb[k]);
    const ids = Object.keys(M.morphs);
    const r = MESHLIB.refine(M.m, all, maxLen, ids.map(id => M.morphs[id]), M.skin, 400000);
    if (!r) return false;
    M.m = r.m; ids.forEach((id, i) => { M.morphs[id] = r.extras[i]; }); if (M.skin) M.skin = r.skin;
    if (shapeEdit && shapeEdit.id === o.id && shapeEdit.base) {
      // keep the shape-key base in step: the base gets the same split
      shapeEdit.base = null;
    }
    R.drop(o.id);
    return true;
  }
  function strokeAct(hit, px, py, e0) {
    const o = hit.o, M = hit.M;
    pushUndo(snapMesh(o.id));
    const sc = (Math.hypot(hit.Wm[0], hit.Wm[1], hit.Wm[2]) + Math.hypot(hit.Wm[4], hit.Wm[5], hit.Wm[6]) + Math.hypot(hit.Wm[8], hit.Wm[9], hit.Wm[10])) / 3;
    const rpx = brush.radius * dpr, rL0 = rpx * camObj.pxSize(hit.wp) / sc;
    const touched = new Set(), changedV = new Set();
    const col = S.hex(brush.color);
    const tool = weightMode ? 'weights' : brush.tool, ax = symAxis();
    const pen = e => e && e.pointerType === 'pen' ? clamp(e.pressure || 0.5, 0.05, 1) : 1;
    let pr = pen(e0);
    const rad = () => rL0 * (brush.prSize && pr < 1 ? 0.25 + 0.75 * pr : 1);
    const str = () => brush.strength * (brush.prStr ? pr : 1);
    const mirOn = p => ax >= 0 && Math.abs(p[ax]) > rad() * 0.05;
    const skinBone = () => M.skin ? M.skin.bones.indexOf(selBone) : -1;
    const dabAt = (p, n, seed) => {
      const m = M.m, r = rad();
      if (tool === 'weights') {
        const bi = skinBone(); if (bi < 0) return;
        SC.weightDab(m, M.skin, p, r, seed, bi, (brush.invert ? -1 : 1) * str() * 0.6, brush.wSmooth).forEach(i => changedV.add(i));
        if (mirOn(p)) { const mb = o.bones.find(b => b.id === selBone), twin = mb && mb.mirror ? M.skin.bones.indexOf(mb.mirror) : bi; if (twin >= 0) SC.weightDab(m, M.skin, SC.mir(p, ax), r, null, twin, (brush.invert ? -1 : 1) * str() * 0.6, brush.wSmooth).forEach(i => changedV.add(i)); }
        M.skin.painted = true; M.skin.ver = (M.skin.ver || 0) + 1;
        return;
      }
      SC.dab(m, { tool, P: p, N: n, seed, r, s: str(), invert: brush.invert, color: col }).forEach(i => changedV.add(i));
      if (mirOn(p)) SC.dab(m, { tool, P: SC.mir(p, ax), N: SC.mir(n, ax), r, s: str(), invert: brush.invert, color: col }).forEach(i => changedV.add(i));
    };
    const flush = () => {
      if (!changedV.size) return;
      const m = M.m;
      for (const v of changedV) touched.add(v);
      if (tool === 'mask' || tool === 'paint' || tool === 'weights') { changedV.clear(); dirty = true; return; }
      const all = new Set(changedV);
      for (const v of changedV) for (let k = m.nbStart[v]; k < m.nbStart[v + 1]; k++) all.add(m.nb[k]);
      MESHLIB.normals(m, all);
      m.ver++; changedV.clear(); dirty = true;
    };
    const finish = () => {
      const m0 = M.m;
      if (tool === 'mask' || tool === 'paint') m0.cver = (m0.cver || 0) + 1;
      else if (tool !== 'weights') {
        MESHLIB.normals(m0);
        if (tool !== 'smooth' && refineAround(o, M, touched, rad()) && M.m.idx.length / 3 > 250000) toast('Lots of detail now: Remesh can even it out');
        M.m.ver++;
      }
      changed({ tl: false });
    };
    if (tool === 'move') {
      const m = M.m, grab = SC.grabStart(m, hit.hit.p, rad(), hit.hit.v, ax >= 0 ? ax : null);
      const n = v3.norm(v3.sub(camObj.eye, hit.wp)), p0 = hit.wp;
      return {
        type: 'stroke', move(x, y) {
          const r = camObj.ray(x, y), dn = v3.dot(r.d, n); if (Math.abs(dn) < 1e-6) return;
          const wp = v3.add(r.o, v3.scale(r.d, v3.dot(v3.sub(p0, r.o), n) / dn));
          SC.grabMove(m, grab, m4.dir(hit.Wi, v3.sub(wp, p0))).forEach(i => changedV.add(i));
          flush();
        },
        up() {
          MESHLIB.normals(m);
          SC.relax(m, grab.idx, grab.idx.map((_, k) => Math.max(grab.w[k * 2], grab.w[k * 2 + 1])), 3);
          finish();
        }
      };
    }
    if (tool === 'snake') {
      // the tip slides on a plane facing the camera; each step drags the region at the tip
      let tip = hit.hit.p.slice(), tipW = hit.wp, mtip = ax >= 0 ? SC.mir(tip, ax) : null, lastRefine = performance.now();
      const n = v3.norm(v3.sub(camObj.eye, hit.wp));
      return {
        type: 'stroke', move(x, y, e) {
          pr = pen(e);
          const r = camObj.ray(x, y), dn = v3.dot(r.d, n); if (Math.abs(dn) < 1e-6) return;
          const wp = v3.add(r.o, v3.scale(r.d, v3.dot(v3.sub(tipW, r.o), n) / dn));
          const dl = m4.dir(hit.Wi, v3.sub(wp, tipW));
          const steps = Math.max(1, Math.ceil(v3.len(dl) / (rad() * 0.25)));
          for (let k = 0; k < steps; k++) {
            const d = v3.scale(dl, 1 / steps);
            SC.snakeStep(M.m, tip, rad(), d, null).forEach(i => changedV.add(i));
            tip = v3.add(tip, d);
            if (mtip) { const md = SC.mir(d, ax); SC.snakeStep(M.m, mtip, rad(), md, null).forEach(i => changedV.add(i)); mtip = v3.add(mtip, md); }
          }
          tipW = wp;
          flush();
          // keep the pulled part from thinning into long slivers
          if (performance.now() - lastRefine > 140) { lastRefine = performance.now(); const tv = new Set(touched); if (refineAround(o, M, tv, rad())) { touched.clear(); } dirty = true; }
        },
        up() { SC.relax(M.m, [...touched].filter(v => v < M.m.pos.length / 3), null, 1); finish(); }
      };
    }
    dabAt(hit.hit.p, hit.hit.n, hit.hit.v); flush();
    if (!hintedSub && !brush.detail && tool !== 'smooth' && tool !== 'mask' && tool !== 'paint' && tool !== 'weights' && M.m.pos.length / 3 < 3000) { hintedSub = true; toast('Low detail: tap Subdivide, or turn on Dynamic detail in ⚙ Brush'); }
    const spacing = Math.max(2, rpx * 0.22);
    let last = [px, py], near = trisNear(M.m, hit.hit.p, rad() * 3, hit.hit.v), nearAt = hit.hit.p, nearM = M.m;
    return {
      type: 'stroke',
      move(x, y, e) {
        pr = pen(e);
        const d = Math.hypot(x - last[0], y - last[1]);
        if (d < spacing) return;
        const n = Math.floor(d / spacing), m = M.m;
        for (let k = 1; k <= n; k++) {
          const sx = last[0] + (x - last[0]) * k / n, sy = last[1] + (y - last[1]) * k / n;
          const r = camObj.ray(sx, sy), lo = m4.point(hit.Wi, r.o), ld = v3.norm(m4.dir(hit.Wi, r.d));
          // look near the last hit first; fall back to the whole mesh
          let h2 = nearM === m ? MESHLIB.raycastTris(m, lo, ld, near) : null;
          if (!h2) h2 = MESHLIB.raycast(m, lo, ld, true);
          if (!h2) continue;
          if (nearM !== m || v3.dist(h2.p, nearAt) > rad() * 1.5) { near = trisNear(m, h2.p, rad() * 3, h2.v); nearAt = h2.p; nearM = m; }
          dabAt(h2.p, h2.n, h2.v);
        }
        last = [x, y];
        flush();
      },
      up() { finish(); }
    };
  }

  // ---------- moving objects: drag on the object, or the gizmo's arrows, rings and outer circle ----------
  const viewN = p => v3.norm(v3.sub(camObj.eye, p));
  function planeHit(px, py, p0, n) { const r = camObj.ray(px, py), dn = v3.dot(r.d, n); if (Math.abs(dn) < 1e-6) return null; return v3.add(r.o, v3.scale(r.d, v3.dot(v3.sub(p0, r.o), n) / dn)); }
  function setWorldPos(o, wp) { const P = parentWorld(o); setChan(o, 'pos', m4.point(m4.inv(P), wp).map(v => round(v, 4))); }
  function dragObjAct(o, px, py) {
    const Wm = worldOf(o), c0 = [Wm[12], Wm[13], Wm[14]], n = viewN(c0), h0 = planeHit(px, py, c0, n);
    let started = false;
    return { type: 'drag', move(x, y) { if (!started) { before(); started = true; } const p = planeHit(x, y, c0, n); if (p && h0) setWorldPos(o, v3.add(c0, v3.sub(p, h0))); changed({ tl: false }); }, up(c) { if (started) changed(); } };
  }
  function gizmoAct(o, px, py) {
    const g = gizmoGeom(o); if (!g) return null;
    const tol = 14 * dpr;
    let hitAxis = null, hitRing = null;
    for (const a of g.axes) if (Math.hypot(a.tip[0] - px, a.tip[1] - py) < tol * 1.3 || nearPoly([[g.cs[0] + (a.tip[0] - g.cs[0]) * 0.35, g.cs[1] + (a.tip[1] - g.cs[1]) * 0.35], a.tip], px, py, tol * 0.8)) { hitAxis = a; break; }
    if (!hitAxis) for (const r of g.rings) if (nearPoly(r.pts, px, py, tol * 0.7)) { hitRing = r; break; }
    const dc = Math.hypot(px - g.cs[0], py - g.cs[1]);
    const onOuter = !hitAxis && !hitRing && Math.abs(dc - g.outer) < tol;
    const onCentre = !hitAxis && !hitRing && dc < tol * 1.2;
    if (!hitAxis && !hitRing && !onOuter && !onCentre) return null;
    before();
    const Wm = worldOf(o), c0 = g.c;
    if (onCentre) return dragObjAct(o, px, py);
    if (hitAxis) {
      const sa = [hitAxis.tip[0] - g.cs[0], hitAxis.tip[1] - g.cs[1]], sl = Math.hypot(sa[0], sa[1]) || 1;
      return { type: 'axis', move(x, y) { const dd = ((x - px) * sa[0] + (y - py) * sa[1]) / sl; setWorldPos(o, v3.add(c0, v3.scale(hitAxis.e, dd / sl * hitAxis.L))); changed({ tl: false }); }, up() { changed(); } };
    }
    if (onOuter) {
      const s0 = getChan(o, 'scl').slice();
      return { type: 'scale', move(x, y) { const f = Math.max(0.02, Math.hypot(x - g.cs[0], y - g.cs[1]) / (dc || 1)); setChan(o, 'scl', s0.map(v => round(v * f, 4))); changed({ tl: false }); }, up() { changed(); } };
    }
    // ring: turn about a world axis
    const r0 = q.fromEuler(getChan(o, 'rot')), pr = decompose(parentWorld(o)).r;
    const facing = v3.dot(hitRing.e, v3.sub(camObj.eye, c0)) > 0 ? 1 : -1;
    const a0 = Math.atan2(-(py - g.cs[1]), px - g.cs[0]);
    return {
      type: 'ring', move(x, y) {
        let da = Math.atan2(-(y - g.cs[1]), x - g.cs[0]) - a0;
        const qw = q.axisAngle(hitRing.e, da * facing);
        const nl = q.mul(q.mul(q.mul(q.inv(pr), qw), pr), r0);
        setChan(o, 'rot', q.toEuler(nl).map(v => round(v, 2)));
        changed({ tl: false });
      }, up() { changed(); }
    };
  }

  // ---------- rigging: tap inside a limb to drop joints ----------
  function jointAt(o, px, py) {
    if (!lastEval) return null;
    let best = null;
    for (const p of bonePts(o, lastEval)) {
      const dt = Math.hypot(p.t[0] - px, p.t[1] - py), dh = Math.hypot(p.h[0] - px, p.h[1] - py);
      if (dt < 18 * dpr && (!best || dt < best.d)) best = { b: p.b, end: 'tail', d: dt, w: p.tw };
      if (!p.b.parent && dh < 18 * dpr && (!best || dh < best.d)) best = { b: p.b, end: 'head', d: dh, w: p.hw };
    }
    return best;
  }
  function insidePoint(o, hit, px, py) {
    const r = camObj.ray(px, py), lo = m4.point(hit.Wi, r.o), ld = v3.norm(m4.dir(hit.Wi, r.d));
    const ts = MESHLIB.raycastAll(hit.M.m, lo, ld);
    if (ts.length >= 2) return v3.add(lo, v3.scale(ld, (ts[0] + ts[1]) / 2));
    return hit.hit.p;
  }
  const mirrorOf = (o, b) => b && o.bones.find(x => x.id === b.mirror);
  function addJoint(o, hit, px, py) {
    const p = insidePoint(o, hit, px, py).map(v => round(v, 4));
    before();
    if (!rigChain || rigChain.id !== o.id) {
      const par = selBone && o.bones.find(b => b.id === selBone);
      rigChain = { id: o.id, last: par ? par.tail.slice() : null, parent: par ? par.id : null };
    }
    if (!rigChain.last) {
      rigChain.last = p; rigChain.lastW = m4.point(worldOf(o), p);
      toast('Joint placed. Tap further along the limb to make a bone.');
      changed(); return;
    }
    const nb = { id: uid(), name: 'Bone ' + (o.bones.length + 1), parent: rigChain.parent, head: rigChain.last.slice(), tail: p, rot: [0, 0, 0, 1] };
    o.bones.push(nb);
    // mirrored twin for arms and legs
    if (symX() && Math.abs(nb.tail[0]) > 0.03) {
      const par = o.bones.find(b => b.id === nb.parent), mpar = mirrorOf(o, par) || par;
      const mb = { id: uid(), name: nb.name + ' (mirror)', parent: mpar ? mpar.id : null, head: [-nb.head[0], nb.head[1], nb.head[2]], tail: [-nb.tail[0], nb.tail[1], nb.tail[2]], rot: [0, 0, 0, 1], mirror: nb.id };
      if (Math.abs(nb.head[0]) < 0.02) mb.head = nb.head.slice();
      nb.mirror = mb.id; o.bones.push(mb);
    }
    rigChain.last = p; rigChain.parent = nb.id; rigChain.lastW = m4.point(worldOf(o), p);
    selBone = nb.id; o.rigDirty = true;
    changed(); renderTools();
  }
  function jointDragAct(o, j) {
    const W0 = worldOf(o), Wi = m4.inv(W0), n = viewN(j.w);
    const old = (j.end === 'tail' ? j.b.tail : j.b.head).slice();
    let started = false;
    const moveBone = (b, end, p, oldP) => {
      if (end === 'tail') { b.tail = p; o.bones.forEach(c => { if (c.parent === b.id && v3.dist(c.head, oldP) < 1e-3) c.head = p.slice(); }); }
      else b.head = p;
    };
    return {
      type: 'joint', move(x, y) {
        if (!started) { before(); started = true; }
        const w = planeHit(x, y, j.w, n); if (!w) return;
        const p = m4.point(Wi, w).map(v => round(v, 4));
        const prev = (j.end === 'tail' ? j.b.tail : j.b.head).slice();
        moveBone(j.b, j.end, p, prev);
        const mb = symX() && mirrorOf(o, j.b);
        if (mb) { const mp = [-p[0], p[1], p[2]], mprev = (j.end === 'tail' ? mb.tail : mb.head).slice(); moveBone(mb, j.end, mp, mprev); }
        o.rigDirty = true; changed({ tl: false });
      },
      up() {
        if (!started) { selBone = j.b.id; rigChain = { id: o.id, last: j.b.tail.slice(), parent: j.b.id, lastW: m4.point(W0, j.b.tail) }; renderTools(); toast(j.b.name + ': tap inside the mesh to grow a bone from here'); }
        else changed();
        dirty = true;
      }
    };
  }
  function bind(o, quiet) {
    const M = MESH.get(o.id); if (!M || !o.bones.length) return;
    if (o.bones.length > S.MAX_BONES) { toast('Up to ' + S.MAX_BONES + ' bones per mesh'); return; }
    M.skin = S.autoWeights(M.m, o.bones);
    o.rigDirty = false;
    if (!quiet) toast('Bound ' + o.bones.length + ' bones to ' + o.name + '. Try it in Pose.');
    saveSoon();
  }

  // ---------- posing: drag a joint (aim, or IK along the chain), or turn on the rings ----------
  function curPose(o) { const rec = lastEval && lastEval.get(o.id); return new Map(rec ? rec.pose : []); }
  function applyPose(o, pose, ids) { for (const id of ids) setChan(o, 'bone:' + id, q.norm(pose.get(id)).map(v => round(v, 5))); }
  function poseDragAct(o, j, px, py) {
    if (j.end === 'head') { selBone = j.b.id; renderTools(); return dragObjAct(o, px, py); }
    const Wm = worldOf(o), Wi = m4.inv(Wm), n = viewN(j.w);
    let started = false;
    return {
      type: 'pose', move(x, y) {
        if (!started) { before(); started = true; selBone = j.b.id; }
        const w = planeHit(x, y, j.w, n); if (!w) return;
        const target = m4.point(Wi, w), pose = curPose(o);
        let ids;
        if (ik.on && j.b.parent) {
          S.solveIK(o.bones, pose, j.b.id, target, Math.max(1, ik.len));
          ids = []; let b = j.b; while (b && ids.length < ik.len) { ids.push(b.id); b = o.bones.find(x2 => x2.id === b.parent); }
        } else {
          const ps = S.poseBones(o.bones, pose), hd = ps.head.get(j.b.id), tl = ps.tail.get(j.b.id);
          const rw = q.between(v3.norm(v3.sub(tl, hd)), v3.norm(v3.sub(target, hd)));
          const pr = j.b.parent ? decompose(ps.P.get(j.b.parent)).r : [0, 0, 0, 1];
          pose.set(j.b.id, q.norm(q.mul(q.mul(q.mul(q.inv(pr), rw), pr), pose.get(j.b.id) || [0, 0, 0, 1])));
          ids = [j.b.id];
        }
        applyPose(o, pose, ids);
        changed({ tl: false });
      },
      up() { if (!started) { selBone = j.b.id; renderTools(); refreshSheet(); } else changed(); dirty = true; }
    };
  }
  function ringAct(o, px, py) {
    const g = boneRings(o, lastEval); if (!g) return null;
    const r = g.rings.find(rr => nearPoly(rr.pts, px, py, 11 * dpr)); if (!r) return null;
    before();
    const b = o.bones.find(x => x.id === selBone), Wm = worldOf(o);
    const eObj = v3.norm(m4.dir(m4.inv(Wm), r.e));
    const pose0 = curPose(o), ps = S.poseBones(o.bones, pose0);
    const pr = b.parent ? decompose(ps.P.get(b.parent)).r : [0, 0, 0, 1], cur = pose0.get(b.id) || [0, 0, 0, 1];
    const facing = v3.dot(r.e, v3.sub(camObj.eye, g.c)) > 0 ? 1 : -1, a0 = Math.atan2(-(py - g.cs[1]), px - g.cs[0]);
    return {
      type: 'bring', move(x, y) {
        const da = (Math.atan2(-(y - g.cs[1]), x - g.cs[0]) - a0) * facing;
        const ql = q.mul(q.mul(q.inv(pr), q.axisAngle(eObj, da)), pr);
        setChan(o, 'bone:' + b.id, q.norm(q.mul(ql, cur)).map(v => round(v, 5)));
        changed({ tl: false });
      }, up() { changed(); }
    };
  }

  // ---------- small UI helpers ----------
  function tool(icon, label, fn, cls, dis) { const b = h('button', { type: 'button', class: 'tool' + (cls ? ' ' + cls : ''), onclick: fn, title: label }, h('span', { class: 'ti', 'aria-hidden': 'true' }, icon), h('span', { class: 'tlab' }, label)); if (dis) b.disabled = true; return b; }
  const sep = () => h('span', { class: 'tool sep', 'aria-hidden': 'true' });
  const group = (title, ...kids) => h('div', { class: 'grp' }, title ? h('h3', {}, title) : null, ...kids);
  const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
  function stepper(v, step, on, opt) {
    opt = opt || {};
    const i = h('input', { type: 'number', step: String(step), value: String(round(v, 3)), inputmode: 'decimal', 'aria-label': opt.label || '' });
    const fire = nv => { if (opt.min != null) nv = Math.max(opt.min, nv); if (opt.max != null) nv = Math.min(opt.max, nv); i.value = String(round(nv, 3)); on(nv); };
    i.addEventListener('change', () => { const n = parseFloat(i.value); if (isFinite(n)) fire(n); });
    return h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Less', onclick: () => fire((parseFloat(i.value) || 0) - step) }, '−'), i, h('button', { type: 'button', 'aria-label': 'More', onclick: () => fire((parseFloat(i.value) || 0) + step) }, '+'));
  }
  const PALETTE = ['#D9D4CF', '#F2D0A4', '#E8A87C', '#C8553D', '#8E3B46', '#F6E27F', '#8FB996', '#3E8E7E', '#6FA8DC', '#3D5A80', '#9C89B8', '#E6A1C6', '#FFFFFF', '#7A7A85', '#2B2B33'];
  function colorField(v, on) {
    const wrap = h('div', { class: 'swatches' });
    const paint = cur => { wrap.querySelectorAll('.sw').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === String(cur).toLowerCase())); };
    PALETTE.forEach(c => wrap.append(h('button', { type: 'button', class: 'sw', 'data-c': c, style: 'background:' + c, 'aria-label': c, onclick: () => { on(c); paint(c); cust.value = c; } })));
    const cust = h('input', { type: 'color', class: 'sw-custom', value: v || '#ffffff', 'aria-label': 'Any colour' });
    cust.addEventListener('input', () => { on(cust.value); paint(cust.value); });
    wrap.append(cust); paint(v);
    return wrap;
  }
  function selectInput(opts, v, on) { const s = h('select', {}); opts.forEach(([k, l]) => s.append(h('option', { value: k }, l))); s.value = v; s.addEventListener('change', () => on(s.value)); return s; }
  const chk = (label, on, set) => h('label', { class: 'chk' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = !!on; c.addEventListener('change', () => set(c.checked)); return c; })(), h('span', {}, label));
  function ask(msg, yes) {
    return new Promise(res => {
      const d = $('dlg'); d.innerHTML = '';
      d.append(h('p', {}, msg), h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => { d.close(); res(false); } }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: () => { d.close(); res(true); } }, yes || 'OK')));
      d.showModal();
    });
  }
  function askText(msg, val) {
    return new Promise(res => {
      const d = $('dlg'); d.innerHTML = '';
      const i = h('input', { type: 'text', value: val || '' });
      d.append(h('p', {}, msg), i, h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => { d.close(); res(null); } }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: () => { d.close(); res(i.value.trim()); } }, 'OK')));
      d.showModal(); i.focus(); i.select();
    });
  }

  // ---------- modes and tool rows ----------
  const MODE_HINT = { sculpt: 'One finger sculpts the selected object; two fingers move the view.', objects: 'Tap to select, drag it to move, or use the arrows, rings and outer circle.', rig: 'Tap inside a limb to drop joints; each tap after the first adds a bone.', pose: 'Drag a joint to pose. The rings turn the selected bone.', stage: 'Puppet live with a controller or the on-screen sticks.' };
  function setMode(m) {
    if (mode === 'rig' && m !== 'rig') scene.objects.forEach(o => { if (o.rigDirty && o.bones.length) bind(o, true); });
    if (mode === 'stage' && m !== 'stage') exitStage();
    if (shapeEdit && m !== 'sculpt') finishShape();
    mode = m; rigChain = null;
    document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    if (m !== 'rig') weightMode = false;
    updSliders();
    if (m === 'stage') enterStage();
    renderTools(); closeSheet(); banner(); dirty = true;
    toast(MODE_HINT[m], 2200);
  }
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  function banner() {
    const b = $('banner'), o = selObj();
    b.innerHTML = '';
    if (shapeEdit) { const mo = objById(shapeEdit.id).morphs.find(x => x.id === shapeEdit.mid); b.append(h('span', {}, 'Sculpting the shape “' + (mo ? mo.name : '') + '”'), h('button', { type: 'button', class: 'btn primary', onclick: finishShape }, 'Done')); b.hidden = false; return; }
    if (mode === 'rig' && o && o.rigDirty && o.bones.length) { b.append(h('span', {}, 'Bones changed'), h('button', { type: 'button', class: 'btn primary', onclick: () => { bind(o); banner(); } }, 'Bind')); b.hidden = false; return; }
    b.hidden = true;
  }
  function renderTools() {
    const bar = $('tools'); bar.innerHTML = '';
    const o = selObj();
    if (mode === 'sculpt') {
      for (const [k, B] of Object.entries(SC.BRUSHES)) bar.append(tool(B.icon, B.label, () => { brush.tool = k; store.set('clayframe.brush', brush); renderTools(); toast(B.hint, 1600); if (k === 'paint') openSheet('paint'); }, brush.tool === k ? 'active' : ''));
      bar.append(sep(),
        tool('⊞', 'Subdivide', () => subdivide(o), '', !o),
        tool('≋', 'Smooth all', () => { if (!o) return; pushUndo(snapMesh(o.id)); const m = MESH.get(o.id).m; SC.smoothAll(m, 2); MESHLIB.normals(m); m.ver++; changed({ tl: false }); }, '', !o),
        tool('◑', 'Invert mask', () => maskOp(o, 'invert'), '', !o),
        tool('○', 'Clear mask', () => maskOp(o, 'clear'), '', !o),
        tool('◈', 'Remesh', () => openSheet('brush'), '', !o),
        tool('☺', 'Shapes', () => openSheet('shapes'), '', !o),
        tool('◉', 'Look', () => openSheet('look'), '', !o),
        tool('⚙', 'Brush', () => openSheet('brush')));
    } else if (mode === 'objects') {
      bar.append(tool('＋', 'Add', () => openSheet('add')),
        tool('◉', 'Look', () => openSheet('look'), '', !o),
        tool('⤧', 'Transform', () => openSheet('xform'), '', !o),
        tool('☺', 'Shapes', () => openSheet('shapes'), '', !o),
        tool('⛓', 'Parent', () => openSheet('parent'), '', !o),
        tool('⧉', 'Copy', () => dupObj(o), '', !o),
        tool(o && o.visible === false ? '◌' : '◉', o && o.visible === false ? 'Show' : 'Hide', () => { before(); o.visible = o.visible === false; changed(); renderTools(); }, '', !o),
        tool('🗑', 'Delete', () => delObj(o), '', !o),
        sep(),
        tool('⌂', 'Scene', () => openSheet('scene')));
    } else if (mode === 'rig') {
      bar.append(tool('🖌', weightMode ? 'Weights on' : 'Weights', () => setWeightMode(!weightMode), weightMode ? 'active' : '', !o || !o.bones.length));
      if (weightMode) {
        bar.append(tool('≈', brush.wSmooth ? 'Smoothing' : 'Smooth', () => { brush.wSmooth = !brush.wSmooth; store.set('clayframe.brush', brush); renderTools(); }, brush.wSmooth ? 'active' : ''),
          tool('⚭', 'Re-bind', async () => { if (!await ask('Work the weights out again from scratch? Your painted weights are replaced.', 'Re-bind')) return; pushUndo(snapMesh(o.id)); bind(o); dirty = true; }), sep());
      }
      bar.append(tool('＋', 'New chain', () => { setWeightMode(false); selBone = null; rigChain = null; toast('Tap inside the mesh where the chain starts'); renderTools(); dirty = true; }, !selBone && !rigChain && !weightMode ? 'active' : '', !o),
        tool('⚭', 'Bind', () => { bind(o); banner(); }, '', !o || !o.bones.length),
        tool('✎', 'Bones', () => openSheet('bones'), '', !o || !o.bones.length),
        tool('✕', 'Delete bone', () => delBone(o), '', !selBone),
        tool('🗑', 'Clear rig', async () => { if (!o || !o.bones.length) return; if (!await ask('Remove every bone from ' + o.name + '?', 'Remove')) return; before(); o.bones = []; for (const k of Object.keys(o.keys)) if (k.startsWith('bone:')) delete o.keys[k]; MESH.get(o.id).skin = null; selBone = null; rigChain = null; changed(); renderTools(); }, '', !o || !o.bones.length));
    } else if (mode === 'pose') {
      bar.append(tool('⤳', ik.on ? 'IK on' : 'IK off', () => { ik.on = !ik.on; store.set('clayframe.ik', ik); renderTools(); toast(ik.on ? 'IK: dragging a joint bends the bones above it' : 'Aim: dragging a joint turns just that bone'); }, ik.on ? 'active' : ''),
        tool('−', 'Chain ' + ik.len, () => { ik.len = Math.max(1, ik.len - 1); store.set('clayframe.ik', ik); renderTools(); }),
        tool('+', 'Longer', () => { ik.len = Math.min(8, ik.len + 1); store.set('clayframe.ik', ik); renderTools(); }),
        tool('↺', 'Reset bone', () => { if (!o || !selBone) return; before(); setChan(o, 'bone:' + selBone, [0, 0, 0, 1]); changed(); }, '', !selBone),
        tool('⟲', 'Reset pose', () => { if (!o) return; before(); o.bones.forEach(b => setChan(o, 'bone:' + b.id, [0, 0, 0, 1])); changed(); }, '', !o || !o.bones.length),
        tool('⇉', 'Mirror →', () => mirrorPose(o, false), '', !selBone),
        tool('⇄', 'Flip pose', () => mirrorPose(o, true), '', !o || !o.bones.length),
        tool('★', 'Poses', () => openSheet('poses'), '', !o || !o.bones.length),
        tool('↻', 'Cycles', () => openSheet('cycles'), '', !o || !o.bones.length),
        tool('✎', 'Bones', () => openSheet('bones'), '', !o || !o.bones.length),
        tool('☺', 'Shapes', () => openSheet('shapes'), '', !o));
    }
    updKeyBtn(); banner();
  }
  function subdivide(o) {
    if (!o) return;
    const M = MESH.get(o.id), n = M.m.idx.length / 3;
    if (n * 4 > 600000) { toast('That would be over 600,000 triangles, more than a phone handles smoothly'); return; }
    pushUndo(snapMesh(o.id));
    const ids = Object.keys(M.morphs);
    const r = MESHLIB.subdivide(M.m, ids.map(id => M.morphs[id]));
    const morphs = {}; ids.forEach((id, i) => { morphs[id] = r.extras[i]; });
    delete r.extras;
    M.m = r; M.morphs = morphs;
    if (shapeEdit && shapeEdit.id === o.id) shapeEdit.base = null;
    if (M.skin && o.bones.length) bind(o, true);
    R.drop(o.id);
    changed({ tl: false });
    toast((r.idx.length / 3).toLocaleString() + ' triangles');
  }
  function maskOp(o, k) {
    if (!o) return;
    pushUndo(snapMesh(o.id));
    const m = MESH.get(o.id).m;
    for (let i = 0; i < m.mask.length; i++) m.mask[i] = k === 'clear' ? 0 : 1 - m.mask[i];
    m.cver = (m.cver || 0) + 1; changed({ tl: false });
  }
  function dupObj(o) {
    if (!o) return;
    before();
    const fam = [o, ...descendants(o)], ids = new Map(fam.map(x => [x.id, uid()]));
    for (const x of fam) {
      const c = JSON.parse(JSON.stringify(x)); c.id = ids.get(x.id); if (ids.has(c.parent)) c.parent = ids.get(c.parent);
      const M = MESH.get(x.id);
      if (M) { const mm = MESHLIB.clone(M.m); MESH.set(c.id, { m: mm, morphs: Object.fromEntries(Object.entries(M.morphs).map(([k, v]) => [k, v.slice()])), skin: M.skin ? { bi: M.skin.bi.slice(), bw: M.skin.bw.slice(), bones: M.skin.bones.slice() } : null }); }
      if (x === o) { c.name = x.name + ' copy'; c.pos = v3.add(c.pos, [0.6, 0, 0]); if (c.keys.pos) c.keys.pos.forEach(k => { k.v = v3.add(k.v, [0.6, 0, 0]); }); }
      scene.objects.push(c);
    }
    sel = ids.get(o.id); changed(); renderTools(); renderTimeline();
  }
  async function delObj(o) {
    if (!o) return;
    before();
    const gone = [o, ...descendants(o)];
    scene.objects = scene.objects.filter(x => !gone.includes(x));
    gone.forEach(x => { MESH.delete(x.id); R.drop(x.id); });
    sel = null; changed(); renderTools(); renderTimeline(); closeSheet();
    toast('Deleted. Undo with ↶');
  }
  function delBone(o) {
    if (!o || !selBone) return;
    before();
    const kill = new Set([selBone]);
    let grew = true; while (grew) { grew = false; o.bones.forEach(b => { if (b.parent && kill.has(b.parent) && !kill.has(b.id)) { kill.add(b.id); grew = true; } }); }
    o.bones.forEach(b => { if (kill.has(b.mirror)) delete b.mirror; });
    o.bones = o.bones.filter(b => !kill.has(b.id));
    for (const id of kill) delete o.keys['bone:' + id];
    scene.objects.forEach(c => { if (c.parent === o.id && kill.has(c.parentBone)) c.parentBone = null; });
    selBone = null; rigChain = null; o.rigDirty = true;
    changed(); renderTools();
  }

  // ---------- shape keys ----------
  function startShape(o, mid) {
    const M = MESH.get(o.id);
    if (shapeEdit) finishShape();
    if (mode !== 'sculpt') setMode('sculpt');
    pushUndo(snapMesh(o.id));
    const base = M.m.pos.slice(), d = M.morphs[mid];
    if (d) for (let i = 0; i < base.length; i++) M.m.pos[i] = base[i] + d[i];
    shapeEdit = { id: o.id, mid, base };
    MESHLIB.normals(M.m); M.m.ver++;
    sel = o.id; closeSheet(); banner(); renderTools(); dirty = true;
    toast('Sculpt the change. Tap Done when finished.');
  }
  function finishShape() {
    const se = shapeEdit; if (!se) return;
    shapeEdit = null;
    const M = MESH.get(se.id); if (!M) return;
    if (se.base && se.base.length === M.m.pos.length) {
      const d = new Float32Array(M.m.pos.length);
      for (let i = 0; i < d.length; i++) d[i] = M.m.pos[i] - se.base[i];
      M.morphs[se.mid] = d;
      M.m.pos.set(se.base);
    }
    MESHLIB.normals(M.m); M.m.ver++;
    banner(); changed(); dirty = true;
    toast('Shape saved. Set its amount (and keyframe it) in Shapes.');
  }

  // ---------- panels ----------
  let sheetKind = null;
  function openSheet(k) { sheetKind = k; $('sheet').hidden = false; document.body.classList.add('docked'); renderSheet(); resize(); }
  function closeSheet() { sheetKind = null; $('sheet').hidden = true; document.body.classList.remove('docked'); resize(); }
  $('sheetClose').addEventListener('click', closeSheet);
  function refreshSheet() { if (sheetKind) renderSheet(); }
  function renderSheet() {
    const body = $('sheetBody'), title = $('sheetTitle'), o = selObj(), k = sheetKind;
    body.innerHTML = '';
    const need = () => { body.append(h('p', { class: 'muted' }, 'Select an object first.')); };
    if (k === 'add') { title.textContent = 'Add'; addSheet(body); }
    else if (k === 'scene') { title.textContent = 'Scene'; sceneSheet(body); }
    else if (k === 'paint') { title.textContent = 'Paint colour'; body.append(colorField(brush.color, v => { brush.color = v; store.set('clayframe.brush', brush); }), h('p', { class: 'muted small' }, 'Strength sets how much colour each dab lays down. Mask protects areas.')); }
    else if (k === 'ease') { title.textContent = 'Keyframe easing'; easeSheet(body); }
    else if (k === 'stagemap') { title.textContent = 'Controls'; stageMapSheet(body); }
    else if (k === 'takes') { title.textContent = 'Takes'; takesSheet(body); }
    else if (k === 'brush') { title.textContent = 'Brush & detail'; brushSheet(body); }
    else if (!o) { title.textContent = ''; need(); }
    else if (k === 'look') { title.textContent = 'Look'; lookSheet(body, o); }
    else if (k === 'xform') { title.textContent = 'Transform'; xformSheet(body, o); }
    else if (k === 'shapes') { title.textContent = 'Shapes'; shapesSheet(body, o); }
    else if (k === 'parent') { title.textContent = 'Parent'; parentSheet(body, o); }
    else if (k === 'bones') { title.textContent = 'Bones'; bonesSheet(body, o); }
    else if (k === 'poses') { title.textContent = 'Poses'; posesSheet(body, o); }
    else if (k === 'cycles') { title.textContent = 'Cycles'; cyclesSheet(body, o); }
    else if (k === 'graph') { title.textContent = 'Curves'; graphSheet(body, o); }
  }
  function addSheet(body) {
    const g = h('div', { class: 'grid4' });
    const ICON = { sphere: '●', cube: '■', cylinder: '▮', capsule: '⬮', cone: '▲', torus: '◎', plane: '▬' };
    for (const [k, p] of Object.entries(MESHLIB.PRIMS)) g.append(h('button', { type: 'button', class: 'tile', onclick: () => addPrim(k) }, h('span', { class: 'ic' }, ICON[k] || '●'), p.label));
    g.append(h('button', { type: 'button', class: 'tile', onclick: importOBJ }, h('span', { class: 'ic' }, '⤒'), 'OBJ file…'));
    body.append(g, h('p', { class: 'muted small' }, 'New shapes start at the middle of the floor. Shapes made of smaller triangles sculpt more finely; Subdivide adds more.'));
  }
  function lookSheet(body, o) {
    const set = (k, v) => { before(); o[k] = v; changed(); };
    body.append(field('Colour', colorField(getChan(o, 'color'), v => { before(); setChan(o, 'color', v); changed(); })));
    const g = h('div', { class: 'grid4' });
    for (const [k, mc] of Object.entries(RND.MATCAPS)) { const c = RND.matcapPreview(k, 48); g.append(h('button', { type: 'button', class: 'tile' + (o.matcap === k ? ' on' : ''), onclick: () => { set('matcap', k); refreshSheet(); } }, c, mc.label)); }
    body.append(field('Material', g));
    body.append(chk('Flat shading (low-poly look)', o.flat, v => set('flat', v)));
    body.append(h('p', { class: 'muted small' }, 'Colour can be keyframed: turn on ● auto-key (or press ◇) and pick a new colour at another time.'));
  }
  function vecRow(label, v, step, on) {
    const ins = v.map((x, i) => { const inp = h('input', { type: 'number', step: String(step), value: String(round(x, 3)), 'aria-label': label + ' ' + 'xyz'[i] }); inp.addEventListener('change', () => { const nv = ins.map(e => parseFloat(e.value) || 0); on(nv); }); return inp; });
    return field(label, h('div', { class: 'vec' }, ...ins.map((e, i) => h('label', {}, e, 'XYZ'[i]))));
  }
  function xformSheet(body, o) {
    const mk = (ch, label, step) => h('div', { class: 'row', style: 'align-items:flex-end;flex-wrap:nowrap' }, h('div', { style: 'flex:1' }, vecRow(label, getChan(o, ch), step, v => { before(); setChan(o, ch, v); changed(); })), keyToggle(o, ch));
    body.append(field('Name', (() => { const i = h('input', { type: 'text', value: o.name }); i.addEventListener('change', () => { before(); o.name = i.value.trim() || o.name; changed(); renderTimeline(); fillProjects(); }); return i; })()));
    body.append(mk('pos', 'Position', 0.1), mk('rot', 'Rotation (°)', 15), mk('scl', 'Size', 0.1));
    body.append(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => { before(); setChan(o, 'rot', [0, 0, 0]); changed(); refreshSheet(); } }, 'Reset turn'),
      h('button', { type: 'button', class: 'btn', onclick: () => { before(); setChan(o, 'scl', [1, 1, 1]); changed(); refreshSheet(); } }, 'Reset size'),
      h('button', { type: 'button', class: 'btn', onclick: () => dropToFloor(o) }, 'Drop to floor')));
  }
  function keyToggle(o, ch) {
    const k = o.keys[ch] || [], here = k.some(x => Math.abs(x.t - time) < 1e-3);
    return h('button', { type: 'button', class: 'keybtn' + (here ? ' on' : k.length ? ' some' : ''), title: 'Keyframe here', onclick: () => {
      before();
      if (here) { o.keys[ch] = k.filter(x => Math.abs(x.t - time) >= 1e-3); if (!o.keys[ch].length) delete o.keys[ch]; }
      else S.setKey(o.keys, ch, round(time, 3), getChan(o, ch));
      changed(); renderTimeline(); refreshSheet();
    } }, here ? '◆' : '◇');
  }
  function dropToFloor(o) {
    const M = MESH.get(o.id); if (!M) return;
    const Wm = worldOf(o), p = M.m.pos;
    let lo = Infinity; for (let i = 0; i < p.length; i += 3) lo = Math.min(lo, m4.point(Wm, [p[i], p[i + 1], p[i + 2]])[1]);
    before(); const P = getChan(o, 'pos'); setChan(o, 'pos', [P[0], round(P[1] - lo, 4), P[2]]); changed(); refreshSheet();
  }
  function shapesSheet(body, o) {
    const M = MESH.get(o.id);
    if (!M) { body.append(h('p', { class: 'muted' }, 'Only sculpted objects have shapes.')); return; }
    body.append(h('p', { class: 'muted small' }, 'A shape is a sculpted change you can dial in and out: a smile, a blink, a squash. Sculpt it once, then set or keyframe how much of it shows.' + (mode === 'sculpt' ? ' (Amounts show outside Sculpt mode.)' : '')));
    const list = h('div', { class: 'list' });
    for (const mo of o.morphs) {
      const name = h('input', { type: 'text', value: mo.name, 'aria-label': 'Shape name' });
      name.addEventListener('change', () => { before(); mo.name = name.value.trim() || mo.name; changed(); });
      list.append(h('div', { class: 'li' + (shapeEdit && shapeEdit.mid === mo.id ? ' on' : '') }, h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:6px;min-width:0' }, name,
        h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(getChan(o, 'morph:' + mo.id)), style: 'flex:1;accent-color:var(--accent)', 'aria-label': mo.name + ' amount', oninput: e => { setChan(o, 'morph:' + mo.id, +e.target.value); changed({ tl: false }); }, onchange: () => { renderTimeline(); refreshSheet(); } }), keyToggle(o, 'morph:' + mo.id))),
        h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('button', { type: 'button', class: 'btn', onclick: () => startShape(o, mo.id) }, 'Sculpt'),
          h('button', { type: 'button', class: 'btn quiet danger', onclick: () => { before(); o.morphs = o.morphs.filter(x => x !== mo); delete M.morphs[mo.id]; delete o.keys['morph:' + mo.id]; changed(); refreshSheet(); } }, 'Delete'))));
    }
    body.append(list, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => { before(); const mo = { id: uid(), name: 'Shape ' + (o.morphs.length + 1), w: 0 }; o.morphs.push(mo); M.morphs[mo.id] = new Float32Array(M.m.pos.length); startShape(o, mo.id); } }, '＋ New shape')));
  }
  function parentSheet(body, o) {
    const desc = new Set(descendants(o).map(x => x.id));
    const cands = scene.objects.filter(x => x !== o && !desc.has(x.id));
    body.append(h('p', { class: 'muted small' }, 'A child moves, turns and sizes with its parent. Attach it to one of the parent’s bones and it follows that bone, like a hat on a head.'));
    body.append(field('Parent', selectInput([['', '— none —'], ...cands.map(x => [x.id, x.name])], o.parent || '', v => reparent(o, v || null, null))));
    const par = o.parent && objById(o.parent);
    if (par && par.bones.length) body.append(field('Follow a bone', selectInput([['', '— the whole object —'], ...par.bones.map(b => [b.id, b.name])], o.parentBone || '', v => reparent(o, o.parent, v || null))));
  }
  // keep the object where it is on screen when its parent changes
  function reparent(o, pid, bone) {
    before();
    const Wold = worldOf(o);
    o.parent = pid; o.parentBone = bone;
    const ev = S.evaluate(scene, time, { rest: restMode() }); lastEval = ev;
    const P = parentWorld(o), L = m4.mul(m4.inv(P), Wold), d = decompose(L);
    o.pos = d.t.map(v => round(v, 4)); o.rot = q.toEuler(d.r).map(v => round(v, 2)); o.scl = d.s.map(v => round(v, 4));
    delete o.keys.pos; delete o.keys.rot; delete o.keys.scl;
    changed(); renderTimeline(); refreshSheet();
    if (Object.keys(o.keys).length) toast('Its move, turn and size keyframes were cleared, since they belonged to the old parent');
  }
  function bonesSheet(body, o) {
    const list = h('div', { class: 'list' });
    const depth = b => { let d = 0, p = b; while (p && p.parent && d < 20) { p = o.bones.find(x => x.id === p.parent); d++; } return d; };
    for (const b of S.boneOrder(o.bones)) {
      const name = h('input', { type: 'text', value: b.name, 'aria-label': 'Bone name' });
      name.addEventListener('change', () => { before(); b.name = name.value.trim() || b.name; changed(); renderTimeline(); });
      list.append(h('div', { class: 'li' + (b.id === selBone ? ' on' : ''), style: 'margin-left:' + depth(b) * 12 + 'px' }, h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Select ' + b.name, onclick: () => { selBone = b.id; renderTools(); refreshSheet(); dirty = true; } }, b.id === selBone ? '◉' : '○'), name, mode === 'pose' ? keyToggle(o, 'bone:' + b.id) : null));
    }
    body.append(h('p', { class: 'muted small' }, 'Names help in the timeline and in Stage mode, where a bone called “head” is steered by the right stick.'), list);
  }
  function sceneSheet(body) {
    body.append(field('Name', (() => { const i = h('input', { type: 'text', value: scene.name }); i.addEventListener('change', () => { before(); scene.name = i.value.trim() || scene.name; changed(); saveNow().then(fillProjects); }); return i; })()));
    body.append(h('div', { class: 'two' },
      field('Length (seconds)', stepper(scene.duration, 1, v => { before(); scene.duration = Math.max(1, Math.round(v)); changed(); renderTimeline(); $('dur').textContent = scene.duration; }, { min: 1, max: 600 })),
      field('Video shape', selectInput([['16:9', '16:9 wide'], ['9:16', '9:16 tall'], ['1:1', '1:1 square'], ['4:3', '4:3']], scene.aspect || '16:9', v => { before(); scene.aspect = v; changed(); }))));
    body.append(field('Background', colorField(scene.bg || '#24242A', v => { before(); scene.bg = v; changed(); })));
    body.append(chk('Show the floor grid', scene.grid !== false, v => { scene.grid = v; dirty = true; saveSoon(); }));
    body.append(group('Render view (☀)',
      chk('Floor that catches shadows', scene.floor !== false, v => { scene.floor = v; dirty = true; saveSoon(); }),
      field('Floor colour', colorField(scene.floorColor || '#6E655C', v => { scene.floorColor = v; dirty = true; saveSoon(); })),
      field('Sky light colour', colorField(scene.sky || '#BFD0EA', v => { scene.sky = v; dirty = true; saveSoon(); }))));
    body.append(group('Camera', h('p', { class: 'muted small' }, 'Frame a shot, then tap 🎥◆ to keyframe the camera there. 🎥 on the view plays through those camera keys.'),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, (scene.camKeys.length || 'No') + ' camera keyframes'), scene.camKeys.length ? h('button', { type: 'button', class: 'btn quiet danger', onclick: () => { before(); scene.camKeys = []; camView = false; changed(); refreshSheet(); renderTimeline(); } }, 'Remove them') : null)));
  }

  // ---------- view toggles ----------
  function updSliders() { const on = mode === 'sculpt' || (mode === 'rig' && weightMode); $('sliders').hidden = !on; $('subBtn').hidden = !on; }
  function setWeightMode(on) {
    const o = selObj();
    if (on && o && o.bones.length && (!MESH.get(o.id).skin || o.rigDirty)) bind(o, true);
    weightMode = !!on && !!o;
    if (weightMode && !selBone && o && o.bones[0]) selBone = o.bones[0].id;
    updSliders(); renderTools(); dirty = true;
    if (weightMode) toast('Paint how much each bone moves the skin: red = all, blue = none. Tap a joint to pick a bone; − Sub takes weight away.', 3600);
  }
  const togBtn = (id, get, set, msg) => $(id).addEventListener('click', () => { set(!get()); $(id).setAttribute('aria-pressed', String(get())); dirty = true; if (msg) toast(msg(get()), 2200); });
  togBtn('renderBtn', () => renderMode, v => { renderMode = v; }, v => v ? 'Render view: lights, shadows and a floor (Scene sets the colours)' : 'Sculpting view');
  togBtn('wireBtn', () => wireOn, v => { wireOn = v; });
  togBtn('onionBtn', () => onion, v => { onion = v; }, v => v ? 'Onion skin: blue is the keyframe before, green the one after' : 'Onion skin off');
  $('curvesBtn').addEventListener('click', () => { if (!selObj()) { toast('Select something with keyframes first'); return; } openSheet('graph'); });

  // ---------- brush settings, dynamic detail, remesh ----------
  function brushSheet(body) {
    const set = (k, v) => { brush[k] = v; store.set('clayframe.brush', brush); };
    body.append(group('Detail',
      chk('Dynamic detail: add triangles where strokes stretch the surface', brush.detail, v => { set('detail', v); refreshSheet(); }),
      brush.detail ? field('How fine', h('div', { class: 'chips' }, [['fine', 'Fine'], ['medium', 'Medium'], ['coarse', 'Coarse']].map(([k, l]) => h('button', { type: 'button', class: 'pick' + ((brush.detailLevel || 'medium') === k ? ' on' : ''), onclick: () => { set('detailLevel', k); refreshSheet(); } }, l)))) : null,
      h('p', { class: 'muted small' }, 'Detail follows the brush size: a small brush adds finer triangles. Snake hook always adds detail as it pulls.')));
    const o = selObj();
    let res = brush.remeshRes || 96;
    body.append(group('Remesh',
      h('p', { class: 'muted small' }, 'Rebuilds the whole surface with even triangles, merges overlapping parts into one skin, and keeps your sculpted shape. Shapes and paint carry over; bones bind again.'),
      field('Detail (cells across)', stepper(res, 16, v => { res = Math.round(v); set('remeshRes', res); }, { min: 32, max: 220 })),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', disabled: !o || !MESH.get(o && o.id), onclick: () => doRemesh(selObj(), res) }, '◈ Remesh ' + (o ? o.name : '')))));
    body.append(group('Pen',
      chk('Pressing harder makes the brush bigger', brush.prSize, v => set('prSize', v)),
      chk('Pressing harder makes the brush stronger', brush.prStr !== false, v => set('prStr', v)),
      h('p', { class: 'muted small' }, 'For an Apple Pencil or other stylus. Fingers always use the full size and strength.')));
    body.append(group('View', chk('Wireframe', wireOn, v => { wireOn = v; $('wireBtn').setAttribute('aria-pressed', String(v)); dirty = true; })));
  }
  function doRemesh(o, res) {
    if (!o) return;
    const M = MESH.get(o.id); if (!M) return;
    if (shapeEdit) finishShape();
    toast('Remeshing…', 1500);
    setTimeout(() => {
      const t0 = performance.now();
      pushUndo(snapMesh(o.id));
      const ids = Object.keys(M.morphs);
      const r = MESHLIB.remesh(M.m, res, ids.map(id => M.morphs[id]));
      if (!r) { toast('Couldn’t remesh this shape (is it a closed surface?)'); hist.pop(); return; }
      M.m = r.m; ids.forEach((id, i) => { M.morphs[id] = r.extras[i]; });
      if (o.bones.length) bind(o, true); else M.skin = null;
      R.drop(o.id); changed({ tl: false });
      toast('Remeshed: ' + (r.m.idx.length / 3).toLocaleString() + ' even triangles (' + Math.round(performance.now() - t0) + ' ms)');
    }, 30);
  }

  // ---------- mirror and flip poses ----------
  const mirQ = qq => [qq[0], -qq[1], -qq[2], qq[3]];
  function twinOf(o, b) {
    if (b.mirror) return o.bones.find(x => x.id === b.mirror) || null;
    const near = (a, c) => Math.abs(a[0] + c[0]) < 0.03 && Math.abs(a[1] - c[1]) < 0.03 && Math.abs(a[2] - c[2]) < 0.03;
    return o.bones.find(x => x !== b && near(x.head, b.head) && near(x.tail, b.tail)) || null;
  }
  function mirrorPose(o, flip) {
    if (!o || !o.bones.length) return;
    before();
    const pose = curPose(o);
    if (flip) {
      const next = new Map();
      for (const b of o.bones) { const tw = twinOf(o, b) || b; next.set(b.id, mirQ(pose.get(tw.id) || [0, 0, 0, 1])); }
      for (const b of o.bones) setChan(o, 'bone:' + b.id, q.norm(next.get(b.id)).map(v => round(v, 5)));
      toast('Flipped the pose left to right');
    } else {
      const start = o.bones.find(b => b.id === selBone); if (!start) return;
      const set = [start], add = id => o.bones.forEach(c => { if (c.parent === id) { set.push(c); add(c.id); } });
      add(start.id);
      let n = 0;
      for (const b of set) { const tw = twinOf(o, b); if (tw && tw !== b) { setChan(o, 'bone:' + tw.id, q.norm(mirQ(pose.get(b.id) || [0, 0, 0, 1])).map(v => round(v, 5))); n++; } }
      toast(n ? 'Copied to the other side' : 'This bone has no twin on the other side');
    }
    changed();
  }

  // ---------- saved poses ----------
  function posesSheet(body, o) {
    o.poses = o.poses || [];
    body.append(h('p', { class: 'muted small' }, 'Save poses to reuse: apply one at the playhead, or put them on controller buttons in Stage.'));
    const list = h('div', { class: 'list' });
    o.poses.forEach((p, i) => {
      const name = h('input', { type: 'text', value: p.name, 'aria-label': 'Pose name' });
      name.addEventListener('change', () => { p.name = name.value.trim() || p.name; saveSoon(); });
      list.append(h('div', { class: 'li' }, name,
        h('button', { type: 'button', class: 'btn primary', onclick: () => { before(); for (const [id, v] of Object.entries(p.bones)) if (o.bones.some(b => b.id === id)) setChan(o, 'bone:' + id, v); for (const [id, w] of Object.entries(p.morph || {})) if (o.morphs.some(m => m.id === id)) setChan(o, 'morph:' + id, w); changed(); toast('Applied ' + p.name); } }, 'Apply'),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Delete ' + p.name, onclick: () => { before(); o.poses.splice(i, 1); changed(); refreshSheet(); } }, '✕')));
    });
    body.append(list, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      const nm = await askText('Name this pose', 'Pose ' + (o.poses.length + 1)); if (!nm) return;
      const pose = curPose(o), bones = {}, morph = {};
      for (const b of o.bones) bones[b.id] = (pose.get(b.id) || [0, 0, 0, 1]).map(v => round(v, 5));
      for (const mo of o.morphs) morph[mo.id] = round(getChan(o, 'morph:' + mo.id), 3);
      before(); o.poses.push({ id: uid(), name: nm, bones, morph }); changed(); refreshSheet();
    } }, '＋ Save the current pose')));
  }

  // ---------- cycles: walk and idle made from the bones, and looping ----------
  function classifyBones(o) {
    const B = o.bones, by = new Map(B.map(b => [b.id, b]));
    const side = b => Math.sign((b.head[0] + b.tail[0]) / 2) || 0;
    const centre = b => Math.abs(b.head[0]) < 0.06 && Math.abs(b.tail[0]) < 0.06;
    const down = b => b.tail[1] < b.head[1] - 0.6 * Math.abs(b.tail[0] - b.head[0]) && b.tail[1] < b.head[1] - 0.05;
    const flat = b => Math.abs(b.tail[0] - b.head[0]) > Math.abs(b.tail[1] - b.head[1]);
    const isLeg = b => !centre(b) && down(b), isArm = b => !centre(b) && flat(b);
    const legs = B.filter(b => isLeg(b) && !(b.parent && by.has(b.parent) && isLeg(by.get(b.parent))));
    const shins = B.filter(b => isLeg(b) && b.parent && by.has(b.parent) && isLeg(by.get(b.parent)));
    const arms = B.filter(b => isArm(b) && !(b.parent && by.get(b.parent) && isArm(by.get(b.parent))));
    const fore = B.filter(b => isArm(b) && b.parent && by.get(b.parent) && isArm(by.get(b.parent)));
    const spine = B.filter(centre).sort((a, b) => a.head[1] - b.head[1]);
    const head = B.find(b => /head/i.test(b.name)) || spine[spine.length - 1];
    const chest = spine.length > 1 ? spine[spine.length - 2] : null;
    return { legs, shins, arms, fore, spine, head, chest, side };
  }
  const E = e => q.norm(q.fromEuler(e)).map(v => round(v, 5));
  function walkPose(c, ph, amp) {
    const P = new Map();
    for (const b of c.legs) { const s = c.side(b), a = Math.sin(ph + (s > 0 ? 0 : Math.PI)); P.set(b.id, E([-28 * a * amp, 0, 0])); }
    for (const b of c.shins) { const s = c.side(b), k = Math.max(0, Math.sin(ph + (s > 0 ? 0 : Math.PI) - Math.PI / 2)); P.set(b.id, E([40 * k * amp, 0, 0])); }
    for (const b of c.arms) { const s = c.side(b), f = -Math.sin(ph + (s > 0 ? 0 : Math.PI)); P.set(b.id, E([0, -s * 22 * f * amp, -s * 62 * Math.min(1, amp * 2)])); }
    for (const b of c.fore) { const s = c.side(b); P.set(b.id, E([0, -s * 12 * amp, 0])); }
    if (c.chest) P.set(c.chest.id, E([0, 5 * Math.sin(ph) * amp, 0]));
    if (c.head && c.head !== c.chest) P.set(c.head.id, E([0, -4 * Math.sin(ph) * amp, 0]));
    return P;
  }
  function makeCycle(o, kind) {
    const c = classifyBones(o), t0 = round(time, 3), P = kind === 'walk' ? 1 : 2.4;
    if (kind === 'walk' && !c.legs.length) { toast('I couldn’t find legs (bones pointing down, away from the middle)'); return; }
    before();
    const steps = kind === 'walk' ? 4 : 2;
    for (let k = 0; k <= steps; k++) {
      const t = round(t0 + P * k / steps, 3);
      let pose;
      if (kind === 'walk') pose = walkPose(c, k / steps * Math.PI * 2, 1);
      else {
        pose = new Map(); const ph = k / steps * Math.PI * 2;
        if (c.chest) pose.set(c.chest.id, E([3 * Math.sin(ph), 0, 0]));
        if (c.head) pose.set(c.head.id, E([-2 * Math.sin(ph), 0, 3 * Math.sin(ph / 2 + 0.5)]));
        for (const b of c.arms) { const s = c.side(b); pose.set(b.id, E([0, 0, -s * (66 + 3 * Math.sin(ph))])); }
      }
      for (const [id, v] of pose) S.setKey(o.keys, 'bone:' + id, t, v, 'smooth');
    }
    o.repeat = 'loop';
    if (t0 + P > scene.duration) scene.duration = Math.ceil(t0 + P);
    changed(); renderTimeline(); refreshSheet();
    toast((kind === 'walk' ? 'Walk' : 'Idle') + ' cycle made from ' + t0.toFixed(2) + 's, set to repeat');
  }
  function cyclesSheet(body, o) {
    body.append(h('p', { class: 'muted small' }, 'Make a looping cycle from the playhead, worked out from the bones. Then fine-tune it like any keyframes.'));
    body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => makeCycle(o, 'walk') }, '🚶 Walk cycle (1 s)'), h('button', { type: 'button', class: 'btn', onclick: () => makeCycle(o, 'idle') }, '〰 Idle breathing (2.4 s)')));
    body.append(field('After the last keyframe', selectInput([['none', 'Stop'], ['loop', 'Repeat'], ['bounce', 'Back and forth']], o.repeat || 'none', v => { before(); o.repeat = v; changed(); })));
    body.append(h('p', { class: 'muted small' }, 'Repeat loops the object’s whole animation from its first keyframe to its last. In Stage, walking also swings the legs on its own (Controls).'));
  }

  // ---------- curves: keyframe values on a graph ----------
  let graphCh = null, graphKey = null;
  const COMP = ['#F2685B', '#7BD389', '#5B9BFF'];
  function chanVals(o, ch, v) { if (ch.startsWith('bone:')) return q.toEuler(v); if (typeof v === 'number') return [v]; return v.slice(); }
  function fromVals(o, ch, vals, old) { if (ch.startsWith('bone:')) return q.norm(q.fromEuler(vals)).map(x => round(x, 5)); if (typeof old === 'number') return round(vals[0], 4); return vals.map(x => round(x, 4)); }
  function graphSheet(body, o) {
    const chans = chanList(o).filter(([ch]) => (o.keys[ch] || []).length);
    if (!chans.length) { body.append(h('p', { class: 'muted' }, 'No keyframes on ' + o.name + ' yet.')); return; }
    if (!graphCh || !chans.some(c => c[0] === graphCh)) graphCh = chans[0][0];
    body.append(h('div', { class: 'chips' }, chans.map(([ch, l]) => h('button', { type: 'button', class: 'pick' + (ch === graphCh ? ' on' : ''), onclick: () => { graphCh = ch; graphKey = null; refreshSheet(); } }, l))));
    const cv = h('canvas', { class: 'graph', width: 720, height: 360, 'aria-label': 'Keyframe curves: drag a dot to change its time and value' });
    body.append(cv);
    const ks = o.keys[graphCh], D = scene.duration;
    let lo = Infinity, hi = -Infinity;
    const sample = t => chanVals(o, graphCh, getChan(o, graphCh, t));
    for (let i = 0; i <= 120; i++) for (const v of sample(i / 120 * D)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (const k of ks) for (const v of chanVals(o, graphCh, k.v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo < 1e-3) { hi += 1; lo -= 1; }
    const padv = (hi - lo) * 0.15; lo -= padv; hi += padv;
    const Wc = cv.width, Hc = cv.height, L0 = 46, R0 = 14, T0 = 14, B0 = 26;
    const X = t => L0 + t / D * (Wc - L0 - R0), Y = v => T0 + (hi - v) / (hi - lo) * (Hc - T0 - B0);
    const iX = x => (x - L0) / (Wc - L0 - R0) * D, iY = y => hi - (y - T0) / (Hc - T0 - B0) * (hi - lo);
    const paint = () => {
      const x = cv.getContext('2d'); x.clearRect(0, 0, Wc, Hc);
      x.fillStyle = '#101015'; x.fillRect(0, 0, Wc, Hc);
      x.strokeStyle = 'rgba(255,255,255,.08)'; x.lineWidth = 1; x.font = '11px "IBM Plex Mono", monospace'; x.fillStyle = '#9393A6';
      for (let t = 0; t <= D; t += D > 12 ? 2 : 1) { x.beginPath(); x.moveTo(X(t), T0); x.lineTo(X(t), Hc - B0); x.stroke(); x.fillText(t + 's', X(t) - 6, Hc - 8); }
      for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; x.beginPath(); x.moveTo(L0, Y(v)); x.lineTo(Wc - R0, Y(v)); x.stroke(); x.fillText(String(round(v, 2)), 2, Y(v) + 4); }
      x.strokeStyle = '#5BC0FF'; x.beginPath(); x.moveTo(X(time), T0); x.lineTo(X(time), Hc - B0); x.stroke();
      const n = chanVals(o, graphCh, ks[0].v).length;
      for (let c = 0; c < n; c++) {
        x.strokeStyle = n === 1 ? '#F2B35E' : COMP[c]; x.lineWidth = 2; x.beginPath();
        for (let i = 0; i <= 240; i++) { const t = i / 240 * D, v = sample(t)[c]; i ? x.lineTo(X(t), Y(v)) : x.moveTo(X(t), Y(v)); }
        x.stroke();
        for (const k of ks) { const v = chanVals(o, graphCh, k.v)[c]; x.fillStyle = k === graphKey ? '#fff' : (n === 1 ? '#F2B35E' : COMP[c]); x.beginPath(); x.arc(X(k.t), Y(v), k === graphKey ? 8 : 6, 0, 7); x.fill(); }
      }
    };
    paint();
    let drag = null;
    const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * Wc / r.width, (e.clientY - r.top) * Hc / r.height]; };
    cv.addEventListener('pointerdown', e => {
      const [mx, my] = pos(e); let best = null;
      for (const k of ks) chanVals(o, graphCh, k.v).forEach((v, c) => { const d = Math.hypot(X(k.t) - mx, Y(v) - my); if (d < 22 && (!best || d < best.d)) best = { k, c, d }; });
      if (!best) return;
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      before(); graphKey = best.k; drag = { k: best.k, c: best.c, x0: mx, y0: my, moved: false };
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const [mx, my] = pos(e);
      if (!drag.moved && Math.hypot(mx - drag.x0, my - drag.y0) < 5) return;
      drag.moved = true;
      const k = drag.k, vals = chanVals(o, graphCh, k.v);
      vals[drag.c] = iY(my);
      k.v = fromVals(o, graphCh, vals, k.v);
      if (Math.abs(mx - drag.x0) > 8) { const nt = round(clamp(Math.round(iX(mx) * 30) / 30, 0, D), 3); if (!ks.some(x => x !== k && Math.abs(x.t - nt) < 1e-3)) { k.t = nt; ks.sort((a, b) => a.t - b.t); } }
      dirty = true; paint();
    });
    const up = () => { if (!drag) return; const d = drag; drag = null; if (!d.moved) setTime(d.k.t); changed(); renderTimeline(); refreshSheet(); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    if (graphKey && ks.includes(graphKey)) body.append(field('Easing into the ' + graphKey.t.toFixed(2) + 's keyframe', h('div', { class: 'chips' }, EASES.map(([k, l]) => h('button', { type: 'button', class: 'pick' + ((graphKey.ease || 'smooth') === k ? ' on' : ''), onclick: () => { before(); graphKey.ease = k; changed(); refreshSheet(); } }, l)))));
    body.append(h('p', { class: 'muted small' }, 'Drag a dot up or down to change its value, sideways to retime it. Tap one to jump there and set its easing.' + (graphCh.startsWith('bone:') ? ' Bone turns show as X, Y and Z angles.' : '')));
  }

  // ---------- timeline (fixed playhead in the middle; scroll to scrub) ----------
  let pps = 90, tlScroll = null, ignoreScroll = false, rtT = 0;
  const renderTimelineSoon = () => { clearTimeout(rtT); rtT = setTimeout(renderTimeline, 120); };
  function renderTimeline() {
    const tl = $('timeline');
    tl.classList.toggle('closed', !tlOpen);
    if (!scene) return;
    const prevTop = tlScroll ? tlScroll.scrollTop : 0;
    tl.innerHTML = '';
    const sc = h('div', { class: 'tl-scroll' }), half = Math.max(60, (tl.clientWidth || 360) / 2), D = scene.duration;
    const inner = h('div', { class: 'tl-inner', style: 'width:' + (half * 2 + D * pps) + 'px' });
    const X = t => half + t * pps;
    const ruler = h('div', { class: 'tl-ruler' });
    const step = pps > 140 ? 0.5 : pps > 40 ? 1 : 2;
    for (let t = 0; t <= D + 1e-6; t += step) ruler.append(h('div', { class: 'tl-tick', style: 'left:' + X(t) + 'px' }, Number.isInteger(t) ? t + 's' : ''));
    inner.append(ruler, h('div', { class: 'tl-end', style: 'left:' + X(D) + 'px' }));
    const diamond = (row, ch, t) => h('div', { class: 'tl-key' + (Math.abs(t - time) < 1e-3 ? ' at' : ''), style: 'left:' + X(t) + 'px', 'data-row': row, 'data-ch': ch || '', 'data-t': t });
    const span = (ts) => ts.length > 1 ? h('div', { class: 'tl-span', style: 'left:' + X(ts[0]) + 'px;width:' + (ts[ts.length - 1] - ts[0]) * pps + 'px' }) : null;
    if (scene.camKeys.length) {
      const ts = scene.camKeys.map(k => k.t);
      inner.append(h('div', { class: 'tl-row', 'data-sel': '' }, h('span', { class: 'tl-label' }, '🎥 Camera'), span(ts), ...ts.map(t => diamond('cam', '', t))));
    }
    const depth = o => { let d = 0, p = o; while (p && p.parent && d < 10) { p = objById(p.parent); d++; } return d; };
    for (const o of scene.objects) {
      const ts = S.keyTimes(o);
      inner.append(h('div', { class: 'tl-row' + (o.id === sel ? ' sel' : ''), 'data-sel': o.id }, h('span', { class: 'tl-label', style: 'padding-left:' + (8 + depth(o) * 10) + 'px' }, (o.visible === false ? '◌ ' : '') + o.name), span(ts), ...ts.map(t => diamond(o.id, '', t))));
      if (o.id === sel) for (const [ch, label] of chanList(o)) {
        const k = o.keys[ch]; if (!k || !k.length) continue;
        inner.append(h('div', { class: 'tl-row chan', 'data-sel': o.id }, h('span', { class: 'tl-label' }, label), ...k.map(x => diamond(o.id, ch, x.t))));
      }
    }
    if (!scene.objects.length) inner.append(h('div', { class: 'tl-row' }, h('span', { class: 'tl-label' }, 'Add something in Objects → Add')));
    sc.append(inner);
    tl.append(sc, h('div', { class: 'tl-ph' }));
    tlScroll = sc;
    ignoreScroll = true; sc.scrollLeft = time * pps; sc.scrollTop = prevTop;
    requestAnimationFrame(() => { ignoreScroll = false; });
    sc.addEventListener('scroll', () => { if (ignoreScroll || playing) return; setTime(sc.scrollLeft / pps, true); });
    sc.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); pps = clamp(pps * Math.exp(-e.deltaY * 0.004), 20, 400); renderTimeline(); }, { passive: false });
    sc.addEventListener('click', e => { if (e.target.closest('.tl-key')) return; const r = e.target.closest('.tl-row'); if (r && r.dataset.sel && r.dataset.sel !== sel) selectObj(r.dataset.sel); });
    sc.addEventListener('pointerdown', keyDown);
  }
  // drag a keyframe sideways to retime it; tap one to jump there (tap again for its easing)
  function keyDown(e) {
    const k = e.target.closest('.tl-key'); if (!k) return;
    e.preventDefault();
    const row = k.dataset.row, ch = k.dataset.ch, t0 = +k.dataset.t, x0 = e.clientX;
    let moved = false, snapDone = false;
    const move = ev => {
      const dt = (ev.clientX - x0) / pps;
      if (!moved && Math.abs(ev.clientX - x0) < 6) return;
      if (!snapDone) { before(); snapDone = true; }
      moved = true;
      const nt = round(clamp(Math.round((t0 + dt) * 30) / 30, 0, scene.duration), 3);
      k.dataset.nt = nt;
      k.style.transform = 'translateX(' + (nt - t0) * pps + 'px) rotate(45deg) scale(.78)';
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) { if (Math.abs(time - t0) < 1e-3) { if (row !== 'cam') selectObj(row); openSheet('ease'); } else setTime(t0); return; }
      const nt = +k.dataset.nt;
      if (row === 'cam') { const c = scene.camKeys.find(x => Math.abs(x.t - t0) < 1e-3); if (c) { scene.camKeys = scene.camKeys.filter(x => x === c || Math.abs(x.t - nt) >= 1e-3); c.t = nt; scene.camKeys.sort((a, b) => a.t - b.t); } }
      else {
        const o = objById(row); if (o) for (const [c2, list] of Object.entries(o.keys)) {
          if (ch && c2 !== ch) continue;
          const kk = list.find(x => Math.abs(x.t - t0) < 1e-3); if (!kk) continue;
          o.keys[c2] = list.filter(x => x === kk || Math.abs(x.t - nt) >= 1e-3); kk.t = nt; o.keys[c2].sort((a, b) => a.t - b.t);
        }
      }
      changed(); renderTimeline();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  const EASES = [['smooth', 'Smooth'], ['linear', 'Linear'], ['easeIn', 'Ease in'], ['easeOut', 'Ease out'], ['backOut', 'Overshoot'], ['spring', 'Spring'], ['bounce', 'Bounce'], ['elastic', 'Elastic'], ['hold', 'Hold']];
  function easeSheet(body) {
    const o = selObj(), t = round(time, 3);
    const targets = [];
    if (o) for (const [, k] of Object.entries(o.keys)) { const x = k.find(y => Math.abs(y.t - t) < 1e-3); if (x) targets.push(x); }
    const ck = scene.camKeys.find(x => Math.abs(x.t - t) < 1e-3); if (ck) targets.push(ck);
    if (!targets.length) { body.append(h('p', { class: 'muted' }, 'No keyframes at the playhead. Move to a ◆ on the timeline, then tap it.')); return; }
    const cur = targets[0].ease || 'smooth';
    body.append(h('p', { class: 'muted small' }, 'How things move into the keyframes at ' + t.toFixed(2) + 's' + (o ? ' (' + o.name + (ck ? ' and the camera' : '') + ')' : '') + '.'));
    body.append(h('div', { class: 'chips' }, EASES.map(([k, l]) => h('button', { type: 'button', class: 'pick' + (cur === k ? ' on' : ''), onclick: () => { before(); targets.forEach(x => { x.ease = k; }); changed(); refreshSheet(); } }, l))));
    body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn danger', onclick: () => {
      before();
      if (o) for (const ch of Object.keys(o.keys)) { o.keys[ch] = o.keys[ch].filter(x => Math.abs(x.t - t) >= 1e-3); if (!o.keys[ch].length) delete o.keys[ch]; }
      if (ck) scene.camKeys = scene.camKeys.filter(x => x !== ck);
      changed(); renderTimeline(); closeSheet();
    } }, 'Delete these keyframes')));
  }

  // ---------- time and playback ----------
  function setTime(t, fromScroll) {
    time = clamp(t, 0, scene.duration);
    $('time').textContent = time.toFixed(2);
    if (!fromScroll && tlScroll) { ignoreScroll = true; tlScroll.scrollLeft = time * pps; requestAnimationFrame(() => { ignoreScroll = false; }); }
    updKeyBtn(); dirty = true;
    if (!playing && (sheetKind === 'xform' || sheetKind === 'shapes' || sheetKind === 'ease') && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#sheet'))) refreshSheetSoon();
  }
  let rsT = 0; const refreshSheetSoon = () => { clearTimeout(rsT); rsT = setTimeout(refreshSheet, 150); };
  function setPlaying(on) {
    if (on && shapeEdit) finishShape();
    playing = on;
    document.querySelectorAll('.playbtn').forEach(b => { b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); });
    if (on) { if (time >= scene.duration - 0.01) time = 0; playT0 = performance.now() - time * 1000; }
    else { renderTimeline(); updKeyBtn(); }
    dirty = true;
  }
  document.querySelectorAll('.playbtn').forEach(b => b.addEventListener('click', () => setPlaying(!playing)));
  let lastFrame = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
    if (stageOn) stageTick(dt);
    if (playing && !exporting) {
      let t = (now - playT0) / 1000;
      if (t >= scene.duration) { if (stageRec) { stopRecord(); t = scene.duration; } else { t = t % scene.duration; playT0 = now - t * 1000; } }
      time = t; $('time').textContent = time.toFixed(2);
      if (tlScroll) { ignoreScroll = true; tlScroll.scrollLeft = time * pps; ignoreScroll = false; }
      dirty = true;
    }
    if (dirty && scene && !exporting) { draw(stageOn ? stageDrawOpt() : {}); dirty = false; }
    requestAnimationFrame(loop);
  }

  // ---------- camera keys ----------
  function camKey() {
    before();
    const t = round(time, 3), v = { target: cam.target.map(x => round(x, 4)), yaw: round(cam.yaw, 4), pitch: round(cam.pitch, 4), dist: round(cam.dist, 4), fov: cam.fov };
    const ex = scene.camKeys.find(x => Math.abs(x.t - t) < 1e-3);
    if (ex) ex.v = v; else { scene.camKeys.push({ t, v }); scene.camKeys.sort((a, b) => a.t - b.t); }
    changed(); renderTimeline();
    toast('Camera keyframed at ' + t.toFixed(2) + 's. 🎥 on the view plays through the camera keys.');
  }
  $('camKey').addEventListener('click', camKey);
  $('camViewBtn').addEventListener('click', () => {
    if (!scene.camKeys.length) { toast('Frame a shot and tap 🎥◆ to keyframe the camera first'); return; }
    camView = !camView; $('camViewBtn').setAttribute('aria-pressed', String(camView)); dirty = true;
  });
  $('frameBtn').addEventListener('click', frameSel);
  function updSym() { const a = symAxis(); $('symBtn').textContent = a < 0 ? '⇋ off' : '⇋ ' + 'XYZ'[a]; $('symBtn').setAttribute('aria-pressed', String(a >= 0)); }
  $('symBtn').addEventListener('click', () => { const a = symAxis(); brush.symAxis = a === 2 ? -1 : a + 1; store.set('clayframe.brush', brush); updSym(); const n = symAxis(); toast(n < 0 ? 'Mirroring off' : 'Mirroring across ' + 'XYZ'[n] + (n === 0 ? ' (sculpting and new bones)' : ' (sculpting; bones mirror across X only)')); });
  $('subBtn').addEventListener('click', () => { brush.invert = !brush.invert; $('subBtn').setAttribute('aria-pressed', String(brush.invert)); dirty = true; });
  $('radius').addEventListener('input', e => { brush.radius = +e.target.value; store.set('clayframe.brush', brush); hover = hover || [W / 2, H / 2]; dirty = true; });
  $('strength').addEventListener('input', e => { brush.strength = +e.target.value / 100; store.set('clayframe.brush', brush); dirty = true; });
  $('keyBtn').addEventListener('click', toggleKeyAll);
  $('autoKey').addEventListener('click', () => { autoKey = !autoKey; $('autoKey').setAttribute('aria-pressed', String(autoKey)); toast(autoKey ? 'Auto-key on: every move, turn, pose or shape change makes a keyframe at the playhead' : 'Auto-key off'); });
  $('tlToggle').addEventListener('click', () => { tlOpen = !tlOpen; renderTimeline(); resize(); });
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
  window.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === 'k') toggleKeyAll();
    else if (e.key === 'f') frameSel();
    else if (e.key === 'x') $('symBtn').click();
    else if (e.key === '[') { brush.radius = Math.max(8, brush.radius - 6); $('radius').value = brush.radius; dirty = true; }
    else if (e.key === ']') { brush.radius = Math.min(200, brush.radius + 6); $('radius').value = brush.radius; dirty = true; }
  });

  // ---------- posed geometry (for OBJ export) ----------
  function posedPositions(o, rec) {
    const M = MESH.get(o.id), base = S.morphed(M.m, M.morphs, rec.morphW) || M.m.pos, out = new Float32Array(base.length);
    const mats = M.skin && rec.bones ? M.skin.bones.map(id => rec.bones.S.get(id) || m4.id()) : null;
    for (let i = 0; i < base.length / 3; i++) {
      let p = [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];
      if (mats) { let x = 0, y = 0, z = 0; for (let k = 0; k < 4; k++) { const w = M.skin.bw[i * 4 + k]; if (!w) continue; const q2 = m4.point(mats[M.skin.bi[i * 4 + k]] || m4.id(), p); x += q2[0] * w; y += q2[1] * w; z += q2[2] * w; } p = [x, y, z]; }
      p = m4.point(rec.world, p);
      out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
    }
    return out;
  }
  function download(name, blob) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
  const slug = () => (scene.name || 'clayframe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'clayframe';

  // ---------- GLB (glTF 2.0) export: meshes, colours, bones and skin, shapes, and the animation sampled at 30 fps ----------
  function exportGLB() {
    const fps = 30, D = scene.duration, NF = Math.max(2, Math.round(D * fps) + 1);
    const times = new Float32Array(NF); for (let i = 0; i < NF; i++) times[i] = Math.min(D, i / fps);
    const chunks = [], views = [], accessors = [], nodes = [], meshes = [], materials = [], skins = [], channels = [], samplers = [];
    let len = 0;
    const view = (typed, target) => {
      const pad = (4 - len % 4) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
      chunks.push(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength));
      views.push(Object.assign({ buffer: 0, byteOffset: len, byteLength: typed.byteLength }, target ? { target } : {}));
      len += typed.byteLength;
      return views.length - 1;
    };
    const acc = (typed, type, ct, count, target, mm) => {
      const a = { bufferView: view(typed, target), componentType: ct, count, type };
      if (mm) { const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], mn = new Array(n).fill(Infinity), mx = new Array(n).fill(-Infinity); for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) { const v = typed[i * n + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } a.min = mn; a.max = mx; }
      accessors.push(a); return accessors.length - 1;
    };
    const lin = c => S.hex(c).map(v => Math.pow(v, 2.2));
    const tAcc = acc(times, 'SCALAR', 5126, NF, null, true);
    const track = (node, path, data, comps) => { samplers.push({ input: tAcc, output: acc(data, comps === 4 ? 'VEC4' : comps === 3 ? 'VEC3' : 'SCALAR', 5126, data.length / comps), interpolation: 'LINEAR' }); channels.push({ sampler: samplers.length - 1, target: { node, path } }); };
    const nodeOf = new Map(), boneNode = new Map(), roots = [];
    const animated = o => Object.keys(o.keys || {}).length > 0;
    // nodes for objects and their bones
    for (const o of scene.objects) {
      const n = { name: o.name, translation: o.pos.slice(), rotation: q.norm(q.fromEuler(o.rot)), scale: o.scl.slice() };
      nodes.push(n); nodeOf.set(o.id, nodes.length - 1);
    }
    for (const o of scene.objects) {
      const ni = nodeOf.get(o.id), n = nodes[ni];
      const par = o.parent && objById(o.parent);
      if (par && o.parentBone && par.bones.some(b => b.id === o.parentBone)) { /* attached under the bone, later */ }
      else if (par) { const pn = nodes[nodeOf.get(par.id)]; (pn.children = pn.children || []).push(ni); }
      else roots.push(ni);
      for (const b of S.boneOrder(o.bones)) {
        const pb = b.parent && o.bones.find(x => x.id === b.parent);
        nodes.push({ name: o.name + ' · ' + b.name, translation: pb ? v3.sub(b.head, pb.head) : b.head.slice(), rotation: q.norm(b.rot || [0, 0, 0, 1]) });
        const bi = nodes.length - 1; boneNode.set(o.id + ':' + b.id, bi);
        const host = pb ? nodes[boneNode.get(o.id + ':' + pb.id)] : n;
        (host.children = host.children || []).push(bi);
      }
    }
    for (const o of scene.objects) {
      const par = o.parent && objById(o.parent);
      if (!(par && o.parentBone && boneNode.has(par.id + ':' + o.parentBone))) continue;
      const head = par.bones.find(b => b.id === o.parentBone).head, ni = nodeOf.get(o.id);
      nodes[ni].translation = v3.sub(o.pos, head);
      const bn = nodes[boneNode.get(par.id + ':' + o.parentBone)]; (bn.children = bn.children || []).push(ni);
    }
    // meshes
    for (const o of scene.objects) {
      const M = MESH.get(o.id); if (!M) continue;
      const m = M.m, n = m.pos.length / 3, mat = { name: o.name, pbrMetallicRoughness: { baseColorFactor: [...lin(o.color || '#D9D4CF'), 1], metallicFactor: o.matcap === 'metal' ? 1 : 0, roughnessFactor: { glossy: 0.2, metal: 0.3, wax: 0.5 }[o.matcap] || 0.75 }, doubleSided: true };
      materials.push(mat);
      const col = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) col[i] = Math.pow(m.col[i], 2.2);
      const attrs = { POSITION: acc(m.pos, 'VEC3', 5126, n, 34962, true), NORMAL: acc(m.nor, 'VEC3', 5126, n, 34962), COLOR_0: acc(col, 'VEC3', 5126, n, 34962) };
      const skinned = M.skin && o.bones.length && M.skin.bi.length === n * 4;
      if (skinned) {
        const j = new Uint16Array(n * 4), w = new Float32Array(n * 4);
        for (let i = 0; i < n * 4; i++) { j[i] = M.skin.bi[i]; w[i] = M.skin.bw[i]; }
        for (let i = 0; i < n; i++) { const s = w[i * 4] + w[i * 4 + 1] + w[i * 4 + 2] + w[i * 4 + 3]; if (s > 0) for (let k = 0; k < 4; k++) w[i * 4 + k] /= s; else w[i * 4] = 1; }
        attrs.JOINTS_0 = acc(j, 'VEC4', 5123, n, 34962); attrs.WEIGHTS_0 = acc(w, 'VEC4', 5126, n, 34962);
      }
      const prim = { attributes: attrs, indices: acc(m.idx, 'SCALAR', 5125, m.idx.length, 34963), material: materials.length - 1 };
      const shapeIds = (o.morphs || []).filter(mo => M.morphs[mo.id] && M.morphs[mo.id].length === n * 3);
      if (shapeIds.length) prim.targets = shapeIds.map(mo => ({ POSITION: acc(M.morphs[mo.id], 'VEC3', 5126, n, 34962, true) }));
      const mesh = { name: o.name, primitives: [prim] };
      if (shapeIds.length) { mesh.weights = shapeIds.map(mo => mo.w || 0); mesh.extras = { targetNames: shapeIds.map(mo => mo.name) }; }
      meshes.push(mesh);
      let meshNode = nodeOf.get(o.id);
      if (skinned) {
        // skinned meshes sit at the top level with no transform; the joints carry the movement (glTF rule)
        const ibm = new Float32Array(M.skin.bones.length * 16);
        M.skin.bones.forEach((id, k) => { const b = o.bones.find(x => x.id === id); ibm.set(m4.translate(b ? v3.scale(b.head, -1) : [0, 0, 0]), k * 16); });
        skins.push({ joints: M.skin.bones.map(id => boneNode.get(o.id + ':' + id)), inverseBindMatrices: acc(ibm, 'MAT4', 5126, M.skin.bones.length), name: o.name });
        nodes.push({ name: o.name + ' (skin)', mesh: meshes.length - 1, skin: skins.length - 1 });
        meshNode = nodes.length - 1; roots.push(meshNode);
      } else nodes[meshNode].mesh = meshes.length - 1;
      // animation
      if (animated(o) || o.repeat) {
        const K = o.keys, at = i => S.localTime(o, times[i]);
        const headOff = o.parentBone && o.parent ? (objById(o.parent).bones.find(b => b.id === o.parentBone) || { head: [0, 0, 0] }).head : [0, 0, 0];
        if (K.pos) { const d = new Float32Array(NF * 3); for (let i = 0; i < NF; i++) d.set(v3.sub(S.keyVal(K, 'pos', at(i), o.pos), headOff), i * 3); track(nodeOf.get(o.id), 'translation', d, 3); }
        if (K.rot) { const d = new Float32Array(NF * 4); let prev = null; for (let i = 0; i < NF; i++) { let r = q.norm(q.fromEuler(S.keyVal(K, 'rot', at(i), o.rot))); if (prev && prev[0] * r[0] + prev[1] * r[1] + prev[2] * r[2] + prev[3] * r[3] < 0) r = r.map(v => -v); d.set(r, i * 4); prev = r; } track(nodeOf.get(o.id), 'rotation', d, 4); }
        if (K.scl) { const d = new Float32Array(NF * 3); for (let i = 0; i < NF; i++) d.set(S.keyVal(K, 'scl', at(i), o.scl), i * 3); track(nodeOf.get(o.id), 'scale', d, 3); }
        for (const b of o.bones) if (K['bone:' + b.id]) { const d = new Float32Array(NF * 4); let prev = null; for (let i = 0; i < NF; i++) { let r = q.norm(S.keyVal(K, 'bone:' + b.id, at(i), b.rot || [0, 0, 0, 1])); if (prev && prev[0] * r[0] + prev[1] * r[1] + prev[2] * r[2] + prev[3] * r[3] < 0) r = r.map(v => -v); d.set(r, i * 4); prev = r; } track(boneNode.get(o.id + ':' + b.id), 'rotation', d, 4); }
        if (shapeIds.length && shapeIds.some(mo => K['morph:' + mo.id])) { const d = new Float32Array(NF * shapeIds.length); for (let i = 0; i < NF; i++) shapeIds.forEach((mo, k) => { d[i * shapeIds.length + k] = S.keyVal(K, 'morph:' + mo.id, at(i), mo.w || 0); }); samplers.push({ input: tAcc, output: acc(d, 'SCALAR', 5126, d.length), interpolation: 'LINEAR' }); channels.push({ sampler: samplers.length - 1, target: { node: meshNode, path: 'weights' } }); }
      }
    }
    // the shot camera
    const cameras = [];
    if (scene.camKeys.length) {
      const [aw, ah] = String(scene.aspect || '16:9').split(':').map(Number);
      const c0 = S.camAt(scene, 0);
      cameras.push({ type: 'perspective', name: 'Shot camera', perspective: { yfov: (c0.fov || 40) * Math.PI / 180, aspectRatio: aw / ah, znear: 0.05, zfar: 500 } });
      const pose = t => { const c = S.camAt(scene, t), cm = RND.camera(c, aw, ah), d = decompose(m4.inv(cm.view)); return d; };
      const d0 = pose(0);
      nodes.push({ name: 'Shot camera', camera: 0, translation: d0.t, rotation: d0.r }); const ci = nodes.length - 1; roots.push(ci);
      const T = new Float32Array(NF * 3), Rq = new Float32Array(NF * 4); let prev = null;
      for (let i = 0; i < NF; i++) { const d = pose(times[i]); T.set(d.t, i * 3); let r = d.r; if (prev && prev[0] * r[0] + prev[1] * r[1] + prev[2] * r[2] + prev[3] * r[3] < 0) r = r.map(v => -v); Rq.set(r, i * 4); prev = r; }
      track(ci, 'translation', T, 3); track(ci, 'rotation', Rq, 4);
    }
    const json = { asset: { version: '2.0', generator: 'Clayframe' }, scene: 0, scenes: [{ name: scene.name, nodes: roots }], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: len }] };
    if (skins.length) json.skins = skins;
    if (cameras.length) json.cameras = cameras;
    if (channels.length) json.animations = [{ name: scene.name || 'Animation', channels, samplers }];
    let js = new TextEncoder().encode(JSON.stringify(json));
    const jpad = (4 - js.length % 4) % 4, bpad = (4 - len % 4) % 4;
    const total = 12 + 8 + js.length + jpad + 8 + len + bpad;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, js.length + jpad, true); dv.setUint32(16, 0x4E4F534A, true); out.set(js, 20); out.fill(0x20, 20 + js.length, 20 + js.length + jpad);
    let p = 20 + js.length + jpad;
    dv.setUint32(p, len + bpad, true); dv.setUint32(p + 4, 0x004E4942, true); p += 8;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return new Blob([out], { type: 'model/gltf-binary' });
  }
  // ---------- video export ----------
  let exporting = null;
  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }
  function openExport() {
    const d = $('dlg'); d.innerHTML = '';
    const mime = pickMime();
    const [aw, ah] = String(scene.aspect || '16:9').split(':').map(Number);
    const res = selectInput([['720', '720p'], ['1080', '1080p']], '720', () => {});
    let useCam = !!scene.camKeys.length, useLit = renderMode;
    const out = h('div', {});
    const status = h('p', { class: 'small muted', 'aria-live': 'polite' }, mime === null ? 'This browser can’t record video.' : scene.duration + ' s at 30 fps, ' + aw + ':' + ah + ', ' + (mime.includes('mp4') ? 'MP4' : 'WebM'));
    const go = h('button', { type: 'button', class: 'btn primary', disabled: mime === null, onclick: () => {
      go.disabled = true;
      recordVideo(+res.value, aw / ah, useCam, useLit, mime, (p) => { status.textContent = 'Recording… ' + Math.round(p * 100) + '%'; }, (blob, err) => {
        go.disabled = false;
        if (err) { status.textContent = 'Couldn’t record: ' + err; return; }
        const ext = blob.type.includes('mp4') ? 'mp4' : 'webm', url = URL.createObjectURL(blob);
        status.textContent = 'Done. Play it here, or save it.';
        out.innerHTML = ''; out.append(h('video', { src: url, controls: true, playsinline: true }), h('div', { class: 'row', style: 'margin-top:8px' }, h('a', { class: 'btn primary', href: url, download: slug() + '.' + ext }, '⤓ Save video')));
      });
    } }, '● Record video');
    const sel_ = selObj();
    d.append(h('h2', {}, 'Export'),
      h('div', { class: 'two' }, field('Size', res), field('Shape', h('span', { style: 'padding-top:8px' }, aw + ':' + ah + ' (change in Scene)'))),
      scene.camKeys.length ? chk('Film through the camera keyframes', useCam, v => { useCam = v; }) : h('p', { class: 'muted small' }, 'Films from the current view (keyframe the camera with 🎥◆ for moving shots).'),
      chk('Lights, shadows and a floor (the ☀ render view)', useLit, v => { useLit = v; }),
      status, h('div', { class: 'row' }, go), out,
      h('hr', { style: 'border:0;border-top:1px solid var(--rule);margin:14px 0' }),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', disabled: !sel_ || !MESH.get(sel_ && sel_.id), onclick: () => {
        const o = selObj(), rec = lastEval.get(o.id), P = posedPositions(o, rec), M = MESH.get(o.id);
        download(slug() + '-' + o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.obj', new Blob([MESHLIB.toOBJ(o.name, P, M.m.idx, RND.normalsFor(P, M.m.idx))], { type: 'text/plain' }));
      } }, '⤓ Selected object as OBJ (as posed now)')),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { type: 'button', class: 'btn', onclick: () => { try { download(slug() + '.glb', exportGLB()); } catch (e) { toast('Couldn’t make the GLB: ' + e.message); } } }, '⤓ Whole scene as GLB (bones, shapes and animation)')),
      h('p', { class: 'muted small' }, 'OBJ files open in Blender, Nomad, Procreate and 3D printing apps. GLB keeps the rig and animation, for Blender, game engines and AR viewers.'),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => d.close() }, 'Close')));
    d.showModal();
  }
  $('exportBtn').addEventListener('click', openExport);
  function recordVideo(short, ratio, useCam, useLit, mime, onProg, onDone) {
    let w = ratio >= 1 ? Math.round(short * ratio) : short, hh = ratio >= 1 ? short : Math.round(short / ratio);
    w += w % 2; hh += hh % 2;
    const keep = { W, H, time, playing, camView };
    if (playing) setPlaying(false);
    exporting = { cam: useCam, lit: useLit };
    W = w; H = hh; view.width = w; view.height = hh;
    let rec, chunks = [];
    try { rec = new MediaRecorder(view.captureStream(30), Object.assign({ videoBitsPerSecond: short >= 1080 ? 12e6 : 6e6 }, mime ? { mimeType: mime } : {})); }
    catch (e) { restoreAfter(); onDone(null, e.message); return; }
    function restoreAfter() { exporting = null; W = keep.W; H = keep.H; view.width = W; view.height = H; time = keep.time; dirty = true; resize(); }
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => { restoreAfter(); onDone(new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] })); };
    rec.start(500);
    const t0 = performance.now(), D = scene.duration;
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      time = Math.min(t, D);
      draw({ final: true });
      onProg(time / D);
      if (t < D + 0.15) requestAnimationFrame(step); else rec.stop();
    };
    requestAnimationFrame(step);
  }

  // ---------- Stage: puppet a character live with a game controller or touch sticks, and record it ----------
  let stageOn = false, stageRec = null, stageChar = null, live = null;
  const INPUTS = [['lx', 'Left stick ↔'], ['ly', 'Left stick ↕'], ['rx', 'Right stick ↔'], ['ry', 'Right stick ↕'], ['lt', 'Left trigger'], ['rt', 'Right trigger'], ['a', 'A button'], ['b', 'B button'], ['x', 'X button'], ['y', 'Y button'], ['lb', 'Left bumper'], ['rb', 'Right bumper'], ['up', 'D-pad up'], ['down', 'D-pad down'], ['left', 'D-pad left'], ['right', 'D-pad right'],
    ['f_yaw', 'Face: turn'], ['f_pitch', 'Face: nod'], ['f_roll', 'Face: tilt'], ['f_jaw', 'Face: mouth open'], ['f_smile', 'Face: smile'], ['f_blink', 'Face: blink'], ['f_brow', 'Face: brows up'], ['f_pucker', 'Face: pucker'], ['f_cheek', 'Face: cheek puff'], ['f_wide', 'Face: eyes wide']];
  const zero = () => Object.fromEntries(INPUTS.map(([k]) => [k, 0]));
  const inp = zero(), touchInp = zero();
  function stageTargets(o) {
    const T = [['move.x', 'Walk across'], ['move.z', 'Walk forward'], ['turn', 'Turn around'], ['jump', 'Jump'], ['lift', 'Rise up']];
    for (const b of o.bones) T.push(['bone:' + b.id + ':y', b.name + ': turn'], ['bone:' + b.id + ':x', b.name + ': nod'], ['bone:' + b.id + ':z', b.name + ': tilt']);
    for (const mo of o.morphs) T.push(['morph:' + mo.id, 'Shape: ' + mo.name]);
    for (const p of o.poses || []) T.push(['pose:' + p.id, 'Pose: ' + p.name]);
    return T;
  }
  function defaultMap(o) {
    const head = o.bones.find(b => /head/i.test(b.name)) || o.bones.filter(b => Math.abs(b.tail[0]) < 0.05).sort((a, b) => b.tail[1] - a.tail[1])[0];
    const arm = o.bones.find(b => /arm|hand/i.test(b.name) && b.tail[0] > 0) || o.bones.find(b => b.tail[0] > 0.2);
    const M = [{ in: 'lx', to: 'move.x', amt: 2.2 }, { in: 'ly', to: 'move.z', amt: 2.2 }];
    if (head) M.push({ in: 'rx', to: 'bone:' + head.id + ':y', amt: 55 }, { in: 'ry', to: 'bone:' + head.id + ':x', amt: 30 });
    else M.push({ in: 'rx', to: 'turn', amt: 140 });
    if (o.morphs[0]) M.push({ in: 'rt', to: 'morph:' + o.morphs[0].id, amt: 1 });
    else if (arm) M.push({ in: 'rt', to: 'bone:' + arm.id + ':z', amt: 70 });
    if (o.morphs[1]) M.push({ in: 'lt', to: 'morph:' + o.morphs[1].id, amt: 1 });
    else if (arm && o.morphs[0]) M.push({ in: 'lt', to: 'bone:' + arm.id + ':z', amt: 70 });
    M.push({ in: 'a', to: 'jump', amt: 1 });
    (o.poses || []).slice(0, 3).forEach((p, i) => M.push({ in: ['b', 'x', 'y'][i], to: 'pose:' + p.id, amt: 1 }));
    return M;
  }
  const stageCfg = o => (o.stage = o.stage || { map: defaultMap(o), face: true, bob: true, follow: true, walk: true });
  function enterStage() {
    stageOn = true; document.body.classList.add('staging');
    if (playing) setPlaying(false);
    const o = selObj() && MESH.get(sel) ? selObj() : scene.objects.find(x => x.type === 'mesh' && x.bones.length) || scene.objects.find(x => x.type === 'mesh');
    setStageChar(o ? o.id : null);
    buildStageUI(); resize();
  }
  function exitStage() {
    if (stageRec) stopRecord();
    stopFace(true);
    stageOn = false; live = null; document.body.classList.remove('staging');
    $('stageUI').hidden = true; $('stageUI').innerHTML = ''; resize(); dirty = true;
  }
  function setStageChar(id) {
    stageChar = id;
    const o = id && objById(id);
    live = null;
    if (!o) return;
    sel = id;
    stageCfg(o);
    resetLive(o);
  }
  function resetLive(o) {
    live = { pos: getChan(o, 'pos').slice(), rot: getChan(o, 'rot').slice(), vy: 0, hop: 0, phase: 0, yaw: getChan(o, 'rot')[1], used: new Set(), pt: {}, pw: {}, gait: 0, cls: o.bones.length ? classifyBones(o) : null };
  }
  function readPad() {
    let pad = null;
    try { const ps = navigator.getGamepads ? navigator.getGamepads() : []; for (const p of ps) if (p && p.connected) { pad = p; break; } } catch (e) {}
    const dz = v => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;
    const g = zero();
    if (pad) {
      const ax = pad.axes || [], bt = pad.buttons || [], bv = i => bt[i] ? (typeof bt[i] === 'object' ? bt[i].value : bt[i]) : 0;
      g.lx = dz(ax[0] || 0); g.ly = dz(ax[1] || 0); g.rx = dz(ax[2] || 0); g.ry = dz(ax[3] || 0);
      g.lt = bv(6); g.rt = bv(7); g.a = bv(0); g.b = bv(1); g.x = bv(2); g.y = bv(3); g.lb = bv(4); g.rb = bv(5);
      g.up = bv(12); g.down = bv(13); g.left = bv(14); g.right = bv(15);
    }
    for (const k in inp) inp[k] = Math.abs(touchInp[k]) > Math.abs(g[k]) ? touchInp[k] : g[k];
    if (face.on) for (const k in face.vals) inp[k] = face.vals[k];
    const pi = $('padInfo'); if (pi) pi.textContent = pad ? '🎮 ' + (pad.id || 'Controller').split('(')[0].trim().slice(0, 32) : 'No controller: use the sticks, or connect one and press a button';
  }
  let liveOver = null, livePose = null;
  function stageTick(dt) {
    readFace();
    readPad();
    const o = stageChar && objById(stageChar);
    if (!o || !live) return;
    const cfg = stageCfg(o);
    // base values come from the timeline; the controls add to them
    const baseRot = getChan(o, 'rot'), basePos = getChan(o, 'pos');
    const off = new Map(), morph = {};
    let mv = [0, 0], turn = 0, lift = 0, jump = 0;
    for (const m of cfg.map) {
      const v = inp[m.in] || 0, a = m.amt;
      if (m.to === 'move.x') { mv[0] += v * a; if (v) live.used.add('pos'); }
      else if (m.to === 'move.z') { mv[1] += v * a; if (v) live.used.add('pos'); }
      else if (m.to === 'turn') { turn += v * a; if (v) live.used.add('rot'); }
      else if (m.to === 'jump') { if (v > 0.5) jump = 1; }
      else if (m.to === 'lift') lift += v * a;
      else if (m.to.startsWith('bone:')) { const [, id, axis] = m.to.split(':'); const e = off.get(id) || [0, 0, 0]; e['xyz'.indexOf(axis)] += v * a; off.set(id, e); if (v) live.used.add('bone:' + id); }
      else if (m.to.startsWith('morph:')) { const id = m.to.slice(6); morph[id] = clamp((morph[id] || 0) + v * a, 0, 1); if (v) live.used.add('morph:' + id); }
      else if (m.to.startsWith('pose:')) { const id = m.to.slice(5); live.pt[id] = Math.max(live.pt[id] || 0, clamp(v * a, 0, 1)); }
    }
    // saved poses ease in and out over a fraction of a second
    for (const p of o.poses || []) {
      const want = live.pt[p.id] || 0, cur = live.pw[p.id] || 0;
      live.pw[p.id] = cur + (want - cur) * Math.min(1, dt * 9);
      live.pt[p.id] = 0;
      if (live.pw[p.id] > 0.01) { for (const id in p.bones) live.used.add('bone:' + id); for (const id in p.morph || {}) live.used.add('morph:' + id); }
    }
    // walk relative to the camera
    const fw = v3.norm([Math.sin(cam.yaw) * -1, 0, Math.cos(cam.yaw) * -1]), rt = [-fw[2], 0, fw[0]];
    const vel = v3.add(v3.scale(rt, mv[0]), v3.scale(fw, -mv[1]));
    const sp = Math.hypot(vel[0], vel[2]);
    if (!live.used.has('pos')) { live.pos = basePos.slice(); }
    live.pos[0] += vel[0] * dt; live.pos[2] += vel[2] * dt;
    if (jump && live.hop <= 0 && live.vy === 0) { live.vy = 4.2; live.used.add('pos'); }
    if (live.vy !== 0 || live.hop > 0) { live.hop += live.vy * dt; live.vy -= 12 * dt; if (live.hop <= 0) { live.hop = 0; live.vy = 0; } }
    live.phase += sp * dt * 3.2;
    const bob = cfg.bob && sp > 0.05 ? Math.abs(Math.sin(live.phase)) * 0.09 : 0;
    let yaw = live.used.has('rot') ? live.yaw : baseRot[1];
    yaw += turn * dt;
    if (cfg.face && sp > 0.15) { const want = Math.atan2(vel[0], vel[2]) * 180 / Math.PI; let d = ((want - yaw + 540) % 360) - 180; yaw += d * Math.min(1, dt * 10); live.used.add('rot'); }
    live.yaw = yaw;
    const pos = [live.pos[0], (live.used.has('pos') ? live.pos[1] : basePos[1]) + live.hop + bob + lift, live.pos[2]];
    const rot = [baseRot[0], yaw, baseRot[2]];
    liveOver = { id: o.id, pos: live.used.has('pos') || live.hop || bob || lift ? pos : null, rot: live.used.has('rot') ? rot : null, morph };
    // bone offsets on top of the keyframed pose
    const pose = new Map();
    const rec = lastEval && lastEval.get(o.id);
    // walking swings the legs and arms on its own
    live.gait += ((sp > 0.15 ? Math.min(1, sp / 2) : 0) - live.gait) * Math.min(1, dt * 6);
    const walk = cfg.walk !== false && live.cls && live.gait > 0.02 ? walkPose(live.cls, live.phase * 1.25, live.gait) : null;
    if (walk) for (const id of walk.keys()) live.used.add('bone:' + id);
    const lt = S.localTime(o, time);
    for (const b of o.bones) {
      let base = S.keyVal(o.keys, 'bone:' + b.id, lt, b.rot || [0, 0, 0, 1]);
      for (const p of o.poses || []) { const w = live.pw[p.id]; if (w > 0.01 && p.bones[b.id]) base = q.slerp(base, p.bones[b.id], w); }
      if (walk && walk.has(b.id)) base = q.norm(q.mul(base, walk.get(b.id)));
      const e = off.get(b.id);
      pose.set(b.id, e ? q.norm(q.mul(base, q.fromEuler(e))) : base);
    }
    for (const p of o.poses || []) { const w = live.pw[p.id]; if (w > 0.01) for (const [id, mw] of Object.entries(p.morph || {})) { const cur = morph[id] != null ? morph[id] : getChan(o, 'morph:' + id); morph[id] = cur + (mw - cur) * w; } }
    livePose = { id: o.id, map: pose };
    if (cfg.follow) { const tgt = [pos[0], cam.target[1], pos[2]]; cam.target = v3.lerp(cam.target, tgt, Math.min(1, dt * 3)); }
    if (stageRec) sample(o, liveOver, pose, morph);
    dirty = true;
  }
  const stageDrawOpt = () => ({ over: liveOver, pose: livePose });
  // recording: sample every frame, then write keyframes (thinned out) for whatever the controls moved
  function startRecord() {
    const o = stageChar && objById(stageChar); if (!o) return;
    if (time >= scene.duration - 0.05) setTime(0);
    stageRec = { o, t0: time, frames: [] };
    live.used = new Set();
    setPlaying(true); buildStageUI();
  }
  function sample(o, ov, pose, morph) {
    const f = { t: round(time, 3) };
    f.pos = ov.pos ? ov.pos.slice() : getChan(o, 'pos');
    f.rot = ov.rot ? ov.rot.slice() : getChan(o, 'rot');
    f.bones = {}; for (const [id, qq] of pose) f.bones[id] = qq.slice();
    f.morph = {}; for (const mo of o.morphs) f.morph[mo.id] = morph[mo.id] != null ? morph[mo.id] : getChan(o, 'morph:' + mo.id);
    const fr = stageRec.frames; if (!fr.length || f.t > fr[fr.length - 1].t + 1 / 40) fr.push(f);
  }
  function thin(keys, tol) {
    if (keys.length < 3) return keys;
    const dist = (a, b) => typeof a === 'number' ? Math.abs(a - b) : a.reduce((s, x, i) => Math.max(s, Math.abs(x - b[i])), 0);
    const out = [keys[0]];
    for (let i = 1; i < keys.length - 1; i++) {
      const a = out[out.length - 1], c = keys[i + 1], u = (keys[i].t - a.t) / (c.t - a.t || 1);
      const guess = typeof a.v === 'number' ? a.v + (c.v - a.v) * u : a.v.length === 4 ? q.slerp(a.v, c.v, u) : a.v.map((x, j) => x + (c.v[j] - x) * u);
      if (dist(guess, keys[i].v) > tol) out.push(keys[i]);
    }
    out.push(keys[keys.length - 1]);
    return out;
  }
  function stopRecord() {
    const R0 = stageRec; stageRec = null;
    if (playing) setPlaying(false);
    if (!R0 || R0.frames.length < 2) { buildStageUI(); return; }
    pushUndo(snapScene());
    const o = R0.o, fr = R0.frames, t0 = fr[0].t, t1 = fr[fr.length - 1].t;
    const write = (ch, get, tol) => {
      const ks = thin(fr.map(f => ({ t: f.t, v: get(f), ease: 'linear' })), tol);
      const keep = (o.keys[ch] || []).filter(k => k.t < t0 - 1e-3 || k.t > t1 + 1e-3);
      o.keys[ch] = keep.concat(ks).sort((a, b) => a.t - b.t);
    };
    const used = live ? live.used : new Set();
    let n = 0;
    if (used.has('pos')) { write('pos', f => f.pos.map(v => round(v, 4)), 0.01); n++; }
    if (used.has('rot')) { write('rot', f => f.rot.map(v => round(v, 2)), 1); n++; }
    for (const b of o.bones) if (used.has('bone:' + b.id)) { write('bone:' + b.id, f => f.bones[b.id].map(v => round(v, 5)), 0.01); n++; }
    for (const mo of o.morphs) if (used.has('morph:' + mo.id)) { write('morph:' + mo.id, f => round(f.morph[mo.id], 3), 0.02); n++; }
    if (n) {
      o.takes = o.takes || [];
      const chans = {};
      for (const ch of Object.keys(o.keys)) if (used.has(ch) || (ch === 'pos' && used.has('pos')) || (ch === 'rot' && used.has('rot'))) chans[ch] = o.keys[ch].filter(k => k.t >= t0 - 1e-3 && k.t <= t1 + 1e-3).map(k => Object.assign({}, k));
      const names = Object.keys(chans).map(ch => (chanList(o).find(c => c[0] === ch) || [ch, ch])[1]);
      o.takes.forEach(tk => { if (Object.keys(tk.chans).some(ch => chans[ch])) tk.active = false; });
      o.takes.push({ id: uid(), name: 'Take ' + (o.takes.length + 1), t0, t1, chans, what: names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : ''), active: true });
    }
    changed(); renderTimeline(); resetLive(o); buildStageUI();
    toast(n ? 'Recorded ' + (t1 - t0).toFixed(1) + 's into ' + n + ' tracks of ' + o.name + '. Undo with ↶ to try again.' : 'Nothing moved, so nothing was recorded');
  }
  function buildStageUI() {
    const ui = $('stageUI'); ui.hidden = false; ui.innerHTML = '';
    const chars = scene.objects.filter(o => o.type === 'mesh');
    const charSel = selectInput(chars.map(o => [o.id, o.name]), stageChar || '', v => { setStageChar(v); buildStageUI(); });
    const status = h('span', { class: 'st-status' + (stageRec ? ' rec' : '') }, stageRec ? '● REC ' + time.toFixed(1) + 's' : time.toFixed(1) + 's');
    ui.append(h('div', { class: 'st-top' },
      h('button', { type: 'button', class: 'btn', onclick: () => setMode('objects') }, '✕ Exit'),
      charSel,
      stageRec ? h('button', { type: 'button', class: 'btn rec', onclick: stopRecord }, '■ Stop') : h('button', { type: 'button', class: 'btn rec', onclick: startRecord }, '● Record'),
      h('button', { type: 'button', class: 'btn', onclick: () => { if (stageRec) return; setPlaying(!playing); buildStageUI(); } }, playing && !stageRec ? '❚❚ Pause' : '▶ Rehearse'),
      h('button', { type: 'button', class: 'btn', onclick: () => { const o = objById(stageChar); if (o) { resetLive(o); dirty = true; } } }, '⟲ Reset'),
      h('button', { type: 'button', class: 'btn', onclick: () => openSheet('stagemap') }, '⚙ Controls'),
      h('button', { type: 'button', class: 'btn', onclick: () => openSheet('takes') }, '🎞 Takes'),
      h('button', { type: 'button', class: 'btn' + (face.on || face.busy ? ' primary' : ''), onclick: () => face.on || face.busy ? stopFace() : startFace() }, face.on || face.busy ? '🙂 Face on' : '🙂 Face'),
      status));
    const joy = (side, kx, ky, label) => {
      const knob = h('div', { class: 'knob' }), el = h('div', { class: 'joy ' + side, 'aria-label': label }, h('span', { class: 'jl' }, label), knob);
      let id = null;
      const set = e => { const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R0 = r.width / 2; let dx = (e.clientX - cx) / R0, dy = (e.clientY - cy) / R0; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } touchInp[kx] = dx; touchInp[ky] = dy; knob.style.transform = 'translate(' + dx * R0 * 0.6 + 'px,' + dy * R0 * 0.6 + 'px)'; };
      el.addEventListener('pointerdown', e => { id = e.pointerId; el.setPointerCapture(id); set(e); });
      el.addEventListener('pointermove', e => { if (e.pointerId === id) set(e); });
      const end = e => { if (e.pointerId !== id) return; id = null; touchInp[kx] = 0; touchInp[ky] = 0; knob.style.transform = ''; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      return el;
    };
    const trig = (side, k, label) => {
      const fill = h('div', { class: 'fill' }), el = h('div', { class: 'trig ' + side, 'aria-label': label }, h('span', { class: 'jl' }, label), fill);
      let id = null;
      const set = e => { const r = el.getBoundingClientRect(); const v = clamp((r.bottom - e.clientY) / r.height, 0, 1); touchInp[k] = v; fill.style.height = v * 100 + '%'; };
      el.addEventListener('pointerdown', e => { id = e.pointerId; el.setPointerCapture(id); set(e); });
      el.addEventListener('pointermove', e => { if (e.pointerId === id) set(e); });
      const end = e => { if (e.pointerId !== id) return; id = null; touchInp[k] = 0; fill.style.height = '0'; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      return el;
    };
    const pad = h('div', { class: 'abxy' });
    for (const k of ['y', 'x', 'b', 'a']) {
      const b = h('button', { type: 'button', class: 'stbtn ' + k, 'aria-label': k.toUpperCase() + ' button' }, k.toUpperCase());
      b.addEventListener('pointerdown', e => { touchInp[k] = 1; b.classList.add('on'); try { b.setPointerCapture(e.pointerId); } catch (err) {} });
      const off = () => { touchInp[k] = 0; b.classList.remove('on'); };
      b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off);
      pad.append(b);
    }
    if (face.on || face.busy || face.err) {
      const box = h('div', { class: 'facebox' });
      if (face.video) box.append(face.video);
      box.append(h('div', { class: 'facestat', id: 'faceStat' }, face.err || face.status || ''));
      if (face.on) box.append(h('button', { type: 'button', class: 'btn small', onclick: () => { face.neutral = face.raw.slice(); toast('Centred: your head as it is now counts as straight'); } }, 'Centre'));
      ui.append(box);
    }
    ui.append(joy('l', 'lx', 'ly', 'Move'), joy('r', 'rx', 'ry', 'Look'), trig('l', 'lt', 'LT'), trig('r', 'rt', 'RT'), pad, h('div', { class: 'padinfo', id: 'padInfo' }, ''));
    if (!stageChar) ui.append(h('div', { class: 'banner' }, 'Add a character first'));
  }
  setInterval(() => { if (stageOn) { const s = document.querySelector('.st-status'); if (s) s.textContent = (stageRec ? '● REC ' : '') + time.toFixed(1) + 's'; } }, 200);
  function stageDown() { return false; } function stageMove() { return false; } function stageUp() { return false; }
  function stageMapSheet(body) {
    const o = stageChar && objById(stageChar);
    if (!o) { body.append(h('p', { class: 'muted' }, 'Pick a character first.')); return; }
    const cfg = stageCfg(o), T = stageTargets(o);
    body.append(h('p', { class: 'muted small' }, 'What each stick, trigger and button does to ' + o.name + '. Amount is speed for walking and turning, degrees for bones, and 0–1 for shapes. Works with Xbox, PlayStation and most Bluetooth controllers, and handhelds with built-in sticks.'));
    const list = h('div', { class: 'list' });
    cfg.map.forEach((m, i) => list.append(h('div', { class: 'li', style: 'flex-wrap:wrap' },
      h('div', { style: 'flex:1 1 120px' }, selectInput(INPUTS, m.in, v => { m.in = v; saveSoon(); })),
      h('div', { style: 'flex:1 1 150px' }, selectInput(T, m.to, v => { m.to = v; saveSoon(); })),
      h('div', { style: 'flex:0 0 150px' }, stepper(m.amt, m.to.startsWith('morph') ? 0.1 : m.to.startsWith('move') ? 0.5 : 10, v => { m.amt = v; saveSoon(); })),
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Remove', onclick: () => { cfg.map.splice(i, 1); saveSoon(); refreshSheet(); } }, '✕'))));
    body.append(list, h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => { cfg.map.push({ in: 'b', to: T[0][0], amt: 1 }); saveSoon(); refreshSheet(); } }, '＋ Add a control'),
      h('button', { type: 'button', class: 'btn quiet', onclick: () => { cfg.map = defaultMap(o); saveSoon(); refreshSheet(); } }, 'Reset to suggested')));
    body.append(chk('Face the way it walks', cfg.face, v => { cfg.face = v; saveSoon(); }), chk('Swing legs and arms while walking', cfg.walk !== false, v => { cfg.walk = v; saveSoon(); }), chk('Bob while walking', cfg.bob, v => { cfg.bob = v; saveSoon(); }), chk('Camera follows', cfg.follow, v => { cfg.follow = v; saveSoon(); }));
    body.append(group('Face', chk('Mirror me (turn left, it turns left as you see it)', face.mirror, v => { face.mirror = v; }),
      h('p', { class: 'muted small' }, 'Turn on 🙂 Face, then map the Face inputs above to bones and shapes. Name shapes after expressions (Smile, Blink, Jaw open…) and they’re wired up for you. Sculpt them in Shapes.')));
    if (!(o.poses || []).length) body.append(h('p', { class: 'muted small' }, 'Tip: save poses in Pose → Poses, then put them on buttons here: they blend in while you hold the button.'));
    body.append(h('p', { class: 'muted small' }, 'Record plays the timeline from the playhead, so other characters’ animation plays along and you can layer takes. Only the things you moved are recorded.'));
  }

  // ---------- face puppeteering: the front camera and MediaPipe's face tracker (runs on the device) ----------
  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  const face = { on: false, busy: false, status: '', err: '', video: null, stream: null, lm: null, last: 0, vals: {}, raw: [0, 0, 0], neutral: [0, 0, 0], mirror: true, seen: 0 };
  const setFaceStat = msg => { face.status = msg; const e = $('faceStat'); if (e) e.textContent = msg; };
  async function startFace() {
    if (face.busy) return;
    face.busy = true; face.err = ''; buildStageUI();
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('this browser can’t use the camera here');
      setFaceStat('Starting the camera…');
      face.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      const v = h('video', { playsinline: true, muted: true, autoplay: true, class: 'facevid' });
      v.muted = true; v.srcObject = face.stream; face.video = v;
      buildStageUI();
      await v.play().catch(() => {});
      if (!face.lm) {
        setFaceStat('Loading face tracking (about 4 MB, first time only)…');
        const vision = await import(MP + '/vision_bundle.mjs');
        const files = await vision.FilesetResolver.forVisionTasks(MP + '/wasm');
        const opts = d => ({ baseOptions: { modelAssetPath: MODEL, delegate: d }, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, runningMode: 'VIDEO', numFaces: 1 });
        try { face.lm = await vision.FaceLandmarker.createFromOptions(files, opts('GPU')); }
        catch (e) { face.lm = await vision.FaceLandmarker.createFromOptions(files, opts('CPU')); }
      }
      face.on = true; face.busy = false;
      setFaceStat('Looking for your face…');
      const o = stageChar && objById(stageChar);
      if (o) addFaceMap(o);
      buildStageUI();
      toast('Face on: turn, nod and tilt your head, and make faces. ⚙ Controls says what each one moves.', 3800);
    } catch (e) {
      face.busy = false; face.on = false;
      face.err = 'Face tracking couldn’t start: ' + (e && e.name === 'NotAllowedError' ? 'camera permission was turned down' : (e && e.message) || e) + '. It needs the internet the first time, and camera permission.';
      stopFace(true, true); buildStageUI();
    }
  }
  function stopFace(quiet, keepErr) {
    if (face.stream) face.stream.getTracks().forEach(t => t.stop());
    face.stream = null; face.video = null; face.on = false; face.busy = false; face.vals = {};
    if (!keepErr) face.err = '';
    if (!quiet && stageOn) buildStageUI();
  }
  function readFace() {
    if (!face.on || !face.lm || !face.video || face.video.readyState < 2) return;
    const now = performance.now();
    if (now - face.last < 33) return;
    face.last = now;
    let res;
    try { res = face.lm.detectForVideo(face.video, now); } catch (e) { return; }
    const bs = res && res.faceBlendshapes && res.faceBlendshapes[0], mx = res && res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
    if (!bs || !mx) { if (face.seen) { face.seen = 0; setFaceStat('Can’t see your face'); } return; }
    if (!face.seen) setFaceStat('Tracking'); face.seen = 1;
    const sc = {}; for (const c of bs.categories) sc[c.categoryName] = c.score;
    const avg = (a, b) => ((sc[a] || 0) + (sc[b] || 0)) / 2;
    const e = q.toEuler(decompose(Array.from(mx.data)).r);
    face.raw = [e[0], e[1], e[2]];
    const m = face.mirror ? -1 : 1;
    const want = {
      f_pitch: clamp(-(e[0] - face.neutral[0]) / 30, -1, 1), f_yaw: clamp(m * (e[1] - face.neutral[1]) / 45, -1, 1), f_roll: clamp(m * (e[2] - face.neutral[2]) / 30, -1, 1),
      f_jaw: sc.jawOpen || 0, f_smile: avg('mouthSmileLeft', 'mouthSmileRight'), f_blink: avg('eyeBlinkLeft', 'eyeBlinkRight'), f_brow: sc.browInnerUp || 0,
      f_pucker: sc.mouthPucker || 0, f_cheek: sc.cheekPuff || 0, f_wide: avg('eyeWideLeft', 'eyeWideRight')
    };
    for (const k in want) face.vals[k] = (face.vals[k] || 0) + (want[k] - (face.vals[k] || 0)) * 0.55;
  }
  // when the face turns on, wire it to the head and to shapes whose names suggest an expression
  function addFaceMap(o) {
    const cfg = stageCfg(o);
    if (cfg.map.some(m => m.in.startsWith('f_'))) return;
    const head = o.bones.find(b => /head/i.test(b.name)) || o.bones.filter(b => Math.abs(b.tail[0]) < 0.05).sort((a, b) => b.tail[1] - a.tail[1])[0];
    if (head) cfg.map.push({ in: 'f_yaw', to: 'bone:' + head.id + ':y', amt: 50 }, { in: 'f_pitch', to: 'bone:' + head.id + ':x', amt: 30 }, { in: 'f_roll', to: 'bone:' + head.id + ':z', amt: 30 });
    else cfg.map.push({ in: 'f_yaw', to: 'turn', amt: 90 });
    const rules = [[/jaw|mouth|open|talk|ah/i, 'f_jaw'], [/smile|happy|grin/i, 'f_smile'], [/blink|eyes? ?closed?|shut/i, 'f_blink'], [/brow|surprise|shock/i, 'f_brow'], [/pucker|kiss|ooh/i, 'f_pucker'], [/cheek|puff/i, 'f_cheek'], [/wide|stare/i, 'f_wide']];
    const used = new Set();
    for (const mo of o.morphs) for (const [re, k] of rules) if (re.test(mo.name) && !used.has(k)) { cfg.map.push({ in: k, to: 'morph:' + mo.id, amt: 1 }); used.add(k); break; }
    if (!used.size && o.morphs[0]) cfg.map.push({ in: 'f_jaw', to: 'morph:' + o.morphs[0].id, amt: 1 });
    saveSoon();
  }
  function takesSheet(body) {
    const o = stageChar && objById(stageChar);
    if (!o) { body.append(h('p', { class: 'muted' }, 'Pick a character first.')); return; }
    const T = o.takes || [];
    if (!T.length) { body.append(h('p', { class: 'muted' }, 'No takes yet. Each recording is kept as a take, so you can try again and switch back.')); return; }
    body.append(h('p', { class: 'muted small' }, 'Record the arms in one take and the head in another; they layer. Several takes of the same thing? Pick the one to use.'));
    const list = h('div', { class: 'list' });
    T.slice().reverse().forEach(tk => list.append(h('div', { class: 'li' + (tk.active ? ' on' : '') },
      h('div', { class: 'nm' }, h('b', {}, tk.name), h('div', { class: 'muted small' }, tk.t0.toFixed(1) + '–' + tk.t1.toFixed(1) + 's · ' + tk.what)),
      tk.active ? h('span', { class: 'muted small' }, 'in use') : h('button', { type: 'button', class: 'btn primary', onclick: () => {
        before();
        for (const [ch, ks] of Object.entries(tk.chans)) { const keep = (o.keys[ch] || []).filter(k => k.t < tk.t0 - 1e-3 || k.t > tk.t1 + 1e-3); o.keys[ch] = keep.concat(ks.map(k => Object.assign({}, k))).sort((a, b) => a.t - b.t); }
        T.forEach(x => { if (x !== tk && Object.keys(x.chans).some(ch => tk.chans[ch])) x.active = false; }); tk.active = true;
        changed(); renderTimeline(); refreshSheet(); toast('Using ' + tk.name);
      } }, 'Use'),
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Forget ' + tk.name, onclick: () => { o.takes = T.filter(x => x !== tk); saveSoon(); refreshSheet(); } }, '✕'))));
    body.append(list);
  }

  // ---------- projects, backups, import ----------
  const b64 = a => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s, T) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new T(u.buffer); };
  function backupBlob() {
    const meshes = {};
    for (const [id, M] of MESH) meshes[id] = { pos: b64(M.m.pos), idx: b64(M.m.idx), col: b64(M.m.col), mask: b64(M.m.mask), morphs: Object.fromEntries(Object.entries(M.morphs).map(([k, v]) => [k, b64(v)])), skin: M.skin ? { bi: b64(M.skin.bi), bw: b64(M.skin.bw), bones: M.skin.bones } : null };
    return new Blob([JSON.stringify({ clayframe: 1, scene, meshes })], { type: 'application/json' });
  }
  function fromBackup(j) {
    const meshes = {};
    for (const [id, d] of Object.entries(j.meshes || {})) meshes[id] = { pos: unb64(d.pos, Float32Array), idx: unb64(d.idx, Uint32Array), col: unb64(d.col, Float32Array), mask: unb64(d.mask, Float32Array), morphs: Object.fromEntries(Object.entries(d.morphs || {}).map(([k, v]) => [k, unb64(v, Float32Array)])), skin: d.skin ? { bi: unb64(d.skin.bi, Float32Array), bw: unb64(d.skin.bw, Float32Array), bones: d.skin.bones } : null };
    return meshes;
  }
  function pickFile(accept) { return new Promise(res => { const i = h('input', { type: 'file', accept, style: 'position:fixed;left:-9999px' }); i.addEventListener('change', () => { res(i.files[0] || null); i.remove(); }); document.body.append(i); i.click(); }); }
  async function importOBJ() {
    const f = await pickFile('.obj,text/plain'); if (!f) return;
    try {
      const m = MESHLIB.fromOBJ(await f.text());
      before();
      const b = MESHLIB.bounds(m);
      const o = addMesh(m, { name: f.name.replace(/\.[^.]+$/, '').slice(0, 30) || 'Import', pos: [0, round(-b.min[1] * 1.5, 3), 0], scl: [1.5, 1.5, 1.5] });
      sel = o.id; changed(); renderTools(); renderTimeline(); closeSheet();
      toast('Imported ' + (m.idx.length / 3).toLocaleString() + ' triangles');
    } catch (e) { toast('Couldn’t read that OBJ: ' + e.message); }
  }
  async function newProjectFrom(sc, meshes) {
    if (scene) await saveNow();
    const id = uid();
    openScene(sc, meshes, id);
    saveNow().then(fillProjects);
  }
  function blankScene(name) { return { v: 1, name: name || 'Untitled', duration: 5, fps: 30, aspect: '16:9', bg: '#24242A', objects: [], camKeys: [] }; }
  function openMenu() {
    const d = $('dlg'); d.innerHTML = '';
    const act = (label, fn, cls) => h('button', { type: 'button', class: 'btn ' + (cls || 'quiet'), onclick: () => { d.close(); fn(); } }, label);
    const projs = listMeta();
    d.append(h('h2', {}, 'Projects'), h('div', { class: 'menu' },
      act('＋ New empty project', () => { newProjectFrom(blankScene('Project ' + (projs.length + 1)), {}); setMode('objects'); }),
      act('＋ New copy of the demo character', () => { const dm = demo(); newProjectFrom(dm.scene, dm.meshes); }),
      act('⤓ Save a backup file', () => download(slug() + '.clayframe.json', backupBlob())),
      act('⤒ Open a backup file…', async () => { const f = await pickFile('.json,application/json'); if (!f) return; try { const j = JSON.parse(await f.text()); if (!j.clayframe) throw new Error('that isn’t a Clayframe backup'); newProjectFrom(j.scene, fromBackup(j)); toast('Opened ' + j.scene.name); } catch (e) { toast('Couldn’t open it: ' + e.message); } }),
      act('⌂ Scene settings', () => { if (mode === 'stage') setMode('objects'); openSheet('scene'); }),
      projs.length > 1 ? act('🗑 Delete this project', async () => { if (!await ask('Delete “' + scene.name + '”? This can’t be undone.', 'Delete')) return; const id = projId; try { await db.del(id); } catch (e) {} store.set('clayframe.projects', listMeta().filter(p => p.id !== id)); const next = listMeta()[0]; scene = null; if (!next || !(await loadProject(next.id))) { const dm = demo(); newProjectFrom(dm.scene, dm.meshes); } }, 'quiet danger') : null,
      h('p', { class: 'muted small' }, 'Projects are kept in this browser on this device. Save a backup file to move one to another device.'),
      act('Close', () => {})));
    d.showModal();
  }
  $('menuBtn').addEventListener('click', openMenu);
  $('proj').addEventListener('change', async e => { const id = e.target.value; await saveNow(); if (!(await loadProject(id))) { toast('Couldn’t open that project'); fillProjects(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  // ---------- the demo: a little rigged clay buddy and a ball ----------
  function demo() {
    const sc = blankScene('Clay buddy');
    sc.duration = 6;
    const meshes = {};
    const T = (t, e, s) => m4.trs(t, q.fromEuler(e || [0, 0, 0]), s || [1, 1, 1]);
    const ico = MESHLIB.icosphere(4), cap = MESHLIB.PRIMS.capsule.make();
    const body = MESHLIB.merge([
      { m: ico, mat: T([0, 1.0, 0], [0, 0, 0], [1.05, 1.2, 0.9]) },
      { m: ico, mat: T([0, 1.95, 0.02], [0, 0, 0], [0.86, 0.8, 0.8]) },
      { m: cap, mat: T([0.78, 1.18, 0], [0, 0, 72], [0.62, 1.05, 0.62]) },
      { m: cap, mat: T([-0.78, 1.18, 0], [0, 0, -72], [0.62, 1.05, 0.62]) },
      { m: cap, mat: T([0.26, 0.32, 0], [0, 0, 0], [0.72, 0.9, 0.72]) },
      { m: cap, mat: T([-0.26, 0.32, 0], [0, 0, 0], [0.72, 0.9, 0.72]) }]);
    // a smoothing pass blends the parts a little
    SC.smoothAll(body, 1); MESHLIB.normals(body);
    const o = newObj({ id: 'buddy', name: 'Buddy', color: '#E8A87C', matcap: 'clay' });
    o.bones = [
      { id: 'hips', name: 'Hips', parent: null, head: [0, 0.62, 0], tail: [0, 1.2, 0] },
      { id: 'chest', name: 'Chest', parent: 'hips', head: [0, 1.2, 0], tail: [0, 1.6, 0] },
      { id: 'head', name: 'Head', parent: 'chest', head: [0, 1.6, 0], tail: [0, 2.3, 0] },
      { id: 'armR', name: 'Arm R', parent: 'chest', head: [0.42, 1.36, 0], tail: [0.86, 1.2, 0], mirror: 'armL' },
      { id: 'handR', name: 'Hand R', parent: 'armR', head: [0.86, 1.2, 0], tail: [1.3, 1.04, 0], mirror: 'handL' },
      { id: 'armL', name: 'Arm L', parent: 'chest', head: [-0.42, 1.36, 0], tail: [-0.86, 1.2, 0], mirror: 'armR' },
      { id: 'handL', name: 'Hand L', parent: 'armL', head: [-0.86, 1.2, 0], tail: [-1.3, 1.04, 0], mirror: 'handR' },
      { id: 'legR', name: 'Leg R', parent: 'hips', head: [0.26, 0.62, 0], tail: [0.26, -0.05, 0], mirror: 'legL' },
      { id: 'legL', name: 'Leg L', parent: 'hips', head: [-0.26, 0.62, 0], tail: [-0.26, -0.05, 0], mirror: 'legR' }];
    o.bones.forEach(b => { b.rot = [0, 0, 0, 1]; });
    // shapes: a big surprised head, and a squash
    const n = body.pos.length;
    const big = new Float32Array(n), squash = new Float32Array(n);
    for (let i = 0; i < n; i += 3) {
      const x = body.pos[i], y = body.pos[i + 1], z = body.pos[i + 2];
      if (y > 1.55) { const k = Math.min(1, (y - 1.55) / 0.2); big[i] = x * 0.28 * k; big[i + 1] = (y - 1.95) * 0.28 * k; big[i + 2] = (z - 0.02) * 0.28 * k; }
      squash[i] = x * 0.22; squash[i + 1] = -y * 0.18; squash[i + 2] = z * 0.22;
    }
    o.morphs = [{ id: 'big', name: 'Surprise', w: 0 }, { id: 'squash', name: 'Squash', w: 0 }];
    meshes.buddy = { pos: body.pos, idx: body.idx, col: body.col, mask: body.mask, morphs: { big, squash }, skin: S.autoWeights(body, o.bones) };
    const E = e => q.norm(q.fromEuler(e)).map(v => round(v, 5));
    o.keys = {
      'bone:armR': [{ t: 0, v: E([0, 0, 0]) }, { t: 0.8, v: E([0, 0, 62]) }, { t: 3.6, v: E([0, 0, 62]) }, { t: 4.4, v: E([0, 0, 0]) }],
      'bone:handR': [{ t: 0.8, v: E([0, 0, 20]) }, { t: 1.3, v: E([0, 0, 55]) }, { t: 1.8, v: E([0, 0, 15]) }, { t: 2.3, v: E([0, 0, 55]) }, { t: 2.8, v: E([0, 0, 15]) }, { t: 3.3, v: E([0, 0, 50]) }, { t: 4.4, v: E([0, 0, 0]) }],
      'bone:head': [{ t: 0, v: E([0, 0, 0]) }, { t: 1.2, v: E([0, 0, -12]) }, { t: 2.6, v: E([8, 25, -6]) }, { t: 4.6, v: E([0, 0, 0]) }],
      'bone:chest': [{ t: 0, v: E([0, 0, 0]) }, { t: 1.5, v: E([0, 0, 5]) }, { t: 3, v: E([0, 0, -4]) }, { t: 4.5, v: E([0, 0, 0]) }],
      'morph:big': [{ t: 4.4, v: 0 }, { t: 4.8, v: 1, ease: 'backOut' }, { t: 5.5, v: 1 }, { t: 6, v: 0 }],
      'morph:squash': [{ t: 0, v: 0 }, { t: 0.25, v: 0.6 }, { t: 0.6, v: 0, ease: 'spring' }]
    };
    sc.objects.push(o);
    // eyes ride on the head bone
    const eye = MESHLIB.icosphere(3);
    for (const [id, x] of [['eyeR', 0.17], ['eyeL', -0.17]]) {
      sc.objects.push(newObj({ id, name: id === 'eyeR' ? 'Eye R' : 'Eye L', parent: 'buddy', parentBone: 'head', pos: [x, 2.02, 0.37], scl: [0.12, 0.16, 0.09], color: '#2B2B33', matcap: 'glossy' }));
      meshes[id] = { pos: eye.pos, idx: eye.idx, col: eye.col, mask: eye.mask, morphs: {}, skin: null };
    }
    const ball = MESHLIB.icosphere(4);
    sc.objects.push(newObj({ id: 'ball', name: 'Ball', pos: [1.9, 0.3, 0.6], scl: [0.6, 0.6, 0.6], color: '#6FA8DC', matcap: 'glossy',
      keys: { pos: [{ t: 0, v: [2.6, 2.2, 0.6] }, { t: 1.1, v: [1.9, 0.3, 0.6], ease: 'bounce' }], scl: [{ t: 1, v: [0.6, 0.6, 0.6] }, { t: 1.12, v: [0.72, 0.48, 0.72] }, { t: 1.4, v: [0.6, 0.6, 0.6], ease: 'spring' }] } }));
    meshes.ball = { pos: ball.pos, idx: ball.idx, col: ball.col, mask: ball.mask, morphs: {}, skin: null };
    sc.camKeys = [{ t: 0, v: { target: [0.3, 1.1, 0], yaw: 0.35, pitch: 0.12, dist: 6.2, fov: 40 } }, { t: 4.2, v: { target: [0.1, 1.5, 0], yaw: -0.1, pitch: 0.08, dist: 4.2, fov: 40 }, ease: 'smooth' }, { t: 6, v: { target: [0.3, 1.1, 0], yaw: 0.35, pitch: 0.12, dist: 6.2, fov: 40 } }];
    sc.view = { target: [0.2, 1.1, 0], yaw: 0.45, pitch: 0.15, dist: 6, fov: 40 };
    return { scene: sc, meshes };
  }

  // ---------- start ----------
  window.Clayframe = { get scene() { return scene; }, setTime, setMode, get mode() { return mode; }, select: selectObj, addPrim, get sel() { return sel; }, MESH, cam, draw: () => { dirty = true; }, setPlaying, inp: touchInp, get lastEval() { return lastEval; }, openSheet };
  (async function init() {
    $('radius').value = brush.radius; $('strength').value = Math.round(brush.strength * 100);
    updSym();
    const cur = store.get('clayframe.current', null);
    let ok = false;
    if (cur) ok = await loadProject(cur).catch(() => false);
    if (!ok) { const dm = demo(); newProjectFrom(dm.scene, dm.meshes); setMode('pose'); }
    $('dur').textContent = scene.duration;
    resize(); updUndo(); renderTools(); renderTimeline();
    requestAnimationFrame(loop);
  })();
})();
