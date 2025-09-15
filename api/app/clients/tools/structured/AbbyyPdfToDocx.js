// abbyy_pdf_to_docx.js (patched)
const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const { XMLParser } = require('fast-xml-parser');

const BASE = process.env.ABBYY_BASE_URL || 'https://cloud.ocrsdk.com';
const APP_ID = process.env.ABBYY_APP_ID;
const APP_PWD = process.env.ABBYY_APP_PWD;
const { getFiles, findFileById } = require('~/models/File');

async function resolvePdfBytes(payload) {
  if (payload.base64) return Buffer.from(payload.base64, 'base64');

  // If your message provides a direct (signed) download URL:
  if (payload.fileUrl) {
    // If the URL requires auth, add headers (cookie/token) here.
    const { data } = await axios.get(payload.fileUrl, { responseType: 'arraybuffer' });
    return Buffer.from(data);
  }

  // If LibreChat gave you a local server path (mounted volume):
  if (payload.filePath) {
    const abs = path.isAbsolute(payload.filePath)
      ? payload.filePath
      : path.join(process.cwd(), payload.filePath);
    return fs.readFile(abs);
  }

  throw new Error('No PDF bytes. Provide `base64`, `fileUrl`, or `filePath`.');
}

async function startProcess(buffer, opts = {}) {
  const { language = 'eng', exportFormat = 'docx' } = opts;
  const form = new FormData();
  form.append('file', buffer, { filename: 'input.pdf', contentType: 'application/pdf' });
  const url = `${BASE}/processDocument?exportFormat=${encodeURIComponent(exportFormat)}&language=${encodeURIComponent(language)}`;
  const { data } = await axios.post(url, form, {
    auth: { username: APP_ID, password: APP_PWD },
    headers: form.getHeaders(),
  });
  return data;
}

async function getStatus(taskId) {
  const url = `${BASE}/getTaskStatus?taskId=${encodeURIComponent(taskId)}`;
  const { data } = await axios.get(url, { auth: { username: APP_ID, password: APP_PWD } });
  return data;
}

async function downloadResult(resultUrl) {
  const { data } = await axios.get(resultUrl, { responseType: 'arraybuffer' });
  return Buffer.from(data);
}

function parseTask(xmlStr) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const obj = parser.parse(xmlStr);
  const task = obj?.response?.task;
  if (!task || !task.Id) throw new Error('Malformed ABBYY response');
  return task;
}

class AbbyyPdfToDocx extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'abbyy_pdf_to_docx';
    this.description =
      'Converts scanned PDF to DOCX using ABBYY Cloud OCR SDK. Accepts { base64 | fileUrl | filePath }.';
    this.userId = fields.userId;
    this.description_for_model =
      'Convert a PDF to DOCX. Provide one of base64, fileUrl, filePath, or file_id. Optionally set language (default: eng) and filename (must end with .docx).';
    this.schema = z.object({
      base64: z.string().describe('Base64-encoded PDF without data: prefix').optional(),
      fileUrl: z.string().url().describe('Direct URL to download the PDF').optional(),
      filePath: z.string().describe('Absolute or server-relative path to the PDF').optional(),
      file_id: z.string().describe('ID of an uploaded PDF in the system').optional(),
      filename: z.string().describe('Output DOCX filename. Defaults to converted.docx').optional(),
      language: z.string().describe('OCR language code, e.g., eng').optional(),
      timeoutMs: z.number().describe('Processing timeout in ms').optional(),
    });
  }

  async _call(input) {
    if (!APP_ID || !APP_PWD)
      throw new Error('Missing ABBYY credentials (ABBYY_APP_ID/ABBYY_APP_PWD).');
    console.log('inside AbbyyPdfToDocx', input);
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

    // If a file_id was provided, resolve to a filepath/URL
    if (payload.file_id && !payload.fileUrl && !payload.filePath && !payload.base64) {
      try {
        const file = await findFileById(payload.file_id);
        if (file?.filepath) {
          payload.fileUrl = file.filepath;
          if (!payload.filename) payload.filename = file.filename;
        }
      } catch (_) {
        // ignore and continue to other strategies
      }
    }

    // If still no bytes source, attempt to find the latest PDF for this user (optionally by name)
    const hasSource = payload.base64 || payload.fileUrl || payload.filePath;
    if (!hasSource && this.userId) {
      const nameHint = payload.filename;
      const filter = { user: this.userId, type: /^application\/pdf$/ };
      if (nameHint) {
        filter.$or = [
          { filename: nameHint },
          { filepath: new RegExp(nameHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        ];
      }
      try {
        const files = await getFiles(filter, { updatedAt: -1 }, { text: 0 });
        const latest = files?.[0];
        if (latest?.filepath) {
          payload.fileUrl = latest.filepath;
          if (!payload.filename) payload.filename = latest.filename;
        }
      } catch (_) {
        // ignore
      }
    }

    // Validate we have a source now
    if (!payload.base64 && !payload.fileUrl && !payload.filePath) {
      throw new Error('No input provided. Pass one of: { base64 | fileUrl | filePath | file_id }');
    }

    const pdfBuf = await resolvePdfBytes(payload);
    const language = payload.language || 'eng';
    const filename =
      payload.filename && payload.filename.endsWith('.docx') ? payload.filename : 'converted.docx';

    const startXml = await startProcess(pdfBuf, { language, exportFormat: 'docx' });
    let task = parseTask(startXml);

    // poll
    const start = Date.now(),
      timeoutMs = payload.timeoutMs || 6 * 60 * 1000;
    let delay = 1500;
    while (true) {
      if (task.Status === 'Completed' && task.resultUrl) break;
      if (task.Status === 'ProcessingFailed') throw new Error('ABBYY processing failed');
      if (Date.now() - start > timeoutMs) throw new Error('ABBYY timeout');
      await new Promise((r) => setTimeout(r, delay));
      const statusXml = await getStatus(task.Id);
      task = parseTask(statusXml);
      delay = Math.min(delay * 1.5, 7000);
    }

    const docxBuf = await downloadResult(task.resultUrl);
    return JSON.stringify({
      filename,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: docxBuf.toString('base64'),
    });
  }
}

module.exports = AbbyyPdfToDocx;
