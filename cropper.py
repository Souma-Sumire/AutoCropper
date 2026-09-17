import os
import sys
import math
import time
import cv2
import numpy as np

def get_resource_path(relative_path):
    """获取资源绝对路径，兼容常规运行与 PyInstaller 打包环境"""
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)

class ImageCropper:
    _face_detector = None
    _face_detector_failed = False

    @classmethod
    def get_face_detector(cls):
        if cls._face_detector_failed:
            return None
        if cls._face_detector is not None:
            return cls._face_detector
        model_path = get_resource_path(os.path.join("models", "face_detection_yunet.onnx"))
        if os.path.exists(model_path) and hasattr(cv2, "FaceDetectorYN_create"):
            try:
                cls._face_detector = cv2.FaceDetectorYN_create(
                    model_path, "", (320, 320), score_threshold=0.6, nms_threshold=0.3
                )
            except Exception:
                cls._face_detector_failed = True
                cls._face_detector = None
        else:
            cls._face_detector_failed = True
        return cls._face_detector

    @staticmethod
    def resize_to_limit(image, max_height=1600):
        h, w = image.shape[:2]
        if h > max_height:
            scale = max_height / h
            new_w = int(w * scale)
            return cv2.resize(image, (new_w, max_height)), scale
        return image.copy(), 1.0

    @staticmethod
    def estimate_best_threshold(image_gray, bg_type="light"):
        """通过分析灰度直方图估算最佳二值化阈值（抗纯白盖板与底纸纹理干扰）。"""
        blurred = cv2.GaussianBlur(image_gray, (5, 5), 0)
        if bg_type == "light":
            # 过滤扫描盖板纯白反光区域（>242）以准确分离照片暗部与相册底纸
            valid_pixels = blurred[blurred < 242]
            if valid_pixels.size > 100:
                otsu_val, _ = cv2.threshold(valid_pixels, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
                # 适度向上偏置补偿（上限 190），确保老照片浅色天空、高光区域以及白色纸边不被误判为背景
                boosted_otsu = round(otsu_val * 1.10)
                return int(max(60, min(190, boosted_otsu)))
        thresh_type = cv2.THRESH_BINARY_INV if bg_type == "light" else cv2.THRESH_BINARY
        otsu_val, _ = cv2.threshold(blurred, 0, 255, thresh_type + cv2.THRESH_OTSU)
        return int(round(otsu_val))

    @staticmethod
    def process_preview(image_gray, blur_kernel, threshold_val, bg_type, threshold_mode="fixed", morph_size=0):
        """
        预处理预览图像并生成二值化掩模。
        threshold_mode:
            - 'fixed': 固定阈值
            - 'otsu': Otsu 自动全局阈值（智能抗相册底纸干扰）
            - 'adaptive': 自适应局部高斯阈值
        morph_size:
            形态学平滑核大小 (0 为使用默认滤波)
        """
        if blur_kernel % 2 == 0 or blur_kernel <= 0:
            blur_kernel = max(3, blur_kernel | 1)

        blurred = cv2.GaussianBlur(image_gray, (blur_kernel, blur_kernel), 0)
        thresh_type = cv2.THRESH_BINARY_INV if bg_type == "light" else cv2.THRESH_BINARY

        if threshold_mode == "otsu":
            if bg_type == "light":
                valid_pixels = blurred[blurred < 242]
                if valid_pixels.size > 100:
                    otsu_val, _ = cv2.threshold(valid_pixels, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
                    clamped_thresh = int(max(60, min(190, round(otsu_val * 1.10))))
                    _, thresh = cv2.threshold(blurred, clamped_thresh, 255, cv2.THRESH_BINARY_INV)
                else:
                    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            else:
                _, thresh = cv2.threshold(blurred, 0, 255, thresh_type + cv2.THRESH_OTSU)
        elif threshold_mode == "adaptive":
            h_img, w_img = blurred.shape[:2]
            block_size = max(25, (int(min(h_img, w_img) // 20) | 1))
            c_val = 6
            raw_thresh = cv2.adaptiveThreshold(
                blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, thresh_type, block_size, c_val
            )
            k_close = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
            closed = cv2.morphologyEx(raw_thresh, cv2.MORPH_CLOSE, k_close)
            cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            thresh = np.zeros_like(closed)
            min_fill_area = (w_img * h_img) * 0.001
            for c in cnts:
                if cv2.contourArea(c) >= min_fill_area:
                    cv2.drawContours(thresh, [c], -1, 255, thickness=-1)
                else:
                    cv2.drawContours(thresh, [c], -1, 255, thickness=1)
        else:
            _, thresh = cv2.threshold(blurred, threshold_val, 255, thresh_type)

        # 默认消除细小斜条纹与纸纹噪点
        active_morph = max(3, morph_size) if morph_size else 3
        k_open = cv2.getStructuringElement(cv2.MORPH_RECT, (active_morph, active_morph))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, k_open)
        k_close = cv2.getStructuringElement(cv2.MORPH_RECT, (active_morph + 2, active_morph + 2))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, k_close)

        return blurred, thresh

    @staticmethod
    def detect_rects(thresh_img, min_area_pct, max_area_pct, padding):
        h, w = thresh_img.shape[:2]
        total_area = w * h

        contours, _ = cv2.findContours(thresh_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        valid_rects = []
        filtered_count = 0

        for c in contours:
            rect = cv2.minAreaRect(c)
            (cx, cy), (rw, rh), angle = rect
            rect_area = rw * rh
            contour_area = cv2.contourArea(c)

            # 核心约束 1: 实心度 (Solidity) 过滤。容许天空浅白部分及照片花边相框（放宽至 0.40），
            # 同时有效滤除由斜纹/布纹离散噪点构成的空心散乱怪框
            solidity = contour_area / max(1.0, rect_area)
            if solidity < 0.40:
                filtered_count += 1
                continue

            # 核心约束 2: 面积以真实实心轮廓面积为基准，避免虚高
            area_pct = (contour_area / total_area) * 100.0

            min_dim = max(1.0, min(rw, rh))
            aspect_ratio = max(rw, rh) / min_dim
            if aspect_ratio > 8.0:
                filtered_count += 1
                continue

            if min_area_pct <= area_pct <= max_area_pct:
                x, y, w_box, h_box = cv2.boundingRect(c)
                x_new = max(0, x - padding)
                y_new = max(0, y - padding)
                w_new = min(w - x_new, w_box + 2 * padding)
                h_new = min(h - y_new, h_box + 2 * padding)

                rw_padded = rw + 2 * padding
                rh_padded = rh + 2 * padding
                rect_padded = ((cx, cy), (rw_padded, rh_padded), angle)

                box_pts = cv2.boxPoints(rect_padded)
                box_pts = np.int32(box_pts).tolist()

                valid_rects.append({
                    "x": x_new,
                    "y": y_new,
                    "w": w_new,
                    "h": h_new,
                    "orient": 0,
                    "excluded": False,
                    "rotated": {
                        "cx": cx,
                        "cy": cy,
                        "w": rw_padded,
                        "h": rh_padded,
                        "angle": angle,
                        "points": box_pts
                    }
                })
            else:
                filtered_count += 1

        valid_rects.sort(key=lambda r: (r['y'] // 10, r['x']))
        return valid_rects, filtered_count

    @staticmethod
    def _compute_box_points(cx, cy, w, h, angle):
        rad = math.radians(angle)
        cos_a = math.cos(rad) * 0.5
        sin_a = math.sin(rad) * 0.5
        p0 = [cx - sin_a * h - cos_a * w, cy + cos_a * h - sin_a * w]
        p1 = [cx + sin_a * h - cos_a * w, cy - cos_a * h - sin_a * w]
        p2 = [2 * cx - p0[0], 2 * cy - p0[1]]
        p3 = [2 * cx - p1[0], 2 * cy - p1[1]]
        return [
            [int(round(p0[0])), int(round(p0[1]))],
            [int(round(p1[0])), int(round(p1[1]))],
            [int(round(p2[0])), int(round(p2[1]))],
            [int(round(p3[0])), int(round(p3[1]))]
        ]

    @classmethod
    def split_rect(cls, rect, direction="v"):
        """
        拆分一个粘连选框为两个子框。
        direction: 'v' 垂直拆分(左右分为两半) / 'h' 水平拆分(上下分为两半)
        """
        rot = rect.get("rotated")
        orient = rect.get("orient", 0)
        excluded = rect.get("excluded", False)

        if not rot:
            x, y, w, h = rect["x"], rect["y"], rect["w"], rect["h"]
            if direction == "h":
                h_half = h // 2
                r1 = {"x": x, "y": y, "w": w, "h": h_half, "orient": orient, "excluded": excluded}
                r2 = {"x": x, "y": y + h_half, "w": w, "h": h - h_half, "orient": orient, "excluded": excluded}
            else:
                w_half = w // 2
                r1 = {"x": x, "y": y, "w": w_half, "h": h, "orient": orient, "excluded": excluded}
                r2 = {"x": x + w_half, "y": y, "w": w - w_half, "h": h, "orient": orient, "excluded": excluded}
            return [r1, r2]

        cx, cy = rot["cx"], rot["cy"]
        w, h = rot["w"], rot["h"]
        angle = rot["angle"]
        rad = math.radians(angle)

        if direction == "h":
            dx = math.sin(rad) * (h / 4.0)
            dy = -math.cos(rad) * (h / 4.0)
            new_h = h / 2.0
            new_w = w

            c1 = (cx - dx, cy - dy)
            c2 = (cx + dx, cy + dy)
            r1_pts = cls._compute_box_points(c1[0], c1[1], new_w, new_h, angle)
            r2_pts = cls._compute_box_points(c2[0], c2[1], new_w, new_h, angle)
        else:
            dx = math.cos(rad) * (w / 4.0)
            dy = math.sin(rad) * (w / 4.0)
            new_w = w / 2.0
            new_h = h

            c1 = (cx - dx, cy - dy)
            c2 = (cx + dx, cy + dy)
            r1_pts = cls._compute_box_points(c1[0], c1[1], new_w, new_h, angle)
            r2_pts = cls._compute_box_points(c2[0], c2[1], new_w, new_h, angle)

        xs1 = [p[0] for p in r1_pts]
        ys1 = [p[1] for p in r1_pts]
        xs2 = [p[0] for p in r2_pts]
        ys2 = [p[1] for p in r2_pts]

        r1 = {
            "x": min(xs1), "y": min(ys1),
            "w": max(xs1) - min(xs1), "h": max(ys1) - min(ys1),
            "orient": orient, "excluded": excluded,
            "rotated": {
                "cx": c1[0], "cy": c1[1], "w": new_w, "h": new_h, "angle": angle, "points": r1_pts
            }
        }
        r2 = {
            "x": min(xs2), "y": min(ys2),
            "w": max(xs2) - min(xs2), "h": max(ys2) - min(ys2),
            "orient": orient, "excluded": excluded,
            "rotated": {
                "cx": c2[0], "cy": c2[1], "w": new_w, "h": new_h, "angle": angle, "points": r2_pts
            }
        }
        return [r1, r2]

    @classmethod
    def merge_rects(cls, rects):
        """将多个选框合并为一个统一的外接选框。"""
        if not rects:
            return None
        if len(rects) == 1:
            return rects[0]

        all_points = []
        for r in rects:
            rot = r.get("rotated")
            if rot and "points" in rot and rot["points"]:
                all_points.extend(rot["points"])
            else:
                x, y, w, h = r["x"], r["y"], r["w"], r["h"]
                all_points.extend([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])

        pts_arr = np.array(all_points, dtype=np.float32)
        min_rect = cv2.minAreaRect(pts_arr)
        (cx, cy), (rw, rh), angle = min_rect
        box_pts = cv2.boxPoints(min_rect)
        box_pts_list = np.int32(box_pts).tolist()

        x, y, w, h = cv2.boundingRect(np.int32(pts_arr))
        return {
            "x": int(x),
            "y": int(y),
            "w": int(w),
            "h": int(h),
            "orient": 0,
            "excluded": False,
            "rotated": {
                "cx": float(cx),
                "cy": float(cy),
                "w": float(rw),
                "h": float(rh),
                "angle": float(angle),
                "points": box_pts_list
            }
        }

    @classmethod
    def predict_orientation(cls, crop_bgr):
        """
        预判图像的正向朝向偏移 (0, 90, 180, 270)。
        优先使用轻量级 YuNet 人脸检测，若无人脸则结合上下光照分布进行弱启发式判定。
        """
        if crop_bgr is None or crop_bgr.size == 0:
            return 0

        h, w = crop_bgr.shape[:2]
        detector = cls.get_face_detector()

        angles = [0, 90, 180, 270]
        face_scores = {}

        if detector:
            for deg in angles:
                if deg == 0:
                    rotated = crop_bgr
                elif deg == 90:
                    rotated = cv2.rotate(crop_bgr, cv2.ROTATE_90_CLOCKWISE)
                elif deg == 180:
                    rotated = cv2.rotate(crop_bgr, cv2.ROTATE_180)
                else:
                    rotated = cv2.rotate(crop_bgr, cv2.ROTATE_90_COUNTERCLOCKWISE)

                rh, rw = rotated.shape[:2]
                scale = 320.0 / max(rw, rh)
                tw, th = max(16, int(rw * scale)), max(16, int(rh * scale))
                inp = cv2.resize(rotated, (tw, th))

                detector.setInputSize((tw, th))
                try:
                    _, faces = detector.detect(inp)
                    if faces is not None and len(faces) > 0:
                        score_sum = 0.0
                        for f in faces:
                            score = float(f[-1])
                            r_eye_y, l_eye_y = f[5], f[7]
                            mouth_y = (f[11] + f[13]) / 2.0
                            if mouth_y > ((r_eye_y + l_eye_y) / 2.0):
                                score += 1.0
                            score_sum += score
                        face_scores[deg] = score_sum
                except Exception:
                    pass

            if face_scores:
                best_deg = max(face_scores.items(), key=lambda item: item[1])
                if best_deg[1] >= 1.0:
                    return best_deg[0]

        gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        top_half = gray[:h // 2, :]
        bottom_half = gray[h // 2:, :]
        mean_top = float(np.mean(top_half)) if top_half.size else 128.0
        mean_bottom = float(np.mean(bottom_half)) if bottom_half.size else 128.0

        if mean_bottom - mean_top > 45.0:
            return 180

        return 0

    @staticmethod
    def extract_crop(original_img, rect, scale_x, scale_y, auto_rotate=True, bg_type="light"):
        """按预览坐标从原图提取裁剪图。旋转时直接变换到目标尺寸，避免整图 warpAffine。"""
        rotated_info = rect.get("rotated")
        if auto_rotate and rotated_info:
            cx = rotated_info["cx"] * scale_x
            cy = rotated_info["cy"] * scale_y
            rw = rotated_info["w"] * scale_x
            rh = rotated_info["h"] * scale_y
            angle = rotated_info["angle"]

            if rw < rh:
                angle = angle + 90
                rw, rh = rh, rw

            out_w = max(1, int(round(rw)))
            out_h = max(1, int(round(rh)))

            M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
            M[0, 2] += (out_w / 2.0) - cx
            M[1, 2] += (out_h / 2.0) - cy

            bg_color = (255, 255, 255) if bg_type == "light" else (0, 0, 0)
            cropped = cv2.warpAffine(
                original_img,
                M,
                (out_w, out_h),
                flags=cv2.INTER_CUBIC,
                borderMode=cv2.BORDER_CONSTANT,
                borderValue=bg_color,
            )
        else:
            rx = int(rect["x"] * scale_x)
            ry = int(rect["y"] * scale_y)
            rw = int(rect["w"] * scale_x)
            rh = int(rect["h"] * scale_y)

            orig_h, orig_w = original_img.shape[:2]
            rx_clamped = max(0, rx)
            ry_clamped = max(0, ry)
            rw_clamped = min(orig_w - rx_clamped, rw)
            rh_clamped = min(orig_h - ry_clamped, rh)

            if rw_clamped <= 0 or rh_clamped <= 0:
                return None
            cropped = original_img[ry_clamped:ry_clamped + rh_clamped, rx_clamped:rx_clamped + rw_clamped]

        orient = int(rect.get("orient", 0) or 0) % 360
        if rect.get("flip180") and orient == 0:
            orient = 180
        if orient == 90:
            cropped = cv2.rotate(cropped, cv2.ROTATE_90_CLOCKWISE)
        elif orient == 180:
            cropped = cv2.rotate(cropped, cv2.ROTATE_180)
        elif orient == 270:
            cropped = cv2.rotate(cropped, cv2.ROTATE_90_COUNTERCLOCKWISE)
        return cropped

    @staticmethod
    def format_crop_name(template, original_name, index, ext="jpg"):
        """
        根据模板生成文件名。
        支持占位符:
          - {original}: 原文件名（不带扩展名）
          - {index}: 索引数字 1, 2, 3...
          - {index:02d}: 2位补零 01, 02...
          - {index:03d}: 3位补零 001, 002...
        """
        if not template or not template.strip():
            template = "{original}_{index:02d}"

        stem, _ = os.path.splitext(original_name)

        name = template.replace("{original}", stem)
        name = name.replace("{index:02d}", f"{index:02d}")
        name = name.replace("{index:03d}", f"{index:03d}")
        name = name.replace("{index}", str(index))

        for invalid_char in r'<>:"/\|?*':
            name = name.replace(invalid_char, "_")

        ext_clean = ext.lower().lstrip(".")
        return f"{name}.{ext_clean}"

    @staticmethod
    def imread(path, flags=cv2.IMREAD_COLOR):
        """读取图片；兼容 Windows 中文与特殊字符路径。"""
        if not path or not os.path.isfile(path):
            return None
        try:
            with open(path, "rb") as f:
                data = f.read()
            if not data:
                return None
            nparr = np.frombuffer(data, np.uint8)
            return cv2.imdecode(nparr, flags)
        except Exception:
            return None

    @staticmethod
    def imwrite(path, img, quality=100):
        """写入图片；兼容 Windows 中文路径，并支持 JPEG 质量参数。"""
        ext = (os.path.splitext(path)[1] or ".jpg").lower()
        params = []
        if ext in [".jpg", ".jpeg"]:
            params = [cv2.IMWRITE_JPEG_QUALITY, quality]
        elif ext == ".png":
            params = [cv2.IMWRITE_PNG_COMPRESSION, 3]

        ok, buffer = cv2.imencode(ext, img, params)
        if not ok:
            return False
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "wb") as f:
            f.write(buffer.tobytes())
        return True
