import { Badge, Button, FieldGroup, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  ErrorState,
  FormDrawer,
  LoadingState,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { z } from "zod"
import { api } from "./lib/api"
import { when } from "./lib/pedidos"

/**
 * «Link de pago» en Pagos y entregas (tablero 14): la tienda conecta su propia cuenta de
 * Mercado Pago y Sofi (o el equipo) cobra con un link que se confirma solo. El token se guarda
 * cifrado y nunca vuelve a la pantalla: aquí solo se ve si está conectado.
 */

interface LinkStatus {
  available: boolean
  connection: {
    provider: "mercadopago"
    hint: string
    signed: boolean
    connectedAt: string
    connectedByName: string | null
  } | null
}

const KEY = (storeId: string) => ["link-de-pago", storeId]

export function PaymentLinkSection({ storeId, canEdit }: { storeId: string; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: KEY(storeId),
    queryFn: () => api<LinkStatus>(`/api/tiendas/${storeId}/link-de-pago`),
  })
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const remove = useMutation({
    mutationFn: () => api(`/api/tiendas/${storeId}/link-de-pago`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEY(storeId) })
      setRemoving(false)
      toast.success("Link de pago desconectado")
    },
  })
  const id = useId()
  const connection = status.data?.connection
  return (
    <section aria-labelledby={id} className="elevated overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <h3 id={id} className="text-base font-semibold">
            Link de pago
          </h3>
          <p className="text-sm text-muted-foreground">
            Lo primero con que se cobra: el cliente paga en línea y el pedido pasa a pagado solo.
          </p>
        </div>
        {canEdit && status.data?.available ? (
          <Button variant={connection ? "outline" : "default"} onClick={() => setEditing(true)}>
            {connection ? "Cambiar la cuenta" : "Conectar Mercado Pago"}
          </Button>
        ) : null}
      </div>
      <div className="px-5 py-4 text-sm">
        {status.isPending ? (
          <LoadingState message="Mirando si está conectado…" />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        ) : !status.data.available ? (
          <p className="text-muted-foreground">
            El link de pago todavía no está disponible en gestorIA. Mientras tanto, cobra con
            captura o al recibir.
          </p>
        ) : connection ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 font-medium">
                Mercado Pago <Badge variant="success">Conectado</Badge>
              </span>
              <span className="text-muted-foreground">
                Token que termina en «{connection.hint}» · conectado
                {connection.connectedByName ? ` por ${connection.connectedByName}` : ""} el{" "}
                {when(connection.connectedAt)}
                {connection.signed ? " · los avisos se comprueban con tu clave" : ""}
              </span>
            </div>
            {canEdit ? (
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => setRemoving(true)}
              >
                Desconectar
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground">
            {canEdit
              ? "Sin conectar. Conecta la cuenta de Mercado Pago de la tienda: el dinero llega directo a ella."
              : "Sin conectar. Lo conecta el dueño o un administrador."}
          </p>
        )}
      </div>
      {editing ? <ConnectSheet storeId={storeId} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog
        open={removing}
        variant="destructive"
        title="Desconectar Mercado Pago"
        description="Ya no se podrán crear links de pago. Los links que ya enviaste dejan de confirmarse solos: esos pagos los revisas a mano."
        confirmLabel="Desconectar"
        cancelLabel="Volver"
        pending={remove.isPending}
        error={remove.isError ? submitErrorMessage(remove.error) : null}
        onConfirm={() => remove.mutate()}
        onClose={() => setRemoving(false)}
      />
    </section>
  )
}

function ConnectSheet({ storeId, onClose }: { storeId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (value: { accessToken: string; webhookSecret: string }) =>
      api<LinkStatus>(`/api/tiendas/${storeId}/link-de-pago`, {
        method: "PATCH",
        body: { provider: "mercadopago", ...value },
      }),
  })
  const form = useAppForm({
    defaultValues: { accessToken: "", webhookSecret: "" },
    validators: {
      // Lo demás del token (largo, sin espacios) lo dice el servidor, que además lo prueba con
      // Mercado Pago: aquí solo que no se envíe vacío.
      onSubmit: z.object({
        accessToken: z.string().trim().min(1, "Pega el «Access token» completo"),
        webhookSecret: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      const data = await save.mutateAsync(value)
      queryClient.setQueryData(KEY(storeId), data)
      toast.success("Mercado Pago conectado")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Conectar Mercado Pago"
      description="Con la cuenta de la tienda: el dinero de cada link llega directo a ella."
      onClose={onClose}
      submitLabel="Conectar"
    >
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          En Mercado Pago, entra a «Tus integraciones», abre tu aplicación y copia sus credenciales
          de producción.
        </p>
        <form.AppField name="accessToken">
          {(field) => (
            <field.TextField
              label="Access token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              description="Empieza con «APP_USR-». Lo comprobamos con Mercado Pago antes de guardarlo, y se guarda cifrado: nadie lo vuelve a ver."
            />
          )}
        </form.AppField>
        <form.AppField name="webhookSecret">
          {(field) => (
            <field.TextField
              label="Clave secreta de las notificaciones (opcional)"
              type="password"
              autoComplete="off"
              spellCheck={false}
              description="En «Webhooks» de tu aplicación. Con ella, además, cada aviso de pago se comprueba con su firma. Sin ella también funciona: el pago siempre se consulta a Mercado Pago."
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}
