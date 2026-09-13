// 状态管理
let sessionId = null;
let filesMap = {}; // { fileId: { name, width, height, thumbnail, rects, params, canvasEl, containerEl, detected, selectedCropIndex, selectedCropIndices: Set<number>, _edgeCanvas, _edgeCtx } }
let currentFileId = null;
let currentDebugMode = 'original'; // 'original' | 'threshold' | 'blurred'
let debounceTimeout = null;
let isProgrammaticScrolling = false;
let isImporting = false;

// DOM 节点
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const fileMeta = document.getElementById('fileMeta');
const fileListContainer = document.getElementById('fileListContainer');
const canvasContainer = document.getElementById('canvasContainer');
const exportTypeSelect = document.getElementById('exportType');
const exportFormatSelect = document.getElementById('exportFormat');
const namingTemplateInput = document.getElementById('namingTemplate');
const flatExportCheck = document.getElementById('flatExport');
const exportBtn = document.getElementById('exportBtn');
const syncParamsBtn = document.getElementById('syncParamsBtn');
const tabItems = document.querySelectorAll('.tab-item');
const consoleLog = document.getElementById('consoleLog');
const batchSummary = document.getElementById('batchSummary');
const importProgress = document.getElementById('importProgress');
const importProgressText = document.getElementById('importProgressText');
const importProgressFill = document.getElementById('importProgressFill');

function log(message) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    consoleLog.value += `\n[${timeStr}] ${message}`;
    consoleLog.scrollTop = consoleLog.scrollHeight;
}

function setExportBusy(busy, label) {
    exportBtn.disabled = busy || isImporting || Object.keys(filesMap).length === 0;
    exportBtn.textContent = busy ? (label || '正在导出…') : '开始执行图像裁剪';
    exportTypeSelect.disabled = busy || isImporting;
    if (exportFormatSelect) exportFormatSelect.disabled = busy || isImporting;
    if (namingTemplateInput) namingTemplateInput.disabled = busy || isImporting;
    if (flatExportCheck) flatExportCheck.disabled = busy || isImporting;
}

async function readApiError(res, fallback) {
    try {
        const data = await res.json();
        return data.error || fallback;
    } catch (_) {
        return `${fallback} (HTTP ${res.status})`;
    }
}

function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function encodeUtf8(str) {
    return new TextEncoder().encode(str);
}

function buildStoreZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const GP_UTF8 = 0x0800;

    for (const entry of entries) {
        const nameBytes = encodeUtf8(entry.name);
        const data = entry.data;
        const crc = crc32(data);
        const size = data.length;

        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, GP_UTF8, true);
        lv.setUint16(8, 0, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);
        lv.setUint32(22, size, true);
        lv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, GP_UTF8, true);
        cv.setUint16(10, 0, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);

        localParts.push(local, data);
        centralParts.push(central);
        offset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

function downloadBlobNative(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 1500);
}

function getSortedFileIds() {
    return Object.keys(filesMap).sort((a, b) => naturalCompare(filesMap[a].name, filesMap[b].name));
}

function setImportUi(active, current = 0, total = 0, name = '') {
    isImporting = active;
    if (active) {
        importProgress.hidden = false;
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        importProgressFill.style.width = `${pct}%`;
        importProgressText.textContent = total
            ? `正在导入 ${current}/${total}：${name}`
            : '正在准备导入…';
        uploadBtn.disabled = true;
        uploadBtn.textContent = total ? `导入中 ${current}/${total}` : '导入中…';
        fileMeta.innerText = total
            ? `导入进度: ${current}/${total} — ${name}`
            : '正在导入文件…';
        syncParamsBtn.disabled = true;
        setExportBusy(true, '导入中…');

        let banner = document.getElementById('importBanner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'importBanner';
            banner.className = 'import-banner';
            canvasContainer.prepend(banner);
        }
        banner.innerHTML = `
            <div class="title">正在导入扫描件 ${current}/${total}</div>
            <div class="sub">${name || '请稍候，上传完成后会自动检测并选中排序第一的文件'}</div>
        `;
    } else {
        importProgress.hidden = true;
        importProgressFill.style.width = '0%';
        uploadBtn.disabled = false;
        uploadBtn.textContent = '选择本地图片';
        syncParamsBtn.disabled = Object.keys(filesMap).length === 0;
        setExportBusy(false);
        const banner = document.getElementById('importBanner');
        if (banner) banner.remove();
    }
}

function updateBatchSummary() {
    const fileIds = Object.keys(filesMap);
    const totalFiles = fileIds.length;
    let totalCrops = 0;
    fileIds.forEach(id => {
        const validRects = (filesMap[id].rects || []).filter(r => !r.excluded);
        totalCrops += validRects.length;
    });
    batchSummary.innerText = `[ 已载入: ${totalFiles} 个文件 | 共检测到 ${totalCrops} 张子照片 ]`;
}

tabItems.forEach(tab => {
    tab.addEventListener('click', () => {
        tabItems.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentDebugMode = tab.getAttribute('data-mode');
        log(`切换调试视图到: ${tab.innerText}`);

        Object.keys(filesMap).forEach(fileId => {
            if (currentDebugMode === 'original' && filesMap[fileId].detected) {
                drawCanvas(fileId);
                renderCropPreviews(fileId);
            } else {
                requestPreview(fileId);
            }
        });
    });
});

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
    }
});

async function handleFiles(files) {
    if (files.length === 0 || isImporting) return;

    const fileList = Array.from(files).sort((a, b) => naturalCompare(a.name, b.name));
    log(`准备上传并预处理 ${fileList.length} 个文件...`);
    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.style.display = 'none';

    setImportUi(true, 0, fileList.length, fileList[0]?.name || '');

    try {
        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            setImportUi(true, i + 1, fileList.length, file.name);
            log(`正在上传 [${i + 1}/${fileList.length}]: ${file.name}`);

            const formData = new FormData();
            formData.append('file', file);
            if (sessionId) {
                formData.append('session_id', sessionId);
            }

            try {
                const res = await fetch('/api/upload', { method: 'POST', body: formData });
                const data = await res.json();
                if (data.error) {
                    log(`上传失败: ${file.name} - ${data.error}`);
                    continue;
                }

                if (!sessionId) {
                    sessionId = data.session_id;
                }

                const fileId = data.file_id;
                const pageEl = document.createElement('div');
                pageEl.className = 'canvas-page';
                pageEl.id = `page-${fileId}`;
                pageEl.innerHTML = `
                <div class="canvas-page-left">
                    <div class="canvas-page-header">
                        <span>[扫描件]: ${data.filename} (${data.width}x${data.height})</span>
                        <span id="page-count-${fileId}">正在计算检测框...</span>
                    </div>
                    <canvas id="canvas-${fileId}"></canvas>
                    <div class="crop-preview-panel">
                        <div class="crop-preview-title">
                            <span>矫正预览</span>
                            <span class="hint">快捷键：Z 左旋 · C 右旋 · X 转180°/反选排除 · Shift多选</span>
                        </div>
                        <div class="crop-preview-strip" id="crop-previews-${fileId}"></div>
                    </div>
                </div>
                <div class="canvas-page-right">
                    <h4>OpenCV 局部调优</h4>
                    
                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>背景色模式 <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="浅色白底：普通的白底扫描件大图；&#10;深色黑底：纯黑背景或深色底板的大图。">[?]</span></span>
                        </div>
                        <div class="radio-group" style="font-size:11px; display:flex; gap:10px;">
                            <label><input type="radio" name="bgType-${fileId}" value="light" checked> 浅色白底</label>
                            <label><input type="radio" name="bgType-${fileId}" value="dark"> 深色黑底</label>
                        </div>
                    </div>

                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>二值化算法模式 <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="固定阈值：手动拉动阈值滑块；&#10;Otsu 大津法：自动根据灰度双峰计算最优全局阈值；&#10;自适应局部高斯：有效应对纸张发黄、四角光照不均或暗角。">[?]</span></span>
                        </div>
                        <select id="threshMode-${fileId}" style="width:100%;font-size:11px;background:var(--bg-primary);color:var(--text-main);border:1px solid var(--border-color);padding:3px;outline:none;">
                            <option value="fixed" selected>固定阈值 (手动精确调整)</option>
                            <option value="otsu">Otsu 大津法 (自动双峰计算)</option>
                            <option value="adaptive">自适应局部高斯 (抗发黄/不均光照)</option>
                        </select>
                    </div>

                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>高斯模糊大小 <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="用于平滑降噪。数值越大图像越模糊，能融合微小噪点，但过大会导致边缘模糊。">[?]</span></span>
                        </div>
                        <select id="blurKernel-${fileId}" style="width:100%;font-size:11px;background:var(--bg-primary);color:var(--text-main);border:1px solid var(--border-color);padding:3px;outline:none;">
                            <option value="1">1 (无模糊)</option>
                            <option value="3" selected>3</option>
                            <option value="5">5</option>
                            <option value="7">7</option>
                            <option value="9">9</option>
                            <option value="11">11</option>
                            <option value="15">15</option>
                            <option value="21">21</option>
                        </select>
                    </div>

                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>二值化阈值 / 灵敏度 <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="区分背景与前景的亮度临界点。调高可滤除浅灰色阴影，使边缘彻底分离。">[?]</span></span>
                            <span id="threshValLabel-${fileId}" style="font-family:monospace; font-weight:bold; color:var(--accent-color);">200</span>
                        </div>
                        <div class="ctrl-input-row" style="display:flex; gap:6px; align-items:center;">
                            <input type="range" id="threshold-${fileId}" min="0" max="255" value="200" style="flex:1; cursor:pointer;">
                            <input type="number" id="thresholdNum-${fileId}" min="0" max="255" value="200" style="width:42px; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; text-align:right; padding:2px;">
                            <button id="estimateThreshBtn-${fileId}" class="btn-mini" style="font-size:10px; padding:3px 5px;" title="根据图像灰度自动估算最佳阈值">估算</button>
                        </div>
                    </div>

                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>形态学平滑 (闭合缝隙) <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="闭合轻微裂痕与微小缝隙，平滑老照片边缘毛刺。0 为不启用。">[?]</span></span>
                            <span id="morphValLabel-${fileId}" style="font-family:monospace; font-weight:bold; color:var(--accent-color);">0 px</span>
                        </div>
                        <div class="ctrl-input-row" style="display:flex; gap:10px; align-items:center;">
                            <input type="range" id="morphSizeRange-${fileId}" min="0" max="15" value="0" style="flex:1; cursor:pointer;">
                            <input type="number" id="morphSizeNum-${fileId}" min="0" max="15" value="0" style="width:45px; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; text-align:right; padding:2px;">
                        </div>
                    </div>

                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>自动倾斜矫正 <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="开启后，检测时会以斜框定位照片；导出分割时，会自动通过图像仿射变换旋转纠正，切出水平摆正的照片。">[?]</span></span>
                        </div>
                        <div style="font-size: 11px;">
                            <label style="cursor:pointer; display:flex; align-items:center; gap:6px;">
                                <input type="checkbox" id="autoRotate-${fileId}" checked> 自动倾斜矫正 (转正照片)
                            </label>
                        </div>
                    </div>

                    <h4>轮廓面积过滤</h4>
                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>最小面积占比 (%) <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="包围盒实际占画面面积低于此值的噪点会被忽略。已调小默认值以识别中小照片。">[?]</span></span>
                            <span id="minAreaValLabel-${fileId}" style="font-family:monospace; font-weight:bold; color:var(--accent-color);">0.8%</span>
                        </div>
                        <div class="ctrl-input-row" style="display:flex; gap:10px; align-items:center;">
                            <input type="range" id="minAreaRange-${fileId}" min="0.01" max="20" step="0.05" value="0.8" style="flex:1; cursor:pointer;">
                            <input type="number" id="minArea-${fileId}" min="0.01" max="100" step="0.05" value="0.8" style="width:50px; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; text-align:right; padding:2px;">
                        </div>
                    </div>
                    
                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>最大面积占比 (%) <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="任何面积占比超过此阈值的大块区域会被忽略，防止将整个扫描背景误当做照片。">[?]</span></span>
                            <span id="maxAreaValLabel-${fileId}" style="font-family:monospace; font-weight:bold; color:var(--accent-color);">80%</span>
                        </div>
                        <div class="ctrl-input-row" style="display:flex; gap:10px; align-items:center;">
                            <input type="range" id="maxAreaRange-${fileId}" min="5" max="100" step="0.5" value="80.0" style="flex:1; cursor:pointer;">
                            <input type="number" id="maxArea-${fileId}" min="0.1" max="100" step="0.5" value="80.0" style="width:50px; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; text-align:right; padding:2px;">
                        </div>
                    </div>

                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>外扩边缘 (px) <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="在真实矩形外围额外扩充的宽度。正数朝外防止切边，负数朝内收紧。">[?]</span></span>
                            <span id="paddingValLabel-${fileId}" style="font-family:monospace; font-weight:bold; color:var(--accent-color);">2 px</span>
                        </div>
                        <div class="ctrl-input-row" style="display:flex; gap:10px; align-items:center;">
                            <input type="range" id="padding-${fileId}" min="-50" max="50" value="2" style="flex:1; cursor:pointer;">
                            <input type="number" id="paddingNum-${fileId}" min="-50" max="50" value="2" style="width:45px; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; text-align:right; padding:2px;">
                        </div>
                    </div>

                    <div class="ctrl-group" style="margin-top:10px;">
                        <div class="ctrl-label-row">
                            <span>选框高级操作 (已选中: <span id="multiCount-${fileId}" style="color:var(--accent-color);font-weight:bold;">1</span> 个)</span>
                        </div>
                        <div class="tool-btn-grid full-width" style="margin-top:4px;">
                            <button id="autoOrientBtn-${fileId}" class="btn-mini" style="border-color:var(--accent-color); color:var(--accent-color); font-weight:bold;" title="基于人脸与图像特征智能判断朝向并摆正">自动纠正所有朝向</button>
                        </div>
                        <div class="tool-btn-grid" style="margin-top:4px;">
                            <button id="mergeCropsBtn-${fileId}" class="btn-mini" title="将当前选中的多个框合并为一个大框 (快捷键: M)">合并多框 (M)</button>
                            <button id="selectAllBtn-${fileId}" class="btn-mini" title="全选当前图片的所有裁剪框 (快捷键: Ctrl+A)">全选框 (Ctrl+A)</button>
                        </div>
                        <div class="tool-btn-grid" style="margin-top:4px;">
                            <button id="splitVCropBtn-${fileId}" class="btn-mini" title="将当前选中框从中间左右垂直二等分 (快捷键: V)">垂直拆分 (V)</button>
                            <button id="splitHCropBtn-${fileId}" class="btn-mini" title="将当前选中框从中间上下水平二等分 (快捷键: H)">水平拆分 (H)</button>
                        </div>
                        <div class="tool-btn-grid" style="margin-top:4px;">
                            <button id="delCropBtn-${fileId}" class="btn-mini" style="color:#ff3b30;" title="删除所有选中的裁剪框 (快捷键: Delete / Backspace)">删除选中框</button>
                            <button id="reDetectBtn-${fileId}" class="btn-mini" title="使用当前调优参数重新自动检测">重新自动检测</button>
                        </div>
                        <div style="font-size:10px; color:var(--text-muted); margin-top:6px; line-height:1.4;">
                            提示: 拖动已开启物理边缘磁吸（按住 Ctrl 自由拖动）；按住 Shift 可在空白处拉框多选或连续加选。
                        </div>
                    </div>
                </div>
            `;

                pageEl.addEventListener('click', () => selectFile(fileId, false));
                canvasContainer.appendChild(pageEl);

                const canvasEl = document.getElementById(`canvas-${fileId}`);

                filesMap[fileId] = {
                    name: data.filename,
                    width: data.width,
                    height: data.height,
                    thumbnail: data.thumbnail,
                    rects: [],
                    undoStack: [],
                    redoStack: [],
                    detected: false,
                    selectedCropIndex: 0,
                    selectedCropIndices: new Set([0]),
                    params: {
                        blur_kernel: 3,
                        threshold: 200,
                        threshold_mode: 'fixed',
                        morph_size: 0,
                        bg_type: 'light',
                        min_area_pct: 0.8,
                        max_area_pct: 80.0,
                        padding: 2,
                        auto_rotate: true
                    },
                    canvasEl: canvasEl,
                    containerEl: pageEl,
                    debugImgSrc: null,
                    _edgeCanvas: null,
                    _edgeCtx: null
                };

                bindLocalEvents(fileId);
                syncCanvasOrder();
                renderFileList();
                setupCanvasObserver();
                updateBatchSummary();

                await silentRequestPreview(fileId);
            } catch (err) {
                log(`上传接口通信异常: ${err}`);
            }
        }

        log(`所有上传处理完成。`);
        syncCanvasOrder();
        renderFileList();
        setupCanvasObserver();
        const sortedIds = getSortedFileIds();
        if (sortedIds.length > 0) {
            selectFile(sortedIds[0], true);
        }
    } finally {
        setImportUi(false);
        if (Object.keys(filesMap).length > 0) {
            fileMeta.innerText = currentFileId
                ? `当前文件: ${filesMap[currentFileId].name} (${filesMap[currentFileId].width} x ${filesMap[currentFileId].height})`
                : `已载入 ${Object.keys(filesMap).length} 个文件`;
        }
    }
}

function bindLocalEvents(fileId) {
    const fileData = filesMap[fileId];

    const threshModeSelect = document.getElementById(`threshMode-${fileId}`);
    const threshRange = document.getElementById(`threshold-${fileId}`);
    const threshNum = document.getElementById(`thresholdNum-${fileId}`);
    const threshLabel = document.getElementById(`threshValLabel-${fileId}`);
    const estimateBtn = document.getElementById(`estimateThreshBtn-${fileId}`);
    const morphRange = document.getElementById(`morphSizeRange-${fileId}`);
    const morphNum = document.getElementById(`morphSizeNum-${fileId}`);
    const morphLabel = document.getElementById(`morphValLabel-${fileId}`);
    const paddingRange = document.getElementById(`padding-${fileId}`);
    const paddingNum = document.getElementById(`paddingNum-${fileId}`);
    const paddingLabel = document.getElementById(`paddingValLabel-${fileId}`);
    const blurSelect = document.getElementById(`blurKernel-${fileId}`);
    const autoRotCheck = document.getElementById(`autoRotate-${fileId}`);
    const minAreaRange = document.getElementById(`minAreaRange-${fileId}`);
    const minAreaInput = document.getElementById(`minArea-${fileId}`);
    const minAreaLabel = document.getElementById(`minAreaValLabel-${fileId}`);
    const maxAreaRange = document.getElementById(`maxAreaRange-${fileId}`);
    const maxAreaInput = document.getElementById(`maxArea-${fileId}`);
    const maxAreaLabel = document.getElementById(`maxAreaValLabel-${fileId}`);
    const bgRadios = document.getElementsByName(`bgType-${fileId}`);

    const autoOrientBtn = document.getElementById(`autoOrientBtn-${fileId}`);
    const mergeCropsBtn = document.getElementById(`mergeCropsBtn-${fileId}`);
    const selectAllBtn = document.getElementById(`selectAllBtn-${fileId}`);
    const splitVCropBtn = document.getElementById(`splitVCropBtn-${fileId}`);
    const splitHCropBtn = document.getElementById(`splitHCropBtn-${fileId}`);
    const delCropBtn = document.getElementById(`delCropBtn-${fileId}`);
    const reDetectBtn = document.getElementById(`reDetectBtn-${fileId}`);

    let localFastTimer = null;
    const triggerFastPreview = (skipPreviews = true) => {
        clearTimeout(localFastTimer);
        localFastTimer = setTimeout(() => {
            requestPreview(fileId, skipPreviews);
        }, 16);
    };

    if (threshModeSelect) {
        threshModeSelect.addEventListener('change', (e) => {
            fileData.params.threshold_mode = e.target.value;
            log(`[${fileData.name}] 切换二值化模式: ${e.target.options[e.target.selectedIndex].text}`);
            requestPreview(fileId, false);
        });
    }

    if (estimateBtn) {
        estimateBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                estimateBtn.disabled = true;
                estimateBtn.innerText = '…';
                const res = await fetch('/api/estimate_threshold', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: sessionId,
                        file_id: fileId,
                        bg_type: fileData.params.bg_type
                    })
                });
                const data = await res.json();
                if (data.threshold !== undefined) {
                    fileData.params.threshold = data.threshold;
                    threshRange.value = data.threshold;
                    threshNum.value = data.threshold;
                    threshLabel.innerText = data.threshold;
                    log(`[${fileData.name}] 大津法估算最佳阈值: ${data.threshold}`);
                    requestPreview(fileId, false);
                }
            } catch (err) {
                log(`估算阈值异常: ${err}`);
            } finally {
                estimateBtn.disabled = false;
                estimateBtn.innerText = '估算';
            }
        });
    }

    if (morphRange) {
        morphRange.addEventListener('input', (e) => {
            const val = parseInt(e.target.value) || 0;
            morphNum.value = val;
            morphLabel.innerText = val + ' px';
            fileData.params.morph_size = val;
            triggerFastPreview(true);
        });
        morphRange.addEventListener('change', (e) => {
            fileData.params.morph_size = parseInt(e.target.value) || 0;
            requestPreview(fileId, false);
        });
        morphNum.addEventListener('input', (e) => {
            const val = Math.max(0, Math.min(15, parseInt(e.target.value) || 0));
            morphRange.value = val;
            morphLabel.innerText = val + ' px';
            fileData.params.morph_size = val;
            triggerFastPreview(true);
        });
        morphNum.addEventListener('change', (e) => {
            fileData.params.morph_size = Math.max(0, Math.min(15, parseInt(e.target.value) || 0));
            requestPreview(fileId, false);
        });
    }

    threshRange.addEventListener('input', (e) => {
        threshNum.value = e.target.value;
        threshLabel.innerText = e.target.value;
        fileData.params.threshold = parseInt(e.target.value);
        triggerFastPreview(true);
    });
    threshRange.addEventListener('change', (e) => {
        fileData.params.threshold = parseInt(e.target.value);
        requestPreview(fileId, false);
    });
    threshNum.addEventListener('input', (e) => {
        let val = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
        threshRange.value = val;
        threshLabel.innerText = val;
        fileData.params.threshold = val;
        triggerFastPreview(true);
    });
    threshNum.addEventListener('change', (e) => {
        let val = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
        threshRange.value = val;
        threshLabel.innerText = val;
        fileData.params.threshold = val;
        requestPreview(fileId, false);
    });

    paddingRange.addEventListener('input', (e) => {
        paddingNum.value = e.target.value;
        paddingLabel.innerText = e.target.value + ' px';
        fileData.params.padding = parseInt(e.target.value);
        triggerFastPreview(true);
    });
    paddingRange.addEventListener('change', (e) => {
        fileData.params.padding = parseInt(e.target.value);
        requestPreview(fileId, false);
    });
    paddingNum.addEventListener('input', (e) => {
        let val = Math.max(-50, Math.min(50, parseInt(e.target.value) || 0));
        paddingRange.value = val;
        paddingLabel.innerText = val + ' px';
        fileData.params.padding = val;
        triggerFastPreview(true);
    });
    paddingNum.addEventListener('change', (e) => {
        let val = Math.max(-50, Math.min(50, parseInt(e.target.value) || 0));
        paddingRange.value = val;
        paddingLabel.innerText = val + ' px';
        fileData.params.padding = val;
        requestPreview(fileId, false);
    });

    blurSelect.addEventListener('change', (e) => {
        fileData.params.blur_kernel = parseInt(e.target.value);
        requestPreview(fileId, false);
    });
    autoRotCheck.addEventListener('change', (e) => {
        fileData.params.auto_rotate = e.target.checked;
        drawCanvas(fileId);
        renderCropPreviews(fileId);
    });

    if (minAreaRange) {
        minAreaRange.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 0.05;
            minAreaInput.value = val;
            if (minAreaLabel) minAreaLabel.innerText = val.toFixed(2) + '%';
            fileData.params.min_area_pct = val;
            triggerFastPreview(true);
        });
        minAreaRange.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value) || 0.05;
            fileData.params.min_area_pct = val;
            requestPreview(fileId, false);
        });
    }
    minAreaInput.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) || 0.05;
        if (minAreaRange) minAreaRange.value = Math.min(20, val);
        if (minAreaLabel) minAreaLabel.innerText = val.toFixed(2) + '%';
        fileData.params.min_area_pct = val;
        triggerFastPreview(true);
    });
    minAreaInput.addEventListener('change', (e) => {
        const val = parseFloat(e.target.value) || 0.05;
        fileData.params.min_area_pct = val;
        requestPreview(fileId, false);
    });

    if (maxAreaRange) {
        maxAreaRange.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 100.0;
            maxAreaInput.value = val;
            if (maxAreaLabel) maxAreaLabel.innerText = val.toFixed(1) + '%';
            fileData.params.max_area_pct = val;
            triggerFastPreview(true);
        });
        maxAreaRange.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value) || 100.0;
            fileData.params.max_area_pct = val;
            requestPreview(fileId, false);
        });
    }
    maxAreaInput.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) || 100.0;
        if (maxAreaRange) maxAreaRange.value = val;
        if (maxAreaLabel) maxAreaLabel.innerText = val.toFixed(1) + '%';
        fileData.params.max_area_pct = val;
        triggerFastPreview(true);
    });
    maxAreaInput.addEventListener('change', (e) => {
        const val = parseFloat(e.target.value) || 100.0;
        fileData.params.max_area_pct = val;
        requestPreview(fileId, false);
    });

    bgRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            fileData.params.bg_type = e.target.value;
            requestPreview(fileId, false);
        });
    });

    if (autoOrientBtn) {
        autoOrientBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            autoOrientAllCrops(fileId);
        });
    }
    if (mergeCropsBtn) {
        mergeCropsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            mergeSelectedCrops(fileId);
        });
    }
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectAllCrops(fileId);
        });
    }
    if (splitVCropBtn) {
        splitVCropBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            splitSelectedCrop(fileId, 'v');
        });
    }
    if (splitHCropBtn) {
        splitHCropBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            splitSelectedCrop(fileId, 'h');
        });
    }
    if (delCropBtn) {
        delCropBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSelectedCrop(fileId);
        });
    }
    if (reDetectBtn) {
        reDetectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            requestPreview(fileId);
        });
    }

    const canvasEl = fileData.canvasEl;
    canvasEl.addEventListener('mousedown', (e) => handleCanvasMouseDown(fileId, e));
    canvasEl.addEventListener('mousemove', (e) => handleCanvasMouseMove(fileId, e));
    canvasEl.addEventListener('mouseleave', (e) => handleCanvasMouseLeave(fileId, e));
}

function syncCanvasOrder() {
    const sortedIds = getSortedFileIds();
    sortedIds.forEach(id => {
        const fileData = filesMap[id];
        if (fileData && fileData.containerEl && fileData.containerEl.parentElement === canvasContainer) {
            canvasContainer.appendChild(fileData.containerEl);
        }
    });
}

let canvasObserver = null;
function setupCanvasObserver() {
    if (canvasObserver) {
        canvasObserver.disconnect();
    }
    if (typeof IntersectionObserver === 'undefined') return;

    canvasObserver = new IntersectionObserver((entries) => {
        if (isProgrammaticScrolling) return;
        let bestEntry = null;
        for (const entry of entries) {
            if (entry.isIntersecting) {
                if (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio) {
                    bestEntry = entry;
                }
            }
        }
        if (bestEntry && bestEntry.target && bestEntry.target.id) {
            const fileId = bestEntry.target.id.replace('page-', '');
            if (fileId && fileId !== currentFileId && filesMap[fileId]) {
                selectFile(fileId, false);
            }
        }
    }, {
        threshold: [0.15, 0.4, 0.7]
    });

    getSortedFileIds().forEach(id => {
        if (filesMap[id] && filesMap[id].containerEl) {
            canvasObserver.observe(filesMap[id].containerEl);
        }
    });
}

function renderFileList() {
    fileListContainer.innerHTML = '';

    const sortedIds = getSortedFileIds();
    const sortedItems = sortedIds.map(id => ({
        id,
        name: filesMap[id].name,
        rectsCount: (filesMap[id].rects || []).filter(r => !r.excluded).length
    }));

    sortedItems.forEach(item => {
        const el = document.createElement('div');
        el.className = 'file-item';
        if (item.id === currentFileId) {
            el.classList.add('active');
        }
        el.id = `file-${item.id}`;
        el.innerHTML = `
            <span class="file-name" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">${item.name}</span>
            <span class="badge" id="badge-${item.id}">${item.rectsCount}</span>
        `;
        el.addEventListener('click', () => selectFile(item.id, true));
        fileListContainer.appendChild(el);
    });
}

function naturalCompare(a, b) {
    const ax = [], bx = [];
    a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
        ax.push($1 ? parseInt($1, 10) : $2);
    });
    b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
        bx.push($1 ? parseInt($1, 10) : $2);
    });
    while (ax.length && bx.length) {
        const an = ax.shift();
        const bn = bx.shift();
        if (an !== bn) {
            const typeA = typeof an;
            const typeB = typeof bn;
            if (typeA === 'number' && typeB === 'number') {
                return an - bn;
            }
            return an.toString().localeCompare(bn.toString(), 'zh-CN');
        }
    }
    return ax.length - bx.length;
}

function selectFile(fileId, autoScroll = true) {
    if (!filesMap[fileId]) return;
    currentFileId = fileId;
    const fileData = filesMap[fileId];

    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById(`file-${fileId}`);
    if (activeEl) {
        activeEl.classList.add('active');
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    document.querySelectorAll('.canvas-page').forEach(el => el.classList.remove('active'));
    const activePage = fileData.containerEl;
    if (activePage) activePage.classList.add('active');

    fileMeta.innerText = `当前文件: ${fileData.name} (${fileData.width} x ${fileData.height})`;

    if (autoScroll && activePage) {
        isProgrammaticScrolling = true;
        activePage.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => {
            isProgrammaticScrolling = false;
        }, 500);
    }

    if (!fileData.detected) {
        requestPreview(fileId);
    } else if (currentDebugMode !== 'original') {
        requestPreview(fileId);
    } else {
        drawCanvas(fileId);
        renderCropPreviews(fileId);
    }
}

function mergeRectsPreserveFlip(oldRects, newRects) {
    return (newRects || []).map((rect, idx) => {
        const prev = oldRects && oldRects[idx];
        let orient = 0;
        let excluded = false;
        if (prev) {
            if (typeof prev.orient === 'number') orient = ((prev.orient % 360) + 360) % 360;
            else if (prev.flip180) orient = 180;
            if (prev.excluded !== undefined) excluded = !!prev.excluded;
        }
        return { ...rect, orient, excluded };
    });
}

function requestPreview(fileId, skipCropPreviews = false) {
    const targetId = fileId || currentFileId;
    if (!sessionId || !targetId) return;

    const fileData = filesMap[targetId];
    if (!fileData) return;

    if (fileData._previewAbort) {
        fileData._previewAbort.abort();
    }
    const abortCtrl = new AbortController();
    fileData._previewAbort = abortCtrl;
    const reqSeq = (++fileData._previewSeq || (fileData._previewSeq = 1));

    const params = {
        session_id: sessionId,
        file_id: targetId,
        ...fileData.params,
        debug_mode: currentDebugMode
    };

    fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: abortCtrl.signal
    })
    .then(res => res.json())
    .then(data => {
        if (reqSeq !== fileData._previewSeq) return;

        if (data.error) {
            log(`图像调试出错: ${data.error}`);
            return;
        }
        fileData.rects = mergeRectsPreserveFlip(fileData.rects, data.rects);
        fileData.debugImgSrc = data.debug_image;
        fileData.detected = true;

        if (!fileData.selectedCropIndices) {
            fileData.selectedCropIndices = new Set();
        }
        if (fileData.rects.length > 0 && fileData.selectedCropIndices.size === 0) {
            fileData.selectedCropIndices.add(0);
            fileData.selectedCropIndex = 0;
        }

        const validCount = (fileData.rects || []).filter(r => !r.excluded).length;
        const totalCount = (fileData.rects || []).length;
        const badge = document.getElementById(`badge-${targetId}`);
        if (badge) badge.innerText = validCount;

        const headerCount = document.getElementById(`page-count-${targetId}`);
        if (headerCount) {
            headerCount.innerText = `已提取: ${validCount} 张${totalCount > validCount ? ` (含 ${totalCount - validCount} 个排除区)` : ''}`;
        }

        updateBatchSummary();
        drawCanvas(targetId);

        if (!skipCropPreviews) {
            renderCropPreviews(targetId);
        }
    })
    .catch(err => {
        if (err.name === 'AbortError') return;
        log(`获取图像数据失败: ${err}`);
    });
}

function silentRequestPreview(fileId) {
    if (!sessionId || !filesMap[fileId]) return Promise.resolve();
    const fileData = filesMap[fileId];
    const params = {
        session_id: sessionId,
        file_id: fileId,
        ...fileData.params,
        debug_mode: 'original'
    };

    return fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    })
    .then(res => res.json())
    .then(data => {
        if (!data.error) {
            fileData.rects = mergeRectsPreserveFlip(fileData.rects, data.rects);
            fileData.debugImgSrc = null;
            fileData.detected = true;
            fileData.selectedCropIndices = new Set(data.rects.length > 0 ? [0] : []);
            fileData.selectedCropIndex = data.rects.length > 0 ? 0 : -1;

            const badge = document.getElementById(`badge-${fileId}`);
            if (badge) badge.innerText = data.rects.length;

            const headerCount = document.getElementById(`page-count-${fileId}`);
            if (headerCount) headerCount.innerText = `已提取: ${data.rects.length} 张`;

            updateBatchSummary();
            drawCanvas(fileId);
            renderCropPreviews(fileId);
            log(`[${fileData.name}] 检出有效子图数: ${data.rects.length}`);
        }
    });
}

function buildCropPreviewDataUrl(sourceImg, rect, autoRotate, bgType) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const bg = bgType === 'dark' ? '#000000' : '#ffffff';

    if (autoRotate && rect.rotated) {
        let cx = rect.rotated.cx;
        let cy = rect.rotated.cy;
        let rw = rect.rotated.w;
        let rh = rect.rotated.h;
        let angle = rect.rotated.angle;
        if (rw < rh) {
            angle += 90;
            const tmp = rw;
            rw = rh;
            rh = tmp;
        }
        const outW = Math.max(1, Math.round(rw));
        const outH = Math.max(1, Math.round(rh));
        canvas.width = outW;
        canvas.height = outH;
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, outW, outH);
        ctx.translate(outW / 2, outH / 2);
        ctx.rotate((-angle * Math.PI) / 180);
        ctx.drawImage(sourceImg, -cx, -cy);
    } else {
        const w = Math.max(1, Math.round(rect.w));
        const h = Math.max(1, Math.round(rect.h));
        canvas.width = w;
        canvas.height = h;
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(sourceImg, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    }

    return applyOrientToCanvas(canvas, getRectOrient(rect));
}

function getRectOrient(rect) {
    if (typeof rect.orient === 'number') return ((rect.orient % 360) + 360) % 360;
    if (rect.flip180) return 180;
    return 0;
}

function applyOrientToCanvas(sourceCanvas, orient) {
    const deg = ((orient % 360) + 360) % 360;
    if (!deg) return sourceCanvas.toDataURL('image/jpeg', 0.85);

    const out = document.createElement('canvas');
    if (deg === 90 || deg === 270) {
        out.width = sourceCanvas.height;
        out.height = sourceCanvas.width;
    } else {
        out.width = sourceCanvas.width;
        out.height = sourceCanvas.height;
    }
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
    return out.toDataURL('image/jpeg', 0.85);
}

function formatOrientLabel(orient) {
    const deg = ((orient % 360) + 360) % 360;
    return deg ? `${deg}°` : '';
}

function renderCropPreviews(fileId) {
    const fileData = filesMap[fileId];
    const strip = document.getElementById(`crop-previews-${fileId}`);
    if (!fileData || !strip) return;

    const rects = fileData.rects || [];
    if (rects.length === 0) {
        strip.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">暂无检出子图</div>';
        return;
    }

    const multiCountEl = document.getElementById(`multiCount-${fileId}`);
    if (multiCountEl) {
        multiCountEl.innerText = (fileData.selectedCropIndices ? fileData.selectedCropIndices.size : 0);
    }

    const img = new Image();
    img.onload = () => {
        strip.innerHTML = '';
        const autoRotate = !!fileData.params.auto_rotate;
        const selIndices = fileData.selectedCropIndices || new Set();

        rects.forEach((rect, index) => {
            const isSelected = selIndices.has(index);
            const isExcluded = !!rect.excluded;
            const orient = getRectOrient(rect);
            const orientLabel = formatOrientLabel(orient);
            const item = document.createElement('div');
            item.className = 'crop-preview-item' + (isSelected ? ' selected' : '') + (isExcluded ? ' excluded' : '');
            const src = buildCropPreviewDataUrl(img, rect, autoRotate, fileData.params.bg_type);
            const badgeHtml = isExcluded
                ? `<span class="flip-badge" style="background:#ff3b30;color:#fff;">排除</span>`
                : (orientLabel ? `<span class="flip-badge">${orientLabel}</span>` : '');
            item.innerHTML = `
                ${badgeHtml}
                <img alt="crop ${index + 1}" src="${src}">
                <span class="crop-label" style="${isExcluded ? 'color:#ff3b30;font-weight:bold;' : ''}">${isExcluded ? '[已排除] ' : ''}#${index + 1}${orientLabel ? ` · ${orientLabel}` : ''}</span>
            `;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                selectCrop(fileId, index, e.shiftKey || e.ctrlKey || e.metaKey);
            });
            strip.appendChild(item);
        });
    };
    img.src = fileData.thumbnail;
}

function selectCrop(fileId, index, isMulti = false) {
    const fileData = filesMap[fileId];
    if (!fileData || !fileData.rects[index]) return;
    selectFile(fileId, false);

    if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();

    if (isMulti) {
        if (fileData.selectedCropIndices.has(index)) {
            fileData.selectedCropIndices.delete(index);
        } else {
            fileData.selectedCropIndices.add(index);
        }
        fileData.selectedCropIndex = index;
    } else {
        fileData.selectedCropIndices.clear();
        fileData.selectedCropIndices.add(index);
        fileData.selectedCropIndex = index;
    }

    const multiCountEl = document.getElementById(`multiCount-${fileId}`);
    if (multiCountEl) multiCountEl.innerText = fileData.selectedCropIndices.size;

    drawCanvas(fileId);
    renderCropPreviews(fileId);
}

const MAX_UNDO_STACK = 40;

function createSnapshot(fileId) {
    const fileData = filesMap[fileId];
    if (!fileData) return null;
    return {
        rects: JSON.parse(JSON.stringify(fileData.rects || [])),
        selectedCropIndex: fileData.selectedCropIndex,
        selectedCropIndices: Array.from(fileData.selectedCropIndices || [])
    };
}

function pushUndoState(fileId, snapshot) {
    const fileData = filesMap[fileId];
    if (!fileData) return;
    if (!fileData.undoStack) fileData.undoStack = [];
    const snap = snapshot || createSnapshot(fileId);
    if (!snap) return;

    fileData.undoStack.push(snap);
    if (fileData.undoStack.length > MAX_UNDO_STACK) {
        fileData.undoStack.shift();
    }
    fileData.redoStack = [];
}

function undo(fileId) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    if (!fileData.undoStack || fileData.undoStack.length === 0) {
        log(`[${fileData.name}] 无可撤销操作`);
        return;
    }

    const currentSnap = createSnapshot(targetId);
    if (!fileData.redoStack) fileData.redoStack = [];
    fileData.redoStack.push(currentSnap);

    const prevState = fileData.undoStack.pop();
    fileData.rects = JSON.parse(JSON.stringify(prevState.rects));
    fileData.selectedCropIndex = prevState.selectedCropIndex;
    fileData.selectedCropIndices = new Set(prevState.selectedCropIndices || [prevState.selectedCropIndex]);

    updateFileUiAfterRectsChange(targetId);
    log(`[${fileData.name}] 撤销操作 (Ctrl+Z)`);
}

function redo(fileId) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    if (!fileData.redoStack || fileData.redoStack.length === 0) {
        log(`[${fileData.name}] 无可重做操作`);
        return;
    }

    const currentSnap = createSnapshot(targetId);
    if (!fileData.undoStack) fileData.undoStack = [];
    fileData.undoStack.push(currentSnap);

    const nextState = fileData.redoStack.pop();
    fileData.rects = JSON.parse(JSON.stringify(nextState.rects));
    fileData.selectedCropIndex = nextState.selectedCropIndex;
    fileData.selectedCropIndices = new Set(nextState.selectedCropIndices || [nextState.selectedCropIndex]);

    updateFileUiAfterRectsChange(targetId);
    log(`[${fileData.name}] 重做操作 (Ctrl+Y)`);
}

function updateFileUiAfterRectsChange(fileId) {
    const fileData = filesMap[fileId];
    if (!fileData) return;

    const validCount = (fileData.rects || []).filter(r => !r.excluded).length;
    const totalCount = (fileData.rects || []).length;
    const badge = document.getElementById(`badge-${fileId}`);
    if (badge) badge.innerText = validCount;
    const headerCount = document.getElementById(`page-count-${fileId}`);
    if (headerCount) {
        headerCount.innerText = `已提取: ${validCount} 张${totalCount > validCount ? ` (含 ${totalCount - validCount} 个排除区)` : ''}`;
    }

    const multiCountEl = document.getElementById(`multiCount-${fileId}`);
    if (multiCountEl) {
        multiCountEl.innerText = fileData.selectedCropIndices ? fileData.selectedCropIndices.size : 0;
    }

    updateBatchSummary();
    drawCanvas(fileId);
    renderCropPreviews(fileId);
}

// 批量旋转选中框
function rotateSelectedCrop(deltaDeg) {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    pushUndoState(currentFileId);

    const selIndices = (fileData.selectedCropIndices && fileData.selectedCropIndices.size > 0)
        ? Array.from(fileData.selectedCropIndices)
        : [fileData.selectedCropIndex >= 0 ? fileData.selectedCropIndex : 0];

    selIndices.forEach(idx => {
        if (rects[idx]) {
            const cur = getRectOrient(rects[idx]);
            rects[idx].orient = (cur + deltaDeg + 360) % 360;
            delete rects[idx].flip180;
        }
    });

    drawCanvas(currentFileId);
    renderCropPreviews(currentFileId);
    log(`[${fileData.name}] 已旋转选中的 ${selIndices.length} 个裁剪框 (${deltaDeg > 0 ? '+' : ''}${deltaDeg}°)。`);
}

// 批量删除选中的框
function deleteSelectedCrop(fileId) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    const selIndices = fileData.selectedCropIndices && fileData.selectedCropIndices.size > 0
        ? Array.from(fileData.selectedCropIndices)
        : [fileData.selectedCropIndex];

    const validIndices = selIndices.filter(i => i >= 0 && i < rects.length).sort((a, b) => b - a);
    if (validIndices.length === 0) return;

    pushUndoState(targetId);

    validIndices.forEach(idx => {
        rects.splice(idx, 1);
    });

    fileData.selectedCropIndices.clear();
    if (rects.length > 0) {
        fileData.selectedCropIndex = Math.min(validIndices[validIndices.length - 1], rects.length - 1);
        fileData.selectedCropIndices.add(fileData.selectedCropIndex);
    } else {
        fileData.selectedCropIndex = -1;
    }

    updateFileUiAfterRectsChange(targetId);
    log(`[${fileData.name}] 已批量删除 ${validIndices.length} 个裁剪框，当前剩余 ${rects.length} 张。`);
}

// 全选当前图片的所有框
function selectAllCrops(fileId) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    const rects = fileData.rects || [];

    if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();
    fileData.selectedCropIndices.clear();

    rects.forEach((_, idx) => fileData.selectedCropIndices.add(idx));
    fileData.selectedCropIndex = rects.length > 0 ? 0 : -1;

    updateFileUiAfterRectsChange(targetId);
    log(`[${fileData.name}] 已全选当前图片的所有 ${rects.length} 个选框。`);
}

// 合并当前选中的多个框为一个整体外接框
function mergeSelectedCrops(fileId) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    const rects = fileData.rects || [];

    const selIndices = Array.from(fileData.selectedCropIndices || []).sort((a, b) => a - b);
    if (selIndices.length < 2) {
        log(`[${fileData.name}] 请按住 Shift 选择至少 2 个框后再执行合并。`);
        return;
    }

    pushUndoState(targetId);

    const targetRects = selIndices.map(i => rects[i]);
    let allPoints = [];
    targetRects.forEach(r => {
        const hInfo = getTransformHandles(r);
        allPoints.push(...hInfo.corners);
    });

    const xs = allPoints.map(p => p[0]);
    const ys = allPoints.map(p => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = maxX - minX;
    const h = maxY - minY;

    const mergedRect = {
        x: Math.round(minX),
        y: Math.round(minY),
        w: Math.round(w),
        h: Math.round(h),
        orient: 0,
        excluded: false,
        rotated: {
            cx: Math.round(cx),
            cy: Math.round(cy),
            w: Math.round(w),
            h: Math.round(h),
            angle: 0,
            points: computeBoxPoints(cx, cy, w, h, 0)
        }
    };

    // 移除原有被合并的框（从大索引到小索引删除）
    for (let i = selIndices.length - 1; i >= 0; i--) {
        rects.splice(selIndices[i], 1);
    }

    rects.push(mergedRect);
    fileData.selectedCropIndices.clear();
    fileData.selectedCropIndex = rects.length - 1;
    fileData.selectedCropIndices.add(fileData.selectedCropIndex);

    updateFileUiAfterRectsChange(targetId);
    log(`[${fileData.name}] 成功将 ${selIndices.length} 个框合并为一个新裁剪框。`);
}

// 拆分当前选中的框 (垂直/水平)
function splitSelectedCrop(fileId, direction) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    const rects = fileData.rects || [];

    const idx = fileData.selectedCropIndex;
    if (idx < 0 || idx >= rects.length) return;

    pushUndoState(targetId);

    const targetRect = rects[idx];
    const hInfo = getTransformHandles(targetRect);

    let r1, r2;
    if (direction === 'h') {
        const halfH = hInfo.h / 2;
        const dy = halfH / 2;
        const rad = (hInfo.angle * Math.PI) / 180;
        const dx = Math.sin(rad) * dy;
        const dy_rot = -Math.cos(rad) * dy;

        const c1 = { cx: hInfo.cx - dx, cy: hInfo.cy - dy_rot, w: hInfo.w, h: halfH, angle: hInfo.angle };
        const c2 = { cx: hInfo.cx + dx, cy: hInfo.cy + dy_rot, w: hInfo.w, h: halfH, angle: hInfo.angle };

        r1 = { ...targetRect, rotated: { ...c1, points: computeBoxPoints(c1.cx, c1.cy, c1.w, c1.h, c1.angle) } };
        r2 = { ...targetRect, rotated: { ...c2, points: computeBoxPoints(c2.cx, c2.cy, c2.w, c2.h, c2.angle) } };
    } else {
        const halfW = hInfo.w / 2;
        const dx = halfW / 2;
        const rad = (hInfo.angle * Math.PI) / 180;
        const dx_rot = Math.cos(rad) * dx;
        const dy_rot = Math.sin(rad) * dx;

        const c1 = { cx: hInfo.cx - dx_rot, cy: hInfo.cy - dy_rot, w: halfW, h: hInfo.h, angle: hInfo.angle };
        const c2 = { cx: hInfo.cx + dx_rot, cy: hInfo.cy + dy_rot, w: halfW, h: hInfo.h, angle: hInfo.angle };

        r1 = { ...targetRect, rotated: { ...c1, points: computeBoxPoints(c1.cx, c1.cy, c1.w, c1.h, c1.angle) } };
        r2 = { ...targetRect, rotated: { ...c2, points: computeBoxPoints(c2.cx, c2.cy, c2.w, c2.h, c2.angle) } };
    }

    updateRectBoundingBox(r1);
    updateRectBoundingBox(r2);

    rects.splice(idx, 1, r1, r2);
    fileData.selectedCropIndices.clear();
    fileData.selectedCropIndex = idx;
    fileData.selectedCropIndices.add(idx);
    fileData.selectedCropIndices.add(idx + 1);

    updateFileUiAfterRectsChange(targetId);
    log(`[${fileData.name}] 已将 #${idx + 1} 框${direction === 'v' ? '垂直左右' : '水平上下'}二等分拆分。`);
}

function updateRectBoundingBox(rect) {
    if (!rect.rotated || !rect.rotated.points) return;
    const xs = rect.rotated.points.map(p => p[0]);
    const ys = rect.rotated.points.map(p => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    rect.x = Math.max(0, Math.round(minX));
    rect.y = Math.max(0, Math.round(minY));
    rect.w = Math.round(maxX - minX);
    rect.h = Math.round(maxY - minY);
}

// 智能预判所有朝向并自动修正
async function autoOrientAllCrops(fileId) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    const orientBtn = document.getElementById(`autoOrientBtn-${targetId}`);
    if (orientBtn) {
        orientBtn.disabled = true;
        orientBtn.innerText = '正在智能分析朝向…';
    }

    try {
        pushUndoState(targetId);
        const res = await fetch('/api/auto_orient', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                file_id: targetId,
                rects: fileData.rects,
                bg_type: fileData.params.bg_type,
                auto_rotate: fileData.params.auto_rotate
            })
        });

        const data = await res.json();
        if (data.rects) {
            fileData.rects = data.rects;
            updateFileUiAfterRectsChange(targetId);
            log(`[${fileData.name}] ${data.message || '朝向智能预判校正完成。'}`);
        }
    } catch (err) {
        log(`智能朝向预判异常: ${err}`);
    } finally {
        if (orientBtn) {
            orientBtn.disabled = false;
            orientBtn.innerText = '自动纠正所有朝向';
        }
    }
}

// 自由变换与手动操作状态管理器
let transformState = {
    fileId: null,
    mode: 'none', // 'none' | 'moving' | 'resizing' | 'rotating' | 'drawing_new' | 'marquee_select'
    handleIndex: -1,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    rectIndex: -1,
    initialHandles: null,
    initialMultiRects: null, // 多选时记录每个框的初始中心和角度
    pendingSnapshot: null,
    hasModified: false
};

function computeBoxPoints(cx, cy, w, h, angle) {
    const rad = (angle * Math.PI) / 180.0;
    const b = Math.cos(rad) * 0.5;
    const a = Math.sin(rad) * 0.5;
    const p0 = [cx - a * h - b * w, cy + b * h - a * w];
    const p1 = [cx + a * h - b * w, cy - b * h - a * w];
    const p2 = [2 * cx - p0[0], 2 * cy - p0[1]];
    const p3 = [2 * cx - p1[0], 2 * cy - p1[1]];
    return [
        [Math.round(p0[0]), Math.round(p0[1])],
        [Math.round(p1[0]), Math.round(p1[1])],
        [Math.round(p2[0]), Math.round(p2[1])],
        [Math.round(p3[0]), Math.round(p3[1])]
    ];
}

function getTransformHandles(rect) {
    let rot = rect.rotated;
    if (!rot || !rot.points) {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const w = rect.w;
        const h = rect.h;
        const angle = 0;
        rot = { cx, cy, w, h, angle, points: computeBoxPoints(cx, cy, w, h, angle) };
        rect.rotated = rot;
    }
    const cx = rot.cx;
    const cy = rot.cy;
    const w = Math.max(10, rot.w);
    const h = Math.max(10, rot.h);
    const angle = rot.angle || 0;
    const [p0, p1, p2, p3] = rot.points;

    const m01 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const m12 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    const m23 = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
    const m30 = [(p3[0] + p0[0]) / 2, (p3[1] + p0[1]) / 2];

    const lenW = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) || w;
    const lenH = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || h;

    return {
        cx, cy, w, h, angle,
        corners: [p0, p1, p2, p3],
        handles: [p0, p1, p2, p3, m01, m12, m23, m30],
        u_w: [(p3[0] - p0[0]) / lenW, (p3[1] - p0[1]) / lenW],
        u_h: [(p1[0] - p0[0]) / lenH, (p1[1] - p0[1]) / lenH]
    };
}

function updateRectFromParams(rect, cx, cy, w, h, angle) {
    w = Math.max(15, Math.round(w));
    h = Math.max(15, Math.round(h));
    cx = Math.round(cx);
    cy = Math.round(cy);
    angle = Math.round(angle * 10) / 10;
    const points = computeBoxPoints(cx, cy, w, h, angle);
    rect.rotated = { cx, cy, w, h, angle, points };

    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    rect.x = Math.max(0, Math.round(minX));
    rect.y = Math.max(0, Math.round(minY));
    rect.w = Math.round(maxX - minX);
    rect.h = Math.round(maxY - minY);
}

function getCanvasCoords(canvas, e) {
    const r = canvas.getBoundingClientRect();
    const scaleX = canvas.width / r.width;
    const scaleY = canvas.height / r.height;
    return {
        x: (e.clientX - r.left) * scaleX,
        y: (e.clientY - r.top) * scaleY
    };
}

// 边缘智能磁吸算法：在当前坐标 10px 范围内搜寻最大梯度物理边缘（按住 Ctrl 临时禁用）
function getEdgeSnap(fileId, x, y, isCtrlPressed) {
    if (isCtrlPressed) {
        return { x, y, snapped: false };
    }

    const fileData = filesMap[fileId];
    if (!fileData || !fileData._cachedImg) {
        return { x, y, snapped: false };
    }

    if (!fileData._edgeCanvas) {
        fileData._edgeCanvas = document.createElement('canvas');
        fileData._edgeCanvas.width = fileData._cachedImg.width;
        fileData._edgeCanvas.height = fileData._cachedImg.height;
        fileData._edgeCtx = fileData._edgeCanvas.getContext('2d', { willReadFrequently: true });
        fileData._edgeCtx.drawImage(fileData._cachedImg, 0, 0);
    }

    const ctx = fileData._edgeCtx;
    const searchR = 9;
    const sx = Math.max(1, Math.min(fileData._cachedImg.width - searchR * 2 - 2, Math.round(x - searchR)));
    const sy = Math.max(1, Math.min(fileData._cachedImg.height - searchR * 2 - 2, Math.round(y - searchR)));
    const sw = searchR * 2 + 1;
    const sh = searchR * 2 + 1;

    try {
        const imgData = ctx.getImageData(sx, sy, sw, sh);
        const data = imgData.data;

        let maxGradX = 0;
        let bestOffsetGx = 0;
        let maxGradY = 0;
        let bestOffsetGy = 0;

        const centerY = searchR;
        const centerX = searchR;

        // 水平梯度搜索
        for (let i = 1; i < sw - 1; i++) {
            const idxLeft = (centerY * sw + (i - 1)) * 4;
            const idxRight = (centerY * sw + (i + 1)) * 4;
            const grayL = data[idxLeft] * 0.299 + data[idxLeft + 1] * 0.587 + data[idxLeft + 2] * 0.114;
            const grayR = data[idxRight] * 0.299 + data[idxRight + 1] * 0.587 + data[idxRight + 2] * 0.114;
            const grad = Math.abs(grayR - grayL);
            if (grad > maxGradX) {
                maxGradX = grad;
                bestOffsetGx = i - centerX;
            }
        }

        // 垂直梯度搜索
        for (let j = 1; j < sh - 1; j++) {
            const idxTop = ((j - 1) * sw + centerX) * 4;
            const idxBot = ((j + 1) * sw + centerX) * 4;
            const grayT = data[idxTop] * 0.299 + data[idxTop + 1] * 0.587 + data[idxTop + 2] * 0.114;
            const grayB = data[idxBot] * 0.299 + data[idxBot + 1] * 0.587 + data[idxBot + 2] * 0.114;
            const grad = Math.abs(grayB - grayT);
            if (grad > maxGradY) {
                maxGradY = grad;
                bestOffsetGy = j - centerY;
            }
        }

        let snappedX = x;
        let snappedY = y;
        let isSnapped = false;

        if (maxGradX > 30 && Math.abs(bestOffsetGx) <= 8) {
            snappedX = x + bestOffsetGx;
            isSnapped = true;
        }
        if (maxGradY > 30 && Math.abs(bestOffsetGy) <= 8) {
            snappedY = y + bestOffsetGy;
            isSnapped = true;
        }

        return { x: snappedX, y: snappedY, snapped: isSnapped };
    } catch (_) {
        return { x, y, snapped: false };
    }
}

const ROTATE_CURSORS = {};
[0, 45, 90, 135, 180, 225, 270, 315].forEach(ang => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'><g transform='rotate(${ang} 10 10)'><path d='M 14.4 4.8 A 6.8 6.8 0 0 1 14.4 15.2' fill='none' stroke='%23ffffff' stroke-width='3.2' stroke-linecap='round'/><polygon points='11.5,2.4 15.8,3.1 13.0,6.5' fill='%23ffffff' stroke='%23ffffff' stroke-width='1.5' stroke-linejoin='round'/><polygon points='11.5,17.6 15.8,16.9 13.0,13.5' fill='%23ffffff' stroke='%23ffffff' stroke-width='1.5' stroke-linejoin='round'/><path d='M 14.4 4.8 A 6.8 6.8 0 0 1 14.4 15.2' fill='none' stroke='%23000000' stroke-width='1.4' stroke-linecap='round'/><polygon points='11.5,2.4 15.8,3.1 13.0,6.5' fill='%23000000'/><polygon points='11.5,17.6 15.8,16.9 13.0,13.5' fill='%23000000'/></g></svg>`;
    ROTATE_CURSORS[ang] = `url("data:image/svg+xml;utf8,${svg}") 10 10, crosshair`;
});

function getRotateCursor(cx, cy, x, y) {
    if (cx === undefined || cy === undefined || x === undefined || y === undefined) {
        return ROTATE_CURSORS[315] || ROTATE_CURSORS[0];
    }
    let deg = Math.round(Math.atan2(y - cy, x - cx) * 180 / Math.PI);
    deg = ((deg % 360) + 360) % 360;
    const snap = Math.round(deg / 45) * 45 % 360;
    return ROTATE_CURSORS[snap] || ROTATE_CURSORS[0];
}

function hitTest(fileId, mx, my) {
    const fileData = filesMap[fileId];
    if (!fileData) return { type: 'empty' };
    const rects = fileData.rects || [];
    const canvas = fileData.canvasEl;
    if (!canvas) return { type: 'empty' };

    const cssRect = canvas.getBoundingClientRect();
    const scale = canvas.width / (cssRect.width || canvas.width);
    const handleRadius = Math.max(10, Math.min(26, 12 * scale));
    const rotateMargin = 32 * scale;

    const selIdx = fileData.selectedCropIndex;
    if (selIdx >= 0 && selIdx < rects.length) {
        const selRect = rects[selIdx];
        const hInfo = getTransformHandles(selRect);

        // 1. 优先检查主选框的 8 个控制手柄
        for (let i = 0; i < 8; i++) {
            const hp = hInfo.handles[i];
            const dist = Math.hypot(mx - hp[0], my - hp[1]);
            if (dist <= handleRadius) {
                return { type: 'handle', index: i, info: hInfo, rectIndex: selIdx };
            }
        }

        const dx = mx - hInfo.cx;
        const dy = my - hInfo.cy;
        const lx = dx * hInfo.u_w[0] + dy * hInfo.u_w[1];
        const ly = dx * hInfo.u_h[0] + dy * hInfo.u_h[1];
        const halfW = hInfo.w / 2;
        const halfH = hInfo.h / 2;

        const isInside = Math.abs(lx) <= halfW && Math.abs(ly) <= halfH;
        if (isInside) {
            return { type: 'inside', info: hInfo, rectIndex: selIdx };
        }

        const distOutsideX = Math.max(0, Math.abs(lx) - halfW);
        const distOutsideY = Math.max(0, Math.abs(ly) - halfH);
        const distToBox = Math.hypot(distOutsideX, distOutsideY);

        if (distToBox <= rotateMargin) {
            return { type: 'rotate', info: hInfo, rectIndex: selIdx, cx: hInfo.cx, cy: hInfo.cy };
        }
    }

    // 2. 检查是否点击了其它矩形（逆序优先选上层）
    for (let idx = rects.length - 1; idx >= 0; idx--) {
        if (idx === selIdx) continue;
        const rInfo = getTransformHandles(rects[idx]);
        const dx = mx - rInfo.cx;
        const dy = my - rInfo.cy;
        const lx = dx * rInfo.u_w[0] + dy * rInfo.u_w[1];
        const ly = dx * rInfo.u_h[0] + dy * rInfo.u_h[1];
        if (Math.abs(lx) <= rInfo.w / 2 && Math.abs(ly) <= rInfo.h / 2) {
            return { type: 'other_rect', rectIndex: idx };
        }
    }

    return { type: 'empty' };
}

function getHandleCursor(info, handleIndex) {
    if (!info) return 'default';
    let rad = 0;
    if (handleIndex === 0 || handleIndex === 2) {
        rad = Math.atan2(info.corners[2][1] - info.corners[0][1], info.corners[2][0] - info.corners[0][0]);
    } else if (handleIndex === 1 || handleIndex === 3) {
        rad = Math.atan2(info.corners[3][1] - info.corners[1][1], info.corners[3][0] - info.corners[1][0]);
    } else if (handleIndex === 4 || handleIndex === 6) {
        rad = Math.atan2(info.u_w[1], info.u_w[0]);
    } else if (handleIndex === 5 || handleIndex === 7) {
        rad = Math.atan2(info.u_h[1], info.u_h[0]);
    }

    let deg = (rad * 180 / Math.PI) % 180;
    if (deg < 0) deg += 180;

    if (deg >= 22.5 && deg < 67.5) return 'nwse-resize';
    if (deg >= 67.5 && deg < 112.5) return 'ns-resize';
    if (deg >= 112.5 && deg < 157.5) return 'nesw-resize';
    return 'ew-resize';
}

function handleCanvasMouseDown(fileId, e) {
    if (e.button !== 0) return;
    selectFile(fileId, false);

    const fileData = filesMap[fileId];
    if (!fileData) return;
    const canvas = fileData.canvasEl;
    const { x, y } = getCanvasCoords(canvas, e);
    const hit = hitTest(fileId, x, y);
    const pendingSnapshot = createSnapshot(fileId);

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const isAlt = e.altKey;

    if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();

    // 1. Alt+左键：新建排除区域
    if (isAlt) {
        e.preventDefault();
        transformState = {
            fileId,
            mode: 'drawing_new',
            drawType: 'exclude',
            startX: x,
            startY: y,
            currentX: x,
            currentY: y,
            pendingSnapshot,
            hasModified: false
        };
        return;
    }

    // 2. 普通/Shift 交互
    if (hit.type === 'handle') {
        e.preventDefault();
        transformState = {
            fileId,
            mode: 'resizing',
            handleIndex: hit.index,
            startX: x,
            startY: y,
            rectIndex: hit.rectIndex,
            initialHandles: hit.info,
            pendingSnapshot,
            hasModified: false
        };
    } else if (hit.type === 'rotate') {
        e.preventDefault();
        transformState = {
            fileId,
            mode: 'rotating',
            startX: x,
            startY: y,
            rectIndex: hit.rectIndex,
            initialHandles: hit.info,
            pendingSnapshot,
            hasModified: false
        };
    } else if (hit.type === 'inside' || hit.type === 'other_rect') {
        e.preventDefault();
        const clickedIdx = hit.rectIndex;

        if (isShift) {
            if (fileData.selectedCropIndices.has(clickedIdx)) {
                fileData.selectedCropIndices.delete(clickedIdx);
                const remaining = Array.from(fileData.selectedCropIndices);
                fileData.selectedCropIndex = remaining.length > 0 ? remaining[remaining.length - 1] : -1;
            } else {
                fileData.selectedCropIndices.add(clickedIdx);
                fileData.selectedCropIndex = clickedIdx;
            }
        } else {
            if (!fileData.selectedCropIndices.has(clickedIdx)) {
                fileData.selectedCropIndices.clear();
                fileData.selectedCropIndices.add(clickedIdx);
                fileData.selectedCropIndex = clickedIdx;
            }
        }

        drawCanvas(fileId);
        renderCropPreviews(fileId);

        // 记录所有当前多选矩形的初始位置，以便支持批量整体平移
        const initialMulti = {};
        fileData.selectedCropIndices.forEach(idx => {
            if (fileData.rects[idx]) {
                const rInfo = getTransformHandles(fileData.rects[idx]);
                initialMulti[idx] = { cx: rInfo.cx, cy: rInfo.cy, w: rInfo.w, h: rInfo.h, angle: rInfo.angle };
            }
        });

        transformState = {
            fileId,
            mode: 'moving',
            startX: x,
            startY: y,
            rectIndex: fileData.selectedCropIndex,
            initialHandles: getTransformHandles(fileData.rects[fileData.selectedCropIndex]),
            initialMultiRects: initialMulti,
            pendingSnapshot,
            hasModified: false
        };
    } else if (hit.type === 'empty') {
        if (isShift) {
            // Shift + 空白处拖动：矩形框选多选 (Marquee Selection)
            e.preventDefault();
            transformState = {
                fileId,
                mode: 'marquee_select',
                startX: x,
                startY: y,
                currentX: x,
                currentY: y,
                pendingSnapshot,
                hasModified: false
            };
        } else {
            // 普通点击空白处：清空选择
            if (fileData.selectedCropIndices.size > 0) {
                fileData.selectedCropIndices.clear();
                fileData.selectedCropIndex = -1;
                drawCanvas(fileId);
                renderCropPreviews(fileId);
            }
            // 允许直接在空白处拖动拉出新选框
            transformState = {
                fileId,
                mode: 'drawing_new',
                drawType: 'include',
                startX: x,
                startY: y,
                currentX: x,
                currentY: y,
                pendingSnapshot,
                hasModified: false
            };
        }
    }
}

function handleCanvasMouseMove(fileId, e) {
    const fileData = filesMap[fileId];
    if (!fileData) return;
    const canvas = fileData.canvasEl;
    const { x, y } = getCanvasCoords(canvas, e);

    if (transformState.mode === 'none') {
        const hit = hitTest(fileId, x, y);
        if (e.altKey) {
            canvas.style.cursor = 'crosshair';
        } else if (hit.type === 'handle') {
            canvas.style.cursor = getHandleCursor(hit.info, hit.index);
        } else if (hit.type === 'rotate') {
            canvas.style.cursor = getRotateCursor(hit.cx, hit.cy, x, y);
        } else if (hit.type === 'inside' || hit.type === 'other_rect') {
            canvas.style.cursor = 'move';
        } else {
            canvas.style.cursor = 'default';
        }
    }
}

function handleCanvasMouseLeave(fileId, e) {
    if (transformState.mode === 'none') {
        const fileData = filesMap[fileId];
        if (fileData && fileData.canvasEl) {
            fileData.canvasEl.style.cursor = 'default';
        }
    }
}

window.addEventListener('mousemove', (e) => {
    if (!transformState || transformState.mode === 'none') return;
    const fileId = transformState.fileId;
    const fileData = filesMap[fileId];
    if (!fileData) return;

    const canvas = fileData.canvasEl;
    let { x, y } = getCanvasCoords(canvas, e);

    const isCtrlPressed = e.ctrlKey || e.metaKey;

    if (transformState.mode === 'moving') {
        canvas.style.cursor = 'move';
        // 磁吸判断
        const snapped = getEdgeSnap(fileId, x, y, isCtrlPressed);
        const curX = snapped.x;
        const curY = snapped.y;

        const dx = curX - transformState.startX;
        const dy = curY - transformState.startY;

        if (transformState.initialMultiRects) {
            Object.keys(transformState.initialMultiRects).forEach(idxStr => {
                const idx = parseInt(idxStr);
                const rect = fileData.rects[idx];
                const init = transformState.initialMultiRects[idx];
                if (rect && init) {
                    updateRectFromParams(rect, init.cx + dx, init.cy + dy, init.w, init.h, init.angle);
                }
            });
        } else {
            const init = transformState.initialHandles;
            const rect = fileData.rects[transformState.rectIndex];
            if (rect && init) {
                updateRectFromParams(rect, init.cx + dx, init.cy + dy, init.w, init.h, init.angle);
            }
        }

        transformState.hasModified = true;
        drawCanvas(fileId);
    } else if (transformState.mode === 'resizing') {
        canvas.style.cursor = getHandleCursor(transformState.initialHandles, transformState.handleIndex);

        const snapped = getEdgeSnap(fileId, x, y, isCtrlPressed);
        const curX = snapped.x;
        const curY = snapped.y;

        const dx = curX - transformState.startX;
        const dy = curY - transformState.startY;
        const init = transformState.initialHandles;
        const rect = fileData.rects[transformState.rectIndex];
        if (rect) {
            const hIdx = transformState.handleIndex;
            const proj_w = dx * init.u_w[0] + dy * init.u_w[1];
            const proj_h = dx * init.u_h[0] + dy * init.u_h[1];

            let new_w = init.w;
            let new_h = init.h;
            let delta_w = 0;
            let delta_h = 0;
            let new_cx = init.cx;
            let new_cy = init.cy;

            if (hIdx === 2) {
                new_w = Math.max(15, init.w + proj_w);
                new_h = Math.max(15, init.h + proj_h);
                if (e.shiftKey) new_h = Math.max(15, new_w * (init.h / init.w));
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx + (delta_w * init.u_w[0] + delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (delta_w * init.u_w[1] + delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 0) {
                new_w = Math.max(15, init.w - proj_w);
                new_h = Math.max(15, init.h - proj_h);
                if (e.shiftKey) new_h = Math.max(15, new_w * (init.h / init.w));
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx - (delta_w * init.u_w[0] + delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy - (delta_w * init.u_w[1] + delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 1) {
                new_w = Math.max(15, init.w - proj_w);
                new_h = Math.max(15, init.h + proj_h);
                if (e.shiftKey) new_h = Math.max(15, new_w * (init.h / init.w));
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx + (-delta_w * init.u_w[0] + delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (-delta_w * init.u_w[1] + delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 3) {
                new_w = Math.max(15, init.w + proj_w);
                new_h = Math.max(15, init.h - proj_h);
                if (e.shiftKey) new_h = Math.max(15, new_w * (init.h / init.w));
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx + (delta_w * init.u_w[0] - delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (delta_w * init.u_w[1] - delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 4) {
                new_w = Math.max(15, init.w - proj_w);
                delta_w = new_w - init.w;
                new_cx = init.cx - (delta_w * init.u_w[0]) * 0.5;
                new_cy = init.cy - (delta_w * init.u_w[1]) * 0.5;
            } else if (hIdx === 5) {
                new_h = Math.max(15, init.h + proj_h);
                delta_h = new_h - init.h;
                new_cx = init.cx + (delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 6) {
                new_w = Math.max(15, init.w + proj_w);
                delta_w = new_w - init.w;
                new_cx = init.cx + (delta_w * init.u_w[0]) * 0.5;
                new_cy = init.cy + (delta_w * init.u_w[1]) * 0.5;
            } else if (hIdx === 7) {
                new_h = Math.max(15, init.h - proj_h);
                delta_h = new_h - init.h;
                new_cx = init.cx - (delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy - (delta_h * init.u_h[1]) * 0.5;
            }

            updateRectFromParams(rect, new_cx, new_cy, new_w, new_h, init.angle);
            transformState.hasModified = true;
            drawCanvas(fileId);
        }
    } else if (transformState.mode === 'rotating') {
        const init = transformState.initialHandles;
        canvas.style.cursor = getRotateCursor(init.cx, init.cy, x, y);
        const rect = fileData.rects[transformState.rectIndex];
        if (rect) {
            const dAng = (Math.atan2(y - init.cy, x - init.cx) - Math.atan2(transformState.startY - init.cy, transformState.startX - init.cx)) * 180 / Math.PI;
            let new_angle = (init.angle + dAng) % 360;
            if (e.shiftKey) {
                new_angle = Math.round(new_angle / 15) * 15;
            }
            updateRectFromParams(rect, init.cx, init.cy, init.w, init.h, new_angle);
            transformState.hasModified = true;
            drawCanvas(fileId);
        }
    } else if (transformState.mode === 'drawing_new' || transformState.mode === 'marquee_select') {
        canvas.style.cursor = 'crosshair';
        transformState.currentX = x;
        transformState.currentY = y;
        drawCanvas(fileId);
    }
});

window.addEventListener('mouseup', (e) => {
    if (!transformState || transformState.mode === 'none') return;
    const fileId = transformState.fileId;
    const fileData = filesMap[fileId];

    if (transformState.mode === 'marquee_select') {
        const x0 = Math.min(transformState.startX, transformState.currentX);
        const y0 = Math.min(transformState.startY, transformState.currentY);
        const w0 = Math.abs(transformState.currentX - transformState.startX);
        const h0 = Math.abs(transformState.currentY - transformState.startY);

        if (w0 >= 10 && h0 >= 10) {
            if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();
            (fileData.rects || []).forEach((r, idx) => {
                const rx = r.x;
                const ry = r.y;
                const rw = r.w;
                const rh = r.h;
                const intersects = !(rx + rw < x0 || rx > x0 + w0 || ry + rh < y0 || ry > y0 + h0);
                if (intersects) {
                    fileData.selectedCropIndices.add(idx);
                }
            });
            if (fileData.selectedCropIndices.size > 0) {
                fileData.selectedCropIndex = Array.from(fileData.selectedCropIndices)[0];
            }
            updateFileUiAfterRectsChange(fileId);
            log(`[${fileData.name}] 矩形多选完成，当前选中 ${fileData.selectedCropIndices.size} 个裁剪框。`);
        } else {
            drawCanvas(fileId);
        }
    } else if (transformState.mode === 'drawing_new') {
        const canvas = fileData.canvasEl;
        const { x, y } = getCanvasCoords(canvas, e);
        const x0 = Math.min(transformState.startX, x);
        const y0 = Math.min(transformState.startY, y);
        const w0 = Math.abs(x - transformState.startX);
        const h0 = Math.abs(y - transformState.startY);

        if (w0 >= 15 && h0 >= 15) {
            const isExclude = transformState.drawType === 'exclude';
            const newRect = {
                x: Math.round(x0),
                y: Math.round(y0),
                w: Math.round(w0),
                h: Math.round(h0),
                orient: 0,
                excluded: isExclude,
                rotated: {
                    cx: Math.round(x0 + w0 / 2),
                    cy: Math.round(y0 + h0 / 2),
                    w: Math.round(w0),
                    h: Math.round(h0),
                    angle: 0,
                    points: computeBoxPoints(x0 + w0 / 2, y0 + h0 / 2, w0, h0, 0)
                }
            };
            fileData.rects.push(newRect);
            fileData.selectedCropIndex = fileData.rects.length - 1;
            if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();
            fileData.selectedCropIndices.clear();
            fileData.selectedCropIndices.add(fileData.selectedCropIndex);

            updateFileUiAfterRectsChange(fileId);
            log(`[${fileData.name}] ${isExclude ? '新建排除区域' : '手动新建框选'} #${fileData.rects.length} (${Math.round(w0)}x${Math.round(h0)})`);
        } else {
            drawCanvas(fileId);
        }
    } else if (transformState.mode === 'moving' || transformState.mode === 'resizing' || transformState.mode === 'rotating') {
        if (transformState.hasModified && transformState.pendingSnapshot) {
            pushUndoState(fileId, transformState.pendingSnapshot);
        }
        renderCropPreviews(fileId);
    } else {
        renderCropPreviews(fileId);
    }

    transformState.mode = 'none';
});

window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    const isCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // 全选 Ctrl+A
    if (isCtrl && key === 'a') {
        e.preventDefault();
        selectAllCrops(currentFileId);
        return;
    }

    // 撤销 Ctrl+Z
    if (isCtrl && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
            redo(currentFileId);
        } else {
            undo(currentFileId);
        }
        return;
    }

    // 重做 Ctrl+Y
    if (isCtrl && key === 'y') {
        e.preventDefault();
        redo(currentFileId);
        return;
    }

    // 快捷操作
    if (!isCtrl) {
        if (key === 'z') {
            e.preventDefault();
            rotateSelectedCrop(-90);
        } else if (key === 'c') {
            e.preventDefault();
            rotateSelectedCrop(90);
        } else if (key === 'm') {
            e.preventDefault();
            mergeSelectedCrops(currentFileId);
        } else if (key === 'v') {
            e.preventDefault();
            splitSelectedCrop(currentFileId, 'v');
        } else if (key === 'h') {
            e.preventDefault();
            splitSelectedCrop(currentFileId, 'h');
        } else if (key === 'x') {
            e.preventDefault();
            const fileData = filesMap[currentFileId];
            const rects = fileData ? fileData.rects || [] : [];
            const selIndices = fileData && fileData.selectedCropIndices && fileData.selectedCropIndices.size > 0
                ? Array.from(fileData.selectedCropIndices)
                : [fileData ? fileData.selectedCropIndex : -1];

            pushUndoState(currentFileId);
            selIndices.forEach(idx => {
                const curRect = rects[idx];
                if (curRect) {
                    if (curRect.excluded) {
                        curRect.excluded = false;
                    } else if (e.altKey) {
                        curRect.excluded = !curRect.excluded;
                    } else {
                        const cur = getRectOrient(curRect);
                        curRect.orient = (cur + 180) % 360;
                        delete curRect.flip180;
                    }
                }
            });
            updateFileUiAfterRectsChange(currentFileId);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteSelectedCrop(currentFileId);
        }
    }
});

function drawCanvas(fileId) {
    const fileData = filesMap[fileId];
    if (!fileData) return;

    const canvas = fileData.canvasEl;
    const canvasCtx = canvas.getContext('2d');
    const autoRotElem = document.getElementById(`autoRotate-${fileId}`);
    const isAutoRotate = autoRotElem ? autoRotElem.checked : true;

    const imageSrc = currentDebugMode === 'original' ? fileData.thumbnail : fileData.debugImgSrc;
    if (!imageSrc) return;

    const render = (img) => {
        if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
        } else {
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
        }

        canvasCtx.imageSmoothingEnabled = true;
        canvasCtx.imageSmoothingQuality = 'high';
        canvasCtx.drawImage(img, 0, 0);

        if (currentDebugMode === 'original') {
            const strokeColor = getComputedStyle(document.body).getPropertyValue('--crop-outline').trim() || '#ffff00';
            const selectedColor = '#00e5ff';
            const multiSelectColor = '#29b6f6';
            const rects = fileData.rects || [];

            const calculatedLineWidth = Math.max(2, Math.round(canvas.width / 350));
            const fontSize = Math.max(12, Math.round(canvas.width / 80));
            const paddingOffset = Math.round(fontSize * 0.25);
            const handlePx = Math.max(8, Math.min(22, Math.round(canvas.width / 140)));

            const selIndices = fileData.selectedCropIndices || new Set();

            rects.forEach((rect, index) => {
                const isSelected = selIndices.has(index);
                const isPrimary = (index === fileData.selectedCropIndex);
                const isExcluded = !!rect.excluded;

                let currentStroke = strokeColor;
                if (isExcluded) {
                    currentStroke = isSelected ? '#ff3b30' : 'rgba(255, 59, 48, 0.85)';
                } else if (isPrimary) {
                    currentStroke = selectedColor;
                } else if (isSelected) {
                    currentStroke = multiSelectColor;
                }

                canvasCtx.strokeStyle = currentStroke;
                canvasCtx.lineWidth = calculatedLineWidth + (isSelected ? 1 : 0);

                const hInfo = getTransformHandles(rect);
                const pts = hInfo.corners;

                if (isAutoRotate && pts) {
                    canvasCtx.beginPath();
                    canvasCtx.moveTo(pts[0][0], pts[0][1]);
                    canvasCtx.lineTo(pts[1][0], pts[1][1]);
                    canvasCtx.lineTo(pts[2][0], pts[2][1]);
                    canvasCtx.lineTo(pts[3][0], pts[3][1]);
                    canvasCtx.closePath();
                    if (isExcluded) {
                        canvasCtx.fillStyle = 'rgba(255, 59, 48, 0.16)';
                        canvasCtx.fill();
                    } else if (isSelected && !isPrimary) {
                        canvasCtx.fillStyle = 'rgba(41, 182, 246, 0.1)';
                        canvasCtx.fill();
                    }
                    canvasCtx.stroke();

                    // 标签
                    canvasCtx.fillStyle = currentStroke;
                    canvasCtx.font = `bold ${fontSize}px monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const angleStr = Math.abs(hInfo.angle) > 0.05 ? ` ${hInfo.angle > 0 ? '+' : ''}${hInfo.angle.toFixed(1)}°` : '';
                    const labelPrefix = isExcluded ? '[排除 ' : '[';
                    const multiMark = (selIndices.size > 1 && isSelected) ? ' ✓' : '';
                    const label = `${labelPrefix}#${index + 1}]${orientLabel ? ' ' + orientLabel : ''}${angleStr}${multiMark}`;
                    const textWidth = canvasCtx.measureText(label).width;

                    const rectH = fontSize + (paddingOffset * 2);
                    const rectY = pts[0][1] - rectH > 0 ? pts[0][1] - rectH : 0;

                    canvasCtx.fillRect(pts[0][0], rectY, textWidth + (paddingOffset * 2), rectH);
                    canvasCtx.fillStyle = isExcluded ? '#ffffff' : '#000000';
                    canvasCtx.fillText(label, pts[0][0] + paddingOffset, rectY + fontSize);
                } else {
                    if (isExcluded) {
                        canvasCtx.fillStyle = 'rgba(255, 59, 48, 0.16)';
                        canvasCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
                    } else if (isSelected && !isPrimary) {
                        canvasCtx.fillStyle = 'rgba(41, 182, 246, 0.1)';
                        canvasCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
                    }
                    canvasCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

                    canvasCtx.fillStyle = currentStroke;
                    canvasCtx.font = `bold ${fontSize}px monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const labelPrefix = isExcluded ? '[排除 ' : '[';
                    const multiMark = (selIndices.size > 1 && isSelected) ? ' ✓' : '';
                    const label = `${labelPrefix}#${index + 1}]${orientLabel ? ' ' + orientLabel : ''}${multiMark}`;
                    const textWidth = canvasCtx.measureText(label).width;

                    const rectH = fontSize + (paddingOffset * 2);
                    const rectY = rect.y - rectH > 0 ? rect.y - rectH : 0;

                    canvasCtx.fillRect(rect.x, rectY, textWidth + (paddingOffset * 2), rectH);
                    canvasCtx.fillStyle = isExcluded ? '#ffffff' : '#000000';
                    canvasCtx.fillText(label, rect.x + paddingOffset, rectY + fontSize);
                }

                // 绘制主选中框的 8 个自由变换控制手柄
                if (isPrimary) {
                    canvasCtx.fillStyle = '#ffffff';
                    canvasCtx.strokeStyle = isExcluded ? '#ff3b30' : '#007acc';
                    canvasCtx.lineWidth = 2;

                    hInfo.handles.forEach(hp => {
                        canvasCtx.fillRect(hp[0] - handlePx / 2, hp[1] - handlePx / 2, handlePx, handlePx);
                        canvasCtx.strokeRect(hp[0] - handlePx / 2, hp[1] - handlePx / 2, handlePx, handlePx);
                    });

                    canvasCtx.beginPath();
                    canvasCtx.arc(hInfo.cx, hInfo.cy, handlePx / 2.5, 0, Math.PI * 2);
                    canvasCtx.fillStyle = isExcluded ? '#ff3b30' : selectedColor;
                    canvasCtx.fill();
                    canvasCtx.stroke();
                }
            });

            // 正在绘制新选框或矩形框选时显示虚线
            if (transformState && transformState.fileId === fileId) {
                const x0 = Math.min(transformState.startX, transformState.currentX);
                const y0 = Math.min(transformState.startY, transformState.currentY);
                const w0 = Math.abs(transformState.currentX - transformState.startX);
                const h0 = Math.abs(transformState.currentY - transformState.startY);

                if (transformState.mode === 'marquee_select') {
                    canvasCtx.save();
                    canvasCtx.strokeStyle = '#29b6f6';
                    canvasCtx.lineWidth = 1.5;
                    canvasCtx.setLineDash([4, 4]);
                    canvasCtx.strokeRect(x0, y0, w0, h0);
                    canvasCtx.fillStyle = 'rgba(41, 182, 246, 0.15)';
                    canvasCtx.fillRect(x0, y0, w0, h0);
                    canvasCtx.restore();
                } else if (transformState.mode === 'drawing_new') {
                    const isExcludeDraw = transformState.drawType === 'exclude';
                    canvasCtx.save();
                    canvasCtx.strokeStyle = isExcludeDraw ? '#ff3b30' : '#00e5ff';
                    canvasCtx.lineWidth = calculatedLineWidth;
                    canvasCtx.setLineDash([8, 6]);
                    canvasCtx.strokeRect(x0, y0, w0, h0);
                    canvasCtx.fillStyle = isExcludeDraw ? 'rgba(255, 59, 48, 0.22)' : 'rgba(0, 229, 255, 0.15)';
                    canvasCtx.fillRect(x0, y0, w0, h0);
                    canvasCtx.restore();
                }
            }
        }
    };

    if (fileData._cachedImg && fileData._cachedImgSrc === imageSrc && fileData._cachedImg.complete) {
        render(fileData._cachedImg);
    } else {
        const img = new Image();
        img.onload = () => {
            fileData._cachedImg = img;
            fileData._cachedImgSrc = imageSrc;
            render(img);
        };
        img.src = imageSrc;
    }
}

syncParamsBtn.addEventListener('click', () => {
    if (!currentFileId) return;
    const srcParams = { ...filesMap[currentFileId].params };
    log(`正在将当前 [${filesMap[currentFileId].name}] 的配置参数批量同步应用到其他图片...`);

    Object.keys(filesMap).forEach(fileId => {
        if (fileId === currentFileId) return;

        filesMap[fileId].params = { ...srcParams };

        const modeSelect = document.getElementById(`threshMode-${fileId}`);
        if (modeSelect) modeSelect.value = srcParams.threshold_mode || 'fixed';

        const morphRange = document.getElementById(`morphSizeRange-${fileId}`);
        if (morphRange) morphRange.value = srcParams.morph_size || 0;
        const morphNum = document.getElementById(`morphSizeNum-${fileId}`);
        if (morphNum) morphNum.value = srcParams.morph_size || 0;
        const morphLabel = document.getElementById(`morphValLabel-${fileId}`);
        if (morphLabel) morphLabel.innerText = (srcParams.morph_size || 0) + ' px';

        document.getElementById(`threshold-${fileId}`).value = srcParams.threshold;
        document.getElementById(`thresholdNum-${fileId}`).value = srcParams.threshold;
        document.getElementById(`threshValLabel-${fileId}`).innerText = srcParams.threshold;
        document.getElementById(`padding-${fileId}`).value = srcParams.padding;
        document.getElementById(`paddingNum-${fileId}`).value = srcParams.padding;
        document.getElementById(`paddingValLabel-${fileId}`).innerText = srcParams.padding + ' px';
        document.getElementById(`blurKernel-${fileId}`).value = srcParams.blur_kernel;
        document.getElementById(`autoRotate-${fileId}`).checked = srcParams.auto_rotate;
        document.getElementById(`minArea-${fileId}`).value = srcParams.min_area_pct;
        const minAreaRange = document.getElementById(`minAreaRange-${fileId}`);
        if (minAreaRange) minAreaRange.value = srcParams.min_area_pct;
        const minAreaLabel = document.getElementById(`minAreaValLabel-${fileId}`);
        if (minAreaLabel) minAreaLabel.innerText = Number(srcParams.min_area_pct).toFixed(2) + '%';

        document.getElementById(`maxArea-${fileId}`).value = srcParams.max_area_pct;
        const maxAreaRange = document.getElementById(`maxAreaRange-${fileId}`);
        if (maxAreaRange) maxAreaRange.value = srcParams.max_area_pct;
        const maxAreaLabel = document.getElementById(`maxAreaValLabel-${fileId}`);
        if (maxAreaLabel) maxAreaLabel.innerText = Number(srcParams.max_area_pct).toFixed(1) + '%';

        const radios = document.getElementsByName(`bgType-${fileId}`);
        radios.forEach(radio => {
            if (radio.value === srcParams.bg_type) radio.checked = true;
        });

        silentRequestPreview(fileId);
    });
    log(`全局参数同步重绘完成。`);
});

exportBtn.addEventListener('click', async () => {
    if (!sessionId || Object.keys(filesMap).length === 0) return;

    const exportType = exportTypeSelect.value;
    const exportFormat = (exportFormatSelect ? exportFormatSelect.value : 'jpg').toLowerCase();
    const namingTemplate = (namingTemplateInput && namingTemplateInput.value.trim()) ? namingTemplateInput.value.trim() : '{original}_crop_{index:02d}';
    const flat = !!(flatExportCheck && flatExportCheck.checked);

    const filesPayload = Object.keys(filesMap).map(fileId => ({
        file_id: fileId,
        filename: filesMap[fileId].name,
        rects: (filesMap[fileId].rects || []).filter(r => !r.excluded),
        bg_type: filesMap[fileId].params.bg_type,
        auto_rotate: filesMap[fileId].params.auto_rotate,
        padding: filesMap[fileId].params.padding
    }));
    const totalFiles = filesPayload.length;
    const totalRects = filesPayload.reduce((n, f) => n + f.rects.length, 0);

    log(`开始批量裁剪。格式: ${exportFormat.toUpperCase()}，模板: ${namingTemplate}，总文件数: ${totalFiles}，子图约 ${totalRects} 张，模式: ${exportType}${flat ? ' (平铺)' : ''}`);
    setExportBusy(true, '正在导出…');

    try {
        if (exportType === 'zip') {
            const zipEntries = [];
            let croppedCount = 0;

            for (let i = 0; i < filesPayload.length; i++) {
                const fileItem = filesPayload[i];
                setExportBusy(true, `导出中 ${i + 1}/${totalFiles}`);
                if (!fileItem.rects.length) {
                    log(`[${i + 1}/${totalFiles}] ${fileItem.filename}: 无有效裁剪框，跳过。`);
                    continue;
                }
                log(`正在裁剪 [${i + 1}/${totalFiles}]: ${fileItem.filename}（${fileItem.rects.length} 张子图）…`);

                const res = await fetch('/api/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: sessionId,
                        export_type: 'images',
                        format: exportFormat,
                        naming_template: namingTemplate,
                        quality: 100,
                        flat,
                        files: [fileItem]
                    })
                });

                if (!res.ok) {
                    throw new Error(await readApiError(res, `裁剪失败: ${fileItem.filename}`));
                }

                const data = await res.json();
                if (data.error) throw new Error(data.error);

                const images = data.images || [];
                for (const img of images) {
                    zipEntries.push({
                        name: img.path || (flat ? `${img.folder}_${img.name}` : `${img.folder}/${img.name}`),
                        data: base64ToUint8Array(img.data)
                    });
                }
                croppedCount += images.length;
                log(`[${fileItem.filename}] 已提取 ${images.length} 张，累计 ${croppedCount} 张。`);
            }

            if (zipEntries.length === 0) {
                throw new Error('没有提取到任何裁剪后的图片，请调整裁剪参数。');
            }

            setExportBusy(true, '正在打包…');
            log(`正在浏览器内打包 ${zipEntries.length} 张图片为 ZIP…`);
            const zipBlob = buildStoreZip(zipEntries);
            const zipName = `batch_cropped_${exportFormat}_${Date.now().toString(36)}.zip`;
            downloadBlobNative(zipBlob, zipName);
            log(`批量导出完成！已通过浏览器下载: ${zipName}（共 ${zipEntries.length} 张，${exportFormat.toUpperCase()} 格式）。`);
        } else {
            let savedCount = 0;
            let lastPath = '';

            for (let i = 0; i < filesPayload.length; i++) {
                const fileItem = filesPayload[i];
                setExportBusy(true, `保存中 ${i + 1}/${totalFiles}`);
                if (!fileItem.rects.length) {
                    log(`[${i + 1}/${totalFiles}] ${fileItem.filename}: 无有效裁剪框，跳过。`);
                    continue;
                }
                log(`正在写入本地 [${i + 1}/${totalFiles}]: ${fileItem.filename}…`);

                const res = await fetch('/api/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: sessionId,
                        export_type: 'local',
                        format: exportFormat,
                        naming_template: namingTemplate,
                        quality: 100,
                        flat,
                        files: [fileItem]
                    })
                });

                if (!res.ok) {
                    throw new Error(await readApiError(res, `写入失败: ${fileItem.filename}`));
                }

                const data = await res.json();
                if (data.error) throw new Error(data.error);

                savedCount += data.count || 0;
                lastPath = data.local_path || lastPath;
                log(`[${fileItem.filename}] ${data.message || '已写入'}`);
            }

            log(`批量裁剪保存成功！共写入约 ${savedCount} 张 ${exportFormat.toUpperCase()} 照片。`);
            if (lastPath) log(`输出物理目录: ${lastPath}`);
        }
    } catch (err) {
        log(`导出出错: ${err.message || err}`);
    } finally {
        setExportBusy(false);
    }
});
