import { Button, FieldGroup, toast } from "@odentia/ui"
import { submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { type ConsentDocument, setConsentPersonalRisks } from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"
import type { PatientFull } from "../../lib/patients"

/** ¿Se pueden cambiar todavía? Pendiente, sin firmar en su enlace y sin enviar: lo que lee no cambia. */
export function personalRisksEditable(
  document: Pick<ConsentDocument, "status" | "personSignedAt" | "linkSentAt" | "sectionsSnapshot">,
): boolean {
  return (
    document.status === "pendiente" &&
    !document.personSignedAt &&
    !document.linkSentAt &&
    !!document.sectionsSnapshot
  )
}

/**
 * La ayuda del campo: «Lo propone el sistema» solo si el sistema los propuso y nadie los cambió (el
 * documento sigue como nació); sin riesgos, una ayuda neutra para escribirlos.
 */
export function personalRisksHelp(
  document: Pick<ConsentDocument, "sectionsSnapshot" | "createdAt" | "updatedAt">,
): string {
  const saved = document.sectionsSnapshot?.personalRisks ?? []
  if (saved.length === 0) return "Escribe los riesgos propios de su caso, una frase por línea."
  if (document.updatedAt === document.createdAt)
    return "Lo propone el sistema según sus antecedentes. Cámbialo o bórralo. Una frase por línea."
  return "Cámbialo o bórralo. Una frase por línea."
}

/**
 * Los riesgos propios de su caso (reglas clínicas del 18 nov): el sistema los propone al generar el
 * consentimiento desde sus antecedentes y el procedimiento; aquí se cambian o se borran, una frase
 * por línea, mientras está pendiente y no se envió a su enlace. Vacío, la hoja queda como siempre.
 * No frena la firma.
 */
export function ConsentPersonalRisksField({
  document,
  onSaved,
}: {
  document: ConsentDocument
  onSaved: () => void | Promise<void>
}) {
  const canPatients = usePermission("patients.read")
  const patientQuery = useQuery({
    queryKey: ["patient", document.patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${document.patientId}`),
    enabled: canPatients,
  })
  const person = patientQuery.data?.data.patient
  const first = (person?.givenNames ?? person?.displayName ?? "").trim().split(/\s+/)[0] ?? ""
  const saved = (document.sectionsSnapshot?.personalRisks ?? []).join("\n")
  const form = useAppForm({
    defaultValues: { personalRisks: saved },
    validators: {
      onSubmit: z.object({
        personalRisks: z.string().max(6000, "Escribe como mucho 6000 caracteres."),
      }),
    },
    onSubmit: async ({ value }) => {
      const text = value.personalRisks.trim()
      await setConsentPersonalRisks(document.id, text || null)
      toast.success(text ? "Riesgos propios guardados" : "Riesgos propios quitados de la hoja")
      await onSaved()
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const changed = useStore(form.store, (state) => state.values.personalRisks.trim() !== saved)
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submitForm(form)
      }}
    >
      <FieldGroup className="gap-2">
        <form.AppField name="personalRisks">
          {(field) => (
            <field.TextareaField
              label={
                first
                  ? `Riesgos propios de ${first} (opcional)`
                  : "Riesgos propios de su caso (opcional)"
              }
              description={personalRisksHelp(document)}
              rows={3}
              maxLength={6000}
              disabled={pending}
            />
          )}
        </form.AppField>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" size="sm" variant="outline" disabled={pending || !changed}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}
