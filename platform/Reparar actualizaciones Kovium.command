#!/bin/bash
# Reabre la misma aplicación para reparar su comprobación de instalación.
# No cambia el bundle, las firmas, las cuentas ni ajustes de seguridad de macOS.
set -euo pipefail

if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  printf '%s\n' 'Este reparador es únicamente para macOS.' >&2
  exit 1
fi

EXPLICIT_APP=0
APP_PATH=''
if [ "$#" -eq 2 ] && [ "$1" = '--app' ]; then
  APP_PATH="$2"
  EXPLICIT_APP=1
elif [ "$#" -ne 0 ]; then
  printf '%s\n' 'Uso: Reparar actualizaciones Kovium.command [--app "/ruta/KOVIUM Launcher.app"]' >&2
  exit 64
else
  if [ -d '/Applications/KOVIUM Launcher.app' ]; then
    APP_PATH='/Applications/KOVIUM Launcher.app'
  elif [ -d "$HOME/Applications/KOVIUM Launcher.app" ]; then
    APP_PATH="$HOME/Applications/KOVIUM Launcher.app"
  else
    APP_PATH="$(/usr/bin/osascript <<'APPLESCRIPT'
set chosenApp to choose file with prompt "Selecciona la aplicación KOVIUM Launcher que ya tienes instalada." of type {"com.apple.application-bundle"} default location (path to applications folder)
return POSIX path of chosenApp
APPLESCRIPT
    )" || exit 1
  fi
fi

fail() {
  printf '%s\n' "$1" >&2
  if [ "$EXPLICIT_APP" -eq 0 ]; then
    /usr/bin/osascript - "$1" <<'APPLESCRIPT' || true
on run argv
  display alert "KOVIUM Launcher" message (item 1 of argv) as warning
end run
APPLESCRIPT
  fi
  exit 1
}

[ -d "$APP_PATH" ] || fail 'No se encontró la aplicación seleccionada.'
APP_PATH="$(cd -P "$APP_PATH" && pwd)"
PLIST="$APP_PATH/Contents/Info.plist"
[ -f "$PLIST" ] || fail 'La selección no es una aplicación de macOS válida.'
APP_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST" 2>/dev/null)" || fail 'No se pudo identificar la aplicación.'
APP_EXEC="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST" 2>/dev/null)" || fail 'No se pudo identificar su ejecutable.'
[ "$APP_ID" = 'com.kovium.launcher' ] || fail 'Selecciona KOVIUM Launcher; esta aplicación tiene otro identificador.'
[ "$APP_EXEC" = 'Electron' ] || fail 'Esta aplicación no utiliza la versión de Kovium afectada por este problema.'
EXECUTABLE="$APP_PATH/Contents/MacOS/$APP_EXEC"
ARCHIVE="$APP_PATH/Contents/Resources/app.asar"
[ -f "$EXECUTABLE" ] && [ -x "$EXECUTABLE" ] && [ ! -L "$EXECUTABLE" ] || fail 'El ejecutable de Kovium no es válido.'
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || fail 'Faltan los archivos originales del Launcher.'
/usr/bin/codesign --verify --deep --strict "$APP_PATH" 2>/dev/null || fail 'La aplicación no supera la comprobación de su firma. Descarga de nuevo Kovium desde su publicación oficial.'

# Leer procesos, sin terminarlos ni tocar Minecraft u otras aplicaciones.
if /bin/ps -axo comm= | /usr/bin/grep -Fqx -- "$EXECUTABLE" || /usr/sbin/lsof -t "$EXECUTABLE" >/dev/null 2>&1; then
  fail 'Cierra completamente KOVIUM Launcher con Cmd+Q y vuelve a abrir este reparador. Minecraft puede permanecer abierto.'
fi

# La variable sólo se aplica a este arranque y a su supervisor de actualización.
# No se guarda en el sistema, en el perfil ni en la aplicación.
/usr/bin/nohup /usr/bin/env ELECTRON_FORCE_IS_PACKAGED=1 "$EXECUTABLE" </dev/null >/dev/null 2>&1 &
REPAIR_PID=$!
printf 'KOVIUM_REPAIR_STARTED pid=%s\n' "$REPAIR_PID"
printf '%s\n' 'Kovium se abrió en modo de reparación de actualizaciones.' 'Déjalo abierto hasta que termine de actualizarse y reiniciarse. Después podrás abrirlo normalmente.'
