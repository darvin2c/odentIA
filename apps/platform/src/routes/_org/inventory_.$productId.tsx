import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * El producto no tiene página propia (tablero 6): se abre al lado de la lista
 * de Inventario. Esta dirección se conserva porque hay avisos y enlaces
 * guardados con ella: solo redirige.
 */
export const Route = createFileRoute("/_org/inventory_/$productId")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/inventory", search: { producto: params.productId }, replace: true })
  },
})
