#!/usr/bin/env node
/**
 * Chrome Native Messaging Host
 * 负责按需启动/停止本地 Controller，并维护 Dashboard / Crawl 占用状态。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOST_STATE_FILE = path.join(__dirname, '.native_host_state.json');
const SERVER_PATH = path.join(__dirname, 'server.js');
const CONTROLLER_PORT = parseInt(process.env.CONTROLLER_PORT || '7893', 10);
const CONTROLLER_BASE_URL = `http://127.0.0.1:${CONTROLLER_PORT}`;
const CONTROLLER_READY_TIMEOUT_MS = 8000;
const UI_CLOSE_GRACE_MS = 5000;

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    let expectedLength = null;

    function cleanup() {
      process.stdin.off('readable', onReadable);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onEnd() {
      cleanup();
      reject(new Error('Native host stdin ended before a full message was received'));
    }

    function onReadable() {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        chunks.push(chunk);
        totalLength += chunk.length;

        if (expectedLength === null && totalLength >= 4) {
          const headerBuffer = Buffer.concat(chunks, totalLength);
          expectedLength = headerBuffer.readUInt32LE(0);
        }

        if (expectedLength !== null && totalLength >= expectedLength + 4) {
          const buffer = Buffer.concat(chunks, totalLength);
          cleanup();
          try {
            const body = buffer.subarray(4, 4 + expectedLength).toString('utf8');
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
          return;
        }
      }
    }

    process.stdin.on('readable', onReadable);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function createDefaultState() {
  return {
    uiClients: {},
    activeCrawlCount: 0,
    ownedPid: null,
    lastStartedAt: null,
    lastEventAt: null
  };
}

function readState() {
  try {
    const raw = fs.readFileSync(HOST_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...createDefaultState(),
      ...parsed,
      uiClients: parsed && parsed.uiClients && typeof parsed.uiClients === 'object' ? parsed.uiClients : {}
    };
  } catch (_) {
    return createDefaultState();
  }
}

function writeState(state) {
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(state, null, 2));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCommand(command, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        success: false,
        error: `${command} timed out after ${timeoutMs}ms`,
        stdout,
        stderr
      });
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        success: false,
        error: error.message,
        stdout,
        stderr
      });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        success: code === 0,
        code,
        error: code === 0 ? '' : (stderr || `${command} exited with code ${code}`),
        stdout,
        stderr
      });
    });
  });
}

async function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'sh';
  const args = process.platform === 'win32' ? [command] : ['-lc', `command -v ${command}`];
  const result = await runCommand(checker, args, 1500);
  return result.success;
}

async function runPythonMouseClick(x, y) {
  const script = [
    'from pynput.mouse import Button, Controller',
    'import time',
    'mouse = Controller()',
    `mouse.position = (${x}, ${y})`,
    'time.sleep(0.08)',
    'mouse.press(Button.left)',
    'time.sleep(0.08)',
    'mouse.release(Button.left)'
  ].join('; ');

  const python = await commandExists('python3') ? 'python3' : 'python';
  if (!(await commandExists(python))) {
    return {
      success: false,
      error: 'Neither xdotool nor python/pynput is available for system-level clicking.'
    };
  }

  return runCommand(python, ['-c', script], 5000);
}

function normalizeCoordinate(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Math.round(number);
}

async function clickMouseAt(message) {
  const x = normalizeCoordinate(message.x, 'x');
  const y = normalizeCoordinate(message.y, 'y');

  if (process.platform === 'linux') {
    if (!(await commandExists('xdotool'))) {
      const sessionType = process.env.XDG_SESSION_TYPE || 'unknown';
      const pynputClick = await runPythonMouseClick(x, y);
      if (pynputClick.success) {
        return {
          ...pynputClick,
          platform: process.platform,
          sessionType,
          command: 'python3 pynput click',
          x,
          y
        };
      }

      return {
        success: false,
        error: `xdotool is not installed or unavailable, and pynput fallback failed. Current session=${sessionType}. pynput error: ${pynputClick.error || pynputClick.stderr || 'unknown'}`,
        platform: process.platform,
        sessionType,
        fallback: pynputClick
      };
    }

    const move = await runCommand('xdotool', ['mousemove', '--sync', String(x), String(y)], 3000);
    if (!move.success) {
      return { ...move, platform: process.platform, command: 'xdotool mousemove' };
    }

    const click = await runCommand('xdotool', ['click', '1'], 3000);
    return {
      ...click,
      platform: process.platform,
      command: 'xdotool click',
      x,
      y
    };
  }

  if (process.platform === 'darwin') {
    const script = `tell application "System Events" to click at {${x}, ${y}}`;
    const result = await runCommand('osascript', ['-e', script], 3000);
    return {
      ...result,
      platform: process.platform,
      command: 'osascript click',
      x,
      y
    };
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class Mouse { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra); }";',
      `[Mouse]::SetCursorPos(${x}, ${y}) | Out-Null;`,
      '[Mouse]::mouse_event(0x0002, 0, 0, 0, 0);',
      'Start-Sleep -Milliseconds 80;',
      '[Mouse]::mouse_event(0x0004, 0, 0, 0, 0);'
    ].join(' ');
    const result = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], 5000);
    return {
      ...result,
      platform: process.platform,
      command: 'powershell mouse_event',
      x,
      y
    };
  }

  return {
    success: false,
    error: `Unsupported platform for system click: ${process.platform}`,
    platform: process.platform
  };
}

function pingController(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(`${CONTROLLER_BASE_URL}/status`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });

    req.on('error', () => resolve(false));
  });
}

async function waitForControllerReady(timeoutMs = CONTROLLER_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pingController()) {
      return true;
    }
    await wait(250);
  }
  return false;
}

async function ensureControllerStarted(state) {
  if (await pingController()) {
    return {
      success: true,
      running: true,
      started: false,
      pid: state.ownedPid || null
    };
  }

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CONTROLLER_PORT: String(CONTROLLER_PORT)
    }
  });

  child.unref();
  state.ownedPid = child.pid;
  state.lastStartedAt = Date.now();
  writeState(state);

  const ready = await waitForControllerReady();
  if (!ready) {
    return {
      success: false,
      running: false,
      started: true,
      pid: child.pid,
      error: `Controller did not become ready on port ${CONTROLLER_PORT}`
    };
  }

  return {
    success: true,
    running: true,
    started: true,
    pid: child.pid
  };
}

function countUiClients(state) {
  return Object.keys(state.uiClients || {}).length;
}

async function stopOwnedControllerIfIdle(state) {
  const uiCount = countUiClients(state);
  if (uiCount > 0 || state.activeCrawlCount > 0) {
    return { success: true, stopped: false, reason: 'busy' };
  }

  if (UI_CLOSE_GRACE_MS > 0) {
    await wait(UI_CLOSE_GRACE_MS);
    const refreshedState = readState();
    const refreshedUiCount = countUiClients(refreshedState);
    if (refreshedUiCount > 0 || refreshedState.activeCrawlCount > 0) {
      return { success: true, stopped: false, reason: 'busy_after_grace' };
    }
    state = refreshedState;
  }

  if (!state.ownedPid) {
    return { success: true, stopped: false, reason: 'not_owned' };
  }

  try {
    process.kill(state.ownedPid, 'SIGTERM');
  } catch (error) {
    state.ownedPid = null;
    writeState(state);
    return { success: true, stopped: false, reason: `pid_unavailable:${error.code || 'unknown'}` };
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await pingController())) {
      state.ownedPid = null;
      writeState(state);
      return { success: true, stopped: true, reason: 'terminated' };
    }
    await wait(150);
  }

  try {
    process.kill(state.ownedPid, 'SIGKILL');
  } catch (_) {
    // ignore forced kill failure
  }

  state.ownedPid = null;
  writeState(state);
  return { success: true, stopped: true, reason: 'forced' };
}

async function handleSessionEvent(message, state) {
  const event = message.event;
  const clientId = typeof message.clientId === 'string' && message.clientId.trim()
    ? message.clientId.trim()
    : null;

  state.lastEventAt = Date.now();

  if (event === 'ui_open') {
    if (clientId) {
      state.uiClients[clientId] = {
        openedAt: Date.now(),
        source: message.source || 'unknown'
      };
    }
    writeState(state);
    const startup = await ensureControllerStarted(state);
    return {
      ...startup,
      event,
      uiCount: countUiClients(state),
      activeCrawlCount: state.activeCrawlCount
    };
  }

  if (event === 'ui_close') {
    if (clientId && state.uiClients[clientId]) {
      delete state.uiClients[clientId];
    }
    writeState(state);
    const stopResult = await stopOwnedControllerIfIdle(state);
    return {
      ...stopResult,
      running: await pingController(),
      event,
      uiCount: countUiClients(state),
      activeCrawlCount: state.activeCrawlCount
    };
  }

  if (event === 'crawl_start') {
    state.activeCrawlCount += 1;
    writeState(state);
    const startup = await ensureControllerStarted(state);
    return {
      ...startup,
      event,
      uiCount: countUiClients(state),
      activeCrawlCount: state.activeCrawlCount
    };
  }

  if (event === 'crawl_stop') {
    state.activeCrawlCount = Math.max(0, state.activeCrawlCount - 1);
    writeState(state);
    const stopResult = await stopOwnedControllerIfIdle(state);
    return {
      ...stopResult,
      running: await pingController(),
      event,
      uiCount: countUiClients(state),
      activeCrawlCount: state.activeCrawlCount
    };
  }

  return {
    success: false,
    error: `Unknown session event: ${event}`
  };
}

async function handleMessage(message, state) {
  const action = message && typeof message.action === 'string' ? message.action : '';

  switch (action) {
    case 'ensure_server':
    case 'start_server':
      return ensureControllerStarted(state);
    case 'check_status':
      return {
        success: true,
        running: await pingController(),
        uiCount: countUiClients(state),
        activeCrawlCount: state.activeCrawlCount,
        ownedPid: state.ownedPid || null
      };
    case 'session_event':
      return handleSessionEvent(message, state);
    case 'mouse_click':
      return clickMouseAt(message);
    default:
      return {
        success: false,
        error: `Unknown action: ${action}`
      };
  }
}

async function main() {
  try {
    const message = await readMessage();
    const state = readState();
    const response = await handleMessage(message, state);
    sendMessage(response);
  } catch (error) {
    sendMessage({
      success: false,
      error: error && error.message ? error.message : String(error)
    });
  }
}

main();
