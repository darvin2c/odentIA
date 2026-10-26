import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireSession } from "../../lib/guards"
import { adminRedirectFor, orgSlugFromHostname, panelUrl, requestHostname } from "../../lib/host"

export const Route = createFileRoute("/")({
  beforeLoad: async ({ location }) => {
    // `admin.` del dominio de latidIA lleva a la administración, que es una sola (ADR 0091).
    const toAdmin = adminRedirectFor(requestHostname())
    if (toAdmin) throw redirect({ href: toAdmin })
    if (!orgSlugFromHostname(requestHostname())) {
      throw redirect({ href: panelUrl("/") })
    }
    await requireSession(location)
    throw redirect({ to: "/home" })
  },
})
