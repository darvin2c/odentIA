import { Badge, Button, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, DetailField, DetailList, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { DISCONNECT_CONSEQUENCE, INTEGRATIONS, type MailRow } from "../../lib/integrations"

const STATUS_BADGE = { ok: "soft", off: "secondary", attention: "warning" } as const

/**
 * Detalle de un buzón conectado (Gmail o Microsoft 365): con qué cuenta está,
 * cómo está y lo que se puede hacer. Volver a conectar inicia la autorización
 * del proveedor; nunca se escribe una clave aquí.
 */
export function MailPanel({
  row,
  canManage,
  connecting,
  onConnect,
  onClose,
}: {
  row: MailRow
  canManage: boolean
  /** La autorización ya se está iniciando: se va a salir de la página. */
  connecting: boolean
  onConnect: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const name = INTEGRATIONS[row.provider].name
  const connection = row.connection
  const [confirming, setConfirming] = useState(false)
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mail"] }),
      queryClient.invalidateQueries({ queryKey: ["connections"] }),
    ])
  }

  const test = useMutation({
    mutationFn: () => apiFetch<{ data: { emailAddress?: string } }>(`/api/mail/${connection?.id}/test`, { method: "POST" }),
    onSuccess: ({ data }) => {
      setTested({ ok: true, text: data.emailAddress ? `Funciona. Respondió ${data.emailAddress}.` : "Funciona. El buzón respondió." })
      void refresh()
    },
    onError: () => {
      // El motivo del proveedor no llega a la pantalla: se dice qué hacer.
      setTested({ ok: false, text: "El buzón no respondió. Puede que haga falta volver a conectarlo." })
      void refresh()
    },
  })

  const disconnect = useMutation({
    mutationFn: () => apiFetch(`/api/mail/${connection?.id}/disconnect`, { method: "POST" }),
    onSuccess: async () => {
      await refresh()
      setConfirming(false)
      toast.success(`${name} quedó desconectado`)
      onClose()
    },
  })
  const disconnectError = disconnect.isError ? submitErrorMessage(disconnect.error) : null

  const needsReconnect = connection !== null && row.tone === "attention"

  return (
    <>
      <DetailDrawer
        open
        onClose={onClose}
        title={name}
        description={INTEGRATIONS[row.provider].purpose}
        // Con «Desconectar» abierto, su error se dice en el diálogo (no detrás).
        error={confirming ? null : disconnectError}
        actions={
          canManage && row.available && needsReconnect ? (
            <Button type="button" disabled={connecting} onClick={onConnect}>
              {connecting ? "Abriendo…" : "Volver a conectar"}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-5">
          <DetailList columns={1}>
            {row.detail.kind === "account" ? <DetailField label="Buzón">{row.detail.account}</DetailField> : null}
            <DetailField label="Estado">
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={STATUS_BADGE[row.tone]}>{row.status}</Badge>
                {row.detail.kind === "account" && row.detail.activity ? <span>{row.detail.activity}</span> : null}
              </span>
            </DetailField>
          </DetailList>
          {row.problem ? <p className="text-sm font-semibold text-warning">{row.problem}</p> : null}
          {connection && canManage ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? "Probando…" : "Probar"}
                </Button>
                <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
                  Desconectar
                </Button>
              </div>
              {tested ? (
                <p role="status" className={tested.ok ? "text-sm font-medium text-success" : "text-sm font-medium text-destructive"}>
                  {tested.text}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </DetailDrawer>

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false)
          disconnect.reset()
        }}
        onConfirm={() => disconnect.mutate()}
        title={`Desconectar ${name}`}
        description={DISCONNECT_CONSEQUENCE[row.provider]}
        confirmLabel="Desconectar"
        pending={disconnect.isPending}
        error={disconnectError}
      />
    </>
  )
}
