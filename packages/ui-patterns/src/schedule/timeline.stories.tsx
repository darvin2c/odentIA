import type { Meta, StoryObj } from "@storybook/react"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import * as React from "react"
import { SchedulePage } from "./schedule-page.js"

const meta = {
  title: "Patrones/Agenda/Timeline",
  parameters: { layout: "fullscreen" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

// Router aislado: los controles comparten search sin modificar la URL de Storybook.
function AgendaStory() {
  const [router] = React.useState(() =>
    createRouter({
      routeTree: createRootRoute({
        validateSearch: (search: Record<string, unknown>) => search,
        component: SchedulePage,
      }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    }),
  )
  return <RouterProvider router={router} />
}

export const Version3: Story = {
  name: "Agenda del equipo",
  render: () => <AgendaStory />,
}
