import {
  MANUAL_SIGNED_ODONTOGRAM_PURPOSES,
  type ManualOdontogramPurpose,
  SIGNED_ODONTOGRAM_PURPOSE_LABELS,
  SIGNED_ODONTOGRAM_PURPOSE_SHORT,
} from "@odentia/clinical"
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useRef, useState } from "react"
import { ApiError } from "../lib/api"
import { usePermission } from "../lib/crm"
import { fetchMyProfessionalProfile, registrationLabel } from "../lib/encounters"
import { activeOrgLocale, activeOrgTimeZone } from "../lib/locale"
import { fetchSignedOdontograms, signOdontogramApi } from "../lib/odontogram"
import type { OdontogramAssessment, OdontogramEntry } from "../lib/patients"
import { OdontogramDocument } from "./odontogram-document"
import { useOdontogramNotation } from "./odontogram-notation"
import { ProfessionalProfileDrawer } from "./professional-profile-drawer"

const MANUAL_OPTIONS: Record<ManualOdontogramPurpose, string> = {
  legal: SIGNED_ODONTOGRAM_PURPOSE_LABELS.legal,
  personal: SIGNED_ODONTOGRAM_PURPOSE_LABELS.personal,
  reentry: `${SIGNED_ODONTOGRAM_PURPOSE_LABELS.reentry} tras culminar el plan`,
}

/** «15 oct», con el año si no es el de hoy; en el formato y la zona de la clínica. */
function shortDate(iso: string): string {
  const date = new Date(iso)
  const timeZone = activeOrgTimeZone()
  const year = (value: Date) => new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(value)
  return date.toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    ...(year(date) === year(new Date()) ? {} : { year: "numeric" }),
    timeZone,
  })
}

/** «15 oct · Inicio del plan · Ana Torres · COP 12345». */
function rowLabel(item: OdontogramAssessment): string {
  return [
    shortDate(item.createdAt),
    SIGNED_ODONTOGRAM_PURPOSE_SHORT[item.purpose],
    item.examinerName,
    item.registrationNumber,
  ].join(" · ")
}

/**
 * Odontogramas firmados (solo en clínicas de Perú, NTS 188; ADR 0036). Los
 * firma el cierre de la atención que cambió el gráfico, con su momento; el
 * botón «Firmar odontograma» queda para lo judicial, lo personal y el
 * reingreso. Una sola firma, la del perfil profesional, sin trazo. Cada uno se
 * ve con el gráfico de la norma y se imprime con «Firma y sello» en papel.
 */
export function SignedOdontograms({
  patientId,
  history,
  readOnly,
  disabled,
}: {
  patientId: string
  history: OdontogramEntry[]
  readOnly: boolean
  disabled: boolean
}) {
  const id = useId()
  const official = useOdontogramNotation()
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [viewing, setViewing] = useState<OdontogramAssessment | null>(null)
  const [purpose, setPurpose] = useState<ManualOdontogramPurpose | "">("")
  const [observations, setObservations] = useState("")
  const [specifications, setSpecifications] = useState("")
  const [profileOpen, setProfileOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ["odontogram-assessments", patientId],
    queryFn: () => fetchSignedOdontograms(patientId),
    enabled: official?.signedOdontogram === true,
  })
  const profileQuery = useQuery({
    queryKey: ["professional-profile", "me"],
    queryFn: fetchMyProfessionalProfile,
    enabled: open,
  })
  if (!official?.signedOdontogram) return null
  const assessments = query.data?.data ?? []
  const profile = profileQuery.data?.data ?? null
  const signerRegistration = profile ? registrationLabel(profile) : null
  const reviewCount = history.filter((entry) => entry.needsReview && entry.status !== "voided").length
  const canSign = !readOnly && canWrite

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (pending || disabled || !canSign) return
    if (!purpose) {
      setError("Elige para qué se firma.")
      return
    }
    setPending(true)
    setError(null)
    try {
      await signOdontogramApi(patientId, {
        purpose,
        observations: observations.trim(),
        specifications: specifications.trim(),
      })
      await queryClient.invalidateQueries({ queryKey: ["odontogram-assessments", patientId] })
      setOpen(false)
      setPurpose("")
      setObservations("")
      setSpecifications("")
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.shape.message
          ? cause.shape.message
          : cause instanceof Error
            ? cause.message
            : "No se pudo firmar el odontograma.",
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border p-4 sm:p-6" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id={`${id}-title`} className="text-base font-semibold">
            Odontogramas firmados
          </h3>
          <p className="text-sm text-muted-foreground">
            Se firman solos al cerrar la atención que cambia el gráfico: inicio del plan, nuevos
            hallazgos o culminación ({official.shortName}). Lo firmado no se altera.
          </p>
        </div>
        {canSign ? (
          <Button
            variant="outline"
            disabled={disabled || pending}
            onClick={() => {
              setError(null)
              setOpen(true)
            }}
          >
            Firmar odontograma
          </Button>
        ) : null}
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudieron cargar los odontogramas firmados.{" "}
          <Button variant="link" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : assessments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no tiene: se firma al cerrar la atención que registre sus hallazgos.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {assessments.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0 break-words">{rowLabel(item)}</span>
              <span className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setViewing(item)}>
                  Ver
                </Button>
                <Link
                  to="/patients/$patientId/odontogram/$assessmentId/print"
                  params={{ patientId, assessmentId: item.id }}
                  target="_blank"
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  Imprimir
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}

      <FormDrawer
        open={open}
        onClose={() => setOpen(false)}
        title="Firmar odontograma"
        description="Para un pedido judicial o de la persona, o al reingresar tras culminar el plan. Se conservan los hallazgos de hoy y tu firma; lo que se corrija después no altera este documento."
        onSubmit={save}
        isDirty={purpose !== "" || observations !== "" || specifications !== ""}
        isSubmitting={pending}
        error={error}
        submitLabel="Firmar odontograma"
        submitDisabled={disabled || reviewCount > 0 || !signerRegistration || !purpose}
      >
        <div className="flex flex-col gap-4">
          {reviewCount > 0 && (
            <p role="alert" className="rounded-lg border p-3 text-sm">
              Revisa los {reviewCount} registros anteriores antes de firmar: no se pueden asumir sus
              datos faltantes.
            </p>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-purpose`}>Para qué se firma</FieldLabel>
            <Select
              value={purpose}
              items={MANUAL_OPTIONS}
              onValueChange={(value) => {
                if (value && (MANUAL_SIGNED_ODONTOGRAM_PURPOSES as readonly string[]).includes(value))
                  setPurpose(value as ManualOdontogramPurpose)
              }}
              disabled={pending}
            >
              <SelectTrigger id={`${id}-purpose`}>
                <SelectValue placeholder="Elige…" />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_SIGNED_ODONTOGRAM_PURPOSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {MANUAL_OPTIONS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-observations`}>Observaciones (opcional)</FieldLabel>
            <Textarea
              id={`${id}-observations`}
              value={observations}
              onChange={(event) => setObservations(event.target.value)}
              maxLength={4000}
              disabled={pending}
              placeholder="Hallazgos no contemplados en la nomenclatura."
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-specifications`}>Especificaciones (opcional)</FieldLabel>
            <Textarea
              id={`${id}-specifications`}
              value={specifications}
              onChange={(event) => setSpecifications(event.target.value)}
              maxLength={4000}
              disabled={pending}
              placeholder="Clasificaciones utilizadas u otros detalles."
            />
          </Field>
          {profileQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Cargando tu perfil profesional…</p>
          ) : profileQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo cargar tu perfil profesional.{" "}
              <Button type="button" variant="link" onClick={() => void profileQuery.refetch()}>
                Reintentar
              </Button>
            </p>
          ) : signerRegistration && profile ? (
            <div className="rounded-lg border p-3 text-sm">
              <p className="font-medium">Firmarás como {profile.signatureName ?? profile.accountName}</p>
              <p className="text-xs text-muted-foreground">
                {[profile.professionalTitle, signerRegistration].filter(Boolean).join(" · ")} · de tu
                perfil
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm">
              <span>Para firmar, registra tu colegiatura en tu perfil profesional.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => setProfileOpen(true)}>
                Completar perfil
              </Button>
            </div>
          )}
        </div>
      </FormDrawer>
      {profileOpen ? (
        <ProfessionalProfileDrawer
          open
          target="me"
          profile={profile}
          onClose={() => setProfileOpen(false)}
        />
      ) : null}
      <SignedOdontogramDialog patientId={patientId} viewing={viewing} onClose={() => setViewing(null)} />
    </section>
  )
}

/** «Ver»: el odontograma firmado con el gráfico de la norma, y «Imprimir». */
function SignedOdontogramDialog({
  patientId,
  viewing,
  onClose,
}: {
  patientId: string
  viewing: OdontogramAssessment | null
  onClose: () => void
}) {
  const viewTitleRef = useRef<HTMLHeadingElement>(null)
  return (
    <Dialog open={viewing !== null} onOpenChange={(value) => (!value ? onClose() : undefined)}>
      <DialogContent initialFocus={viewTitleRef} className="max-h-[90vh] w-full overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle ref={viewTitleRef} tabIndex={-1}>
            Odontograma firmado
          </DialogTitle>
          <DialogDescription>
            {viewing
              ? `${SIGNED_ODONTOGRAM_PURPOSE_LABELS[viewing.purpose]} · ${rowLabel(viewing)}. Copia inalterable de sus hallazgos.`
              : null}
          </DialogDescription>
        </DialogHeader>
        {viewing ? (
          <div className="min-w-0 rounded-lg bg-white p-3 text-black">
            <OdontogramDocument
              entries={viewing.entries}
              standard={viewing.standard}
              date={viewing.createdAt}
              specifications={viewing.specifications}
              observations={viewing.observations}
              examinerName={viewing.examinerName}
              examinerTitle={viewing.examinerTitle}
              registrationNumber={viewing.registrationNumber}
              patientName={`${viewing.patientName} · HC-${String(viewing.patientNumber).padStart(6, "0")}`}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          {viewing ? (
            <Link
              to="/patients/$patientId/odontogram/$assessmentId/print"
              params={{ patientId, assessmentId: viewing.id }}
              target="_blank"
              className={buttonVariants({})}
            >
              Imprimir
            </Link>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * El odontograma firmado como hecho de la historia, con «Ver · Imprimir»: en
 * Historia (el del botón, por su id) y en la atención cerrada que lo firmó
 * (por la atención). Sin odontograma firmado no muestra nada.
 */
export function SignedOdontogramFact({
  patientId,
  assessmentId,
  encounterId,
}: {
  patientId: string
  assessmentId?: string
  encounterId?: string
}) {
  const official = useOdontogramNotation()
  const [viewing, setViewing] = useState<OdontogramAssessment | null>(null)
  const query = useQuery({
    queryKey: ["odontogram-assessments", patientId],
    queryFn: () => fetchSignedOdontograms(patientId),
    enabled: official?.signedOdontogram === true || assessmentId !== undefined,
  })
  const item = (query.data?.data ?? []).find((row) =>
    assessmentId ? row.id === assessmentId : encounterId ? row.encounterId === encounterId : false,
  )
  if (!item) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="min-w-0 break-words">
        <span className="font-medium">Odontograma firmado</span> · {rowLabel(item)}
      </span>
      <span className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setViewing(item)}>
          Ver
        </Button>
        <Link
          to="/patients/$patientId/odontogram/$assessmentId/print"
          params={{ patientId, assessmentId: item.id }}
          target="_blank"
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          Imprimir
        </Link>
      </span>
      <SignedOdontogramDialog patientId={patientId} viewing={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}
