import { productWords } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import {
  common,
  countryOptions,
  FormDrawer,
  PageNotice,
  submitForm,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { Copy } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { invitationDueWords } from "../../lib/invitation-words"
import { useIsAdmin } from "../../lib/session"
import {
  type ClientSale,
  postJson,
  type SaleProposal,
  useClientProposals,
  useClientSale,
  useInvalidateClient,
  usePlans,
  useSellers,
} from "./sale-api"
import {
  addDays,
  CLIENT_PROFESSIONALS,
  CLIENT_TOOLS,
  dayWords,
  LOST_REASON_WORDS,
  LOST_REASONS,
  limaDay,
  PROFESSIONALS_WORDS,
  TOOL_WORDS,
} from "./sale-words"
import { DayField } from "./task-drawer"

/**
 * Decidir la venta (solo Administración; el servidor lo exige): invitarla a
 * abrir su cuenta con la propuesta aceptada puesta, darla de alta uno mismo
 * (el alta asistida de siempre, ligada a este cliente), «No por ahora» con su
 * motivo y el día para volver, o «Perdido» con su motivo. «Entró» no se marca:
 * lo pone la cuenta al crearse.
 */
export type SaleDecision = "invitar" | "alta" | "no_por_ahora" | "perdido"

export interface DecideDrawerProps {
  clientId: string
  open: boolean
  onClose: () => void
  decision: SaleDecision
}

const TITLES: Record<SaleDecision, string> = {
  invitar: "Invitar a abrir su cuenta",
  alta: "Dar de alta",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
}

export function DecideDrawer(props: DecideDrawerProps) {
  if (!props.open) return null
  return <DecideLoader {...props} />
}

function DecideLoader({ clientId, onClose, decision }: DecideDrawerProps) {
  const isAdmin = useIsAdmin()
  const client = useClientSale(clientId)
  const proposals = useClientProposals(
    clientId,
    isAdmin && (decision === "invitar" || decision === "alta"),
  )
  const needsProposals = decision === "invitar" || decision === "alta"
  if (!isAdmin) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title={TITLES[decision]}
        onSubmit={(event) => event.preventDefault()}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        <p className="text-sm text-muted-foreground">Decidir la venta es del rol Administración.</p>
      </FormDrawer>
    )
  }
  if (!client.data || (needsProposals && !proposals.data)) {
    const failed = client.isError || (needsProposals && proposals.isError)
    return (
      <FormDrawer
        open
        onClose={onClose}
        title={TITLES[decision]}
        onSubmit={(event) => event.preventDefault()}
        isLoading={!failed}
        error={failed ? "No pude cargar al cliente. Cierra y vuelve a intentarlo." : null}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {null}
      </FormDrawer>
    )
  }
  // La aceptada de esta venta: la de una venta anterior (perdida y reabierta) ya no vale.
  const accepted =
    (proposals.data ?? []).find(
      (proposal) => proposal.status === "aceptada" && proposal.currentSale !== false,
    ) ?? null
  if (client.data.organization) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title={TITLES[decision]}
        onSubmit={(event) => event.preventDefault()}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        <p className="text-sm text-muted-foreground">
          {client.data.name} ya tiene su cuenta: la venta entró.
        </p>
      </FormDrawer>
    )
  }
  if (decision === "invitar")
    return (
      <InviteForm clientId={clientId} client={client.data} accepted={accepted} onClose={onClose} />
    )
  if (decision === "alta")
    return (
      <AssistedForm
        clientId={clientId}
        client={client.data}
        accepted={accepted}
        onClose={onClose}
      />
    )
  return (
    <CloseForm clientId={clientId} client={client.data} decision={decision} onClose={onClose} />
  )
}

/* ---------- Invitar ---------- */

const LIVE_REQUEST = new Set(["por_revisar", "invitada"])

const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Escribe el correo de quien abre la cuenta")
    .email("Escribe un correo válido, como nombre@clinica.com")
    .max(254),
  firstName: z.string().max(80, "Usa como máximo 80 caracteres"),
  lastName: z.string().max(120, "Usa como máximo 120 caracteres"),
  phone: z.string().max(20, "Usa como máximo 20 caracteres"),
  city: z.string().max(120, "Usa como máximo 120 caracteres"),
  professionals: z.string(),
  currentTool: z.string(),
})

const invitedSchema = z.object({ url: z.string(), expiresAt: z.string(), emailSent: z.boolean() })
type Invited = z.infer<typeof invitedSchema> & { send: boolean; email: string }

const UNKNOWN = "__sin"

/**
 * Sin solicitud de la web, la invitación lleva los datos de quien entra y el
 * servidor los exige (`inviteClient`): se piden aquí, antes de enviar, con
 * las mismas palabras. Antes se ofrecía «Por saber» y volvía un 400.
 */
function inviteSchemaFor(live: boolean, clinicians: string) {
  if (live) return inviteSchema
  return inviteSchema.superRefine((value, ctx) => {
    const missing = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message })
    if (!value.firstName.trim()) missing("firstName", "Escribe el nombre de quien entra")
    if (!value.lastName.trim()) missing("lastName", "Escribe sus apellidos")
    if (!/^\+[1-9][0-9]{6,14}$/.test(value.phone.replace(/[ ()-]/g, "")))
      missing("phone", "Escribe su celular con el código del país, como +51987654321")
    if (!value.city.trim()) missing("city", "Escribe la ciudad")
    if (value.professionals === UNKNOWN)
      missing("professionals", `Elige cuántos ${clinicians} atienden`)
    if (value.currentTool === UNKNOWN) missing("currentTool", "Elige qué usan hoy")
  })
}

function InviteForm({
  clientId,
  client,
  accepted,
  onClose,
}: {
  clientId: string
  client: ClientSale
  accepted: SaleProposal | null
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const [invited, setInvited] = useState<Invited | null>(null)
  const send = useRef(true)
  const live =
    client.waitlistRequest && LIVE_REQUEST.has(client.waitlistRequest.status)
      ? client.waitlistRequest
      : null
  const contacts = client.contacts.filter((contact) => contact.id !== null)
  const primary = contacts.find((contact) => contact.isPrimary) ?? contacts[0]
  const [firstName = "", ...rest] = (primary?.name ?? "").trim().split(/\s+/)
  const form = useAppForm({
    defaultValues: {
      email: live?.email ?? primary?.email ?? "",
      firstName,
      lastName: rest.join(" "),
      phone: primary?.phone ?? "",
      city: client.city ?? "",
      professionals: client.professionals ?? UNKNOWN,
      currentTool: client.currentTool ?? UNKNOWN,
    },
    validators: {
      onSubmit: inviteSchemaFor(live !== null, productWords(client.product).clinician.many),
    },
    onSubmit: async ({ value }) => {
      const text = (raw: string) => raw.trim() || null
      const body = {
        email: value.email.trim().toLowerCase(),
        proposalId: accepted?.id ?? null,
        send: send.current,
        ...(live
          ? {}
          : {
              firstName: text(value.firstName),
              lastName: text(value.lastName),
              phone: text(value.phone.replace(/[ ()-]/g, "")),
              city: text(value.city),
              professionals: value.professionals === UNKNOWN ? null : value.professionals,
              currentTool: value.currentTool === UNKNOWN ? null : value.currentTool,
            }),
      }
      const result = invitedSchema.parse(
        await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/invite`, body),
      )
      invalidate()
      setInvited({ ...result, send: send.current, email: body.email })
      if (send.current && result.emailSent) toast.success(`Invitación enviada a ${body.email}`)
    },
  })
  const surface = useFormSurface(form)
  const professionalsLabel = `Cuántos ${productWords(client.product).clinician.many} atienden`

  if (invited) return <InvitedView invited={invited} onClose={onClose} />

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={TITLES.invitar}
      description={`Le llega «Crear mi cuenta» a ${client.name}: el enlace vale para un solo correo y una sola clínica, y vence a los 14 días.`}
      submitLabel="Invitar y enviar el correo"
      secondaryAction={{
        label: "Solo el enlace",
        onClick: () => {
          send.current = false
          void submitForm(form).finally(() => {
            send.current = true
          })
        },
        disabled: surface.isSubmitting,
      }}
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        {accepted ? (
          <PageNotice tone="aviso" label="Con su propuesta">
            Va con la propuesta v{accepted.version} aceptada ({accepted.plan.name}): sus condiciones
            se ponen solas al entrar.
          </PageNotice>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sin propuesta aceptada: entra con el plan de la invitación de siempre.
          </p>
        )}
        {client.waitlistRequest?.status === "invitada" && client.waitlistRequest.inviteExpiresAt ? (
          <p className="text-sm text-muted-foreground">
            Ya tiene una invitación que{" "}
            {invitationDueWords(client.waitlistRequest.inviteExpiresAt).text}: invitar otra vez da
            un enlace nuevo y anula el anterior.
          </p>
        ) : null}
        <form.AppField name="email">
          {(field) => (
            <field.TextField
              id="invitar-correo"
              label="Correo de quien abre la cuenta"
              type="email"
              autoComplete="off"
              maxLength={254}
            />
          )}
        </form.AppField>
        {live ? null : (
          <>
            <p className="text-sm text-muted-foreground">
              No pidió en la web: la invitación necesita estos datos de quien entra.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <form.AppField name="firstName">
                {(field) => <field.TextField id="invitar-nombre" label="Nombres" maxLength={80} />}
              </form.AppField>
              <form.AppField name="lastName">
                {(field) => (
                  <field.TextField id="invitar-apellidos" label="Apellidos" maxLength={120} />
                )}
              </form.AppField>
              <form.AppField name="phone">
                {(field) => (
                  <field.TextField
                    id="invitar-celular"
                    label="Celular"
                    description="Con el código del país, como +51987654321."
                    type="tel"
                    maxLength={20}
                  />
                )}
              </form.AppField>
              <form.AppField name="city">
                {(field) => <field.TextField id="invitar-ciudad" label="Ciudad" maxLength={120} />}
              </form.AppField>
              <form.AppField name="professionals">
                {(field) => (
                  <field.SelectField
                    id="invitar-profesionales"
                    label={professionalsLabel.charAt(0).toUpperCase() + professionalsLabel.slice(1)}
                    options={[
                      { value: UNKNOWN, label: "Elige…" },
                      ...CLIENT_PROFESSIONALS.map((value) => ({
                        value,
                        label: PROFESSIONALS_WORDS[value],
                      })),
                    ]}
                  />
                )}
              </form.AppField>
              <form.AppField name="currentTool">
                {(field) => (
                  <field.SelectField
                    id="invitar-herramienta"
                    label="Qué usan hoy"
                    options={[
                      { value: UNKNOWN, label: "Elige…" },
                      ...CLIENT_TOOLS.map((value) => ({ value, label: TOOL_WORDS[value] })),
                    ]}
                  />
                )}
              </form.AppField>
            </div>
          </>
        )}
      </div>
    </FormDrawer>
  )
}

/** La invitación hecha: el enlace para copiarlo y pasarlo por WhatsApp; si el correo no salió, se dice. */
function InvitedView({ invited, onClose }: { invited: Invited; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invited.url)
      setCopied(true)
      toast.success("Enlace copiado: pégalo en WhatsApp")
    } catch {
      toast.message("Copia el enlace de abajo y pégalo en WhatsApp")
    }
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Invitación lista"
      onSubmit={(event) => event.preventDefault()}
      hideSubmit
      cancelLabel={common.actions.close}
    >
      <div className="flex flex-col gap-4" aria-live="polite">
        <p className="text-sm">
          {invited.send && invited.emailSent
            ? `Le enviamos el correo a ${invited.email}.`
            : invited.send
              ? `La invitación quedó lista para ${invited.email}.`
              : `La invitación quedó lista para ${invited.email}; no se envió ningún correo.`}{" "}
          El enlace {invitationDueWords(invited.expiresAt).text}.
        </p>
        {invited.send && !invited.emailSent ? (
          <PageNotice tone="alarma" label="Correo sin enviar">
            El correo no salió y no se vuelve a enviar solo. Copia el enlace y envíaselo por
            WhatsApp.
          </PageNotice>
        ) : null}
        <p className="rounded-lg bg-muted px-3 py-2 text-xs break-all">{invited.url}</p>
        <div>
          <Button
            type="button"
            variant={invited.send && invited.emailSent ? "outline" : "default"}
            onClick={() => void copy()}
          >
            <Copy aria-hidden />
            {copied ? "Copiado" : "Copiar enlace"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          El enlace solo se muestra ahora. Si se pierde, invitar otra vez da uno nuevo y anula este.
        </p>
      </div>
    </FormDrawer>
  )
}

/* ---------- Dar de alta: el alta asistida de siempre, ligada al cliente ---------- */

const assistedSchema = z
  .object({
    orgName: z
      .string()
      .trim()
      .min(2, "Escribe el nombre de la clínica")
      .max(120, "Escribe como mucho 120 caracteres"),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2, "Escribe al menos 2 caracteres")
      .max(63, "Escribe como mucho 63 caracteres")
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Minúsculas, números y guiones"),
    email: z.string().trim().email("Correo inválido").max(320, "Escribe como mucho 320 caracteres"),
    countryCode: z.string().trim().length(2, "Elige el país"),
    currency: z.string(),
    billingStart: z.enum(["trial", "now"]),
    planCode: z.string(),
    sellerId: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.billingStart === "now" && !value.planCode)
      ctx.addIssue({
        code: "custom",
        path: ["planCode"],
        message: "Elige un plan para el cobro desde hoy",
      })
  })

/** «Clínica Sonrisa (ficticia)» → «clinica-sonrisa-ficticia»: solo se propone, se puede cambiar. */
function slugOf(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "")
}

const assistedResultSchema = z.object({
  userId: z.string().nullable(),
  proposal: z
    .object({ applied: z.boolean(), reason: z.string().nullable() })
    .nullable()
    .default(null),
})

function AssistedForm({
  clientId,
  client,
  accepted,
  onClose,
}: {
  clientId: string
  client: ClientSale
  accepted: SaleProposal | null
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const plans = usePlans(true)
  const sellers = useSellers(true)
  const contacts = client.contacts.filter((contact) => contact.id !== null)
  const primary =
    contacts.find((contact) => contact.isPrimary && contact.email) ??
    contacts.find((contact) => contact.email)
  const productPlans = (plans.data ?? []).filter(
    (plan) => plan.product === client.product && plan.isActive,
  )
  const trialDays = productPlans.find((plan) => plan.isDefault)?.trialDays
  const countries = useMemo(
    () =>
      countryOptions("PE", undefined, "es").map((item) => ({
        value: item.value,
        label: item.label,
      })),
    [],
  )
  const currencies = useMemo(() => {
    const names = new Intl.DisplayNames(["es"], { type: "currency" })
    return Intl.supportedValuesOf("currency").map((code) => ({
      value: code,
      label: `${code} · ${names.of(code) ?? code}`,
    }))
  }, [])
  const form = useAppForm({
    defaultValues: {
      orgName: client.name.slice(0, 120),
      slug: slugOf(client.name),
      email: primary?.email ?? client.waitlistRequest?.email ?? "",
      countryCode: client.countryCode || "PE",
      currency: "",
      billingStart: "trial" as "trial" | "now",
      planCode: "",
      sellerId: "",
    },
    validators: { onSubmit: assistedSchema },
    onSubmit: async ({ value }) => {
      let raw: unknown
      try {
        raw = await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/assisted`, {
          orgName: value.orgName.trim(),
          slug: value.slug.trim().toLowerCase(),
          email: value.email.trim(),
          countryCode: value.countryCode,
          currency: value.currency || undefined,
          billingStart: value.billingStart,
          // Sin plan elegido y con una propuesta aceptada, el servidor usa el de la propuesta.
          planCode: value.planCode || undefined,
          sellerId: value.sellerId || undefined,
        })
      } catch (error) {
        // La clínica ya quedó creada: no se reintenta el alta; el aviso queda hasta cerrarlo.
        if (!(error instanceof ApiError && error.shape.code === "EMAIL_FAILED")) throw error
        invalidate()
        toast.warning(
          error.shape.message ??
            "Clínica creada, pero no se pudo enviar el correo: reenvíalo desde la ficha",
          {
            duration: Number.POSITIVE_INFINITY,
            closeButton: true,
          },
        )
        onClose()
        return
      }
      invalidate()
      const created = assistedResultSchema.safeParse(raw)
      toast.success(
        created.success && created.data.userId
          ? "Clínica creada; el correo ya tiene cuenta: acepta la invitación sin crear contraseña"
          : "Clínica creada e invitación de propietaria enviada",
      )
      if (created.success && created.data.proposal && !created.data.proposal.applied) {
        toast.warning(
          created.data.proposal.reason ??
            "Las condiciones de la propuesta aceptada no se pusieron solas: ponlas en Plan y pagos",
          { duration: Number.POSITIVE_INFINITY, closeButton: true },
        )
      }
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const billingStart = useStore(form.store, (state) => state.values.billingStart)
  // Vacío: con propuesta aceptada, el plan de esa propuesta (lo pone el servidor); si no, la prueba sin plan.
  const planOptions = [
    {
      value: "",
      label: accepted
        ? `El de la propuesta v${accepted.version} (${accepted.plan.name})`
        : "Sin plan (prueba)",
    },
    ...productPlans.map((plan) => ({ value: plan.code, label: plan.name })),
  ]

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={TITLES.alta}
      description={`Creas la clínica de ${client.name} una sola vez y le llega la invitación de propietaria. Entrar exige que la acepte; quien ya tiene cuenta acepta sin crear contraseña.`}
      submitLabel="Crear clínica"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Producto: {productWords(client.product).name}. No se cambia después: la clínica abre en el
          dominio de su producto.
        </p>
        <form.AppField name="orgName">
          {(field) => (
            <field.TextField id="alta-nombre" label="Nombre de la clínica" maxLength={120} />
          )}
        </form.AppField>
        <form.AppField name="slug">
          {(field) => (
            <field.TextField
              id="alta-direccion"
              label="Dirección personalizada"
              description="Será su dirección en el dominio de su producto, en minúsculas sin espacios."
              maxLength={63}
              autoCapitalize="none"
            />
          )}
        </form.AppField>
        <form.AppField name="email">
          {(field) => (
            <field.TextField
              id="alta-correo"
              label="Correo de la propietaria"
              type="email"
              maxLength={320}
            />
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="countryCode">
            {(field) => <field.SelectField id="alta-pais" label="País" options={countries} />}
          </form.AppField>
          <form.AppField name="currency">
            {(field) => (
              <field.SelectField
                id="alta-moneda"
                label="Moneda (opcional)"
                options={[{ value: "", label: "La del país" }, ...currencies]}
                placeholder="La del país"
              />
            )}
          </form.AppField>
          <form.AppField name="billingStart">
            {(field) => (
              <field.SelectField
                id="alta-inicio"
                label="Inicio"
                options={[
                  { value: "trial", label: trialDays ? `Prueba de ${trialDays} días` : "Prueba" },
                  { value: "now", label: "Cobro desde hoy" },
                ]}
              />
            )}
          </form.AppField>
          <form.AppField name="planCode">
            {(field) => (
              <field.SelectField
                id="alta-plan"
                label={billingStart === "now" ? "Plan" : "Plan (para cobro desde hoy)"}
                options={planOptions}
              />
            )}
          </form.AppField>
          <form.AppField name="sellerId">
            {(field) => (
              <field.SelectField
                id="alta-vendedora"
                label="Vendedora"
                options={[
                  { value: "", label: "Sin vendedor" },
                  ...(sellers.data ?? []).map((seller) => ({
                    value: seller.id,
                    label: seller.displayName,
                  })),
                ]}
              />
            )}
          </form.AppField>
        </div>
        {accepted ? (
          <PageNotice tone="aviso" label="Con su propuesta">
            Sus condiciones (v{accepted.version}) se ponen en su plan al crearla. Si no se pueden
            poner, la clínica se crea igual y lo decimos.
          </PageNotice>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/* ---------- No por ahora y Perdido ---------- */

const closeSchema = z
  .object({
    decision: z.enum(["no_por_ahora", "perdido"]),
    reason: z.string().min(1, "Elige el motivo"),
    reasonDetail: z.string().trim().max(500, "Usa como máximo 500 caracteres"),
    returnOn: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "no_por_ahora" && !value.returnOn)
      ctx.addIssue({ code: "custom", path: ["returnOn"], message: "Elige el día para volver" })
    if (value.reason === "otro" && !value.reasonDetail.trim())
      ctx.addIssue({
        code: "custom",
        path: ["reasonDetail"],
        message: "Escribe cuál fue el motivo",
      })
  })

function CloseForm({
  clientId,
  client,
  decision,
  onClose,
}: {
  clientId: string
  client: ClientSale
  decision: "no_por_ahora" | "perdido"
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const today = limaDay()
  const form = useAppForm({
    defaultValues: {
      decision,
      reason: decision === "no_por_ahora" ? "no_es_el_momento" : "",
      reasonDetail: "",
      returnOn: decision === "no_por_ahora" ? addDays(today, 30) : "",
    },
    validators: { onSubmit: closeSchema },
    onSubmit: async ({ value }) => {
      await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/decide`, {
        decision: value.decision,
        reason: value.reason,
        reasonDetail: value.reasonDetail.trim() || null,
        returnOn: value.decision === "no_por_ahora" ? value.returnOn : null,
      })
      invalidate()
      toast.success(
        value.decision === "no_por_ahora"
          ? `No por ahora: volver el ${dayWords(value.returnOn)}`
          : `${client.name}: venta perdida`,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const options = LOST_REASONS.map((reason) => ({
    value: reason,
    label: reason === "otro" ? "Otro (escrito)" : LOST_REASON_WORDS[reason],
  }))
  const liveRequest = client.waitlistRequest && LIVE_REQUEST.has(client.waitlistRequest.status)

  return (
    <FormDrawer
      {...surface}
      open
      dock={false}
      onClose={onClose}
      title={`${TITLES[decision]} · ${client.name}`}
      description={
        decision === "no_por_ahora"
          ? "La venta se cierra con su motivo. Ese día Kairós pone la tarea y te deja el mensaje listo; no lo envía sin tu sí."
          : "La venta se cierra con su motivo, para poder contarlo. Si la clínica vuelve, se abre otra y esta queda en su historial."
      }
      submitLabel={decision === "no_por_ahora" ? "Guardar «No por ahora»" : "Marcar perdido"}
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="reason">
          {(field) =>
            decision === "perdido" ? (
              <field.RadioGroupField id="decidir-motivo" legend="Motivo" options={options} />
            ) : (
              <field.SelectField id="decidir-motivo" label="Motivo" options={options} />
            )
          }
        </form.AppField>
        {decision === "no_por_ahora" ? (
          <DayField
            form={form}
            name="returnOn"
            id="decidir-volver"
            label="Volver el"
            min={addDays(today, 1)}
          />
        ) : null}
        <form.AppField name="reasonDetail">
          {(field) => (
            <field.TextareaField
              id="decidir-nota"
              label={decision === "perdido" ? "Nota" : "Nota (opcional)"}
              description="No escribas nombres de pacientes."
              rows={3}
              maxLength={500}
            />
          )}
        </form.AppField>
        <p className="text-xs text-muted-foreground">
          Las tareas de venta abiertas se cancelan.
          {decision === "perdido" && liveRequest
            ? " Su solicitud de la web también se descarta con este motivo, y si tenía invitación deja de servir."
            : ""}
        </p>
      </div>
    </FormDrawer>
  )
}
