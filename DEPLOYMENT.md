# Vercel 部署说明

这个项目是纯前端 Vite 应用，最适合用 Vercel 的静态站点部署。Vercel 会提供 HTTPS 域名，因此摄像头权限可以正常弹出。

## 当前项目检查结果

- Vite 配置：使用默认根路径 `/`，适合部署到 `https://<project>.vercel.app/`。
- Build 命令：`npm run build`。
- Output 目录：`dist`。
- 本地路径依赖：没有发现 `/Users/...`、`file://` 或本机 API 地址依赖。
- 静态资源：MediaPipe WASM 位于 `public/mediapipe/wasm`，模型文件位于 `public/mediapipe/models`，构建后会一起复制到 `dist/mediapipe`。
- 摄像头权限：线上必须通过 HTTPS 打开；Vercel 默认提供 HTTPS。
- 后端依赖：无后端，无 API 环境变量。
- 外部运行依赖：姿态和面部模型已随站点托管，线上检测不再依赖浏览器从 Google Storage 拉取模型。

## Vercel 项目设置

在 Vercel 导入项目后，保持以下设置：

```text
Framework Preset: Vite
Install Command: npm install
Build Command: npm run build
Output Directory: dist
Root Directory: ./
Environment Variables: 不需要
```

本项目已包含 `vercel.json`，用于固定以上部署设置，并允许当前站点自身使用摄像头权限。

## 本地构建测试

```bash
npm install
npm run build
npm run preview
```

预览地址通常是：

```text
http://localhost:4173
```

`localhost` 属于浏览器允许摄像头的安全来源，所以本地预览也可以测试摄像头。

## 上传到 GitHub

如果还没有 Git 仓库，先执行：

```bash
git init
git branch -M main
git add .
git commit -m "Initial posture reminder app"
```

在 GitHub 新建一个空仓库，例如：

```text
https://github.com/<your-name>/posture-app
```

然后把本地项目推上去：

```bash
git remote add origin https://github.com/<your-name>/posture-app.git
git push -u origin main
```

如果已经有 Git 仓库，只需要：

```bash
git add .
git commit -m "Prepare Vercel deployment"
git push
```

## 在 Vercel 部署

1. 打开 `https://vercel.com/new`。
2. 选择刚上传到 GitHub 的仓库。
3. Framework Preset 选择 `Vite`。
4. 确认 Build Command 是 `npm run build`。
5. 确认 Output Directory 是 `dist`。
6. 点击 Deploy。

部署完成后，你会得到类似下面的 HTTPS 地址：

```text
https://posture-app.vercel.app
```

别人打开这个链接后，点击「开启摄像头」并允许权限，就可以直接使用。

## 使用 Vercel CLI 部署

如果想直接从本机部署，也可以使用 Vercel CLI：

```bash
npm install -g vercel
vercel login
vercel
vercel --prod
```

第一次执行 `vercel` 时按提示选择当前项目目录。`vercel --prod` 会发布正式线上版本。

## 更新线上版本

修改代码后：

```bash
npm run build
git add .
git commit -m "Update posture reminder app"
git push
```

如果项目已通过 GitHub 连接到 Vercel，`git push` 后 Vercel 会自动重新部署。

如果使用 CLI：

```bash
vercel --prod
```

## 查看线上错误

- Vercel 控制台：进入项目 → Deployments → 选择某次部署 → 查看 Build Logs。
- 浏览器错误：打开线上地址 → 右键检查 → Console 查看前端错误。
- 摄像头权限：确认地址是 `https://`，并在浏览器地址栏左侧的网站权限里允许摄像头。
- macOS 权限：系统设置 → 隐私与安全性 → 摄像头 → 允许当前浏览器。

## 摄像头线上注意事项

- 必须通过 HTTPS 地址访问，不能用普通 HTTP。
- 用户第一次打开线上网站时，需要手动允许摄像头。
- 如果曾经拒绝权限，需要在浏览器的网站设置中重新允许。
- 当前应用只请求摄像头，不请求麦克风。
