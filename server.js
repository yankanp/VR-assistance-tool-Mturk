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
  const mturkParamsAreValid = payload.debug_mode === true || hasValidMturkParams(payload);
  return payload.completion_status === 'completed'
    && mturkParamsAreValid
    && Array.isArray(payload.rows)
    && payload.rows.length > 0
    && payload.rows.some((row) => row.screen_name === 'Dashboard Question');
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
        error: 'Completed sessions require MTurk identifiers and row-based study responses.',
      });
      return;
    }

    const generatedCompletionCode = payload.completion_status === 'completed'
      ? payload.completion_code || await findExistingCompletionCode(payload.session_id) || createCompletionCode(completionPrefix)
      : '';
    const payloadToSave = {
      ...payload,
      completion_code: generatedCompletionCode,
      rows: Array.isArray(payload.rows)
        ? payload.rows
          .filter((row) => row.screen_name !== 'Dashboard Attention Check')
          .map((row) => ({
            ...row,
            completion_code: row.completion_code || generatedCompletionCode,
            final_answer: row.screen_name === 'Completion / Qualtrics Code'
              ? generatedCompletionCode
              : row.final_answer,
          }))
        : [],
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

function normalizeSession(session) {
  if (Array.isArray(session.rows)) return session;
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
    client_info: session.client_info ?? {},
    timing: {
      informed_consent_started_at: session.timing?.informed_consent_started_at || '',
      informed_consent_ended_at: session.timing?.informed_consent_ended_at || '',
      informed_consent_duration_ms: session.timing?.informed_consent_duration_ms || '',
      introduction_started_at: session.timing?.introduction_started_at || '',
      introduction_ended_at: session.timing?.introduction_ended_at || '',
      introduction_duration_ms: session.timing?.introduction_duration_ms || '',
      attention_checks_started_at: session.timing?.attention_checks_started_at || '',
      attention_checks_ended_at: session.timing?.attention_checks_ended_at || '',
      attention_checks_total_duration_ms: session.timing?.attention_checks_total_duration_ms || '',
      actual_study_started_at: session.timing?.actual_study_started_at || '',
      actual_study_ended_at: session.timing?.actual_study_ended_at || '',
      actual_study_total_duration_ms: session.timing?.actual_study_total_duration_ms || '',
    },
    attention_checks: (session.attention_checks ?? []).map((check) => ({
      attention_question_id: check.check_id || check.attention_question_id || '',
      prompt: check.prompt || '',
      type: check.type || '',
      answer: check.answer || '',
      answer_base_region_id: check.answer_base_region_id || '',
      answer_label: check.answer_label || '',
      correct_answer: check.correct_answer || '',
      is_correct: check.is_correct ?? '',
      requires_manual_review: check.requires_manual_review ?? false,
      started_at: check.started_at || '',
      ended_at: check.ended_at || check.answered_at || '',
    })),
    main_questions: (session.responses ?? []).map((response) => ({
      question_asked_id: response.question_id || '',
      question_type: response.question_type || 'main',
      is_attention_check: response.is_attention_check ?? false,
      prompt: response.prompt || '',
      all_regions_clicked_with_timestamp: (response.clicks ?? []).map((click) => ({
        region_id: click.region_id || '',
        base_region_id: click.base_region_id || '',
        region_label: click.region_label || '',
        timestamp: click.timestamp || '',
        x: click.x ?? '',
        y: click.y ?? '',
      })),
      final_answer_selected: response.selected_region_id || '',
      final_answer_selected_base_region_id: response.selected_base_region_id || '',
      final_answer_selected_label: response.selected_region_label || '',
      correct_answer: (response.correct_answers ?? []).join('|'),
      is_correct: response.is_correct ?? '',
      question_started_at: response.question_started_at || '',
      question_ended_at: response.final_click_timestamp || '',
      total_time_taken_to_answer_ms: response.response_time_ms || '',
    })),
  };
}

function durationMs(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '';
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : '';
}

function getEvent(session, type) {
  return (session.events ?? []).find((event) => event.type === type) ?? null;
}

function makeBaseRow(session) {
  const clientInfo = session.client_info ?? {};
  return {
    session_id: session.session_id || '',
    participant_id: getParticipantId(session),
    workerId: session.workerId || session.participant_params?.workerId || '',
    assignmentId: session.assignmentId || session.participant_params?.assignmentId || '',
    hitId: session.hitId || session.participant_params?.hitId || '',
    screen_name: '',
    question_asked: '',
    final_answer: '',
    all_clicked_elements: '[]',
    click_count: 0,
    is_correct: '',
    time_spent_ms: '',
    browser: clientInfo.browser || '',
    screen_width: clientInfo.screen_width || '',
    screen_height: clientInfo.screen_height || '',
    completion_code: session.completion_code || '',
    // Internal-only field used to order rows chronologically by when the
    // screen was shown to the participant. Stripped before writing the XLS.
    _screen_started_at: '',
  };
}

function formatClickedElements(clicks = []) {
  return JSON.stringify((clicks ?? []).map((click) => ({
    element_clicked: click.region_id || click.target_id || '',
    timestamp: click.timestamp || '',
    x: click.x ?? '',
    y: click.y ?? '',
  })));
}

function flattenSessionRows(rawSession) {
  const session = normalizeSession(rawSession);
  if (Array.isArray(session.rows)) {
    return session.rows.filter((row) => row.screen_name !== 'Dashboard Attention Check');
  }

  const timing = session.timing ?? {};
  const rows = [];
  const base = makeBaseRow(session);

  const consentEvent = getEvent(session, 'consent_declined') || getEvent(session, 'consent_accepted');
  const consentStartedAt = timing.informed_consent_started_at || session.started_at || '';
  const consentEndedAt = timing.informed_consent_ended_at || consentEvent?.timestamp || '';
  const consentClicks = consentEvent
    ? [{ timestamp: consentEvent.timestamp, region_id: consentEvent.type === 'consent_declined' ? 'I do not consent' : 'I consent and want to continue' }]
    : [];
  rows.push({
    ...base,
    screen_name: 'Informed Consent',
    question_asked: 'Consent form shown',
    final_answer: consentEvent?.type === 'consent_declined' ? 'declined' : 'consented',
    all_clicked_elements: formatClickedElements(consentClicks),
    click_count: consentClicks.length,
    time_spent_ms: timing.informed_consent_duration_ms || durationMs(consentStartedAt, consentEndedAt),
    _screen_started_at: consentStartedAt,
  });

  if (timing.introduction_started_at || timing.introduction_ended_at) {
    const introEvent = getEvent(session, 'introduction_continued');
    const introClicks = introEvent ? [{ timestamp: introEvent.timestamp, region_id: 'Start study questions' }] : [];
    rows.push({
      ...base,
      screen_name: 'Study Introduction',
      question_asked: 'Study instructions shown',
      final_answer: introEvent ? 'continued' : '',
      all_clicked_elements: formatClickedElements(introClicks),
      click_count: introClicks.length,
      time_spent_ms: timing.introduction_duration_ms || durationMs(timing.introduction_started_at, timing.introduction_ended_at || introEvent?.timestamp),
      _screen_started_at: timing.introduction_started_at || '',
    });
  }

  for (const check of session.attention_checks ?? []) {
    const checkClicks = check.answer ? [{ timestamp: check.ended_at, region_id: check.answer }] : [];
    rows.push({
      ...base,
      screen_name: 'Attention Check',
      question_asked: check.prompt || '',
      final_answer: check.answer_label || check.answer || '',
      all_clicked_elements: formatClickedElements(checkClicks),
      click_count: checkClicks.length,
      is_correct: check.is_correct ?? '',
      time_spent_ms: durationMs(check.started_at, check.ended_at),
      _screen_started_at: check.started_at || '',
    });
  }

  for (const question of session.main_questions ?? []) {
    const clicks = question.all_regions_clicked_with_timestamp ?? [];
    rows.push({
      ...base,
      screen_name: question.is_attention_check ? 'Dashboard Attention Check' : 'Dashboard Question',
      question_asked: question.prompt || '',
      final_answer: question.final_answer_selected_label || question.final_answer_selected || '',
      all_clicked_elements: formatClickedElements(clicks),
      click_count: clicks.length,
      is_correct: question.is_correct ?? '',
      time_spent_ms: question.total_time_taken_to_answer_ms || durationMs(question.question_started_at, question.question_ended_at),
      _screen_started_at: question.question_started_at || '',
    });
  }

  const completedAt = session.ended_at || timing.actual_study_ended_at || '';
  rows.push({
    ...base,
    screen_name: 'Completion / Qualtrics Code',
    question_asked: 'Participant reached completion screen and received/submitted completion code',
    final_answer: session.completion_code || '',
    all_clicked_elements: '[]',
    click_count: 0,
    completion_code: session.completion_code || '',
    _screen_started_at: completedAt,
  });

  // Order rows by when the screen was actually shown to the participant,
  // not by row category. Rows with a missing/unparsable timestamp keep
  // their original (flow) position via a stable sort.
  const withIndex = rows.map((row, index) => ({ row, index }));
  withIndex.sort((a, b) => {
    const aTime = Date.parse(a.row._screen_started_at);
    const bTime = Date.parse(b.row._screen_started_at);
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid && aTime !== bTime) return aTime - bTime;
    if (aValid && !bValid) return -1;
    if (!aValid && bValid) return 1;
    return a.index - b.index;
  });

  return withIndex.map(({ row }) => {
    const { _screen_started_at, ...exportRow } = row;
    return exportRow;
  });
}

function buildExcelXml(rows) {
  const columns = [
    'session_id',
    'participant_id',
    'workerId',
    'assignmentId',
    'hitId',
    'screen_name',
    'question_asked',
    'final_answer',
    'all_clicked_elements',
    'click_count',
    'is_correct',
    'time_spent_ms',
    'browser',
    'screen_width',
    'screen_height',
    'completion_code',
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
    main_question_count: Array.isArray(session.rows)
      ? session.rows.filter((row) => row.screen_name === 'Dashboard Question').length
      : session.main_questions?.filter((question) => !question.is_attention_check).length || 0,
    attention_check_count: Array.isArray(session.rows)
      ? session.rows.filter((row) => row.screen_name === 'Attention Check').length
      : session.attention_checks?.length || 0,
    row_count: Array.isArray(session.rows)
      ? session.rows.filter((row) => row.screen_name !== 'Dashboard Attention Check').length
      : 0,
  };
}

async function listSessions(response) {
  const saved = await readSavedSessions();
  sendJson(response, 200, { ok: true, sessions: saved.map(({ filename, session }) => summarizeSession(filename, session)) });
}

async function listSessionJsonFiles(response) {
  const saved = await readSavedSessions();
  sendJson(response, 200, {
    ok: true,
    files: saved.map(({ filename, session }) => ({
      filename,
      download_url: `/api/session-json/${encodeURIComponent(filename)}`,
      summary: summarizeSession(filename, session),
    })),
  });
}

async function downloadSessionJson(response, filename) {
  const safeFilename = path.basename(filename || '');
  if (!safeFilename || safeFilename !== filename || !safeFilename.endsWith('.json')) {
    sendJson(response, 400, { ok: false, error: 'Invalid JSON session filename.' });
    return;
  }

  const filePath = path.join(dataDir, safeFilename);
  if (!filePath.startsWith(dataDir) || !existsSync(filePath)) {
    sendJson(response, 404, { ok: false, error: 'JSON session file not found.' });
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safeFilename}"`,
    'Access-Control-Allow-Origin': allowedOrigin,
  });
  createReadStream(filePath).pipe(response);
}

async function downloadAllSessionJson(response) {
  const saved = await readSavedSessions();
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="mturk_session_json_files.json"',
    'Access-Control-Allow-Origin': allowedOrigin,
  });
  response.end(JSON.stringify({ ok: true, files: saved }, null, 2));
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

  if (request.method === 'GET' && url.pathname === '/api/session-json') {
    await listSessionJsonFiles(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/session-json-all') {
    await downloadAllSessionJson(response);
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/session-json/')) {
    const filename = decodeURIComponent(url.pathname.slice('/api/session-json/'.length));
    await downloadSessionJson(response, filename);
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
  console.log(`JSON files: http://localhost:${port}/api/session-json`);
  console.log(`All JSON download: http://localhost:${port}/api/session-json-all`);
});
