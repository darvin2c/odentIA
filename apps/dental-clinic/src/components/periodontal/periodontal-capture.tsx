/**
 * Captura del periodontograma a pantalla completa (lienzo, tableros 3, 5 y 7).
 * Una pieza y una cara a la vez, con campos grandes, el teclado físico o el de
 * la pantalla, y el gráfico que se dibuja al lado mientras se escribe. Cada
 * cambio se guarda solo; sin conexión queda en la pantalla y se envía al volver.
 * La placa (O'Leary) se marca aparte, en sus cuatro caras.
 */
import {
  furcationEntriesFor,
  MOBILITY_MAX,
  probingSequence,
  type PeriodontalToothRecord,
  summarizePeriodontal,
} from "@odentia/clinical"
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import { type PeriodontalChart as ChartData, periodontalKeys, savePeriodontalTooth, toothSaveBody } from "../../lib/periodontal"
import { isUpper, PlaqueTooth } from "./anatomy"
import {
  applyCaptureKey,
  type CaptureKey,
  type CaptureState,
  chartFace,
  directionWords,
  fieldAt,
  fieldKind,
  fieldLabel,
  fieldSite,
  initialCaptureState,
  jumpToTooth,
  keyFromEvent,
  progressWords,
  typingPositions,
  cellValue,
} from "./capture-state"
import { LOWER_ROW, PeriodontalChart, signed, UPPER_ROW } from "./periodontal-chart"

type SaveState = "saved" | "saving" | "offline" | "error"

const isOffline = (err: unknown) => (typeof navigator !== "undefined" && navigator.onLine === false) || err instanceof TypeError

const HAMP = ["—", "I", "II", "III"]
const MOBILITY_GRADES = Array.from({ length: MOBILITY_MAX + 1 }, (_, grade) => grade)
const FURCATION_GRADES = [0, 1, 2, 3]

/**
 * Un grado que se elige entre pocos (movilidad, furca): el `RadioGroup` del
 * sistema con cada opción como una píldora. `byKeyboard` dice si se eligió con
 * las flechas, para no sacar el foco del grupo mientras se recorre.
 */
function PillRadios({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string; aria?: string }>
  onChange: (value: string, byKeyboard: boolean) => void
}) {
  return (
    <RadioGroup
      aria-label={label}
      className="flex flex-wrap gap-1"
      value={value}
      onValueChange={(next, details) => onChange(String(next), details.event instanceof KeyboardEvent)}
    >
      {options.map((option) => (
        <FieldLabel
          key={option.value}
          className={cn(
            "flex h-9 w-auto cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-sm font-semibold",
            value === option.value ? "border-primary bg-primary-soft text-primary-soft-foreground" : "text-muted-foreground",
          )}
        >
          <RadioGroupItem value={option.value} aria-label={option.aria ?? option.label} />
          {option.label}
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
const FURCATION_WORDS: Record<string, string> = {
  buccal: "Furca por fuera",
  lingual: "Furca por dentro",
  mesiopalatal: "Furca mesial por dentro",
  distopalatal: "Furca distal por dentro",
  mesial: "Furca mesial",
  distal: "Furca distal",
}

/**
 * Guarda las piezas que cambian, una a la vez y la última versión de cada una.
 * Lo que no salió (sin conexión) se reintenta al volver la conexión.
 */
function useToothSaver(patientId: string, chartId: string, latest: React.RefObject<CaptureState>) {
  const queryClient = useQueryClient()
  const pending = useRef(new Set<number>())
  const draining = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [state, setState] = useState<SaveState>("saved")
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)

  const drain = useCallback(async () => {
    if (draining.current) return
    draining.current = true
    try {
      while (pending.current.size > 0) {
        const tooth = pending.current.values().next().value as number
        pending.current.delete(tooth)
        const record = latest.current?.teeth[tooth]
        if (!record) continue
        try {
          await savePeriodontalTooth(patientId, chartId, tooth, toothSaveBody(record))
        } catch (err) {
          pending.current.add(tooth)
          if (isOffline(err)) {
            setState("offline")
          } else {
            setState("error")
            setError(err instanceof ApiError && err.shape.message ? err.shape.message : "No se pudo guardar la pieza")
          }
          return
        }
      }
      setState("saved")
      setError(null)
      setSavedAt(new Date())
      void queryClient.invalidateQueries({ queryKey: periodontalKeys.list(patientId) })
      void queryClient.invalidateQueries({ queryKey: periodontalKeys.chart(patientId, chartId) })
      // La movilidad se ve en el odontograma (M1–M3): se vuelve a pedir.
      void queryClient.invalidateQueries({ queryKey: ["odontogram", patientId] })
    } finally {
      draining.current = false
    }
  }, [chartId, latest, patientId, queryClient])

  const schedule = useCallback(
    (teeth: number[], now = false) => {
      for (const tooth of teeth) pending.current.add(tooth)
      if (!pending.current.size) return
      setState((current) => (current === "offline" ? current : "saving"))
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void drain(), now ? 0 : 600)
    },
    [drain],
  )

  useEffect(() => {
    const online = () => {
      if (pending.current.size) void drain()
    }
    window.addEventListener("online", online)
    return () => {
      window.removeEventListener("online", online)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [drain])

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    await drain()
    return pending.current.size === 0
  }, [drain])

  return { state, error, savedAt, schedule, flush, retry: () => void drain() }
}

export function PeriodontalCapture({
  patientId,
  chart,
  open,
  onClose,
}: {
  patientId: string
  chart: ChartData
  open: boolean
  onClose: () => void
}) {
  const steps = useMemo(() => probingSequence(chart.expectedTeeth), [chart.expectedTeeth])
  const [capture, setCapture] = useState<CaptureState>(() =>
    initialCaptureState(Object.fromEntries(chart.teeth.map((tooth) => [tooth.toothNumber, tooth])), steps),
  )
  const latest = useRef(capture)
  latest.current = capture
  const saver = useToothSaver(patientId, chart.id, latest)
  const [say, setSay] = useState("")
  const [mode, setMode] = useState<"probe" | "plaque">("probe")
  const cellRefs = useRef<Array<HTMLInputElement | null>>([])
  // Al abrir, el foco va al campo que toca escribir, no al primer botón.
  const activeCell = useRef<HTMLInputElement | null>(null)
  const [closing, setClosing] = useState(false)

  const step = capture.steps[capture.cursor.step]
  const record: PeriodontalToothRecord | undefined = step ? capture.teeth[step.toothNumber] : undefined
  const implant = step ? chart.implantTeeth.includes(step.toothNumber) : false
  const teethList = useMemo(() => Object.values(capture.teeth), [capture.teeth])
  const summary = useMemo(
    () => summarizePeriodontal(teethList, chart.implantTeeth, chart.expectedTeeth),
    [teethList, chart.implantTeeth, chart.expectedTeeth],
  )

  // Las teclas pueden llegar antes de que se pinte la anterior: todo se lee de `latest`.
  const apply = (key: CaptureKey) => {
    const before = latest.current
    const result = applyCaptureKey(before, key, performance.now())
    latest.current = result.state
    setCapture(result.state)
    if (result.say) setSay(result.say)
    if (result.changed.length) {
      // Al cambiar de pieza se guarda enseguida lo de la anterior.
      const toothOf = (state: CaptureState) => state.steps[state.cursor.step]?.toothNumber
      saver.schedule(result.changed, toothOf(result.state) !== toothOf(before))
    }
  }

  /** Movilidad, furca, sangrado o placa tocados con el ratón o el dedo; con teclado el foco se queda en el control. */
  const updateTooth = (
    toothNumber: number,
    change: (tooth: PeriodontalToothRecord) => PeriodontalToothRecord,
    words: string,
    refocus = true,
  ) => {
    const current = latest.current
    const tooth = current.teeth[toothNumber]
    if (!tooth) return
    const next = { ...current, teeth: { ...current.teeth, [toothNumber]: change(tooth) } }
    latest.current = next
    setCapture(next)
    setSay(words)
    saver.schedule([toothNumber])
    // Tras marcar movilidad, furca o sangrado se sigue escribiendo donde se estaba.
    if (refocus && mode === "probe" && !next.done) requestAnimationFrame(() => cellRefs.current[next.cursor.field]?.focus({ preventScroll: true }))
  }

  // El foco va siempre al campo que se escribe.
  useEffect(() => {
    if (!open || mode !== "probe" || capture.done) return
    cellRefs.current[capture.cursor.field]?.focus({ preventScroll: true })
  }, [open, mode, capture.cursor, capture.done])

  // No se cierra con piezas sin guardar: se perderían. Se dice y se ofrece cerrar igual.
  const [unsavedOnClose, setUnsavedOnClose] = useState(false)
  const close = async () => {
    setClosing(true)
    const ok = await saver.flush()
    setClosing(false)
    if (ok) onClose()
    else setUnsavedOnClose(true)
  }

  const saveText =
    saver.state === "offline"
      ? "Sin conexión: se guarda al volver"
      : saver.state === "saving"
        ? "Guardando…"
        : saver.state === "error"
          ? "No se guardó"
          : saver.savedAt
            ? `Guardado ${saver.savedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
            : "Guardado"

  const keypad: Array<{ label: string; key: CaptureKey; aria?: string; wide?: boolean }> = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => ({ label: String(value), key: { kind: "digit", value } as CaptureKey })),
    { label: "−", key: { kind: "minus" }, aria: "Recesión negativa" },
    { label: "0", key: { kind: "digit", value: 0 } },
    { label: "⌫", key: { kind: "back" }, aria: "Borrar" },
    { label: "Sangra (S)", key: { kind: "bleeding" }, wide: true },
    { label: "Supura (P)", key: { kind: "suppuration" }, wide: true },
    { label: "Saltar pieza", key: { kind: "skip" }, wide: true },
  ]

  // Caras con algún sitio sin escribir (las piezas saltadas no faltan).
  const pendingSteps = steps.filter(
    (s) => !capture.teeth[s.toothNumber]?.skipped && [0, 1, 2, 3, 4, 5].some((field) => cellValue(capture.teeth, s, field) === null),
  ).length

  const probeCard = step ? (
    <div className="flex flex-col gap-4 rounded-2xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-2xl font-extrabold tracking-tight">
            Pieza {step.toothNumber}
            {implant ? <span className="ml-2 text-base font-semibold text-muted-foreground">implante</span> : null}
            {record?.skipped ? <span className="ml-2 text-base font-semibold text-warning">saltada</span> : null}
          </span>
          <span className="text-sm text-muted-foreground">
            {isUpper(step.toothNumber) ? "Arriba" : "Abajo"},{" "}
            {step.face === "buccal" ? "por fuera (vestibular)" : isUpper(step.toothNumber) ? "por dentro (palatino)" : "por dentro (lingual)"} ·{" "}
            {directionWords(step)}
          </span>
        </div>
        <span className="text-sm text-muted-foreground">{progressWords(capture)}</span>
      </div>
      {/* Tres columnas en el orden de la pantalla; el cursor avanza en el sentido de la sonda. */}
      <fieldset className="grid min-w-0 grid-cols-[auto_repeat(3,minmax(0,1fr))] items-center gap-2">
        <legend className="sr-only">Sitios de la {step.toothNumber}</legend>
        <span />
        {[0, 1, 2].map((position) => {
          const field = fieldAt(step, "pd", position)
          const site = fieldSite(step, field)
          return (
            <span key={position} className="text-center text-xs font-bold tracking-wider text-muted-foreground uppercase">
              {["Mesial", "Centro", "Distal", "Mesial", "Centro", "Distal"][site]}
            </span>
          )
        })}
        {(["pd", "rec"] as const).map((row) => (
          <div key={row} className="contents">
            <span className="pr-1 text-xs font-semibold text-muted-foreground">{row === "pd" ? "Profundidad" : "Recesión"}</span>
            {[0, 1, 2].map((position) => {
              const field = fieldAt(step, row, position)
              const value = cellValue(capture.teeth, step, field)
              const active = capture.cursor.field === field && !capture.done
              const site = fieldSite(step, field)
              const pd = record?.probingDepth[site] ?? null
              return (
                <input
                  key={`${row}-${position}`}
                  ref={(node) => {
                    cellRefs.current[field] = node
                    if (active) activeCell.current = node
                  }}
                  aria-label={fieldLabel(step, field)}
                  inputMode="none"
                  autoComplete="off"
                  value={value === null ? (active && capture.minus && row === "rec" ? "−" : "") : row === "rec" ? signed(value) : String(value)}
                  onChange={(event) => {
                    // Lo que llega sin pasar por la tecla (pegar, teclados en pantalla del sistema).
                    const char = event.target.value.slice(-1)
                    const key = keyFromEvent({ key: char })
                    if (key) apply(key)
                  }}
                  onFocus={() => {
                    if (capture.cursor.field !== field) {
                      const next = { ...latest.current, cursor: { step: latest.current.cursor.step, field }, minus: false, last: null }
                      latest.current = next
                      setCapture(next)
                    }
                  }}
                  onKeyDown={(event) => {
                    const key = keyFromEvent(event)
                    if (!key) return
                    event.preventDefault()
                    apply(key)
                  }}
                  className={cn(
                    "h-14 w-full min-w-0 rounded-xl border-2 bg-background text-center font-mono text-2xl font-extrabold outline-none transition-colors",
                    active ? "border-primary ring-4 ring-primary/20" : "border-input",
                    row === "pd" && value !== null && value >= 6 && "text-danger",
                    row === "pd" && value !== null && value >= 4 && value < 6 && "text-warning",
                    row === "rec" && value === 0 && "text-muted-foreground",
                    row === "pd" && pd !== null && record?.bleeding[site] && "bg-danger-soft",
                  )}
                />
              )
            })}
          </div>
        ))}
        <span />
        {[0, 1, 2].map((position) => {
          const site = fieldSite(step, fieldAt(step, "pd", position))
          const bleeds = record?.bleeding[site] === true
          const pus = record?.suppuration[site] === true
          const toggle = (kind: "bleeding" | "suppuration") =>
            updateTooth(
              step.toothNumber,
              (tooth) => {
                const list = [...tooth[kind]]
                list[site] = !list[site]
                return { ...tooth, [kind]: list }
              },
              `${step.toothNumber}: ${kind === "bleeding" ? (bleeds ? "no sangra" : "sangra") : pus ? "no supura" : "supura"}`,
            )
          // Con el teclado se marcan con S y P; estos botones son para el dedo y el ratón.
          return (
            <div key={position} className="flex flex-col gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                tabIndex={-1}
                aria-pressed={bleeds}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggle("bleeding")}
                className={cn("h-7 px-1 text-xs", bleeds && "border-transparent bg-danger-soft text-danger hover:bg-danger-soft")}
              >
                {bleeds ? "Sangra" : "Sin sangrado"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                tabIndex={-1}
                aria-pressed={pus}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggle("suppuration")}
                className={cn("h-7 px-1 text-xs", pus && "border-transparent bg-warning-soft text-warning hover:bg-warning-soft")}
              >
                {pus ? "Supura" : "Sin pus"}
              </Button>
            </div>
          )
        })}
      </fieldset>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {say ||
          (fieldKind(capture.cursor.field) === "pd"
            ? "Escribe la profundidad de cada sitio en milímetros."
            : `Faltan las recesiones de la ${step.toothNumber}. Si la encía cubre la corona, «−» antes del número.`)}
      </p>
      {/* Para el dedo: con teclado físico se escribe directo en el campo, así que no entra en el Tab. */}
      <fieldset className="grid grid-cols-3 gap-2">
        <legend className="sr-only">Teclado en pantalla</legend>
        {keypad.map((item) => (
          <Button
            key={item.label}
            type="button"
            variant={item.wide ? "outline" : "secondary"}
            className={cn("h-12 text-lg font-bold", item.wide && "text-sm")}
            aria-label={item.aria}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </fieldset>
      {/* Movilidad y furca de la pieza, en la misma tarjeta. */}
      {!implant && record ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          {step.face === "buccal" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-32 text-sm font-medium">Movilidad (Miller)</span>
              <PillRadios
                label={`Movilidad de la ${step.toothNumber}`}
                value={record.mobility === null ? "" : String(record.mobility)}
                options={MOBILITY_GRADES.map((grade) => ({ value: String(grade), label: String(grade) }))}
                onChange={(next, byKeyboard) => {
                  const grade = Number(next)
                  updateTooth(
                    step.toothNumber,
                    (tooth) => ({ ...tooth, mobility: grade }),
                    grade === 0 ? `${step.toothNumber}: sin movilidad` : `${step.toothNumber}: movilidad ${grade}, se verá en el odontograma como M${grade}`,
                    !byKeyboard,
                  )
                }}
              />
              {record.mobility ? <span className="text-xs text-muted-foreground">En el odontograma: M{record.mobility}</span> : null}
            </div>
          ) : null}
          {furcationEntriesFor(step.toothNumber)
            .filter((entry) => (step.face === "buccal" ? entry === "buccal" : entry !== "buccal"))
            .map((entry) => (
              <div key={entry} className="flex flex-wrap items-center gap-2">
                <span className="w-32 text-sm font-medium">{FURCATION_WORDS[entry]}</span>
                <PillRadios
                  label={`${FURCATION_WORDS[entry]} de la ${step.toothNumber} (Hamp)`}
                  value={String(record.furcation[entry] ?? 0)}
                  options={FURCATION_GRADES.map((grade) => ({ value: String(grade), label: HAMP[grade]!, aria: grade === 0 ? "Sin furca" : `Grado ${HAMP[grade]}` }))}
                  onChange={(next, byKeyboard) => {
                    const grade = Number(next)
                    updateTooth(
                      step.toothNumber,
                      (tooth) => {
                        const furcation = { ...tooth.furcation }
                        if (grade === 0) delete furcation[entry]
                        else furcation[entry] = grade as 1 | 2 | 3
                        return { ...tooth, furcation }
                      },
                      grade === 0 ? `${step.toothNumber}: sin furca` : `${step.toothNumber}: furca grado ${HAMP[grade]}`,
                      !byKeyboard,
                    )
                  }}
                />
              </div>
            ))}
        </div>
      ) : null}
    </div>
  ) : null

  const doneCard = (
    <div className="flex flex-col gap-3 rounded-2xl border bg-card p-5">
      <span className="text-xl font-bold">Sondaje completo</span>
      <p className="text-sm text-muted-foreground">
        {summary.teethMeasured} piezas
        {summary.implants.length ? ` y ${summary.implants.length} ${summary.implants.length === 1 ? "implante" : "implantes"}` : ""} · sangra el{" "}
        {summary.bleedingPercent ?? 0} % de los sitios. Toca una pieza del gráfico para corregirla.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setMode("plaque")}>
          Marcar la placa
        </Button>
        <SubmitButton pending={closing} onClick={() => void close()}>
          Volver a la atención
        </SubmitButton>
      </div>
    </div>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) void close()
      }}
    >
      <DialogContent
        initialFocus={activeCell}
        aria-describedby="perio-capture-desc"
        scrollable
        contentClassName="flex min-h-full flex-col gap-0 p-0"
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
      >
        <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 pr-14 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <DialogTitle className="text-lg">Periodontograma</DialogTitle>
            <Tabs value={mode} onValueChange={(value) => setMode(value === "plaque" ? "plaque" : "probe")}>
              <TabsList aria-label="Qué se marca">
                <TabsTrigger value="probe">Sondaje</TabsTrigger>
                <TabsTrigger value="plaque">Placa</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="flex items-center gap-2">
            <span
              role="status"
              aria-live="polite"
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium",
                saver.state === "saved" && "border-success/40 bg-success-soft text-success",
                saver.state === "offline" && "border-warning/40 bg-warning-soft text-warning",
                saver.state === "error" && "border-destructive/40 text-destructive",
              )}
            >
              {saveText}
            </span>
            {saver.state === "error" ? (
              <Button type="button" size="sm" variant="outline" onClick={saver.retry}>
                Reintentar
              </Button>
            ) : null}
            <SubmitButton size="sm" pending={closing} onClick={() => void close()}>
              Listo
            </SubmitButton>
          </div>
        </header>
        <DialogDescription id="perio-capture-desc" className="sr-only">
          Escribe con el teclado las profundidades y luego las recesiones de cada pieza; pasa sola a la siguiente. S marca sangrado, P supuración, X salta la pieza, la flecha izquierda y derecha se mueven sin borrar.
        </DialogDescription>
        {saver.error ? (
          <p role="alert" className="px-6 pt-3 text-sm text-destructive">
            {saver.error}
          </p>
        ) : null}
        {unsavedOnClose && saver.state !== "saved" ? (
          <div role="alert" className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/50 bg-warning-soft px-4 py-3 text-sm sm:mx-6">
            <span>Hay piezas sin guardar. Si cierras ahora, se pierde lo que no se guardó.</span>
            <span className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={saver.retry}>
                Reintentar
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onClose}>
                Cerrar igual
              </Button>
            </span>
          </div>
        ) : null}
        {mode === "probe" ? (
          <div className="grid flex-1 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              {capture.done ? doneCard : probeCard}
              <p className="text-xs text-muted-foreground">
                {pendingSteps === 0 ? "No falta ninguna cara." : `Faltan ${pendingSteps} ${pendingSteps === 1 ? "cara" : "caras"} por sondear.`} 0 a 9: la medida, pasa sola al
                sitio siguiente (10 a 15: los dos dígitos seguidos) · − recesión negativa · S sangra · P supura · ⌫ borra · ← → ↑ ↓ se mueven sin borrar · X salta la pieza.
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="rounded-xl border bg-card p-3">
                <PeriodontalChart
                  teeth={teethList}
                  expectedTeeth={chart.expectedTeeth}
                  implantTeeth={chart.implantTeeth}
                  selected={step?.toothNumber ?? null}
                  marker={
                    step && !capture.done
                      ? { tooth: step.toothNumber, face: chartFace(step), position: typingPositions(step)[capture.cursor.field % 3]! }
                      : null
                  }
                  onSelect={(tooth) => {
                    const next = jumpToTooth(latest.current, tooth)
                    latest.current = next
                    setCapture(next)
                    setSay(`Pieza ${tooth}`)
                  }}
                  label="Así se va dibujando el periodontograma; elige una pieza para volver a ella"
                />
              </div>
              <p className="text-xs text-muted-foreground">En el teléfono, desliza el gráfico para ver la arcada. Toca una pieza para volver a ella.</p>
            </div>
          </div>
        ) : (
          <PlaqueBoard
            teeth={capture.teeth}
            expected={chart.expectedTeeth}
            implants={chart.implantTeeth}
            percent={summary.plaque}
            onToggle={(tooth, face) =>
              updateTooth(
                tooth,
                (current) => {
                  const plaque = [...(current.plaque ?? [false, false, false, false])]
                  plaque[face] = !plaque[face]
                  return { ...current, plaque }
                },
                `Placa en la ${tooth}`,
              )
            }
            onRestClean={() => {
              const current = latest.current
              const changed: number[] = []
              const teeth = { ...current.teeth }
              for (const tooth of chart.expectedTeeth) {
                if (chart.implantTeeth.includes(tooth) || !teeth[tooth] || teeth[tooth]!.plaque) continue
                teeth[tooth] = { ...teeth[tooth]!, plaque: [false, false, false, false] }
                changed.push(tooth)
              }
              const next = { ...current, teeth }
              latest.current = next
              setCapture(next)
              setSay(`${changed.length} piezas sin placa`)
              saver.schedule(changed)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * La placa de O'Leary (tablero 7): las piezas como en el odontograma, con sus
 * cuatro caras que se tocan. El implante no cuenta. Es opcional y puede ser
 * otro día; las piezas sin tocar no cuentan hasta marcarlas.
 */
function PlaqueBoard({
  teeth,
  expected,
  implants,
  percent,
  onToggle,
  onRestClean,
}: {
  teeth: Record<number, PeriodontalToothRecord>
  expected: number[]
  implants: number[]
  percent: { faces: number; withPlaque: number; percent: number } | null
  onToggle: (tooth: number, face: number) => void
  onRestClean: () => void
}) {
  const natural = expected.filter((tooth) => !implants.includes(tooth))
  const unmarked = natural.filter((tooth) => !teeth[tooth]?.plaque).length
  const size = 40
  const gap = 6
  const width = 16 * (size + gap)
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5 rounded-xl border bg-card px-4 py-3">
          <span className="text-xs font-medium text-muted-foreground">Placa (O'Leary)</span>
          <span className="text-2xl font-semibold tabular-nums">{percent ? `${percent.percent} %` : "Sin marcar"}</span>
          <span className="text-xs text-muted-foreground">
            {percent ? `${percent.withPlaque} de ${percent.faces} caras` : "Toca las caras con placa"} · el implante no cuenta
          </span>
        </div>
        {unmarked > 0 ? (
          <Button type="button" variant="outline" onClick={onRestClean}>
            Sin placa en las {unmarked} que faltan
          </Button>
        ) : null}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        Cada pieza se ve como en el odontograma: arriba, la cara de fuera hacia arriba y, abajo, hacia abajo; las mesiales miran al centro. Toca una cara, o
        recórrelas con Tab y marca con Enter. Menos del 20 % suele tomarse como buena higiene.
      </p>
      <ScrollArea horizontal className="perio max-w-full rounded-xl border bg-card p-3">
        {/* biome-ignore lint/a11y/useSemanticElements: un SVG no puede ser un fieldset; el grupo nombra las caras que se marcan. */}
        <svg width={width} height={2 * (size + 26)} viewBox={`0 0 ${width} ${2 * (size + 26)}`} role="group" aria-label="Placa por pieza" className="block max-w-none">
          {[UPPER_ROW, LOWER_ROW].map((row, r) => (
            <g key={row[0]} transform={`translate(0 ${r * (size + 26)})`}>
              {row.map((tooth, c) => {
                const x = c * (size + gap)
                const present = expected.includes(tooth)
                const numberY = r === 0 ? size + 14 : 10
                const toothY = r === 0 ? 0 : 16
                return (
                  <g key={tooth}>
                    <text className={cn("tn", !present && "dim")} x={x + size / 2} y={numberY} textAnchor="middle">
                      {tooth}
                    </text>
                    {!present ? null : implants.includes(tooth) ? (
                      <text className="tag" x={x + size / 2} y={toothY + size / 2} textAnchor="middle">
                        implante
                      </text>
                    ) : (
                      <PlaqueTooth tooth={tooth} faces={teeth[tooth]?.plaque ?? null} x={x} y={toothY} width={size} onToggle={(face) => onToggle(tooth, face)} />
                    )}
                  </g>
                )
              })}
            </g>
          ))}
        </svg>
      </ScrollArea>
    </div>
  )
}
