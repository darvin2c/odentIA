import { MEDICATION_CLASSES, type MedicationClass, medicationClassOf } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useId, useRef, useState } from "react"
import { allergyTitle, bySeverity, sinceWords } from "../../lib/allergies"
import { useMemberName, usePermission } from "../../lib/crm"
import { declaredMarkWords, pregnancyWords, saidNoWords } from "../../lib/declared-health"
import { clinicToday } from "../../lib/inventory"
import {
  isCurrentMedication,
  markAllergiesReviewedApi,
  markHealthDeniedApi,
  type PatientHealth,
  unaskedHealthGroups,
} from "../../lib/patients"
import { AllergyFormDrawer } from "./allergies-card"
import { useOpenWide } from "./wide-section"

/** «a, b y c». */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

// A quién se le pregunta cuando la persona tiene representante: la misma regla que dice quién lo dijo.
export { askWhom } from "../../lib/declared-health"

/**
 * «Antes de atenderla» en la atención (QA del 8 nov, A2): un solo aviso con lo
 * que nunca se le preguntó de su salud, una fila por tema y su respuesta a un
 * toque. Alergias: si nunca se revisaron o pasaron 6 meses (tablero 7).
 * Enfermedades y medicación: si siguen «no preguntado» y sin filas vigentes;
 * «Niega enfermedades» y «No toma medicación» lo dejan dicho con quién y
 * cuándo, y lo que sí tiene se escribe en Antecedentes, encima de la atención.
 * La ASA no va aquí: es un juicio del profesional después de saber lo demás
 * (se ve en «Antecedentes y última atención» y al firmar con anestesia).
 * Avisa, nunca frena la firma. Solo para quien escribe en la historia. «No»
 * y «sí tiene» pesan lo mismo: el aviso pide preguntar, no negar a un toque.
 * Lo que dijo la persona y nadie revisó (mesa del 13 nov) va en una fila, por
 * tema y con sus palabras: el embarazo con la semana de hoy, cada alergia con
 * lo que le pasó, sus medicinas y sus enfermedades, y su «No» como «dijo que
 * no». Un embarazo que ya pasó su término pide confirmarlo.
 */
export function HealthReviewNotice({
  patientId,
  patientName,
  health,
  disabled = false,
  askTo = null,
  sex,
}: {
  patientId: string
  patientName: string
  health: PatientHealth
  disabled?: boolean
  /** Con representante, a quién se le pregunta (`askWhom`): «su padre (Luis Ríos)». */
  askTo?: string | null
  /** El sexo registrado del paciente, para decir «ella» o «él»; sin él no se supone. */
  sex?: string | null
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const memberName = useMemberName()
  const openWide = useOpenWide()
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [adding, setAdding] = useState(false)
  const refresh = async () => {
    await Promise.all(
      [
        ["patient-health", patientId],
        ["patient", patientId],
        ["patient-summary", patientId],
        ["encounter-closing", patientId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
    // La fila respondida se va: el foco vuelve al aviso, no se pierde.
    titleRef.current?.focus()
  }
  const reviewed = useMutation({
    mutationFn: () => markAllergiesReviewedApi(patientId),
    onSuccess: async () => {
      await refresh()
      toast.success("Alergias revisadas")
    },
  })
  const denied = useMutation({
    mutationFn: (group: "conditions" | "medications") => markHealthDeniedApi(patientId, [group]),
    onSuccess: async (_result, group) => {
      await refresh()
      toast.success(group === "conditions" ? "Anotado: niega enfermedades" : "Anotado: no toma medicación")
    },
  })
  const allergiesDue = health.allergyReviewDue === true
  const unasked = unaskedHealthGroups(health, clinicToday())
  // Lo que dijo la persona y nadie revisó todavía: qué es lo dice el servidor (`health.declared`), que
  // sabe si lo anotó un clínico o lo declaró ella. Sin ese dato no se pide revisar nada.
  const pending = health.reviewPending === true
  const today = clinicToday()
  const pregnancy = health.pregnancy ?? null
  // Una lista por declaración: cada cosa con quien la dijo y su día, sin juntar lo de dos fechas.
  const saidGroups = (health.declared ?? []).map((group) => {
    const no = saidNoWords(group.by, sex).toLocaleLowerCase("es")
    const rows: Array<{ label: string; value: string }> = []
    if (pregnancy && group.pregnancy) {
      const words = pregnancyWords(pregnancy)
      rows.push({
        label: "Embarazo",
        value: words.confirm
          ? `${words.detail}; pregúntale si sigue embarazada`
          : pregnancy.weeksToday === null
            ? words.detail
            : `${pregnancy.weeksToday} ${pregnancy.weeksToday === 1 ? "semana" : "semanas"} hoy (dijo ${words.detail})`,
      })
    }
    const saidAllergies = health.allergies.filter((row) => group.allergies.includes(row.id))
    if (saidAllergies.length > 0)
      rows.push({
        label: "Alergias",
        value: saidAllergies
          .map((row) => `${allergyTitle(row)} · ${row.reaction?.trim() || "no dijo qué le pasó"}`)
          .join("; "),
      })
    else if (group.saidNo.allergies) rows.push({ label: "Alergias", value: no })
    const saidMedications = health.medications.filter(
      (row) => group.medications.includes(row.id) && isCurrentMedication(row, today),
    )
    // Lo que tiene marca (anticoagulante, huesos) va en su propia fila, como arriba de la ficha.
    for (const key of Object.keys(MEDICATION_CLASSES) as MedicationClass[]) {
      const inClass = saidMedications.filter((row) => medicationClassOf(row.atcCode) === key)
      if (inClass.length > 0)
        rows.push({
          label: key === "anticoagulants" ? "Anticoagulante" : "Medicinas para los huesos",
          value: inClass.map((row) => [row.name, row.dose].filter(Boolean).join(" ")).join(", "),
        })
    }
    const otherMedications = saidMedications.filter((row) => medicationClassOf(row.atcCode) === null)
    if (otherMedications.length > 0)
      rows.push({ label: "Medicinas", value: otherMedications.map((row) => row.name).join(", ") })
    else if (saidMedications.length === 0 && group.saidNo.medications) rows.push({ label: "Medicinas", value: no })
    const saidConditions = health.conditions.filter((row) => group.conditions.includes(row.id) && row.status === "activa")
    if (saidConditions.length > 0)
      rows.push({ label: "Enfermedades", value: saidConditions.map((row) => row.name).join(", ") })
    else if (group.saidNo.conditions) rows.push({ label: "Enfermedades", value: no })
    // Lo del producto, como lo dice el servidor (odentIA: lo de pequeño que contó quien cuida a un niño).
    for (const row of group.interview ?? []) rows.push(row)
    return { title: declaredMarkWords(group.by, group.at, sex), rows }
  })
  const pregnancyPending = (health.declared ?? []).some((group) => group.pregnancy)
  // Un embarazo que ya pasó su término (o quedó sin fecha) y que ya nadie tiene por revisar: se pide confirmarlo.
  const confirmPregnancy = pregnancy?.state === "por_confirmar" && !(pending && pregnancyPending)
  if (!canWrite || (!allergiesDue && unasked.length === 0 && !pending && !confirmPregnancy)) return null
  const active = health.allergies.filter((allergy) => allergy.isActive).sort(bySeverity)
  const asked = active.length > 0 || health.reviewStatus.allergies === "none"
  // Con representante (un niño), se le pregunta a él, como lo dice la ficha; si no, a la persona.
  const patientFirst = patientName.trim().split(/\s+/)[0] ?? patientName
  const first = askTo ?? patientFirst
  const topics = [
    allergiesDue ? (asked ? "sus alergias nuevas" : "sus alergias") : null,
    unasked.includes("conditions") ? "sus enfermedades" : null,
    unasked.includes("medications") ? "su medicación" : null,
  ].filter((topic): topic is string => topic !== null)
  const title =
    !allergiesDue && unasked.length === 0
      ? pending
        ? `Revisa con ${first} lo que dijo de ${askTo ? `la salud de ${patientFirst}` : "su salud"}`
        : `Pregúntale a ${first} si sigue embarazada`
      : unasked.length === 0
      ? asked
        ? `Pregúntale a ${first} si tiene alergias nuevas`
        : `Pregúntale a ${first} si tiene alergias`
      : `Pregúntale a ${first} por ${listWords(topics)}`
  const busy = disabled || reviewed.isPending || denied.isPending
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-4"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-sm font-medium outline-none">
          {title}
        </h2>
        {unasked.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Problemas del corazón, presión alta, diabetes, anticoagulantes o un embarazo cambian la anestesia y lo que
            se receta.
          </p>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-warning/30">
        {allergiesDue ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Alergias</h3>
              <p className="text-sm text-muted-foreground">
                {health.allergiesReviewedAt
                  ? `Última revisión ${sinceWords(health.allergiesReviewedAt)}${health.allergiesReviewedBy ? `, por ${memberName(health.allergiesReviewedBy)}` : ""}.`
                  : "Nadie las revisó todavía con el paciente."}
              </p>
              {active.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {active.map((allergy) => (
                    <li key={allergy.id} className="rounded-full border bg-background px-3 py-1 text-sm">
                      {allergyTitle(allergy)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => reviewed.mutate()}>
                {reviewed.isPending ? "Guardando…" : asked ? "Sin cambios" : "No tiene alergias"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setAdding(true)}>
                <Plus aria-hidden />
                Agregar alergia
              </Button>
            </div>
          </li>
        ) : null}
        {unasked.includes("conditions") ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Enfermedades</h3>
              <p className="text-sm text-muted-foreground">Aún no se le preguntó.</p>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => denied.mutate("conditions")}>
              {denied.isPending && denied.variables === "conditions" ? "Guardando…" : "Niega enfermedades"}
            </Button>
          </li>
        ) : null}
        {unasked.includes("medications") ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Medicación</h3>
              <p className="text-sm text-muted-foreground">Aún no se le preguntó.</p>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => denied.mutate("medications")}>
              {denied.isPending && denied.variables === "medications" ? "Guardando…" : "No toma medicación"}
            </Button>
          </li>
        ) : null}
        {pending ? (
          <li className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-2">
              {saidGroups.filter((group) => group.rows.length > 0).length > 0 ? (
                saidGroups
                  .filter((group) => group.rows.length > 0)
                  .map((group) => (
                    <div key={group.title} className="flex flex-col gap-1">
                      <h3 className="text-sm font-medium">{group.title}</h3>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                        {group.rows.map((row) => (
                          <div key={row.label} className="contents">
                            <dt className="text-muted-foreground">{row.label}</dt>
                            <dd>{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))
              ) : (
                <>
                  <h3 className="text-sm font-medium">Sin revisar</h3>
                  <p className="text-sm text-muted-foreground">Datos de su salud que nadie revisó todavía.</p>
                </>
              )}
              <p className="text-sm text-muted-foreground">Confírmalo con {first} en sus antecedentes.</p>
            </div>
            {openWide ? (
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => openWide({ id: "antecedentes", review: true })}>
                Revisar antecedentes
              </Button>
            ) : null}
          </li>
        ) : null}
        {confirmPregnancy && pregnancy ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Embarazo por confirmar</h3>
              <p className="text-sm text-muted-foreground">
                {pregnancyWords(pregnancy).detail.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))}. Ya pasó
                el tiempo de un embarazo o no tiene fecha: anota en sus antecedentes cómo está hoy.
              </p>
            </div>
            {openWide ? (
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => openWide({ id: "antecedentes", review: true })}>
                Actualizar en antecedentes
              </Button>
            ) : null}
          </li>
        ) : null}
      </ul>
      {unasked.length > 0 && openWide ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* Lo que sí tiene se escribe en Antecedentes, encima de la atención: al cerrar se sigue aquí. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => openWide({ id: "antecedentes", review: true })}
          >
            Registrar enfermedades o medicación
          </Button>
        </div>
      ) : null}
      {reviewed.error || denied.error ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(reviewed.error ?? denied.error)}
        </p>
      ) : null}
      <AllergyFormDrawer patientId={patientId} patientName={patientName} open={adding} onClose={() => setAdding(false)} />
    </section>
  )
}
