// La v2 de la presentación (/presentacion/fundadores?v2): una clínica en maqueta llena de gente que se puede
// tocar. Cada momento es un tema y con qué trabaja la clínica: hoy, con un chatbot, con un CRM o con odentIA.
// Lo que pasa lo decide clinic-sim.js, lo que se lee está en clinic-slide.html y esto solo lo dibuja y atiende
// los clics. Se carga solo cuando hace falta (deck.js), así la v1 no la baja.
//
// La gente va en mallas instanciadas para que sean muchas sin frenar un computador común; sus sombras
// son una proyección sobre el piso. Los muebles proyectan una sombra que no cambia, así no se recalcula en
// cada cuadro. Los agentes nunca tocan nada físico ni ocupan la silla de nadie.
import * as THREE from "three"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { AGENDA_HUECOS, createSim, EQUIPO, PANTALLAS } from "./clinic-sim.js"

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
const W = 1920
const H = 1080
/** La maqueta va a la derecha del texto, sin deformarla: se corre la imagen, no la cámara. */
const SHIFT_X = 318
const SHIFT_Y = 26
const STOP = Symbol("stop")
const COLOR = { sofi: "#4fc3d7", clio: "#a6f0d8", argos: "#f5c46b" }
/** Las figuras que no son del equipo: los agentes y, con su propio gris, el chatbot. */
const FIGURES = { ...COLOR, bot: "#a9b8bd" }
const CARD_COLOR = { sky: "var(--sky)", mint: "var(--mint)", amber: "var(--amber)" }
const V = (x, y, z) => new THREE.Vector3(x, y, z)
const damp = (cur, tar, rate, dt) => cur + (tar - cur) * (1 - Math.exp(-rate * dt))
const clamp = (x, min, max) => Math.min(max, Math.max(min, x))
const clamp01 = (x) => clamp(x, 0, 1)

const CAM = V(6.2, 20.2, 25.4)
const LOOK = V(-0.35, 0, 0.75)
const PERSON_SCALE = 1.06

/* ===== La luz de cada momento ===== */
const LIGHT = {
  noche: { hemi: 0.85, sky: "#6f8ea6", ground: "#0f2029", key: 0.7, keyC: "#8fafc8" },
  sin: { hemi: 1.75, sky: "#a9bac6", ground: "#2a3c44", key: 1.55, keyC: "#c3d3e0" },
  con: { hemi: 2.1, sky: "#f4f3ec", ground: "#555f5c", key: 2.6, keyC: "#fff1de" },
  recupera: { hemi: 2.2, sky: "#f7f2e6", ground: "#5a5e55", key: 2.75, keyC: "#ffeed6" },
  fin: { hemi: 2.35, sky: "#fff7ea", ground: "#615f52", key: 3, keyC: "#ffe9ca" },
}

/* ===== Lo que hace el cuerpo: lo decide la simulación por su nombre ===== */
const POSE_KEYS = [
  "sit",
  "spine",
  "head",
  "la",
  "le",
  "lz",
  "ra",
  "re",
  "rz",
  "tap",
  "jit",
  "wave",
  "shake",
]
const base = {
  sit: 0,
  spine: 0,
  head: 0.02,
  la: 0.08,
  le: 0.16,
  lz: 0.05,
  ra: 0.08,
  re: 0.16,
  rz: 0.05,
  tap: 0,
  jit: 0,
  wave: 0,
  shake: 0,
}
const pose = (o) => ({ ...base, ...o })
const POSE = {
  stand: pose({}),
  waitTap: pose({
    spine: -0.02,
    head: 0.08,
    la: 0.62,
    le: 1.5,
    lz: -0.02,
    ra: 0.62,
    re: 1.5,
    rz: -0.02,
    tap: 1,
  }),
  phone: pose({ spine: 0.12, head: 0.44, ra: 0.82, re: 1.72, rz: -0.08, tap: 0.2 }),
  typeStand: pose({ spine: 0.1, head: 0.24, la: 0.64, le: 0.96, ra: 0.64, re: 0.96, jit: 1 }),
  phoneSit: pose({
    sit: 1,
    spine: 0.18,
    head: 0.46,
    la: 0.4,
    le: 0.7,
    ra: 0.82,
    re: 1.72,
    rz: -0.08,
  }),
  armsUp: pose({
    spine: -0.14,
    head: -0.3,
    la: 2.72,
    le: 0.38,
    lz: 0.38,
    ra: 2.72,
    re: 0.38,
    rz: 0.38,
    shake: 1,
  }),
  armsHead: pose({
    spine: 0.06,
    head: 0.34,
    la: 2.25,
    le: 2.15,
    lz: 0.55,
    ra: 2.25,
    re: 2.15,
    rz: 0.55,
    tap: 0.4,
  }),
  headHands: pose({
    sit: 1,
    spine: 0.52,
    head: 0.74,
    la: 1.15,
    le: 2.25,
    lz: -0.05,
    ra: 1.15,
    re: 2.25,
    rz: -0.05,
  }),
  sit: pose({ sit: 1, spine: 0.03, la: 0.42, le: 0.74, ra: 0.42, re: 0.74 }),
  calmSit: pose({ sit: 1, head: -0.03, la: 0.6, le: 0.88, ra: 0.6, re: 0.88 }),
  sitSlump: pose({
    sit: 1,
    spine: 0.42,
    head: 0.5,
    la: 0.76,
    le: 0.62,
    ra: 0.76,
    re: 0.62,
    tap: 0.3,
  }),
  type: pose({ sit: 1, spine: 0.22, head: 0.3, la: 0.64, le: 0.96, ra: 0.64, re: 0.96, jit: 1 }),
  typeCalm: pose({
    sit: 1,
    spine: 0.07,
    head: 0.1,
    la: 0.6,
    le: 0.96,
    ra: 0.6,
    re: 0.96,
    jit: 0.3,
  }),
  talk: pose({ sit: 1, spine: 0.15, head: 0.02, la: 0.42, le: 0.8, ra: 0.82, re: 1.15, wave: 1 }),
  talkCalm: pose({
    sit: 1,
    spine: 0.06,
    head: -0.02,
    la: 0.5,
    le: 0.8,
    ra: 0.65,
    re: 1,
    wave: 0.4,
  }),
  treat: pose({ sit: 1, spine: 0.46, head: 0.46, la: 1, le: 0.72, ra: 1, re: 0.72, jit: 0.25 }),
  lie: pose({ head: -0.08, la: 0.05, le: 0.12, ra: 0.05, re: 0.12 }),
  lost: pose({ spine: 0.07, head: 0.34, la: 0.04, le: 0.1, ra: 0.04, re: 0.1 }),
}

/* ===== La ropa: colores apagados, para que la gente se lea como gente y no como fichas ===== */
const CLOTH = [
  "#7f98a6",
  "#a78f7b",
  "#8c9a7e",
  "#b08f94",
  "#6f8191",
  "#b5a58a",
  "#8a7f9c",
  "#9aa8a0",
  "#a3806f",
  "#6e8a86",
]
const PANTS = ["#3e4d57", "#4c4a52", "#57524a", "#2f3f4a", "#5a5a5e", "#404a44"]
const HAIR = ["#2a211c", "#3b2c22", "#191613", "#5a4332", "#6f6a66", "#2e2a2a"]
const SKIN = ["#e6d3bd", "#d6b89a", "#c9a483", "#efdcc6", "#b98f6d"]
const TEAM_LOOK = {
  recep: { cloth: "#3e8a96", pants: "#26363d", hair: "#2a211c" },
  caja: { cloth: "#7c8f96", pants: "#2f3b42", hair: "#3b2c22" },
  doctora: { cloth: "#f4f1ea", pants: "#d9d6cc", hair: "#191613" },
  director: { cloth: "#44566a", pants: "#2c3540", hair: "#6f6a66" },
}

/* ===== Las burbujas: una sola textura, para dibujarlas todas de una vez ===== */
const CELL = {
  msg: 0,
  wait: 1,
  x: 2,
  check: 3,
  cal: 4,
  sofi: 5,
  dots: 6,
  smile: 7,
  glow: 8,
  bot: 9,
  note: 10,
}
function bubbleAtlas() {
  const S = 256
  const c = document.createElement("canvas")
  c.width = c.height = S * 4
  const g = c.getContext("2d")
  const bubble = (cx, cy, fill) => {
    g.fillStyle = fill
    g.beginPath()
    g.arc(cx, cy - 10, 92, 0, Math.PI * 2)
    g.fill()
    g.beginPath()
    g.moveTo(cx - 26, cy + 70)
    g.lineTo(cx, cy + 112)
    g.lineTo(cx + 26, cy + 70)
    g.fill()
  }
  const ink = (w = 16, color = "#06222a") => {
    g.strokeStyle = color
    g.fillStyle = color
    g.lineWidth = w
    g.lineCap = "round"
    g.lineJoin = "round"
  }
  const dots = (cx, cy) => {
    for (const dx of [-38, 0, 38]) {
      g.beginPath()
      g.arc(cx + dx, cy - 10, 13, 0, Math.PI * 2)
      g.fill()
    }
  }
  const draw = {
    msg(x, y) {
      bubble(x, y, "#e8927c")
      ink()
      dots(x, y)
    },
    wait(x, y) {
      bubble(x, y, "#f5c46b")
      ink(15)
      g.beginPath()
      g.arc(x, y - 10, 54, 0, Math.PI * 2)
      g.stroke()
      g.beginPath()
      g.moveTo(x, y - 40)
      g.lineTo(x, y - 10)
      g.lineTo(x + 24, y + 6)
      g.stroke()
    },
    x(x, y) {
      bubble(x, y, "#e8927c")
      ink(24)
      g.beginPath()
      g.moveTo(x - 36, y - 46)
      g.lineTo(x + 36, y + 26)
      g.moveTo(x + 36, y - 46)
      g.lineTo(x - 36, y + 26)
      g.stroke()
    },
    check(x, y) {
      bubble(x, y, "#a6f0d8")
      ink(24)
      g.beginPath()
      g.moveTo(x - 44, y - 8)
      g.lineTo(x - 12, y + 26)
      g.lineTo(x + 46, y - 44)
      g.stroke()
    },
    cal(x, y) {
      bubble(x, y, "#4fc3d7")
      ink(14)
      g.beginPath()
      g.roundRect(x - 48, y - 54, 96, 88, 12)
      g.stroke()
      g.beginPath()
      g.moveTo(x - 48, y - 28)
      g.lineTo(x + 48, y - 28)
      g.stroke()
      g.beginPath()
      g.moveTo(x - 22, y)
      g.lineTo(x - 4, y + 16)
      g.lineTo(x + 26, y - 14)
      g.stroke()
    },
    sofi(x, y) {
      bubble(x, y, "#4fc3d7")
      ink()
      dots(x, y)
    },
    dots(x, y) {
      bubble(x, y, "#8fb0b8")
      ink()
      dots(x, y)
    },
    smile(x, y) {
      bubble(x, y, "#a6f0d8")
      ink(16)
      g.beginPath()
      g.arc(x, y - 18, 46, Math.PI * 0.15, Math.PI * 0.85)
      g.stroke()
      g.beginPath()
      g.arc(x - 28, y - 34, 11, 0, Math.PI * 2)
      g.arc(x + 28, y - 34, 11, 0, Math.PI * 2)
      g.fill()
    },
    bot(x, y) {
      bubble(x, y, "#c9d3d6")
      ink(14)
      g.beginPath()
      g.roundRect(x - 46, y - 44, 92, 66, 16)
      g.stroke()
      g.beginPath()
      g.arc(x - 18, y - 12, 10, 0, Math.PI * 2)
      g.arc(x + 18, y - 12, 10, 0, Math.PI * 2)
      g.fill()
    },
    note(x, y) {
      bubble(x, y, "#8fb0b8")
      ink(13)
      g.beginPath()
      g.roundRect(x - 36, y - 56, 72, 92, 10)
      g.stroke()
      for (const dy of [-28, -6, 16]) {
        g.beginPath()
        g.moveTo(x - 20, y + dy)
        g.lineTo(x + 20, y + dy)
        g.stroke()
      }
    },
    glow(x, y) {
      const r = g.createRadialGradient(x, y, 0, x, y, 124)
      r.addColorStop(0, "rgba(255,255,255,1)")
      r.addColorStop(0.28, "rgba(255,255,255,.55)")
      r.addColorStop(1, "rgba(255,255,255,0)")
      g.fillStyle = r
      g.fillRect(x - 128, y - 128, 256, 256)
    },
  }
  for (const [k, i] of Object.entries(CELL))
    draw[k](S * (i % 4) + S / 2, S * Math.floor(i / 4) + S / 2 - 6)
  const t = new THREE.CanvasTexture(c)
  t.flipY = false
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.anisotropy = 2
  return t
}
function spriteCloud(capacity, atlas, blending) {
  const geo = new THREE.BufferGeometry()
  const buf = (n) => {
    const a = new THREE.BufferAttribute(new Float32Array(capacity * n), n)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }
  geo.setAttribute("position", buf(3))
  geo.setAttribute("aInfo", buf(2))
  geo.setAttribute("aTint", buf(4))
  const material = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: atlas }, uPx: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending,
    vertexShader: `
      attribute vec2 aInfo; attribute vec4 aTint;
      uniform float uPx; varying float vCell; varying vec4 vTint;
      void main() {
        vCell = aInfo.y; vTint = aTint;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aInfo.x * uPx;
      }`,
    fragmentShader: `
      uniform sampler2D uMap; varying float vCell; varying vec4 vTint;
      void main() {
        vec2 c = vec2(mod(vCell, 4.0), floor(vCell / 4.0));
        vec4 t = texture2D(uMap, (c + gl_PointCoord) / 4.0);
        if (t.a < 0.03) discard;
        gl_FragColor = t * vTint;
      }`,
  })
  const points = new THREE.Points(geo, material)
  points.frustumCulled = false
  let n = 0
  return {
    points,
    material,
    begin() {
      n = 0
    },
    add(x, y, z, size, cell, r = 1, g = 1, b = 1, a = 1) {
      if (n >= capacity) return
      geo.attributes.position.setXYZ(n, x, y, z)
      geo.attributes.aInfo.setXY(n, size, cell)
      geo.attributes.aTint.setXYZW(n, r, g, b, a)
      n++
    },
    end() {
      geo.setDrawRange(0, n)
      geo.attributes.position.needsUpdate = true
      geo.attributes.aInfo.needsUpdate = true
      geo.attributes.aTint.needsUpdate = true
    },
  }
}

function build(slide) {
  const host = slide.querySelector(".cl-gl")
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true })
  } catch {
    slide.classList.add("cl-flat")
    return null
  }
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.shadowMap.autoUpdate = false
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.setSize(W, H, false)
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const cam = new THREE.PerspectiveCamera(24, W / H, 1, 120)
  cam.setViewOffset(W, H, -SHIFT_X, SHIFT_Y, W, H)
  const camAt = CAM.clone()
  const camLook = LOOK.clone()
  cam.position.copy(camAt)
  cam.lookAt(camLook)

  const sim = createSim()
  const ctl = { run: 0, active: false, stopping: false, step: 0, last: 0, moved: true, hudAt: 0 }
  const updaters = []

  /* ----- Materiales de maqueta: un solo tono de cartón, sin texturas ----- */
  const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra })
  const MAT = {
    street: mat("#1f3d47"),
    curb: mat("#3a5a64"),
    plate: mat("#20404a"),
    floor: mat("#d8d4c8"),
    wall: mat("#efeade"),
    inner: mat("#e4dfd3"),
    furn: mat("#c9c5b9"),
    soft: mat("#aeb5b1"),
    dark: mat("#5d7079"),
    paper: mat("#f6f2e8"),
    sticky: mat("#e8b9a4"),
    carton: mat("#b89f7c"),
    folder: mat("#b8b0a0"),
    hole: mat("#3b4f57"),
    busy: mat("#b4bab3"),
    clash: mat("#e8927c", { emissive: "#e8927c", emissiveIntensity: 0.5 }),
    filled: mat("#a6f0d8", { emissive: "#a6f0d8", emissiveIntensity: 0.55 }),
    screen: mat("#16323b", { emissive: "#4fc3d7", emissiveIntensity: 0.25 }),
  }

  const boxes = new Map()
  const boxGeo = (w, h, d, r) => {
    const key = `${w}|${h}|${d}|${r}`
    if (!boxes.has(key))
      boxes.set(key, new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)))
    return boxes.get(key)
  }
  /** Una caja apoyada en `y`, centrada en x y z. */
  const box = (material, w, h, d, x, y, z, r = 0.025, parent = scene) => {
    const m = new THREE.Mesh(boxGeo(w, h, d, r), material)
    m.position.set(x, y + h / 2, z)
    m.castShadow = true
    m.receiveShadow = true
    parent.add(m)
    return m
  }
  const stool = (x, z) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 0.4, 16), MAT.soft)
    m.position.set(x, 0.2, z)
    m.castShadow = true
    m.receiveShadow = true
    scene.add(m)
  }

  /* ----- La calle: de ahí llega la gente y ahí queda la que se va ----- */
  box(MAT.street, 42, 0.1, 3.5, -6, -0.13, 5.75, 0.02).castShadow = false
  box(MAT.curb, 42, 0.1, 0.32, -6, -0.1, 3.84, 0.02).castShadow = false
  box(MAT.curb, 42, 0.1, 0.22, -6, -0.1, 7.6, 0.02).castShadow = false

  /* ----- La planta: dos muros altos atrás y tabiques bajos, como una maqueta cortada ----- */
  box(MAT.plate, 12.4, 0.3, 8.4, 0, -0.34, -0.4, 0.12)
  box(MAT.floor, 12, 0.04, 8, 0, -0.04, -0.4, 0.005)
  box(MAT.wall, 12, 1.95, 0.14, 0, 0, -4.33, 0.03)
  box(MAT.wall, 0.14, 1.95, 8, -5.93, 0, -0.4, 0.03)
  box(MAT.inner, 0.12, 0.72, 5.26, 0.9, 0, -1.67, 0.02)
  box(MAT.inner, 4.42, 0.72, 0.12, -3.72, 0, -1.0, 0.02)
  box(MAT.inner, 1.2, 0.72, 0.12, 0.3, 0, -1.0, 0.02)
  box(MAT.inner, 3.4, 0.72, 0.12, 4.3, 0, 1.0, 0.02)
  // El frente: un murito bajo con la puerta en medio.
  box(MAT.inner, 4.75, 0.26, 0.12, -3.5, 0, 3.54, 0.02)
  box(MAT.inner, 4.9, 0.26, 0.12, 3.5, 0, 3.54, 0.02)
  for (const x of [-1.12, 1.05]) box(MAT.dark, 0.1, 1.05, 0.14, x, 0, 3.54, 0.02)

  // Recepción: el mostrador, su pantalla y la sala de espera.
  box(MAT.furn, 3.4, 0.62, 0.62, -2.4, 0, 0.85, 0.03)
  box(MAT.wall, 3.5, 0.04, 0.72, -2.4, 0.62, 0.85, 0.015)
  box(MAT.dark, 0.5, 0.3, 0.03, -1.8, 0.66, 0.64, 0.012)
  box(MAT.screen, 0.46, 0.26, 0.012, -1.8, 0.68, 0.66, 0.004)
  stool(-2.4, 0.02)
  for (const z of [0.5, 1.3, 2.1]) box(MAT.soft, 0.52, 0.4, 0.52, -5.4, 0, z, 0.05)
  for (const x of [-4.6, -3.8, -3.0]) box(MAT.soft, 0.52, 0.4, 0.42, x, 0, 3.16, 0.05)

  // Consultorio: la unidad dental, su lámpara, el banco y la mesa de la pared.
  box(MAT.dark, 0.5, 0.36, 0.5, 3.75, 0, -1.4, 0.05)
  box(MAT.soft, 0.95, 0.13, 0.5, 3.9, 0.36, -1.4, 0.05)
  const back = box(MAT.soft, 0.85, 0.13, 0.5, 3.12, 0.43, -1.4, 0.05)
  back.rotation.z = -0.3
  box(MAT.soft, 0.26, 0.12, 0.34, 2.65, 0.68, -1.4, 0.05)
  box(MAT.dark, 0.08, 1.45, 0.08, 2.9, 0, -2.25, 0.03)
  box(MAT.dark, 0.08, 0.06, 0.82, 2.9, 1.42, -1.85, 0.02)
  box(MAT.wall, 0.42, 0.09, 0.2, 3.0, 1.34, -1.48, 0.03)
  box(MAT.dark, 0.34, 0.03, 0.26, 2.42, 0.62, -0.92, 0.01)
  box(MAT.dark, 0.05, 0.62, 0.05, 2.42, 0, -0.92, 0.015)
  stool(EQUIPO.doctora.x, EQUIPO.doctora.z)
  // La pantalla junto a la que trabaja Clío: no toca al paciente.
  box(MAT.dark, 0.06, 0.82, 0.06, 4.75, 0, -3.0, 0.02)
  box(MAT.dark, 0.74, 0.46, 0.04, 4.75, 0.82, -3.0, 0.015)
  box(MAT.screen, 0.68, 0.4, 0.015, 4.75, 0.85, -2.97, 0.005)
  // La mesa de las notas.
  box(MAT.furn, 2.1, 0.5, 0.72, 2.4, 0, -3.7, 0.025)
  box(MAT.wall, 2.2, 0.04, 0.8, 2.4, 0.5, -3.7, 0.015)

  // Administración: su mesa, los archivos y la agenda de la clínica en la pared.
  box(MAT.furn, 2.2, 0.5, 0.8, -3.8, 0, -2.78, 0.025)
  box(MAT.wall, 2.3, 0.04, 0.88, -3.8, 0.5, -2.78, 0.015)
  box(MAT.dark, 0.5, 0.3, 0.03, -3.8, 0.54, -2.5, 0.012)
  box(MAT.screen, 0.46, 0.26, 0.012, -3.8, 0.56, -2.49, 0.004)
  stool(EQUIPO.director.x, EQUIPO.director.z)
  box(MAT.furn, 1.3, 1.5, 0.3, -5.15, 0, -4.08, 0.02)
  for (let i = 0; i < 5; i++) box(MAT.folder, 0.16, 0.44, 0.24, -5.6 + i * 0.22, 0.1, -3.96, 0.012)
  for (let i = 0; i < 5; i++) box(MAT.folder, 0.16, 0.44, 0.24, -5.6 + i * 0.22, 0.82, -3.96, 0.012)

  // Caja.
  box(MAT.furn, 1.9, 0.62, 0.6, 3.7, 0, 2.35, 0.03)
  box(MAT.wall, 2.0, 0.04, 0.7, 3.7, 0.62, 2.35, 0.015)
  box(MAT.dark, 0.42, 0.2, 0.32, 4.05, 0.66, 2.33, 0.03)
  stool(EQUIPO.caja.x, EQUIPO.caja.z)

  // La agenda: lo ocupado, y los huecos que se van llenando.
  const boardX = -1.95
  box(MAT.dark, 2.3, 1.06, 0.05, boardX, 0.8, -4.24, 0.02)
  const HOLES = [1, 3, 4, 7, 9, 11, 12, 15, 16, 19, 21, 23, 24, 26, 28]
  const CLASH = [6, 18]
  const cells = []
  for (let i = 0; i < 30; i++) {
    const m = box(
      HOLES.includes(i) ? MAT.hole : MAT.busy,
      0.39,
      0.125,
      0.018,
      boardX - 0.88 + (i % 5) * 0.44,
      1.66 - Math.floor(i / 5) * 0.158,
      -4.2,
      0.008,
    )
    m.castShadow = false
    cells[i] = m
  }
  let boardShown = -1
  const setBoard = (n) => {
    if (n === boardShown) return
    boardShown = n
    HOLES.forEach((i, k) => {
      cells[i].material = k < n ? MAT.filled : MAT.hole
    })
    paintClash()
  }
  function paintClash() {
    for (const i of CLASH) cells[i].material = sim.mode === "sin" ? MAT.clash : MAT.busy
  }

  /* ----- Luces: una fría que se vuelve cálida; ninguna luz de sala, pesan mucho ----- */
  const hemi = new THREE.HemisphereLight("#ffffff", "#222222", 1)
  scene.add(hemi)
  const key = new THREE.DirectionalLight("#ffffff", 1)
  key.position.set(-6.5, 13, 8)
  key.target.position.set(0, 0, 0)
  scene.add(key, key.target)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.radius = 4
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.02
  Object.assign(key.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 34 })

  /* ----- El desorden: papeles apilados y regados, notas pegadas, cajas ----- */
  const sheetSpots = []
  const addStack = (group, x, y, z, n, seed = 0, step = 0.022) => {
    for (let i = 0; i < n; i++) {
      sheetSpots.push({
        group,
        th: i / n,
        x: x + Math.sin(i * 2.3 + seed) * 0.03,
        y: y + i * step,
        z: z + Math.cos(i * 1.7 + seed) * 0.03,
        ry: Math.sin(i * 3.1 + seed) * 0.3,
      })
    }
  }
  addStack("general", -2.85, 0.68, 0.92, 26, 1)
  addStack("general", -1.3, 0.68, 0.98, 18, 2.4)
  addStack("general", 3.1, 0.68, 2.32, 12, 0.7)
  addStack("notas", 1.9, 0.56, -3.62, 18, 0.6)
  addStack("notas", 2.5, 0.56, -3.56, 11, 3.2)
  addStack("reporte", -4.55, 0.56, -2.82, 14, 1.2)
  addStack("reporte", -3.05, 0.56, -2.76, 10, 2.2)
  // Regados por el piso de la recepción y del pasillo.
  for (let i = 0; i < 46; i++) {
    const a = i * 2.399
    const r = 0.4 + (i % 13) * 0.22
    sheetSpots.push({
      group: "general",
      th: 0.02 + (i / 46) * 0.9,
      x: clamp(-2.2 + Math.cos(a) * r * 1.5, -5.6, 0.6),
      y: 0.012,
      z: clamp(1.9 + Math.sin(a) * r * 0.62, 1.25, 3.35),
      ry: a * 1.7,
    })
  }
  for (let i = 0; i < 14; i++) {
    const a = i * 1.71
    sheetSpots.push({
      group: "reporte",
      th: i / 14,
      x: -3.8 + Math.cos(a) * (0.9 + (i % 4) * 0.35),
      y: 0.012,
      z: -2 + Math.sin(a) * 0.32,
      ry: a * 2.1,
    })
  }
  const sheetGeo = new THREE.BoxGeometry(0.3, 0.012, 0.38)
  const sheets = new THREE.InstancedMesh(sheetGeo, MAT.paper, sheetSpots.length)
  sheets.frustumCulled = false
  sheets.receiveShadow = true
  scene.add(sheets)
  const dummy = new THREE.Object3D()
  const mess = { general: 1, notas: 1, reporte: 1 }
  const messWant = { ...mess }
  const paintSheets = () => {
    sheetSpots.forEach((s, i) => {
      const k = clamp01((mess[s.group] - s.th) * 7 + (mess[s.group] >= 0.999 ? 1 : 0))
      dummy.position.set(s.x, s.y, s.z)
      dummy.rotation.set(0, s.ry, 0)
      dummy.scale.setScalar(k < 0.02 ? 0 : k)
      dummy.updateMatrix()
      sheets.setMatrixAt(i, dummy.matrix)
    })
    sheets.instanceMatrix.needsUpdate = true
  }
  // Las notas pegadas en los tabiques y las cajas amontonadas.
  const stickySpots = []
  for (let i = 0; i < 16; i++) {
    stickySpots.push([
      -5 + i * 0.27 + Math.sin(i * 1.9) * 0.05,
      0.42 + Math.cos(i * 2.7) * 0.15,
      -0.93,
      0,
    ])
  }
  for (let i = 0; i < 9; i++)
    stickySpots.push([0.3 + Math.sin(i) * 0.5, 0.34 + (i % 3) * 0.13, -0.93, 0])
  for (let i = 0; i < 9; i++)
    stickySpots.push([-5.85, 1 + (i % 3) * 0.2, -3.6 + i * 0.28, Math.PI / 2])
  const stickies = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.15, 0.15, 0.006),
    MAT.sticky,
    stickySpots.length,
  )
  stickies.frustumCulled = false
  scene.add(stickies)
  const paintStickies = () => {
    stickySpots.forEach(([x, y, z, ry], i) => {
      const k = clamp01(
        (mess.general - i / stickySpots.length) * 7 + (mess.general >= 0.999 ? 1 : 0),
      )
      dummy.position.set(x, y, z)
      dummy.rotation.set(0, ry, Math.sin(i * 2) * 0.12)
      dummy.scale.setScalar(k < 0.02 ? 0 : k)
      dummy.updateMatrix()
      stickies.setMatrixAt(i, dummy.matrix)
    })
    stickies.instanceMatrix.needsUpdate = true
  }
  const cartons = [
    [-5.3, 0, -2.0, 0.6, 0.42, 0.48, 0.2],
    [-5.25, 0.42, -2.02, 0.48, 0.36, 0.42, -0.25],
    [-4.7, 0, -1.55, 0.5, 0.38, 0.44, 0.5],
    [1.6, 0, -3.0, 0.56, 0.4, 0.46, 0.1],
    [5.35, 0, 2.6, 0.5, 0.42, 0.46, -0.3],
    [5.3, 0.42, 2.62, 0.42, 0.3, 0.38, 0.35],
    [-0.45, 0, 0.2, 0.5, 0.4, 0.44, 0.15],
  ].map(([x, y, z, w, h, d, ry]) => {
    const m = box(MAT.carton, w, h, d, x, y, z, 0.02)
    m.rotation.y = ry
    return m
  })
  // Fichas repetidas sobre el mostrador: se vuelven una.
  const folders = [0, 1, 2].map((i) => {
    const m = box(
      MAT.folder,
      0.32,
      0.05,
      0.42,
      -0.98 + i * 0.1,
      0.66 + i * 0.002,
      0.92 + i * 0.1,
      0.012,
    )
    m.rotation.y = 0.2 - i * 0.22
    return { m, x: m.position.x, z: m.position.z }
  })
  // Unas hojas siguen cayendo del mostrador.
  const FLY = 9
  const flying = new THREE.InstancedMesh(sheetGeo, MAT.paper, FLY)
  flying.frustumCulled = false
  scene.add(flying)
  let shadowDirty = 3
  updaters.push((dt, t) => {
    let changed = false
    for (const k of Object.keys(mess)) {
      const next = damp(mess[k], messWant[k], k === "general" ? 0.55 : 0.9, dt)
      if (Math.abs(next - mess[k]) > 0.0004) changed = true
      mess[k] = Math.abs(next - messWant[k]) < 0.002 ? messWant[k] : next
    }
    if (changed) {
      paintSheets()
      paintStickies()
      const s = clamp01(mess.general * 1.6 - 0.1)
      for (const c of cartons) {
        c.visible = s > 0.02
        c.scale.setScalar(s)
      }
      folders.forEach((f, i) => {
        if (!i) return
        f.m.position.x = folders[0].x + (f.x - folders[0].x) * s
        f.m.position.z = folders[0].z + (f.z - folders[0].z) * s
        f.m.visible = s > 0.04
      })
      shadowDirty = 1
    }
    const copying = sim.flavor === "crm" && sim.mode === "sin" && !reduce
    const show = (mess.general > 0.45 || copying) && !reduce
    flying.visible = show
    if (show) {
      for (let i = 0; i < FLY; i++) {
        if (copying) {
          const [a, b] = PAPER_ROUTES[i % PAPER_ROUTES.length]
          const u = (t * 0.2 + i * 0.37) % 1
          dummy.position.set(
            a.x + (b.x - a.x) * u,
            1 + Math.sin(u * Math.PI) * 1.3,
            a.z + (b.z - a.z) * u,
          )
          dummy.rotation.set(0.35, u * 3, 0)
          dummy.scale.setScalar(u < 0.04 || u > 0.96 ? 0 : 1)
          dummy.updateMatrix()
          flying.setMatrixAt(i, dummy.matrix)
          continue
        }
        const u = (t * (0.13 + i * 0.008) + i * 0.137) % 1
        const fromX = -3.6 + ((i * 0.73) % 3)
        dummy.position.set(
          fromX + Math.sin(u * 7 + i) * 0.35 + u * 0.5,
          0.9 * (1 - u) ** 1.4 + Math.sin(u * 9 + i) * 0.05 * (1 - u) + 0.02,
          1.25 + u * (0.9 + (i % 3) * 0.5),
        )
        dummy.rotation.set(
          Math.sin(u * 8 + i) * 1.1 * (1 - u),
          u * 6 + i,
          Math.cos(u * 6 + i) * 0.9 * (1 - u),
        )
        dummy.scale.setScalar(u > 0.98 ? 0 : 1)
        dummy.updateMatrix()
        flying.setMatrixAt(i, dummy.matrix)
      }
      flying.instanceMatrix.needsUpdate = true
    }
  })

  /* ----- La gente: muchas personas, pocas llamadas de dibujo ----- */
  const N = sim.people.length
  const GEO = {
    torso: new THREE.CapsuleGeometry(0.14, 0.2, 3, 10),
    head: new THREE.SphereGeometry(0.128, 14, 12),
    hair: new THREE.SphereGeometry(0.136, 12, 10),
    upper: new THREE.CapsuleGeometry(0.048, 0.16, 2, 6),
    fore: new THREE.CapsuleGeometry(0.042, 0.16, 2, 6),
    thigh: new THREE.CapsuleGeometry(0.064, 0.19, 2, 6),
    shin: new THREE.CapsuleGeometry(0.054, 0.19, 2, 6),
  }
  const skinMat = new THREE.MeshLambertMaterial()
  const clothMat = new THREE.MeshLambertMaterial()
  const instanced = (geo, count) => {
    const m = new THREE.InstancedMesh(geo, clothMat, count)
    m.frustumCulled = false
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.setColorAt(0, new THREE.Color("#ffffff"))
    scene.add(m)
    return m
  }
  const parts = {
    torso: instanced(GEO.torso, N),
    head: instanced(GEO.head, N),
    hair: instanced(GEO.hair, N),
    upper: instanced(GEO.upper, N * 2),
    fore: instanced(GEO.fore, N * 2),
    thigh: instanced(GEO.thigh, N * 2),
    shin: instanced(GEO.shin, N * 2),
  }
  parts.head.material = skinMat
  // Sombras: la misma gente aplastada sobre el piso; el esténcil evita que se oscurezcan al cruzarse.
  const KX = 0.5
  const KZ = -0.615
  const FLOOR = 0.012
  const flatten = new THREE.Matrix4().set(
    1,
    KX,
    0,
    -KX * FLOOR,
    0,
    0,
    0,
    FLOOR,
    0,
    KZ,
    1,
    -KZ * FLOOR,
    0,
    0,
    0,
    1,
  )
  const shadowMat = new THREE.MeshBasicMaterial({
    color: "#071a20",
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
    toneMapped: false,
  })
  for (const k of ["torso", "head", "upper", "fore", "thigh", "shin"]) {
    const m = new THREE.InstancedMesh(parts[k].geometry, shadowMat, parts[k].count)
    m.instanceMatrix = parts[k].instanceMatrix
    m.frustumCulled = false
    m.matrixAutoUpdate = false
    m.matrix.copy(flatten)
    m.renderOrder = -1
    scene.add(m)
  }

  // Cada persona: su ropa y lo que su cuerpo viene haciendo.
  const look = sim.people.map((p) => {
    const t = p.kind === "equipo" ? TEAM_LOOK[p.key] : null
    const i = p.id
    return {
      cloth: new THREE.Color(t ? t.cloth : CLOTH[(i * 7) % CLOTH.length]),
      pants: new THREE.Color(t ? t.pants : PANTS[(i * 5) % PANTS.length]),
      hair: new THREE.Color(t ? t.hair : HAIR[(i * 3) % HAIR.length]),
      skin: new THREE.Color(SKIN[(i * 11) % SKIN.length]),
      long: i % 2 === 0,
      scale: PERSON_SCALE * (t ? 1.03 : 0.94 + ((i * 13) % 10) * 0.012),
      phase: i * 1.37,
      cur: { ...POSE.stand },
      y: 0,
      lean: 0,
      walk: 0,
      dim: -1,
      bub: null,
      bubS: 0,
      snap: true,
    }
  })
  const night = new THREE.Color("#0c2028")
  const tint = new THREE.Color()
  const paintLook = (p, v, dim) => {
    v.dim = dim
    const shade = (c) => tint.copy(c).lerp(night, dim)
    const i = p.id
    shade(v.cloth)
    parts.torso.setColorAt(i, tint)
    parts.upper.setColorAt(i * 2, tint)
    parts.upper.setColorAt(i * 2 + 1, tint)
    parts.fore.setColorAt(i * 2, tint)
    parts.fore.setColorAt(i * 2 + 1, tint)
    shade(v.pants)
    parts.thigh.setColorAt(i * 2, tint)
    parts.thigh.setColorAt(i * 2 + 1, tint)
    parts.shin.setColorAt(i * 2, tint)
    parts.shin.setColorAt(i * 2 + 1, tint)
    shade(v.hair)
    parts.hair.setColorAt(i, tint)
    shade(v.skin)
    parts.head.setColorAt(i, tint)
    colorsDirty = true
  }
  let colorsDirty = true

  const J = {
    root: new THREE.Matrix4(),
    hips: new THREE.Matrix4(),
    spine: new THREE.Matrix4(),
    neck: new THREE.Matrix4(),
    joint: new THREE.Matrix4(),
    next: new THREE.Matrix4(),
    out: new THREE.Matrix4(),
  }
  const tM = new THREE.Matrix4()
  const rM = new THREE.Matrix4()
  const sV = new THREE.Vector3()
  const hide = new THREE.Matrix4().makeScale(0, 0, 0)
  /** out = padre × trasladar × girar en z × girar en x */
  const chain = (out, parent, x, y, z, rx = 0, rz = 0) => {
    tM.makeTranslation(x, y, z)
    out.multiplyMatrices(parent, tM)
    if (rz) out.multiply(rM.makeRotationZ(rz))
    if (rx) out.multiply(rM.makeRotationX(rx))
    return out
  }
  const atHome = (p) => {
    if (p.kind !== "equipo") return true
    const h = EQUIPO[p.key]
    return Math.hypot(p.x - h.x, p.z - h.z) < 0.2
  }
  function drawPerson(p, v, dt, t) {
    const i = p.id
    if (!p.active) {
      for (const k of ["torso", "head", "hair"]) parts[k].setMatrixAt(i, hide)
      for (const k of ["upper", "fore", "thigh", "shin"]) {
        parts[k].setMatrixAt(i * 2, hide)
        parts[k].setMatrixAt(i * 2 + 1, hide)
      }
      v.snap = true
      return
    }
    const target = POSE[p.pose] ?? POSE.stand
    const rate = v.snap ? 1000 : 8
    for (const k of POSE_KEYS) {
      let want = target[k]
      if (k === "sit" && (!atHome(p) || p.walking)) want = 0
      v.cur[k] = damp(v.cur[k], want, rate, dt || 0.016)
    }
    v.y = damp(v.y, p.y, v.snap ? 1000 : 6, dt || 0.016)
    v.lean = damp(v.lean, p.lean, v.snap ? 1000 : 6, dt || 0.016)
    v.walk = damp(v.walk, p.walking ? 1 : 0, v.snap ? 1000 : 10, dt || 0.016)
    if (p.walking) v.phase += (p.speed * 4.2 + 1) * dt
    const dimNow = v.snap ? p.dim : damp(v.dim < 0 ? p.dim : v.dim, p.dim, 2.2, dt || 0.016)
    if (Math.abs(dimNow - v.dim) > 0.004) paintLook(p, v, dimNow)
    v.snap = false

    const c = v.cur
    const w = reduce ? 0 : v.walk
    const ph = v.phase
    const sw = Math.sin(ph)
    const live = reduce ? 0 : 1
    const jit = Math.sin(t * 17 + i) * 0.1 * c.jit * live
    const wave = Math.sin(t * 5.5 + i) * c.wave * live
    const shake = Math.sin(t * 13 + i) * c.shake * live
    const tap = Math.max(0, Math.sin(t * 8 + i)) * c.tap * live
    const breathe = Math.sin(t * 1.1 + v.phase) * 0.012 * live

    sV.setScalar(v.scale)
    J.root.makeRotationY(p.yaw)
    J.root.setPosition(p.x, v.y, p.z)
    if (v.lean > 0.001) J.root.multiply(rM.makeRotationZ(v.lean))
    J.root.scale(sV)
    const hipY = 0.52 + (0.34 - 0.52) * c.sit + Math.abs(sw) * 0.032 * w + Math.abs(shake) * 0.03
    chain(J.hips, J.root, 0, hipY, 0)
    // Las piernas: sentado, doblado; caminando, alternan.
    const legA = (-Math.PI / 2) * c.sit
    const legK = (Math.PI / 2) * c.sit
    for (const side of [0, 1]) {
      const s = side ? -sw : sw
      const a = legA + -s * (0.26 + 0.15 * p.speed) * w
      const k =
        legK + Math.max(0, side ? Math.cos(ph) : -Math.cos(ph)) * 0.72 * w + (side ? tap * 0.45 : 0)
      chain(J.joint, J.hips, side ? 0.078 : -0.078, 0, 0, side ? a - tap * 0.25 : a)
      chain(J.out, J.joint, 0, -0.125, 0)
      parts.thigh.setMatrixAt(i * 2 + side, J.out)
      chain(J.next, J.joint, 0, -0.25, 0, k)
      chain(J.out, J.next, 0, -0.125, 0)
      parts.shin.setMatrixAt(i * 2 + side, J.out)
    }
    chain(J.spine, J.hips, 0, 0, 0, c.spine + 0.07 * w + breathe)
    chain(J.out, J.spine, 0, 0.22, 0)
    J.out.scale(sV.set(1, 1, 0.76))
    parts.torso.setMatrixAt(i, J.out)
    chain(J.neck, J.spine, 0, 0.42, 0, c.head - 0.06 * w - shake * 0.08)
    chain(J.out, J.neck, 0, 0.125, 0)
    parts.head.setMatrixAt(i, J.out)
    chain(J.out, J.neck, 0, 0.145, v.long ? -0.026 : -0.012)
    J.out.scale(v.long ? sV.set(1.04, 1.08, 1.08) : sV.set(1, 0.84, 1.02))
    parts.hair.setMatrixAt(i, J.out)
    // Los brazos: acompañan al caminar, y cada postura los lleva a su sitio.
    for (const side of [0, 1]) {
      const swing = (side ? -sw : sw) * 0.45 * w
      const armA = (side ? c.ra : c.la) + swing + (side ? wave * 0.22 : 0) + jit + shake * 0.14
      const armE = (side ? c.re : c.le) + 0.22 * w + (side ? wave * 0.5 : 0) + jit
      const armZ = (side ? c.rz : c.lz) * (side ? 1 : -1)
      chain(J.joint, J.spine, side ? 0.185 : -0.185, 0.355, 0, -armA, armZ)
      chain(J.out, J.joint, 0, -0.105, 0)
      parts.upper.setMatrixAt(i * 2 + side, J.out)
      chain(J.next, J.joint, 0, -0.21, 0, -armE)
      chain(J.out, J.next, 0, -0.105, 0)
      parts.fore.setMatrixAt(i * 2 + side, J.out)
    }
  }
  /** Lo alto de la cabeza de alguien, para sus burbujas y su ficha. */
  const topOf = (v) =>
    (v.cur.sit > 0.5 ? 1.2 : 1.42) * (v.scale / PERSON_SCALE) + v.y - (v.lean > 0.5 ? 0.75 : 0)

  /* ----- Burbujas y destellos ----- */
  const atlas = bubbleAtlas()
  const bubbles = spriteCloud(N + 40, atlas, THREE.NormalBlending)
  const glows = spriteCloud(420, atlas, THREE.AdditiveBlending)
  scene.add(bubbles.points, glows.points)
  bubbles.points.renderOrder = 5
  glows.points.renderOrder = 6

  const pulses = []
  function pulse(a, b, hex, dur = 0.8, lift = 1.3, done = null) {
    if (reduce) {
      done?.()
      return
    }
    if (pulses.length > 60) pulses.shift()
    const mid = a.clone().add(b).multiplyScalar(0.5)
    mid.y += lift
    pulses.push({
      curve: new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone()),
      t: 0,
      dur,
      c: new THREE.Color(hex),
      done,
    })
  }
  const pv = new THREE.Vector3()

  // Los mensajes sin responder: se amontonan sobre el mostrador.
  const CLOUD = 34
  const cloudSpots = Array.from({ length: CLOUD }, (_, i) => {
    const row = Math.floor(i / 7)
    return {
      x: -3.25 + ((i % 7) * 0.2 + (row % 2) * 0.1),
      y: 1.62 + row * 0.19 + Math.sin(i * 2.1) * 0.03,
      z: 0.82 + Math.cos(i * 1.3) * 0.16,
      s: 0,
      seed: i * 1.9,
    }
  })
  let cloudShown = 0

  /* ----- Los agentes: una figura más, con su color y sus corchetes ----- */
  const AGENT_PLACE = {
    sofi: { x: 0.08, z: 0.2, rot: -0.3 },
    clio: { x: 5.25, z: -2.5, rot: -0.8 },
    argos: { x: -1.55, z: -2.6, rot: -0.2 },
    bot: { x: 0.08, z: 0.2, rot: -0.3 },
  }
  const agentV = (k, y = 1.15) => V(AGENT_PLACE[k].x, y, AGENT_PLACE[k].z)
  const glowTex = (() => {
    const c = document.createElement("canvas")
    c.width = c.height = 128
    const x = c.getContext("2d")
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, "rgba(255,255,255,1)")
    g.addColorStop(0.3, "rgba(255,255,255,.5)")
    g.addColorStop(1, "rgba(255,255,255,0)")
    x.fillStyle = g
    x.fillRect(0, 0, 128, 128)
    return new THREE.CanvasTexture(c)
  })()
  const agents = {}
  for (const k of Object.keys(FIGURES)) {
    const c = FIGURES[k]
    const plain = k === "bot"
    const place = AGENT_PLACE[k]
    const material = new THREE.MeshLambertMaterial({
      color: c,
      emissive: c,
      emissiveIntensity: plain ? 0.12 : 0.55,
      transparent: true,
      opacity: 0,
    })
    const body = new THREE.Group()
    body.position.set(place.x, 0, place.z)
    body.rotation.y = place.rot
    body.scale.setScalar(1.2)
    scene.add(body)
    const part = (geo, parent, x, y, z = 0, sx = 1, sz = 1) => {
      const m = new THREE.Mesh(geo, material)
      m.position.set(x, y, z)
      m.scale.set(sx, 1, sz)
      parent.add(m)
      return m
    }
    part(GEO.torso, body, 0, 0.74, 0, 1, 0.76)
    part(GEO.head, body, 0, 1.065)
    for (const s of [-1, 1]) {
      part(GEO.thigh, body, s * 0.078, 0.395)
      part(GEO.shin, body, s * 0.078, 0.145)
      const arm = new THREE.Group()
      arm.position.set(s * 0.185, 0.875, 0)
      arm.rotation.z = s * 0.05
      arm.rotation.x = -0.1
      body.add(arm)
      part(GEO.upper, arm, 0, -0.105)
      part(GEO.fore, arm, 0, -0.315)
    }
    const disk = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 32),
      new THREE.MeshBasicMaterial({
        map: glowTex,
        color: c,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    )
    disk.rotation.x = -Math.PI / 2
    disk.position.set(place.x, 0.02, place.z)
    scene.add(disk)
    const group = new THREE.Group()
    group.position.set(place.x, 0.84, place.z)
    group.rotation.y = Math.atan2(CAM.x - place.x, CAM.z - place.z)
    scene.add(group)
    const metal = new THREE.MeshLambertMaterial({
      color: c,
      emissive: c,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0,
    })
    const sides = [-1, 1].map((side) => {
      const s = new THREE.Group()
      group.add(s)
      for (const [w, h, x, y] of [
        [0.06, 1.72, 0, 0],
        [0.22, 0.06, -side * 0.08, 0.83],
        [0.22, 0.06, -side * 0.08, -0.83],
      ]) {
        const m = new THREE.Mesh(boxGeo(w, h, 0.07, 0.012), metal)
        m.position.set(x, y, 0)
        s.add(m)
      }
      return { s, side }
    })
    const st = { shown: 0, want: 0, gap: 1.1, beat: 0 }
    agents[k] = st
    updaters.push((dt) => {
      st.shown = damp(st.shown, st.want, 3.4, dt)
      st.gap = damp(st.gap, st.want ? 0.56 : 1.1, 3, dt)
      st.beat = Math.max(0, st.beat - dt * 2.4)
      material.opacity = st.shown * 0.95
      body.visible = st.shown > 0.02
      group.visible = st.shown > 0.02 && !plain
      disk.visible = st.shown > 0.02 && !plain
      metal.opacity = st.shown
      for (const { s, side } of sides) s.position.x = side * st.gap
      disk.material.opacity = st.shown * (0.45 + st.beat * 0.55)
      disk.scale.setScalar(1 + st.beat * 0.5)
      body.position.y = reduce ? 0 : Math.sin(performance.now() / 900 + place.x) * 0.012
    })
  }
  // Lo que ve Argos: un anillo que recorre toda la clínica.
  const scan = new THREE.Mesh(
    new THREE.RingGeometry(0.965, 1, 72),
    new THREE.MeshBasicMaterial({
      color: COLOR.argos,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  scan.rotation.x = -Math.PI / 2
  scan.position.set(AGENT_PLACE.argos.x, 0.04, AGENT_PLACE.argos.z)
  scene.add(scan)

  /* ----- La luz se mueve ----- */
  let lightWant = LIGHT.sin
  const lightNow = { hemi: LIGHT.sin.hemi, key: LIGHT.sin.key }
  const skyC = new THREE.Color()
  const groundC = new THREE.Color()
  const keyC = new THREE.Color()
  const snapLight = () => {
    lightNow.hemi = lightWant.hemi
    lightNow.key = lightWant.key
    hemi.color.set(lightWant.sky)
    hemi.groundColor.set(lightWant.ground)
    key.color.set(lightWant.keyC)
  }
  updaters.push((dt, t) => {
    const w = lightWant
    lightNow.hemi = damp(lightNow.hemi, w.hemi, 1.1, dt)
    lightNow.key = damp(lightNow.key, w.key, 1.1, dt)
    const u = 1 - Math.exp(-1.1 * dt)
    hemi.color.lerp(skyC.set(w.sky), u)
    hemi.groundColor.lerp(groundC.set(w.ground), u)
    key.color.lerp(keyC.set(w.keyC), u)
    // Sin odentIA, un tubo que titila de vez en cuando.
    const flick = w === LIGHT.sin && !reduce && t % 6.7 < 0.14 ? 0.9 : 1
    hemi.intensity = lightNow.hemi * flick
    key.intensity = lightNow.key
  })
  /* ----- Con un CRM: una pantalla para cada cosa, y ninguna habla con otra ----- */
  const crm = new THREE.Group()
  crm.visible = false
  scene.add(crm)
  for (const [k, place] of Object.entries(PANTALLAS)) {
    const glow = { mensajes: "#7fb4c4", agenda: "#b7c0a4", historia: "#c9a99f", caja: "#b3a9c7" }[k]
    box(MAT.dark, 0.07, 0.95, 0.07, place.x, 0, place.z, 0.02, crm)
    box(MAT.dark, 0.86, 0.54, 0.05, place.x, 0.95, place.z, 0.015, crm)
    const face = box(
      mat("#16323b", { emissive: glow, emissiveIntensity: 0.6 }),
      0.8,
      0.48,
      0.02,
      place.x,
      0.98,
      place.z + 0.03,
      0.005,
      crm,
    )
    face.castShadow = false
  }
  const headOfScreen = (k) => V(PANTALLAS[k].x, 1.25, PANTALLAS[k].z)
  /** Un tramo de una curva, para dibujar la línea con su corte en medio. */
  class PartOf extends THREE.Curve {
    constructor(curve, from, to) {
      super()
      this.curve = curve
      this.from = from
      this.to = to
    }
    getPoint(t, target = new THREE.Vector3()) {
      return this.curve.getPoint(this.from + (this.to - this.from) * t, target)
    }
  }
  const brokenMat = new THREE.MeshBasicMaterial({ color: "#e8927c", toneMapped: false })
  const CRM_GAPS = [
    ["mensajes", "agenda"],
    ["agenda", "historia"],
    ["historia", "caja"],
  ].map(([a, b]) => {
    const from = headOfScreen(a)
    const to = headOfScreen(b)
    const mid = from.clone().add(to).multiplyScalar(0.5)
    mid.y += 1.5
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to)
    for (const [p, q] of [
      [0, 0.4],
      [0.6, 1],
    ]) {
      crm.add(
        new THREE.Mesh(
          new THREE.TubeGeometry(new PartOf(curve, p, q), 18, 0.016, 6, false),
          brokenMat,
        ),
      )
    }
    return curve.getPoint(0.5)
  })
  // Lo que pasa de una pantalla a otra, alguien lo lleva: las hojas van y vienen.
  const PAPER_ROUTES = [
    [PANTALLAS.mensajes, PANTALLAS.agenda],
    [PANTALLAS.agenda, PANTALLAS.historia],
    [PANTALLAS.historia, PANTALLAS.caja],
  ]

  /* ----- Lo que se puede tocar ----- */
  const HOT = {
    recep: { person: "recep" },
    doctora: { person: "doctora" },
    caja: { person: "caja" },
    director: { person: "director" },
    sofi: { agent: "sofi" },
    clio: { agent: "clio" },
    argos: { agent: "argos" },
    bot: { agent: "bot" },
    mensajes: { at: [-3.5, 1.95, 0.82], box: [1.7, 1.1, 0.8, -2.65, 2, 0.82] },
    papeles: { at: [-1.75, 1.28, 0.95], box: [2.4, 0.6, 0.7, -2.1, 0.92, 0.95] },
    fichas: { at: [-0.72, 1.05, 1.02], box: [0.55, 0.3, 0.6, -0.9, 0.75, 1.0] },
    sala: { at: [-5.45, 0.92, 2.55], box: [1.1, 1.2, 3.2, -5.2, 0.5, 1.5] },
    agenda: { at: [-1.95, 2.04, -4.2], box: [2.4, 1.15, 0.25, -1.95, 1.33, -4.2] },
    archivo: { at: [-5.15, 1.72, -4.05], box: [1.4, 1.6, 0.45, -5.15, 0.78, -4.05] },
    notas: { at: [1.55, 0.98, -3.5], box: [2.2, 0.75, 0.9, 2.4, 0.6, -3.7] },
    perdidos: { at: [-1.6, 1.2, 7.6], box: [6.6, 1.7, 3.2, -1.6, 0.7, 9] },
    pantallas: {
      at: [PANTALLAS.agenda.x, 1.72, PANTALLAS.agenda.z],
      box: [1, 1.6, 0.4, PANTALLAS.agenda.x, 0.9, PANTALLAS.agenda.z],
    },
  }
  const ANCHOR = {
    mensajes: [-2.65, 2.55, 0.82],
    papeles: [-1.5, 1.42, 0.95],
    agenda: [-1.95, 2.36, -4.2],
    notas: [2.4, 1.1, -3.7],
    perdidos: [-1.6, 1.72, 7.65],
    ficha1: [-0.98, 1.05, 0.92],
    ficha2: [-0.3, 0.9, 1.5],
    ficha3: [-1.55, 0.9, 1.55],
    "p-mensajes": [PANTALLAS.mensajes.x, 1.62, PANTALLAS.mensajes.z],
    "p-agenda": [PANTALLAS.agenda.x, 1.62, PANTALLAS.agenda.z],
    "p-historia": [PANTALLAS.historia.x, 1.62, PANTALLAS.historia.z],
    "p-caja": [PANTALLAS.caja.x, 1.62, PANTALLAS.caja.z],
    "sala-recepcion": [-0.5, 0.04, 1.28],
    "sala-consultorio": [5.1, 0.04, -0.2],
    "sala-administracion": [-4.3, 0.04, -1.55],
    "sala-caja": [5.3, 0.04, 3.2],
  }
  const hits = new THREE.Group()
  scene.add(hits)
  const hitMat = new THREE.MeshBasicMaterial({ visible: false })
  for (const [k, h] of Object.entries(HOT)) {
    if (!h.box) continue
    const [w, ht, d, x, y, z] = h.box
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, ht, d), hitMat)
    m.position.set(x, y, z)
    m.userData.hot = k
    hits.add(m)
  }
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()

  /* ----- Los momentos: un tema y con qué trabaja la clínica; los dice la página ----- */
  const layers = [...slide.querySelectorAll(":scope > .layer")]
  const MOMENTS = layers.map((l) => ({
    topic: l.dataset.topic,
    sc: l.dataset.sc,
    key: `${l.dataset.topic}-${l.dataset.sc}`,
    hold: Number(l.dataset.hold) || 9000,
  }))
  const moment = () => MOMENTS[ctl.step]
  const CAST = {
    "dia-con": ["sofi", "clio"],
    "noche-con": ["sofi"],
    "mostrador-con": ["sofi"],
    "consulta-con": ["clio"],
    "fueron-con": ["sofi", "argos"],
    "direccion-con": ["argos"],
    "tesis-con": ["sofi", "clio", "argos"],
    "fin-con": ["sofi", "clio", "argos"],
    "dia-bot": ["bot"],
  }
  const castOf = (m) => CAST[m.key] ?? []
  /** Dónde mira la cámara: la imagen se corre a la derecha del texto, así que la sala queda ahí. */
  const VIEW = {
    dia: { look: LOOK, dist: 1 },
    noche: { look: LOOK, dist: 1 },
    mostrador: { look: V(-2.0, 0.25, 1.45), dist: 0.56 },
    consulta: { look: V(3.3, 0.25, -2.1), dist: 0.58 },
    fueron: { look: V(-0.5, 0, 4.4), dist: 0.86 },
    direccion: { look: V(-3.0, 0.25, -2.9), dist: 0.56 },
    tesis: { look: LOOK, dist: 1 },
    fin: { look: LOOK, dist: 1 },
  }
  const lightOf = (m) => {
    if (m.topic === "noche") return LIGHT.noche
    if (m.sc !== "con") return LIGHT.sin
    if (m.topic === "fueron" || m.topic === "direccion") return LIGHT.recupera
    return m.topic === "fin" || m.topic === "tesis" ? LIGHT.fin : LIGHT.con
  }
  /** Cuánto desorden se ve: el chatbot no lo toca; el CRM pasa una parte a sus pantallas. */
  const messOf = (m) => {
    // Con odentIA las notas y el reporte se van en su momento, no antes.
    if (m.sc === "con") {
      return {
        general: 0,
        notas: m.topic === "consulta" ? 1 : 0,
        reporte: m.topic === "fueron" || m.topic === "direccion" ? 1 : 0,
      }
    }
    if (m.sc === "crm") return { general: 0.42, notas: 0.6, reporte: 0.6 }
    return { general: 1, notas: 1, reporte: 1 }
  }

  const cardsRoot = slide.querySelector(".cl-cards")
  const NAMES = (cardsRoot.dataset.names || "").split("|")
  const cardEl = slide.querySelector(".cl-card")
  const tipEl = slide.querySelector(".cl-tip")
  const pins = [...slide.querySelectorAll(".cl-pin")].map((node, i) => {
    node.style.setProperty("--pd", `${(i * 0.37) % 2.6}s`)
    return { node, hot: node.dataset.hot }
  })
  const WHEN = { hoy: "sin", bot: "bot", crm: "crm", con: "con" }
  const articleOfHot = (hot, sc) =>
    cardsRoot.querySelector(`[data-hot="${hot}"][data-when="${WHEN[sc]}"]`)
  const articleFor = (s) => {
    if (!s.hot) return cardsRoot.querySelector(`[data-story="${s.person.story}"]`)
    // Con chatbot o CRM, lo que no cambia sigue diciendo lo de hoy.
    const sc = moment().sc
    return (
      articleOfHot(s.hot, sc) ?? (sc === "bot" || sc === "crm" ? articleOfHot(s.hot, "hoy") : null)
    )
  }
  const lives = [...slide.querySelectorAll(".cl-hud [data-live], .cl-names [data-live]")]
  let nightBase = { atendidos: 0, agendados: 0 }
  const liveValue = (k) => {
    const c = sim.counts
    if (k === "huecos") return AGENDA_HUECOS - Math.max(0, boardShown)
    if (k === "llenos") return Math.max(0, boardShown)
    // Los contadores de arriba empiezan de nuevo con los agentes; lo de antes se dice aparte.
    const a = sim.antes
    if (k === "hudLlegaron") return c.llegaron - (a ? a.llegaron - a.enEspera : 0)
    if (k === "hudAtendidos") return c.atendidos - (a?.atendidos ?? 0)
    if (k === "hudFueron") return c.fueron - (a?.fueron ?? 0)
    if (k === "antesLlegaron") return a?.llegaron ?? 0
    if (k === "antesFueron") return a?.fueron ?? 0
    if (k === "nocheAtendidos") return Math.max(0, c.atendidos - nightBase.atendidos)
    if (k === "nocheCitas") return Math.max(0, c.agendados - nightBase.agendados)
    return c[k] ?? 0
  }
  const paintLive = (nodes) => {
    for (const n of nodes) {
      const value = String(liveValue(n.dataset.live))
      if (n.textContent !== value) n.textContent = value
    }
  }
  const waitWords = (seconds) => {
    // Un segundo de simulación son unos minutos de un día de clínica: es un ejemplo.
    const min = Math.max(1, Math.round(seconds * 4))
    if (min < 60) return `${min} min`
    return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`
  }

  /* ----- La pantalla de muestra de un objeto: la misma de «Todo lo de siempre» ----- */
  const shot = slide.querySelector(".cl-shot")
  let shotRun = 0
  function openShot(key) {
    const make = window.ModuleScreens?.[key]
    if (!make) return
    const screen = make()
    const run = ++shotRun
    shot.querySelector(".msc-t").textContent = screen.title
    shot.querySelector(".msc-s").textContent = screen.sub
    shot.querySelector(".msc-zero").textContent = `${shot.dataset.cur} 0 al mes`
    shot.querySelector(".msc-b").replaceChildren(screen.body)
    shot.classList.add("open")
    const wait = (ms) =>
      new Promise((res, rej) => {
        setTimeout(() => (run === shotRun ? res() : rej(STOP)), reduce ? Math.min(ms, 30) : ms)
      })
    screen.play(wait).catch(() => {})
    setTimeout(() => shot.querySelector(".msc-x").focus({ preventScroll: true }), 50)
  }
  function closeShot() {
    if (!shot.classList.contains("open")) return false
    shotRun++
    shot.classList.remove("open")
    return true
  }

  /* ----- La ficha que se abre al tocar ----- */
  let sel = null
  let selStory = ""
  const selRing = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.43, 40),
    new THREE.MeshBasicMaterial({
      color: "#ffffff",
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  )
  selRing.rotation.x = -Math.PI / 2
  selRing.visible = false
  scene.add(selRing)
  const fillCard = () => {
    const article = articleFor(sel)
    if (!article) return closeCard()
    const person = sel.person
    selStory = person?.story ?? ""
    cardEl.innerHTML = ""
    const copy = article.cloneNode(true)
    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.className = "cl-close"
    closeBtn.setAttribute("aria-label", "Cerrar")
    closeBtn.textContent = "×"
    cardEl.append(copy, closeBtn)
    if (article.dataset.screen && window.ModuleScreens?.[article.dataset.screen]) {
      const see = document.createElement("button")
      see.type = "button"
      see.className = "cl-see"
      see.dataset.screen = article.dataset.screen
      see.textContent = "Ver la pantalla"
      copy.append(see)
    }
    cardEl.style.setProperty(
      "--cc",
      CARD_COLOR[article.dataset.color] ?? (moment().sc === "con" ? "var(--sky)" : "var(--warn)"),
    )
    for (const n of cardEl.querySelectorAll('[data-field="nombre"]')) {
      n.textContent = person ? NAMES[person.name % NAMES.length] : ""
    }
    updateCardLive()
  }
  function updateCardLive() {
    if (!sel) return
    paintLive(cardEl.querySelectorAll("[data-live]"))
    if (sel.person) {
      for (const n of cardEl.querySelectorAll('[data-field="espera"]')) {
        n.textContent = waitWords(sim.waited(sel.person))
      }
    }
  }
  function select(next) {
    sel = next
    for (const p of pins) p.node.classList.toggle("sel", !!sel && sel.hot === p.hot)
    fillCard()
    if (!sel) return
    cardEl.classList.add("on")
    tipEl.classList.remove("on")
    cardPos.fresh = true
    placeCard(0)
  }
  function closeCard() {
    if (!sel && !cardEl.classList.contains("on")) return
    sel = null
    cardEl.classList.remove("on")
    selRing.visible = false
    for (const p of pins) p.node.classList.remove("sel")
  }
  const toStage = (v) => {
    v.project(cam)
    return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H]
  }
  const pointOf = (s) => {
    if (s.person) {
      const v = look[s.person.id]
      return pv.set(s.person.x, topOf(v) + 0.12, s.person.z)
    }
    const h = HOT[s.hot]
    if (h.person) {
      const p = sim.team[h.person]
      return pv.set(p.x, topOf(look[p.id]) + 0.12, p.z)
    }
    if (h.agent) return pv.set(AGENT_PLACE[h.agent].x, 1.95, AGENT_PLACE[h.agent].z)
    return pv.set(h.at[0], h.at[1], h.at[2])
  }
  const cardPos = { x: 0, y: 0, fresh: true }
  function placeCard(dt) {
    if (!sel) return
    const [ax, ay] = toStage(pointOf(sel).clone())
    const w = cardEl.offsetWidth
    const h = cardEl.offsetHeight
    // Encima de lo tocado; si no cabe, debajo.
    const margin = 18
    let y = ay - h - margin
    if (y < 96) y = ay + 46
    const x = clamp(ax - w / 2, 14, W - w - 14)
    y = clamp(y, 14, H - h - 14)
    if (cardPos.fresh) {
      cardPos.x = x
      cardPos.y = y
      cardPos.fresh = false
    } else {
      cardPos.x = damp(cardPos.x, x, 7, dt)
      cardPos.y = damp(cardPos.y, y, 7, dt)
    }
    cardEl.style.transform = `translate(${cardPos.x.toFixed(1)}px, ${cardPos.y.toFixed(1)}px)`
  }

  /* ----- Qué hay bajo el puntero ----- */
  const stagePoint = (e) => {
    const r = renderer.domElement.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]
  }
  const hv = new THREE.Vector3()
  const segDist = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax
    const vy = by - ay
    const u = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1))
    return Math.hypot(px - (ax + vx * u), py - (ay + vy * u))
  }
  function pickAt(sx, sy) {
    // En un teléfono la parte se ve pequeña: alcanzar a alguien se mide en la pantalla, no en la maqueta.
    const k = renderer.domElement.getBoundingClientRect().width / W || 1
    const reach = Math.max(24, 20 / k)
    let best = null
    let bestD = reach
    for (const p of sim.people) {
      if (!p.active) continue
      const v = look[p.id]
      const [ax, ay] = toStage(hv.set(p.x, v.y, p.z))
      const [bx, by] = toStage(hv.set(p.x, topOf(v), p.z))
      const d = segDist(sx, sy, ax, ay, bx, by)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    if (best) return best.kind === "equipo" ? { hot: best.key } : { person: best }
    for (const name of Object.keys(FIGURES)) {
      if (agents[name].want < 0.5) continue
      const [ax, ay] = toStage(hv.set(AGENT_PLACE[name].x, 0, AGENT_PLACE[name].z))
      const [bx, by] = toStage(hv.set(AGENT_PLACE[name].x, 1.7, AGENT_PLACE[name].z))
      if (segDist(sx, sy, ax, ay, bx, by) < reach + 4) return { hot: name }
    }
    ndc.set((sx / W) * 2 - 1, -(sy / H) * 2 + 1)
    ray.setFromCamera(ndc, cam)
    const hit = ray.intersectObjects(hits.children, false)[0]
    return hit ? { hot: hit.object.userData.hot } : null
  }
  const labelOf = (s) => {
    if (s.person) return NAMES[s.person.name % NAMES.length]
    const pin = pins.find((p) => p.hot === s.hot)
    return pin?.node.getAttribute("aria-label") ?? ""
  }

  /* ----- Los botones: saltan a un tema, o a con qué trabaja la clínica ----- */
  const goKey = (key) => {
    const i = MOMENTS.findIndex((m) => m.key === key)
    if (i >= 0 && i !== ctl.step) ctl.go?.(i)
  }
  const pressTopic = (topic) => {
    const sc = moment().sc
    goKey(`${topic}-${sc === "con" ? "con" : "hoy"}`)
  }
  const pressScenario = (sc) => {
    if (sc === "bot" || sc === "crm") return goKey(`dia-${sc}`)
    const t = moment().topic
    return goKey(`${t === "tesis" || t === "fin" ? "dia" : t}-${sc}`)
  }
  const topicBtns = [...slide.querySelectorAll(".cl-b.tp")]
  const scBtns = [...slide.querySelectorAll(".cl-b.sc")]
  const syncBar = (m) => {
    // Chatbot y CRM se ven enteros: no se les elige un tema.
    for (const b of topicBtns) {
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.topic === m.topic && (m.sc === "hoy" || m.sc === "con")),
      )
    }
    for (const b of scBtns) b.setAttribute("aria-pressed", String(b.dataset.sc === m.sc))
  }

  slide.addEventListener("click", (e) => {
    if (!ctl.active) return
    const t = e.target instanceof Element ? e.target : null
    if (t?.closest(".cl-shot")) {
      e.stopPropagation()
      if (t.closest(".cl-shot-x")) closeShot()
      return
    }
    if (t?.closest(".cl-bar")) {
      e.stopPropagation()
      const b = t.closest("button")
      if (!b) return
      if (b.classList.contains("cl-guide")) setGuide(!guide.on)
      else if (b.dataset.topic) pressTopic(b.dataset.topic)
      else if (b.dataset.sc) pressScenario(b.dataset.sc)
      return
    }
    if (t?.closest(".cl-close")) {
      e.stopPropagation()
      closeCard()
      return
    }
    if (t?.closest(".cl-see")) {
      e.stopPropagation()
      openShot(t.closest(".cl-see").dataset.screen)
      return
    }
    if (t?.closest(".cl-card")) {
      e.stopPropagation()
      return
    }
    const pin = t?.closest(".cl-pin")
    if (pin) {
      e.stopPropagation()
      select({ hot: pin.dataset.hot })
      return
    }
    const [sx, sy] = stagePoint(e)
    const hit = pickAt(sx, sy)
    if (hit && articleFor(hit)) {
      e.stopPropagation()
      select(hit)
      return
    }
    if (sel) {
      e.stopPropagation()
      closeCard()
      return
    }
    // Se está explorando: errarle a una persona que camina no cambia de momento. Avanzan las flechas.
    if (!stacked()) e.stopPropagation()
  })
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !ctl.active) return
    if (!closeShot()) closeCard()
  })
  slide.addEventListener("keydown", (e) => {
    // Enter o espacio en un botón de la clínica lo aprietan; la presentación no avanza.
    const t = e.target instanceof Element ? e.target : null
    if (
      (e.key === "Enter" || e.key === " ") &&
      t?.closest(".cl-pin, .cl-close, .cl-see, .cl-b, .msc-x")
    ) {
      e.stopPropagation()
    }
  })
  let hoverAt = null
  slide.addEventListener("pointermove", (e) => {
    if (!ctl.active || e.pointerType === "touch") return
    hoverAt = stagePoint(e)
  })
  slide.addEventListener("pointerleave", () => {
    hoverAt = null
    tipEl.classList.remove("on")
    slide.classList.remove("cl-hover")
  })
  function applyHover() {
    if (!hoverAt) return
    const [sx, sy] = hoverAt
    hoverAt = null
    const hit = pickAt(sx, sy)
    const can = hit && articleFor(hit)
    slide.classList.toggle("cl-hover", !!can)
    if (can) {
      tipEl.textContent = labelOf(hit)
      tipEl.style.left = `${sx}px`
      tipEl.style.top = `${sy}px`
    }
    tipEl.classList.toggle("on", !!can && !sel)
  }

  /* ----- Lo que va pegado a la maqueta ----- */
  const anchored = [...slide.querySelectorAll("[data-anchor]")]
    .map((node) => ({ node, at: ANCHOR[node.dataset.anchor] }))
    .filter((a) => a.at)
    .map((a) => ({ node: a.node, at: V(...a.at) }))
  const followers = [...slide.querySelectorAll("[data-follow]")].map((node) => ({
    node,
    key: node.dataset.follow,
  }))
  const shownBy = [...slide.querySelectorAll("[data-show]")].map((node) => ({
    node,
    keys: node.dataset.show.split(" "),
  }))
  const v3 = new THREE.Vector3()
  const stacked = () => document.documentElement.classList.contains("stacked")
  /** La parte de la imagen donde se ve la maqueta: a la izquierda va el texto y arriba los botones. */
  const inView = (x, y) => stacked() || (x > 660 && y > 104 && x < W - 8 && y < H - 8)
  const placeAnchors = () => {
    cam.updateMatrixWorld()
    const near = stacked()
    for (const a of anchored) {
      if (a.node.hidden) continue
      const [x, y] = toStage(v3.copy(a.at))
      a.node.style.opacity = inView(x, y) ? "" : "0"
      a.node.style.left = `${(near ? clamp(x, 900, 1760) : x).toFixed(1)}px`
      a.node.style.top = `${(near ? clamp(y, 90, 1040) : y).toFixed(1)}px`
    }
    slide.classList.add("cl-ready")
  }
  const followPoint = (k) => {
    if (AGENT_PLACE[k]) return v3.set(AGENT_PLACE[k].x, 1.75, AGENT_PLACE[k].z)
    const p = sim.team[k]
    return v3.set(p.x, topOf(look[p.id]) + 0.1, p.z)
  }
  const placeFollowers = () => {
    for (const f of followers) {
      const hidden =
        f.node.classList.contains("hide") ||
        (f.node.classList.contains("cl-say") && !f.node.classList.contains("on"))
      if (hidden) continue
      const [x, y] = toStage(followPoint(f.key))
      f.node.style.left = `${x.toFixed(1)}px`
      f.node.style.top = `${y.toFixed(1)}px`
    }
    for (const pin of pins) {
      if (!pin.node.classList.contains("show")) continue
      const h = HOT[pin.hot]
      let x
      let y
      if (h.at) [x, y] = toStage(v3.set(h.at[0], h.at[1], h.at[2]))
      else {
        ;[x, y] = toStage(followPoint(h.person ?? h.agent))
        y += 8
      }
      pin.node.style.visibility = inView(x, y) ? "" : "hidden"
      pin.node.style.left = `${x.toFixed(1)}px`
      pin.node.style.top = `${y.toFixed(1)}px`
    }
  }
  const says = Object.fromEntries(
    [...slide.querySelectorAll("[data-say]")].map((n) => [n.dataset.say, n]),
  )
  const names = Object.fromEntries(
    [...slide.querySelectorAll("[data-name]")].map((n) => [n.dataset.name, n]),
  )
  const hushAll = () => {
    for (const n of Object.values(says)) n.classList.remove("on")
  }

  /* ----- Los tiempos de cada momento ----- */
  const sleep = (ms) => {
    const id = ctl.run
    return new Promise((res, rej) => {
      setTimeout(() => (id === ctl.run ? res() : rej(STOP)), reduce ? Math.min(ms, 30) : ms)
    })
  }
  const tween = (ms, f) => {
    const id = ctl.run
    return new Promise((res, rej) => {
      const t0 = performance.now()
      const D = reduce ? 1 : ms
      const go = (now) => {
        if (id !== ctl.run) return rej(STOP)
        const p = clamp01((now - t0) / D)
        f(p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2)
        if (p < 1) requestAnimationFrame(go)
        else res()
      }
      requestAnimationFrame(go)
    })
  }
  const say = async (k, ms) => {
    says[k].classList.add("on")
    placeFollowers()
    await sleep(ms)
    says[k].classList.remove("on")
  }
  const showAgent = (k) => {
    agents[k].want = 1
    agents[k].beat = 1
    names[k]?.classList.remove("hide")
  }
  const headOf = (key) => {
    const p = sim.team[key]
    return V(p.x, 1.2, p.z)
  }
  const inLayer = (sel2) => layers[ctl.step].querySelector(sel2)
  const clockText = (minutes) => {
    const m = Math.round(minutes) % 1440
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
  }
  const setClock = (minutes) => {
    const n = inLayer("[data-clock]")
    if (n) n.textContent = clockText(minutes)
  }
  const setBig = (text) => {
    const n = inLayer("[data-big]")
    if (n) n.textContent = text
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`
  /** Lleva la clínica a los agentes: lo mismo desde cualquier tema. */
  const toAgents = () => {
    sim.withAgents()
    paintClash()
    messWant.general = 0
  }
  /** Amanece: sube la luz, corre el reloj y el equipo vuelve. */
  const sunrise = async (light) => {
    lightWant = light
    await tween(1900, (e) => setClock(22 * 60 + 47 + e * (9 * 60 + 13)))
    sim.dawn()
    refreshPins()
  }
  const PLAY = {
    "dia-hoy": async () => {
      await sleep(1600)
      for (;;) {
        for (const k of ["s-recep", "s-doctora", "s-director", "s-caja"]) {
          await say(k, 2300)
          await sleep(1500)
        }
      }
    },
    "dia-con": async () => {
      await sleep(350)
      showAgent("sofi")
      await sleep(500)
      toAgents()
      await say("sofi-recep", 3400)
      showAgent("clio")
      await sleep(500)
      pulse(agentV("clio"), headOf("doctora"), COLOR.clio, 0.9, 1)
      await say("clio-dra", 2500)
      await say("dra-ok", 1400)
      messWant.notas = 0
      await sleep(1600)
      pulse(agentV("sofi"), headOf("doctora"), COLOR.sofi, 1, 1.4)
      await say("sofi-dra", 3200)
    },
    "noche-hoy": async () => {
      setClock(22 * 60 + 47)
      await sleep(11000)
      await sunrise(LIGHT.sin)
      await sleep(3000)
      await say("s-buenos", 4200)
    },
    "noche-con": async () => {
      setClock(22 * 60 + 47)
      await sleep(300)
      showAgent("sofi")
      await sleep(500)
      toAgents()
      await say("sofi-noche", 4200)
      await sleep(7500)
      await sunrise(LIGHT.con)
      await sleep(3000)
      await say("mientras", 6000)
    },
    "mostrador-hoy": async () => {
      setBig("0:00")
      tween(7500, (e) => setBig(mmss(e * 460))).catch(() => {})
      await sleep(1200)
      await say("s-busca", 3200)
    },
    "mostrador-con": async () => {
      setBig("7:40")
      await sleep(350)
      showAgent("sofi")
      await sleep(400)
      toAgents()
      await say("sofi-lucia", 3200)
      await tween(1300, (e) => setBig(mmss(4 + (1 - e) * 456)))
      setBig("0:04")
    },
    "consulta-hoy": async () => {
      setBig("14")
      await sleep(1500)
      await say("s-nota", 3600)
    },
    "consulta-con": async () => {
      setBig("14")
      await sleep(300)
      toAgents()
      showAgent("clio")
      await sleep(700)
      pulse(agentV("clio"), headOf("doctora"), COLOR.clio, 0.9, 1)
      await say("clio-dra", 2600)
      await say("dra-ok", 1400)
      messWant.notas = 0
      await tween(1500, (e) => setBig(String(Math.round(14 * (1 - e)))))
      const big = inLayer("[data-big]")
      if (big?.nextElementSibling) big.nextElementSibling.textContent = "notas pendientes · ejemplo"
    },
    "fueron-hoy": async () => {},
    "fueron-con": async () => {
      await sleep(300)
      toAgents()
      showAgent("sofi")
      showAgent("argos")
      if (!reduce) {
        scan.material.opacity = 0.9
        tween(2000, (e) => {
          scan.scale.setScalar(0.6 + e * 15)
          scan.material.opacity = 0.9 * (1 - e)
        }).catch(() => {})
      }
      await sleep(900)
      pulse(agentV("argos"), headOf("director"), COLOR.argos, 0.7, 0.7)
      await say("argos-dir", 2900)
      await say("dir-ok", 1300)
      messWant.reporte = 0
      pulse(agentV("argos"), agentV("sofi"), COLOR.argos, 0.9, 1.4)
      sim.startRecovery()
      await say("argos-sofi", 2600)
    },
    "direccion-hoy": async () => {
      tween(6500, (e) => {
        const m = Math.round(e * 520)
        setBig(`${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`)
      }).catch(() => {})
      await sleep(1600)
      await say("s-excel", 3200)
    },
    "direccion-con": async () => {
      await sleep(300)
      toAgents()
      showAgent("argos")
      await sleep(600)
      await say("dir-pregunta", 2600)
      pulse(agentV("argos"), headOf("director"), COLOR.argos, 0.7, 0.7)
      messWant.reporte = 0
      await say("argos-responde", 3600)
    },
    "dia-bot": async () => {
      await sleep(1200)
      await say("bot-dice", 3000)
      await sleep(900)
      await say("b-recep", 3400)
    },
    "dia-crm": async () => {
      await sleep(1200)
      await say("c-recep", 3000)
      await sleep(900)
      await say("c-director", 2800)
    },
    "tesis-con": async () => {},
    "fin-con": async () => {},
  }

  /* ----- Armar un momento ----- */
  function setMess(values, snap) {
    Object.assign(messWant, values)
    if (!snap) return
    Object.assign(mess, values)
    paintSheets()
    paintStickies()
    const s = clamp01(mess.general * 1.6 - 0.1)
    for (const c of cartons) {
      c.visible = s > 0.02
      c.scale.setScalar(Math.max(s, 0.001))
    }
    folders.forEach((f, i) => {
      if (!i) return
      f.m.position.x = folders[0].x + (f.x - folders[0].x) * s
      f.m.position.z = folders[0].z + (f.z - folders[0].z) * s
      f.m.visible = s > 0.04
    })
    shadowDirty = 1
  }
  function setCast(m, snap) {
    const on = castOf(m)
    for (const k of Object.keys(FIGURES)) {
      const yes = on.includes(k)
      const st = agents[k]
      if (snap) Object.assign(st, { want: yes ? 1 : 0, shown: yes ? 1 : 0, gap: yes ? 0.56 : 1.1 })
      else if (!yes) st.want = 0
      names[k]?.classList.toggle("hide", !(snap && yes) && !(!snap && st.want > 0.5))
    }
  }
  function refreshPins() {
    const m = moment()
    const cast = castOf(m)
    for (const p of pins) {
      let on = !!articleOfHot(p.hot, m.sc)
      if (FIGURES[p.hot]) on = on && cast.includes(p.hot)
      if (HOT[p.hot].person && sim.team[HOT[p.hot].person].away) on = false
      p.node.classList.toggle("show", on)
    }
  }
  /** Llega a un momento con la clínica ya en marcha, sin que se vea el camino. */
  function prewarm(m) {
    sim.reset()
    if (m.sc === "bot" || m.sc === "crm") sim.setFlavor(m.sc)
    sim.advance(m.sc === "crm" ? 115 : 100)
    if (m.topic === "noche") {
      sim.closeNow()
      nightBase = { atendidos: sim.counts.atendidos, agendados: sim.counts.agendados }
    }
    if (m.sc === "con") sim.withAgents()
    if (m.topic === "noche" || m.sc === "con") sim.advance(m.topic === "noche" ? 14 : 28)
    if (m.sc === "con" && (m.topic === "fueron" || m.topic === "fin" || m.topic === "tesis")) {
      sim.startRecovery()
      sim.advance(m.topic === "fueron" ? 8 : 42)
    }
    pulses.length = 0
    cloudShown = sim.counts.sinResponder
    for (const s of cloudSpots) s.s = 0
    for (const v of look) {
      v.snap = true
      v.bubS = 0
      v.bub = null
    }
    boardShown = -1
    setBoard(Math.min(AGENDA_HUECOS, sim.counts.agendados))
    setMess(messOf(m), true)
    setCast(m, true)
  }
  function applyMoment(m) {
    slide.classList.toggle("cl-sin", m.sc !== "con")
    slide.classList.toggle("cl-con", m.sc === "con")
    slide.classList.toggle("cl-sc-con", m.sc === "con")
    slide.classList.toggle("cl-sc-bot", m.sc === "bot")
    slide.classList.toggle("cl-sc-crm", m.sc === "crm")
    slide.classList.toggle(
      "cl-hud-on",
      (m.sc === "hoy" || m.sc === "con") && ["dia", "noche", "fueron", "fin"].includes(m.topic),
    )
    for (const s of shownBy) s.node.hidden = !s.keys.includes(m.key)
    const showCrm = m.sc === "crm"
    if (crm.visible !== showCrm) {
      crm.visible = showCrm
      shadowDirty = 1
    }
    syncBar(m)
    refreshPins()
  }
  function goTo(step, snap) {
    const from = ctl.step
    ctl.run++
    ctl.step = step
    const m = MOMENTS[step]
    const prev = MOMENTS[from]
    closeCard()
    closeShot()
    hushAll()
    // Se ve el camino solo de «hoy» a «con odentIA» en el mismo tema; lo demás ya está en ese momento.
    const flows =
      !snap &&
      !reduce &&
      step === from + 1 &&
      ((prev.topic === m.topic &&
        prev.sc === "hoy" &&
        m.sc === "con" &&
        (m.topic !== "noche" || sim.night)) ||
        (prev.sc === "con" && m.sc === "con"))
    lightWant = lightOf(m)
    if (flows) {
      setCast(m, false)
      for (const k of castOf(prev)) if (castOf(m).includes(k)) showAgent(k)
      // De la tesis al final ya están todos.
      if (prev.sc === "con") {
        for (const k of castOf(m)) showAgent(k)
        if (!sim.recovering) sim.startRecovery()
      }
    } else {
      prewarm(m)
      snapLight()
      if (!snap && !reduce) {
        renderer.domElement.animate([{ opacity: 0.15 }, { opacity: 1 }], {
          duration: 480,
          easing: "ease-out",
        })
      }
    }
    applyMoment(m)
    paintClash()
    PLAY[m.key]().catch((e) => {
      if (e !== STOP) throw e
    })
    aimCamera()
    if (snap) {
      camAt.copy(camGoal)
      camLook.copy(lookGoal)
      cam.position.copy(camAt)
      cam.lookAt(camLook)
    }
    placeAnchors()
    placeFollowers()
    paintLive(lives)
    guideAfterMove()
  }
  const camGoal = CAM.clone()
  const lookGoal = LOOK.clone()
  // De pie en el teléfono, la cámara se acerca a la recepción; acostado y en el escritorio, a cada tema.
  function aimCamera() {
    const m = moment()
    if (stacked()) {
      const v = VIEW[m.topic] ?? VIEW.dia
      lookGoal.set(v.look.x, v.look.y, v.look.z)
      camGoal.set(v.look.x + 4.1, 12.7, v.look.z + 15.4)
    } else {
      const v = VIEW[m.topic] ?? VIEW.dia
      lookGoal.copy(v.look)
      camGoal.copy(v.look).addScaledVector(CAM_DIR, v.dist)
    }
    ctl.moved = true
  }
  const CAM_DIR = CAM.clone().sub(LOOK)

  /* ----- «Explícame»: recorre los momentos solo, con los audios grabados, para quien la mira sin nadie ----- */
  const guide = { on: false, id: 0, self: false, finish: null }
  const guideBtn = slide.querySelector(".cl-guide")
  const voiceBase = slide.querySelector(".cl-bar").dataset.voz
  // Un solo reproductor: en los teléfonos solo sigue sonando el que arrancó con un toque.
  const voice = new Audio()
  /** Reproduce el audio del momento; si no está o no suena, el momento sigue sin voz. */
  const playClip = (key) =>
    new Promise((done) => {
      const finish = () => {
        voice.onended = null
        voice.onerror = null
        guide.finish = null
        done()
      }
      guide.finish = finish
      voice.onended = finish
      voice.onerror = finish
      voice.src = `${voiceBase}${key}.mp3`
      voice.play().catch(finish)
    })
  async function guideRun() {
    const id = ++guide.id
    const step = ctl.step
    const started = performance.now()
    await playClip(MOMENTS[step].key)
    const left = MOMENTS[step].hold - (performance.now() - started)
    if (left > 0 && !reduce) await new Promise((r) => setTimeout(r, left))
    if (id !== guide.id || !guide.on) return
    if (step >= layers.length - 1) return setGuide(false)
    guide.self = true
    ctl.go?.(step + 1)
    guide.self = false
  }
  function setGuide(on) {
    guide.on = on
    guide.id++
    guideBtn.setAttribute("aria-pressed", String(on))
    guideBtn.textContent = on ? "■ Detener" : "▶ Explícame"
    voice.pause()
    guide.finish?.()
    if (on) guideRun()
  }
  /** Quien aprieta una flecha o un botón retoma el control: la explicación se detiene. */
  function guideAfterMove() {
    if (!guide.on) return
    if (guide.self) guideRun()
    else setGuide(false)
  }

  /* ----- Lo que manda la simulación ----- */
  const botAt = () => agentV("bot")
  function handleEvents() {
    for (const ev of sim.drain()) {
      const p = ev.p
      const at = p ? V(p.x, 1.25, p.z) : null
      switch (ev.type) {
        case "mensaje":
          pulse(at, V(-2.65, 1.9, 0.82), "#e8927c", 0.8, 1)
          break
        case "botResponde":
          agents.bot.beat = 1
          pulse(botAt(), at, "#c9d3d6", 0.55, 1.1)
          break
        case "respuesta":
          agents.sofi.beat = 1
          pulse(agentV("sofi"), at, COLOR.sofi, 0.65, 1.2)
          break
        case "mensajeCon":
          pulse(at, agentV("sofi"), COLOR.sofi, 0.5, 0.9)
          break
        case "agenda":
          pulse(at, V(-1.95, 1.4, -4.2), COLOR.clio, 1.05, 1.9, () =>
            setBoard(Math.min(AGENDA_HUECOS, boardShown + 1)),
          )
          break
        case "limpia": {
          const s = cloudSpots[Math.min(cloudShown, CLOUD) - 1]
          agents.sofi.beat = 1
          if (s) pulse(V(s.x, s.y, s.z), agentV("sofi"), COLOR.sofi, 0.5, 0.45)
          break
        }
        case "recupera":
          agents.argos.beat = 1
          pulse(agentV("argos"), agentV("sofi"), COLOR.argos, 0.5, 1.1, () => {
            agents.sofi.beat = 1
            pulse(agentV("sofi"), V(p.x, 1.25, p.z), COLOR.sofi, 0.75, 1.5)
          })
          break
        default:
          break
      }
    }
  }
  function drawSprites(dt, t) {
    bubbles.begin()
    for (const p of sim.people) {
      if (!p.active) continue
      const v = look[p.id]
      const want = p.bubble
      if (want !== v.bub) {
        if (v.bubS < 0.05 || !v.bub) {
          v.bub = want
          v.bubS = 0
        } else {
          v.bubS = Math.max(0, v.bubS - dt * 9)
        }
      } else if (v.bub) v.bubS = reduce ? 1 : Math.min(1, v.bubS + dt * 5.5)
      if (!v.bub || v.bubS <= 0.02) continue
      const s = v.bubS
      // Entra con un rebote pequeño, como un globo.
      const pop = s < 1 ? s + Math.sin(s * Math.PI) * 0.3 : 1
      const bob = reduce ? 0 : Math.sin(t * 2.6 + p.id) * 0.018
      bubbles.add(p.x, topOf(v) + 0.24 + bob, p.z, (v.bub === "note" ? 30 : 44) * pop, CELL[v.bub])
    }
    const nCloud = Math.min(CLOUD, sim.counts.sinResponder)
    cloudShown = nCloud
    cloudSpots.forEach((c, i) => {
      c.s = damp(c.s, i < nCloud ? 1 : 0, 9, dt || 0.016)
      if (c.s < 0.04) return
      const bob = reduce ? 0 : Math.sin(t * 1.5 + c.seed) * 0.022
      bubbles.add(c.x, c.y + bob, c.z, 32 * c.s, CELL.msg)
    })
    if (crm.visible) for (const g of CRM_GAPS) bubbles.add(g.x, g.y, g.z, 30, CELL.x)
    bubbles.end()

    glows.begin()
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i]
      q.t += dt / q.dur
      if (q.t >= 1) {
        pulses.splice(i, 1)
        q.done?.()
        continue
      }
      for (let k = 0; k < 6; k++) {
        const u = q.t - k * 0.028
        if (u < 0) break
        q.curve.getPoint(u, pv)
        const fade = 1 - k / 6
        glows.add(pv.x, pv.y, pv.z, (k ? 22 : 34) * fade, CELL.glow, q.c.r, q.c.g, q.c.b, fade)
      }
    }
    glows.end()
  }
  function drawPeople(dt, t) {
    for (const p of sim.people) drawPerson(p, look[p.id], dt, t)
    for (const m of Object.values(parts)) {
      m.instanceMatrix.needsUpdate = true
      if (colorsDirty && m.instanceColor) m.instanceColor.needsUpdate = true
    }
    colorsDirty = false
  }
  function refreshCard(dt) {
    if (!sel) return
    if (sel.person) {
      if (!sel.person.active) {
        closeCard()
        return
      }
      if (sel.person.story !== selStory) fillCard()
      selRing.visible = true
      selRing.position.set(sel.person.x, 0.03, sel.person.z)
    } else {
      const h = HOT[sel.hot]
      if (h.person) {
        const p = sim.team[h.person]
        if (!p.active) {
          closeCard()
          return
        }
        selRing.visible = true
        selRing.position.set(p.x, 0.03, p.z)
      } else selRing.visible = false
    }
    selRing.scale.setScalar(1 + (reduce ? 0 : Math.sin(performance.now() / 260) * 0.08))
    placeCard(dt)
  }

  const frame = (dt, t) => {
    for (const f of updaters) f(dt, t)
    drawPeople(dt, t)
    drawSprites(dt, t)
    if (shadowDirty) {
      renderer.shadowMap.needsUpdate = true
      shadowDirty = 0
    }
  }
  const tick = (now) => {
    if (!ctl.active) return
    ctl.raf = requestAnimationFrame(tick)
    const dt = clamp((now - ctl.last) / 1000, 0, 0.05)
    ctl.last = now
    if (!reduce) sim.step(dt)
    handleEvents()
    frame(dt, now / 1000)
    if (ctl.moved) {
      const rate = reduce ? 1000 : 1.9
      camAt.x = damp(camAt.x, camGoal.x, rate, dt)
      camAt.y = damp(camAt.y, camGoal.y, rate, dt)
      camAt.z = damp(camAt.z, camGoal.z, rate, dt)
      camLook.x = damp(camLook.x, lookGoal.x, rate, dt)
      camLook.y = damp(camLook.y, lookGoal.y, rate, dt)
      camLook.z = damp(camLook.z, lookGoal.z, rate, dt)
      cam.position.copy(camAt)
      cam.lookAt(camLook)
      placeAnchors()
      if (camAt.distanceTo(camGoal) < 0.005 && camLook.distanceTo(lookGoal) < 0.005)
        ctl.moved = false
    }
    cam.updateMatrixWorld()
    placeFollowers()
    refreshCard(dt)
    applyHover()
    if (now - ctl.hudAt > 220) {
      ctl.hudAt = now
      paintLive(lives)
      updateCardLive()
      if (moment().topic === "noche") refreshPins()
    }
    renderer.render(scene, cam)
  }
  const fitRenderer = () => {
    const st = slide.closest(".stage")
    const k = st ? st.getBoundingClientRect().width / 1920 : 1
    const ratio = Math.max(0.75, Math.min(1.5, (window.devicePixelRatio || 1) * k))
    renderer.setPixelRatio(ratio)
    renderer.setSize(W, H, false)
    bubbles.material.uniforms.uPx.value = ratio
    glows.material.uniforms.uPx.value = ratio
    aimCamera()
    placeAnchors()
  }
  addEventListener("resize", fitRenderer)
  /** De pie, la parte que se deja sigue a la vista en su primer momento. */
  function rest() {
    ctl.step = 0
    const m = MOMENTS[0]
    prewarm(m)
    lightWant = lightOf(m)
    snapLight()
    applyMoment(m)
    aimCamera()
    camAt.copy(camGoal)
    camLook.copy(lookGoal)
    cam.position.copy(camAt)
    cam.lookAt(camLook)
    ctl.moved = false
    frame(0.016, performance.now() / 1000)
    placeAnchors()
    placeFollowers()
    paintLive(lives)
    renderer.render(scene, cam)
  }
  // La primera vez que se llega a esta parte no tiene que compilar nada.
  paintSheets()
  paintStickies()
  renderer.compile(scene, cam)

  return {
    start(step, go) {
      const alive = ctl.active
      ctl.stopping = false
      ctl.go = go
      if (!alive) fitRenderer()
      slide.classList.add("cl-live-on")
      goTo(step, !alive)
      if (alive) return
      ctl.active = true
      ctl.last = performance.now()
      cancelAnimationFrame(ctl.raf)
      ctl.raf = requestAnimationFrame(tick)
    },
    // Entre dos momentos de esta parte deck.js detiene y vuelve a empezar en el mismo paso: la
    // escena solo se apaga si nadie la retomó, así el cambio de luz y de postura no se corta.
    stop() {
      ctl.run++
      ctl.stopping = true
      queueMicrotask(() => {
        if (!ctl.stopping) return
        ctl.stopping = false
        ctl.active = false
        closeCard()
        closeShot()
        hushAll()
        setGuide(false)
        slide.classList.remove("cl-live-on")
        if (stacked()) rest()
      })
    },
  }
}

let ready
/** Arma la escena sin mostrarla, para que no frene la llegada a su parte. */
export function prepare(slide) {
  if (ready === undefined) ready = build(slide)
}
export function start(slide, step, go) {
  prepare(slide)
  ready?.start(step, go)
}
export function stop() {
  ready?.stop()
}
