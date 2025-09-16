// abbyy_pdf_to_docx.js (patched)
const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const axios = require('axios');
// const fs = require('fs').promises;
// const path = require('path');
const FormData = require('form-data');
// const { XMLParser } = require('fast-xml-parser');
const { logger } = require('@librechat/data-schemas');

const BASE = process.env.ABBYY_BASE_URL || 'https://cloud.ocrsdk.com';
const APP_ID = process.env.ABBYY_APP_ID;
const APP_PWD = process.env.ABBYY_APP_PWD;
// Convenience fallback: fetch latest uploaded PDF for this user if args lack base64/fileUrl
const { getFiles } = require('~/models/File');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

async function resolvePdfBytes(payload) {
  if (payload.base64) return Buffer.from(payload.base64, 'base64');

  // If your message provides a direct (signed) download URL:
  if (payload.fileUrl) {
    // If the URL requires auth, add headers (cookie/token) here.
    const { data } = await axios.get(payload.fileUrl, { responseType: 'arraybuffer' });
    return Buffer.from(data);
  }

  throw new Error('No PDF bytes. Provide `base64` or `fileUrl`.');
}

async function getFreshSignedURL({ req, originalFilepath, userId, filename }) {
  try {
    const appConfig = req?.config;
    if (!appConfig) {
      return null;
    }
    logger.info(
      `Tool AbbyyPdfToDocx: generating fresh signed URL (user: ${userId ?? 'n/a'}, filename: ${filename ?? 'n/a'})`,
    );
    const source = getFileStrategy(appConfig, { isImage: false });

    const { getFileURL } = getStrategyFunctions(source);
    if (typeof getFileURL !== 'function') {
      return null;
    }
    let objectKey = null;
    if (originalFilepath) {
      try {
        const url = new URL(originalFilepath);
        const marker = `/uploads/${userId}/`;
        const idx = url.pathname.indexOf(marker);
        if (idx !== -1) {
          objectKey = url.pathname.substring(idx + marker.length);
        }
      } catch (_e) {
        // ignore parse errors
      }
    }
    if (!objectKey && userId && filename) {
      objectKey = `${userId}/${filename}`;
    }
    if (!objectKey) {
      return null;
    }
    const freshUrl = await getFileURL({
      fileName: objectKey,
      basePath: 'uploads',
      userId: userId,
    });
    return freshUrl ?? null;
  } catch (_e) {
    return null;
  }
}

async function startProcess(buffer, opts = {}) {
  let { language = 'English,Vietnamese', exportFormat = 'docx' } = opts;
  language = 'English,Vietnamese';
  const form = new FormData();
  form.append('file', buffer, { filename: 'input.pdf', contentType: 'application/pdf' });
  const url = `${BASE}/v2/processImage?exportFormat=${encodeURIComponent(exportFormat)}&language=${encodeURIComponent(language)}`;
  const { data } = await axios.post(url, form, {
    auth: { username: APP_ID, password: APP_PWD },
    headers: form.getHeaders(),
  });
  return data;
}

async function getStatus(taskId) {
  const url = `${BASE}/v2/getTaskStatus?taskId=${encodeURIComponent(taskId)}`;
  const { data } = await axios.get(url, { auth: { username: APP_ID, password: APP_PWD } });
  return data;
}

// async function downloadResult(resultUrl) {
//   const { data } = await axios.get(resultUrl, { responseType: 'arraybuffer' });
//   return Buffer.from(data);
// }

function parseTask(json) {
  const task = json;
  if (!task || !task.taskId) throw new Error('Malformed ABBYY response');
  return task;
}

class AbbyyPdfToDocx extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'abbyy_pdf_to_docx';
    this.description =
      'Converts scanned PDF to DOCX using ABBYY Cloud OCR SDK. Accepts { base64 | fileUrl }.';
    this.userId = fields.req?.user?.id;
    this.req = fields.req;
    this.description_for_model =
      'Convert a PDF to DOCX. Provide one of base64 or fileUrl. Optionally set language (default: eng) and filename (must end with .docx).';
    this.schema = z.object({
      // fileUrl: z.string().url().describe('Direct URL to download the PDF').optional(),
      filename: z.string().describe('Output DOCX filename. Defaults to converted.docx').optional(),
      language: z.string().describe('OCR language code, e.g., eng').optional(),
      timeoutMs: z.number().describe('Processing timeout in ms').optional(),
    });
  }

  async _call(input) {
    if (!APP_ID || !APP_PWD)
      throw new Error('Missing ABBYY credentials (ABBYY_APP_ID/ABBYY_APP_PWD).');
    logger.info(`Tool AbbyyPdfToDocx: starting process from user ${this.userId}`);
    console.log(input);
    // Normalize payload: accept object, JSON string, filename string, or empty
    let payload = input;
    if (typeof input === 'string') {
      try {
        payload = JSON.parse(input);
      } catch {
        // If a plain string was provided (e.g., filename), wrap it
        payload = { filename: input };
      }
    }
    if (payload == null || typeof payload !== 'object') {
      payload = {};
    }
    // If no source provided, try most recent uploaded PDF for this user
    if (!payload.base64 && !payload.fileUrl && this.userId) {
      try {
        logger.info(`Tool AbbyyPdfToDocx: getting latest uploaded PDF for user ${this.userId}`);
        const files = await getFiles(
          { user: this.userId, type: /^application\/pdf$/, filepath: { $exists: true, $ne: null } },
          { updatedAt: -1 },
          { text: 0 },
        );

        const latest = files?.[0];

        if (latest?.filepath) {
          const freshUrl = await getFreshSignedURL({
            req: this.req,
            originalFilepath: latest.filepath,
            userId: this.userId,
            filename: latest.filename,
          });
          payload.fileUrl = freshUrl ?? latest.filepath;
          if (!payload.filename) payload.filename = latest.filename;
        }
      } catch (_e) {
        // ignore and fall through
      }
    }

    // Validate we have a source now
    if (!payload.base64 && !payload.fileUrl) {
      throw new Error('No input provided. Pass one of: { base64 | fileUrl }');
    }

    const pdfBuf = await resolvePdfBytes(payload);
    const language = payload.language || 'English,Vietnamese';
    const filename =
      payload.filename && payload.filename.endsWith('.docx') ? payload.filename : 'converted.docx';

    const startJSON = await startProcess(pdfBuf, { language, exportFormat: 'docx' });
    let task = parseTask(startJSON);

    // poll
    const start = Date.now(),
      timeoutMs = 60 * 60 * 1000;
    let delay = 1500;
    while (true) {
      if (task.status === 'Completed' && task.resultUrls[0]) break;
      if (task.status === 'ProcessingFailed') throw new Error('ABBYY processing failed');
      if (Date.now() - start > timeoutMs) throw new Error('ABBYY timeout');
      await new Promise((r) => setTimeout(r, delay));
      task = await getStatus(task.taskId);
      // task = parseTask(statusXml);
      delay = Math.min(delay * 1.5, 7000);
    }
    logger.info('Tool AbbyyPdfToDocx: task completed with result urls', task.resultUrls);
    return JSON.stringify({
      filename,
      fileUrl: task.resultUrls[0],
    });
    // return `Here is your converted file: [${filename}](${task.resultUrls[0]})`;
  }
}

module.exports = AbbyyPdfToDocx;
