# AutoCropper

从扫描件大图中自动检测并裁剪照片。

## 环境要求

- Python 3.9+
- 依赖见 `requirements.txt`（Flask、OpenCV、NumPy）

## 安装与运行

```bash
pip install -r requirements.txt
python app.py
```

浏览器打开 [http://127.0.0.1:5000](http://127.0.0.1:5000)。

## 构建可执行文件

### 1. 安装打包工具

```bash
pip install pyinstaller
```

### 2. 执行打包

**单文件版（便携单 exe，自动剪枝减小体积）：**

```bash
pyinstaller --noconfirm --clean --onefile --name "AutoCropper" --add-data "templates;templates" --add-data "static;static" --add-data "models;models" --hidden-import "waitress" --exclude-module "tkinter" --exclude-module "unittest" --exclude-module "pydoc" app.py
```

**绿色便携版（推荐：解压即用，无需向临时目录解压，实现 0.3 秒冷启动秒开）：**

```bash
pyinstaller --noconfirm --clean --onedir --name "AutoCropper-Portable" --add-data "templates;templates" --add-data "static;static" --add-data "models;models" --hidden-import "waitress" --exclude-module "tkinter" --exclude-module "unittest" --exclude-module "pydoc" app.py
```

> 注：若使用 Linux/macOS，将 `--add-data` 中的分号 `;` 替换为冒号 `:` 即可。产物生成于 `dist/` 目录。