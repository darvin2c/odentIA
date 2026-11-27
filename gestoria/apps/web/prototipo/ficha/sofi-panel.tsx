import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn, Input } from "@odentia/ui"
import { AgentMark } from "@odentia/ui-patterns"
import { ArrowUp, Check, ChevronDown, CircleAlert, Play, RotateCcw, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { type Dato, foto, type Producto, type Rubro } from "../datos"
import { type Respuesta, responder, resumen, saber } from "../sofi"
import { irA, SofiDot } from "./piezas"

/**
 * «Pregúntale a Sofi»: se escribe como clienta y se ve cómo respondería Sofi con lo que tiene la
 * ficha AHORA (también lo no guardado). Cambiar un dato cambia la respuesta al instante; lo que le
 * falta se completa desde aquí. Reemplaza la lista de control: muestra en la práctica qué sabe.
 */

function Burbuja({
  r,
  onCompletar,
  edit,
}: {
  r: Respuesta
  onCompletar: (target: string, q?: string) => void
  edit: boolean
}) {
  const texto = r.partes.join(" ")
  const prev = useRef(texto)
  const [cambio, setCambio] = useState(false)
  useEffect(() => {
    if (prev.current !== texto) {
      prev.current = texto
      setCambio(true)
      const t = setTimeout(() => setCambio(false), 1600)
      return () => clearTimeout(t)
    }
  }, [texto])
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div
        className={cn(
          "relative max-w-[92%] rounded-2xl rounded-br-md border border-agent-border bg-agent-soft px-3.5 py-2.5 text-sm leading-relaxed transition-shadow duration-500",
          cambio &&
            "destello shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_22%,transparent)]",
        )}
      >
        {r.img ? (
          <span className="relative mb-2 block overflow-hidden rounded-xl">
            <img src={foto(r.img)} alt="" className="aspect-[4/3] w-48 object-cover" />
            {r.video ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/15">
                <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white">
                  <Play className="size-4 fill-current" aria-hidden />
                </span>
              </span>
            ) : null}
          </span>
        ) : null}
        <span aria-live="polite">{texto}</span>
        {cambio ? (
          <span className="entra absolute -top-2.5 left-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
            Al día con tu cambio
          </span>
        ) : null}
      </div>
      {r.usados.length ? (
        <div className="flex max-w-[92%] flex-wrap justify-end gap-1" aria-label="Lo que usó Sofi">
          {r.usados.map((u) => (
            <button
              key={u.label}
              type="button"
              onClick={() => onCompletar(u.target)}
              className="inline-flex h-6 items-center gap-1 rounded-full border bg-card px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Check className="size-3 text-success" aria-hidden />
              {u.label}
            </button>
          ))}
        </div>
      ) : null}
      {r.faltan.length ? (
        <div className="flex max-w-[92%] flex-col items-end gap-1">
          {r.faltan.map((f) => (
            <span
              key={f.label}
              className="entra inline-flex items-center gap-1.5 rounded-full bg-warning-soft py-0.5 pr-0.5 pl-2 text-[12px] font-medium text-warning"
            >
              <CircleAlert className="size-3.5" aria-hidden />
              Le falta: {f.label.toLowerCase()}
              {edit ? (
                <Button
                  size="xs"
                  variant="secondary"
                  className="h-6 bg-card"
                  onClick={() => onCompletar(f.target, f.target === "preguntas" ? "q" : undefined)}
                >
                  Completar
                </Button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function SofiPanel({
  p,
  R,
  tpl,
  dirty,
  onClose,
  onGo,
  className,
  edit = true,
}: {
  p: Producto
  R: Rubro
  tpl: Dato[]
  dirty: boolean
  onClose?: () => void
  /** Antes de ir a un campo (en el celular, cierra el cajón). */
  onGo?: () => void
  className?: string
  /** Ventas ve lo que sabe Sofi, pero no completa la ficha. */
  edit?: boolean
}) {
  const [qs, setQs] = useState<string[]>(() => [R.sugeridas[0]!])
  const [text, setText] = useState("")
  const [pensando, setPensando] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const L = saber(p, R, tpl)
  const s = resumen(L)
  const faltan = [...s.needMiss, ...s.plusMiss]

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [qs.length, pensando])

  const ask = (q: string) => {
    if (!q.trim()) return
    setText("")
    setPensando(true)
    setTimeout(() => {
      setPensando(false)
      setQs((x) => [...x, q.trim()])
    }, 520)
  }
  const go = (target: string, q?: string) => {
    onGo?.()
    setTimeout(
      () => {
        irA(target)
        if (q) window.dispatchEvent(new CustomEvent("ficha:pregunta", { detail: qs.at(-1) ?? "" }))
      },
      onGo ? 280 : 0,
    )
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card", className)}>
      <div className="flex items-start gap-3 border-b px-4 py-3">
        <AgentMark size="sm" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-[15px] font-semibold">Pregúntale a Sofi</h2>
          <p className="text-xs text-muted-foreground">
            {dirty
              ? "Responde con la ficha de ahora, con tus cambios sin guardar"
              : "Responde con lo que tiene la ficha ahora"}
          </p>
        </div>
        {onClose ? (
          <Button variant="ghost" size="icon-sm" aria-label="Cerrar Sofi" onClick={onClose}>
            <X aria-hidden />
          </Button>
        ) : null}
      </div>

      <Collapsible className="border-b">
        <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/60">
          <SofiDot done={s.done} total={s.total} vendeSola={s.vendeSola} size={30} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-semibold">
              {s.completo
                ? "Responde todo sobre este producto"
                : s.vendeSola
                  ? "Lo vende sola"
                  : `Necesita ${s.needMiss.length} ${s.needMiss.length === 1 ? "dato" : "datos"} para vender sola`}
            </span>
            <span className="text-xs text-muted-foreground">
              Sabe {s.done} de {s.total}
              {faltan.length ? ` · ${faltan.length} para responder todo` : ""}
            </span>
          </span>
          <ChevronDown
            className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-250 ease-out data-ending-style:h-0 data-starting-style:h-0">
          <ul className="flex flex-col gap-0.5 px-2 pb-2">
            {L.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => go(x.target)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  {x.ok ? (
                    <Check className="size-4 shrink-0 text-success" aria-label="Lo sabe" />
                  ) : (
                    <CircleAlert
                      className={cn(
                        "size-4 shrink-0",
                        x.need ? "text-warning" : "text-muted-foreground",
                      )}
                      aria-label="Le falta"
                    />
                  )}
                  <span className={cn("min-w-0 flex-1 truncate", !x.ok && "font-medium")}>
                    {x.label}
                  </span>
                  <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                    {x.ok ? x.detail : x.need ? "Lo necesita" : "Suma"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
      {faltan.length && edit ? (
        <div className="flex flex-col gap-1 border-b px-4 py-2.5">
          {faltan.slice(0, 3).map((f) => (
            <div key={f.id} className="flex items-center gap-2 text-sm">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  f.need ? "bg-warning" : "bg-muted-foreground/50",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{f.label}</span>
              <Button size="xs" variant="outline" onClick={() => go(f.target)}>
                Completar
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        aria-label="Prueba de Sofi"
      >
        {qs.map((q, i) => (
          <div key={`${q}${i}`} className="entra flex flex-col gap-2">
            <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 text-sm">
              {q}
            </div>
            <Burbuja r={responder(p, R, tpl, q)} onCompletar={go} edit={edit} />
          </div>
        ))}
        {pensando ? (
          <div
            className="flex gap-1 self-end rounded-2xl border border-agent-border bg-agent-soft px-3.5 py-3"
            role="status"
            aria-label="Sofi está escribiendo"
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="pulso size-1.5 rounded-full bg-primary"
                style={{ animationDelay: `${i * 160}ms` }}
              />
            ))}
          </div>
        ) : null}
        <div ref={end} />
      </div>

      <div className="flex flex-col gap-2 border-t px-3 pt-2.5 pb-3">
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {R.sugeridas
            .filter((q) => !qs.includes(q))
            .map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask(q)}
                className="h-7 shrink-0 rounded-full border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {q}
              </button>
            ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            ask(text)
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe como clienta…"
            aria-label="Pregunta de prueba para Sofi"
          />
          <Button type="submit" size="icon" aria-label="Preguntar" disabled={!text.trim()}>
            <ArrowUp aria-hidden />
          </Button>
          {qs.length > 1 ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Empezar de nuevo"
              onClick={() => setQs([R.sugeridas[0]!])}
            >
              <RotateCcw aria-hidden />
            </Button>
          ) : null}
        </form>
        <p className="text-[11px] text-muted-foreground">
          Es una prueba: no se envía a nadie ni cuenta como conversación.
        </p>
      </div>
    </div>
  )
}
