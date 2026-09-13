import os
import cv2
import numpy as np
import pytest
from cropper import ImageCropper
from app import app

@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

def test_estimate_best_threshold():
    # 创建白底包含黑色色块的图片
    img = np.full((300, 300), 255, dtype=np.uint8)
    img[50:150, 50:150] = 30
    best_thresh = ImageCropper.estimate_best_threshold(img, bg_type="light")
    assert 30 < best_thresh < 255

def test_process_preview_modes():
    img = np.full((300, 300), 255, dtype=np.uint8)
    img[50:200, 50:200] = 50

    # 1. Otsu 模式
    blurred, thresh_otsu = ImageCropper.process_preview(
        img, blur_kernel=3, threshold_val=200, bg_type="light", threshold_mode="otsu"
    )
    assert thresh_otsu is not None
    assert np.any(thresh_otsu > 0)

    # 2. Adaptive 模式
    blurred, thresh_adapt = ImageCropper.process_preview(
        img, blur_kernel=3, threshold_val=200, bg_type="light", threshold_mode="adaptive"
    )
    assert thresh_adapt is not None

    # 3. 形态学滤波
    _, thresh_morph = ImageCropper.process_preview(
        img, blur_kernel=3, threshold_val=200, bg_type="light", threshold_mode="fixed", morph_size=3
    )
    assert thresh_morph is not None

def test_split_and_merge_rects():
    rect = {
        "x": 100, "y": 100, "w": 200, "h": 100,
        "orient": 0, "excluded": False,
        "rotated": {
            "cx": 200.0, "cy": 150.0, "w": 200.0, "h": 100.0, "angle": 0.0,
            "points": [[100, 100], [300, 100], [300, 200], [100, 200]]
        }
    }

    # 垂直拆分 (左右)
    splits_v = ImageCropper.split_rect(rect, direction="v")
    assert len(splits_v) == 2
    assert splits_v[0]["w"] < rect["w"]

    # 水平拆分 (上下)
    splits_h = ImageCropper.split_rect(rect, direction="h")
    assert len(splits_h) == 2
    assert splits_h[0]["h"] < rect["h"]

    # 多框合并
    merged = ImageCropper.merge_rects(splits_v)
    assert merged is not None
    assert merged["w"] >= rect["w"] - 5
    assert merged["h"] >= rect["h"] - 5

def test_format_crop_name():
    res_default = ImageCropper.format_crop_name(None, "photo_sample.png", 1, ext="jpg")
    assert res_default == "photo_sample_01.jpg"

    res = ImageCropper.format_crop_name(
        "{original}_scan_{index:02d}", "photo_sample.png", 5, ext="jpg"
    )
    assert res == "photo_sample_scan_05.jpg"

    res_date = ImageCropper.format_crop_name(
        "{date}_P{index:03d}", "test.jpg", 12, date_str="20260913", ext="png"
    )
    assert res_date == "20260913_P012.png"

def test_predict_orientation_fallback():
    # 测试全黑/全白或天空/地面模拟图像
    dummy = np.full((100, 100, 3), 128, dtype=np.uint8)
    deg = ImageCropper.predict_orientation(dummy)
    assert deg in [0, 90, 180, 270]

def test_export_jpg_api(client, tmp_path):
    # 上传一张测试图片
    img = np.full((400, 400, 3), 255, dtype=np.uint8)
    img[50:150, 50:150] = [30, 30, 180]
    ok, buf = cv2.imencode('.png', img)
    assert ok

    from io import BytesIO
    upload_res = client.post(
        '/api/upload',
        data={'file': (BytesIO(buf.tobytes()), 'test_scan.png')},
        content_type='multipart/form-data'
    )
    assert upload_res.status_code == 200
    upload_data = upload_res.get_json()
    session_id = upload_data['session_id']
    file_id = upload_data['file_id']

    # 估算阈值 API
    est_res = client.post('/api/estimate_threshold', json={
        'session_id': session_id,
        'file_id': file_id,
        'bg_type': 'light'
    })
    assert est_res.status_code == 200
    assert 'threshold' in est_res.get_json()

    # 预览生成 rects
    prev_res = client.post('/api/preview', json={
        'session_id': session_id,
        'file_id': file_id,
        'threshold_mode': 'otsu',
        'threshold': 200,
        'blur_kernel': 3,
        'morph_size': 3,
        'min_area_pct': 0.1,
        'max_area_pct': 90.0
    })
    assert prev_res.status_code == 200
    prev_data = prev_res.get_json()
    rects = prev_data['rects']
    assert len(rects) >= 1

    # 智能朝向预判 API
    orient_res = client.post('/api/auto_orient', json={
        'session_id': session_id,
        'file_id': file_id,
        'rects': rects,
        'bg_type': 'light'
    })
    assert orient_res.status_code == 200
    assert 'rects' in orient_res.get_json()

    # 导出为 JPG 并使用自定义命名模板
    export_res = client.post('/api/export', json={
        'session_id': session_id,
        'export_type': 'images',
        'format': 'jpg',
        'naming_template': '{original}_export_{index:02d}',
        'quality': 100,
        'files': [{
            'file_id': file_id,
            'filename': 'test_scan.png',
            'rects': rects
        }]
    })
    assert export_res.status_code == 200
    exp_data = export_res.get_json()
    assert exp_data['count'] >= 1
    assert exp_data['images'][0]['name'].endswith('.jpg')
    assert '_export_01.jpg' in exp_data['images'][0]['name']
