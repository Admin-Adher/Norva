import importlib.util, inspect
s=importlib.util.spec_from_file_location('release','/home/adrien/.norva/storyboard-compression-20260916/release.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for f in [m.lib.edge_expected,m.lib.edge_root,m.lib.edge_health,m.gw.clone_payload,m.gw.assert_clone]:
    print(inspect.getsource(f))
