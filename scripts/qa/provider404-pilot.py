"""Reuse the proven pilot-only clone/maintenance/rollback protocol, exact patch only."""
import pathlib
base=pathlib.Path('/tmp/opplex-diagnostic-pilot.py').read_text()
base=base.replace("/home/adrien/.norva/opplex-diagnostic-20260916", "/home/adrien/.norva/provider404-pilot-20260916")
base=base.replace("IMAGE='norva-media-gateway:opplex-diagnostic-20260916'", "IMAGE='norva-media-gateway:provider404-pilot-20260916'")
base=base.replace("=='norva-media-gateway:resume-native-pilot-20260916'", "=='norva-media-gateway:opplex-diagnostic-20260916'")
base=base.replace('-diagnostic-candidate','-provider404-candidate').replace('-diagnostic-retained','-provider404-retained').replace('-diagnostic-rejected','-provider404-rejected')
start=base.index('    before=')
end=base.index('    assert source.count(before)',start)
before="            return res.status(502).json({\n                error: 'Unable to prepare this media file for reliable playback.',"
after="            if (err?.upstreamStatus === 404 && err?.code === 'PROVIDER_REQUEST_FAILED') {\n                return res.status(404).json({error: 'Media file not found on the provider (404).', code: 'PROVIDER_HTTP_ERROR'});\n            }\n"+before
base=base[:start]+'    before='+repr(before)+'\n    after='+repr(after)+"\n    if '\\r\\n' in source: before=before.replace('\\n','\\r\\n');after=after.replace('\\n','\\r\\n')\n"+base[end:]
exec(compile(base,'provider404-pilot-release','exec'))
