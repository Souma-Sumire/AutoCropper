import io
import json
import zipfile
import numpy as np
import cv2
import pytest
from app import app

def test_batch_api_workflow():
    client = app.test_client()
    
    # 1. 模拟生成两张不同的图片 (600x600)
    img1 = np.ones((600, 600, 3), dtype=np.uint8) * 255
    img1[100:200, 100:200] = 0 # 黑色块作为照片
    
    img2 = np.ones((600, 600, 3), dtype=np.uint8) * 255
    img2[300:400, 300:400] = 0
    
    _, enc1 = cv2.imencode('.png', img1)
    _, enc2 = cv2.imencode('.png', img2)
    
    # 2. 上传第一张图片 (初始化session_id)
    res1 = client.post('/api/upload', data={
        'file': (io.BytesIO(enc1.tobytes()), 'scan1.png')
    }, content_type='multipart/form-data')
    assert res1.status_code == 200
    data1 = res1.get_json()
    assert 'session_id' in data1
    assert 'file_id' in data1
    assert 'suggested_threshold' in data1
    assert isinstance(data1['suggested_threshold'], int)
    assert 0 <= data1['suggested_threshold'] <= 255
    session_id = data1['session_id']
    file_id_1 = data1['file_id']
    
    # 3. 携带同一个 session_id 上传第二张图片
    res2 = client.post('/api/upload', data={
        'file': (io.BytesIO(enc2.tobytes()), 'scan2.png'),
        'session_id': session_id
    }, content_type='multipart/form-data')
    assert res2.status_code == 200
    data2 = res2.get_json()
    assert data2['session_id'] == session_id
    file_id_2 = data2['file_id']
    
    # 4. 预览第一张图的裁剪框
    prev_res1 = client.post('/api/preview', json={
        "session_id": session_id,
        "file_id": file_id_1,
        "blur_kernel": 3,
        "threshold": 127,
        "bg_type": "light",
        "min_area_pct": 1.0,
        "max_area_pct": 80.0,
        "padding": 5,
        "debug_mode": "original"
    })
    assert prev_res1.status_code == 200
    p_data1 = prev_res1.get_json()
    assert 'rects' in p_data1
    rects1 = p_data1['rects']
    assert len(rects1) >= 1
    
    # 5. 批量导出为 ZIP 包
    export_res = client.post('/api/export', json={
        "session_id": session_id,
        "export_type": "zip",
        "files": [
            {"file_id": file_id_1, "filename": "scan1.png", "rects": rects1},
            {"file_id": file_id_2, "filename": "scan2.png", "rects": []} # 模拟第二张为空
        ]
    })
    assert export_res.status_code == 200
    assert export_res.headers['Content-Type'] == 'application/zip'
    assert 'attachment' not in (export_res.headers.get('Content-Disposition') or '').lower()

    # 6. images 模式（前端按文件拉取后本地打包，避免下载器劫持）
    images_res = client.post('/api/export', json={
        "session_id": session_id,
        "export_type": "images",
        "files": [
            {"file_id": file_id_1, "filename": "scan1.png", "rects": rects1},
        ]
    })
    assert images_res.status_code == 200
    images_data = images_res.get_json()
    assert images_data['count'] >= 1
    assert len(images_data['images']) == images_data['count']
    assert 'data' in images_data['images'][0]

    # 7. 平铺导出（无子文件夹）
    flat_res = client.post('/api/export', json={
        "session_id": session_id,
        "export_type": "images",
        "flat": True,
        "files": [
            {"file_id": file_id_1, "filename": "scan1.png", "rects": rects1},
        ]
    })
    assert flat_res.status_code == 200
    flat_data = flat_res.get_json()
    assert '/' not in flat_data['images'][0]['path']
    assert flat_data['images'][0]['path'].startswith('scan1_')
