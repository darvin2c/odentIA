# 0183 · La carga de una clínica corre en el servidor, desde la skill

Fecha: 2026-11-12 · Estado: aceptada · Cambia el paso «Ensayar» y una alternativa descartada de la [0104](0104-cargar-los-datos-de-una-clinica-nueva.md)

## Problema

La 0104 dejó la carga en la administración: la skill preparaba el plan y una persona lo subía en la ficha de la clínica, con su segundo factor. Con la primera clínica real el recorrido se cortó en cada paso: la skill arma el plan, el PDF y el informe, pero cargar y enviar obligaba a pasar archivos a mano a la pantalla, y el informe no podía salir desde la máquina del equipo (el correo de producción no conecta desde ahí). La 0104 había descartado un script contra producción porque se saltaba el segundo factor y la auditoría y dejaba la conexión owner fuera de la API.

## Decisión y motivo

- **La skill corre cada orden dentro del contenedor de la API de producción, por SSH** (`import:produccion` → `apps/api/src/cli/carga.ts`): ensayar, cargar, enviar el informe y registrarlo. La conexión owner no sale del servidor: el comando usa el mismo entorno que la API.
- **Las mismas operaciones que antes** (`apps/api/src/lib/clinic-load.ts`): el mismo ensayo dentro de una transacción que se deshace, la misma carga por tandas que no duplica, el mismo informe que sale una sola vez con su PDF guardado.
- **El control de acceso es el del servidor**: entrar por SSH exige la llave del equipo, que es más que el segundo factor de la pantalla. Quien carga se nombra con `--como` y tiene que ser personal activo con rol de administración; la auditoría queda a su nombre, como antes.
- **La administración pasa a ser el registro**: la pestaña «Carga» de la ficha muestra las cargas con sus cifras y quién las hizo, y los informes con su PDF tal como salió. No carga ni envía nada.

## Alternativas descartadas

- **Seguir cargando por la pantalla**: duplica el trabajo (la skill arma, la persona sube) y el informe igual tenía que salir del servidor.
- **Una ruta de la API para la skill, con un token**: un secreto más que guardar y rotar, para lo mismo que ya da la llave SSH.
- **Un script desde la máquina del equipo con la conexión owner**: sigue descartado; la base de producción no se abre hacia afuera.

## Consecuencias

- **Beneficio:** la carga y el informe salen en un solo recorrido, con la aprobación de quien acompaña en cada paso, y queda a la vista en la administración.
- **Sacrificio:** cargar exige acceso SSH al servidor; quien no lo tiene no carga. El rol se comprueba con el correo que se escribe en `--como`, no con una sesión.
- **Revisar** si carga más de una persona del equipo o si la carga pasa a ser autoservicio de la clínica: entonces vuelve a la pantalla, con su sesión.
