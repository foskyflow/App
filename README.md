# 🪙 Alerta Oro

App web (instalable en el móvil como PWA) que vigila el precio del oro y te avisa cuando baja.

## Qué hace
- Muestra el precio actual del oro en **USD o EUR**, por **onza troy o gramo**, con un gráfico de la sesión.
- Te avisa (notificación del sistema + sonido) cuando:
  - el precio **baja de un valor** que tú eliges, y/o
  - el precio **cae un X %** desde el máximo reciente (por defecto 1 %).
- Guarda tus ajustes y el historial de avisos en el navegador.

## Cómo usarla
1. Abre `index.html` servido por HTTP (las notificaciones no funcionan con `file://`):
   ```bash
   python3 -m http.server 8000
   # y abre http://localhost:8000
   ```
   O publícala gratis con **GitHub Pages** (Settings → Pages → rama `main`, carpeta raíz).
2. Pulsa **🔔 Activar notificaciones** y acepta el permiso.
3. Configura cuándo quieres el aviso y deja la app abierta (puede estar en segundo plano).
4. En el móvil: menú del navegador → *Añadir a pantalla de inicio*.

## Limitaciones
- Avisa **mientras la app esté abierta** (pestaña o app instalada). Para avisos con la app cerrada haría falta un pequeño servidor con *push*.
- Datos: [gold-api.com](https://gold-api.com) (precio spot XAU en USD/onza) y [frankfurter.dev](https://frankfurter.dev) (cambio USD→EUR).
- No es asesoramiento financiero.
