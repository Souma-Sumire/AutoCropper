import os
import sys
import uuid
import base64
import zipfile
from io import BytesIO
import time
import cv2
import numpy as np
from flask import Flask, request, jsonify, send_file, render_template
from cropper import ImageCropper

def get_resource_path(relative_path):
    """获取资源绝对路径，兼容常规运行与 PyInstaller 打包环境"""
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)

template_dir = get_resource_path('templates')
static_dir = get_resource_path('static')
app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

import json
import shutil

UPLOAD_DIR = "temp_uploads"
OUTPUT_DIR = "output"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

def choose_folder_dialog(title="选择文件夹"):
    """调出系统文件夹选择对话框，优先使用 tkinter，失败时在 Windows 下回退至 ctypes"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder = filedialog.askdirectory(title=title)
        root.destroy()
        if folder:
            return os.path.abspath(folder)
        return ""
    except Exception:
        pass

    if sys.platform == 'win32':
        try:
            import ctypes
            from ctypes import wintypes
            class BROWSEINFO(ctypes.Structure):
                _fields_ = [
                    ('hwndOwner', wintypes.HWND),
                    ('pidlRoot', wintypes.LPARAM),
                    ('pszDisplayName', wintypes.LPWSTR),
                    ('lpszTitle', wintypes.LPCWSTR),
                    ('ulFlags', wintypes.UINT),
                    ('lpfn', wintypes.LPVOID),
                    ('lParam', wintypes.LPARAM),
                    ('iImage', ctypes.c_int)
                ]
            BIF_RETURNONLYFSDIRS = 0x0001
            BIF_NEWDIALOGSTYLE = 0x0040
            bi = BROWSEINFO()
            bi.lpszTitle = title
            bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
            pidl = ctypes.windll.shell32.SHBrowseForFolderW(ctypes.byref(bi))
            if pidl:
                path_buf = ctypes.create_unicode_buffer(260)
                ctypes.windll.shell32.SHGetPathFromIDListW(pidl, path_buf)
                ctypes.windll.ole32.CoTaskMemFree(pidl)
                if path_buf.value:
                    return os.path.abspath(path_buf.value)
        except Exception:
            pass
    return ""

def choose_files_dialog(title="选择要裁剪的本地图片"):
    """调出系统文件选择对话框，优先使用 tkinter，返回选择的绝对路径列表"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        filetypes = [
            ("图片文件", "*.jpg *.jpeg *.png *.bmp *.webp *.tif *.tiff"),
            ("所有文件", "*.*")
        ]
        files = filedialog.askopenfilenames(title=title, filetypes=filetypes)
        root.destroy()
        if files:
            return [os.path.abspath(f) for f in files]
        return []
    except Exception:
        pass
    return []

def cleanup_temp_uploads(max_age_hours=24):
    """扫描并清理超过指定时长的临时上传会话目录，返回清理的目录数量与释放字节数"""
    if not os.path.exists(UPLOAD_DIR):
        return 0, 0
    now = time.time()
    max_age_sec = max_age_hours * 3600
    cleaned_count = 0
    freed_bytes = 0

    try:
        for entry in os.scandir(UPLOAD_DIR):
            if entry.is_dir():
                try:
                    stat = entry.stat()
                    if now - stat.st_mtime >= max_age_sec:
                        dir_size = 0
                        for root, _, files in os.walk(entry.path):
                            for f in files:
                                try:
                                    dir_size += os.path.getsize(os.path.join(root, f))
                                except Exception:
                                    pass
                        shutil.rmtree(entry.path, ignore_errors=True)
                        cleaned_count += 1
                        freed_bytes += dir_size
                except Exception:
                    pass
    except Exception:
        pass
    return cleaned_count, freed_bytes

@app.route('/')
def index():
    return render_template('index.html', title="AutoCropper Local Debugger")

@app.route('/api/ping', methods=['GET'])
def ping():
    return jsonify({"status": "ok", "message": "服务在线"})

def _process_and_store_image(session_id, original_img, filename, source_path="", source_dir=""):
    """存储原图、生成预览和缩略图，并记录元数据"""
    file_id = str(uuid.uuid4())
    session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
    os.makedirs(session_path, exist_ok=True)

    file_path = os.path.join(session_path, "original.png")
    ImageCropper.imwrite(file_path, original_img)

    h, w = original_img.shape[:2]
    preview_img, scale = ImageCropper.resize_to_limit(original_img, max_height=1600)
    ImageCropper.imwrite(os.path.join(session_path, "preview.png"), preview_img)

    gray = cv2.cvtColor(preview_img, cv2.COLOR_BGR2GRAY)
    auto_thresh = ImageCropper.estimate_best_threshold(gray, "light")

    _, buffer = cv2.imencode('.png', preview_img)
    thumbnail_base64 = base64.b64encode(buffer).decode('utf-8')

    resolved_source_dir = ""
    if source_dir and source_dir.strip():
        resolved_source_dir = os.path.abspath(source_dir.strip().strip('"').strip("'"))
    elif source_path and source_path.strip():
        resolved_source_dir = os.path.abspath(os.path.dirname(source_path.strip().strip('"').strip("'")))

    meta = {
        "filename": filename,
        "source_path": source_path,
        "source_dir": resolved_source_dir
    }
    with open(os.path.join(session_path, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)

    return {
        "session_id": session_id,
        "file_id": file_id,
        "filename": filename,
        "source_path": source_path,
        "source_dir": resolved_source_dir,
        "width": w,
        "height": h,
        "thumbnail": f"data:image/png;base64,{thumbnail_base64}",
        "suggested_threshold": auto_thresh
    }

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

    source_path = request.form.get("source_path", "").strip()
    source_dir = request.form.get("source_dir", "").strip()

    file_bytes = file.read()
    nparr = np.frombuffer(file_bytes, np.uint8)
    original_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if original_img is None:
        return jsonify({"error": "无效的图片格式"}), 400

    result = _process_and_store_image(
        session_id, original_img, file.filename, source_path=source_path, source_dir=source_dir
    )
    return jsonify(result)

@app.route('/api/pick_images', methods=['POST'])
def pick_images():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    if not session_id:
        session_id = str(uuid.uuid4())

    paths = choose_files_dialog(title="选择要裁剪的本地图片")
    if not paths:
        return jsonify({"files": [], "cancelled": True, "session_id": session_id})

    results = []
    for p in paths:
        if not os.path.isfile(p):
            continue
        img = ImageCropper.imread(p)
        if img is None:
            continue
        filename = os.path.basename(p)
        source_dir = os.path.dirname(p)
        item = _process_and_store_image(
            session_id, img, filename, source_path=p, source_dir=source_dir
        )
        results.append(item)

    return jsonify({
        "session_id": session_id,
        "files": results,
        "count": len(results),
        "cancelled": False
    })

@app.route('/api/pick_folder', methods=['POST'])
def pick_folder():
    data = request.get_json() or {}
    title = data.get("title", "选择保存切片的目标文件夹")
    path = choose_folder_dialog(title=title)
    return jsonify({
        "folder": path or "",
        "cancelled": not bool(path)
    })

@app.route('/api/estimate_threshold', methods=['POST'])
def estimate_threshold():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    file_id = data.get("file_id")
    bg_type = data.get("bg_type", "light")

    session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
    preview_path = os.path.join(session_path, "preview.png")
    if not os.path.exists(preview_path):
        return jsonify({"error": "找不到预览文件"}), 404

    preview_img = ImageCropper.imread(preview_path)
    if preview_img is None:
        return jsonify({"error": "读取预览文件失败"}), 500

    gray = cv2.cvtColor(preview_img, cv2.COLOR_BGR2GRAY)
    best_thresh = ImageCropper.estimate_best_threshold(gray, bg_type)
    return jsonify({"threshold": best_thresh})

def _invert_image_files(session_id, file_id):
    """将 session 中的 preview.png 和 original.png 旋转 180 度翻转保存，返回新的 preview_img 与 base64 缩略图"""
    session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
    preview_path = os.path.join(session_path, "preview.png")
    original_path = os.path.join(session_path, "original.png")

    preview_img = ImageCropper.imread(preview_path)
    if preview_img is not None:
        preview_img = cv2.rotate(preview_img, cv2.ROTATE_180)
        ImageCropper.imwrite(preview_path, preview_img)

    if os.path.exists(original_path):
        orig_img = ImageCropper.imread(original_path)
        if orig_img is not None:
            orig_img = cv2.rotate(orig_img, cv2.ROTATE_180)
            ImageCropper.imwrite(original_path, orig_img)

    meta_path = os.path.join(session_path, "meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta["inverted"] = not meta.get("inverted", False)
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False)
        except Exception:
            pass

    new_thumb = ""
    if preview_img is not None:
        _, buffer = cv2.imencode('.png', preview_img)
        new_thumb = f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"

    return preview_img, new_thumb

@app.route('/api/auto_orient', methods=['POST'])
def auto_orient():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    file_id = data.get("file_id")
    rects = data.get("rects", [])
    bg_type = data.get("bg_type", "light")
    auto_rotate = bool(data.get("auto_rotate", True))

    session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
    preview_path = os.path.join(session_path, "preview.png")
    if not os.path.exists(preview_path):
        return jsonify({"error": "找不到预览文件"}), 404

    preview_img = ImageCropper.imread(preview_path)
    if preview_img is None:
        return jsonify({"error": "读取预览文件失败"}), 500

    changed_count = 0
    valid_count = 0
    for r in rects:
        if r.get("excluded"):
            continue
        valid_count += 1
        crop = ImageCropper.extract_crop(
            preview_img, r, scale_x=1.0, scale_y=1.0, auto_rotate=auto_rotate, bg_type=bg_type
        )
        if crop is not None and crop.size > 0:
            predicted_deg = ImageCropper.predict_orientation(crop)
            if predicted_deg != 0:
                current_orient = int(r.get("orient", 0) or 0)
                new_orient = (current_orient + predicted_deg) % 360
                r["orient"] = new_orient
                changed_count += 1

    # 规则：如果扫描结果超过半数的切片都需要倒置，则大图应该倒置
    image_rotated = False
    new_thumbnail = None
    inverted_count = sum(1 for r in rects if not r.get("excluded") and int(r.get("orient", 0) or 0) == 180)
    if valid_count > 0 and inverted_count > valid_count / 2:
        preview_img, new_thumbnail = _invert_image_files(session_id, file_id)
        if preview_img is not None:
            image_rotated = True
            img_h, img_w = preview_img.shape[:2]
            rects = ImageCropper.rotate_rects_180(rects, img_w, img_h)
            for r in rects:
                if r.get("excluded"):
                    continue
                crop = ImageCropper.extract_crop(
                    preview_img, r, scale_x=1.0, scale_y=1.0, auto_rotate=auto_rotate, bg_type=bg_type
                )
                if crop is not None and crop.size > 0:
                    deg = ImageCropper.predict_orientation(crop)
                    r["orient"] = deg

    msg = f"检测到超过半数切片倒置（{inverted_count}/{valid_count}），已将大图旋转180°正向放置并校正切片。" if image_rotated else f"已智能校正 {changed_count} 张照片的朝向。"
    resp = {
        "rects": rects,
        "changed_count": changed_count,
        "image_rotated": image_rotated,
        "message": msg
    }
    if image_rotated and new_thumbnail:
        resp["thumbnail"] = new_thumbnail

    return jsonify(resp)

@app.route('/api/preview', methods=['POST'])
def preview_crops():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    file_id = data.get("file_id")
    blur_kernel = int(data.get("blur_kernel", 3))
    threshold_val = int(data.get("threshold", 200))
    threshold_mode = data.get("threshold_mode", "fixed")
    morph_size = int(data.get("morph_size", 0))
    bg_type = data.get("bg_type", "light")
    min_area_pct = float(data.get("min_area_pct", 0.25))
    max_area_pct = float(data.get("max_area_pct", 80.0))
    padding = int(data.get("padding", 2))
    debug_mode = data.get("debug_mode", "original")
    allow_auto_invert = bool(data.get("allow_auto_invert", True))
    
    session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
    preview_path = os.path.join(session_path, "preview.png")
    if not os.path.exists(preview_path):
        return jsonify({"error": "找不到预览文件，会话可能失效"}), 404
        
    preview_img = ImageCropper.imread(preview_path)
    gray = cv2.cvtColor(preview_img, cv2.COLOR_BGR2GRAY)
    
    auto_rotate = bool(data.get("auto_rotate", True))

    start_time = time.time()
    blurred, thresh = ImageCropper.process_preview(
        gray, blur_kernel, threshold_val, bg_type, threshold_mode=threshold_mode, morph_size=morph_size
    )
    rects, filtered_count = ImageCropper.detect_rects(thresh, min_area_pct, max_area_pct, padding)

    # 自动识别并纠正朝向（自动转正照片）
    if auto_rotate:
        for r in rects:
            crop = ImageCropper.extract_crop(
                preview_img, r, scale_x=1.0, scale_y=1.0, auto_rotate=True, bg_type=bg_type
            )
            if crop is not None and crop.size > 0:
                deg = ImageCropper.predict_orientation(crop)
                if deg != 0:
                    r["orient"] = deg

    # 规则：如果扫描结果超过半数的切片都需要倒置，则大图应该倒置
    image_rotated = False
    new_thumbnail = None
    valid_rects = [r for r in rects if not r.get("excluded")]
    inverted_count = sum(1 for r in valid_rects if int(r.get("orient", 0) or 0) == 180)

    if allow_auto_invert and len(valid_rects) > 0 and inverted_count > len(valid_rects) / 2:
        preview_img, new_thumbnail = _invert_image_files(session_id, file_id)
        if preview_img is not None:
            image_rotated = True
            img_h, img_w = preview_img.shape[:2]
            rects = ImageCropper.rotate_rects_180(rects, img_w, img_h)
            for r in rects:
                if r.get("excluded"):
                    continue
                crop = ImageCropper.extract_crop(
                    preview_img, r, scale_x=1.0, scale_y=1.0, auto_rotate=auto_rotate, bg_type=bg_type
                )
                if crop is not None and crop.size > 0:
                    deg = ImageCropper.predict_orientation(crop)
                    r["orient"] = deg
            # 翻转后若在调试模式下，重新计算二值化图
            gray = cv2.cvtColor(preview_img, cv2.COLOR_BGR2GRAY)
            blurred, thresh = ImageCropper.process_preview(
                gray, blur_kernel, threshold_val, bg_type, threshold_mode=threshold_mode, morph_size=morph_size
            )

    elapsed_ms = int((time.time() - start_time) * 1000)
    
    debug_image_base64 = ""
    if debug_mode == "threshold":
        _, buffer = cv2.imencode('.png', thresh)
        debug_image_base64 = f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"
    elif debug_mode == "blurred":
        _, buffer = cv2.imencode('.png', blurred)
        debug_image_base64 = f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"
        
    invert_notice = f" 检测到超过半数切片倒置（{inverted_count}/{len(valid_rects)}），已将大图旋转180°正向放置。" if image_rotated else ""
    log_msg = f"检测到轮廓 {len(rects) + filtered_count} 个。保留 {len(rects)} 个，过滤噪点 {filtered_count} 个。模式: {threshold_mode}，耗时: {elapsed_ms}ms。{invert_notice}"
    
    resp = {
        "rects": rects,
        "debug_image": debug_image_base64,
        "log": log_msg,
        "image_rotated": image_rotated
    }
    if image_rotated and new_thumbnail:
        resp["thumbnail"] = new_thumbnail

    return jsonify(resp)

def _collect_cropped_items(session_id, files, naming_template=None, ext="jpg"):
    """从会话原图按 rects 提取裁剪结果。返回每个裁剪项的字典信息，包含 source_dir。"""
    all_cropped_items = []
    ext_clean = ext.lower().lstrip(".")

    for f in files:
        file_id = f.get("file_id")
        filename = f.get("filename", "image.png")
        rects = f.get("rects", [])
        bg_type = f.get("bg_type", "light")
        auto_rotate = f.get("auto_rotate", True)
        source_dir = (f.get("source_dir") or "").strip()
        name_prefix, _ = os.path.splitext(filename)

        session_path = os.path.join(UPLOAD_DIR, session_id, file_id)
        original_path = os.path.join(session_path, "original.png")
        preview_path = os.path.join(session_path, "preview.png")

        # 若未获取到 source_dir，尝试从服务端持久化的 meta.json 读取
        if not source_dir:
            meta_path = os.path.join(session_path, "meta.json")
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as mf:
                        meta = json.load(mf)
                        source_dir = (meta.get("source_dir") or "").strip()
                        if not source_dir and meta.get("source_path"):
                            source_dir = os.path.dirname(meta.get("source_path")).strip()
                except Exception:
                    pass

        if source_dir:
            source_dir = os.path.abspath(os.path.normpath(source_dir.strip().strip('"').strip("'")))

        if not os.path.exists(original_path) or not os.path.exists(preview_path):
            continue

        original_img = ImageCropper.imread(original_path)
        preview_img = ImageCropper.imread(preview_path)
        if original_img is None or preview_img is None:
            continue

        orig_h, orig_w = original_img.shape[:2]
        prev_h, prev_w = preview_img.shape[:2]
        if prev_w <= 0 or prev_h <= 0:
            continue
        scale_x = orig_w / prev_w
        scale_y = orig_h / prev_h

        crop_idx = 0
        for r in rects:
            if r.get("excluded"):
                continue
            cropped = ImageCropper.extract_crop(
                original_img, r, scale_x, scale_y, auto_rotate=auto_rotate, bg_type=bg_type
            )
            if cropped is None or cropped.size == 0:
                continue
            crop_idx += 1
            out_name = ImageCropper.format_crop_name(
                naming_template, filename, crop_idx, ext=ext_clean
            )
            all_cropped_items.append({
                "folder": name_prefix,
                "name": out_name,
                "img": cropped,
                "source_dir": source_dir
            })

    return all_cropped_items

def _export_entry_path(folder, name, flat=False):
    if flat:
        if name.startswith(f"{folder}_") or name.startswith(folder):
            return name
        return f"{folder}_{name}"
    return f"{folder}/{name}"

@app.route('/api/check_session', methods=['POST'])
def check_session():
    data = request.get_json() or {}
    sid = data.get("session_id")
    if not sid or not os.path.exists(os.path.join(UPLOAD_DIR, sid)):
        return jsonify({"valid": False})
    return jsonify({"valid": True})

@app.route('/api/get_file_preview', methods=['GET'])
def get_file_preview():
    session_id = request.args.get("session_id")
    file_id = request.args.get("file_id")
    if not session_id or not file_id:
        return jsonify({"error": "缺少参数"}), 400

    preview_path = os.path.join(UPLOAD_DIR, session_id, file_id, "preview.png")
    if not os.path.exists(preview_path):
        return jsonify({"error": "预览图不存在"}), 404

    return send_file(preview_path, mimetype='image/png')


@app.route('/api/export', methods=['POST'])
def export_crops():
    data = request.get_json() or {}
    session_id = data.get("session_id")
    files = data.get("files", [])
    export_type = data.get("export_type", "local")
    export_format = (data.get("format") or "jpg").lower().lstrip(".")
    naming_template = data.get("naming_template") or "{original}_{index:02d}"
    quality = int(data.get("quality", 100))
    flat = bool(data.get("flat", False))
    path_mode = data.get("path_mode", "subfolder")
    custom_path = data.get("custom_path", "")
    subfolder = data.get("subfolder", "output")

    if not session_id:
        return jsonify({"error": "缺少 session_id"}), 400

    all_cropped_items = _collect_cropped_items(
        session_id, files, naming_template=naming_template, ext=export_format
    )

    if not all_cropped_items:
        return jsonify({"error": "没有提取到任何裁剪后的图片，请调整裁剪参数。"}), 400

    encode_ext = f".{export_format}"
    encode_params = []
    if export_format in ["jpg", "jpeg"]:
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    elif export_format == "png":
        encode_params = [cv2.IMWRITE_PNG_COMPRESSION, 3]

    # 供前端按文件逐步拉取并本地打包
    if export_type == "images":
        images = []
        for item in all_cropped_items:
            folder = item["folder"]
            name = item["name"]
            img = item["img"]
            ok, buffer = cv2.imencode(encode_ext, img, encode_params)
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
            for item in all_cropped_items:
                folder = item["folder"]
                name = item["name"]
                img = item["img"]
                ok, buffer = cv2.imencode(encode_ext, img, encode_params)
                if ok:
                    zf.writestr(_export_entry_path(folder, name, flat=flat), buffer.tobytes())
        zip_bytes = zip_buffer.getvalue()
        return send_file(
            BytesIO(zip_bytes),
            mimetype='application/zip',
            as_attachment=False,
            download_name=f'cropped_batch_{export_format}.zip',
        )

    if export_type == "local":
        sub = subfolder.strip().strip('"').strip("'") if (subfolder and subfolder.strip()) else "output"
        written_dirs = set()

        for item in all_cropped_items:
            folder = item["folder"]
            name = item["name"]
            img = item["img"]
            item_source_dir = (item.get("source_dir") or "").strip().strip('"').strip("'")
            if item_source_dir:
                item_source_dir = os.path.abspath(os.path.normpath(item_source_dir))

            if path_mode == "custom" and custom_path and custom_path.strip():
                base_dir = os.path.abspath(custom_path.strip().strip('"').strip("'"))
            elif path_mode == "subfolder" and item_source_dir and os.path.isdir(item_source_dir):
                # 真实输出到原图所在的同级子目录
                base_dir = os.path.abspath(os.path.join(item_source_dir, sub))
            elif custom_path and custom_path.strip() and os.path.isdir(custom_path.strip()):
                base_dir = os.path.abspath(os.path.join(custom_path.strip().strip('"').strip("'"), sub))
            else:
                return jsonify({
                    "error": "未检测到原图所在的本地文件夹（可能由网页直接拖拽导入）。请在导出配置中选择“指定本机文件夹...”选择保存位置，以避免误存入项目目录。"
                }), 400

            os.makedirs(base_dir, exist_ok=True)
            written_dirs.add(base_dir)

            rel_entry = _export_entry_path(folder, name, flat=flat)
            out_path = os.path.join(base_dir, rel_entry)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            if not ImageCropper.imwrite(out_path, img, quality=quality):
                return jsonify({"error": f"写入失败: {out_path}"}), 500

        output_paths = sorted(list(written_dirs))
        display_path = output_paths[0] if len(output_paths) == 1 else (os.path.commonpath(output_paths) if len(output_paths) > 1 else "")
        if not display_path and output_paths:
            display_path = output_paths[0]

        return jsonify({
            "message": f"成功批量分割并导出 {len(all_cropped_items)} 张照片（{export_format.upper()} 格式）。",
            "local_path": display_path,
            "local_paths": output_paths,
            "count": len(all_cropped_items),
        })

    return jsonify({"error": "不支持的导出类型"}), 400

@app.route('/api/clear_session', methods=['POST'])
def clear_session():
    data = request.get_json() or {}
    sid = data.get("session_id")
    if not sid:
        return jsonify({"success": False, "error": "缺少 session_id"}), 400
    session_path = os.path.join(UPLOAD_DIR, sid)
    if os.path.exists(session_path):
        shutil.rmtree(session_path, ignore_errors=True)
        return jsonify({"success": True, "message": "会话临时文件已清除"})
    return jsonify({"success": True, "message": "会话目录不存在或已被清理"})

@app.route('/api/cleanup', methods=['POST'])
def manual_cleanup():
    data = request.get_json() or {}
    max_age_hours = float(data.get("max_age_hours", 24))
    count, freed = cleanup_temp_uploads(max_age_hours=max_age_hours)
    freed_mb = round(freed / (1024 * 1024), 2)
    return jsonify({
        "success": True,
        "cleaned_count": count,
        "freed_mb": freed_mb,
        "message": f"已清理 {count} 个临时会话，释放 {freed_mb} MB 磁盘空间。"
    })

if __name__ == '__main__':
    import webbrowser
    import threading
    import socket

    is_frozen = getattr(sys, 'frozen', False)

    def start_cleanup_daemon():
        count, freed = cleanup_temp_uploads(max_age_hours=24)
        if count > 0:
            print(f"  [清理] 已自动清理 {count} 个过期临时会话，释放 {freed / (1024 * 1024):.1f} MB 空间。")
        while True:
            time.sleep(3600)
            try:
                cleanup_temp_uploads(max_age_hours=24)
            except Exception:
                pass

    threading.Thread(target=start_cleanup_daemon, daemon=True).start()

    def open_browser(host='127.0.0.1', port=5000, max_wait=6.0):
        start_time = time.time()
        while time.time() - start_time < max_wait:
            try:
                with socket.create_connection((host, port), timeout=0.04):
                    break
            except (OSError, ConnectionRefusedError):
                time.sleep(0.02)
        try:
            webbrowser.open(f'http://{host}:{port}')
        except Exception:
            pass

    threading.Thread(target=open_browser, daemon=True).start()

    print("=" * 60)
    print("  AutoCropper 智能图像批量裁剪工作台")
    print("  本地服务地址: http://127.0.0.1:5000")
    print("  正在自动在浏览器中打开工作台...")
    print("  提示: 保持此窗口开启即可正常使用，关闭此窗口即退出程序。")
    print("=" * 60)

    if is_frozen:
        try:
            from waitress import serve
            serve(app, host='127.0.0.1', port=5000, threads=6)
        except ImportError:
            app.run(host='127.0.0.1', port=5000, debug=False)
    else:
        app.run(host='127.0.0.1', port=5000, debug=True)
