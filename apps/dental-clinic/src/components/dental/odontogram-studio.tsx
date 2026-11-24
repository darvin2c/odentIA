import { formatDate } from "@odentia/clinic-app/lib/clinical-journey"
import { usePermission } from "@odentia/clinic-app/lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "@odentia/clinic-app/lib/locale"
import { statusLabel } from "@odentia/clinic-app/lib/patients"
import { groupFindings } from "@odentia/clinic-app/lib/site-findings"
import { diagnosisCodeLabel } from "@odentia/clinical"
import {
  activeFindingsAsOf,
  FDI_ADULT,
  FDI_ADULT_ROWS,
  FDI_CHILD,
  FDI_CHILD_ROWS,
  surfaceLabel,
  toothNameOf,
} from "@odentia/dental"
import {
  Badge,
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { UnsavedDialog, useDetailMode, useStaysBeside } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type Dentition, suggestedDentition } from "../../lib/dental/dentition"
import {
  earlierEvolutionWords,
  type OdontogramEntry,
  type OdontogramState,
  winnersAsOf,
} from "../../lib/dental/odontogram"
import { ActiveFindingsList } from "./active-findings-list"
import { OdontogramArch } from "./odontogram-arch"
import { SignedOdontograms } from "./odontogram-assessments"
import { OdontogramDocument } from "./odontogram-document"
import { OdontogramFront } from "./odontogram-front"
import { planMouth, singleArchRows } from "./odontogram-layout"
import {
  findingWords,
  OdontogramNotationProvider,
  useOdontogramNotation,
} from "./odontogram-notation"
import { ToothDrawer } from "./tooth-drawer"
import { ToothSVG } from "./tooth-svg"

/** Ancho del contenedor disponible (no del viewport): a partir de 960 px cabe la pieza al lado. */
function useContainerWide(): {
  ref: RefObject<HTMLDivElement | null>
  wide: boolean
  width: number
} {
  const ref = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(false)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      // Dentro de un panel plegado mide 0: no cambia nada.
      if (el.clientWidth === 0) return
      // La pieza al lado y a la boca le quedan 600 px por dentro de su borde (40,5rem con el relleno).
      setWide(el.clientWidth >= 984)
      setWidth(el.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, wide, width }
}

/**
 * El ancho que le queda a la boca, por dentro de su borde, con la pieza abierta al lado: la grilla
 * de abajo (la boca de 40,5rem a 1fr, la pieza de 20 a 28rem, 1rem entre las dos) menos el borde
 * y el relleno de la boca (sm:p-5).
 */
function mouthWidthWithPanel(studio: number): number {
  const panel = Math.min(448, Math.max(320, studio - 16 - 648))
  return studio - 16 - panel - 42
}

/** Ancho del lugar de la boca, por dentro de su borde. */
function useViewsWidth(): { ref: RefObject<HTMLDivElement | null>; width: number } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      // Dentro de un panel plegado mide 0: se conserva el último ancho.
      if (el.clientWidth > 0) setWidth(el.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** Lo que se pierde si la pieza abierta se cierra con un hallazgo a medias. */
function selectedToothLost(selection: readonly number[]): string {
  return selection.length === 1
    ? `No se registró el hallazgo de la ${selection[0]}. Si cierras la pieza, se pierde.`
    : "No se registró el hallazgo de las piezas elegidas. Si las cierras, se pierde."
}

/** El día de un momento en la zona de la clínica («2026-11-23»): así se agrupan los cambios. */
function clinicDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: activeOrgTimeZone() })
}

/** «23 nov 2026», en el formato y la zona de la clínica. */
function snapshotLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: activeOrgTimeZone(),
  })
}

/**
 * «Ver estado al» por día: cada día con cambios, con cómo quedó la boca al terminar ese día (su
 * último cambio). Antes salía cada momento con segundos: diez hallazgos, diez horas del mismo día
 * (lienzo del 24 nov). Hoy no va: es lo mismo que «Actual».
 */
export function snapshotDays(
  instants: readonly string[],
  today = clinicDay(new Date().toISOString()),
): { value: string; label: string }[] {
  const byDay = new Map<string, { last: string; count: number }>()
  for (const iso of instants) {
    const day = clinicDay(iso)
    const seen = byDay.get(day)
    byDay.set(day, { last: !seen || iso > seen.last ? iso : seen.last, count: (seen?.count ?? 0) + 1 })
  }
  return [...byDay.entries()]
    .filter(([day]) => day !== today)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([, { last, count }]) => ({
      value: last,
      label: `${snapshotLabel(last)} · ${count} ${count === 1 ? "cambio" : "cambios"}`,
    }))
}

type OdontogramStudioProps = {
  patientId: string
  state: OdontogramState
  onChanged: () => void | Promise<void>
  encounterId?: string
  compact?: boolean
  initialTooth?: number
  /** La selección permanece local y no modifica la URL. */
  readOnly?: boolean
  disabled?: boolean
  beforeWrite?: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
  /** Fecha de nacimiento: sugiere la dentición inicial; el clínico puede cambiarla. */
  birthDate?: string | null
  /** Piezas seleccionadas, para enlazar otras superficies (p. ej. el plan). */
  onSelectionChange?: (teeth: number[]) => void
  /** Hay edición sin guardar en el panel de la pieza. */
  onDirtyChange?: (dirty: boolean) => void
  /** Contenido enlazado a la selección, justo bajo el odontograma y antes de lo firmado. */
  belowChart?: React.ReactNode
  /** En la atención: lleva al motivo de consulta («dolor» en el buscador de la pieza). */
  onReason?: () => void
}

/**
 * El odontograma: la misma forma de boca en todos los países, un solo
 * historial («Evolución» y «Ver estado al») y el panel de la pieza. Los
 * hallazgos se registran dentro de una atención; desde la ficha se consulta.
 * En clínicas de Perú, además, «Ver como la norma» (NTS 188, 5.18) y los
 * odontogramas firmados; en las demás, «Imprimir odontograma» en hoja neutra.
 */
export function OdontogramStudio(props: OdontogramStudioProps) {
  return (
    <OdontogramNotationProvider>
      <StudioBody {...props} />
    </OdontogramNotationProvider>
  )
}

function StudioBody({
  patientId,
  state,
  onChanged,
  encounterId,
  compact = false,
  initialTooth,
  readOnly = false,
  disabled = false,
  beforeWrite,
  onPendingChange,
  birthDate,
  onSelectionChange,
  onDirtyChange,
  belowChart,
  onReason,
}: OdontogramStudioProps) {
  const canWrite = usePermission("clinical.write")
  const official = useOdontogramNotation()
  const [officialOpen, setOfficialOpen] = useState(false)
  const officialTitleRef = useRef<HTMLHeadingElement>(null)
  const queryClient = useQueryClient()
  const id = useId()
  const { ref: containerRef, wide, width: studioWidth } = useContainerWide()
  const mouthRef = useRef<HTMLElement>(null)
  const detailMode = useDetailMode()
  const dirty = useRef(false)
  // Lo mismo, para pintar: con un hallazgo a medias, cerrar la pieza al perder el ancho pregunta.
  const [panelDirty, setPanelDirty] = useState(false)
  const handleDirtyChange = useCallback(
    (value: boolean) => {
      dirty.current = value
      setPanelDirty(value)
      onDirtyChange?.(value)
    },
    [onDirtyChange],
  )
  const [editorPending, setEditorPending] = useState(false)
  // Cambiar de pieza, de dentición o de fecha con un hallazgo a medias pregunta lo mismo que cerrar la
  // pieza, con nuestra ventana «¿Salir sin guardar?»: antes salía la del navegador, con otras palabras.
  const [pendingChange, setPendingChange] = useState<(() => void) | null>(null)
  const changeSelection = (action: () => void) => {
    if (editorPending) return
    if (dirty.current) setPendingChange(() => action)
    else action()
  }
  const validInitial =
    initialTooth && (FDI_ADULT.includes(initialTooth) || FDI_CHILD.includes(initialTooth))
      ? initialTooth
      : null
  // Por edad cuando se conoce; si no, por lo ya registrado: piezas temporales
  // con hallazgos indican al menos dentición mixta.
  const suggested: Dentition =
    suggestedDentition(birthDate) ??
    (state.history.some((entry) => FDI_CHILD.includes(entry.toothNumber)) ? "mixed" : "adult")
  const dentitionFor = (tooth: number | null, current: Dentition): Dentition => {
    if (tooth == null || current === "mixed") return current
    const primary = FDI_CHILD.includes(tooth)
    if (primary === (current === "primary")) return current
    return suggested === "mixed" ? "mixed" : primary ? "primary" : "adult"
  }
  const [dentition, setDentition] = useState<Dentition>(() => dentitionFor(validInitial, suggested))
  const { ref: viewsRef, width: viewsWidth } = useViewsWidth()
  /** Desde qué vista se abrió la pieza: al cerrarla, el foco vuelve ahí. */
  const openedFrom = useRef<"top" | "front">("top")
  const [selection, setSelection] = useState<number[]>(validInitial ? [validInitial] : [])
  const [drawerOpen, setDrawerOpen] = useState(Boolean(validInitial))
  const [multiple, setMultiple] = useState(false)
  const [snapshot, setSnapshot] = useState("current")
  const lastInitial = useRef<number | null>(validInitial)
  // El enlace (p. ej. Historia→pieza) actualiza la selección también después del primer mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo reacciona al enlace; la dentición sugerida es estable por paciente.
  useEffect(() => {
    if (!validInitial) {
      // Sin pieza pedida: pedir después la misma pieza vuelve a seleccionarla.
      lastInitial.current = null
      return
    }
    if (validInitial !== lastInitial.current) {
      lastInitial.current = validInitial
      setDentition((current) => dentitionFor(validInitial, current))
      setSelection([validInitial])
      setDrawerOpen(true)
      setSnapshot("current")
    }
  }, [validInitial])
  useEffect(() => {
    onSelectionChange?.(selection)
  }, [selection, onSelectionChange])
  const days = useMemo(
    () =>
      snapshotDays([
        ...new Set(
          state.history.flatMap((entry) =>
            [entry.createdAt, entry.voidedAt].filter((date): date is string => !!date),
          ),
        ),
      ]),
    [state.history],
  )
  const historical = snapshot !== "current"
  const view = useMemo(
    () => winnersAsOf(state.history, historical ? snapshot : undefined),
    [state.history, snapshot, historical],
  )
  const history = useMemo(() => {
    if (snapshot === "current") return state.history
    const cutoff = new Date(snapshot).getTime()
    return state.history
      .filter((entry) => entry.createdAt && new Date(entry.createdAt).getTime() <= cutoff)
      .map((entry) =>
        entry.voidedAt && Date.parse(entry.voidedAt) > cutoff
          ? { ...entry, status: "recorded", voidedAt: null, voidedBy: null, voidReason: null }
          : entry,
      )
  }, [state.history, snapshot])
  const byTooth = useMemo(() => {
    const byId = new Map(history.map((entry) => [entry.id, entry]))
    const result = new Map<number, OdontogramEntry[]>()
    for (const [tooth, current] of Object.entries(view.teeth)) {
      const entries = current.entries.flatMap((entryId) => {
        const entry = byId.get(entryId)
        return entry ? [entry] : []
      })
      entries.sort(
        (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id),
      )
      result.set(Number(tooth), entries)
    }
    return result
  }, [history, view.teeth])
  const refresh = async () => {
    await Promise.all(
      ["patient-summary", "timeline"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, patientId] }),
      ),
    )
    await onChanged()
  }
  // Sin atención el odontograma se consulta: lo nuevo se registra atendiendo.
  const locked = !canWrite || readOnly || historical || !encounterId
  const outerRows = dentition === "primary" ? FDI_CHILD_ROWS : FDI_ADULT_ROWS
  const innerRows = dentition === "mixed" ? FDI_CHILD_ROWS : null
  const upperTeeth = [...(outerRows[0] ?? []), ...(innerRows?.[0] ?? [])]
  const lowerTeeth = [...(outerRows[1] ?? []), ...(innerRows?.[1] ?? [])]
  const entriesOf = (tooth: number): OdontogramEntry[] => byTooth.get(tooth) ?? []
  const historyOf = (tooth: number): OdontogramEntry[] =>
    history.filter(
      (entry) => entry.toothNumber === tooth || entry.details?.relatedTeeth?.includes(tooth),
    )
  const toggle = (tooth: number, additive: boolean) =>
    changeSelection(() => {
      if (multiple || additive) {
        setSelection(
          selection.includes(tooth)
            ? selection.filter((item) => item !== tooth)
            : [...selection, tooth],
        )
        setMultiple(true)
      } else {
        setSelection([tooth])
        setDrawerOpen(true)
      }
    })
  const switchDentition = (next: Dentition) => {
    if (next === dentition) return
    changeSelection(() => {
      setDentition(next)
      // La vista mixta contiene las demás: solo se pierde lo que deja de verse.
      const visible = next === "mixed" ? null : next === "primary" ? FDI_CHILD : FDI_ADULT
      const kept = visible ? selection.filter((tooth) => visible.includes(tooth)) : selection
      setSelection(kept)
      if (kept.length === 0) setDrawerOpen(false)
    })
  }
  const selectedTooth = selection.length === 1 ? selection[0] : undefined
  const visibleHistory = history
    .filter(
      (entry) =>
        selection.length === 0 ||
        [entry.toothNumber, ...(entry.details?.relatedTeeth ?? [])].some((tooth) =>
          selection.includes(tooth),
        ),
    )
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
  const pendingReview = state.history.filter(
    (entry) => entry.needsReview && entry.status !== "voided",
  ).length
  // En la atención, sin pieza abierta, no hay columna a la derecha: la evolución anterior es
  // una sola fila plegada bajo el arco y, si no hay nada anterior, nada (segundo repaso del 9
  // nov: quedaba «▶ ODONTOGRAMA / Evolución» vacío al lado, a 1464 px y a 390 px). La pieza que
  // se cerró al perder el ancho sigue marcada en el arco: un toque la vuelve a abrir.
  const panelOpen = selection.length > 0 && drawerOpen
  const compactRow = compact && (selection.length === 0 || (!drawerOpen && !multiple))
  // La pieza al lado nunca salta encima como ventana porque se abrió otra cosa («Anotar su
  // respuesta», el dictado): se cierra y queda marcada; a medias, pregunta (regla 5 de `side-dock`).
  const { beside: showInlinePanel, confirmDialog: besideDialog } = useStaysBeside({
    open: panelOpen,
    fits: detailMode === "panel" && wide,
    dirty: panelDirty,
    lost: selectedToothLost(selection),
    onClose: () => setDrawerOpen(false),
  })
  // Dos columnas solo con la pieza al lado: «Evolución» va debajo del odontograma (lienzo del 23 nov).
  const twoColumns = !compactRow && showInlinePanel
  // En la atención, con la pieza al lado, el acomodo es el que cabe con ella abierta: abrirla no
  // reacomoda la boca ni corre lo que estaba bajo el dedo (QA del 23 nov).
  const stable = compact && wide && detailMode === "panel"
  const archRowsOf = (which: "upper" | "lower", split: boolean) =>
    singleArchRows(
      (which === "upper" ? outerRows[0] : outerRows[1]) ?? [],
      innerRows ? ((which === "upper" ? innerRows[0] : innerRows[1]) ?? []) : null,
      which === "upper",
      split,
    )
  const wholeRows = innerRows
    ? [outerRows[0] ?? [], innerRows[0] ?? [], innerRows[1] ?? [], outerRows[1] ?? []]
    : [outerRows[0] ?? [], outerRows[1] ?? []]
  const available = stable && studioWidth > 0 ? mouthWidthWithPanel(studioWidth) : viewsWidth
  // Las filas son las constantes FDI de la dentición: el acomodo cambia con el ancho y la dentición.
  // biome-ignore lint/correctness/useExhaustiveDependencies: las filas salen de la dentición.
  const plan = useMemo(
    () =>
      planMouth(
        available,
        {
          whole: wholeRows,
          narrow: [archRowsOf("upper", true), archRowsOf("lower", true)],
        },
        {
          outer: { upper: outerRows[0] ?? [], lower: outerRows[1] ?? [] },
          ...(innerRows ? { inner: { upper: innerRows[0] ?? [], lower: innerRows[1] ?? [] } } : {}),
        },
      ),
    [available, dentition],
  )
  const layout = plan.layout
  // Al medio de su lugar, salvo en la atención con la pieza al lado: ahí, al abrirla, el lugar se
  // angosta y el dibujo centrado se corría bajo el dedo; a la izquierda queda quieto (24 nov).
  const centered = stable ? "" : "mx-auto"
  const earlier = compactRow
    ? visibleHistory.filter((entry) => !encounterId || entry.encounterId !== encounterId)
    : []
  // Sin nada elegido y sin historia, «Evolución» no tiene qué mostrar: no se muestra. En la
  // ficha, en el celular, va debajo de la lista de hallazgos: plegada encima la tapaba (QA del 9 nov).
  const evolutionEmpty = selection.length === 0 && (visibleHistory.length === 0 || compact)
  const evolutionBelow = !compact
  function historyList(entries: OdontogramEntry[]) {
    // Una caries de dos caras es una lesión: una tarjeta con sus caras, como en la atención (QA del
    // 9 nov, repaso 3: la DO de la 46 salía en dos tarjetas en la ficha).
    return (
      <ol className="ml-2 flex flex-col gap-5 border-l pl-5">
        {groupFindings(entries).map(({ first: entry, ids, surfaces }) => (
          <li key={ids.join(",")} className="relative rounded-lg border bg-background p-4">
            <span
              aria-hidden
              className="absolute top-5 -left-[26px] size-2.5 rounded-full border-2 border-background bg-muted-foreground"
            />
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground">
                  Pieza {entry.toothNumber}
                  {entry.createdAt ? ` · ${formatDate(entry.createdAt)}` : ""}
                </p>
                <h4 className="mt-1 font-medium">{findingWords(official, entry)}</h4>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{statusLabel(entry.status)}</Badge>
                {entry.resolvedAt && entry.status !== "voided" ? (
                  <Badge variant="outline">Tratado</Badge>
                ) : null}
                {entry.leftByPlanItemId ? (
                  <Badge variant="outline">Lo dejó un tratamiento</Badge>
                ) : null}
                {entry.needsReview ? (
                  <Badge variant="outline">Registro previo · requiere revisión</Badge>
                ) : null}
              </div>
            </div>
            {(surfaces.length > 0 || entry.diagnosisCode) && (
              <p className="mt-3 text-sm text-muted-foreground">
                {surfaces.length > 0
                  ? surfaces.map((surface) => surfaceLabel(surface)).join(" y ")
                  : "Pieza completa"}
                {entry.diagnosisCode
                  ? ` · ${diagnosisCodeLabel(entry.diagnosisSystem, entry.diagnosisCode)}`
                  : ""}
              </p>
            )}
            {entry.note && <p className="mt-3 rounded-md bg-muted/50 p-3 text-sm">{entry.note}</p>}
            {entry.details?.specifications && (
              <p className="mt-2 text-sm">Especificaciones: {entry.details.specifications}</p>
            )}
            {entry.details?.observations && (
              <p className="mt-2 text-sm">Observaciones: {entry.details.observations}</p>
            )}
            {entry.voidReason && (
              <p className="mt-2 text-sm text-muted-foreground">Corrección: {entry.voidReason}</p>
            )}
          </li>
        ))}
      </ol>
    )
  }
  const evolution = evolutionEmpty ? null : (
    <details
      key={selection.length > 0 ? "con-seleccion" : "sin-seleccion"}
      // En la ficha, con evolución que leer, sale abierta: plegada parecía vacía (QA del 9 nov).
      open={selection.length > 0 || (!compact && visibleHistory.length > 0)}
    >
      <summary className="min-h-11 cursor-pointer px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {selection.length ? "Selección actual" : "Odontograma"}
        </span>
        <span className="block text-lg font-semibold">
          {selectedTooth
            ? toothNameOf(selectedTooth)
            : selection.length
              ? `${selection.length} piezas seleccionadas`
              : "Evolución"}
        </span>
      </summary>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {selection.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {selection.map((tooth) => (
                <Badge key={tooth} variant="outline">
                  Pieza {tooth}
                </Badge>
              ))}
            </div>
            <Button disabled={disabled} onClick={() => setDrawerOpen(true)}>
              {locked ? "Ver selección" : "Editar selección"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {encounterId
              ? "Elige una pieza para registrar lo que observas, su diagnóstico y su tratamiento."
              : "Elige una pieza para ver sus hallazgos, su plan y sus imágenes. Los hallazgos se registran dentro de una atención."}
          </p>
        )}
        <ScrollArea className="h-[420px] min-h-0">
          <div className="pr-3">
            {visibleHistory.length === 0 ? (
              <div className="flex flex-col items-start gap-4 rounded-lg border bg-background p-6">
                {selectedTooth && (
                  <ToothSVG
                    toothNumber={selectedTooth}
                    entries={entriesOf(selectedTooth)}
                    size="preview"
                    showRoots={false}
                    disabled
                  />
                )}
                <h4 className="font-medium">
                  {selection.length
                    ? "Sin registros en esta selección"
                    : "Sin hallazgos registrados"}
                </h4>
                <p className="text-sm text-muted-foreground">
                  Los diagnósticos y tratamientos quedarán asociados a la pieza que elijas.
                </p>
              </div>
            ) : (
              historyList(visibleHistory)
            )}
          </div>
        </ScrollArea>
      </div>
    </details>
  )
  // En el celular, «Ver como la norma» y «Ver estado al» van al pie: arriba, lo que hace falta para
  // elegir una pieza (mesa del 23 nov, diseño UX).
  // Lo que hace falta para leer la mixta, dicho como se ve en cada acomodo (estándar E2).
  const mixedHint =
    layout === "narrow"
      ? "Arco exterior: permanentes; arco interior: temporales. De frente, las temporales van en su propia fila."
      : "Arco exterior: permanentes; arco interior: temporales. De frente, las temporales van en las filas del medio."
  const normButton = official ? (
    <Button size="sm" variant="outline" onClick={() => setOfficialOpen(true)}>
      Ver como la norma
    </Button>
  ) : null
  const dateField = compact ? null : (
    <Field className="w-full sm:w-52">
      <FieldLabel htmlFor={`${id}-date`}>Ver estado al</FieldLabel>
      <Select
        value={snapshot}
        items={{
          current: "Actual",
          ...Object.fromEntries(days.map((day) => [day.value, day.label])),
        }}
        onValueChange={(value) => {
          changeSelection(() => setSnapshot(value ?? "current"))
        }}
        disabled={disabled}
      >
        <SelectTrigger id={`${id}-date`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="current">Actual</SelectItem>
          {days.map((day) => (
            <SelectItem key={day.value} value={day.value}>
              {day.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
  const topHeading = (
    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      De arriba · las caras
    </h4>
  )
  const frontHeading = (
    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      De frente · cada pieza con su raíz
    </h4>
  )
  // Con las dos arcadas juntas (boca entera o arcos arriba), los dos arcos son un solo grupo para el
  // teclado; en el celular cada arcada va en su sección, con su arco y su fila.
  const [archVisited, setArchVisited] = useState<number | null>(null)
  const archRows = wholeRows.filter((row) => row.length > 0)
  const archVisible = archRows.flat()
  const archTogether =
    layout === "narrow"
      ? undefined
      : {
          rows: archRows,
          tabStop:
            archVisited !== null && archVisible.includes(archVisited)
              ? archVisited
              : (selection.find((tooth) => archVisible.includes(tooth)) ?? archVisible[0]),
          onVisit: setArchVisited,
        }
  const archOf = (which: "upper" | "lower") => (
    <OdontogramArch
      single={which}
      together={archTogether}
      aspect={plan.archAspect}
      byTooth
      // En el celular cada arcada ya lleva su título encima, y en la mixta el centro es de los números
      // de las temporales: el nombre al centro, solo en los demás casos.
      title={layout === "narrow" || innerRows ? null : which === "upper" ? "Superior" : "Inferior"}
      teeth={{ upper: outerRows[0] ?? [], lower: outerRows[1] ?? [] }}
      inner={innerRows ? { upper: innerRows[0] ?? [], lower: innerRows[1] ?? [] } : undefined}
      entriesOf={entriesOf}
      selected={selection}
      disabled={disabled || editorPending}
      onToggle={(tooth, additive) => {
        openedFrom.current = "top"
        toggle(tooth, additive)
      }}
    />
  )
  const frontOf = (rows: readonly (readonly number[])[]) => (
    <OdontogramFront
      rows={rows}
      pxPerMm={plan.frontPxPerMm}
      entriesOf={entriesOf}
      selected={selection}
      disabled={disabled || editorPending}
      onToggle={(tooth, additive) => {
        openedFrom.current = "front"
        toggle(tooth, additive)
      }}
    />
  )
  return (
    <div ref={containerRef} className="flex min-w-0 flex-col gap-4">
      <div
        // Con la pieza al lado, la boca no baja de 600 px: así caben una arcada de arriba y su vista de
        // frente (mesa del 23 nov, diseño UX). Sin `overflow` aquí: la boca y el panel se pegan a la ventana.
        className={`grid min-w-0 gap-4 ${twoColumns ? "grid-cols-[minmax(40.5rem,1fr)_minmax(20rem,28rem)]" : "grid-cols-1"}`}
      >
        <section
          ref={mouthRef}
          aria-label="Boca dental"
          // Se queda donde está al abrir una pieza: pegada arriba, con la página bajada saltaba hacia
          // abajo y lo que estaba bajo el dedo se corría (QA del 23 nov). El panel de al lado se pega
          // él solo y se recorre por dentro, así que la boca no necesita seguirlo.
          className={`flex min-w-0 flex-col gap-4 rounded-lg border p-3 sm:p-5 ${twoColumns ? "self-start" : ""}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* En la atención el bloque ya se titula «Odontograma»: aquí solo para el lector de pantalla. */}
            <h3 className={compact ? "sr-only" : "text-base font-semibold"}>Odontograma</h3>
            <div className="flex flex-wrap gap-2" aria-label="Dentición">
              {(
                [
                  ["adult", "Permanente (32)"],
                  ["mixed", "Mixta"],
                  ["primary", "Temporal (20)"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  variant={dentition === value ? "default" : "outline"}
                  size="sm"
                  aria-pressed={dentition === value}
                  disabled={disabled}
                  onClick={() => switchDentition(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {/* En la atención, tres frases decían cómo usar el arco: queda una, la del bloque vacío
              («Toca una pieza…»). Lo que hace falta para leer la mixta se dice siempre (estándar E2). */}
          {compact ? (
            dentition === "mixed" ? (
              <p className="text-xs text-muted-foreground">{mixedHint}</p>
            ) : null
          ) : (
            <p className="text-xs text-muted-foreground">
              {dentition === suggested
                ? birthDate
                  ? "Dentición sugerida por la edad del paciente."
                  : "Dentición por defecto: no hay fecha de nacimiento registrada."
                : "Vista cambiada a mano."}
              {dentition === "mixed" ? ` ${mixedHint}` : ""}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={multiple ? "default" : "outline"}
                aria-pressed={multiple}
                disabled={disabled}
                onClick={() => setMultiple(!multiple)}
              >
                Seleccionar varias
              </Button>
              {layout === "narrow" ? null : normButton}
            </div>
            {layout === "narrow" ? null : dateField}
          </div>
          {historical && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Estado histórico · solo lectura</Badge>
              <Button size="sm" variant="outline" onClick={() => setSnapshot("current")}>
                Volver al estado actual
              </Button>
            </div>
          )}
          {pendingReview > 0 && (
            <p
              role="status"
              className="rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-950"
            >
              {pendingReview} registros anteriores requieren revisión clínica. Se conservan en el
              historial; no se les asignan símbolos ni datos clínicos por inferencia.
            </p>
          )}
          {multiple && (
            <div className="flex flex-wrap gap-2" aria-label="Selección por arcada">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  changeSelection(() => setSelection(upperTeeth))
                }}
              >
                Arcada superior
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  changeSelection(() => setSelection(lowerTeeth))
                }}
              >
                Arcada inferior
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || selection.length === 0}
                onClick={() => {
                  changeSelection(() => setSelection([]))
                }}
              >
                Limpiar
              </Button>
            </div>
          )}
          {/* Dos vistas (lienzo del 23 nov 2026): de arriba, el arco, para las caras; de frente, cada
              pieza con su raíz, para lo que el arco no muestra (el perno, los conductos, el implante,
              el puente). Se toca una pieza en cualquiera de las dos y la elegida se marca en las dos. */}
          <div ref={viewsRef} className="flex min-w-0 flex-col gap-3">
            {layout === "whole" ? (
              // Cada arco a la izquierda, a la altura de su fila de frente, y la vista de frente al medio
              // del alto de los dos arcos (lienzo del 24 nov). Si sobra espacio, sobra a los dos lados.
              <div className={`${centered} flex min-w-0 items-start gap-4`}>
                <section
                  aria-label="De arriba"
                  className="flex shrink-0 flex-col gap-2"
                  style={{ width: `${plan.archWidth}px` }}
                >
                  {topHeading}
                  <div
                    data-arches=""
                    className="flex flex-col"
                    style={{ marginTop: `${plan.archTop}px`, gap: `${plan.archGap}px` }}
                  >
                    {archOf("upper")}
                    {archOf("lower")}
                  </div>
                </section>
                <section aria-label="De frente" className="flex min-w-0 flex-col gap-2">
                  {frontHeading}
                  <div style={{ marginTop: `${plan.frontTop}px` }}>{frontOf(wholeRows)}</div>
                </section>
              </div>
            ) : layout === "top" ? (
              // Más angosto (la atención con la pieza al lado), los dos arcos arriba y la boca de frente
              // debajo: siempre las dos arcadas (lienzo del 24 nov).
              <div className={`${centered} flex w-fit min-w-0 max-w-full flex-col gap-4`}>
                <section aria-label="De arriba" className="flex min-w-0 flex-col gap-2">
                  {topHeading}
                  <div data-arches="" className="flex justify-center gap-4">
                    {(["upper", "lower"] as const).map((which) => (
                      <div key={which} style={{ width: `${plan.archWidth}px` }}>
                        {archOf(which)}
                      </div>
                    ))}
                  </div>
                </section>
                <section
                  aria-label="De frente"
                  className="flex min-w-0 flex-col items-center gap-2"
                >
                  <div className="self-stretch">{frontHeading}</div>
                  {frontOf(wholeRows)}
                </section>
              </div>
            ) : (
              // En el celular, una arcada tras otra, sin pestañas: cada una con su arco y su vista de
              // frente, las dos a todo el ancho (lienzo del 24 nov).
              <div className="flex min-w-0 flex-col gap-5">
                {(["upper", "lower"] as const).map((which) => (
                  <section
                    key={which}
                    aria-label={which === "upper" ? "Arcada superior" : "Arcada inferior"}
                    className="flex min-w-0 flex-col items-center gap-3 border-t pt-4 first:border-t-0 first:pt-0"
                  >
                    <h4 className="self-stretch text-sm font-semibold">
                      {which === "upper" ? "Superior" : "Inferior"}
                    </h4>
                    <div className="max-w-full" style={{ width: `${plan.archWidth}px` }}>
                      {archOf(which)}
                    </div>
                    {frontOf(archRowsOf(which, true))}
                  </section>
                ))}
              </div>
            )}
          </div>
          {multiple || !compact ? (
            <p className="text-xs text-muted-foreground">
              {multiple
                ? "Marca las piezas y abre la selección para editarlas juntas."
                : "Toca una pieza, de arriba o de frente, para abrir su registro clínico."}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-red-600" />
              Patología, mal estado o temporal
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-blue-600" />
              Buen estado o característica no patológica
            </span>
          </div>
          {layout === "narrow" && (normButton || dateField) ? (
            <div className="flex flex-wrap items-end justify-between gap-2 border-t pt-3">
              {normButton}
              {dateField}
            </div>
          ) : null}
          {earlier.length > 0 ? (
            <details className="border-t pt-2">
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
                {earlierEvolutionWords(earlier)}
              </summary>
              <ScrollArea className="max-h-[420px] [&_[data-slot=scroll-area-viewport]]:max-h-[420px]">
                <div className="pt-2 pr-3">{historyList(earlier)}</div>
              </ScrollArea>
            </details>
          ) : null}
        </section>
        {compactRow ? null : (
          <section
            data-tooth-panel=""
            aria-label="Registro clínico dental"
            className={
              showInlinePanel
                ? // La cabecera del panel («Pieza 46…» y su «×») queda debajo de la línea fija, y su botón
                  // principal encima del pie de la atención: antes quedaba tapado por «Finalizar y firmar».
                  "h-[calc(100dvh-3rem-var(--notice-strip-h,0px)-var(--patient-line-h,0px)-var(--closing-bar-h,0px))] min-h-0 min-w-0 self-start overflow-hidden sticky top-[calc(var(--notice-strip-h,0px)+var(--patient-line-h,0px)+1rem)]"
                : "min-w-0 self-start rounded-sm bg-card"
            }
          >
            {!showInlinePanel && !evolutionBelow ? evolution : null}
            {selection.length > 0 && (
              <ToothDrawer
                key={`${selection.join("-")}-${snapshot}`}
                inline={showInlinePanel}
                open={drawerOpen}
                onOpenChange={(next) => {
                  setDrawerOpen(next)
                  if (next) return
                  // Cerrada con × o Escape, el foco vuelve a su pieza en el arco: con el teclado se
                  // sigue de ahí, con las flechas, sin volver a empezar desde arriba.
                  const closed = selection[0]
                  setSelection([])
                  const active = document.activeElement
                  if (
                    closed != null &&
                    (active === null ||
                      active === document.body ||
                      active.closest("[data-tooth-panel]"))
                  )
                    requestAnimationFrame(() =>
                      mouthRef.current
                        ?.querySelector<HTMLElement>(
                          openedFrom.current === "front"
                            ? `[data-front-tooth="${closed}"]`
                            : `[data-tooth="${closed}"]`,
                        )
                        ?.focus({ preventScroll: true }),
                    )
                }}
                patientId={patientId}
                teeth={selection}
                entriesOf={entriesOf}
                historyOf={historyOf}
                encounterId={encounterId}
                readOnly={locked}
                historical={historical}
                disabled={disabled}
                onChanged={refresh}
                beforeWrite={beforeWrite}
                onReason={onReason}
                onDirtyChange={handleDirtyChange}
                onPendingChange={(pending) => {
                  setEditorPending(pending)
                  onPendingChange?.(pending)
                }}
              />
            )}
          </section>
        )}
      </div>
      {/* En la ficha, lo que tiene la boca en una lista; en la atención va la de lo registrado hoy. */}
      {!compact ? (
        <ActiveFindingsList
          history={state.history}
          asOf={historical ? snapshot : undefined}
          asOfLabel={historical ? snapshotLabel(snapshot) : undefined}
          official={official}
          onSelect={(tooth) => {
            changeSelection(() => {
              setDentition((current) => dentitionFor(tooth, current))
              setSelection([tooth])
              setDrawerOpen(true)
            })
          }}
        />
      ) : null}
      {evolutionBelow && !showInlinePanel && evolution ? (
        <section aria-label="Evolución del odontograma" className="min-w-0 rounded-sm bg-card">
          {evolution}
        </section>
      ) : null}
      {belowChart}
      {!compact && official?.signedOdontogram ? (
        <SignedOdontograms
          patientId={patientId}
          history={state.history}
          readOnly={!canWrite || readOnly}
          disabled={disabled}
        />
      ) : null}
      {!compact && !official ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">
            La hoja lleva la numeración internacional (FDI) y los hallazgos de hoy por pieza.
          </p>
          <Link
            to="/patients/$patientId/odontogram/print"
            params={{ patientId }}
            target="_blank"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Imprimir odontograma
          </Link>
        </div>
      ) : null}
      {besideDialog}
      <UnsavedDialog
        open={pendingChange !== null}
        lost={selectedToothLost(selection)}
        onStay={() => setPendingChange(null)}
        onDiscard={() => {
          const action = pendingChange
          setPendingChange(null)
          action?.()
        }}
      />
      {official ? (
        <Dialog open={officialOpen} onOpenChange={setOfficialOpen}>
          <DialogContent
            initialFocus={officialTitleRef}
            scrollable
            className="max-h-[90vh] w-full sm:max-w-4xl"
          >
            <DialogHeader>
              <DialogTitle ref={officialTitleRef} tabIndex={-1}>
                Odontograma según la {official.shortName}
              </DialogTitle>
              <DialogDescription>
                {historical
                  ? `Los mismos hallazgos, en el gráfico de la norma, al ${snapshotLabel(snapshot)}. No es un odontograma firmado.`
                  : "Los mismos hallazgos de hoy, en el gráfico de la norma. No es un odontograma firmado: se firma al cerrar la atención."}
              </DialogDescription>
            </DialogHeader>
            <div className="min-w-0 rounded-lg bg-white p-3 text-black">
              <OdontogramDocument
                entries={activeFindingsAsOf(state.history, historical ? snapshot : undefined)}
                standard={official.standard}
                date={historical ? snapshot : new Date().toISOString()}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOfficialOpen(false)}>
                Cerrar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
