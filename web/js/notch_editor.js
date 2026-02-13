/**
 * ComfyUI Spectrum Notch Filter – 프론트엔드 확장
 *
 * SpectrumNotchManual 노드에 인터랙티브 캔버스 위젯을 추가합니다.
 *  - 노드 실행 후 입력 스펙트럼 이미지가 캔버스 배경으로 표시됩니다.
 *  - 좌클릭: 노치 원 추가
 *  - 우클릭: 가장 가까운 노치 원 삭제
 *  - Shift+드래그: 원 반지름 실시간 조정
 *  - 슬라이더: 새 원의 기본 반지름 설정
 *  - "Clear" 버튼: 모든 노치 초기화
 *  - 십자선: FFT 중심(DC) 위치 표시
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 캔버스 표시 크기 (노드 너비에 맞게 자동 조정)
const CANVAS_HEIGHT = 320;

// ─────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────

function specToCanvas(sx, sy, specW, specH, cw, ch) {
    return { x: (sx / specW) * cw, y: (sy / specH) * ch };
}

function canvasToSpec(cx, cy, specW, specH, cw, ch) {
    return {
        x: Math.round((cx / cw) * specW),
        y: Math.round((cy / ch) * specH),
    };
}

function distToCircle(mx, my, circle, specW, specH, cw, ch) {
    const cp = specToCanvas(circle.x, circle.y, specW, specH, cw, ch);
    return Math.sqrt((mx - cp.x) ** 2 + (my - cp.y) ** 2);
}

function hitTest(mx, my, circles, specW, specH, cw, ch) {
    const rScale = Math.min(cw / specW, ch / specH);
    for (let i = circles.length - 1; i >= 0; i--) {
        const d = distToCircle(mx, my, circles[i], specW, specH, cw, ch);
        if (d <= circles[i].r * rScale + 6) return i;
    }
    return -1;
}

// ─────────────────────────────────────────────
// 캔버스 위젯 생성
// ─────────────────────────────────────────────

function createNotchEditorWidget(node) {
    // 상태
    const state = {
        circles: [],
        specW: 512,
        specH: 512,
        spectrumImg: null,
        defaultRadius: 10,
        dragging: null,  // { index, startMx, startMy, origR } – Shift+드래그
    };

    // ── DOM 구성 ──────────────────────────────
    const container = document.createElement("div");
    container.style.cssText =
        "display:flex; flex-direction:column; width:100%; background:#111; user-select:none;";

    // 캔버스
    const canvas = document.createElement("canvas");
    canvas.height = CANVAS_HEIGHT;
    canvas.style.cssText =
        "display:block; width:100%; cursor:crosshair; border-bottom:1px solid #333;";
    container.appendChild(canvas);

    // 컨트롤 바
    const controls = document.createElement("div");
    controls.style.cssText =
        "display:flex; align-items:center; gap:6px; padding:4px 6px;" +
        "background:#1a1a1a; font-size:11px; color:#aaa; flex-wrap:wrap;";

    const makeLabel = (text) => {
        const el = document.createElement("span");
        el.textContent = text;
        return el;
    };

    // 반지름 슬라이더
    const rLabel = makeLabel("반지름:");
    const rSlider = document.createElement("input");
    rSlider.type = "range";
    rSlider.min = 2;
    rSlider.max = 100;
    rSlider.value = state.defaultRadius;
    rSlider.style.cssText = "flex:1; min-width:60px; max-width:120px;";
    const rVal = makeLabel(state.defaultRadius);

    rSlider.oninput = () => {
        state.defaultRadius = parseInt(rSlider.value);
        rVal.textContent = state.defaultRadius;
    };

    // Symmetry 토글
    const symLabel = makeLabel("대칭:");
    const symCheck = document.createElement("input");
    symCheck.type = "checkbox";
    symCheck.checked = true;
    symCheck.title = "FFT 켤레 대칭 – 반대쪽에도 동일한 원 자동 추가";

    // Clear 버튼
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.style.cssText =
        "padding:2px 8px; cursor:pointer; background:#333; color:#ccc;" +
        "border:1px solid #555; border-radius:3px; font-size:11px;";
    clearBtn.onclick = () => {
        state.circles = [];
        flushWidget();
        redraw();
    };

    controls.append(rLabel, rSlider, rVal, symLabel, symCheck, clearBtn);
    container.appendChild(controls);

    // 상태 바
    const statusBar = document.createElement("div");
    statusBar.style.cssText =
        "padding:2px 6px; font-size:10px; color:#666; background:#111;";
    statusBar.textContent =
        "노드를 실행하면 스펙트럼이 표시됩니다 │ 좌클릭: 추가 │ 우클릭: 삭제 │ Shift+드래그: 반지름 조정";
    container.appendChild(statusBar);

    // ── 위젯 등록 ────────────────────────────
    // notch_points STRING 위젯을 찾아 getValue/setValue와 연결
    let notchWidget = null;
    const domWidget = node.addDOMWidget(
        "notch_editor_canvas",
        "NOTCH_CANVAS",
        container,
        {
            serialize: false,     // 직렬화는 notch_points 위젯이 담당
            hideOnZoom: false,
            getValue() {
                return notchWidget ? notchWidget.value : "[]";
            },
            setValue(v) {
                if (notchWidget) notchWidget.value = v;
                try {
                    state.circles = JSON.parse(v) || [];
                } catch { state.circles = []; }
                redraw();
            },
        }
    );

    // 위젯이 완전히 등록된 뒤에 notch_points 위젯 참조
    requestAnimationFrame(() => {
        notchWidget = node.widgets?.find((w) => w.name === "notch_points");
        if (notchWidget?.value) {
            try {
                state.circles = JSON.parse(notchWidget.value) || [];
            } catch { /* ignore */ }
        }
        resizeCanvas();
        redraw();
    });

    // ── 캔버스 크기 동기화 ───────────────────
    function resizeCanvas() {
        const w = container.offsetWidth || 400;
        canvas.width = w;
        // 비율 유지
        canvas.height = CANVAS_HEIGHT;
    }

    // 노드 크기 변경 시 캔버스 재조정
    const origOnResize = node.onResize;
    node.onResize = function (size) {
        origOnResize?.call(this, size);
        resizeCanvas();
        redraw();
    };

    // ── 그리기 ──────────────────────────────
    function redraw() {
        const cw = canvas.width;
        const ch = canvas.height;
        const ctx = canvas.getContext("2d");

        ctx.clearRect(0, 0, cw, ch);

        // 배경: 스펙트럼 이미지
        if (state.spectrumImg) {
            ctx.drawImage(state.spectrumImg, 0, 0, cw, ch);
        } else {
            ctx.fillStyle = "#1a1a1a";
            ctx.fillRect(0, 0, cw, ch);
            ctx.fillStyle = "#444";
            ctx.font = "13px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("노드를 실행하면 스펙트럼이 여기에 표시됩니다", cw / 2, ch / 2);
        }

        // DC 중심 십자선
        ctx.save();
        ctx.strokeStyle = "rgba(80, 120, 255, 0.45)";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(cw / 2, 0); ctx.lineTo(cw / 2, ch);
        ctx.moveTo(0, ch / 2); ctx.lineTo(cw, ch / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // 노치 원
        const rScale = Math.min(cw / state.specW, ch / state.specH);
        for (let i = 0; i < state.circles.length; i++) {
            const c = state.circles[i];
            const cp = specToCanvas(c.x, c.y, state.specW, state.specH, cw, ch);
            const cr = c.r * rScale;

            ctx.save();
            ctx.strokeStyle = "rgba(255, 220, 0, 0.9)";
            ctx.fillStyle = "rgba(255, 200, 0, 0.18)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, cr, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // 인덱스 레이블
            ctx.fillStyle = "rgba(255, 220, 0, 0.85)";
            ctx.font = "10px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(i + 1, cp.x, cp.y);
            ctx.restore();
        }
    }

    // ── 위젯 값 동기화 ───────────────────────
    function flushWidget() {
        if (notchWidget) {
            notchWidget.value = JSON.stringify(state.circles);
        }
    }

    function setStatus(msg) {
        statusBar.textContent = msg;
    }

    // ── 마우스 이벤트 ────────────────────────
    function getCanvasXY(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (canvas.width / rect.width),
            y: (e.clientY - rect.top) * (canvas.height / rect.height),
        };
    }

    canvas.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const { x: mx, y: my } = getCanvasXY(e);
        const cw = canvas.width, ch = canvas.height;

        if (e.button === 2) {
            // 우클릭: 삭제
            const idx = hitTest(mx, my, state.circles, state.specW, state.specH, cw, ch);
            if (idx >= 0) {
                state.circles.splice(idx, 1);
                flushWidget();
                redraw();
                setStatus(`노치 삭제 │ 남은 개수: ${state.circles.length}`);
            }
            return;
        }

        if (e.button === 0 && e.shiftKey) {
            // Shift+좌클릭: 가장 가까운 원의 반지름 조정 시작
            const idx = hitTest(mx, my, state.circles, state.specW, state.specH, cw, ch);
            if (idx >= 0) {
                state.dragging = {
                    index: idx,
                    startMx: mx,
                    startMy: my,
                    origR: state.circles[idx].r,
                };
                return;
            }
        }

        if (e.button === 0 && !e.shiftKey) {
            // 좌클릭: 새 원 추가
            const sp = canvasToSpec(mx, my, state.specW, state.specH, cw, ch);
            const newCircle = { x: sp.x, y: sp.y, r: state.defaultRadius };
            state.circles.push(newCircle);

            // FFT 대칭 쌍 자동 추가
            if (symCheck.checked) {
                const symX = state.specW - 1 - sp.x;
                const symY = state.specH - 1 - sp.y;
                if (symX !== sp.x || symY !== sp.y) {
                    state.circles.push({ x: symX, y: symY, r: state.defaultRadius });
                }
            }

            flushWidget();
            redraw();
            setStatus(
                `추가 (${sp.x}, ${sp.y}) r=${state.defaultRadius} │ 총 ${state.circles.length}개`
            );
        }
    });

    canvas.addEventListener("mousemove", (e) => {
        if (!state.dragging) return;
        const { x: mx, y: my } = getCanvasXY(e);
        const rScale = Math.min(canvas.width / state.specW, canvas.height / state.specH);
        const dx = mx - state.dragging.startMx;
        const newR = Math.max(2, Math.round(state.dragging.origR + dx / rScale));
        state.circles[state.dragging.index].r = newR;
        flushWidget();
        redraw();
        setStatus(`반지름 조정: ${newR}px`);
    });

    canvas.addEventListener("mouseup", () => {
        state.dragging = null;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // ── onExecuted: 서버 실행 후 스펙트럼 이미지 로드 ──
    function loadSpectrumFromOutput(images) {
        if (!images || images.length === 0) return;
        const info = images[0];
        const url = api.apiURL(
            `/view?filename=${encodeURIComponent(info.filename)}` +
            `&subfolder=${encodeURIComponent(info.subfolder || "")}` +
            `&type=${info.type || "temp"}`
        );
        const img = new Image();
        img.onload = () => {
            state.spectrumImg = img;
            state.specW = img.naturalWidth;
            state.specH = img.naturalHeight;
            resizeCanvas();
            redraw();
            setStatus(
                `스펙트럼 로드 완료 (${state.specW}×${state.specH}) │` +
                ` 좌클릭: 추가 │ 우클릭: 삭제 │ Shift+드래그: 반지름 조정`
            );
        };
        img.onerror = () => setStatus("스펙트럼 이미지 로드 실패");
        img.src = url;
    }

    // 외부에서 호출 (아래 registerExtension에서 연결)
    node._notchLoadSpectrum = loadSpectrumFromOutput;

    return { state, redraw };
}

// ─────────────────────────────────────────────
// ComfyUI 확장 등록
// ─────────────────────────────────────────────

app.registerExtension({
    name: "Comfy.NotchFilter.SpectrumEditor",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "SpectrumNotchManual") return;

        // 노드 생성 시 캔버스 위젯 삽입
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            createNotchEditorWidget(this);
        };

        // 노드 실행 완료 시 스펙트럼 이미지 갱신
        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origOnExecuted?.apply(this, [message]);
            // OUTPUT_NODE=True 이면 message.images 에 temp 파일 정보가 담겨 옴
            if (typeof this._notchLoadSpectrum === "function") {
                this._notchLoadSpectrum(message?.images);
            }
        };
    },

    // SpectrumNotchAuto 노드: preview 출력을 노드 위에 인라인 표시
    // (ComfyUI 기본 PreviewImage 동작을 그대로 활용)
});
