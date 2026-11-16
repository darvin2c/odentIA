import { createFileRoute } from "@tanstack/react-router"
import { ChannelPage } from "../../components/integrations/channel-page"

/** Telegram: su cuenta conectada y las anteriores (una activa a la vez). */
export const Route = createFileRoute("/_org/settings/integrations/telegram")({
  component: () => <ChannelPage channel="telegram" />,
})
