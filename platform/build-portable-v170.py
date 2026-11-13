#!/usr/bin/env python3
"""Repackage checksum-verified official Electron Unix runtimes, preserving modes.

macOS ZIPs made on Windows are explicitly unsigned inputs for the native signing
job; only that job emits the final macOS ZIP after codesign verification.
"""
import argparse, hashlib, io, json, os, pathlib, plistlib, stat, tarfile, zipfile

EPOCH=1700000000
def sha(file):
    h=hashlib.sha256()
    with open(file,'rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''): h.update(chunk)
    return h.hexdigest()
def mode(info): return (info.external_attr>>16) or (stat.S_IFDIR|0o755 if info.is_dir() else stat.S_IFREG|0o644)
def tar_add_directory(t,name):
    """dpkg requires each parent directory to precede the files it contains."""
    emitted=getattr(t,'_kovium_directories',None)
    if emitted is None:emitted=set();t._kovium_directories=emitted
    parts=pathlib.PurePosixPath(name.rstrip('/')).parts
    if not parts or any(p in ('','.', '..','/') for p in parts):raise ValueError('Invalid archive directory')
    for end in range(1,len(parts)+1):
        folder='/'.join(parts[:end])
        if folder in emitted:continue
        info=tarfile.TarInfo(folder);info.type=tarfile.DIRTYPE;info.mode=0o755;info.uid=info.gid=0;info.uname=info.gname='';info.mtime=EPOCH;t.addfile(info);emitted.add(folder)
def tar_add_parents(t,name):
    parent=pathlib.PurePosixPath(name).parent
    if str(parent)!='.':tar_add_directory(t,str(parent))
def tar_add_bytes(t,name,data,permissions=0o644):
    tar_add_parents(t,name)
    info=tarfile.TarInfo(name);info.size=len(data);info.mode=permissions;info.mtime=EPOCH;t.addfile(info,io.BytesIO(data))
def zip_info(name,permissions):
    z=zipfile.ZipInfo(name,date_time=(2023,11,14,22,13,20));z.create_system=3;z.external_attr=permissions<<16;z.compress_type=zipfile.ZIP_DEFLATED;return z
def validate_elf(z,arch):
    with z.open('electron') as f: h=f.read(20)
    if h[:4]!=b'\x7fELF' or int.from_bytes(h[18:20],'little')!=({'x64':62,'arm64':183}[arch]): raise ValueError('Wrong ELF architecture')
def validate_mach(z,arch):
    with z.open('Electron.app/Contents/MacOS/Electron') as f: h=f.read(8)
    if h[:4]!=b'\xcf\xfa\xed\xfe' or int.from_bytes(h[4:8],'little')!=({'x64':0x1000007,'arm64':0x100000c}[arch]): raise ValueError('Wrong Mach-O architecture')
def unix_members(z,prefix):
    for info in z.infolist():
        if info.filename in ('resources/default_app.asar',): continue
        name='kovium-launcher' if info.filename=='electron' else info.filename
        target=prefix+'/'+name.rstrip('/');permissions=mode(info)
        t=tarfile.TarInfo(target);t.mtime=EPOCH;t.mode=stat.S_IMODE(permissions);t.uid=t.gid=0;t.uname=t.gname=''
        if info.is_dir(): t.type=tarfile.DIRTYPE;t.size=0
        elif stat.S_ISLNK(permissions):
            t.type=tarfile.SYMTYPE;t.linkname=z.read(info).decode();t.size=0
        else: t.type=tarfile.REGTYPE;t.size=info.file_size
        yield info,t
def linux_tar(z,target,asar,logo,version,deb=False):
    prefix='opt/kovium-launcher' if deb else 'kovium-launcher'
    with tarfile.open(target,'w:gz',format=tarfile.PAX_FORMAT,compresslevel=6) as t:
        tar_add_directory(t,prefix)
        for info,member in unix_members(z,prefix):
            if member.isdir():tar_add_directory(t,member.name);continue
            tar_add_parents(t,member.name)
            if member.isreg():
                with z.open(info) as stream:t.addfile(member,stream)
            else:t.addfile(member)
        with open(asar,'rb') as stream:
            tar_add_parents(t,prefix+'/resources/app.asar')
            m=tarfile.TarInfo(prefix+'/resources/app.asar');m.size=os.path.getsize(asar);m.mode=0o644;m.mtime=EPOCH;t.addfile(m,stream)
        tar_add_bytes(t,prefix+'/kovium.png',logo)
        if deb:
            desktop='[Desktop Entry]\nType=Application\nName=KOVIUM Launcher\nComment=Minecraft y la comunidad de Kovium\nExec=/opt/kovium-launcher/kovium-launcher %U\nIcon=/opt/kovium-launcher/kovium.png\nTerminal=false\nCategories=Game;\nStartupWMClass=kovium-launcher\n'
            tar_add_bytes(t,'usr/share/applications/kovium-launcher.desktop',desktop.encode())
        else:
            script='#!/bin/sh\nset -eu\nKOVIUM_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$KOVIUM_DIR/kovium-launcher" "$@"\n'
            tar_add_bytes(t,prefix+'/Abrir Kovium.sh',script.encode(),0o755)
            readme='KOVIUM Launcher '+version+'\n\nExtrae esta carpeta y abre «Abrir Kovium.sh». El launcher instala Java y el contenido del juego automáticamente.\n\nSi tu distribución no permite el sandbox de Chromium para aplicaciones portables, instala el paquete .deb con el instalador de paquetes del sistema. No desactives el sandbox.\n\nDiscord y Microsoft utilizan el navegador oficial y el almacén de claves del escritorio (Secret Service o KWallet). Si no hay un almacén seguro disponible, se informará en Cuentas en lugar de guardar secretos en texto plano.\n\nLas actualizaciones firmadas se guardan en tu perfil. Conserva completa esta carpeta.\n'
            tar_add_bytes(t,prefix+'/LEEME.txt',readme.encode())
def ar_member(out,name,file=None,data=None):
    size=os.path.getsize(file) if file else len(data)
    header=f'{name+"/":<16}{EPOCH:<12}{0:<6}{0:<6}{"100644":<8}{size:<10}`\n'.encode('ascii');assert len(header)==60;out.write(header)
    if file:
        with open(file,'rb') as f:
            for chunk in iter(lambda:f.read(4*1024*1024),b''):out.write(chunk)
    else:out.write(data)
    if size%2:out.write(b'\n')
def build_deb(z,out,asar,logo,version,arch):
    data=out.with_suffix('.data.tar.gz');control=out.with_suffix('.control.tar.gz')
    linux_tar(z,data,asar,logo,version,True)
    control_text=f'Package: kovium-launcher\nVersion: {version}\nArchitecture: {"amd64" if arch=="x64" else "arm64"}\nMaintainer: Kovium Studios\nSection: games\nPriority: optional\nDepends: libc6 (>= 2.31), libnss3, libx11-6, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libgtk-3-0 | libgtk-3-0t64, libasound2 | libasound2t64, libsecret-1-0, gnome-keyring, xdg-utils\nDescription: Kovium Launcher\n Launcher de Minecraft y comunidad de Kovium con actualizaciones firmadas.\n'
    postinst='#!/bin/sh\nset -e\nif [ "$1" = "configure" ]; then\n chown root:root /opt/kovium-launcher/chrome-sandbox\n chmod 4755 /opt/kovium-launcher/chrome-sandbox\n if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q || true; fi\nfi\n'
    with tarfile.open(control,'w:gz',format=tarfile.PAX_FORMAT) as t:
        tar_add_bytes(t,'control',control_text.encode());tar_add_bytes(t,'postinst',postinst.encode(),0o755)
    with open(out,'wb') as f:
        f.write(b'!<arch>\n');ar_member(f,'debian-binary',data=b'2.0\n');ar_member(f,'control.tar.gz',file=control);ar_member(f,'data.tar.gz',file=data)
    os.unlink(data);os.unlink(control)
def mac_zip(z,out,asar,version):
    with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as target:
        for info in z.infolist():
            if info.filename=='Electron.app/Contents/Resources/default_app.asar':continue
            name=info.filename.replace('Electron.app/','KOVIUM Launcher.app/',1)
            if info.filename=='Electron.app/Contents/Info.plist':
                value=plistlib.loads(z.read(info));value.update(CFBundleName='KOVIUM Launcher',CFBundleDisplayName='KOVIUM Launcher',CFBundleIdentifier='com.kovium.launcher',CFBundleShortVersionString=version,CFBundleVersion=version)
                data=plistlib.dumps(value);target.writestr(zip_info(name,mode(info)),data)
            else:
                new=zip_info(name,mode(info))
                with z.open(info) as source,target.open(new,'w',force_zip64=True) as dest:
                    for chunk in iter(lambda:source.read(4*1024*1024),b''):dest.write(chunk)
        with open(asar,'rb') as source,target.open(zip_info('KOVIUM Launcher.app/Contents/Resources/app.asar',stat.S_IFREG|0o644),'w',force_zip64=True) as dest:
            for chunk in iter(lambda:source.read(4*1024*1024),b''):dest.write(chunk)
        readme='KOVIUM Launcher '+version+'\n\nEste archivo es una entrada de compilación para el trabajo nativo macOS. No distribuir antes de firmar y verificar con codesign. La salida final de CI conserva la firma del bundle durante las actualizaciones del launcher.\n'
        target.writestr(zip_info('LEEME-COMPILACION.txt',stat.S_IFREG|0o644),readme.encode())
def main():
    p=argparse.ArgumentParser();p.add_argument('--asar',required=True);p.add_argument('--out',required=True);p.add_argument('--runtimes',default=str(pathlib.Path(__file__).parent/'portable-runtimes-v170'));p.add_argument('--source',default=str(pathlib.Path(__file__).parent/'player-v170'));p.add_argument('--only',choices=['linux-x64','linux-arm64','darwin-x64','darwin-arm64']);a=p.parse_args()
    asar=pathlib.Path(a.asar).resolve();out=pathlib.Path(a.out).resolve();out.mkdir(parents=True,exist_ok=True);runtime=pathlib.Path(a.runtimes);verified=json.loads((runtime/'verified-runtimes.json').read_text());info=json.loads((asar.parent/'release-info.json').read_text());version=info['version'];digest=sha(asar)
    if info['sha256']!=digest or info['runtimeMajor']!=45:raise ValueError('App ASAR does not match verified release metadata')
    logo=(pathlib.Path(a.source)/'logo-small.png').read_bytes();artifacts=[]
    for entry in verified['results']:
        target=entry['target']
        if a.only and a.only!=target:continue
        if not a.only and target=='linux-arm64':continue  # Experimental; calendar-version MC lacks these natives.
        archive=runtime/pathlib.Path(entry['file']).name
        if sha(archive)!=entry['sha256']:raise ValueError('Electron runtime changed: '+target)
        arch=target.split('-')[1]
        with zipfile.ZipFile(archive) as z:
            if target.startswith('linux'):
                validate_elf(z,arch)
                for ext in ['tar.gz','deb']:
                    file=out/f'KOVIUM-Launcher-{version}-linux-{arch}.{ext}'
                    if ext=='deb':build_deb(z,file,asar,logo,version,arch)
                    else:linux_tar(z,file,asar,logo,version)
                    row=dict(platform='linux',arch=arch,file=str(file),size=file.stat().st_size,sha256=sha(file),nativeSmokeTested=False);artifacts.append(row);print(json.dumps(row),flush=True)
            else:
                validate_mach(z,arch);file=out/f'KOVIUM-Launcher-{version}-macos-{arch}-unsigned.zip';mac_zip(z,file,asar,version)
                row=dict(platform='darwin',arch=arch,file=str(file),size=file.stat().st_size,sha256=sha(file),requiresNativeSigning=True,nativeSmokeTested=False);artifacts.append(row);print(json.dumps(row),flush=True)
    manifest=dict(version=version,appSha256=digest,electronVersion=verified['version'],artifacts=artifacts)
    suffix='-'+a.only if a.only else '';(out/('platform-builds'+suffix+'.json')).write_text(json.dumps(manifest,indent=2),encoding='utf8')
if __name__=='__main__':main()
