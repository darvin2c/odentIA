import { Button } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { api } from "./lib/api"

/**
 * La vuelta de Mercado Pago (`/mercadopago/vuelta`, la dirección registrada en la aplicación de
 * gestorIA): trae el código y el `state` del intento. El servidor comprueba que el intento es de
 * esta persona, sigue vigente y no se usó, cambia el código por las credenciales y dice de qué
 * tienda era: se vuelve a su Cobros. Si la persona dijo que no, se dice y se vuelve igual.
 */
export function MercadoPagoReturnPage() {
  const params = useSearch({ strict: false }) as Record<string, string | undefined>
  const navigate = useNavigate()
  const storeOfState = /^([0-9a-f-]{36})\./.exec(params.state ?? "")?.[1] ?? null
  const finish = useMutation({
    mutationFn: () =>
      api<{ storeId: string; mode: "prueba" | "real" }>("/api/link-de-pago/vuelta", {
        method: "POST",
        body: { state: params.state ?? "", code: params.code ?? "" },
      }),
    onSuccess: ({ storeId, mode }) =>
      void navigate({
        href: `/tiendas/${storeId}/configuracion/medios-de-pago?mp=${mode}`,
        replace: true,
      }),
  })
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current || !params.code || !params.state) return
    sent.current = true
    finish.mutate()
  }, [finish, params.code, params.state])
  const back = storeOfState ? `/tiendas/${storeOfState}/configuracion/medios-de-pago` : "/"

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      {!params.code || !params.state ? (
        <>
          <ErrorState
            title="No se conectó Mercado Pago"
            message={
              params.error === "access_denied"
                ? "No diste el permiso en Mercado Pago. Puedes volver a intentarlo cuando quieras."
                : "Mercado Pago no devolvió el permiso. Vuelve a Cobros e inténtalo otra vez."
            }
          />
          <Button render={<a href={back} />}>Volver a Cobros</Button>
        </>
      ) : finish.isError ? (
        <>
          <ErrorState title="No se conectó Mercado Pago" error={finish.error} />
          <Button render={<a href={back} />}>Volver a Cobros</Button>
        </>
      ) : (
        <LoadingState message="Conectando tu Mercado Pago…" />
      )}
    </main>
  )
}
