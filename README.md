# Posture Care Monitor / 姿势健康监测

Webcam posture coach in the browser — calibrate once, get gentle reminders when you slouch. Runs locally; stats stay on your machine.

摄像头坐姿提醒网页应用：校准一次后，驼背、低头、肩膀歪斜时会提醒你。本地运行，数据只存在你的浏览器里。

> **Demo GIF** — coming soon / 演示动图稍后补上

## Features / 功能

- Live pose + face landmarks via MediaPipe（实时姿态与面部关键点检测）
- Privacy wireframe view — no raw face on screen（隐私线框画面，不直接显示真人脸）
- Calibrate + tunable thresholds（一键校准，灵敏度可调）
- Daily / calendar / dashboard stats in LocalStorage（今日 / 日历 / 看板统计，本地存储）
- Stretch & water reminders via system notifications（护眼、喝水等系统通知提醒）

## Quick Start / 快速开始

**Requirements / 需要：** Node.js 18+，Chrome 推荐；摄像头权限。

```bash
git clone https://github.com/N1117/posture-app.git
cd posture-app
npm install
```

### MediaPipe models (required) / 模型文件（必做）

Large model and WASM files are **not** in this repo (keeps the clone small). Put them under `public/mediapipe/` before running:

大体积的模型和 WASM 文件**不在仓库里**（保持仓轻）。运行前放到 `public/mediapipe/`：

```text
public/mediapipe/
├── models/
│   ├── pose_landmarker_lite.task
│   └── face_landmarker.task
└── wasm/          # files from @mediapipe/tasks-vision wasm folder
```

Download models from Google’s MediaPipe model repo:

- Pose lite: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task
- Face: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task

Copy WASM from the npm package after `npm install`:

```bash
mkdir -p public/mediapipe/models public/mediapipe/wasm
curl -L -o public/mediapipe/models/pose_landmarker_lite.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
curl -L -o public/mediapipe/models/face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
cp -R node_modules/@mediapipe/tasks-vision/wasm/* public/mediapipe/wasm/
```

Then:

```bash
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`), allow camera + notifications, click calibrate, and start monitoring.

## Tech stack / 技术栈

React 19 · Vite · Tailwind CSS · MediaPipe Tasks Vision · LocalStorage

## Deploy / 部署

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Vercel. Remember to include `public/mediapipe/` in the deploy artifact (or download models in CI).

线上部署见 [DEPLOYMENT.md](./DEPLOYMENT.md)。部署产物里需要带上 `public/mediapipe/`。

## License / 许可证

[MIT](./LICENSE) © 2026 N1117
