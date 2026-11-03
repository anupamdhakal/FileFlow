import express from 'express';
import multer from 'multer';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

const MiB = 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * MiB;
const MAX_IMAGE_BYTES = 100 * MiB;
const MAX_MEDIA_BYTES = 64 * MiB;
const MAX_PDF_BYTES = 48 * MiB;
const MAX_PDF_PAGES = 50;
const MAX_PDF_PAGE_BYTES = 8 * MiB;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_VIDEO_PIXELS = 8_294_400;
const IMAGE_TIMEOUT_MS = 120_000;
const MEDIA_TIMEOUT_MS = 10 * 60_000;
const PDF_TIMEOUT_MS = 180_000;
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };
const outputFormats = ['png', 'jpeg', 'webp', 'avif'] as const;
const children = new Set<ChildProcess>();
const activeSignals = new Set<AbortController>();

function envInt(key: string, fallback: number, min: number, max: number) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${key} configuration.`);
  return n;
}
const PORT = envInt('PORT', 3001, 1, 65535);
const MAX_CONCURRENT = envInt('MAX_CONCURRENT_CONVERSIONS', 2, 1, 8);
const CONVERSION_TIMEOUT_MS = envInt('CONVERSION_TIMEOUT_MS', MEDIA_TIMEOUT_MS, 30_000, 30 * 60_000);
const production = process.env.NODE_ENV === 'production';
function envBool(key: string, fallback: boolean) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid ${key} configuration. Use true or false.`);
}
const forceHttps = envBool('FORCE_HTTPS', false);
const proxySetting = process.env.TRUST_PROXY;
const trustProxy = !proxySetting || proxySetting === 'false' ? false : proxySetting === 'true' ? true : envInt('TRUST_PROXY', 0, 0, 5);
const configuredOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : undefined;
if (production && configuredOrigin && !configuredOrigin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must use HTTPS in production.');
async function createTempRoot() {
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('fileflow-')) continue;
    const previous = path.join(tmpdir(), entry.name);
    try {
      if (!(await lstat(previous)).isDirectory()) continue;
      const ownerPath = path.join(previous, '.owner');
      if (!(await lstat(ownerPath)).isFile()) continue;
      const ownerPid = Number((await readFile(ownerPath, 'utf8')).trim());
      if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) continue;
      try { process.kill(ownerPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(previous, { recursive: true, force: true });
      }
    } catch {}
  }
  const root = await mkdtemp(path.join(tmpdir(), 'fileflow-'));
  await writeFile(path.join(root, '.owner'), String(process.pid), { mode: 0o600 });
  return root;
}
const tempRoot = await createTempRoot();

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxy);

function safeError(res: express.Response, status: number, message: string) {
  if (!res.headersSent && !res.destroyed) res.status(status).json({ error: message });
}
function safeBaseName(input: string) {
  const base = path.posix.basename((input || 'converted-file').replace(/\\/g, '/'));
  const stem = path.parse(base).name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return stem || 'converted-file';
}
function exactFields(body: unknown, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Conversion settings are missing or invalid.');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key)) || Object.values(record).some(value => typeof value !== 'string')) {
    throw new HttpError(400, 'One or more conversion settings are invalid.');
  }
  return record as Record<string, string>;
}
function integerField(value: string | undefined, name: string, min: number, max: number) {
  if (value === undefined || !/^\d+$/.test(value)) throw new HttpError(400, `Choose a valid ${name}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(400, `Choose a valid ${name}.`);
  return number;
}
function rateLimit(max: number, windowMs: number) {
  const records = new Map<string, { count: number; until: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let record = records.get(ip);
    if (!record || record.until <= now) {
      if (records.size >= 10_000) for (const [key, value] of records) if (value.until <= now) records.delete(key);
      if (!record && records.size >= 10_000) { safeError(res, 429, 'Too many requests. Please wait before trying again.'); return; }
      record = { count: 0, until: now + windowMs }; records.set(ip, record);
    }
    record.count++;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - record.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(record.until / 1000)));
    if (record.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((record.until - now) / 1000))));
      safeError(res, 429, 'Too many requests. Please wait before trying again.');
      return;
    }
    next();
  };
}
const apiLimit = rateLimit(120, 60_000);
const conversionLimit = rateLimit(20, 60_000);
let activeJobs = 0;
function conversionSlot(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (activeJobs >= MAX_CONCURRENT) { safeError(res, 429, 'FileFlow is busy processing other files. Please try again shortly.'); return; }
  activeJobs++;
  let released = false;
  const release = () => { if (!released) { released = true; activeJobs = Math.max(0, activeJobs - 1); req.removeListener('aborted', release); res.removeListener('close', release); } };
  res.locals.releaseConversionSlot = release;
  res.once('close', release);
  req.once('aborted', release);
  next();
}
function releaseSlot(res: express.Response) { (res.locals.releaseConversionSlot as (() => void) | undefined)?.(); }

const upload = multer({
  dest: tempRoot,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 6, fieldNameSize: 40, fieldSize: 100, parts: 8 },
});
function receiveFile(req: express.Request, res: express.Response, next: express.NextFunction) {
  upload.single('file')(req, res, error => {
    if (error) {
      releaseSlot(res);
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') safeError(res, 413, 'Files must be 100 MB or smaller.');
      else if (error instanceof multer.MulterError) safeError(res, 400, 'The upload could not be accepted. Check the file and try again.');
      else safeError(res, 400, 'Could not receive this file.');
      return;
    }
    if (!req.file) { releaseSlot(res); safeError(res, 400, 'Choose a file first.'); return; }
    next();
  });
}
function requireSameOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const origin = req.get('origin');
  if (origin) {
    let expected = configuredOrigin;
    try { expected ??= `${req.protocol}://${req.get('host')}`; } catch { expected = undefined; }
    if (!expected || origin !== expected) { safeError(res, 403, 'Cross-origin requests are not allowed.'); return; }
  }
  next();
}
function securityHeaders(req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (production) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (forceHttps || req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
app.use(securityHeaders);
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); }, apiLimit, requireSameOrigin);

function requestSignal(req: IncomingMessage, res: express.Response, timeoutMs: number) {
  const controller = new AbortController();
  activeSignals.add(controller);
  const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')); };
  req.once('aborted', disconnect);
  res.once('close', disconnect);
  const timer = setTimeout(() => controller.abort(new Error('Conversion timed out')), timeoutMs);
  timer.unref();
  const dispose = () => { clearTimeout(timer); req.removeListener('aborted', disconnect); res.removeListener('close', disconnect); activeSignals.delete(controller); };
  return { signal: controller.signal, dispose };
}
function processError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message === 'Conversion timed out') return new HttpError(504, 'Conversion took too long. Try a smaller file or shorter media.');
  if (signal?.aborted) return new HttpError(499, 'Conversion was cancelled.');
  return new HttpError(422, 'This file could not be converted. Check that it is a supported, uncorrupted file.');
}
function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500);
  timer.unref();
}
function run(command: string, args: string[], options: { signal?: AbortSignal; onProgress?: (progress: number) => void; duration?: number; outputPath?: string; outputDirectory?: string; maxOutputBytes?: number; temporaryDirectory?: string } = {}) {
  return new Promise<void>((resolve, reject) => {
    if (options.signal?.aborted) { reject(processError(options.signal)); return; }
    const env = command === 'magick' ? { ...process.env, MAGICK_TEMPORARY_PATH: options.temporaryDirectory || tempRoot } : process.env;
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    children.add(child);
    let pending = '';
    let outputLimitExceeded = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (monitor) clearInterval(monitor);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      children.delete(child);
      if (error) reject(error); else resolve();
    };
    const abort = () => { terminate(child); killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2500); killTimer.unref(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    let monitor: NodeJS.Timeout | undefined;
    if ((options.outputPath || options.outputDirectory) && options.maxOutputBytes) {
      monitor = setInterval(() => {
        const size = options.outputDirectory
          ? readdir(options.outputDirectory).then(files => Promise.all(files.map(file => stat(path.join(options.outputDirectory!, file)).then(item => item.size).catch(() => 0))).then(items => items.reduce((sum, item) => sum + item, 0)))
          : stat(options.outputPath!).then(info => info.size);
        void size.then(bytes => { if (bytes > options.maxOutputBytes!) { outputLimitExceeded = true; terminate(child); } }).catch(() => {});
      }, 500);
    }
    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      pending += text;
      const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/out_time_ms=(\d+)/);
        if (m && options.onProgress && options.duration && options.duration > 0) options.onProgress(Math.min(95, Math.max(1, Math.round(Number(m[1]) / 1_000_000 / options.duration * 100))));
      }
    });
    child.once('error', () => finish(new HttpError(503, 'A required conversion tool is unavailable.')));
    child.once('close', async code => {
      if (options.signal?.aborted) { finish(processError(options.signal)); return; }
      if (outputLimitExceeded) { finish(new HttpError(413, 'The converted file is too large to return safely.')); return; }
      if (code !== 0) { finish(new HttpError(422, 'This file could not be converted. Check that it is a supported, uncorrupted file.')); return; }
      if (options.outputPath && options.maxOutputBytes) {
        try {
          const output = await stat(options.outputPath);
          if (output.size > options.maxOutputBytes) { finish(new HttpError(413, 'The converted file is too large to return safely.')); return; }
          if (output.size === 0 || !output.isFile()) { finish(new HttpError(422, 'The conversion did not produce a valid output file.')); return; }
        }
        catch { finish(new HttpError(422, 'The conversion did not produce a valid output file.')); return; }
      }
      finish();
    });
    if (options.signal?.aborted) abort();
  });
}

async function capture(command: string, args: string[], signal?: AbortSignal, maxBytes = 64 * 1024, temporaryDirectory = tempRoot) {
  if (signal?.aborted) throw processError(signal);
  return new Promise<string>((resolve, reject) => {
    const env = command === 'magick' ? { ...process.env, MAGICK_TEMPORARY_PATH: temporaryDirectory } : process.env;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], env });
    children.add(child);
    let output = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout;
    let killTimer: NodeJS.Timeout | undefined;
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', abort); child.stdout?.removeAllListeners('data'); children.delete(child); };
    const abort = () => { terminate(child); killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2500); killTimer.unref(); };
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    timer = setTimeout(() => { terminate(child); fail(new HttpError(504, 'File inspection timed out.')); }, 15_000); timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => {
      if (settled) return;
      output = Buffer.concat([output, chunk]);
      if (output.length > maxBytes) { terminate(child); fail(new HttpError(415, 'The file contains too much metadata to process safely.')); }
    });
    child.once('error', () => fail(new HttpError(503, 'A required file inspection tool is unavailable.')));
    child.once('close', code => {
      if (signal?.aborted) { fail(processError(signal)); return; }
      if (code !== 0) { fail(new HttpError(415, 'The file appears malformed or is not supported.')); return; }
      if (settled) return;
      settled = true; cleanup(); resolve(output.toString('utf8'));
    });
  });
}

async function fileHead(filePath: string, length = 64) {
  const file = await open(filePath, 'r');
  try { const data = Buffer.alloc(length); const { bytesRead } = await file.read(data, 0, length, 0); return data.subarray(0, bytesRead); }
  finally { await file.close(); }
}
function imageMagic(head: Buffer): 'png' | 'jpeg' | 'webp' | 'avif' | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(head.toString('ascii', 8, 12))) return 'avif';
  return undefined;
}
function mediaMagic(head: Buffer) {
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') return 'audio';
  if (head.toString('ascii', 0, 4) === 'fLaC' || head.toString('ascii', 0, 4) === 'OggS' || head.toString('ascii', 0, 3) === 'ID3') return 'audio';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio';
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') return 'bmff';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'ebml';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'AVI ') return 'video';
  return undefined;
}
async function probeMedia(filePath: string, signal: AbortSignal) {
  const text = await capture('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,width,height', '-of', 'json', filePath], signal, 128 * 1024);
  let parsed: { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  try { parsed = JSON.parse(text); } catch { throw new HttpError(415, 'The media file appears malformed or is not supported.'); }
  const streams = parsed.streams || [];
  if (!streams.length || streams.length > 16 || streams.some(stream => !['audio', 'video', 'subtitle', 'data'].includes(String(stream.codec_type)))) throw new HttpError(415, 'The media file has an unsupported stream layout.');
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new HttpError(415, 'The media file has no readable duration.');
  return { streams, duration, format: parsed.format?.format_name || '' };
}
function formatError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return processError(signal);
  return error instanceof HttpError ? error : new HttpError(422, 'This file could not be converted. Check that it is a supported, uncorrupted file.');
}
function handleRouteError(res: express.Response, error: unknown, signal?: AbortSignal) {
  const safe = formatError(error, signal);
  safeError(res, safe.status, safe.message);
}

app.post('/api/convert/image', conversionLimit, conversionSlot, receiveFile, async (req, res) => {
  const context = requestSignal(req, res, IMAGE_TIMEOUT_MS);
  let dir = '';
  try {
    const fields = exactFields(req.body, ['format', 'quality']);
    const format = fields.format?.toLowerCase();
    if (!outputFormats.includes(format as typeof outputFormats[number])) throw new HttpError(400, 'Choose PNG, JPG, WebP, or AVIF.');
    const quality = integerField(fields.quality, 'quality', 1, 100);
    const head = await fileHead(req.file!.path, 32);
    const detected = imageMagic(head);
    if (!detected) throw new HttpError(415, 'Choose a valid PNG, JPG, WebP, or AVIF image.');
    dir = await mkdtemp(path.join(tempRoot, 'image-'));
    const identify = await capture('magick', ['identify', '-limit', 'thread', '2', '-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '512MiB', '-regard-warnings', '-ping', '-format', '%m %w %h', req.file!.path], context.signal, 128, dir);
    const [inputFormat, widthText, heightText] = identify.trim().split(/\s+/);
    const width = Number(widthText); const height = Number(heightText);
    if (!width || !height || width * height > MAX_IMAGE_PIXELS || !/^(PNG|JPEG|WEBP|AVIF)$/i.test(inputFormat)) throw new HttpError(415, 'The image is damaged or exceeds the 40 megapixel limit.');
    const output = path.join(dir, `converted.${format}`);
    await run('magick', ['-limit', 'thread', '2', '-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '512MiB', req.file!.path, '-auto-orient', '-strip', '-quality', String(quality), output], { signal: context.signal, outputPath: output, maxOutputBytes: MAX_IMAGE_BYTES, temporaryDirectory: dir });
    const data = await readFile(output);
    const ext = format === 'jpeg' ? 'jpg' : format;
    res.setHeader('Content-Type', MIME[format]);
    res.setHeader('Content-Disposition', `attachment; filename="${safeBaseName(req.file!.originalname)}.${ext}"`);
    res.setHeader('Content-Length', String(data.length));
    res.send(data);
  } catch (error) { handleRouteError(res, error, context.signal); }
  finally { context.dispose(); releaseSlot(res); if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}); if (req.file) await rm(req.file.path, { force: true }).catch(() => {}); }
});

app.post('/api/convert/media', conversionLimit, conversionSlot, receiveFile, async (req, res) => {
  const context = requestSignal(req, res, CONVERSION_TIMEOUT_MS);
  let dir = '';
  try {
    const fields = exactFields(req.body, ['format', 'kind', 'quality', 'resolution', 'bitrate']);
    const kind = fields.kind;
    const format = fields.format?.toLowerCase();
    const audioFormats = ['mp3', 'wav', 'flac']; const videoFormats = ['mp4', 'webm', 'mov'];
    if (kind !== 'audio' && kind !== 'video') throw new HttpError(400, 'Choose audio or video conversion.');
    if (!(kind === 'audio' ? audioFormats : videoFormats).includes(format || '')) throw new HttpError(400, 'That output format is not supported.');
    const quality = integerField(fields.quality, 'quality', 1, 100);
    const bitrate = fields.bitrate;
    if (!['128', '192', '256', '320'].includes(bitrate)) throw new HttpError(400, 'Choose a supported audio bitrate.');
    const resolution = fields.resolution;
    if (!['original', '1080p', '720p', '480p'].includes(resolution)) throw new HttpError(400, 'Choose a supported video resolution.');
    const head = await fileHead(req.file!.path, 32);
    const signature = mediaMagic(head);
    if (!signature) throw new HttpError(415, 'The media file content is not a supported audio or video format.');
    const probe = await probeMedia(req.file!.path, context.signal);
    const hasAudio = probe.streams.some(stream => stream.codec_type === 'audio');
    const videoStream = probe.streams.find(stream => stream.codec_type === 'video');
    if (kind === 'audio') {
      if (signature !== 'audio' && signature !== 'bmff' || !hasAudio || videoStream) throw new HttpError(415, 'Choose a valid audio-only file.');
      if (probe.duration > 3 * 60 * 60) throw new HttpError(413, 'Audio files must be 3 hours or shorter.');
    } else {
      if (!['video', 'bmff', 'ebml'].includes(signature) || !videoStream) throw new HttpError(415, 'Choose a valid video file.');
      if (probe.duration > 30 * 60) throw new HttpError(413, 'Videos must be 30 minutes or shorter.');
      if (!videoStream.width || !videoStream.height || videoStream.width * videoStream.height > MAX_VIDEO_PIXELS) throw new HttpError(413, 'Videos are limited to 4K resolution.');
    }
    dir = await mkdtemp(path.join(tempRoot, 'media-'));
    const output = path.join(dir, `converted.${format}`);
    const args = ['-y', '-threads', '2', '-xerror', '-err_detect', 'explode', '-i', req.file!.path];
    if (kind === 'audio') {
      if (format === 'mp3') args.push('-vn', '-codec:a', 'libmp3lame', '-b:a', `${bitrate}k`);
      if (format === 'wav') args.push('-vn', '-codec:a', 'pcm_s16le');
      if (format === 'flac') args.push('-vn', '-codec:a', 'flac');
    } else {
      if (resolution !== 'original') {
        const height = Number(resolution.slice(0, -1));
        args.push('-vf', `scale=-2:min(ih\\,${height})`);
      }
      const crf = Math.round(51 - (quality / 100) * 39);
      if (format === 'mp4') args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'aac', '-movflags', '+faststart');
      if (format === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', String(Math.round(63 - (quality / 100) * 55)), '-b:v', '0', '-c:a', 'libopus');
      if (format === 'mov') args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'aac');
    }
    args.push('-threads', '2', '-progress', 'pipe:2', '-nostats', output);
    await run('ffmpeg', args, { signal: context.signal, duration: probe.duration, onProgress: progress => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ progress })}\n\n`); }, outputPath: output, maxOutputBytes: MAX_MEDIA_BYTES });
    const data = await readFile(output);
    const mime: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
    res.write(`data: ${JSON.stringify({ progress: 100, done: true, size: data.length })}\n\n`);
    res.write(`data: ${JSON.stringify({ file: data.toString('base64'), name: `${safeBaseName(req.file!.originalname)}.${format}`, mime: mime[format!] })}\n\n`);
    res.end();
  } catch (error) {
    const safe = formatError(error, context.signal);
    if (!res.headersSent && !res.destroyed) safeError(res, safe.status, safe.message);
    else if (!res.destroyed && !res.writableEnded) { res.write(`data: ${JSON.stringify({ error: safe.message })}\n\n`); res.end(); }
  } finally { context.dispose(); releaseSlot(res); if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}); if (req.file) await rm(req.file.path, { force: true }).catch(() => {}); }
});

app.post('/api/pdf/pages', conversionLimit, conversionSlot, receiveFile, async (req, res) => {
  const context = requestSignal(req, res, PDF_TIMEOUT_MS);
  let dir = '';
  try {
    const fields = exactFields(req.body, ['format']);
    const format = fields.format?.toLowerCase();
    if (!['png', 'jpg'].includes(format || '')) throw new HttpError(400, 'Choose PNG or JPG.');
    const head = await fileHead(req.file!.path, 8);
    if (head.length < 5 || head.toString('ascii', 0, 5) !== '%PDF-') throw new HttpError(415, 'The uploaded file is not a valid PDF.');
    const info = await capture('pdfinfo', [req.file!.path], context.signal, 64 * 1024);
    const pageCount = Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1]);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new HttpError(415, 'The PDF has no readable pages.');
    if (pageCount > MAX_PDF_PAGES) throw new HttpError(413, `PDF files are limited to ${MAX_PDF_PAGES} pages.`);
    dir = await mkdtemp(path.join(tempRoot, 'pdf-'));
    const prefix = path.join(dir, 'page');
    await run('pdftoppm', ['-f', '1', '-l', String(MAX_PDF_PAGES), '-scale-to', '1600', `-${format === 'jpg' ? 'jpeg' : 'png'}`, req.file!.path, prefix], { signal: context.signal, outputDirectory: dir, maxOutputBytes: MAX_PDF_BYTES });
    const names = (await readdir(dir)).filter(name => /^page-\d+\.(png|jpg)$/i.test(name)).sort((a, b) => Number(a.match(/-(\d+)/)?.[1]) - Number(b.match(/-(\d+)/)?.[1]));
    if (!names.length || names.length > MAX_PDF_PAGES) throw new HttpError(422, 'The PDF pages could not be rendered safely.');
    const pages = [] as Array<{ name: string; mime: string; file: string }>;
    let totalBytes = 0;
    for (const name of names) {
      const info = await stat(path.join(dir, name));
      totalBytes += info.size;
      if (info.size > MAX_PDF_PAGE_BYTES || totalBytes > MAX_PDF_BYTES) throw new HttpError(413, 'The rendered PDF pages exceed the safe download size.');
      const data = await readFile(path.join(dir, name));
      pages.push({ name, mime: format === 'jpg' ? 'image/jpeg' : 'image/png', file: data.toString('base64') });
    }
    res.json({ pages });
  } catch (error) { handleRouteError(res, error, context.signal); }
  finally { context.dispose(); releaseSlot(res); if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}); if (req.file) await rm(req.file.path, { force: true }).catch(() => {}); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.resolve('dist'), { dotfiles: 'deny', index: 'index.html', maxAge: production ? '1h' : 0, setHeaders(res, filePath) {
  if (/\/assets\/.*-[a-zA-Z0-9_-]{8,}\./.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (filePath.endsWith('service-worker.js') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
} }));
app.use((_req, res) => safeError(res, 404, 'The requested resource was not found.'));
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (!res.headersSent) safeError(res, 500, 'The request could not be completed.');
});

const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`FileFlow listening on port ${PORT}`));
server.once('error', () => { console.error('FileFlow server could not start.'); void rm(tempRoot, { recursive: true, force: true }).finally(() => process.exit(1)); });
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.timeout = 0;
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of activeSignals) controller.abort(new Error('Server shutting down'));
  for (const child of children) terminate(child);
  const timer = setTimeout(() => { void rm(tempRoot, { recursive: true, force: true }).finally(() => process.exit(1)); }, 10_000);
  server.close(() => { void rm(tempRoot, { recursive: true, force: true }).finally(() => clearTimeout(timer)); });
  timer.unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
