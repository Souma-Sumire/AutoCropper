import numpy as np
import cv2
import pytest
from cropper import ImageCropper

def test_resize_to_limit():
    # 模拟一个 1000x800 的大图
    img = np.zeros((1000, 800, 3), dtype=np.uint8)
    resized, scale = ImageCropper.resize_to_limit(img, max_height=600)
    assert resized.shape[0] == 600
    assert resized.shape[1] == 480
    assert abs(scale - 0.6) < 1e-5

def test_detect_rects_light_bg():
    # 创建 100x100 的白底图 (255)
    img = np.ones((100, 100), dtype=np.uint8) * 255
    # 在 x=20, y=20 处放置一个 30x30 的黑色矩形 (模拟照片)
    img[20:50, 20:50] = 0
    
    # 模糊并二值化
    blurred, thresh = ImageCropper.process_preview(img, 3, 127, "light")
    # 寻轮廓 (最小面积 1%，最大 80%)
    rects, filtered = ImageCropper.detect_rects(thresh, 1.0, 80.0, 0)
    
    assert len(rects) == 1
    assert abs(rects[0]['x'] - 20) <= 2
    assert abs(rects[0]['y'] - 20) <= 2
    assert abs(rects[0]['w'] - 30) <= 2
    assert abs(rects[0]['h'] - 30) <= 2

def test_extract_crop_axis_aligned():
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    img[10:40, 20:50] = (0, 0, 255)
    rect = {"x": 20, "y": 10, "w": 30, "h": 30}
    crop = ImageCropper.extract_crop(img, rect, 1.0, 1.0, auto_rotate=False)
    assert crop is not None
    assert crop.shape[0] == 30 and crop.shape[1] == 30

def test_extract_crop_rotated_outputs_target_size():
    img = np.ones((200, 200, 3), dtype=np.uint8) * 255
    img[60:140, 70:150] = (0, 128, 255)
    rect = {
        "x": 70, "y": 60, "w": 80, "h": 80,
        "rotated": {"cx": 110.0, "cy": 100.0, "w": 80.0, "h": 60.0, "angle": 15.0, "points": []}
    }
    crop = ImageCropper.extract_crop(img, rect, 1.0, 1.0, auto_rotate=True, bg_type="light")
    assert crop is not None
    # w>=h 时输出约为 80x60
    assert crop.shape[1] == 80
    assert crop.shape[0] == 60

def test_extract_crop_flip180():
    img = np.zeros((40, 60, 3), dtype=np.uint8)
    img[0, 0] = (0, 0, 255)  # 左上角红点
    rect = {"x": 0, "y": 0, "w": 60, "h": 40, "flip180": True}
    crop = ImageCropper.extract_crop(img, rect, 1.0, 1.0, auto_rotate=False)
    assert crop is not None
    assert tuple(crop[0, 0]) == (0, 0, 0)
    assert tuple(crop[-1, -1]) == (0, 0, 255)

def test_extract_crop_orient_90_cw():
    img = np.zeros((40, 60, 3), dtype=np.uint8)
    img[0, 0] = (0, 0, 255)  # 左上角红点
    rect = {"x": 0, "y": 0, "w": 60, "h": 40, "orient": 90}
    crop = ImageCropper.extract_crop(img, rect, 1.0, 1.0, auto_rotate=False)
    assert crop is not None
    assert crop.shape[0] == 60 and crop.shape[1] == 40
    # 顺时针 90° 后原左上角落到右上角
    assert tuple(crop[0, -1]) == (0, 0, 255)

def test_imwrite_unicode_path(tmp_path):
    img = np.zeros((8, 8, 3), dtype=np.uint8)
    img[:] = (10, 20, 30)
    out = tmp_path / "未标题-1" / "crop_01.png"
    assert ImageCropper.imwrite(str(out), img)
    assert out.exists()
    assert out.stat().st_size > 0

def test_detect_rects_with_hollow_or_scalloped_border():
    # 模拟 200x200 图像中有一个 40x40 空心方框（边缘像素少，但外接矩形占 4%）
    thresh = np.zeros((200, 200), dtype=np.uint8)
    cv2.rectangle(thresh, (50, 50), (90, 90), 255, 2) # 空心矩形框线
    rects, _ = ImageCropper.detect_rects(thresh, min_area_pct=2.0, max_area_pct=80.0, padding=0)
    assert len(rects) == 1
    assert abs(rects[0]['w'] - 41) <= 2
    assert abs(rects[0]['h'] - 41) <= 2

def test_detect_rects_filters_extreme_aspect_ratio():
    # 模拟 200x200 图像中的扫描边缘长条阴影 (180x3, 长宽比 60:1)
    thresh = np.zeros((200, 200), dtype=np.uint8)
    thresh[0:3, 10:190] = 255
    rects, filtered = ImageCropper.detect_rects(thresh, min_area_pct=0.5, max_area_pct=80.0, padding=0)
    assert len(rects) == 0
    assert filtered == 1

