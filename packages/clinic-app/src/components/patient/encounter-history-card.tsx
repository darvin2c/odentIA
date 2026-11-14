import { Badge, Button, cn } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { documentCategoryLabel } from "../../lib/patient-overview"
import { type EncounterBorn, type EncounterDetail, encounterStatusLabel, type TimelineItem } from "../../lib/patients"
import { visitHistoryLine } from "../../lib/visit-answer-words"
import { productUi } from "../../product/product-ui"
import { formatTakenAt } from "./document-labels"
import { DocumentOpenButton } from "./document-open-button"
import { EncounterDetailView } from "./encounter-detail-view"
import { useOpenWide } from "./wide-section"

/** «mié 4 nov, 10:30»: el día y la hora, siempre absolutos. */
function whenWords(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const options = { timeZone: activeOrgTimeZone() }
  const day = at.toLocaleDateString(activeOrgLocale(), { ...options, weekday: "short", day: "numeric", month: "short" }).replace(/\./g, "")
  return `${day}, ${at.toLocaleTimeString(activeOrgLocale(), { ...options, hour: "2-digit", minute: "2-digit" })}`
}

/** «4 nov». */
function dayWords(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  // De otro año, con su año: el control radiográfico al año parecía tocar hoy (verificación de la entrega 9).
  const yearOf = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone(), year: "numeric" }).format(date)
  const otherYear = yearOf(at) !== yearOf(new Date())
  return at
    .toLocaleDateString(activeOrgLocale(), {
      timeZone: activeOrgTimeZone(),
      day: "numeric",
      month: "short",
      ...(otherYear ? { year: "numeric" } : {}),
    })
    .replace(".", "")
}

/** «endodoncia, prótesis y corona»: los nombres en una frase. */
function listWords(names: string[]): string {
  const lower = names.map((name, index) => (index === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1)))
  return lower.length <= 1 ? (lower[0] ?? "") : `${lower.slice(0, -1).join(", ")} y ${lower.at(-1)}`
}

/** «1 presupuesto y 2 tratamientos»: lo anulado dicho por lo que es (mesa del 9 nov). */
function retiredWords(born: EncounterBorn): string {
  const count = (n: number, one: string, many: string) => (n === 0 ? null : `${n} ${n === 1 ? one : many}`)
  return listWords(
    [
      count(born.budgets.filter((row) => row.retired).length, "presupuesto", "presupuestos"),
      count(born.indicated.filter((row) => row.retired).length, "tratamiento", "tratamientos"),
      count(born.followUps.filter((row) => row.retired).length, "control", "controles"),
      count(born.consents.filter((row) => row.status === "anulado").length, "consentimiento", "consentimientos"),
    ].filter((part): part is string => part !== null),
  )
}

/** Un bloque con su rótulo encima (no en una columna al lado: se lee igual en el teléfono). */
function Part({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

/**
 * Lo que nació en la atención (QA de la ficha del 8 nov: un día eran 14
 * tarjetas sueltas): lo que se indicó, se pidió y se firmó, cada cosa una vez.
 * Lo anulado o cancelado va plegado al pie, dicho por lo que es; una receta
 * anulada se ve, porque la impresa pudo salir.
 */
function BornParts({ born, retired = false }: { born: EncounterBorn; retired?: boolean }) {
  const openWide = useOpenWide()
  const pick = <T extends { retired?: boolean }>(rows: T[]) => rows.filter((row) => !!row.retired === retired)
  const indicated = pick(born.indicated)
  const budgets = pick(born.budgets)
  const followUps = pick(born.followUps)
  const consents = born.consents.filter((row) => (row.status === "anulado") === retired)
  const signed = consents.filter((row) => row.status === "firmado")
  const unsigned = consents.filter((row) => row.status !== "firmado" && row.status !== "anulado")
  // Quien firmó, una vez, con lo que firmó: «Firmó Ana Pérez (madre): endodoncia y prótesis».
  const bySigner = new Map<string, string[]>()
  for (const row of signed) {
    const who = row.signerName ? `${row.signerName}${row.relation ? ` (${row.relation})` : ""}` : ""
    bySigner.set(who, [...(bySigner.get(who) ?? []), row.title])
  }
  const prescriptions = retired ? [] : born.prescriptions
  const orders = retired ? [] : born.orders
  const forms = retired ? [] : born.forms
  const indicatedSomething = indicated.length + budgets.length + followUps.length + prescriptions.length + orders.length + forms.length > 0
  return (
    <>
      {!retired && born.told ? (
        // Lo que contó antes de venir, en la atención de su cita, con quién lo vio (mesa del 13 nov, entrega 8).
        <Part label="Lo que contó antes de venir">
          <p className="text-sm">{visitHistoryLine(born.told)}</p>
        </Part>
      ) : null}
      {indicatedSomething ? (
        <Part label={retired ? "Ya no vigente" : "Se indicó"}>
          <ul className="flex flex-col gap-1 text-sm">
            {indicated.map((row) => (
              <li key={row.id}>
                {row.title}
                {row.where ? <span className="text-muted-foreground"> · {row.where}</span> : null}
                <span className="text-muted-foreground"> · {row.stateText}</span>
              </li>
            ))}
            {budgets.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-2">
                <span>
                  Presupuesto N.º {row.budgetNumber}
                  <span className="text-muted-foreground"> · {row.stateText}</span>
                </span>
                {retired ? null : (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    aria-label={`Ver el presupuesto N.º ${row.budgetNumber}`}
                    onClick={() => openWide?.({ id: "plan", budgetId: row.id })}
                  >
                    Ver
                  </Button>
                )}
              </li>
            ))}
            {followUps.map((row) => (
              <li key={row.id}>
                {row.title}
                <span className="text-muted-foreground">
                  {" "}
                  · {new Date(row.dueAt).getTime() < Date.now() ? "tocaba" : "toca"} el {dayWords(row.dueAt)} · {row.stateText}
                </span>
              </li>
            ))}
            {prescriptions.map((row) => (
              <li key={row.id} className={cn(row.voided && "text-muted-foreground")}>
                {row.voided ? `Receta N.º ${row.number} anulada` : `Receta N.º ${row.number}`}
                <span className="text-muted-foreground">
                  {" "}
                  · {row.voided ? (row.reason ?? "sin motivo registrado") : row.detail}
                </span>
              </li>
            ))}
            {orders.map((row) => (
              <li key={row.id}>
                Se pidió: {row.title}
                <span className="text-muted-foreground"> · {row.state}</span>
              </li>
            ))}
            {forms.map((row) => (
              <li key={row.id}>Formulario: {row.title}</li>
            ))}
          </ul>
        </Part>
      ) : null}
      {bySigner.size > 0 || unsigned.length > 0 || (retired && consents.length > 0) ? (
        <Part label={retired ? "Consentimiento anulado" : "Consentimiento"}>
          <ul className="flex flex-col gap-1 text-sm">
            {retired
              ? consents.map((row) => <li key={row.id}>{row.title}</li>)
              : [...bySigner.entries()].map(([who, titles]) => (
                  <li key={who || "-"}>
                    {who ? `Firmó ${who}: ` : "Firmó: "}
                    {listWords(titles)}
                  </li>
                ))}
            {/* Lo que falta firmar no se pliega (mesa del 9 nov). */}
            {retired
              ? null
              : unsigned.map((row) => (
                  <li key={row.id} className="font-medium">
                    Falta la firma: {row.title}
                  </li>
                ))}
          </ul>
        </Part>
      ) : null}
    </>
  )
}

/**
 * Una atención como unidad clínica (QA de la ficha del 8 nov): cuándo y con
 * quién, el motivo, el diagnóstico con su nombre, lo que se hizo, lo que se
 * indicó y lo que se firmó, cada cosa una vez. Lo anulado de ella, plegado al
 * pie. «Ver todo» trae el detalle firmado sin salir de la historia.
 */
export function EncounterHistoryCard({
  patientId,
  item,
}: {
  patientId: string
  item: TimelineItem
}) {
  const openWide = useOpenWide()
  const [expanded, setExpanded] = useState(false)
  const [showRetired, setShowRetired] = useState(false)
  // Lo que el producto firmó con la atención (odentIA: el odontograma firmado).
  const EncounterSigned = productUi().history.EncounterSigned
  const detail = useQuery({
    queryKey: ["encounter", patientId, item.refId],
    queryFn: () =>
      apiFetch<{ data: EncounterDetail }>(`/api/patients/${patientId}/encounters/${item.refId}`),
    enabled: expanded,
  })
  const regionId = `encounter-detail-${item.refId}`
  const retiredId = `encounter-retired-${item.refId}`
  // Una sola cosa hecha que ya es su título no se repite debajo.
  const procedures = (item.procedures ?? []).filter(
    (procedure, _index, all) => !(all.length === 1 && procedure.toLowerCase() === item.title.toLowerCase()),
  )
  const teeth = item.toothNumbers ?? []
  const diagnoses = item.diagnoses ?? (item.diagnosisCode ? [item.diagnosisCode] : [])
  const documents = item.documents ?? []
  const born = item.born
  // Sin lo nacido (un filtro que no lo trae), lo vinculado sigue diciéndose como antes.
  const planned = born ? [] : (item.plannedItems ?? [])
  const planBudgetId = planned.find((link) => link.budgetId)?.budgetId
  const retired = born ? retiredWords(born) : ""

  return (
    <article
      aria-label={`Atención del ${whenWords(item.createdAt)}: ${item.title}`}
      className="flex flex-col gap-4 elevated rounded-xl border bg-card p-4 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          {/* El motivo lleva a la atención: no hace falta otro botón «Abrir». */}
          <Link
            to="/patients/$patientId/encounters/$encounterId"
            params={{ patientId, encounterId: item.refId }}
            className="font-heading text-base font-medium underline-offset-4 hover:underline focus-visible:underline"
          >
            {item.title}
          </Link>
          {item.status === "borrador" ? (
            // Lo de dentro aún puede cambiar: no se lee como una atención firmada (QA del 9 nov).
            <Badge variant="warning">En curso · sin firmar</Badge>
          ) : item.status && item.status !== "finalizada" ? (
            <Badge variant="outline">{encounterStatusLabel(item.status)}</Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          <time dateTime={item.createdAt}>{whenWords(item.createdAt)}</time>
          {item.professionalName ? ` · ${item.professionalName}` : ""}
          {/* Firmada: lo que se lee es definitivo; si firmó otra persona, se nombra (segunda mesa del 9 nov). */}
          {item.signerName
            ? item.professionalName && item.signerName.includes(item.professionalName.replace(/^(Dra?\.|Dr\.)\s+/, ""))
              ? " · firmada"
              : ` · firmó ${item.signerName}`
            : ""}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {diagnoses.length > 0 ? (
          <Part label={diagnoses.length === 1 ? "Diagnóstico" : "Diagnósticos"}>
            {/* Uno por línea: «· resuelto» es de su diagnóstico, no de todos (verificación de la entrega 9). */}
            {diagnoses.map((diagnosis) => (
              <p key={diagnosis} className="text-sm">
                {diagnosis}
              </p>
            ))}
          </Part>
        ) : null}
        {item.detail ? <p className="whitespace-pre-wrap text-sm">{item.detail}</p> : null}
        {teeth.length > 0 ? (
          <div className="flex flex-wrap gap-1" aria-label="Piezas tratadas">
            {teeth.map((tooth) => (
              <Badge variant="secondary" key={tooth}>
                Pieza {tooth}
              </Badge>
            ))}
          </div>
        ) : null}
        {procedures.length > 0 ? (
          <Part label="Se hizo">
            <ul className="flex flex-col gap-1 text-sm" aria-label="Procedimientos">
              {procedures.map((procedure, index) => (
                <li key={`${procedure}-${index}`}>{procedure}</li>
              ))}
            </ul>
          </Part>
        ) : null}
        {born ? <BornParts born={born} /> : null}
        {planned.length > 0 ? (
          <Part label={productUi().plan.budgetRequired ? "Tratamientos vinculados del presupuesto" : "Tratamientos vinculados"}>
            <ul className="flex flex-col gap-1 text-sm" aria-label="Tratamientos vinculados">
              {planned.map((link) => (
                <li key={link.id}>
                  {link.title}
                  {link.toothNumber != null ? <span className="text-muted-foreground"> · P{link.toothNumber}</span> : null}
                </li>
              ))}
            </ul>
            <div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => openWide?.({ id: "plan", ...(planBudgetId ? { budgetId: planBudgetId } : {}) })}
              >
                {productUi().plan.budgetRequired ? "Ver presupuesto" : "Ver el plan"}
              </Button>
            </div>
          </Part>
        ) : null}
        {documents.length > 0 ? (
          <Part label={`Documentos (${documents.length})`}>
            <ul className="flex flex-col gap-1 text-sm" aria-label="Documentos relacionados">
              {documents.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {doc.label}{" "}
                    <span className="text-muted-foreground">
                      · {documentCategoryLabel(doc.category)}
                      {/* Un papel con fecha propia (la historia que trajo, una radiografía vieja) la dice aquí. */}
                      {doc.capturedAt ? ` · ${formatTakenAt({ ...doc, createdAt: doc.capturedAt })}` : ""}
                    </span>
                  </span>
                  <DocumentOpenButton patientId={patientId} documentId={doc.id} label={doc.label} />
                </li>
              ))}
            </ul>
          </Part>
        ) : null}
        <EncounterSigned patientId={patientId} encounterId={item.refId} />
        {item.periodontal ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              <span className="font-medium">Periodontograma</span>
              <span className="text-muted-foreground">
                {[
                  item.periodontal.classification,
                  item.periodontal.bleedingPercent !== null ? `sangrado ${item.periodontal.bleedingPercent} %` : null,
                  item.periodontal.partial ? "parcial" : null,
                ]
                  .filter(Boolean)
                  .map((part) => ` · ${part}`)
                  .join("")}
              </span>
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              aria-label="Ver el periodontograma"
              onClick={() => {
                if (item.periodontal) openWide?.({ id: "periodontograma", opened: item.periodontal.chartId })
              }}
            >
              Ver
            </Button>
          </div>
        ) : null}
        {item.indications ? (
          <p className="text-sm">
            <span className="font-medium">Indicaciones: </span>
            {item.indications}
          </p>
        ) : null}
        {born && retired ? (
          <div className="flex flex-col gap-2 border-t pt-3">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto justify-start p-0 text-muted-foreground"
              aria-expanded={showRetired}
              aria-controls={retiredId}
              onClick={() => setShowRetired((value) => !value)}
            >
              {showRetired ? "Ocultar lo que ya no vale" : `Ya no vigente: ${retired} · Ver`}
            </Button>
            {showRetired ? (
              <div id={retiredId} className="flex flex-col gap-3 text-muted-foreground">
                <BornParts born={born} retired />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Ver menos" : "Ver todo"}
          </Button>
        </div>
        {expanded ? (
          <div id={regionId} className="border-t pt-3">
            {detail.isPending && <p className="text-sm text-muted-foreground">Cargando detalle…</p>}
            {detail.isError && (
              <p role="alert" className="text-sm text-destructive">
                {detail.error.message}
              </p>
            )}
            {detail.data ? <EncounterDetailView patientId={patientId} detail={detail.data.data} /> : null}
          </div>
        ) : null}
      </div>
    </article>
  )
}

/**
 * Una atención anulada: plegada al final de su día, con su motivo, quién la
 * anuló y cuándo, y lo que se anuló con ella. No se tacha ni va arriba de lo
 * vigente (QA de la ficha del 8 nov).
 */
export function VoidedEncounterLine({ item }: { item: TimelineItem }) {
  const born = item.born
  const withIt = born
    ? listWords([
        ...born.budgets.map((row) => `presupuesto N.º ${row.budgetNumber}`),
        ...born.indicated.map((row) => row.title),
        ...born.followUps.map((row) => row.title),
      ])
    : ""
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-dashed px-4 py-3 text-sm">
      <p>
        <span className="font-medium">{item.title}</span>
        <span className="text-muted-foreground">
          {" "}
          · empezó {whenWords(item.createdAt)}
          {item.professionalName ? ` · ${item.professionalName}` : ""}
        </span>
      </p>
      <p className="text-muted-foreground">
        Anulada{item.voidedAt ? ` el ${whenWords(item.voidedAt)}` : ""}
        {item.voidedByName ? ` por ${item.voidedByName}` : ""} · Motivo: {item.voidReason ?? "sin registrar"}
      </p>
      {withIt ? <p className="text-muted-foreground">Se anuló con ella: {withIt}</p> : null}
      {/* Lo firmado, recetado o pedido en ella no desaparece: un consentimiento firmado o una
          receta que salió siguen siendo hechos (revisión de código del 9 nov). */}
      {born ? (
        <div className="mt-1 flex flex-col gap-2 text-muted-foreground">
          <BornParts born={{ ...born, indicated: [], budgets: [], followUps: [] }} />
        </div>
      ) : null}
    </div>
  )
}
