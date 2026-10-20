// 02 · Agéntica: los tres agentes en pestañas. Sofi conversa y agenda (con selector de tono),
// Clío arma la nota a partir del dictado y Argos trae de vuelta a Rosa.
// Las tres pestañas quedan en el HTML generado; solo se ve la elegida.
import { useEffect, useRef, useState } from "react"
import { prefersReducedMotion, useInterval, useMoving } from "./motion"

type Tab = "rec" | "cli" | "adm"
type Tone = "cercano" | "neutro" | "formal"
/** Emojis de la voz de la clínica, como en el producto: «No usar» (viene así) o «Pocos». */
type Emojis = "no" | "pocos"

const TABS: { id: Tab; label: string; sub: string; href: string }[] = [
  {
    id: "rec",
    label: "Sofi",
    sub: "Tu agente de recepción. Responde, informa y agenda a cualquier hora.",
    href: "/agentes/recepcion",
  },
  {
    id: "cli",
    label: "Clío",
    sub: "Tu agente clínico. Prepara la nota mientras el odontólogo atiende. Solo falta su sí.",
    href: "/agentes/asistente-clinico",
  },
  {
    id: "adm",
    label: "Argos",
    sub: "Tu agente administrador. Recuerda citas y trae de vuelta a los pacientes.",
    href: "/agentes/administrador",
  },
]
const TONE_OPTS: [Tone, string][] = [
  ["cercano", "Cercano"],
  ["neutro", "Neutro"],
  ["formal", "Formal · usted"],
]
const LINES = [
  "Carlos viene por dolor al frío en una muela de abajo, del lado izquierdo, desde hace una semana.",
  "En la 36 hay caries oclusal profunda. La percusión es negativa.",
  "Hoy hacemos una resina en la 36 y control en seis meses.",
]
// Barras de la onda del dictado, con una clave fija para cada una.
const WAVE_BARS = Array.from({ length: 20 }, (_, i) => `barra-${i}`)

const ADM = [
  {
    when: "Lunes",
    title: "Rosa Vega tiene su control de 6 meses vencido hace tres semanas.",
    sub: "Argos lo encuentra solo, sin que nadie revise listas.",
  },
  {
    when: "Lunes · 16:05",
    title: "Le escribe por WhatsApp con su enlace para reservar.",
    sub: "«Hola, Rosa, soy Sofi, de Clínica Sonrisa Norte. Ya te toca tu control. Puedes elegir el día aquí.»",
  },
  {
    when: "Lunes · 16:20",
    title: "Rosa elige el viernes 24 a las 11:00 desde su enlace.",
    sub: "La cita aparece en la agenda de la clínica.",
  },
  {
    when: "Viernes · 11:00",
    title: "Rosa llega y la atienden.",
    sub: "Recién ahora cuenta como cita recuperada.",
  },
  {
    when: "Viernes",
    title: "Cita recuperada",
    sub: "Si Rosa no hubiera ido, no contaría como recuperada.",
  },
]
// Estados finales de cada demostración (lo que se ve sin animación).
const END = { chat: 7, note: 5, adm: 5 }

export default function AgentTabs() {
  const moving = useMoving()
  const [tab, setTab] = useState<Tab>("rec")
  const [chat, setChat] = useState(END.chat)
  const [wait, setWait] = useState(0)
  const [slotPick, setSlotPick] = useState("16:30")
  const [tone, setTone] = useState<Tone>("cercano")
  const [emojis, setEmojis] = useState<Emojis>("no")
  const [note, setNote] = useState(END.note)
  const [noteDone, setNoteDone] = useState<"" | "ok" | "no">("")
  const [adm, setAdm] = useState(END.adm)
  const n = useRef(0)

  // Al aparecer, la conversación de Sofi empieza desde el primer mensaje.
  useEffect(() => {
    if (!prefersReducedMotion()) setChat(0)
  }, [])

  useInterval(() => {
    if (!moving) return
    n.current++
    if (tab === "rec") {
      if (chat < 3) setChat(chat + 1)
      else if (chat === 3) {
        // Espera a que la persona elija una hora; si no elige, elige la de la tarde.
        if (wait >= 4) {
          setChat(4)
          setSlotPick("16:30")
        } else setWait(wait + 1)
      } else if (chat < 7) setChat(chat + 1)
    }
    if (tab === "cli" && note > 0 && note < 5) setNote(note + 1)
    if (tab === "adm" && adm > 0 && adm < 5 && n.current % 2 === 0) setAdm(adm + 1)
  }, 1150)

  const replay = (id: Tab) => {
    const still = prefersReducedMotion()
    if (id === "rec") {
      setChat(still ? END.chat : 0)
      setWait(0)
    }
    if (id === "cli") {
      setNote(still ? END.note : 1)
      setNoteDone("")
    }
    if (id === "adm") setAdm(still ? END.adm : 1)
  }
  const pickTab = (id: Tab) => {
    setTab(id)
    replay(id)
  }

  const late = slotPick === "16:30"
  const slotTxt = late ? "a las 16:30 con el Dr. Ríos" : "a las 10:30 con la Dra. Paredes"
  // El asistente tiene el nombre y el tono que elige la clínica.
  const TONES: Record<Tone, [string, string]> = {
    cercano: [
      "Hola, Andrea. Soy Sofi, asistente virtual de Clínica Sonrisa Norte. Lamento lo de la muela. Mañana jueves tengo libre a las 10:30 con la Dra. Paredes o a las 16:30 con el Dr. Ríos. ¿Cuál te acomoda?",
      "¡Listo! Te espero el jueves 22 " +
        slotTxt +
        ". Mañana temprano te lo recuerdo. Si algo cambia, escríbeme aquí.",
    ],
    neutro: [
      "Hola, Andrea. Soy Sofi, asistente virtual de Clínica Sonrisa Norte. Mañana jueves hay horarios a las 10:30 con la Dra. Paredes y a las 16:30 con el Dr. Ríos. ¿Cuál prefieres?",
      "Tu cita quedó para el jueves 22 " +
        slotTxt +
        ". Mañana recibirás un recordatorio. Si necesitas cambiarla, responde a este mensaje.",
    ],
    formal: [
      "Buenas noches, Andrea. Le saluda Sofi, asistente virtual de Clínica Sonrisa Norte. Lamentamos la molestia. Mañana jueves hay disponibilidad a las 10:30 con la Dra. Paredes o a las 16:30 con el Dr. Ríos. ¿Cuál prefiere?",
      "Su cita quedó reservada para el jueves 22 " +
        slotTxt +
        ". Mañana le enviaremos un recordatorio. Si necesita algún cambio, puede responder a este mensaje.",
    ],
  }
  // Cada mensaje lleva un id estable para usarlo como clave.
  const msgs: { id: string; cls: string; text: string }[] = []
  if (chat >= 1)
    msgs.push({
      id: "pregunta",
      cls: "bubble in",
      text: "Hola, buenas noches. ¿Tienen cita para mañana? Me duele una muela.",
    })
  if (chat >= 3) msgs.push({ id: "ofrece", cls: "bubble out", text: TONES[tone][0] })
  if (chat >= 4)
    msgs.push({
      id: "elige",
      cls: "bubble in",
      text: late ? "A las 16:30, por favor." : "A las 10:30, por favor.",
    })
  // Con «Pocos», uno como mucho y nunca donde se habla del dolor: solo va en la confirmación.
  const confirmText = emojis === "pocos" ? `${TONES[tone][1]} 📅` : TONES[tone][1]
  if (chat >= 6) msgs.push({ id: "confirma", cls: "bubble out", text: confirmText })
  if (chat >= 7) msgs.push({ id: "cita", cls: "sys", text: "Cita creada · Evaluación · 30 min" })
  const booked = chat >= 7
  const slots = [
    { time: "09:00", label: "Ocupado", cls: "slot busy" },
    {
      time: "10:30",
      label: booked && !late ? "Andrea Ramos · Evaluación" : "Libre · Dra. Paredes",
      cls: booked && !late ? "slot new" : "slot free",
    },
    { time: "12:00", label: "Ocupado", cls: "slot busy" },
    { time: "15:00", label: "Ocupado", cls: "slot busy" },
    {
      time: "16:30",
      label: booked && late ? "Andrea Ramos · Evaluación" : "Libre · Dr. Ríos",
      cls: booked && late ? "slot new" : "slot free",
    },
    { time: "17:30", label: "Libre · Dr. Ríos", cls: "slot free" },
  ]
  const pick = (h: string) => {
    setChat(4)
    setSlotPick(h)
  }

  const noteReady = note >= 5
  const noteStatus =
    noteDone === "ok"
      ? "confirmada"
      : noteDone === "no"
        ? "descartada"
        : noteReady
          ? "esperando a la doctora"
          : "escuchando"

  return (
    <div className="ag">
      <fieldset className="ag-tabs" aria-label="Elige un agente">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.id === tab ? "tabbtn on" : "tabbtn"}
            aria-pressed={t.id === tab}
            onClick={() => pickTab(t.id)}
          >
            <span className="tablabel">{t.label}</span>
            <span className="tabsub">{t.sub}</span>
          </button>
        ))}
        <p className="mono ag-demo">Demostración con datos de ejemplo.</p>
      </fieldset>

      <div className="ag-body">
        {/* Sofi */}
        <div className="ag-panel" hidden={tab !== "rec"}>
          <div className="ag-grid">
            <div className="chatbox">
              <div className="chathead">
                <span className="chatav" aria-hidden="true">
                  S
                </span>
                <span className="stack">
                  <strong>Sofi · Clínica Sonrisa Norte</strong>
                  <span className="mono">Miércoles · 23:40 · la clínica está cerrada</span>
                </span>
              </div>
              <div className="voice">
                <fieldset className="tones" aria-label="Tono del asistente">
                  {TONE_OPTS.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={id === tone ? "tone on" : "tone"}
                      aria-pressed={id === tone}
                      onClick={() => setTone(id)}
                    >
                      {label}
                    </button>
                  ))}
                </fieldset>
                {/* Emojis: «No usar» (apagado, como viene) o «Pocos» (encendido). */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={emojis === "pocos"}
                  className={emojis === "pocos" ? "emo on" : "emo"}
                  onClick={() => setEmojis(emojis === "pocos" ? "no" : "pocos")}
                >
                  <span className="emo-track" aria-hidden="true">
                    <span className="emo-knob"></span>
                  </span>
                  Emojis
                </button>
              </div>
              <div className="chatmsgs" aria-live="polite">
                {msgs.map((m) => (
                  <div key={m.id} className={m.cls}>
                    {m.text}
                  </div>
                ))}
                {(chat === 2 || chat === 5) && (
                  <div className="bubble out typing">
                    <span className="sr-only">Escribiendo</span>
                    <span className="dots" aria-hidden="true">
                      <i></i>
                      <i></i>
                      <i></i>
                    </span>
                  </div>
                )}
                {chat === 3 && (
                  <div className="opts">
                    <button type="button" className="opt" onClick={() => pick("10:30")}>
                      10:30
                    </button>
                    <button type="button" className="opt" onClick={() => pick("16:30")}>
                      16:30
                    </button>
                  </div>
                )}
              </div>
              <button type="button" className="mono replay" onClick={() => replay("rec")}>
                Volver a ver
              </button>
            </div>
            <div className="ag-side">
              <div className="card agenda d-only">
                <div className="agenda-h">
                  <strong>Agenda · jueves 22</strong>
                  <span className="mono">se llena sola</span>
                </div>
                {slots.map((s) => (
                  <div key={s.time} className={s.cls}>
                    <span className="mono">{s.time}</span>
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
              <div className="ag-copy">
                <p className="d-only">
                  <strong>Sofi</strong>, tu agente de recepción, contesta al momento, de día y de noche, por WhatsApp,
                  Instagram, Messenger, Telegram, el chat de tu web y el correo. Informa precios y
                  horarios, y agenda, mueve o cancela citas siempre con el sí del paciente. Si hace
                  falta una persona, le pasa el caso a tu equipo con un resumen.
                </p>
                <p className="d-only">
                  Se llama Sofi, o como tú le pongas, y tiene el tono de tu clínica: cercano, neutro o
                  formal, de tú o de usted, con o sin emojis. Con «Pocos» pone uno como mucho y
                  nunca cuando hablan de dolor, urgencias, pagos o reclamos. Siempre dice que es un
                  asistente virtual.
                </p>
                <p className="m-only">
                  Responde a cualquier hora, informa precios y horarios y agenda con el sí del
                  paciente.
                </p>
                <a className="ag-link" href="/agentes/recepcion">
                  Conoce a Sofi <span aria-hidden="true">→</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Clío */}
        <div className="ag-panel" hidden={tab !== "cli"}>
          <div className="ag-grid">
            <div className="dict">
              <div className="dict-h">
                <span className="tag tag-d">Consulta de Carlos Medina</span>
                <span className="mono">Dra. Paredes · 09:40</span>
              </div>
              {note >= 1 && note < 4 && (
                <div className="wave" aria-hidden="true">
                  {WAVE_BARS.map((b) => (
                    <span key={b}></span>
                  ))}
                </div>
              )}
              <div className="dict-lines">
                {LINES.slice(0, Math.min(Math.max(note, 0), 3)).map((l) => (
                  <p key={l} className="line">
                    «{l}»
                  </p>
                ))}
              </div>
              {note === 4 && <p className="mono dict-org">Ordenando la nota…</p>}
              <button type="button" className="mono dict-replay" onClick={() => replay("cli")}>
                Volver a escuchar
              </button>
            </div>
            <div className="card sugg">
              <div className="sugg-h">
                <strong>Sugerencias para la historia</strong>
                <span className="mono">{noteStatus}</span>
              </div>
              {noteReady ? (
                <>
                  <div className="line sugg-body">
                    <div>
                      <span className="tag sl">Consulta y evolución</span>
                      <p>
                        Dolor al frío en la pieza 36 desde hace una semana. Caries oclusal profunda
                        en 36, percusión negativa.
                      </p>
                    </div>
                    <div>
                      <span className="tag sl">Diagnóstico</span>
                      <p>
                        <span className="mono code">K02.1</span> Caries de la dentina · pieza 36
                      </p>
                    </div>
                    <div>
                      <span className="tag sl">Plan</span>
                      <p>Restauración con resina en 36, del tarifario de la clínica.</p>
                    </div>
                    <div>
                      <span className="tag sl">Controles</span>
                      <p>Control en seis meses.</p>
                    </div>
                  </div>
                  {!noteDone && (
                    <div className="sugg-acts">
                      <button
                        type="button"
                        className="btn btn-d btn-sm"
                        onClick={() => setNoteDone("ok")}
                      >
                        Confirmar y firmar
                      </button>
                      <button
                        type="button"
                        className="btn btn-l btn-sm"
                        onClick={() => setNoteDone("no")}
                      >
                        Descartar
                      </button>
                    </div>
                  )}
                  {noteDone === "ok" && (
                    <p className="line sugg-msg">
                      La Dra. Paredes confirmó y firmó. Ya está en la historia de Carlos.
                    </p>
                  )}
                  {noteDone === "no" && (
                    <p className="line sugg-msg">
                      Descartadas. Lo que no se confirma no entra a la historia ni se cobra.
                    </p>
                  )}
                </>
              ) : (
                <p className="sugg-wait">
                  Las sugerencias se arman mientras la doctora habla. Nada entra en la historia
                  hasta que ella las confirma, y el precio sale siempre de tu tarifario.
                </p>
              )}
              <p className="m-only ag-mcopy">
                Prepara la nota mientras el odontólogo atiende. Nada entra en la historia sin su sí.
              </p>
              <a className="ag-link" href="/agentes/asistente-clinico">
                Conoce a Clío <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </div>

        {/* Argos */}
        <div className="ag-panel" hidden={tab !== "adm"}>
          <div className="ag-grid">
            <div className="card admc">
              <div className="admc-h">
                <span className="tag">Rosa Vega · control de 6 meses</span>
                <button type="button" className="mono replay" onClick={() => replay("adm")}>
                  Volver a ver
                </button>
              </div>
              <ol className="steps">
                {ADM.map((a, i) => (
                  <li
                    key={a.when}
                    className={i < adm - 1 ? "step done" : i === adm - 1 ? "step now" : "step wait"}
                  >
                    <span className="dot" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="stack stepb">
                      <span className="mono">{a.when}</span>
                      <strong>{a.title}</strong>
                      <span>{a.sub}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="ag-side">
              <div className="counts">
                <span className="tag tag-d">Lo que cuenta</span>
                <span className="counts-t">Que Rosa volvió y la atendieron.</span>
                <span className="counts-s">
                  Recordar y avisar es parte del servicio. Lo que se mide es la cita a la que el
                  paciente asistió.
                </span>
              </div>
              <div className="ag-copy">
                <p className="d-only">
                  <strong>Argos</strong>, tu agente administrador, recuerda cada cita un día antes y tres horas antes,
                  avisa los controles, retoma los presupuestos sin respuesta y ofrece otra fecha a
                  quien faltó. Si no puede escribirle a alguien, le deja la tarea a tu equipo.
                </p>
                <p className="m-only">
                  Recuerda citas, avisa controles y retoma presupuestos. Recordar no se cobra.
                </p>
                <a className="ag-link" href="/agentes/administrador">
                  Conoce a Argos <span aria-hidden="true">→</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
