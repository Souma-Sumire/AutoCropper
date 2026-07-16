import os
import cv2
import numpy as np

class ImageCropper:
    @staticmethod
    def resize_to_limit(image, max_height=1600):
        h, w = image.shape[:2]
        if h > max_height:
            scale = max_height / h
            new_w = int(w * scale)
            return cv2.resize(image, (new_w, max_height)), scale
        return image.copy(), 1.0

    @staticmethod
    def process_preview(image_gray, blur_kernel, threshold_val, bg_type):
        # 确保 blur_kernel 是大于 0 的奇数
        if blur_kernel % 2 == 0 or blur_kernel <= 0:
            blur_kernel = max(3, blur_kernel | 1)
            
        blurred = cv2.GaussianBlur(image_gray, (blur_kernel, blur_kernel), 0)
        
        thresh_type = cv2.THRESH_BINARY_INV if bg_type == "light" else cv2.THRESH_BINARY
        _, thresh = cv2.threshold(blurred, threshold_val, 255, thresh_type)
        return blurred, thresh

    @staticmethod
    def detect_rects(thresh_img, min_area_pct, max_area_pct, padding):
        h, w = thresh_img.shape[:2]
        total_area = w * h
        
        contours, _ = cv2.findContours(thresh_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        valid_rects = []
        filtered_count = 0
        
        for c in contours:
            area = cv2.contourArea(c)
            area_pct = (area / total_area) * 100.0
            
            if min_area_pct <= area_pct <= max_area_pct:
                # 1. 传统水平包围框
                x, y, w_box, h_box = cv2.boundingRect(c)
                x_new = max(0, x - padding)
                y_new = max(0, y - padding)
                w_new = min(w - x_new, w_box + 2 * padding)
                h_new = min(h - y_new, h_box + 2 * padding)
                
                # 2. 最小外接旋转矩形
                rect = cv2.minAreaRect(c)
                (cx, cy), (rw, rh), angle = rect
                
                # 对旋转矩形的高宽尺寸应用双向 padding 外扩
                rw_padded = rw + 2 * padding
                rh_padded = rh + 2 * padding
                rect_padded = ((cx, cy), (rw_padded, rh_padded), angle)
                
                # 获取外扩后旋转包围框的 4 个顶点坐标
                box_pts = cv2.boxPoints(rect_padded)
                box_pts = np.int32(box_pts).tolist() # [[x0,y0], [x1,y1], [x2,y2], [x3,y3]]
                
                valid_rects.append({
                    "x": x_new,
                    "y": y_new,
                    "w": w_new,
                    "h": h_new,
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
                
        # 排序
        valid_rects.sort(key=lambda r: (r['y'] // 10, r['x']))
        return valid_rects, filtered_count

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

            # 角度纠偏及长宽轴对齐（横向输出）
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
    def imwrite(path, img):
        """写入图片；兼容 Windows 下含中文的路径（cv2.imwrite 会静默失败）。"""
        ext = os.path.splitext(path)[1] or '.png'
        ok, buffer = cv2.imencode(ext, img)
        if not ok:
            return False
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'wb') as f:
            f.write(buffer.tobytes())
        return True
