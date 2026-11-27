# 0223 · gestorIA arma «Tu marca» con la cuenta común del color, y Configuración se ve por permisos

Fecha: 2026-11-27 · Estado: aceptada · Entrega 3a del lienzo «gestorIA como odentIA» (tableros 4,
10 y 21; sobre ADR 0162, 0203 y 0222)

## Problema

El menú del día de gestorIA mezclaba lo diario (Pedidos, Catálogo) con lo que se ajusta una vez
(Sofi, Pagos y entregas, Equipo, la hora de la tienda al pie de otra pantalla), y Ventas veía
pantallas que no podía tocar. La tienda tampoco tenía marca: el catálogo (tablero 21) necesita su
logo, su color, su portada y el nombre de su link, y el color de las clínicas vivía en
`@odentia/clinical`, que gestorIA no puede importar (ADR 0203).

## Decisión y motivo

- **La cuenta del color es de uso general**: `brandPalette`, `dominantColors`, `brandColorName`,
  `brandColorCss` y el contraste pasan a `@odentia/ui/lib/brand-color`, sin negocio. Las clínicas
  la siguen tomando de `@odentia/clinical`, que la vuelve a exportar y conserva lo suyo (el color
  de fábrica de cada producto y los sugeridos). Una sola cuenta: cualquier color vale y los tonos
  legibles se calculan al mostrarlo (ADR 0162).
- **«Tu marca» es el kit básico de la tienda**: el nombre que ve el cliente y el color en `store`;
  el logo y la portada en `store_image` (por su contenido, como las fotos del catálogo); el nombre
  del link en `store_link`. El color pinta la app de todo el equipo, siempre, como en las clínicas.
- **El nombre del link es único entre todas las tiendas** (la clave de `store_link`), aunque cada
  una vea solo los suyos: el choque lo dice la base y la API lo traduce. Un nombre cambiado queda
  con su tienda (nadie más lo toma; el catálogo lo llevará al nuevo). Los reservados (tablero 21)
  y los que se les parecen los bloquea la API (`marca.ts`); la base solo exige su forma de nombre
  de dominio.
- **Configuración se ve por permisos, sin permisos nuevos**: cada apartado lo ve quien puede
  cambiarlo (`configuracion`, `equipo.gestionar`, `plan`), y soporte mira lo que su permiso deja
  leer. Ventas no ve Configuración hasta que llegue «Avisos al celular». «Probar a Sofi» pasa a
  pedir `configuracion` en el servidor: sirve al ajustarla, no a diario.

## Alternativas descartadas

- Copiar la cuenta del color en gestorIA: dos cuentas que se separan con el tiempo.
- La opción «usar este color también en mi gestorIA» del lienzo: una decisión más sin un caso que
  la pida; las clínicas siempre usan su color.
- Nombres del link únicos por tienda: dos catálogos con la misma dirección.
- Un permiso nuevo para ver Configuración: la matriz ya dice quién cambia cada cosa.

## Consecuencias

- Un cambio en la cuenta del color toca a las clínicas y a gestorIA: corre las pruebas de ambas.
- Las direcciones de antes (`/sofi`, `/pagos-y-entregas`, `/equipo`, `/plan`) llevan a su lugar en
  Configuración. La hora de la tienda se cambia en Datos de la tienda.
- Ventas ya no prueba a Sofi; lo dice la Ayuda.
- Fuera de esta decisión: el catálogo que usa la portada y el link, que el nombre de antes lleve al
  nuevo, y los apartados Canales, Franjas y repartidores y Avisos al celular.

## Referencias

- `shared/packages/ui/src/lib/brand-color.ts`, `packages/clinical/src/brand-color.ts`.
- `gestoria/apps/api/src/marca.ts`, `gestoria/apps/web/src/marca.tsx`,
  `gestoria/apps/web/src/lib/configuracion.ts`.
- `gestoria/packages/db/drizzle/0018_tu_marca_y_los_datos_de_la_tienda.sql` y
  `0019_reglas_tu_marca.sql`.
