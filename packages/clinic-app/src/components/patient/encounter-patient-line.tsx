/**
 * La línea fija del paciente en la atención (P12, estándar E1): al pasar la cabecera aparece
 * arriba, gemela del pie fijo, con el nombre, la edad, las alertas por riesgo, «Guardado» y
 * «Dictar». Mientras se escribe la evolución o se receta, la persona y su alergia siguen a la vista
 * (Microsoft Health CUI / NHS, «Patient banner»: la identidad siempre visible). Usa las mismas
 * piezas que la cabecera: no es otra fuente de alertas. La página reserva su alto con
 * `scroll-padding-top` para que el campo que se escribe nunca quede tapado (WCAG 2.4.11).
 */
import { Badge, Button, cn } from "@odentia/ui"
import { Mic } from "lucide-react"
import { type RefObject, useEffect, useState } from "react"
import { alertsByRisk } from "./patient-header"

/**
 * Cuántas alertas caben en la línea; lo demás en «+N». En el teléfono, dos con su rótulo corto
 * («Alergia: penicilinas», «Warfarina»): la alergia y el anticoagulante se leen sin tocar nada
 * (QA del 16 nov, Q6; antes una sola, y la alergia quedaba detrás de «+1»).
 */
export const SHOWN = { phone: 2, wide: 3 } as const

/** «Carmen R.»: el primer nombre y la inicial del apellido, para el teléfono. */
export function shortPatientName(patient: { givenNames?: string | null; familyName?: string | null; displayName: string }): string {
  const given = (patient.givenNames ?? "").trim().split(/\s+/)[0] ?? ""
  const family = (patient.familyName ?? "").trim()
  if (!given) return patient.displayName
  return family ? `${given} ${family.charAt(0).toUpperCase()}.` : given
}

/**
 * Si la marca ya pasó por arriba de la ventana (bajo la franja de avisos): la cabecera no se ve.
 * Al volver arriba, la línea se va.
 */
export function usePastHeader(marker: RefObject<HTMLElement | null>): boolean {
  const [past, setPast] = useState(false)
  useEffect(() => {
    const element = marker.current
    if (!element || typeof IntersectionObserver !== "function") return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      setPast(!entry.isIntersecting && entry.boundingClientRect.top < 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [marker])
  return past
}

/**
 * El alto de la línea fija, en una sola variable (QA del 16 nov, Q12). La usan la línea, el foco
 * (`scroll-padding-top`) y todo lo que se pega arriba dentro de la atención (el arco y el panel de
 * la pieza): se pegan debajo de la línea, no detrás. Fuera de la atención no existe y vale 0.
 */
export const PATIENT_LINE_HEIGHT_VAR = "--patient-line-h"
const PATIENT_LINE_HEIGHT = "2.75rem"

/**
 * Mientras la atención está abierta, lo que se enfoca al bajar con Tab (o al saltar a un campo)
 * no queda debajo de la línea, y lo que se pega arriba lo hace debajo de ella: la ventana reserva
 * su alto. Al salir vuelve como estaba.
 */
export function useReservedTop(): void {
  useEffect(() => {
    const root = document.documentElement
    const before = root.style.scrollPaddingTop
    root.style.setProperty(PATIENT_LINE_HEIGHT_VAR, PATIENT_LINE_HEIGHT)
    root.style.scrollPaddingTop = `calc(var(--notice-strip-h, 0px) + var(${PATIENT_LINE_HEIGHT_VAR}) + 0.75rem)`
    return () => {
      root.style.scrollPaddingTop = before
      root.style.removeProperty(PATIENT_LINE_HEIGHT_VAR)
    }
  }, [])
}

/**
 * El alto del pie fijo de la atención («Faltan…» y «Finalizar y firmar»): lo que se pega arriba y
 * llega hasta abajo (el panel de la pieza) termina encima del pie, no detrás. Sin el pie vale 0.
 */
export const CLOSING_BAR_HEIGHT_VAR = "--closing-bar-h"

/** Mide el pie fijo mientras se ve y lo publica en `--closing-bar-h`. */
export function useReservedBottom(bar: RefObject<HTMLElement | null>, shown: boolean): void {
  useEffect(() => {
    const el = bar.current
    if (!shown || !el) return
    const root = document.documentElement
    const update = () => root.style.setProperty(CLOSING_BAR_HEIGHT_VAR, `${el.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.removeProperty(CLOSING_BAR_HEIGHT_VAR)
    }
  }, [bar, shown])
}

export function EncounterPatientLine({
  detail,
  health,
  displayName,
  shortName,
  age,
  save,
  canDictate,
  onDictate,
  dictating = false,
  onFinishDictation,
  onAntecedentes,
}: {
  detail: Parameters<typeof alertsByRisk>[0]
  health: Parameters<typeof alertsByRisk>[1]
  displayName: string
  shortName: string
  /** «42 a»; vacío sin fecha de nacimiento. */
  age: string
  /** El mismo estado de guardado que la cabecera («Guardado 12:47»). */
  save: { text: string; tone: string }
  /** «Dictar» a mano, como en la cabecera, sin volver arriba. */
  canDictate: boolean
  onDictate: () => void
  /** Se está dictando: la línea deja terminar el dictado sin volver arriba. */
  dictating?: boolean
  onFinishDictation?: () => void
  /** «+2»: abre los antecedentes, como en la franja de arriba. */
  onAntecedentes: () => void
}): React.JSX.Element {
  const alerts = alertsByRisk(detail, health)
  // En el teléfono las dos se reparten el ancho y se recortan con puntos suspensivos: ninguna
  // queda debajo de «+N» ni de «Dictar».
  const chip = (alert: (typeof alerts)[number]) => (
    <Badge
      key={alert.id}
      variant={alert.tone === "destructive" ? "destructive" : alert.tone === "warning" ? "outline" : "secondary"}
      className={cn(
        "max-w-56 justify-start max-sm:min-w-0 max-sm:shrink",
        alert.tone === "warning" && "border-warning/30 bg-warning-soft text-warning",
      )}
      title={alert.label}
    >
      <span className="min-w-0 truncate sm:hidden">{alert.short}</span>
      <span className="min-w-0 truncate max-sm:hidden">{alert.label}</span>
    </Badge>
  )
  const more = (shown: number, className: string) =>
    alerts.length > shown ? (
      <li className={cn("flex shrink-0", className)}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 px-2 sm:h-7"
          aria-label={`${alerts.length - shown} ${alerts.length - shown === 1 ? "alerta más" : "alertas más"}: ver antecedentes`}
          onClick={onAntecedentes}
        >
          +{alerts.length - shown}
        </Button>
      </li>
    ) : null
  return (
    <section
      aria-label="Paciente en atención"
      className="sticky top-[var(--notice-strip-h,0px)] z-20 -mx-4 -mb-[3.75rem] flex h-[var(--patient-line-h,2.75rem)] items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:mx-0 sm:rounded-xl sm:border"
    >
      <p className="flex min-w-0 shrink items-baseline gap-1 text-sm font-medium">
        <span className="truncate max-sm:hidden">{displayName}</span>
        <span className="truncate sm:hidden">{shortName}</span>
        {age ? <span className="shrink-0 font-normal text-muted-foreground">· {age}</span> : null}
      </p>
      {/* Las alertas en el orden del riesgo: la alergia nunca queda escondida en «+N». */}
      <ul aria-label="Alertas clínicas" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {alerts.map((alert, index) => (
          <li
            key={alert.id}
            className={cn("flex min-w-0", index >= SHOWN.phone && "max-sm:hidden", index >= SHOWN.wide && "hidden")}
          >
            {chip(alert)}
          </li>
        ))}
        {more(SHOWN.phone, "sm:hidden")}
        {more(SHOWN.wide, "max-sm:hidden")}
      </ul>
      <span className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium max-sm:hidden", save.tone)}>
        {save.text}
      </span>
      {dictating && onFinishDictation ? (
        <Button type="button" size="sm" variant="outline" className="h-11 shrink-0 sm:h-8" onClick={onFinishDictation}>
          <Mic className="size-4 text-destructive" aria-hidden />
          <span className="max-sm:sr-only">Terminar el dictado</span>
        </Button>
      ) : canDictate ? (
        <Button type="button" size="sm" className="h-11 shrink-0 sm:h-8" onClick={onDictate}>
          <Mic className="size-4" aria-hidden />
          <span className="max-sm:sr-only">Dictar</span>
        </Button>
      ) : null}
    </section>
  )
}
