import type { Meta, StoryObj } from "@storybook/react-vite"
import { PerformanceSummary } from "../components/crm/performance-summary"

const meta = {
  title: "CRM/Resultados operativos",
  component: PerformanceSummary,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerformanceSummary>

export default meta
type Story = StoryObj<typeof meta>

export const ContinuidadConDesconocidos: Story = {
  args: {
    data: {
      responses: {
        conversations: 12,
        responded: 10,
        timedResponses: 8,
        avgFirstResponseSeconds: 420,
      },
      followUps: { open: 7, overdue: 3, unassigned: 1 },
      conversations: { closed: 9, waiting: 2 },
      proposals: { executed: 4, failed: 1, pending: 2 },
      handoffs: { cohort: 8, collected: 6, resolved: 4, cancelled: 1, open: 2, unknown: 1 },
      clinicalControls: { cohort: 10, realized: 6, cancelled: 1, pending: 2, unknown: 1 },
      taskTimeliness: { cohort: 14, onTime: 8, late: 2, cancelled: 1, open: 2, unknown: 1 },
      bookings: [
        { source: "recepcion", count: 7, active: 6 },
        { source: "agent", count: 3, active: 2 },
      ],
      conversion: [
        {
          channel: "whatsapp",
          assigneeUserId: "recepcion",
          assigneeName: "Ana Torres",
          created: 9,
          won: 4,
          lost: 2,
          open: 3,
          wonRate: 44.4,
        },
      ],
    },
  },
}

export const SinEvidenciaConocida: Story = {
  args: {
    data: {
      responses: null,
      followUps: null,
      conversations: null,
      proposals: null,
      bookings: null,
      conversion: null,
      handoffs: { cohort: 2, collected: 0, resolved: 0, cancelled: 0, open: 0, unknown: 2 },
      clinicalControls: { cohort: 1, realized: 0, cancelled: 0, pending: 0, unknown: 1 },
      taskTimeliness: { cohort: 3, onTime: 0, late: 0, cancelled: 0, open: 0, unknown: 3 },
    },
  },
}
