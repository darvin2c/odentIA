import { type OrgRole, PRODUCT_ROLES, roleLabel } from "@odentia/auth/permissions"
import { Button, toast } from "@odentia/ui"
import {
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../lib/api"
import { useMemberName } from "../lib/crm"
import { appWords } from "../lib/product-words"
import { productUi } from "../product/product-ui"

/**
 * Dar acceso a soporte de odentIA para que mire la clínica: con qué rol (lo que
 * vería ese rol, solo para mirar) o solo la configuración, y por cuánto tiempo.
 * El mismo cuadro sirve para responder a un pedido de soporte (con lo pedido ya
 * puesto) y para darlo sin que lo pidan, desde el pie de Ayuda.
 */

/** «Solo la configuración» se guarda como rol vacío: es el acceso de diagnóstico. */
const CONFIG = "configuracion"

const MINUTES = [
  { value: "15", label: "15 minutos" },
  { value: "30", label: "30 minutos" },
  { value: "60", label: "1 hora" },
] as const

const accessSchema = z.object({
  view: z.string().min(1, "Elige qué puede mirar soporte."),
  minutes: z.enum(["15", "30", "60"], "Elige por cuánto tiempo."),
  reason: z.string().max(500, "Escríbelo en 500 caracteres o menos."),
})

/** Los roles con que soporte puede mirar: los del producto, menos propietario y «miembro». */
export function supportViewOptions(): { value: string; label: string }[] {
  const product = productUi().product
  // Administrador al final: es lo más amplio (toda la clínica).
  const roles = PRODUCT_ROLES[product]
    .filter((role) => role !== "owner" && role !== "member")
    .sort((a, b) => Number(a === "admin") - Number(b === "admin"))
  return [
    { value: CONFIG, label: "Solo la configuración (ningún paciente)" },
    ...roles.map((role) => ({
      value: role,
      label:
        role === "admin"
          ? `${roleLabel(role, product)} (toda la clínica)`
          : roleLabel(role, product),
    })),
  ]
}

/** «como Odontólogo» o «la configuración», para frases. */
export function supportViewWords(viewRole: string | null | undefined): string {
  if (!viewRole) return "la configuración"
  return `como ${roleLabel(viewRole as OrgRole, productUi().product)}`
}

/** «hasta las 4:40 p. m.» en la hora de este equipo. */
export function untilWords(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

/** La hora al final de una frase: «6:34 p. m.» ya trae su punto; «18:34» lo recibe. */
export function untilSentence(iso: string): string {
  const time = untilWords(iso)
  return time.endsWith(".") ? time : `${time}.`
}

/** Lo que verá soporte con cada elección, dicho antes de dar el acceso. */
const VIEW_WORDS: Record<string, string> = {
  [CONFIG]: "Verá sedes, canales, el agente y el equipo; ningún paciente.",
  reception: "Verá la agenda, los pacientes y las conversaciones; no la historia clínica.",
  cashier: "Verá los cobros y las cuentas; no la historia clínica.",
  clinician: "Verá los pacientes, su historia y sus documentos.",
  sales: "Verá las ventas, los cobros y la receta de lentes vigente.",
  workshop: "Verá solo los pedidos del taller.",
  admin: "Verá toda la clínica.",
}

export interface SupportAccessValues {
  viewRole: string | null
  minutes: number
  reason: string | null
}

/** El cuadro: qué mira, para qué (opcional) y cuánto tiempo; el botón dice lo que hace. */
export function SupportAccessForm({
  id,
  initialViewRole = null,
  initialMinutes = 30,
  askReason = true,
  onSubmit,
  onCancel,
}: {
  id: string
  initialViewRole?: string | null
  initialMinutes?: number
  askReason?: boolean
  onSubmit: (values: SupportAccessValues) => Promise<unknown>
  onCancel?: () => void
}) {
  const form = useAppForm({
    defaultValues: {
      view: initialViewRole ?? CONFIG,
      minutes: String([15, 30, 60].includes(initialMinutes) ? initialMinutes : 30),
      reason: "",
    },
    validators: { onSubmit: accessSchema },
    onSubmit: async ({ value }) => {
      await onSubmit({
        viewRole: value.view === CONFIG ? null : value.view,
        minutes: Number.parseInt(value.minutes, 10),
        reason: value.reason.trim() || null,
      })
    },
  })
  const onFormSubmit = useFormSubmit(form)
  const error = useFormSubmitError(form)
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const minutes = useStore(form.store, (state) => state.values.minutes)
  const view = useStore(form.store, (state) => state.values.view)
  const until = new Date(Date.now() + Number.parseInt(minutes, 10) * 60_000).toISOString()
  const label = Number.parseInt(minutes, 10) === 60 ? "1 hora" : `${minutes} min`
  return (
    <form noValidate onSubmit={onFormSubmit} className="flex flex-col gap-3">
      <form.AppField name="view">
        {(field) => (
          <field.RadioGroupField
            legend="¿Con qué rol mira soporte?"
            id={`${id}-rol`}
            options={supportViewOptions()}
          />
        )}
      </form.AppField>
      <p className="text-sm text-muted-foreground">
        {VIEW_WORDS[view] ?? "Verá lo mismo que ese rol de tu clínica."} Sin poder cambiar nada; cada ficha que abra queda anotada.
      </p>
      {askReason ? (
        <form.AppField name="reason">
          {(field) => (
            <field.TextField
              id={`${id}-para-que`}
              label="¿Qué quieres que revisen? (opcional)"
              maxLength={500}
            />
          )}
        </form.AppField>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <form.AppField name="minutes">
          {(field) => (
            <field.SelectField
              label="¿Por cuánto tiempo?"
              id={`${id}-minutos`}
              className="w-auto"
              triggerClassName="w-40"
              options={MINUTES}
            />
          )}
        </form.AppField>
        <span className="pb-2 text-sm text-muted-foreground">hasta las {untilWords(until)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          className="min-h-11 sm:min-h-9"
          disabled={submitting}
          aria-busy={submitting}
        >
          Dar acceso por {label}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" onClick={onCancel}>
            Cancelar
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}

/** Lo que cambia al dar o quitar: la franja, los casos y el caso abierto. */
export function useSupportAccessRefresh(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["saas"] })
    void queryClient.invalidateQueries({ queryKey: ["support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["support-case"] })
  }
}

interface GivenGrant {
  caseId: string
  grant: { id: string; expiresAt: string; viewRole: string | null }
}

/** «Dar acceso a soporte» desde el pie de Ayuda, sin que soporte lo haya pedido. */
export function GiveSupportAccess({ screen, onClose }: { screen: string; onClose: () => void }) {
  const refresh = useSupportAccessRefresh()
  const [given, setGiven] = useState<GivenGrant | null>(null)
  const [ended, setEnded] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  // Al abrir, el cuadro queda a la vista y con el foco: no detrás de la conversación.
  useEffect(() => {
    titleRef.current?.scrollIntoView({ block: "start" })
    titleRef.current?.focus()
  }, [])
  // Lo dado se sigue: si se quita desde la franja, se resuelve el caso o vence, la tarjeta lo dice.
  const live = useQuery({
    queryKey: ["support-case", given?.caseId ?? null],
    queryFn: () =>
      apiFetch<{ data: { grants: { id: string; active: boolean }[] } }>(`/api/help/cases/${given?.caseId}`),
    enabled: given !== null,
    refetchInterval: 30_000,
  })
  const stillActive = given
    ? (live.data?.data.grants.find((item) => item.id === given.grant.id)?.active ?? true)
    : false
  useEffect(() => {
    if (given && !stillActive) {
      setGiven(null)
      setEnded(true)
    }
  }, [given, stillActive])
  useEffect(() => {
    if (given) statusRef.current?.focus()
  }, [given])
  const give = useMutation({
    retry: false,
    mutationFn: (values: SupportAccessValues) =>
      apiFetch<{ data: GivenGrant }>("/api/help/support-access", {
        method: "POST",
        body: JSON.stringify({ ...values, screen }),
      }),
    onSuccess: (body) => {
      setEnded(false)
      setGiven(body.data)
      refresh()
    },
  })
  const revoke = useMutation({
    retry: false,
    mutationFn: (current: GivenGrant) =>
      apiFetch(`/api/help/cases/${current.caseId}/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId: current.grant.id }),
      }),
    onSuccess: () => {
      setGiven(null)
      setEnded(true)
      refresh()
      toast.success("Soporte ya no ve tu clínica")
    },
    onError: () => toast.error("No pude quitar el acceso. Inténtalo otra vez."),
  })
  return (
    <section aria-labelledby="dar-acceso-titulo" className="flex flex-col gap-3">
      <Button
        type="button"
        variant="link"
        className="h-auto self-start p-0 text-sm"
        onClick={onClose}
      >
        ← Volver a Ayuda
      </Button>
      <div>
        <h3
          id="dar-acceso-titulo"
          ref={titleRef}
          tabIndex={-1}
          className="scroll-mt-2 text-base font-bold outline-none"
        >
          Dar acceso a soporte de {appWords().name}
        </h3>
        <p className="text-sm text-muted-foreground">
          Soporte solo mira: no puede cambiar nada. Lo quitas cuando quieras.
        </p>
      </div>
      {given ? (
        <div
          ref={statusRef}
          tabIndex={-1}
          role="status"
          className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary-soft px-3 py-2.5 text-sm outline-none"
        >
          <p>
            Listo. Soporte puede mirar {supportViewWords(given.grant.viewRole)} hasta las{" "}
            {untilSentence(given.grant.expiresAt)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 self-start bg-card sm:min-h-9"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(given)}
          >
            Quitar acceso
          </Button>
          {revoke.isError ? (
            <p role="alert" className="text-destructive">
              No pude quitar el acceso. {submitErrorMessage(revoke.error)}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {ended ? (
            <p role="status" className="text-sm text-muted-foreground">
              Soporte ya no ve tu clínica. Si hace falta, puedes darle acceso otra vez.
            </p>
          ) : null}
          <SupportAccessForm
            id="dar-acceso"
            onSubmit={(values) => give.mutateAsync(values)}
            onCancel={onClose}
          />
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Queda anotado quién lo dio y qué miró soporte: lo ves en «Tus casos con soporte».
      </p>
    </section>
  )
}

export interface ClinicGrant {
  id: string
  grantedBy: string
  scope: "diagnostico" | "rol"
  viewRole: string | null
  staffName: string | null
  expiresAt: string
  revokedAt: string | null
  endReason: string | null
  revokedBy: string | null
  active: boolean
  createdAt: string
  reads: { patientName: string; resource: string; at: string }[]
}

const END_WORDS: Record<string, string> = {
  quitado: "lo quitaron",
  reemplazado: "lo reemplazó otro acceso",
  vencido: "se cumplió el tiempo",
  caso_resuelto: "se resolvió el caso",
  sin_quien_lo_dio: "quien lo dio ya no administra la clínica",
}

const RESOURCE_WORDS: Record<string, string> = {
  resumen: "Resumen clínico",
  antecedentes: "Antecedentes",
  odontograma: "Odontograma",
  historia: "Historia",
  atenciones: "Atenciones",
  notas: "Notas clínicas",
  plan: "Plan de tratamiento",
  tratamientos: "Tratamientos",
  controles: "Controles",
  recetas: "Recetas",
  documentos: "Imágenes y documentos",
  formularios: "Formularios",
  consentimientos: "Consentimientos",
  ordenes: "Órdenes",
  descarga: "Descargó la historia completa",
  apertura: "Abrió la historia bloqueada",
  descansos: "Descansos médicos",
}

/** El rastro de cada acceso en el caso: quién lo dio, cómo terminó y qué fichas miró soporte. */
export function SupportGrantHistory({ grants }: { grants: ClinicGrant[] }) {
  const nameOf = useMemberName()
  if (grants.length === 0) return null
  return (
    <ol aria-label="Accesos de soporte" className="flex flex-col gap-2 text-sm">
      {[...grants].reverse().map((grant) => {
        const ended = grant.revokedAt ?? (grant.active ? null : grant.expiresAt)
        const people = new Set(grant.reads.map((read) => read.patientName)).size
        return (
          <li key={grant.id} className="flex flex-col gap-1 rounded-xl bg-muted/60 px-3 py-2">
            <span>
              {untilWords(grant.createdAt)} · {nameOf(grant.grantedBy)} dio acceso a soporte para
              mirar {supportViewWords(grant.viewRole)} hasta las {untilSentence(grant.expiresAt)}
            </span>
            {ended ? (
              <span>
                {untilWords(ended)} · El acceso terminó:{" "}
                {grant.endReason === "quitado" && grant.revokedBy
                  ? `lo quitó ${nameOf(grant.revokedBy)}`
                  : (END_WORDS[grant.endReason ?? "vencido"] ?? "terminó")}
                .
              </span>
            ) : null}
            {grant.reads.length > 0 ? (
              <details>
                <summary className="cursor-pointer">
                  {grant.staffName ?? "Soporte"} miró{" "}
                  {people === 1 ? "la ficha de 1 persona" : `las fichas de ${people} personas`}. Ver
                  cuáles
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                  {grant.reads.map((read) => (
                    <li key={`${read.patientName}-${read.resource}-${read.at}`}>
                      {read.patientName} · {RESOURCE_WORDS[read.resource] ?? read.resource} ·{" "}
                      {untilWords(read.at)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : grant.scope === "rol" && ended ? (
              <span className="text-muted-foreground">Soporte no abrió ninguna ficha.</span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
