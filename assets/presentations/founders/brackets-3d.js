// Parte 4 en 3D: los corchetes de cada agente (las piezas de la marca: el diente de la portada y los
// corchetes metálicos de Precios). La pieza de Lucía pasa de un agente a otro y cada uno se cierra sobre ella.
import * as THREE from "three"

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
const W = 1160,
  H = 1080,
  OX = 760
const AG = {
  sofi: {
    name: "Sofi",
    role: "Agente de recepción",
    short: "recepción",
    c: "#4fc3d7",
    why: "De <i>sophía</i>, sabiduría: sabe todo de tu clínica y responde con tu tono.",
  },
  clio: {
    name: "Clío",
    role: "Agente clínico",
    short: "clínica",
    c: "#a6f0d8",
    why: "La musa de la <i>historia</i>: escribe la historia clínica mientras atiendes.",
  },
  argos: {
    name: "Argos",
    role: "Agente administrador",
    short: "administración",
    c: "#f5c46b",
    why: "El gigante de los <i>cien ojos</i>: ve toda tu clínica y no deja a nadie atrás.",
  },
}
const ORDER = ["sofi", "clio", "argos"]
const STORY = [
  {
    ag: "sofi",
    t: "vie 22:47",
    kind: "chat",
    ch: "Instagram · 22:47",
    msgs: [
      ["them", "¿Tienen cita el viernes? Me duele una muela"],
      ["us", "Hola, Lucía. Tengo el viernes a las 16:30 con la Dra. Ana. ¿Te la agendo?"],
    ],
    res: "Evaluación · vie 16:30",
    to: "Agenda",
    line: "atendió a Lucía por Instagram y agendó su evaluación",
  },
  {
    ag: "clio",
    t: "vie 16:52",
    kind: "note",
    ch: "En la consulta · Dra. Ana",
    lines: [
      ["Hallazgo", "Pieza 36, caries oclusal"],
      ["Diagnóstico", "CIE-10 · K02.1"],
      ["Plan", "Resina en pieza 36"],
    ],
    human: "La Dra. Ana confirmó",
    res: "Nota confirmada",
    to: "Historia",
    line: "escuchó la consulta y dejó la nota lista; la Dra. Ana la confirmó",
  },
  {
    ag: "sofi",
    t: "vie 17:10",
    kind: "chat",
    ch: "WhatsApp",
    msgs: [["us", "Te envío tu presupuesto: resina en pieza 36. ¿Lo revisas con calma?"]],
    res: "Presupuesto enviado",
    to: "Presupuestos",
    line: "le envió el presupuesto por WhatsApp",
  },
  {
    ag: "argos",
    t: "vie 09:00",
    kind: "alert",
    big: "7 días",
    sub: "sin respuesta al presupuesto",
    pass: "sofi",
    res: "7 días sin respuesta",
    to: "Le pasa el caso a Sofi",
    line: "vio 7 días sin respuesta y le pasó el caso a Sofi",
  },
  {
    ag: "sofi",
    t: "vie 09:02",
    kind: "chat",
    ch: "WhatsApp",
    msgs: [
      ["us", "Hola, Lucía. ¿Te ayudo a agendar tu tratamiento?"],
      ["them", "Sí, el jueves en la tarde"],
    ],
    res: "Tratamiento · jue 17:30",
    to: "Agenda",
    line: "retomó el presupuesto y Lucía agendó su tratamiento",
  },
  {
    ag: "argos",
    t: "jue 18:40",
    kind: "alert",
    big: "6 meses",
    sub: "su control queda listo para avisarle",
    res: "Control · abril",
    to: "Mensajes",
    line: "dejó listo su control de los 6 meses",
  },
]
const END = "Lucía empezó su tratamiento. Tu equipo intervino una vez: para confirmar lo clínico."
const STOP = Symbol("stop")
const el = (tag, cls, html) => {
  const d = document.createElement(tag)
  if (cls) d.className = cls
  if (html !== undefined) d.innerHTML = html
  return d
}
function piece(s) {
  const a = AG[s.ag]
  let h = `<div class="p4-pc">`
  if (s.kind === "chat")
    h +=
      `<span class="ch">${s.ch}</span>` +
      s.msgs.map(([w, t]) => `<div class="bub ${w}">${t}</div>`).join("")
  if (s.kind === "note")
    h +=
      `<span class="ch">${s.ch}</span>` +
      s.lines.map(([k, v]) => `<div class="ln"><b>${k}</b><span>${v}</span></div>`).join("") +
      `<span class="hum">✓ ${s.human}</span>`
  if (s.kind === "alert")
    h +=
      `<span class="ch">${a.name} vigila</span><span class="big">${s.big}</span><span class="sub">${s.sub}</span>` +
      (s.pass ? `<span class="pass">→ le pasa el caso a ${AG[s.pass].name}</span>` : "")
  return `${h}</div>`
}

/* ===== Piezas de la marca ===== */
// El diente de la portada (packages/brand-scene): supercuádrica con cúspides y raíz más angosta.
function toothGeo(kind) {
  const LAT = 30,
    LON = 36,
    E = 3.0,
    P = [],
    I = []
  const sm = (a, b, x) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)
  }
  for (let i = 0; i <= LAT; i++) {
    const th = (i / LAT) * Math.PI
    for (let j = 0; j <= LON; j++) {
      const ph = (j / LON) * Math.PI * 2
      const dx = Math.sin(th) * Math.cos(ph),
        dy = Math.cos(th),
        dz = Math.sin(th) * Math.sin(ph)
      const r = (Math.abs(dx) ** E + Math.abs(dy) ** E + Math.abs(dz) ** E) ** (-1 / E)
      let x = dx * r,
        y = dy * r,
        z = dz * r
      const root = sm(-0.1, 1, y),
        occ = sm(-0.45, -1, y)
      const tp = (1 - 0.32 * root ** 1.3) * (1 + 0.06 * Math.exp(-(((y + 0.35) / 0.35) ** 2)))
      x *= tp
      z *= tp
      if (kind === "inc") z *= 1 - 0.3 * occ
      if (kind === "can") y -= 0.24 * occ * Math.exp(-(x * x + z * z) / 0.18)
      if (kind === "pre") y += 0.13 * occ * Math.exp(-(z * z) / 0.05)
      if (kind === "mol") y += 0.17 * occ * Math.exp(-(x * x + z * z) / 0.14)
      P.push(x, y, z)
    }
  }
  for (let i = 0; i < LAT; i++)
    for (let j = 0; j < LON; j++) {
      const a = i * (LON + 1) + j,
        b = a + LON + 1
      I.push(a, b, a + 1, b, b + 1, a + 1)
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3))
  g.setIndex(I)
  g.computeVertexNormals()
  return g
}
// La supercuádrica de los corchetes de Precios (exponente 10).
function superGeo(E = 10, LAT = 22, LON = 28) {
  const P = [],
    N = [],
    I = []
  for (let i = 0; i <= LAT; i++) {
    const th = (i / LAT) * Math.PI
    for (let j = 0; j <= LON; j++) {
      const ph = (j / LON) * Math.PI * 2
      const dx = Math.sin(th) * Math.cos(ph),
        dy = Math.cos(th),
        dz = Math.sin(th) * Math.sin(ph)
      const r = (Math.abs(dx) ** E + Math.abs(dy) ** E + Math.abs(dz) ** E) ** (-1 / E)
      const x = dx * r,
        y = dy * r,
        z = dz * r
      const gx = Math.sign(x) * Math.abs(x) ** (E - 1),
        gy = Math.sign(y) * Math.abs(y) ** (E - 1),
        gz = Math.sign(z) * Math.abs(z) ** (E - 1)
      const l = Math.hypot(gx, gy, gz) || 1
      P.push(x, y, z)
      N.push(gx / l, gy / l, gz / l)
    }
  }
  for (let i = 0; i < LAT; i++)
    for (let j = 0; j < LON; j++) {
      const a = i * (LON + 1) + j,
        b = a + LON + 1
      I.push(a, b, a + 1, b, b + 1, a + 1)
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3))
  g.setIndex(I)
  return g
}
const VS = `varying vec3 vN; varying vec3 vW; varying float vY;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(transpose(inverse(modelMatrix))) * normal); vY = position.y; gl_Position = projectionMatrix * viewMatrix * w; }`
// Sombreado marfil de las 32 piezas; la luz de oclusión baja hacia las raíces.
const TOOTH_FS = `varying vec3 vN; varying vec3 vW; varying float vY; uniform vec3 uTint; uniform float uLit; uniform float uGlow;
void main(){ vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; vec3 v = normalize(cameraPosition - vW);
vec3 l1 = normalize(vec3(0.3,0.9,0.6)); vec3 l2 = normalize(vec3(-0.8,-0.2,-0.4));
float w1 = dot(n,l1)*0.5+0.5; float d1 = max(dot(n,l1),0.0); float d2 = max(dot(n,l2),0.0);
float fr = pow(1.0-max(dot(n,v),0.0),3.0); vec3 h = normalize(l1+v); float sp = pow(max(dot(n,h),0.0),40.0);
vec3 base = vec3(0.94,0.93,0.89); float ao = mix(1.0,0.7,smoothstep(0.15,1.0,vY));
vec3 col = base*(0.16+0.46*w1+0.3*d1)*ao + vec3(0.31,0.76,0.84)*d2*0.14 + vec3(0.85,0.95,1.0)*fr*0.26 + vec3(1.0)*sp*0.24;
col = mix(col, col*0.3+uTint*0.78, uLit*0.6); col = mix(col, uTint*1.2+vec3(0.12), uGlow);
gl_FragColor = vec4(col, 1.0); }`
const BRACKET_FS = `varying vec3 vN; varying vec3 vW; varying float vY; uniform vec3 uB; uniform float uG; uniform vec3 uGC;
void main(){ vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; vec3 v = normalize(cameraPosition - vW); vec3 r = reflect(-v, n);
float strip = smoothstep(0.75,0.98,1.0-abs(r.x-0.35))*smoothstep(0.0,0.6,r.y+0.3);
vec3 env = mix(vec3(0.02,0.07,0.09), vec3(0.62,0.9,0.96), smoothstep(-0.2,0.85,r.y)) + vec3(1.0)*strip*0.9;
vec3 l1 = normalize(vec3(-0.45,0.85,0.6)); float d1 = max(dot(n,l1),0.0); vec3 h = normalize(l1+v);
float sp = pow(max(dot(n,h),0.0),120.0); float fr = pow(1.0-max(dot(n,v),0.0),3.0);
vec3 col = uB*(0.1+0.3*d1) + env*uB*0.85 + vec3(0.8,0.97,1.0)*fr*0.35 + vec3(1.0)*sp*0.9; col += uGC*uG*0.5;
gl_FragColor = vec4(col, 1.0); }`
const lin = (hex) => {
  const c = new THREE.Color(hex)
  return new THREE.Vector3(c.r, c.g, c.b)
}
const V = (x, y, z) => new THREE.Vector3(x, y, z)

let ready = null
function build(layer) {
  const gl = layer.querySelector(".p4-gl"),
    ov = layer.querySelector(".p4-ov")
  const nowEl = layer.querySelector(".p4-now"),
    rowsEl = layer.querySelector(".p4-rows")
  const ctl = { run: 0, active: false, updaters: [] }
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  } catch {
    gl.appendChild(el("div", "p4-fail", "Este navegador no puede mostrar la escena 3D."))
    return null
  }
  renderer.setClearColor(0x000000, 0)
  renderer.setSize(W, H, false)
  gl.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 200)
  cam.position.set(0, 2.4, 17.5)
  cam.lookAt(0, 0.1, 0)
  const sq = superGeo(10)
  const glowTex = (() => {
    const c = document.createElement("canvas")
    c.width = c.height = 128
    const x = c.getContext("2d")
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, "rgba(255,255,255,1)")
    g.addColorStop(0.25, "rgba(255,255,255,.55)")
    g.addColorStop(1, "rgba(255,255,255,0)")
    x.fillStyle = g
    x.fillRect(0, 0, 128, 128)
    return new THREE.CanvasTexture(c)
  })()
  const anchors = []
  const anchor = (v, node) => {
    anchors.push({ v, node })
    ov.appendChild(node)
    return node
  }
  const unanchor = (node) => {
    const i = anchors.findIndex((a) => a.node === node)
    if (i >= 0) anchors.splice(i, 1)
    node.remove()
  }
  const tween = (ms, f) => {
    const id = ctl.run
    return new Promise((res, rej) => {
      const t0 = performance.now(),
        D = reduce ? 1 : ms
      const go = (now) => {
        if (id !== ctl.run) return rej(STOP)
        const p = Math.min(1, (now - t0) / D)
        f(p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2, p)
        if (p < 1) requestAnimationFrame(go)
        else res()
      }
      requestAnimationFrame(go)
    })
  }
  const sleep = (ms) => {
    const id = ctl.run
    return new Promise((res, rej) =>
      setTimeout(() => (id === ctl.run ? res() : rej(STOP)), reduce ? Math.min(ms, 60) : ms),
    )
  }
  const arc = (a, b, lift) => {
    const mid = a.clone().add(b).multiplyScalar(0.5)
    mid.y += lift
    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone())
  }
  const trail = (curve, color) => {
    const m = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 80, 0.024, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }),
    )
    scene.add(m)
    return m
  }
  function brackets(color) {
    const g = new THREE.Group()
    scene.add(g)
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: BRACKET_FS,
      side: THREE.DoubleSide,
      uniforms: {
        uB: { value: lin(color).multiplyScalar(0.95) },
        uG: { value: 0 },
        uGC: { value: lin(color) },
      },
    })
    const sides = []
    for (const side of [-1, 1]) {
      const s = new THREE.Group()
      g.add(s)
      for (const q of [
        { p: [0, 0, 0], s: [0.085, 1.25, 0.13] },
        { p: [-side * 0.28, 1.165, 0], s: [0.365, 0.085, 0.13] },
        { p: [-side * 0.28, -1.165, 0], s: [0.365, 0.085, 0.13] },
      ]) {
        const m = new THREE.Mesh(sq, mat)
        m.position.set(...q.p)
        m.scale.set(...q.s)
        s.add(m)
      }
      sides.push({ s, side })
    }
    g.scale.setScalar(0.62)
    const st = { gap: 2.25, target: 2.25, glow: 0, glowTarget: 0, g }
    ctl.updaters.push(() => {
      st.gap += (st.target - st.gap) * (reduce ? 1 : 0.08)
      st.glow += (st.glowTarget - st.glow) * 0.08
      sides.forEach(({ s, side }) => {
        s.position.x = side * st.gap
      })
      mat.uniforms.uG.value = st.glow
    })
    return st
  }

  const POS = { sofi: V(-2.9, 0, 0.7), clio: V(0, 0.55, -1.5), argos: V(2.9, 0, 0.7) }
  const BR = {},
    LAB = {},
    CH = {}
  for (const k of ORDER) {
    const b = brackets(AG[k].c)
    b.g.position.copy(POS[k])
    b.g.lookAt(cam.position.x * 0.3, POS[k].y, cam.position.z)
    BR[k] = b
    LAB[k] = anchor(
      POS[k].clone().add(V(0, 1.38, 0)),
      el("div", "p4-lab hide", `<b>${AG[k].name}</b><span>${AG[k].short}</span>`),
    )
    LAB[k].style.setProperty("--c", AG[k].c)
    CH[k] = anchor(POS[k].clone().add(V(0, -1.05, 0)), el("div", "p4-chips"))
  }
  // La muela de Lucía, con el sombreado marfil de la marca.
  // La pieza de Lucía es un premolar de la portada, con sus mismas proporciones y de pie (corona arriba).
  const toothMat = new THREE.ShaderMaterial({
    vertexShader: VS,
    fragmentShader: TOOTH_FS,
    side: THREE.DoubleSide,
    uniforms: { uTint: { value: lin(AG.sofi.c) }, uLit: { value: 0 }, uGlow: { value: 0 } },
  })
  const lucia = new THREE.Mesh(toothGeo("pre"), toothMat)
  const S = 1.5
  lucia.scale.set(0.46 * 0.5 * S, -0.82 * 0.5 * S, 0.54 * 0.5 * S)
  scene.add(lucia)
  const lucLab = anchor(V(0, 0, 0), el("div", "p4-lab small", `<b>Lucía</b><span>su caso</span>`))
  lucLab.style.setProperty("--c", "#f1f5f9")
  const lucA = anchors[anchors.length - 1]
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: new THREE.Color("#ffffff"),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    }),
  )
  halo.scale.setScalar(1.8)
  scene.add(halo)
  const START = V(-6.0, -0.3, 2.4)
  const trails = []
  let at = null
  ctl.updaters.push((t) => {
    lucia.rotation.y = reduce ? 0.5 : 0.5 + Math.sin(t * 0.5) * 0.6
    lucia.rotation.x = 0
    halo.position.copy(lucia.position)
    lucA.v.copy(lucia.position).add(V(0, -0.85, 0))
    lucLab.style.opacity = at ? "0" : "1"
  })

  async function moveTo(k, ms = 1300, lift = 1.6) {
    const from = lucia.position.clone(),
      to = POS[k].clone()
    if (at) {
      BR[at].target = 2.25
      BR[at].glowTarget = 0.15
    }
    const curve = arc(from, to, lift)
    await tween(ms, (e) => lucia.position.copy(curve.getPoint(e)))
    trails.push(trail(curve, AG[k].c))
    at = k
    BR[k].target = 1.5
    BR[k].glowTarget = 1
    toothMat.uniforms.uTint.value = lin(AG[k].c)
    await tween(400, (e) => {
      toothMat.uniforms.uLit.value = e * 0.75
    })
    halo.material.color.set(AG[k].c)
    halo.material.opacity = 0.45
  }
  const chip = (k, text) => {
    const n = el("div", "p4-chip", `<i>✓</i>${text}`)
    n.style.setProperty("--c", AG[k].c)
    CH[k].appendChild(n)
  }
  const setNow = (html, c) => {
    nowEl.style.setProperty("--c", c)
    nowEl.innerHTML = ""
    nowEl.appendChild(el("div", "", html))
  }
  const addRow = (s) => {
    const a = AG[s.ag]
    const r = el(
      "div",
      "p4-row",
      `<span class="t">${s.t}</span><span class="w"><b>${a.name}</b> ${s.line}</span><span class="to">→ ${s.to}</span>`,
    )
    r.style.setProperty("--c", a.c)
    rowsEl.prepend(r)
    while (rowsEl.children.length > 3) rowsEl.lastChild.remove()
  }
  function reset() {
    trails.splice(0).forEach((m) => {
      scene.remove(m)
      m.geometry.dispose()
    })
    for (const k of ORDER) {
      BR[k].target = 2.25
      BR[k].glowTarget = 0
      LAB[k].className = "p4-lab hide"
      CH[k].innerHTML = ""
    }
    lucia.position.copy(START)
    toothMat.uniforms.uLit.value = 0
    toothMat.uniforms.uGlow.value = 0
    halo.material.opacity = 0
    at = null
    for (const n of ov.querySelectorAll(".p4-pass")) unanchor(n)
    rowsEl.innerHTML = ""
  }
  async function play() {
    const id = ++ctl.run
    try {
      reset()
      setNow(
        `<span class="who">Tus agentes</span><p class="txt">Tres agentes de IA trabajan en tu clínica, alrededor de cada paciente.</p>`,
        "#f1f5f9",
      )
      await sleep(1400)
      for (const k of ORDER) {
        const a = AG[k]
        setNow(
          `<span class="who">${a.role}</span><span class="name">${a.name}</span><p class="why">${a.why}</p>`,
          a.c,
        )
        LAB[k].className = "p4-lab"
        BR[k].glowTarget = 0.9
        await sleep(600)
        BR[k].glowTarget = 0.15
        await sleep(1300)
      }
      for (let i = 0; i < STORY.length; i++) {
        const s = STORY[i],
          a = AG[s.ag]
        setNow(
          `<span class="who">${s.t} · ${a.name}</span><p class="txt"><b>${a.name}</b> ${s.line}.</p>${piece(s)}`,
          a.c,
        )
        if (i === 4) {
          BR.sofi.target = 1.35
          await sleep(400)
          BR.sofi.target = 1.5
        } else await moveTo(s.ag)
        await sleep(500)
        chip(s.ag, s.res)
        if (s.pass) {
          await sleep(900)
          const p = anchor(
            arc(POS.argos, POS.sofi, 2.6).getPoint(0.5),
            el("div", "p4-pass", "le pasa el caso a Sofi"),
          )
          await moveTo("sofi", 1700, 2.6)
          await sleep(700)
          unanchor(p)
        }
        addRow(s)
        await sleep(1600)
      }
      if (at) BR[at].target = 2.25
      const curve = arc(lucia.position.clone(), V(0, -0.9, 2.6), 1.2)
      await tween(1300, (e) => lucia.position.copy(curve.getPoint(e)))
      for (const k of ORDER) BR[k].glowTarget = 0.7
      toothMat.uniforms.uTint.value = lin("#a6f0d8")
      await tween(700, (e) => {
        toothMat.uniforms.uGlow.value = e * 0.3
      })
      setNow(`<span class="who">Fin del recorrido</span><p class="txt">${END}</p>`, "#f1f5f9")
      await sleep(8000)
      if (id === ctl.run) play()
    } catch (e) {
      if (e !== STOP) throw e
    }
  }
  const v3 = new THREE.Vector3()
  const tick = (now) => {
    if (!ctl.active) return
    requestAnimationFrame(tick)
    for (const f of ctl.updaters) f(now / 1000)
    renderer.render(scene, cam)
    for (const a of anchors) {
      v3.copy(a.v).project(cam)
      a.node.style.left = `${(OX + ((v3.x + 1) / 2) * W).toFixed(1)}px`
      a.node.style.top = `${(((1 - v3.y) / 2) * H).toFixed(1)}px`
    }
  }
  const fit = () => {
    const st = layer.closest(".stage")
    const k = st ? st.getBoundingClientRect().width / 1920 : 1
    renderer.setPixelRatio(Math.max(0.75, Math.min(2, (window.devicePixelRatio || 1) * k)))
    renderer.setSize(W, H, false)
  }
  addEventListener("resize", fit)
  return {
    start() {
      fit()
      ctl.active = true
      requestAnimationFrame(tick)
      play()
    },
    stop() {
      ctl.run++
      ctl.active = false
    },
  }
}
window.Part4 = {
  start(layer) {
    ready = ready || build(layer)
    ready?.start()
  },
  stop() {
    ready?.stop()
  },
}
dispatchEvent(new Event("part4-ready"))
