import { apiFetch, apiFetchBytes } from "@odentia/clinic-app/lib/api"
import { usePermission, useMyUserId } from "@odentia/clinic-app/lib/crm"
import { uploadPatientFile } from "@odentia/clinic-app/lib/encounter-documents"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import type { RecordSectionProps } from "@odentia/clinic-app/product/product-ui"
import {
  EYES,
  formatDay,
  lensText,
  PD_FIELDS,
  PRESCRIPTION_KINDS,
  type PrescriptionKind,
  type PrescriptionLenses,
  type PupillaryDistance,
  pupillaryDistanceText,
  refractionText,
} from "@odentia/optical"
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Textarea,
  toast,
} from "@odentia/ui"
import { EmptyState, FormDrawer, LoadingState, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Glasses } from "lucide-react"
import { type FormEvent, useState } from "react"
import { ChoiceButtons } from "@odentia/clinic-app/components/choice-buttons"
import { EMPTY_LENSES, LensFields, type LensDrafts, lensDraftsOf, lensesBody, lensesDirty, numberOf } from "./lens-fields"

interface LensPrescription {
  id: string
  kind: PrescriptionKind
  source: "examen" | "externa"
  encounterId: string | null
  lenses: PrescriptionLenses
  pupillaryDistance: PupillaryDistance | null
  notes: string | null
  issuedOn: string
  validUntil: string
  prescriberName: string
  prescriberRegistration: string | null
  prescriberUserId: string | null
  verifiedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  notices: string[]
}

interface Prescriptions {
  items: LensPrescription[]
  current: Partial<Record<PrescriptionKind, LensPrescription>>
}

/** Abre el PDF en otra pestaña, abierta en el mismo clic para que el navegador no la bloquee. */
async function openPdf(path: string): Promise<void> {
  const tab = window.open("", "_blank")
  if (tab) tab.opener = null
  try {
    const bytes = await apiFetchBytes(path)
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
    if (tab && !tab.closed) tab.location.href = url
    else window.open(url, "_blank", "noopener")
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
  } catch (cause) {
    if (tab && !tab.closed) tab.close()
    throw cause
  }
}

const KIND_LABEL = Object.fromEntries(PRESCRIPTION_KINDS.map((kind) => [kind.key, kind.label])) as Record<PrescriptionKind, string>

function queryKey(patientId: string) {
  return ["lens-prescriptions", patientId] as const
}

/** Los ojos de una receta, uno por línea: «OD −1,25 −0,50 × 180°». */
function Lenses({ prescription }: { prescription: LensPrescription }) {
  return (
    <dl className="grid grid-cols-[2.5rem_1fr] gap-x-2 gap-y-1 text-sm">
      {EYES.filter((eye) => prescription.lenses[eye.key]).map((eye) => (
        <div key={eye.key} className="contents">
          <dt className="font-semibold" title={eye.label}>
            {eye.short}
          </dt>
          <dd className="tabular-nums">{lensText(prescription.lenses[eye.key])}</dd>
        </div>
      ))}
      {pupillaryDistanceText(prescription.pupillaryDistance) ? (
        <div className="contents">
          <dt className="font-semibold">DP</dt>
          <dd className="tabular-nums">{pupillaryDistanceText(prescription.pupillaryDistance)}</dd>
        </div>
      ) : null}
    </dl>
  )
}

function PrescriptionCard({
  patientId,
  prescription,
  canWrite,
  onVerify,
  onVoid,
  verifying,
}: {
  patientId: string
  prescription: LensPrescription
  canWrite: boolean
  onVerify: () => void
  onVoid: () => void
  verifying: boolean
}) {
  const external = prescription.source === "externa"
  return (
    <article className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col">
          <h3 className="font-heading text-base font-semibold">{KIND_LABEL[prescription.kind]}</h3>
          <p className="text-sm text-muted-foreground">
            {external ? "Externa" : "De la óptica"} · {formatDay(prescription.issuedOn)} · vale hasta {formatDay(prescription.validUntil)}
          </p>
        </div>
        {external && !prescription.verifiedAt ? <Badge variant="outline">Sin verificar</Badge> : null}
      </header>
      <Lenses prescription={prescription} />
      {prescription.notes ? <p className="text-sm">{prescription.notes}</p> : null}
      <p className="text-xs text-muted-foreground">
        Firma: {prescription.prescriberName}
        {prescription.prescriberRegistration ? ` · ${prescription.prescriberRegistration}` : ""}
      </p>
      {prescription.notices.length > 0 ? (
        <Alert role="status" className="border-warning/40 bg-warning-soft">
          <AlertDescription className="text-foreground">
            {prescription.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            void openPdf(`/api/patients/${patientId}/lens-prescriptions/${prescription.id}/pdf`).catch((cause: unknown) =>
              toast.error(submitErrorMessage(cause)),
            )
          }
        >
          Imprimir
        </Button>
        {canWrite && external && !prescription.verifiedAt ? (
            <Button type="button" size="sm" disabled={verifying} onClick={onVerify}>
            {verifying ? "Verificando…" : "La revisé: verificar"}
          </Button>
        ) : null}
        {canWrite ? (
          <Button type="button" size="sm" variant="ghost" onClick={onVoid}>
            Anular
          </Button>
        ) : null}
      </div>
    </article>
  )
}

type PdText = Partial<Record<(typeof PD_FIELDS)[number]["key"], string>>

/**
 * Transcribir la receta que trae el cliente: su graduación (con el prisma, en la
 * de anteojos), su distancia pupilar si la dice y su foto, que queda entre sus
 * documentos para verificarla. Queda «sin verificar» hasta que la revise un
 * optómetra. Al guardar o cerrar, el cajón vuelve a empezar vacío.
 */
function ExternalPrescriptionDrawer({ patientId, open, onClose }: { patientId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<PrescriptionKind>("anteojos")
  const [lenses, setLenses] = useState<LensDrafts>(EMPTY_LENSES)
  const [pd, setPd] = useState<PdText>({})
  const [photo, setPhoto] = useState<File | null>(null)
  const [issuedOn, setIssuedOn] = useState("")
  const [prescriberName, setPrescriberName] = useState("")
  const [prescriberRegistration, setPrescriberRegistration] = useState("")
  const [notes, setNotes] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const reset = () => {
    setKind("anteojos")
    setLenses(EMPTY_LENSES)
    setPd({})
    setPhoto(null)
    setIssuedOn("")
    setPrescriberName("")
    setPrescriberRegistration("")
    setNotes("")
    setErrors({})
  }
  const close = () => {
    reset()
    onClose()
  }
  const save = useMutation({
    mutationFn: async () => {
      // La foto va primero entre sus documentos: la receta la nombra para verificarla.
      const uploaded = photo
        ? await uploadPatientFile(patientId, photo, { category: "otro", label: `Receta externa${prescriberName.trim() ? ` de ${prescriberName.trim()}` : ""}` })
        : null
      const pupillaryDistance = Object.fromEntries(
        PD_FIELDS.map((field) => [field.key, numberOf(pd[field.key])]).filter(([, value]) => value !== undefined),
      )
      return apiFetch(`/api/patients/${patientId}/lens-prescriptions/external`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          lenses: lensesBody(kind, lenses),
          issuedOn,
          prescriberName,
          prescriberRegistration: prescriberRegistration.trim() || null,
          notes: notes.trim() || null,
          pupillaryDistance: Object.keys(pupillaryDistance).length ? pupillaryDistance : null,
          photoDocumentId: uploaded?.id ?? null,
        }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey(patientId) })
      toast.success("Receta guardada. Queda sin verificar hasta que la revise un optómetra.")
      close()
    },
    onError: (cause: unknown) => {
      const fields = (cause as { fields?: Record<string, string> }).fields
      if (fields) setErrors(fields.file ? { ...fields, photo: fields.file } : fields)
    },
  })
  return (
    <FormDrawer
      open={open}
      onClose={close}
      title="Receta externa"
      description="La que trae de su oftalmólogo. Queda «sin verificar» hasta que la revise un optómetra."
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        setErrors({})
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={Boolean(issuedOn || prescriberName || photo || lensesDirty(lenses))}
      error={save.error && !(save.error as { fields?: unknown }).fields ? submitErrorMessage(save.error) : null}
      submitLabel="Guardar receta"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span id="receta-tipo" className="text-sm font-medium">
            Tipo
          </span>
          <ChoiceButtons
            aria-labelledby="receta-tipo"
            value={kind}
            options={PRESCRIPTION_KINDS.map((item) => ({ value: item.key, label: item.label }))}
            columns={2}
            onChange={setKind}
          />
        </div>
        <LensFields idPrefix="externa" kind={kind} value={lenses} onChange={setLenses} errors={errors} />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">Distancia pupilar (mm, si la dice)</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PD_FIELDS.map((field) => {
              const id = `externa-dp-${field.key}`
              const message = errors[`pupillaryDistance.${field.key}`]
              return (
                <Field key={field.key} data-invalid={message ? true : undefined} className="gap-1">
                  <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
                    {field.label}
                  </FieldLabel>
                  <Input
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    value={pd[field.key] ?? ""}
                    aria-invalid={message ? true : undefined}
                    onChange={(event) => setPd((all) => ({ ...all, [field.key]: event.target.value }))}
                  />
                  {message ? <FieldError>{message}</FieldError> : null}
                </Field>
              )
            })}
          </div>
        </fieldset>
        <Field data-invalid={errors.issuedOn ? true : undefined}>
          <FieldLabel htmlFor="externa-fecha">Fecha de la receta</FieldLabel>
          <Input id="externa-fecha" type="date" value={issuedOn} onChange={(event) => setIssuedOn(event.target.value)} />
          {errors.issuedOn ? <FieldError>{errors.issuedOn}</FieldError> : null}
        </Field>
        <Field data-invalid={errors.prescriberName ? true : undefined}>
          <FieldLabel htmlFor="externa-firma">Quién la firmó</FieldLabel>
          <Input id="externa-firma" value={prescriberName} placeholder="Dra. Ana Ruiz, oftalmóloga" onChange={(event) => setPrescriberName(event.target.value)} />
          {errors.prescriberName ? <FieldError>{errors.prescriberName}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="externa-colegiatura">Su colegiatura (opcional)</FieldLabel>
          <Input id="externa-colegiatura" value={prescriberRegistration} placeholder="CMP 12345" onChange={(event) => setPrescriberRegistration(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="externa-notas">Indicaciones (opcional)</FieldLabel>
          <Textarea id="externa-notas" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <Field data-invalid={errors.photo || errors.photoDocumentId ? true : undefined}>
          <FieldLabel htmlFor="externa-foto">Foto de la receta (opcional)</FieldLabel>
          <Input
            id="externa-foto"
            type="file"
            accept="image/*,application/pdf"
            onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-muted-foreground">Queda entre sus documentos; el optómetra la mira al verificar.</p>
          {errors.photo || errors.photoDocumentId ? <FieldError>{errors.photo ?? errors.photoDocumentId}</FieldError> : null}
        </Field>
      </div>
    </FormDrawer>
  )
}

function VoidDrawer({ patientId, prescription, onClose }: { patientId: string; prescription: LensPrescription | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState("")
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/lens-prescriptions/${prescription?.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey(patientId) })
      toast.success("Receta anulada")
      setReason("")
      onClose()
    },
  })
  return (
    <FormDrawer
      open={prescription !== null}
      onClose={onClose}
      title="Anular la receta"
      description={
        prescription?.source === "examen"
          ? "Queda en la historia como anulada, con el motivo. No se borra. Quien la firmó puede emitir otra desde el mismo examen, en «Anteriores»."
          : "Queda en la historia como anulada, con el motivo. No se borra."
      }
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={Boolean(reason)}
      error={save.error ? submitErrorMessage(save.error) : null}
      submitLabel="Anular"
      dock={false}
    >
      <Field>
        <FieldLabel htmlFor="anular-motivo">Motivo</FieldLabel>
        <Textarea id="anular-motivo" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </FormDrawer>
  )
}

/**
 * Emitir otra receta desde el examen de una que se anuló, aunque la atención ya
 * esté firmada: con su graduación escrita para corregirla. La firma quien atendió.
 */
function IssueAgainDrawer({ patientId, from, onClose }: { patientId: string; from: LensPrescription | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [lenses, setLenses] = useState<LensDrafts>(EMPTY_LENSES)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<string | null>(null)
  if (from && shown !== from.id) {
    setShown(from.id)
    setLenses(lensDraftsOf(from.lenses))
    setErrors({})
  }
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/lens-prescriptions`, {
        method: "POST",
        body: JSON.stringify({ encounterId: from?.encounterId, kind: from?.kind, lenses: lensesBody(from?.kind ?? "anteojos", lenses) }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey(patientId) })
      toast.success("Receta emitida")
      setShown(null)
      onClose()
    },
    onError: (cause: unknown) => {
      const fields = (cause as { fields?: Record<string, string> }).fields
      if (fields) setErrors(fields)
    },
  })
  return (
    <FormDrawer
      open={from !== null}
      onClose={() => {
        setShown(null)
        onClose()
      }}
      title={from ? `Otra receta de ${KIND_LABEL[from.kind].toLowerCase()}` : "Otra receta"}
      description="Del mismo examen, con la graduación de la anulada para corregirla. La firmas tú."
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        setErrors({})
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty
      error={save.error && !(save.error as { fields?: unknown }).fields ? submitErrorMessage(save.error) : null}
      submitLabel="Emitir"
    >
      {from ? <LensFields idPrefix="otra" kind={from.kind} value={lenses} onChange={setLenses} errors={errors} /> : null}
    </FormDrawer>
  )
}

/**
 * Las recetas de lentes de la persona (entrega 3 del plan): la vigente de cada
 * tipo arriba, con su aviso si venció o si es externa sin verificar (se informa,
 * no impide vender), y las anteriores debajo.
 */
export function PrescriptionsSection({ patientId }: RecordSectionProps) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const myUserId = useMyUserId()
  const [externalOpen, setExternalOpen] = useState(false)
  const [voiding, setVoiding] = useState<LensPrescription | null>(null)
  const [again, setAgain] = useState<LensPrescription | null>(null)
  const query = useQuery({
    queryKey: queryKey(patientId),
    queryFn: () => apiFetch<{ data: Prescriptions }>(`/api/patients/${patientId}/lens-prescriptions`).then((body) => body.data),
  })
  const verify = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/patients/${patientId}/lens-prescriptions/${id}/verify`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey(patientId) })
      toast.success("Receta verificada")
    },
    onError: (cause) => toast.error(submitErrorMessage(cause)),
  })
  if (query.isPending) return <LoadingState message="Cargando las recetas…" />
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => query.refetch()} />
  const data = query.data
  const current = PRESCRIPTION_KINDS.map((kind) => data.current[kind.key]).filter((item): item is LensPrescription => Boolean(item))
  const currentIds = new Set(current.map((item) => item.id))
  const past = data.items.filter((item) => !currentIds.has(item.id))
  // Una anulada de su examen se vuelve a emitir mientras ese examen no tenga otra viva de su tipo.
  const live = new Set(data.items.filter((item) => !item.voidedAt && item.encounterId).map((item) => `${item.encounterId}:${item.kind}`))
  const canIssueAgain = (item: LensPrescription) =>
    canWrite &&
    Boolean(item.voidedAt) &&
    item.source === "examen" &&
    item.prescriberUserId === myUserId &&
    !live.has(`${item.encounterId}:${item.kind}`)
  return (
    <section className="flex flex-col gap-4" aria-labelledby="recetas-lentes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="recetas-lentes" className="font-heading text-lg font-semibold">
            Recetas de lentes
          </h2>
          <p className="text-sm text-muted-foreground">
            La de la óptica sale del examen de la vista, en la atención. La externa se transcribe aquí.
          </p>
        </div>
        {canWrite ? (
          <Button type="button" variant="outline" onClick={() => setExternalOpen(true)}>
            Transcribir receta externa
          </Button>
        ) : null}
      </div>
      {current.length === 0 ? (
        <EmptyState
          icon={Glasses}
          title="Sin receta todavía"
          description="Examina la vista en una atención y emite la receta, o transcribe la que trae de su oftalmólogo."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {current.map((prescription) => (
            <PrescriptionCard
              key={prescription.id}
              patientId={patientId}
              prescription={prescription}
              canWrite={canWrite}
              verifying={verify.isPending && verify.variables === prescription.id}
              onVerify={() => verify.mutate(prescription.id)}
              onVoid={() => setVoiding(prescription)}
            />
          ))}
        </div>
      )}
      {past.length > 0 ? (
        <details className="rounded-xl border bg-card p-4">
          <summary className="cursor-pointer text-sm font-semibold">Anteriores ({past.length})</summary>
          <ul className="mt-3 flex flex-col divide-y">
            {past.map((item) => (
              <li key={item.id} className="flex flex-col gap-1 py-2 text-sm">
                <span className="font-medium">
                  {KIND_LABEL[item.kind]} · {formatDay(item.issuedOn)}
                  {item.voidedAt ? ` · anulada: ${item.voidReason}` : ""}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {EYES.filter((eye) => item.lenses[eye.key]).map((eye) => `${eye.short} ${refractionText(item.lenses[eye.key])}`).join(" · ")}
                </span>
                {canIssueAgain(item) ? (
                  <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setAgain(item)}>
                    Emitir otra desde su examen
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ExternalPrescriptionDrawer patientId={patientId} open={externalOpen} onClose={() => setExternalOpen(false)} />
      <VoidDrawer patientId={patientId} prescription={voiding} onClose={() => setVoiding(null)} />
      <IssueAgainDrawer patientId={patientId} from={again} onClose={() => setAgain(null)} />
    </section>
  )
}
