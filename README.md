# Money

App web estatica para control personal de ingresos, gastos, deudas y ahorro. Esta pensada para publicarse directo en GitHub Pages.

## Estructura

- `index.html`: estructura de la interfaz, modales, navegacion inferior y contenedores de cada pagina.
- `styles.css`: estilos globales, layout mobile-first, tarjetas, botones, modales y estados visuales.
- `app.js`: estado, calculos, renderizado, localStorage, navegacion entre meses, deudas, gastos y ahorro.

## Publicacion en GitHub Pages

Los archivos usan rutas relativas (`styles.css`, `app.js`, `manifest.json`, `icon-192.png`), asi que pueden servirse desde la raiz del repo o desde una carpeta publicada por Pages sin build step.

Para publicar:

1. Sube `index.html`, `styles.css`, `app.js` y los assets existentes al branch configurado en GitHub Pages.
2. En GitHub, ve a `Settings -> Pages`.
3. Selecciona el branch/carpeta donde vive esta app.
4. Espera a que Pages despliegue el sitio.

## Datos

La app guarda todo en `localStorage` bajo la llave `finanzas-v3`. No hay backend ni base de datos remota.

Modelo general:

- `state.months[YYYY-MM]`: datos de cada mes.
- `ingresos`: ingresos y sub-ingresos del mes.
- `expenses`: gastos normales y salidas del ahorro.
- `tarjetas`: deudas/tarjetas del mes.
- `depositos`: depositos al ahorro.

## Notas Para Futuras Iteraciones

- La deuda se calcula como `saldo anterior + gastos de tarjeta - pago del mes`.
- Al pasar al siguiente mes, `confirmarArrastre()` debe copiar el saldo pendiente a `nextMd.tarjetas` con `saldoOverride`.
- Los pagos de tarjeta se descuentan del ingreso elegido con `fuentePago`.
- El ahorro visual debe usar neto cuando corresponde: `depositos del mes - salidas del ahorro`.
- El saldo total de ahorro se calcula acumulando depositos y restando gastos con `fuente === '__AHORRO__'`.
- Evita guardar campos calculados como `saldo` o `saldoBase` en localStorage; se recalculan desde `app.js`.

## Desarrollo

No requiere instalacion de dependencias. Puedes abrir `index.html` directamente en el navegador o servir la carpeta con cualquier servidor estatico.
