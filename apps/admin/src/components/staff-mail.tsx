/**
 * La dirección de correo de cada persona del equipo en Equipo: con qué parte
 * local escribe en las tres marcas («ada.lovelace@» en odentIA, latidIA y
 * vistIA), a dónde le llega la copia de lo que le escriben, y «Su correo»
 * para que Administración lo corrija (`POST /api/admin/access/team/:id/mail`).
 * La dirección cambia solo mientras no haya salido nada con ella; después se
 * ve fija con su motivo (las clínicas responden ahí). Lo valida el servidor:
 * aquí solo se muestra lo que dice, junto a su campo.
 */
import { Button, toast } from "@odentia/ui"
import { common, FormDrawer, PageNotice, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../lib/api"
import { supportDay } from "../lib/support-words"

/** Lo que Equipo trae de la dirección de cada persona. */
export interface StaffMailRow {
  userId: string
  name: string
  email: string
  mailLocal?: string | null
  mailCopyTo?: string | null
  mailFirstSentAt?: string | null
}

const BRANDS = "odentIA, latidIA y vistIA"

/** Las líneas de la fila: con qué escribe y a dónde le llega la copia. */
export function StaffMailLine({ row }: { row: StaffMailRow }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <p className="[overflow-wrap:anywhere]">
        {row.mailLocal ? (
          <>
            Escribe como <span className="font-medium text-foreground">{row.mailLocal}@</span> (
            {BRANDS})
            {row.mailFirstSentAt ? ` · fija desde el ${supportDay(row.mailFirstSentAt)}` : ""}
          </>
        ) : (
          "Sin dirección propia: sus correos salen desde hola@"
        )}
      </p>
      {row.mailCopyTo ? (
        <p className="[overflow-wrap:anywhere]">Copia de lo que le escriben a {row.mailCopyTo}</p>
      ) : null}
    </div>
  )
}

/** El botón de la fila (solo Administración). */
export function StaffMailButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick}>
      Su correo
    </Button>
  )
}

const mailSchema = z.object({
  mailLocal: z.string().trim().min(2, "Entre 2 y 64 caracteres").max(64, "Entre 2 y 64 caracteres"),
  copyTo: z.union([
    z.literal(""),
    z.email("Escribe un correo válido, como nombre@gmail.com").max(254),
  ]),
})

/**
 * «Su correo»: la parte local (mientras no haya salido nada con ella) y la
 * copia. Solo manda lo que cambió; un 409 dice el motivo junto a su campo.
 */
export function StaffMailDrawer({ row, onClose }: { row: StaffMailRow; onClose: () => void }) {
  const queryClient = useQueryClient()
  const fixed = Boolean(row.mailFirstSentAt && row.mailLocal)
  const form = useAppForm({
    defaultValues: { mailLocal: row.mailLocal ?? "", copyTo: row.mailCopyTo ?? "" },
    // Fija, el campo no se muestra y su valor es el de hoy: la misma validación vale.
    validators: { onSubmit: mailSchema },
    onSubmit: async ({ value, formApi }) => {
      const mailLocal = value.mailLocal.trim().toLowerCase()
      const copyTo = value.copyTo.trim().toLowerCase()
      const body = {
        ...(!fixed && mailLocal !== (row.mailLocal ?? "") ? { mailLocal } : {}),
        ...(copyTo !== (row.mailCopyTo ?? "") ? { copyTo } : {}),
      }
      if (Object.keys(body).length > 0) {
        await api(`/api/admin/access/team/${encodeURIComponent(row.userId)}/mail`, {
          method: "POST",
          body: JSON.stringify(body),
        })
        void queryClient.invalidateQueries({ queryKey: ["admin-team"] })
        toast.success("Guardado")
      }
      formApi.reset(value)
      onClose()
    },
  })
  return (
    <FormDrawer
      {...useFormSurface(form)}
      open
      onClose={onClose}
      title="Su correo"
      description={row.name || row.email}
      submitLabel="Guardar"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        {fixed ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Escribe como {row.mailLocal}@</p>
            <p className="text-muted-foreground">
              Ya salieron correos con esta dirección (desde el{" "}
              {supportDay(row.mailFirstSentAt ?? "")}): las clínicas responden ahí, así que no
              cambia.
            </p>
          </div>
        ) : (
          <form.AppField name="mailLocal">
            {(field) => (
              <field.TextField
                id="correo-direccion"
                label="Dirección"
                description={`Lo que va antes de la @, igual en ${BRANDS}. Letras sin tildes y números, con un punto, guion o guion bajo entre ellos. Después del primer correo que salga, queda fija.`}
                maxLength={64}
                autoComplete="off"
                autoFocus
              />
            )}
          </form.AppField>
        )}
        <form.AppField name="copyTo">
          {(field) => (
            <field.TextField
              id="correo-copia"
              label="Copia a (opcional)"
              description="Le llega una copia de lo que le escriben a su dirección. Vacío, sin copia."
              type="email"
              maxLength={254}
              autoComplete="off"
              autoFocus={fixed}
            />
          )}
        </form.AppField>
        <PageNotice tone="aviso" label="Para que la copia llegue">
          Ese correo tiene que estar verificado en Cloudflare (Email Routing › Direcciones de
          destino). Si no lo está, la copia no le llega; el correo igual entra al ARM.
        </PageNotice>
      </div>
    </FormDrawer>
  )
}
