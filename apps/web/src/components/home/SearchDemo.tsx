// El buscador rápido en la portada (las dos webs): la ventana del producto (Ctrl K) con datos de
// ejemplo. Al verse, escribe sola cada ejemplo y muestra lo que encuentra; quien mira puede escribir
// en el campo, tocar una ficha o recorrer los resultados con las flechas. Con menos movimiento (o en
// pausa) se queda con el primer ejemplo ya buscado. Ctrl K solo se atiende con el foco dentro de la
// demo: fuera de ella sigue siendo el atajo del navegador.
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { prefersReducedMotion, useMoving } from "./motion"
import {
  DEMO_TYPE_LABELS,
  DEMO_TYPES,
  type DemoItem,
  type DemoOwner,
  type DemoType,
  type SearchDemoData,
  searchDemo,
} from "./search-demo"
import "./search-demo.css"

type Row =
  | { kind: "recent"; owner: DemoOwner }
  | { kind: "screen"; label: string }
  | { kind: "owner"; owner: DemoOwner }
  | { kind: "item"; owner: DemoOwner; item: DemoItem }
  | { kind: "more"; owner: DemoOwner; more: number }
  | { kind: "argos" }
  | { kind: "help" }

interface Section {
  key: string
  heading?: string
  owner?: boolean
  rows: Row[]
}

/* Los íconos del producto (lucide), en línea: la web no carga la librería. */
const PATHS: Record<DemoType | "search" | "filter" | "arrow" | "bot" | "help", ReactNode> = {
  persona: (
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>
  ),
  cita: (
    <>
      <path d="M8 2v4M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
    </>
  ),
  conversacion: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  clinica: (
    <>
      <path d="M11 2v2M5 2v2M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1M8 15a6 6 0 0 0 12 0v-3" />
      <circle cx="20" cy="10" r="2" />
    </>
  ),
  documento: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" />
    </>
  ),
  dinero: (
    <>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </>
  ),
  tarea: (
    <>
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="m3 17 2 2 4-4M13 6h8M13 12h8M13 18h8" />
    </>
  ),
  servicio: (
    <>
      <path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19" />
      <path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="6.5" cy="9.5" r=".5" fill="currentColor" />
    </>
  ),
  inventario: (
    <>
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <path d="M12 22V12M3.3 7l7.703 4.734a2 2 0 0 0 1.994 0L20.7 7M7.5 4.27l9 5.15" />
    </>
  ),
  equipo: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  filter: <path d="M3 6h18M7 12h10M10 18h4" />,
  arrow: <path d="M5 12h14M12 5l7 7-7 7" />,
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
}

function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

/** Cada tipo con su ícono y su fondo, como en el producto: la forma lo distingue y el color ayuda. */
function Tile({ type, small }: { type: DemoType; small?: boolean }) {
  return (
    <span className={`sd-tile t-${type}${small ? " sm" : ""}`} aria-hidden="true">
      <Icon name={type} />
    </span>
  )
}

const VERB_OF: Record<Row["kind"], string> = {
  recent: "Abrir ficha",
  screen: "Ir",
  owner: "",
  item: "",
  more: "Abrir ficha",
  argos: "Preguntar",
  help: "Preguntar",
}

export default function SearchDemo({
  data,
  label = "Demostración con datos de ejemplo",
}: {
  data: SearchDemoData
  label?: string
}) {
  const uid = useId()
  const moving = useMoving()
  const first = data.examples[0] ?? ""
  // En el servidor y sin movimiento, el primer ejemplo ya buscado: la página se lee entera.
  const [query, setQuery] = useState(first)
  const [auto, setAuto] = useState(true)
  const [visible, setVisible] = useState(false)
  const [hidden, setHidden] = useState<DemoType[]>([])
  const [active, setActive] = useState(0)
  const [opened, setOpened] = useState<ReactNode>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [mac, setMac] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const filterButton = useRef<HTMLButtonElement>(null)
  const filterBox = useRef<HTMLDivElement>(null)
  const chipTimer = useRef<number | undefined>(undefined)
  const step = useRef({ example: 0, typed: first.length })
  const latest = useRef<{
    rows: Row[]
    activate: (row: Row | undefined, fromAuto?: boolean) => void
  }>({
    rows: [],
    activate: () => {},
  })

  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.userAgent)), [])

  useEffect(() => {
    const el = root.current
    if (!el || !("IntersectionObserver" in window)) return
    const io = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), {
      threshold: 0.3,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Se escribe sola mientras se ve, hasta que quien mira toma el control. Cada vez que vuelve a verse,
  // empieza a escribir el ejemplo en que iba.
  useEffect(() => {
    if (!auto || !visible || !moving || prefersReducedMotion()) return
    const examples = data.examples
    let timer: number | undefined
    const tick = () => {
      const s = step.current
      const target = examples[s.example] ?? ""
      if (s.typed < target.length) {
        s.typed += 1
        setQuery(target.slice(0, s.typed))
        timer = window.setTimeout(tick, target[s.typed] === " " ? 140 : 75 + Math.random() * 50)
        return
      }
      // Escrito: «pulsa» Enter en la primera fila (el pie dice adónde lleva), deja ver los resultados y
      // pasa al siguiente.
      timer = window.setTimeout(() => {
        latest.current.activate(latest.current.rows[0], true)
        timer = window.setTimeout(
          () => {
            s.example = (s.example + 1) % examples.length
            s.typed = 0
            setQuery("")
            timer = window.setTimeout(tick, 650)
          },
          target.length > 18 ? 3000 : 2600,
        )
      }, 900)
    }
    step.current.typed = 0
    setQuery("")
    timer = window.setTimeout(tick, 450)
    return () => window.clearTimeout(timer)
  }, [auto, visible, moving, data.examples])

  // En pausa (el botón de la portada) se queda con el ejemplo completo, no a medio escribir.
  useEffect(() => {
    if (auto && !moving) setQuery(data.examples[step.current.example] ?? first)
  }, [auto, moving, data.examples, first])

  useEffect(() => () => window.clearTimeout(chipTimer.current), [])

  const takeOver = () => {
    setAuto(false)
    window.clearTimeout(chipTimer.current)
  }

  /** Una ficha de ejemplo: se escribe rápido (o de golpe, sin movimiento). */
  const play = (text: string) => {
    takeOver()
    setOpened(null)
    if (!moving || prefersReducedMotion()) {
      setQuery(text)
      return
    }
    let n = 0
    setQuery("")
    const tick = () => {
      n += 1
      setQuery(text.slice(0, n))
      if (n < text.length) chipTimer.current = window.setTimeout(tick, 38)
    }
    chipTimer.current = window.setTimeout(tick, 120)
  }

  const focusInput = () => {
    takeOver()
    input.current?.focus()
    input.current?.select()
  }

  const text = query.trim()
  const result = useMemo(
    () => (text.length >= 2 ? searchDemo(data, text, hidden) : null),
    [data, text, hidden],
  )
  const present = useMemo(
    () =>
      DEMO_TYPES.filter((type) =>
        data.owners.some((o) => o.type === type || o.items.some((i) => i.type === type)),
      ),
    [data],
  )

  const sections: Section[] = []
  if (!result) {
    const recents = data.recents.flatMap((id) => data.owners.filter((o) => o.id === id))
    sections.push({
      key: "recientes",
      heading: "Abiertas hace poco",
      rows: recents.map((owner) => ({ kind: "recent", owner })),
    })
    sections.push({
      key: "ir",
      heading: "Ir a",
      rows: data.screens.slice(0, 6).map((label) => ({ kind: "screen", label })),
    })
  } else {
    const ask: Section = {
      key: "preguntar",
      heading: "Preguntar",
      rows: [{ kind: "argos" }, { kind: "help" }],
    }
    if (result.question) sections.push(ask)
    for (const { owner, items, more } of result.owners)
      sections.push({
        key: `dueño:${owner.id}`,
        owner: true,
        rows: [
          { kind: "owner", owner },
          ...items.map((item): Row => ({ kind: "item", owner, item })),
          ...(more ? [{ kind: "more", owner, more } as Row] : []),
        ],
      })
    if (result.screens.length)
      sections.push({
        key: "ir",
        heading: "Ir a",
        rows: result.screens.map((label) => ({ kind: "screen", label })),
      })
    if (!result.question) sections.push(ask)
  }
  const rows = sections.flatMap((section) => section.rows)
  // Mientras la demo escribe sola, un ejemplo a medio escribir («987») no es una búsqueda que falló.
  const halfTyped =
    auto && data.examples.some((example) => example !== text && example.startsWith(text))
  const nothing =
    !!result && !halfTyped && !result.question && !result.owners.length && !result.screens.length
  const canCreate = nothing && !/\d{4,}/.test(text)

  // Cada texto nuevo vuelve a elegir la primera fila y borra lo que se abrió.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia al cambiar lo que se busca.
  useEffect(() => {
    setActive(0)
    setOpened(null)
    if (list.current) list.current.scrollTop = 0
  }, [text, hidden])

  const rowId = (index: number) => `${uid}-fila-${index}`

  const move = (delta: number) => {
    if (!rows.length) return
    const next = (active + delta + rows.length) % rows.length
    setActive(next)
    // Solo se desplaza la lista, nunca la página.
    const box = list.current
    const el = box?.querySelector<HTMLElement>(`[data-row="${next}"]`)
    if (box && el) {
      const top = el.offsetTop - box.offsetTop
      if (top < box.scrollTop) box.scrollTop = top - 8
      else if (top + el.offsetHeight > box.scrollTop + box.clientHeight)
        box.scrollTop = top + el.offsetHeight - box.clientHeight + 8
    }
  }

  const verbOf = (row: Row) =>
    row.kind === "owner" ? row.owner.verb : row.kind === "item" ? row.item.verb : VERB_OF[row.kind]

  /** En la demo no se navega: se dice adónde llevaría Enter en el producto. */
  const activate = (row: Row | undefined, fromAuto = false) => {
    if (!row) return
    if (!fromAuto) takeOver()
    const p = data.product
    const go = (where: ReactNode) => (
      <>
        <b>En {p}:</b> {where}
      </>
    )
    switch (row.kind) {
      case "argos":
        return setOpened(go(`${data.agent} responde a un lado, con los datos que tú puedes ver.`))
      case "help":
        return setOpened(go(`se abre Ayuda, que te enseña a usar ${p}.`))
      case "screen":
        return setOpened(go(`Ir a ${row.label}.`))
      case "recent":
      case "more":
        return setOpened(go(`Abrir ficha → ${row.owner.title}.`))
      case "owner":
        return setOpened(go(`${row.owner.verb} → ${row.owner.title}.`))
      case "item":
        return setOpened(go(`${row.item.verb} → ${row.item.kind} de ${row.owner.title}.`))
    }
  }

  // Lo último que se pintó, para la escritura sola (corre en un temporizador).
  latest.current = { rows, activate }

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      takeOver()
      move(event.key === "ArrowDown" ? 1 : -1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      activate(rows[active])
    } else if (event.key === "Escape" && query) {
      event.preventDefault()
      takeOver()
      setQuery("")
    }
  }

  // Ctrl K (⌘K) con el foco dentro de la demo lleva al campo; fuera de ella, el navegador sigue igual.
  const onRootKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key.toLowerCase() === "k" &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault()
      focusInput()
    }
  }

  // El filtro se cierra al tocar fuera o con Esc, y el foco vuelve a su botón.
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!filterBox.current?.contains(target) && !filterButton.current?.contains(target))
        setFilterOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    filterBox.current?.querySelector("input")?.focus()
    return () => document.removeEventListener("mousedown", onDown)
  }, [filterOpen])

  const toggleType = (type: DemoType) =>
    setHidden((now) => (now.includes(type) ? now.filter((t) => t !== type) : [...now, type]))

  const shownHidden = hidden.filter((type) => present.includes(type))
  const personCount = result?.owners.filter((o) => o.owner.type === "persona").length ?? 0
  const resultCount = result?.owners.reduce((sum, o) => sum + 1 + o.items.length, 0) ?? 0
  const kbd = mac ? "⌘" : "Ctrl"

  let index = -1
  const renderRow = (row: Row) => {
    index += 1
    const i = index
    const selected = i === active
    const common = {
      id: rowId(i),
      role: "option" as const,
      "aria-selected": selected,
      "data-row": i,
      onMouseMove: () => !selected && setActive(i),
      onClick: () => {
        setActive(i)
        activate(row)
      },
    }
    const verb = verbOf(row)
    const shortcut = verb ? <span className="sd-kbd-hint">Enter · {verb}</span> : null
    switch (row.kind) {
      case "recent":
        return (
          <div
            key={`r:${row.owner.id}`}
            {...common}
            className={`sd-row sd-top${selected ? " on" : ""}`}
          >
            <Tile type="persona" />
            <span className="sd-grow sd-strong">{row.owner.title}</span>
            {shortcut}
          </div>
        )
      case "screen":
        return (
          <div
            key={`s:${row.label}`}
            {...common}
            className={`sd-row sd-screen${selected ? " on" : ""}`}
          >
            <span className="sd-arrow" aria-hidden="true">
              <Icon name="arrow" />
            </span>
            <span className="sd-grow">{row.label}</span>
            {shortcut}
          </div>
        )
      case "owner":
        return (
          <div
            key={`o:${row.owner.id}`}
            {...common}
            className={`sd-row sd-top${selected ? " on" : ""}`}
          >
            <Tile type={row.owner.type} />
            <span className="sd-grow sd-two">
              <span className="sd-line">
                <span className="sd-title">{row.owner.title}</span>
                <span className="sd-badge">{row.owner.badge}</span>
              </span>
              {row.owner.detail ? <span className="sd-sub">{row.owner.detail}</span> : null}
            </span>
            {shortcut}
          </div>
        )
      case "item":
        return (
          <div
            key={`i:${row.owner.id}:${row.item.title}`}
            {...common}
            className={`sd-row sd-child${selected ? " on" : ""}`}
          >
            <span className="sd-branch" aria-hidden="true" />
            <Tile type={row.item.type} small />
            <span className="sd-kind">{row.item.kind}</span>
            <span className="sd-grow sd-item">{row.item.title}</span>
            {row.item.meta ? <span className="sd-meta">{row.item.meta}</span> : null}
            {shortcut}
          </div>
        )
      case "more":
        return (
          <div
            key={`m:${row.owner.id}`}
            {...common}
            className={`sd-row sd-child sd-more${selected ? " on" : ""}`}
          >
            <span className="sd-branch" aria-hidden="true" />+ {row.more} más de {row.owner.title}
          </div>
        )
      case "argos":
        return (
          <div key="argos" {...common} className={`sd-row sd-top${selected ? " on" : ""}`}>
            <span className="sd-tile t-agent" aria-hidden="true">
              <Icon name="bot" />
            </span>
            <span className="sd-grow sd-two">
              <span className="sd-title">
                Preguntarle a {data.agent}: «{text}»
              </span>
              <span className="sd-sub">Responde con los datos de la clínica que tú puedes ver</span>
            </span>
            {shortcut}
          </div>
        )
      case "help":
        return (
          <div key="help" {...common} className={`sd-row sd-top${selected ? " on" : ""}`}>
            <span className="sd-tile t-help" aria-hidden="true">
              <Icon name="help" />
            </span>
            <span className="sd-grow sd-two">
              <span className="sd-title">Preguntarle a Ayuda: «{text}»</span>
              <span className="sd-sub">Te enseña a usar {data.product}; no conoce cifras</span>
            </span>
          </div>
        )
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha Ctrl K de lo que tiene dentro (el campo, las fichas).
    <div className="sd" ref={root} onKeyDown={onRootKey}>
      <div className="sd-try">
        <span className="sd-try-l">Prueba con</span>
        {data.examples.map((example) => (
          <button
            key={example}
            type="button"
            className={`sd-chip${text === example ? " on" : ""}`}
            aria-pressed={!auto && text === example}
            onClick={() => play(example)}
          >
            {example}
          </button>
        ))}
      </div>

      <div className="sd-win">
        <div className="sd-bar">
          <span className="sd-clinic">
            <i aria-hidden="true" />
            {data.clinic}
          </span>
          <button
            type="button"
            className="sd-open"
            onClick={focusInput}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Icon name="search" />
            <span className="sd-open-l">Buscar</span>
            <span className="sd-keys" aria-hidden="true">
              <kbd>{kbd}</kbd>
              <kbd>K</kbd>
            </span>
          </button>
        </div>

        <div className="sd-head">
          <span className="sd-lens" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            ref={input}
            className="sd-input"
            type="text"
            role="combobox"
            aria-label="Buscar en todo (demostración)"
            aria-expanded="true"
            aria-controls={`${uid}-lista`}
            aria-autocomplete="list"
            aria-activedescendant={!auto && rows.length ? rowId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Busca una persona, una cita, un pago, un servicio…"
            value={query}
            onFocus={takeOver}
            onChange={(event) => {
              takeOver()
              setQuery(event.target.value)
            }}
            onKeyDown={onInputKey}
          />
          <button
            ref={filterButton}
            type="button"
            className={`sd-filter${shownHidden.length ? " on" : ""}`}
            aria-expanded={filterOpen}
            aria-controls={`${uid}-filtro`}
            aria-label={
              shownHidden.length
                ? `Filtrar: ${present.length - shownHidden.length} de ${present.length}`
                : "Filtrar"
            }
            onClick={() => {
              takeOver()
              setFilterOpen(!filterOpen)
            }}
          >
            <Icon name="filter" />
            <span className="sd-filter-l">
              {shownHidden.length
                ? `Filtrar · ${present.length - shownHidden.length} de ${present.length}`
                : "Filtrar"}
            </span>
          </button>
          <kbd className="sd-esc">Esc</kbd>
          {filterOpen ? (
            // biome-ignore lint/a11y/useSemanticElements: un grupo flotante de casillas; un fieldset dibujaría su leyenda sobre el borde.
            <div
              ref={filterBox}
              id={`${uid}-filtro`}
              className="sd-pop"
              role="group"
              aria-label="Buscar en"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation()
                  setFilterOpen(false)
                  filterButton.current?.focus()
                }
              }}
            >
              <p className="sd-pop-h">Buscar en</p>
              <div className="sd-pop-grid">
                {present.map((type) => (
                  <label key={type} className="sd-check">
                    <input
                      type="checkbox"
                      checked={!hidden.includes(type)}
                      onChange={() => toggleType(type)}
                    />
                    <Tile type={type} small />
                    <span>{DEMO_TYPE_LABELS[type]}</span>
                  </label>
                ))}
              </div>
              <div className="sd-pop-f">
                <button type="button" className="sd-link" onClick={() => setHidden([])}>
                  Marcar todo
                </button>
                <span>En {data.product} se recuerda la próxima vez.</span>
              </div>
            </div>
          ) : null}
        </div>

        {shownHidden.length ? (
          <div className="sd-hidden">
            <span>
              Sin buscar en: {shownHidden.map((type) => DEMO_TYPE_LABELS[type]).join(", ")}
            </span>
            <button type="button" className="sd-link" onClick={() => setHidden([])}>
              Buscar en todo
            </button>
          </div>
        ) : null}

        <p role="status" className="sd-sr">
          {auto || !result
            ? ""
            : nothing
              ? `No encontramos «${text}»`
              : `${personCount} ${personCount === 1 ? "persona" : "personas"}, ${resultCount} resultados`}
        </p>

        <div className="sd-list" ref={list}>
          {/* Como en el producto: «No encontramos…» va antes de las filas para preguntar. */}
          {nothing ? (
            <div className="sd-none">
              <p>No encontramos «{text}».</p>
              <p className="sd-mut">Revisa cómo se escribe o busca por teléfono o documento.</p>
              {canCreate ? (
                <button
                  type="button"
                  className="sd-create"
                  onClick={() => {
                    takeOver()
                    setOpened(
                      <>
                        <b>En {data.product}:</b> se abre Pacientes con «{text}» ya escrito.
                      </>,
                    )
                  }}
                >
                  Crear paciente «{text}»
                </button>
              ) : null}
            </div>
          ) : null}
          <div role="listbox" id={`${uid}-lista`} aria-label="Resultados">
            {sections.map((section) =>
              section.heading ? (
                // biome-ignore lint/a11y/useSemanticElements: un grupo de opciones dentro del listbox (ARIA); un fieldset no va ahí.
                <div
                  key={section.key}
                  role="group"
                  aria-label={section.heading}
                  className="sd-group"
                >
                  <span className="sd-gh" aria-hidden="true">
                    {section.heading}
                  </span>
                  {section.rows.map(renderRow)}
                </div>
              ) : (
                // biome-ignore lint/a11y/useSemanticElements: un grupo de opciones dentro del listbox (ARIA); un fieldset no va ahí.
                <div
                  key={section.key}
                  role="group"
                  aria-label={
                    section.rows[0] && "owner" in section.rows[0]
                      ? section.rows[0].owner.title
                      : undefined
                  }
                  className="sd-owner"
                >
                  {section.rows.map(renderRow)}
                </div>
              ),
            )}
          </div>
          {!result ? (
            <p className="sd-hint">También por teléfono, documento o número de historia.</p>
          ) : null}
        </div>

        <div className={`sd-foot${opened ? " said" : ""}`} aria-live="polite">
          {opened ? (
            <span className="sd-said">{opened}</span>
          ) : (
            <>
              <span>↑ ↓ moverse · Enter abrir · Esc borrar</span>
              <span>{kbd} K busca desde cualquier pantalla</span>
            </>
          )}
        </div>
      </div>
      <p className="sd-label">{label}</p>
    </div>
  )
}
