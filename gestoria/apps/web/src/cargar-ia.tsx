import { Button, toast } from "@odentia/ui"
import { AiSuggestion, PageNotice } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Sparkles } from "lucide-react"
import { useState } from "react"
import { Swatch } from "./ficha/piezas"
import { ApiError, api } from "./lib/api"
import {
  applyProposal,
  type ColorValue,
  discardProposal,
  LOAD_PROPOSALS_KEY,
  type LoadProposals,
  type Proposal,
  useLoadProposals,
} from "./lib/ia"
import { useStoreContext } from "./tiendas"

/**
 * La IA en «Cargar muchos» (prototipo `cargar.tsx`; lienzo, tablero 7 y decisión 3): «Juntar con
 * IA» propone qué fotos sueltas son del mismo producto, y «Completar con IA» propone el nombre, la
 * categoría, la descripción y los colores de un producto de la carga. Rosa confirma cada cosa;
 * lo que es de la ficha (rubro, datos, palabras) espera a «Crear» y pasa al producto como ✦.
 */

interface Photo {
  id: string
  urls: { miniatura: string } | null
}

/** Lo que queda escrito cuando «Juntar con IA» no encuentra qué juntar: un resultado, no un error. */
export const NOTHING_TO_JOIN = "No encontré fotos del mismo producto para juntar."
/** Sin dos fotos sueltas, la IA no mira: no hay nada que juntar. */
export const NO_LOOSE_PHOTOS = "No hay fotos sueltas para juntar."

/** «Juntar con IA» y «Completar con IA» de un producto de la carga. */
export function useLoadIa(loadId: string, refreshLoad: () => Promise<unknown>) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  // Sin grupos, el resultado queda fijo junto a la tabla hasta que se vuelva a pedir o cambien
  // las fotos de la carga.
  const [groupNote, setGroupNote] = useState<string | null>(null)
  const key = LOAD_PROPOSALS_KEY(store.id, loadId)
  const done = (data: LoadProposals, what: string) => {
    queryClient.setQueryData(key, data)
    void queryClient.invalidateQueries({ queryKey: ["ia-tope", store.id] })
    toast.success(what)
  }
  const group = useMutation({
    mutationFn: () =>
      api<LoadProposals>(`/api/tiendas/${store.id}/cargas/${loadId}/ia/juntar`, {
        method: "POST",
      }),
    onMutate: () => setGroupNote(null),
    onSuccess: (data) => {
      const n = data.proposals.filter((p) => p.kind === "juntar").length
      if (n) done(data, `La IA propone juntar ${n} ${n === 1 ? "grupo" : "grupos"} de fotos`)
      else {
        queryClient.setQueryData(key, data)
        void queryClient.invalidateQueries({ queryKey: ["ia-tope", store.id] })
        setGroupNote(NOTHING_TO_JOIN)
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "NOTHING_TO_GROUP")
        setGroupNote(NO_LOOSE_PHOTOS)
      else toast.error(error.message)
    },
  })
  const complete = useMutation({
    mutationFn: (itemId: string) =>
      api<LoadProposals>(`/api/tiendas/${store.id}/cargas/${loadId}/productos/${itemId}/ia`, {
        method: "POST",
      }),
    onSuccess: (data) => done(data, "La IA propuso lo que ve: revísalo arriba de la tabla"),
    onError: (error) => toast.error(error.message),
  })
  const decide = useMutation({
    mutationFn: ({ proposal, use }: { proposal: Proposal; use: boolean }) =>
      use ? applyProposal(store.id, proposal.id) : discardProposal(store.id, proposal.id),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: key })
      await refreshLoad()
    },
    onError: (error) => toast.error(error.message),
  })
  const all = useMutation({
    mutationFn: (itemId: string) =>
      api<{ applied: number }>(
        `/api/tiendas/${store.id}/cargas/${loadId}/productos/${itemId}/ia/aplicar-todos`,
        { method: "POST" },
      ),
    onSuccess: ({ applied }) =>
      toast.success(applied === 1 ? "Usé 1 propuesta" : `Usé ${applied} propuestas`),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: key })
      await refreshLoad()
    },
    onError: (error) => toast.error(error.message),
  })
  return { group, complete, decide, all, groupNote, clearGroupNote: () => setGroupNote(null) }
}

const LABEL: Record<string, string> = {
  nombre: "Nombre",
  categoria: "Categoría",
  descripcion: "Descripción",
}

/**
 * Lo que dijo «Juntar con IA» cuando no hubo qué juntar, fijo y en neutro. La región está siempre
 * montada para que el lector de pantalla la anuncie al cambiar.
 */
export function JoinNote({ ia }: { ia: ReturnType<typeof useLoadIa> }) {
  return (
    <p
      role="status"
      className={
        ia.groupNote
          ? "rounded-xl border bg-card px-3 py-2 text-sm text-muted-foreground"
          : "sr-only"
      }
    >
      {ia.groupNote ?? ""}
    </p>
  )
}

export function LoadIaPanel({
  loadId,
  items,
  photos,
  ia,
}: {
  loadId: string
  items: { id: string; name: string; photos: Photo[] }[]
  photos: Photo[]
  ia: ReturnType<typeof useLoadIa>
}) {
  const { store } = useStoreContext()
  const query = useLoadProposals(store.id, loadId)
  const proposals = query.data?.proposals ?? []
  const cap = query.data?.cap
  const look = query.data?.look
  const thumb = (id: string) => photos.find((p) => p.id === id)?.urls?.miniatura
  const groups = proposals.filter((p) => p.kind === "juntar")
  const byItem = items
    .map((item) => ({
      item,
      list: proposals.filter((p) => p.itemId === item.id && !p.waitsForProduct),
      later: proposals.filter((p) => p.itemId === item.id && p.waitsForProduct),
    }))
    .filter((x) => x.list.length || x.later.length)
  if (!groups.length && !byItem.length && !(cap && !cap.available) && look?.state !== "fallo")
    return null
  const busy = ia.decide.isPending || ia.all.isPending
  return (
    <section aria-label="Lo que propone la IA" className="flex flex-col gap-3">
      {cap && !cap.available && cap.message ? (
        <PageNotice tone="aviso" label="La IA no mira ahora">
          {cap.message}
        </PageNotice>
      ) : null}
      {look?.state === "fallo" && look.failure ? (
        <PageNotice tone="aviso" label="La IA no pudo mirar">
          {look.failure} Puedes seguir a mano.
        </PageNotice>
      ) : null}
      {groups.map((p) => {
        const ids = (p.value as { photos: string[] }).photos
        return (
          <AiSuggestion
            key={p.id}
            layout="row"
            reason={p.reason}
            acceptLabel="Juntar"
            onAccept={() => !busy && ia.decide.mutate({ proposal: p, use: true })}
            onDiscard={() => !busy && ia.decide.mutate({ proposal: p, use: false })}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="flex -space-x-2">
                {ids.map((id) =>
                  thumb(id) ? (
                    <img
                      key={id}
                      src={thumb(id)}
                      alt=""
                      className="size-9 rounded-lg border-2 border-card object-cover"
                    />
                  ) : null,
                )}
              </span>
              <span>Estas {ids.length} fotos parecen del mismo producto</span>
            </span>
          </AiSuggestion>
        )
      })}
      {byItem.map(({ item, list, later }) => (
        <div key={item.id} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            {item.photos[0]?.urls ? (
              <img
                src={item.photos[0].urls.miniatura}
                alt=""
                className="size-8 rounded-md object-cover"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {item.name || "Producto sin nombre"}
            </span>
            {list.length > 1 ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => ia.all.mutate(item.id)}
              >
                Aplicar todos
              </Button>
            ) : null}
          </div>
          {list.map((p) =>
            p.kind === "color" ? (
              <AiSuggestion
                key={p.id}
                layout="row"
                reason={p.reason}
                onAccept={() => !busy && ia.decide.mutate({ proposal: p, use: true })}
                onDiscard={() => !busy && ia.decide.mutate({ proposal: p, use: false })}
              >
                <span className="inline-flex items-center gap-2">
                  <Swatch
                    hex={(p.value as ColorValue).hex}
                    hex2={(p.value as ColorValue).hex2}
                    className="size-4"
                  />
                  Color: <span className="font-medium">{(p.value as ColorValue).name}</span>
                </span>
              </AiSuggestion>
            ) : p.kind === "pregunta" ? null : (
              <AiSuggestion
                key={p.id}
                layout="row"
                reason={p.reason}
                onAccept={() => !busy && ia.decide.mutate({ proposal: p, use: true })}
                onDiscard={() => !busy && ia.decide.mutate({ proposal: p, use: false })}
              >
                {LABEL[p.kind] ?? p.kind}: <span className="font-medium">{String(p.value)}</span>
              </AiSuggestion>
            ),
          )}
          {later.length ? (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              {later.filter((p) => p.kind === "pregunta").length
                ? "Lo que no se ve lo pregunta en la ficha. "
                : ""}
              El rubro, sus datos y las palabras te esperan en la ficha (✦), al crear el producto.
            </p>
          ) : null}
        </div>
      ))}
    </section>
  )
}
