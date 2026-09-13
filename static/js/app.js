// 状态管理
let sessionId = null;
let filesMap = {}; // { fileId: { name, width, height, thumbnail, rects, params, detected, selectedCropIndex, selectedCropIndices, debugImgSrc, _cachedImg, _edgeCanvas, _edgeCtx } }
let currentFileId = null;
let currentDebugMode = 'original'; // 'original' | 'threshold' | 'blurred'
let isImporting = false;
let isConsoleOpen = false;

// DOM 节点 - 左侧面板
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const fileMeta = document.getElementById('fileMeta');
const batchSummary = document.getElementById('batchSummary');
const importProgress = document.getElementById('importProgress');
const importProgressText = document.getElementById('importProgressText');
const importProgressFill = document.getElementById('importProgressFill');
const fileListContainer = document.getElementById('fileListContainer');
const exportTypeSelect = document.getElementById('exportType');
const exportFormatSelect = document.getElementById('exportFormat');
const namingTemplateInput = document.getElementById('namingTemplate');
const flatExportCheck = document.getElementById('flatExport');
const exportBtn = document.getElementById('exportBtn');

// DOM 节点 - 中间视口
const tabItems = document.querySelectorAll('.tab-item');
const viewportInfo = document.getElementById('viewportInfo');
const canvasViewport = document.getElementById('canvasViewport');
const dropZone = document.getElementById('dropZone');
const mainCanvas = document.getElementById('mainCanvas');
const cropPreviewStrip = document.getElementById('cropPreviewStrip');
const statusbarMsg = document.getElementById('statusbarMsg');
const consoleToggle = document.getElementById('consoleToggle');
const consoleDrawer = document.getElementById('consoleDrawer');
const consoleLog = document.getElementById('consoleLog');
const dragOverlay = document.getElementById('dragOverlay');

// DOM 节点 - 右侧检查器
const bgRadios = document.getElementsByName('bgType');
const blurSelect = document.getElementById('blurKernel');
const threshModeSelect = document.getElementById('threshMode');
const threshRange = document.getElementById('threshold');
const threshNum = document.getElementById('thresholdNum');
const threshValLabel = document.getElementById('threshValLabel');
const estimateThreshBtn = document.getElementById('estimateThreshBtn');
const morphSizeRange = document.getElementById('morphSizeRange');
const morphSizeNum = document.getElementById('morphSizeNum');
const morphValLabel = document.getElementById('morphValLabel');
const autoRotateCheck = document.getElementById('autoRotate');
const minAreaRange = document.getElementById('minAreaRange');
const minAreaInput = document.getElementById('minArea');
const minAreaValLabel = document.getElementById('minAreaValLabel');
const maxAreaRange = document.getElementById('maxAreaRange');
const maxAreaInput = document.getElementById('maxArea');
const maxAreaValLabel = document.getElementById('maxAreaValLabel');
const paddingRange = document.getElementById('padding');
const paddingNum = document.getElementById('paddingNum');
const paddingValLabel = document.getElementById('paddingValLabel');
const multiCountBadge = document.getElementById('multiCountBadge');
const autoOrientBtn = document.getElementById('autoOrientBtn');
const mergeCropsBtn = document.getElementById('mergeCropsBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const splitVCropBtn = document.getElementById('splitVCropBtn');
const splitHCropBtn = document.getElementById('splitHCropBtn');
const delCropBtn = document.getElementById('delCropBtn');
const reDetectBtn = document.getElementById('reDetectBtn');
const syncParamsBtn = document.getElementById('syncParamsBtn');

function log(message) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const fullMsg = `[${timeStr}] ${message}`;
    if (consoleLog) {
        consoleLog.value += `\n${fullMsg}`;
        consoleLog.scrollTop = consoleLog.scrollHeight;
    }
    if (statusbarMsg) {
        statusbarMsg.innerText = fullMsg;
    }
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
            ? `导入中 [${current}/${total}]：${name}`
            : '准备导入…';
        uploadBtn.disabled = true;
        uploadBtn.textContent = total ? `导入中 ${current}/${total}` : '导入中…';
        fileMeta.innerText = total ? `正在载入: ${name}` : '正在导入文件…';
        syncParamsBtn.disabled = true;
        setExportBusy(true, '导入中…');
    } else {
        importProgress.hidden = true;
        importProgressFill.style.width = '0%';
        uploadBtn.disabled = false;
        uploadBtn.textContent = '添加本地图片';
        syncParamsBtn.disabled = Object.keys(filesMap).length === 0;
        setExportBusy(false);
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
    batchSummary.innerText = `[ 已载入: ${totalFiles} 个文件 | 共 ${totalCrops} 张子图 ]`;
}

// 标签切换
tabItems.forEach(tab => {
    tab.addEventListener('click', () => {
        tabItems.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentDebugMode = tab.getAttribute('data-mode');
        log(`切换调试视图到: ${tab.innerText}`);

        if (currentFileId && filesMap[currentFileId]) {
            if (currentDebugMode === 'original' && filesMap[currentFileId].detected) {
                drawCanvas();
                renderCropPreviews();
            } else {
                requestPreview(currentFileId);
            }
        }
    });
});

// 日志折叠控制
if (consoleToggle) {
    consoleToggle.addEventListener('click', () => {
        isConsoleOpen = !isConsoleOpen;
        consoleDrawer.style.display = isConsoleOpen ? 'block' : 'none';
        consoleToggle.innerText = isConsoleOpen ? '控制台日志 ▼' : '控制台日志 ▲';
    });
}

// 上传与拖拽
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
        if (Object.keys(filesMap).length === 0) return;
        if (!confirm('确认清空所有已载入的图片吗？')) return;
        filesMap = {};
        currentFileId = null;
        renderFileList();
        updateBatchSummary();
        mainCanvas.style.display = 'none';
        dropZone.style.display = 'block';
        cropPreviewStrip.innerHTML = '<div class="empty-hint">暂无检出子图</div>';
        viewportInfo.innerText = '未选择文件';
        fileMeta.innerText = '等待文件载入...';
        syncParamsBtn.disabled = true;
        setExportBusy(false);
        log('已清空所有图片数据。');
    });
}

window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
        dragOverlay.style.display = 'flex';
    }
});

dragOverlay.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
        dragOverlay.style.display = 'none';
    }
});

dragOverlay.addEventListener('dragover', (e) => e.preventDefault());
dragOverlay.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOverlay.style.display = 'none';
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
    }
});

async function handleFiles(files) {
    if (files.length === 0 || isImporting) return;

    const fileList = Array.from(files).sort((a, b) => naturalCompare(a.name, b.name));
    log(`准备上传并预处理 ${fileList.length} 个文件...`);
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
                    debugImgSrc: null,
                    _cachedImg: null,
                    _edgeCanvas: null,
                    _edgeCtx: null
                };

                renderFileList();
                updateBatchSummary();
                await silentRequestPreview(fileId);
            } catch (err) {
                log(`上传通信异常: ${err}`);
            }
        }

        log(`批量文件上传处理完成。`);
        renderFileList();
        const sortedIds = getSortedFileIds();
        if (sortedIds.length > 0 && (!currentFileId || !filesMap[currentFileId])) {
            selectFile(sortedIds[0]);
        }
    } finally {
        setImportUi(false);
        if (Object.keys(filesMap).length > 0 && currentFileId) {
            fileMeta.innerText = `当前: ${filesMap[currentFileId].name} (${filesMap[currentFileId].width}×${filesMap[currentFileId].height})`;
        }
    }
}

function renderFileList() {
    fileListContainer.innerHTML = '';
    const sortedIds = getSortedFileIds();

    sortedIds.forEach(id => {
        const item = filesMap[id];
        const validRectsCount = (item.rects || []).filter(r => !r.excluded).length;

        const el = document.createElement('div');
        el.className = 'file-item' + (id === currentFileId ? ' active' : '');
        el.id = `file-${id}`;
        el.innerHTML = `
            <span class="file-name" title="${item.name}">${item.name}</span>
            <span class="badge" id="badge-${id}">${validRectsCount}</span>
        `;
        el.addEventListener('click', () => selectFile(id));
        fileListContainer.appendChild(el);
    });
}

function selectFile(fileId) {
    if (!filesMap[fileId]) return;
    currentFileId = fileId;
    const fileData = filesMap[fileId];

    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById(`file-${fileId}`);
    if (activeEl) {
        activeEl.classList.add('active');
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    dropZone.style.display = 'none';
    mainCanvas.style.display = 'block';

    fileMeta.innerText = `当前: ${fileData.name} (${fileData.width}×${fileData.height})`;
    viewportInfo.innerText = `[${fileData.name}] ${fileData.width}×${fileData.height} | 检出 ${fileData.rects.length} 张`;

    // 刷新右侧参数检查器
    syncInspectorControls(fileData.params);

    if (!fileData.detected) {
        requestPreview(fileId);
    } else if (currentDebugMode !== 'original') {
        requestPreview(fileId);
    } else {
        drawCanvas();
        renderCropPreviews();
    }
}

// 将指定参数同步到右侧面板
function syncInspectorControls(params) {
    if (!params) return;

    bgRadios.forEach(r => {
        r.checked = (r.value === params.bg_type);
    });
    blurSelect.value = params.blur_kernel;
    if (threshModeSelect) threshModeSelect.value = params.threshold_mode || 'fixed';

    threshRange.value = params.threshold;
    threshNum.value = params.threshold;
    threshValLabel.innerText = params.threshold;

    if (morphSizeRange) morphSizeRange.value = params.morph_size || 0;
    if (morphSizeNum) morphSizeNum.value = params.morph_size || 0;
    if (morphValLabel) morphValLabel.innerText = (params.morph_size || 0) + ' px';

    autoRotateCheck.checked = !!params.auto_rotate;

    minAreaRange.value = params.min_area_pct;
    minAreaInput.value = params.min_area_pct;
    minAreaValLabel.innerText = Number(params.min_area_pct).toFixed(2) + '%';

    maxAreaRange.value = params.max_area_pct;
    maxAreaInput.value = params.max_area_pct;
    maxAreaValLabel.innerText = Number(params.max_area_pct).toFixed(1) + '%';

    paddingRange.value = params.padding;
    paddingNum.value = params.padding;
    paddingValLabel.innerText = params.padding + ' px';
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
    if (!sessionId || !targetId || !filesMap[targetId]) return;

    const fileData = filesMap[targetId];

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
            log(`调试识别出错: ${data.error}`);
            return;
        }
        fileData.rects = mergeRectsPreserveFlip(fileData.rects, data.rects);
        fileData.debugImgSrc = data.debug_image;
        fileData.detected = true;

        if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();
        if (fileData.rects.length > 0 && fileData.selectedCropIndices.size === 0) {
            fileData.selectedCropIndices.add(0);
            fileData.selectedCropIndex = 0;
        }

        const validCount = (fileData.rects || []).filter(r => !r.excluded).length;
        const badge = document.getElementById(`badge-${targetId}`);
        if (badge) badge.innerText = validCount;

        if (targetId === currentFileId) {
            viewportInfo.innerText = `[${fileData.name}] ${fileData.width}×${fileData.height} | 检出 ${validCount} 张`;
            drawCanvas();
            if (!skipCropPreviews) renderCropPreviews();
        }

        updateBatchSummary();
    })
    .catch(err => {
        if (err.name === 'AbortError') return;
        log(`获取预览数据失败: ${err}`);
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

            updateBatchSummary();
            if (fileId === currentFileId) {
                drawCanvas();
                renderCropPreviews();
            }
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

function renderCropPreviews() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];

    if (rects.length === 0) {
        cropPreviewStrip.innerHTML = '<div class="empty-hint">暂无检出子图</div>';
        if (multiCountBadge) multiCountBadge.innerText = '已选 0 个';
        return;
    }

    const selIndices = fileData.selectedCropIndices || new Set();
    if (multiCountBadge) multiCountBadge.innerText = `已选 ${selIndices.size} 个`;

    const img = new Image();
    img.onload = () => {
        cropPreviewStrip.innerHTML = '';
        const autoRotate = !!fileData.params.auto_rotate;

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
                <span class="crop-label" style="${isExcluded ? 'color:#ff3b30;font-weight:bold;' : ''}">${isExcluded ? '[排] ' : ''}#${index + 1}${orientLabel ? ` · ${orientLabel}` : ''}</span>
            `;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                selectCrop(index, e.shiftKey || e.ctrlKey || e.metaKey);
            });
            cropPreviewStrip.appendChild(item);
        });
    };
    img.src = fileData.thumbnail;
}

function selectCrop(index, isMulti = false) {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    if (!fileData.rects[index]) return;

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

    if (multiCountBadge) multiCountBadge.innerText = `已选 ${fileData.selectedCropIndices.size} 个`;

    drawCanvas();
    renderCropPreviews();
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

function undo() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    if (!fileData.undoStack || fileData.undoStack.length === 0) {
        log(`[${fileData.name}] 无可撤销操作`);
        return;
    }

    const currentSnap = createSnapshot(currentFileId);
    if (!fileData.redoStack) fileData.redoStack = [];
    fileData.redoStack.push(currentSnap);

    const prevState = fileData.undoStack.pop();
    fileData.rects = JSON.parse(JSON.stringify(prevState.rects));
    fileData.selectedCropIndex = prevState.selectedCropIndex;
    fileData.selectedCropIndices = new Set(prevState.selectedCropIndices || [prevState.selectedCropIndex]);

    updateFileUiAfterRectsChange();
    log(`[${fileData.name}] 撤销操作 (Ctrl+Z)`);
}

function redo() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    if (!fileData.redoStack || fileData.redoStack.length === 0) {
        log(`[${fileData.name}] 无可重做操作`);
        return;
    }

    const currentSnap = createSnapshot(currentFileId);
    if (!fileData.undoStack) fileData.undoStack = [];
    fileData.undoStack.push(currentSnap);

    const nextState = fileData.redoStack.pop();
    fileData.rects = JSON.parse(JSON.stringify(nextState.rects));
    fileData.selectedCropIndex = nextState.selectedCropIndex;
    fileData.selectedCropIndices = new Set(nextState.selectedCropIndices || [nextState.selectedCropIndex]);

    updateFileUiAfterRectsChange();
    log(`[${fileData.name}] 重做操作 (Ctrl+Y)`);
}

function updateFileUiAfterRectsChange() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];

    const validCount = (fileData.rects || []).filter(r => !r.excluded).length;
    const badge = document.getElementById(`badge-${currentFileId}`);
    if (badge) badge.innerText = validCount;

    if (multiCountBadge) multiCountBadge.innerText = `已选 ${(fileData.selectedCropIndices ? fileData.selectedCropIndices.size : 0)} 个`;
    viewportInfo.innerText = `[${fileData.name}] ${fileData.width}×${fileData.height} | 检出 ${validCount} 张`;

    updateBatchSummary();
    drawCanvas();
    renderCropPreviews();
}

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

    drawCanvas();
    renderCropPreviews();
    log(`[${fileData.name}] 旋转选中的 ${selIndices.length} 个裁剪框 (${deltaDeg > 0 ? '+' : ''}${deltaDeg}°)。`);
}

function deleteSelectedCrop() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    const selIndices = fileData.selectedCropIndices && fileData.selectedCropIndices.size > 0
        ? Array.from(fileData.selectedCropIndices)
        : [fileData.selectedCropIndex];

    const validIndices = selIndices.filter(i => i >= 0 && i < rects.length).sort((a, b) => b - a);
    if (validIndices.length === 0) return;

    pushUndoState(currentFileId);

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

    updateFileUiAfterRectsChange();
    log(`[${fileData.name}] 删除 ${validIndices.length} 个选框，当前剩余 ${rects.length} 张。`);
}

function selectAllCrops() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];

    if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();
    fileData.selectedCropIndices.clear();

    rects.forEach((_, idx) => fileData.selectedCropIndices.add(idx));
    fileData.selectedCropIndex = rects.length > 0 ? 0 : -1;

    updateFileUiAfterRectsChange();
    log(`[${fileData.name}] 已全选所有 ${rects.length} 个选框。`);
}

function mergeSelectedCrops() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];

    const selIndices = Array.from(fileData.selectedCropIndices || []).sort((a, b) => a - b);
    if (selIndices.length < 2) {
        log(`[${fileData.name}] 请按住 Shift 至少选择 2 个框后再执行合并。`);
        return;
    }

    pushUndoState(currentFileId);

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

    for (let i = selIndices.length - 1; i >= 0; i--) {
        rects.splice(selIndices[i], 1);
    }

    rects.push(mergedRect);
    fileData.selectedCropIndices.clear();
    fileData.selectedCropIndex = rects.length - 1;
    fileData.selectedCropIndices.add(fileData.selectedCropIndex);

    updateFileUiAfterRectsChange();
    log(`[${fileData.name}] 成功合并 ${selIndices.length} 个框为一个新裁剪框。`);
}

function splitSelectedCrop(direction) {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];

    const idx = fileData.selectedCropIndex;
    if (idx < 0 || idx >= rects.length) return;

    pushUndoState(currentFileId);

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

    updateFileUiAfterRectsChange();
    log(`[${fileData.name}] 已将选框 #${idx + 1} ${direction === 'v' ? '垂直左右' : '水平上下'}二等分拆分。`);
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

async function autoOrientAllCrops() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    if (autoOrientBtn) {
        autoOrientBtn.disabled = true;
        autoOrientBtn.innerText = '正在智能预判朝向…';
    }

    try {
        pushUndoState(currentFileId);
        const res = await fetch('/api/auto_orient', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                file_id: currentFileId,
                rects: fileData.rects,
                bg_type: fileData.params.bg_type,
                auto_rotate: fileData.params.auto_rotate
            })
        });

        const data = await res.json();
        if (data.rects) {
            fileData.rects = data.rects;
            updateFileUiAfterRectsChange();
            log(`[${fileData.name}] ${data.message || '朝向智能预判校正完成。'}`);
        }
    } catch (err) {
        log(`智能朝向预判异常: ${err}`);
    } finally {
        if (autoOrientBtn) {
            autoOrientBtn.disabled = false;
            autoOrientBtn.innerText = '自动纠正所有朝向';
        }
    }
}

// 自由变换与手动操作状态管理器
let transformState = {
    mode: 'none',
    handleIndex: -1,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    rectIndex: -1,
    initialHandles: null,
    initialMultiRects: null,
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

function getEdgeSnap(x, y, isCtrlPressed) {
    if (isCtrlPressed || !currentFileId || !filesMap[currentFileId]) {
        return { x, y, snapped: false };
    }
    const fileData = filesMap[currentFileId];
    if (!fileData._cachedImg) return { x, y, snapped: false };

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

function hitTest(mx, my) {
    if (!currentFileId || !filesMap[currentFileId]) return { type: 'empty' };
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];

    const cssRect = mainCanvas.getBoundingClientRect();
    const scale = mainCanvas.width / (cssRect.width || mainCanvas.width);
    const handleRadius = Math.max(10, Math.min(26, 12 * scale));
    const rotateMargin = 32 * scale;

    const selIdx = fileData.selectedCropIndex;
    if (selIdx >= 0 && selIdx < rects.length) {
        const selRect = rects[selIdx];
        const hInfo = getTransformHandles(selRect);

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

mainCanvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !currentFileId || !filesMap[currentFileId]) return;

    const fileData = filesMap[currentFileId];
    const { x, y } = getCanvasCoords(mainCanvas, e);
    const hit = hitTest(x, y);
    const pendingSnapshot = createSnapshot(currentFileId);

    const isShift = e.shiftKey;
    const isAlt = e.altKey;

    if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();

    if (isAlt) {
        e.preventDefault();
        transformState = {
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

    if (hit.type === 'handle') {
        e.preventDefault();
        transformState = {
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

        drawCanvas();
        renderCropPreviews();

        const initialMulti = {};
        fileData.selectedCropIndices.forEach(idx => {
            if (fileData.rects[idx]) {
                const rInfo = getTransformHandles(fileData.rects[idx]);
                initialMulti[idx] = { cx: rInfo.cx, cy: rInfo.cy, w: rInfo.w, h: rInfo.h, angle: rInfo.angle };
            }
        });

        transformState = {
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
            e.preventDefault();
            transformState = {
                mode: 'marquee_select',
                startX: x,
                startY: y,
                currentX: x,
                currentY: y,
                pendingSnapshot,
                hasModified: false
            };
        } else {
            if (fileData.selectedCropIndices.size > 0) {
                fileData.selectedCropIndices.clear();
                fileData.selectedCropIndex = -1;
                drawCanvas();
                renderCropPreviews();
            }
            transformState = {
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
});

mainCanvas.addEventListener('mousemove', (e) => {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const { x, y } = getCanvasCoords(mainCanvas, e);

    if (transformState.mode === 'none') {
        const hit = hitTest(x, y);
        if (e.altKey) {
            mainCanvas.style.cursor = 'crosshair';
        } else if (hit.type === 'handle') {
            mainCanvas.style.cursor = getHandleCursor(hit.info, hit.index);
        } else if (hit.type === 'rotate') {
            mainCanvas.style.cursor = getRotateCursor(hit.cx, hit.cy, x, y);
        } else if (hit.type === 'inside' || hit.type === 'other_rect') {
            mainCanvas.style.cursor = 'move';
        } else {
            mainCanvas.style.cursor = 'default';
        }
    }
});

mainCanvas.addEventListener('mouseleave', () => {
    if (transformState.mode === 'none') {
        mainCanvas.style.cursor = 'default';
    }
});

window.addEventListener('mousemove', (e) => {
    if (!transformState || transformState.mode === 'none' || !currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    let { x, y } = getCanvasCoords(mainCanvas, e);
    const isCtrlPressed = e.ctrlKey || e.metaKey;

    if (transformState.mode === 'moving') {
        mainCanvas.style.cursor = 'move';
        const snapped = getEdgeSnap(x, y, isCtrlPressed);
        const dx = snapped.x - transformState.startX;
        const dy = snapped.y - transformState.startY;

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
        drawCanvas();
    } else if (transformState.mode === 'resizing') {
        mainCanvas.style.cursor = getHandleCursor(transformState.initialHandles, transformState.handleIndex);
        const snapped = getEdgeSnap(x, y, isCtrlPressed);
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
            drawCanvas();
        }
    } else if (transformState.mode === 'rotating') {
        const init = transformState.initialHandles;
        mainCanvas.style.cursor = getRotateCursor(init.cx, init.cy, x, y);
        const rect = fileData.rects[transformState.rectIndex];
        if (rect) {
            const dAng = (Math.atan2(y - init.cy, x - init.cx) - Math.atan2(transformState.startY - init.cy, transformState.startX - init.cx)) * 180 / Math.PI;
            let new_angle = (init.angle + dAng) % 360;
            if (e.shiftKey) new_angle = Math.round(new_angle / 15) * 15;
            updateRectFromParams(rect, init.cx, init.cy, init.w, init.h, new_angle);
            transformState.hasModified = true;
            drawCanvas();
        }
    } else if (transformState.mode === 'drawing_new' || transformState.mode === 'marquee_select') {
        mainCanvas.style.cursor = 'crosshair';
        transformState.currentX = x;
        transformState.currentY = y;
        drawCanvas();
    }
});

window.addEventListener('mouseup', (e) => {
    if (!transformState || transformState.mode === 'none' || !currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];

    if (transformState.mode === 'marquee_select') {
        const x0 = Math.min(transformState.startX, transformState.currentX);
        const y0 = Math.min(transformState.startY, transformState.currentY);
        const w0 = Math.abs(transformState.currentX - transformState.startX);
        const h0 = Math.abs(transformState.currentY - transformState.startY);

        if (w0 >= 10 && h0 >= 10) {
            if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();
            (fileData.rects || []).forEach((r, idx) => {
                const rx = r.x, ry = r.y, rw = r.w, rh = r.h;
                const intersects = !(rx + rw < x0 || rx > x0 + w0 || ry + rh < y0 || ry > y0 + h0);
                if (intersects) fileData.selectedCropIndices.add(idx);
            });
            if (fileData.selectedCropIndices.size > 0) {
                fileData.selectedCropIndex = Array.from(fileData.selectedCropIndices)[0];
            }
            updateFileUiAfterRectsChange();
            log(`[${fileData.name}] 矩形多选，当前选中 ${fileData.selectedCropIndices.size} 个框。`);
        } else {
            drawCanvas();
        }
    } else if (transformState.mode === 'drawing_new') {
        const { x, y } = getCanvasCoords(mainCanvas, e);
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

            updateFileUiAfterRectsChange();
            log(`[${fileData.name}] ${isExclude ? '新建排除区' : '新建框选'} #${fileData.rects.length} (${Math.round(w0)}×${Math.round(h0)})`);
        } else {
            drawCanvas();
        }
    } else if (transformState.mode === 'moving' || transformState.mode === 'resizing' || transformState.mode === 'rotating') {
        if (transformState.hasModified && transformState.pendingSnapshot) {
            pushUndoState(currentFileId, transformState.pendingSnapshot);
        }
        renderCropPreviews();
    } else {
        renderCropPreviews();
    }

    transformState.mode = 'none';
});

// 快捷键管理
window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    const isCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (isCtrl && key === 'a') {
        e.preventDefault();
        selectAllCrops();
        return;
    }
    if (isCtrl && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
    }
    if (isCtrl && key === 'y') {
        e.preventDefault();
        redo();
        return;
    }

    if (!isCtrl) {
        if (key === 'z') {
            e.preventDefault();
            rotateSelectedCrop(-90);
        } else if (key === 'c') {
            e.preventDefault();
            rotateSelectedCrop(90);
        } else if (key === 'm') {
            e.preventDefault();
            mergeSelectedCrops();
        } else if (key === 'v') {
            e.preventDefault();
            splitSelectedCrop('v');
        } else if (key === 'h') {
            e.preventDefault();
            splitSelectedCrop('h');
        } else if (key === 'x') {
            e.preventDefault();
            if (!currentFileId || !filesMap[currentFileId]) return;
            const fileData = filesMap[currentFileId];
            const rects = fileData.rects || [];
            const selIndices = fileData.selectedCropIndices && fileData.selectedCropIndices.size > 0
                ? Array.from(fileData.selectedCropIndices)
                : [fileData.selectedCropIndex];

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
            updateFileUiAfterRectsChange();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteSelectedCrop();
        }
    }
});

function drawCanvas() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];

    const canvasCtx = mainCanvas.getContext('2d');
    const isAutoRotate = !!fileData.params.auto_rotate;

    const imageSrc = currentDebugMode === 'original' ? fileData.thumbnail : fileData.debugImgSrc;
    if (!imageSrc) return;

    const render = (img) => {
        if (mainCanvas.width !== img.width || mainCanvas.height !== img.height) {
            mainCanvas.width = img.width;
            mainCanvas.height = img.height;
        } else {
            canvasCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
        }

        canvasCtx.imageSmoothingEnabled = true;
        canvasCtx.imageSmoothingQuality = 'high';
        canvasCtx.drawImage(img, 0, 0);

        if (currentDebugMode === 'original') {
            const strokeColor = '#ffff00';
            const selectedColor = '#00e5ff';
            const multiSelectColor = '#29b6f6';
            const rects = fileData.rects || [];

            const calculatedLineWidth = Math.max(2, Math.round(mainCanvas.width / 350));
            const fontSize = Math.max(12, Math.round(mainCanvas.width / 80));
            const paddingOffset = Math.round(fontSize * 0.25);
            const handlePx = Math.max(8, Math.min(22, Math.round(mainCanvas.width / 140)));

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

                    canvasCtx.fillStyle = currentStroke;
                    canvasCtx.font = `bold ${fontSize}px Consolas, monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const angleStr = Math.abs(hInfo.angle) > 0.05 ? ` ${hInfo.angle > 0 ? '+' : ''}${hInfo.angle.toFixed(1)}°` : '';
                    const labelPrefix = isExcluded ? '[排 ' : '[';
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
                    canvasCtx.font = `bold ${fontSize}px Consolas, monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const labelPrefix = isExcluded ? '[排 ' : '[';
                    const multiMark = (selIndices.size > 1 && isSelected) ? ' ✓' : '';
                    const label = `${labelPrefix}#${index + 1}]${orientLabel ? ' ' + orientLabel : ''}${multiMark}`;
                    const textWidth = canvasCtx.measureText(label).width;

                    const rectH = fontSize + (paddingOffset * 2);
                    const rectY = rect.y - rectH > 0 ? rect.y - rectH : 0;

                    canvasCtx.fillRect(rect.x, rectY, textWidth + (paddingOffset * 2), rectH);
                    canvasCtx.fillStyle = isExcluded ? '#ffffff' : '#000000';
                    canvasCtx.fillText(label, rect.x + paddingOffset, rectY + fontSize);
                }

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

            if (transformState && transformState.mode === 'marquee_select') {
                const x0 = Math.min(transformState.startX, transformState.currentX);
                const y0 = Math.min(transformState.startY, transformState.currentY);
                const w0 = Math.abs(transformState.currentX - transformState.startX);
                const h0 = Math.abs(transformState.currentY - transformState.startY);

                canvasCtx.save();
                canvasCtx.strokeStyle = '#29b6f6';
                canvasCtx.lineWidth = 1.5;
                canvasCtx.setLineDash([4, 4]);
                canvasCtx.strokeRect(x0, y0, w0, h0);
                canvasCtx.fillStyle = 'rgba(41, 182, 246, 0.15)';
                canvasCtx.fillRect(x0, y0, w0, h0);
                canvasCtx.restore();
            } else if (transformState && transformState.mode === 'drawing_new') {
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

// 绑定右侧全局面板事件
function bindInspectorEvents() {
    let debounceTimer = null;
    const triggerUpdate = (skipPreviews = true) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (currentFileId) requestPreview(currentFileId, skipPreviews);
        }, 16);
    };

    bgRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (!currentFileId || !filesMap[currentFileId]) return;
            filesMap[currentFileId].params.bg_type = e.target.value;
            requestPreview(currentFileId, false);
        });
    });

    blurSelect.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.blur_kernel = parseInt(e.target.value);
        requestPreview(currentFileId, false);
    });

    if (threshModeSelect) {
        threshModeSelect.addEventListener('change', (e) => {
            if (!currentFileId || !filesMap[currentFileId]) return;
            filesMap[currentFileId].params.threshold_mode = e.target.value;
            log(`[${filesMap[currentFileId].name}] 二值化模式: ${e.target.options[e.target.selectedIndex].text}`);
            requestPreview(currentFileId, false);
        });
    }

    threshRange.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        threshNum.value = e.target.value;
        threshValLabel.innerText = e.target.value;
        filesMap[currentFileId].params.threshold = parseInt(e.target.value);
        triggerUpdate(true);
    });
    threshRange.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.threshold = parseInt(e.target.value);
        requestPreview(currentFileId, false);
    });
    threshNum.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        let val = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
        threshRange.value = val;
        threshValLabel.innerText = val;
        filesMap[currentFileId].params.threshold = val;
        triggerUpdate(true);
    });
    threshNum.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        let val = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
        threshRange.value = val;
        threshValLabel.innerText = val;
        filesMap[currentFileId].params.threshold = val;
        requestPreview(currentFileId, false);
    });

    if (estimateThreshBtn) {
        estimateThreshBtn.addEventListener('click', async () => {
            if (!currentFileId || !filesMap[currentFileId]) return;
            try {
                estimateThreshBtn.disabled = true;
                estimateThreshBtn.innerText = '…';
                const res = await fetch('/api/estimate_threshold', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: sessionId,
                        file_id: currentFileId,
                        bg_type: filesMap[currentFileId].params.bg_type
                    })
                });
                const data = await res.json();
                if (data.threshold !== undefined) {
                    filesMap[currentFileId].params.threshold = data.threshold;
                    threshRange.value = data.threshold;
                    threshNum.value = data.threshold;
                    threshValLabel.innerText = data.threshold;
                    log(`[${filesMap[currentFileId].name}] 大津法估算阈值: ${data.threshold}`);
                    requestPreview(currentFileId, false);
                }
            } catch (err) {
                log(`估算阈值失败: ${err}`);
            } finally {
                estimateThreshBtn.disabled = false;
                estimateThreshBtn.innerText = '估算';
            }
        });
    }

    if (morphSizeRange) {
        morphSizeRange.addEventListener('input', (e) => {
            if (!currentFileId || !filesMap[currentFileId]) return;
            const val = parseInt(e.target.value) || 0;
            morphSizeNum.value = val;
            morphValLabel.innerText = val + ' px';
            filesMap[currentFileId].params.morph_size = val;
            triggerUpdate(true);
        });
        morphSizeRange.addEventListener('change', (e) => {
            if (!currentFileId || !filesMap[currentFileId]) return;
            filesMap[currentFileId].params.morph_size = parseInt(e.target.value) || 0;
            requestPreview(currentFileId, false);
        });
        morphSizeNum.addEventListener('input', (e) => {
            if (!currentFileId || !filesMap[currentFileId]) return;
            const val = Math.max(0, Math.min(15, parseInt(e.target.value) || 0));
            morphSizeRange.value = val;
            morphValLabel.innerText = val + ' px';
            filesMap[currentFileId].params.morph_size = val;
            triggerUpdate(true);
        });
        morphSizeNum.addEventListener('change', (e) => {
            if (!currentFileId || !filesMap[currentFileId]) return;
            filesMap[currentFileId].params.morph_size = Math.max(0, Math.min(15, parseInt(e.target.value) || 0));
            requestPreview(currentFileId, false);
        });
    }

    autoRotateCheck.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.auto_rotate = e.target.checked;
        drawCanvas();
        renderCropPreviews();
    });

    minAreaRange.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        const val = parseFloat(e.target.value) || 0.05;
        minAreaInput.value = val;
        minAreaValLabel.innerText = val.toFixed(2) + '%';
        filesMap[currentFileId].params.min_area_pct = val;
        triggerUpdate(true);
    });
    minAreaRange.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.min_area_pct = parseFloat(e.target.value) || 0.05;
        requestPreview(currentFileId, false);
    });
    minAreaInput.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        const val = parseFloat(e.target.value) || 0.05;
        minAreaRange.value = Math.min(20, val);
        minAreaValLabel.innerText = val.toFixed(2) + '%';
        filesMap[currentFileId].params.min_area_pct = val;
        triggerUpdate(true);
    });
    minAreaInput.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.min_area_pct = parseFloat(e.target.value) || 0.05;
        requestPreview(currentFileId, false);
    });

    maxAreaRange.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        const val = parseFloat(e.target.value) || 100.0;
        maxAreaInput.value = val;
        maxAreaValLabel.innerText = val.toFixed(1) + '%';
        filesMap[currentFileId].params.max_area_pct = val;
        triggerUpdate(true);
    });
    maxAreaRange.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.max_area_pct = parseFloat(e.target.value) || 100.0;
        requestPreview(currentFileId, false);
    });
    maxAreaInput.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        const val = parseFloat(e.target.value) || 100.0;
        maxAreaRange.value = val;
        maxAreaValLabel.innerText = val.toFixed(1) + '%';
        filesMap[currentFileId].params.max_area_pct = val;
        triggerUpdate(true);
    });
    maxAreaInput.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.max_area_pct = parseFloat(e.target.value) || 100.0;
        requestPreview(currentFileId, false);
    });

    paddingRange.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        paddingNum.value = e.target.value;
        paddingValLabel.innerText = e.target.value + ' px';
        filesMap[currentFileId].params.padding = parseInt(e.target.value);
        triggerUpdate(true);
    });
    paddingRange.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        filesMap[currentFileId].params.padding = parseInt(e.target.value);
        requestPreview(currentFileId, false);
    });
    paddingNum.addEventListener('input', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        let val = Math.max(-50, Math.min(50, parseInt(e.target.value) || 0));
        paddingRange.value = val;
        paddingValLabel.innerText = val + ' px';
        filesMap[currentFileId].params.padding = val;
        triggerUpdate(true);
    });
    paddingNum.addEventListener('change', (e) => {
        if (!currentFileId || !filesMap[currentFileId]) return;
        let val = Math.max(-50, Math.min(50, parseInt(e.target.value) || 0));
        paddingRange.value = val;
        paddingValLabel.innerText = val + ' px';
        filesMap[currentFileId].params.padding = val;
        requestPreview(currentFileId, false);
    });

    autoOrientBtn.addEventListener('click', () => autoOrientAllCrops());
    mergeCropsBtn.addEventListener('click', () => mergeSelectedCrops());
    selectAllBtn.addEventListener('click', () => selectAllCrops());
    splitVCropBtn.addEventListener('click', () => splitSelectedCrop('v'));
    splitHCropBtn.addEventListener('click', () => splitSelectedCrop('h'));
    delCropBtn.addEventListener('click', () => deleteSelectedCrop());
    reDetectBtn.addEventListener('click', () => {
        if (currentFileId) requestPreview(currentFileId);
    });
}

bindInspectorEvents();

syncParamsBtn.addEventListener('click', () => {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const srcParams = { ...filesMap[currentFileId].params };
    log(`正在将 [${filesMap[currentFileId].name}] 的调优参数同步到所有图片...`);

    Object.keys(filesMap).forEach(fileId => {
        if (fileId === currentFileId) return;
        filesMap[fileId].params = { ...srcParams };
        silentRequestPreview(fileId);
    });
    log(`全量参数同步重算完成。`);
});

exportBtn.addEventListener('click', async () => {
    if (!sessionId || Object.keys(filesMap).length === 0) return;

    const exportType = exportTypeSelect.value;
    const exportFormat = (exportFormatSelect ? exportFormatSelect.value : 'jpg').toLowerCase();
    const namingTemplate = (namingTemplateInput && namingTemplateInput.value.trim())
        ? namingTemplateInput.value.trim()
        : '{original}_crop_{index:02d}';
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

    log(`开始批量裁剪。格式: ${exportFormat.toUpperCase()}，模板: ${namingTemplate}，总文件: ${totalFiles}，子图约 ${totalRects} 张，模式: ${exportType}${flat ? ' (平铺)' : ''}`);
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
