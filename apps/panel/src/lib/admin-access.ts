import { queryOptions } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "./api"

const accessSchema = z.object({ data: z.object({ staff: z.boolean() }) })
export const adminAccessQuery = queryOptions({
  queryKey: ["account", "admin-access"],
  queryFn: async () => accessSchema.parse(await apiFetch<unknown>("/api/account/admin-access")).data,
  staleTime: 60_000,
})
