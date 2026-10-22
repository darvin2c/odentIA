import {
  diagnosisCodeLabel,
  activeFindingsAsOf,
  FDI_ADULT,
  FDI_ADULT_ROWS,
  FDI_CHILD,
  FDI_CHILD_ROWS,
  surfaceLabel,
  toothNameOf,
} from "@odentia/clinical"
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
import { common, useDetailMode } from "@odentia/ui-patterns"
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
import { usePermission } from "../lib/crm"
import { type Dentition, suggestedDentition } from "../lib/patient-areas"
import {
  type OdontogramEntry,
  type OdontogramState,
  statusLabel,
  winnersAsOf,
} from "../lib/patients"
import { OdontogramArch } from "./odontogram-arch"
import { SignedOdontograms } from "./odontogram-assessments"
import { OdontogramDocument } from "./odontogram-document"
import { findingWords, OdontogramNotationProvider, useOdontogramNotation } from "./odontogram-notation"
import { ToothDrawer } from "./tooth-drawer"
import { ToothSVG } from "./tooth-svg"
import { formatDate } from "../lib/clinical-journey"
import { activeOrgLocale, activeOrgTimeZone } from "../lib/locale"

/** Ancho del contenedor disponible (no del viewport): a partir de 960 px el área es de dos columnas. */
function useContainerWide(): { ref: RefObject<HTMLDivElement | null>; wide: boolean } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setWide(el.clientWidth >= 960)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, wide }
}

/** Momento de un estado del odontograma, con segundos, en el formato y la zona de la clínica. */
function snapshotLabel(iso: string): string {
  return new Date(iso).toLocaleString(activeOrgLocale(), { timeZone: activeOrgTimeZone() })
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
}: OdontogramStudioProps) {
  const canWrite = usePermission("clinical.write")
  const official = useOdontogramNotation()
  const [officialOpen, setOfficialOpen] = useState(false)
  const officialTitleRef = useRef<HTMLHeadingElement>(null)
  const queryClient = useQueryClient()
  const id = useId()
  const { ref: containerRef, wide } = useContainerWide()
  const detailMode = useDetailMode()
  const dirty = useRef(false)
  const handleDirtyChange = useCallback(
    (value: boolean) => {
      dirty.current = value
      onDirtyChange?.(value)
    },
    [onDirtyChange],
  )
  const [editorPending, setEditorPending] = useState(false)
  const canChangeSelection = () =>
    !editorPending && (!dirty.current || window.confirm(common.confirm.unsavedMessage))
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
  const dates = useMemo(
    () =>
      [
        ...new Set(
          state.history.flatMap((entry) =>
            [entry.createdAt, entry.voidedAt].filter((date): date is string => !!date),
          ),
        ),
      ]
        .sort()
        .reverse(),
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
  const toggle = (tooth: number, additive: boolean) => {
    if (!canChangeSelection()) return
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
  }
  const switchDentition = (next: Dentition) => {
    if (next === dentition || !canChangeSelection()) return
    setDentition(next)
    // La vista mixta contiene las demás: solo se pierde lo que deja de verse.
    const visible = next === "mixed" ? null : next === "primary" ? FDI_CHILD : FDI_ADULT
    const kept = visible ? selection.filter((tooth) => visible.includes(tooth)) : selection
    setSelection(kept)
    if (kept.length === 0) setDrawerOpen(false)
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
  const showInlinePanel = detailMode === "panel" && wide && selection.length > 0 && drawerOpen
  return (
    <div ref={containerRef} className="flex min-w-0 flex-col gap-4">
      <div
        className={`grid min-w-0 gap-4 ${wide ? "grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)]" : "grid-cols-1"}`}
      >
        <section
          aria-label="Boca dental"
          className={`flex min-w-0 flex-col gap-4 rounded-lg border p-4 sm:p-5 ${wide ? "lg:sticky lg:top-4 self-start" : ""}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Odontograma</h3>
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
          <p className="text-xs text-muted-foreground">
            {dentition === suggested
              ? birthDate
                ? "Dentición sugerida por la edad del paciente."
                : "Dentición por defecto: no hay fecha de nacimiento registrada."
              : "Vista cambiada a mano."}
            {dentition === "mixed" ? " Arco exterior: permanentes. Arco interior: temporales." : ""}
          </p>
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
              {official ? (
                <Button size="sm" variant="outline" onClick={() => setOfficialOpen(true)}>
                  Ver como la norma
                </Button>
              ) : null}
            </div>
            {!compact && (
              <Field className="w-full sm:w-52">
                <FieldLabel htmlFor={`${id}-date`}>Ver estado al</FieldLabel>
                <Select
                  value={snapshot}
                  items={{
                    current: "Actual",
                    ...Object.fromEntries(
                      dates.map((date) => [date, snapshotLabel(date)]),
                    ),
                  }}
                  onValueChange={(value) => {
                    if (canChangeSelection()) setSnapshot(value ?? "current")
                  }}
                  disabled={disabled}
                >
                  <SelectTrigger id={`${id}-date`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current">Actual</SelectItem>
                    {dates.map((date) => (
                      <SelectItem key={date} value={date}>
                        {snapshotLabel(date)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
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
                  if (canChangeSelection()) setSelection(upperTeeth)
                }}
              >
                Arcada superior
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  if (canChangeSelection()) setSelection(lowerTeeth)
                }}
              >
                Arcada inferior
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || selection.length === 0}
                onClick={() => {
                  if (canChangeSelection()) setSelection([])
                }}
              >
                Limpiar
              </Button>
            </div>
          )}
          {/* En el celular el arco llega casi al borde de la tarjeta: así las piezas
              quedan a 24 px una de otra, lo mínimo para tocarlas con el dedo. */}
          <div className="-mx-3 sm:mx-0">
            <OdontogramArch
              teeth={{ upper: outerRows[0] ?? [], lower: outerRows[1] ?? [] }}
              inner={
                innerRows ? { upper: innerRows[0] ?? [], lower: innerRows[1] ?? [] } : undefined
              }
              entriesOf={entriesOf}
              selected={selection}
              disabled={disabled || editorPending}
              onToggle={toggle}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {multiple
              ? "Marca las piezas y abre la selección para editarlas juntas."
              : "Haz clic en una pieza para abrir su registro clínico."}
          </p>
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
        </section>
        <section
          aria-label="Registro clínico dental"
          className={
            showInlinePanel
              ? "h-[calc(100dvh-3rem)] min-h-0 min-w-0 self-start overflow-hidden sticky top-4"
              : "min-w-0 self-start rounded-sm bg-card"
          }
        >
          {!showInlinePanel && (
            <details
              key={selection.length > 0 ? "con-seleccion" : "sin-seleccion"}
              open={selection.length > 0}
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
                      <ol className="ml-2 flex flex-col gap-5 border-l pl-5">
                        {visibleHistory.map((entry) => (
                          <li
                            key={entry.id}
                            className="relative rounded-lg border bg-background p-4"
                          >
                            <span
                              aria-hidden
                              className="absolute top-5 -left-[26px] size-2.5 rounded-full border-2 border-background bg-muted-foreground"
                            />
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="text-xs text-muted-foreground">
                                  Pieza {entry.toothNumber}
                                  {entry.createdAt
                                    ? ` · ${formatDate(entry.createdAt)}`
                                    : ""}
                                </p>
                                <h4 className="mt-1 font-medium">
                                  {findingWords(official, entry)}
                                </h4>
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
                                  <Badge variant="outline">
                                    Registro previo · requiere revisión
                                  </Badge>
                                ) : null}
                              </div>
                            </div>
                            {(entry.surface || entry.diagnosisCode) && (
                              <p className="mt-3 text-sm text-muted-foreground">
                                {entry.surface ? surfaceLabel(entry.surface) : "Pieza completa"}
                                {entry.diagnosisCode ? ` · ${diagnosisCodeLabel(entry.diagnosisSystem, entry.diagnosisCode)}` : ""}
                              </p>
                            )}
                            {entry.note && (
                              <p className="mt-3 rounded-md bg-muted/50 p-3 text-sm">
                                {entry.note}
                              </p>
                            )}
                            {entry.details?.specifications && (
                              <p className="mt-2 text-sm">
                                Especificaciones: {entry.details.specifications}
                              </p>
                            )}
                            {entry.details?.observations && (
                              <p className="mt-2 text-sm">
                                Observaciones: {entry.details.observations}
                              </p>
                            )}
                            {entry.voidReason && (
                              <p className="mt-2 text-sm text-muted-foreground">
                                Corrección: {entry.voidReason}
                              </p>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </details>
          )}
          {selection.length > 0 && (
            <ToothDrawer
              key={`${selection.join("-")}-${snapshot}`}
              inline={showInlinePanel}
              open={drawerOpen}
              onOpenChange={(next) => {
                setDrawerOpen(next)
                if (!next) setSelection([])
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
              onDirtyChange={handleDirtyChange}
              onPendingChange={(pending) => {
                setEditorPending(pending)
                onPendingChange?.(pending)
              }}
            />
          )}
        </section>
      </div>
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
