# 0091 · Una administración neutra para los dos productos, en una sola dirección

Fecha: 2026-10-26 · Estado: aceptada · Sigue a [0079](0079-un-nucleo-para-varios-productos.md) y [0087](0087-dos-dominios-y-el-producto-de-la-clinica.md). Lienzo «Administración en negro», aprobado el 2026-10-26.

## Problema

La administración maneja las clínicas de odentIA y de latidIA, pero se veía como odentIA: logo y botones celestes, pestaña con su ícono. En Organizaciones, Hoy y Cobros no se distinguía de qué producto era cada clínica, y un consultorio de latidIA se abría en el dominio de odentIA. Además, `admin.latidia72.com` llevaba al panel de latidIA.

## Decisión y motivo

- **Neutra, en negro, grafito, gris y blanco** (`<html data-brand="admin">` en `globals.css`), en claro y en oscuro. Arriba del menú, la marca «A» con «Administración» y, debajo, los logos de odentIA y latidIA; la pestaña usa la misma «A».
- **El color solo distingue el producto de cada clínica** (`--product-dental`, `--product-medical`): un punto con su nombre, nunca una pastilla, para no confundirlo con los estados. Los estados (Activa, negociado, sin saldo) conservan su color porque avisan algo.
- **Filtro «Producto»** (Todos, odentIA, latidIA) en Hoy, Organizaciones, Lista de espera, Cobros y Costo y margen. Organizaciones filtra en el servidor y cuenta cada producto; las demás filtran sus filas con el producto de cada clínica (`GET /api/admin/organizations/products`). En Hoy, las colas de arriba suman los dos productos.
- **Una sola dirección: `admin.odentia32.com`.** Para el navegador cada dominio tiene su sesión y su equipo reconocido (0090): con dos direcciones habría que iniciar sesión y poner el código en cada una. `admin.` en el dominio de latidIA lleva ahí (`adminRedirectFor`).

## Alternativas descartadas

- **La administración en el color de cada producto o en las dos direcciones.** Cada vez que se entra por la otra se pide sesión y código, y adentro se ve lo mismo.
- **El producto como pastilla de color.** Se mezcla con las de estado y a simple vista no se sabe si dice qué es la clínica o cómo está.

## Referencias

`packages/ui/src/styles/globals.css` (`[data-brand="admin"]`), `apps/admin/src/components/product.tsx`, `apps/admin/src/routes/_app.tsx`, `packages/services/src/admin-organizations.ts` (`listOrganizations`, `listOrganizationProducts`), `packages/clinic-app/src/lib/host.ts` (`adminRedirectFor`).
