import { apiFetch } from "@odentia/clinic-app/lib/api"
import { usePermission } from "@odentia/clinic-app/lib/crm"
import { QueryErrorState } from "@odentia/clinic-app/lib/query-error"
import type { RecordSectionProps } from "@odentia/clinic-app/product/product-ui"
import {
  EYES,
  formatDay,
  lensText,
  PRESCRIPTION_KINDS,
  type PrescriptionKind,
  type PrescriptionLenses,
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

interface LensPrescription {
  id: string
  kind: PrescriptionKind
  source: "examen" | "externa"
  lenses: PrescriptionLenses
  pupillaryDistance: { od?: number; oi?: number } | null
  notes: string | null
  issuedOn: string
  validUntil: string
  prescriberName: string
  prescriberRegistration: string | null
  verifiedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  notices: string[]
}

interface Prescriptions {
  items: LensPrescription[]
  current: Partial<Record<PrescriptionKind, LensPrescription>>
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
      {prescription.pupillaryDistance ? (
        <div className="contents">
          <dt className="font-semibold">DP</dt>
          <dd className="tabular-nums">
            {EYES.filter((eye) => prescription.pupillaryDistance?.[eye.key] !== undefined)
              .map((eye) => `${eye.short} ${String(prescription.pupillaryDistance![eye.key]).replace(".", ",")} mm`)
              .join(" · ")}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

function PrescriptionCard({
  prescription,
  canWrite,
  onVerify,
  onVoid,
  verifying,
}: {
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
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          {external && !prescription.verifiedAt ? (
            <Button type="button" size="sm" disabled={verifying} onClick={onVerify}>
              {verifying ? "Verificando…" : "La revisé: verificar"}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={onVoid}>
            Anular
          </Button>
        </div>
      ) : null}
    </article>
  )
}

type EyeText = { esfera: string; cilindro: string; eje: string; adicion: string; curvaBase: string; diametro: string; marca: string }
const EMPTY_EYE: EyeText = { esfera: "", cilindro: "", eje: "", adicion: "", curvaBase: "", diametro: "", marca: "" }

function numberOf(text: string): number | string | undefined {
  const clean = text.trim().replace("−", "-").replace(",", ".").replace(/^\+/, "")
  if (!clean) return undefined
  const value = Number(clean)
  return Number.isFinite(value) ? value : text
}

/** Transcribir la receta que trae el cliente: queda «sin verificar» hasta que la revise un optómetra. */
function ExternalPrescriptionDrawer({ patientId, open, onClose }: { patientId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<PrescriptionKind>("anteojos")
  const [eyes, setEyes] = useState<Record<"od" | "oi", EyeText>>({ od: EMPTY_EYE, oi: EMPTY_EYE })
  const [issuedOn, setIssuedOn] = useState("")
  const [prescriberName, setPrescriberName] = useState("")
  const [prescriberRegistration, setPrescriberRegistration] = useState("")
  const [notes, setNotes] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: () => {
      const lenses: Record<string, Record<string, unknown>> = {}
      for (const eye of EYES) {
        const e = eyes[eye.key]
        const lens: Record<string, unknown> = {
          esfera: numberOf(e.esfera),
          cilindro: numberOf(e.cilindro),
          eje: numberOf(e.eje),
          adicion: numberOf(e.adicion),
          ...(kind === "contacto" ? { curvaBase: numberOf(e.curvaBase), diametro: numberOf(e.diametro), marca: e.marca.trim() || undefined } : {}),
        }
        if (Object.values(lens).some((value) => value !== undefined)) lenses[eye.key] = lens
      }
      return apiFetch(`/api/patients/${patientId}/lens-prescriptions/external`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          lenses,
          issuedOn,
          prescriberName,
          prescriberRegistration: prescriberRegistration.trim() || null,
          notes: notes.trim() || null,
        }),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKey(patientId) })
      toast.success("Receta guardada. Queda sin verificar hasta que la revise un optómetra.")
      onClose()
    },
    onError: (cause: unknown) => {
      const fields = (cause as { fields?: Record<string, string> }).fields
      if (fields) setErrors(fields)
    },
  })
  const setEye = (eye: "od" | "oi", key: keyof EyeText, value: string) => setEyes((all) => ({ ...all, [eye]: { ...all[eye], [key]: value } }))
  const columns: Array<{ key: keyof EyeText; label: string }> = [
    { key: "esfera", label: "Esfera" },
    { key: "cilindro", label: "Cilindro" },
    { key: "eje", label: "Eje" },
    { key: "adicion", label: "Adición" },
    ...(kind === "contacto"
      ? ([
          { key: "curvaBase", label: "Curva base (mm)" },
          { key: "diametro", label: "Diámetro (mm)" },
          { key: "marca", label: "Marca" },
        ] as const)
      : []),
  ]
  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Receta externa"
      description="La que trae de su oftalmólogo. Queda «sin verificar» hasta que la revise un optómetra."
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        setErrors({})
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={Boolean(issuedOn || prescriberName || eyes.od.esfera || eyes.oi.esfera)}
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
        {EYES.map((eye) => (
          <fieldset key={eye.key} className="flex flex-col gap-2">
            <legend className="text-sm font-semibold">{eye.label}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {columns.map((column) => {
                const id = `externa-${eye.key}-${column.key}`
                const message = errors[`lentes.${eye.key}.${column.key}`]
                return (
                  <Field key={column.key} data-invalid={message ? true : undefined}>
                    <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
                      {column.label}
                    </FieldLabel>
                    <Input
                      id={id}
                      inputMode={column.key === "marca" ? "text" : "decimal"}
                      value={eyes[eye.key][column.key]}
                      aria-invalid={message ? true : undefined}
                      onChange={(event) => setEye(eye.key, column.key, event.target.value)}
                    />
                    {message ? <FieldError>{message}</FieldError> : null}
                  </Field>
                )
              })}
            </div>
          </fieldset>
        ))}
        {errors.lentes ? <FieldError>{errors.lentes}</FieldError> : null}
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
        <p className="text-xs text-muted-foreground">Sube la foto de la receta en Documentos de la ficha.</p>
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
      description="Queda en la historia como anulada, con el motivo. No se borra."
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
 * Las recetas de lentes de la persona (entrega 3 del plan): la vigente de cada
 * tipo arriba, con su aviso si venció o si es externa sin verificar (se informa,
 * no impide vender), y las anteriores debajo.
 */
export function PrescriptionsSection({ patientId }: RecordSectionProps) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const [externalOpen, setExternalOpen] = useState(false)
  const [voiding, setVoiding] = useState<LensPrescription | null>(null)
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
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ExternalPrescriptionDrawer patientId={patientId} open={externalOpen} onClose={() => setExternalOpen(false)} />
      <VoidDrawer patientId={patientId} prescription={voiding} onClose={() => setVoiding(null)} />
    </section>
  )
}
