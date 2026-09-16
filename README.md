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

### 1. 安装打包工具与完整依赖

```bash
pip install -r requirements.txt
pip install pyinstaller
```

### 2. 执行打包

```bash
pyinstaller --noconfirm --clean --onedir --name "AutoCropper" --add-data "templates;templates" --add-data "static;static" --add-data "models;models" --hidden-import "waitress" --exclude-module "tkinter" --exclude-module "unittest" --exclude-module "pydoc" app.py
```

> 注：若使用 Linux/macOS，将 `--add-data` 中的分号 `;` 替换为冒号 `:` 即可。

打包完成后，程序文件夹生成于 `dist/AutoCropper/`，双击其中的 `AutoCropper.exe` 运行。
