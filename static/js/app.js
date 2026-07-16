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
        totalCrops += (filesMap[id].rects || []).length;
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

    const fileList = Array.from(files);
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
                            <span>最小面积占比 (%) <span style="cursor:help;color:var(--accent-color);font-weight:bold;" title="任何面积占比小于此阈值的噪点和斑点都会被忽略。">[?]</span></span>
                        </div>
                        <input type="number" id="minArea-${fileId}" min="0.1" max="100" step="0.1" value="3.0" style="width:100%; background:var(--bg-primary); color:var(--text-main); border:1px solid var(--border-color); font-size:11px; padding:3px; box-sizing:border-box;">
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
                    detected: false,
                    selectedCropIndex: 0,
                    params: {
                        blur_kernel: 3,
                        threshold: 200,
                        bg_type: 'light',
                        min_area_pct: 3.0,
                        max_area_pct: 80.0,
                        padding: 5,
                        auto_rotate: true
                    },
                    canvasEl: canvasEl,
                    containerEl: pageEl,
                    debugImgSrc: null
                };

                bindLocalEvents(fileId);
                renderFileList();
                updateBatchSummary();

                // 导入阶段只后台检测，不切换选中，避免中途乱跳
                await silentRequestPreview(fileId);
            } catch (err) {
                log(`上传接口通信异常: ${err}`);
            }
        }

        log(`所有上传处理完成。`);
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
    minAreaInput.addEventListener('change', (e) => {
        fileData.params.min_area_pct = parseFloat(e.target.value) || 0.1;
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
}

function renderFileList() {
    fileListContainer.innerHTML = '';

    const sortedItems = getSortedFileIds().map(id => ({
        id,
        name: filesMap[id].name,
        rectsCount: (filesMap[id].rects || []).length
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
    if (activeEl) activeEl.classList.add('active');

    document.querySelectorAll('.canvas-page').forEach(el => el.classList.remove('active'));
    const activePage = fileData.containerEl;
    if (activePage) activePage.classList.add('active');

    fileMeta.innerText = `当前文件: ${fileData.name} (${fileData.width} x ${fileData.height})`;

    if (autoScroll && activePage) {
        isProgrammaticScrolling = true;
        activePage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
            const orient = getRectOrient(rect);
            const orientLabel = formatOrientLabel(orient);
            const item = document.createElement('div');
            item.className = 'crop-preview-item' + (index === fileData.selectedCropIndex ? ' selected' : '');
            const src = buildCropPreviewDataUrl(img, rect, autoRotate, fileData.params.bg_type);
            item.innerHTML = `
                ${orientLabel ? `<span class="flip-badge">${orientLabel}</span>` : ''}
                <img alt="crop ${index + 1}" src="${src}">
                <span class="crop-label">#${index + 1}${orientLabel ? ` · ${orientLabel}` : ''}</span>
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

function rotateSelectedCrop(deltaDeg) {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

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

window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const key = e.key;
    if (key === 'z' || key === 'Z') {
        e.preventDefault();
        rotateSelectedCrop(-90); // 向左（逆时针）90°
    } else if (key === 'c' || key === 'C') {
        e.preventDefault();
        rotateSelectedCrop(90); // 向右（顺时针）90°
    } else if (key === 'x' || key === 'X') {
        e.preventDefault();
        rotateSelectedCrop(180);
    }
});
function drawCanvas(fileId) {
    const fileData = filesMap[fileId];
    if (!fileData) return;

    const canvas = fileData.canvasEl;
    const canvasCtx = canvas.getContext('2d');
    const isAutoRotate = document.getElementById(`autoRotate-${fileId}`).checked;

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

            rects.forEach((rect, index) => {
                const isSelected = index === fileData.selectedCropIndex;
                canvasCtx.strokeStyle = isSelected ? selectedColor : strokeColor;
                canvasCtx.lineWidth = calculatedLineWidth + (isSelected ? 1 : 0);

                if (isAutoRotate && rect.rotated && rect.rotated.points) {
                    const pts = rect.rotated.points;
                    canvasCtx.beginPath();
                    canvasCtx.moveTo(pts[0][0], pts[0][1]);
                    canvasCtx.lineTo(pts[1][0], pts[1][1]);
                    canvasCtx.lineTo(pts[2][0], pts[2][1]);
                    canvasCtx.lineTo(pts[3][0], pts[3][1]);
                    canvasCtx.closePath();
                    canvasCtx.stroke();

                    canvasCtx.fillStyle = isSelected ? selectedColor : strokeColor;
                    canvasCtx.font = `bold ${fontSize}px monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const label = `[#${index + 1}]${orientLabel ? ' ' + orientLabel : ''}`;
                    const textWidth = canvasCtx.measureText(label).width;

                    const rectH = fontSize + (paddingOffset * 2);
                    const rectY = pts[0][1] - rectH > 0 ? pts[0][1] - rectH : 0;

                    canvasCtx.fillRect(pts[0][0], rectY, textWidth + (paddingOffset * 2), rectH);
                    canvasCtx.fillStyle = '#000000';
                    canvasCtx.fillText(label, pts[0][0] + paddingOffset, rectY + fontSize);
                } else {
                    canvasCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

                    canvasCtx.fillStyle = isSelected ? selectedColor : strokeColor;
                    canvasCtx.font = `bold ${fontSize}px monospace`;
                    const orientLabel = formatOrientLabel(getRectOrient(rect));
                    const label = `[#${index + 1}]${orientLabel ? ' ' + orientLabel : ''}`;
                    const textWidth = canvasCtx.measureText(label).width;

                    const rectH = fontSize + (paddingOffset * 2);
                    const rectY = rect.y - rectH > 0 ? rect.y - rectH : 0;

                    canvasCtx.fillRect(rect.x, rectY, textWidth + (paddingOffset * 2), rectH);
                    canvasCtx.fillStyle = '#000000';
                    canvasCtx.fillText(label, rect.x + paddingOffset, rectY + fontSize);
                }
            });
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
        rects: filesMap[fileId].rects || [],
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
