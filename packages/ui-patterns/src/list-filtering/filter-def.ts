import type { LucideIcon } from "lucide-react"

export type FilterOption = {
  value: string
  label: string
  count?: number
}

export type FilterPlacement = "primary" | "overflow"

type FilterBase = {
  key: string
  label: string
  icon?: LucideIcon
  placement?: FilterPlacement
}

export type FilterDef =
  | (FilterBase & {
      type: "select"
      options: FilterOption[]
    })
  | (FilterBase & {
      type: "multi"
      options: FilterOption[]
    })
  | (FilterBase & {
      type: "number-range"
      money?: boolean
    })
  | (FilterBase & {
      type: "date"
    })
  | (FilterBase & {
      type: "date-range"
    })

export type SortOption = { value: string; label: string }

export function paramKeys(filter: FilterDef): string[] {
  switch (filter.type) {
    case "number-range":
      return [`${filter.key}_min`, `${filter.key}_max`]
    case "date":
      return [`${filter.key}_on`]
    case "date-range":
      return [`${filter.key}_from`, `${filter.key}_to`]
    default:
      return [filter.key]
  }
}
