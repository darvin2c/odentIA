import { CONSENT_DECLARATION, CONSENT_SECTION_LABELS } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import { FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
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

const errorMessage = (e: unknown, fallback: string) =>
  e instanceof ApiError ? (e.shape.message ?? fallback) : e instanceof Error ? e.message : fallback

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
  const queryClient = useQueryClient()
  const { choices, isMinor, loading } = useSignerChoices(patientId)
  const [choiceId, setChoiceId] = useState("")
  const signer: SignerChoice | null = choices.find((c) => c.contactId === choiceId) ?? choices[0] ?? null
  const [step, setStep] = useState<Step>({ kind: "sign", index: 0 })
  // Con más de una persona habilitada, primero se elige quién firma.
  const [whoChosen, setWhoChosen] = useState(false)
  const choosing = choices.length > 1 && !whoChosen
  const [understood, setUnderstood] = useState<Record<string, boolean>>({})
  const [strokes, setStrokes] = useState<Record<string, number[][][]>>({})
  const [signed, setSigned] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signAs = useSignAs()
  const total = documents.length
  const current = step.kind === "sign" && !choosing ? documents[step.index] : undefined

  const finish = async () => {
    if (!signer || saving) return
    setSaving(true)
    setError(null)
    const done = new Set(signed)
    try {
      for (const document of documents) {
        if (done.has(document.id)) continue
        const result = await signConsent(document.id, {
          signerKind: signer.kind,
          signerContactId: signer.contactId,
          representativeRelation: signer.kind === "representante" ? "Representante legal" : null,
          signatureData: { strokes: strokes[document.id] ?? [] },
          comprehensionConfirmed: true,
          method: "clinica",
        })
        done.add(document.id)
        setSigned(new Set(done))
        // El PDF queda en Documentos; si falla, la firma ya está y se genera después.
        if (!result.data.pdfDocumentId) await generateConsentPdf(document.id).catch(() => null)
      }
      await Promise.all(
        [["consents", patientId], ["consent-needs", patientId], ["patient-documents", patientId]].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      )
      toast.success(total === 1 ? "Consentimiento firmado" : `${total} consentimientos firmados`)
      await onSigned()
      onClose()
    } catch (e) {
      setError(
        `${errorMessage(e, "No se pudo guardar la firma")}${
          done.size > 0 ? `. Quedaron firmados ${done.size} de ${total}; vuelve a confirmar para el resto.` : ""
        }`,
      )
    } finally {
      setSaving(false)
    }
  }

  const next = () => {
    if (!current) return
    if (!understood[current.id]) {
      setError("Marca la casilla para seguir")
      return
    }
    if ((strokes[current.id] ?? []).length === 0) {
      setError(`Falta la firma de ${firstName(signer?.name ?? "la persona")}`)
      return
    }
    setError(null)
    if (step.kind === "sign" && step.index < total - 1) setStep({ kind: "sign", index: step.index + 1 })
    else setStep({ kind: "confirm" })
  }

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
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none p-0 sm:max-w-none"
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

        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-6 text-lg">
          {loading ? (
            <LoadingState message="Buscando quién puede firmar…" />
          ) : !signer ? (
            <p role="alert" className="rounded-md bg-warning-soft p-4 text-base">
              {isMinor
                ? "Es menor de edad y no tiene representante legal vigente. Regístralo en Datos para que pueda firmar por él, o fírmalo en papel."
                : "No hay una persona habilitada para firmar. Revisa sus vínculos en Datos."}
            </p>
          ) : choosing ? (
            <Field>
              <FieldLabel htmlFor={`${ids}-who`} className="text-base">
                ¿Quién firma?
              </FieldLabel>
              <Select
                items={Object.fromEntries(choices.map((c) => [c.contactId, c.label]))}
                value={signer.contactId}
                onValueChange={(value) => setChoiceId(value ?? "")}
              >
                <SelectTrigger id={`${ids}-who`} className="text-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((c) => (
                    <SelectItem key={c.contactId} value={c.contactId}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {isMinor
                  ? "Es menor de edad: firma su representante legal vigente."
                  : "Firma la propia persona o su representante legal vigente."}
              </p>
            </Field>
          ) : current ? (
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
              <label className="flex items-start gap-3 rounded-lg border p-4">
                <Checkbox
                  className="mt-1 size-6"
                  checked={understood[current.id] === true}
                  onCheckedChange={(value) => {
                    setUnderstood((prev) => ({ ...prev, [current.id]: value === true }))
                    setError(null)
                  }}
                />
                <span>
                  <strong>Entendí lo que me explicaron y acepto</strong>
                  <span className="mt-1 block text-sm text-muted-foreground">{CONSENT_DECLARATION}</span>
                </span>
              </label>
              <div className="flex flex-col gap-2">
                <p className="font-medium">Firma aquí con el dedo</p>
                <FirmaPad
                  key={current.id}
                  label={`Firma de ${signer.name}`}
                  onChange={(value) => {
                    setStrokes((prev) => ({ ...prev, [current.id]: value }))
                    setError(null)
                  }}
                />
              </div>
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
          {error ? (
            <p role="alert" className="text-base text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-popover px-6 py-4">
          <span className="text-sm text-muted-foreground">{CONSENT_SIGNATURE_WORDS.clinica}</span>
          {!signer ? (
            <Button type="button" variant="outline" onClick={onClose}>
              Cerrar
            </Button>
          ) : choosing ? (
            <Button type="button" size="lg" onClick={() => setWhoChosen(true)}>
              Empezar
            </Button>
          ) : step.kind === "sign" ? (
            <Button type="button" size="lg" onClick={next}>
              {step.index < total - 1 ? "Siguiente" : "Listo"}
            </Button>
          ) : (
            <Button type="button" size="lg" disabled={saving || !signAs.text} onClick={() => void finish()}>
              {saving ? "Guardando…" : "Confirmar"}
            </Button>
          )}
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
  const ids = useId()
  const queryClient = useQueryClient()
  const { choices, isMinor, loading } = useSignerChoices(patientId)
  const [choiceId, setChoiceId] = useState("")
  const signer = choices.find((c) => c.contactId === choiceId) ?? choices[0] ?? null
  const [file, setFile] = useState<File | null>(null)
  const [informed, setInformed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signAs = useSignAs()
  const close = () => {
    if (saving) return
    setFile(null)
    setInformed(false)
    setError(null)
    onClose()
  }
  return (
    <FormDrawer
      open={open}
      dock={false}
      onClose={close}
      title="Firmado en papel"
      description={document ? `${document.titleSnapshot}: sube la foto de la hoja firmada y el pendiente se cierra.` : undefined}
      isSubmitting={saving}
      error={error}
      submitLabel="Guardar firma en papel"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!document || !signer) return
        if (!file) {
          setError("Sube la foto de la hoja firmada")
          return
        }
        if (!informed) {
          setError("Confirma que informaste y resolviste sus dudas")
          return
        }
        setSaving(true)
        setError(null)
        try {
          const uploaded = await uploadPatientFile(patientId, file, {
            category: "consentimiento",
            label: `Hoja firmada: ${document.titleSnapshot}`,
            encounterId: encounterId ?? null,
          })
          await signConsent(document.id, {
            signerKind: signer.kind,
            signerContactId: signer.contactId,
            representativeRelation: signer.kind === "representante" ? "Representante legal" : null,
            comprehensionConfirmed: true,
            method: "papel",
            paperDocumentId: uploaded.id,
          })
          await generateConsentPdf(document.id).catch(() => null)
          await Promise.all(
            [["consents", patientId], ["consent-needs", patientId], ["patient-documents", patientId]].map(
              (queryKey) => queryClient.invalidateQueries({ queryKey }),
            ),
          )
          toast.success("Firma en papel guardada")
          setFile(null)
          setInformed(false)
          await onSigned()
          onClose()
        } catch (e) {
          setError(errorMessage(e, "No se pudo guardar la firma en papel"))
        } finally {
          setSaving(false)
        }
      }}
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
          <Field>
            <FieldLabel htmlFor={`${ids}-who`}>Quién firmó la hoja</FieldLabel>
            <Select
              items={Object.fromEntries(choices.map((c) => [c.contactId, c.label]))}
              value={signer.contactId}
              onValueChange={(value) => setChoiceId(value ?? "")}
            >
              <SelectTrigger id={`${ids}-who`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((c) => (
                  <SelectItem key={c.contactId} value={c.contactId}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-file`}>Foto de la hoja firmada</FieldLabel>
            <Input
              id={`${ids}-file`}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              capture="environment"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                setError(null)
              }}
            />
            <p className="text-xs text-muted-foreground">Queda en Documentos como consentimiento.</p>
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={informed} onCheckedChange={(value) => setInformed(value === true)} />
            <span>
              Informé a {firstName(signer.name)} y resolví sus dudas.
              <span className="block text-xs text-muted-foreground">
                {signAs.text ? `Firmas como ${signAs.text}` : "Firmas con tu perfil profesional"}
              </span>
            </span>
          </label>
          <p className="text-xs text-muted-foreground">{CONSENT_SIGNATURE_WORDS.papel}</p>
        </div>
      )}
    </FormDrawer>
  )
}
