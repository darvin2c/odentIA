import { toast } from "@odentia/ui"
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"
import { ApiError } from "./api"

/**
 * La caché de datos de la clínica. Lo traído hace menos de 10 s no se vuelve a
 * pedir al montar: las utilidades de la cabecera se montan de nuevo en cada
 * pantalla. Lo que cambia lo siguen invalidando las mutaciones y los eventos.
 * Un 4xx no mejora reintentando: se muestra enseguida en vez de esperar ~7 s.
 * Una por app en el navegador y una por petición en SSR (nunca compartida
 * entre sesiones): se crea con `useState` en la raíz.
 * Si la clínica empieza a pedir verificación en dos pasos con la pantalla
 * abierta (ADR 0107), la primera consulta que lo dice recarga: el layout
 * muestra entonces cómo seguir. Un guardado que falla por eso no recarga: lo
 * escrito se conserva, y el aviso ofrece seguir cuando la persona quiera.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadWhenTwoFactorRequired }),
    mutationCache: new MutationCache({ onError: offerTwoFactorStep }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (failures, error) => failures < 3 && !(error instanceof ApiError && error.status < 500),
      },
    },
  })
}

function asksTwoFactor(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.shape.code === "TWO_FACTOR_REQUIRED" || error.shape.code === "TWO_FACTOR_CODE_REQUIRED")
}

let reloading = false
function reloadWhenTwoFactorRequired(error: unknown): void {
  if (reloading || typeof window === "undefined") return
  if (asksTwoFactor(error)) {
    reloading = true
    window.location.reload()
  }
}

function offerTwoFactorStep(error: unknown): void {
  if (!asksTwoFactor(error)) return
  toast.error(error.message, {
    id: "verificacion-en-dos-pasos",
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Verificar ahora", onClick: () => window.location.reload() },
  })
}
