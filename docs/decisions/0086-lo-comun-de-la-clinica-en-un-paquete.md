# 0086 · Lo común de la clínica en un paquete; cada producto, una app delgada

Fecha: 2026-10-24 · Estado: aceptada · Precisa [0079](0079-un-nucleo-para-varios-productos.md) en las pantallas. Entrega 2 del plan de latidIA (issue #229), camino A del lienzo.

## Problema

latidIA necesita las mismas pantallas que odentIA: Agenda, Bandeja, Pacientes, Cobros, Reportes, Configuración y Agente. Hasta ahora vivían dentro de `apps/dental-clinic`, unas 149 000 líneas, de las que solo 38 archivos son dentales. Copiarlas a otra app duplica cada arreglo. Separarlas por carpetas dentro de una sola app no deja tener dos marcas, dos dominios y dos raíces.

## Decisión y motivo

- **`@odentia/clinic-app` tiene todo lo común de las pantallas:** componentes, `lib`, el contrato del producto (`productUi()`, ADR 0079) y las páginas. Cada producto es una app delgada: su raíz (nombre, ícono y estilos), su declaración del producto en `router.tsx`, lo suyo (en odentIA, `components/dental`, `lib/dental` y `product/dental`) y sus páginas propias.
- **Las páginas comunes existen una sola vez.** Cada app las monta con las rutas virtuales de TanStack Router (`virtualRouteConfig` en `vite.config.ts`): `physical()` de las carpetas `routes/public` y `routes/_org` del paquete, y en el layout `_org` también las páginas de la app (en odentIA, `src/routes/dental`, las hojas del odontograma). Las direcciones y los ids no cambian. Se comprobó: el árbol generado tiene las mismas 73 rutas que antes.
- **El paquete expone a cada producto solo lo que usa,** con una lista explícita de exportaciones (`package.json`), como `@odentia/auth`. Por dentro, lo común sigue usando rutas relativas.
- **El paquete nunca importa lo de un producto.** Lo vigila la misma prueba de límites del resto de lo común (`packages/dental/src/boundaries.test.ts`).
- **Lo que depende del árbol de rutas lo prueba cada app contra el suyo** (`lib/route-tree-checks.ts`): que cada pantalla tenga su regla de entrada, que cada padre dibuje a sus hijas y que las direcciones movidas sigan existiendo.

## Alternativas descartadas

- **Un archivo corto por página en cada app,** que solo apunta a la página del paquete: 74 archivos repetidos por producto, que pueden quedar distintos sin que nadie lo note.
- **Una sola app que cambia de marca según el dominio:** mezcla en el mismo bundle los dos productos, sus estilos y sus páginas propias, y cada cambio de marca se vuelve una condición en la pantalla.

## Consecuencias

- **Se gana:** un arreglo en una pantalla común llega a los dos productos. La app médica nace montando el paquete.
- **Se sacrifica:** las páginas del paquete se tipan con el árbol de rutas de una app (el `Register` de TanStack). Por eso el `tsconfig` del paquete incluye el router de odentIA, solo para los tipos. Además, Tailwind de cada app tiene que leer el paquete (`@source`).
- **Cuándo revisar:** si una versión de TanStack Start deja de aceptar `physical()` fuera de la carpeta de rutas, o si un producto necesita cambiar una página común entera y no solo sus partes.

## Referencias

- `packages/clinic-app/` (`src/product/product-ui.ts`, `src/lib/route-tree-checks.ts`, `vite.ts`).
- `apps/dental-clinic/vite.config.ts`, `src/router.tsx`, `src/route-tree.test.ts`.
- `packages/dental/src/boundaries.test.ts`.
