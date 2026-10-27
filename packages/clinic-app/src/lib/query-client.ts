import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "./api"

/**
 * La caché de datos de la clínica. Lo traído hace menos de 10 s no se vuelve a
 * pedir al montar: las utilidades de la cabecera se montan de nuevo en cada
 * pantalla. Lo que cambia lo siguen invalidando las mutaciones y los eventos.
 * Un 4xx no mejora reintentando: se muestra enseguida en vez de esperar ~7 s.
 * Una por app en el navegador y una por petición en SSR (nunca compartida
 * entre sesiones): se crea con `useState` en la raíz.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (failures, error) => failures < 3 && !(error instanceof ApiError && error.status < 500),
      },
    },
  })
}
