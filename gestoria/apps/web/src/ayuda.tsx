import { Badge, DropdownMenuItem } from "@odentia/ui"
import { OPEN_HELP_EVENT, useHeaderCompact } from "@odentia/ui-patterns"
import { HelpButton } from "@odentia/ui-patterns/help"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleHelp } from "lucide-react"
import { api, type MyStore } from "./lib/api"
import { HELP_KEY, type HelpQuestion, questionStatus } from "./lib/ayuda"
import { when } from "./lib/pedidos"

/**
 * La Ayuda de gestorIA (ADR 0227): el panel común de todas las apps (`HelpButton` de
 * `@odentia/ui-patterns`), con la misma Ariadna de las clínicas, en la cabecera de cada pantalla
 * de la tienda. Aquí va solo lo de gestorIA: su servidor (que pregunta con la guía de
 * `apps/api/src/ayuda.ts`) y «Tus casos con soporte». gestorIA no tiene un agente de las cifras en
 * la Ayuda ni da acceso a soporte desde ella (eso es de Equipo).
 */
export function StoreHelpButton({ store }: { store: MyStore }) {
  const queryClient = useQueryClient()
  const writes = store.permissions.includes("ayuda.pedir")
  return (
    <HelpButton
      appName="gestorIA"
      peopleWord="clientes"
      placeWord="tienda"
      apiBase={`/api/tiendas/${store.id}/ayuda`}
      fetcher={helpFetch}
      // La administración no dice qué respuestas ya se leyeron: el botón no cuenta ninguna.
      unseen={0}
      supportMode={store.role === "support"}
      renderCases={() => (writes ? <SupportCases storeId={store.id} /> : null)}
      onSent={() => void queryClient.invalidateQueries({ queryKey: HELP_KEY(store.id) })}
    />
  )
}

/** El panel llama con el cuerpo ya en texto; `api` lo quiere como dato y pone la sesión. */
function helpFetch(path: string, init?: RequestInit): Promise<unknown> {
  return api<unknown>(path, {
    method: init?.method,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  })
}

/**
 * «Ayuda» en el menú ⋯ de la cabecera, solo con la fila compacta (el teléfono, o cuando la fila
 * no cabe): si no, el botón ya está en la fila.
 */
export function HelpMenuItem() {
  const compact = useHeaderCompact()
  if (!compact) return null
  return (
    <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(OPEN_HELP_EVENT))}>
      <CircleHelp aria-hidden />
      Ayuda
    </DropdownMenuItem>
  )
}

/**
 * «Tus casos con soporte»: lo que la persona escribió al equipo de gestorIA y sus respuestas.
 * Solo lo suyo (ADR 0221); lo que aún no sale, «Por enviar».
 */
function SupportCases({ storeId }: { storeId: string }) {
  const cases = useQuery({
    queryKey: HELP_KEY(storeId),
    queryFn: () => api<{ questions: HelpQuestion[] }>(`/api/tiendas/${storeId}/ayuda/casos`),
    staleTime: 30_000,
    retry: false,
  })
  const items = cases.data?.questions ?? []
  return (
    <section aria-label="Tus casos con soporte" className="flex flex-col gap-2 border-t pt-3.5">
      <h3 className="text-sm font-bold">Tus casos con soporte</h3>
      {cases.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando tus casos…</p>
      ) : cases.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pude cargar tus casos ahora.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aún no tienes casos. Cuando envías una pregunta o reportas un problema, aquí sigue su
          conversación.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((one) => (
            <li
              key={one.id ?? `${one.createdAt}-${one.question}`}
              className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm"
            >
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{questionStatus(one.status)}</Badge>
                <span className="text-xs text-muted-foreground">{when(one.createdAt)}</span>
              </span>
              <p className="font-semibold [overflow-wrap:anywhere]">{one.question}</p>
              {one.replies.map((reply, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: dos respuestas pueden tener la misma hora
                <div key={`${reply.at}-${i}`} className="rounded-md bg-muted/50 p-3">
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{reply.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    gestorIA · soporte · {when(reply.at)}
                  </p>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
