import { formatMoney } from "@odentia/clinical"
import { Button, Checkbox, Skeleton } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { formatDate } from "../../lib/clinical-journey"
import { useMyRole, useMyUserId, usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { productUi } from "../../product/product-ui"

const MAX_LENGTH = 2000

const reasonSchema = z.object({
  reason: z.string().trim().min(1, "Escribe por qué no se hizo.").max(MAX_LENGTH, `Escribe como mucho ${MAX_LENGTH} caracteres.`),
  keepInPlan: z.boolean(),
})

/** Lo que pasará al marcar «No se hizo» (`getNotDonePreview`). */
interface NotDonePreview {
  procedure: { id: string; description: string; site: string | null }
  planItem: { title: string; becomes: "pendiente" | "en_curso" | "cancelado"; direct: boolean } | null
  diagnoses: string[]
  materials: Array<{ productId: string; name: string; quantity: number; quantityText: string }>
  dictatedMaterials: boolean
  charges: Array<{
    id: string
    description: string
    /** Sin caja (`finance.read`) llegan sin monto. */
    amountCents: number | null
    paidCents: number | null
    currency: string
    outcome: "anula" | "caja" | "sigue"
  }>
  bookedControls: Array<{ title: string; dueAt: string }>
  prescription: boolean
}

/** Quien firmó o atendió, o quien es dueño o administra: los mismos que deja pasar el servidor. */
export function useCanMarkNotDone(encounter: { finalizedBy: string | null; professionalUserId: string }): boolean {
  const canWrite = usePermission("clinical.write")
  const me = useMyUserId()
  const role = useMyRole()
  return canWrite && (encounter.finalizedBy === me || encounter.professionalUserId === me || role === "owner" || role === "admin")
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

/** «Al confirmar»: cada consecuencia en una línea, en palabras de quien atiende. */
function consequences(preview: NotDonePreview, keepInPlan: boolean): string[] {
  const locale = activeOrgLocale() ?? "es-PE"
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale)
  const lines: string[] = []
  const item = preview.planItem
  if (item)
    lines.push(
      item.becomes === "cancelado"
        ? `${item.title} sale del plan: era la consulta de ese día.`
        : item.direct && !keepInPlan
          ? `${item.title} sale del plan.`
          : item.direct
            ? `${item.title} queda indicado en el plan, por decidir.`
            : `${item.title} vuelve a ${item.becomes === "en_curso" ? "en curso" : "pendiente"} en el plan.`,
    )
  if (preview.diagnoses.length > 0)
    lines.push(`${listWords(preview.diagnoses)} ${preview.diagnoses.length > 1 ? "vuelven" : "vuelve"} a activo.`)
  if (productUi().site && item && item.becomes !== "cancelado") lines.push("El odontograma deja de dibujarlo.")
  if (preview.materials.length > 0)
    lines.push(`Vuelven al almacén los materiales de su servicio: ${listWords(preview.materials.map((item) => `${item.name} (${item.quantity})`))}.`)
  if (preview.dictatedMaterials)
    lines.push("Hubo material dicho a mano: no se devuelve solo; corrígelo en «Materiales usados».")
  for (const charge of preview.charges) {
    if (charge.outcome === "anula")
      lines.push(
        charge.amountCents != null
          ? `Su cobro de ${money(charge.amountCents, charge.currency)} no está pagado: se anula.`
          : "Su cobro no está pagado: se anula.",
      )
    if (charge.outcome === "caja")
      lines.push(
        charge.paidCents != null
          ? `Ya lo pagó (${money(charge.paidCents, charge.currency)}): caja recibe la tarea de devolverlo o dejarlo a favor.`
          : "Ya tiene un pago: caja recibe la tarea de devolverlo o dejarlo a favor.",
      )
    if (charge.outcome === "sigue") lines.push("Su cobro sigue: el tratamiento continúa con otra sesión.")
  }
  for (const control of preview.bookedControls)
    lines.push(`Su control del ${formatDate(control.dueAt)} sigue en la agenda: muévelo si ya no va.`)
  if (preview.prescription) lines.push("La receta de esta atención sigue vigente: anúlala en Documentos si ya no va.")
  return lines
}

/**
 * «No se hizo…» de un procedimiento de una atención firmada (mesa del cierre, 19 nov 2026): lo
 * firmado no se borra, queda tachado con el motivo; el cajón dice antes qué vuelve atrás.
 */
export function NotDoneButton({
  patientId,
  encounterId,
  procedure,
}: {
  patientId: string
  encounterId: string
  procedure: { id: string; description: string; place: string | null }
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const base = `/api/patients/${patientId}/encounters/${encounterId}/procedures/${procedure.id}/not-done`
  const preview = useQuery({
    queryKey: ["not-done", patientId, encounterId, procedure.id],
    queryFn: () => apiFetch<{ data: NotDonePreview }>(base).then((r) => r.data),
    enabled: open,
    staleTime: 0,
  })
  const save = useMutation({
    mutationFn: (body: { reason: string; keepInPlan: boolean }) =>
      apiFetch(base, { method: "POST", body: JSON.stringify(body) }),
  })
  const form = useAppForm({
    defaultValues: { reason: "", keepInPlan: true },
    validators: { onSubmit: reasonSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({ reason: value.reason.trim(), keepInPlan: value.keepInPlan })
      form.reset({ reason: "", keepInPlan: true })
      setOpen(false)
      // Cambia mucho de la persona (la atención, la historia, el plan, el odontograma, la cuenta y
      // el inventario): se vuelve a leer todo lo suyo.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(patientId) || query.queryKey.includes(encounterId),
      })
    },
  })
  const surface = useFormSurface(form)
  const label = [procedure.description, procedure.place].filter(Boolean).join(" · ")
  const keepInPlan = useStore(form.store, (state) => state.values.keepInPlan)
  const lines = preview.data ? consequences(preview.data, keepInPlan) : []

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={`No se hizo: ${label}`}
        onClick={() => {
          form.reset({ reason: "", keepInPlan: true })
          setOpen(true)
        }}
      >
        No se hizo…
      </Button>
      <FormDrawer
        {...surface}
        open={open}
        onClose={() => {
          if (surface.isSubmitting) return
          form.reset({ reason: "", keepInPlan: true })
          setOpen(false)
        }}
        title={`No se hizo: ${label}`}
        description="Lo firmado no se borra: queda tachado, con tu motivo, quién y cuándo."
        submitLabel={surface.isSubmitting ? "Guardando…" : "Confirmar: no se hizo"}
      >
        <form.AppField name="reason">
          {(field) => (
            <field.TextareaField
              label="Por qué"
              maxLength={MAX_LENGTH}
              rows={3}
              disabled={surface.isSubmitting}
              placeholder="Lo registré en la pieza equivocada: solo hice la 15."
            />
          )}
        </form.AppField>
        {preview.data?.planItem?.direct && preview.data.planItem.becomes !== "cancelado" ? (
          // Lo hecho directo: si había algo que tratar (la caries de la 24), queda indicado; si todo
          // fue un error, se quita (QA antes de entregar, 19 nov).
          <form.AppField name="keepInPlan">
            {(field) => (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={field.state.value}
                  disabled={surface.isSubmitting}
                  onCheckedChange={(checked) => field.handleChange(checked === true)}
                />
                <span>
                  Dejarlo indicado en el plan, por decidir
                  <span className="block text-xs text-muted-foreground">
                    Desmárcalo si no había nada que tratar: sale del plan.
                  </span>
                </span>
              </label>
            )}
          </form.AppField>
        ) : null}
        <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 text-sm">
          <p className="font-medium">Al confirmar</p>
          {preview.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : preview.isError ? (
            <p role="alert" className="text-destructive">
              No se pudo leer lo que pasará. Cierra y vuelve a abrir.
            </p>
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
              {lines.length > 0 ? lines.map((line) => <li key={line}>{line}</li>) : <li>Queda tachado en esta atención.</li>}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">Si lo hiciste en otra pieza, regístralo en una atención nueva.</p>
        </div>
      </FormDrawer>
    </>
  )
}
