// 状态管理
let sessionId = null;
let filesMap = {}; // { fileId: { name, width, height, thumbnail, rects, params, canvasEl, containerEl, detected, selectedCropIndex } }
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
            // 调试层需要重新取图；原图模式若已检测则只重绘
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
                            <span class="hint">选中后：Z 左旋90° · C 右旋90° · X 转180°</span>
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
                            <span>二值化阈值 <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="区分背景与前景的亮度临界点（0-255）。调高可滤除浅灰色阴影，使边缘彻底分离。">[?]</span></span>
                            <span id="threshValLabel-${fileId}" style="font-family:monospace; font-weight:bold; color:var(--accent-color);">200</span>
                        </div>
                        <div class="ctrl-input-row" style="display:flex; gap:10px; align-items:center;">
                            <input type="range" id="threshold-${fileId}" min="0" max="255" value="200" style="flex:1; cursor:pointer;">
                            <input type="number" id="thresholdNum-${fileId}" min="0" max="255" value="200" style="width:45px; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; text-align:right; padding:2px;">
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
                        </div>
                        <input type="number" id="minArea-${fileId}" min="0.05" max="100" step="0.1" value="0.8" style="width:100%; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; padding:3px; box-sizing:border-box;">
                    </div>
                    
                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>最大面积占比 (%) <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="任何面积占比超过此阈值的大块区域会被忽略，防止将整个扫描背景误当做照片。">[?]</span></span>
                        </div>
                        <input type="number" id="maxArea-${fileId}" min="0.1" max="100" step="0.1" value="80.0" style="width:100%; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; padding:3px; box-sizing:border-box;">
                    </div>

                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>外扩边缘 (px) <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="在真实矩形外围额外扩充的宽度。正数朝外防止切边，负数朝内收紧。">[?]</span></span>
                            <span id="paddingValLabel-${fileId}" style="font-family:monospace; font-weight:bold; color:var(--accent-color);">5 px</span>
                        </div>
                        <div class="ctrl-input-row" style="display:flex; gap:10px; align-items:center;">
                            <input type="range" id="padding-${fileId}" min="-50" max="50" value="5" style="flex:1; cursor:pointer;">
                            <input type="number" id="paddingNum-${fileId}" min="-50" max="50" value="5" style="width:45px; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; text-align:right; padding:2px;">
                        </div>
                    </div>

                    <div style="display:flex; gap:6px; margin-top:8px;">
                        <button id="delCropBtn-${fileId}" class="btn-secondary" style="margin-top:0; font-size:11px; padding:4px;" title="删除当前选中的裁剪框 (快捷键: Delete / Backspace)">删除选中框</button>
                        <button id="reDetectBtn-${fileId}" class="btn-secondary" style="margin-top:0; font-size:11px; padding:4px;" title="使用当前调优参数重新自动检测">重新自动检测</button>
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
                    params: {
                        blur_kernel: 3,
                        threshold: 200,
                        bg_type: 'light',
                        min_area_pct: 0.8,
                        max_area_pct: 80.0,
                        padding: 5,
                        auto_rotate: true
                    },
                    canvasEl: canvasEl,
                    containerEl: pageEl,
                    debugImgSrc: null
                };

                bindLocalEvents(fileId);
                syncCanvasOrder();
                renderFileList();
                setupCanvasObserver();
                updateBatchSummary();

                // 导入阶段只后台检测，不切换选中，避免中途乱跳
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

    const threshRange = document.getElementById(`threshold-${fileId}`);
    const threshNum = document.getElementById(`thresholdNum-${fileId}`);
    const threshLabel = document.getElementById(`threshValLabel-${fileId}`);
    const paddingRange = document.getElementById(`padding-${fileId}`);
    const paddingNum = document.getElementById(`paddingNum-${fileId}`);
    const paddingLabel = document.getElementById(`paddingValLabel-${fileId}`);
    const blurSelect = document.getElementById(`blurKernel-${fileId}`);
    const autoRotCheck = document.getElementById(`autoRotate-${fileId}`);
    const minAreaInput = document.getElementById(`minArea-${fileId}`);
    const maxAreaInput = document.getElementById(`maxArea-${fileId}`);
    const bgRadios = document.getElementsByName(`bgType-${fileId}`);
    const delCropBtn = document.getElementById(`delCropBtn-${fileId}`);
    const reDetectBtn = document.getElementById(`reDetectBtn-${fileId}`);

    const triggerLocalDebouncedPreview = () => {
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
            requestPreview(fileId);
        }, 80);
    };

    threshRange.addEventListener('input', (e) => {
        threshNum.value = e.target.value;
        threshLabel.innerText = e.target.value;
        fileData.params.threshold = parseInt(e.target.value);
        triggerLocalDebouncedPreview();
    });
    threshNum.addEventListener('change', (e) => {
        let val = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
        threshRange.value = val;
        threshNum.value = val;
        threshLabel.innerText = val;
        fileData.params.threshold = val;
        triggerLocalDebouncedPreview();
    });

    paddingRange.addEventListener('input', (e) => {
        paddingNum.value = e.target.value;
        paddingLabel.innerText = e.target.value + ' px';
        fileData.params.padding = parseInt(e.target.value);
        triggerLocalDebouncedPreview();
    });
    paddingNum.addEventListener('change', (e) => {
        let val = Math.max(-50, Math.min(50, parseInt(e.target.value) || 0));
        paddingRange.value = val;
        paddingNum.value = val;
        paddingLabel.innerText = val + ' px';
        fileData.params.padding = val;
        triggerLocalDebouncedPreview();
    });

    blurSelect.addEventListener('change', (e) => {
        fileData.params.blur_kernel = parseInt(e.target.value);
        triggerLocalDebouncedPreview();
    });
    autoRotCheck.addEventListener('change', (e) => {
        fileData.params.auto_rotate = e.target.checked;
        drawCanvas(fileId);
        renderCropPreviews(fileId);
    });
    minAreaInput.addEventListener('input', (e) => {
        fileData.params.min_area_pct = parseFloat(e.target.value) || 0.05;
        triggerLocalDebouncedPreview();
    });
    minAreaInput.addEventListener('change', (e) => {
        fileData.params.min_area_pct = parseFloat(e.target.value) || 0.05;
        triggerLocalDebouncedPreview();
    });
    maxAreaInput.addEventListener('change', (e) => {
        fileData.params.max_area_pct = parseFloat(e.target.value) || 100.0;
        triggerLocalDebouncedPreview();
    });

    bgRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            fileData.params.bg_type = e.target.value;
            triggerLocalDebouncedPreview();
        });
    });

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

    // Canvas 自由变换与框选交互
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

    // 已检测过的文件切换选中时不再重新跑检测
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
        if (prev) {
            if (typeof prev.orient === 'number') orient = ((prev.orient % 360) + 360) % 360;
            else if (prev.flip180) orient = 180;
        }
        return { ...rect, orient };
    });
}

function requestPreview(fileId) {
    const targetId = fileId || currentFileId;
    if (!sessionId || !targetId) return;

    const fileData = filesMap[targetId];
    const params = {
        session_id: sessionId,
        file_id: targetId,
        ...fileData.params,
        debug_mode: currentDebugMode
    };

    fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            log(`图像调试出错: ${data.error}`);
            return;
        }
        fileData.rects = mergeRectsPreserveFlip(fileData.rects, data.rects);
        fileData.debugImgSrc = data.debug_image;
        fileData.detected = true;
        if (fileData.selectedCropIndex >= fileData.rects.length) {
            fileData.selectedCropIndex = Math.max(0, fileData.rects.length - 1);
        }

        if (targetId === currentFileId) {
            log(`[${fileData.name}] ${data.log}`);
        }

        const badge = document.getElementById(`badge-${targetId}`);
        if (badge) badge.innerText = data.rects.length;

        const headerCount = document.getElementById(`page-count-${targetId}`);
        if (headerCount) headerCount.innerText = `已提取: ${data.rects.length} 张`;

        updateBatchSummary();
        drawCanvas(targetId);
        renderCropPreviews(targetId);
    })
    .catch(err => {
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

/** 从预览缩略图生成矫正后的子图预览（与导出逻辑一致，含额外朝向旋转） */
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
        // OpenCV 正角为逆时针，Canvas 正角为顺时针
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

    const img = new Image();
    img.onload = () => {
        strip.innerHTML = '';
        const autoRotate = !!fileData.params.auto_rotate;
        rects.forEach((rect, index) => {
            const isExcluded = !!rect.excluded;
            const orient = getRectOrient(rect);
            const orientLabel = formatOrientLabel(orient);
            const item = document.createElement('div');
            item.className = 'crop-preview-item' + (index === fileData.selectedCropIndex ? ' selected' : '') + (isExcluded ? ' excluded' : '');
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
                selectCrop(fileId, index);
            });
            strip.appendChild(item);
        });
    };
    img.src = fileData.thumbnail;
}

function selectCrop(fileId, index) {
    const fileData = filesMap[fileId];
    if (!fileData || !fileData.rects[index]) return;
    selectFile(fileId, false);
    fileData.selectedCropIndex = index;
    drawCanvas(fileId);
    renderCropPreviews(fileId);
}

const MAX_UNDO_STACK = 40;

function createSnapshot(fileId) {
    const fileData = filesMap[fileId];
    if (!fileData) return null;
    return {
        rects: JSON.parse(JSON.stringify(fileData.rects || [])),
        selectedCropIndex: fileData.selectedCropIndex
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
    fileData.selectedCropIndex = Math.max(0, Math.min(prevState.selectedCropIndex, fileData.rects.length - 1));

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
    fileData.selectedCropIndex = Math.max(0, Math.min(nextState.selectedCropIndex, fileData.rects.length - 1));

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

    updateBatchSummary();
    drawCanvas(fileId);
    renderCropPreviews(fileId);
}

function rotateSelectedCrop(deltaDeg) {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    pushUndoState(currentFileId);

    let idx = fileData.selectedCropIndex;
    if (idx == null || idx < 0 || idx >= rects.length) idx = 0;
    fileData.selectedCropIndex = idx;
    const rect = rects[idx];
    const cur = getRectOrient(rect);
    rect.orient = (cur + deltaDeg + 360) % 360;
    delete rect.flip180;
    drawCanvas(currentFileId);
    renderCropPreviews(currentFileId);
}

// 自由变换与手动操作状态管理器
let transformState = {
    fileId: null,
    mode: 'none', // 'none' | 'moving' | 'resizing' | 'rotating' | 'drawing_new'
    handleIndex: -1,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    rectIndex: -1,
    initialHandles: null,
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
    return [p0, p1, p2, p3];
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

    // 8 个手柄：4 个角点 + 4 个边中点
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

        // 1. 优先检查 8 个控制手柄 (缩放)
        for (let i = 0; i < 8; i++) {
            const hp = hInfo.handles[i];
            const dist = Math.hypot(mx - hp[0], my - hp[1]);
            if (dist <= handleRadius) {
                return { type: 'handle', index: i, info: hInfo, rectIndex: selIdx };
            }
        }

        // 计算当前鼠标在选中矩形局部坐标系中的坐标 (中心为 0,0)
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

        // 2. 检查矩形外围附近区域 (Photoshop 自由变换：鼠标位于矩形外围边框/角点附近即可旋转)
        const distOutsideX = Math.max(0, Math.abs(lx) - halfW);
        const distOutsideY = Math.max(0, Math.abs(ly) - halfH);
        const distToBox = Math.hypot(distOutsideX, distOutsideY);

        if (distToBox <= rotateMargin) {
            return { type: 'rotate', info: hInfo, rectIndex: selIdx, cx: hInfo.cx, cy: hInfo.cy };
        }
    }

    // 3. 检查是否点击了其它矩形
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

function deleteSelectedCrop(fileId) {
    const targetId = fileId || currentFileId;
    if (!targetId || !filesMap[targetId]) return;
    const fileData = filesMap[targetId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    pushUndoState(targetId);

    let idx = fileData.selectedCropIndex;
    if (idx < 0 || idx >= rects.length) idx = 0;
    rects.splice(idx, 1);
    fileData.selectedCropIndex = Math.max(0, Math.min(idx, rects.length - 1));

    updateFileUiAfterRectsChange(targetId);
    log(`[${fileData.name}] 已删除第 #${idx + 1} 裁剪框，当前剩余 ${rects.length} 张。`);
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
    const isAlt = e.altKey;

    // 1. Ctrl+左键：强制新建普通裁剪框
    if (isCtrl) {
        e.preventDefault();
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
        return;
    }

    // 2. Alt+左键：强制新建排除区域
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

    // 3. 常规左键交互
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
    } else if (hit.type === 'inside') {
        e.preventDefault();
        transformState = {
            fileId,
            mode: 'moving',
            startX: x,
            startY: y,
            rectIndex: hit.rectIndex,
            initialHandles: hit.info,
            pendingSnapshot,
            hasModified: false
        };
    } else if (hit.type === 'other_rect') {
        e.preventDefault();
        fileData.selectedCropIndex = hit.rectIndex;
        drawCanvas(fileId);
        renderCropPreviews(fileId);
        const newHandles = getTransformHandles(fileData.rects[hit.rectIndex]);
        transformState = {
            fileId,
            mode: 'moving',
            startX: x,
            startY: y,
            rectIndex: hit.rectIndex,
            initialHandles: newHandles,
            pendingSnapshot,
            hasModified: false
        };
    } else if (hit.type === 'empty') {
        // 普通点击空白处：取消当前选中状态，不进入绘制模式
        if (fileData.selectedCropIndex !== -1) {
            fileData.selectedCropIndex = -1;
            drawCanvas(fileId);
            renderCropPreviews(fileId);
        }
        transformState = {
            fileId,
            mode: 'none',
            handleIndex: -1,
            startX: 0,
            startY: 0,
            currentX: 0,
            currentY: 0,
            rectIndex: -1,
            initialHandles: null,
            pendingSnapshot: null,
            hasModified: false
        };
    }
}

function handleCanvasMouseMove(fileId, e) {
    const fileData = filesMap[fileId];
    if (!fileData) return;
    const canvas = fileData.canvasEl;
    const { x, y } = getCanvasCoords(canvas, e);

    if (transformState.mode === 'none') {
        const hit = hitTest(fileId, x, y);
        if (e.ctrlKey || e.metaKey || e.altKey) {
            canvas.style.cursor = 'crosshair';
        } else if (hit.type === 'handle') {
            canvas.style.cursor = getHandleCursor(hit.info, hit.index);
        } else if (hit.type === 'rotate') {
            canvas.style.cursor = getRotateCursor(hit.cx, hit.cy, x, y);
        } else if (hit.type === 'inside') {
            canvas.style.cursor = 'move';
        } else if (hit.type === 'other_rect') {
            canvas.style.cursor = 'pointer';
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
    const { x, y } = getCanvasCoords(canvas, e);

    if (transformState.mode === 'moving') {
        canvas.style.cursor = 'move';
        const dx = x - transformState.startX;
        const dy = y - transformState.startY;
        const init = transformState.initialHandles;
        const rect = fileData.rects[transformState.rectIndex];
        if (rect) {
            updateRectFromParams(rect, init.cx + dx, init.cy + dy, init.w, init.h, init.angle);
            transformState.hasModified = true;
            drawCanvas(fileId);
        }
    } else if (transformState.mode === 'resizing') {
        canvas.style.cursor = getHandleCursor(transformState.initialHandles, transformState.handleIndex);
        const dx = x - transformState.startX;
        const dy = y - transformState.startY;
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

            if (hIdx === 2) { // 右下角 (+w/2, +h/2)
                new_w = Math.max(15, init.w + proj_w);
                new_h = Math.max(15, init.h + proj_h);
                if (e.shiftKey) {
                    new_h = Math.max(15, new_w * (init.h / init.w));
                }
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx + (delta_w * init.u_w[0] + delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (delta_w * init.u_w[1] + delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 0) { // 左上角 (-w/2, -h/2)
                new_w = Math.max(15, init.w - proj_w);
                new_h = Math.max(15, init.h - proj_h);
                if (e.shiftKey) {
                    new_h = Math.max(15, new_w * (init.h / init.w));
                }
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx - (delta_w * init.u_w[0] + delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy - (delta_w * init.u_w[1] + delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 1) { // 左下角 (-w/2, +h/2)
                new_w = Math.max(15, init.w - proj_w);
                new_h = Math.max(15, init.h + proj_h);
                if (e.shiftKey) {
                    new_h = Math.max(15, new_w * (init.h / init.w));
                }
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx + (-delta_w * init.u_w[0] + delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (-delta_w * init.u_w[1] + delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 3) { // 右上角 (+w/2, -h/2)
                new_w = Math.max(15, init.w + proj_w);
                new_h = Math.max(15, init.h - proj_h);
                if (e.shiftKey) {
                    new_h = Math.max(15, new_w * (init.h / init.w));
                }
                delta_w = new_w - init.w;
                delta_h = new_h - init.h;
                new_cx = init.cx + (delta_w * init.u_w[0] - delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (delta_w * init.u_w[1] - delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 4) { // 左边中点
                new_w = Math.max(15, init.w - proj_w);
                delta_w = new_w - init.w;
                new_cx = init.cx - (delta_w * init.u_w[0]) * 0.5;
                new_cy = init.cy - (delta_w * init.u_w[1]) * 0.5;
            } else if (hIdx === 5) { // 上边中点
                new_h = Math.max(15, init.h + proj_h);
                delta_h = new_h - init.h;
                new_cx = init.cx + (delta_h * init.u_h[0]) * 0.5;
                new_cy = init.cy + (delta_h * init.u_h[1]) * 0.5;
            } else if (hIdx === 6) { // 右边中点
                new_w = Math.max(15, init.w + proj_w);
                delta_w = new_w - init.w;
                new_cx = init.cx + (delta_w * init.u_w[0]) * 0.5;
                new_cy = init.cy + (delta_w * init.u_w[1]) * 0.5;
            } else if (hIdx === 7) { // 下边中点
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
    } else if (transformState.mode === 'drawing_new') {
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

    if (transformState.mode === 'drawing_new') {
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

    // 非组合键快捷操作
    if (!isCtrl) {
        if (key === 'z') {
            e.preventDefault();
            rotateSelectedCrop(-90); // 向左（逆时针）90°
        } else if (key === 'c') {
            e.preventDefault();
            rotateSelectedCrop(90); // 向右（顺时针）90°
        } else if (key === 'x') {
            e.preventDefault();
            const fileData = filesMap[currentFileId];
            const rects = fileData ? fileData.rects || [] : [];
            const idx = fileData ? fileData.selectedCropIndex : -1;
            const curRect = (idx >= 0 && idx < rects.length) ? rects[idx] : null;

            if (curRect && curRect.excluded) {
                pushUndoState(currentFileId);
                curRect.excluded = false;
                updateFileUiAfterRectsChange(currentFileId);
                log(`[${fileData.name}] 排除区域 #${idx + 1} 已反向为正常裁剪框`);
            } else if (e.altKey && curRect) {
                pushUndoState(currentFileId);
                curRect.excluded = !curRect.excluded;
                updateFileUiAfterRectsChange(currentFileId);
                log(`[${fileData.name}] 选框 #${idx + 1} 已切换为${curRect.excluded ? '排除区域' : '正常裁剪框'}`);
            } else if (curRect) {
                rotateSelectedCrop(180);
            }
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

    const img = new Image();
    img.onload = function() {
        canvas.width = img.width;
        canvas.height = img.height;

        canvasCtx.imageSmoothingEnabled = true;
        canvasCtx.imageSmoothingQuality = 'high';
        canvasCtx.drawImage(img, 0, 0);

        if (currentDebugMode === 'original') {
            const strokeColor = getComputedStyle(document.body).getPropertyValue('--crop-outline').trim() || '#ffff00';
            const selectedColor = '#00e5ff';
            const rects = fileData.rects || [];

            const calculatedLineWidth = Math.max(2, Math.round(canvas.width / 350));
            const fontSize = Math.max(12, Math.round(canvas.width / 80));
            const paddingOffset = Math.round(fontSize * 0.25);
            const handlePx = Math.max(8, Math.min(22, Math.round(canvas.width / 140)));

            rects.forEach((rect, index) => {
                const isSelected = index === fileData.selectedCropIndex;
                const isExcluded = !!rect.excluded;
                const currentStroke = isExcluded
                    ? (isSelected ? '#ff3b30' : 'rgba(255, 59, 48, 0.85)')
                    : (isSelected ? selectedColor : strokeColor);

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
                    }
                    canvasCtx.stroke();

                    // 标签
                    canvasCtx.fillStyle = currentStroke;
                    canvasCtx.font = `bold ${fontSize}px monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const angleStr = Math.abs(hInfo.angle) > 0.05 ? ` ${hInfo.angle > 0 ? '+' : ''}${hInfo.angle.toFixed(1)}°` : '';
                    const labelPrefix = isExcluded ? '[排除 ' : '[';
                    const label = `${labelPrefix}#${index + 1}]${orientLabel ? ' ' + orientLabel : ''}${angleStr}`;
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
                    }
                    canvasCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

                    canvasCtx.fillStyle = currentStroke;
                    canvasCtx.font = `bold ${fontSize}px monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const labelPrefix = isExcluded ? '[排除 ' : '[';
                    const label = `${labelPrefix}#${index + 1}]${orientLabel ? ' ' + orientLabel : ''}`;
                    const textWidth = canvasCtx.measureText(label).width;

                    const rectH = fontSize + (paddingOffset * 2);
                    const rectY = rect.y - rectH > 0 ? rect.y - rectH : 0;

                    canvasCtx.fillRect(rect.x, rectY, textWidth + (paddingOffset * 2), rectH);
                    canvasCtx.fillStyle = isExcluded ? '#ffffff' : '#000000';
                    canvasCtx.fillText(label, rect.x + paddingOffset, rectY + fontSize);
                }

                // 绘制 Photoshop 风格的 8 个自由变换控制手柄与中心指示点
                if (isSelected) {
                    canvasCtx.fillStyle = '#ffffff';
                    canvasCtx.strokeStyle = isExcluded ? '#ff3b30' : '#007acc';
                    canvasCtx.lineWidth = 2;

                    hInfo.handles.forEach(hp => {
                        canvasCtx.fillRect(hp[0] - handlePx / 2, hp[1] - handlePx / 2, handlePx, handlePx);
                        canvasCtx.strokeRect(hp[0] - handlePx / 2, hp[1] - handlePx / 2, handlePx, handlePx);
                    });

                    // 中心十字/圆点
                    canvasCtx.beginPath();
                    canvasCtx.arc(hInfo.cx, hInfo.cy, handlePx / 2.5, 0, Math.PI * 2);
                    canvasCtx.fillStyle = isExcluded ? '#ff3b30' : selectedColor;
                    canvasCtx.fill();
                    canvasCtx.stroke();
                }
            });

            // 正在绘制新选框时显示虚线框
            if (transformState && transformState.mode === 'drawing_new' && transformState.fileId === fileId) {
                const x0 = Math.min(transformState.startX, transformState.currentX);
                const y0 = Math.min(transformState.startY, transformState.currentY);
                const w0 = Math.abs(transformState.currentX - transformState.startX);
                const h0 = Math.abs(transformState.currentY - transformState.startY);

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
    };
    const imageSrc = currentDebugMode === 'original' ? fileData.thumbnail : fileData.debugImgSrc;
    img.src = imageSrc;
}

syncParamsBtn.addEventListener('click', () => {
    if (!currentFileId) return;
    const srcParams = { ...filesMap[currentFileId].params };
    log(`正在将当前 [${filesMap[currentFileId].name}] 的配置参数批量同步应用到其他图片...`);

    Object.keys(filesMap).forEach(fileId => {
        if (fileId === currentFileId) return;

        filesMap[fileId].params = { ...srcParams };

        document.getElementById(`threshold-${fileId}`).value = srcParams.threshold;
        document.getElementById(`thresholdNum-${fileId}`).value = srcParams.threshold;
        document.getElementById(`threshValLabel-${fileId}`).innerText = srcParams.threshold;
        document.getElementById(`padding-${fileId}`).value = srcParams.padding;
        document.getElementById(`paddingNum-${fileId}`).value = srcParams.padding;
        document.getElementById(`paddingValLabel-${fileId}`).innerText = srcParams.padding + ' px';
        document.getElementById(`blurKernel-${fileId}`).value = srcParams.blur_kernel;
        document.getElementById(`autoRotate-${fileId}`).checked = srcParams.auto_rotate;
        document.getElementById(`minArea-${fileId}`).value = srcParams.min_area_pct;
        document.getElementById(`maxArea-${fileId}`).value = srcParams.max_area_pct;

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

    log(`开始批量裁剪。总文件数: ${totalFiles}，子图约 ${totalRects} 张，导出目标: ${exportType}${flat ? '（平铺，无子文件夹）' : ''}`);
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
            const zipName = `batch_cropped_${Date.now().toString(36)}.zip`;
            downloadBlobNative(zipBlob, zipName);
            log(`批量导出完成！已通过浏览器下载: ${zipName}（共 ${zipEntries.length} 张）。`);
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

            log(`批量裁剪保存成功！共写入约 ${savedCount} 张照片。`);
            if (lastPath) log(`输出物理目录: ${lastPath}`);
        }
    } catch (err) {
        log(`导出出错: ${err.message || err}`);
    } finally {
        setExportBusy(false);
    }
});
