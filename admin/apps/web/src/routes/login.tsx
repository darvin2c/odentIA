import { createFileRoute, redirect } from "@tanstack/react-router"
import { loginUrl } from "../lib/host"

export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    throw redirect({ href: loginUrl() })
  },
})
