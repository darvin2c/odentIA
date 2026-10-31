import { CONSENT_DECLARATION, CONSENT_SECTION_LABELS } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  toast,
} from "@odentia/ui"
import {
  applySubmitError,
  FormChoiceField,
  FormDrawer,
  focusFirstInvalid,
  LoadingState,
  submitErrorOf,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import {
  CONSENT_SIGNATURE_WORDS,
  type ConsentDocument,
  generateConsentPdf,
  signConsent,
} from "../../lib/clinical-forms"
import { fetchResponsibilities } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { uploadPatientFile } from "../../lib/encounter-documents"
import { fetchMyProfessionalProfile, registrationLabel } from "../../lib/encounters"
import type { PatientFull } from "../../lib/patients"
import { FirmaPad } from "./firma-pad"

export interface SignerChoice {
  kind: "paciente" | "representante"
  contactId: string
  name: string
  label: string
}

/** Quién puede firmar o revocar: la propia persona (mayor de edad) o su representante legal vigente. */
export function useSignerChoices(patientId: string) {
  const canPatients = usePermission("patients.read")
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canPatients,
  })
  const responsibilitiesQuery = useQuery({
    queryKey: ["responsibilities", patientId],
    queryFn: () => fetchResponsibilities(patientId),
    enabled: canPatients,
  })
  const detail = patientQuery.data?.data
  const own = detail?.contacts.find((link) => link.relationship === "self")
  // Menor de edad según el servidor (el día de la clínica), no la hora de este equipo.
  const isMinor = detail?.isMinor ?? false
  const representatives = (responsibilitiesQuery.data?.data ?? []).filter(
    (row) => row.isCurrent && row.kind === "representante_legal",
  )
  const choices: SignerChoice[] = [
    ...(own && !isMinor
      ? [
          {
            kind: "paciente" as const,
            contactId: own.contactId,
            name: own.displayName,
            label: `${own.displayName} · paciente`,
          },
        ]
      : []),
    ...representatives.map(
      (row): SignerChoice => ({
        kind: "representante",
        contactId: row.contact.id,
        name: row.contact.displayName,
        label: `${row.contact.displayName} · representante legal`,
      }),
    ),
  ]
  return {
    choices,
    isMinor,
    loading: patientQuery.isPending || responsibilitiesQuery.isPending,
  }
}

/** Primer nombre de quien firma, como lo dice la pantalla: «Firma de Lucía». */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/** «Firmas como Ana Torres · Cirujano dentista · COP 12345», de su perfil profesional. */
export function useSignAs(): { text: string | null; loading: boolean } {
  const profile = useQuery({ queryKey: ["professional-profile", "me"], queryFn: fetchMyProfessionalProfile })
  const data = profile.data?.data
  if (!data) return { text: null, loading: profile.isPending }
  const parts = [data.signatureName ?? data.accountName, data.professionalTitle, registrationLabel(data)].filter(Boolean)
  return { text: parts.join(" · "), loading: false }
}

/**
 * Firma en la unidad dental (decisión 3): una pantalla completa para pasarle la tablet a
 * la persona, con letra grande, la casilla de comprensión y su firma con el
 * dedo; si son varios consentimientos van seguidos, sin volver a empezar. Al
 * terminar, el profesional confirma con su perfil, sin dibujar otra firma, y
 * recién entonces se guardan.
 */
export function ConsentSigningScreen({
  open,
  documents,
  patientId,
  onClose,
  onSigned,
}: {
  open: boolean
  /** Pendientes a firmar en una sola pasada. */
  documents: ConsentDocument[]
  patientId: string
  onClose: () => void
  onSigned: () => Promise<void> | void
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <SigningFlow
      key={documents.map((d) => d.id).join(",")}
      documents={documents}
      patientId={patientId}
      onClose={onClose}
      onSigned={onSigned}
    />
  )
}

type Step = { kind: "sign"; index: number } | { kind: "confirm" }

interface SigningValues {
  signerContactId: string
  /** Por documento, en el orden de la pasada: la casilla y el trazo. */
  docs: { understood: boolean; strokes: number[][][] }[]
}

function SigningFlow({
  documents,
  patientId,
  onClose,
  onSigned,
}: {
  documents: ConsentDocument[]
  patientId: string
  onClose: () => void
  onSigned: () => Promise<void> | void
}) {
  const ids = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()
  const { choices, isMinor, loading } = useSignerChoices(patientId)
  const [step, setStep] = useState<Step>({ kind: "sign", index: 0 })
  // Con más de una persona habilitada, primero se elige quién firma.
  const [whoChosen, setWhoChosen] = useState(false)
  const choosing = choices.length > 1 && !whoChosen
  const [signed, setSigned] = useState<Set<string>>(new Set())
  // El rechazo del servidor espera a que su paso esté en pantalla para decirse junto a su campo.
  const [rejected, setRejected] = useState<{ error: unknown; index: number; done: number } | null>(null)
  const signAs = useSignAs()
  const total = documents.length
  const current = step.kind === "sign" && !choosing ? documents[step.index] : undefined
  const defaultValues: SigningValues = {
    signerContactId: "",
    docs: documents.map(() => ({ understood: false, strokes: [] })),
  }

  const finish = async (value: SigningValues, signer: SignerChoice): Promise<void> => {
    const done = new Set(signed)
    let index = 0
    try {
      for (const [position, document] of documents.entries()) {
        if (done.has(document.id)) continue
        index = position
        const result = await signConsent(document.id, {
          signerKind: signer.kind,
          signerContactId: signer.contactId,
          representativeRelation: signer.kind === "representante" ? "Representante legal" : null,
          signatureData: { strokes: value.docs[position]?.strokes ?? [] },
          comprehensionConfirmed: true,
          method: "clinica",
        })
        done.add(document.id)
        setSigned(new Set(done))
        // El PDF queda en Documentos; si falla, la firma ya está y se genera después.
        if (!result.data.pdfDocumentId) await generateConsentPdf(document.id).catch(() => null)
      }
    } catch (error) {
      // Lo que se corrige en un paso anterior vuelve a ese paso: quién firma, o la casilla y la firma del documento.
      const fields = submitErrorOf(error).fields
      if (("signerContactId" in fields || "signerDoc" in fields) && choices.length > 1) {
        // Otra persona firma: casilla y firma de lo que falta, otra vez.
        const first = documents.findIndex((document) => !done.has(document.id))
        documents.forEach((document, position) => {
          if (done.has(document.id)) return
          form.setFieldValue(`docs[${position}].understood`, false, { dontUpdateMeta: true, dontValidate: true })
          form.setFieldValue(`docs[${position}].strokes`, [], { dontUpdateMeta: true, dontValidate: true })
        })
        setStep({ kind: "sign", index: Math.max(first, 0) })
        setWhoChosen(false)
      } else if ("signatureData" in fields || "comprehensionConfirmed" in fields) {
        setStep({ kind: "sign", index })
      }
      setRejected({ error, index, done: done.size })
      return
    }
    await Promise.all(
      [["consents", patientId], ["consent-needs", patientId], ["patient-documents", patientId]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
    toast.success(total === 1 ? "Consentimiento firmado" : `${total} consentimientos firmados`)
    await onSigned()
    onClose()
  }

  const form = useAppForm({
    defaultValues,
    validators: {
      // Cada paso pide lo suyo: quién firma, o la casilla y la firma del documento a la vista.
      onSubmit: ({ value }) => {
        if (choosing) return value.signerContactId ? undefined : { fields: { signerContactId: "Elige quién firma" } }
        if (step.kind !== "sign") return undefined
        const doc = value.docs[step.index]
        const fields: Record<string, string> = {}
        if (!doc?.understood) fields[`docs[${step.index}].understood`] = "Marca la casilla para seguir"
        if (!doc?.strokes.length)
          fields[`docs[${step.index}].strokes`] = `Falta la firma de ${firstName(signer?.name ?? "la persona")}`
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (choosing) setWhoChosen(true)
      else if (step.kind === "sign")
        setStep(step.index < total - 1 ? { kind: "sign", index: step.index + 1 } : { kind: "confirm" })
      else if (signer) await finish(value, signer)
    },
  })
  const signerContactId = useStore(form.store, (state) => state.values.signerContactId)
  const signer: SignerChoice | null = choices.find((c) => c.contactId === signerContactId) ?? choices[0] ?? null
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const error = useFormSubmitError(form)

  // Quien firma por defecto es el primero habilitado, cuando se sabe (no cambia lo ya elegido).
  const firstChoice = choices[0]?.contactId
  useEffect(() => {
    if (firstChoice && !form.getFieldValue("signerContactId"))
      form.setFieldValue("signerContactId", firstChoice, { dontUpdateMeta: true })
  }, [firstChoice, form])

  // El recuadro de firma aparece en blanco cada vez que se muestra: el trazo guardado también.
  const shownIndex = current && step.kind === "sign" ? step.index : null
  useEffect(() => {
    if (typeof shownIndex === "number")
      form.setFieldValue(`docs[${shownIndex}].strokes`, [], { dontUpdateMeta: true, dontValidate: true })
  }, [shownIndex, form])

  useEffect(() => {
    if (!rejected) return
    applySubmitError(form, rejected.error, {
      fieldMap: (key) =>
        key === "signatureData"
          ? `docs[${rejected.index}].strokes`
          : key === "comprehensionConfirmed"
            ? `docs[${rejected.index}].understood`
            : key === "signerDoc"
              ? "signerContactId"
              : undefined,
      formMessage: (failure) => {
        const message = submitErrorOf(failure).form
        return message && rejected.done > 0
          ? `${message}. Quedaron firmados ${rejected.done} de ${total}; vuelve a confirmar para el resto.`
          : null
      },
    })
    focusFirstInvalid(rootRef.current)
    setRejected(null)
  }, [rejected, form, total])

  const advance = () => void submitForm(form, { root: rootRef.current })
  // «Volver»: al paso anterior; desde la primera firma, a elegir quién firma.
  const back =
    step.kind === "confirm"
      ? () => setStep({ kind: "sign", index: total - 1 })
      : step.index > 0
        ? () => setStep({ kind: "sign", index: step.index - 1 })
        : choices.length > 1
          ? () => setWhoChosen(false)
          : null

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !saving) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!saving}
        aria-describedby={`${ids}-desc`}
        scrollable
        contentClassName="flex min-h-full flex-col gap-0 p-0"
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4 pr-16">
          <DialogTitle className="text-lg">
            {step.kind === "confirm"
              ? "Confirma que informaste"
              : signer
                ? `Firma de ${firstName(signer.name)}`
                : "Firma del consentimiento"}
          </DialogTitle>
          {step.kind === "sign" && !choosing ? (
            <span className="rounded-full bg-muted px-3 py-1 text-sm font-medium">
              {step.index + 1} de {total}
            </span>
          ) : null}
        </header>
        <DialogDescription id={`${ids}-desc`} className="sr-only">
          Pantalla completa para que la persona lea y firme con el dedo; al final confirma el profesional.
        </DialogDescription>

        <div ref={rootRef} className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-6 text-lg">
          {loading ? (
            <LoadingState message="Buscando quién puede firmar…" />
          ) : !signer ? (
            <p role="alert" className="rounded-md bg-warning-soft p-4 text-base">
              {isMinor
                ? "Es menor de edad y no tiene representante legal vigente. Regístralo en Datos para que pueda firmar por él, o fírmalo en papel."
                : "No hay una persona habilitada para firmar. Revisa sus vínculos en Datos."}
            </p>
          ) : choosing ? (
            <form.AppField name="signerContactId">
              {(field) => (
                <field.SelectField
                  label="¿Quién firma?"
                  triggerClassName="text-base"
                  options={choices.map((c) => ({ value: c.contactId, label: c.label }))}
                  description={
                    isMinor
                      ? "Es menor de edad: firma su representante legal vigente."
                      : "Firma la propia persona o su representante legal vigente."
                  }
                />
              )}
            </form.AppField>
          ) : current && step.kind === "sign" ? (
            <article className="flex flex-col gap-5">
              <h2 className="text-2xl font-semibold">{current.titleSnapshot}</h2>
              {current.procedureRef ? <p className="text-muted-foreground">{current.procedureRef}</p> : null}
              {current.sectionsSnapshot ? (
                <>
                  <BigBlock title={CONSENT_SECTION_LABELS.procedure}>
                    <p>{current.sectionsSnapshot.procedure}</p>
                  </BigBlock>
                  <BigBlock title={CONSENT_SECTION_LABELS.benefits}>
                    <BigList items={current.sectionsSnapshot.benefits} />
                  </BigBlock>
                  <BigBlock title={CONSENT_SECTION_LABELS.risks}>
                    <BigList items={current.sectionsSnapshot.risks} />
                  </BigBlock>
                  <BigBlock title={CONSENT_SECTION_LABELS.alternatives}>
                    <BigList items={current.sectionsSnapshot.alternatives} />
                  </BigBlock>
                  <BigBlock title={CONSENT_SECTION_LABELS.consequences}>
                    <p>{current.sectionsSnapshot.consequences}</p>
                  </BigBlock>
                </>
              ) : (
                <p className="whitespace-pre-wrap">{current.bodySnapshot}</p>
              )}
              <form.AppField key={`${current.id}-understood`} name={`docs[${step.index}].understood`}>
                {(field) => (
                  <FormChoiceField
                    className="rounded-lg border p-4"
                    label={<strong className="text-lg">Entendí lo que me explicaron y acepto</strong>}
                    description={CONSENT_DECLARATION}
                  >
                    {(control) => (
                      <Checkbox
                        className="mt-1 size-6"
                        id={control.id}
                        name={control.name}
                        checked={field.state.value === true}
                        aria-invalid={control.invalid || undefined}
                        aria-describedby={control.describedBy}
                        onCheckedChange={(value) => {
                          field.handleChange(value === true)
                          field.handleBlur()
                        }}
                      />
                    )}
                  </FormChoiceField>
                )}
              </form.AppField>
              <form.AppField key={`${current.id}-strokes`} name={`docs[${step.index}].strokes`}>
                {(field) => (
                  <field.Group legend="Firma aquí con el dedo">
                    {(control) => (
                      <FirmaPad
                        key={current.id}
                        label={`Firma de ${signer.name}`}
                        id={control.id}
                        invalid={control.invalid}
                        describedBy={control.describedBy}
                        onChange={(value) => {
                          field.handleChange(value)
                          field.handleBlur()
                        }}
                      />
                    )}
                  </field.Group>
                )}
              </form.AppField>
            </article>
          ) : step.kind === "confirm" ? (
            <div className="flex flex-col gap-4">
              <p>
                <strong>Informé a {firstName(signer.name)} y resolví sus dudas.</strong>
              </p>
              <p className="text-base text-muted-foreground">
                {signAs.text
                  ? `Firmas como ${signAs.text} · de tu perfil, sin dibujar otra firma.`
                  : signAs.loading
                    ? "Buscando tu perfil profesional…"
                    : "Registra tu colegiatura en tu perfil profesional para firmar."}
              </p>
              <ul className="flex flex-col gap-1 text-base">
                {documents.map((document) => (
                  <li key={document.id}>
                    {signed.has(document.id) ? "✓ " : ""}
                    {document.titleSnapshot}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <footer className="sticky bottom-0 flex flex-col gap-2 border-t bg-popover px-6 py-4">
          {error ? (
            <p role="alert" className="text-base text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">{CONSENT_SIGNATURE_WORDS.clinica}</span>
            {!signer ? (
              <Button type="button" variant="outline" onClick={onClose}>
                Cerrar
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                {!choosing && back ? (
                  <Button type="button" size="lg" variant="outline" disabled={saving} onClick={back}>
                    Volver
                  </Button>
                ) : null}
                {choosing ? (
                  <Button type="button" size="lg" onClick={advance}>
                    Empezar
                  </Button>
                ) : step.kind === "sign" ? (
                  <Button type="button" size="lg" onClick={advance}>
                    {step.index < total - 1 ? "Siguiente" : "Listo"}
                  </Button>
                ) : (
                  <Button type="button" size="lg" disabled={saving || !signAs.text} onClick={advance}>
                    {saving ? "Guardando…" : "Confirmar"}
                  </Button>
                )}
              </div>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function BigBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-base font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function BigList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-6">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

interface PaperSignValues {
  signerContactId: string
  file: File | null
  informed: boolean
}

const paperSignSchema = z.object({
  signerContactId: z.string().min(1, "Elige quién firmó la hoja"),
  file: z.custom<File | null>().refine((file) => file !== null, "Sube la foto de la hoja firmada"),
  informed: z.boolean().refine((value) => value, "Confirma que informaste y resolviste sus dudas"),
})

/**
 * «Firmado en papel»: se sube la foto de la hoja firmada y el pendiente se
 * cierra con método papel. El profesional confirma con su perfil.
 */
export function PaperSignDrawer({
  open,
  document,
  patientId,
  encounterId,
  onClose,
  onSigned,
}: {
  open: boolean
  document: ConsentDocument | null
  patientId: string
  encounterId?: string | null
  onClose: () => void
  onSigned: () => Promise<void> | void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const { choices, isMinor, loading } = useSignerChoices(patientId)
  const signAs = useSignAs()
  // La foto ya subida no se sube otra vez si lo que falla es la firma.
  const uploaded = useRef<{ file: File; id: string } | null>(null)
  const firstChoice = choices[0]?.contactId ?? ""
  const defaultValues: PaperSignValues = { signerContactId: "", file: null, informed: false }
  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: paperSignSchema },
    onSubmit: async ({ value }) => {
      if (!document || !value.file) return
      let paperDocumentId = uploaded.current?.file === value.file ? uploaded.current.id : null
      if (!paperDocumentId) {
        const sheet = await uploadPatientFile(patientId, value.file, {
          category: "consentimiento",
          label: `Hoja firmada: ${document.titleSnapshot}`,
          encounterId: encounterId ?? null,
        })
        uploaded.current = { file: value.file, id: sheet.id }
        paperDocumentId = sheet.id
      }
      const signer = choices.find((c) => c.contactId === value.signerContactId)
      await signConsent(document.id, {
        signerKind: signer?.kind ?? "paciente",
        signerContactId: value.signerContactId,
        representativeRelation: signer?.kind === "representante" ? "Representante legal" : null,
        comprehensionConfirmed: true,
        method: "papel",
        paperDocumentId,
      })
      await generateConsentPdf(document.id).catch(() => null)
      await Promise.all(
        [["consents", patientId], ["consent-needs", patientId], ["patient-documents", patientId]].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      )
      toast.success("Firma en papel guardada")
      form.reset({ ...defaultValues, signerContactId: firstChoice })
      await onSigned()
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { paperDocumentId: "file", comprehensionConfirmed: "informed", signerDoc: "signerContactId" },
  })
  const signerContactId = useStore(form.store, (state) => state.values.signerContactId)
  const signer = choices.find((c) => c.contactId === signerContactId) ?? choices[0] ?? null

  // Quien firmó por defecto es el primero habilitado, cuando se sabe (no cambia lo ya elegido).
  useEffect(() => {
    if (firstChoice && !form.getFieldValue("signerContactId"))
      form.setFieldValue("signerContactId", firstChoice, { dontUpdateMeta: true })
  }, [firstChoice, form])

  const close = () => {
    if (surface.isSubmitting) return
    form.reset({ ...defaultValues, signerContactId: firstChoice })
    onClose()
  }
  return (
    <FormDrawer
      {...surface}
      open={open}
      dock={false}
      onClose={close}
      title="Firmado en papel"
      description={document ? `${document.titleSnapshot}: sube la foto de la hoja firmada y el pendiente se cierra.` : undefined}
      submitLabel="Guardar firma en papel"
      // Sin nadie habilitado para firmar no hay qué guardar; el aviso dice por qué.
      submitDisabled={!signer}
    >
      {loading ? (
        <LoadingState message="Buscando quién puede firmar…" />
      ) : !signer ? (
        <p role="alert" className="rounded-md bg-warning-soft p-3 text-sm">
          {isMinor
            ? "Es menor de edad y no tiene representante legal vigente: regístralo en Datos."
            : "No hay una persona habilitada para firmar: revisa sus vínculos en Datos."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <form.AppField name="signerContactId">
            {(field) => (
              <field.SelectField
                label="Quién firmó la hoja"
                options={choices.map((c) => ({ value: c.contactId, label: c.label }))}
              />
            )}
          </form.AppField>
          <form.AppField name="file">
            {(field) => (
              <field.Control label="Foto de la hoja firmada" description="Queda en Documentos como consentimiento.">
                {(control) => (
                  <Input
                    {...control.props}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    capture="environment"
                    onChange={(event) => field.handleChange(event.target.files?.[0] ?? null)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="informed">
            {(field) => (
              <field.CheckboxField
                label={`Informé a ${firstName(signer.name)} y resolví sus dudas.`}
                description={signAs.text ? `Firmas como ${signAs.text}` : "Firmas con tu perfil profesional"}
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">{CONSENT_SIGNATURE_WORDS.papel}</p>
        </div>
      )}
    </FormDrawer>
  )
}
