/**
 * KevinAI ComfyUI Extension
 * 
 * - Video preview widget on KevWriteVideo (like VHS Combine but Kevin-branded)
 * - Image preview on KevWriteImage  
 * - Real Kevin VFX logo (orange + pink) on all KevinAI nodes
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Kevin VFX Logo — real asset, base64 encoded ──
const KEV_LOGO_BADGE = "data:image/png;base64,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";
const KEV_LOGO_OVERLAY = "data:image/png;base64,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";

// ── Brand colors (extracted from logo) ──
const KEV = {
    orange:    "#f5881e",
    pink:      "#eb008b",
    dark:      "#1a1008",
    title_bg:  "#1a1208",
    border:    "#5a3a0a",
    text:      "#f5a848",
    text_dim:  "#8a6a3a",
};

// Preload logo images
const _badgeImg = new Image();
_badgeImg.src = KEV_LOGO_BADGE;
const _overlayImg = new Image();
_overlayImg.src = KEV_LOGO_OVERLAY;


app.registerExtension({
    name: "KevinAI.WriteNodes",

    async beforeRegisterNodeDef(nodeType, nodeData, appInstance) {
        if (!nodeData.name || !nodeData.name.startsWith("Kev")) return;

        const isVideo = nodeData.name === "KevWriteVideo";
        const isImage = nodeData.name === "KevWriteImage";

        // ── Video Preview Widget (like VHS Combine) ──
        if (isVideo) {
            const origOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                if (origOnExecuted) origOnExecuted.apply(this, arguments);

                if (message && message.gifs && message.gifs.length > 0) {
                    const gif = message.gifs[0];
                    const src = api.apiURL(
                        `/view?filename=${encodeURIComponent(gif.filename)}` +
                        `&subfolder=${encodeURIComponent(gif.subfolder || "")}` +
                        `&type=${encodeURIComponent(gif.type || "temp")}` +
                        `&t=${Date.now()}`
                    );

                    let container = this._kevVideoContainer;
                    if (!container) {
                        container = document.createElement("div");
                        container.style.cssText = `
                            position: relative;
                            margin: 4px;
                            border-radius: 6px;
                            overflow: hidden;
                            background: #0a0a0a;
                            border: 1px solid ${KEV.border};
                        `;

                        const video = document.createElement("video");
                        video.style.cssText = `
                            width: 100%;
                            display: block;
                            border-radius: 6px;
                        `;
                        video.controls = true;
                        video.loop = true;
                        video.muted = true;
                        video.autoplay = true;
                        video.playsInline = true;
                        container.appendChild(video);

                        // Kevin logo overlay badge
                        const badge = document.createElement("div");
                        badge.style.cssText = `
                            position: absolute;
                            top: 6px;
                            right: 6px;
                            display: flex;
                            align-items: center;
                            gap: 4px;
                            background: rgba(10,8,4,0.82);
                            border: 1px solid ${KEV.border};
                            border-radius: 4px;
                            padding: 3px 7px 3px 5px;
                            pointer-events: none;
                            backdrop-filter: blur(6px);
                        `;
                        const logoImg = document.createElement("img");
                        logoImg.src = KEV_LOGO_OVERLAY;
                        logoImg.style.cssText = "height: 14px; width: auto;";
                        badge.appendChild(logoImg);

                        const labelSpan = document.createElement("span");
                        labelSpan.textContent = "AI";
                        labelSpan.style.cssText = `
                            font-size: 9px;
                            font-weight: bold;
                            color: ${KEV.text};
                            letter-spacing: 1px;
                        `;
                        badge.appendChild(labelSpan);

                        container.appendChild(badge);
                        this._kevVideoContainer = container;

                        const widget = this.addDOMWidget(
                            "kev_video_preview", "customtext",
                            container,
                            { getValue: () => "", setValue: () => {} }
                        );
                        widget.computeSize = function () {
                            return [this.parent.size[0], 220];
                        };
                    }

                    const video = container.querySelector("video");
                    if (video) {
                        video.src = src;
                        video.load();
                    }
                    this.setSize(this.computeSize());
                    app.graph.setDirtyCanvas(true);
                }
            };
        }

        // ── Image Preview ──
        if (isImage) {
            const origOnExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                if (origOnExecuted) origOnExecuted.apply(this, arguments);
                if (message && message.images) {
                    this.setSize(this.computeSize());
                    app.graph.setDirtyCanvas(true);
                }
            };
        }
    },

    async nodeCreated(node) {
        if (!node.comfyClass || !node.comfyClass.startsWith("Kev")) return;

        // ── Brand colors on node body ──
        node.color = KEV.title_bg;
        node.bgcolor = "#121008";

        // ── Custom title bar with real Kevin logo ──
        const origDrawTitleBar = node.onDrawTitleBar;
        node.onDrawTitleBar = function (ctx, title_height, size, scale) {
            if (origDrawTitleBar) {
                origDrawTitleBar.apply(this, arguments);
            }

            // Orange-to-dark gradient title
            const grad = ctx.createLinearGradient(0, 0, size[0], 0);
            grad.addColorStop(0, "#2a1a08");
            grad.addColorStop(0.5, "#1a1208");
            grad.addColorStop(1, "#0d0a04");
            ctx.fillStyle = grad;
            ctx.fillRect(0, -title_height, size[0], title_height);

            // Bottom accent line (orange → pink gradient)
            const lineGrad = ctx.createLinearGradient(0, 0, size[0], 0);
            lineGrad.addColorStop(0, KEV.orange);
            lineGrad.addColorStop(1, KEV.pink);
            ctx.fillStyle = lineGrad;
            ctx.fillRect(0, -1, size[0], 1);

            // Draw the Kevin logo image in title bar
            const logoH = title_height - 6;
            const logoW = logoH * (_badgeImg.naturalWidth / (_badgeImg.naturalHeight || 1));
            const logoX = 8;
            const logoY = -title_height + 3;
            
            if (_badgeImg.complete && _badgeImg.naturalWidth > 0) {
                ctx.drawImage(_badgeImg, logoX, logoY, logoW, logoH);
            }

            // Node title text
            ctx.fillStyle = KEV.text;
            ctx.font = "bold 11px Arial, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            const textX = logoW > 0 ? logoX + logoW + 6 : 10;
            ctx.fillText(this.title || "", textX, -title_height / 2 + 0.5);
        };

        // Minimum width
        if (node.size[0] < 320) {
            node.size[0] = 320;
        }
    },
});
