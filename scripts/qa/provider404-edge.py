"""Exact one-file Edge patch; use the existing healthy sequential replica swap."""
import pathlib,json,sys
root=pathlib.Path('/home/adrien/.norva/provider404-edge-20260916')
previous=pathlib.Path('/home/adrien/.norva/resume-cache-prefix-20260916')
if sys.argv[1]=='stage':
    root.mkdir(mode=0o700,exist_ok=True)
    original=(previous/'functions/norva-playback/index.ts').read_text()
    before='      throw new HttpError(response.status, "Media gateway refused the session", gatewayBody);'
    after='      if (response.status === 404 && gatewayBody.code === "PROVIDER_HTTP_ERROR") {\n        throw new HttpError(404, "Media file not found on the provider (404). Try another version or retry later.", { code: "PROVIDER_HTTP_ERROR" });\n      }\n'+before
    assert original.count(before)==1,'unexpected_edge_code'
    out=root/'input/norva-playback/index.ts';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(original.replace(before,after))
base=pathlib.Path('/tmp/norva-resume-cache-edge-prefix.py').read_text()
base=base.replace("ROOT=pathlib.Path('/home/adrien/.norva/resume-cache-prefix-20260916')", 'ROOT=pathlib.Path('+repr(str(root))+')')
base=base.replace("PREVIOUS=pathlib.Path('/home/adrien/.norva/resume-cache-pilot-20260916')",'PREVIOUS=pathlib.Path('+repr(str(previous))+')')
base=base.replace("FILES=['norva-playback/index.ts','_shared/native-mp4-gateway-policy.mjs']", "FILES=['norva-playback/index.ts']")
base=base.replace("PREVIOUS/'edge-plan.private.json'", "PREVIOUS/'plan.private.json'")
base=base.replace('-prefix-rejected-','-provider404-rejected-').replace('-prefix-candidate-','-provider404-candidate-').replace('-prefix-retained-','-provider404-retained-')
exec(compile(base,'provider404-edge-release','exec'))
