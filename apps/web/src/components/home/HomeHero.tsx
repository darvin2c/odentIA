// Portada del inicio («D3»): cada trabajo de un jueves de ejemplo entra por un canal, un agente
// lo resuelve y se enciende una de las 32 piezas. En escritorio, la fila de siete vías arriba;
// en teléfono, solo la vía activa. Se puede pausar y señalar las piezas para leer qué se hizo.
import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { AGENTS, CHANS, DAY, type DayEvent, dir, via } from "./heroData"
import { pauseStore, useInterval, useNarrow, usePaused, useReducedMotion } from "./motion"
import { type SceneHost, ToothScene } from "./toothScene"

type Props = { ctaHref: string; ctaLabel: string }
type Cur = {
  agent: string
  color: string
  ch: string
  where: string
  meta: string
  text: string
  cls: string
}

const OUT: [string, string, string][] = [
  ["cita", "cita agendada", "citas agendadas"],
  ["nota", "nota confirmada", "notas confirmadas"],
  ["vuelta", "paciente de vuelta", "pacientes de vuelta"],
  ["tarea", "caso para tu equipo", "casos para tu equipo"],
]

function d3vals(sStep: number, hover: number, cycle: number, still: boolean) {
  const D = DAY,
    AG = AGENTS,
    step = still ? 32 : sStep
  const counts: Record<string, number> = {}
  for (let k = 0; k < step; k++) counts[D.ev[k].out] = (counts[D.ev[k].out] || 0) + 1
  const nEv = step > 0 && !still ? D.ev[step - 1] : null
  let cur: Cur
  let focusEv: DayEvent | null = null
  if (hover >= 0) {
    const e = D.ev[D.slotOf[hover]]
    focusEv = e
    cur = {
      agent: AG[e.agent].name,
      color: AG[e.agent].color,
      ch: via(e),
      where: e.where,
      meta: "La pieza que señalas · " + e.time,
      text: e.text,
      cls: "ztxt",
    }
  } else if (still || step === 32) {
    cur = {
      agent: "Tus tres agentes",
      color: "#ffffff",
      ch: "",
      where: "",
      meta: "Jueves · 32 de 32",
      text: "Un jueves completo de ejemplo: 32 trabajos que llegaron por siete vías y quedaron resueltos mientras tu equipo atendía.",
      cls: "ztxt",
    }
  } else if (step === 0) {
    cur = {
      agent: "Tus tres agentes",
      color: "#ffffff",
      ch: "",
      where: "",
      meta: "Jueves · 06:59",
      text: "Empieza el día en una clínica de ejemplo.",
      cls: "ztxt",
    }
  } else {
    const e = D.ev[step - 1]
    focusEv = e
    cur = {
      agent: AG[e.agent].name,
      color: AG[e.agent].color,
      ch: via(e),
      where: e.where,
      meta: "Jueves · " + e.time + " · " + step + " de 32",
      text: e.text,
      cls: step % 2 ? "ztxt n1" : "ztxt n2",
    }
  }
  const fe = focusEv || nEv
  return {
    chans: CHANS.map((c, i) => ({
      label: c.label,
      left: c.left,
      width: c.width,
      color: focusEv ? AG[focusEv.agent].color : "#4fc3d7",
      delay: (0.15 + i * 0.09).toFixed(2) + "s",
      cls:
        "zch" +
        (i === 6 ? " cons" : "") +
        (cycle % 2 ? " b" : " a") +
        (focusEv && focusEv.ch === i ? " on" + (hover >= 0 ? "" : step % 2 ? " s1" : " s2") : ""),
    })),
    one: {
      label: fe ? dir(fe) : "Todos tus canales",
      color: fe ? AG[fe.agent].color : "#4fc3d7",
      cls: "zone " + (step % 2 ? "a" : "b"),
    },
    cur,
    progress: ((step / 32) * 100).toFixed(1) + "%",
    outs: OUT.map(([k, one, many]) => ({
      n: String(counts[k] || 0),
      label: (counts[k] || 0) === 1 ? one : many,
    })),
    key: AG.map((a) => ({ name: a.short, color: a.color })),
    cap: nEv
      ? { color: AG[nEv.agent].color, dir: dir(nEv), msg: nEv.msg }
      : { color: "#4fc3d7", dir: "", msg: "" },
  }
}

const cssVar = (o: Record<string, string>) => o as CSSProperties

export default function HomeHero({ ctaHref, ctaLabel }: Props) {
  const narrow = useNarrow()
  const reduced = useReducedMotion()
  const paused = usePaused()
  const still = reduced || paused
  const [d, setD] = useState({ step: 0, hold: 0, cycle: 0 })
  const [hover, setHover] = useState(-1)

  const cvRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sceneElRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<ToothScene | null>(null)
  // La escena lee siempre el último estado sin volver a montarse.
  const live = useRef({ step: 0, hover: -1, still: false, narrow: false })
  live.current = { step: d.step, hover, still, narrow }
  const hostRef = useRef<SceneHost | null>(null)
  if (!hostRef.current) {
    hostRef.current = {
      state: () => live.current,
      anchor: (ch) =>
        live.current.narrow
          ? [(cvRef.current ? cvRef.current.clientWidth : 390) / 2, 38]
          : [CHANS[ch].ax, 42],
      panelPt: () =>
        live.current.narrow
          ? cvRef.current
            ? [cvRef.current.clientWidth / 2, cvRef.current.clientHeight]
            : [195, 300]
          : [150, 505],
      cap: null,
      lineIn: null,
      lineOut: null,
      dot: null,
    }
  }
  const host = hostRef.current

  // Arranca la escena WebGL; en teléfono y escritorio el lienzo es otro, así que se rehace al cambiar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow cambia el canvas al que apunta cvRef y obliga a rehacer la escena.
  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return
    const sc = new ToothScene(host)
    sceneRef.current = sc
    const id = requestAnimationFrame(() => sc.start(cv))
    return () => {
      cancelAnimationFrame(id)
      sc.stop()
      sceneRef.current = null
    }
  }, [narrow, host])

  // La escena de escritorio mide 840 × 680 y se escala al ancho disponible.
  useEffect(() => {
    if (narrow) return
    const wrap = wrapRef.current,
      scene = sceneElRef.current
    if (!wrap || !scene) return
    const fit = () => {
      const k = Math.min(1, wrap.clientWidth / 840)
      scene.style.transform = "scale(" + k.toFixed(4) + ")"
      wrap.style.height = Math.round(680 * k) + "px"
    }
    fit()
    if (!window.ResizeObserver) return
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [narrow])

  // Cada trabajo nuevo marca su hora de inicio antes de pintarse.
  // biome-ignore lint/correctness/useExhaustiveDependencies: d.step es el disparador: el efecto debe correr con cada trabajo nuevo.
  useLayoutEffect(() => {
    if (sceneRef.current) sceneRef.current.stepAt = performance.now()
  }, [d.step])

  // La pausa y el «menos movimiento» detienen también las animaciones del resto del inicio.
  useEffect(() => {
    document.querySelector(".home")?.classList.toggle("still", still)
  }, [still])

  useInterval(() => {
    if (still) return
    if (d.step < 32) setD({ ...d, step: d.step + 1 })
    else if (d.hold < 3) setD({ ...d, hold: d.hold + 1 })
    else setD({ step: 0, hold: 0, cycle: d.cycle + 1 })
  }, 1500)

  const onMove = (e: PointerEvent) => {
    const cv = cvRef.current,
      sc = sceneRef.current
    if (!cv || !sc) return
    const r = cv.getBoundingClientRect(),
      k = cv.clientWidth / (r.width || 1),
      x = (e.clientX - r.left) * k,
      y = (e.clientY - r.top) * k
    sc.tmx = Math.max(-1, Math.min(1, (x / cv.clientWidth) * 2 - 1))
    sc.tmy = Math.max(-1, Math.min(1, -((y / cv.clientHeight) * 2 - 1)))
    const step = still ? 32 : d.step
    let best = -1,
      bd = 26
    sc.scr.forEach((p, i) => {
      const dd = Math.hypot(p[0] - x, p[1] - y)
      if (dd < bd && DAY.slotOf[i] < step) {
        bd = dd
        best = i
      }
    })
    if (best !== hover) setHover(best)
  }
  const onLeave = (e: PointerEvent) => {
    // Con el dedo, la pieza tocada queda señalada hasta tocar otra cosa.
    if (e.pointerType !== "mouse") return
    if (sceneRef.current) {
      sceneRef.current.tmx = 0
      sceneRef.current.tmy = 0
    }
    if (hover !== -1) setHover(-1)
  }

  const v = d3vals(d.step, hover, d.cycle, still)
  const togglePause = () => pauseStore.set(!paused)
  const pauseLabel = paused ? "Activar movimiento" : "Pausar movimiento"

  const key = (
    <div className="zkey">
      {v.key.map((k) => (
        <span key={k.name} style={cssVar({ "--c": k.color })}>
          <i aria-hidden="true"></i>
          {k.name}
        </span>
      ))}
    </div>
  )
  const panel = (
    <div className="zpanel" role="status" aria-live="polite">
      <div className="zrow">
        <span className="zwho" style={cssVar({ "--c": v.cur.color })}>
          <i aria-hidden="true"></i>
          {v.cur.agent}
          {v.cur.ch && <span className="zbdg">{v.cur.ch}</span>}
          {v.cur.where && <span className="zbdg to">→ {v.cur.where}</span>}
        </span>
        <span className="mono zmeta">{v.cur.meta}</span>
      </div>
      <span className={v.cur.cls}>{v.cur.text}</span>
      <div className="zbar" aria-hidden="true">
        <span style={{ width: v.progress }}></span>
      </div>
      <div className="zout">
        {v.outs.map((o) => (
          <span key={o.label}>
            <b>{o.n}</b>
            {o.label}
          </span>
        ))}
      </div>
    </div>
  )
  const lines = (
    <>
      <line
        ref={(el) => {
          host.lineIn = el
        }}
        x1="0"
        y1="0"
        x2="0"
        y2="0"
        stroke="#7fd6e4"
        strokeWidth="1.5"
        strokeDasharray="3 5"
        opacity="0"
      ></line>
      <line
        ref={(el) => {
          host.lineOut = el
        }}
        x1="0"
        y1="0"
        x2="0"
        y2="0"
        stroke="#ffffff"
        strokeWidth="1"
        strokeDasharray="2 6"
        opacity="0"
      ></line>
      <circle
        ref={(el) => {
          host.dot = el
        }}
        cx="0"
        cy="0"
        r="5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.5"
        opacity="0"
      ></circle>
    </>
  )

  return (
    <section
      className={"hero hh" + (still ? " still" : "")}
      onPointerMove={onMove}
      onPointerDown={onMove}
      onPointerLeave={onLeave}
      aria-labelledby="inicio-titulo"
    >
      <div className="grain" aria-hidden="true"></div>
      <div className="wrap herow">
        <div className="hero-copy">
          <span className="tag tag-d rise">[ Para clínicas dentales ]</span>
          <h1 id="inicio-titulo" className="hh-title rise d1">
            Omnicanal <span>y agéntica.</span>
          </h1>
          <p className="hh-lead rise d2">
            WhatsApp, Instagram, correo y más llegan a una sola ficha por persona. Y tus agentes no
            solo conversan: agendan, documentan y traen de vuelta a tus pacientes mientras tu equipo
            atiende.
          </p>
          <div className="hh-ctas rise d3">
            <a className="btn btn-p" href={ctaHref}>
              {ctaLabel}
            </a>
            <a className="btn btn-g" href="#omnicanal">
              Míralo trabajar
            </a>
          </div>
          <p className="mono hh-note rise d4">
            Sin tarjeta para probar. Tú decides qué puede hacer cada agente, y lo que no da
            resultado no se cobra.
          </p>
          {!narrow && (
            <div className="hh-key rise d4">
              {key}
              <div className="hh-pause">
                <button type="button" className="pill" onClick={togglePause} aria-pressed={paused}>
                  {pauseLabel}
                </button>
                <span>
                  Cada pieza es un trabajo de un jueves de ejemplo: llega por un canal, un agente lo
                  resuelve y queda registrado. Pasa el cursor por las que brillan.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {!narrow ? (
        <div className="scene-wrap" ref={wrapRef}>
          <div className="scene" ref={sceneElRef}>
            <div className="scene-shadow" aria-hidden="true"></div>
            {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: un canvas sin tabIndex no recibe el foco; es decorativo. */}
            <canvas key="d" ref={cvRef} aria-hidden="true"></canvas>
            <svg aria-hidden="true" viewBox="0 0 840 680" className="scene-svg">
              {lines}
            </svg>
            <ul className="zchans" aria-label="Por dónde llega el trabajo">
              {v.chans.map((c) => (
                <li
                  key={c.label}
                  className={c.cls}
                  style={cssVar({
                    left: c.left + "px",
                    width: c.width + "px",
                    "--c": c.color,
                    "--d": c.delay,
                  })}
                >
                  {c.label}
                </li>
              ))}
            </ul>
            <div
              className="zcap"
              ref={(el) => {
                host.cap = el
              }}
              aria-hidden="true"
              style={cssVar({ "--c": v.cap.color })}
            >
              <span className="mono">{v.cap.dir}</span>
              <span>{v.cap.msg}</span>
            </div>
            {panel}
          </div>
        </div>
      ) : (
        <>
          <div className="zstage" aria-hidden="true">
            <canvas key="p" ref={cvRef}></canvas>
            <svg className="zstage-svg" aria-hidden="true">
              {lines}
            </svg>
            <span className={v.one.cls} style={cssVar({ "--c": v.one.color })}>
              {v.one.label}
            </span>
            <div
              className="zcap"
              ref={(el) => {
                host.cap = el
              }}
              style={cssVar({ "--c": v.cap.color })}
            >
              <span>{v.cap.msg}</span>
            </div>
          </div>
          <div className="hh-phone">
            {panel}
            {key}
            <div className="hh-pause-ph">
              <span>Cada pieza es un trabajo de un jueves de ejemplo. Toca las que brillan.</span>
              <button type="button" className="pill" onClick={togglePause} aria-pressed={paused}>
                {pauseLabel}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
