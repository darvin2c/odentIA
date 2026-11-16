import { createFileRoute } from "@tanstack/react-router"
import { ChannelPage, validateChannelSearch } from "../../components/integrations/channel-page"

/** Instagram: sus cuentas conectadas y las anteriores; vuelve aquí de «Conectar con Instagram». */
export const Route = createFileRoute("/_org/settings/integrations/instagram")({
  validateSearch: validateChannelSearch,
  component: function InstagramPage() {
    return <ChannelPage channel="instagram" search={Route.useSearch()} />
  },
})
