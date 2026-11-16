import { createFileRoute } from "@tanstack/react-router"
import { ChannelPage } from "../../components/integrations/channel-page"

/** Messenger: su cuenta conectada y las anteriores (una activa a la vez). */
export const Route = createFileRoute("/_org/settings/integrations/messenger")({
  component: () => <ChannelPage channel="messenger" />,
})
