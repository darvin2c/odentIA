import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireSession } from "../lib/guards"
import { orgSlugFromHostname, panelUrl, requestHostname } from "../lib/host"

export const Route = createFileRoute("/")({
  beforeLoad: async ({ location }) => {
    if (!orgSlugFromHostname(requestHostname())) {
      throw redirect({ href: panelUrl("/") })
    }
    await requireSession(location)
    throw redirect({ to: "/home" })
  },
})
