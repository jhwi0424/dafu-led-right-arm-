'use strict';

const protocol = 'LED54/1';
const board = 'right-arm';
const pollMs = 500;
const historyMs = 30000;
const defaults = {
  protocol, board, result: 'OK', state: 'PWM_DONE', blue: 4, bootBlue: 4, maxBlue: 8, pixels: 54,
  pin: 'P0.09', order: 'GRB', bitRate: 800000, zeroDuty: 25, oneDuty: 50,
  latchUs: 400, frameBits: 1296, refreshMs: 250, timeoutMs: 2000, uptimeMs: 0,
  stopReason: 'BOOT', controlled: false, frameCount: 2, frameAgeMs: 0, vddMv: null, tempCentiC: null,
};
const reasons = {
  BOOT: '开机初始化', USER: '手动熄灯', NONE: '—', TIMEOUT: '通信超时',
  USB_LOST: '串口断开', FAULT: '驱动故障',
};
const faults = {
  FRAME_TIMEOUT: '帧发送超时', STOP_TIMEOUT: 'PWM 停止超时',
  NFC_PINS_NOT_GPIO: 'P0.09 未配置为 GPIO', STARTING: '正在初始化',
};
const el = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), node => [node.id, node]));

let mode = 'offline';
let link;
let exchange = false;
let latest;
let target = 0;
let pending = null;
let nextPoll = 0;
let updated = 0;
let samples = [];
let demoStart = 0;

const encoder = new TextEncoder();
const duty = blue => (blue * 100 / 255).toFixed(2);
const format = (id, value) => {
  if (el[id].textContent !== value) el[id].textContent = value;
};

function setMessage(message, error = false) {
  format('message', message);
  el.message.dataset.tone = error ? 'error' : 'info';
}

function render() {
  const data = latest;
  const max = data?.maxBlue ?? defaults.maxBlue;
  const commandable = (mode === 'serial' || mode === 'demo') && data?.state === 'PWM_DONE' && max > 0;
  const working = mode === 'connecting' || mode === 'closing';
  const blue = data && data.blue >= 0 ? data.blue : null;
  const names = { offline: '未连接', demo: '离线演示中', connecting: '连接中', serial: '串口已连接', closing: '正在断开' };
  format('connection', names[mode]);
  el.connection.dataset.mode = working ? 'working' : mode;
  format('connect-label', mode === 'serial' || mode === 'closing' ? '断开串口' : '连接串口');
  format('demo', mode === 'demo' ? '退出演示' : '离线演示');
  el.connect.disabled = working;
  el.demo.disabled = working || mode === 'serial';
  el.controls.disabled = !commandable;
  el.down.disabled = target <= 0;
  el.up.disabled = target >= max;
  el.brightness.max = max;
  el.brightness.value = target;
  el.brightness.style.setProperty('--position', (max ? target / max * 100 : 0) + '%');
  el.brightness.setAttribute('aria-valuetext', duty(target) + '%');
  format('target', duty(target) + '%');
  format('slider-limit', duty(max) + '% 上限');
  format('duty', blue === null ? '—' : duty(blue));
  format('raw', (blue ?? '—') + ' / 255');

  const healthy = data?.state === 'PWM_DONE';
  el['output-state'].dataset.output = data && !healthy ? 'fault' : blue > 0 ? 'on' : 'off';
  format('output-state', !data ? '等待连接' : !healthy ? '驱动异常' : blue > 0 ? '蓝光输出' : '已发送熄灯帧');
  format('drive-state', !data ? '—' : healthy ? 'PWM 正常' : faults[data.state] || data.state);
  format('led-info', data ? data.pixels + ' 颗 / ' + data.pin : '—');
  format('color', data ? data.order + ' / ' + (blue === null ? '—' : '0, 0, ' + blue) : '—');
  format('rate', data ? data.bitRate / 1000 + ' kbit/s' : '—');
  format('timing', data ? data.zeroDuty + '% / ' + data.oneDuty + '%' : '—');
  format('latch', data ? data.latchUs + ' µs' : '—');
  format('frame-bits', data ? data.frameBits + ' bit' : '—');
  format('refresh', data ? data.refreshMs + ' ms' : '—');
  format('frames', data ? data.frameCount + ' / ' + (data.frameCount ? data.frameAgeMs + ' ms' : '—') : '—');
  format('uptime', data ? Math.floor(data.uptimeMs / 1000) + ' s' : '—');
  format('reason', data ? reasons[data.stopReason] || data.stopReason : '—');
  format('voltage', data?.vddMv != null ? (data.vddMv / 1000).toFixed(2) + ' V' : '—');
  format('temperature', data?.tempCentiC != null ? (data.tempCentiC / 100).toFixed(2) + ' °C' : '—');
  format('ceiling', max + ' / 255');
  format('watchdog', (data?.timeoutMs ?? defaults.timeoutMs) / 1000 + ' s');
  format('watchdog-state', data ? (data.controlled ? '已启用' : '待命') : '—');
  format('boot-blue', (data?.bootBlue ?? defaults.bootBlue) + ' / 255');
  format('age', !data ? '等待数据' : mode === 'demo' ? '演示数据' : '已更新 ' + ((performance.now() - updated) / 1000).toFixed(1) + ' s 前');
  const pixels = data?.pixels ?? defaults.pixels;
  const grid = el['led-grid'];
  if (grid.childElementCount !== pixels) {
    grid.replaceChildren(...Array.from({ length: pixels }, () => document.createElement('i')));
  }
  grid.style.setProperty('--light', max && blue > 0 ? Math.sqrt(blue / max) : 0);
  format('pixel-caption', pixels + ' 颗 · 蓝光');
}

function accept(data) {
  latest = data;
  updated = performance.now();
  if (data.blue >= 0) samples.push({ time: updated, blue: data.blue });
  if (pending === null) target = Math.max(data.blue, 0);
  render();
}

function resetData() {
  latest = undefined;
  pending = null;
  target = 0;
  nextPoll = 0;
  samples = [];
}

function decode(line) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (data?.protocol !== protocol || data.board !== board) return null;
  const integers = ['blue', 'bootBlue', 'maxBlue', 'pixels', 'bitRate', 'zeroDuty', 'oneDuty', 'latchUs',
    'frameBits', 'refreshMs', 'timeoutMs', 'uptimeMs', 'frameCount', 'frameAgeMs', 'vddMv', 'tempCentiC'];
  const strings = ['state', 'pin', 'order', 'result', 'stopReason'];
  if (!integers.every(key => Number.isInteger(data[key])) || !strings.every(key => typeof data[key] === 'string') ||
      data.maxBlue < 0 || data.maxBlue > 255 || data.blue < -1 || data.blue > data.maxBlue ||
      typeof data.controlled !== 'boolean' || data.pixels !== defaults.pixels || data.pin !== defaults.pin ||
      data.frameBits !== data.pixels * 24 || data.timeoutMs < 1000 ||
      data.bootBlue < 0 || data.bootBlue > data.maxBlue) {
    return null;
  }
  return data;
}

class SerialLink {
  constructor(port) {
    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.waiting = null;
    this.stopped = false;
    this.reading = this.read();
  }

  finish(error, value) {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    clearTimeout(waiting.timer);
    if (error) waiting.reject(error);
    else waiting.resolve(value);
  }

  request(command, timeoutMs = 1200) {
    if (this.stopped || this.waiting) return Promise.reject(new Error('串口当前不可用。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(new Error('灯板回报超时。')), timeoutMs);
      const waiting = { resolve, reject, timer };
      this.waiting = waiting;
      this.writer.write(encoder.encode(command + '\n')).catch(error => {
        if (this.waiting === waiting) this.finish(error);
      });
    });
  }

  async read() {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.length > 512) continue;
          const data = decode(line);
          if (data) this.finish(null, data);
        }
        if (buffer.length > 512) buffer = '';
      }
    } catch (error) {
      this.finish(error);
    } finally {
      this.stopped = true;
      this.finish(new Error('串口已断开。'));
      this.reader.releaseLock();
    }
  }

  async close() {
    this.stopped = true;
    this.finish(new Error('串口已关闭。'));
    await Promise.allSettled([this.reader.cancel(), this.writer.abort()]);
    await this.reading;
    this.writer.releaseLock();
    await this.port.close();
  }
}

async function closeLink(message, error = false) {
  const oldLink = link;
  link = undefined;
  mode = 'closing';
  resetData();
  render();
  try {
    await oldLink?.close();
  } catch (closeError) {
    console.debug('Serial close:', closeError);
  }
  mode = 'offline';
  setMessage(message, error);
  render();
}

async function connect() {
  if (mode === 'serial') {
    mode = 'closing';
    pending = 0;
    setMessage('正在发送熄灯指令并关闭串口。');
    render();
    void tick();
    return;
  }
  if (!navigator.serial || !window.isSecureContext) {
    setMessage('请用桌面版 Chrome 或 Edge 打开 localhost 页面连接串口。', true);
    return;
  }
  let port;
  mode = 'connecting';
  resetData();
  setMessage('请选择 LED54 Right Arm 的 USB 串口。');
  render();
  try {
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x239a, usbProductId: 0x80da }] });
    await port.open({ baudRate: 115200 });
    await port.setSignals({ dataTerminalReady: true });
    link = new SerialLink(port);
    let data;
    try {
      data = await link.request('GET');
    } catch {
      throw new Error('未收到右灯臂回报。请选择右灯臂，并确认已刷入 led54_control.uf2。');
    }
    mode = 'serial';
    accept(data);
    setMessage(data.state === 'PWM_DONE' ? '拖动滑块或按 ＋ / − 调整蓝光。' :
      '驱动异常，请查看状态。若灯板仍亮，请切断灯板电源。', data.state !== 'PWM_DONE');
  } catch (error) {
    if (!link && port?.readable) await port.close().catch(() => {});
    const message = error.name === 'NotFoundError' ? '未选择串口。' :
      error.name === 'NetworkError' ? '串口打开失败。请关闭占用该端口的串口工具后重试。' : error.message;
    await closeLink(message, error.name !== 'NotFoundError');
  }
}

function adjust(value) {
  if (el.controls.disabled || !Number.isInteger(value)) return;
  target = Math.max(0, Math.min(latest.maxBlue, value));
  if (mode === 'demo') {
    pending = null;
    accept({ ...latest, blue: target, controlled: target > 0, stopReason: target ? 'NONE' : 'USER' });
    return;
  }
  pending = target;
  render();
  if (target === 0) void tick();
}

async function tick() {
  const now = performance.now();
  if (mode === 'demo' && now >= nextPoll) {
    nextPoll = now + pollMs;
    const uptimeMs = Math.floor(now - demoStart);
    accept({ ...latest, uptimeMs, frameCount: 2 + Math.floor(uptimeMs / defaults.refreshMs),
      frameAgeMs: uptimeMs % defaults.refreshMs });
  }
  if (exchange || !link || (mode !== 'serial' && mode !== 'closing')) return;
  if (pending === null && now < nextPoll && mode !== 'closing') return;

  exchange = true;
  const selected = pending;
  pending = null;
  nextPoll = now + pollMs;
  const command = selected !== null ? 'SET ' + selected : latest?.controlled && !document.hidden ? 'KEEP' : 'GET';
  try {
    const data = await link.request(command);
    accept(data);
    if (mode === 'closing' && selected === 0) {
      const confirmed = data.blue === 0;
      await closeLink(confirmed ? '已收到熄灯回报，串口已断开。' : '串口已断开。灯板熄灯状态未确认。', !confirmed);
    } else if (data.state !== 'PWM_DONE') {
      pending = null;
      setMessage('驱动异常。若灯板仍亮，请切断灯板电源。', true);
    } else if (data.result !== 'OK') {
      setMessage(data.result === 'LIMIT' ? '指令超出固件上限。' : '固件拒绝了指令。', true);
    } else if (data.stopReason === 'TIMEOUT' || data.stopReason === 'USB_LOST') {
      setMessage('固件因通信中断已发送熄灯帧。');
    } else if (selected !== null) {
      setMessage(selected === 0 ? '固件已回报熄灯。' : '亮度已更新。');
    }
  } catch {
    await closeLink('串口通信中断，等待固件超时熄灯。', true);
  } finally {
    exchange = false;
    if (pending === 0) void tick();
  }
}

function drawChart() {
  const canvas = el.chart;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  const bitmapWidth = Math.round(width * ratio);
  const bitmapHeight = Math.round(height * ratio);
  if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
  }
  const ctx = canvas.getContext('2d');
  const style = getComputedStyle(canvas);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const now = performance.now();
  const start = now - historyMs;
  while (samples.length > 1 && samples[1].time < start) samples.shift();
  const points = samples.filter(point => point.time >= start);
  const limit = Math.max(1, latest?.maxBlue ?? defaults.maxBlue);
  const x0 = 49, x1 = width - 10, y0 = height - 25, y1 = 12;
  const x = time => x0 + (time - start) / historyMs * (x1 - x0);
  const y = blue => y0 - blue / limit * (y0 - y1);
  ctx.font = '11px ' + style.getPropertyValue('--mono');
  ctx.strokeStyle = style.getPropertyValue('--line');
  ctx.fillStyle = style.getPropertyValue('--muted');
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  for (const blue of [0, limit / 2, limit]) {
    const level = y(blue);
    ctx.beginPath();
    ctx.moveTo(x0, level);
    ctx.lineTo(x1, level);
    ctx.stroke();
    ctx.fillText(blue ? duty(blue) + '%' : '0%', 1, level + 3);
  }
  ctx.fillText('−30 s', x0, height - 5);
  ctx.textAlign = 'right';
  ctx.fillText('0 s', x1, height - 5);
  ctx.strokeStyle = ctx.fillStyle = style.getPropertyValue('--accent');
  ctx.lineWidth = 2;
  let previous = null;
  ctx.beginPath();
  for (const point of points) {
    if (previous && point.time - previous.time <= 1500) {
      ctx.lineTo(x(point.time), y(previous.blue));
      ctx.lineTo(x(point.time), y(point.blue));
    } else {
      ctx.moveTo(x(point.time), y(point.blue));
    }
    previous = point;
  }
  ctx.stroke();
  if (previous) {
    ctx.beginPath();
    ctx.arc(x(previous.time), y(previous.blue), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  el['chart-empty'].hidden = points.length > 0;
}

el.connect.addEventListener('click', connect);
el.demo.addEventListener('click', () => {
  resetData();
  if (mode === 'demo') {
    mode = 'offline';
    setMessage('连接右灯臂开始调光，或打开离线演示。');
    render();
  } else {
    mode = 'demo';
    demoStart = performance.now();
    accept({ ...defaults });
    setMessage('离线演示。调整只影响此页面。');
  }
});
el.brightness.addEventListener('input', event => adjust(event.target.valueAsNumber));
el.down.addEventListener('click', () => adjust(target - 1));
el.up.addEventListener('click', () => adjust(target + 1));
el.off.addEventListener('click', () => adjust(0));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'serial' && latest?.controlled) adjust(0);
});
setInterval(() => void tick(), 80);
setInterval(drawChart, 250);
new ResizeObserver(drawChart).observe(el.chart);
render();
drawChart();
