import http from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 5174);
const distDir = path.join(__dirname, 'dist');
const dataDir = path.join(__dirname, 'data', 'sessions');
const allowedOrigin = process.env.CORS_ORIGIN || '*';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.glb': 'model/gltf-binary',
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(body));
}

function sendCorsPreflight(response) {
  response.writeHead(204, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  response.end();
}

function sanitizeFilePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function readRequestBody(request, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limitBytes) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function saveSession(request, response) {
  try {
    const body = await readRequestBody(request);
    const payload = JSON.parse(body);
    const sessionId = sanitizeFilePart(payload.session_id);
    const workerId = sanitizeFilePart(payload.participant_params?.workerId || payload.participant_params?.participant_id);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${workerId}_${sessionId}.json`;

    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, filename), JSON.stringify(payload, null, 2), 'utf8');

    sendJson(response, 200, { ok: true, filename });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getParticipantId(session) {
  return session.participant_params?.participant_id
    || session.participant_params?.workerId
    || session.session_id
    || '';
}

function flattenSessionRows(session) {
  const participantId = getParticipantId(session);
  const base = {
    session_id: session.session_id,
    participant_id: participantId,
    workerId: session.participant_params?.workerId || '',
    assignmentId: session.participant_params?.assignmentId || '',
    hitId: session.participant_params?.hitId || '',
    completion_status: session.completion_status,
    attention_passed: session.attention_passed,
    attention_failure_count: session.attention_failure_count,
    started_at: session.started_at,
    ended_at: session.ended_at,
    completion_code: session.completion_code || '',
  };

  if (!session.responses?.length) {
    return [{
      ...base,
      question_id: '',
      prompt: '',
      target_feature: '',
      selected_region_id: '',
      first_click_region_id: '',
      is_correct: '',
      response_time_ms: '',
      question_started_at: '',
      final_click_timestamp: '',
    }];
  }

  return session.responses.map((response) => ({
    ...base,
    question_id: response.question_id,
    prompt: response.prompt,
    target_feature: response.target_feature,
    selected_region_id: response.selected_region_id,
    first_click_region_id: response.first_click_region_id,
    is_correct: response.is_correct,
    response_time_ms: response.response_time_ms,
    question_started_at: response.question_started_at,
    final_click_timestamp: response.final_click_timestamp,
  }));
}

function buildExcelXml(rows) {
  const columns = [
    'session_id',
    'participant_id',
    'workerId',
    'assignmentId',
    'hitId',
    'completion_status',
    'attention_passed',
    'attention_failure_count',
    'started_at',
    'ended_at',
    'completion_code',
    'question_id',
    'prompt',
    'target_feature',
    'selected_region_id',
    'first_click_region_id',
    'is_correct',
    'response_time_ms',
    'question_started_at',
    'final_click_timestamp',
  ];

  const header = columns
    .map((column) => `<Cell><Data ss:Type="String">${xmlEscape(column)}</Data></Cell>`)
    .join('');
  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => `<Cell><Data ss:Type="String">${xmlEscape(row[column])}</Data></Cell>`)
        .join('');
      return `<Row>${cells}</Row>`;
    })
    .join('');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="MTurk Metrics">
    <Table>
      <Row>${header}</Row>
      ${body}
    </Table>
  </Worksheet>
</Workbook>`;
}

async function exportMetrics(response) {
  await mkdir(dataDir, { recursive: true });
  const files = (await readdir(dataDir)).filter((file) => file.endsWith('.json'));
  const sessions = await Promise.all(files.map(async (file) => {
    const raw = await readFile(path.join(dataDir, file), 'utf8');
    return JSON.parse(raw);
  }));
  const rows = sessions.flatMap(flattenSessionRows);
  const workbook = buildExcelXml(rows);

  response.writeHead(200, {
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': 'attachment; filename="mturk_metrics.xls"',
    'Access-Control-Allow-Origin': allowedOrigin,
  });
  response.end(workbook);
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1);
  const fullPath = path.normalize(path.join(distDir, relativePath));

  if (!fullPath.startsWith(distDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  const filePath = existsSync(fullPath) ? fullPath : path.join(distDir, 'index.html');
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, { 'Content-Type': contentTypes[extension] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    sendCorsPreflight(response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/session') {
    await saveSession(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/export') {
    await exportMetrics(response);
    return;
  }

  serveStatic(request, response);
});

server.listen(port, () => {
  console.log(`MTurk study server running at http://localhost:${port}`);
  console.log(`Saved sessions: ${dataDir}`);
  console.log(`Excel export: http://localhost:${port}/api/export`);
});
