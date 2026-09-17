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

    res_p3 = ImageCropper.format_crop_name(
        "{original}_P{index:03d}", "test.jpg", 12, ext="png"
    )
    assert res_p3 == "test_P012.png"

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

def test_session_check_and_preview(client):
    # 验证无效 session
    res_invalid = client.post('/api/check_session', json={'session_id': 'non_existent_session_id_123'})
    assert res_invalid.status_code == 200
    assert res_invalid.get_json()['valid'] is False

    # 上传生成有效 session
    img = np.full((100, 100, 3), 255, dtype=np.uint8)
    ok, buf = cv2.imencode('.png', img)
    assert ok
    from io import BytesIO
    upload_res = client.post(
        '/api/upload',
        data={'file': (BytesIO(buf.tobytes()), 'test_check.png')},
        content_type='multipart/form-data'
    )
    assert upload_res.status_code == 200
    upload_data = upload_res.get_json()
    sid = upload_data['session_id']
    fid = upload_data['file_id']

    # 验证有效 session
    res_valid = client.post('/api/check_session', json={'session_id': sid})
    assert res_valid.status_code == 200
    assert res_valid.get_json()['valid'] is True

    # 验证获取预览图接口
    prev_res = client.get(f'/api/get_file_preview?session_id={sid}&file_id={fid}')
    assert prev_res.status_code == 200
    assert prev_res.content_type == 'image/png'

def test_export_custom_path_and_subfolder(client, tmp_path):
    img = np.full((200, 200, 3), 255, dtype=np.uint8)
    img[20:80, 20:80] = 0
    ok, buf = cv2.imencode('.png', img)
    assert ok
    from io import BytesIO
    upload_res = client.post(
        '/api/upload',
        data={'file': (BytesIO(buf.tobytes()), 'test_path.png')},
        content_type='multipart/form-data'
    )
    upload_data = upload_res.get_json()
    sid = upload_data['session_id']
    fid = upload_data['file_id']

    rects = [{"x": 20, "y": 20, "w": 60, "h": 60, "orient": 0, "excluded": False}]

    # 1. 测试自定义绝对路径导出
    custom_dir = str(tmp_path / "custom_output_dir")
    res_custom = client.post('/api/export', json={
        'session_id': sid,
        'export_type': 'local',
        'path_mode': 'custom',
        'custom_path': custom_dir,
        'format': 'jpg',
        'files': [{'file_id': fid, 'filename': 'test_path.png', 'rects': rects}]
    })
    assert res_custom.status_code == 200
    c_data = res_custom.get_json()
    assert os.path.exists(custom_dir)
    assert c_data['count'] == 1

    # 2. 测试子文件夹导出（兜底/默认）
    res_sub = client.post('/api/export', json={
        'session_id': sid,
        'export_type': 'local',
        'path_mode': 'subfolder',
        'subfolder': 'test_sub_run',
        'format': 'jpg',
        'files': [{'file_id': fid, 'filename': 'test_path.png', 'rects': rects}]
    })
    assert res_sub.status_code == 200
    s_data = res_sub.get_json()
    assert 'test_sub_run' in s_data['local_path']
    assert os.path.exists(s_data['local_path'])

def test_export_source_dir_subfolder(client, tmp_path):
    """测试原图同级子目录导出：确保切片保存到原图所在真实文件夹，而非项目目录"""
    # 模拟用户电脑上的原图文件夹
    source_folder = tmp_path / "user_scans_folder"
    source_folder.mkdir()
    fake_orig_img_path = source_folder / "scan_sample.png"

    img = np.full((150, 150, 3), 255, dtype=np.uint8)
    img[20:70, 20:70] = 0
    ok = ImageCropper.imwrite(str(fake_orig_img_path), img)
    assert ok

    # 通过 upload 上传并携带 source_path 与 source_dir
    with open(fake_orig_img_path, "rb") as f:
        upload_res = client.post(
            '/api/upload',
            data={
                'file': (f, 'scan_sample.png'),
                'source_path': str(fake_orig_img_path),
                'source_dir': str(source_folder)
            },
            content_type='multipart/form-data'
        )
    assert upload_res.status_code == 200
    up_data = upload_res.get_json()
    sid = up_data['session_id']
    fid = up_data['file_id']
    assert up_data['source_dir'] == str(source_folder)

    rects = [{"x": 20, "y": 20, "w": 50, "h": 50, "orient": 0, "excluded": False}]

    # 执行 subfolder 模式导出
    export_res = client.post('/api/export', json={
        'session_id': sid,
        'export_type': 'local',
        'path_mode': 'subfolder',
        'subfolder': 'output',
        'format': 'jpg',
        'files': [{'file_id': fid, 'filename': 'scan_sample.png', 'rects': rects, 'source_dir': str(source_folder)}]
    })
    assert export_res.status_code == 200
    exp_data = export_res.get_json()

    # 核心校验：导出的目标目录必须是原图目录下的 output，而不是项目目录
    expected_output_dir = str(source_folder / "output")
    assert os.path.abspath(exp_data['local_path']) == os.path.abspath(expected_output_dir)
    assert os.path.exists(expected_output_dir)

    exported_files = os.listdir(expected_output_dir)
    assert len(exported_files) > 0

def test_dialog_apis(client, monkeypatch):
    """测试原生选择对话框接口"""
    # 模拟选择图片取消
    monkeypatch.setattr('app.choose_files_dialog', lambda title: [])
    pick_res = client.post('/api/pick_images', json={'session_id': 'test_sid'})
    assert pick_res.status_code == 200
    assert pick_res.get_json()['cancelled'] is True

    # 模拟选择文件夹
    monkeypatch.setattr('app.choose_folder_dialog', lambda title: 'D:\\TestFolder')
    folder_res = client.post('/api/pick_folder', json={'title': '测试'})
    assert folder_res.status_code == 200
    assert folder_res.get_json()['folder'] == 'D:\\TestFolder'

def test_rotate_rects_180():
    """测试 180 度几何与朝向变换"""
    rects = [
        {
            "x": 20, "y": 30, "w": 100, "h": 200, "orient": 180,
            "rotated": {
                "cx": 70, "cy": 130, "w": 100, "h": 200, "angle": 15.0,
                "points": [[20, 30], [120, 30], [120, 230], [20, 230]]
            }
        },
        {
            "x": 50, "y": 80, "w": 60, "h": 70, "orient": 0
        }
    ]
    transformed = ImageCropper.rotate_rects_180(rects, img_w=800, img_h=600)
    assert len(transformed) == 2

    # 原本 180 度的切片倒置后变 0 度正向
    assert transformed[0]["orient"] == 0
    assert transformed[0]["x"] == 800 - 20 - 100  # 680
    assert transformed[0]["y"] == 600 - 30 - 200  # 370
    assert transformed[0]["w"] == 100
    assert transformed[0]["h"] == 200
    assert transformed[0]["rotated"]["cx"] == 800 - 70
    assert transformed[0]["rotated"]["cy"] == 600 - 130

    # 原本 0 度的切片倒置后变为 180 度
    assert transformed[1]["orient"] == 180
    assert transformed[1]["x"] == 800 - 50 - 60
    assert transformed[1]["y"] == 600 - 80 - 70

def test_auto_orient_inverts_large_image_when_majority_inverted(client, monkeypatch):
    """测试超过半数切片倒置时触发大图翻转"""
    img = np.full((300, 300, 3), 255, dtype=np.uint8)
    img[20:100, 20:100] = [10, 20, 30]
    ok, buf = cv2.imencode('.png', img)
    assert ok

    from io import BytesIO
    upload_res = client.post(
        '/api/upload',
        data={'file': (BytesIO(buf.tobytes()), 'test_upside_down.png')},
        content_type='multipart/form-data'
    )
    assert upload_res.status_code == 200
    up_data = upload_res.get_json()
    sid = up_data['session_id']
    fid = up_data['file_id']

    # 模拟 predict_orientation 返回 180 (倒置)
    monkeypatch.setattr(ImageCropper, 'predict_orientation', lambda crop: 180)

    # 3 个切片中有 2 个倒置 (> 50%)
    rects = [
        {"x": 10, "y": 10, "w": 50, "h": 50, "orient": 0},
        {"x": 70, "y": 10, "w": 50, "h": 50, "orient": 0},
        {"x": 10, "y": 70, "w": 50, "h": 50, "orient": 0}
    ]

    orient_res = client.post('/api/auto_orient', json={
        'session_id': sid,
        'file_id': fid,
        'rects': rects,
        'bg_type': 'light'
    })
    assert orient_res.status_code == 200
    res_data = orient_res.get_json()
    assert res_data['image_rotated'] is True
    assert 'thumbnail' in res_data
    assert len(res_data['rects']) == 3

def test_preview_inverts_large_image_when_majority_inverted(client, monkeypatch):
    """测试首次预览扫描时超过半数切片倒置自动翻转大图"""
    img = np.full((400, 400, 3), 255, dtype=np.uint8)
    img[30:120, 30:120] = [10, 20, 30]
    img[30:120, 200:290] = [10, 20, 30]
    ok, buf = cv2.imencode('.png', img)
    assert ok

    from io import BytesIO
    upload_res = client.post(
        '/api/upload',
        data={'file': (BytesIO(buf.tobytes()), 'test_preview_upside_down.png')},
        content_type='multipart/form-data'
    )
    assert upload_res.status_code == 200
    up_data = upload_res.get_json()
    sid = up_data['session_id']
    fid = up_data['file_id']

    # 模拟 predict_orientation 返回 180 (倒置)
    monkeypatch.setattr(ImageCropper, 'predict_orientation', lambda crop: 180)

    prev_res = client.post('/api/preview', json={
        'session_id': sid,
        'file_id': fid,
        'threshold_mode': 'otsu',
        'threshold': 200,
        'blur_kernel': 3,
        'morph_size': 3,
        'min_area_pct': 0.1,
        'max_area_pct': 90.0,
        'allow_auto_invert': True
    })
    assert prev_res.status_code == 200
    prev_data = prev_res.get_json()
    assert prev_data['image_rotated'] is True
    assert 'thumbnail' in prev_data




