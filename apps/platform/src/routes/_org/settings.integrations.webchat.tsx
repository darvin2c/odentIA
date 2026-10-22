import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Field, FieldLabel, Input, Textarea, toast } from "@odentia/ui"
import { ConfirmDialog, ErrorState, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { CheckCircle2, ChevronRight, Copy, Globe, ShieldAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { ChoiceButtons } from "../../components/choice-buttons"
import { IntegrationsCrumbWithText } from "../../components/integrations/integrations-crumb"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/integrations/webchat")({
  component: WebchatSettingsPage,
})

const orgRouteApi = getRouteApi("/_org")

const TITLE = "Chat web"
const SUBTITLE = "El chat de tu sitio web: lo que escriben llega a la misma Bandeja."

/** Lo que entrega `/api/channels/webchat`: un solo chat por clínica (decisión 7 del pulido). */
interface ClinicWebchat {
  id: string
  active: boolean
  script: string | null
  color: string
  greeting: string
  notifyUrl: string | null
  installedOn: string | null
  sites: Array<{
    id: string
    origin: string
    status: "permitido" | "pendiente" | "bloqueado"
    firstSeenAt: string
    decidedAt: string | null
    decidedByName: string | null
    first: boolean
  }>
}

/** Colores del botón y la cabecera: todos con buen contraste para el texto blanco. */
const COLORS = [
  { value: "#0f766e", label: "Turquesa" },
  { value: "#1d4ed8", label: "Azul" },
  { value: "#6d28d9", label: "Morado" },
  { value: "#be185d", label: "Rosa" },
  { value: "#c2410c", label: "Naranja" },
  { value: "#334155", label: "Gris" },
] as const

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

const dayWords = (iso: string) => {
  const date = new Date(iso)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return "hoy"
  return `el ${new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(date)}`
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(done)
  } catch {
    toast.error("No se pudo copiar: selecciónalo y cópialo a mano.")
  }
}

function WebchatSettingsPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const key = ["clinic-webchat", org.slug]
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<{ data: ClinicWebchat }>("/api/channels/webchat"),
    enabled: canRead,
    retry: false,
  })
  const chat = query.data?.data ?? null
  const refresh = (data?: { data: ClinicWebchat }) => {
    if (data) queryClient.setQueryData(key, data)
    else void queryClient.invalidateQueries({ queryKey: key })
  }
  const failed = (cause: unknown) => toast.error(cause instanceof ApiError && cause.shape.message ? cause.shape.message : "No se pudo guardar. Inténtalo de nuevo.")

  const [confirmOff, setConfirmOff] = useState(false)
  const status = useMutation({
    mutationFn: (active: boolean) => apiFetch<{ data: ClinicWebchat }>(`/api/channels/webchat/${active ? "enable" : "disable"}`, { method: "POST", body: "{}" }),
    onSuccess: (data, active) => {
      refresh(data)
      setConfirmOff(false)
      toast.success(active ? "El chat volvió a responder en tus sitios." : "Chat desactivado.")
    },
    onError: failed,
  })
  const site = useMutation({
    mutationFn: ({ id, allow }: { id: string; allow: boolean }) =>
      apiFetch<{ data: ClinicWebchat }>(`/api/channels/webchat/sites/${id}/${allow ? "allow" : "block"}`, { method: "POST", body: "{}" }),
    onSuccess: (data, { allow }) => {
      refresh(data)
      toast.success(allow ? "Listo: el chat responde en ese sitio." : "Bloqueado: ahí el chat dice «No disponible».")
    },
    onError: failed,
  })

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} subtitle={<IntegrationsCrumbWithText current={TITLE} text={SUBTITLE} />} />
        <SettingsNoAccess />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={TITLE} subtitle={<IntegrationsCrumbWithText current={TITLE} text={SUBTITLE} />} />
      {query.isError ? (
        <ErrorState title="No pudimos cargar el chat web" message="Revisa tu conexión." retryLabel="Reintentar" onRetry={() => void query.refetch()} />
      ) : !chat ? (
        <div className="flex flex-col gap-4" aria-busy>
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
          <div className="h-40 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[3_1_26rem] flex-col gap-6">
            <section aria-labelledby="chat-estado" className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 id="chat-estado" className="font-semibold">
                  Chat de tu sitio
                </h2>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {!chat.active ? (
                    "Desactivado: en todos tus sitios dice «No disponible»."
                  ) : chat.installedOn ? (
                    <>
                      <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                      Instalado en {hostOf(chat.installedOn)}
                    </>
                  ) : (
                    "Aún no está en ningún sitio: pega la línea y se activa sola."
                  )}
                </p>
              </div>
              {canWrite ? (
                chat.active ? (
                  <Button variant="outline" onClick={() => setConfirmOff(true)}>
                    Desactivar
                  </Button>
                ) : (
                  <Button disabled={status.isPending} onClick={() => status.mutate(true)}>
                    Activar
                  </Button>
                )
              ) : null}
            </section>

            <Install chat={chat} clinicName={org.name} />

            <section aria-labelledby="chat-sitios" className="flex flex-col gap-3">
              <div>
                <h2 id="chat-sitios" className="font-semibold">
                  Dónde responde
                </h2>
                <p className="text-sm text-muted-foreground">El primer sitio donde pegas la línea se registra solo. Si aparece en otro, decides tú; mientras tanto, ahí dice «No disponible».</p>
              </div>
              {chat.sites.length === 0 ? (
                <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Todavía no cargó en ningún sitio.</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-xl border bg-card">
                  {chat.sites.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                      {item.status === "permitido" ? (
                        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                      ) : item.status === "pendiente" ? (
                        <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
                      ) : (
                        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{hostOf(item.origin)}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.status === "permitido"
                            ? item.first
                              ? `Primer sitio, registrado solo · desde ${dayWords(item.firstSeenAt)}`
                              : `Permitido${item.decidedByName ? ` por ${item.decidedByName}` : ""} · desde ${dayWords(item.decidedAt ?? item.firstSeenAt)}`
                            : item.status === "pendiente"
                              ? `Apareció ${dayWords(item.firstSeenAt)} · ¿Es tuyo?`
                              : `Bloqueado${item.decidedByName ? ` por ${item.decidedByName}` : ""}: ahí dice «No disponible»`}
                        </span>
                      </div>
                      {canWrite && item.status !== "permitido" ? (
                        <span className="flex gap-2">
                          <Button size="sm" className="min-h-11 sm:min-h-8" disabled={site.isPending} onClick={() => site.mutate({ id: item.id, allow: true })}>
                            Permitir
                          </Button>
                          {item.status === "pendiente" ? (
                            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={site.isPending} onClick={() => site.mutate({ id: item.id, allow: false })}>
                              Bloquear
                            </Button>
                          ) : null}
                        </span>
                      ) : canWrite && item.status === "permitido" ? (
                        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" disabled={site.isPending} onClick={() => site.mutate({ id: item.id, allow: false })}>
                          Bloquear
                        </Button>
                      ) : item.status === "pendiente" ? (
                        <Badge variant="secondary">Espera tu sí</Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {canWrite ? <Advanced chat={chat} onSaved={refresh} /> : null}
          </div>
          <div className="flex min-w-0 flex-[2_1_20rem] flex-col gap-3 lg:sticky lg:top-4">
            {canWrite ? <Preview chatId={chat.id} /> : <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">La vista previa la abre quien administra la configuración.</p>}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmOff}
        title="Desactivar el chat"
        description="El chat deja de responder en todos tus sitios: ahí dirá «No disponible». Las conversaciones que ya tienes siguen en la Bandeja."
        confirmLabel="Desactivar"
        cancelLabel="Volver"
        pending={status.isPending}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => status.mutate(false)}
      />
    </div>
  )
}

/** «Instalar en tu sitio»: la línea, copiarla, enviarla a quien hace la web y cómo pegarla. */
function Install({ chat, clinicName }: { chat: ClinicWebchat; clinicName: string }) {
  if (!chat.script) {
    return <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">La dirección de tu clínica aún no está configurada: el chat no se puede instalar todavía.</p>
  }
  const script = chat.script
  const forWebmaster = `Hola. Por favor, pega esta línea en el sitio de ${clinicName}, justo antes de </body>, en todas las páginas:\n\n${script}\n\nEs el chat de la clínica. Gracias.`
  return (
    <section aria-labelledby="chat-instalar" className="flex flex-col gap-3">
      <div>
        <h2 id="chat-instalar" className="font-semibold">
          Instalar en tu sitio
        </h2>
        <p className="text-sm text-muted-foreground">Copia esta línea y pégala en tu sitio, antes de &lt;/body&gt;. Cambiar el color o el saludo no obliga a volver a pegarla.</p>
      </div>
      {/* La línea se parte en renglones: se lee entera también en el celular, sin barra. */}
      <pre className="whitespace-pre-wrap break-all rounded-xl border bg-muted px-4 py-3 font-mono text-sm">{script}</pre>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void copy(script, "Línea copiada.")}>
          <Copy className="size-4" /> Copiar código
        </Button>
        <Button variant="outline" onClick={() => void copy(forWebmaster, "Mensaje copiado: pégalo en un correo o un WhatsApp para quien hace tu web.")}>
          Enviar a quien hace mi web
        </Button>
      </div>
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-semibold text-primary">
          <ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
          Cómo pegarlo en WordPress o Wix
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-6 text-sm text-muted-foreground">
            <li>WordPress: en Apariencia › Editor de temas (o con un complemento para añadir código, como «WPCode»), pega la línea en el pie de página, antes de &lt;/body&gt;.</li>
            <li>Wix: en Configuración › Código personalizado, «Agregar código», pega la línea, elige «Todas las páginas» y «Body - final».</li>
            <li>Abre tu sitio: aparece el botón del chat abajo a la derecha y este sitio queda como el primero.</li>
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}

/** «Opciones avanzadas»: color, saludo, aviso al sitio y el código. Un formulario con su «Guardar». */
function Advanced({ chat, onSaved }: { chat: ClinicWebchat; onSaved: (data: { data: ClinicWebchat }) => void }) {
  const [color, setColor] = useState(chat.color)
  const [greeting, setGreeting] = useState(chat.greeting)
  const [notifyUrl, setNotifyUrl] = useState(chat.notifyUrl ?? "")
  const [code, setCode] = useState<string | null>(null)
  const [rotating, setRotating] = useState(false)
  const save = useMutation({
    mutationFn: () =>
      apiFetch<{ data: ClinicWebchat }>("/api/channels/webchat", {
        method: "PATCH",
        body: JSON.stringify({ color, greeting: greeting.trim() || null, notifyUrl: notifyUrl.trim() || null }),
      }),
    onSuccess: (data) => {
      onSaved(data)
      toast.success("Guardado. Tu sitio lo muestra sin volver a pegar la línea.")
    },
    onError: (cause) => toast.error(cause instanceof ApiError && cause.shape.message ? cause.shape.message : "No se pudo guardar."),
  })
  const reveal = useMutation({
    mutationFn: () => apiFetch<{ data: { code: string } }>("/api/channels/webchat/code"),
    onSuccess: (data) => setCode(data.data.code),
    onError: (cause) => toast.error(cause instanceof ApiError && cause.shape.message ? cause.shape.message : "No se pudo mostrar el código."),
  })
  const rotate = useMutation({
    mutationFn: () => apiFetch<{ data: ClinicWebchat }>("/api/channels/webchat/rotate", { method: "POST", body: "{}" }),
    onSuccess: (data) => {
      onSaved(data)
      setRotating(false)
      setCode(null)
      toast.success("Código nuevo. Quien ya conversaba sigue en su conversación.")
    },
    onError: (cause) => toast.error(cause instanceof ApiError && cause.shape.message ? cause.shape.message : "No se pudo generar el código nuevo."),
  })
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 font-semibold">
        <ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
        Opciones avanzadas
      </CollapsibleTrigger>
      <CollapsibleContent>
        <form
          className="mt-3 flex flex-col gap-4 rounded-xl border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <Field>
            <FieldLabel>Color del chat</FieldLabel>
            <ChoiceButtons label="Color del chat" value={color} options={COLORS} onChange={setColor} tone="primary" />
          </Field>
          <Field>
            <FieldLabel htmlFor="chat-saludo">Saludo</FieldLabel>
            <Textarea id="chat-saludo" rows={2} maxLength={500} value={greeting} onChange={(event) => setGreeting(event.target.value)} />
            <p className="text-xs text-muted-foreground">Es la primera burbuja del chat. Vacío, dice «Hola, ¿en qué podemos ayudarte?».</p>
          </Field>
          <Field>
            <FieldLabel htmlFor="chat-aviso">Aviso a tu sitio (opcional)</FieldLabel>
            <Input id="chat-aviso" inputMode="url" placeholder="https://tu-sitio.com/avisos-del-chat" value={notifyUrl} onChange={(event) => setNotifyUrl(event.target.value)} />
            <p className="text-xs text-muted-foreground">Si tu sitio quiere saber cada respuesta, recibe un aviso firmado con el código de abajo. La mayoría no lo necesita.</p>
          </Field>
          <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 text-sm">
            <span className="font-semibold">Código para comprobar los avisos</span>
            {code ? <code className="break-all rounded bg-background px-2 py-1 font-mono text-xs">{code}</code> : null}
            <span className="flex flex-wrap gap-2">
              {code ? null : (
                <Button type="button" size="sm" variant="outline" disabled={reveal.isPending} onClick={() => reveal.mutate()}>
                  Mostrar el código
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setRotating(true)}>
                Generar un código nuevo
              </Button>
            </span>
          </div>
          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </form>
      </CollapsibleContent>
      <ConfirmDialog
        open={rotating}
        title="Generar un código nuevo"
        description="Quien ya conversaba sigue en su conversación. Si tu sitio comprueba los avisos, cambia ahí el código por el nuevo."
        confirmLabel="Generar código nuevo"
        cancelLabel="Volver"
        pending={rotate.isPending}
        onClose={() => setRotating(false)}
        onConfirm={() => rotate.mutate()}
      />
    </Collapsible>
  )
}

/**
 * «Vista previa»: el chat de verdad, en modo prueba (fase 6 del pulido). Sofi
 * responde de verdad, pero no se publica, no se cobra, no crea a nadie en
 * Pacientes y se borra a los 7 días o con «Borrar esta prueba».
 */
function Preview({ chatId }: { chatId: string }) {
  const [size, setSize] = useState<"computadora" | "celular">("computadora")
  const [session, setSession] = useState<{ sessionId: string; token: string } | null>(null)
  const open = useMutation({
    mutationFn: () => apiFetch<{ data: { sessionId: string; token: string } }>("/api/channels/webchat/test", { method: "POST", body: "{}" }),
    onSuccess: (data) => setSession(data.data),
  })
  const remove = useMutation({
    mutationFn: (sessionId: string) => apiFetch("/api/channels/webchat/test/delete", { method: "POST", body: JSON.stringify({ sessionId }) }),
    onSuccess: () => {
      toast.success("Prueba borrada.")
      setSession(null)
      open.mutate()
    },
    onError: () => toast.error("No se pudo borrar la prueba. Vuelve a intentarlo."),
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: una sesión de prueba por chat, al abrir la página.
  useEffect(() => {
    open.mutate()
  }, [chatId])
  return (
    <section aria-labelledby="chat-vista" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="chat-vista" className="flex-1 font-semibold">
          Vista previa
        </h2>
        <ChoiceButtons
          label="Tamaño de la vista previa"
          value={size}
          options={[
            { value: "computadora", label: "Computadora" },
            { value: "celular", label: "Celular" },
          ]}
          onChange={setSize}
        />
      </div>
      <div className={`mx-auto w-full overflow-hidden rounded-2xl border shadow-sm ${size === "celular" ? "max-w-[360px]" : "max-w-[400px]"}`} style={{ height: size === "celular" ? 640 : 600 }}>
        {session ? (
          <iframe key={session.sessionId} title="Vista previa del chat" className="size-full border-0" src={`/embed?prueba=1#t=${encodeURIComponent(session.token)}`} />
        ) : open.isError ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-sm">
            <p role="alert">No se pudo abrir la prueba del chat.</p>
            <Button variant="outline" size="sm" onClick={() => open.mutate()}>
              Reintentar
            </Button>
          </div>
        ) : (
          <div className="size-full animate-pulse bg-muted" />
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Prueba · no se publica ni se cobra. Sofi responde de verdad; la conversación lleva «Prueba» en la Bandeja y se borra sola a los 7 días.
      </p>
      {session ? (
        <Button variant="outline" className="w-fit" disabled={remove.isPending} onClick={() => remove.mutate(session.sessionId)}>
          Borrar esta prueba
        </Button>
      ) : null}
    </section>
  )
}
