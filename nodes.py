"""
ComfyUI Custom Node: Spectrum Notch Filter
입력: FFT 진폭 스펙트럼 이미지
출력: 주기적 노이즈 피크가 마스킹된 스펙트럼 이미지
"""

import json
import os
import tempfile

import numpy as np
import torch
from PIL import Image
from scipy.ndimage import gaussian_filter, maximum_filter


# ---------------------------------------------------------------------------
# 공통 유틸
# ---------------------------------------------------------------------------

def _to_gray(frame: np.ndarray) -> np.ndarray:
    """(H, W, C) float32 → (H, W) grayscale float32"""
    C = frame.shape[2]
    if C >= 3:
        return 0.299 * frame[:, :, 0] + 0.587 * frame[:, :, 1] + 0.114 * frame[:, :, 2]
    return frame[:, :, 0]


def _build_circular_mask(H: int, W: int, peaks, radius: int, feather: int) -> np.ndarray:
    """피크 좌표 목록으로 0/1 마스크 생성. 1=노치(제거) 영역."""
    mask = np.zeros((H, W), dtype=np.float32)
    Y, X = np.ogrid[:H, :W]
    for peak in peaks:
        r, c = int(peak[0]), int(peak[1])
        circle = (X - c) ** 2 + (Y - r) ** 2 <= radius ** 2
        mask[circle] = 1.0
    if feather > 0:
        mask = gaussian_filter(mask, sigma=feather)
        mask = np.clip(mask, 0.0, 1.0)
    return mask


def _save_temp_image(frame: np.ndarray) -> dict:
    """(H, W, C) float32 [0,1] → temp PNG, ComfyUI /view 형식 dict 반환."""
    img_u8 = (np.clip(frame, 0.0, 1.0) * 255).astype(np.uint8)
    if img_u8.shape[2] == 1:
        pil = Image.fromarray(img_u8[:, :, 0], mode="L").convert("RGB")
    else:
        pil = Image.fromarray(img_u8[:, :, :3])
    tmp = tempfile.NamedTemporaryFile(
        suffix=".png", prefix="notch_", delete=False,
        dir=os.path.join(tempfile.gettempdir())
    )
    pil.save(tmp.name)
    tmp.close()
    return {
        "filename": os.path.basename(tmp.name),
        "subfolder": "",
        "type": "temp",
    }


def _annotate_preview(frame: np.ndarray, peaks, radius: int, dc_r: int, H: int, W: int) -> np.ndarray:
    """스펙트럼 위에 검출된 피크를 노란색 링으로 표시한 미리보기 생성."""
    preview = np.clip(frame.copy(), 0.0, 1.0)
    C = frame.shape[2]
    Y, X = np.ogrid[:H, :W]
    cy, cx = H // 2, W // 2

    # DC 보호 영역 – 파란 링
    if dc_r > 0:
        outer = (X - cx) ** 2 + (Y - cy) ** 2 <= (dc_r + 1) ** 2
        inner = (X - cx) ** 2 + (Y - cy) ** 2 <= (dc_r - 1) ** 2
        ring = outer & ~inner
        if C >= 3:
            preview[ring, 0] = 0.2
            preview[ring, 1] = 0.5
            preview[ring, 2] = 1.0

    # 피크 – 노란 링
    for peak in peaks:
        r, c = int(peak[0]), int(peak[1])
        outer = (X - c) ** 2 + (Y - r) ** 2 <= (radius + 2) ** 2
        inner = (X - c) ** 2 + (Y - r) ** 2 <= max(0, radius - 1) ** 2
        ring = outer & ~inner
        if C >= 3:
            preview[ring, 0] = 1.0
            preview[ring, 1] = 0.9
            preview[ring, 2] = 0.0
        else:
            preview[ring, 0] = 1.0
    return preview.astype(np.float32)


# ---------------------------------------------------------------------------
# Node 1: SpectrumNotchAuto – 자동 피크 검출
# ---------------------------------------------------------------------------

class SpectrumNotchAutoNode:
    """
    FFT 진폭 스펙트럼 이미지에서 주기적 노이즈 피크를 자동 검출하여
    노치 필터 마스크를 생성합니다.

    출력:
      filtered_spectrum – 피크가 마스킹된 스펙트럼 이미지
      notch_mask        – 마스크 이미지 (흰색=제거 영역)
      preview           – 검출된 피크를 링으로 표시한 어노테이션 이미지
      peak_positions    – 검출된 피크 좌표 JSON (SpectrumNotchManual 연결용)
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "spectrum": ("IMAGE",),
                "threshold_rel": (
                    "FLOAT",
                    {
                        "default": 0.5,
                        "min": 0.05,
                        "max": 1.0,
                        "step": 0.01,
                        "display": "slider",
                        "tooltip": "최댓값 대비 피크 검출 임계값 (낮을수록 더 많은 피크 검출)",
                    },
                ),
                "min_distance": (
                    "INT",
                    {
                        "default": 10,
                        "min": 2,
                        "max": 200,
                        "step": 1,
                        "tooltip": "피크 간 최소 거리 (픽셀). 너무 작으면 같은 피크를 중복 검출",
                    },
                ),
                "notch_radius": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "tooltip": "각 피크에 적용할 원형 마스크 반지름 (픽셀)",
                    },
                ),
                "protect_dc": (
                    "INT",
                    {
                        "default": 20,
                        "min": 0,
                        "max": 200,
                        "step": 1,
                        "tooltip": "DC 성분(중심) 주변 보호 반지름. 이 영역 내 피크는 무시",
                    },
                ),
                "feather": (
                    "INT",
                    {
                        "default": 2,
                        "min": 0,
                        "max": 20,
                        "step": 1,
                        "tooltip": "마스크 경계 부드러움 (Gaussian sigma). 0=하드 에지",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("filtered_spectrum", "notch_mask", "preview", "peak_positions")
    FUNCTION = "apply_notch"
    CATEGORY = "image/frequency"
    DESCRIPTION = (
        "FFT 스펙트럼 이미지에서 주기적 노이즈 피크를 자동 검출하여 마스킹합니다. "
        "peak_positions 출력을 SpectrumNotchManual에 연결하면 수동 편집이 가능합니다."
    )

    def apply_notch(self, spectrum, threshold_rel, min_distance, notch_radius, protect_dc, feather):
        img_np = spectrum.cpu().numpy().astype(np.float32)
        # (B,H,W) 그레이스케일 텐서도 허용 → (B,H,W,1)로 정규화
        if img_np.ndim == 3:
            img_np = img_np[:, :, :, np.newaxis]
        B, H, W, C = img_np.shape

        out_filtered, out_mask, out_preview = [], [], []
        all_peaks = []

        for b in range(B):
            frame = img_np[b]
            gray = _to_gray(frame)

            # 로컬 최댓값 검출
            nbhd = maximum_filter(gray, size=max(3, min_distance * 2 + 1))
            local_max = (gray == nbhd) & (gray >= threshold_rel * gray.max())

            # DC 보호 영역 제외
            cy, cx = H // 2, W // 2
            Ym, Xm = np.ogrid[:H, :W]
            if protect_dc > 0:
                local_max[(Xm - cx) ** 2 + (Ym - cy) ** 2 <= protect_dc ** 2] = False

            peaks = np.argwhere(local_max).tolist()  # [[row, col], ...]

            # 마스크 생성 및 적용
            mask = _build_circular_mask(H, W, peaks, notch_radius, feather)
            filtered = frame * (1.0 - mask[:, :, np.newaxis])

            # 마스크 이미지 (3채널 흰색/검정)
            mask_img = np.stack([mask, mask, mask], axis=-1)

            # 어노테이션 미리보기
            preview = _annotate_preview(frame, peaks, notch_radius, protect_dc, H, W)

            out_filtered.append(filtered)
            out_mask.append(mask_img)
            out_preview.append(preview)
            if b == 0:
                all_peaks = [{"x": int(p[1]), "y": int(p[0]), "r": notch_radius} for p in peaks]

        t_filtered = torch.from_numpy(np.stack(out_filtered).astype(np.float32))
        t_mask = torch.from_numpy(np.stack(out_mask).astype(np.float32))
        t_preview = torch.from_numpy(np.stack(out_preview).astype(np.float32))

        return (t_filtered, t_mask, t_preview, json.dumps(all_peaks))


# ---------------------------------------------------------------------------
# Node 2: SpectrumNotchManual – 인터랙티브 수동 마스크 편집
# ---------------------------------------------------------------------------

class SpectrumNotchManualNode:
    """
    JS 캔버스 위젯으로 직접 그린 원형 노치 마스크를 스펙트럼에 적용합니다.
    노드 실행 후 캔버스에 스펙트럼 미리보기가 표시되며,
    클릭으로 노치 위치를 추가/삭제할 수 있습니다.

    peak_positions(SpectrumNotchAuto 출력)를 notch_points에 연결하면
    자동 검출 결과를 수동 편집의 시작점으로 활용할 수 있습니다.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "spectrum": ("IMAGE",),
                "notch_points": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": True,
                        "tooltip": (
                            'JSON 배열: [{"x":100,"y":50,"r":10}, ...]\n'
                            "캔버스에서 클릭하면 자동으로 업데이트됩니다."
                        ),
                    },
                ),
            },
            "optional": {
                "feather": (
                    "INT",
                    {"default": 2, "min": 0, "max": 20, "step": 1},
                ),
                "protect_dc": (
                    "INT",
                    {"default": 0, "min": 0, "max": 200, "step": 1,
                     "tooltip": "DC 중심 보호 반지름 (0=비활성)"},
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("filtered_spectrum", "notch_mask")
    OUTPUT_NODE = True  # onExecuted 트리거 → JS 캔버스 미리보기 갱신
    FUNCTION = "apply_manual_notch"
    CATEGORY = "image/frequency"
    DESCRIPTION = (
        "캔버스 위젯으로 직접 노치 위치를 지정합니다. "
        "노드 실행 후 캔버스에 스펙트럼이 표시되며 클릭으로 노치 원을 추가/삭제합니다."
    )

    def apply_manual_notch(self, spectrum, notch_points, feather=2, protect_dc=0, unique_id=None):
        # notch_points 파싱
        try:
            points = json.loads(notch_points)
            if not isinstance(points, list):
                points = []
        except Exception:
            points = []

        img_np = spectrum.cpu().numpy().astype(np.float32)
        # (B,H,W) 그레이스케일 텐서도 허용 → (B,H,W,1)로 정규화
        if img_np.ndim == 3:
            img_np = img_np[:, :, :, np.newaxis]
        B, H, W, C = img_np.shape

        out_filtered, out_mask = [], []
        cy, cx = H // 2, W // 2
        Ym, Xm = np.ogrid[:H, :W]

        for b in range(B):
            frame = img_np[b]

            # 포인트 목록을 (row, col, radius) 형식으로 변환
            peaks = [(int(p.get("y", 0)), int(p.get("x", 0))) for p in points]
            radii = [int(p.get("r", 8)) for p in points]

            # 마스크 생성
            mask = np.zeros((H, W), dtype=np.float32)
            for (r, c), rad in zip(peaks, radii):
                circle = (Xm - c) ** 2 + (Ym - r) ** 2 <= rad ** 2
                mask[circle] = 1.0

            # DC 보호 영역 마스킹
            if protect_dc > 0:
                dc_zone = (Xm - cx) ** 2 + (Ym - cy) ** 2 <= protect_dc ** 2
                mask[dc_zone] = 1.0

            if feather > 0:
                mask = gaussian_filter(mask, sigma=feather)
                mask = np.clip(mask, 0.0, 1.0)

            filtered = frame * (1.0 - mask[:, :, np.newaxis])
            mask_img = np.stack([mask, mask, mask], axis=-1)

            out_filtered.append(filtered)
            out_mask.append(mask_img)

        t_filtered = torch.from_numpy(np.stack(out_filtered).astype(np.float32))
        t_mask = torch.from_numpy(np.stack(out_mask).astype(np.float32))

        # 첫 번째 프레임을 temp PNG로 저장 → JS 캔버스 배경으로 사용
        # (INPUT 스펙트럼을 저장하여 노치 편집의 기준 이미지로 활용)
        preview_info = _save_temp_image(img_np[0])

        return {
            "ui": {"images": [preview_info]},
            "result": (t_filtered, t_mask),
        }


# ---------------------------------------------------------------------------
# 노드 등록
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "SpectrumNotchAuto": SpectrumNotchAutoNode,
    "SpectrumNotchManual": SpectrumNotchManualNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SpectrumNotchAuto": "Spectrum Notch Filter (Auto)",
    "SpectrumNotchManual": "Spectrum Notch Filter (Manual)",
}
