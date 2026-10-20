// Escena «B2» de las portadas de /omnicanal, /agentes y cada agente (tablero CabeceraComoFunciona):
// los canales llegan a Lucía en el centro y los tres agentes orbitan y trabajan sobre su historia.
// La prop `focus` pone un agente al frente; la persona puede tocar otro o volver a ver los tres.

import type { PointerEvent as ReactPointerEvent } from "react"
import { useCallback, useEffect, useRef, useState } from "react"

export type AgentFocus = "todos" | "recepcion" | "clinico" | "administrador"

type AgentMeta = {
  key: Exclude<AgentFocus, "todos">
  name: string
  sub: string
  idle: string
  color: string
  rgb: string
  R: number
  inc: number
  roll: number
  sp: number
  ph: number
}

type SceneEvent = { ch: number; agent: number; time: string; short: string; text: string }

const AGENTS: AgentMeta[] = [
  {
    key: "recepcion",
    name: "Sofi",
    sub: "Recepción · en todos los canales",
    idle: "Conversa con Lucía y con su mamá, agenda y responde.",
    color: "#4fc3d7",
    rgb: "79,195,215",
    R: 128,
    inc: 1.2,
    roll: 0.25,
    sp: 0.55,
    ph: 0.2,
  },
  {
    key: "clinico",
    name: "Clío",
    sub: "Clínica · en la consulta",
    idle: "Ordena lo que dicta la doctora en la historia de Lucía.",
    color: "#a6f0d8",
    rgb: "166,240,216",
    R: 182,
    inc: 1.32,
    roll: -0.35,
    sp: 0.38,
    ph: 2.3,
  },
  {
    key: "administrador",
    name: "Argos",
    sub: "Administración · atento a lo pendiente",
    idle: "Ve lo que falta y avisa a tiempo para que nada se olvide.",
    color: "#f5c46b",
    rgb: "245,196,107",
    R: 236,
    inc: 1.12,
    roll: 0.6,
    sp: 0.27,
    ph: 4.4,
  },
]

const EVENTS: SceneEvent[] = [
  {
    ch: 0,
    agent: 0,
    time: "08:12",
    short: "Cita movida al viernes",
    text: "Carmen, su mamá, escribió por WhatsApp y Sofi movió la cita al viernes.",
  },
  {
    ch: 4,
    agent: 1,
    time: "09:40",
    short: "Nota del control, confirmada",
    text: "La Dra. Paredes dictó el control de Lucía y confirmó la nota.",
  },
  {
    ch: 2,
    agent: 2,
    time: "10:05",
    short: "Recordatorio del martes",
    text: "Le recordó a Carmen, por correo, el control de ortodoncia del martes.",
  },
  {
    ch: 1,
    agent: 0,
    time: "13:20",
    short: "Respondió lo de los brackets",
    text: "Lucía preguntó por Instagram cuánto falta para quitarse los brackets.",
  },
  {
    ch: 4,
    agent: 1,
    time: "15:30",
    short: "Próximo control, listo",
    text: "Dejó listo el próximo control para que la doctora lo confirme.",
  },
  {
    ch: 0,
    agent: 2,
    time: "16:05",
    short: "Presupuesto retomado",
    text: "El presupuesto de Lucía seguía sin respuesta: le escribió a Carmen para retomarlo.",
  },
  {
    ch: 3,
    agent: 0,
    time: "18:40",
    short: "Presupuesto reenviado",
    text: "Carmen pidió por el chat de la web el presupuesto de Lucía y Sofi se lo reenvió.",
  },
  {
    ch: 4,
    agent: 1,
    time: "19:10",
    short: "Diagnóstico firmado",
    text: "Propuso el diagnóstico con su código; la doctora lo corrigió y lo firmó.",
  },
  {
    ch: 0,
    agent: 2,
    time: "20:00",
    short: "Otra fecha ofrecida",
    text: "Lucía faltó el lunes: le ofreció a Carmen otra fecha por WhatsApp.",
  },
]

const CHANNELS = ["WhatsApp", "Instagram", "Correo", "Chat de la web", "Consulta"]
const FONT = "Manrope Variable, Manrope, system-ui, sans-serif"
/** Tamaño del lienzo del tablero; la escena se escala para caber en su columna. */
const STAGE_W = 800

const focusIndex = (f: AgentFocus) => AGENTS.findIndex((a) => a.key === f)

/** Siguiente evento a mostrar: si hay un agente al frente, solo los suyos. */
function nextEvent(from: number, f: number) {
  for (let k = 1; k <= EVENTS.length; k++) {
    const c = (from + k) % EVENTS.length
    if (f < 0 || EVENTS[c]!.agent === f) return c
  }
  return from
}

/** Íconos de cada agente dentro de su círculo: mensaje, nota y campana. */
function drawIcon(ctx: CanvasRenderingContext2D, i: number, x: number, y: number, k: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(k, k)
  ctx.strokeStyle = "#03252e"
  ctx.fillStyle = "#03252e"
  ctx.lineWidth = 1.8
  ctx.lineJoin = "round"
  ctx.lineCap = "round"
  ctx.beginPath()
  if (i === 0) {
    ctx.moveTo(-6, -4)
    ctx.lineTo(6, -4)
    ctx.quadraticCurveTo(7.5, -4, 7.5, -2.5)
    ctx.lineTo(7.5, 2.5)
    ctx.quadraticCurveTo(7.5, 4, 6, 4)
    ctx.lineTo(-1, 4)
    ctx.lineTo(-4.5, 7)
    ctx.lineTo(-4, 4)
    ctx.lineTo(-6, 4)
    ctx.quadraticCurveTo(-7.5, 4, -7.5, 2.5)
    ctx.lineTo(-7.5, -2.5)
    ctx.quadraticCurveTo(-7.5, -4, -6, -4)
    ctx.stroke()
  } else if (i === 1) {
    ctx.rect(-5, -7, 10, 14)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(-2.5, -2.5)
    ctx.lineTo(2.5, -2.5)
    ctx.moveTo(-2.5, 0.5)
    ctx.lineTo(2.5, 0.5)
    ctx.moveTo(-2.5, 3.5)
    ctx.lineTo(1, 3.5)
    ctx.stroke()
  } else {
    ctx.moveTo(-5.5, 3.5)
    ctx.lineTo(-4.5, -1)
    ctx.quadraticCurveTo(-4, -6, 0, -6)
    ctx.quadraticCurveTo(4, -6, 4.5, -1)
    ctx.lineTo(5.5, 3.5)
    ctx.closePath()
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 6, 1.4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Estado de la animación que vive fuera de React para no re-renderizar en cada cuadro. */
type Anim = {
  t: number
  t0: number
  beam: number
  lastEv: number
  dimA: number[]
  mx: number
  my: number
  tmx: number
  tmy: number
}

export default function AgentScene({ focus = "todos" }: { focus?: AgentFocus }) {
  const [ev, setEv] = useState(() => nextEvent(EVENTS.length - 1, focusIndex(focus)))
  const [seen, setSeen] = useState<number[]>(() => [
    nextEvent(EVENTS.length - 1, focusIndex(focus)),
  ])
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const [f, setF] = useState(focusIndex(focus))
  const [scale, setScale] = useState<number | null>(null)

  const fitRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const live = useRef({ ev, f, still: false, visible: true })
  const anim = useRef<Anim>({
    t: 0,
    t0: 0,
    beam: 0,
    lastEv: -1,
    dimA: [1, 1, 1],
    mx: 0,
    my: 0,
    tmx: 0,
    tmy: 0,
  })
  const still = paused || reduced
  live.current.ev = ev
  live.current.f = f
  live.current.still = still

  const show = useCallback((j: number) => {
    setEv(j)
    setSeen((s) => [j, ...s.filter((x) => x !== j)].slice(0, 3))
  }, [])

  // Preferencia de movimiento reducido, también si cambia con la página abierta.
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])

  // Un evento nuevo cada 3,4 s, solo si hay movimiento y la escena está a la vista.
  useEffect(() => {
    const id = window.setInterval(() => {
      const l = live.current
      if (l.still || !l.visible) return
      show(nextEvent(l.ev, l.f))
    }, 3400)
    return () => window.clearInterval(id)
  }, [show])

  // La escena dibujada en 800 × 680 se escala al ancho de su columna.
  useEffect(() => {
    const el = fitRef.current
    if (!el) return
    const fit = () => setScale(Math.min(1, el.clientWidth / STAGE_W) || 1)
    fit()
    if (!window.ResizeObserver) return
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Lienzo: líneas de los canales, órbitas de los agentes y Lucía al centro. Se pausa fuera de pantalla.
  useEffect(() => {
    const cv = canvasRef.current
    const ctx = cv?.getContext("2d")
    if (!cv || !ctx) return
    const a = anim.current
    a.t0 = performance.now()
    let raf = 0
    let dead = false
    const draw = () => {
      const l = live.current
      const dpr = Math.min(window.devicePixelRatio || 1, 2),
        w = cv.clientWidth,
        h = cv.clientHeight
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr)
        cv.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!l.still) a.t = (performance.now() - a.t0) / 1000
      const t = a.t,
        evi = l.ev,
        e = EVENTS[evi]!,
        act = AGENTS[e.agent]!,
        F = l.f,
        st = l.still
      if (evi !== a.lastEv) {
        a.lastEv = evi
        a.beam = 0
      }
      a.beam += (1 - a.beam) * (st ? 1 : 0.04)
      AGENTS.forEach((_, i) => {
        const target = F < 0 || F === i ? 1 : 0.18
        a.dimA[i]! += (target - a.dimA[i]!) * (st ? 1 : 0.08)
      })
      a.mx += ((st ? 0 : a.tmx) - a.mx) * 0.05
      a.my += ((st ? 0 : a.tmy) - a.my) * 0.05
      const cx = 470,
        cy = 290,
        yaw = t * 0.1 + a.mx * 0.6,
        tilt = -a.my * 0.3
      const proj = (x: number, y: number, z: number) => {
        const X = x * Math.cos(yaw) + z * Math.sin(yaw)
        let Z = -x * Math.sin(yaw) + z * Math.cos(yaw)
        const Y = y * Math.cos(tilt) - Z * Math.sin(tilt)
        Z = y * Math.sin(tilt) + Z * Math.cos(tilt)
        const k = 760 / (760 + Z)
        return [cx + X * k, cy + Y * k, Z, k] as const
      }
      // Partículas que viajan de cada canal hacia la persona.
      const srcY = [146, 226, 306, 386, 466]
      srcY.forEach((y0, k) => {
        const on = e.ch === k,
          x0 = 150
        ctx.strokeStyle = on ? `rgba(${act.rgb},.4)` : "rgba(255,255,255,.06)"
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.quadraticCurveTo(x0 + 170, y0, cx - 56, cy)
        ctx.stroke()
        const n = on ? 7 : 3
        for (let j = 0; j < n; j++) {
          const u = (t * (on ? 0.32 : 0.16) + j / n + k * 0.17) % 1,
            b = 1 - u
          const px = b * b * x0 + 2 * b * u * (x0 + 170) + u * u * (cx - 56),
            py = b * b * y0 + 2 * b * u * y0 + u * u * cy
          ctx.fillStyle = on
            ? `rgba(${act.rgb},${(Math.sin(u * Math.PI) * 0.95).toFixed(3)})`
            : `rgba(255,255,255,${(Math.sin(u * Math.PI) * 0.25).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(px, py, on ? 3.2 : 2.2, 0, Math.PI * 2)
          ctx.fill()
        }
      })
      const pt = (r: AgentMeta, ang: number) => {
        const x = r.R * Math.cos(ang),
          z = r.R * Math.sin(ang)
        const y1 = -z * Math.sin(r.inc),
          z1 = z * Math.cos(r.inc)
        return proj(
          x * Math.cos(r.roll) - y1 * Math.sin(r.roll),
          x * Math.sin(r.roll) + y1 * Math.cos(r.roll),
          z1,
        )
      }
      const segs = (back: boolean) =>
        AGENTS.forEach((r, i) => {
          const on = e.agent === i,
            d = a.dimA[i]!
          ctx.lineWidth = on ? 2.2 : 1.3
          for (let s = 0; s < 120; s++) {
            const p = pt(r, (s / 120) * Math.PI * 2),
              q = pt(r, ((s + 1) / 120) * Math.PI * 2)
            if (p[2] > 0 !== back) continue
            ctx.strokeStyle = `rgba(${r.rgb},${((back ? (on ? 0.3 : 0.1) : on ? 0.95 : 0.32) * d).toFixed(3)})`
            ctx.beginPath()
            ctx.moveTo(p[0], p[1])
            ctx.lineTo(q[0], q[1])
            ctx.stroke()
          }
        })
      const pos = AGENTS.map((r) => pt(r, t * r.sp + r.ph))
      const avatars = (back: boolean) =>
        AGENTS.forEach((r, i) => {
          const p = pos[i]!
          if (p[2] > 0 !== back) return
          const on = e.agent === i,
            d = a.dimA[i]!,
            rad = (on ? 17 : 13) * p[3] * (F === i ? 1.12 : 1)
          if (on) {
            const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad * 3.2)
            g.addColorStop(0, `rgba(${r.rgb},.5)`)
            g.addColorStop(1, `rgba(${r.rgb},0)`)
            ctx.fillStyle = g
            ctx.beginPath()
            ctx.arc(p[0], p[1], rad * 3.2, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = (back ? 0.55 : 1) * Math.max(0.25, d)
          ctx.fillStyle = r.color
          ctx.beginPath()
          ctx.arc(p[0], p[1], rad, 0, Math.PI * 2)
          ctx.fill()
          drawIcon(ctx, i, p[0], p[1], rad / 14)
          ctx.globalAlpha = Math.max(0.25, d)
          if (!back) {
            ctx.font = `${on ? 700 : 600} 13px ${FONT}`
            ctx.fillStyle = on ? "#ffffff" : "rgba(207,231,236,.8)"
            ctx.fillText(r.name, p[0] + rad + 8, p[1] + 4)
          }
          ctx.globalAlpha = 1
        })
      // Rayo del agente que acaba de actuar hacia la historia de Lucía.
      const beam = () => {
        const p = pos[e.agent]!,
          u = a.beam
        ctx.strokeStyle = `rgba(${act.rgb},.85)`
        ctx.lineWidth = 2
        ctx.setLineDash([4, 6])
        ctx.lineDashOffset = -t * 30
        ctx.beginPath()
        ctx.moveTo(p[0], p[1])
        ctx.lineTo(p[0] + (cx - p[0]) * u, p[1] + (cy - p[1]) * u)
        ctx.stroke()
        ctx.setLineDash([])
      }
      segs(true)
      avatars(true)
      if (pos[e.agent]![2] > 0) beam()
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 110)
      halo.addColorStop(0, `rgba(${act.rgb},.3)`)
      halo.addColorStop(1, `rgba(${act.rgb},0)`)
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(cx, cy, 110, 0, Math.PI * 2)
      ctx.fill()
      const body = ctx.createRadialGradient(cx - 14, cy - 16, 6, cx, cy, 52)
      body.addColorStop(0, "#f4fdff")
      body.addColorStop(0.55, "#cdeef4")
      body.addColorStop(1, "#5aa9b8")
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(cx, cy, 50, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = "#03252e"
      ctx.font = `800 26px ${FONT}`
      ctx.textAlign = "center"
      ctx.fillText("LR", cx, cy + 9)
      ctx.textAlign = "left"
      if (pos[e.agent]![2] <= 0) beam()
      segs(false)
      avatars(false)
    }
    const loop = () => {
      raf = 0
      if (dead) return
      if (live.current.visible) {
        draw()
        raf = requestAnimationFrame(loop)
      }
    }
    let io: IntersectionObserver | undefined
    if (window.IntersectionObserver) {
      io = new IntersectionObserver((es) => {
        live.current.visible = !!es[0]?.isIntersecting
        if (live.current.visible && !raf) loop()
      })
      io.observe(cv)
    }
    loop()
    return () => {
      dead = true
      if (raf) cancelAnimationFrame(raf)
      io?.disconnect()
    }
  }, [])

  const onMove = (e: ReactPointerEvent) => {
    const cv = canvasRef.current
    if (!cv) return
    const r = cv.getBoundingClientRect()
    anim.current.tmx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1))
    anim.current.tmy = Math.max(-1, Math.min(1, -(((e.clientY - r.top) / r.height) * 2 - 1)))
  }
  const onLeave = () => {
    anim.current.tmx = 0
    anim.current.tmy = 0
  }

  /** Tocar un agente lo pone al frente (o vuelve a los tres) y salta a uno de sus eventos. */
  const pick = (i: number) => () => {
    const nf = f === i ? -1 : i
    setF(nf)
    if (nf >= 0) show(nextEvent(ev, nf))
  }

  const e = EVENTS[ev]!
  const caption =
    f < 0
      ? "Todos los canales llegan a la misma persona, y los tres agentes trabajan sobre su historia."
      : `Solo ${AGENTS[f]!.name}. Toca otro agente o «Ver los tres».`

  const agentButtons = (
    <fieldset className="b2-agents" aria-label="Los tres agentes">
      {AGENTS.map((a, i) => (
        <button
          key={a.key}
          type="button"
          className={i === e.agent ? "b2-ag on" : f >= 0 && f !== i ? "b2-ag dim" : "b2-ag"}
          style={{ ["--c" as string]: a.color }}
          aria-pressed={f === i}
          onClick={pick(i)}
        >
          <span className="nm">
            <span>
              <i aria-hidden="true" />
              {a.name}
            </span>
            <span className="pin">{f === i ? "Solo este" : "Ver solo este"}</span>
          </span>
          <span className="sub">{a.sub}</span>
          <span className="tx">{i === e.agent ? e.text : a.idle}</span>
        </button>
      ))}
    </fieldset>
  )

  return (
    <div className="b2" onPointerMove={onMove} onPointerLeave={onLeave}>
      <div
        className="b2-fit"
        ref={fitRef}
        style={scale === null ? undefined : { ["--s" as string]: scale }}
      >
        <div className="b2-stage">
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: un canvas sin tabIndex no recibe el foco; es decorativo. */}
          <canvas ref={canvasRef} aria-hidden="true" className="b2-canvas" />
          {CHANNELS.map((label, i) => (
            <span
              key={label}
              className={i === e.ch ? "b2-ch on" : f >= 0 ? "b2-ch dim" : "b2-ch"}
              style={{ top: `${146 + i * 80 - 18}px`, ["--c" as string]: AGENTS[e.agent]!.color }}
            >
              {label}
            </span>
          ))}
          <div className="b2-name">
            <strong>Lucía Ramos</strong>
          </div>
          <div className="b2-hist" role="log" aria-label="La historia de Lucía" aria-live="polite">
            <span className="mono b2-hk">Su historia, hoy</span>
            {seen.map((j, k) => {
              const h = EVENTS[j]!
              return (
                <div
                  key={k === 0 ? `n${j}` : j}
                  className={k === 0 ? "b2-hr first" : "b2-hr"}
                  style={{ ["--c" as string]: AGENTS[h.agent]!.color }}
                >
                  <i aria-hidden="true" />
                  <span>{h.short}</span>
                  <span className="mono b2-tm">{h.time}</span>
                </div>
              )
            })}
          </div>
          <div className="b2-in">{agentButtons}</div>
        </div>
      </div>
      <div className="b2-out">{agentButtons}</div>
      <div className="b2-foot">
        <span className="b2-cap">{caption}</span>
        <div className="b2-btns">
          {f >= 0 && (
            <button type="button" className="pill" onClick={() => setF(-1)}>
              Ver los tres
            </button>
          )}
          <button
            type="button"
            className="pill"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? "Activar movimiento" : "Pausar movimiento"}
          </button>
        </div>
      </div>
    </div>
  )
}
