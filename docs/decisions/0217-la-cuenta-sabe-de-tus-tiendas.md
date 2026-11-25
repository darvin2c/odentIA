# 0217 · La cuenta sabe de tus tiendas: gestorIA le avisa quién está en cada una

Fecha: 2026-11-25 · Estado: aceptada · Paso opcional del lienzo «Una cuenta, todas las apps»
(decisión 8, tableros 7 y 11)

## Problema

El selector de lugares de las clínicas (`PlaceSwitcher`, PR 696) ya agrupa por app y el pase
(ADR 0215) abre otro dominio con la misma sesión, pero las tiendas de gestorIA no salían: viven
en la base de gestorIA, que la cuenta no lee (ADR 0203). Por lo mismo, cerrar la cuenta solo
miraba las clínicas: la única Dueña de una tienda podía cerrarla y dejar la tienda sin Dueño
(gestorIA solo promueve al Administrador más antiguo, si hay).

## Decisión y motivo

- **gestorIA avisa el equipo entero de cada tienda** con un aviso nuevo del acuerdo
  (`equipo.cambiado` de `@odentia/contract`: nombre y cada persona con su rol `owner`, `admin`
  o `sales`), por la misma bandeja de salida (`contract_outbox`) y la misma firma que los demás.
  Va en la transacción de cada cambio: abrir la tienda, entrar alguien, cambiar un rol, sacar a
  alguien y cerrarse la cuenta de alguien del equipo. Siempre entero, nunca el cambio suelto:
  repetido o en desorden da lo mismo (manda el de `timestamp` más nuevo) y no hace falta otro
  mensaje para la carga inicial.
- **La carga inicial es la revisión de cada hora**: gestorIA compara el equipo de cada tienda con
  lo último que avisó y avisa lo que no coincide. La primera vuelta después de desplegar avisa
  todas las tiendas de antes; después arregla lo que dos cambios a la vez hayan dejado atrás.
- **La cuenta guarda una copia** (`auth.app_place` y `auth.app_place_member`, sin `GRANT`: solo
  la conexión propietaria) y nadie la edita. `GET /api/account/places` la devuelve a la persona;
  cada pantalla arma la dirección de la tienda (`app.<VITE_GESTORIA_DOMAIN>/tiendas/<id>`) con el
  pase. Sin ese dominio, las tiendas no salen.
- **Cerrar la cuenta revisa la copia** (`closeMyAccount` y `closeAccountByAdmin`): no se cierra si
  la persona es la única Dueña de una tienda, y el mensaje dice cuál, como con la única
  Propietaria de una clínica. Quien ya cerró su cuenta no cuenta como otra Dueña aunque gestorIA
  todavía no haya avisado que salió. gestorIA no cambia lo que hace al recibir `cuenta.cerrada`.

## Alternativas descartadas

- **Preguntarle a gestorIA en cada apertura del selector:** ata el selector de las clínicas a que
  gestorIA responda («si falla, las clínicas no lo notan», ADR 0203) y pide un tiempo de espera y
  un estado «no responden» en cada clic.
- **Avisar altas, bajas y cambios de rol por separado:** cada uno depende del anterior; uno
  perdido o en desorden deja la copia mal para siempre, y la carga inicial sería otro mensaje.
- **Sumar el equipo a `cuenta.abierta`:** ese aviso es de la cuenta de cobro, que se separa de la
  cuenta de la persona en los pasos 6 y 7 del lienzo A.

## Consecuencias

- **Beneficio:** quien usa clínicas y tiendas pasa de una a otra desde el selector, sin clave, y
  ninguna tienda queda sin Dueño por un cierre de cuenta hecho desde las clínicas.
- **Sacrificio:** la copia va unos segundos detrás (la bandeja sale cada 30 segundos): una tienda
  recién creada o a la que se acaba de entrar aparece al rato, y un cierre de cuenta puede pasar
  si la otra Dueña salió hace segundos (gestorIA sigue promoviendo al Administrador, si hay).
  `user_id` no es clave foránea, como en `account_event`.
- **Cuándo revisarlo:** si otra app que es otro sistema necesita sus lugares en el selector, o si
  la cuenta se muda a su propia casa (paso 7 del lienzo A).

## Referencias

`shared/packages/contract/src/messages.ts` (`teamChangedEvent`), `packages/services/src/app-places.ts`,
`gestoria/apps/api/src/acuerdo.ts` (`noteStoreTeam`, `reviewStoreTeams`); migraciones
`0158_las_tiendas_de_cada_persona.sql` y, en gestorIA, `0012_el_equipo_de_cada_tienda.sql`.
