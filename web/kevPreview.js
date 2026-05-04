/**
 * kevPreview.js — KevinAI ComfyUI Extension v2.1.0
 *
 * Works on BOTH new nodes AND nodes loaded from saved workflows.
 *
 * Features:
 *   - Kevin VFX branded title bar (logo-colored letters, dark bg)
 *   - Auto-fill user/sequence/shot from localStorage + server env
 *   - Copy Path button on Write Image + Write Video
 *   - Inline video preview on Write Video
 *
 * Kevin VFX: orange #f5881e, pink #eb008b
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* ── Constants ──────────────────────────────────────── */
const KEVIN_ORANGE  = "#f5881e";
const KEVIN_PINK    = "#eb008b";
const KEVIN_BODY    = "#1e1215";
const KEV_VERSION   = "3.1.0";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  CHANGED v3.1.0 — HDR preview pipeline (KevWrite)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  Adds an inline color-science toolbar above each KevWrite preview
 *  with three live controls:
 *
 *    exposure     [-8 EV ... +8 EV]   — multiplies linearised RGB by 2^EV
 *    saturation   [0   ...   2]       — Rec.709-luma weighted desat/oversat
 *    input_space  {sRGB | linear | logc3 | ACEScct | rec709}
 *                                     — what color space the source media
 *                                       is encoded in; we decode → linear,
 *                                       apply exposure + sat, re-encode sRGB
 *
 *  Defaults reset every load: exposure 0, saturation 1, input sRGB.
 *  No per-node localStorage (matches Isaac's spec — fresh start each time).
 *
 *  Implementation:
 *    The browser <video> element stays visible underneath with all native
 *    controls (play / scrub / time / fullscreen) functional. A WebGL
 *    <canvas> overlays the video's frame area with pointer-events:none so
 *    clicks pass through to the controls. A requestAnimationFrame loop
 *    samples the current video frame as a texture, runs the fragment
 *    shader, writes to the canvas. Result: KJNodes-grade HDR inspection
 *    on log/linear footage with zero impact on the underlying playback.
 *
 *    If WebGL is unavailable the canvas stays hidden and the raw video
 *    is shown — feature degrades silently to today's behaviour.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const HDR_INPUT_SPACES = ["srgb", "linear", "logc3", "acescct", "rec709"];
const HDR_SPACE_LABELS = {
    "srgb":    "sRGB",
    "linear":  "linear",
    "logc3":   "logc3",
    "acescct": "ACEScct",
    "rec709":  "rec709",
};

const HDR_VERTEX_SHADER = `
    attribute vec2 aPos;
    varying vec2 vUV;
    void main() {
        vUV = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
        gl_Position = vec4(aPos, 0.0, 1.0);
    }
`;

// Fragment shader: per-pixel decode → exposure → saturation → encode sRGB.
// Color-science formulas are the standard published transforms:
//   sRGB EOTF / OETF  — IEC 61966-2-1
//   Rec.709 / BT.1886 — ITU-R BT.1886
//   ALEXA LogC3 EI800 — Arri whitepaper
//   ACEScct           — Academy / SMPTE ST 2065
const HDR_FRAGMENT_SHADER = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform float uExposure;
    uniform float uSaturation;
    uniform int   uInputSpace;

    vec3 srgbToLinear(vec3 c) {
        return mix(c / 12.92,
                   pow((c + 0.055) / 1.055, vec3(2.4)),
                   step(0.04045, c));
    }
    vec3 linearToSrgb(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        return mix(c * 12.92,
                   1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
                   step(0.0031308, c));
    }
    vec3 rec709ToLinear(vec3 c) {
        return mix(c / 4.5,
                   pow((c + 0.099) / 1.099, vec3(1.0 / 0.45)),
                   step(0.081, c));
    }
    float logc3ToLinearChan(float v) {
        return v < 0.1496582
            ? (v - 0.092809) / 5.367655
            : (pow(10.0, (v - 0.385537) / 0.2471896) - 0.052272) / 5.555556;
    }
    vec3 logc3ToLinear(vec3 c) {
        return vec3(logc3ToLinearChan(c.r),
                    logc3ToLinearChan(c.g),
                    logc3ToLinearChan(c.b));
    }
    float acescctToLinearChan(float v) {
        return v <= 0.155251141552511
            ? (v - 0.0729055341958355) / 10.5402377416545
            : pow(2.0, v * 17.52 - 9.72);
    }
    vec3 acescctToLinear(vec3 c) {
        return vec3(acescctToLinearChan(c.r),
                    acescctToLinearChan(c.g),
                    acescctToLinearChan(c.b));
    }

    void main() {
        vec3 c = texture2D(uTex, vUV).rgb;
        // Decode to linear scene-light per uInputSpace (0=srgb, 1=linear,
        // 2=logc3, 3=acescct, 4=rec709). GLSL ES 1.00 has no switch — the
        // chained conditionals are equivalent and shader compilers fold
        // them well on modern hardware.
        if      (uInputSpace == 0) c = srgbToLinear(c);
        else if (uInputSpace == 1) c = c;
        else if (uInputSpace == 2) c = logc3ToLinear(c);
        else if (uInputSpace == 3) c = acescctToLinear(c);
        else if (uInputSpace == 4) c = rec709ToLinear(c);

        // Exposure: linear gain by 2^EV. -3.28 EV \u2248 0.103x, +3.28 EV \u2248 9.71x.
        c *= pow(2.0, uExposure);

        // Saturation: lerp between greyscale luma (Rec.709 weights) and
        // the original color. uSaturation == 1 is identity, 0 fully grey,
        // 2 doubles chroma distance from grey.
        float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(luma), c, uSaturation);

        gl_FragColor = vec4(linearToSrgb(c), 1.0);
    }
`;

/**
 * Wire a WebGL HDR preview pipeline onto an existing <video> + <canvas>
 * pair. Returns { params, dispose } where mutating params.exposure /
 * params.saturation / params.inputSpace immediately affects the next
 * rendered frame, and dispose() tears down the rAF loop + GL context.
 *
 * If WebGL is unavailable, returns null \u2014 callers should hide the
 * canvas and let the native <video> element render directly.
 */
function setupHDRPipeline(videoEl, canvasEl) {
    const gl = canvasEl.getContext("webgl", { premultipliedAlpha: false })
            || canvasEl.getContext("experimental-webgl", { premultipliedAlpha: false });
    if (!gl) {
        console.warn("[KevinAI] WebGL unavailable \u2014 HDR preview disabled");
        return null;
    }

    function compile(type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error("[KevinAI] shader compile error:", gl.getShaderInfoLog(sh));
            gl.deleteShader(sh);
            return null;
        }
        return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, HDR_VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, HDR_FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error("[KevinAI] shader link error:", gl.getProgramInfoLog(prog));
        return null;
    }
    gl.useProgram(prog);

    // Full-screen triangle (covers the viewport in one draw call without
    // a quad's diagonal seam). Saves a vertex but more importantly avoids
    // the quad-rasterizer's center-of-pixel artefacts.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1,  3, -1,  -1,  3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const uExposure   = gl.getUniformLocation(prog, "uExposure");
    const uSaturation = gl.getUniformLocation(prog, "uSaturation");
    const uInputSpace = gl.getUniformLocation(prog, "uInputSpace");
    const uTex        = gl.getUniformLocation(prog, "uTex");
    gl.uniform1i(uTex, 0);

    const params = { exposure: 0, saturation: 1, inputSpace: 0 };
    let rafId = null;
    let disposed = false;

    function render() {
        if (disposed) return;
        // Match canvas backing size to its CSS pixel size (devicePixelRatio
        // capped at 2 to keep GPU load reasonable on 4K monitors).
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssW = canvasEl.clientWidth;
        const cssH = canvasEl.clientHeight;
        const targetW = Math.max(1, Math.floor(cssW * dpr));
        const targetH = Math.max(1, Math.floor(cssH * dpr));
        if (canvasEl.width !== targetW || canvasEl.height !== targetH) {
            canvasEl.width = targetW;
            canvasEl.height = targetH;
        }
        gl.viewport(0, 0, canvasEl.width, canvasEl.height);

        // Skip GPU work when the source has no decoded frames yet \u2014
        // readyState < 2 (HAVE_CURRENT_DATA) means texImage2D would
        // upload garbage. Spin again next rAF.
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
            try {
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                    gl.UNSIGNED_BYTE, videoEl);
                gl.uniform1f(uExposure,   params.exposure);
                gl.uniform1f(uSaturation, params.saturation);
                gl.uniform1i(uInputSpace, params.inputSpace);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            } catch (e) {
                // Some browsers throw SecurityError on cross-origin video
                // textures. Surface once and disable the canvas so the
                // raw video shows through.
                console.warn("[KevinAI] HDR texImage2D failed \u2014 falling back:", e);
                disposed = true;
                canvasEl.style.display = "none";
                return;
            }
        }
        rafId = requestAnimationFrame(render);
    }
    rafId = requestAnimationFrame(render);

    return {
        params,
        dispose() {
            disposed = true;
            if (rafId !== null) cancelAnimationFrame(rafId);
        },
    };
}

const KEVIN_NODES = ["KevWrite", "KevPathInfo"];
const VIDEO_NODES = ["KevWrite"];
const WRITE_NODES = ["KevWrite"];

/* ── Logo letter colors ─────────────────────────────── */
const LOGO_COLORS = {
    "K": KEVIN_ORANGE, "k": KEVIN_ORANGE,
    "e": KEVIN_PINK,   "E": KEVIN_PINK,
    "v": KEVIN_ORANGE, "V": KEVIN_ORANGE,
    "i": KEVIN_ORANGE,
    "n": KEVIN_ORANGE, "N": KEVIN_ORANGE,
    "A": KEVIN_ORANGE, "a": KEVIN_ORANGE,
    "I": KEVIN_PINK,
};

/* ── Display name lookup (works even after title blank) */
const DISPLAY_NAMES = {
    "KevWrite":    "KevinAI Write",
    "KevPathInfo": "KevinAI Path Info",
};

/* ── User identity (browser localStorage) ───────────── */
const STORAGE_KEY  = "kevinai_user";
const USERNAME_RE  = /^[a-zA-Z][a-zA-Z0-9._-]{1,30}$/;

function isValidUsername(val) {
    return val && USERNAME_RE.test(val.trim());
}

function getStoredUser() {
    try {
        const v = localStorage.getItem(STORAGE_KEY) || "";
        return isValidUsername(v) ? v.trim() : "";
    } catch(e) { return ""; }
}

function storeUser(name) {
    if (!isValidUsername(name)) return;
    try { localStorage.setItem(STORAGE_KEY, name.trim()); }
    catch(e) {}
}

/* ── Clipboard helper ───────────────────────────────── */
async function copyToClipboard(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    }
    if (btn) {
        const orig = btn.textContent;
        const origBg = btn.style.background;
        const origColor = btn.style.color;
        btn.textContent = "Copied ✓";
        btn.style.background = KEVIN_ORANGE;
        btn.style.color = "#000";
        setTimeout(() => {
            btn.textContent = orig;
            btn.style.background = origBg;
            btn.style.color = origColor;
        }, 1200);
    }
}

/* ── ComfyUI /view URL builder ──────────────────────── */
function viewURL(filename, subfolder, type) {
    const params = new URLSearchParams({
        filename: filename,
        type: type || "temp",
        subfolder: subfolder || "",
        rand: Math.random().toString(36).slice(2),
    });
    return api.apiURL("/view?" + params.toString());
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  MAIN SETUP — called for BOTH new and loaded nodes
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function setupKevinNode(node) {
    if (!KEVIN_NODES.includes(node.comfyClass)) return;
    if (node._kevSetup) return;   // idempotent — don't double-apply
    node._kevSetup = true;

    /* ── Title bar branding ────────────────────────── */
    const kevTitle = DISPLAY_NAMES[node.comfyClass] || node.title || "KevinAI";
    node.title = " ";
    node.color  = "#2a1215";
    node.bgcolor = KEVIN_BODY;

    node.onDrawTitleBar = function(ctx, title_height, size, scale) {
        // Dark background
        ctx.fillStyle = "#2a1215";
        const radius = 6 * scale;
        ctx.beginPath();
        ctx.roundRect(0, -title_height, size[0], title_height, [radius, radius, 0, 0]);
        ctx.fill();

        // Accent line
        const lineGrad = ctx.createLinearGradient(0, 0, size[0], 0);
        lineGrad.addColorStop(0, KEVIN_ORANGE);
        lineGrad.addColorStop(1, KEVIN_PINK);
        ctx.fillStyle = lineGrad;
        ctx.fillRect(0, -1, size[0], 1);

        // Logo-colored "KevinAI" + white subtitle
        const boldFont = "bold " + (12 * scale) + "px -apple-system, BlinkMacSystemFont, sans-serif";
        const lightFont = (12 * scale) + "px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "left";
        const baseY = -title_height + 15 * scale;
        let x = 10 * scale;

        const aiIdx = kevTitle.indexOf("AI");
        const brandEnd = aiIdx >= 0 ? aiIdx + 2 : 0;
        const brand = kevTitle.substring(0, brandEnd);
        const rest  = kevTitle.substring(brandEnd);

        ctx.font = boldFont;
        for (let c = 0; c < brand.length; c++) {
            const ch = brand[c];
            ctx.fillStyle = LOGO_COLORS[ch] || KEVIN_ORANGE;
            ctx.fillText(ch, x, baseY);
            x += ctx.measureText(ch).width;
        }

        ctx.font = lightFont;
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.fillText(rest, x, baseY);

        // Version
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.font = (9 * scale) + "px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("v" + KEV_VERSION, size[0] - 8 * scale, baseY);
    };

    /* ── Write node features ───────────────────────── */
    if (!WRITE_NODES.includes(node.comfyClass)) return;

    /* Auto-fill user from localStorage */
    const storedUser = getStoredUser();
    if (storedUser) {
        for (const w of node.widgets || []) {
            if (w.name === "user") {
                if (w.value === "_auto_" || w.value === "_unsorted" || !w.value || !w.value.trim()) {
                    w.value = storedUser;
                }
                break;
            }
        }
    }

    /* Watch user field changes — save to localStorage */
    for (const w of node.widgets || []) {
        if (w.name === "user" && !w._kevWatching) {
            w._kevWatching = true;
            const origCb = w.callback;
            w.callback = function(value) {
                if (isValidUsername(value)) storeUser(value.trim());
                if (origCb) origCb.call(this, value);
            };
            break;
        }
    }

    /* ── Shot Picker (Job → Sequence → Shot) ───────── */
    if (!node._kevPicker) {
        node._kevPicker = true;

        const SEL_CSS = [
            "flex:1;height:24px;border-radius:3px",
            "border:1px solid #444;background:#1a1a1a;color:#ccc",
            "font-size:11px;font-family:-apple-system,BlinkMacSystemFont,sans-serif",
            "padding:0 4px;outline:none",
        ].join(";");

        const pickerEl = document.createElement("div");
        pickerEl.style.cssText = "display:flex;gap:4px;padding:4px 6px;margin:2px 0;align-items:center";

        // Helper: set a widget value by name
        function setWidget(name, value) {
            for (const w of node.widgets || []) {
                if (w.name === name) { w.value = value; break; }
            }
        }

        // Unique IDs for datalists (per node)
        const uid = "kev" + node.id;

        // Job input + datalist
        const jobList = document.createElement("datalist");
        jobList.id = uid + "_jobs";
        pickerEl.appendChild(jobList);
        const jobInp = document.createElement("input");
        jobInp.style.cssText = SEL_CSS;
        jobInp.placeholder = "job...";
        jobInp.setAttribute("list", jobList.id);
        pickerEl.appendChild(jobInp);

        // Sequence input + datalist
        const seqList = document.createElement("datalist");
        seqList.id = uid + "_seqs";
        pickerEl.appendChild(seqList);
        const seqInp = document.createElement("input");
        seqInp.style.cssText = SEL_CSS;
        seqInp.placeholder = "seq...";
        seqInp.setAttribute("list", seqList.id);
        seqInp.disabled = true;
        pickerEl.appendChild(seqInp);

        // Shot input + datalist
        const shotList = document.createElement("datalist");
        shotList.id = uid + "_shots";
        pickerEl.appendChild(shotList);
        const shotInp = document.createElement("input");
        shotInp.style.cssText = SEL_CSS;
        shotInp.placeholder = "shot...";
        shotInp.setAttribute("list", shotList.id);
        shotInp.disabled = true;
        pickerEl.appendChild(shotInp);

        // Helper: populate a datalist
        function fillDatalist(dl, items) {
            dl.innerHTML = "";
            for (const item of items) {
                const opt = document.createElement("option");
                opt.value = item;
                dl.appendChild(opt);
            }
        }

        // Load jobs on first focus
        let jobsLoaded = false;
        jobInp.addEventListener("focus", async function() {
            if (jobsLoaded) return;
            jobsLoaded = true;
            try {
                const r = await api.fetchApi("/kevinai/jobs");
                if (!r.ok) return;
                const d = await r.json();
                fillDatalist(jobList, d.jobs);
            } catch(e) {}
        });

        // Job selected → load sequences, auto-pick first
        jobInp.addEventListener("change", async function() {
            seqInp.value = "";
            shotInp.value = "";
            fillDatalist(seqList, []);
            fillDatalist(shotList, []);
            seqInp.disabled = true;
            shotInp.disabled = true;
            if (!jobInp.value) return;
            try {
                const r = await api.fetchApi("/kevinai/sequences?job=" + encodeURIComponent(jobInp.value));
                if (!r.ok) return;
                const d = await r.json();
                fillDatalist(seqList, d.sequences);
                seqInp.disabled = false;
                // Auto-pick first sequence
                if (d.sequences.length === 1) {
                    seqInp.value = d.sequences[0];
                    seqInp.dispatchEvent(new Event("change"));
                }
            } catch(e) {}
        });

        // Sequence selected → load shots, auto-pick first, fill widget
        seqInp.addEventListener("change", async function() {
            shotInp.value = "";
            fillDatalist(shotList, []);
            shotInp.disabled = true;
            if (!seqInp.value) return;
            setWidget("sequence", seqInp.value);
            try {
                const r = await api.fetchApi("/kevinai/shots?job=" + encodeURIComponent(jobInp.value) + "&seq=" + encodeURIComponent(seqInp.value));
                if (!r.ok) return;
                const d = await r.json();
                fillDatalist(shotList, d.shots);
                shotInp.disabled = false;
                // Auto-pick first shot
                if (d.shots.length === 1) {
                    shotInp.value = d.shots[0];
                    shotInp.dispatchEvent(new Event("change"));
                }
            } catch(e) {}
            app.graph.setDirtyCanvas(true);
        });

        // Shot selected → fill widget
        shotInp.addEventListener("change", function() {
            if (shotInp.value) {
                setWidget("shot", shotInp.value);
                app.graph.setDirtyCanvas(true);
            }
        });

        node.addDOMWidget("kev_shot_picker", "custom", pickerEl, {
            getValue() { return jobInp.value + "/" + seqInp.value + "/" + shotInp.value; },
            setValue(v) {},
            getMinHeight() { return 30; },
        });

        // Move picker to top of widget list so it renders first
        const widgets = node.widgets;
        if (widgets && widgets.length > 1) {
            const picker = widgets[widgets.length - 1];
            widgets.splice(widgets.length - 1, 1);
            widgets.splice(0, 0, picker);
        }
    }

    /* ── Copy Path widget ──────────────────────────── */
    let lastFilepath = null;
    let copyContainer = null;

    function ensureCopyWidget() {
        if (copyContainer) return;

        copyContainer = document.createElement("div");
        copyContainer.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 6px;margin:2px 0";

        const pathLabel = document.createElement("span");
        pathLabel.style.cssText = [
            "flex:1",
            "font-family:'JetBrains Mono','SF Mono','Consolas',monospace",
            "font-size:10px;color:#888",
            "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
            "direction:rtl;text-align:left",
        ].join(";");
        pathLabel.textContent = "—";
        copyContainer.appendChild(pathLabel);
        copyContainer._label = pathLabel;

        const copyBtn = document.createElement("button");
        copyBtn.textContent = "Copy Path";
        copyBtn.style.cssText = [
            "flex-shrink:0;padding:3px 10px;border-radius:4px",
            "border:1px solid " + KEVIN_ORANGE,
            "background:rgba(245,136,30,0.15);color:" + KEVIN_ORANGE,
            "font-size:11px;font-weight:600",
            "font-family:-apple-system,BlinkMacSystemFont,sans-serif",
            "cursor:pointer;transition:all 0.15s ease",
        ].join(";");
        copyBtn.addEventListener("mouseenter", () => {
            if (copyBtn.textContent === "Copy Path") copyBtn.style.background = "rgba(245,136,30,0.3)";
        });
        copyBtn.addEventListener("mouseleave", () => {
            if (copyBtn.textContent === "Copy Path") copyBtn.style.background = "rgba(245,136,30,0.15)";
        });
        copyBtn.addEventListener("click", () => {
            if (lastFilepath) copyToClipboard(lastFilepath, copyBtn);
        });
        copyContainer.appendChild(copyBtn);

        // RV button — copies terminal command to open in RV
        const rvBtn = document.createElement("button");
        rvBtn.textContent = "RV";
        rvBtn.style.cssText = [
            "flex-shrink:0;padding:3px 8px;border-radius:4px",
            "border:1px solid " + KEVIN_PINK,
            "background:rgba(235,0,139,0.15);color:" + KEVIN_PINK,
            "font-size:11px;font-weight:700",
            "font-family:-apple-system,BlinkMacSystemFont,sans-serif",
            "cursor:pointer;transition:all 0.15s ease",
        ].join(";");
        rvBtn.addEventListener("mouseenter", () => {
            if (rvBtn.textContent === "RV") rvBtn.style.background = "rgba(235,0,139,0.3)";
        });
        rvBtn.addEventListener("mouseleave", () => {
            if (rvBtn.textContent === "RV") rvBtn.style.background = "rgba(235,0,139,0.15)";
        });
        rvBtn.addEventListener("click", () => {
            // RV gets video path (last in array) or frame path
            const rvPath = (lastVideoPath || lastFilepath || "").replace(/ \d+-\d+$/, "");
            if (rvPath) copyToClipboard("/software/tools/bin/rv " + rvPath, rvBtn);
        });
        copyContainer.appendChild(rvBtn);

        node.addDOMWidget("kev_copy_path", "custom", copyContainer, {
            getValue()  { return lastFilepath || ""; },
            setValue(v)  {},
            getMinHeight() { return 28; },
        });
    }

    /* ── onExecuted: copy path + video preview ─────── */
    let lastVideoPath = null;
    const _origExec = node.onExecuted;
    node.onExecuted = function(output) {
        if (_origExec) _origExec.call(this, output);

        // Copy path — first = frames (Nuke), second = video
        if (output && output.filepath && output.filepath.length > 0) {
            lastFilepath = output.filepath[0];
            if (output.filepath.length > 1) {
                lastVideoPath = output.filepath[1];
            } else {
                lastVideoPath = output.filepath[0];
            }
            ensureCopyWidget();
            copyContainer._label.textContent = lastFilepath;
        }

        // Video preview (Write Video only)
        if (VIDEO_NODES.includes(node.comfyClass) && output && output.gifs && output.gifs.length > 0) {
            const gif = output.gifs[0];
            const src = viewURL(gif.filename, gif.subfolder, gif.type);
            if (src !== node._kevVideoSrc || !node._kevVideoEl) {
                node._kevVideoSrc = src;
                ensureVideoWidget();
                node._kevVideoEl.innerHTML = "";
                const sourceEl = document.createElement("source");
                sourceEl.src  = src;
                sourceEl.type = gif.format || "video/mp4";
                node._kevVideoEl.appendChild(sourceEl);
                node._kevVideoEl.load();
                node._kevVideoEl.play().catch(() => {});
                console.log("[KevinAI] Preview:", gif.filename);
            }
        }
    };

    /* ── Video widget (lazy-created) ───────────────── */
    function ensureVideoWidget() {
        if (node._kevVideoEl) return;

        // CHANGED v3.1.0 — HDR preview toolbar pinned above the video.
        // Three live controls: exposure, saturation, input_space.
        // Defaults reset every load (Isaac's spec): exp 0, sat 1, sRGB.
        const containerEl = document.createElement("div");
        containerEl.style.cssText = [
            "background:#0a0a0a",
            "border-radius:6px","overflow:hidden","margin:4px 0",
            "border:1px solid #333",
        ].join(";");

        // ── Toolbar ────────────────────────────────────
        const toolbarEl = document.createElement("div");
        toolbarEl.style.cssText = [
            "padding:6px 10px","background:#141414",
            "border-bottom:1px solid #2a2a2a",
            "font-size:11px","color:#bbb",
            "display:flex","flex-direction:column","gap:4px",
        ].join(";");

        function makeSliderRow(label, min, max, step, def, fmt) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:8px";
            const lbl = document.createElement("span");
            lbl.textContent = label;
            lbl.style.cssText = "color:#888;min-width:64px;font-size:10px";
            const slider = document.createElement("input");
            slider.type = "range";
            slider.min = String(min); slider.max = String(max);
            slider.step = String(step); slider.value = String(def);
            slider.style.cssText = "flex:1;min-width:60px;accent-color:" + KEVIN_ORANGE;
            const val = document.createElement("span");
            val.textContent = fmt(def);
            val.style.cssText = "color:#ddd;min-width:48px;font-family:monospace;font-size:10px;text-align:right";
            row.appendChild(lbl); row.appendChild(slider); row.appendChild(val);
            return { row, slider, val };
        }
        const expo = makeSliderRow("exposure",   -8, 8, 0.01, 0,
            v => (v >= 0 ? "+" : "") + Number(v).toFixed(2));
        const sat  = makeSliderRow("saturation", 0,  2, 0.01, 1,
            v => Number(v).toFixed(2));
        toolbarEl.appendChild(expo.row);
        toolbarEl.appendChild(sat.row);

        // Input-space dropdown lives in its own row alongside a passive
        // resolution readout (filled in by onExecuted once we know the
        // intrinsic video dimensions). Mirrors KJNodes' compact layout.
        const spaceRow = document.createElement("div");
        spaceRow.style.cssText = "display:flex;align-items:center;gap:8px";
        const spaceLbl = document.createElement("span");
        spaceLbl.textContent = "input space";
        spaceLbl.style.cssText = "color:#888;min-width:64px;font-size:10px";
        const spaceSel = document.createElement("select");
        spaceSel.style.cssText = [
            "background:#1e1e1e","color:#bbb","border:1px solid #2a2a2a",
            "border-radius:3px","padding:2px 4px","font-size:10px",
            "font-family:monospace",
        ].join(";");
        for (const k of HDR_INPUT_SPACES) {
            const opt = document.createElement("option");
            opt.value = k; opt.textContent = HDR_SPACE_LABELS[k];
            spaceSel.appendChild(opt);
        }
        spaceSel.value = "srgb";  // default per spec
        const resLbl = document.createElement("span");
        resLbl.style.cssText = "flex:1;color:#666;font-family:monospace;font-size:10px;text-align:right";
        spaceRow.appendChild(spaceLbl);
        spaceRow.appendChild(spaceSel);
        spaceRow.appendChild(resLbl);
        toolbarEl.appendChild(spaceRow);

        containerEl.appendChild(toolbarEl);

        // ── Video + canvas overlay ─────────────────────
        // The <video> stays visible underneath providing native
        // controls (play/scrub/time/fullscreen). The <canvas> overlays
        // the frame area with pointer-events:none so clicks fall through
        // to the controls strip. WebGL pipeline samples the video as a
        // texture each rAF and writes the tonemapped result to the canvas.
        const stageEl = document.createElement("div");
        stageEl.style.cssText = "position:relative;line-height:0";

        const videoEl = document.createElement("video");
        videoEl.style.cssText = "width:100%;display:block;border-radius:0 0 6px 6px";
        videoEl.controls = true;
        videoEl.autoplay = true;
        videoEl.loop     = true;
        videoEl.muted    = true;
        videoEl.playsInline = true;
        // Required for WebGL textures from <video> on cross-origin sources.
        // ComfyUI's view endpoint is same-origin so this is belt-and-braces.
        videoEl.crossOrigin = "anonymous";
        stageEl.appendChild(videoEl);

        const canvasEl = document.createElement("canvas");
        canvasEl.style.cssText = [
            "position:absolute","left:0","top:0",
            "width:100%","height:100%",
            "pointer-events:none",  // clicks pass through to <video> controls
            "border-radius:0 0 6px 6px",
        ].join(";");
        stageEl.appendChild(canvasEl);

        containerEl.appendChild(stageEl);

        // ── WebGL HDR pipeline ─────────────────────────
        const pipeline = setupHDRPipeline(videoEl, canvasEl);
        if (pipeline) {
            // Wire the toolbar controls to the live pipeline params object.
            // The rAF render loop reads params each frame, so mutation here
            // is seen on the very next paint \u2014 no manual redraw needed.
            expo.slider.addEventListener("input", e => {
                const v = parseFloat(e.target.value);
                pipeline.params.exposure = v;
                expo.val.textContent = (v >= 0 ? "+" : "") + v.toFixed(2);
            });
            sat.slider.addEventListener("input", e => {
                const v = parseFloat(e.target.value);
                pipeline.params.saturation = v;
                sat.val.textContent = v.toFixed(2);
            });
            spaceSel.addEventListener("change", e => {
                pipeline.params.inputSpace = HDR_INPUT_SPACES.indexOf(e.target.value);
            });
            node._kevHDRPipeline = pipeline;
        } else {
            // WebGL unavailable \u2014 hide the canvas, hide the toolbar
            // (no point showing controls that don't do anything), let the
            // raw <video> render unmodified. Console-warned in setupHDRPipeline.
            canvasEl.style.display = "none";
            toolbarEl.style.display = "none";
        }

        node._kevVideoEl    = videoEl;
        node._kevHDRCanvas  = canvasEl;
        node._kevHDRResLbl  = resLbl;
        node._kevHDRToolbar = toolbarEl;

        const widget = node.addDOMWidget("kev_video_preview", "custom", containerEl, {
            getValue()  { return node._kevVideoSrc || ""; },
            setValue(v)  {},
            getMinHeight() { return 280; },  // toolbar adds ~80px to the 200 baseline
        });
        widget.computeSize = function() {
            const nodeWidth = node.size[0] - 20;
            // Toolbar height: 3 rows \u00d7 ~22px + padding \u2248 80px.
            const toolbarH = 80;
            if (videoEl.videoWidth && videoEl.videoHeight) {
                const aspect = videoEl.videoHeight / videoEl.videoWidth;
                return [nodeWidth, Math.max(160 + toolbarH, nodeWidth * aspect + toolbarH + 10)];
            }
            return [nodeWidth, 200 + toolbarH];
        };
        videoEl.addEventListener("loadedmetadata", () => {
            // Update the resolution readout and re-pack the node.
            if (videoEl.videoWidth && videoEl.videoHeight) {
                resLbl.textContent =
                    videoEl.videoWidth + "\u00d7" + videoEl.videoHeight;
            }
            node.setSize(node.computeSize());
            app.graph.setDirtyCanvas(true);
        });

        // CHANGED v3.1.0 \u2014 dispose pipeline when node is removed so
        // we don't leak rAF loops or GL contexts on long workflow sessions.
        const _origRemoved = node.onRemoved;
        node.onRemoved = function() {
            if (node._kevHDRPipeline) {
                try { node._kevHDRPipeline.dispose(); } catch (e) {}
                node._kevHDRPipeline = null;
            }
            if (_origRemoved) _origRemoved.call(this);
        };
    }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  REGISTER EXTENSION — hooks both new + loaded nodes
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.registerExtension({
    name: "KevinAI.Preview",

    // New node dropped on canvas
    nodeCreated(node) {
        setupKevinNode(node);
    },

    // Node loaded from saved workflow
    loadedGraphNode(node) {
        setupKevinNode(node);
    },

    // After full graph loads — sweep anything missed
    afterConfigureGraph() {
        if (!app.graph) return;
        for (const node of app.graph._nodes || []) {
            setupKevinNode(node);
        }
    },
});
