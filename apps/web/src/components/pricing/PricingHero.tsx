// Portada de Precios: entra el trabajo, sale el resultado y solo ese se cobra.
// En pantallas anchas, corchetes metálicos en WebGL (como los del logo); en el teléfono (≤ 720 px),
// corchetes en 2D con CSS para no cargar una escena 3D.
import { type PointerEvent, useEffect, useRef, useState } from "react"
import { usd, type ValuePrices } from "../../lib/pricing"
import "./pricing-hero.css"

type Pair = [string, string]
type Task = {
  time: string
  in: Pair
  inM?: Pair
  work: Pair
  workM?: Pair
  out: string
  outM?: string
  /** Qué acción cobra; null = no se cobra. */
  price: "conversation" | "consultation" | "recovered" | null
}

/** Ejemplo de un día. Los textos «M» son los del teléfono, más cortos. */
const TASKS: Task[] = [
  {
    time: "23:40",
    in: ["WhatsApp · Andrea", "«¿Tienen cita para mañana? Me duele una muela.»"],
    inM: ["WhatsApp · Andrea", "«¿Tienen cita para mañana?»"],
    work: ["Sofi · recepción", "Busca un horario y agenda"],
    out: "Conversación atendida",
    price: "conversation",
  },
  {
    time: "07:00",
    in: ["Recordatorio · Carlos", "Su cita es hoy a las 9:00."],
    work: ["Argos · administración", "Le recuerda la cita"],
    out: "Recordatorio enviado",
    price: null,
  },
  {
    time: "09:40",
    in: ["Consulta · Carlos", "«En la 36 hay caries oclusal profunda…»"],
    inM: ["Consulta · Carlos", "«En la 36 hay caries oclusal…»"],
    work: ["Clío · clínica", "Ordena el dictado en la historia"],
    workM: ["Clío · clínica", "Ordena el dictado"],
    out: "Nota confirmada por la doctora",
    outM: "Nota confirmada",
    price: "consultation",
  },
  {
    time: "11:05",
    in: ["Consulta · Miguel", "«Esta nota prefiero escribirla yo.»"],
    inM: ["Consulta · Miguel", "«Esta nota la escribo yo.»"],
    work: ["Clío · clínica", "Prepara las sugerencias"],
    out: "Borrador descartado",
    price: null,
  },
  {
    time: "16:05",
    in: ["Faltó a su cita · Rosa", "No llegó ayer a su limpieza."],
    inM: ["Faltó a su cita · Rosa", "No llegó ayer."],
    work: ["Argos · administración", "Le ofrece otro horario"],
    out: "Rosa volvió y la atendieron",
    price: "recovered",
  },
  {
    time: "16:20",
    in: ["Faltó a su cita · Pedro", "No llegó el lunes a su control."],
    inM: ["Faltó a su cita · Pedro", "No llegó el lunes."],
    work: ["Argos · administración", "Le ofrece otro horario"],
    out: "Pedro reservó, pero no vino",
    price: null,
  },
]
const ALL_DONE = [5, 4, 3, 2, 1, 0]
const NARROW = "(max-width: 720px)"

type Step = { task: number; phase: number; done: number[] }

function nextStep(s: Step): Step {
  if (s.phase < 3) {
    const phase = s.phase + 1
    return { ...s, phase, done: phase === 3 ? [s.task, ...s.done].slice(0, 12) : s.done }
  }
  const task = (s.task + 1) % TASKS.length
  return { task, phase: 0, done: task === 0 ? [] : s.done }
}

/** Escena WebGL: dos corchetes de supercuádricas con brillo metálico de estudio (geometría y shaders del lienzo). */
function startScene(
  cv: HTMLCanvasElement,
  live: { current: { still: boolean; phase: number; billable: boolean } },
  mouse: { current: { tmx: number; tmy: number } },
) {
  let gl: WebGLRenderingContext | null = null
  try {
    gl = cv.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true })
  } catch {
    gl = null
  }
  if (!gl) return () => {}
  const g = gl
  const vs =
    "attribute vec3 aP;attribute vec3 aN;uniform mat4 uPV;uniform mat3 uR;uniform vec3 uS;uniform vec3 uT;varying vec3 vN;varying vec3 vW;void main(){vec3 p=uR*(aP*uS)+uT;vN=normalize(uR*(aN/uS));vW=p;gl_Position=uPV*vec4(p,1.0);}"
  const fs =
    "precision mediump float;varying vec3 vN;varying vec3 vW;uniform vec3 uC;uniform vec3 uB;uniform float uG;void main(){vec3 n=normalize(vN);vec3 v=normalize(uC-vW);vec3 r=reflect(-v,n);float strip=smoothstep(0.75,0.98,1.0-abs(r.x-0.35))*smoothstep(0.0,0.6,r.y+0.3);vec3 env=mix(vec3(0.02,0.07,0.09),vec3(0.62,0.9,0.96),smoothstep(-0.2,0.85,r.y))+vec3(1.0)*strip*0.9;vec3 l1=normalize(vec3(-0.45,0.85,0.6));float d1=max(dot(n,l1),0.0);vec3 h=normalize(l1+v);float sp=pow(max(dot(n,h),0.0),120.0);float fr=pow(1.0-max(dot(n,v),0.0),3.0);vec3 col=uB*(0.1+0.3*d1)+env*uB*0.85+vec3(0.8,0.97,1.0)*fr*0.35+vec3(1.0)*sp*0.9;col+=vec3(0.31,0.76,0.84)*uG*0.35;gl_FragColor=vec4(col,1.0);}"
  const sh = (t: number, src: string) => {
    const o = g.createShader(t)!
    g.shaderSource(o, src)
    g.compileShader(o)
    return o
  }
  const pr = g.createProgram()!
  g.attachShader(pr, sh(g.VERTEX_SHADER, vs))
  g.attachShader(pr, sh(g.FRAGMENT_SHADER, fs))
  g.linkProgram(pr)
  if (!g.getProgramParameter(pr, g.LINK_STATUS)) return () => {}
  // biome-ignore lint/correctness/useHookAtTopLevel: es el método useProgram de WebGL, no un hook de React.
  g.useProgram(pr)

  // Supercuádrica (exponente 10): un cubo de aristas suaves que se estira en cada pieza del corchete.
  const LAT = 22,
    LON = 28,
    E = 10
  const P: number[] = [],
    N: number[] = [],
    I: number[] = []
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
  const buf = (data: number[], loc: string) => {
    const b = g.createBuffer()
    g.bindBuffer(g.ARRAY_BUFFER, b)
    g.bufferData(g.ARRAY_BUFFER, new Float32Array(data), g.STATIC_DRAW)
    const l = g.getAttribLocation(pr, loc)
    g.enableVertexAttribArray(l)
    g.vertexAttribPointer(l, 3, g.FLOAT, false, 0, 0)
  }
  buf(P, "aP")
  buf(N, "aN")
  const ib = g.createBuffer()
  g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ib)
  g.bufferData(g.ELEMENT_ARRAY_BUFFER, new Uint16Array(I), g.STATIC_DRAW)
  const cnt = I.length
  const U: Record<string, WebGLUniformLocation | null> = {}
  for (const u of ["uPV", "uR", "uS", "uT", "uC", "uB", "uG"]) U[u] = g.getUniformLocation(pr, u)
  g.enable(g.DEPTH_TEST)

  let gap = 2.2,
    mx = 0,
    my = 0,
    t = 0,
    vis = true,
    dead = false,
    raf = 0
  const t0 = performance.now()

  type M3 = number[]
  const m4 = (a: number[], b: number[]) => {
    const o: number[] = []
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let x = 0
        for (let q = 0; q < 4; q++) x += a[q * 4 + r]! * b[c * 4 + q]!
        o[c * 4 + r] = x
      }
    return o
  }
  const m3 = (a: M3, b: M3) => {
    const o: number[] = []
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 3; r++) {
        let x = 0
        for (let q = 0; q < 3; q++) x += a[q * 3 + r]! * b[c * 3 + q]!
        o[c * 3 + r] = x
      }
    return o
  }
  const ap = (m: M3, v: number[]) => [
    m[0]! * v[0]! + m[3]! * v[1]! + m[6]! * v[2]!,
    m[1]! * v[0]! + m[4]! * v[1]! + m[7]! * v[2]!,
    m[2]! * v[0]! + m[5]! * v[1]! + m[8]! * v[2]!,
  ]
  const rX = (a: number) => {
    const c = Math.cos(a),
      s = Math.sin(a)
    return [1, 0, 0, 0, c, s, 0, -s, c]
  }
  const rY = (a: number) => {
    const c = Math.cos(a),
      s = Math.sin(a)
    return [c, 0, -s, 0, 1, 0, s, 0, c]
  }

  const draw = () => {
    const { still, phase: ph, billable } = live.current
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
    const W = Math.max(1, Math.round(cv.clientWidth * dpr)),
      H = Math.max(1, Math.round(cv.clientHeight * dpr))
    if (cv.width !== W || cv.height !== H) {
      cv.width = W
      cv.height = H
    }
    g.viewport(0, 0, W, H)
    g.clearColor(0, 0, 0, 0)
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)
    if (!still) t = (performance.now() - t0) / 1000
    // Los corchetes se cierran sobre el trabajo y se abren para dejar salir el resultado.
    const target = ph === 1 ? 1.56 : ph === 2 ? 1.7 : 2.25
    gap += (target - gap) * (still ? 1 : 0.05)
    mx += ((still ? 0 : mouse.current.tmx) - mx) * 0.06
    my += ((still ? 0 : mouse.current.tmy) - my) * 0.06
    const aspect = W / H,
      f = 1 / Math.tan((15 * Math.PI) / 180),
      n = 0.1,
      fa = 60,
      camZ = 10.5
    const Pm = [
      f / aspect,
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      (fa + n) / (n - fa),
      -1,
      0,
      0,
      (2 * fa * n) / (n - fa),
      0,
    ]
    const V = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -camZ, 1]
    g.uniformMatrix4fv(U.uPV!, false, new Float32Array(m4(Pm, V)))
    g.uniform3f(U.uC!, 0, 0, camZ)
    const glow = ph === 1 ? 0.5 + 0.4 * Math.sin(t * 5) : ph === 2 && billable ? 0.35 : 0
    const lift = 0.68 + (still ? 0 : Math.sin(t * 0.7) * 0.05)
    for (const [side, turn] of [
      [-1, 1],
      [1, -1],
    ] as const) {
      const G = m3(
        rX(-0.1 - my * 0.2),
        rY(mx * 0.36 + (still ? 0 : Math.sin(t * 0.3) * 0.08) + turn * 0.2),
      )
      const parts = [
        { p: [side * gap, 0, 0], s: [0.085, 1.25, 0.13] },
        { p: [side * (gap - 0.28), 1.165, 0], s: [0.365, 0.085, 0.13] },
        { p: [side * (gap - 0.28), -1.165, 0], s: [0.365, 0.085, 0.13] },
      ]
      g.uniformMatrix3fv(U.uR!, false, new Float32Array(G))
      g.uniform3f(U.uB!, side < 0 ? 0.36 : 0.45, side < 0 ? 0.78 : 0.86, side < 0 ? 0.88 : 0.92)
      g.uniform1f(U.uG!, glow)
      for (const q of parts) {
        const w = ap(G, q.p)
        g.uniform3f(U.uS!, q.s[0]!, q.s[1]!, q.s[2]!)
        g.uniform3f(U.uT!, w[0]!, w[1]! + lift, w[2]!)
        g.drawElements(g.TRIANGLES, cnt, g.UNSIGNED_SHORT, 0)
      }
    }
  }
  const loop = () => {
    raf = 0
    if (dead) return
    if (vis) {
      draw()
      raf = requestAnimationFrame(loop)
    }
  }
  // Sin pintar mientras la escena no está en pantalla.
  const io =
    "IntersectionObserver" in window
      ? new IntersectionObserver((es) => {
          vis = !!es[0]?.isIntersecting
          if (vis && !raf) loop()
        })
      : null
  io?.observe(cv)
  loop()
  return () => {
    dead = true
    if (raf) cancelAnimationFrame(raf)
    io?.disconnect()
  }
}

export default function PricingHero({
  prices,
  ctaHref,
  ctaLabel,
  lead,
}: {
  prices: ValuePrices
  ctaHref: string
  ctaLabel: string
  /** La bajada con las cifras del plan que se muestra (lista o Fundadores). */
  lead: string
}) {
  const cost = (key: Task["price"]) => (key ? prices[key] : 0)
  const [step, setStep] = useState<Step>({ task: 0, phase: 0, done: [] })
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const still = paused || reduced

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  const mouse = useRef({ tmx: 0, tmy: 0 })

  const k = TASKS[step.task]!
  const p = still ? 2 : step.phase
  const billable = cost(k.price) > 0
  const live = useRef({ still, phase: p, billable })
  live.current = { still, phase: p, billable }

  // Preferencias de la persona y ancho de pantalla.
  useEffect(() => {
    const mqR = window.matchMedia("(prefers-reduced-motion: reduce)")
    const mqN = window.matchMedia(NARROW)
    const sync = () => {
      setReduced(mqR.matches)
      setNarrow(mqN.matches)
    }
    sync()
    mqR.addEventListener("change", sync)
    mqN.addEventListener("change", sync)
    return () => {
      mqR.removeEventListener("change", sync)
      mqN.removeEventListener("change", sync)
    }
  }, [])

  // El día avanza: entra, se trabaja, sale el resultado y cae en la cuenta.
  useEffect(() => {
    if (still) return
    const id = setInterval(() => setStep(nextStep), 1400)
    return () => clearInterval(id)
  }, [still])

  // La escena de 800 × 680 se escala al ancho disponible; en el teléfono no hay escala.
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cruzar el corte de teléfono hay que volver a medir y poner o quitar la escala.
  useEffect(() => {
    const wrap = wrapRef.current,
      scene = sceneRef.current
    if (!wrap || !scene) return
    const fit = () => {
      if (window.matchMedia(NARROW).matches) {
        scene.style.transform = ""
        wrap.style.height = ""
        return
      }
      const kk = Math.min(1, wrap.clientWidth / 800)
      scene.style.transform = `scale(${kk.toFixed(4)})`
      wrap.style.height = `${Math.round(680 * kk)}px`
    }
    fit()
    const ro = "ResizeObserver" in window ? new ResizeObserver(fit) : null
    ro?.observe(wrap)
    return () => ro?.disconnect()
  }, [narrow])

  // WebGL solo en pantallas anchas.
  useEffect(() => {
    if (narrow || !canvasRef.current) return
    let stop = () => {}
    const id = requestAnimationFrame(() => {
      if (canvasRef.current) stop = startScene(canvasRef.current, live, mouse)
    })
    return () => {
      cancelAnimationFrame(id)
      stop()
    }
  }, [narrow])

  const onMove = (e: PointerEvent<HTMLElement>) => {
    const cv = canvasRef.current
    if (!cv) return
    const r = cv.getBoundingClientRect()
    if (!r.width || !r.height) return
    mouse.current.tmx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1))
    mouse.current.tmy = Math.max(-1, Math.min(1, -(((e.clientY - r.top) / r.height) * 2 - 1)))
  }
  const onLeave = () => {
    mouse.current.tmx = 0
    mouse.current.tmy = 0
  }

  const pair: Pair =
    p === 0
      ? (narrow && k.inM) || k.in
      : p === 1
        ? (narrow && k.workM) || k.work
        : [`Resultado · ${k.time}`, (narrow && k.outM) || k.out]
  const done = still ? ALL_DONE : step.done
  const total = done.reduce((a, i) => a + cost(TASKS[i]!.price), 0)
  const rows = done.slice(0, narrow ? 3 : 4)
  const togglePause = () => setPaused((v) => !v)

  return (
    <section
      className={`hero pz-hero${still ? " pz-still" : ""}`}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      <div className="grain" aria-hidden="true" />
      <div className="wrap pz-copywrap">
        <div className="pz-copy">
          <span className="tag tag-d rise">[ Precios ]</span>
          <h1 className="pz-h1 rise d1">
            Pagas por el valor que recibes, <span>no por el software.</span>
          </h1>
          <p className="pz-lead rise d2">{lead}</p>
          <div className="pz-ctas rise d3">
            <a className="btn btn-p" href={ctaHref}>
              {ctaLabel}
            </a>
            <a className="btn btn-g" href="#calcula">
              Calcula tu mes
            </a>
          </div>
          <div className="pz-pauserow rise d4">
            <button type="button" className="pill" onClick={togglePause} aria-pressed={paused}>
              {paused ? "Activar movimiento" : "Pausar movimiento"}
            </button>
            <span>
              Entra el trabajo. Sale el resultado, y solo ese se cobra. Ejemplo de un día.
            </span>
          </div>
        </div>
      </div>
      <div className="pz-scenewrap" ref={wrapRef}>
        <div className={`pz-scene pz-st${p}`} ref={sceneRef}>
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: un canvas sin tabIndex no recibe el foco; es decorativo. */}
          <canvas ref={canvasRef} aria-hidden="true" />
          <span className="pz-bk pz-l" aria-hidden="true" />
          <span className="pz-bk pz-r" aria-hidden="true" />
          <div
            className={`pz-card pz-p${p}${p >= 2 && !billable ? " pz-free" : ""}`}
            aria-hidden="true"
          >
            <span className="mono pz-meta" style={{ color: p >= 2 ? "#0b5568" : "#8fb0b8" }}>
              {pair[0]}
            </span>
            <strong className="pz-title" style={{ color: p >= 2 ? "#06303a" : "#e7f5f8" }}>
              {pair[1]}
            </strong>
            {p === 1 && (
              <span className="pz-dots">
                <i />
                <i />
                <i />
              </span>
            )}
            {p >= 2 && (
              <span className={`pz-chip${billable ? "" : " pz-free"}`}>
                {billable ? usd(cost(k.price)) : "Sin costo"}
              </span>
            )}
          </div>
          <div className="pz-led" role="status" aria-live="polite">
            <div className="pz-ledhead">
              <span className="mono pz-ledtitle">Tu cuenta, fila por fila</span>
              <span className="pz-today">
                <span>Hoy</span>
                <strong className="mono">{usd(total)}</strong>
              </span>
            </div>
            {/* Cada tarea aparece una sola vez por ronda, así que su número sirve de clave. */}
            {rows.map((i, idx) => {
              const t = TASKS[i]!
              return (
                <div
                  key={i}
                  className={`pz-lr${idx === 0 ? (done.length % 2 ? " pz-n1" : " pz-n2") : ""}`}
                >
                  <span className="mono pz-time">{t.time}</span>
                  <span>{(narrow && t.outM) || t.out}</span>
                  <span className={`pz-pr${cost(t.price) > 0 ? "" : " pz-free"}`}>{usd(cost(t.price))}</span>
                </div>
              )
            })}
            {done.length === 0 && (
              <span className="pz-empty">Aquí cae cada resultado con su precio.</span>
            )}
          </div>
        </div>
      </div>
      <div className="pz-mrow">
        <span>Entra el trabajo. Sale el resultado, y solo ese se cobra.</span>
        <button type="button" className="pill" onClick={togglePause} aria-pressed={paused}>
          {paused ? "Activar" : "Pausar"}
        </button>
      </div>
    </section>
  )
}
