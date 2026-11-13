/* Clayframe renderer: WebGL2, matcap shading (like most sculpting apps), GPU skinning, a ground grid. */
window.CRender = (function () {
  'use strict';
  const { v3, m4 } = window.CM;

  const SKIN = `
    vec4 p = vec4(aPos, 1.0); vec3 n = aNor;
    if (uSkin) {
      mat4 s = uBones[int(aBi.x)] * aBw.x + uBones[int(aBi.y)] * aBw.y + uBones[int(aBi.z)] * aBw.z + uBones[int(aBi.w)] * aBw.w;
      p = s * p; n = mat3(s) * n;
    }`;
  const VS = `#version 300 es
  precision highp float;
  in vec3 aPos; in vec3 aNor; in vec4 aCol; in vec4 aBi; in vec4 aBw;
  uniform mat4 uModel, uView, uProj, uLightVP; uniform mat4 uBones[48]; uniform bool uSkin;
  out vec3 vN; out vec3 vP; out vec4 vC; out vec3 vW; out vec3 vNW; out vec4 vL;
  void main() {` + SKIN + `
    mat4 mv = uView * uModel;
    vec4 vp = mv * p, wp = uModel * p;
    vP = vp.xyz; vW = wp.xyz;
    vN = normalize(transpose(inverse(mat3(mv))) * n);
    vNW = normalize(transpose(inverse(mat3(uModel))) * n);
    vL = uLightVP * wp;
    vC = aCol;
    gl_Position = uProj * vp;
  }`;
  const FS = `#version 300 es
  precision highp float; precision highp sampler2DShadow;
  in vec3 vN; in vec3 vP; in vec4 vC; in vec3 vW; in vec3 vNW; in vec4 vL;
  uniform sampler2D uMat; uniform sampler2DShadow uShadow;
  uniform vec3 uColor; uniform bool uFlat; uniform float uSel; uniform vec3 uAccent; uniform float uAlpha; uniform vec4 uTint;
  uniform int uMode; uniform vec3 uLight, uEye, uSky, uGround; uniform vec4 uMat4; uniform bool uShadowOn; uniform vec3 uGC; uniform float uGR;
  out vec4 o;
  float shadowAt() {
    if (!uShadowOn) return 1.0;
    vec3 c = vL.xyz / vL.w * 0.5 + 0.5;
    if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
    float s = 0.0; vec2 tx = vec2(1.0 / 2048.0);
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) s += texture(uShadow, vec3(c.xy + vec2(x, y) * tx * 1.5, c.z - 0.0015));
    return s / 9.0;
  }
  vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  void main() {
    vec3 base = uColor * vC.rgb;
    if (uMode == 0) {
      vec3 n = uFlat ? normalize(cross(dFdx(vP), dFdy(vP))) : normalize(vN);
      if (!uFlat && !gl_FrontFacing) n = -n;
      vec3 vd = normalize(-vP);
      vec3 x = normalize(vec3(vd.z, 0.0, -vd.x)), y = cross(vd, x);
      vec2 uv = vec2(dot(x, n), dot(y, n)) * 0.495 + 0.5;
      vec3 c = texture(uMat, vec2(uv.x, 1.0 - uv.y)).rgb * base;
      c *= mix(1.0, 0.32, vC.a);
      c += uAccent * pow(1.0 - abs(dot(n, vd)), 3.0) * uSel * 0.7;
      o = vec4(mix(c, uTint.rgb, uTint.a), uAlpha);
      return;
    }
    vec3 n = uFlat ? normalize(cross(dFdx(vW), dFdy(vW))) : normalize(vNW);
    if (!uFlat && !gl_FrontFacing) n = -n;
    vec3 V = normalize(uEye - vW), L = normalize(uLight), H = normalize(L + V);
    float sh = shadowAt();
    if (uMode == 2) {
      // the floor: catches shadows and fades out towards the edge
      float d = length(vW.xz - uGC.xz) / uGR;
      vec3 g = base * (0.55 + 0.45 * sh);
      o = vec4(aces(g * 1.15), (1.0 - smoothstep(0.35, 1.0, d)) * uAlpha);
      return;
    }
    float rough = uMat4.x, spec = uMat4.y, metal = uMat4.z, toon = uMat4.w;
    float ndl = dot(n, L);
    float diff = toon > 0.5 ? (ndl > 0.4 ? 1.0 : ndl > 0.0 ? 0.6 : 0.25) : max(ndl, 0.0);
    if (rough > 0.45 && rough < 0.55) diff = max((ndl + 0.35) / 1.35, 0.0);
    float shin = mix(180.0, 8.0, rough);
    float sp = pow(max(dot(n, H), 0.0), shin) * spec * (shin + 8.0) / 60.0;
    vec3 hemi = mix(uGround, uSky, n.y * 0.5 + 0.5);
    vec3 c = base * (hemi * 0.42 + vec3(1.0, 0.96, 0.9) * diff * sh * 0.82);
    c = mix(c, base * (hemi * 0.4 + sp * sh * 2.0), metal) + (1.0 - metal) * vec3(sp * sh);
    c += uSky * pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.12;
    if (toon > 0.5) c = mix(c, vec3(0.0), smoothstep(0.35, 0.2, dot(n, V)));
    c = aces(c * 0.95);
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 1.12);
    c += uAccent * pow(1.0 - abs(dot(n, V)), 3.0) * uSel * 0.5;
    o = vec4(mix(c, uTint.rgb, uTint.a), uAlpha);
  }`;
  const SVS = `#version 300 es
  in vec3 aPos; in vec3 aNor; in vec4 aCol; in vec4 aBi; in vec4 aBw;
  uniform mat4 uModel, uLightVP; uniform mat4 uBones[48]; uniform bool uSkin;
  void main() {` + SKIN + `
    gl_Position = uLightVP * uModel * p;
  }`;
  const SFS = `#version 300 es
  precision mediump float; out vec4 o; void main() { o = vec4(1.0); }`;
  const LVS = `#version 300 es
  in vec3 aPos; uniform mat4 uVP; void main() { gl_Position = uVP * vec4(aPos, 1.0); }`;
  const LFS = `#version 300 es
  precision mediump float; uniform vec4 uC; out vec4 o; void main() { o = uC; }`;
  // how each material looks in the lit render: roughness, shine, metal, toon
  const LIT = { clay: [0.75, 0.12, 0, 0], glossy: [0.18, 0.7, 0, 0], wax: [0.5, 0.3, 0, 0], toon: [0.6, 0.2, 0, 1], metal: [0.3, 0.9, 1, 0], rim: [0.6, 0.25, 0, 0] };

  function prog(gl, vs, fs) {
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aNor'); gl.bindAttribLocation(p, 2, 'aCol'); gl.bindAttribLocation(p, 3, 'aBi'); gl.bindAttribLocation(p, 4, 'aBw');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  // ---------- matcaps, drawn procedurally ----------
  const MATCAPS = {
    clay: { label: 'Clay' }, glossy: { label: 'Glossy' }, wax: { label: 'Wax' }, toon: { label: 'Toon' }, metal: { label: 'Metal' }, rim: { label: 'Rim light' }
  };
  function matcapPixels(kind, S) {
    const d = new Uint8Array(S * S * 4), L = v3.norm([-0.55, 0.7, 0.6]), H = v3.norm(v3.add(L, [0, 0, 1]));
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = (i + 0.5) / S * 2 - 1, y = 1 - (j + 0.5) / S * 2, r2 = x * x + y * y;
      const k = Math.min(r2, 0.999), n = [x, y, Math.sqrt(1 - k)];
      const nl = Math.max(0, v3.dot(n, L)), nh = Math.max(0, v3.dot(n, H)), rim = Math.pow(1 - n[2], 2.2), amb = 0.5 + 0.5 * n[1];
      let c;
      switch (kind) {
        case 'glossy': { const s = Math.pow(nh, 70) * 0.9; c = [0.12 + 0.62 * nl + 0.18 * amb + s, 0.12 + 0.62 * nl + 0.18 * amb + s, 0.13 + 0.62 * nl + 0.2 * amb + s]; break; }
        case 'wax': { const sss = 0.25 * Math.pow(1 - Math.abs(v3.dot(n, L)), 2); const s = Math.pow(nh, 30) * 0.25; c = [0.2 + 0.6 * nl + 0.15 * amb + sss + s, 0.16 + 0.56 * nl + 0.12 * amb + sss * 0.6 + s, 0.15 + 0.5 * nl + 0.1 * amb + sss * 0.5 + s]; break; }
        case 'toon': { const b = nl > 0.65 ? 1 : nl > 0.25 ? 0.68 : 0.4; const line = r2 > 0.86 ? 0.25 : 1; const s = nh > 0.97 ? 0.25 : 0; c = [b * line + s, b * line + s, b * line + s]; break; }
        case 'metal': { const ry = n[1] * 0.9 + n[0] * 0.1; const env = ry > 0.1 ? 0.75 + 0.25 * ry : ry > -0.05 ? 0.25 : 0.42 + 0.3 * (ry + 1) * 0.5; const s = Math.pow(nh, 120); c = [env * 0.92 + s, env * 0.94 + s, env + s]; break; }
        case 'rim': { const s = Math.pow(nh, 40) * 0.3; c = [0.08 + 0.5 * nl + 0.1 * amb + rim * 0.35 + s, 0.1 + 0.5 * nl + 0.1 * amb + rim * 0.55 + s, 0.12 + 0.5 * nl + 0.12 * amb + rim * 0.75 + s]; break; }
        default: { const s = Math.pow(nh, 22) * 0.12; c = [0.2 + 0.62 * nl + 0.22 * amb + s, 0.19 + 0.6 * nl + 0.21 * amb + s, 0.18 + 0.57 * nl + 0.21 * amb + s]; }
      }
      const o = (j * S + i) * 4;
      d[o] = Math.min(255, c[0] * 255); d[o + 1] = Math.min(255, c[1] * 255); d[o + 2] = Math.min(255, c[2] * 255); d[o + 3] = 255;
    }
    return d;
  }
  // a small picture of a matcap, for buttons
  function matcapPreview(kind, size) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d'), img = x.createImageData(size, size), d = matcapPixels(kind, size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) { const o = (j * size + i) * 4, xx = (i + 0.5) / size * 2 - 1, yy = (j + 0.5) / size * 2 - 1; const inside = xx * xx + yy * yy <= 1; img.data.set(inside ? [d[o], d[o + 1], d[o + 2], 255] : [0, 0, 0, 0], o); }
    x.putImageData(img, 0, 0);
    return c;
  }

  function normalsFor(pos, idx) {
    const nr = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      nr[a] += nx; nr[a + 1] += ny; nr[a + 2] += nz; nr[b] += nx; nr[b + 1] += ny; nr[b + 2] += nz; nr[c] += nx; nr[c + 1] += ny; nr[c + 2] += nz;
    }
    for (let i = 0; i < nr.length; i += 3) { const l = Math.hypot(nr[i], nr[i + 1], nr[i + 2]) || 1; nr[i] /= l; nr[i + 1] /= l; nr[i + 2] /= l; }
    return nr;
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return null;
    const P = prog(gl, VS, FS), L = prog(gl, LVS, LFS), SP = prog(gl, SVS, SFS);
    const tex = {};
    function matTex(kind) {
      if (tex[kind]) return tex[kind];
      const t = gl.createTexture(), S = 256;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, matcapPixels(kind, S));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return (tex[kind] = t);
    }
    // shadow map
    const SH = 2048, shTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SH, SH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const shFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shFB); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shTex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GPU copies of meshes
    const gpu = new Map();
    function buf(target, data, usage) { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage || gl.DYNAMIC_DRAW); return b; }
    function sync(id, mesh, display, skin, colOverride, colKey) {
      let g = gpu.get(id);
      const n = mesh.pos.length / 3;
      if (!g || g.topo !== mesh.topoVer || g.mesh !== mesh) {
        if (g) free(g);
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const col = new Float32Array(n * 4);
        const bp = buf(gl.ARRAY_BUFFER, mesh.pos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        const bn = buf(gl.ARRAY_BUFFER, mesh.nor); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        const bc = buf(gl.ARRAY_BUFFER, col); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
        const bi = buf(gl.ARRAY_BUFFER, new Float32Array(n * 4)); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
        const bw = buf(gl.ARRAY_BUFFER, new Float32Array(n * 4)); gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 0, 0);
        const bx = buf(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        g = { vao, bufs: [bp, bn, bc, bi, bw, bx], count: mesh.idx.length, topo: mesh.topoVer, mesh, ver: -1, cver: -1, ckey: null, skin: null, skinVer: -1, disp: null, colArr: col, wire: null };
        gpu.set(id, g);
      }
      if (g.ver !== mesh.ver || g.disp !== (display || null)) {
        const Pp = display || mesh.pos, N = display ? normalsFor(display, mesh.idx) : mesh.nor;
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[0]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, Pp);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[1]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, N);
        g.ver = mesh.ver; g.disp = display || null;
      }
      if (colOverride) {
        if (g.ckey !== colKey) { gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[2]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, colOverride); g.ckey = colKey; g.cver = -1; }
      } else if (g.cver !== mesh.cver || g.ckey) {
        const c = g.colArr; for (let i = 0; i < n; i++) { c[i * 4] = mesh.col[i * 3]; c[i * 4 + 1] = mesh.col[i * 3 + 1]; c[i * 4 + 2] = mesh.col[i * 3 + 2]; c[i * 4 + 3] = mesh.mask[i]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[2]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c);
        g.cver = mesh.cver; g.ckey = null;
      }
      if (skin && (g.skin !== skin || g.skinVer !== (skin.ver || 0)) && skin.bi.length === n * 4) {
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[3]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, skin.bi);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[4]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, skin.bw);
        g.skin = skin; g.skinVer = skin.ver || 0;
      }
      return g;
    }
    function free(g) { gl.deleteVertexArray(g.vao); g.bufs.forEach(b => gl.deleteBuffer(b)); if (g.wire) { gl.deleteVertexArray(g.wire.vao); gl.deleteBuffer(g.wire.buf); } }
    function drop(id) { const g = gpu.get(id); if (g) { free(g); gpu.delete(id); } }
    function wireOf(g) {
      if (g.wire) return g.wire;
      const m = g.mesh, e = [];
      for (let i = 0; i < m.pos.length / 3; i++) for (let k = m.nbStart[i]; k < m.nbStart[i + 1]; k++) if (m.nb[k] > i) e.push(i, m.nb[k]);
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[0]); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const b = buf(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(e), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return (g.wire = { vao, buf: b, count: e.length });
    }
    // grid and floor
    const gridData = []; const N = 10, step = 0.5;
    for (let i = -N; i <= N; i++) { if (i === 0) continue; gridData.push(i * step, 0, -N * step, i * step, 0, N * step, -N * step, 0, i * step, N * step, 0, i * step); }
    const gridBuf = buf(gl.ARRAY_BUFFER, new Float32Array(gridData), gl.STATIC_DRAW);
    const axisBuf = buf(gl.ARRAY_BUFFER, new Float32Array([-N * step, 0, 0, N * step, 0, 0, 0, 0, -N * step, 0, 0, N * step]), gl.STATIC_DRAW);
    const lineVao = gl.createVertexArray();
    function lines(b, count, vp, c, from) {
      gl.useProgram(L.p); gl.bindVertexArray(lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(L.u.uVP, false, vp); gl.uniform4fv(L.u.uC, c);
      gl.drawArrays(gl.LINES, from || 0, count);
    }
    const floor = window.CMesh ? window.CMesh.plane(1) : null;
    const ident = new Float32Array(16 * 48);
    for (let i = 0; i < 48; i++) ident.set(m4.id(), i * 16);
    const ortho = (l, r, b, t, n, f) => [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1];
    // items: [{ id, mesh, display, skin, bones, model, color, matcap, flat, selected, alpha, tint, wire, colOverride, colKey }]
    // opt: { bg, grid, lit, ground, groundY, scene: { c, r } }
    function draw(items, cam, opt) {
      const w = canvas.width, h = canvas.height;
      const lit = !!opt.lit;
      let lightVP = m4.id(), Ldir = v3.norm([-0.45, 1, 0.55]);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
      items.forEach(it => { it.g = sync(it.id, it.mesh, it.display, it.skin, it.colOverride, it.colKey); });
      if (lit) {
        const c = opt.scene ? opt.scene.c : [0, 0.8, 0], R = Math.max(1.5, opt.scene ? opt.scene.r * 1.25 : 3);
        const eye = v3.add(c, v3.scale(Ldir, R * 2.5));
        lightVP = m4.mul(ortho(-R, R, -R, R, 0.05, R * 5), m4.lookAt(eye, c, Math.abs(Ldir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]));
        gl.bindFramebuffer(gl.FRAMEBUFFER, shFB); gl.viewport(0, 0, SH, SH);
        gl.clear(gl.DEPTH_BUFFER_BIT); gl.disable(gl.BLEND);
        gl.useProgram(SP.p); gl.uniformMatrix4fv(SP.u.uLightVP, false, lightVP);
        for (const it of items) {
          if ((it.alpha != null && it.alpha < 1) || it.noShadow) continue;
          gl.uniformMatrix4fv(SP.u.uModel, false, it.model); gl.uniform1i(SP.u.uSkin, it.bones ? 1 : 0); gl.uniformMatrix4fv(SP.u.uBones, false, it.bones || ident);
          gl.bindVertexArray(it.g.vao); gl.drawElements(gl.TRIANGLES, it.g.count, gl.UNSIGNED_INT, 0);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, w, h);
      const bg = opt.bg || [0.16, 0.16, 0.18];
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const vp = m4.mul(cam.proj, cam.view);
      if (opt.grid && !lit) {
        gl.depthMask(false);
        lines(gridBuf, gridData.length / 3, vp, [1, 1, 1, 0.07]);
        lines(axisBuf, 2, vp, [0.9, 0.3, 0.3, 0.45], 0); lines(axisBuf, 2, vp, [0.3, 0.5, 0.95, 0.45], 2);
        gl.depthMask(true);
      }
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uView, false, cam.view); gl.uniformMatrix4fv(P.u.uProj, false, cam.proj); gl.uniformMatrix4fv(P.u.uLightVP, false, lightVP);
      gl.uniform3fv(P.u.uAccent, [0.35, 0.75, 1.0]);
      gl.uniform3fv(P.u.uLight, Ldir); gl.uniform3fv(P.u.uEye, cam.eye);
      const sky = opt.sky || [0.75, 0.82, 0.95], gnd = opt.groundCol || [0.42, 0.36, 0.32];
      gl.uniform3fv(P.u.uSky, sky); gl.uniform3fv(P.u.uGround, v3.scale(gnd, 0.9));
      gl.uniform1i(P.u.uShadowOn, lit ? 1 : 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shTex); gl.uniform1i(P.u.uShadow, 1);
      gl.activeTexture(gl.TEXTURE0); gl.uniform1i(P.u.uMat, 0);
      const one = it => {
        const g = it.g;
        gl.bindTexture(gl.TEXTURE_2D, matTex(it.matcap || 'clay'));
        gl.uniform1i(P.u.uMode, it.mode != null ? it.mode : lit ? 1 : 0);
        gl.uniform4fv(P.u.uMat4, LIT[it.matcap] || LIT.clay);
        gl.uniformMatrix4fv(P.u.uModel, false, it.model);
        gl.uniform3fv(P.u.uColor, it.color);
        gl.uniform1i(P.u.uFlat, it.flat ? 1 : 0);
        gl.uniform1f(P.u.uSel, it.selected ? 1 : 0);
        gl.uniform1f(P.u.uAlpha, it.alpha == null ? 1 : it.alpha);
        gl.uniform4fv(P.u.uTint, it.tint || [0, 0, 0, 0]);
        gl.uniform1i(P.u.uSkin, it.bones ? 1 : 0);
        gl.uniformMatrix4fv(P.u.uBones, false, it.bones || ident);
        gl.bindVertexArray(g.vao);
        if (it.wire) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); }
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
        if (it.wire) {
          gl.disable(gl.POLYGON_OFFSET_FILL);
          const W = wireOf(g);
          gl.useProgram(L.p); gl.bindVertexArray(W.vao);
          gl.uniformMatrix4fv(L.u.uVP, false, m4.mul(vp, it.model)); gl.uniform4fv(L.u.uC, [0, 0, 0, 0.28]);
          gl.drawElements(gl.LINES, W.count, gl.UNSIGNED_INT, 0);
          gl.useProgram(P.p);
        }
      };
      items.filter(it => !(it.alpha < 1)).forEach(one);
      if (lit && opt.ground && floor) {
        const c = opt.scene ? opt.scene.c : [0, 0, 0], R = Math.max(6, (opt.scene ? opt.scene.r : 3) * 4);
        const g = sync('__floor', floor, null, null);
        gl.uniform3fv(P.u.uGC, c); gl.uniform1f(P.u.uGR, R);
        gl.depthMask(false);
        one({ g, model: m4.trs([c[0], opt.groundY || 0, c[2]], [0, 0, 0, 1], [R * 2, 1, R * 2]), color: opt.ground, matcap: 'clay', mode: 2, alpha: 1 });
        gl.depthMask(true);
      }
      const ghosts = items.filter(it => it.alpha < 1);
      if (ghosts.length) { gl.depthMask(false); ghosts.forEach(one); gl.depthMask(true); }
      gl.bindVertexArray(null);
    }
    return { gl, draw, drop, matcapPreview };
  }

  // orbit camera → matrices, and screen ↔ world helpers
  function camera(c, w, h) {
    const cp = Math.cos(c.pitch), eye = v3.add(c.target, [c.dist * cp * Math.sin(c.yaw), c.dist * Math.sin(c.pitch), c.dist * cp * Math.cos(c.yaw)]);
    const view = m4.lookAt(eye, c.target, [0, 1, 0]);
    const proj = m4.perspective((c.fov || 40) * Math.PI / 180, w / h, Math.max(0.01, c.dist * 0.01), c.dist * 60 + 100);
    const vp = m4.mul(proj, view), ivp = m4.inv(vp);
    return {
      eye, view, proj, vp, w, h,
      project: p => { const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13], ww = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]; return [(x / ww * 0.5 + 0.5) * w, (0.5 - y / ww * 0.5) * h, ww]; },
      ray: (sx, sy) => { const nx = sx / w * 2 - 1, ny = 1 - sy / h * 2; const a = m4.point(ivp, [nx, ny, -1]), b = m4.point(ivp, [nx, ny, 1]); return { o: a, d: v3.norm(v3.sub(b, a)) }; },
      // world units per screen pixel at a given depth
      pxSize: p => { const d = v3.dist(eye, p); return 2 * d * Math.tan((c.fov || 40) * Math.PI / 360) / h; }
    };
  }
  return { create, camera, MATCAPS, matcapPreview, normalsFor };
})();
