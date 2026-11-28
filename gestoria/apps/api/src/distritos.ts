/**
 * Los distritos de Lima Metropolitana y del Callao, con su código UBIGEO del INEI (Instituto
 * Nacional de Estadística e Informática, «Códigos de Ubicación Geográfica»: departamento,
 * provincia y distrito, dos cifras cada uno; 15 01 es Lima, provincia de Lima; 07 01 es la
 * Provincia Constitucional del Callao). Son 43 de Lima y 7 del Callao: Mi Perú (070107) es de
 * 2014 (Ley 30197). Ojo: RENIEC usa otros códigos (Lima 140101); aquí van siempre los del INEI.
 *
 * El nombre es el oficial, con su nombre de uso entre paréntesis donde la gente dice otro
 * (Lurigancho es «Chosica»); `short` es como cabe en el mapa y `aliases`, como lo escribe una
 * clienta («SJL», «Surco», «Cercado»): Sofi los entiende, nadie los escribe en la tienda.
 *
 * El grupo es la zona de Lima de Ipsos Perú («Perfiles Zonales 2025»: Lima Norte, Lima Centro,
 * Lima Moderna, Lima Este, Lima Sur y Callao). La plantilla de Lima (`entregas.ts`) parte de él.
 */

export type IpsosZone = "norte" | "centro" | "moderna" | "este" | "sur" | "callao"

export interface District {
  code: string
  name: string
  short: string
  province: "Lima" | "Callao"
  ipsos: IpsosZone
  aliases: string[]
}

const d = (
  code: string,
  name: string,
  ipsos: IpsosZone,
  short = name,
  aliases: string[] = [],
): District => ({
  code,
  name,
  short,
  province: code.startsWith("07") ? "Callao" : "Lima",
  ipsos,
  aliases,
})

export const DISTRICTS: readonly District[] = [
  d("150101", "Lima", "centro", "Lima", ["cercado", "cercado de lima", "lima cercado"]),
  d("150102", "Ancón", "norte"),
  d("150103", "Ate", "este", "Ate", ["ate vitarte", "vitarte"]),
  d("150104", "Barranco", "moderna"),
  d("150105", "Breña", "centro"),
  d("150106", "Carabayllo", "norte"),
  d("150107", "Chaclacayo", "este"),
  d("150108", "Chorrillos", "sur"),
  d("150109", "Cieneguilla", "este"),
  d("150110", "Comas", "norte"),
  d("150111", "El Agustino", "este", "El Agustino", ["agustino"]),
  d("150112", "Independencia", "norte"),
  d("150113", "Jesús María", "moderna"),
  d("150114", "La Molina", "moderna", "La Molina", ["molina"]),
  d("150115", "La Victoria", "centro", "La Victoria", ["victoria", "gamarra"]),
  d("150116", "Lince", "moderna"),
  d("150117", "Los Olivos", "norte", "Los Olivos", ["olivos"]),
  d("150118", "Lurigancho (Chosica)", "este", "Chosica", ["chosica", "lurigancho"]),
  d("150119", "Lurín", "sur"),
  d("150120", "Magdalena del Mar", "moderna", "Magdalena", ["magdalena"]),
  d("150121", "Pueblo Libre", "moderna"),
  d("150122", "Miraflores", "moderna"),
  d("150123", "Pachacámac", "sur"),
  d("150124", "Pucusana", "sur"),
  d("150125", "Puente Piedra", "norte"),
  d("150126", "Punta Hermosa", "sur"),
  d("150127", "Punta Negra", "sur"),
  d("150128", "Rímac", "centro"),
  d("150129", "San Bartolo", "sur"),
  d("150130", "San Borja", "moderna"),
  d("150131", "San Isidro", "moderna"),
  d("150132", "San Juan de Lurigancho", "este", "S. J. de Lurigancho", ["sjl"]),
  d("150133", "San Juan de Miraflores", "sur", "S. J. de Miraflores", ["sjm"]),
  d("150134", "San Luis", "centro"),
  d("150135", "San Martín de Porres", "norte", "S. M. de Porres", ["smp"]),
  d("150136", "San Miguel", "moderna"),
  d("150137", "Santa Anita", "este"),
  d("150138", "Santa María del Mar", "sur", "Santa María del Mar", ["santa maria"]),
  d("150139", "Santa Rosa", "norte"),
  d("150140", "Santiago de Surco", "moderna", "Surco", ["surco"]),
  d("150141", "Surquillo", "moderna"),
  d("150142", "Villa El Salvador", "sur", "Villa El Salvador", ["ves"]),
  d("150143", "Villa María del Triunfo", "sur", "Villa María del Triunfo", ["vmt"]),
  d("070101", "Callao", "callao", "Callao", ["callao cercado", "cercado del callao"]),
  d("070102", "Bellavista", "callao"),
  d("070103", "Carmen de la Legua Reynoso", "callao", "Carmen de la Legua", ["carmen de la legua"]),
  d("070104", "La Perla", "callao"),
  d("070105", "La Punta", "callao"),
  d("070106", "Ventanilla", "callao"),
  d("070107", "Mi Perú", "callao"),
]

export const DISTRICT_BY_CODE: ReadonlyMap<string, District> = new Map(
  DISTRICTS.map((district) => [district.code, district]),
)

export function isDistrict(code: string): boolean {
  return DISTRICT_BY_CODE.has(code)
}

/** El nombre corto de un distrito, o el código si no se conoce. */
export function districtName(code: string): string {
  return DISTRICT_BY_CODE.get(code)?.short ?? code
}

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * El distrito que nombra una clienta, en sus palabras («surco», «SJL», «San Juan de
 * Lurigancho»), o null si no se entiende o puede ser más de uno: entonces se le pregunta. Es lo
 * único que se lee de un texto; lo que guarda la tienda son siempre códigos.
 */
export function districtFromWords(words: string): District | null {
  const wanted = plain(words).replace(/^(distrito de|en|a) /, "")
  if (!wanted) return null
  const exact = DISTRICTS.filter(
    (district) =>
      plain(district.name) === wanted ||
      plain(district.short) === wanted ||
      district.aliases.some((alias) => plain(alias) === wanted),
  )
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) return null
  const partial = DISTRICTS.filter((district) => plain(district.name).includes(wanted))
  return wanted.length >= 4 && partial.length === 1 ? partial[0]! : null
}
