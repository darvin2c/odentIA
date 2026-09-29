import {
  conditionLabel,
  FDI_ADULT,
  FDI_ADULT_ROWS,
  FDI_CHILD,
  FDI_CHILD_ROWS,
  findingAbbreviation,
  surfaceLabel,
  toothNameOf,
} from "@odentia/clinical"
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
import { ChevronDown } from "lucide-react"
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
import {
  type OdontogramEntry,
  type OdontogramState,
  statusLabel,
  winnersAsOf,
} from "../lib/patients"
import { OdontogramArch } from "./odontogram-arch"
import { OdontogramAssessments } from "./odontogram-assessments"
import { ToothDrawer } from "./tooth-drawer"
import { ToothSVG } from "./tooth-svg"

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

export function OdontogramStudio({
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
}: {
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
}) {
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const id = useId()
  const { ref: containerRef, wide } = useContainerWide()
  const detailMode = useDetailMode()
  const dirty = useRef(false)
  const handleDirtyChange = useCallback((value: boolean) => {
    dirty.current = value
  }, [])
  const [editorPending, setEditorPending] = useState(false)
  const canChangeSelection = () =>
    !editorPending && (!dirty.current || window.confirm(common.confirm.unsavedMessage))
  const validInitial =
    initialTooth && (FDI_ADULT.includes(initialTooth) || FDI_CHILD.includes(initialTooth))
      ? initialTooth
      : null
  const [dentition, setDentition] = useState<"adult" | "primary">(
    validInitial && FDI_CHILD.includes(validInitial) ? "primary" : "adult",
  )
  const [selection, setSelection] = useState<number[]>(validInitial ? [validInitial] : [])
  const [drawerOpen, setDrawerOpen] = useState(Boolean(validInitial))
  const [multiple, setMultiple] = useState(false)
  const [snapshot, setSnapshot] = useState("current")
  const lastInitial = useRef<number | null>(validInitial)
  // El enlace (p. ej. Historia→pieza) actualiza la selección también después del primer mount.
  useEffect(() => {
    if (validInitial && validInitial !== lastInitial.current) {
      lastInitial.current = validInitial
      setDentition(FDI_CHILD.includes(validInitial) ? "primary" : "adult")
      setSelection([validInitial])
      setSnapshot("current")
    }
  }, [validInitial])
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
  const locked = !canWrite || readOnly || historical
  const rows = dentition === "adult" ? FDI_ADULT_ROWS : FDI_CHILD_ROWS
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
  const switchDentition = (next: "adult" | "primary") => {
    if (!canChangeSelection()) return
    setDentition(next)
    setSelection([])
    setDrawerOpen(false)
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
              <Button
                variant={dentition === "adult" ? "default" : "outline"}
                size="sm"
                aria-pressed={dentition === "adult"}
                disabled={disabled}
                onClick={() => switchDentition("adult")}
              >
                Adulta (32)
              </Button>
              <Button
                variant={dentition === "primary" ? "default" : "outline"}
                size="sm"
                aria-pressed={dentition === "primary"}
                disabled={disabled}
                onClick={() => switchDentition("primary")}
              >
                Temporal (20)
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              size="sm"
              variant={multiple ? "default" : "outline"}
              aria-pressed={multiple}
              disabled={disabled}
              onClick={() => setMultiple(!multiple)}
            >
              Seleccionar varias
            </Button>
            {!compact && (
              <Field className="w-full sm:w-52">
                <FieldLabel htmlFor={`${id}-date`}>Ver estado al</FieldLabel>
                <Select
                  value={snapshot}
                  items={{
                    current: "Actual",
                    ...Object.fromEntries(
                      dates.map((date) => [date, new Date(date).toLocaleString("es-PE")]),
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
                        {new Date(date).toLocaleString("es-PE")}
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
                  if (canChangeSelection()) setSelection([...(rows[0] ?? [])])
                }}
              >
                Arcada superior
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  if (canChangeSelection()) setSelection([...(rows[1] ?? [])])
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
          <OdontogramArch
            teeth={{ upper: rows[0] ?? [], lower: rows[1] ?? [] }}
            entriesOf={entriesOf}
            selected={selection}
            disabled={disabled || editorPending}
            onToggle={toggle}
          />
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
                  {selection.length ? "Selección actual" : "Registro clínico"}
                </span>
                <span className="block text-lg font-semibold">
                  {selectedTooth
                    ? toothNameOf(selectedTooth)
                    : selection.length
                      ? `${selection.length} piezas seleccionadas`
                      : "Evolución del odontograma"}
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
                    Selecciona un diente para ver sus hallazgos, imágenes y tratamientos. Registra
                    los hallazgos observados en el panel de edición; los tratamientos propuestos
                    pertenecen al plan.
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
                                    ? ` · ${new Date(entry.createdAt).toLocaleDateString("es-PE")}`
                                    : ""}
                                </p>
                                <h4 className="mt-1 font-medium">
                                  {conditionLabel(entry.condition)}
                                </h4>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Badge variant="outline">{statusLabel(entry.status)}</Badge>
                                {entry.needsReview ? (
                                  <Badge variant="outline">
                                    Registro previo · requiere revisión
                                  </Badge>
                                ) : (
                                  findingAbbreviation(entry) && (
                                    <Badge variant="outline">{findingAbbreviation(entry)}</Badge>
                                  )
                                )}
                              </div>
                            </div>
                            {(entry.surface || entry.diagnosisCode) && (
                              <p className="mt-3 text-sm text-muted-foreground">
                                {entry.surface ? surfaceLabel(entry.surface) : "Pieza completa"}
                                {entry.diagnosisCode ? ` · CIE-10 ${entry.diagnosisCode}` : ""}
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
      {!compact && (
        <Collapsible>
          <div className="flex flex-col gap-6 rounded-sm bg-card p-6">
            <div className="flex flex-col gap-1.5 pb-3">
              <CollapsibleTrigger className="text-base font-semibold">
                <span className="flex items-center gap-1">
                  Actas del odontograma <ChevronDown aria-hidden className="size-4" />
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div>
                <OdontogramAssessments
                  patientId={patientId}
                  history={state.history}
                  readOnly={locked}
                  disabled={disabled}
                  beforeWrite={beforeWrite}
                  onPendingChange={onPendingChange}
                />
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
      {!compact && (
        <Collapsible>
          <div className="flex flex-col gap-6 rounded-sm bg-card p-6">
            <div className="flex flex-col gap-1.5 pb-3">
              <CollapsibleTrigger className="text-base font-semibold">
                <span className="flex items-center gap-1">
                  Historial del odontograma <ChevronDown aria-hidden className="size-4" />
                </span>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="flex flex-col gap-3">
                {historical && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">Solo lectura</Badge>
                    <Button size="sm" variant="outline" onClick={() => setSnapshot("current")}>
                      Volver al estado actual
                    </Button>
                  </div>
                )}
                <ol className="flex flex-col gap-2">
                  {state.history.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                    >
                      <span>
                        Pieza {entry.toothNumber} · {conditionLabel(entry.condition)}
                        {entry.createdAt
                          ? ` · ${new Date(entry.createdAt).toLocaleDateString("es-PE")}`
                          : ""}
                      </span>
                      <span className="flex gap-2">
                        <Badge variant="outline">{statusLabel(entry.status)}</Badge>
                        {entry.needsReview ? (
                          <Badge variant="outline">Requiere revisión</Badge>
                        ) : null}
                      </span>
                    </li>
                  ))}
                  {state.history.length === 0 ? (
                    <li className="text-sm text-muted-foreground">Sin registros dentales.</li>
                  ) : null}
                </ol>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
    </div>
  )
}
