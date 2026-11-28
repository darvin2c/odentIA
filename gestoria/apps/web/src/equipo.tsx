import { Badge, Button, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  type CountryCode,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  internationalText,
  LoadingState,
  normalizeCountry,
  PersonAvatar,
  RadioChips,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Copy, MessageCircle, Truck, UserPlus } from "lucide-react"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import {
  api,
  invitationLink,
  type MyStore,
  type PendingInvitation,
  ROLES,
  type StoreRole,
  type SupportAccess,
  type TeamMember,
} from "./lib/api"
import { firstName } from "./lib/inicio"
import { supportLine } from "./lib/soporte"
import { money, moneyInput, readMoney } from "./lib/tienda"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Equipo y repartidores (lienzo «gestorIA · Configuración, de nuevo», tablero 9): en una página,
 * quién atiende la tienda, qué puede hacer cada rol y quién reparte, con lo que se le paga por
 * entrega. La invitación sale por WhatsApp desde el celular de quien invita, con el mensaje
 * escrito: lo envía la persona, así que queda «enviada por ti», nunca que llegó. Se acepta solo
 * entrando con la cuenta del correo invitado. Aquí se responde también el pedido de soporte para
 * mirar la tienda, que la franja de arriba avisa en toda la tienda. Es de `equipo.gestionar`.
 */

export interface Team {
  members: TeamMember[]
  invitations: PendingInvitation[]
  support: SupportAccess[]
}

/** Un repartidor como lo devuelve `GET /repartidores` (`storeCouriersIn` de la API). */
interface Courier {
  id: string
  name: string
  userId: string | null
  team: boolean
  phone: string | null
  payCents: number | null
  failedTripPaid: boolean
}

const TEAM_KEY = (storeId: string) => ["equipo", storeId]

/** El equipo y la línea de «Lo que falta» que lo resume, a la vez. */
const refreshTeam = (queryClient: ReturnType<typeof useQueryClient>, storeId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: TEAM_KEY(storeId) }),
    queryClient.invalidateQueries({ queryKey: ["configuracion-resumen", storeId] }),
  ])
const COURIERS_KEY = (storeId: string) => ["repartidores", storeId]

/** Los roles que quien está puede dar: solo un Dueño da el rol de Dueño. */
function assignable(store: MyStore): StoreRole[] {
  return store.role === "owner" ? ["sales", "admin", "owner"] : ["sales", "admin"]
}

const longDay = (iso: string) =>
  new Date(iso).toLocaleDateString("es", { day: "numeric", month: "long" })

/** «vence en 5 días», «vence hoy», «venció el 3 de diciembre». */
function expiryText(invitation: PendingInvitation, now = Date.now()): string {
  if (invitation.expired) return `venció el ${longDay(invitation.expiresAt)}`
  const days = Math.floor((new Date(invitation.expiresAt).getTime() - now) / 86_400_000)
  if (days < 1) return "vence hoy"
  return days === 1 ? "vence mañana" : `vence en ${days} días`
}

/** El WhatsApp de este celular con el mensaje escrito: al celular, o para elegir a quién. */
function whatsappHref(phone: string | null, text: string): string {
  return `https://wa.me/${phone ? phone.slice(1) : ""}?text=${encodeURIComponent(text)}`
}

export function TeamPage() {
  const { store, meId } = useStoreContext()
  const canManage = store.permissions.includes("equipo.gestionar")
  const team = useQuery({
    queryKey: TEAM_KEY(store.id),
    queryFn: () => api<Team>(`/api/tiendas/${store.id}/equipo`),
  })
  const couriers = useQuery({
    queryKey: COURIERS_KEY(store.id),
    queryFn: () => api<{ couriers: Courier[] }>(`/api/tiendas/${store.id}/repartidores`),
    enabled: canManage,
  })
  // Invitar, o «Corregir» una invitación (con sus datos puestos). Vive aquí y no en su fila: al
  // crear la nueva, la fila de la anterior se va y el cajón tiene que seguir para enviarla.
  const [inviting, setInviting] = useState<"nueva" | PendingInvitation | null>(null)
  // Enviar una invitación, también la nueva de «Invitar otra vez»: vive aquí por lo mismo.
  const [sharing, setSharing] = useState<PendingInvitation | null>(null)
  // Lo de soporte que hay que responder o que está abierto va primero: ahí lleva la franja.
  const supportNow = (team.data?.support ?? []).some(
    (row) => row.status === "por_aceptar" || row.status === "vigente",
  )
  const delivers = new Set(
    (couriers.data?.couriers ?? []).flatMap((courier) => (courier.userId ? [courier.userId] : [])),
  )

  return (
    <>
      <StoreHeader
        title="Equipo y repartidores"
        subtitle="Quién atiende tu tienda, qué puede hacer y quién reparte."
        primary={
          canManage
            ? {
                label: "Invitar",
                icon: <UserPlus aria-hidden />,
                onClick: () => setInviting("nueva"),
              }
            : undefined
        }
      />
      {team.data && supportNow ? <SupportAccessPanel store={store} team={team.data} /> : null}
      <Card
        id="tu-equipo"
        title="Tu equipo"
        count={team.data ? team.data.members.length : undefined}
      >
        {team.isPending ? <LoadingState message="Cargando tu equipo" /> : null}
        {team.isError ? (
          <ErrorState error={team.error} onRetry={() => void team.refetch()} />
        ) : null}
        {team.data ? (
          <ul className="-mx-2 flex flex-col">
            {team.data.members.map((member) => (
              <MemberRow
                key={member.userId}
                store={store}
                member={member}
                isMe={member.userId === meId}
                delivers={delivers.has(member.userId)}
                canManage={canManage}
              />
            ))}
            {team.data.invitations.map((invitation) => (
              <PendingRow
                key={invitation.id}
                store={store}
                invitation={invitation}
                canManage={canManage}
                onFix={() => setInviting(invitation)}
                onShare={setSharing}
                sentBy={
                  invitation.sharedBy === meId
                    ? "ti"
                    : (team.data.members.find((m) => m.userId === invitation.sharedBy)?.name ??
                      "alguien del equipo")
                }
              />
            ))}
          </ul>
        ) : null}
        <RolesLegend />
      </Card>
      {canManage ? <Couriers store={store} query={couriers} /> : null}
      {team.data && !supportNow && team.data.support.length > 0 ? (
        <SupportAccessPanel store={store} team={team.data} />
      ) : null}
      {inviting ? (
        <InviteForm
          // Otro cajón para cada invitación que se corrige: arranca con sus datos.
          key={inviting === "nueva" ? "nueva" : inviting.id}
          store={store}
          replaces={inviting === "nueva" ? undefined : inviting}
          onClose={() => setInviting(null)}
        />
      ) : null}
      {sharing ? (
        <ShareInvitation store={store} invitation={sharing} onClose={() => setSharing(null)} />
      ) : null}
    </>
  )
}

/** Una tarjeta de la página, con su título y lo que va a su derecha. */
function Card({
  id,
  title,
  count,
  action,
  children,
}: {
  id: string
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 id={id} className="text-base font-semibold">
          {title}
          {count !== undefined ? (
            <span className="ml-2 font-normal text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Qué puede cada rol, en una línea (tablero 9). */
function RolesLegend() {
  return (
    <dl className="grid gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-3">
      {(["owner", "admin", "sales"] as const).map((role) => (
        <div key={role} className="flex flex-col gap-0.5">
          <dt className="font-medium">{ROLES[role].name}</dt>
          <dd className="text-muted-foreground">{ROLES[role].can}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Una fila que se abre con un toque si se puede cambiar: en la computadora dice «Cambiar» y en el
 * celular lleva la flecha. Lo de la derecha (el rol) se esconde en el celular: va debajo del nombre.
 */
function Row({
  avatar,
  title,
  detail,
  side,
  onOpen,
  openLabel,
  actions,
}: {
  avatar: ReactNode
  title: ReactNode
  detail: ReactNode
  side?: ReactNode
  onOpen?: () => void
  openLabel?: string
  actions?: ReactNode
}) {
  const body = (
    <>
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        <span className="line-clamp-2 text-sm break-words text-muted-foreground">{detail}</span>
      </span>
      {side ? <span className="shrink-0 max-sm:hidden">{side}</span> : null}
    </>
  )
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b last:border-b-0">
      {onOpen ? (
        <button
          type="button"
          aria-label={openLabel}
          onClick={onOpen}
          className="flex min-h-16 min-w-0 flex-1 basis-72 items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {body}
          <span className="shrink-0 text-sm font-medium text-primary max-sm:hidden">Cambiar</span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground sm:hidden" />
        </button>
      ) : (
        <div className="flex min-h-16 min-w-0 flex-1 basis-72 items-center gap-3 px-2 py-2.5">
          {body}
        </div>
      )}
      {actions ? <div className="flex flex-wrap gap-2 px-2 pb-3">{actions}</div> : null}
    </li>
  )
}

function MemberRow({
  store,
  member,
  isMe,
  delivers,
  canManage,
}: {
  store: MyStore
  member: TeamMember
  isMe: boolean
  delivers: boolean
  canManage: boolean
}) {
  const [open, setOpen] = useState(false)
  const touchable = canManage && (member.role !== "owner" || store.role === "owner")
  const role = ROLES[member.role].name
  return (
    <>
      <Row
        avatar={<PersonAvatar name={member.name} src={member.image ?? undefined} />}
        title={
          <>
            {member.name}
            {isMe ? <span className="font-normal text-muted-foreground"> (tú)</span> : null}
          </>
        }
        detail={
          <>
            <span className="sm:hidden">{role} · </span>
            {member.email}
            {delivers ? " · también reparte" : ""}
          </>
        }
        side={<Badge variant={member.role === "owner" ? "secondary" : "outline"}>{role}</Badge>}
        onOpen={touchable ? () => setOpen(true) : undefined}
        openLabel={`Cambiar el rol de ${member.name}`}
      />
      {open ? (
        <MemberForm store={store} member={member} isMe={isMe} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

const roleSchema = z.object({ role: z.enum(["sales", "admin", "owner"]) })

/**
 * Cambiar el rol de alguien o quitarlo del equipo. Solo un Dueño toca a otro Dueño, y la tienda
 * nunca se queda sin Dueño: lo dice el servidor si pasa.
 */
function MemberForm({
  store,
  member,
  isMe,
  onClose,
}: {
  store: MyStore
  member: TeamMember
  isMe: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState(false)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: TEAM_KEY(store.id) }),
      queryClient.invalidateQueries({ queryKey: ["yo"] }),
      queryClient.invalidateQueries({ queryKey: ["configuracion-resumen", store.id] }),
    ])
  const roles = assignable(store)
  const form = useAppForm({
    defaultValues: { role: member.role },
    validators: { onSubmit: roleSchema },
    onSubmit: async ({ value }) => {
      if (value.role !== member.role)
        await api(`/api/tiendas/${store.id}/equipo/${encodeURIComponent(member.userId)}`, {
          method: "PATCH",
          body: { role: value.role },
        })
      await refresh()
      toast.success(
        value.role === member.role
          ? "Sin cambios"
          : `${member.name} ahora es ${ROLES[value.role].name}`,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/equipo/${encodeURIComponent(member.userId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setRemoving(false)
      await refresh()
      toast.success(`${member.name} ya no es parte del equipo`)
      onClose()
    },
  })
  return (
    <>
      <FormDrawer
        {...surface}
        open
        title={member.name}
        description={member.email}
        onClose={onClose}
        submitLabel="Guardar"
        secondaryAction={{
          label: isMe ? "Salir del equipo" : "Quitar del equipo",
          onClick: () => setRemoving(true),
        }}
      >
        <form.AppField name="role">
          {(field) => (
            <field.Group legend="Rol" description={ROLES[field.state.value].can} id="member-role">
              {(control) => (
                <RadioChips
                  id={control.id}
                  value={field.state.value}
                  options={roles.map((role) => ({ value: role, label: ROLES[role].name }))}
                  onChange={(next) => field.handleChange(next)}
                  onBlur={control.onBlur}
                  invalid={control.invalid}
                  aria-label="Rol"
                  aria-describedby={control.describedBy}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
      </FormDrawer>
      <ConfirmDialog
        open={removing}
        title={isMe ? "¿Salir del equipo?" : `¿Quitar a ${member.name} del equipo?`}
        description={
          isMe
            ? "Dejarás de ver esta tienda. Para volver, alguien del equipo tendrá que invitarte."
            : "Deja de ver esta tienda y de recibir sus avisos. Su cuenta sigue igual y puedes invitarla otra vez."
        }
        confirmLabel={isMe ? "Salir del equipo" : "Quitar del equipo"}
        variant="destructive"
        pending={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onConfirm={() => remove.mutate()}
        onClose={() => {
          setRemoving(false)
          remove.reset()
        }}
      />
    </>
  )
}

/** Una invitación que espera: a quién, su rol y si ya se le envió. */
function PendingRow({
  store,
  invitation,
  canManage,
  onFix,
  onShare,
  sentBy,
}: {
  store: MyStore
  invitation: PendingInvitation
  canManage: boolean
  /** «Corregir»: abre el cajón de invitar con sus datos puestos. */
  onFix: () => void
  /** Abre el cajón para enviarla, en la página: la fila se va si se hace otra. */
  onShare: (invitation: PendingInvitation) => void
  /** Quién abrió el WhatsApp con ella: «ti» o su nombre. */
  sentBy: string
}) {
  const queryClient = useQueryClient()
  const [revoking, setRevoking] = useState(false)
  // Anular no se deshace: el link deja de servir. Por eso se confirma.
  const revoke = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/invitaciones/${invitation.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRevoking(false)
      await refreshTeam(queryClient, store.id)
      toast.success("Invitación anulada")
    },
  })
  // Una vencida se hace otra, con lo mismo: la de antes queda anulada y su fila se va.
  const renew = useMutation({
    mutationFn: () =>
      api<{ invitation: PendingInvitation }>(`/api/tiendas/${store.id}/invitaciones`, {
        method: "POST",
        body: {
          email: invitation.email,
          role: invitation.role,
          name: invitation.name,
          phone: invitation.phone,
        },
      }),
    onSuccess: async ({ invitation: fresh }) => {
      onShare({ ...fresh, expired: false, sharedAt: null, sharedBy: null })
      await refreshTeam(queryClient, store.id)
    },
    onError: (error) => toast.error(error.message),
  })
  const touchable = canManage && (invitation.role !== "owner" || store.role === "owner")
  const shown = invitation.name ?? invitation.email
  const status = invitation.expired
    ? "Venció"
    : invitation.sharedAt
      ? `Enviada por ${sentBy} por WhatsApp`
      : "Por enviar"
  return (
    <>
      <Row
        avatar={<PersonAvatar name={shown} />}
        title={shown}
        detail={`${ROLES[invitation.role].name} · ${status} · ${expiryText(invitation)}`}
        side={<Badge variant="outline">{invitation.expired ? "Venció" : "Por aceptar"}</Badge>}
        actions={
          touchable ? (
            <>
              {invitation.expired ? (
                <SubmitButton
                  size="sm"
                  variant="outline"
                  className="max-sm:min-h-11"
                  pending={renew.isPending}
                  onClick={() => renew.mutate()}
                >
                  Invitar otra vez
                </SubmitButton>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="max-sm:min-h-11"
                  onClick={() => onShare(invitation)}
                >
                  <MessageCircle aria-hidden />
                  {invitation.sharedAt ? "Reenviar" : "Enviar"}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="max-sm:min-h-11"
                aria-label={`Corregir la invitación de ${shown}`}
                onClick={onFix}
              >
                Corregir
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="max-sm:min-h-11"
                aria-label={`Anular la invitación de ${shown}`}
                onClick={() => setRevoking(true)}
              >
                Anular
              </Button>
            </>
          ) : undefined
        }
      />
      <ConfirmDialog
        open={revoking}
        title={`¿Anular la invitación de ${shown}?`}
        description={`El link ${invitation.sharedAt ? "que le enviaste " : ""}deja de servir y ya no podrá entrar con él a ${store.name}. Si solo había un dato mal, usa «Corregir».`}
        confirmLabel="Anular la invitación"
        variant="destructive"
        pending={revoke.isPending}
        error={revoke.isError ? revoke.error.message : null}
        onConfirm={() => revoke.mutate()}
        onClose={() => {
          setRevoking(false)
          revoke.reset()
        }}
      />
    </>
  )
}

/** El mensaje de la invitación, como lo envía quien invita. */
function invitationText(store: MyStore, invitation: PendingInvitation): string {
  const hello = invitation.name ? `Hola ${firstName(invitation.name)}, te` : "Hola, te"
  return `${hello} invito a atender ${store.name} en gestorIA. Entra con tu correo ${invitation.email}: ${invitationLink(invitation.id)}`
}

/**
 * Enviar la invitación (tablero 9): el mensaje escrito y «Enviar por WhatsApp», que abre el
 * WhatsApp de este celular (al número, si se anotó). Lo envía la persona: aquí queda «enviada por
 * ti». «Copiar link» sirve para mandarlo por otro lado.
 */
function ShareInvitation({
  store,
  invitation,
  onClose,
}: {
  store: MyStore
  invitation: PendingInvitation
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const text = invitationText(store, invitation)
  const shared = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/invitaciones/${invitation.id}/enviada`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: TEAM_KEY(store.id) }),
  })
  const who = invitation.name ? firstName(invitation.name) : invitation.email
  return (
    <DetailDrawer
      open
      title={`Envía la invitación a ${who}`}
      description={`Vale hasta el ${longDay(invitation.expiresAt)}. Al tocar «Enviar por WhatsApp» se abre tu WhatsApp con el mensaje; lo envías tú.`}
      onClose={onClose}
      closeLabel="Listo"
      actions={
        <>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invitationLink(invitation.id))
                toast.success("Link copiado")
              } catch {
                toast.error(
                  "No se pudo copiar. Mantén presionado el link del mensaje para copiarlo.",
                )
              }
            }}
          >
            <Copy aria-hidden />
            Copiar link
          </Button>
          <Button
            className="min-h-11"
            render={
              // biome-ignore lint/a11y/useAnchorContent: el texto va dentro del botón.
              <a
                href={whatsappHref(invitation.phone, text)}
                target="_blank"
                rel="noreferrer"
                onClick={() => shared.mutate()}
              />
            }
          >
            <MessageCircle aria-hidden />
            Enviar por WhatsApp
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <MessagePreview text={text} to={invitation.phone} />
        <p className="text-sm text-muted-foreground">
          Entra con la cuenta de <strong className="text-foreground">{invitation.email}</strong>. El
          link solo no basta: así nadie más usa su lugar. Si aún no tiene cuenta, la crea ahí mismo.
        </p>
        {shared.isSuccess ? (
          <p role="status" className="text-sm">
            Queda como enviada por ti. gestorIA no sabe si le llegó: lo verás cuando entre.
          </p>
        ) : null}
      </div>
    </DetailDrawer>
  )
}

/** El mensaje, como se verá en el WhatsApp. */
function MessagePreview({ text, to }: { text: string; to: string | null }) {
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {to ? `Mensaje para ${internationalText(to)}` : "Mensaje"}
      </figcaption>
      <blockquote className="whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm">
        {text}
      </blockquote>
    </figure>
  )
}

const inviteSchema = z.object({
  name: z.string().trim().min(1, "Escribe su nombre").max(80, "Máximo 80 caracteres"),
  phone: z.string().nullable(),
  email: z
    .string()
    .trim()
    .regex(/^\S+@\S+\.\S+$/, "Escribe un correo válido, como nombre@gmail.com"),
  role: z.enum(["sales", "admin", "owner"]),
})

/**
 * Invitar al equipo (tablero 9): nombre, celular, el correo con el que entrará y el rol. Al
 * crearla, el mensaje para enviarlo por WhatsApp. «Corregir» abre lo mismo con los datos de la
 * invitación ya puestos (`replaces`): una invitación no cambia lo que dice, así que al crear la
 * nueva la anterior queda anulada en el mismo paso; si se cierra sin crearla, sigue como estaba.
 */
function InviteForm({
  store,
  replaces,
  onClose,
}: {
  store: MyStore
  replaces?: PendingInvitation
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [done, setDone] = useState<PendingInvitation | null>(null)
  const roles = assignable(store)
  const form = useAppForm({
    defaultValues: {
      name: replaces?.name ?? "",
      phone: replaces?.phone ?? (null as string | null),
      email: replaces?.email ?? "",
      role: replaces?.role ?? ("sales" as StoreRole),
    },
    validators: { onSubmit: inviteSchema },
    onSubmit: async ({ value }) => {
      const { invitation } = await api<{ invitation: PendingInvitation }>(
        `/api/tiendas/${store.id}/invitaciones`,
        {
          method: "POST",
          body: {
            name: value.name.trim(),
            phone: value.phone,
            email: value.email.trim(),
            role: value.role,
            ...(replaces ? { replaces: replaces.id } : {}),
          },
        },
      )
      await refreshTeam(queryClient, store.id)
      setDone({ ...invitation, expired: false, sharedAt: null, sharedBy: null })
    },
  })
  const surface = useFormSurface(form)
  if (done) return <ShareInvitation store={store} invitation={done} onClose={onClose} />
  return (
    <FormDrawer
      {...surface}
      open
      title={replaces ? "Corregir la invitación" : "Invitar al equipo"}
      description={
        replaces
          ? "Cambia lo que estaba mal. Al crearla, la anterior queda anulada y su link deja de servir: envía la nueva."
          : `Le llega por WhatsApp y entra a ${store.name} con su cuenta.`
      }
      onClose={onClose}
      submitLabel="Crear la invitación"
    >
      <form.AppField name="name">
        {(field) => (
          <field.TextField label="Nombre" autoComplete="off" maxLength={80} autoFocus={!replaces} />
        )}
      </form.AppField>
      <form.AppField name="phone">
        {(field) => (
          <field.PhoneField
            label="Celular"
            description="Para enviarle la invitación por WhatsApp."
            defaultCountry={normalizeCountry(store.country) as CountryCode | undefined}
          />
        )}
      </form.AppField>
      <form.AppField name="email">
        {(field) => (
          <field.TextField
            label="Correo con el que entrará"
            description="Entra con la cuenta de este correo. El link solo no basta: así nadie más usa su lugar."
            type="email"
            inputMode="email"
            autoComplete="off"
          />
        )}
      </form.AppField>
      <form.AppField name="role">
        {(field) => (
          <field.Group legend="Rol" description={ROLES[field.state.value].can} id="invite-role">
            {(control) => (
              <RadioChips
                id={control.id}
                value={field.state.value}
                options={roles.map((role) => ({ value: role, label: ROLES[role].name }))}
                onChange={(next) => field.handleChange(next)}
                onBlur={control.onBlur}
                invalid={control.invalid}
                aria-label="Rol"
                aria-describedby={control.describedBy}
              />
            )}
          </field.Group>
        )}
      </form.AppField>
    </FormDrawer>
  )
}

/* ------------------------------------------------------------------------ los repartidores */

/** «S/ 8 por entrega», o que no se le paga por entrega. */
function payText(courier: Courier, currency: string | null): string {
  if (courier.payCents === null || !currency) return "sin pago por entrega"
  const pay = `${money(courier.payCents, currency)} por entrega`
  return courier.failedTripPaid ? pay : `${pay} · el viaje fallido no se paga`
}

/**
 * Quién reparte (tablero 9): los de fuera que la tienda sumó (aquí o al escribir su nombre en
 * Despachos) y las personas del equipo que ya llevaron un pedido, con lo que se le paga por
 * entrega. Se eligen al despachar, en Despachos.
 */
function Couriers({
  store,
  query,
}: {
  store: MyStore
  query: ReturnType<typeof useQuery<{ couriers: Courier[] }, Error>>
}) {
  const [editing, setEditing] = useState<Courier | "nuevo" | null>(null)
  const currency = store.currency
  const add = (
    <Button
      variant="outline"
      size="sm"
      className="max-sm:min-h-11"
      onClick={() => setEditing("nuevo")}
    >
      <Truck aria-hidden />
      Agregar repartidor
    </Button>
  )
  const list = query.data?.couriers ?? []
  return (
    <Card id="repartidores" title="Repartidores" action={list.length > 0 ? add : undefined}>
      {query.isPending ? <LoadingState message="Cargando los repartidores" /> : null}
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data ? (
        list.length > 0 ? (
          <>
            <ul className="-mx-2 flex flex-col">
              {list.map((courier) => (
                <Row
                  key={courier.id}
                  avatar={<PersonAvatar name={courier.name} />}
                  title={courier.name}
                  detail={[
                    courier.team
                      ? "Del equipo"
                      : courier.phone
                        ? internationalText(courier.phone)
                        : "De fuera",
                    payText(courier, currency),
                  ].join(" · ")}
                  side={
                    courier.payCents !== null ? (
                      <span className="font-medium tabular-nums">
                        {money(courier.payCents, currency)}
                      </span>
                    ) : undefined
                  }
                  onOpen={() => setEditing(courier)}
                  openLabel={`Cambiar a ${courier.name}`}
                />
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              Los eliges al despachar, en Despachos. Lo que les pagas lo anotas para saber cuánto
              les debes: gestorIA no les paga.
            </p>
          </>
        ) : (
          <EmptyState
            icon={Truck}
            title="Todavía no tienes repartidores"
            description="Suma a quien lleva tus pedidos, con su celular y lo que le pagas por entrega. Luego lo eliges al despachar, en Despachos."
            actionLabel="Agregar repartidor"
            onAction={() => setEditing("nuevo")}
          />
        )
      ) : null}
      {editing ? (
        <CourierForm
          store={store}
          currency={currency}
          courier={editing === "nuevo" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  )
}

const FAILED_TRIP = [
  { value: "si", label: "El viaje se le paga" },
  { value: "no", label: "No se le paga" },
] as const

/**
 * Sumar o cambiar a un repartidor: de fuera, su nombre, su celular y su pago; del equipo, solo su
 * pago (su nombre es el de su cuenta). Lo de dinero: lo que la tienda le paga por entrega y si el
 * viaje en que la clienta no estaba se le paga igual.
 */
function CourierForm({
  store,
  currency,
  courier,
  onClose,
}: {
  store: MyStore
  currency: string
  courier: Courier | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [added, setAdded] = useState<Courier | null>(null)
  const [removing, setRemoving] = useState(false)
  const team = courier?.team ?? false
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: COURIERS_KEY(store.id) }),
      queryClient.invalidateQueries({ queryKey: ["configuracion-resumen", store.id] }),
      queryClient.invalidateQueries({ queryKey: ["pagos-y-entregas", store.id] }),
    ])
  const schema = z.object({
    name: z.string().trim().min(1, "Escribe su nombre").max(80, "Máximo 80 caracteres"),
    phone: z.string().nullable(),
    pay: z
      .string()
      .refine(
        (text) => text.trim() === "" || readMoney(text, currency) !== null,
        "Escribe el monto, como 8 o 8.50",
      ),
    failedTrip: z.enum(["si", "no"]),
  })
  const form = useAppForm({
    defaultValues: {
      name: courier?.name ?? "",
      phone: courier?.phone ?? null,
      pay: moneyInput(courier?.payCents ?? null, currency),
      failedTrip: (courier?.failedTripPaid ?? true) ? "si" : "no",
    } as { name: string; phone: string | null; pay: string; failedTrip: "si" | "no" },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const pay = {
        payCents: value.pay.trim() === "" ? null : readMoney(value.pay, currency),
        failedTripPaid: value.failedTrip === "si",
      }
      const body = team ? pay : { name: value.name.trim(), phone: value.phone, ...pay }
      if (courier) {
        await api(`/api/tiendas/${store.id}/repartidores/${courier.id}`, { method: "PATCH", body })
        await refresh()
        toast.success(`Guardado: ${courier.name}`)
        onClose()
        return
      }
      const created = await api<{ courier: Courier }>(`/api/tiendas/${store.id}/repartidores`, {
        method: "POST",
        body,
      })
      await refresh()
      setAdded(created.courier)
    },
  })
  const surface = useFormSurface(form)
  const remove = useMutation({
    mutationFn: () =>
      api<{ unassigned: number }>(`/api/tiendas/${store.id}/repartidores/${courier?.id}`, {
        method: "DELETE",
      }),
    onSuccess: async ({ unassigned }) => {
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: ["despachos", store.id] }),
      ])
      toast.success(
        unassigned > 0
          ? `${courier?.name} ya no reparte. ${unassigned === 1 ? "Un pedido quedó" : `${unassigned} pedidos quedaron`} sin repartidor en Despachos.`
          : `${courier?.name} ya no reparte para tu tienda.`,
      )
      setRemoving(false)
      onClose()
    },
  })
  if (added)
    return <ShareCourier store={store} courier={added} currency={currency} onClose={onClose} />
  return (
    <>
      <FormDrawer
        {...surface}
        open
        title={courier ? courier.name : "Agregar repartidor"}
        description={
          team
            ? "Es de tu equipo: aquí anotas lo que le pagas por entrega."
            : "Su nombre, su celular y lo que le pagas por entrega."
        }
        onClose={onClose}
        submitLabel={courier ? "Guardar" : "Agregar repartidor"}
        secondaryAction={
          courier && !team ? { label: "Sacar", onClick: () => setRemoving(true) } : undefined
        }
      >
        {team ? null : (
          <>
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label="Nombre"
                  autoComplete="off"
                  maxLength={80}
                  autoFocus={!courier}
                />
              )}
            </form.AppField>
            <form.AppField name="phone">
              {(field) => (
                <field.PhoneField
                  label="Celular"
                  description="Para escribirle por WhatsApp."
                  defaultCountry={normalizeCountry(store.country) as CountryCode | undefined}
                />
              )}
            </form.AppField>
          </>
        )}
        <form.AppField name="pay">
          {(field) => (
            <field.Control
              label="Le pagas por entrega"
              description="Déjalo vacío si no le pagas por entrega. Es para que sepas cuánto le debes: gestorIA no le paga."
            >
              {(control) => (
                <MoneyInput
                  control={control}
                  currency={currency}
                  value={field.state.value}
                  onChange={field.handleChange}
                  placeholder="0"
                  className="max-w-40"
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="failedTrip">
          {(field) => (
            <field.Group legend="Si la clienta no estaba" id="courier-failed-trip">
              {(control) => (
                <RadioChips
                  id={control.id}
                  value={field.state.value}
                  options={[...FAILED_TRIP]}
                  onChange={(next) => field.handleChange(next)}
                  onBlur={control.onBlur}
                  aria-label="Si la clienta no estaba"
                  aria-describedby={control.describedBy}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
      </FormDrawer>
      <ConfirmDialog
        open={removing}
        title={`¿Sacar a ${courier?.name}?`}
        description="Deja de aparecer en Despachos. Lo que tiene asignado y todavía no salió queda «sin repartidor»; lo que ya va en camino sigue con él. Lo que llevó y cobró sigue con su nombre."
        confirmLabel="Sacar"
        variant="destructive"
        pending={remove.isPending}
        error={remove.isError ? submitErrorMessage(remove.error) : null}
        onConfirm={() => remove.mutate()}
        onClose={() => {
          setRemoving(false)
          remove.reset()
        }}
      />
    </>
  )
}

/**
 * Avisarle al repartidor que ya está (tablero 9): el mensaje por WhatsApp desde este celular, que
 * envía la persona. Su app, gestorIA Reparto, todavía no existe: el mensaje no lleva link.
 */
function ShareCourier({
  store,
  courier,
  currency,
  onClose,
}: {
  store: MyStore
  courier: Courier
  currency: string
  onClose: () => void
}) {
  const pay =
    courier.payCents !== null ? ` Te pago ${money(courier.payCents, currency)} por entrega.` : ""
  const text = `Hola ${firstName(courier.name)}, te sumé como repartidor de ${store.name}.${pay} Te escribo por aquí cuando tengas entregas.`
  return (
    <DetailDrawer
      open
      title={`${courier.name} ya reparte para tu tienda`}
      description="Ya lo puedes elegir al despachar, en Despachos. Si quieres, avísale por WhatsApp: se abre tu WhatsApp con el mensaje y lo envías tú."
      onClose={onClose}
      closeLabel="Listo"
      actions={
        courier.phone ? (
          <Button
            className="min-h-11"
            render={
              // biome-ignore lint/a11y/useAnchorContent: el texto va dentro del botón.
              <a href={whatsappHref(courier.phone, text)} target="_blank" rel="noreferrer" />
            }
          >
            <MessageCircle aria-hidden />
            Enviar por WhatsApp
          </Button>
        ) : undefined
      }
    >
      <MessagePreview text={text} to={courier.phone} />
    </DetailDrawer>
  )
}

/* ------------------------------------------------------------------ soporte de gestorIA */

/**
 * Soporte de gestorIA (ADR 0214 y 0219): lo que pide la administración para mirar la tienda y lo
 * que pasó. Aquí se responde el pedido que la franja de arriba avisa en toda la tienda. Dejarlo
 * entrar, no hacerlo o sacarlo es del Dueño o un Administrador; se ve también quién miró,
 * cuándo, quién lo aceptó y cómo terminó.
 */
function SupportAccessPanel({ store, team }: { store: MyStore; team: Team }) {
  const queryClient = useQueryClient()
  const { meId } = useStoreContext()
  const canManage = store.permissions.includes("equipo.gestionar")
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "aceptar" | "rechazar" | "quitar" }) =>
      api(`/api/tiendas/${store.id}/soporte/${id}/${action}`, { method: "POST" }),
    onSuccess: async (_, { action }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TEAM_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: ["configuracion-resumen", store.id] }),
      ])
      toast.success(
        action === "aceptar"
          ? "Listo: soporte ya puede mirar tu tienda."
          : action === "quitar"
            ? "Soporte ya no puede mirar tu tienda."
            : "Listo: soporte no entra. Si te equivocaste, pide ayuda otra vez y soporte lo vuelve a pedir.",
      )
    },
    onError: (error) => toast.error(error.message),
  })
  const rows = team.support
  if (rows.length === 0) return null
  return (
    <Card id="soporte-gestoria" title="Soporte de gestorIA">
      <ul className="flex flex-col divide-y">
        {rows.map((row) => {
          const line = supportLine(row, meId)
          const sees = `Verá tu tienda, tu catálogo sin costos y tu equipo (nombres, correos y roles). No ve tus pedidos ni tus conversaciones, y no cambia nada. Los ${row.minutes} minutos empiezan cuando la dejas entrar. Este pedido solo lo puede hacer el equipo de gestorIA.`
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
              <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
                <span className="font-medium">{line.title}</span>
                {line.detail ? <span className="text-muted-foreground">{line.detail}</span> : null}
                {row.status === "por_aceptar" ? (
                  <>
                    <span className="max-sm:hidden">{sees}</span>
                    {/* En el celular se pliega para no empujar lo que se estaba haciendo. */}
                    <details className="sm:hidden">
                      <summary className="flex min-h-11 cursor-pointer items-center font-medium">
                        Qué verá
                      </summary>
                      <p>{sees}</p>
                    </details>
                  </>
                ) : null}
              </div>
              {row.status === "por_aceptar" ? <Badge variant="outline">Pide entrar</Badge> : null}
              {row.status === "vigente" ? (
                <Badge variant="outline">{row.usedAt ? "Mirando" : "Puede mirar"}</Badge>
              ) : null}
              {canManage && row.status === "por_aceptar" ? (
                <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto sm:gap-2">
                  <Button
                    className="max-sm:h-12"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: row.id, action: "aceptar" })}
                  >
                    Dejar entrar
                  </Button>
                  <Button
                    variant="outline"
                    className="max-sm:h-12"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: row.id, action: "rechazar" })}
                  >
                    No
                  </Button>
                </div>
              ) : null}
              {canManage && row.status === "vigente" ? (
                <Button
                  variant="outline"
                  className="max-sm:h-12"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: row.id, action: "quitar" })}
                >
                  Sacar ahora
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
