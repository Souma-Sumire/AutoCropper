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
const batchSummary = document.getElementById('batchSummary');
const fileListContainer = document.getElementById('fileListContainer');
const stateSaveIndicator = document.getElementById('stateSaveIndicator');

// 导出保存位置相关 DOM
const exportRadioCustom = document.getElementById('exportRadioCustom');
const exportRadioSubfolder = document.getElementById('exportRadioSubfolder');
const exportRadioZip = document.getElementById('exportRadioZip');
const customPathInput = document.getElementById('customPathInput');
const subfolderInput = document.getElementById('subfolderInput');
const exportTypeSelect = document.getElementById('exportType');
const exportFormatSelect = document.getElementById('exportFormat');
const namingTemplateInput = document.getElementById('namingTemplate');
const flatExportCheck = document.getElementById('flatExport');
const exportBtn = document.getElementById('exportBtn');
const statusToast = document.getElementById('statusToast');

// DOM 节点 - 中间视口
const canvasViewport = document.getElementById('canvasViewport');
const streamContainer = document.getElementById('streamContainer');
const dropZone = document.getElementById('dropZone');
const mainCanvas = document.getElementById('mainCanvas');
const statusbarMsg = document.getElementById('statusbarMsg');
const consoleToggle = document.getElementById('consoleToggle');
const consoleDrawer = document.getElementById('consoleDrawer');
const consoleLog = document.getElementById('consoleLog');
const dragOverlay = document.getElementById('dragOverlay');
const viewportLoading = document.getElementById('viewportLoading');
const loadingProgressFill = document.getElementById('loadingProgressFill');
const loadingPercentText = document.getElementById('loadingPercentText');
const loadingFilename = document.getElementById('loadingFilename');
const loadingCountText = document.getElementById('loadingCountText');
const loadingDetail = document.getElementById('loadingDetail');

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
    if (exportTypeSelect) exportTypeSelect.disabled = busy || isImporting;
    if (exportRadioCustom) exportRadioCustom.disabled = busy || isImporting;
    if (exportRadioSubfolder) exportRadioSubfolder.disabled = busy || isImporting;
    if (exportRadioZip) exportRadioZip.disabled = busy || isImporting;
    if (customPathInput && !exportRadioCustom?.checked) customPathInput.disabled = true;
    if (subfolderInput && !exportRadioSubfolder?.checked) subfolderInput.disabled = true;
    if (exportFormatSelect) exportFormatSelect.disabled = busy || isImporting;
    if (namingTemplateInput) namingTemplateInput.disabled = busy || isImporting;
    if (flatExportCheck) flatExportCheck.disabled = busy || isImporting;
}

let toastTimer = null;
function showToast(message, duration = 2000) {
    if (!statusToast) return;
    statusToast.innerText = message;
    statusToast.style.display = 'block';
    statusToast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        statusToast.style.opacity = '0';
        setTimeout(() => {
            statusToast.style.display = 'none';
        }, 200);
    }, duration);
}

// 工作区状态持久化与路径偏好记忆
const WORKSPACE_STORAGE_KEY = 'autocropper_saved_state_v2';
const PATH_PREF_KEY = 'autocropper_path_pref_v1';

function updateExportPathUi() {
    if (!exportPathModeSelect) return;
    const mode = exportPathModeSelect.value;
    if (mode === 'subfolder') {
        if (customPathInput) customPathInput.style.display = 'none';
        if (subfolderInput) subfolderInput.style.display = 'block';
    } else if (mode === 'custom') {
        if (customPathInput) customPathInput.style.display = 'block';
        if (subfolderInput) subfolderInput.style.display = 'none';
    } else {
        if (customPathInput) customPathInput.style.display = 'none';
        if (subfolderInput) subfolderInput.style.display = 'none';
    }
    updateExportDestHint();
    savePathPreferences();
}

function savePathPreferences() {
    try {
        const mode = exportPathModeSelect ? exportPathModeSelect.value : 'subfolder';
        const pref = {
            mode,
            customPath: customPathInput ? customPathInput.value : '',
            subfolder: subfolderInput ? subfolderInput.value : 'output',
            format: exportFormatSelect ? exportFormatSelect.value : 'jpg',
            naming: namingTemplateInput ? namingTemplateInput.value : '{original}_{index:02d}',
            flat: !!(flatExportCheck && flatExportCheck.checked)
        };
        localStorage.setItem(PATH_PREF_KEY, JSON.stringify(pref));
    } catch (_) {}
}

function loadPathPreferences() {
    try {
        const raw = localStorage.getItem(PATH_PREF_KEY);
        if (!raw) return;
        const pref = JSON.parse(raw);
        if (pref.customPath && customPathInput) customPathInput.value = pref.customPath;
        if (pref.subfolder && subfolderInput) subfolderInput.value = pref.subfolder;
        if (pref.format && exportFormatSelect) exportFormatSelect.value = pref.format;
        if (pref.naming && namingTemplateInput) namingTemplateInput.value = pref.naming;
        if (typeof pref.flat === 'boolean' && flatExportCheck) flatExportCheck.checked = pref.flat;

        if (pref.mode && exportPathModeSelect) {
            exportPathModeSelect.value = pref.mode;
        }
        updateExportPathUi();
    } catch (_) {}
}

function saveWorkspaceState(isManual = false) {
    if (isImporting) return;
    savePathPreferences();

    const fileIds = Object.keys(filesMap);
    if (fileIds.length === 0 || !sessionId) {
        if (isManual) showToast('当前暂无可保存的工作区数据');
        return;
    }

    try {
        const filesData = fileIds.map(fid => {
            const f = filesMap[fid];
            return {
                fileId: fid,
                name: f.name,
                width: f.width,
                height: f.height,
                params: f.params,
                rects: f.rects || [],
                debugMode: f.debugMode || 'original',
                selectedCropIndex: f.selectedCropIndex,
                selectedCropIndices: Array.from(f.selectedCropIndices || [])
            };
        });

        const stateObj = {
            version: 2,
            timestamp: Date.now(),
            sessionId: sessionId,
            currentFileId: currentFileId,
            files: filesData
        };

        localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(stateObj));

        const draftIndicator = document.getElementById('draftIndicator');
        if (draftIndicator) {
            draftIndicator.innerText = '● 草稿已暂存';
            draftIndicator.classList.add('saved');
        }

        if (isManual) {
            let totalRects = 0;
            fileIds.forEach(id => {
                totalRects += (filesMap[id].rects || []).filter(r => !r.excluded).length;
            });
            showToast(`草稿已暂存至浏览器 (共 ${fileIds.length} 张原图 · ${totalRects} 个切片，关闭网页不丢失)`);
            log(`编辑草稿已成功暂存到浏览器缓存 (Ctrl+S)`);
        }
    } catch (e) {
        log(`保存状态异常: ${e}`);
        if (isManual) showToast('保存状态异常，请查看控制台');
    }
}

let autoSaveTimer = null;
function scheduleAutoSaveState() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        saveWorkspaceState(false);
    }, 500);
}

async function restoreWorkspaceState() {
    loadPathPreferences();

    try {
        const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
        if (!raw) return;
        const stateObj = JSON.parse(raw);
        if (!stateObj || !stateObj.sessionId || !Array.isArray(stateObj.files) || stateObj.files.length === 0) {
            return;
        }

        const checkRes = await fetch('/api/check_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: stateObj.sessionId })
        });
        const checkData = await checkRes.json();
        if (!checkData.valid) {
            log('检测到历史工作区记录，但服务端缓存已过期，请重新添加图片。');
            return;
        }

        sessionId = stateObj.sessionId;
        filesMap = {};

        stateObj.files.forEach(f => {
            const fid = f.fileId;
            filesMap[fid] = {
                name: f.name,
                width: f.width,
                height: f.height,
                thumbnail: `/api/get_file_preview?session_id=${sessionId}&file_id=${fid}`,
                rects: f.rects || [],
                undoStack: [],
                redoStack: [],
                detected: true,
                selectedCropIndex: (f.selectedCropIndex !== undefined) ? f.selectedCropIndex : 0,
                selectedCropIndices: new Set(f.selectedCropIndices || [0]),
                params: f.params || {
                    blur_kernel: 3,
                    threshold: 180,
                    threshold_mode: 'fixed',
                    morph_size: 0,
                    bg_type: 'light',
                    min_area_pct: 0.25,
                    max_area_pct: 80.0,
                    padding: 5,
                    auto_rotate: true
                },
                debugMode: f.debugMode || 'original',
                _cachedImg: null,
                _edgeCanvas: null,
                _edgeCtx: null
            };
        });

        currentFileId = stateObj.currentFileId && filesMap[stateObj.currentFileId]
            ? stateObj.currentFileId
            : Object.keys(filesMap)[0];

        renderFileList();
        updateBatchSummary();

        if (currentFileId) {
            selectFile(currentFileId, true);
        }

        showToast(`已恢复上次工作状态 (${stateObj.files.length} 个文件)`);
        log(`已自动恢复上次工作状态 (会话: ${sessionId.slice(0, 8)}..., 文件: ${stateObj.files.length} 个)`);
    } catch (err) {
        log(`恢复工作状态异常: ${err}`);
    }
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

function setImportUi(active, current = 0, total = 0, name = '', detail = '') {
    isImporting = active;
    if (active) {
        if (viewportLoading) viewportLoading.style.display = 'flex';
        const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

        if (loadingProgressFill) loadingProgressFill.style.width = `${pct}%`;
        if (loadingPercentText) loadingPercentText.innerText = `${pct}%`;
        if (loadingFilename) loadingFilename.innerText = name || '准备导入...';
        if (loadingCountText) loadingCountText.innerText = `[${Math.min(total, Math.ceil(current))} / ${total}]`;
        if (loadingDetail) loadingDetail.innerText = detail || '正在自适应测算阈值并分割子图...';

        uploadBtn.disabled = true;
        uploadBtn.textContent = total ? `导入中 ${Math.min(total, Math.ceil(current))}/${total}` : '导入中…';
        setExportBusy(true, '导入中…');
    } else {
        if (viewportLoading) viewportLoading.style.display = 'none';
        if (loadingProgressFill) loadingProgressFill.style.width = '0%';
        uploadBtn.disabled = false;
        uploadBtn.textContent = '添加本地图片';
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
    if (batchSummary) {
        batchSummary.innerText = `${totalFiles} 个文件 · 共 ${totalCrops} 张子图`;
    }

    if (exportBtn) {
        if (totalCrops > 0) {
            exportBtn.disabled = false;
            exportBtn.innerText = `保存全部切片到本地 (共 ${totalCrops} 张)`;
        } else {
            exportBtn.disabled = true;
            exportBtn.innerText = totalFiles > 0 ? '等待图片识别中...' : '保存切片到本地 (请先添加图片)';
        }
    }
}

function setFileDebugMode(fileId, mode) {
    const fid = fileId || currentFileId;
    if (!fid || !filesMap[fid]) return;
    const fileData = filesMap[fid];
    fileData.debugMode = mode;

    const cardTabs = document.querySelectorAll(`.card-tab-btn[data-file-id="${fid}"]`);
    cardTabs.forEach(btn => {
        if (btn.getAttribute('data-mode') === mode) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    if (fid === currentFileId) {
        currentDebugMode = mode;
    }

    const modeName = mode === 'original' ? '原图与选框' : mode === 'threshold' ? '二值化调试' : '灰度模糊';
    log(`[${fileData.name}] 切换视图到: ${modeName}`);

    if (mode === 'original' && fileData.detected) {
        drawCanvas(fid);
        renderCropPreviews(fid);
    } else {
        requestPreview(fid);
    }
}

// 犄角旮旯：右下角控制台弹层控制
const closeLogBtn = document.getElementById('closeLogBtn');
const clearLogBtn = document.getElementById('clearLogBtn');

if (consoleToggle) {
    consoleToggle.addEventListener('click', () => {
        isConsoleOpen = !isConsoleOpen;
        if (consoleDrawer) consoleDrawer.style.display = isConsoleOpen ? 'flex' : 'none';
        consoleToggle.innerText = isConsoleOpen ? '关闭控制台 ✕' : '控制台日志 ▤';
    });
}
if (closeLogBtn) {
    closeLogBtn.addEventListener('click', () => {
        isConsoleOpen = false;
        if (consoleDrawer) consoleDrawer.style.display = 'none';
        if (consoleToggle) consoleToggle.innerText = '控制台日志 ▤';
    });
}
if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
        if (consoleLog) consoleLog.value = '';
    });
}

// 上传与拖拽
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
        if (Object.keys(filesMap).length === 0) return;
        if (!confirm('确认清空所有已载入的图片吗？')) return;
        if (sessionId) {
            fetch('/api/clear_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId })
            }).catch(() => {});
            sessionId = null;
        }
        filesMap = {};
        currentFileId = null;
        renderFileList();
        updateBatchSummary();
        mainCanvas.style.display = 'none';
        if (streamContainer) {
            streamContainer.innerHTML = '';
            streamContainer.style.display = 'none';
        }
        dropZone.style.display = 'block';
        setExportBusy(false);
        log('已清空所有图片数据并释放本地临时缓存。');
    });
}

// 全局彻底拦截浏览器默认拖放行为，防止在标签页中直接打开图片
let dragCounter = 0;

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evtName => {
    window.addEventListener(evtName, (e) => {
        e.preventDefault();
    }, false);
    document.addEventListener(evtName, (e) => {
        e.preventDefault();
    }, false);
});

window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
        dragCounter++;
        if (dragOverlay) dragOverlay.style.display = 'flex';
    }
}, false);

window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
    }
}, false);

window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        if (dragOverlay) dragOverlay.style.display = 'none';
    }
}, false);

window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (dragOverlay) dragOverlay.style.display = 'none';
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
        handleFiles(dt.files);
    }
}, false);

if (dropZone) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }, false);
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        if (dragOverlay) dragOverlay.style.display = 'none';
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
            handleFiles(dt.files);
        }
    }, false);
}

async function handleFiles(files) {
    if (files.length === 0 || isImporting) return;

    const fileList = Array.from(files).sort((a, b) => naturalCompare(a.name, b.name));
    log(`准备上传并预处理 ${fileList.length} 个文件...`);
    setImportUi(true, 0, fileList.length, fileList[0]?.name || '', '准备批量导入与预处理...');

    try {
        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            setImportUi(true, i + 0.1, fileList.length, file.name, '正在上传原始图像并生成预览...');
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
                const autoThresh = (typeof data.suggested_threshold === 'number' && data.suggested_threshold > 0)
                    ? data.suggested_threshold
                    : 180;

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
                        threshold: autoThresh,
                        threshold_mode: 'fixed',
                        morph_size: 0,
                        bg_type: 'light',
                        min_area_pct: 0.25,
                        max_area_pct: 80.0,
                        padding: 5,
                        auto_rotate: true
                    },
                    debugImgSrc: null,
                    _cachedImg: null,
                    _edgeCanvas: null,
                    _edgeCtx: null
                };

                setImportUi(true, i + 0.6, fileList.length, file.name, `已匹配最佳阈值(${autoThresh})，正在自动检测裁剪框...`);
                renderFileList();
                updateBatchSummary();
                await silentRequestPreview(fileId);

                const validCrops = (filesMap[fileId].rects || []).filter(r => !r.excluded).length;
                setImportUi(true, i + 1, fileList.length, file.name, `已检出 ${validCrops} 张照片 [${i + 1}/${fileList.length}]`);
                log(`[${file.name}] 自动阈值: ${autoThresh}, 检出照片: ${validCrops} 张`);

                // 首张图片就绪后直接在底层激活显示
                if (!currentFileId && i === 0) {
                    selectFile(fileId);
                }
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
        el.addEventListener('click', () => selectFile(id, true));
        fileListContainer.appendChild(el);
    });

    renderStreamContainer();
}

function renderStreamContainer() {
    if (!streamContainer) return;
    const sortedIds = getSortedFileIds();
    if (sortedIds.length === 0) {
        streamContainer.style.display = 'none';
        dropZone.style.display = 'block';
        return;
    }

    dropZone.style.display = 'none';
    streamContainer.style.display = 'flex';

    sortedIds.forEach((fileId, index) => {
        let pageEl = document.getElementById(`page-${fileId}`);
        const item = filesMap[fileId];
        const validCount = (item.rects || []).filter(r => !r.excluded).length;
        const itemMode = item.debugMode || 'original';

        const isFixedMode = (item.params.threshold_mode === 'fixed');
        const threshDisabledAttr = isFixedMode ? '' : 'disabled';
        const threshDisabledStyle = isFixedMode ? '' : 'style="opacity: 0.4; cursor: not-allowed;"';
        let threshBadgeText = item.params.threshold;
        if (item.params.threshold_mode === 'otsu') threshBadgeText = `${item.params.threshold} (自动)`;
        else if (item.params.threshold_mode === 'adaptive') threshBadgeText = '自适应';

        if (!pageEl) {
            pageEl = document.createElement('div');
            pageEl.className = 'stream-page' + (fileId === currentFileId ? ' active' : '');
            pageEl.id = `page-${fileId}`;
            pageEl.dataset.fileId = fileId;
            pageEl.innerHTML = `
                <div class="stream-page-left">
                    <div class="stream-page-header">
                        <div class="stream-page-title">
                            <span class="stream-page-num">[#${index + 1}]</span>
                            <span class="stream-page-name" title="${item.name}">${item.name}</span>
                            <span class="stream-page-dim">(${item.width}×${item.height})</span>
                        </div>
                        <div class="stream-page-actions">
                            <div class="card-view-tabs" id="tabs-${fileId}">
                                <button class="card-tab-btn ${itemMode === 'original' ? 'active' : ''}" data-mode="original" data-file-id="${fileId}" title="原图与标框 (快捷键: 1)">1. 原图</button>
                                <button class="card-tab-btn ${itemMode === 'threshold' ? 'active' : ''}" data-mode="threshold" data-file-id="${fileId}" title="二值化调试图 (快捷键: 2)">2. 二值化</button>
                                <button class="card-tab-btn ${itemMode === 'blurred' ? 'active' : ''}" data-mode="blurred" data-file-id="${fileId}" title="灰度滤波图 (快捷键: 3)">3. 滤波</button>
                            </div>
                        </div>
                    </div>
                    <div class="stream-canvas-box">
                        <canvas id="canvas-${fileId}" class="stream-canvas"></canvas>
                    </div>
                    <div class="stream-crops-box">
                        <div class="stream-crop-strip" id="crop-strip-${fileId}">
                            <div class="empty-hint">暂无子图</div>
                        </div>
                    </div>
                </div>

                <div class="stream-page-right">
                    <div class="ctrl-group">
                        <div class="ctrl-label-row"><span>高斯滤波降噪</span></div>
                        <select id="blurKernel-${fileId}" class="select-input">
                            <option value="1" ${item.params.blur_kernel == 1 ? 'selected' : ''}>1 (无模糊)</option>
                            <option value="3" ${item.params.blur_kernel == 3 ? 'selected' : ''}>3 (推荐)</option>
                            <option value="5" ${item.params.blur_kernel == 5 ? 'selected' : ''}>5</option>
                            <option value="7" ${item.params.blur_kernel == 7 ? 'selected' : ''}>7</option>
                            <option value="9" ${item.params.blur_kernel == 9 ? 'selected' : ''}>9</option>
                            <option value="15" ${item.params.blur_kernel == 15 ? 'selected' : ''}>15</option>
                        </select>
                    </div>
                    <div class="ctrl-group">
                        <div class="ctrl-label-row"><span>二值化算法</span></div>
                        <select id="threshMode-${fileId}" class="select-input">
                            <option value="fixed" ${item.params.threshold_mode === 'fixed' ? 'selected' : ''}>固定阈值 (手动微调)</option>
                            <option value="otsu" ${item.params.threshold_mode === 'otsu' ? 'selected' : ''}>Otsu 大津法 (自动双峰)</option>
                            <option value="adaptive" ${item.params.threshold_mode === 'adaptive' ? 'selected' : ''}>自适应局部高斯</option>
                        </select>
                    </div>
                    <div class="ctrl-group">
                        <div class="ctrl-label-row">
                            <span>二值化阈值</span>
                        </div>
                        <div class="ctrl-input-row">
                            <input type="range" id="threshold-${fileId}" min="0" max="255" value="${item.params.threshold}" class="range-input" ${threshDisabledAttr} ${threshDisabledStyle}>
                            <input type="number" id="thresholdNum-${fileId}" min="0" max="255" value="${item.params.threshold}" class="num-input" ${threshDisabledAttr} ${threshDisabledStyle}>
                            <button id="estimateThreshBtn-${fileId}" class="btn-mini" title="估算最佳阈值" ${threshDisabledAttr} ${threshDisabledStyle}>估算</button>
                        </div>
                    </div>
                    <div class="ctrl-group">
                        <div class="ctrl-label-row"><span>形态学平滑 (px)</span></div>
                        <div class="ctrl-input-row">
                            <input type="range" id="morphSizeRange-${fileId}" min="0" max="15" value="${item.params.morph_size || 0}" class="range-input">
                            <input type="number" id="morphSizeNum-${fileId}" min="0" max="15" value="${item.params.morph_size || 0}" class="num-input">
                        </div>
                    </div>
                    <div class="ctrl-group">
                        <label class="checkbox-row">
                            <input type="checkbox" id="autoRotate-${fileId}" ${item.params.auto_rotate ? 'checked' : ''}>
                            <span>自动倾斜矫正 (摆正照片)</span>
                        </label>
                    </div>
                    <div class="ctrl-group">
                        <div class="ctrl-label-row"><span>最小面积占比 (%)</span></div>
                        <div class="ctrl-input-row">
                            <input type="range" id="minAreaRange-${fileId}" min="0.01" max="20" step="0.05" value="${item.params.min_area_pct}" class="range-input">
                            <input type="number" id="minArea-${fileId}" min="0.01" max="100" step="0.05" value="${item.params.min_area_pct}" class="num-input" style="width: 54px;">
                        </div>
                    </div>
                    <div class="ctrl-group">
                        <div class="ctrl-label-row"><span>最大面积占比 (%)</span></div>
                        <div class="ctrl-input-row">
                            <input type="range" id="maxAreaRange-${fileId}" min="5" max="100" step="0.5" value="${item.params.max_area_pct}" class="range-input">
                            <input type="number" id="maxArea-${fileId}" min="0.1" max="100" step="0.5" value="${item.params.max_area_pct}" class="num-input" style="width: 54px;">
                        </div>
                    </div>
                    <div class="ctrl-group">
                        <div class="ctrl-label-row"><span>外扩边缘 (px)</span></div>
                        <div class="ctrl-input-row">
                            <input type="range" id="padding-${fileId}" min="-20" max="20" value="${item.params.padding}" class="range-input">
                            <input type="number" id="paddingNum-${fileId}" min="-20" max="20" value="${item.params.padding}" class="num-input">
                        </div>
                    </div>
                    <div class="tool-divider"></div>
                    <div class="tool-grid">
                        <button id="reDetectBtn-${fileId}" class="btn-tool" title="以当前参数重新检测">重新检测</button>
                        <button id="syncParamsBtn-${fileId}" class="btn-tool" title="将当前参数同步到所有图片">同步至全部</button>
                    </div>
                    <div class="shortcut-tip-box">
                        <div class="shortcut-grid">
                            <div class="sc-cell"><kbd>Ctrl+A</kbd><span>全选选框</span></div>
                            <div class="sc-cell"><kbd>Del</kbd><span>删除选框</span></div>
                            <div class="sc-cell"><kbd>Ctrl+Z/Y</kbd><span>撤销/重做</span></div>
                            <div class="sc-cell"><kbd>Ctrl+S</kbd><span>暂存草稿</span></div>
                            <div class="sc-cell"><kbd>Z / C / X</kbd><span>旋转/翻转</span></div>
                            <div class="sc-cell"><kbd>V / H</kbd><span>纵/横拆分</span></div>
                            <div class="sc-cell"><kbd>M</kbd><span>合并选框</span></div>
                            <div class="sc-cell"><kbd>[ / ]</kbd><span>切换图片</span></div>
                            <div class="sc-cell"><kbd>Ctrl+拖</kbd><span>新建框</span></div>
                            <div class="sc-cell"><kbd>Alt+拖</kbd><span>排除区</span></div>
                            <div class="sc-cell"><kbd>Shift+点</kbd><span>多选</span></div>
                            <div class="sc-cell"><kbd>1 / 2 / 3</kbd><span>切换视图</span></div>
                        </div>
                    </div>
                </div>
            `;

            pageEl.querySelectorAll('.card-tab-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const mode = btn.getAttribute('data-mode');
                    selectFile(fileId, false);
                    setFileDebugMode(fileId, mode);
                });
            });

            pageEl.addEventListener('click', () => {
                if (currentFileId !== fileId) {
                    selectFile(fileId, false);
                }
            });

            streamContainer.appendChild(pageEl);

            const canvas = document.getElementById(`canvas-${fileId}`);
            if (canvas) {
                bindCanvasEvents(canvas, fileId);
            }
            bindCardEvents(fileId);
        } else {
            const numEl = pageEl.querySelector('.stream-page-num');
            if (numEl) numEl.innerText = `[#${index + 1}]`;
            pageEl.querySelectorAll('.card-tab-btn').forEach(btn => {
                if (btn.getAttribute('data-mode') === itemMode) btn.classList.add('active');
                else btn.classList.remove('active');
            });
            if (fileId === currentFileId) {
                pageEl.classList.add('active');
            } else {
                pageEl.classList.remove('active');
            }
        }

        drawCanvas(fileId);
        renderCropPreviews(fileId);
    });

    // 清除无用卡片
    const allCards = streamContainer.querySelectorAll('.stream-page');
    allCards.forEach(card => {
        const fid = card.dataset.fileId;
        if (!filesMap[fid]) card.remove();
    });
}

function bindCardEvents(fileId) {
    const fileData = filesMap[fileId];
    if (!fileData) return;

    const threshRange = document.getElementById(`threshold-${fileId}`);
    const threshNum = document.getElementById(`thresholdNum-${fileId}`);
    const threshLabel = document.getElementById(`threshValLabel-${fileId}`);
    const threshMode = document.getElementById(`threshMode-${fileId}`);
    const estimateBtn = document.getElementById(`estimateThreshBtn-${fileId}`);
    const morphRange = document.getElementById(`morphSizeRange-${fileId}`);
    const morphNum = document.getElementById(`morphSizeNum-${fileId}`);
    const morphLabel = document.getElementById(`morphValLabel-${fileId}`);
    const autoRot = document.getElementById(`autoRotate-${fileId}`);
    const blur = document.getElementById(`blurKernel-${fileId}`);
    const minRange = document.getElementById(`minAreaRange-${fileId}`);
    const minInput = document.getElementById(`minArea-${fileId}`);
    const minLabel = document.getElementById(`minAreaValLabel-${fileId}`);
    const maxRange = document.getElementById(`maxAreaRange-${fileId}`);
    const maxInput = document.getElementById(`maxArea-${fileId}`);
    const maxLabel = document.getElementById(`maxAreaValLabel-${fileId}`);
    const padRange = document.getElementById(`padding-${fileId}`);
    const padNum = document.getElementById(`paddingNum-${fileId}`);
    const padLabel = document.getElementById(`paddingValLabel-${fileId}`);

    let localDebounce = null;
    const triggerUpdate = (isSlider = false) => {
        clearTimeout(localDebounce);
        localDebounce = setTimeout(() => {
            requestPreview(fileId, false);
        }, isSlider ? 100 : 20);
    };

    if (threshRange && threshNum) {
        threshRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value) || 0;
            threshNum.value = v;
            if (threshLabel) threshLabel.innerText = v;
            fileData.params.threshold = v;
            triggerUpdate(true);
        });
        threshNum.addEventListener('change', (e) => {
            const v = Math.max(0, Math.min(255, parseInt(e.target.value) || 0));
            threshRange.value = v;
            threshNum.value = v;
            if (threshLabel) threshLabel.innerText = v;
            fileData.params.threshold = v;
            requestPreview(fileId, false);
        });
    }

    if (estimateBtn) {
        estimateBtn.addEventListener('click', async () => {
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
                    if (threshRange) threshRange.value = data.threshold;
                    if (threshNum) threshNum.value = data.threshold;
                    if (threshLabel) threshLabel.innerText = data.threshold;
                    log(`[${fileData.name}] 大津法估算阈值: ${data.threshold}`);
                    requestPreview(fileId, false);
                }
            } catch (err) {
                log(`估算阈值失败: ${err}`);
            } finally {
                estimateBtn.disabled = false;
                estimateBtn.innerText = '估算';
            }
        });
    }

    const updateThreshModeUi = (mode) => {
        const isFixed = (mode === 'fixed');
        if (threshRange) {
            threshRange.disabled = !isFixed;
            threshRange.style.opacity = isFixed ? '1' : '0.4';
            threshRange.style.cursor = isFixed ? 'pointer' : 'not-allowed';
        }
        if (threshNum) {
            threshNum.disabled = !isFixed;
            threshNum.style.opacity = isFixed ? '1' : '0.4';
            threshNum.style.cursor = isFixed ? 'text' : 'not-allowed';
        }
        if (estimateBtn) {
            estimateBtn.disabled = !isFixed;
            estimateBtn.style.opacity = isFixed ? '1' : '0.4';
            estimateBtn.style.pointerEvents = isFixed ? 'auto' : 'none';
        }
        if (threshLabel) {
            if (mode === 'otsu') {
                threshLabel.innerText = `${fileData.params.threshold} (自动)`;
            } else if (mode === 'adaptive') {
                threshLabel.innerText = '自适应';
            } else {
                threshLabel.innerText = fileData.params.threshold;
            }
        }
    };
    updateThreshModeUi(fileData.params.threshold_mode || 'fixed');

    if (threshMode) {
        threshMode.addEventListener('change', (e) => {
            const m = e.target.value;
            fileData.params.threshold_mode = m;
            updateThreshModeUi(m);
            log(`[${fileData.name}] 切换二值化算法: ${e.target.options[e.target.selectedIndex].text}`);
            requestPreview(fileId, false);
        });
    }

    if (blur) {
        blur.addEventListener('change', (e) => {
            fileData.params.blur_kernel = parseInt(e.target.value) || 3;
            requestPreview(fileId, false);
        });
    }

    if (morphRange && morphNum) {
        morphRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value) || 0;
            morphNum.value = v;
            if (morphLabel) morphLabel.innerText = v + ' px';
            fileData.params.morph_size = v;
            triggerUpdate(true);
        });
        morphNum.addEventListener('change', (e) => {
            const v = Math.max(0, Math.min(15, parseInt(e.target.value) || 0));
            morphRange.value = v;
            morphNum.value = v;
            if (morphLabel) morphLabel.innerText = v + ' px';
            fileData.params.morph_size = v;
            requestPreview(fileId, false);
        });
    }

    if (autoRot) {
        autoRot.addEventListener('change', (e) => {
            fileData.params.auto_rotate = e.target.checked;
            drawCanvas(fileId);
            renderCropPreviews(fileId);
        });
    }

    if (minRange && minInput) {
        minRange.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 0.05;
            minInput.value = v;
            if (minLabel) minLabel.innerText = v.toFixed(2) + '%';
            fileData.params.min_area_pct = v;
            triggerUpdate(true);
        });
        minInput.addEventListener('change', (e) => {
            const v = parseFloat(e.target.value) || 0.05;
            minRange.value = Math.min(20, v);
            if (minLabel) minLabel.innerText = v.toFixed(2) + '%';
            fileData.params.min_area_pct = v;
            requestPreview(fileId, false);
        });
    }

    if (maxRange && maxInput) {
        maxRange.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 80.0;
            maxInput.value = v;
            if (maxLabel) maxLabel.innerText = v.toFixed(1) + '%';
            fileData.params.max_area_pct = v;
            triggerUpdate(true);
        });
        maxInput.addEventListener('change', (e) => {
            const v = parseFloat(e.target.value) || 80.0;
            maxRange.value = v;
            if (maxLabel) maxLabel.innerText = v.toFixed(1) + '%';
            fileData.params.max_area_pct = v;
            requestPreview(fileId, false);
        });
    }

    let paddingDragging = false;
    let pendingPaddingSnapshot = null;

    if (padRange && padNum) {
        const startPadDrag = () => {
            paddingDragging = true;
            pendingPaddingSnapshot = JSON.parse(JSON.stringify(fileData.rects || []));
        };
        padRange.addEventListener('mousedown', startPadDrag);
        padRange.addEventListener('touchstart', startPadDrag, { passive: true });

        padRange.addEventListener('input', (e) => {
            const newPadding = parseInt(e.target.value) || 0;
            padNum.value = newPadding;
            if (padLabel) padLabel.innerText = newPadding + ' px';

            const oldPadding = fileData.params.padding !== undefined ? fileData.params.padding : 5;
            const delta = newPadding - oldPadding;
            fileData.params.padding = newPadding;

            if (delta !== 0) {
                applyPaddingDelta(fileId, delta);
            }
        });

        const finishPaddingDrag = () => {
            if (paddingDragging) {
                paddingDragging = false;
                if (pendingPaddingSnapshot) {
                    pushUndoState(fileId, pendingPaddingSnapshot);
                    pendingPaddingSnapshot = null;
                }
            }
        };
        padRange.addEventListener('change', finishPaddingDrag);
        padRange.addEventListener('mouseup', finishPaddingDrag);
        padRange.addEventListener('touchend', finishPaddingDrag);

        padNum.addEventListener('change', (e) => {
            const newPadding = Math.max(-20, Math.min(20, parseInt(e.target.value) || 0));
            padRange.value = newPadding;
            padNum.value = newPadding;
            if (padLabel) padLabel.innerText = newPadding + ' px';

            const oldPadding = fileData.params.padding !== undefined ? fileData.params.padding : 5;
            const delta = newPadding - oldPadding;
            fileData.params.padding = newPadding;

            if (delta !== 0) {
                pushUndoState(fileId);
                applyPaddingDelta(fileId, delta);
            }
        });
    }

    const orientBtn = document.getElementById(`autoOrientBtn-${fileId}`);
    if (orientBtn) {
        orientBtn.addEventListener('click', () => {
            selectFile(fileId, false);
            autoOrientAllCrops();
        });
    }

    const mergeBtn = document.getElementById(`mergeCropsBtn-${fileId}`);
    if (mergeBtn) {
        mergeBtn.addEventListener('click', () => {
            selectFile(fileId, false);
            mergeSelectedCrops();
        });
    }

    const selAllBtn = document.getElementById(`selectAllBtn-${fileId}`);
    if (selAllBtn) {
        selAllBtn.addEventListener('click', () => {
            selectFile(fileId, false);
            selectAllCrops();
        });
    }

    const splitVBtn = document.getElementById(`splitVCropBtn-${fileId}`);
    if (splitVBtn) {
        splitVBtn.addEventListener('click', () => {
            selectFile(fileId, false);
            splitSelectedCrop('v');
        });
    }

    const splitHBtn = document.getElementById(`splitHCropBtn-${fileId}`);
    if (splitHBtn) {
        splitHBtn.addEventListener('click', () => {
            selectFile(fileId, false);
            splitSelectedCrop('h');
        });
    }

    const delBtn = document.getElementById(`delCropBtn-${fileId}`);
    if (delBtn) {
        delBtn.addEventListener('click', () => {
            selectFile(fileId, false);
            deleteSelectedCrop();
        });
    }

    const reDetBtn = document.getElementById(`reDetectBtn-${fileId}`);
    if (reDetBtn) {
        reDetBtn.addEventListener('click', () => {
            selectFile(fileId, false);
            log(`[${fileData.name}] 重新执行自动检测...`);
            requestPreview(fileId, false);
        });
    }

    const syncBtn = document.getElementById(`syncParamsBtn-${fileId}`);
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            const srcParams = { ...fileData.params };
            Object.keys(filesMap).forEach(fid => {
                if (fid !== fileId) {
                    filesMap[fid].params = { ...srcParams };
                    syncCardControls(fid, srcParams);
                    requestPreview(fid, false);
                }
            });
            log(`已将 [${fileData.name}] 的参数同步到其他所有图片。`);
        });
    }
}

function syncCardControls(fileId, params) {
    if (!params) return;
    const blur = document.getElementById(`blurKernel-${fileId}`);
    if (blur) blur.value = params.blur_kernel;
    const threshMode = document.getElementById(`threshMode-${fileId}`);
    if (threshMode) threshMode.value = params.threshold_mode || 'fixed';
    const isFixed = (params.threshold_mode === 'fixed');
    const threshRange = document.getElementById(`threshold-${fileId}`);
    if (threshRange) {
        threshRange.value = params.threshold;
        threshRange.disabled = !isFixed;
        threshRange.style.opacity = isFixed ? '1' : '0.4';
        threshRange.style.cursor = isFixed ? 'pointer' : 'not-allowed';
    }
    const threshNum = document.getElementById(`thresholdNum-${fileId}`);
    if (threshNum) {
        threshNum.value = params.threshold;
        threshNum.disabled = !isFixed;
        threshNum.style.opacity = isFixed ? '1' : '0.4';
    }
    const estimateBtn = document.getElementById(`estimateThreshBtn-${fileId}`);
    if (estimateBtn) {
        estimateBtn.disabled = !isFixed;
        estimateBtn.style.opacity = isFixed ? '1' : '0.4';
    }
    const threshLabel = document.getElementById(`threshValLabel-${fileId}`);
    if (threshLabel) {
        if (params.threshold_mode === 'otsu') {
            threshLabel.innerText = `${params.threshold} (自动)`;
        } else if (params.threshold_mode === 'adaptive') {
            threshLabel.innerText = '自适应';
        } else {
            threshLabel.innerText = params.threshold;
        }
    }
    const morphRange = document.getElementById(`morphSizeRange-${fileId}`);
    if (morphRange) morphRange.value = params.morph_size || 0;
    const morphNum = document.getElementById(`morphSizeNum-${fileId}`);
    if (morphNum) morphNum.value = params.morph_size || 0;
    const morphLabel = document.getElementById(`morphValLabel-${fileId}`);
    if (morphLabel) morphLabel.innerText = (params.morph_size || 0) + ' px';
    const autoRot = document.getElementById(`autoRotate-${fileId}`);
    if (autoRot) autoRot.checked = !!params.auto_rotate;
    const minRange = document.getElementById(`minAreaRange-${fileId}`);
    if (minRange) minRange.value = params.min_area_pct;
    const minInput = document.getElementById(`minArea-${fileId}`);
    if (minInput) minInput.value = params.min_area_pct;
    const minLabel = document.getElementById(`minAreaValLabel-${fileId}`);
    if (minLabel) minLabel.innerText = Number(params.min_area_pct).toFixed(2) + '%';
    const maxRange = document.getElementById(`maxAreaRange-${fileId}`);
    if (maxRange) maxRange.value = params.max_area_pct;
    const maxInput = document.getElementById(`maxArea-${fileId}`);
    if (maxInput) maxInput.value = params.max_area_pct;
    const maxLabel = document.getElementById(`maxAreaValLabel-${fileId}`);
    if (maxLabel) maxLabel.innerText = Number(params.max_area_pct).toFixed(1) + '%';
    const padRange = document.getElementById(`padding-${fileId}`);
    if (padRange) padRange.value = params.padding;
    const padNum = document.getElementById(`paddingNum-${fileId}`);
    if (padNum) padNum.value = params.padding;
    const padLabel = document.getElementById(`paddingValLabel-${fileId}`);
    if (padLabel) padLabel.innerText = params.padding + ' px';
}

let isProgrammaticScrolling = false;

function selectFile(fileId, shouldScroll = false) {
    if (!filesMap[fileId]) return;
    const isSameFile = (currentFileId === fileId);
    currentFileId = fileId;
    const fileData = filesMap[fileId];

    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById(`file-${fileId}`);
    if (activeEl) {
        activeEl.classList.add('active');
        if (shouldScroll) {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    document.querySelectorAll('.stream-page').forEach(el => el.classList.remove('active'));
    const activePage = document.getElementById(`page-${fileId}`);
    if (activePage) {
        activePage.classList.add('active');
        if (shouldScroll) {
            isProgrammaticScrolling = true;
            activePage.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
                isProgrammaticScrolling = false;
            }, 450);
        }
    }

    dropZone.style.display = 'none';
    if (streamContainer) streamContainer.style.display = 'flex';

    const mode = fileData.debugMode || 'original';
    currentDebugMode = mode;

    if (!fileData.detected) {
        requestPreview(fileId);
    } else if (mode !== 'original' && !fileData.debugImgSrc) {
        requestPreview(fileId);
    } else {
        drawCanvas(fileId);
        updateCropSelectionVisuals(fileId);
    }
}

function mergeRectsPreserveFlip(oldRects, newRects) {
    return (newRects || []).map((rect, idx) => {
        const prev = oldRects && oldRects[idx];
        let orient = (typeof rect.orient === 'number') ? rect.orient : 0;
        let excluded = false;
        let userModified = false;
        if (prev) {
            if (prev._userOrientModified && typeof prev.orient === 'number') {
                orient = ((prev.orient % 360) + 360) % 360;
                userModified = true;
            } else if (typeof rect.orient === 'number') {
                orient = ((rect.orient % 360) + 360) % 360;
            } else if (typeof prev.orient === 'number') {
                orient = ((prev.orient % 360) + 360) % 360;
            }
            if (prev.excluded !== undefined) excluded = !!prev.excluded;
        }
        return { ...rect, orient, excluded, _userOrientModified: userModified };
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
        debug_mode: fileData.debugMode || 'original'
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

        drawCanvas(targetId);
        if (!skipCropPreviews) renderCropPreviews(targetId);

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

            drawCanvas(fileId);
            renderCropPreviews(fileId);

            updateBatchSummary();
            log(`[${fileData.name}] 检出有效子图数: ${data.rects.length}`);
        }
    });
}

function buildCropPreviewDataUrl(sourceImg, rect, autoRotate, bgType = 'light') {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const bg = '#ffffff';

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

function updateCropSelectionVisuals(targetFileId) {
    const fileId = targetFileId || currentFileId;
    if (!fileId || !filesMap[fileId]) return;
    const fileData = filesMap[fileId];
    const rects = fileData.rects || [];
    const cardStrip = document.getElementById(`crop-strip-${fileId}`);
    if (!cardStrip) return;

    const items = cardStrip.querySelectorAll('.crop-preview-item');
    if (items.length !== rects.length) {
        renderCropPreviews(fileId);
        return;
    }

    const selIndices = fileData.selectedCropIndices || new Set();
    items.forEach((item, idx) => {
        const rect = rects[idx];
        const isSelected = (fileId === currentFileId) && selIndices.has(idx);
        const isExcluded = !!(rect && rect.excluded);
        item.classList.toggle('selected', isSelected);
        item.classList.toggle('excluded', isExcluded);
    });

    const cardMultiBadge = document.getElementById(`multiCountBadge-${fileId}`);
    if (cardMultiBadge) {
        cardMultiBadge.innerText = `已选 ${selIndices.size} 个`;
    }
}

function renderCropPreviews(targetFileId) {
    const fileId = targetFileId || currentFileId;
    if (!fileId || !filesMap[fileId]) return;
    const fileData = filesMap[fileId];
    const rects = fileData.rects || [];

    const cardStrip = document.getElementById(`crop-strip-${fileId}`);
    if (!cardStrip) return;

    if (rects.length === 0) {
        cardStrip.innerHTML = '<div class="empty-hint">暂无检出子图</div>';
        const cardMultiBadge = document.getElementById(`multiCountBadge-${fileId}`);
        if (cardMultiBadge) cardMultiBadge.innerText = '已选 0 个';
        return;
    }

    const selIndices = fileData.selectedCropIndices || new Set();
    const cardMultiBadge = document.getElementById(`multiCountBadge-${fileId}`);
    if (cardMultiBadge) cardMultiBadge.innerText = `已选 ${selIndices.size} 个`;

    const img = new Image();
    img.onload = () => {
        const autoRotate = !!fileData.params.auto_rotate;
        const newItems = [];

        rects.forEach((rect, index) => {
            const isSelected = (fileId === currentFileId) && selIndices.has(index);
            const isExcluded = !!rect.excluded;
            const orient = getRectOrient(rect);
            const orientLabel = formatOrientLabel(orient);
            const src = buildCropPreviewDataUrl(img, rect, autoRotate, fileData.params.bg_type);
            const badgeHtml = isExcluded
                ? `<span class="flip-badge" style="background:#dc2626;color:#ffffff;">排除</span>`
                : (orientLabel ? `<span class="flip-badge">${orientLabel}</span>` : '');

            const item = document.createElement('div');
            item.className = 'crop-preview-item' + (isSelected ? ' selected' : '') + (isExcluded ? ' excluded' : '');
            item.innerHTML = `
                ${badgeHtml}
                <img alt="crop ${index + 1}" src="${src}">
                <span class="crop-label" style="${isExcluded ? 'color:#dc2626;font-weight:600;' : ''}">${isExcluded ? '[排] ' : ''}#${index + 1}${orientLabel ? ` · ${orientLabel}` : ''}</span>
            `;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentFileId !== fileId) {
                    selectFile(fileId, false);
                }
                selectCrop(index, e.shiftKey || e.ctrlKey || e.metaKey);
            });

            newItems.push(item);
        });

        // 原子替换，绝不在异步加载期间清空容器引发高度塌缩
        if (cardStrip.replaceChildren) {
            cardStrip.replaceChildren(...newItems);
        } else {
            cardStrip.innerHTML = '';
            newItems.forEach(el => cardStrip.appendChild(el));
        }
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

    const cardMultiBadge = document.getElementById(`multiCountBadge-${currentFileId}`);
    if (cardMultiBadge) cardMultiBadge.innerText = `已选 ${fileData.selectedCropIndices.size} 个`;

    drawCanvas(currentFileId);
    updateCropSelectionVisuals(currentFileId);
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
    fileData.rects = JSON.parse(JSON.stringify(prevState.rects || []));
    const validPrevIndices = (prevState.selectedCropIndices || (prevState.selectedCropIndex >= 0 ? [prevState.selectedCropIndex] : []))
        .filter(i => i >= 0 && i < fileData.rects.length);
    fileData.selectedCropIndices = new Set(validPrevIndices);
    fileData.selectedCropIndex = (fileData.selectedCropIndices.size > 0)
        ? Array.from(fileData.selectedCropIndices)[0]
        : (fileData.rects.length > 0 ? 0 : -1);

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
    fileData.rects = JSON.parse(JSON.stringify(nextState.rects || []));
    const validNextIndices = (nextState.selectedCropIndices || (nextState.selectedCropIndex >= 0 ? [nextState.selectedCropIndex] : []))
        .filter(i => i >= 0 && i < fileData.rects.length);
    fileData.selectedCropIndices = new Set(validNextIndices);
    fileData.selectedCropIndex = (fileData.selectedCropIndices.size > 0)
        ? Array.from(fileData.selectedCropIndices)[0]
        : (fileData.rects.length > 0 ? 0 : -1);

    updateFileUiAfterRectsChange();
    log(`[${fileData.name}] 重做操作 (Ctrl+Y)`);
}

function updateFileUiAfterRectsChange() {
    if (!currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];

    const validCount = (fileData.rects || []).filter(r => !r.excluded).length;
    const badge = document.getElementById(`badge-${currentFileId}`);
    if (badge) badge.innerText = validCount;

    updateBatchSummary();
    drawCanvas(currentFileId);
    renderCropPreviews(currentFileId);
    scheduleAutoSaveState();
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
            rects[idx]._userOrientModified = true;
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

    const cardOrientBtn = document.getElementById(`autoOrientBtn-${currentFileId}`);
    if (cardOrientBtn) {
        cardOrientBtn.disabled = true;
        cardOrientBtn.innerText = '正在智能预判朝向…';
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
        if (cardOrientBtn) {
            cardOrientBtn.disabled = false;
            cardOrientBtn.innerText = '自动纠正所有朝向';
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

function applyPaddingDelta(fileId, delta) {
    if (!delta || !filesMap[fileId]) return;
    const fileData = filesMap[fileId];
    const rects = fileData.rects || [];
    if (rects.length === 0) return;

    rects.forEach(rect => {
        if (rect.rotated && rect.rotated.points) {
            const rot = rect.rotated;
            rot.w = Math.max(8, rot.w + 2 * delta);
            rot.h = Math.max(8, rot.h + 2 * delta);
            rot.points = computeBoxPoints(rot.cx, rot.cy, rot.w, rot.h, rot.angle || 0);
            const xs = rot.points.map(p => p[0]);
            const ys = rot.points.map(p => p[1]);
            const minX = Math.min(...xs);
            const minY = Math.min(...ys);
            rect.x = Math.max(0, minX);
            rect.y = Math.max(0, minY);
            rect.w = Math.max(...xs) - minX;
            rect.h = Math.max(...ys) - minY;
        } else {
            rect.x = Math.max(0, rect.x - delta);
            rect.y = Math.max(0, rect.y - delta);
            rect.w = Math.max(8, rect.w + 2 * delta);
            rect.h = Math.max(8, rect.h + 2 * delta);
        }
    });

    drawCanvas(fileId);
    renderCropPreviews(fileId);
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

function getEdgeSnap(x, y) {
    return { x, y, snapped: false };
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

let activeCanvas = null;

function hitTest(mx, my, fileId, canvas) {
    const fid = fileId || currentFileId;
    if (!fid || !filesMap[fid]) return { type: 'empty' };
    const fileData = filesMap[fid];
    const rects = fileData.rects || [];

    const targetCanvas = canvas || activeCanvas || document.getElementById(`canvas-${fid}`) || mainCanvas;
    const cssRect = targetCanvas.getBoundingClientRect();
    const scale = targetCanvas.width / (cssRect.width || targetCanvas.width || 1);
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

function handleCanvasMouseDown(e, fileId, canvas) {
    if (e.button !== 0 || !filesMap[fileId]) return;
    const fileData = filesMap[fileId];
    const { x, y } = getCanvasCoords(canvas, e);
    const hit = hitTest(x, y, fileId, canvas);
    const pendingSnapshot = createSnapshot(fileId);

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const isAlt = e.altKey;

    if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) {
        document.activeElement.blur();
    }

    if (!fileData.selectedCropIndices) fileData.selectedCropIndices = new Set();

    // 1. Alt + 拖拽：新建排除区
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

    // 2. Ctrl + 拖拽：新建有效裁剪框（只有按住 Ctrl 才可以框选创建新框）
    if (isCtrl) {
        e.preventDefault();
        if (fileData.selectedCropIndices.size > 0) {
            fileData.selectedCropIndices.clear();
            fileData.selectedCropIndex = -1;
            drawCanvas(fileId);
            updateCropSelectionVisuals(fileId);
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
        return;
    }

    // 3. 正常操作：调节控制点、旋转手柄、移动已有框
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

        drawCanvas(fileId);
        updateCropSelectionVisuals(fileId);

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
            // 普通无修饰键单击空白处：仅取消选择，严禁直接新建框选
            if (fileData.selectedCropIndices.size > 0) {
                fileData.selectedCropIndices.clear();
                fileData.selectedCropIndex = -1;
                drawCanvas(fileId);
                updateCropSelectionVisuals(fileId);
            }
            transformState = { mode: 'none' };
        }
    }
}

function bindCanvasEvents(canvas, fileId) {
    if (!canvas || canvas._hasBound) return;
    canvas._hasBound = true;

    canvas.addEventListener('mousedown', (e) => {
        activeCanvas = canvas;
        if (currentFileId !== fileId) {
            selectFile(fileId, false);
        }
        handleCanvasMouseDown(e, fileId, canvas);
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!filesMap[fileId]) return;
        const { x, y } = getCanvasCoords(canvas, e);

        if (transformState.mode === 'none') {
            const hit = hitTest(x, y, fileId, canvas);
            if (e.ctrlKey || e.metaKey || e.altKey) {
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
    });

    canvas.addEventListener('mouseleave', () => {
        if (transformState.mode === 'none') {
            canvas.style.cursor = 'default';
        }
    });
}

window.addEventListener('mousemove', (e) => {
    if (!transformState || transformState.mode === 'none' || !currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const targetCanvas = activeCanvas || document.getElementById(`canvas-${currentFileId}`) || mainCanvas;
    let { x, y } = getCanvasCoords(targetCanvas, e);
    const isCtrlPressed = e.ctrlKey || e.metaKey;

    if (transformState.mode === 'moving') {
        targetCanvas.style.cursor = 'move';
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
        drawCanvas(currentFileId);
    } else if (transformState.mode === 'resizing') {
        targetCanvas.style.cursor = getHandleCursor(transformState.initialHandles, transformState.handleIndex);
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
            drawCanvas(currentFileId);
        }
    } else if (transformState.mode === 'rotating') {
        const init = transformState.initialHandles;
        targetCanvas.style.cursor = getRotateCursor(init.cx, init.cy, x, y);
        const rect = fileData.rects[transformState.rectIndex];
        if (rect) {
            const dAng = (Math.atan2(y - init.cy, x - init.cx) - Math.atan2(transformState.startY - init.cy, transformState.startX - init.cx)) * 180 / Math.PI;
            let new_angle = (init.angle + dAng) % 360;
            if (e.shiftKey) new_angle = Math.round(new_angle / 15) * 15;
            updateRectFromParams(rect, init.cx, init.cy, init.w, init.h, new_angle);
            transformState.hasModified = true;
            drawCanvas(currentFileId);
        }
    } else if (transformState.mode === 'drawing_new' || transformState.mode === 'marquee_select') {
        targetCanvas.style.cursor = 'crosshair';
        transformState.currentX = x;
        transformState.currentY = y;
        drawCanvas(currentFileId);
    }
});

window.addEventListener('mouseup', (e) => {
    if (!transformState || transformState.mode === 'none' || !currentFileId || !filesMap[currentFileId]) return;
    const fileData = filesMap[currentFileId];
    const targetCanvas = activeCanvas || document.getElementById(`canvas-${currentFileId}`) || mainCanvas;

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
            drawCanvas(currentFileId);
        }
    } else if (transformState.mode === 'drawing_new') {
        const { x, y } = getCanvasCoords(targetCanvas, e);
        const x0 = Math.min(transformState.startX, x);
        const y0 = Math.min(transformState.startY, y);
        const w0 = Math.abs(x - transformState.startX);
        const h0 = Math.abs(y - transformState.startY);

        if (w0 >= 15 && h0 >= 15) {
            if (transformState.pendingSnapshot) {
                pushUndoState(currentFileId, transformState.pendingSnapshot);
            }
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
            drawCanvas(currentFileId);
        }
    } else if (transformState.mode === 'moving' || transformState.mode === 'resizing' || transformState.mode === 'rotating') {
        if (transformState.hasModified && transformState.pendingSnapshot) {
            pushUndoState(currentFileId, transformState.pendingSnapshot);
            scheduleAutoSaveState();
            renderCropPreviews(currentFileId);
        } else {
            updateCropSelectionVisuals(currentFileId);
        }
    } else {
        updateCropSelectionVisuals(currentFileId);
    }

    transformState.mode = 'none';
});

// 监听瀑布流滚动：用户滚轮滑动时自动高亮当前视野中心图片，并联动右侧检查器
let streamScrollTimer = null;
if (streamContainer) {
    streamContainer.addEventListener('scroll', () => {
        if (isProgrammaticScrolling || isImporting) return;
        clearTimeout(streamScrollTimer);
        streamScrollTimer = setTimeout(() => {
            if (isProgrammaticScrolling || isImporting) return;
            const containerRect = streamContainer.getBoundingClientRect();
            const centerY = containerRect.top + containerRect.height / 2;

            const pages = Array.from(streamContainer.querySelectorAll('.stream-page'));
            let bestPage = null;
            let minDistance = Infinity;

            pages.forEach(p => {
                const r = p.getBoundingClientRect();
                const pageCenterY = r.top + r.height / 2;
                const dist = Math.abs(pageCenterY - centerY);
                if (dist < minDistance) {
                    minDistance = dist;
                    bestPage = p;
                }
            });

            if (bestPage) {
                const targetId = bestPage.dataset.fileId;
                if (targetId && targetId !== currentFileId) {
                    selectFile(targetId, false);
                }
            }
        }, 60);
    }, { passive: true });
}

function navigateToSiblingFile(delta) {
    const sortedIds = getSortedFileIds();
    if (sortedIds.length <= 1) return;
    const curIdx = sortedIds.indexOf(currentFileId);
    let nextIdx = (curIdx === -1 ? 0 : curIdx) + delta;
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx >= sortedIds.length) nextIdx = sortedIds.length - 1;
    if (nextIdx !== curIdx) {
        selectFile(sortedIds[nextIdx], true);
    }
}

// 快捷键管理
window.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const key = e.key ? e.key.toLowerCase() : '';
    const code = e.code || '';

    // Ctrl+S 立即手动保存工作区状态（无论焦点在哪个元素上都全局拦截）
    if (isCtrl && (key === 's' || code === 'KeyS')) {
        e.preventDefault();
        saveWorkspaceState(true);
        return;
    }

    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (isCtrl && (key === 'a' || code === 'KeyA')) {
        e.preventDefault();
        selectAllCrops();
        return;
    }
    if (isCtrl && (key === 'z' || code === 'KeyZ')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
    }
    if (isCtrl && (key === 'y' || code === 'KeyY')) {
        e.preventDefault();
        redo();
        return;
    }

    if (!isCtrl) {
        if (key === '1' || key === '2' || key === '3') {
            const modeMap = { '1': 'original', '2': 'threshold', '3': 'blurred' };
            if (currentFileId) {
                e.preventDefault();
                setFileDebugMode(currentFileId, modeMap[key]);
                return;
            }
        }
        if (key === '[' || key === 'pageup') {
            e.preventDefault();
            navigateToSiblingFile(-1);
            return;
        } else if (key === ']' || key === 'pagedown') {
            e.preventDefault();
            navigateToSiblingFile(1);
            return;
        }
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
                        curRect._userOrientModified = true;
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

function drawCanvas(targetFileId) {
    const fileId = targetFileId || currentFileId;
    if (!fileId || !filesMap[fileId]) return;
    const fileData = filesMap[fileId];

    const canvas = document.getElementById(`canvas-${fileId}`) || mainCanvas;
    if (!canvas) return;
    const canvasCtx = canvas.getContext('2d');
    const isAutoRotate = !!fileData.params.auto_rotate;

    const fileMode = fileData.debugMode || 'original';
    const imageSrc = fileMode === 'original' ? fileData.thumbnail : fileData.debugImgSrc;
    if (!imageSrc) {
        if (fileMode !== 'original') {
            requestPreview(fileId);
        }
        return;
    }

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

        if (fileMode === 'original') {
            const strokeColor = '#0284c7';
            const selectedColor = '#2563eb';
            const multiSelectColor = '#0ea5e9';
            const dangerColor = '#dc2626';
            const rects = fileData.rects || [];

            const calculatedLineWidth = Math.max(2, Math.round(canvas.width / 350));
            const fontSize = Math.max(12, Math.round(canvas.width / 80));
            const paddingOffset = Math.round(fontSize * 0.25);
            const handlePx = Math.max(8, Math.min(22, Math.round(canvas.width / 140)));

            const selIndices = fileData.selectedCropIndices || new Set();

            rects.forEach((rect, index) => {
                const isSelected = (fileId === currentFileId) && selIndices.has(index);
                const isPrimary = (fileId === currentFileId) && (index === fileData.selectedCropIndex);
                const isExcluded = !!rect.excluded;

                let currentStroke = strokeColor;
                if (isExcluded) {
                    currentStroke = isSelected ? dangerColor : 'rgba(220, 38, 38, 0.85)';
                } else if (isPrimary) {
                    currentStroke = selectedColor;
                } else if (isSelected) {
                    currentStroke = multiSelectColor;
                }

                canvasCtx.strokeStyle = currentStroke;
                canvasCtx.lineWidth = calculatedLineWidth + (isSelected ? 1 : 0);

                const hInfo = getTransformHandles(rect);
                const pts = hInfo.corners;

                const labelPrefix = isExcluded ? '[排 ' : '[';
                const multiMark = (selIndices.size > 1 && isSelected) ? ' ✓' : '';
                const label = `${labelPrefix}#${index + 1}]${multiMark}`;

                let minX, minY;
                if (isAutoRotate && pts) {
                    canvasCtx.beginPath();
                    canvasCtx.moveTo(pts[0][0], pts[0][1]);
                    canvasCtx.lineTo(pts[1][0], pts[1][1]);
                    canvasCtx.lineTo(pts[2][0], pts[2][1]);
                    canvasCtx.lineTo(pts[3][0], pts[3][1]);
                    canvasCtx.closePath();
                    if (isExcluded) {
                        canvasCtx.fillStyle = 'rgba(220, 38, 38, 0.16)';
                        canvasCtx.fill();
                    } else if (isSelected && !isPrimary) {
                        canvasCtx.fillStyle = 'rgba(37, 99, 235, 0.10)';
                        canvasCtx.fill();
                    }
                    canvasCtx.stroke();

                    // 计算倾斜框在画面上的真实最左侧与最高点（真实左上角）
                    minX = Math.min(pts[0][0], pts[1][0], pts[2][0], pts[3][0]);
                    minY = Math.min(pts[0][1], pts[1][1], pts[2][1], pts[3][1]);
                } else {
                    if (isExcluded) {
                        canvasCtx.fillStyle = 'rgba(220, 38, 38, 0.16)';
                        canvasCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
                    } else if (isSelected && !isPrimary) {
                        canvasCtx.fillStyle = 'rgba(37, 99, 235, 0.10)';
                        canvasCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
                    }
                    canvasCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

                    minX = rect.x;
                    minY = rect.y;
                }

                // 统一将识别结果标签固定在选框真实的物理左上角
                canvasCtx.fillStyle = currentStroke;
                canvasCtx.font = `bold ${fontSize}px "JetBrains Mono", Consolas, monospace`;
                const textWidth = canvasCtx.measureText(label).width;

                const rectH = fontSize + (paddingOffset * 2);
                const rectW = textWidth + (paddingOffset * 2);
                const labelX = Math.max(0, minX);
                const labelY = (minY - rectH >= 0) ? (minY - rectH) : minY;

                canvasCtx.fillRect(labelX, labelY, rectW, rectH);
                canvasCtx.fillStyle = '#ffffff';
                canvasCtx.fillText(label, labelX + paddingOffset, labelY + fontSize);

                if (isPrimary && fileId === currentFileId) {
                    canvasCtx.fillStyle = '#ffffff';
                    canvasCtx.strokeStyle = isExcluded ? dangerColor : '#1d4ed8';
                    canvasCtx.lineWidth = 2;

                    hInfo.handles.forEach(hp => {
                        canvasCtx.fillRect(hp[0] - handlePx / 2, hp[1] - handlePx / 2, handlePx, handlePx);
                        canvasCtx.strokeRect(hp[0] - handlePx / 2, hp[1] - handlePx / 2, handlePx, handlePx);
                    });

                    canvasCtx.beginPath();
                    canvasCtx.arc(hInfo.cx, hInfo.cy, handlePx / 2.5, 0, Math.PI * 2);
                    canvasCtx.fillStyle = isExcluded ? dangerColor : selectedColor;
                    canvasCtx.fill();
                    canvasCtx.stroke();
                }
            });

            if (fileId === currentFileId && transformState && transformState.mode === 'marquee_select') {
                const x0 = Math.min(transformState.startX, transformState.currentX);
                const y0 = Math.min(transformState.startY, transformState.currentY);
                const w0 = Math.abs(transformState.currentX - transformState.startX);
                const h0 = Math.abs(transformState.currentY - transformState.startY);

                canvasCtx.save();
                canvasCtx.strokeStyle = '#0284c7';
                canvasCtx.lineWidth = 1.5;
                canvasCtx.setLineDash([4, 4]);
                canvasCtx.strokeRect(x0, y0, w0, h0);
                canvasCtx.fillStyle = 'rgba(2, 132, 199, 0.12)';
                canvasCtx.fillRect(x0, y0, w0, h0);
                canvasCtx.restore();
            } else if (fileId === currentFileId && transformState && transformState.mode === 'drawing_new') {
                const x0 = Math.min(transformState.startX, transformState.currentX);
                const y0 = Math.min(transformState.startY, transformState.currentY);
                const w0 = Math.abs(transformState.currentX - transformState.startX);
                const h0 = Math.abs(transformState.currentY - transformState.startY);

                const isExcludeDraw = transformState.drawType === 'exclude';
                canvasCtx.save();
                canvasCtx.strokeStyle = isExcludeDraw ? dangerColor : selectedColor;
                canvasCtx.lineWidth = calculatedLineWidth;
                canvasCtx.setLineDash([8, 6]);
                canvasCtx.strokeRect(x0, y0, w0, h0);
                canvasCtx.fillStyle = isExcludeDraw ? 'rgba(220, 38, 38, 0.18)' : 'rgba(37, 99, 235, 0.15)';
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

const exportPathModeSelect = document.getElementById('exportPathModeSelect');
const exportDestHint = document.getElementById('exportDestHint');

function updateExportDestHint() {
    if (!exportDestHint) return;
    const mode = exportPathModeSelect ? exportPathModeSelect.value : 'subfolder';

    if (mode === 'subfolder') {
        const sub = (subfolderInput && subfolderInput.value.trim()) ? subfolderInput.value.trim() : 'output';
        exportDestHint.innerText = `目标: 原图目录/${sub}`;
        if (customPathInput) customPathInput.style.display = 'none';
        if (subfolderInput) subfolderInput.style.display = 'block';
    } else if (mode === 'custom') {
        const cPath = (customPathInput && customPathInput.value.trim()) ? customPathInput.value.trim() : '';
        exportDestHint.innerText = cPath ? `目标: ${cPath}` : '目标: 请在上方输入目标文件夹绝对路径';
        if (customPathInput) customPathInput.style.display = 'block';
        if (subfolderInput) subfolderInput.style.display = 'none';
    } else {
        exportDestHint.innerText = '目标: 浏览器下载 ZIP 压缩包';
        if (customPathInput) customPathInput.style.display = 'none';
        if (subfolderInput) subfolderInput.style.display = 'none';
    }
}

if (exportPathModeSelect) {
    exportPathModeSelect.addEventListener('change', () => {
        updateExportPathUi();
    });
}
if (subfolderInput) subfolderInput.addEventListener('input', () => { updateExportDestHint(); savePathPreferences(); });
if (customPathInput) customPathInput.addEventListener('input', () => { updateExportDestHint(); savePathPreferences(); });
updateExportDestHint();

exportBtn.addEventListener('click', async () => {
    if (!sessionId || Object.keys(filesMap).length === 0) return;

    const exportMode = exportPathModeSelect ? exportPathModeSelect.value : 'subfolder';
    const customPath = (customPathInput && customPathInput.value.trim()) ? customPathInput.value.trim() : '';
    const subfolder = (subfolderInput && subfolderInput.value.trim()) ? subfolderInput.value.trim() : 'output';

    if (exportMode === 'custom' && !customPath) {
        showToast('请输入有效的自定义保存绝对路径');
        if (customPathInput) customPathInput.focus();
        return;
    }

    const exportFormat = (exportFormatSelect ? exportFormatSelect.value : 'jpg').toLowerCase();
    const namingTemplate = (namingTemplateInput && namingTemplateInput.value.trim())
        ? namingTemplateInput.value.trim()
        : '{original}_{index:02d}';
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

    const targetDesc = (exportMode === 'zip')
        ? 'ZIP 压缩包'
        : (exportMode === 'custom' ? `指定路径 [${customPath}]` : `子文件夹 [${subfolder}]`);

    log(`开始批量裁剪。格式: ${exportFormat.toUpperCase()}，模板: ${namingTemplate}，总文件: ${totalFiles}，子图约 ${totalRects} 张，目标: ${targetDesc}${flat ? ' (平铺)' : ''}`);
    setExportBusy(true, '正在导出…');

    try {
        if (exportMode === 'zip') {
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
                    const entryName = img.path || (flat ? (img.name.startsWith(img.folder) ? img.name : `${img.folder}_${img.name}`) : `${img.folder}/${img.name}`);
                    zipEntries.push({
                        name: entryName,
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
            showToast(`已成功打包下载 ${zipEntries.length} 张图片 (ZIP)`);
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
                log(`正在写入目标路径 [${i + 1}/${totalFiles}]: ${fileItem.filename}…`);

                const res = await fetch('/api/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: sessionId,
                        export_type: 'local',
                        path_mode: exportMode,
                        custom_path: customPath,
                        subfolder: subfolder,
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

            const targetMsg = lastPath ? `至 ${lastPath}` : '';
            showToast(`切片图片已全部保存成功！共写入 ${savedCount} 张${targetMsg ? ' ' + targetMsg : ''}`, 4500);
            log(`批量裁剪保存成功！共写入约 ${savedCount} 张 ${exportFormat.toUpperCase()} 照片。`);
            if (lastPath) log(`输出物理目录: ${lastPath}`);
        }
    } catch (err) {
        showToast(`导出出错: ${err.message || err}`, 3000);
        log(`导出出错: ${err.message || err}`);
    } finally {
        setExportBusy(false);
    }
});

// 导出单选框与偏好项事件绑定
[exportRadioCustom, exportRadioSubfolder, exportRadioZip].forEach(radio => {
    if (radio) radio.addEventListener('change', updateExportPathRadioUi);
});
if (customPathInput) customPathInput.addEventListener('input', savePathPreferences);
if (subfolderInput) subfolderInput.addEventListener('input', savePathPreferences);
if (exportFormatSelect) exportFormatSelect.addEventListener('change', savePathPreferences);
if (namingTemplateInput) namingTemplateInput.addEventListener('input', savePathPreferences);
if (flatExportCheck) flatExportCheck.addEventListener('change', savePathPreferences);

// 窗口尺寸自适应变动时重新触发画布刷新
window.addEventListener('resize', () => {
    if (currentFileId && filesMap[currentFileId]) {
        drawCanvas(currentFileId);
    }
});

// 页面加载完成后恢复上次工作状态
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    restoreWorkspaceState();
} else {
    window.addEventListener('DOMContentLoaded', () => {
        restoreWorkspaceState();
    });
}
