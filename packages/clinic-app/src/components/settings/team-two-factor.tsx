import { Badge, Button, Skeleton, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  ConfirmDialog,
  FormDrawer,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { panelUrl } from "../../lib/host"
import { appRoleLabel } from "../../lib/product-words"

/**
 * Configuración › Equipo › verificación en dos pasos (ADR 0107): si la clínica
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
    onError: (error) => toast.error(submitErrorMessage(error)),
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
  const form = useAppForm({
    defaultValues: { notify: true },
    onSubmit: async ({ value }) => {
      const { data } = await apiFetch<{ data: { notified: number } }>("/api/team/two-factor", {
        method: "PUT",
        body: JSON.stringify({ required: true, notify: value.notify }),
      })
      toast.success(
        data.notified > 0
          ? `Listo: el equipo entra con verificación en dos pasos. Avisamos por correo a ${data.notified === 1 ? "1 persona" : `${data.notified} personas`}.`
          : "Listo: el equipo entra con verificación en dos pasos.",
      )
      await queryClient.invalidateQueries({ queryKey: TEAM_TWO_FACTOR_KEY })
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Pedir verificación en dos pasos"
      description="Desde ahora nadie del equipo entra a la clínica solo con su contraseña: también con el código de una app de su teléfono."
      onSubmit={(event) => {
        // Sin tenerla uno mismo no se pide: el pie lo dice y no hay nada que enviar.
        if (meEnabled) surface.onSubmit(event)
        else event.preventDefault()
      }}
      submitDisabled={!meEnabled}
      submitLabel="Pedirla desde ahora"
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
                En su próxima acción en la clínica les pediremos activarla antes de seguir. Sus otras clínicas no cambian.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground">Todo el equipo ya la tiene activa: nadie notará el cambio.</p>
          )}
          {missing.length > 0 ? (
            <form.AppField name="notify">
              {(field) => (
                <field.CheckboxField
                  id="notify-two-factor"
                  label="Avisarles ahora por correo"
                  description="Con los pasos y la app que necesitan, para que no los tome por sorpresa en plena atención."
                />
              )}
            </form.AppField>
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

/** El motivo: los mismos límites que la ruta, con el mínimo dicho. */
const resetSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Escribe el motivo con al menos 3 caracteres.")
    .max(500, "Escribe el motivo en 500 caracteres como mucho."),
})

/** Restablecer la de alguien que perdió el teléfono y sus códigos, con su motivo. */
export function ResetTwoFactorDialog({ member, onClose }: { member: { userId: string; name: string } | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: resetSchema },
    onSubmit: async ({ value }) => {
      if (!member) return
      await apiFetch(`/api/team/two-factor/${encodeURIComponent(member.userId)}/reset`, {
        method: "POST",
        body: JSON.stringify({ reason: value.reason.trim() }),
      })
      toast.success(`Verificación de ${member.name} restablecida: la activará de nuevo al entrar`)
      await queryClient.invalidateQueries({ queryKey: TEAM_TWO_FACTOR_KEY })
      close()
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const close = () => {
    form.reset()
    onClose()
  }
  return (
    <ConfirmDialog
      open={member !== null}
      onClose={close}
      onConfirm={() => void submitForm(form)}
      title={`Restablecer la verificación de ${member?.name ?? ""}`}
      description={`Úsalo solo si ${member?.name ?? ""} perdió su teléfono y sus códigos de respaldo, y lo confirmaste en persona o por teléfono. Se borran su app vinculada y sus códigos, se cierran sus sesiones, y al entrar la activará de nuevo. Queda en Actividad del equipo con tu nombre y el motivo.`}
      confirmLabel="Restablecer"
      pending={pending}
      error={error}
    >
      <form.AppField name="reason">
        {(field) => <field.TextareaField id="reset-two-factor-reason" label="Motivo" maxLength={500} />}
      </form.AppField>
    </ConfirmDialog>
  )
}
