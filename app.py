import os
import uuid
import base64
import zipfile
from io import BytesIO
import time
import cv2
import numpy as np
from flask import Flask, request, jsonify, send_file, render_template
from cropper import ImageCropper

app = Flask(__name__, template_folder='templates', static_folder='static')

UPLOAD_DIR = "temp_uploads"
OUTPUT_DIR = "output"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

@app.route('/')
def index():
    return render_template('index.html', title="AutoCropper Local Debugger")

@app.route('/api/ping', methods=['GET'])
def ping():
    return jsonify({"status": "ok", "message": "服务在线"})

@app.route('/api/upload', methods=['POST'])
def upload_image():
    if 'file' not in request.files:
        return jsonify({"error": "没有上传文件"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "未选择文件名"}), 400
    
    session_id = request.form.get("session_id")
    if not session_id:
        session_id = str(uuid.uuid4())
        
    file_id = str(uuid.uuid4())
    session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
    os.makedirs(session_path, exist_ok=True)
    
    file_path = os.path.join(session_path, "original.png")
    file.save(file_path)
    
    original_img = cv2.imread(file_path)
    if original_img is None:
        return jsonify({"error": "无效的图片格式"}), 400
        
    h, w = original_img.shape[:2]
    preview_img, scale = ImageCropper.resize_to_limit(original_img, max_height=1600)
    
    cv2.imwrite(os.path.join(session_path, "preview.png"), preview_img)
    
    _, buffer = cv2.imencode('.png', preview_img)
    thumbnail_base64 = base64.b64encode(buffer).decode('utf-8')
    
    return jsonify({
        "session_id": session_id,
        "file_id": file_id,
        "filename": file.filename,
        "width": w,
        "height": h,
        "thumbnail": f"data:image/png;base64,{thumbnail_base64}"
    })

@app.route('/api/preview', methods=['POST'])
def preview_crops():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    file_id = data.get("file_id")
    blur_kernel = int(data.get("blur_kernel", 3))
    threshold_val = int(data.get("threshold", 200))
    bg_type = data.get("bg_type", "light")
    min_area_pct = float(data.get("min_area_pct", 0.8))
    max_area_pct = float(data.get("max_area_pct", 80.0))
    padding = int(data.get("padding", 5))
    debug_mode = data.get("debug_mode", "original")
    
    session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
    preview_path = os.path.join(session_path, "preview.png")
    if not os.path.exists(preview_path):
        return jsonify({"error": "找不到预览文件，会话可能失效"}), 404
        
    preview_img = cv2.imread(preview_path)
    gray = cv2.cvtColor(preview_img, cv2.COLOR_BGR2GRAY)
    
    start_time = time.time()
    blurred, thresh = ImageCropper.process_preview(gray, blur_kernel, threshold_val, bg_type)
    rects, filtered_count = ImageCropper.detect_rects(thresh, min_area_pct, max_area_pct, padding)
    elapsed_ms = int((time.time() - start_time) * 1000)
    
    debug_image_base64 = ""
    if debug_mode == "threshold":
        _, buffer = cv2.imencode('.png', thresh)
        debug_image_base64 = f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"
    elif debug_mode == "blurred":
        _, buffer = cv2.imencode('.png', blurred)
        debug_image_base64 = f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"
        
    log_msg = f"检测到轮廓 {len(rects) + filtered_count} 个。保留 {len(rects)} 个，过滤噪点 {filtered_count} 个。耗时: {elapsed_ms}ms。"
    
    return jsonify({
        "rects": rects,
        "debug_image": debug_image_base64,
        "log": log_msg
    })

def _collect_cropped_items(session_id, files):
    """从会话原图按 rects 提取裁剪结果。返回 (folder, name, img) 列表。"""
    all_cropped_items = []

    for f in files:
        file_id = f.get("file_id")
        filename = f.get("filename", "image.png")
        rects = f.get("rects", [])
        bg_type = f.get("bg_type", "light")
        auto_rotate = f.get("auto_rotate", True)
        name_prefix, _ = os.path.splitext(filename)

        session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
        original_path = os.path.join(session_path, "original.png")
        preview_path = os.path.join(session_path, "preview.png")

        if not os.path.exists(original_path) or not os.path.exists(preview_path):
            continue

        original_img = cv2.imread(original_path)
        preview_img = cv2.imread(preview_path)
        if original_img is None or preview_img is None:
            continue

        orig_h, orig_w = original_img.shape[:2]
        prev_h, prev_w = preview_img.shape[:2]
        if prev_w <= 0 or prev_h <= 0:
            continue
        scale_x = orig_w / prev_w
        scale_y = orig_h / prev_h

        for idx, r in enumerate(rects):
            cropped = ImageCropper.extract_crop(
                original_img, r, scale_x, scale_y, auto_rotate=auto_rotate, bg_type=bg_type
            )
            if cropped is None or cropped.size == 0:
                continue
            all_cropped_items.append((name_prefix, f"crop_{idx+1:02d}.png", cropped))

    return all_cropped_items


def _export_entry_path(folder, name, flat=False):
    if flat:
        return f"{folder}_{name}"
    return f"{folder}/{name}"


@app.route('/api/export', methods=['POST'])
def export_crops():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    files = data.get("files", [])
    export_type = data.get("export_type", "zip")
    flat = bool(data.get("flat", False))

    if not session_id:
        return jsonify({"error": "缺少 session_id"}), 400

    all_cropped_items = _collect_cropped_items(session_id, files)

    if not all_cropped_items:
        return jsonify({"error": "没有提取到任何裁剪后的图片，请调整裁剪参数。"}), 400

    # 供前端按文件逐步拉取并本地打包，避免下载管理器劫持二进制响应
    if export_type == "images":
        images = []
        for folder, name, img in all_cropped_items:
            ok, buffer = cv2.imencode('.png', img)
            if not ok:
                continue
            images.append({
                "folder": folder,
                "name": name,
                "path": _export_entry_path(folder, name, flat=flat),
                "data": base64.b64encode(buffer.tobytes()).decode('ascii'),
            })
        return jsonify({
            "images": images,
            "count": len(images),
        })

    if export_type == "zip":
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for folder, name, img in all_cropped_items:
                _, buffer = cv2.imencode('.png', img)
                zf.writestr(_export_entry_path(folder, name, flat=flat), buffer.tobytes())
        zip_bytes = zip_buffer.getvalue()
        # 不使用 as_attachment，避免 IDM 等下载器劫持 Content-Disposition: attachment
        return send_file(
            BytesIO(zip_bytes),
            mimetype='application/zip',
            as_attachment=False,
            download_name='cropped_batch_images.zip',
        )

    if export_type == "local":
        local_out_dir = os.path.join(OUTPUT_DIR, session_id)
        os.makedirs(local_out_dir, exist_ok=True)

        for folder, name, img in all_cropped_items:
            if flat:
                out_path = os.path.join(local_out_dir, f"{folder}_{name}")
            else:
                target_folder = os.path.join(local_out_dir, folder)
                os.makedirs(target_folder, exist_ok=True)
                out_path = os.path.join(target_folder, name)
            if not ImageCropper.imwrite(out_path, img):
                return jsonify({"error": f"写入失败: {out_path}"}), 500

        abs_out_path = os.path.abspath(local_out_dir)
        return jsonify({
            "message": f"成功批量分割并导出 {len(all_cropped_items)} 张照片。",
            "local_path": abs_out_path,
            "count": len(all_cropped_items),
        })

    return jsonify({"error": "不支持的导出类型"}), 400

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=True)
