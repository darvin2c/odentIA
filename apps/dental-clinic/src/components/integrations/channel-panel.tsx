import { Alert, AlertDescription, AlertTitle, Badge, Button, Field, FieldDescription, FieldError, FieldLabel, Input } from "@odentia/ui"
import { ConfirmDialog, DetailField, DetailList, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import type { ConnectionItem } from "../../lib/crm"
import {
  CHANNEL_SETUP,
  type ChannelField,
  type ChannelRow,
  DISCONNECT_CONSEQUENCE,
  INTEGRATIONS,
  type PanelChannel,
  secretFields,
} from "../../lib/integrations"

/** La cuenta que el proveedor reconoce con unos datos; cada parte puede faltar. */
interface ProviderAccount {
  name?: string | null
  number?: string | null
}

/** Lo que devuelve el servidor al crear la conexión; la clave de verificación solo viaja aquí y en `setup`. */
interface CreatedConnection extends ConnectionItem {
  webhookSecret?: string
  /** Lo que el proveedor encontró con esos datos; nulo si no se le preguntó. */
  account?: ProviderAccount | null
}

/** Lo que hace falta pegar en el proveedor para que avise de cada mensaje. */
interface ConnectionSetup {
  webhookUrl?: string
  verifyToken?: string
  webhookVerifiedAt?: string | null
  lastInboundAt?: string | null
}

/** Resultado de «Probar»: qué cuenta respondió o, si no entró, qué pasó y cómo arreglarlo. */
interface ConnectionTest {
  ok?: boolean
  checkedAt?: string
  account?: ProviderAccount | null
  problem?: string | null
}

const STATUS_BADGE = { ok: "soft", off: "secondary", attention: "warning" } as const

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/** La cuenta que encontró el proveedor, con las palabras que entregue; `null` si no dijo ninguna. */
function accountWords(account: ProviderAccount | null | undefined): string | null {
  const parts = [account?.name, account?.number].filter((part): part is string => Boolean(part?.trim()))
  return parts.length > 0 ? parts.join(" · ") : null
}

/** Un dato que se copia tal cual al proveedor: se muestra siempre, no una sola vez. */
export function CopyValue({ id, label, hint, value }: { id: string; label: string; hint: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Sin permiso para el portapapeles el valor sigue a la vista: se selecciona a mano.
      setCopied(false)
    }
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input id={id} readOnly value={value} className="min-w-0 flex-1 font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" variant="outline" className="shrink-0" onClick={() => void copy()}>
          {copied ? "Copiado" : "Copiar"}
          {/* El nombre del botón dice qué copia, sin dejar de coincidir con lo que se lee. */}
          <span className="sr-only"> {label.toLowerCase()}</span>
        </Button>
      </div>
      <FieldDescription>{hint}</FieldDescription>
      <span role="status" className="sr-only">
        {copied ? `${label}: copiado` : ""}
      </span>
    </Field>
  )
}

/**
 * Panel de un canal de mensajería (Instagram, Messenger o Telegram): conectar
 * con sus datos dichos en palabras y, ya conectado, probar, cambiar la clave y
 * desconectar. Es una sola superficie para las tres vistas: cambiar de vista no
 * la cierra ni la mueve de la columna al cajón.
 */
export function ChannelPanel({
  channel,
  row,
  loading = false,
  canWrite,
  onClose,
  onConnected,
}: {
  channel: PanelChannel
  /** La fila del canal tal como está en la lista: de ahí salen su estado y su cuenta. */
  row: ChannelRow | null
  /** La conexión existe pero la lista aún no la trae: se espera en vez de ofrecer conectarla otra vez. */
  loading?: boolean
  canWrite: boolean
  onClose: () => void
  /** Se creó la conexión: la pantalla sigue con ella sin cerrar el panel. */
  onConnected: (connectionId: string) => void
}) {
  const queryClient = useQueryClient()
  const setup = CHANNEL_SETUP[channel]
  const name = INTEGRATIONS[channel].name
  const connection = row?.connection ?? null
  const active = connection?.status === "active"

  const [view, setView] = useState<"detail" | "key">("detail")
  const [values, setValues] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const [invalid, setInvalid] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  /** Recién conectado: qué cuenta encontró y la clave de verificación que acaba de generarse. */
  const [created, setCreated] = useState<{ account: string | null; verifyToken: string | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const connecting = connection === null && !loading
  const editing = connecting || view === "key"
  const fields = connecting ? setup.fields : secretFields(channel)
  const isDirty = editing && Object.values(values).some((value) => value.trim() !== "")

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["connections"] })

  function resetForm() {
    setValues({})
    setShown({})
    setInvalid([])
    setFormError(null)
  }

  // La dirección y su clave son de quien administra la configuración: el servidor no las entrega a nadie más.
  const showsSetup = setup.pasteAddress && connection !== null && canWrite
  const setupQuery = useQuery({
    queryKey: ["connection-setup", connection?.id],
    queryFn: () => apiFetch<{ data: ConnectionSetup }>(`/api/channels/connections/${connection?.id}/setup`),
    enabled: showsSetup,
    retry: false,
  })

  const connect = useMutation({
    mutationFn: (config: Record<string, string>) =>
      apiFetch<{ data: CreatedConnection }>("/api/channels/connections", {
        method: "POST",
        // Sin nombre: la conexión toma el que el proveedor le da a la cuenta.
        body: JSON.stringify({ channel, provider: setup.provider, config }),
      }),
    onSuccess: async ({ data }) => {
      await refresh()
      resetForm()
      setCreated({ account: accountWords(data.account), verifyToken: data.webhookSecret ?? null })
      onConnected(data.id)
    },
    onError: (error) => setFormError(errorText(error, `No pudimos conectar ${name}. Revisa los datos y vuelve a intentarlo.`)),
  })

  const changeKey = useMutation({
    mutationFn: (config: Record<string, string>) =>
      apiFetch(`/api/channels/connections/${connection?.id}/credentials`, { method: "POST", body: JSON.stringify({ config }) }),
    onSuccess: async () => {
      await refresh()
      resetForm()
      setTested(null)
      setNotice("Clave cambiada. La conexión y sus conversaciones siguen siendo las mismas.")
      setView("detail")
    },
    onError: (error) => setFormError(errorText(error, "No pudimos cambiar la clave. Revísala y vuelve a intentarlo.")),
  })

  const test = useMutation({
    mutationFn: () => apiFetch<{ data: ConnectionTest }>(`/api/channels/connections/${connection?.id}/test`, { method: "POST" }),
    onSuccess: ({ data }) => {
      const account = accountWords(data.account)
      setTested(
        data.ok === false
          ? { ok: false, text: data.problem?.trim() || `${name} no respondió con esta clave.` }
          : { ok: true, text: account ? `Funciona. Respondió ${account}.` : "Funciona. La cuenta respondió." },
      )
      void refresh()
    },
    onError: (error) => setTested({ ok: false, text: errorText(error, `${name} no respondió. Vuelve a intentarlo en un momento.`) }),
  })

  const setStatus = useMutation({
    mutationFn: (next: "enable" | "disable") =>
      apiFetch(`/api/channels/connections/${connection?.id}/${next}`, { method: "POST" }),
    onSuccess: async (_result, next) => {
      await refresh()
      setConfirming(false)
      setTested(null)
      setCreated(null)
      setNotice(next === "disable" ? `${name} quedó desconectado.` : `${name} volvió a conectarse.`)
    },
  })
  const statusError = setStatus.isError ? errorText(setStatus.error, "No pudimos hacer el cambio. Vuelve a intentarlo.") : null

  function submit(event: FormEvent) {
    event.preventDefault()
    // En el detalle no hay nada que enviar: Enter en un dato de solo lectura no hace nada.
    if (!editing) return
    setFormError(null)
    const filled = Object.fromEntries(
      fields.map((field) => [field.key, (values[field.key] ?? "").trim()] as const).filter(([, value]) => value !== ""),
    )
    if (connecting) {
      const missing = fields.filter((field) => !filled[field.key]).map((field) => field.key)
      setInvalid(missing)
      if (missing.length === 0) connect.mutate(filled)
      return
    }
    // Al cambiar la clave solo viaja lo que se escribió: lo demás se conserva.
    if (Object.keys(filled).length === 0) {
      setInvalid(fields.map((field) => field.key))
      return
    }
    setInvalid([])
    changeKey.mutate(filled)
  }

  /** «Cancelar» en el cambio de clave vuelve al detalle; en lo demás cierra el panel. */
  function close() {
    if (!connecting && view === "key") {
      resetForm()
      setView("detail")
      return
    }
    onClose()
  }

  const renderField = (field: ChannelField) => {
    const id = `integracion-${channel}-${field.key}`
    const isInvalid = invalid.includes(field.key)
    const optional = !connecting && fields.length > 1
    return (
      <Field key={field.key} data-invalid={isInvalid || undefined}>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={id}
            type={field.secret && !shown[field.key] ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={isInvalid || undefined}
            aria-describedby={`${id}-ayuda`}
            className="min-w-0 flex-1"
            value={values[field.key] ?? ""}
            onChange={(event) => {
              setValues((current) => ({ ...current, [field.key]: event.target.value }))
              setInvalid((current) => current.filter((key) => key !== field.key))
            }}
          />
          {field.secret ? (
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              aria-pressed={Boolean(shown[field.key])}
              aria-label={`${shown[field.key] ? "Ocultar" : "Ver"} ${field.label.toLowerCase()}`}
              onClick={() => setShown((current) => ({ ...current, [field.key]: !current[field.key] }))}
            >
              {shown[field.key] ? "Ocultar" : "Ver"}
            </Button>
          ) : null}
        </div>
        <FieldDescription id={`${id}-ayuda`}>
          {field.hint}
          {optional ? " Déjala vacía si no cambió." : ""}
        </FieldDescription>
        {isInvalid ? (
          <FieldError>{optional ? "Escribe al menos una de las claves." : "Escribe este dato."}</FieldError>
        ) : null}
      </Field>
    )
  }

  const webhookUrl = setupQuery.data?.data.webhookUrl ?? connection?.webhookUrl ?? null
  const verifyToken = setupQuery.data?.data.verifyToken ?? created?.verifyToken ?? null
  const verifiedAt = setupQuery.data?.data.webhookVerifiedAt ?? connection?.webhookVerifiedAt

  const title = connecting ? `Conectar ${name}` : view === "key" ? `Cambiar la clave de ${name}` : name
  const description = connecting
    ? setup.intro
    : view === "key"
      ? "La conexión, su dirección de avisos y sus conversaciones siguen siendo las mismas."
      : INTEGRATIONS[channel].purpose

  return (
    <>
      <FormDrawer
        open
        onClose={close}
        title={title}
        description={description}
        onSubmit={submit}
        isDirty={isDirty}
        isSubmitting={connect.isPending || changeKey.isPending}
        isLoading={loading}
        error={editing ? formError : statusError}
        submitLabel={connecting ? "Conectar" : "Guardar la clave"}
        cancelLabel={editing ? "Cancelar" : "Cerrar"}
        hideSubmit={!editing || !canWrite}
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            {fields.map(renderField)}
            {connecting ? (
              <div className="flex flex-col gap-1 rounded-xl bg-muted p-3 text-sm">
                {setup.pasteAddress ? (
                  <>
                    <strong className="font-semibold">Después de conectar</strong>
                    <span className="text-muted-foreground">
                      Te mostramos la dirección de avisos y su clave de verificación para pegarlas en Meta. Hasta entonces no
                      llega ningún mensaje.
                    </span>
                  </>
                ) : (
                  <>
                    <strong className="font-semibold">Es el único dato</strong>
                    <span className="text-muted-foreground">
                      odentIA comprueba la clave, toma el nombre del bot y le dice a Telegram adónde avisar. No hay nada que
                      copiar ni pegar.
                    </span>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : row && connection ? (
          <div className="flex flex-col gap-5">
            {created ? (
              <Alert>
                <AlertTitle>Conectado</AlertTitle>
                <AlertDescription>
                  {/* Solo se dice lo que el proveedor confirmó: sin su respuesta, que la conexión quedó guardada. */}
                  {created.account ? `Encontramos ${created.account}.` : "La conexión quedó guardada."}
                  {setup.pasteAddress ? " Falta un paso: pegar en Meta los dos datos de abajo." : ""}
                </AlertDescription>
              </Alert>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            ) : null}
            <DetailList columns={1}>
              <DetailField label="Cuenta">{row.detail.kind === "account" ? row.detail.account : null}</DetailField>
              <DetailField label="Estado">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_BADGE[row.tone]}>{row.status}</Badge>
                  {row.detail.kind === "account" && row.detail.activity ? <span>{row.detail.activity}</span> : null}
                </span>
              </DetailField>
            </DetailList>
            {row.problem ? <p className="text-sm font-semibold text-warning">{row.problem}</p> : null}

            {showsSetup ? (
              <section aria-label="Para que lleguen los mensajes" className="flex flex-col gap-3 rounded-xl border p-3">
                <div className="flex flex-col gap-0.5">
                  <h3 className="text-sm font-semibold">Para que lleguen los mensajes</h3>
                  <p className="text-sm text-muted-foreground">{setup.pasteWhere} Pega ahí estos dos datos.</p>
                </div>
                {webhookUrl ? (
                  <CopyValue
                    id={`integracion-${channel}-direccion`}
                    label="Dirección de avisos"
                    hint="En Meta se llama «Callback URL»."
                    value={webhookUrl}
                  />
                ) : null}
                {verifyToken ? (
                  <CopyValue
                    id={`integracion-${channel}-verificacion`}
                    label="Clave de verificación"
                    hint="En Meta se llama «Verify token»."
                    value={verifyToken}
                  />
                ) : setupQuery.isPending ? (
                  <p className="text-sm text-muted-foreground">Cargando la clave de verificación…</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-destructive">No pudimos cargar la clave de verificación.</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => void setupQuery.refetch()}>
                      Reintentar
                    </Button>
                  </div>
                )}
                {verifiedAt ? (
                  <p className="text-sm font-medium text-success">Meta ya verificó la dirección.</p>
                ) : verifiedAt === null ? (
                  <p className="text-sm text-muted-foreground">Meta todavía no verificó la dirección. Cuando lo haga, aquí lo dirá.</p>
                ) : null}
              </section>
            ) : setup.pasteAddress ? null : (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
                No hay nada que copiar ni pegar: odentIA le dice a Telegram adónde avisar.
              </p>
            )}

            {canWrite ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  {active ? (
                    <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                      {test.isPending ? "Probando…" : "Probar"}
                    </Button>
                  ) : (
                    <Button type="button" disabled={setStatus.isPending} onClick={() => setStatus.mutate("enable")}>
                      {setStatus.isPending ? "Conectando…" : "Volver a conectar"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      resetForm()
                      setNotice(null)
                      setView("key")
                    }}
                  >
                    Cambiar la clave
                  </Button>
                  {active ? (
                    <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
                      Desconectar
                    </Button>
                  ) : null}
                </div>
                {tested ? (
                  <p role="status" className={tested.ok ? "text-sm font-medium text-success" : "text-sm font-medium text-destructive"}>
                    {tested.text}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </FormDrawer>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => setStatus.mutate("disable")}
        title={`Desconectar ${name}`}
        description={DISCONNECT_CONSEQUENCE[channel]}
        confirmLabel="Desconectar"
        pending={setStatus.isPending}
      />
    </>
  )
}
