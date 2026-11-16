import { Button } from "@odentia/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"

/** Si la instalación tiene «Conectar con Facebook» para páginas: sin él, solo «con tu propia app». */
export function useFacebookPages(enabled: boolean): boolean {
  const status = useQuery({
    queryKey: ["meta-pages-status"],
    queryFn: () => apiFetch<{ data: { enabled: boolean } }>("/api/meta-pages/status"),
    enabled,
    retry: 1,
    staleTime: Number.POSITIVE_INFINITY,
  })
  return status.data?.data.enabled === true
}

/**
 * Va directo a la ventana de Facebook, como Gmail: la clínica marca sus páginas
 * y vuelve a Integraciones con Messenger y el Instagram unido a cada una.
 */
export function FacebookPagesButton({ label, variant = "default" }: { label: string; variant?: "default" | "outline" }) {
  const start = useMutation({
    mutationFn: () => apiFetch<{ data: { url: string } }>("/api/meta-pages/start", { method: "POST" }),
    onSuccess: ({ data }) => {
      window.location.href = data.url
    },
  })
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant={variant} className="self-start" disabled={start.isPending} onClick={() => start.mutate()}>
        {start.isPending ? "Abriendo Facebook…" : label}
      </Button>
      {start.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pudimos abrir Facebook. Vuelve a intentarlo.
        </p>
      ) : null}
    </div>
  )
}
