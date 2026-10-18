/** «USD 100», como en la web: punto de miles, coma decimal y sin decimales si son ceros. */
export function creditText(currency: string, cents: number): string {
  const value = (Math.round(cents) / 100).toFixed(2).replace(".", ",")
  const trimmed = value.endsWith(",00") ? value.slice(0, -3) : value
  return `${currency} ${trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`
}
