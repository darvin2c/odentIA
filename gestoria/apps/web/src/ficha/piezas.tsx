import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn, useIsMobile } from "@odentia/ui"
import { ChevronDown } from "lucide-react"
import { type ReactNode, useEffect, useId, useState } from "react"

/**
 * Lo escrito en un campo que se guarda solo: queda tal cual mientras diga lo mismo que lo
 * guardado («3,0» y 3); si lo guardado cambia por otro lado (deshacer, el servidor), se muestra
 * eso. Se ajusta al dibujar, sin un efecto (como recomienda React).
 */
export function useTyped<T>(
  value: T,
  show: (value: T) => string,
  read: (text: string) => T,
): [string, (text: string) => void] {
  const [text, setText] = useState(() => show(value))
  const [seen, setSeen] = useState(value)
  if (JSON.stringify(seen) !== JSON.stringify(value)) {
    setSeen(value)
    if (JSON.stringify(read(text)) !== JSON.stringify(value)) setText(show(value))
  }
  return [text, setText]
}

/**
 * Lo propio de la ficha que lo común no tiene (como en el prototipo aprobado): la muestra de un
 * color, el anillo de lo que sabe Sofi y las secciones que en el celular se pliegan.
 */

/** La muestra de un color; partida en diagonal si es de dos colores. */
export function Swatch({
  hex,
  hex2,
  className,
}: {
  hex: string | null
  hex2?: string | null
  className?: string
}) {
  const a = hex ?? "var(--muted)"
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.14)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.35)]",
        !hex && "bg-[repeating-linear-gradient(135deg,var(--muted)_0_3px,var(--border)_3px_6px)]",
        className,
      )}
      style={
        hex
          ? { background: hex2 ? `linear-gradient(135deg, ${a} 50%, ${hex2} 50%)` : a }
          : undefined
      }
    />
  )
}

/** El anillo de lo que Sofi sabe del producto: se completa con su animación cuando cambia. */
export function SofiDot({
  done,
  total,
  sellsAlone,
  size = 18,
}: {
  done: number
  total: number
  sellsAlone: boolean
  size?: number
}) {
  const r = size / 2 - 2
  const c = 2 * Math.PI * r
  const pct = total ? done / total : 0
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className="-rotate-90 shrink-0"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth="2.5"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={sellsAlone ? "var(--success)" : "var(--warning)"}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        className="motion-safe:transition-[stroke-dashoffset,stroke] motion-safe:duration-500"
      />
    </svg>
  )
}

/** Lleva a un campo de la ficha: abre su sección, lo muestra, lo ilumina un momento y le da el foco. */
export function goTo(target: string) {
  window.dispatchEvent(new CustomEvent("ficha:abrir", { detail: target }))
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.getElementById(target)
      if (!el) return
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" })
      el.classList.remove("destello")
      void el.offsetWidth
      el.classList.add("destello")
      const input = el.matches("input,textarea,button,[tabindex]")
        ? el
        : el.querySelector<HTMLElement>("input,textarea,[role=radio],[role=grid],button")
      setTimeout(() => input?.focus({ preventScroll: true }), 380)
    }),
  )
}

/** Abre lo que tiene dentro el campo al que se quiere llegar. */
function useOpensFor(id: string, contains: string[], open: () => void) {
  useEffect(() => {
    const onOpen = (e: Event) => {
      const t = (e as CustomEvent<string>).detail
      if (t === id || contains.some((c) => t === c || t.startsWith(c))) open()
    }
    window.addEventListener("ficha:abrir", onOpen)
    return () => window.removeEventListener("ficha:abrir", onOpen)
  }, [id, contains, open])
}

/**
 * Una sección de la ficha. En el escritorio, una tarjeta abierta; en el celular, una tarjeta que se
 * pliega y, cerrada, dice en una línea lo que tiene.
 */
export function Section({
  id,
  title,
  summary,
  action,
  children,
  contains = [],
  side = false,
}: {
  id: string
  title: string
  summary?: ReactNode
  action?: ReactNode
  children: ReactNode
  /** Los campos que viven dentro: llegar a uno la abre. */
  contains?: string[]
  /** En la columna angosta: más compacta. */
  side?: boolean
}) {
  const isMobile = useIsMobile()
  const headingId = useId()
  const [open, setOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: abrir no cambia
  useOpensFor(id, contains, () => setOpen(true))

  if (!isMobile)
    return (
      <section
        id={id}
        aria-labelledby={headingId}
        className={cn(
          "elevated flex min-w-0 scroll-mt-24 flex-col rounded-xl border bg-card",
          side ? "gap-3 p-4" : "gap-4 p-5",
        )}
      >
        <div
          className={cn("flex items-center justify-between gap-3", side ? "min-h-7" : "min-h-8")}
        >
          <h2 id={headingId} className={cn("font-semibold", side ? "text-sm" : "text-base")}>
            {title}
          </h2>
          {action}
        </div>
        {children}
      </section>
    )
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={
        <section
          id={id}
          aria-labelledby={headingId}
          className="elevated min-w-0 scroll-mt-20 rounded-xl border bg-card"
        />
      }
    >
      <CollapsibleTrigger className="flex min-h-14 w-full items-center gap-3 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={headingId} className="text-[15px] font-semibold">
            {title}
          </span>
          {summary && !open ? (
            <span className="truncate text-sm text-muted-foreground">{summary}</span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "size-5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-250 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <div className="flex flex-col gap-4 px-4 pb-4">
          {action ? <div className="flex justify-end">{action}</div> : null}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Un subtítulo dentro de una sección: separa sin poner otra caja. */
export function Sub({
  children,
  action,
  id,
}: {
  children: ReactNode
  action?: ReactNode
  id?: string
}) {
  return (
    <div
      id={id}
      className="flex min-h-7 scroll-mt-24 items-center justify-between gap-2 border-t pt-4 first:border-t-0 first:pt-0"
    >
      <h3 className="text-sm font-semibold">{children}</h3>
      {action}
    </div>
  )
}

/** Una parte que se pliega dentro de una sección; cerrada, dice en una línea lo que tiene. */
export function Fold({
  id,
  title,
  summary,
  children,
}: {
  id: string
  title: string
  summary: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: abrir no cambia
  useOpensFor(id, [], () => setOpen(true))
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<div id={id} className="scroll-mt-24 border-t pt-1" />}
    >
      <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{title}</span>
          {!open ? <span className="truncate text-sm text-muted-foreground">{summary}</span> : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-250 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <div className="flex flex-col gap-3 pt-1 pb-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** El error que el servidor dio de un campo, debajo de él. */
export function FieldProblem({ message, id }: { message?: string; id?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  )
}
