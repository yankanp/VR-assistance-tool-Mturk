import http from 'node:http';
import { randomBytes } from 'node:crypto';
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

function getParticipantParams(payload) {
  return {
    workerId: payload.workerId || payload.participant_params?.workerId || '',
    assignmentId: payload.assignmentId || payload.participant_params?.assignmentId || '',
    hitId: payload.hitId || payload.participant_params?.hitId || '',
    turkSubmitTo: payload.turkSubmitTo || payload.participant_params?.turkSubmitTo || '',
    participant_id: payload.participant_id || payload.participant_params?.participant_id || '',
  };
}

function hasValidMturkParams(payload) {
  const params = getParticipantParams(payload);
  return Boolean(params.workerId && params.assignmentId && params.hitId);
}

function isCompletedPayloadValid(payload) {
  return payload.completion_status === 'completed'
    && hasValidMturkParams(payload)
    && Array.isArray(payload.main_questions)
    && payload.main_questions.length > 0;
}

function createCompletionCode(prefix = 'VRHELP') {
  const partA = randomBytes(3).toString('hex').toUpperCase();
  const partB = randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${partA}-${partB}`;
}

async function findExistingCompletionCode(sessionId) {
  if (!sessionId || !existsSync(dataDir)) return '';
  const files = (await readdir(dataDir)).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = await readFile(path.join(dataDir, file), 'utf8');
      const saved = JSON.parse(raw);
      if (saved.session_id === sessionId && saved.completion_code) {
        return saved.completion_code;
      }
    } catch {
      // Ignore malformed session files so one bad file does not block study completion.
    }
  }
  return '';
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
    const completionPrefix = payload.completion_code_prefix || 'VRHELP';

    if (payload.completion_status === 'completed' && !isCompletedPayloadValid(payload)) {
      sendJson(response, 400, {
        ok: false,
        error: 'Completed sessions require MTurk identifiers and main-study responses.',
      });
      return;
    }

    const payloadToSave = {
      ...payload,
      completion_code: payload.completion_status === 'completed'
        ? payload.completion_code || await findExistingCompletionCode(payload.session_id) || createCompletionCode(completionPrefix)
        : '',
    };

    const sessionId = sanitizeFilePart(payload.session_id);
    const workerId = sanitizeFilePart(payloadToSave.workerId || payloadToSave.participant_id || payloadToSave.participant_params?.workerId || payloadToSave.participant_params?.participant_id);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${workerId}_${sessionId}.json`;

    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, filename), JSON.stringify(payloadToSave, null, 2), 'utf8');

    sendJson(response, 200, {
      ok: true,
      filename,
      completion_code: payloadToSave.completion_code,
    });
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
  return session.participant_id
    || session.participant_params?.participant_id
    || session.workerId
    || session.participant_params?.workerId
    || session.session_id
    || '';
}

function joinValues(values) {
  return values.filter((value) => value !== undefined && value !== null && value !== '').join('; ');
}

function formatClicks(clicks = []) {
  return clicks
    .map((click) => `${click.region_id || click.target_id || ''} @ ${click.timestamp || ''}`.trim())
    .filter(Boolean)
    .join('; ');
}

function normalizeSession(session) {
  if (Array.isArray(session.main_questions)) return session;

  const participantParams = session.participant_params ?? {};
  return {
    session_id: session.session_id,
    participant_id: participantParams.participant_id || participantParams.workerId || session.session_id,
    workerId: participantParams.workerId || '',
    assignmentId: participantParams.assignmentId || '',
    hitId: participantParams.hitId || '',
    turkSubmitTo: participantParams.turkSubmitTo || '',
    completion_status: session.completion_status || '',
    attention_passed: session.attention_passed ?? '',
    completion_code: session.completion_code || '',
    attention_checks: (session.attention_checks ?? []).map((check) => ({
      attention_question_id: check.check_id || check.attention_question_id || '',
      prompt: check.prompt || '',
      type: check.type || '',
      answer: check.answer || '',
      correct_answer: check.correct_answer || '',
      is_correct: check.is_correct ?? '',
      requires_manual_review: check.requires_manual_review ?? false,
      started_at: check.started_at || '',
      ended_at: check.ended_at || check.answered_at || '',
    })),
    timing: {
      informed_consent_duration_ms: session.timing?.informed_consent_duration_ms || '',
      attention_checks_total_duration_ms: session.timing?.attention_checks_total_duration_ms || '',
      introduction_duration_ms: session.timing?.introduction_duration_ms || '',
      actual_study_total_duration_ms: session.timing?.actual_study_total_duration_ms || '',
    },
    main_questions: (session.responses ?? []).map((response) => ({
      question_asked_id: response.question_id || '',
      question_type: response.question_type || 'main',
      is_attention_check: response.is_attention_check ?? false,
      all_regions_clicked_with_timestamp: (response.clicks ?? []).map((click) => ({
        region_id: click.region_id || '',
        timestamp: click.timestamp || '',
      })),
      final_answer_selected: response.selected_region_id || '',
      is_correct: response.is_correct ?? '',
      total_time_taken_to_answer_ms: response.response_time_ms || '',
    })),
  };
}

function flattenSessionRows(rawSession) {
  const session = normalizeSession(rawSession);
  const attentionChecks = session.attention_checks ?? [];
  const timing = session.timing ?? {};
  const base = {
    session_id: session.session_id || '',
    participant_id: getParticipantId(session),
    workerId: session.workerId || session.participant_params?.workerId || '',
    assignmentId: session.assignmentId || session.participant_params?.assignmentId || '',
    hitId: session.hitId || session.participant_params?.hitId || '',
    turkSubmitTo: session.turkSubmitTo || session.participant_params?.turkSubmitTo || '',
    completion_status: session.completion_status || '',
    attention_passed: session.attention_passed ?? '',
    completion_code: session.completion_code || '',
    attention_question_ids: joinValues(attentionChecks.map((check) => check.attention_question_id || check.check_id)),
    attention_answers: joinValues(attentionChecks.map((check) => check.answer)),
    attention_correct: joinValues(attentionChecks.map((check) => String(check.is_correct))),
    attention_types: joinValues(attentionChecks.map((check) => check.type)),
    attention_manual_review: joinValues(attentionChecks.map((check) => String(Boolean(check.requires_manual_review)))),
    attention_started_times: joinValues(attentionChecks.map((check) => check.started_at)),
    attention_ended_times: joinValues(attentionChecks.map((check) => check.ended_at)),
    informed_consent_duration_ms: timing.informed_consent_duration_ms || '',
    attention_checks_total_duration_ms: timing.attention_checks_total_duration_ms || '',
    introduction_duration_ms: timing.introduction_duration_ms || '',
    actual_study_total_duration_ms: timing.actual_study_total_duration_ms || '',
  };

  if (!session.main_questions?.length) {
    return [{
      ...base,
      question_asked_id: '',
      question_type: '',
      is_attention_check: '',
      all_regions_clicked_with_timestamp: '',
      final_answer_selected: '',
      is_correct: '',
      total_time_taken_to_answer_ms: '',
    }];
  }

  return session.main_questions.map((question) => ({
    ...base,
    question_asked_id: question.question_asked_id || '',
    question_type: question.question_type || '',
    is_attention_check: question.is_attention_check ?? '',
    all_regions_clicked_with_timestamp: formatClicks(question.all_regions_clicked_with_timestamp),
    final_answer_selected: question.final_answer_selected || '',
    is_correct: question.is_correct ?? '',
    total_time_taken_to_answer_ms: question.total_time_taken_to_answer_ms || '',
  }));
}

function buildExcelXml(rows) {
  const columns = [
    'session_id',
    'participant_id',
    'workerId',
    'assignmentId',
    'hitId',
    'turkSubmitTo',
    'completion_status',
    'attention_passed',
    'completion_code',
    'attention_question_ids',
    'attention_answers',
    'attention_correct',
    'attention_types',
    'attention_manual_review',
    'attention_started_times',
    'attention_ended_times',
    'question_asked_id',
    'question_type',
    'is_attention_check',
    'all_regions_clicked_with_timestamp',
    'final_answer_selected',
    'is_correct',
    'total_time_taken_to_answer_ms',
    'informed_consent_duration_ms',
    'attention_checks_total_duration_ms',
    'introduction_duration_ms',
    'actual_study_total_duration_ms',
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
async function readSavedSessions() {
  await mkdir(dataDir, { recursive: true });
  const files = (await readdir(dataDir)).filter((file) => file.endsWith('.json'));
  return Promise.all(files.map(async (file) => {
    const raw = await readFile(path.join(dataDir, file), 'utf8');
    return { filename: file, session: JSON.parse(raw) };
  }));
}

function summarizeSession(filename, rawSession) {
  const session = normalizeSession(rawSession);
  return {
    filename,
    session_id: session.session_id || '',
    participant_id: getParticipantId(session),
    workerId: session.workerId || session.participant_params?.workerId || '',
    assignmentId: session.assignmentId || session.participant_params?.assignmentId || '',
    hitId: session.hitId || session.participant_params?.hitId || '',
    completion_status: session.completion_status || '',
    attention_passed: session.attention_passed ?? '',
    completion_code: session.completion_code || '',
    main_question_count: session.main_questions?.length || 0,
    attention_check_count: session.attention_checks?.length || 0,
  };
}

async function listSessions(response) {
  const saved = await readSavedSessions();
  sendJson(response, 200, { ok: true, sessions: saved.map(({ filename, session }) => summarizeSession(filename, session)) });
}

async function exportMetrics(response) {
  const saved = await readSavedSessions();
  const sessions = saved.map(({ session }) => session);
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

  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    await listSessions(response);
    return;
  }

  serveStatic(request, response);
});

server.listen(port, () => {
  console.log(`MTurk study server running at http://localhost:${port}`);
  console.log(`Saved sessions: ${dataDir}`);
  console.log(`Excel export: http://localhost:${port}/api/export`);
});
