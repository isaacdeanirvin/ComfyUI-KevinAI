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
const KEV_VERSION   = "2.4.0";

const KEVIN_NODES = ["KevWriteVideo", "KevWriteImage", "KevPathInfo"];
const VIDEO_NODES = ["KevWriteVideo"];
const WRITE_NODES = ["KevWriteVideo", "KevWriteImage"];

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
    "KevWriteImage": "KevinAI Write Image",
    "KevWriteVideo": "KevinAI Write Video",
    "KevPathInfo":   "KevinAI Path Info",
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
            if (lastFilepath) {
                // Strip frame range suffix for RV (it reads %04d natively)
                const rvPath = lastFilepath.replace(/ \d+-\d+$/, "");
                copyToClipboard("/software/tools/bin/rv " + rvPath, rvBtn);
            }
        });
        copyContainer.appendChild(rvBtn);

        node.addDOMWidget("kev_copy_path", "custom", copyContainer, {
            getValue()  { return lastFilepath || ""; },
            setValue(v)  {},
            getMinHeight() { return 28; },
        });
    }

    /* ── onExecuted: copy path + video preview ─────── */
    const _origExec = node.onExecuted;
    node.onExecuted = function(output) {
        if (_origExec) _origExec.call(this, output);

        // Copy path
        if (output && output.filepath && output.filepath.length > 0) {
            lastFilepath = output.filepath[0];
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

        const containerEl = document.createElement("div");
        containerEl.style.cssText = [
            "position:relative;background:#0a0a0a",
            "border-radius:6px;overflow:hidden;margin:4px 0",
            "border:1px solid #333",
        ].join(";");

        const videoEl = document.createElement("video");
        videoEl.style.cssText = "width:100%;display:block;border-radius:6px";
        videoEl.controls = true;
        videoEl.autoplay = true;
        videoEl.loop     = true;
        videoEl.muted    = true;
        videoEl.playsInline = true;
        containerEl.appendChild(videoEl);
        node._kevVideoEl = videoEl;

        const widget = node.addDOMWidget("kev_video_preview", "custom", containerEl, {
            getValue()  { return node._kevVideoSrc || ""; },
            setValue(v)  {},
            getMinHeight() { return 200; },
        });
        widget.computeSize = function() {
            const nodeWidth = node.size[0] - 20;
            if (videoEl.videoWidth && videoEl.videoHeight) {
                const aspect = videoEl.videoHeight / videoEl.videoWidth;
                return [nodeWidth, Math.max(160, nodeWidth * aspect + 10)];
            }
            return [nodeWidth, 200];
        };
        videoEl.addEventListener("loadedmetadata", () => {
            node.setSize(node.computeSize());
            app.graph.setDirtyCanvas(true);
        });
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
