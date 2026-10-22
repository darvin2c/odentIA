import { pgSchema } from "drizzle-orm/pg-core"

// Cada esquema dice de quién es la tabla (ADR 0064) y, si es de un solo
// producto, de cuál (ADR 0079). En public queda lo que
// pertenece a una clínica; los nombres de tabla no se repiten entre esquemas,
// así que el SQL a mano los nombra sin esquema (search_path de la base).

/** El negocio de odentIA: administración, vendedores, lista de precios y reclamaciones. */
export const adminSchema = pgSchema("admin")

/** Listas oficiales y biblioteca global: todas las clínicas leen, ninguna escribe. */
export const catalogSchema = pgSchema("catalog")

/** Usuarios y acceso: una persona puede trabajar en varias clínicas. */
export const authSchema = pgSchema("auth")

/**
 * Lo que solo usa odentIA (ADR 0079): odontograma, periodontograma y sus
 * enlaces. Es de la clínica igual que `public`, con su RLS.
 */
export const dentalSchema = pgSchema("dental")
