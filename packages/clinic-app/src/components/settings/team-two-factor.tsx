import { Badge, Button, Checkbox, Field, FieldError, FieldLabel, Input, Skeleton, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ConfirmDialog, common, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { panelUrl } from "../../lib/host"
import { appRoleLabel } from "../../lib/product-words"

/**
 * Configuración › Equipo › verificación en dos pasos (ADR 0106): si la clínica
 * la pide a todo su equipo, quién la tiene y restablecer la de alguien. Lo que
 * se ve sale de `/api/team/two-factor`; el servidor decide quién puede cambiarlo.
 */
export interface TeamTwoFactorMember {
  userId: string
  name: string
  email: string
  role: string
  enabled: boolean
}
interface TeamTwoFactor {
  required: boolean
  members: TeamTwoFactorMember[]
}
export const TEAM_TWO_FACTOR_KEY = ["team-two-factor"] as const

export function useTeamTwoFactor(enabled: boolean) {
  return useQuery({
    queryKey: TEAM_TWO_FACTOR_KEY,
    queryFn: async () => (await apiFetch<{ data: TeamTwoFactor }>("/api/team/two-factor")).data,
    enabled,
  })
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? (error.shape.message ?? common.errors.generic) : common.errors.generic
}

/** Lo que dice la columna de cada persona: con palabras, no solo con color. */
export function TwoFactorBadge({ enabled }: { enabled: boolean | undefined }) {
  if (enabled === undefined) return <span className="text-muted-foreground">—</span>
  return enabled ? (
    <Badge className="bg-primary-soft text-primary-soft-foreground">Activa</Badge>
  ) : (
    <Badge variant="secondary">Sin activar</Badge>
  )
}

/** La tarjeta de arriba de Equipo con el interruptor. */
export function TeamTwoFactorCard({ canManage, myUserId }: { canManage: boolean; myUserId: string }) {
  const queryClient = useQueryClient()
  const query = useTeamTwoFactor(true)
  const [asking, setAsking] = useState(false)
  const turnOff = useMutation({
    mutationFn: () => apiFetch("/api/team/two-factor", { method: "PUT", body: JSON.stringify({ required: false }) }),
    onSuccess: async () => {
      toast.success("El equipo ya no tiene que usarla")
      await queryClient.invalidateQueries({ queryKey: TEAM_TWO_FACTOR_KEY })
    },
    onError: (error) => toast.error(errorText(error)),
  })
  if (query.isPending) return <Skeleton className="h-20 w-full rounded-xl" />
  if (query.isError) return null
  const { required, members } = query.data
  const active = members.filter((member) => member.enabled).length
  const missing = members.filter((member) => !member.enabled)
  const me = members.find((member) => member.userId === myUserId)
  return (
    <section aria-labelledby="team-two-factor" className="flex items-center justify-between gap-6 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 id="team-two-factor" className="font-heading text-base font-medium">
          Pedir verificación en dos pasos a todo el equipo
        </h2>
        <p id="team-two-factor-state" className="text-sm text-muted-foreground">
          {required
            ? missing.length === 0
              ? "Encendido: todo el equipo entra con el código de su app."
              : `Encendido: ${missing.length === 1 ? "a 1 persona le falta" : `a ${missing.length} personas les falta`} activarla; se le pide al entrar.`
            : `Apagado: cada persona decide. ${active} de ${members.length} ya la ${active === 1 ? "tiene" : "tienen"} activa.`}
        </p>
      </div>
      {canManage ? (
        <Switch
          aria-labelledby="team-two-factor"
          aria-describedby="team-two-factor-state"
          checked={required}
          disabled={turnOff.isPending}
          onCheckedChange={(checked) => {
            if (checked) setAsking(true)
            else turnOff.mutate()
          }}
        />
      ) : null}
      {asking ? <RequireTwoFactorDrawer missing={missing} meEnabled={me?.enabled === true} onClose={() => setAsking(false)} /> : null}
    </section>
  )
}

/** Antes de pedirla: a quién le falta y qué le pasará. Quien la pide, ya la tiene. */
function RequireTwoFactorDrawer({ missing, meEnabled, onClose }: { missing: TeamTwoFactorMember[]; meEnabled: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [notify, setNotify] = useState(true)
  const save = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { notified: number } }>("/api/team/two-factor", { method: "PUT", body: JSON.stringify({ required: true, notify }) }),
    onSuccess: async ({ data }) => {
      toast.success(
        data.notified > 0
          ? `Listo: el equipo entra con verificación en dos pasos. Avisamos por correo a ${data.notified === 1 ? "1 persona" : `${data.notified} personas`}.`
          : "Listo: el equipo entra con verificación en dos pasos.",
      )
      await queryClient.invalidateQueries({ queryKey: TEAM_TWO_FACTOR_KEY })
      onClose()
    },
  })
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Pedir verificación en dos pasos"
      description="Desde ahora nadie del equipo entra a la clínica solo con su contraseña: también con el código de una app de su teléfono."
      onSubmit={(event) => {
        event.preventDefault()
        if (meEnabled) save.mutate()
      }}
      isSubmitting={save.isPending}
      submitDisabled={!meEnabled}
      submitLabel="Pedirla desde ahora"
      error={save.isError ? errorText(save.error) : null}
    >
      {meEnabled ? (
        <div className="flex flex-col gap-5 text-sm">
          {missing.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-[15px] font-semibold">
                {missing.length === 1 ? "A 1 persona le falta activarla" : `A ${missing.length} personas les falta activarla`}
              </h3>
              <ul className="divide-y rounded-xl border">
                {missing.map((member) => (
                  <li key={member.userId} className="flex justify-between gap-3 px-3.5 py-2.5">
                    <span className="font-medium">{member.name}</span>
                    <span className="text-muted-foreground">{appRoleLabel(member.role)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                En su próxima acción en la clínica les pediremos activarla antes de seguir. No pierden lo que tengan a medias ni su sesión en otras clínicas.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground">Todo el equipo ya la tiene activa: nadie notará el cambio.</p>
          )}
          {missing.length > 0 ? (
            <div className="flex items-start gap-2.5">
              <Checkbox id="notify-two-factor" className="mt-0.5" checked={notify} onCheckedChange={(checked) => setNotify(checked === true)} />
              <label htmlFor="notify-two-factor" className="flex flex-col gap-0.5">
                <span className="font-medium">Avisarles ahora por correo</span>
                <span className="text-muted-foreground">Con los pasos y la app que necesitan, para que no los tome por sorpresa en plena atención.</span>
              </label>
            </div>
          ) : null}
          <p className="rounded-xl bg-muted px-3.5 py-3 text-muted-foreground">Se puede apagar cuando quieras y queda en Actividad del equipo.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p>Primero actívala tú: no se pide al equipo lo que uno mismo no tiene.</p>
          <Button className="self-start" render={<a href={panelUrl("/profile?edit=two-factor")} />}>
            Activarla en Mi perfil
          </Button>
        </div>
      )}
    </FormDrawer>
  )
}

/** Restablecer la de alguien que perdió el teléfono y sus códigos, con su motivo. */
export function ResetTwoFactorDialog({ member, onClose }: { member: { userId: string; name: string } | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState("")
  const [touched, setTouched] = useState(false)
  const reset = useMutation({
    mutationFn: (target: { userId: string }) =>
      apiFetch(`/api/team/two-factor/${encodeURIComponent(target.userId)}/reset`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }),
    onSuccess: async () => {
      toast.success(`Verificación de ${member?.name ?? ""} restablecida: la activará de nuevo al entrar`)
      await queryClient.invalidateQueries({ queryKey: TEAM_TWO_FACTOR_KEY })
      close()
    },
  })
  const close = () => {
    setReason("")
    setTouched(false)
    reset.reset()
    onClose()
  }
  const short = reason.trim().length < 3
  return (
    <ConfirmDialog
      open={member !== null}
      onClose={close}
      onConfirm={() => {
        setTouched(true)
        if (member && !short) reset.mutate(member)
      }}
      title={`Restablecer la verificación de ${member?.name ?? ""}`}
      description={`Úsalo solo si ${member?.name ?? ""} perdió su teléfono y sus códigos de respaldo, y lo confirmaste en persona o por teléfono. Se borran su app vinculada y sus códigos, se cierran sus sesiones, y al entrar la activará de nuevo. Queda en Actividad del equipo con tu nombre y el motivo.`}
      confirmLabel="Restablecer"
      pending={reset.isPending}
      error={reset.isError ? errorText(reset.error) : null}
    >
      <Field>
        <FieldLabel htmlFor="reset-two-factor-reason">Motivo</FieldLabel>
        <Input
          id="reset-two-factor-reason"
          value={reason}
          aria-invalid={touched && short ? true : undefined}
          aria-describedby={touched && short ? "reset-two-factor-reason-error" : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
        {touched && short ? <FieldError id="reset-two-factor-reason-error">Escribe el motivo</FieldError> : null}
      </Field>
    </ConfirmDialog>
  )
}
