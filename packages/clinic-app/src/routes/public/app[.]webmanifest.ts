import { createFileRoute } from "@tanstack/react-router"
import { loadClinicAppearance } from "../../lib/clinic-color"
import { clinicWebManifest } from "../../lib/web-manifest"
import { productUi } from "../../product/product-ui"

/**
 * El manifiesto de la app instalada de esta clínica (ADR 0177). Solo lo enlaza
 * la zona con sesión (`_org`): el portal del paciente no ofrece instalar la app
 * del equipo. Se pide de nuevo en cada carga: un cambio de nombre o color se ve.
 */
export const Route = createFileRoute("/app.webmanifest")({
  server: {
    handlers: {
      GET: async () => {
        const appearance = await loadClinicAppearance()
        // Sin saber de qué clínica es (la API no respondió), nada: el navegador conserva la
        // app instalada como estaba en vez de cambiarle el nombre por el del producto.
        if (!appearance.name) return new Response(null, { status: 503, headers: { "retry-after": "60" } })
        return new Response(JSON.stringify(clinicWebManifest(appearance, productUi().product)), {
          headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" },
        })
      },
    },
  },
})
