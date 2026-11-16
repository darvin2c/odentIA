import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  cn,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"

/** Cómo se conecta este canal con un botón: Instagram con su propio inicio de sesión, o Facebook. */
export type MetaConnectWay = "instagram" | "facebook"

/**
 * Qué botón ofrece la instalación para el canal. Instagram entra con Instagram
 * si está su app (sirve con o sin página de Facebook); si no, por la página de
 * Facebook. Messenger siempre por Facebook. `pending` mientras se pregunta: no
 * se ofrece la vía a mano antes de saberlo.
 */
export function useMetaConnect(
  channel: "instagram" | "messenger" | "telegram",
  enabled: boolean,
): { way: MetaConnectWay | null; pending: boolean; failed: boolean; retry: () => void } {
  const on = enabled && channel !== "telegram"
  const status = useQuery({
    queryKey: ["meta-pages-status"],
    queryFn: () => apiFetch<{ data: { enabled: boolean; instagram?: boolean } }>("/api/meta-pages/status"),
    enabled: on,
    retry: 1,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const data = status.data?.data
  const way: MetaConnectWay | null = !on || !data
    ? null
    : channel === "instagram" && data.instagram
      ? "instagram"
      : data.enabled
        ? "facebook"
        : null
  return { way, pending: on && status.isPending, failed: on && status.isError, retry: () => void status.refetch() }
}

/**
 * Va directo a la ventana de Instagram o de Facebook, como Gmail, y vuelve a la
 * página del canal.
 */
export function MetaConnectButton({
  way,
  label,
  variant = "default",
}: {
  way: MetaConnectWay
  label: string
  variant?: "default" | "outline"
}) {
  const start = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { url: string } }>(way === "instagram" ? "/api/meta-pages/instagram/start" : "/api/meta-pages/start", {
        method: "POST",
      }),
    onSuccess: ({ data }) => {
      window.location.href = data.url
    },
  })
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant={variant} className="self-start" disabled={start.isPending} onClick={() => start.mutate()}>
        {start.isPending ? (way === "instagram" ? "Abriendo Instagram…" : "Abriendo Facebook…") : label}
      </Button>
      {start.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pudimos abrir {way === "instagram" ? "Instagram" : "Facebook"}. Vuelve a intentarlo.
        </p>
      ) : null}
    </div>
  )
}

interface PageChoice {
  id: string
  name: string
  instagram: string | null
}

/**
 * Marcaste varias páginas en Facebook: aquí se elige la de la clínica, una a la
 * vez, para no conectar por error páginas que no son. La elección vence a los
 * 10 minutos y sirve una sola vez.
 */
export function ChooseFacebookPage({ pick, onDone }: { pick: string; onDone: (text: string | null) => void }) {
  const queryClient = useQueryClient()
  const [pageId, setPageId] = useState<string | null>(null)
  const [withInstagram, setWithInstagram] = useState(true)
  const choices = useQuery({
    queryKey: ["meta-pages-pick", pick],
    queryFn: () => apiFetch<{ data: PageChoice[] }>(`/api/meta-pages/pick/${encodeURIComponent(pick)}`),
    retry: false,
  })
  const choose = useMutation({
    mutationFn: (input: { pageId: string; withInstagram: boolean }) =>
      apiFetch<{ data: { messenger: string[]; instagram: string[]; elsewhere: string[] } }>("/api/meta-pages/pick", {
        method: "POST",
        body: JSON.stringify({ pick, ...input }),
      }),
    onSuccess: ({ data }) => {
      void queryClient.invalidateQueries({ queryKey: ["connections"] })
      const connected = [...data.messenger, ...data.instagram]
      onDone(
        connected.length > 0
          ? `Quedó conectado: ${connected.join(" y ")}. Lo que escriban ya entra a la Bandeja.`
          : `No se conectó: ${data.elsewhere.join(" y ")} ya está en otra clínica.`,
      )
    },
  })
  const selected = choices.data?.data.find((page) => page.id === pageId) ?? null

  return (
    <section aria-label="Elige la página de la clínica" className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Elige la página de la clínica</h2>
        <p className="text-sm text-muted-foreground">
          Marcaste varias páginas en Facebook. Se conecta solo la que elijas; para otra, vuelve a conectar después.
        </p>
      </div>
      {choices.isPending ? (
        <div className="flex flex-col gap-2" aria-label="Cargando las páginas">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : choices.isError ? (
        <Alert variant="destructive">
          <AlertDescription>La elección venció (dura 10 minutos). Vuelve a conectar con Facebook.</AlertDescription>
        </Alert>
      ) : (
        <>
          <RadioGroup
            aria-label="Páginas que marcaste en Facebook"
            className="flex flex-col gap-2"
            value={pageId ?? ""}
            onValueChange={(next) => setPageId(String(next))}
          >
            {choices.data.data.map((page) => (
              <FieldLabel
                key={page.id}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-3 rounded-xl border p-3 font-normal",
                  pageId === page.id && "border-primary bg-primary-soft",
                )}
              >
                <RadioGroupItem value={page.id} className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold">{page.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {page.instagram ? `Instagram unido: ${page.instagram}` : "Sin Instagram unido"}
                  </span>
                </span>
              </FieldLabel>
            ))}
          </RadioGroup>
          {selected?.instagram ? (
            <FieldLabel className="flex items-center gap-2 text-sm font-normal">
              <Checkbox checked={withInstagram} onCheckedChange={(checked) => setWithInstagram(checked === true)} />
              Conectar también su Instagram ({selected.instagram})
            </FieldLabel>
          ) : null}
          {choose.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No pudimos conectar esa página. Vuelve a conectar con Facebook.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!selected || choose.isPending}
              onClick={() => selected && choose.mutate({ pageId: selected.id, withInstagram: Boolean(selected.instagram) && withInstagram })}
            >
              {choose.isPending ? "Conectando…" : "Conectar esta página"}
            </Button>
            <Button type="button" variant="outline" onClick={() => onDone(null)}>
              Cancelar
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
