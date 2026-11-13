import importlib.util,io,pathlib,stat,tarfile,tempfile,unittest,zipfile
script_root=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('portable_builder',script_root/'build-portable-v170.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

def verify_directory_order(archive):
    seen=set()
    for member in archive.getmembers():
        parent=pathlib.PurePosixPath(member.name).parent
        while str(parent)!='.':
            assert str(parent) in seen,(member.name,str(parent))
            parent=parent.parent
        if member.isdir():
            assert member.name not in seen,member.name
            assert (member.mode,member.uid,member.gid)==(0o755,0,0),member.name
            seen.add(member.name)

class Parents(unittest.TestCase):
    def test_deb_and_portable_include_root_owned_parents_before_files_and_links(self):
        qa=script_root/'qa-tar-parents-v170';qa.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=qa) as temporary:
            root=pathlib.Path(temporary);assert root.resolve().is_relative_to(qa.resolve())
            fixture=root/'electron.zip';app=root/'app.asar';app.write_bytes(b'candidate ASAR')
            with zipfile.ZipFile(fixture,'w') as z:
                # Deliberately omit all parent directory entries from this ZIP.
                z.writestr('chrome_100_percent.pak',b'pak')
                z.writestr('resources/nested/value.txt',b'content')
                link=zipfile.ZipInfo('resources/linked');link.create_system=3;link.external_attr=(stat.S_IFLNK|0o755)<<16;z.writestr(link,b'nested/value.txt')
                z.writestr('resources/',b'')
            with zipfile.ZipFile(fixture) as z:
                for deb in [True,False]:
                    target=root/('data.tar.gz' if deb else 'portable.tar.gz')
                    builder.linux_tar(z,target,app,b'png','1.7.0',deb)
                    with tarfile.open(target,'r:gz') as t:
                        verify_directory_order(t)
                        names=t.getnames()
                        if deb:
                            for name in ['opt','opt/kovium-launcher','opt/kovium-launcher/resources','usr','usr/share','usr/share/applications']:self.assertIn(name,names)
                            self.assertEqual(t.extractfile('usr/share/applications/kovium-launcher.desktop').read().splitlines()[0],b'[Desktop Entry]')
                        else:self.assertEqual(names[0],'kovium-launcher')
    def test_rejects_parent_traversal(self):
        with tarfile.open(fileobj=io.BytesIO(),mode='w') as t:
            with self.assertRaises(ValueError):builder.tar_add_directory(t,'../outside')

if __name__=='__main__':unittest.main()
