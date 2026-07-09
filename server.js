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
      })),
      final_answer_selected: response.selected_region_id || '',
      final_answer_selected_base_region_id: response.selected_base_region_id || '',
      final_answer_selected_label: response.selected_region_label || '',
      correct_answer: (response.correct_region_ids ?? []).join('|'),
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

function formatClicksJson(clicks = []) {
  return JSON.stringify((clicks ?? []).map((click) => ({
    timestamp: click.timestamp || '',
    region_id: click.region_id || '',
    base_region_id: click.base_region_id || '',
    region_label: click.region_label || '',
  })));
}

function firstClickTimestamp(clicks = []) {
  return clicks?.[0]?.timestamp || '';
}

function lastClickTimestamp(clicks = []) {
  return clicks?.length ? clicks[clicks.length - 1].timestamp || '' : '';
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
    row_type: '',
    row_id: '',
    row_order: '',
    screen_name: '',
    prompt: '',
    answer_given: '',
    final_selected_region_id: '',
    final_selected_base_region_id: '',
    final_selected_region_label: '',
    correct_answer: '',
    is_correct: '',
    requires_manual_review: '',
    all_clicks_json: '',
    first_interaction_timestamp: '',
    last_interaction_timestamp: '',
    screen_started_at: '',
    screen_ended_at: '',
    time_taken_ms: '',
    completion_code: session.completion_code || '',
    browser: clientInfo.browser || '',
    screen_width: clientInfo.screen_width || '',
    screen_height: clientInfo.screen_height || '',
    study_status: session.completion_status || '',
    attention_passed: session.attention_passed ?? '',
  };
}

function flattenSessionRows(rawSession) {
  const session = normalizeSession(rawSession);
  const timing = session.timing ?? {};
  const rows = [];
  const base = makeBaseRow(session);
  let rowOrder = 1;

  const consentEvent = getEvent(session, 'consent_declined') || getEvent(session, 'consent_accepted');
  rows.push({
    ...base,
    row_type: 'consent',
    row_id: 'consent',
    row_order: rowOrder++,
    screen_name: 'Informed Consent',
    prompt: 'Consent form shown',
    answer_given: consentEvent?.type === 'consent_declined' ? 'declined' : 'consented',
    final_selected_region_id: consentEvent?.type || '',
    final_selected_region_label: consentEvent?.type === 'consent_declined' ? 'I do not consent' : 'I consent and want to continue',
    all_clicks_json: consentEvent ? formatClicksJson([{ timestamp: consentEvent.timestamp, region_id: consentEvent.type, region_label: consentEvent.type }]) : '',
    first_interaction_timestamp: consentEvent?.timestamp || '',
    last_interaction_timestamp: consentEvent?.timestamp || '',
    screen_started_at: timing.informed_consent_started_at || session.started_at || '',
    screen_ended_at: timing.informed_consent_ended_at || consentEvent?.timestamp || '',
    time_taken_ms: timing.informed_consent_duration_ms || durationMs(timing.informed_consent_started_at || session.started_at, timing.informed_consent_ended_at || consentEvent?.timestamp),
  });

  if (timing.introduction_started_at || timing.introduction_ended_at) {
    const introEvent = getEvent(session, 'introduction_continued');
    rows.push({
      ...base,
      row_type: 'introduction',
      row_id: 'introduction',
      row_order: rowOrder++,
      screen_name: 'Study Introduction',
      prompt: 'Study instructions shown',
      answer_given: introEvent ? 'continued' : '',
      final_selected_region_id: introEvent?.type || '',
      final_selected_region_label: 'Start study questions',
      all_clicks_json: introEvent ? formatClicksJson([{ timestamp: introEvent.timestamp, region_id: introEvent.type, region_label: 'Start study questions' }]) : '',
      first_interaction_timestamp: introEvent?.timestamp || '',
      last_interaction_timestamp: introEvent?.timestamp || '',
      screen_started_at: timing.introduction_started_at || '',
      screen_ended_at: timing.introduction_ended_at || introEvent?.timestamp || '',
      time_taken_ms: timing.introduction_duration_ms || durationMs(timing.introduction_started_at, timing.introduction_ended_at || introEvent?.timestamp),
    });
  }

  for (const check of session.attention_checks ?? []) {
    rows.push({
      ...base,
      row_type: 'attention',
      row_id: check.attention_question_id || check.check_id || '',
      row_order: rowOrder++,
      screen_name: 'Attention Check',
      prompt: check.prompt || '',
      answer_given: check.answer || '',
      final_selected_region_id: check.answer || '',
      final_selected_base_region_id: check.answer_base_region_id || '',
      final_selected_region_label: check.answer_label || '',
      correct_answer: check.correct_answer || '',
      is_correct: check.is_correct ?? '',
      requires_manual_review: check.requires_manual_review ?? '',
      screen_started_at: check.started_at || '',
      screen_ended_at: check.ended_at || '',
      time_taken_ms: durationMs(check.started_at, check.ended_at),
    });
  }

  for (const question of session.main_questions ?? []) {
    const clicks = question.all_regions_clicked_with_timestamp ?? [];
    rows.push({
      ...base,
      row_type: question.is_attention_check ? 'attention_dashboard' : 'study_question',
      row_id: question.question_asked_id || '',
      row_order: rowOrder++,
      screen_name: question.is_attention_check ? 'Dashboard Attention Check' : 'Dashboard Question',
      prompt: question.prompt || '',
      answer_given: question.final_answer_selected || '',
      final_selected_region_id: question.final_answer_selected || '',
      final_selected_base_region_id: question.final_answer_selected_base_region_id || '',
      final_selected_region_label: question.final_answer_selected_label || '',
      correct_answer: question.correct_answer || '',
      is_correct: question.is_correct ?? '',
      all_clicks_json: formatClicksJson(clicks),
      first_interaction_timestamp: firstClickTimestamp(clicks),
      last_interaction_timestamp: lastClickTimestamp(clicks),
      screen_started_at: question.question_started_at || '',
      screen_ended_at: question.question_ended_at || '',
      time_taken_ms: question.total_time_taken_to_answer_ms || durationMs(question.question_started_at, question.question_ended_at),
    });
  }

  const completedAt = session.ended_at || timing.actual_study_ended_at || '';
  rows.push({
    ...base,
    row_type: 'completion',
    row_id: 'completion',
    row_order: rowOrder++,
    screen_name: 'Completion / Qualtrics Code',
    prompt: 'Participant reached completion screen and received/submitted completion code',
    answer_given: session.completion_code || '',
    final_selected_region_id: 'completion_code',
    final_selected_region_label: 'Completion code',
    screen_started_at: completedAt,
    screen_ended_at: completedAt,
    completion_code: session.completion_code || '',
  });

  return rows;
}

function buildExcelXml(rows) {
  const columns = [
    'session_id',
    'participant_id',
    'workerId',
    'assignmentId',
    'hitId',
    'row_type',
    'row_id',
    'row_order',
    'screen_name',
    'prompt',
    'answer_given',
    'final_selected_region_id',
    'final_selected_base_region_id',
    'final_selected_region_label',
    'correct_answer',
    'is_correct',
    'requires_manual_review',
    'all_clicks_json',
    'first_interaction_timestamp',
    'last_interaction_timestamp',
    'screen_started_at',
    'screen_ended_at',
    'time_taken_ms',
    'completion_code',
    'browser',
    'screen_width',
    'screen_height',
    'study_status',
    'attention_passed',
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
