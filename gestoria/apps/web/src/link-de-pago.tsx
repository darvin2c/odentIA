import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  toast,
} from "@odentia/ui"
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { api } from "./lib/api"
import { when } from "./lib/pedidos"
import { FormAlert, FormSheet, fieldErrors, useDirty } from "./piezas"

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
          <p className="text-muted-foreground">Cargando…</p>
        ) : status.isError ? (
          <FormAlert error={status.error} />
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
        error={remove.isError ? remove.error.message : null}
        onConfirm={() => remove.mutate()}
        onClose={() => setRemoving(false)}
      />
    </section>
  )
}

function ConnectSheet({ storeId, onClose }: { storeId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [accessToken, setAccessToken] = useState("")
  const [webhookSecret, setWebhookSecret] = useState("")
  const dirty = useDirty({ accessToken, webhookSecret })
  const save = useMutation({
    mutationFn: () =>
      api<LinkStatus>(`/api/tiendas/${storeId}/link-de-pago`, {
        method: "PATCH",
        body: { provider: "mercadopago", accessToken, webhookSecret },
      }),
    onSuccess: async (data) => {
      queryClient.setQueryData(KEY(storeId), data)
      toast.success("Mercado Pago conectado")
      onClose()
    },
  })
  const errors = fieldErrors(save.error)
  const tokenId = useId()
  const secretId = useId()
  return (
    <FormSheet
      open
      title="Conectar Mercado Pago"
      description="Con la cuenta de la tienda: el dinero de cada link llega directo a ella."
      onClose={onClose}
      onSubmit={() => save.mutate()}
      dirty={dirty}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={save.isPending}>
            Conectar
          </SubmitButton>
        </>
      }
    >
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          En Mercado Pago, entra a «Tus integraciones», abre tu aplicación y copia sus credenciales
          de producción.
        </p>
        <Field data-invalid={errors.accessToken ? true : undefined}>
          <FieldLabel htmlFor={tokenId}>Access token</FieldLabel>
          <Input
            id={tokenId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            aria-invalid={errors.accessToken ? true : undefined}
            autoFocus
          />
          {errors.accessToken ? (
            <FieldError>{errors.accessToken}</FieldError>
          ) : (
            <FieldDescription>
              Empieza con «APP_USR-». Lo comprobamos con Mercado Pago antes de guardarlo, y se
              guarda cifrado: nadie lo vuelve a ver.
            </FieldDescription>
          )}
        </Field>
        <Field data-invalid={errors.webhookSecret ? true : undefined}>
          <FieldLabel htmlFor={secretId}>Clave secreta de las notificaciones (opcional)</FieldLabel>
          <Input
            id={secretId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            aria-invalid={errors.webhookSecret ? true : undefined}
          />
          {errors.webhookSecret ? (
            <FieldError>{errors.webhookSecret}</FieldError>
          ) : (
            <FieldDescription>
              En «Webhooks» de tu aplicación. Con ella, además, cada aviso de pago se comprueba con
              su firma. Sin ella también funciona: el pago siempre se consulta a Mercado Pago.
            </FieldDescription>
          )}
        </Field>
        <FormAlert error={save.error} />
      </FieldGroup>
    </FormSheet>
  )
}
