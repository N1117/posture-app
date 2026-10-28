# 姿势健康监测 Web App

一个可在 iMac 浏览器中运行的坐姿监测应用，使用 React、Tailwind CSS 和 MediaPipe Tasks Vision。应用通过摄像头检测肩膀、头部、鼻子和眼睛位置，校准后每 3 秒评估一次坐姿，并把每日统计保存到浏览器 LocalStorage。画面默认使用隐私人物特效，不显示真实面容。

## 项目结构

```text
posture-care-monitor/
├── .gitignore
├── DEPLOYMENT.md
├── index.html
├── package.json
├── postcss.config.js
├── public/
│   └── mediapipe/
│       ├── models/
│       └── wasm/
├── tailwind.config.js
├── vercel.json
├── vite.config.js
├── README.md
└── src/
    ├── App.jsx
    ├── main.jsx
    └── styles.css
```

## 安装

```bash
npm install
```

如果本机 npm 缓存目录有权限问题，可以改用项目内临时缓存：

```bash
npm install --cache ./.npm-cache
```

## 运行

```bash
npm run dev
```

打开终端输出中的本地地址，通常是：

```text
http://localhost:5173
```

首次开启摄像头时，浏览器会请求摄像头权限。

## 部署到 Vercel

本项目是纯前端 Vite 应用，最简单的线上方案是部署到 Vercel。Vercel 会提供 HTTPS 地址，浏览器摄像头权限可以正常工作。

当前部署配置：

```text
Framework Preset: Vite
Install Command: npm install
Build Command: npm run build
Output Directory: dist
Environment Variables: 不需要
```

本项目已包含 `vercel.json`，用于固定 Vercel 构建输出目录、缓存策略和摄像头权限策略。MediaPipe WASM 与模型文件都会随站点一起部署，线上检测不依赖浏览器临时拉取外部模型。

### 本地构建测试

```bash
npm install
npm run build
npm run preview
```

### GitHub + Vercel 部署

```bash
git init
git branch -M main
git add .
git commit -m "Initial posture reminder app"
git remote add origin https://github.com/<your-name>/posture-app.git
git push -u origin main
```

然后在 Vercel 里导入这个 GitHub 仓库并点击 Deploy。部署完成后会得到类似下面的公开 HTTPS 地址：

```text
https://posture-app.vercel.app
```

后续更新：

```bash
npm run build
git add .
git commit -m "Update posture reminder app"
git push
```

更完整的步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 使用方式

1. 推荐使用 Google Chrome 打开 `http://localhost:5173`。
2. 点击「开启摄像头」，并在浏览器权限弹窗中选择允许。
3. 点击「开启通知」，允许浏览器发送 iMac 右上角系统通知。所有提醒都会走这个通知通道。
4. 面向摄像头，保持标准坐姿。
5. 隐私画面固定使用「线框姿态」，只显示头肩关键线条。
6. 点击「校准坐姿」，应用会记录当前眼睛高度、头部位置和肩膀位置。
7. 在「监测 → 实时指标」里可以调节提示阈值，设置眼睛下降、头部前倾、肩膀内缩和左右肩不平偏移到多少才提醒。
8. 应用每 3 秒分析一次姿势；切换到其他网页时，会继续按真实经过时间累计监测时长。
9. 人离开摄像头画面超过 6 秒后，监测、统计和提醒会自动暂停；人回来后会自动继续，不需要重新点开始。
10. 默认连续 10 秒需要调整时，会明确指出头部、眼睛或肩膀哪里偏离，并发送 iMac 右上角强提醒系统通知；提醒秒数可以在「提醒」里调整。
11. 默认每 20 分钟提醒看远方 20 秒，每 60 分钟提醒喝水一次；姿态错误、姿态恢复、护眼和喝水都会使用 iMac 右上角强提醒系统通知，时间可以在「提醒 → 生活提醒」里调整。
12. 页面底部可在「今日」「日历」「看板」之间切换，查看当天记录、月历记录和本月趋势总览。

## 权限说明

推荐使用 Google Chrome 打开本应用。需要开启以下权限：

- Chrome 网站权限：允许 `http://localhost:5173` 使用摄像头和通知。
- 线上网站权限：允许 `https://<your-project>.vercel.app` 使用摄像头和通知。
- macOS 摄像头权限：系统设置 → 隐私与安全性 → 摄像头 → 允许 Chrome。
- macOS 通知权限：系统设置 → 通知 → Chrome → 允许通知，并选择横幅或提醒。姿态错误、姿态恢复、护眼和喝水提醒都会通过 iMac 右上角系统通知发送。
- 如果没有通知弹窗，请确认 macOS 专注模式或勿扰模式未开启。

所有提醒都依赖浏览器系统通知权限。如果没有开启通知权限，页面会显示提醒状态，但无法强制 macOS 在右上角弹出系统通知。

## 检测逻辑

应用使用 Pose Landmarker 检测鼻子、左右肩膀、耳朵等点位，使用 Face Landmarker 检测左右眼位置。为了避免部分浏览器里的 WebGL 上下文异常，默认使用 CPU 后端执行检测，并从项目本地加载 MediaPipe WASM 和模型文件。校准后会比较以下指标：

- 眼睛高度是否明显下降
- 头部是否疑似前倾
- 肩膀宽度是否明显缩小
- 左右肩高度差是否异常增大

这些提示阈值可以在「监测 → 实时指标 → 提示阈值」中调节。阈值越接近校准姿势，提醒越敏感；阈值越宽，提醒越宽松。

检测循环使用后台定时器，不依赖页面动画帧。浏览器切换标签页后可能会降低检测频率，但统计会用真实经过时间补齐监测时长、良好时长和异常时长。连续 6 秒识别不到人物时会自动暂停统计和提醒，重新识别到人物后自动恢复。页面关闭、摄像头关闭或电脑睡眠时不会继续监测。

## 姿势提醒

姿势提醒会明确指出检测到的问题位置，例如：

- 眼睛高度下降
- 头部前倾
- 肩膀内缩
- 左右肩不平

提醒会同时给出对应调整动作，例如把视线抬回校准高度、下巴微收、打开胸口或把两侧肩膀放到同一高度。

当姿态恢复稳定后，页面会显示 “✨ Nice posture” 正反馈。

## 今日总结

底部「今日」会用按小时波形图展示当天姿态稳定度，并记录展示：

- 今日总监测时长
- 姿态良好时长
- 异常次数
- 最长连续异常时间
- 姿态最差时间段
- 今日坐姿评分，0-100 分
- 一句自然语言总结

## 日历和看板

底部「日历」会按月份展示每天记录，包括当天评分、监测时长和异常次数。点击某一天后，可以查看那天的评分、监测时长、良好时长、异常次数和最差时间段。

底部「看板」会以波浪图展示本月评分走势，并汇总记录天数、总监测时长、平均评分、异常次数、良好时长、异常总时长、高峰时间、最佳日期、最低分日期和最近记录。

## 隐私特效

真实摄像头画面只作为检测输入使用，不直接渲染到界面。应用会基于关键点在 canvas 中绘制「线框姿态」，只显示头肩关键线条，不显示真实面容。

本项目是日常姿态辅助工具，不作为专业判断。实际阈值会受到摄像头位置、人体距离、光照和坐姿习惯影响，建议在固定设备位置下使用。

## 数据保存

每日统计数据保存在浏览器 LocalStorage，键名为：

```text
posture-care-daily-stats-v1
```

不需要后端服务。

生活提醒设置也保存在浏览器 LocalStorage，键名为：

```text
posture-care-reminder-settings-v1
```

姿态提示阈值保存在浏览器 LocalStorage，键名为：

```text
posture-care-detection-settings-v1
```
