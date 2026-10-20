# Presentación Fundadores

Presentación animada para las clínicas que entran primero al programa Fundadores: nueve problemas de la clínica, cada uno con la respuesta de odentIA, los agentes Sofi, Clío y Argos, el precio de clínica fundadora y cómo entrar. Se presenta con clics (cada parte muestra primero el problema y con un clic la respuesta) y tiene guion para quien presenta (tecla N).

## Armarla

```bash
node assets/presentations/founders/build.mjs
```

Deja `dist/founders.html`, un solo archivo que se abre en el navegador (necesita internet para las fuentes y three.js). `dist/` no se guarda en git.

## Qué hay aquí

- `source.html`: las 15 partes, los estilos, las escenas y el guion. Tiene tres marcadores que llena el armado: `%%LOGO%%`, `%%SCENE%%` y `%%BRACKETS%%`.
- `brackets-3d.js`: la parte 4 en three.js, con los corchetes de cada agente y el premolar de la portada.
- `build.mjs`: arma el archivo. La portada usa la escena real de las 32 piezas (`packages/brand-scene`), así que un cambio en la portada de la web llega aquí al volver a armarla.

## Reglas

- Solo piezas de la marca: el diente de la portada y los corchetes de Precios; nada de objetos genéricos.
- Cada agente con su color en todo lo que hace: Sofi celeste, Clío menta y Argos ámbar.
- Cifras de ejemplo marcadas como «Ejemplo». Las del plan Fundadores y el enlace del botón hay que confirmarlos con producción antes de presentar.
