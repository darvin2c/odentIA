import { createFileRoute } from "@tanstack/react-router"
import { ChannelPage, validateChannelSearch } from "../../components/integrations/channel-page"

/** Messenger: sus páginas conectadas y las anteriores; vuelve aquí para elegir una página de Facebook. */
export const Route = createFileRoute("/_org/settings/integrations/messenger")({
  validateSearch: validateChannelSearch,
  component: function MessengerPage() {
    return <ChannelPage channel="messenger" search={Route.useSearch()} />
  },
})
