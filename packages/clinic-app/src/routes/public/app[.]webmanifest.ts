import { createFileRoute } from "@tanstack/react-router"
import { loadClinicAppearance } from "../../lib/clinic-color"
import { clinicWebManifest } from "../../lib/web-manifest"

/**
 * El manifiesto de la app instalada de esta clínica (ADR 0176). Solo lo enlaza
 * la zona con sesión (`_org`): el portal del paciente no ofrece instalar la app
 * del equipo. Se pide de nuevo en cada carga: un cambio de nombre o color se ve.
 */
export const Route = createFileRoute("/app.webmanifest")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify(clinicWebManifest(await loadClinicAppearance())), {
          headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" },
        }),
    },
  },
})
