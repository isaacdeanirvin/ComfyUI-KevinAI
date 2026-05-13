import os, json, re, server, asyncio
from aiohttp import web

WEB_DIRECTORY = "./web"
_BASE = os.path.dirname(__file__)
ALLOWED_ROOTS = [
    "/kev/comfyui/outputs",
    "/kev/comfyui/input",
    os.path.normpath(os.path.join(_BASE, "..", "..", "output")),
    os.path.normpath(os.path.join(_BASE, "..", "..", "input")),
]
ALLOWED_EXT = (".ply", ".splat")

def _resolve_safe(ply_input):
    for root in [""] + ALLOWED_ROOTS:
        candidate = os.path.normpath(os.path.join(root, ply_input) if root else ply_input)
        if not candidate.endswith(ALLOWED_EXT): continue
        if not any(candidate.startswith(r) for r in ALLOWED_ROOTS): continue
        if os.path.isfile(candidate): return candidate
    return None

@server.PromptServer.instance.routes.get("/gsv/ply")
async def serve_ply(request):
    resolved = _resolve_safe(request.rel_url.query.get("path","").strip())
    if not resolved: return web.Response(status=403, text="Access denied")
    splat = resolved[:-4]+".splat" if resolved.endswith(".ply") else resolved
    return web.FileResponse(splat if os.path.isfile(splat) else resolved,
        headers={"Content-Type":"application/octet-stream","Cache-Control":"max-age=86400"})

@server.PromptServer.instance.routes.post("/gsv/compress")
async def compress_ply(request):
    data = await request.json()
    resolved = _resolve_safe(data.get("path","").strip())
    if not resolved: return web.json_response({"error":"not found"},status=403)
    sh_bands = int(data.get("sh_bands",0))
    out_path = resolved.replace(".ply",f"_sh{sh_bands}.splat")
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _compress, resolved, out_path, sh_bands)
        return web.json_response({"output":out_path,"size_mb":os.path.getsize(out_path)/1e6,"orig_mb":os.path.getsize(resolved)/1e6})
    except Exception as e:
        return web.json_response({"error":str(e)},status=500)

def _compress(ply_path, out_path, sh_bands):
    import numpy as np
    print(f"[KSplat] Compressing {ply_path} SH={sh_bands}")
    with open(ply_path,"rb") as f:
        hdr=""
        while True:
            line=f.readline().decode("utf-8",errors="ignore").strip()
            hdr+=line+"\n"
            if line=="end_header": break
        data_start=f.tell()
    props,vc=[],0
    sizes={"float":4,"uchar":1,"int":4,"uint":4,"double":8}
    for l in hdr.strip().split("\n"):
        if l.startswith("element vertex"): vc=int(l.split()[2])
        if l.startswith("property"): props.append(l.split()[1:])
    stride,off=0,{}
    for typ,name in props: off[name]=stride; stride+=sizes.get(typ,4)
    with open(ply_path,"rb") as f:
        f.seek(data_start)
        raw=np.frombuffer(f.read(vc*stride),dtype=np.uint8).reshape(vc,stride)
    def getf(n): return raw[:,off[n]:off[n]+4].view(np.float32)[:,0].copy()
    sig=lambda v:(1/(1+np.exp(-v.astype(np.float64)))).astype(np.float32)
    x,y,z=getf("x"),getf("y"),getf("z")
    r=(sig(getf("f_dc_0"))*255).clip(0,255).astype(np.uint8)
    g=(sig(getf("f_dc_1"))*255).clip(0,255).astype(np.uint8)
    b=(sig(getf("f_dc_2"))*255).clip(0,255).astype(np.uint8)
    a=(sig(getf("opacity"))*255).clip(0,255).astype(np.uint8)
    sx=(np.exp(getf("scale_0"))*128).clip(0,255).astype(np.uint8)
    sy=(np.exp(getf("scale_1"))*128).clip(0,255).astype(np.uint8)
    sz=(np.exp(getf("scale_2"))*128).clip(0,255).astype(np.uint8)
    q0,q1,q2,q3=getf("rot_0"),getf("rot_1"),getf("rot_2"),getf("rot_3")
    ql=np.sqrt(q0**2+q1**2+q2**2+q3**2).clip(1e-8)
    q0/=ql;q1/=ql;q2/=ql;q3/=ql
    idx=np.argsort(z)[::-1]
    o=np.zeros(vc,dtype=[("x","f4"),("y","f4"),("z","f4"),("sx","u1"),("sy","u1"),("sz","u1"),("r","u1"),("g","u1"),("b","u1"),("a","u1"),("q0","u1"),("q1","u1"),("q2","u1"),("q3","u1")])
    o["x"]=x[idx];o["y"]=y[idx];o["z"]=z[idx]
    o["sx"]=sx[idx];o["sy"]=sy[idx];o["sz"]=sz[idx]
    o["r"]=r[idx];o["g"]=g[idx];o["b"]=b[idx];o["a"]=a[idx]
    o["q0"]=((q0[idx]+1)*127.5).clip(0,255).astype(np.uint8)
    o["q1"]=((q1[idx]+1)*127.5).clip(0,255).astype(np.uint8)
    o["q2"]=((q2[idx]+1)*127.5).clip(0,255).astype(np.uint8)
    o["q3"]=((q3[idx]+1)*127.5).clip(0,255).astype(np.uint8)
    o.tofile(out_path)
    print(f"[KSplat] Done {out_path} ({os.path.getsize(out_path)/1e6:.1f}MB)")

@server.PromptServer.instance.routes.post("/gsv/camera")
async def save_camera(request):
    data=await request.json()
    node_id=re.sub(r'[^a-zA-Z0-9_]','',str(data.get('node_id','default')))[:32] or 'default'
    cache_dir=os.path.normpath(os.path.join(_BASE,"cache"))
    os.makedirs(cache_dir,exist_ok=True)
    cache_file=os.path.normpath(os.path.join(cache_dir,f"camera_{node_id}.json"))
    if not cache_file.startswith(cache_dir+os.sep): return web.Response(status=403,text="Access denied")
    with open(cache_file,"w") as f: json.dump(data,f)
    return web.json_response({"status":"saved"})

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
__all__ = ["NODE_CLASS_MAPPINGS","NODE_DISPLAY_NAME_MAPPINGS","WEB_DIRECTORY"]
