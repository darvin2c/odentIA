// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { listeningClock, useListeningStatus } from "./use-listening-status.js"
import type { MicLevel } from "./use-mic-level.js"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("useListeningStatus", () => {
  it("cuenta el tiempo y avisa tras ocho segundos sin voz", () => {
    const { result, rerender } = renderHook(({ listening, metering }: { listening: boolean; metering: MicLevel }) => useListeningStatus(listening, metering), {
      initialProps: { listening: true, metering: { level: 0.4, streamState: "active" } },
    })
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current).toEqual({ seconds: 3, silent: false })
    rerender({ listening: true, metering: { level: 0, streamState: "active" } })
    act(() => vi.advanceTimersByTime(8000))
    expect(result.current.silent).toBe(true)
    // La voz vuelve: el aviso se va.
    rerender({ listening: true, metering: { level: 0.3, streamState: "active" } })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.silent).toBe(false)
  })

  it("sin medición real nunca dice «No te oigo», y al dejar de escuchar vuelve a cero", () => {
    const { result, rerender } = renderHook(({ listening, metering }: { listening: boolean; metering: MicLevel }) => useListeningStatus(listening, metering), {
      initialProps: { listening: true, metering: { level: 0, streamState: "denied" } },
    })
    act(() => vi.advanceTimersByTime(20_000))
    expect(result.current.silent).toBe(false)
    rerender({ listening: false, metering: { level: 0, streamState: "idle" } })
    expect(result.current).toEqual({ seconds: 0, silent: false })
  })

  it("el reloj se lee «0:08» y «1:24»", () => {
    expect(listeningClock(8)).toBe("0:08")
    expect(listeningClock(84)).toBe("1:24")
  })
})
