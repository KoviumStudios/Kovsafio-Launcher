# Publicación coordinada de Kovium

Windows, Linux y macOS consumen el mismo canal firmado `releases/download/channel/launcher-v2.json`. El contenido de `app.asar` debe ser idéntico (versión y SHA-256) en los cuatro destinos: Windows x64, Linux x64, macOS Intel y macOS Apple Silicon.

1. Preparar la aplicación firmada y sus paquetes en una versión borrador inactiva.
2. Comprobar una actualización real de Windows mediante el acceso directo habitual: firma, hash instalado y confirmación de arranque. Conservar el comprobante.
3. Ejecutar `kovium-platforms.yml` para todos los destinos nativos. Deben pasar arranque, actualización externa firmada y verificaciones de Java/Forge. Los paquetes y sus comprobantes quedan en el borrador.
4. Validar los cuatro comprobantes con `coordinated-release.cjs`. Un destino ausente, fallido o con otro hash impide publicar. Revalidar también sus hashes contra los archivos de la versión y la ejecución de CI.
5. Solo entonces activar la versión y reemplazar una vez el canal común firmado. Comprobar su firma, versión y hash desde la URL pública. Nunca sustituir archivos de una versión ya publicada.

La disponibilidad se activa para los tres sistemas a la vez. Cada cliente la aplica al abrirse o cuando el juego queda libre; un equipo apagado no se actualiza hasta conectarse. Los cambios de imágenes, instancias y modpacks usan el catálogo común y no requieren recompilar los instaladores.

Verificación del validador: `node --test platform/coordinated-release.test.cjs`. Uso: `node platform/coordinated-release.cjs metadata.json proofs.json`. Los comprobantes no contienen credenciales.
