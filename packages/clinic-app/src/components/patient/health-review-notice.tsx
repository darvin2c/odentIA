import { DECLARED_ONLINE_NOTE } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useId, useRef, useState } from "react"
import { allergyTitle, bySeverity, sinceWords } from "../../lib/allergies"
import { useMemberName, usePermission } from "../../lib/crm"
import { clinicToday } from "../../lib/inventory"
import {
  markAllergiesReviewedApi,
  isHealthReviewPending,
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
 */
export function HealthReviewNotice({
  patientId,
  patientName,
  health,
  disabled = false,
}: {
  patientId: string
  patientName: string
  health: PatientHealth
  disabled?: boolean
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
  // Lo que declaró en su registro en línea y nadie revisó todavía: se pide revisarlo aquí, donde se decide.
  const declared = isHealthReviewPending(health)
    ? [...health.conditions, ...health.medications].filter((row) => row.notes?.startsWith(DECLARED_ONLINE_NOTE)).map((row) => row.name)
    : []
  if (!canWrite || (!allergiesDue && unasked.length === 0 && declared.length === 0)) return null
  const active = health.allergies.filter((allergy) => allergy.isActive).sort(bySeverity)
  const asked = active.length > 0 || health.reviewStatus.allergies === "none"
  const first = patientName.trim().split(/\s+/)[0] ?? patientName
  const topics = [
    allergiesDue ? (asked ? "sus alergias nuevas" : "sus alergias") : null,
    unasked.includes("conditions") ? "sus enfermedades" : null,
    unasked.includes("medications") ? "su medicación" : null,
  ].filter((topic): topic is string => topic !== null)
  const title =
    !allergiesDue && unasked.length === 0
      ? `Revisa con ${first} lo que declaró en línea`
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
        {declared.length > 0 ? (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-sm font-medium">Lo que declaró en línea</h3>
              <p className="text-sm text-muted-foreground">{listWords(declared)}. Confírmalo con {first} en sus antecedentes.</p>
            </div>
            {openWide ? (
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => openWide({ id: "antecedentes", review: true })}>
                Revisar antecedentes
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
