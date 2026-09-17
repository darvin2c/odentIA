import { cn, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@odentia/ui"
import { Search, X } from "lucide-react"
import * as React from "react"
import { common } from "../common.js"
import { useListSearch } from "./list-search.js"

export interface SearchInputProps {
  placeholder?: string
  expandable?: boolean
  className?: string
}

export function SearchInput({
  placeholder = common.filters.search,
  expandable = false,
  className,
}: SearchInputProps) {
  const { get, setParam } = useListSearch()
  const query = get("q") ?? ""
  const [value, setValue] = React.useState(query)

  React.useEffect(() => {
    setValue(query)
  }, [query])

  React.useEffect(() => {
    if (value === query) return
    const timeout = window.setTimeout(() => {
      setParam("q", value.trim() || undefined, { replace: true })
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [query, setParam, value])

  return (
    <div
      className={cn(
        expandable
          ? "relative w-36 shrink-0 transition-[width] duration-200 ease-out focus-within:w-64 motion-reduce:transition-none"
          : "relative w-full min-w-52",
        className,
      )}
    >
      <InputGroup className="h-9">
        <InputGroupAddon align="inline-start">
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={value}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <InputGroupAddon align="inline-end">
          {value ? (
            <InputGroupButton
              size="icon-xs"
              aria-label={common.filters.clear}
              onClick={() => {
                setValue("")
                setParam("q", undefined, { replace: true })
              }}
            >
              <X aria-hidden />
            </InputGroupButton>
          ) : null}
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}
