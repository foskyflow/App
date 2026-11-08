# Alerta Oro y Bitcoin

App web (instalable en el móvil como PWA) que muestra en tiempo real el precio del oro y del bitcoin y te avisa cuando bajan.

## Qué hace
- **Tiempo real**: bitcoin en directo desde Coinbase (WebSocket, se reconecta solo); oro desde gold-api.com cada 10 s.
- Pestañas **Oro / Bitcoin** con precio, variación en 24 h y gráfico (tócalo para ver el precio de cada momento).
- Avisos por separado para cada uno, con notificación, sonido y vibración:
  - cuando **cae un X %** desde el máximo (por defecto 1 % el oro y 3 % el bitcoin);
  - cuando **baja de un precio** que tú eliges.
- Precios en **€ o $**; el oro, por **onza troy o gramo**.
- Opción para **mantener la pantalla encendida** mientras la tienes abierta.
- Indica cuándo el mercado del oro está cerrado (fines de semana).

## Cómo usarla
1. Publicada con GitHub Pages desde la rama `main` (o en local: `python3 -m http.server 8000`).
2. En iPhone: ábrela en Safari → Compartir → *Añadir a pantalla de inicio*, y ábrela desde ese icono.
3. Pulsa **Activar notificaciones**.

## Limitaciones
- Solo vigila los precios **mientras la app está abierta**. En iPhone, al pasar a segundo plano el sistema la pausa
  en pocos segundos; al volver se pone al día al instante. Para avisos con la app cerrada haría falta un servicio externo.
- No es asesoramiento financiero.
