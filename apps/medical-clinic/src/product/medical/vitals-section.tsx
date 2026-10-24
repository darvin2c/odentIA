import { NewEncounterButton } from "@odentia/clinic-app/components/patient/new-encounter-button"
import { useMemberName } from "@odentia/clinic-app/lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "@odentia/clinic-app/lib/locale"
import {
  ageFrom,
  fetchPatientVitals,
  type PatientFull,
  type VitalsReading,
} from "@odentia/clinic-app/lib/patients"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import { bodyMassIndex, VITAL_SIGNS, type VitalSignKey, type Vitals } from "@odentia/clinical"
import { MEDICAL_VITAL_KEYS } from "@odentia/medical"
import {
  Button,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@odentia/ui"
import {
  type ChartCategory,
  EmptyState,
  LineChart,
  type LineSeries,
  LoadingState,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Activity } from "lucide-react"
import { useState } from "react"

const SIGN = Object.fromEntries(VITAL_SIGNS.map((sign) => [sign.key, sign])) as Record<
  VitalSignKey,
  (typeof VITAL_SIGNS)[number]
>

function decimal(value: number): string {
  return value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 1 })
}

function dateOf(iso: string, month: "short" | "long"): string {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month,
    ...(month === "long" ? { year: "numeric" } : {}),
    timeZone: activeOrgTimeZone(),
  })
}

/** Una medida en el tiempo: solo las atenciones en que se tomó. */
interface Measure {
  key: string
  title: string
  /** Debajo del título: la unidad y lo que sirve para leerla. */
  hint: string
  unit: string
  series: Array<{ key: VitalSignKey; label: string; tone: LineSeries["tone"] }>
}

/**
 * Qué se grafica: la presión y el peso siempre que haya; la talla en menores de
 * 18 años (decisión 14, sin percentiles todavía); el perímetro cefálico y la
 * glucosa capilar si alguna vez se tomaron.
 */
function measuresFor(readings: VitalsReading[], age: number | null, bmi: number | null): Measure[] {
  const taken = (key: VitalSignKey) => readings.some((reading) => reading.vitals[key] !== undefined)
  const out: Measure[] = []
  if (taken("presionSistolica"))
    out.push({
      key: "presion",
      title: "Presión arterial",
      hint: "mmHg · en cada atención",
      unit: "mmHg",
      series: [
        { key: "presionSistolica", label: "Sistólica", tone: "series-1" },
        { key: "presionDiastolica", label: "Diastólica", tone: "series-2" },
      ],
    })
  if (taken("peso"))
    out.push({
      key: "peso",
      title: "Peso",
      hint: bmi === null ? "kg" : `kg · IMC de la última medición ${decimal(bmi)}`,
      unit: "kg",
      series: [{ key: "peso", label: "Peso", tone: "series-1" }],
    })
  if (taken("talla") && age !== null && age < 18)
    out.push({
      key: "talla",
      title: "Talla",
      hint: "cm",
      unit: "cm",
      series: [{ key: "talla", label: "Talla", tone: "series-1" }],
    })
  if (taken("perimetroCefalico"))
    out.push({
      key: "perimetro",
      title: "Perímetro cefálico",
      hint: "cm",
      unit: "cm",
      series: [{ key: "perimetroCefalico", label: "Perímetro cefálico", tone: "series-1" }],
    })
  if (taken("glucosaCapilar"))
    out.push({
      key: "glucosa",
      title: "Glucosa capilar",
      hint: "mg/dL",
      unit: "mg/dL",
      series: [{ key: "glucosaCapilar", label: "Glucosa capilar", tone: "series-1" }],
    })
  return out
}

function MeasureCard({ measure, readings }: { measure: Measure; readings: VitalsReading[] }) {
  const rows = readings.filter((reading) =>
    measure.series.some((line) => reading.vitals[line.key] !== undefined),
  )
  const categories: ChartCategory[] = rows.map((reading) => ({
    key: reading.encounterId,
    label: dateOf(reading.startedAt, "long"),
    short: dateOf(reading.startedAt, "short"),
  }))
  const series: LineSeries[] = measure.series.map((line) => ({
    key: line.key,
    label: line.label,
    tone: line.tone,
    values: rows.map((reading) => reading.vitals[line.key] ?? null),
  }))
  const first = series[0]?.values.find((value) => value !== null)
  const last = series[0]?.values.findLast((value) => value !== null)
  const trend =
    first === undefined || first === null || last === undefined || last === null
      ? ""
      : rows.length === 1
        ? `: ${decimal(last)} ${measure.unit}`
        : `: de ${decimal(first)} a ${decimal(last)} ${measure.unit}`
  return (
    <section
      aria-label={measure.title}
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6"
    >
      <div>
        <h2 className="font-heading text-base font-medium">{measure.title}</h2>
        <p className="text-sm text-muted-foreground">{measure.hint}</p>
      </div>
      <LineChart
        title={`${measure.title} en cada atención${trend}`}
        categories={categories}
        series={series}
        format={(value) => `${decimal(value)} ${measure.unit}`}
        axis={decimal}
        withTable={false}
        height={180}
      />
    </section>
  )
}

/** Todos los signos de cada atención, la más reciente primero: lo mismo que los gráficos, escrito. */
function ReadingsTable({
  readings,
  keys,
}: {
  readings: VitalsReading[]
  keys: readonly VitalSignKey[]
}) {
  const memberName = useMemberName()
  const shown = keys.filter((key) => readings.some((reading) => reading.vitals[key] !== undefined))
  return (
    <section
      aria-label="Signos vitales de cada atención"
      className="elevated min-w-0 rounded-xl border bg-card p-4 sm:p-6"
    >
      <ScrollArea horizontal className="min-w-0 [&_[data-slot=table-container]]:overflow-visible">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Fecha</TableHead>
              {shown.map((key) => (
                <TableHead key={key} scope="col" className="text-right">
                  {SIGN[key].label} ({SIGN[key].suffix})
                </TableHead>
              ))}
              <TableHead scope="col" className="text-right">
                IMC
              </TableHead>
              <TableHead scope="col">Quién</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...readings].reverse().map((reading) => {
              const bmi = bodyMassIndex(reading.vitals)
              return (
                <TableRow key={reading.encounterId}>
                  <TableCell className="whitespace-nowrap">
                    {dateOf(reading.startedAt, "long")}
                  </TableCell>
                  {shown.map((key) => {
                    const value = reading.vitals[key]
                    return (
                      <TableCell key={key} className="text-right tabular-nums">
                        {value === undefined ? "—" : decimal(value)}
                      </TableCell>
                    )
                  })}
                  <TableCell className="text-right tabular-nums">
                    {bmi === null ? "—" : decimal(bmi)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {memberName(reading.professionalUserId)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </ScrollArea>
    </section>
  )
}

/** La última medición, signo por signo, con cuándo y quién. */
function LatestCard({ reading }: { reading: VitalsReading }) {
  const memberName = useMemberName()
  const vitals: Vitals = reading.vitals
  const bmi = bodyMassIndex(vitals)
  const rows: Array<[string, string]> = []
  if (vitals.presionSistolica !== undefined && vitals.presionDiastolica !== undefined)
    rows.push(["Presión arterial", `${vitals.presionSistolica}/${vitals.presionDiastolica} mmHg`])
  for (const key of MEDICAL_VITAL_KEYS) {
    if (key === "presionSistolica" || key === "presionDiastolica") continue
    const value = vitals[key]
    if (value !== undefined) rows.push([SIGN[key].label, `${decimal(value)} ${SIGN[key].suffix}`])
  }
  if (bmi !== null) rows.push(["IMC", decimal(bmi)])
  const today = reading.status === "borrador"
  return (
    <section
      aria-label="Última medición"
      className="elevated flex flex-col rounded-xl border bg-card p-4 sm:p-6"
    >
      <h2 className="font-heading text-base font-medium">Última medición</h2>
      <p className="mb-2 text-sm text-muted-foreground">
        {dateOf(reading.startedAt, "short")} · {memberName(reading.professionalUserId)}
        {today ? " · en la atención en curso" : ""}
      </p>
      <dl className="flex flex-col">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 border-t py-2 text-sm">
            <dt>{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * «Signos vitales» en la ficha de latidIA, en el lugar del Odontograma
 * (decisión 6 del issue 229): la presión y el peso de cada atención en el
 * tiempo, la última medición y todo como tabla.
 */
export function VitalsSection({
  patientId,
  record,
}: {
  patientId: string
  record: PatientFull | null
}) {
  const [asTable, setAsTable] = useState(false)
  const query = useQuery({
    queryKey: ["patient-vitals", patientId],
    queryFn: () => fetchPatientVitals(patientId),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError)
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const readings = query.data.data
  const latest = readings.at(-1)
  if (!latest)
    return (
      <div className="flex flex-col items-center gap-3">
        <EmptyState
          icon={Activity}
          title="Aún no tiene signos vitales"
          description="Se toman en el examen físico de cada atención y aquí se ven en el tiempo."
          className="w-full"
        />
        <NewEncounterButton patientId={patientId} detail={record ?? undefined} variant="outline" />
      </div>
    )
  const age = Number.parseInt(ageFrom(record?.patient.birthDate), 10)
  const measures = measuresFor(
    readings,
    Number.isNaN(age) ? null : age,
    bodyMassIndex(latest.vitals),
  )
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {asTable ? (
          <ReadingsTable readings={readings} keys={MEDICAL_VITAL_KEYS} />
        ) : measures.length > 0 ? (
          measures.map((measure) => (
            <MeasureCard key={measure.key} measure={measure} readings={readings} />
          ))
        ) : (
          <p className="elevated rounded-xl border bg-card p-4 text-sm text-muted-foreground sm:p-6">
            Todavía no hay presión ni peso para dibujar: los demás signos están en la tabla.
          </p>
        )}
      </div>
      <aside
        aria-label="Resumen de signos vitales"
        className="flex flex-col gap-4 lg:w-80 lg:shrink-0"
      >
        <LatestCard reading={latest} />
        <div className="elevated flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-4">
          <span className="text-sm text-muted-foreground">
            {readings.length === 1
              ? "1 atención con signos vitales"
              : `${readings.length} atenciones con signos vitales`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={asTable}
            onClick={() => setAsTable((value) => !value)}
          >
            {asTable ? "Ver los gráficos" : "Ver como tabla"}
          </Button>
        </div>
      </aside>
    </div>
  )
}
