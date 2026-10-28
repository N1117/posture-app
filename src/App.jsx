import { useEffect, useMemo, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  Activity,
  BellRing,
  Camera,
  CameraOff,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Droplets,
  Eye,
  Gauge,
  LayoutDashboard,
  RefreshCcw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  TimerReset
} from "lucide-react";

const WASM_URL = "/mediapipe/wasm";
const POSE_MODEL_URL = "/mediapipe/models/pose_landmarker_lite.task";
const FACE_MODEL_URL = "/mediapipe/models/face_landmarker.task";

const DETECTION_INTERVAL_MS = 260;
const ANALYSIS_INTERVAL_MS = 3000;
const PRESENCE_AWAY_TIMEOUT_MS = 6000;
const STORAGE_KEY = "posture-care-daily-stats-v1";
const REMINDER_SETTINGS_KEY = "posture-care-reminder-settings-v1";
const DETECTION_SETTINGS_KEY = "posture-care-detection-settings-v1";
const POSTURE_REMINDER_TAG = "posture-care-reminder";
const POSTURE_RECOVERY_TAG = "posture-care-recovery";
const NOTIFICATION_SWAP_DELAY_MS = 260;
const RECOVERY_NOTIFICATION_CLOSE_MS = 2000;
const LIFE_REMINDER_CLOSE_MS = 5000;

const DEFAULT_REMINDER_SETTINGS = {
  postureReminderSeconds: 10,
  eyeEnabled: true,
  eyeIntervalMinutes: 20,
  eyeRestSeconds: 20,
  waterEnabled: true,
  waterIntervalMinutes: 60
};

const DEFAULT_DETECTION_SETTINGS = {
  eyeDropPercent: 3.5,
  headForwardOffset: 0.075,
  shoulderNarrowPercent: 88,
  shoulderTiltOffset: 0.035
};

const POSE_INDEX = {
  nose: 0,
  leftEyeInner: 1,
  rightEyeInner: 4,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12
};

const LEFT_EYE_FACE_POINTS = [33, 133, 159, 145];
const RIGHT_EYE_FACE_POINTS = [362, 263, 386, 374];

const POSTURE_ISSUE_GUIDANCE = {
  "eye-drop": {
    label: "眼睛高度下降",
    action: "把视线抬回校准时的高度"
  },
  "head-forward": {
    label: "头部前倾",
    action: "下巴微收，把耳朵移回肩膀正上方"
  },
  "shoulder-narrow": {
    label: "肩膀内缩",
    action: "打开胸口，让肩膀自然向后下放"
  },
  "shoulder-tilt": {
    label: "左右肩不平",
    action: "把两侧肩膀放到同一高度"
  }
};

function todayKey() {
  return new Date().toLocaleDateString("en-CA");
}

function emptyStats(date = todayKey()) {
  return {
    date,
    hunchCount: 0,
    abnormalCount: 0,
    monitoredTotalMs: 0,
    goodTotalMs: 0,
    abnormalTotalMs: 0,
    longestAbnormalMs: 0,
    worstScore: 0,
    worstAt: null,
    hourly: {}
  };
}

function normalizeStats(stats) {
  const base = emptyStats(stats?.date || todayKey());
  const normalized = { ...base, ...(stats || {}) };
  normalized.abnormalCount = normalized.abnormalCount ?? normalized.hunchCount ?? 0;
  normalized.hunchCount = normalized.abnormalCount;
  normalized.monitoredTotalMs = normalized.monitoredTotalMs ?? normalized.goodTotalMs + normalized.abnormalTotalMs;
  normalized.goodTotalMs = normalized.goodTotalMs ?? Math.max(0, normalized.monitoredTotalMs - normalized.abnormalTotalMs);
  normalized.hourly = normalized.hourly || {};
  return normalized;
}

function loadTodayStats() {
  try {
    const allStats = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return normalizeStats(allStats[todayKey()] || emptyStats());
  } catch {
    return emptyStats();
  }
}

function loadAllDailyStats() {
  try {
    const allStats = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return Object.fromEntries(
      Object.entries(allStats).map(([date, value]) => [date, normalizeStats({ ...value, date })])
    );
  } catch {
    return {};
  }
}

function saveTodayStats(stats) {
  try {
    const allStats = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    allStats[stats.date] = stats;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allStats));
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ [stats.date]: stats }));
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampDecimal(value, min, max, fallback, precision = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const factor = 10 ** precision;
  return Math.min(max, Math.max(min, Math.round(number * factor) / factor));
}

function normalizeReminderSettings(settings) {
  return {
    ...DEFAULT_REMINDER_SETTINGS,
    ...(settings || {}),
    postureReminderSeconds: clampNumber(
      settings?.postureReminderSeconds,
      5,
      300,
      DEFAULT_REMINDER_SETTINGS.postureReminderSeconds
    ),
    eyeEnabled: Boolean(settings?.eyeEnabled ?? DEFAULT_REMINDER_SETTINGS.eyeEnabled),
    eyeIntervalMinutes: clampNumber(settings?.eyeIntervalMinutes, 1, 180, DEFAULT_REMINDER_SETTINGS.eyeIntervalMinutes),
    eyeRestSeconds: clampNumber(settings?.eyeRestSeconds, 5, 120, DEFAULT_REMINDER_SETTINGS.eyeRestSeconds),
    waterEnabled: Boolean(settings?.waterEnabled ?? DEFAULT_REMINDER_SETTINGS.waterEnabled),
    waterIntervalMinutes: clampNumber(settings?.waterIntervalMinutes, 1, 240, DEFAULT_REMINDER_SETTINGS.waterIntervalMinutes)
  };
}

function loadReminderSettings() {
  try {
    return normalizeReminderSettings(JSON.parse(localStorage.getItem(REMINDER_SETTINGS_KEY) || "{}"));
  } catch {
    return DEFAULT_REMINDER_SETTINGS;
  }
}

function saveReminderSettings(settings) {
  localStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify(normalizeReminderSettings(settings)));
}

function normalizeDetectionSettings(settings) {
  return {
    ...DEFAULT_DETECTION_SETTINGS,
    ...(settings || {}),
    eyeDropPercent: clampDecimal(
      settings?.eyeDropPercent,
      1,
      10,
      DEFAULT_DETECTION_SETTINGS.eyeDropPercent,
      1
    ),
    headForwardOffset: clampDecimal(
      settings?.headForwardOffset,
      0.025,
      0.16,
      DEFAULT_DETECTION_SETTINGS.headForwardOffset,
      3
    ),
    shoulderNarrowPercent: clampDecimal(
      settings?.shoulderNarrowPercent,
      70,
      98,
      DEFAULT_DETECTION_SETTINGS.shoulderNarrowPercent,
      0
    ),
    shoulderTiltOffset: clampDecimal(
      settings?.shoulderTiltOffset,
      0.015,
      0.08,
      DEFAULT_DETECTION_SETTINGS.shoulderTiltOffset,
      3
    )
  };
}

function loadDetectionSettings() {
  try {
    return normalizeDetectionSettings(JSON.parse(localStorage.getItem(DETECTION_SETTINGS_KEY) || "{}"));
  } catch {
    return DEFAULT_DETECTION_SETTINGS;
  }
}

function saveDetectionSettings(settings) {
  localStorage.setItem(DETECTION_SETTINGS_KEY, JSON.stringify(normalizeDetectionSettings(settings)));
}

function createReminderSchedule(settings, now = Date.now()) {
  const normalized = normalizeReminderSettings(settings);
  return {
    eyeNextAt: now + normalized.eyeIntervalMinutes * 60 * 1000,
    waterNextAt: now + normalized.waterIntervalMinutes * 60 * 1000
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) return `${hours} 小时 ${remainingMinutes} 分`;
  return `${minutes} 分 ${seconds.toString().padStart(2, "0")} 秒`;
}

function formatCountdown(ms) {
  if (ms <= 0) return "即将提醒";
  return formatDuration(ms);
}

function formatCompactDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes <= 0) return "0 分";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0 && remainingMinutes > 0) return `${hours} 小时 ${remainingMinutes} 分`;
  if (hours > 0) return `${hours} 小时`;
  return `${minutes} 分`;
}

function dateKeyFromDate(date) {
  return date.toLocaleDateString("en-CA");
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;
}

function formatMonthTitle(date) {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function buildMonthCalendar(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];

  for (let i = 0; i < firstDay.getDay(); i += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    cells.push({
      date,
      key: dateKeyFromDate(date),
      day
    });
  }

  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return cells;
}

function getScoreTone(score) {
  if (score === null) return "border-slate-200 bg-slate-50 text-slate-400";
  if (score >= 90) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (score >= 75) return "border-blue-200 bg-blue-50 text-blue-800";
  if (score >= 60) return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function summarizeStatsList(statsList) {
  const scored = statsList
    .map((item) => ({ ...item, postureScore: getPostureScore(item) }))
    .filter((item) => item.monitoredTotalMs > 0);
  const scoreValues = scored.map((item) => item.postureScore).filter((score) => score !== null);
  const hourly = {};

  scored.forEach((item) => {
    Object.entries(item.hourly || {}).forEach(([hour, bucket]) => {
      const current = hourly[hour] || { monitoredMs: 0, abnormalMs: 0, scoreTotal: 0, samples: 0 };
      hourly[hour] = {
        monitoredMs: current.monitoredMs + (bucket.monitoredMs || 0),
        abnormalMs: current.abnormalMs + (bucket.abnormalMs || 0),
        scoreTotal: current.scoreTotal + (bucket.scoreTotal || 0),
        samples: current.samples + (bucket.samples || 0)
      };
    });
  });

  const aggregate = normalizeStats({
    ...emptyStats("range"),
    monitoredTotalMs: scored.reduce((sum, item) => sum + item.monitoredTotalMs, 0),
    goodTotalMs: scored.reduce((sum, item) => sum + item.goodTotalMs, 0),
    abnormalTotalMs: scored.reduce((sum, item) => sum + item.abnormalTotalMs, 0),
    abnormalCount: scored.reduce((sum, item) => sum + item.abnormalCount, 0),
    longestAbnormalMs: Math.max(0, ...scored.map((item) => item.longestAbnormalMs || 0)),
    hourly
  });

  const bestDay = scored
    .filter((item) => item.postureScore !== null)
    .sort((a, b) => b.postureScore - a.postureScore)[0] || null;
  const worstDay = scored
    .filter((item) => item.postureScore !== null)
    .sort((a, b) => a.postureScore - b.postureScore)[0] || null;

  return {
    daysWithData: scored.length,
    averageScore: scoreValues.length ? Math.round(scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length) : null,
    aggregate,
    bestDay,
    worstDay,
    worstHour: getWorstHour(aggregate),
    recentDays: scored.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7)
  };
}

function buildMonthlyTrend(monthDate, statsByDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const key = dateKeyFromDate(new Date(year, month, day));
    const dayStats = statsByDate[key] || null;
    const score = dayStats ? getPostureScore(dayStats) : null;
    const abnormalRatio = dayStats?.monitoredTotalMs
      ? dayStats.abnormalTotalMs / Math.max(1, dayStats.monitoredTotalMs)
      : 0;

    return {
      key,
      day,
      positionIndex: index,
      score,
      abnormalRatio,
      hasData: Boolean(dayStats?.monitoredTotalMs)
    };
  });
}

function buildDailyTrend(dayStats) {
  const hourly = dayStats?.hourly || {};

  return Array.from({ length: 24 }, (_, hour) => {
    const key = hour.toString().padStart(2, "0");
    const bucket = hourly[key] || null;
    const monitoredMs = bucket?.monitoredMs || 0;
    const abnormalRatio = monitoredMs ? (bucket?.abnormalMs || 0) / Math.max(1, monitoredMs) : 0;
    const averageIssueScore = bucket?.samples ? (bucket.scoreTotal || 0) / Math.max(1, bucket.samples) : 0;
    const score = monitoredMs
      ? Math.max(0, Math.min(100, Math.round(100 - abnormalRatio * 70 - averageIssueScore * 0.35)))
      : null;

    return {
      key,
      day: hour,
      positionIndex: hour,
      score,
      abnormalRatio,
      hasData: monitoredMs > 0
    };
  });
}

function createSmoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const controlX = (previous.x + point.x) / 2;
    return `${path} C ${controlX} ${previous.y}, ${controlX} ${point.y}, ${point.x} ${point.y}`;
  }, "");
}

function getHourKey(date = new Date()) {
  return date.getHours().toString().padStart(2, "0");
}

function formatHourPeriod(hourKey) {
  if (!hourKey) return "暂无明显异常";
  const hour = Number(hourKey);
  const nextHour = (hour + 1) % 24;
  const period = hour < 6 ? "凌晨" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const displayNext = nextHour % 12 === 0 ? 12 : nextHour % 12;
  return `${period} ${displayHour} 点到 ${displayNext} 点`;
}

function getWorstHour(stats) {
  const entries = Object.entries(stats.hourly || {});
  if (!entries.length) return null;
  const sorted = entries
    .filter(([, bucket]) => bucket.abnormalMs > 0)
    .sort(([, a], [, b]) => {
      if ((b.abnormalMs || 0) !== (a.abnormalMs || 0)) return (b.abnormalMs || 0) - (a.abnormalMs || 0);
      return (b.scoreTotal || 0) / Math.max(1, b.samples || 0) - (a.scoreTotal || 0) / Math.max(1, a.samples || 0);
    });
  return sorted[0]?.[0] || null;
}

function getPostureScore(stats) {
  if (!stats.monitoredTotalMs) return null;
  const abnormalRatio = stats.abnormalTotalMs / Math.max(1, stats.monitoredTotalMs);
  const longestMinutes = stats.longestAbnormalMs / 60000;
  const score = 100 - abnormalRatio * 58 - stats.abnormalCount * 3.5 - longestMinutes * 1.8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getNaturalSummary(stats) {
  if (!stats.monitoredTotalMs) {
    return "今天还没有开始监测，校准后会自动生成总结。";
  }

  const score = getPostureScore(stats);
  const worstHour = getWorstHour(stats);
  const worstText = formatHourPeriod(worstHour);

  const morning = Object.entries(stats.hourly || {}).filter(([hour]) => Number(hour) >= 6 && Number(hour) < 12);
  const afternoon = Object.entries(stats.hourly || {}).filter(([hour]) => Number(hour) >= 12 && Number(hour) < 18);
  const ratio = (entries) => {
    const total = entries.reduce((sum, [, bucket]) => sum + (bucket.monitoredMs || 0), 0);
    const abnormal = entries.reduce((sum, [, bucket]) => sum + (bucket.abnormalMs || 0), 0);
    return total ? abnormal / total : 0;
  };
  const morningRatio = ratio(morning);
  const afternoonRatio = ratio(afternoon);

  if (score >= 90) {
    return "今天整体很稳，肩颈状态保持得不错。继续保持当前屏幕高度和坐姿节奏。";
  }

  if (afternoonRatio > morningRatio + 0.12 && afternoonRatio > 0.08) {
    return "今天上午状态稳定，下午前倾和肩部紧张更明显。建议明天把屏幕抬高 5cm。";
  }

  if (stats.abnormalCount > 0) {
    return `今天${worstText}更容易出现前倾或肩膀收紧。休息 30 秒会更舒服，也可以把屏幕稍微抬高。`;
  }

  return "今天没有明显连续异常，整体状态轻松。继续保持，记得偶尔让脖子轻一点。";
}

function averageLandmarks(points) {
  const validPoints = points.filter(Boolean);
  if (!validPoints.length) return null;
  return validPoints.reduce(
    (sum, point) => ({
      x: sum.x + point.x / validPoints.length,
      y: sum.y + point.y / validPoints.length,
      z: sum.z + (point.z || 0) / validPoints.length
    }),
    { x: 0, y: 0, z: 0 }
  );
}

function getFacePointAverage(faceLandmarks, indexes) {
  if (!faceLandmarks?.length) return null;
  return averageLandmarks(indexes.map((index) => faceLandmarks[index]));
}

function computeMetrics(poseResult, faceResult) {
  const pose = poseResult?.landmarks?.[0];
  const face = faceResult?.faceLandmarks?.[0];

  if (!pose) {
    return null;
  }

  const leftShoulder = pose[POSE_INDEX.leftShoulder];
  const rightShoulder = pose[POSE_INDEX.rightShoulder];
  const nose = pose[POSE_INDEX.nose];
  const leftEar = pose[POSE_INDEX.leftEar];
  const rightEar = pose[POSE_INDEX.rightEar];
  const leftEye = face ? getFacePointAverage(face, LEFT_EYE_FACE_POINTS) : pose[POSE_INDEX.leftEyeInner];
  const rightEye = face ? getFacePointAverage(face, RIGHT_EYE_FACE_POINTS) : pose[POSE_INDEX.rightEyeInner];
  const eyes = averageLandmarks([leftEye, rightEye]);
  const ears = averageLandmarks([leftEar, rightEar]);

  if (!leftShoulder || !rightShoulder || !nose || !eyes) {
    return null;
  }

  const shoulderCenter = averageLandmarks([leftShoulder, rightShoulder]);
  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
  const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y);
  const headDepth = nose.z - shoulderCenter.z;
  const headDrop = eyes.y - shoulderCenter.y;

  return {
    timestamp: performance.now(),
    eyeY: eyes.y,
    eyeCenterX: eyes.x,
    headX: nose.x,
    headY: nose.y,
    headDepth,
    headDrop,
    shoulderY: shoulderCenter.y,
    shoulderWidth,
    shoulderTilt,
    leftShoulder,
    rightShoulder,
    nose,
    eyes,
    ears,
    eyeSource: face ? "face" : "pose"
  };
}

function evaluatePosture(current, baseline, detectionSettings = DEFAULT_DETECTION_SETTINGS) {
  if (!current || !baseline) {
    return { abnormal: false, issues: [], score: 0 };
  }

  const settings = normalizeDetectionSettings(detectionSettings);
  const eyeDropThreshold = settings.eyeDropPercent / 100;
  const headForwardThreshold = settings.headForwardOffset;
  const shoulderNarrowThreshold = settings.shoulderNarrowPercent / 100;
  const shoulderTiltThreshold = settings.shoulderTiltOffset;
  const shoulderTiltRiseThreshold = Math.max(0.01, shoulderTiltThreshold * 0.5);
  const issues = [];
  const eyeDrop = current.eyeY - baseline.eyeY;
  const headLower = current.headY - baseline.headY;
  const headForward = baseline.headDepth - current.headDepth;
  const shoulderNarrowRatio = current.shoulderWidth / baseline.shoulderWidth;
  const shoulderTiltRise = current.shoulderTilt - baseline.shoulderTilt;

  if (eyeDrop > eyeDropThreshold) {
    issues.push({
      key: "eye-drop",
      label: POSTURE_ISSUE_GUIDANCE["eye-drop"].label,
      value: `下降 ${Math.round(eyeDrop * 1000) / 10}% 画面高度`,
      action: POSTURE_ISSUE_GUIDANCE["eye-drop"].action
    });
  }

  if (headForward > headForwardThreshold || (headLower > eyeDropThreshold && eyeDrop > eyeDropThreshold * 0.7)) {
    issues.push({
      key: "head-forward",
      label: POSTURE_ISSUE_GUIDANCE["head-forward"].label,
      value: headForward > 0 ? `前移 ${headForward.toFixed(3)}` : "头部明显下移",
      action: POSTURE_ISSUE_GUIDANCE["head-forward"].action
    });
  }

  if (shoulderNarrowRatio < shoulderNarrowThreshold) {
    issues.push({
      key: "shoulder-narrow",
      label: POSTURE_ISSUE_GUIDANCE["shoulder-narrow"].label,
      value: `肩宽缩到 ${(shoulderNarrowRatio * 100).toFixed(0)}%`,
      action: POSTURE_ISSUE_GUIDANCE["shoulder-narrow"].action
    });
  }

  if (
    current.shoulderTilt > Math.max(shoulderTiltThreshold, baseline.shoulderTilt + shoulderTiltRiseThreshold) &&
    shoulderTiltRise > shoulderTiltRiseThreshold
  ) {
    issues.push({
      key: "shoulder-tilt",
      label: POSTURE_ISSUE_GUIDANCE["shoulder-tilt"].label,
      value: `左右差值 ${current.shoulderTilt.toFixed(3)}`,
      action: POSTURE_ISSUE_GUIDANCE["shoulder-tilt"].action
    });
  }

  const abnormal = issues.length > 0;
  const score = Math.min(100, Math.round((issues.length / 4) * 100 + Math.max(0, eyeDrop) * 500));

  return { abnormal, issues, score };
}

function buildPostureReminder(issues) {
  const activeIssues = issues.length ? issues : [{ key: "head-forward", label: "姿势偏离校准位置" }];
  const problemText = activeIssues.map((issue) => issue.label).join("、");
  const actionText = activeIssues
    .map((issue) => POSTURE_ISSUE_GUIDANCE[issue.key]?.action)
    .filter(Boolean)
    .slice(0, 2)
    .join("；");

  return {
    title: `姿势问题：${problemText}`,
    message: actionText ? `检测到 ${problemText}。${actionText}。` : `检测到 ${problemText}，请回到校准坐姿。`
  };
}

function drawBackground(ctx, width, height, isAbnormal) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, isAbnormal ? "#261319" : "#06161f");
  gradient.addColorStop(0.52, "#07111d");
  gradient.addColorStop(1, isAbnormal ? "#31111a" : "#10243a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  const gridSize = Math.max(42, width / 18);
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawRoundedCapsule(ctx, x, y, width, height, radius) {
  const left = x - width / 2;
  const top = y - height / 2;
  const right = left + width;
  const bottom = top + height;

  ctx.beginPath();
  ctx.moveTo(left + radius, top);
  ctx.lineTo(right - radius, top);
  ctx.quadraticCurveTo(right, top, right, top + radius);
  ctx.lineTo(right, bottom - radius);
  ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
  ctx.lineTo(left + radius, bottom);
  ctx.quadraticCurveTo(left, bottom, left, bottom - radius);
  ctx.lineTo(left, top + radius);
  ctx.quadraticCurveTo(left, top, left + radius, top);
  ctx.closePath();
}

function drawEffectLabel(ctx, width, height, text) {
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = `${Math.max(14, width / 70)}px Inter, sans-serif`;
  ctx.fillText(text, Math.max(18, width / 60), height - Math.max(22, height / 26));
}

function drawOverlay(canvas, video, metrics, postureState) {
  if (!canvas || !video?.videoWidth || !video?.videoHeight) return;

  const width = video.videoWidth;
  const height = video.videoHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const isAbnormal = postureState.status === "abnormal";
  drawBackground(ctx, width, height, isAbnormal);
  if (!metrics) {
    drawEffectLabel(ctx, width, height, "隐私特效画面：等待人物关键点");
    return;
  }

  const point = (landmark) => [landmark.x * width, landmark.y * height];
  const healthy = !isAbnormal;
  const primary = healthy ? "#17a673" : "#ef4444";
  const accent = healthy ? "#8ee6cf" : "#fecdd3";
  const [leftX, leftY] = point(metrics.leftShoulder);
  const [rightX, rightY] = point(metrics.rightShoulder);
  const [eyeX, eyeY] = point(metrics.eyes);
  const shoulderCenterX = (leftX + rightX) / 2;
  const shoulderCenterY = (leftY + rightY) / 2;
  const shoulderWidth = Math.max(Math.abs(rightX - leftX), width * 0.16);
  const headRadius = Math.max(width / 18, shoulderWidth * 0.18);
  const neckY = shoulderCenterY - headRadius * 0.45;

  ctx.save();
  ctx.shadowColor = primary;
  ctx.shadowBlur = Math.max(12, width / 45);
  ctx.strokeStyle = primary;
  ctx.lineWidth = Math.max(4, width / 240);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(leftX, leftY);
  ctx.lineTo(shoulderCenterX, neckY);
  ctx.lineTo(rightX, rightY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(shoulderCenterX, neckY);
  ctx.lineTo(eyeX, eyeY + headRadius * 0.72);
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.arc(eyeX, eyeY - headRadius * 0.05, headRadius, 0, Math.PI * 2);
  ctx.stroke();

  [metrics.leftShoulder, metrics.rightShoulder, metrics.nose, metrics.eyes].forEach((landmark) => {
    const [x, y] = point(landmark);
    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.arc(x, y, width / 95, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();
  drawEffectLabel(ctx, width, height, "隐私特效：线框姿态");
}

function StatCard({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white/80 px-4 py-3 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function MetricRow({ label, value, baseline, lowerIsBetter = false }) {
  const diff = baseline ? value - baseline : 0;
  const level = Math.min(100, Math.max(0, lowerIsBetter ? (1 - value) * 100 : value * 100));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-medium text-slate-900">
          {value.toFixed(3)}
          {baseline ? <span className="ml-2 text-xs text-slate-400">基准 {diff >= 0 ? "+" : ""}{diff.toFixed(3)}</span> : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="metric-bar h-full rounded-full" style={{ width: `${level}%` }} />
      </div>
    </div>
  );
}

function ThresholdControl({ label, description, value, min, max, step, unit = "", onChange }) {
  return (
    <label className="block border-t border-slate-100 pt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">{label}</div>
          <div className="mt-1 text-xs leading-5 text-slate-500">{description}</div>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
          {value}
          {unit}
        </span>
      </div>
      <input
        className="mt-3 w-full accent-[#007aff]"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ScoreWaveChart({
  trend,
  averageScore,
  title = "坐姿波浪图",
  subtitle,
  emptyText = "还没有足够数据，开始监测后这里会生成波浪图。",
  ariaLabel = "坐姿评分波浪图",
  placeholderAriaLabel = "坐姿评分波浪图占位",
  rangeLabel
}) {
  const width = 1000;
  const height = 280;
  const paddingX = 42;
  const top = 34;
  const chartHeight = 162;
  const bottom = top + chartHeight;
  const usableWidth = width - paddingX * 2;
  const dataPoints = trend
    .filter((item) => item.hasData && item.score !== null)
    .map((item) => ({
      ...item,
      x: paddingX + ((item.positionIndex ?? 0) / Math.max(1, trend.length - 1)) * usableWidth,
      y: top + ((100 - item.score) / 100) * chartHeight
    }));
  const linePath = createSmoothPath(dataPoints);
  const areaPath = dataPoints.length > 1 ? `${linePath} L ${dataPoints[dataPoints.length - 1].x} ${bottom} L ${dataPoints[0].x} ${bottom} Z` : "";
  const resolvedSubtitle = subtitle || "评分走势，越高代表姿态越稳定";
  const resolvedRangeLabel = rangeLabel || `${trend[0]?.day || 1} - ${trend[trend.length - 1]?.day || 1} 日`;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
            <Activity className="h-4 w-4 text-teal-500" />
            {title}
          </div>
          <p className="mt-1 text-sm text-slate-500">{resolvedSubtitle}</p>
        </div>
        <div className="rounded-full bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500">
          平均 {averageScore === null ? "--" : `${averageScore} 分`}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg bg-slate-950">
        {dataPoints.length ? (
          <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full" role="img" aria-label={ariaLabel}>
            <defs>
              <linearGradient id="scoreWaveFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.42" />
                <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id="scoreWaveStroke" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#5eead4" />
                <stop offset="50%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#a7f3d0" />
              </linearGradient>
            </defs>

            {[25, 50, 75, 100].map((score) => {
              const y = top + ((100 - score) / 100) * chartHeight;
              return (
                <g key={score}>
                  <line x1={paddingX} x2={width - paddingX} y1={y} y2={y} stroke="rgba(255,255,255,0.08)" />
                  <text x={paddingX - 12} y={y + 4} textAnchor="end" fill="rgba(255,255,255,0.45)" fontSize="18">
                    {score}
                  </text>
                </g>
              );
            })}

            {trend.map((item) => {
              if (!item.hasData) return null;
              const x = paddingX + ((item.positionIndex ?? 0) / Math.max(1, trend.length - 1)) * usableWidth;
              const barHeight = Math.max(4, Math.min(46, item.abnormalRatio * 92));
              return (
                <rect
                  key={item.key}
                  x={x - 5}
                  y={height - 42 - barHeight}
                  width="10"
                  height={barHeight}
                  rx="5"
                  fill="rgba(251,113,133,0.72)"
                />
              );
            })}

            {areaPath ? <path d={areaPath} fill="url(#scoreWaveFill)" /> : null}
            {dataPoints.length > 1 ? (
              <path d={linePath} fill="none" stroke="url(#scoreWaveStroke)" strokeWidth="7" strokeLinecap="round" />
            ) : null}
            {dataPoints.map((point) => (
              <g key={point.key}>
                <circle cx={point.x} cy={point.y} r="9" fill="#0f172a" stroke="#5eead4" strokeWidth="5" />
                <text x={point.x} y={point.y - 18} textAnchor="middle" fill="rgba(255,255,255,0.82)" fontSize="18" fontWeight="600">
                  {point.score}
                </text>
              </g>
            ))}

            <text x={paddingX} y={height - 17} fill="rgba(255,255,255,0.48)" fontSize="18">
              红色短柱表示异常占比
            </text>
            <text x={width - paddingX} y={height - 17} textAnchor="end" fill="rgba(255,255,255,0.48)" fontSize="18">
              {resolvedRangeLabel}
            </text>
          </svg>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full" role="img" aria-label={placeholderAriaLabel}>
            <path
              d="M 54 150 C 150 82, 245 218, 340 150 C 435 82, 530 218, 625 150 C 720 82, 815 218, 946 150"
              fill="none"
              stroke="rgba(94,234,212,0.36)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray="16 18"
            />
            <path
              d="M 54 150 C 150 82, 245 218, 340 150 C 435 82, 530 218, 625 150 C 720 82, 815 218, 946 150 L 946 222 L 54 222 Z"
              fill="rgba(45,212,191,0.08)"
            />
            <text x={width / 2} y={height / 2 + 64} textAnchor="middle" fill="rgba(255,255,255,0.68)" fontSize="22" fontWeight="600">
              {emptyText}
            </text>
          </svg>
        )}
      </div>
    </div>
  );
}

function PanelTab({ icon: Icon, label, active, onClick }) {
  return (
    <button
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition ${
        active ? "bg-slate-950 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
      }`}
      onClick={onClick}
      title={label}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const poseLandmarkerRef = useRef(null);
  const faceLandmarkerRef = useRef(null);
  const detectionTimerRef = useRef(null);
  const detectionBusyRef = useRef(false);
  const lastDetectionRef = useRef(0);
  const lastAnalysisRef = useRef(0);
  const lastStatsWallClockRef = useRef(null);
  const lastPersonSeenAtRef = useRef(null);
  const nextDetectorRef = useRef("pose");
  const latestPoseResultRef = useRef(null);
  const latestFaceResultRef = useRef(null);
  const faceFailureCountRef = useRef(0);
  const faceDetectionDisabledRef = useRef(false);
  const abnormalStartRef = useRef(null);
  const reminderShownRef = useRef(false);
  const posturePraisePendingRef = useRef(false);
  const postureReminderActiveRef = useRef(false);
  const presencePausedRef = useRef(false);
  const presenceStatusRef = useRef("idle");
  const baselineRef = useRef(null);
  const postureStateRef = useRef({ status: "idle", issues: [], score: 0, abnormalMs: 0 });
  const positiveTimeoutRef = useRef(null);
  const reminderTimeoutRef = useRef(null);
  const healthReminderTimerRef = useRef(null);
  const systemNotificationsRef = useRef(new Map());
  const reminderSettingsRef = useRef(DEFAULT_REMINDER_SETTINGS);
  const detectionSettingsRef = useRef(DEFAULT_DETECTION_SETTINGS);
  const reminderScheduleRef = useRef(createReminderSchedule(DEFAULT_REMINDER_SETTINGS));

  const [modelStatus, setModelStatus] = useState("loading");
  const [cameraStatus, setCameraStatus] = useState("idle");
  const [statusMessage, setStatusMessage] = useState("正在加载姿势与面部检测模型");
  const [currentMetrics, setCurrentMetrics] = useState(null);
  const [presenceStatus, setPresenceStatus] = useState("idle");
  const [baseline, setBaseline] = useState(null);
  const [postureState, setPostureState] = useState({ status: "idle", issues: [], score: 0, abnormalMs: 0 });
  const [stats, setStats] = useState(loadTodayStats);
  const statsRef = useRef(stats);
  const [showReminder, setShowReminder] = useState(false);
  const [reminderText, setReminderText] = useState("检测到姿势问题时，会直接指出具体位置。");
  const [reminderTitle, setReminderTitle] = useState("姿势需要调整");
  const [reminderTone, setReminderTone] = useState("posture");
  const [reminderSettings, setReminderSettings] = useState(loadReminderSettings);
  const [detectionSettings, setDetectionSettings] = useState(loadDetectionSettings);
  const [reminderClock, setReminderClock] = useState(Date.now());
  const [activePanel, setActivePanel] = useState("monitor");
  const [reportView, setReportView] = useState("today");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(todayKey);
  const [showPositive, setShowPositive] = useState(false);
  const [positiveMessage, setPositiveMessage] = useState("✨ Nice posture");
  const [notificationPermission, setNotificationPermission] = useState(() => {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  });
  const [notificationChannel, setNotificationChannel] = useState("正在检查系统通知服务");

  const isReady = modelStatus === "ready";
  const cameraOn = cameraStatus === "running";

  useEffect(() => {
    baselineRef.current = baseline;
  }, [baseline]);

  useEffect(() => {
    postureStateRef.current = postureState;
  }, [postureState]);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: POSE_MODEL_URL,
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          numPoses: 1
        });
        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: FACE_MODEL_URL,
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false
        });

        if (cancelled) return;
        poseLandmarkerRef.current = poseLandmarker;
        faceLandmarkerRef.current = faceLandmarker;
        setModelStatus("ready");
        setStatusMessage("模型已就绪，可以开启摄像头");
      } catch (error) {
        if (cancelled) return;
        setModelStatus("error");
        setStatusMessage(`模型加载失败：${error.message || "请检查网络连接"}`);
      }
    }

    loadModels();

    return () => {
      cancelled = true;
      poseLandmarkerRef.current?.close?.();
      faceLandmarkerRef.current?.close?.();
    };
  }, []);

  useEffect(() => {
    statsRef.current = stats;
    saveTodayStats(stats);
  }, [stats]);

  useEffect(() => {
    const normalized = normalizeReminderSettings(reminderSettings);
    reminderSettingsRef.current = normalized;
    reminderScheduleRef.current = createReminderSchedule(normalized);
    saveReminderSettings(normalized);
  }, [reminderSettings]);

  useEffect(() => {
    const normalized = normalizeDetectionSettings(detectionSettings);
    detectionSettingsRef.current = normalized;
    saveDetectionSettings(normalized);
  }, [detectionSettings]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => {
          setNotificationChannel("iMac 系统通知服务已就绪");
        })
        .catch(() => {
          setNotificationChannel("系统通知服务不可用，将使用浏览器通知兜底");
          setStatusMessage("系统通知服务注册失败，将使用浏览器通知兜底");
        });
    } else {
      setNotificationChannel("当前浏览器不支持系统通知服务");
    }
  }, []);

  useEffect(() => {
    return () => {
      if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current);
      if (positiveTimeoutRef.current) window.clearTimeout(positiveTimeoutRef.current);
      if (reminderTimeoutRef.current) window.clearTimeout(reminderTimeoutRef.current);
      if (healthReminderTimerRef.current) window.clearInterval(healthReminderTimerRef.current);
      closeSystemNotification(POSTURE_REMINDER_TAG);
      closeSystemNotification(POSTURE_RECOVERY_TAG);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const settings = reminderSettingsRef.current;
      const schedule = reminderScheduleRef.current;

      setReminderClock(now);

      const eyeDue = settings.eyeEnabled && now >= schedule.eyeNextAt;
      const waterDue = settings.waterEnabled && now >= schedule.waterNextAt;
      const advanceReminder = (key, intervalMs) => {
        do {
          schedule[key] += intervalMs;
        } while (schedule[key] <= now);
      };

      if (presencePausedRef.current) {
        if (settings.eyeEnabled && now >= schedule.eyeNextAt) {
          advanceReminder("eyeNextAt", settings.eyeIntervalMinutes * 60 * 1000);
        }
        if (settings.waterEnabled && now >= schedule.waterNextAt) {
          advanceReminder("waterNextAt", settings.waterIntervalMinutes * 60 * 1000);
        }
        return;
      }

      if (eyeDue && waterDue) {
        const message = `看远方 ${settings.eyeRestSeconds} 秒，再喝一口水`;
        showGentleReminder("休息一下", message, "water", LIFE_REMINDER_CLOSE_MS);
        sendLifeReminderNotification("休息一下", message, "posture-care-wellness");
        advanceReminder("eyeNextAt", settings.eyeIntervalMinutes * 60 * 1000);
        advanceReminder("waterNextAt", settings.waterIntervalMinutes * 60 * 1000);
        return;
      }

      if (eyeDue) {
        const intervalMs = settings.eyeIntervalMinutes * 60 * 1000;
        showGentleReminder("看看远方", `看远方 ${settings.eyeRestSeconds} 秒，让眼睛松一下`, "eye", LIFE_REMINDER_CLOSE_MS);
        sendLifeReminderNotification("看看远方", `看远方 ${settings.eyeRestSeconds} 秒，让眼睛松一下`, "posture-care-eye-break");
        advanceReminder("eyeNextAt", intervalMs);
      }

      if (waterDue) {
        const intervalMs = settings.waterIntervalMinutes * 60 * 1000;
        showGentleReminder("喝一口水", "补一点水，肩颈也会更轻松", "water", LIFE_REMINDER_CLOSE_MS);
        sendLifeReminderNotification("喝一口水", "补一点水，肩颈也会更轻松", "posture-care-water");
        advanceReminder("waterNextAt", intervalMs);
      }
    };

    healthReminderTimerRef.current = window.setInterval(tick, 1000);
    return () => {
      if (healthReminderTimerRef.current) window.clearInterval(healthReminderTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && streamRef.current && baselineRef.current) {
        setStatusMessage(presencePausedRef.current ? "人离开画面，后台监测已暂停" : "后台监测中，切换网页后会继续按真实时间累计");
      }

      if (!document.hidden && streamRef.current) {
        setStatusMessage(
          presencePausedRef.current
            ? "未检测到人物，监测和提醒已自动暂停；回来后会自动继续"
            : baselineRef.current
              ? "已回到前台，后台监测时长已同步"
              : "摄像头已开启，请保持自然坐姿后校准"
        );
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  function waitForServiceWorkerReady() {
    if (!("serviceWorker" in navigator)) return Promise.reject(new Error("Service Worker unsupported"));
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error("Service Worker timeout")), 1600);
      })
    ]);
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function closeSystemNotification(tag) {
    const notification = systemNotificationsRef.current.get(tag);
    if (notification) {
      notification.close();
      systemNotificationsRef.current.delete(tag);
    }

    if (!("serviceWorker" in navigator)) return;

    try {
      const registration = await waitForServiceWorkerReady();
      if (!registration.getNotifications) return;
      const notifications = await registration.getNotifications({ tag });
      notifications.forEach((item) => item.close());
    } catch {
      // Closing stale notifications is best effort; browsers may limit this per platform.
    }
  }

  async function showSystemNotification(title, body, tag, optionOverrides = {}) {
    const { autoCloseMs, ...notificationOverrides } = optionOverrides;
    const options = {
      body,
      tag,
      renotify: true,
      requireInteraction: true,
      silent: false,
      ...notificationOverrides
    };

    await closeSystemNotification(tag);

    if ("serviceWorker" in navigator) {
      try {
        const registration = await waitForServiceWorkerReady();
        await registration.showNotification(title, options);
        if (autoCloseMs) {
          window.setTimeout(() => {
            closeSystemNotification(tag);
          }, autoCloseMs);
        }
        return;
      } catch {
        setStatusMessage("系统通知发送失败，已尝试浏览器通知兜底");
      }
    }

    const notification = new Notification(title, options);
    systemNotificationsRef.current.set(tag, notification);

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    notification.onclose = () => {
      if (systemNotificationsRef.current.get(tag) === notification) {
        systemNotificationsRef.current.delete(tag);
      }
    };

    if (autoCloseMs) {
      window.setTimeout(() => {
        closeSystemNotification(tag);
      }, autoCloseMs);
    }
  }

  async function requestNotificationPermission() {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      setStatusMessage("当前浏览器不支持系统通知，任何提醒都无法发送到 iMac 右上角");
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    setStatusMessage(
      permission === "granted"
        ? "通知已开启，所有提醒都会发送到 iMac 右上角"
        : "通知未开启，任何提醒都无法发送到 iMac 右上角"
    );
  }

  async function sendSystemReminderNotification(title, message, tag, config = {}) {
    const { showPermissionHint = true, autoCloseMs, requireInteraction = true } = config;
    const currentPermission = "Notification" in window ? Notification.permission : "unsupported";

    if (currentPermission !== "granted") {
      setNotificationPermission(currentPermission);
      if (showPermissionHint) {
        setStatusMessage(
          currentPermission === "denied"
            ? "系统通知已被浏览器拒绝，请允许通知，才能在 iMac 右上角提醒"
            : "请先开启 iMac 系统通知，以接收所有提醒"
        );
      }
      return false;
    }

    await showSystemNotification(title, message, tag, {
      renotify: true,
      requireInteraction,
      silent: false,
      autoCloseMs
    });
    return true;
  }

  async function sendLifeReminderNotification(title, message, tag) {
    const delivered = await sendSystemReminderNotification(title, message, tag, {
      showPermissionHint: true,
      urgent: true,
      requireInteraction: false,
      autoCloseMs: LIFE_REMINDER_CLOSE_MS
    });
    if (delivered) {
      setStatusMessage("已发送 iMac 右上角系统提醒");
    }
  }

  async function sendPostureNotification(title, message) {
    await closeSystemNotification(POSTURE_RECOVERY_TAG);
    const delivered = await sendSystemReminderNotification(title, message, POSTURE_REMINDER_TAG, {
      showPermissionHint: true,
      urgent: true
    });
    if (delivered) {
      setStatusMessage("已发送 iMac 系统姿态提醒");
    }
  }

  async function sendPostureRecoveryNotification() {
    await closeSystemNotification(POSTURE_REMINDER_TAG);
    await wait(NOTIFICATION_SWAP_DELAY_MS);
    const delivered = await sendSystemReminderNotification("姿势恢复正常", "做得很好，继续保持这个位置", POSTURE_RECOVERY_TAG, {
      showPermissionHint: false,
      urgent: true,
      requireInteraction: false,
      autoCloseMs: RECOVERY_NOTIFICATION_CLOSE_MS
    });
    if (delivered) {
      setStatusMessage("姿势已恢复，已发送 iMac 右上角夸奖提醒");
    }
  }

  function showPositiveFeedback(message = "做得很好，继续保持这个位置") {
    setPositiveMessage(message);
    setShowPositive(true);
    if (positiveTimeoutRef.current) window.clearTimeout(positiveTimeoutRef.current);
    positiveTimeoutRef.current = window.setTimeout(() => {
      setShowPositive(false);
    }, 5200);
  }

  function showGentleReminder(title, message, tone = "posture", durationMs = 7600) {
    setReminderTitle(title);
    setReminderText(message);
    setReminderTone(tone);
    setShowReminder(true);
    if (reminderTimeoutRef.current) window.clearTimeout(reminderTimeoutRef.current);
    reminderTimeoutRef.current = window.setTimeout(() => {
      setShowReminder(false);
      reminderTimeoutRef.current = null;
    }, durationMs);
  }

  function updatePresenceStatus(status) {
    presenceStatusRef.current = status;
    setPresenceStatus(status);
  }

  function closeReminderToast() {
    setShowReminder(false);
    if (reminderTimeoutRef.current) {
      window.clearTimeout(reminderTimeoutRef.current);
      reminderTimeoutRef.current = null;
    }
  }

  function pauseForMissingPerson() {
    if (!presencePausedRef.current) {
      presencePausedRef.current = true;
      updatePresenceStatus("away");
      setStatusMessage("未检测到人物，监测和提醒已自动暂停；回来后会自动继续");
    }

    abnormalStartRef.current = null;
    reminderShownRef.current = false;
    posturePraisePendingRef.current = false;
    postureReminderActiveRef.current = false;
    lastStatsWallClockRef.current = null;
    lastAnalysisRef.current = performance.now();
    reminderScheduleRef.current = createReminderSchedule(reminderSettingsRef.current, Date.now());
    closeReminderToast();
    closeSystemNotification(POSTURE_REMINDER_TAG);

    const pausedState = { status: "idle", issues: [], score: 0, abnormalMs: 0 };
    postureStateRef.current = pausedState;
    setPostureState(pausedState);
  }

  function resumeAfterPersonReturn(now = performance.now()) {
    const wasPaused = presencePausedRef.current || presenceStatusRef.current !== "present";
    presencePausedRef.current = false;
    updatePresenceStatus("present");
    lastPersonSeenAtRef.current = now;
    if (!wasPaused) return;

    lastAnalysisRef.current = now;
    abnormalStartRef.current = null;
    reminderShownRef.current = false;
    posturePraisePendingRef.current = false;
    postureReminderActiveRef.current = false;
    reminderScheduleRef.current = createReminderSchedule(reminderSettingsRef.current, Date.now());
    lastStatsWallClockRef.current = baselineRef.current ? Date.now() : null;

    setStatusMessage(baselineRef.current ? "人物已回来，监测已自动继续" : "已检测到人物，请保持自然坐姿后校准");
  }

  function updateStatsForAnalysis(isAbnormal, currentAbnormalMs, score, eventStarted, intervalMs) {
    setStats((previous) => {
      const date = todayKey();
      const base = normalizeStats(previous.date === date ? previous : emptyStats(date));
      const nowDate = new Date();
      const hourKey = getHourKey(nowDate);
      const hourly = { ...base.hourly };
      const bucket = {
        monitoredMs: 0,
        abnormalMs: 0,
        scoreTotal: 0,
        samples: 0,
        ...(hourly[hourKey] || {})
      };
      const interval = Math.max(0, intervalMs ?? ANALYSIS_INTERVAL_MS);
      const nextBucket = {
        ...bucket,
        monitoredMs: bucket.monitoredMs + interval,
        abnormalMs: bucket.abnormalMs + (isAbnormal ? interval : 0),
        scoreTotal: bucket.scoreTotal + score,
        samples: bucket.samples + 1
      };
      hourly[hourKey] = nextBucket;

      const monitoredTotalMs = base.monitoredTotalMs + interval;
      const abnormalTotalMs = base.abnormalTotalMs + (isAbnormal ? interval : 0);
      const goodTotalMs = base.goodTotalMs + (!isAbnormal ? interval : 0);
      const abnormalCount = base.abnormalCount + (eventStarted ? 1 : 0);
      const worstScore = Math.max(base.worstScore || 0, score);

      return {
        ...base,
        hunchCount: abnormalCount,
        abnormalCount,
        monitoredTotalMs,
        goodTotalMs,
        abnormalTotalMs,
        longestAbnormalMs: Math.max(base.longestAbnormalMs, currentAbnormalMs),
        worstScore,
        worstAt: score >= (base.worstScore || 0) ? nowDate.toISOString() : base.worstAt,
        hourly
      };
    });
  }

  function handlePostureAnalysis(metrics) {
    const activeBaseline = baselineRef.current;
    if (!activeBaseline || !metrics) return;

    const wallNow = Date.now();
    const intervalMs = lastStatsWallClockRef.current
      ? Math.max(1000, wallNow - lastStatsWallClockRef.current)
      : ANALYSIS_INTERVAL_MS;
    lastStatsWallClockRef.current = wallNow;

    const result = evaluatePosture(metrics, activeBaseline, detectionSettingsRef.current);
    let abnormalMs = 0;
    let eventStarted = false;

    if (result.abnormal) {
      if (!abnormalStartRef.current) {
        abnormalStartRef.current = wallNow - intervalMs;
        reminderShownRef.current = false;
        eventStarted = true;
      }
      abnormalMs = wallNow - abnormalStartRef.current;

      const postureReminderMs = reminderSettingsRef.current.postureReminderSeconds * 1000;
      if (abnormalMs >= postureReminderMs && !reminderShownRef.current) {
        const { title, message } = buildPostureReminder(result.issues);
        reminderShownRef.current = true;
        posturePraisePendingRef.current = true;
        postureReminderActiveRef.current = true;
        showGentleReminder(title, message, "posture");
        sendPostureNotification(title, message);
      }
    } else {
      if (posturePraisePendingRef.current || postureReminderActiveRef.current) {
        closeReminderToast();
        showPositiveFeedback("做得很好，姿势已经恢复正常");
        sendPostureRecoveryNotification();
        setStatusMessage("姿势已恢复，做得很好");
      }
      abnormalStartRef.current = null;
      reminderShownRef.current = false;
      posturePraisePendingRef.current = false;
      postureReminderActiveRef.current = false;
    }

    updateStatsForAnalysis(result.abnormal, abnormalMs, result.score, eventStarted, intervalMs);
    setPostureState({
      status: result.abnormal ? "abnormal" : "healthy",
      issues: result.issues,
      score: result.score,
      abnormalMs
    });
  }

  function stopDetectionLoop() {
    if (detectionTimerRef.current) {
      window.clearTimeout(detectionTimerRef.current);
      detectionTimerRef.current = null;
    }
  }

  function startDetectionLoop() {
    stopDetectionLoop();

    const tick = async () => {
      const now = performance.now();
      const video = videoRef.current;
      const poseLandmarker = poseLandmarkerRef.current;
      const faceLandmarker = faceLandmarkerRef.current;
      const useFaceLandmarker = faceLandmarker && !faceDetectionDisabledRef.current;

      if (
        video &&
        poseLandmarker &&
        video.readyState >= 2 &&
        !detectionBusyRef.current &&
        now - lastDetectionRef.current >= DETECTION_INTERVAL_MS
      ) {
        detectionBusyRef.current = true;
        lastDetectionRef.current = now;
        try {
          if (!useFaceLandmarker || nextDetectorRef.current === "pose") {
            latestPoseResultRef.current = {
              result: poseLandmarker.detectForVideo(video, now),
              timestamp: now
            };
            nextDetectorRef.current = useFaceLandmarker ? "face" : "pose";
          } else {
            latestFaceResultRef.current = {
              result: faceLandmarker.detectForVideo(video, now),
              timestamp: now
            };
            faceFailureCountRef.current = 0;
            nextDetectorRef.current = "pose";
          }

          const poseResult = latestPoseResultRef.current;
          const faceResult = latestFaceResultRef.current;
          const hasFreshPair =
            !useFaceLandmarker ||
            (poseResult &&
              faceResult &&
              Math.abs(poseResult.timestamp - faceResult.timestamp) < DETECTION_INTERVAL_MS * 4);
          const metrics = poseResult && hasFreshPair ? computeMetrics(poseResult.result, faceResult?.result) : null;
          if (metrics) {
            resumeAfterPersonReturn(now);
          } else if (
            lastPersonSeenAtRef.current &&
            now - lastPersonSeenAtRef.current >= PRESENCE_AWAY_TIMEOUT_MS
          ) {
            pauseForMissingPerson();
          }
          setCurrentMetrics(metrics);

          const activeBaseline = baselineRef.current;
          if (
            metrics &&
            activeBaseline &&
            !presencePausedRef.current &&
            now - lastAnalysisRef.current >= ANALYSIS_INTERVAL_MS
          ) {
            lastAnalysisRef.current = now;
            handlePostureAnalysis(metrics);
          }

          drawOverlay(canvasRef.current, video, metrics, postureStateRef.current);
        } catch (error) {
          const message = error.message || "";
          if (message.includes("GLctx") && nextDetectorRef.current === "face") {
            faceFailureCountRef.current += 1;
            nextDetectorRef.current = "pose";
            if (faceFailureCountRef.current >= 2) {
              faceDetectionDisabledRef.current = true;
              faceLandmarkerRef.current?.close?.();
              faceLandmarkerRef.current = null;
              latestFaceResultRef.current = null;
              setStatusMessage("Face 检测在当前浏览器不稳定，已切换到 Pose 眼睛点继续监测");
            }
          } else {
            setStatusMessage(`检测失败：${message || "请重新开启摄像头"}`);
          }
        } finally {
          detectionBusyRef.current = false;
        }
      }

      if (streamRef.current) {
        detectionTimerRef.current = window.setTimeout(tick, DETECTION_INTERVAL_MS);
      } else {
        detectionTimerRef.current = null;
      }
    };

    detectionTimerRef.current = window.setTimeout(tick, 0);
  }

  async function startCamera() {
    if (!isReady || cameraOn) return;

    try {
      setCameraStatus("starting");
      setStatusMessage("正在请求摄像头权限");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user"
        }
      });
      streamRef.current = stream;

      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      setCameraStatus("running");
      setStatusMessage("摄像头已开启，请保持自然坐姿后校准");
      presencePausedRef.current = false;
      lastPersonSeenAtRef.current = null;
      updatePresenceStatus("detecting");
      lastAnalysisRef.current = performance.now();
      lastStatsWallClockRef.current = baselineRef.current ? Date.now() : null;
      lastDetectionRef.current = 0;
      startDetectionLoop();
    } catch (error) {
      setCameraStatus("error");
      setStatusMessage(`无法开启摄像头：${error.message || "请检查浏览器权限"}`);
    }
  }

  function stopCamera() {
    stopDetectionLoop();
    latestPoseResultRef.current = null;
    latestFaceResultRef.current = null;
    nextDetectorRef.current = "pose";
    faceFailureCountRef.current = 0;
    faceDetectionDisabledRef.current = false;
    presencePausedRef.current = false;
    lastPersonSeenAtRef.current = null;
    updatePresenceStatus("idle");
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStatus("idle");
    setCurrentMetrics(null);
    setPostureState({ status: "idle", issues: [], score: 0, abnormalMs: 0 });
    abnormalStartRef.current = null;
    reminderShownRef.current = false;
    posturePraisePendingRef.current = false;
    postureReminderActiveRef.current = false;
    setShowReminder(false);
    closeSystemNotification(POSTURE_REMINDER_TAG);
    closeSystemNotification(POSTURE_RECOVERY_TAG);
    if (reminderTimeoutRef.current) {
      window.clearTimeout(reminderTimeoutRef.current);
      reminderTimeoutRef.current = null;
    }
    lastStatsWallClockRef.current = null;
    lastAnalysisRef.current = 0;
    lastDetectionRef.current = 0;
    setStatusMessage("摄像头已关闭");
  }

  function calibratePosture() {
    if (!currentMetrics) {
      setStatusMessage("还没有稳定识别到眼睛、头部和肩膀，请面向摄像头稍等片刻");
      return;
    }

    setBaseline({ ...currentMetrics, calibratedAt: new Date().toISOString() });
    presencePausedRef.current = false;
    lastPersonSeenAtRef.current = performance.now();
    updatePresenceStatus("present");
    abnormalStartRef.current = null;
    reminderShownRef.current = false;
    posturePraisePendingRef.current = false;
    postureReminderActiveRef.current = false;
    closeSystemNotification(POSTURE_REMINDER_TAG);
    closeSystemNotification(POSTURE_RECOVERY_TAG);
    lastAnalysisRef.current = performance.now();
    lastStatsWallClockRef.current = Date.now();
    setPostureState({ status: "healthy", issues: [], score: 0, abnormalMs: 0 });
    setStatusMessage("校准完成，将在后台按真实时间持续分析坐姿");
  }

  function resetTodayStats() {
    const fresh = emptyStats();
    setStats(fresh);
    saveTodayStats(fresh);
  }

  function updateReminderSetting(patch) {
    setReminderSettings((previous) => normalizeReminderSettings({ ...previous, ...patch }));
  }

  function updateDetectionSetting(patch) {
    setDetectionSettings((previous) => normalizeDetectionSettings({ ...previous, ...patch }));
  }

  function resetDetectionSettings() {
    setDetectionSettings(DEFAULT_DETECTION_SETTINGS);
  }

  function shiftCalendarMonth(offset) {
    setCalendarMonth((previous) => new Date(previous.getFullYear(), previous.getMonth() + offset, 1));
  }

  const statusTone = useMemo(() => {
    if (presenceStatus === "away") return "border-slate-200 bg-slate-50 text-slate-600";
    if (postureState.status === "abnormal") return "border-amber-200 bg-amber-50 text-amber-800";
    if (postureState.status === "healthy") return "border-emerald-200 bg-emerald-50 text-emerald-800";
    return "border-slate-200 bg-white/80 text-slate-600";
  }, [presenceStatus, postureState.status]);

  const dailyScore = useMemo(() => getPostureScore(stats), [stats]);
  const dailyTrend = useMemo(() => buildDailyTrend(stats), [stats]);
  const worstHour = useMemo(() => getWorstHour(stats), [stats]);
  const naturalSummary = useMemo(() => getNaturalSummary(stats), [stats]);
  const allStatsByDate = useMemo(() => {
    const loaded = loadAllDailyStats();
    loaded[stats.date] = normalizeStats(stats);
    return loaded;
  }, [stats]);
  const monthCells = useMemo(() => buildMonthCalendar(calendarMonth), [calendarMonth]);
  const selectedDateStats = useMemo(
    () => allStatsByDate[selectedCalendarDate] || emptyStats(selectedCalendarDate),
    [allStatsByDate, selectedCalendarDate]
  );
  const selectedDateScore = useMemo(() => getPostureScore(selectedDateStats), [selectedDateStats]);
  const monthKey = useMemo(() => getMonthKey(calendarMonth), [calendarMonth]);
  const monthStats = useMemo(
    () =>
      Object.values(allStatsByDate)
        .filter((item) => item.date?.startsWith(monthKey))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [allStatsByDate, monthKey]
  );
  const boardSummary = useMemo(() => summarizeStatsList(monthStats), [monthStats]);
  const boardTrend = useMemo(() => buildMonthlyTrend(calendarMonth, allStatsByDate), [calendarMonth, allStatsByDate]);
  const reminderCountdowns = useMemo(() => {
    const schedule = reminderScheduleRef.current;
    return {
      eye: reminderSettings.eyeEnabled ? formatCountdown(schedule.eyeNextAt - reminderClock) : "已关闭",
      water: reminderSettings.waterEnabled ? formatCountdown(schedule.waterNextAt - reminderClock) : "已关闭"
    };
  }, [
    reminderClock,
    reminderSettings.postureReminderSeconds,
    reminderSettings.eyeEnabled,
    reminderSettings.eyeIntervalMinutes,
    reminderSettings.eyeRestSeconds,
    reminderSettings.waterEnabled,
    reminderSettings.waterIntervalMinutes
  ]);
  const ReminderIcon = reminderTone === "eye" ? Eye : reminderTone === "water" ? Droplets : BellRing;
  const reminderIconTone =
    reminderTone === "eye"
      ? "bg-indigo-50 text-indigo-500"
      : reminderTone === "water"
        ? "bg-cyan-50 text-cyan-500"
        : "bg-blue-50 text-[#007aff]";
  const notificationReady = notificationPermission === "granted";
  const notificationStatusLabel =
    notificationPermission === "granted"
      ? "iMac 系统通知已开启"
      : notificationPermission === "denied"
        ? "系统通知已被拒绝"
        : notificationPermission === "unsupported"
          ? "当前浏览器不支持系统通知"
          : "需要开启 iMac 系统通知";
  const notificationHelpText =
    notificationPermission === "granted"
      ? "所有提醒都会用 iMac 右上角系统通知发送，并保持强提醒模式。"
      : notificationPermission === "denied"
        ? "当前浏览器拒绝了通知。请点击地址栏左侧权限图标改为允许，并在 macOS 系统设置里允许当前浏览器通知，才能在 iMac 右上角弹出。"
      : notificationPermission === "unsupported"
        ? "当前浏览器不能发送系统通知，请用 Google Chrome 打开。"
        : "必须开启系统通知后，所有提醒才能出现在 iMac 右上角。";
  const postureReminderRemainingMs = Math.max(
    0,
    reminderSettings.postureReminderSeconds * 1000 - (postureState.abnormalMs || 0)
  );
  const isPresenceAway = presenceStatus === "away";
  const monitorStatusLabel = isPresenceAway
    ? "人已离开，监测暂停"
    : postureState.status === "abnormal"
      ? "检测到姿势问题"
      : postureState.status === "healthy"
        ? "状态很好"
        : "等待数据";
  const monitorFooterLabel = isPresenceAway ? "人离开，已暂停" : baseline ? "后台每 3 秒分析中" : "等待校准";

  return (
    <main className="min-h-screen bg-[#f5f5f7] px-5 py-6 text-slate-900 lg:px-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-black/10 pb-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
              <ShieldCheck className="h-4 w-4" />
              Posture Care
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal text-slate-950">Posture</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-slate-950 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              onClick={startCamera}
              disabled={!isReady || cameraOn}
              title="开启摄像头"
            >
              <Camera className="h-4 w-4" />
              开启摄像头
            </button>
            <button
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-black/10 bg-white/80 px-4 text-sm font-medium text-slate-700 shadow-sm backdrop-blur transition hover:bg-white disabled:cursor-not-allowed disabled:text-slate-300"
              onClick={stopCamera}
              disabled={!cameraOn}
              title="关闭摄像头"
            >
              <CameraOff className="h-4 w-4" />
              关闭
            </button>
            <button
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#007aff] px-4 text-sm font-medium text-white shadow-sm transition hover:bg-[#006ee6] disabled:cursor-not-allowed disabled:bg-blue-200"
              onClick={calibratePosture}
              disabled={!cameraOn || !currentMetrics}
              title="校准坐姿"
            >
              <ScanFace className="h-4 w-4" />
              校准坐姿
            </button>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.55fr)]">
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950 shadow-soft">
            <div className="relative aspect-video bg-slate-900">
              <video ref={videoRef} className="mirror absolute inset-0 h-full w-full object-cover opacity-0" playsInline muted />
              <canvas ref={canvasRef} className="mirror absolute inset-0 h-full w-full" />
              {cameraOn ? (
                <div className="pointer-events-none absolute left-4 top-4 rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-xs font-medium text-teal-100 backdrop-blur">
                  隐私特效模式：真实面容不会显示
                </div>
              ) : null}
              {!cameraOn ? (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 px-6 text-center text-slate-200">
                  <div>
                    <Camera className="mx-auto h-10 w-10 text-slate-400" />
                    <p className="mt-4 text-lg font-medium">隐私特效画面将在这里显示</p>
                    <p className="mt-2 text-sm text-slate-400">摄像头只用于检测，真实面容不会展示</p>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex flex-col gap-3 border-t border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-teal-400" />
                {statusMessage}
              </div>
              <div className="flex items-center gap-2 text-slate-400">
                <TimerReset className="h-4 w-4" />
                {monitorFooterLabel}
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <div className="rounded-lg border border-slate-200 bg-white/90 p-2 shadow-sm backdrop-blur">
              <div className="grid grid-cols-3 gap-1">
                <PanelTab
                  icon={Activity}
                  label="监测"
                  active={activePanel === "monitor"}
                  onClick={() => setActivePanel("monitor")}
                />
                <PanelTab
                  icon={BellRing}
                  label="提醒"
                  active={activePanel === "reminders"}
                  onClick={() => setActivePanel("reminders")}
                />
                <PanelTab
                  icon={Sparkles}
                  label="设置"
                  active={activePanel === "settings"}
                  onClick={() => setActivePanel("settings")}
                />
              </div>
            </div>

            {activePanel === "settings" ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-950">人物特效</h2>
                <Sparkles className="h-5 w-5 text-teal-500" />
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-3 text-left text-teal-900">
                <div className="text-sm font-semibold">线框姿态</div>
                <div className="mt-1 text-xs leading-5 text-teal-700">
                  只显示头肩关键线条，不显示真实面容。
                </div>
              </div>
            </div>
            ) : null}

            {activePanel === "monitor" ? (
            <div className={`rounded-lg border px-4 py-4 ${statusTone}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-semibold">
                  {postureState.status === "abnormal" && !isPresenceAway ? <BellRing className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
                  {monitorStatusLabel}
                </div>
                <span className="rounded-full bg-white/70 px-3 py-1 text-xs font-medium">
                  舒适度 {Math.max(0, 100 - postureState.score)}
                </span>
              </div>
              <div className="mt-3 text-sm">
                {postureState.issues.length
                  ? postureState.issues.map((issue) => (
                      <div key={issue.key} className="mt-2 rounded-lg bg-white/60 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold">{issue.label}</span>
                          <span className="font-medium">{issue.value}</span>
                        </div>
                        <div className="mt-1 text-xs leading-5 text-slate-600">{issue.action}</div>
                      </div>
                    ))
                : isPresenceAway
                    ? "未检测到人物，统计和提醒已暂停。回到画面后会自动继续。"
                    : baseline
                    ? "当前很稳，保持轻松呼吸"
                    : "开启摄像头并校准后开始监测"}
              </div>
              {postureState.status === "abnormal" && !isPresenceAway ? (
                <div className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs font-medium">
                  {postureReminderRemainingMs > 0
                    ? `已连续偏离 ${formatDuration(postureState.abnormalMs)}，${formatDuration(postureReminderRemainingMs)} 后发送系统提醒`
                    : "系统提醒已触发，回到校准坐姿后会重新计时"}
                </div>
              ) : null}
            </div>
            ) : null}

            {activePanel === "reminders" ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-950">生活提醒</h2>
                <div className="flex items-center gap-1 text-slate-400">
                  <Eye className="h-5 w-5" />
                  <Droplets className="h-5 w-5" />
                </div>
              </div>

              <div className="space-y-5">
                <div
                  className={`rounded-lg border px-3 py-3 ${
                    notificationReady
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <BellRing className="h-4 w-4" />
                        {notificationStatusLabel}
                      </div>
                      <p className="mt-1 text-xs leading-5">{notificationHelpText}</p>
                    </div>
                    <button
                      className="shrink-0 rounded-lg bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-sm transition hover:bg-white disabled:cursor-not-allowed disabled:text-slate-400"
                      onClick={requestNotificationPermission}
                      disabled={notificationReady || notificationPermission === "unsupported"}
                      title="开启系统通知"
                    >
                      {notificationReady ? "已开启" : notificationPermission === "denied" ? "已拒绝" : "开启"}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-900">
                    姿态提醒
                    <span className="ml-2 text-xs font-medium text-slate-500">
                      连续异常 {reminderSettings.postureReminderSeconds} 秒后提醒
                    </span>
                    <input
                      type="number"
                      min="5"
                      max="300"
                      className="mt-3 h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-[#007aff]"
                      value={reminderSettings.postureReminderSeconds}
                      onChange={(event) => updateReminderSetting({ postureReminderSeconds: event.target.value })}
                    />
                  </label>
                  <p className="mt-2 text-xs leading-5 text-slate-500">默认 10 秒。可以设置 5 到 300 秒。</p>
                </div>

                <div className="border-t border-slate-100 pt-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-normal text-slate-400">生活节奏</div>
                </div>

                <div>
                  <label className="flex items-center justify-between gap-3 text-sm font-semibold text-slate-900">
                    <span className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-[#007aff]"
                        checked={reminderSettings.eyeEnabled}
                        onChange={(event) => updateReminderSetting({ eyeEnabled: event.target.checked })}
                      />
                      护眼休息
                    </span>
                    <span className="text-xs font-medium text-slate-500">下次 {reminderCountdowns.eye}</span>
                  </label>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="text-xs font-medium text-slate-500">
                      间隔（分钟）
                      <input
                        type="number"
                        min="1"
                        max="180"
                        className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-[#007aff] disabled:text-slate-300"
                        value={reminderSettings.eyeIntervalMinutes}
                        disabled={!reminderSettings.eyeEnabled}
                        onChange={(event) => updateReminderSetting({ eyeIntervalMinutes: event.target.value })}
                      />
                    </label>
                    <label className="text-xs font-medium text-slate-500">
                      远眺秒数
                      <input
                        type="number"
                        min="5"
                        max="120"
                        className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-[#007aff] disabled:text-slate-300"
                        value={reminderSettings.eyeRestSeconds}
                        disabled={!reminderSettings.eyeEnabled}
                        onChange={(event) => updateReminderSetting({ eyeRestSeconds: event.target.value })}
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">默认 20 分钟后提醒看远方 20 秒。</p>
                </div>

                <div className="border-t border-slate-100 pt-5">
                  <label className="flex items-center justify-between gap-3 text-sm font-semibold text-slate-900">
                    <span className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-[#007aff]"
                        checked={reminderSettings.waterEnabled}
                        onChange={(event) => updateReminderSetting({ waterEnabled: event.target.checked })}
                      />
                      喝水提醒
                    </span>
                    <span className="text-xs font-medium text-slate-500">下次 {reminderCountdowns.water}</span>
                  </label>
                  <label className="mt-3 block text-xs font-medium text-slate-500">
                    间隔（分钟）
                    <input
                      type="number"
                      min="1"
                      max="240"
                      className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-[#007aff] disabled:text-slate-300"
                      value={reminderSettings.waterIntervalMinutes}
                      disabled={!reminderSettings.waterEnabled}
                      onChange={(event) => updateReminderSetting({ waterIntervalMinutes: event.target.value })}
                    />
                  </label>
                  <p className="mt-2 text-xs leading-5 text-slate-500">默认每 60 分钟提醒一次。</p>
                </div>
              </div>
            </div>
            ) : null}

            {activePanel === "monitor" ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-950">实时指标</h2>
                <Gauge className="h-5 w-5 text-slate-400" />
              </div>
              {currentMetrics ? (
                <div className="space-y-4">
                  <MetricRow label="眼睛高度" value={currentMetrics.eyeY} baseline={baseline?.eyeY} lowerIsBetter />
                  <MetricRow label="头部深度" value={currentMetrics.headDepth} baseline={baseline?.headDepth} />
                  <MetricRow label="肩膀宽度" value={currentMetrics.shoulderWidth} baseline={baseline?.shoulderWidth} />
                  <MetricRow label="肩部高度差" value={currentMetrics.shoulderTilt} baseline={baseline?.shoulderTilt} />
                </div>
              ) : (
                <p className="text-sm leading-6 text-slate-500">
                  {isPresenceAway
                    ? "人离开画面后已暂停统计。重新回到画面中，指标会自动恢复。"
                    : "面向摄像头后，这里会显示眼睛、头部和肩膀的归一化检测值。"}
                </p>
              )}
              <div className="mt-5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950">提示阈值</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">偏移达到这里设置的程度就会判定为姿势问题；越接近校准姿势越敏感。</p>
                  </div>
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                    onClick={resetDetectionSettings}
                    title="恢复默认阈值"
                  >
                    <RefreshCcw className="h-3.5 w-3.5" />
                    默认
                  </button>
                </div>
                <ThresholdControl
                  label="眼睛下降"
                  description="眼睛高度比校准时下降超过多少画面高度时提醒。"
                  value={detectionSettings.eyeDropPercent}
                  min="1"
                  max="10"
                  step="0.5"
                  unit="%"
                  onChange={(value) => updateDetectionSetting({ eyeDropPercent: value })}
                />
                <ThresholdControl
                  label="头部前倾"
                  description="头部深度向前偏移超过多少时提醒。"
                  value={detectionSettings.headForwardOffset}
                  min="0.025"
                  max="0.16"
                  step="0.005"
                  onChange={(value) => updateDetectionSetting({ headForwardOffset: value })}
                />
                <ThresholdControl
                  label="肩膀内缩"
                  description="肩宽缩到校准肩宽的多少以下时提醒。"
                  value={detectionSettings.shoulderNarrowPercent}
                  min="70"
                  max="98"
                  step="1"
                  unit="%"
                  onChange={(value) => updateDetectionSetting({ shoulderNarrowPercent: value })}
                />
                <ThresholdControl
                  label="左右肩不平"
                  description="左右肩高度差超过多少时提醒。"
                  value={detectionSettings.shoulderTiltOffset}
                  min="0.015"
                  max="0.08"
                  step="0.005"
                  onChange={(value) => updateDetectionSetting({ shoulderTiltOffset: value })}
                />
              </div>
            </div>
            ) : null}

            {activePanel === "monitor" ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-base font-semibold text-slate-950">校准状态</h2>
              <div className="mt-3 flex items-center gap-3 text-sm text-slate-600">
                <span className={`h-2.5 w-2.5 rounded-full ${baseline ? "bg-teal-500" : "bg-slate-300"}`} />
                {baseline ? "已记录当前眼睛、头部和肩膀位置" : "尚未校准"}
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-500">
                请坐到你认为舒服且标准的位置后校准。后续检测会以本次姿势作为个人基准。
              </p>
            </div>
            ) : null}

            {activePanel === "settings" ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-base font-semibold text-slate-950">通知与权限</h2>
              <button
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-black/10 bg-slate-950 px-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                onClick={requestNotificationPermission}
                disabled={notificationPermission === "granted" || notificationPermission === "unsupported"}
                title="开启通知"
              >
                <BellRing className="h-4 w-4" />
                {notificationPermission === "granted" ? "通知已开启" : "开启通知"}
              </button>
              <div className="mt-3 grid gap-2 text-xs text-slate-500">
                <div className="rounded-lg bg-blue-50 px-3 py-2 leading-5 text-blue-700">
                  姿态错误、姿态恢复、护眼和喝水都会发送 iMac 右上角系统通知，全部使用强提醒模式。
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  通知权限：
                  {notificationPermission === "granted"
                    ? "已开启"
                    : notificationPermission === "denied"
                      ? "已被浏览器拒绝"
                      : notificationPermission === "unsupported"
                        ? "当前浏览器不支持"
                        : "未开启"}
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 leading-5">
                  通知通道：{notificationChannel}
                </div>
              </div>
              <div className="mt-3 space-y-3 text-sm leading-6 text-slate-600">
                <p>推荐使用 Google Chrome 打开本应用：在 Chrome 地址栏输入 http://localhost:5173。</p>
                <p>首次点击「开启摄像头」时，请在浏览器弹窗中选择允许；如果曾经拒绝，可点击地址栏左侧的网站权限图标重新允许摄像头。</p>
                <p>所有提醒都会走 iMac 右上角系统通知。点击「开启通知」并允许通知；macOS 还需要在系统设置里允许 Chrome 或当前浏览器发送通知。</p>
                <p>macOS 路径：系统设置 → 隐私与安全性 → 摄像头，允许 Chrome；系统设置 → 通知，允许 Chrome 并选择横幅或提醒。</p>
              </div>
            </div>
            ) : null}
          </aside>
        </section>

        <section className="border-t border-black/10 pt-5">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">记录</h2>
              <p className="mt-1 text-sm text-slate-500">今日、日历和看板数据都保存在本机浏览器 LocalStorage</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="rounded-lg border border-slate-200 bg-white/90 p-1 shadow-sm">
                <div className="grid grid-cols-3 gap-1">
                  <PanelTab
                    icon={CheckCircle2}
                    label="今日"
                    active={reportView === "today"}
                    onClick={() => setReportView("today")}
                  />
                  <PanelTab
                    icon={CalendarDays}
                    label="日历"
                    active={reportView === "calendar"}
                    onClick={() => setReportView("calendar")}
                  />
                  <PanelTab
                    icon={LayoutDashboard}
                    label="看板"
                    active={reportView === "board"}
                    onClick={() => setReportView("board")}
                  />
                </div>
              </div>
              <button
                className="inline-flex h-10 w-fit items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                onClick={resetTodayStats}
                title="重置今日数据"
              >
                <RefreshCcw className="h-4 w-4" />
                重置今日
              </button>
            </div>
          </div>

          {reportView === "today" ? (
            <>
              <ScoreWaveChart
                trend={dailyTrend}
                averageScore={dailyScore}
                title="今日姿态波形图"
                subtitle="按小时展示今天姿态稳定度，越高代表越稳定"
                emptyText="今天还没有足够数据，开始监测后这里会生成波形图。"
                ariaLabel="今日姿态评分波形图"
                placeholderAriaLabel="今日姿态评分波形图占位"
                rangeLabel="0 - 23 点"
              />

              <div className="mb-3 rounded-lg border border-black/10 bg-white/80 p-4 shadow-sm backdrop-blur">
                <div className="text-sm font-medium text-slate-500">自然语言总结</div>
                <div className="mt-2 text-base leading-7 text-slate-800">{naturalSummary}</div>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <StatCard icon={TimerReset} label="今日总监测时长" value={formatDuration(stats.monitoredTotalMs)} />
                <StatCard icon={CheckCircle2} label="姿态良好时长" value={formatDuration(stats.goodTotalMs)} />
                <StatCard icon={BellRing} label="异常次数" value={`${stats.abnormalCount} 次`} />
                <StatCard icon={TimerReset} label="最长连续异常" value={formatDuration(stats.longestAbnormalMs)} />
                <StatCard icon={Activity} label="姿态最差时间段" value={formatHourPeriod(worstHour)} />
                <StatCard icon={Gauge} label="今日坐姿评分" value={dailyScore === null ? "--" : `${dailyScore} 分`} />
              </div>
            </>
          ) : null}

          {reportView === "calendar" ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <button
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
                    onClick={() => shiftCalendarMonth(-1)}
                    title="上个月"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <div className="text-base font-semibold text-slate-950">{formatMonthTitle(calendarMonth)}</div>
                  <button
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
                    onClick={() => shiftCalendarMonth(1)}
                    title="下个月"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid grid-cols-7 gap-2 text-center text-xs font-medium text-slate-400">
                  {["日", "一", "二", "三", "四", "五", "六"].map((day) => (
                    <div key={day}>{day}</div>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-7 gap-2">
                  {monthCells.map((cell, index) => {
                    if (!cell) {
                      return <div key={`blank-${index}`} className="min-h-24 rounded-lg border border-transparent" />;
                    }

                    const dayStats = allStatsByDate[cell.key] || null;
                    const score = dayStats ? getPostureScore(dayStats) : null;
                    const isSelected = selectedCalendarDate === cell.key;

                    return (
                      <button
                        key={cell.key}
                        className={`min-h-24 rounded-lg border p-2 text-left transition hover:scale-[1.01] ${getScoreTone(score)} ${
                          isSelected ? "ring-2 ring-slate-950 ring-offset-2" : ""
                        }`}
                        onClick={() => setSelectedCalendarDate(cell.key)}
                        title={`${cell.key} 记录`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold">{cell.day}</span>
                          <span className="text-xs font-semibold">{score === null ? "--" : score}</span>
                        </div>
                        <div className="mt-3 text-xs leading-5">
                          {dayStats?.monitoredTotalMs ? (
                            <>
                              <div>{formatCompactDuration(dayStats.monitoredTotalMs)}</div>
                              <div>{dayStats.abnormalCount} 次异常</div>
                            </>
                          ) : (
                            <div>无记录</div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-medium text-slate-500">选中日期</div>
                <div className="mt-1 text-xl font-semibold text-slate-950">{selectedCalendarDate}</div>
                <div className="mt-4 divide-y divide-slate-100 rounded-lg bg-slate-50 px-3">
                  {[
                    ["坐姿评分", selectedDateScore === null ? "--" : `${selectedDateScore} 分`],
                    ["监测时长", formatDuration(selectedDateStats.monitoredTotalMs)],
                    ["良好时长", formatDuration(selectedDateStats.goodTotalMs)],
                    ["异常次数", `${selectedDateStats.abnormalCount} 次`],
                    ["最差时间段", formatHourPeriod(getWorstHour(selectedDateStats))]
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-3 py-3 text-sm">
                      <span className="text-slate-500">{label}</span>
                      <span className="text-right font-semibold text-slate-900">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {reportView === "board" ? (
            <div className="space-y-4">
              <ScoreWaveChart
                trend={boardTrend}
                averageScore={boardSummary.averageScore}
                title="坐姿波浪图"
                subtitle={`${formatMonthTitle(calendarMonth)} 评分走势，越高代表姿态越稳定`}
                emptyText="本月还没有足够数据，开始监测后这里会生成波浪图。"
                ariaLabel="本月坐姿评分波浪图"
                placeholderAriaLabel="本月坐姿评分波浪图占位"
                rangeLabel={`${boardTrend[0]?.day || 1} - ${boardTrend[boardTrend.length - 1]?.day || 1} 日`}
              />

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <StatCard icon={CalendarDays} label="本月记录天数" value={`${boardSummary.daysWithData} 天`} />
                <StatCard icon={TimerReset} label="本月监测时长" value={formatDuration(boardSummary.aggregate.monitoredTotalMs)} />
                <StatCard icon={Gauge} label="本月平均评分" value={boardSummary.averageScore === null ? "--" : `${boardSummary.averageScore} 分`} />
                <StatCard icon={BellRing} label="本月异常次数" value={`${boardSummary.aggregate.abnormalCount} 次`} />
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <Gauge className="h-4 w-4 text-slate-400" />
                    本月状态
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-slate-600">
                    <div className="flex justify-between gap-3">
                      <span>姿态良好时长</span>
                      <span className="font-semibold text-slate-900">{formatDuration(boardSummary.aggregate.goodTotalMs)}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>异常总时长</span>
                      <span className="font-semibold text-slate-900">{formatDuration(boardSummary.aggregate.abnormalTotalMs)}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>最长连续异常</span>
                      <span className="font-semibold text-slate-900">{formatDuration(boardSummary.aggregate.longestAbnormalMs)}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <Activity className="h-4 w-4 text-slate-400" />
                    关注点
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-slate-600">
                    <div className="flex justify-between gap-3">
                      <span>高峰时间</span>
                      <span className="font-semibold text-slate-900">{formatHourPeriod(boardSummary.worstHour)}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>最低分日期</span>
                      <span className="font-semibold text-slate-900">{boardSummary.worstDay?.date || "--"}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>最佳日期</span>
                      <span className="font-semibold text-slate-900">{boardSummary.bestDay?.date || "--"}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <LayoutDashboard className="h-4 w-4 text-slate-400" />
                    最近记录
                  </div>
                  <div className="mt-4 space-y-2">
                    {boardSummary.recentDays.length ? (
                      boardSummary.recentDays.map((item) => {
                        const score = getPostureScore(item);
                        return (
                          <div key={item.date} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                            <span className="font-medium text-slate-700">{item.date}</span>
                            <span className="text-slate-500">{score === null ? "--" : `${score} 分`}</span>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">本月还没有记录</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {showReminder ? (
        <div
          className="reminder-toast pointer-events-none fixed right-5 top-5 z-50 w-[min(360px,calc(100vw-40px))] rounded-lg border border-white/70 bg-white/90 p-4 text-slate-900 shadow-soft backdrop-blur"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 rounded-full p-2 ${reminderIconTone}`}>
              <ReminderIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{reminderTitle}</div>
              <p className="mt-1 text-sm leading-6 text-slate-600">{reminderText}</p>
            </div>
          </div>
        </div>
      ) : null}
      {showPositive ? (
        <div
          className="positive-toast fixed right-5 top-5 z-50 w-[min(360px,calc(100vw-40px))] rounded-lg border border-emerald-200 bg-emerald-50/95 p-4 text-emerald-950 shadow-soft backdrop-blur"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-emerald-100 p-2 text-emerald-600">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">姿势恢复正常</div>
              <p className="mt-1 text-sm leading-6 text-emerald-800">{positiveMessage}</p>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
