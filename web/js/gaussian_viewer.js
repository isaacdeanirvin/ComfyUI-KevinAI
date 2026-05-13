import { app } from "/scripts/app.js";

// ── Multi-node isolation ──────────────────────────────────────────────────
let _activeNodeId = null;

// ── PlayCanvas loader (local copy, served from our extension) ─────────────
let _pc = null;
const loadPlayCanvas = () => new Promise((resolve, reject) => {
    if (_pc) { resolve(_pc); return; }
    if (window.pc) { _pc = window.pc; resolve(_pc); return; }
    const s = document.createElement("script");
    s.src = "/extensions/comfyui-GaussianSplatViewer/js/playcanvas.min.js";
    s.onload = () => { _pc = window.pc; resolve(_pc); };
    s.onerror = () => reject(new Error("PlayCanvas failed to load — run deploy script first"));
    document.head.appendChild(s);
});

const PRESETS = {
    "WAN 2.2":  [{w:832,h:480},{w:480,h:832},{w:1280,h:720}],
    "LTX 2.3":  [{w:768,h:512},{w:512,h:768},{w:1024,h:576}],
    "HD":       [{w:1920,h:1080},{w:2048,h:1152}],
    "Custom":   [{w:1024,h:1024}],
};
const THUMB_W = 96, THUMB_H = 54;

app.registerExtension({
    name: "KSplatViewer",
    async nodeCreated(node) {
        if (node.comfyClass !== "KSplatViewer") return;
        node.setSize([900, 820]);
        node.color    = "#F07820";
        node.bgcolor  = "#000000";

        // ── Root ─────────────────────────────────────────────────────────
        const root = document.createElement("div");
        root.style.cssText = "position:relative;width:100%;height:720px;background:#000;border-radius:8px;overflow:hidden;font-family:'DM Mono',monospace;display:flex;flex-direction:column;";
        root.addEventListener("mouseenter", () => _activeNodeId = node.id);
        root.addEventListener("mouseleave", () => { if (_activeNodeId === node.id) _activeNodeId = null; });

        // ── Toolbar 1 — main controls ─────────────────────────────────────
        const tb1 = document.createElement("div");
        tb1.style.cssText = "flex-shrink:0;height:34px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:4px;padding:0 8px;";
        const mkTB = (t, on=false) => { const b=document.createElement("button");b.textContent=t;b.dataset.on=on?"1":"";const u=()=>{b.style.background=b.dataset.on?"#1a0800":"rgba(255,255,255,0.04)";b.style.borderColor=b.dataset.on?"#5a2a00":"#1e1e1e";b.style.color=b.dataset.on?"#F07820":"#555";};b.style.cssText="font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer;font-family:'DM Mono',monospace;border:1px solid;transition:all .1s;";u();b._u=u;return b; };
        const mkSel = () => { const s=document.createElement("select");s.style.cssText="background:#0d0d0d;border:1px solid #1e1e1e;color:#555;font-size:10px;padding:2px 4px;border-radius:3px;font-family:'DM Mono',monospace;";return s; };
        const mkSep = () => { const d=document.createElement("div");d.style.cssText="width:1px;height:18px;background:#1a1a1a;margin:0 2px;flex-shrink:0;";return d; };

        const gridBtn  = mkTB("⊞ Grid", true); let showGrid=true;
        const yFlipBtn = mkTB("↕ Y"); let yFlip=false;
        const presetSel = mkSel(); Object.keys(PRESETS).forEach(k=>{const o=document.createElement("option");o.value=k;o.textContent=k;presetSel.appendChild(o);});
        const resSel = mkSel();
        const updRes = () => { resSel.innerHTML=""; PRESETS[presetSel.value].forEach(r=>{const o=document.createElement("option");o.value=JSON.stringify(r);o.textContent=`${r.w}×${r.h}`;resSel.appendChild(o);}); };
        updRes(); presetSel.addEventListener("change", updRes);
        const nameIn = document.createElement("input");
        nameIn.type="text";nameIn.value="scene";nameIn.style.cssText="background:#0d0d0d;border:1px solid #1e1e1e;color:#888;font-size:10px;padding:2px 6px;border-radius:3px;font-family:'DM Mono',monospace;width:80px;";
        const optimizeBtn = mkTB("⚡ Optimize");
        optimizeBtn.style.color="#F07820";optimizeBtn.style.borderColor="#5a2a00";

        // cameras.json loader
        const loadCamBtn = mkTB("📂 cameras.json");
        const hiddenFile = document.createElement("input");
        hiddenFile.type="file";hiddenFile.accept=".json";hiddenFile.style.display="none";
        root.appendChild(hiddenFile);
        loadCamBtn.addEventListener("click",()=>hiddenFile.click());
        hiddenFile.addEventListener("change",e=>{
            if(!e.target.files[0])return;
            const r=new FileReader();
            r.onload=ev=>{
                try{
                    const cams=JSON.parse(ev.target.result);
                    if(!Array.isArray(cams))return;
                    cams.slice(0,9).forEach((cam,i)=>{
                        const R=cam.rotation;
                        const tr=R[0][0]+R[1][1]+R[2][2];
                        let qw,qx,qy,qz;
                        if(tr>0){const s=0.5/Math.sqrt(tr+1);qw=0.25/s;qx=(R[2][1]-R[1][2])*s;qy=(R[0][2]-R[2][0])*s;qz=(R[1][0]-R[0][1])*s;}
                        else{qw=1;qx=qy=qz=0;}
                        bookmarks[i+1]={px:cam.position[0],py:cam.position[1],pz:cam.position[2],ex:0,ey:0,ez:0,thumb:null,fromScanner:true};
                    });
                    renderBmPanel();
                    status.textContent=`◉ ${cams.length} scanner cameras → slots 1-${Math.min(cams.length,9)}`;
                }catch(e){status.textContent="✗ cameras.json: "+e.message;}
            };
            r.readAsText(e.target.files[0]);
        });
        tb1.appendChild(mkSep());
        tb1.appendChild(loadCamBtn);

        [gridBtn,yFlipBtn,mkSep(),presetSel,resSel,mkSep(),nameIn,mkSep(),optimizeBtn].forEach(el=>tb1.appendChild(el));
        root.appendChild(tb1);

        // ── Toolbar 2 — view buttons ──────────────────────────────────────
        const tb2 = document.createElement("div");
        tb2.style.cssText = "flex-shrink:0;height:28px;background:#080808;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:4px;padding:0 8px;";
        const mkBtn = (t,c="#555")=>{const b=document.createElement("button");b.textContent=t;b.style.cssText=`background:rgba(255,255,255,0.03);border:1px solid #1a1a1a;color:${c};font-size:10px;padding:2px 9px;border-radius:3px;cursor:pointer;font-family:'DM Mono',monospace;`;b.onmouseenter=()=>b.style.borderColor=c;b.onmouseleave=()=>b.style.borderColor="#1a1a1a";return b;};
        const camBtn=mkBtn("📌 Cam","#F07820"), shotBtn=mkBtn("📸 Shot","#D4197A");
        const resetBtn=mkBtn("⟳ Reset"), frameBtn=mkBtn("⊡ Frame");
        const topBtn=mkBtn("⊤"), sideBtn=mkBtn("⊣"), frontBtn=mkBtn("⊦"), undoBtn=mkBtn("↩");
        const seqLbl=document.createElement("span");seqLbl.style.cssText="font-size:10px;color:#2a2a2a;font-family:'DM Mono',monospace;margin-left:4px;";seqLbl.textContent="#001";
        [camBtn,shotBtn,resetBtn,frameBtn,mkSep(),topBtn,sideBtn,frontBtn,mkSep(),undoBtn,mkSep(),seqLbl].forEach(el=>tb2.appendChild(el));
        root.appendChild(tb2);

        // ── Viewport ──────────────────────────────────────────────────────
        const vp = document.createElement("div");
        vp.style.cssText = "flex:1;position:relative;min-height:0;";
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "width:100%;height:100%;display:block;";
        vp.appendChild(canvas);

        // Minimap
        const minimap = document.createElement("canvas");
        minimap.width=160;minimap.height=120;
        minimap.style.cssText="position:absolute;top:8px;right:8px;width:160px;height:120px;border:1px solid #1a1a1a;border-radius:3px;background:#0d0d0d;cursor:pointer;z-index:10;";
        vp.appendChild(minimap);
        const mmCtx = minimap.getContext("2d");

        // Bookmark panel
        const bmPanel = document.createElement("div");
        bmPanel.style.cssText = "position:absolute;top:8px;left:8px;display:flex;flex-direction:column;gap:3px;z-index:10;";
        vp.appendChild(bmPanel);

        // Status
        const status = document.createElement("div");
        status.style.cssText = "position:absolute;bottom:8px;left:50%;transform:translateX(-50%);font-size:10px;color:#F07820;font-family:'DM Mono',monospace;pointer-events:none;white-space:nowrap;z-index:5;";
        status.textContent = "⬡ Awaiting PLY...";
        vp.appendChild(status);

        // Progress bar
        const progress = document.createElement("div");
        progress.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:340px;display:none;z-index:20;";
        progress.innerHTML = `<div style="background:#0d0d0d;border:1px solid #F07820;border-radius:6px;padding:16px 18px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <span id="ks-spin-${node.id}" style="color:#F07820;font-size:14px;">⬡</span>
            <span style="font-size:10px;color:#F07820;font-family:'DM Mono',monospace;letter-spacing:.05em;">K S P L A T</span>
            <span style="margin-left:auto;font-size:10px;color:#444;font-family:'DM Mono',monospace;" id="ks-pct-${node.id}">0%</span>
          </div>
          <div style="height:2px;background:#1a1a1a;border-radius:1px;overflow:hidden;margin-bottom:10px;">
            <div id="ks-bar-${node.id}" style="height:100%;width:0%;background:#F07820;transition:width .15s;border-radius:1px;"></div>
          </div>
          <div id="ks-msg-${node.id}" style="font-size:10px;color:#888;font-family:'DM Mono',monospace;line-height:1.6;"></div>
          <div id="ks-log-${node.id}" style="margin-top:8px;font-size:9px;color:#333;font-family:'DM Mono',monospace;line-height:1.8;max-height:64px;overflow:hidden;"></div>
        </div>`;
        vp.appendChild(progress);

        // Retry button
        const retryBtn = document.createElement("button");
        retryBtn.textContent = "↺ Retry";
        retryBtn.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,36px);display:none;background:#F07820;border:none;color:#000;font-size:11px;padding:5px 14px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;z-index:21;";
        vp.appendChild(retryBtn);

        // ── Optimize dialog ───────────────────────────────────────────────
        const optDialog = document.createElement("div");
        optDialog.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:320px;display:none;z-index:30;";
        optDialog.innerHTML = `<div style="background:#0d0d0d;border:1px solid #F07820;border-radius:6px;padding:20px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
            <span style="color:#F07820;font-size:13px;font-family:'DM Mono',monospace;font-weight:500;">⬡ EXPORT / OPTIMIZE</span>
            <span id="ks-opt-close-${node.id}" style="margin-left:auto;color:#555;cursor:pointer;font-size:16px;font-family:monospace;">✕</span>
          </div>
          <div style="margin-bottom:12px;">
            <div style="font-size:10px;color:#888;font-family:'DM Mono',monospace;margin-bottom:6px;">SH Bands <span id="ks-sh-val-${node.id}" style="color:#F07820;">0</span></div>
            <input type="range" id="ks-sh-${node.id}" min="0" max="3" value="0" style="width:100%;accent-color:#F07820;">
            <div style="display:flex;justify-content:space-between;font-size:9px;color:#333;font-family:'DM Mono',monospace;margin-top:2px;"><span>smallest</span><span>highest quality</span></div>
          </div>
          <div style="margin-bottom:16px;">
            <div style="font-size:10px;color:#888;font-family:'DM Mono',monospace;margin-bottom:6px;">Format</div>
            <select id="ks-fmt-${node.id}" style="width:100%;background:#0d0d0d;border:1px solid #1e1e1e;color:#888;font-size:10px;padding:4px 6px;border-radius:3px;font-family:'DM Mono',monospace;">
              <option value="splat">.splat — 24 bytes/splat (~10x smaller)</option>
              <option value="ply">.ply compressed — reduced SH</option>
            </select>
          </div>
          <div style="font-size:9px;color:#2a2a2a;font-family:'DM Mono',monospace;margin-bottom:12px;" id="ks-opt-est-${node.id}">Estimated output: calculating...</div>
          <button id="ks-opt-run-${node.id}" style="width:100%;background:#F07820;border:none;color:#000;font-size:11px;font-weight:500;padding:8px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;">Export</button>
        </div>`;
        vp.appendChild(optDialog);

        root.appendChild(vp);

        // ── Thumbnail bank ────────────────────────────────────────────────
        const thumbBank = document.createElement("div");
        thumbBank.style.cssText = "flex-shrink:0;background:#0d0d0d;border-top:1px solid #1a1a1a;padding:6px 8px;display:flex;gap:6px;overflow-x:auto;min-height:70px;align-items:center;scrollbar-width:thin;scrollbar-color:#1a1a1a transparent;";
        const thumbEmpty = document.createElement("span");
        thumbEmpty.style.cssText = "font-size:10px;color:#1a1a1a;font-family:'DM Mono',monospace;";
        thumbEmpty.textContent = "screenshots appear here";
        thumbBank.appendChild(thumbEmpty);
        root.appendChild(thumbBank);

        node.addDOMWidget("ksplat_viewer", "ksplat_viewer_widget", root);

        // ── Progress helpers ──────────────────────────────────────────────
        const spinF = ["⬡","⬢","◈","◇","◆"]; let _si=0,_st=null,_log=[];
        const showProg = (pct,msg,detail="") => {
            progress.style.display="block"; retryBtn.style.display="none";
            if(!_st) _st=setInterval(()=>{const el=progress.querySelector(`#ks-spin-${node.id}`);if(el)el.textContent=spinF[_si++%spinF.length];},120);
            const bar=progress.querySelector(`#ks-bar-${node.id}`);
            const pctEl=progress.querySelector(`#ks-pct-${node.id}`);
            const msgEl=progress.querySelector(`#ks-msg-${node.id}`);
            const logEl=progress.querySelector(`#ks-log-${node.id}`);
            if(bar) bar.style.width=pct+"%";
            if(pctEl) pctEl.textContent=Math.round(pct)+"%";
            if(msgEl) msgEl.textContent=msg;
            if(detail&&logEl){_log.push(detail);if(_log.length>5)_log.shift();logEl.innerHTML=_log.map(l=>`<div>→ ${l}</div>`).join("");}
        };
        const hideProg = () => {
            clearInterval(_st);_st=null;_log=[];
            const sp=progress.querySelector(`#ks-spin-${node.id}`);if(sp)sp.textContent="✓";
            setTimeout(()=>{progress.style.display="none";},600);
        };

        // ── PlayCanvas state ──────────────────────────────────────────────
        let pcApp=null, pcSplatEntity=null, pcCamera=null, pcOrbit=null;
        let currentPlyUrl=null, lastUrl=null;
        let splatBounds=null, densePos=[0,0,0];

        // Camera history for undo
        const camHistory=[];
        const pushCam=()=>{if(!pcCamera)return;const p=pcCamera.getPosition(),e=pcCamera.getEulerAngles();camHistory.push({px:p.x,py:p.y,pz:p.z,ex:e.x,ey:e.y,ez:e.z});};
        const popCam=()=>{if(!camHistory.length||!pcCamera)return;const s=camHistory.pop();pcCamera.setPosition(s.px,s.py,s.pz);pcCamera.setEulerAngles(s.ex,s.ey,s.ez);};

        // Bookmarks
        const bookmarks={};
        const saveBM=slot=>{if(!pcCamera)return;const p=pcCamera.getPosition(),e=pcCamera.getEulerAngles();bookmarks[slot]={px:p.x,py:p.y,pz:p.z,ex:e.x,ey:e.y,ez:e.z,thumb:canvas.toDataURL("image/jpeg",0.6)};renderBmPanel();status.textContent=`◉ Bookmark ${slot} saved`;try{localStorage.setItem(`ksplat_bm_${node.id}_${slot}`,JSON.stringify(bookmarks[slot]));}catch(e){}};
        const recallBM=slot=>{if(!bookmarks[slot]||!pcCamera)return;pushCam();const b=bookmarks[slot];pcCamera.setPosition(b.px,b.py,b.pz);pcCamera.setEulerAngles(b.ex,b.ey,b.ez);status.textContent=`◉ Bookmark ${slot}`;};
        const renderBmPanel=()=>{bmPanel.innerHTML="";for(let i=1;i<=9;i++){const f=!!bookmarks[i],sl=document.createElement("div");sl.style.cssText=`width:40px;height:26px;border:1px solid ${f?"#5a2a00":"#111"};border-radius:2px;background:${f?"#1a0800":"#0d0d0d"};cursor:pointer;position:relative;overflow:hidden;`;sl.title=f?`Recall ${i} | Shift+${i} save`:`Shift+${i} to save`;if(f&&bookmarks[i].thumb){const img=document.createElement("img");img.src=bookmarks[i].thumb;img.style.cssText="width:100%;height:100%;object-fit:cover;opacity:0.7;";sl.appendChild(img);}const lbl=document.createElement("span");lbl.style.cssText=`position:absolute;bottom:1px;right:2px;font-size:8px;color:${f?"#F07820":"#1a1a1a"};font-family:'DM Mono',monospace;`;lbl.textContent=i;sl.appendChild(lbl);sl.addEventListener("click",()=>recallBM(i));bmPanel.appendChild(sl);}};
        renderBmPanel();

        // Restore bookmarks
        try{for(let i=1;i<=9;i++){const s=localStorage.getItem(`ksplat_bm_${node.id}_${i}`);if(s){bookmarks[i]=JSON.parse(s);}}renderBmPanel();}catch(e){}

        // ── PlayCanvas init ───────────────────────────────────────────────
        const initPC = async (plyUrl) => {
            showProg(5,"Loading PlayCanvas engine...");
            let pc;
            try { pc = await loadPlayCanvas(); }
            catch(e) { status.textContent="✗ "+e.message; hideProg(); return; }

            showProg(15,"Initializing renderer...");

            // Destroy existing app
            if(pcApp){ try{pcApp.destroy();}catch(e){} pcApp=null; pcSplatEntity=null; pcCamera=null; }

            const gfxOpts = { alpha:true, antialias:false, preferWebGl2:true };
            pcApp = new pc.Application(canvas, { graphicsDeviceOptions:gfxOpts });
            pcApp.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
            pcApp.setCanvasResolution(pc.RESOLUTION_AUTO);

            // Camera
            pcCamera = new pc.Entity("camera");
            pcCamera.addComponent("camera", {
                clearColor: new pc.Color(0.04,0.04,0.04,1),
                farClip: 10000,
                nearClip: 0.001,
            });
            pcCamera.setLocalPosition(0,0,5);
            pcApp.root.addChild(pcCamera);

            // ── Orbit camera state (Maya-style) ───────────────────────────
            let pivot=new pc.Vec3(0,0,0), radius=5;
            let azimuth=45, elevation=-20;
            let isDragging=false, isPanning=false;
            let lastMX=0, lastMY=0, mouseBtn=-1;

            const updateCamera = () => {
                const az=azimuth*Math.PI/180, el=elevation*Math.PI/180;
                const x=pivot.x+radius*Math.cos(el)*Math.sin(az);
                const y=pivot.y+radius*Math.sin(el);
                const z=pivot.z+radius*Math.cos(el)*Math.cos(az);
                pcCamera.setPosition(x,y,z);
                pcCamera.lookAt(pivot);
            };
            updateCamera();

            canvas.addEventListener("mousedown",e=>{
                if(e.ctrlKey&&e.shiftKey&&e.button===0){ return; }
                mouseBtn=e.button;lastMX=e.clientX;lastMY=e.clientY;e.preventDefault();
            });
            canvas.addEventListener("contextmenu",e=>e.preventDefault());
            window.addEventListener("mousemove",e=>{
                if(mouseBtn===-1)return;
                const dx=e.clientX-lastMX,dy=e.clientY-lastMY;lastMX=e.clientX;lastMY=e.clientY;
                const alt=e.altKey;
                if(!alt)return; // Maya: ALL navigation requires Alt held
                // Alt+LMB  = Tumble (rotate around pivot)
                if(mouseBtn===0){azimuth-=dx*0.4;elevation=Math.max(-89,Math.min(89,elevation+dy*0.4));updateCamera();}
                // Alt+MMB  = Track (pan — move pivot in screen plane)
                if(mouseBtn===1){const s=radius*0.001;pivot.x-=dx*s;pivot.y+=dy*s;updateCamera();}
                // Alt+RMB  = Dolly (zoom in/out along view axis)
                if(mouseBtn===2){radius=Math.max(0.001,radius*(1+dx*0.005));updateCamera();}
            });
            window.addEventListener("mouseup",()=>mouseBtn=-1);
            canvas.addEventListener("wheel",e=>{radius=Math.max(0.001,radius*(1+e.deltaY*0.001));updateCamera();e.preventDefault();},{passive:false});
            canvas.addEventListener("dblclick",()=>{pushCam();pivot.copy(densePos.length?new pc.Vec3(densePos[0],densePos[1],densePos[2]):new pc.Vec3(0,0,0));radius*=0.2;updateCamera();});

            // Store orbit state for Set Cam / Reset
            pcCamera._getOrbit=()=>({azimuth,elevation,radius,pivot:pivot.clone()});
            pcCamera._setOrbit=(az,el,r,pv)=>{azimuth=az;elevation=el;radius=r;pivot.copy(pv);updateCamera();};

            // Frame on bounds
            const frameScene = () => {
                if(!splatBounds)return;
                const center=splatBounds.center;
                pivot.copy(center);
                radius=splatBounds.halfExtents.length()*2.5;
                azimuth=45;elevation=-20;
                updateCamera();
            };

            showProg(30,"Loading splat asset...",`GET ${plyUrl}`);

            // Load GSplat asset
            const asset = new pc.Asset("splat","gsplat",{url:plyUrl});
            pcApp.assets.add(asset);

            asset.on("load",(a)=>{
                showProg(85,"Creating splat entity...",`${(a.resource?.numSplats||"?").toLocaleString()} splats`);
                if(pcSplatEntity){pcSplatEntity.destroy();pcSplatEntity=null;}
                pcSplatEntity = new pc.Entity("splat");
                pcSplatEntity.addComponent("gsplat",{asset:a});
                if(yFlip) pcSplatEntity.setLocalScale(1,-1,1);
                pcApp.root.addChild(pcSplatEntity);

                // Get bounds for framing
                const gsComp = pcSplatEntity.gsplat;
                if(gsComp&&gsComp.meshInstance){
                    splatBounds = gsComp.meshInstance.aabb;
                    densePos=[splatBounds.center.x,splatBounds.center.y,splatBounds.center.z];
                }
                frameScene();
                hideProg();
                status.textContent=`◉ ${(a.resource?.numSplats||"?").toLocaleString()} splats — GPU sorted — Alt+drag to navigate`;

                // Update optimize estimate
                const numSplats=a.resource?.numSplats||0;
                const el=optDialog.querySelector(`#ks-opt-est-${node.id}`);
                if(el&&numSplats) el.textContent=`~${(numSplats*24/1e6).toFixed(0)}MB .splat · ~${(numSplats*60/1e6).toFixed(0)}MB compressed .ply`;
            });

            asset.on("error",(e)=>{
                hideProg();
                status.textContent="✗ Load failed: "+e;
                retryBtn.style.display="block";retryBtn.onclick=()=>initPC(lastUrl);
            });

            // Progress during loading
            asset.on("progress",(received,total)=>{
                if(total>0){const pct=30+Math.round(received/total*50);showProg(pct,`Streaming — ${(received/1e6).toFixed(0)}/${(total/1e6).toFixed(0)} MB`,`chunk received`);}
            });

            pcApp.assets.load(asset);

            pcApp.on("update", () => {
                if (showGrid) drawGridLines(pc, pivot);
            });

            pcApp.start();
            frameBtn.onclick=frameScene;
            resetBtn.onclick=()=>{azimuth=45;elevation=-20;radius=5;pivot.set(densePos[0]||0,densePos[1]||0,densePos[2]||0);updateCamera();};
            topBtn.onclick=()=>{pushCam();elevation=-89;updateCamera();};
            sideBtn.onclick=()=>{pushCam();azimuth=90;elevation=0;updateCamera();};
            frontBtn.onclick=()=>{pushCam();azimuth=0;elevation=0;updateCamera();};
            undoBtn.onclick=()=>{popCam();};
        };

        // Grid using PlayCanvas drawLine API
        const _gridColor     = new pc.Color(0.15, 0.15, 0.15, 0.6);
        const _gridColorX    = new pc.Color(0.35, 0.08, 0.08, 0.8); // red X axis
        const _gridColorZ    = new pc.Color(0.08, 0.35, 0.15, 0.8); // green Z axis
        const _va = new pc.Vec3(), _vb = new pc.Vec3();

        const drawGridLines = (pc, pivotVec) => {
            if (!pcApp || !splatBounds) return;
            const ext  = Math.max(splatBounds.halfExtents.x, splatBounds.halfExtents.z) * 2.5;
            const step = ext / 10;
            const gY = yFlip
                ? -(splatBounds.center.y + splatBounds.halfExtents.y) // flipped — max Y becomes floor
                : (splatBounds.center.y - splatBounds.halfExtents.y); // Y-up — min Y is floor
            const px   = pivotVec ? pivotVec.x : 0;
            const pz   = pivotVec ? pivotVec.z : 0;

            for (let i = -10; i <= 10; i++) {
                const t = i * step;
                const col = i === 0 ? _gridColorX : _gridColor;
                // Lines along X
                _va.set(px - ext, gY, pz + t);
                _vb.set(px + ext, gY, pz + t);
                pcApp.drawLine(_va, _vb, i === 0 ? _gridColorZ : _gridColor);
                // Lines along Z
                _va.set(px + t, gY, pz - ext);
                _vb.set(px + t, gY, pz + ext);
                pcApp.drawLine(_va, _vb, col);
            }
        };

        // Minimap with frustum
        const drawMinimap = () => {
            const W=160,H=120;mmCtx.clearRect(0,0,W,H);
            mmCtx.fillStyle="#0d0d0d";mmCtx.fillRect(0,0,W,H);
            if(!splatBounds||!pcCamera)return;
            const center=splatBounds.center, ext=splatBounds.halfExtents;
            const sc=Math.min(140/((ext.x*2)||1),100/((ext.z*2)||1));
            const cp=pcCamera.getPosition();
            const mmx=(cp.x-center.x+ext.x)*sc+10;
            const mmz=(cp.z-center.z+ext.z)*sc+10;
            // Splat cloud dots
            mmCtx.fillStyle="rgba(240,120,32,0.25)";mmCtx.fillRect(10,10,140,100);
            // Frustum triangle
            const fwd=pcCamera.forward;
            const right=pcCamera.right;
            const fd=20,fw=12;
            mmCtx.strokeStyle="#F07820";mmCtx.lineWidth=1;
            mmCtx.beginPath();
            mmCtx.moveTo(Math.min(155,Math.max(5,mmx)),Math.min(115,Math.max(5,mmz)));
            mmCtx.lineTo(Math.min(155,Math.max(5,mmx+fwd.x*fd-right.x*fw)),Math.min(115,Math.max(5,mmz+fwd.z*fd-right.z*fw)));
            mmCtx.lineTo(Math.min(155,Math.max(5,mmx+fwd.x*fd+right.x*fw)),Math.min(115,Math.max(5,mmz+fwd.z*fd+right.z*fw)));
            mmCtx.closePath();mmCtx.stroke();
            mmCtx.fillStyle="#F07820";mmCtx.beginPath();mmCtx.arc(Math.min(155,Math.max(5,mmx)),Math.min(115,Math.max(5,mmz)),2.5,0,Math.PI*2);mmCtx.fill();
        };
        setInterval(drawMinimap,100);

        // ── Screenshot ────────────────────────────────────────────────────
        let seqNum=1;
        const takeShot = () => {
            if(!pcApp)return;
            const res=JSON.parse(resSel.value||'{"w":1920,"h":1080}');
            const preset=presetSel.value;
            const p=pcCamera?pcCamera.getEulerAngles():new (window.pc||{Vec3:function(){return{x:0,y:0}}}).Vec3();
            const az=Math.round(p.y||0), el=Math.round(p.x||0);
            const seq=String(seqNum).padStart(3,"0");
            const ptag=preset.toLowerCase().replace(/[\s.]/g,"");
            const fname=`kevin_gsv_${nameIn.value}_az${az<0?"n"+Math.abs(az):az}_el${el<0?"n"+Math.abs(el):el}_${ptag}_${res.w}x${res.h}_${seq}.png`;
            seqNum++;seqLbl.textContent=`#${String(seqNum).padStart(3,"0")}`;

            // Render at target resolution
            const ow=canvas.width,oh=canvas.height;
            canvas.width=res.w;canvas.height=res.h;
            if(pcApp) pcApp.renderNextFrame=true;

            setTimeout(()=>{
                canvas.toBlob(async blob=>{
                    canvas.width=ow;canvas.height=oh;
                    const fd=new FormData();fd.append("image",blob,fname);fd.append("type","output");
                    await fetch("/upload/image",{method:"POST",body:fd});
                    addThumb(blob,fname);
                    status.textContent=`◉ ${fname}`;
                },"image/png");
            },100);
        };

        const addThumb=(blob,fname)=>{
            if(thumbEmpty.parentNode)thumbEmpty.remove();
            const tw=document.createElement("div");tw.style.cssText=`flex-shrink:0;width:${THUMB_W}px;cursor:pointer;`;
            const tc=document.createElement("canvas");tc.width=THUMB_W;tc.height=THUMB_H;tc.style.cssText=`width:${THUMB_W}px;height:${THUMB_H}px;border:1px solid #1a1a1a;border-radius:2px;display:block;`;
            const tctx=tc.getContext("2d");const img=new Image();img.onload=()=>tctx.drawImage(img,0,0,THUMB_W,THUMB_H);img.src=URL.createObjectURL(blob);
            tw.appendChild(tc);
            const tl=document.createElement("div");tl.style.cssText="font-size:8px;color:#2a2a2a;font-family:'DM Mono',monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:96px;";tl.textContent=fname.replace("kevin_gsv_","");
            tw.appendChild(tl);
            tw.onmouseenter=()=>tc.style.borderColor="#F07820";tw.onmouseleave=()=>tc.style.borderColor="#1a1a1a";
            tw.addEventListener("click",()=>{const ov=document.createElement("div");ov.style.cssText="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer;";const bi=new Image();bi.src=URL.createObjectURL(blob);bi.style.cssText="max-width:90%;max-height:90%;";ov.appendChild(bi);ov.addEventListener("click",()=>ov.remove());document.body.appendChild(ov);});
            thumbBank.appendChild(tw);thumbBank.scrollLeft=thumbBank.scrollWidth;
        };

        // ── Optimize / Compress dialog ────────────────────────────────────
        const shSlider=optDialog.querySelector(`#ks-sh-${node.id}`);
        const shVal=optDialog.querySelector(`#ks-sh-val-${node.id}`);
        if(shSlider&&shVal) shSlider.addEventListener("input",()=>shVal.textContent=shSlider.value);

        optimizeBtn.addEventListener("click",()=>{ optDialog.style.display=optDialog.style.display==="none"?"block":"none"; });
        const optClose=optDialog.querySelector(`#ks-opt-close-${node.id}`);
        if(optClose) optClose.addEventListener("click",()=>optDialog.style.display="none");

        const runOptBtn=optDialog.querySelector(`#ks-opt-run-${node.id}`);
        if(runOptBtn) runOptBtn.addEventListener("click",async()=>{
            optDialog.style.display="none";
            const shBands=parseInt(shSlider?.value||"0");
            const fmt=optDialog.querySelector(`#ks-fmt-${node.id}`)?.value||"splat";
            showProg(5,`Compressing — SH Bands ${shBands}...`,`POST /gsv/compress`);
            try{
                const resp=await fetch("/gsv/compress",{
                    method:"POST",
                    headers:{"Content-Type":"application/json"},
                    body:JSON.stringify({path:currentPlyUrl?.split("path=").pop()||"",sh_bands:shBands,format:fmt})
                });
                const data=await resp.json();
                if(data.output){
                    showProg(100,`Compressed → ${data.output}`,`${data.size_mb?.toFixed(0)}MB saved`);
                    setTimeout(()=>{
                        hideProg();
                        currentPlyUrl="/gsv/ply?path="+encodeURIComponent(data.output);
                        initPC(currentPlyUrl);
                    },800);
                } else {
                    hideProg();status.textContent="✗ Compress: "+(data.error||"failed");
                }
            }catch(e){hideProg();status.textContent="✗ "+e.message;}
        });

        // ── Button wiring ─────────────────────────────────────────────────
        shotBtn.addEventListener("click",takeShot);
        camBtn.addEventListener("click",async()=>{
            if(!pcCamera)return;
            const p=pcCamera.getPosition();
            await fetch("/gsv/camera",{method:"POST",headers:{"Content-Type":"application/json"},
                body:JSON.stringify({node_id:String(node.id),position:[p.x,p.y,p.z]})});
            status.textContent="◉ Camera locked for Queue";
        });

        // Keyboard
        window.addEventListener("keydown",e=>{
            if(_activeNodeId!==node.id)return;
            if(document.activeElement?.tagName==="INPUT"||document.activeElement?.tagName==="TEXTAREA")return;
            if(e.key>="1"&&e.key<="9"){e.shiftKey?saveBM(parseInt(e.key)):recallBM(parseInt(e.key));return;}
            if((e.key==="z"||e.key==="Z")&&(e.ctrlKey||e.metaKey)){popCam();e.preventDefault();}
            if(e.key==="f"||e.key==="F"){frameBtn.click();}
            if((e.key==="a"||e.key==="A")&&pcApp&&splatBounds){pivot.copy(splatBounds.center);radius=splatBounds.halfExtents.length()*3;azimuth=45;elevation=-20;updateCamera&&updateCamera();status.textContent="◉ Frame all";}
        });

        // Node cleanup
        node.onRemoved=()=>{if(pcApp){try{pcApp.destroy();}catch(e){}}};

        // ── Execute callback ──────────────────────────────────────────────
        const origOnExecuted=node.onExecuted;
        node.onExecuted=function(msg){
            if(origOnExecuted)origOnExecuted.call(this,msg);
            const d=msg?.gsv_viewer?.[0];if(!d)return;
            if(d.ply_url&&d.ply_url!==currentPlyUrl){
                currentPlyUrl=d.ply_url;lastUrl=d.ply_url;
                nameIn.value=d.filename?.replace(".ply","").replace(".splat","")||"scene";
                initPC(d.ply_url);
            }
        };
    }
});
