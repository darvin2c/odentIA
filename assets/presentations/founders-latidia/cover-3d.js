// Portada en 3D: la línea de pulso de la marca, tres latidos a 72 por minuto (la misma forma que la
// portada de la web, apps/web/src/components/latidia/home/DictationDemo.tsx). Un trazo de luz la
// recorre como en un monitor; en cada pico se abre un anillo del color de un agente (Sofi, Clío,
// Argos) y el piso de puntos se enciende a su paso. Expone window.Cover3D.start/stop.
import * as THREE from "three"

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
const W = 941,
  H = 762
/** Un barrido completo: tres latidos a 72 por minuto. */
const PERIOD = 2.5
const AGENTS = ["#4fc3d7", "#a6f0d8", "#f5c46b"]
const LILA = "#b79cf0"

// La línea de la marca, en coordenadas del SVG de la web (600 × 80, la base en y = 50).
function ecgPath() {
  const path = new THREE.CurvePath()
  const P = (x, y) => new THREE.Vector3(((x - 300) / 600) * 13, ((50 - y) / 80) * 4.6, 0)
  let last = P(0, 50)
  const to = (x, y) => {
    const p = P(x, y)
    path.add(new THREE.LineCurve3(last, p))
    last = p
  }
  const wave = (cx, cy, x, y) => {
    const p = P(x, y)
    path.add(new THREE.QuadraticBezierCurve3(last, P(cx, cy), p))
    last = p
  }
  for (const o of [0, 200, 400]) {
    to(o + 40, 50)
    wave(o + 48, 42, o + 56, 50)
    to(o + 76, 50)
    to(o + 84, 58)
    to(o + 92, 8)
    to(o + 100, 72)
    to(o + 108, 50)
    to(o + 128, 50)
    wave(o + 142, 36, o + 156, 50)
    to(o + 200, 50)
  }
  return path
}

const LINE_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
// El trazo: brilla donde pasa la cabeza y se apaga detrás, como el fósforo de un monitor.
const LINE_FS = `varying vec2 vUv; uniform float uHead; uniform float uStill; uniform float uGain; uniform vec3 uColor;
void main(){ float d = uHead - vUv.x; if (d < 0.0) d += 1.0; float tail = exp(-d * 7.0);
float k = mix(tail, 0.75, uStill);
vec3 c = mix(uColor * 0.55, mix(uColor, vec3(1.0), smoothstep(0.55, 1.0, k)), k);
gl_FragColor = vec4(c * (0.4 + 1.3 * k) * uGain, (0.3 + k) * uGain); }`
const DOTS_VS = `uniform float uBeat; uniform float uBeatX; varying float vA;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
float ripple = uBeat * exp(-abs(position.x - uBeatX) * 0.45);
vA = (0.16 + ripple * 0.9) * smoothstep(-26.0, -8.0, mv.z) * (1.0 - smoothstep(9.0, 13.0, abs(position.x)));
gl_PointSize = (2.6 + ripple * 3.0) * (60.0 / -mv.z); gl_Position = projectionMatrix * mv; }`
const DOTS_FS = `varying float vA; uniform vec3 uColor;
void main(){ vec2 p = gl_PointCoord - 0.5; float r = dot(p, p); if (r > 0.25) discard; gl_FragColor = vec4(uColor, vA * (1.0 - r * 4.0)); }`

let ready = null
function build(host) {
  const box = host.querySelector(".pulse-gl")
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  } catch {
    host.classList.add("nogl")
    return null
  }
  renderer.setClearColor(0x000000, 0)
  renderer.setSize(W, H, false)
  box.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  const cam = new THREE.PerspectiveCamera(32, W / H, 0.1, 200)
  cam.position.set(0, 1.0, 17)
  cam.lookAt(0, 0.1, 0)
  const group = new THREE.Group()
  group.rotation.set(0.1, -0.3, 0)
  scene.add(group)

  const path = ecgPath()
  const line = (radius, gain) => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: LINE_VS,
      fragmentShader: LINE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uHead: { value: 0 }, uStill: { value: reduce ? 1 : 0 }, uGain: { value: gain }, uColor: { value: new THREE.Color(LILA) } },
    })
    group.add(new THREE.Mesh(new THREE.TubeGeometry(path, 1400, radius, 8, false), mat))
    return mat
  }
  // Un trazo fino y uno ancho y tenue, que hace de resplandor.
  const lines = [line(0.05, 1), line(0.2, 0.28)]

  // El piso de puntos, que se enciende donde late.
  const pos = []
  for (let x = -13; x <= 13; x += 0.55) for (let z = -16; z <= 4; z += 0.55) pos.push(x, -2.9, z)
  const dotsGeo = new THREE.BufferGeometry()
  dotsGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  const dotsMat = new THREE.ShaderMaterial({
    vertexShader: DOTS_VS,
    fragmentShader: DOTS_FS,
    transparent: true,
    depthWrite: false,
    uniforms: { uBeat: { value: 0 }, uBeatX: { value: 0 }, uColor: { value: new THREE.Color(LILA) } },
  })
  group.add(new THREE.Points(dotsGeo, dotsMat))

  const glowTex = (() => {
    const c = document.createElement("canvas")
    c.width = c.height = 128
    const x = c.getContext("2d")
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, "rgba(255,255,255,1)")
    g.addColorStop(0.25, "rgba(255,255,255,.5)")
    g.addColorStop(1, "rgba(255,255,255,0)")
    x.fillStyle = g
    x.fillRect(0, 0, 128, 128)
    return new THREE.CanvasTexture(c)
  })()
  const head = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color("#e9defc"), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
  )
  head.scale.setScalar(1.5)
  head.visible = !reduce
  group.add(head)

  // Dónde están los picos de los tres latidos, en la fracción del recorrido.
  const peaks = []
  let prevY = -9
  let rising = false
  for (let i = 0; i < 3000; i++) {
    const u = i / 3000
    const y = path.getPointAt(u).y
    if (y < prevY && rising && prevY > 1.8) peaks.push((i - 1) / 3000)
    rising = y > prevY
    prevY = y
  }

  const rings = []
  const ring = (u, k) => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.7, 64),
      new THREE.MeshBasicMaterial({ color: AGENTS[k], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    )
    m.position.copy(path.getPointAt(u))
    group.add(m)
    rings.push({ m, t0: performance.now() })
    dotsMat.uniforms.uBeatX.value = m.position.x
    dotsMat.uniforms.uBeat.value = 1
    dispatchEvent(new CustomEvent("cover-beat", { detail: k }))
  }

  const ctl = { active: false, t0: 0, last: 0, mx: 0, my: 0 }
  const tick = (now) => {
    if (!ctl.active) return
    requestAnimationFrame(tick)
    // El primer cuadro puede llegar con una hora anterior a la de start().
    const t = Math.max(0, now - ctl.t0) / 1000
    const u = reduce ? 1 : (t % PERIOD) / PERIOD
    for (const m of lines) m.uniforms.uHead.value = u
    const at = path.getPointAt(Math.min(u, 0.9999))
    if (at) head.position.copy(at)
    // Cada pico que pasa la cabeza abre el anillo de su agente.
    if (!reduce)
      peaks.forEach((p, k) => {
        const crossed = ctl.last <= u ? ctl.last < p && p <= u : ctl.last < p || p <= u
        if (crossed) ring(p, k)
      })
    ctl.last = u
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i],
        e = (now - r.t0) / 900
      r.m.scale.setScalar(0.3 + e * 2.6)
      r.m.material.opacity = Math.max(0, 0.9 * (1 - e))
      r.m.lookAt(cam.position)
      if (e >= 1) {
        group.remove(r.m)
        r.m.geometry.dispose()
        r.m.material.dispose()
        rings.splice(i, 1)
      }
    }
    dotsMat.uniforms.uBeat.value *= 0.94
    // Un poco de paralaje con el puntero, sin girar por girar.
    group.rotation.y += (-0.3 + ctl.mx * 0.12 - group.rotation.y) * 0.05
    group.rotation.x += (0.1 - ctl.my * 0.06 - group.rotation.x) * 0.05
    renderer.render(scene, cam)
  }
  const move = (e) => {
    const r = host.getBoundingClientRect()
    ctl.mx = ((e.clientX - r.left) / (r.width || 1)) * 2 - 1
    ctl.my = ((e.clientY - r.top) / (r.height || 1)) * 2 - 1
  }
  const leave = () => {
    ctl.mx = 0
    ctl.my = 0
  }
  const fit = () => {
    const st = host.closest(".stage")
    const k = st ? st.getBoundingClientRect().width / 1920 : 1
    renderer.setPixelRatio(Math.max(0.75, Math.min(2, (window.devicePixelRatio || 1) * k)))
    renderer.setSize(W, H, false)
  }
  addEventListener("resize", fit)
  return {
    start() {
      fit()
      ctl.active = true
      ctl.t0 = performance.now()
      ctl.last = 0
      host.addEventListener("pointermove", move)
      host.addEventListener("pointerleave", leave)
      requestAnimationFrame(tick)
    },
    stop() {
      ctl.active = false
      host.removeEventListener("pointermove", move)
      host.removeEventListener("pointerleave", leave)
    },
  }
}
window.Cover3D = {
  start(host) {
    ready = ready || build(host)
    ready?.start()
  },
  stop() {
    ready?.stop()
  },
}
dispatchEvent(new Event("cover-ready"))
