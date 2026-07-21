import React, { useEffect, useMemo, useRef, useState } from 'react';
import Controller3DViewer from './controllers/Controller3DViewer';
import './controllers/Controller3DViewer.css';

const STORAGE_KEY = 'vr-helper-mturk-study-session';
const CONSENT_VERSION = '2026-07-06';
const FIXED_VR_VIEW_IMAGE = 'img/VR_user_current_view_screenshots/task-18-no-annotation.png';
const CURRENT_TASK_ORDER = 18;

function getTaskNumber(task) {
  if (!task) return 0;
  if (Number.isFinite(task.order)) return task.order;
  const numericPrefix = String(task.title ?? task.id ?? '').match(/^\s*(\d+)/);
  return numericPrefix ? Number(numericPrefix[1]) : 0;
}

function assetUrl(assetPath) {
  if (!assetPath) return undefined;
  const normalized = String(assetPath);
  if (/^(https?:|data:|blob:)/i.test(normalized)) return normalized;
  return `${import.meta.env.BASE_URL}${normalized.replace(/^\/+/, '')}`;
}

function createSessionId() {
  const random =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `session-${random}`;
}

function getIsoTimestamp() {
  return new Date().toISOString();
}

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    workerId: params.get('workerId') ?? '',
    assignmentId: params.get('assignmentId') ?? '',
    hitId: params.get('hitId') ?? '',
    turkSubmitTo: params.get('turkSubmitTo') ?? '',
    participant_id: params.get('participant_id') ?? '',
  };
}

function getParticipantParams(config) {
  const params = getUrlParams();
  if (!config?.debugMode) return params;

  return {
    ...params,
    workerId: params.workerId || params.participant_id || 'debug',
    assignmentId: params.assignmentId || 'DEBUG_ASSIGNMENT',
    hitId: params.hitId || 'DEBUG_HIT',
    participant_id: params.participant_id || params.workerId || 'debug',
  };
}

function isMturkPreview(participantParams) {
  return participantParams?.assignmentId === 'ASSIGNMENT_ID_NOT_AVAILABLE';
}

function normalizeAnswer(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getOptionValue(option) {
  return typeof option === 'object' && option !== null
    ? String(option.value ?? option.label ?? '')
    : String(option ?? '');
}

function getOptionLabel(option) {
  return typeof option === 'object' && option !== null
    ? String(option.label ?? option.value ?? '')
    : String(option ?? '');
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seedValue) {
  let seed = hashString(seedValue || 'vr-helper-mturk-study');
  return () => {
    seed = Math.imul(seed + 0x6d2b79f5, 1);
    let value = seed;
    value ^= value >>> 15;
    value = Math.imul(value, value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function getAttentionInsertionSlots(mainCount, checkCount, seedValue) {
  const random = createSeededRandom(seedValue);
  const slots = Array.from({ length: Math.max(mainCount - 1, 1) }, (_, index) => index + 1);
  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [slots[index], slots[swapIndex]] = [slots[swapIndex], slots[index]];
  }
  return slots.slice(0, checkCount).sort((a, b) => a - b);
}

function shuffleWithSeed(items, seedValue) {
  const random = createSeededRandom(seedValue);
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function makeDashboardAttentionQuestion(check) {
  return {
    question_id: check.check_id,
    prompt: check.prompt,
    correct_answers: check.correct_answers || [],
    question_type: check.question_type || check.type,
    screen_variant: check.screen_variant || 'default',
    is_attention_check: true,
    check_id: check.check_id,
  };
}

function buildQuestionFlow(questions, attentionChecks, sessionId) {
  const scenarioBasedQuestions = questions.some((question) => Array.isArray(question.questions));
  const mainItems = scenarioBasedQuestions
    ? shuffleWithSeed(
      [...questions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      `${sessionId || 'no-session'}:scenarios`,
    ).flatMap((scenario, scenarioIndex) => (
      [...(scenario.questions ?? [])]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((question, questionIndex) => ({
          type: 'dashboard',
          id: question.question_id,
          item: {
            ...question,
            is_attention_check: false,
            scenario_id: scenario.scenario_id,
            scenario_text: scenario.scenario_text,
            scenario_order_index: scenarioIndex + 1,
            scenario_question_index: questionIndex + 1,
            task_id: question.task_id ?? scenario.task_id,
            task_order: question.task_order ?? scenario.task_order,
            vr_view_image: question.vr_view_image ?? scenario.vr_view_image,
            object_view_images: question.object_view_images ?? scenario.object_view_images ?? [],
          },
        }))
    ))
    : shuffleWithSeed(
      [...questions].sort((a, b) => a.order - b.order),
      `${sessionId || 'no-session'}:main-questions`,
    )
      .map((question) => ({ type: 'dashboard', id: question.question_id, item: { ...question, is_attention_check: false } }));
  const checkItems = [...attentionChecks]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((check) => (
      check.type === 'dashboard_click'
        ? { type: 'dashboard', id: check.check_id, item: makeDashboardAttentionQuestion(check), check }
        : { type: 'attention_check', id: check.check_id, item: check }
    ));

  if (!checkItems.length) return mainItems;

  const slots = getAttentionInsertionSlots(mainItems.length, checkItems.length, sessionId);
  const flow = [];
  let checkIndex = 0;
  mainItems.forEach((item, index) => {
    flow.push(item);
    while (slots[checkIndex] === index + 1) {
      flow.push(checkItems[checkIndex]);
      checkIndex += 1;
    }
  });
  while (checkIndex < checkItems.length) {
    flow.push(checkItems[checkIndex]);
    checkIndex += 1;
  }
  return flow;
}

function isAttentionCheckCorrect(check, answer) {
  if (check.type === 'open_text') {
    return String(answer || '').trim().length > 0;
  }
  return normalizeAnswer(answer) === normalizeAnswer(check.correct_answer);
}

function makeQualtricsUrl(config, participantParams, completionCode, sessionId) {
  const base = config.qualtricsRedirectUrl ?? '';
  if (!base) return '';

  try {
    const url = new URL(base);
    if (participantParams.participant_id) url.searchParams.set('participant_id', participantParams.participant_id);
    if (participantParams.workerId) url.searchParams.set('workerId', participantParams.workerId);
    if (participantParams.assignmentId) url.searchParams.set('assignmentId', participantParams.assignmentId);
    if (participantParams.hitId) url.searchParams.set('hitId', participantParams.hitId);
    if (participantParams.turkSubmitTo) url.searchParams.set('turkSubmitTo', participantParams.turkSubmitTo);
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('completion_code', completionCode);
    return url.toString();
  } catch {
    return '';
  }
}

function makeExternalSubmitUrl(turkSubmitTo) {
  const base = String(turkSubmitTo || '').replace(/\/+$/, '');
  return base ? `${base}/mturk/externalSubmit` : '';
}

async function saveSessionMetrics(payload, metricsApiBaseUrl = '') {
  const trimmedBaseUrl = String(metricsApiBaseUrl || '').replace(/\/+$/, '');
  const endpoint = trimmedBaseUrl ? `${trimmedBaseUrl}/api/session` : '/api/session';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Session save failed: ${response.status}`);
  }

  return response.json();
}

function hasRequiredMturkParams(participantParams) {
  return Boolean(
    participantParams?.workerId
    && participantParams?.assignmentId
    && participantParams?.assignmentId !== 'ASSIGNMENT_ID_NOT_AVAILABLE'
    && participantParams?.hitId,
  );
}

function durationMs(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '';
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : '';
}

function compactClick(click) {
  return {
    region_id: click.region_id || click.target_id || '',
    base_region_id: click.base_region_id || click.region_id || click.target_id || '',
    region_label: click.region_label || '',
    timestamp: click.timestamp || '',
    x: click.x ?? '',
    y: click.y ?? '',
  };
}

function getClientInfo() {
  return {
    browser: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    screen_width: typeof window !== 'undefined' ? window.innerWidth : '',
    screen_height: typeof window !== 'undefined' ? window.innerHeight : '',
  };
}

function rectSnapshot(rect) {
  if (!rect) return null;
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
  };
}

function collectLayoutSnapshot(screenElement = null, dashboardElement = null) {
  const regions = {};
  const addRegion = (element, fallbackId = '') => {
    if (!(element instanceof Element)) return;
    const regionId = element.getAttribute('data-region-id') || fallbackId;
    if (!regionId || regionId === 'objects-region') return;
    const rect = rectSnapshot(element.getBoundingClientRect?.());
    if (!rect) return;
    let key = regionId;
    let suffix = 2;
    while (regions[key]) {
      key = `${regionId}#${suffix}`;
      suffix += 1;
    }
    regions[key] = {
      region_id: regionId,
      label: element.getAttribute('aria-label') || element.textContent?.trim()?.replace(/\s+/g, ' ').slice(0, 120) || '',
      rect,
    };
  };

  const root = screenElement instanceof Element ? screenElement : document.body;
  root?.querySelectorAll?.('[data-region-id]')?.forEach((element) => addRegion(element));

  return {
    viewport: {
      width: typeof window !== 'undefined' ? window.innerWidth : '',
      height: typeof window !== 'undefined' ? window.innerHeight : '',
    },
    dashboard_rect: rectSnapshot(dashboardElement?.getBoundingClientRect?.()),
    regions,
  };
}

function createClickLayoutSnapshot(event, dashboardElement = null) {
  const nativeEvent = event?.nativeEvent ?? event;
  const clientX = event?.clientX ?? nativeEvent?.clientX;
  const clientY = event?.clientY ?? nativeEvent?.clientY;
  const targetElement = event?.currentTarget instanceof Element
    ? event.currentTarget
    : nativeEvent?.currentTarget instanceof Element
      ? nativeEvent.currentTarget
      : null;
  const targetRect = targetElement?.getBoundingClientRect?.();
  const dashboardRect = dashboardElement?.getBoundingClientRect?.();

  return {
    viewport_width: typeof window !== 'undefined' ? window.innerWidth : '',
    viewport_height: typeof window !== 'undefined' ? window.innerHeight : '',
    client_x: typeof clientX === 'number' ? Math.round(clientX) : '',
    client_y: typeof clientY === 'number' ? Math.round(clientY) : '',
    target_rect: rectSnapshot(targetRect),
    dashboard_rect: rectSnapshot(dashboardRect),
  };
}

function createScreenClickRecord(elementName, event, extra = {}) {
  const nativeEvent = event?.nativeEvent ?? event;
  const clientX = event?.clientX ?? nativeEvent?.clientX;
  const clientY = event?.clientY ?? nativeEvent?.clientY;
  const dashboardRect = extra.dashboardElement?.getBoundingClientRect?.();
  const dashboardX = dashboardRect && typeof clientX === 'number' ? Math.round(clientX - dashboardRect.left) : '';
  const dashboardY = dashboardRect && typeof clientY === 'number' ? Math.round(clientY - dashboardRect.top) : '';
  return {
    element_clicked: elementName,
    timestamp: getIsoTimestamp(),
    client_x: typeof clientX === 'number' ? Math.round(clientX) : '',
    client_y: typeof clientY === 'number' ? Math.round(clientY) : '',
    dashboard_x: dashboardX,
    dashboard_y: dashboardY,
    layout_snapshot: collectLayoutSnapshot(extra.screenElement, extra.dashboardElement),
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'screenElement' && key !== 'dashboardElement')),
  };
}

function buildMetricsPayload(session, config) {
  const participantParams = session.participant_params ?? {};
  const clientInfo = getClientInfo();
  const base = {
    session_id: session.session_id,
    participant_id: participantParams.participant_id || participantParams.workerId || session.session_id,
    workerId: participantParams.workerId || '',
    assignmentId: participantParams.assignmentId || '',
    hitId: participantParams.hitId || '',
    browser: clientInfo.browser,
    screen_width: clientInfo.screen_width,
    screen_height: clientInfo.screen_height,
    completion_code: session.completion_code || '',
    debug_mode: Boolean(config?.debugMode),
  };
  const timing = session.timing ?? {};
  const rows = [];

  const makeRow = (values) => ({
    ...base,
    screen_name: '',
    scenario_id: '',
    scenario_text: '',
    task_id: '',
    task_order: '',
    question_asked: '',
    final_answer: '',
    layout_snapshot: '',
    all_clicked_elements: '[]',
    click_count: 0,
    is_correct: '',
    time_spent_ms: '',
    ...values,
  });
  const clicksJson = (clicks = []) => JSON.stringify((clicks ?? []).map((click, index) => ({
    click_index: index + 1,
    timestamp: click.timestamp || '',
    client_x: click.client_x ?? '',
    client_y: click.client_y ?? '',
    dashboard_x: click.dashboard_x ?? click.x ?? '',
    dashboard_y: click.dashboard_y ?? click.y ?? '',
  })));
  const layoutJson = (layoutSnapshot) => JSON.stringify(layoutSnapshot || {});
  const findEvent = (type) => (session.events ?? []).find((event) => event.type === type);

  const consentEvent = findEvent('consent_declined') || findEvent('consent_accepted');
  const consentStartedAt = timing.informed_consent_started_at || session.started_at || '';
  const consentEndedAt = timing.informed_consent_ended_at || consentEvent?.timestamp || '';
  const consentClicks = consentEvent ? [consentEvent] : [];
  rows.push(makeRow({
    screen_name: 'Informed Consent',
    question_asked: 'Consent form shown',
    final_answer: consentEvent?.type === 'consent_declined' ? 'declined' : 'consented',
    layout_snapshot: layoutJson(consentClicks.find((click) => click.layout_snapshot)?.layout_snapshot),
    all_clicked_elements: clicksJson(consentClicks),
    click_count: consentClicks.length,
    time_spent_ms: durationMs(consentStartedAt, consentEndedAt),
    _screen_started_at: consentStartedAt,
  }));

  if (timing.introduction_started_at || timing.introduction_ended_at) {
    const introEvent = findEvent('introduction_continued');
    const introClicks = (session.events ?? [])
      .filter((event) => event.type === 'introduction_click');
    if (!introClicks.length && introEvent) {
      introClicks.push({ timestamp: introEvent.timestamp, element_clicked: 'study_introduction_start_questions_button' });
    }
    rows.push(makeRow({
      screen_name: 'Study Introduction',
      question_asked: 'Study instructions shown',
      final_answer: introEvent ? 'continued' : '',
      layout_snapshot: layoutJson(introClicks.find((click) => click.layout_snapshot)?.layout_snapshot),
      all_clicked_elements: clicksJson(introClicks),
      click_count: introClicks.length,
      time_spent_ms: durationMs(timing.introduction_started_at, timing.introduction_ended_at || introEvent?.timestamp),
      _screen_started_at: timing.introduction_started_at || '',
    }));
  }

  for (const check of session.attention_checks ?? []) {
    const checkClicks = Array.isArray(check.clicks) && check.clicks.length
      ? check.clicks
      : (check.answer ? [{ timestamp: check.ended_at, element_clicked: check.answer_label || check.answer }] : []);
    rows.push(makeRow({
      screen_name: 'Attention Check',
      question_asked: check.prompt || '',
      final_answer: check.answer_label || check.answer || '',
      layout_snapshot: layoutJson(check.layout_snapshot || checkClicks.find((click) => click.layout_snapshot)?.layout_snapshot),
      all_clicked_elements: clicksJson(checkClicks),
      click_count: checkClicks.length,
      is_correct: check.is_correct ?? '',
      time_spent_ms: durationMs(check.started_at, check.ended_at),
      _screen_started_at: check.started_at || '',
    }));
  }

  for (const response of session.responses ?? []) {
    if (response.is_attention_check) continue;
    const clicks = response.clicks ?? [];
    rows.push(makeRow({
      screen_name: response.is_attention_check ? 'Dashboard Attention Check' : 'Dashboard Question',
      scenario_id: response.scenario_id || '',
      scenario_text: response.scenario_text || '',
      task_id: response.task_id || '',
      task_order: response.task_order || '',
      question_asked: response.prompt || '',
      final_answer: response.selected_region_label || response.selected_region_id || '',
      layout_snapshot: layoutJson(response.layout_snapshot || clicks.find((click) => click.layout_snapshot)?.layout_snapshot),
      all_clicked_elements: clicksJson(clicks),
      click_count: clicks.length,
      is_correct: response.is_correct ?? '',
      time_spent_ms: response.response_time_ms || durationMs(response.question_started_at, response.final_click_timestamp),
      _screen_started_at: response.question_started_at || '',
    }));
  }

  const completedAt = session.ended_at || timing.actual_study_ended_at || '';
  const completionSubmittedAt = session.completion_submitted_at || timing.completion_submitted_at || '';
  const completionStartedAt = timing.completion_started_at || completedAt;
  const completionScreenClicks = (session.events ?? [])
    .filter((event) => event.type === 'completion_click');
  const completionClicks = [
    ...(completedAt ? [{ timestamp: completedAt, element_clicked: 'completion_qualtrics_code_generated' }] : []),
    ...completionScreenClicks,
    ...(completionSubmittedAt && !completionScreenClicks.some((click) => click.element_clicked === 'completion_code_submit_button')
      ? [{ timestamp: completionSubmittedAt, element_clicked: 'completion_code_submit_button' }]
      : []),
  ];
  rows.push(makeRow({
    screen_name: 'Completion / Qualtrics Code',
    question_asked: 'Participant reached completion screen and received/submitted completion code',
    final_answer: session.completion_entered_code || session.completion_code || '',
    layout_snapshot: layoutJson(completionClicks.find((click) => click.layout_snapshot)?.layout_snapshot),
    all_clicked_elements: clicksJson(completionClicks),
    click_count: completionClicks.length,
    time_spent_ms: timing.completion_duration_ms || durationMs(completionStartedAt, completionSubmittedAt),
    _screen_started_at: completionStartedAt,
  }));

  rows.sort((a, b) => {
    const aTime = Date.parse(a._screen_started_at);
    const bTime = Date.parse(b._screen_started_at);
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid && aTime !== bTime) return aTime - bTime;
    if (aValid && !bValid) return -1;
    if (!aValid && bValid) return 1;
    return 0;
  });

  return {
    session_id: session.session_id,
    participant_id: base.participant_id,
    workerId: base.workerId,
    assignmentId: base.assignmentId,
    hitId: base.hitId,
    debug_mode: Boolean(config?.debugMode),
    turkSubmitTo: participantParams.turkSubmitTo || '',
    completion_status: session.completion_status,
    attention_passed: session.attention_passed,
    completion_code: session.completion_code || '',
    completion_code_prefix: config?.completionCodePrefix ?? 'VRHELP',
    submission_token: config?.submissionToken ?? '',
    qualtrics_redirect_url: session.qualtrics_redirect_url || '',
    study_name: config?.studyName ?? '',
    generated_at: getIsoTimestamp(),
    rows: rows.map(({ _screen_started_at, ...row }) => row),
  };
}
function formatTextTemplate(template, values = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

function renderTextBlocks(blocks = []) {
  return blocks.map((block, index) => {
    if (block.type === 'heading') {
      return <p key={index}><strong>{block.text}</strong></p>;
    }
    if (block.type === 'list') {
      return <ul key={index}>{(block.items ?? []).map((item) => <li key={item}>{item}</li>)}</ul>;
    }
    return <p key={index}>{block.text}</p>;
  });
}

function LandingPage({ onAccept, onDecline, uiText }) {
  const text = uiText?.consent ?? {};
  return (
    <main className="page-shell" data-region-id="consent-screen">
      <section className="study-card consent-card" data-region-id="consent-card" aria-label="Informed consent form">
        <h1 data-region-id="consent-title">{text.title ?? 'Informed Consent'}</h1>
        <div className="consent-box consent-full-text" data-region-id="consent-text">
          {renderTextBlocks(text.blocks)}
        </div>
        <div className="consent-actions" data-region-id="consent-actions">
          <button className="primary-action" type="button" data-region-id="informed_consent_accept_button" onClick={onAccept}>
            {text.acceptButton ?? 'I consent and want to continue'}
          </button>
          <button className="secondary-action" type="button" data-region-id="informed_consent_decline_button" onClick={onDecline}>
            {text.declineButton ?? 'I do not consent'}
          </button>
        </div>
      </section>
    </main>
  );
}
function IntroPage({ onNext, onInteraction, uiText }) {
  const text = uiText?.intro ?? {};
  const slides = text.slides ?? [];
  const [slideIndex, setSlideIndex] = useState(0);
  const totalSlides = slides.length;
  const currentSlide = slides[slideIndex];
  const isLastSlide = slideIndex >= totalSlides - 1;

  function recordIntroClick(elementName, event) {
    onInteraction?.({
      type: 'introduction_click',
      ...createScreenClickRecord(elementName, event),
      slide_index: slideIndex,
    });
  }

  function goBack(event) {
    recordIntroClick('study_introduction_back_button', event);
    setSlideIndex((index) => Math.max(index - 1, 0));
  }

  function goNext(event) {
    if (isLastSlide) {
      recordIntroClick('study_introduction_start_questions_button', event);
      onNext();
      return;
    }
    recordIntroClick('study_introduction_next_button', event);
    setSlideIndex((index) => Math.min(index + 1, totalSlides - 1));
  }

  return (
    <main className="page-shell" data-region-id="study-introduction-screen">
      <section className="study-card intro-card intro-slide-card" data-region-id="study-introduction-card" aria-label="Study introduction">
        <div className="intro-slide-header" data-region-id="study-introduction-header">
          <div>
            <h1 data-region-id="study-introduction-title">{text.title ?? 'Study Introduction'}</h1>
          </div>
          {totalSlides > 0 && (
            <p className="intro-slide-counter" data-region-id="study-introduction-slide-counter">{slideIndex + 1} / {totalSlides}</p>
          )}
        </div>

        {currentSlide ? (
          <div className="intro-slide-frame" data-region-id="study-introduction-slide">
            <img
              src={assetUrl(currentSlide)}
              alt={`${text.slideAltPrefix ?? 'Introduction slide'} ${slideIndex + 1}`}
              className="intro-slide-image"
            />
          </div>
        ) : (
          <div className="intro-slide-fallback" data-region-id="study-introduction-text">
            {(text.paragraphs ?? []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>
        )}

        <div className="intro-slide-actions" data-region-id="study-introduction-actions">
          <button className="secondary-action" type="button" data-region-id="study_introduction_back_button" onClick={goBack} disabled={slideIndex === 0}>
            {text.backButton ?? 'Back'}
          </button>
          <button className="primary-action" type="button" data-region-id={isLastSlide ? 'study_introduction_start_questions_button' : 'study_introduction_next_button'} onClick={goNext}>
            {isLastSlide ? (text.startButton ?? 'Start study questions') : (text.nextButton ?? 'Next')}
          </button>
        </div>
      </section>
    </main>
  );
}

function getObjectViewImage(index, objectViewImages = []) {
  if (objectViewImages[index]) return objectViewImages[index];
  if (objectViewImages[0]) return objectViewImages[0];
  const objectNumber = index + 1;
  if (objectNumber === 7) return 'img/VR_user_current_view_screenshots/task-18-obj-7.png';
  return `img/VR_user_current_view_screenshots/task-18-obj-${objectNumber}.png`;
}

function getObjectKey(object, index = 0) {
  return `${object?.id ?? object?.label ?? 'object'}-${index}`;
}

function readableRegionId(prefix, label, fallback = '') {
  return `${prefix}-${String(label || fallback).trim() || 'unknown'}`;
}

function getButtonsForObject(object, controllerSide) {
  const buttons = object?.controllerHints?.[controllerSide]?.needsToPress ?? [];
  return Array.isArray(buttons) ? buttons.filter(Boolean) : [];
}

function getButtonLabel(buttons) {
  if (!buttons?.length) return '';
  return buttons
    .map((button) => String(button).replace(/_/g, ' '))
    .map((button) => button.charAt(0).toUpperCase() + button.slice(1))
    .join(' + ');
}

function getRegionFeedbackLabel(regionId, uiText) {
  if (regionId?.startsWith('object-button-')) return regionId.replace('object-button-', '') || (uiText?.regionLabels?.objectButton ?? 'object button');
  if (regionId?.startsWith('dropdown-value-')) return regionId.replace('dropdown-value-', '') || 'dropdown value';
  if (regionId?.startsWith('controller-side-dropdown-')) return `controller side dropdown: ${regionId.replace('controller-side-dropdown-', '')}`;
  return uiText?.regionLabels?.[regionId] ?? regionId.replaceAll('-', ' ');
}

function isCorrectRegionSelection(selectedRegionId, correctRegionIds, selectedBaseRegionId = '') {
  if (correctRegionIds.includes(selectedRegionId) || correctRegionIds.includes(selectedBaseRegionId)) return true;
  if (selectedRegionId?.startsWith('object-button-')) {
    return correctRegionIds.includes('object-button');
  }
  if (selectedRegionId?.startsWith('dropdown-value-')) {
    return correctRegionIds.includes('dropdown-value');
  }
  return false;
}

function SimulatedDashboard({ selectedRegionId, onRegionClick, screenVariant, metadata, resetKey, uiText, scenarioConfig = {} }) {
  const tasks = metadata?.tasks ?? [];
  const dashboardText = uiText?.dashboard ?? {};
  const initialTask = (
    scenarioConfig.task_id
      ? tasks.find((task) => task.id === scenarioConfig.task_id)
      : null
  )
    ?? (
      Number.isFinite(Number(scenarioConfig.task_order))
        ? tasks.find((task) => getTaskNumber(task) === Number(scenarioConfig.task_order))
        : null
    )
    ?? tasks.find((task) => getTaskNumber(task) === CURRENT_TASK_ORDER)
    ?? tasks[0];
  const baseVrViewImage = scenarioConfig.vr_view_image || FIXED_VR_VIEW_IMAGE;
  const objectViewImages = Array.isArray(scenarioConfig.object_view_images)
    ? scenarioConfig.object_view_images
    : [];
  const [selectedTaskId, setSelectedTaskId] = useState(initialTask?.id ?? '');
  const [selectedObjectKey, setSelectedObjectKey] = useState('');
  const [controllerSide, setControllerSide] = useState('left');
  const [isControllerVideoPlaying, setIsControllerVideoPlaying] = useState(false);
  const [isDemoVideoPlaying, setIsDemoVideoPlaying] = useState(false);
  const [controllerVideoProgress, setControllerVideoProgress] = useState(0);
  const [demoVideoProgress, setDemoVideoProgress] = useState(0);
  const [sentControllerVideo, setSentControllerVideo] = useState(false);
  const [isFreehandActive, setIsFreehandActive] = useState(false);
  const [hasActiveAnnotation, setHasActiveAnnotation] = useState(false);
  const [hasObjectAnnotation, setHasObjectAnnotation] = useState(false);
  const [vrViewImage, setVrViewImage] = useState(baseVrViewImage);
  const [isTaskDropdownOpen, setIsTaskDropdownOpen] = useState(false);
  const [screencastVolume, setScreencastVolume] = useState(70);
  const [isVolumeOpen, setIsVolumeOpen] = useState(false);
  const [openTooltipId, setOpenTooltipId] = useState('');
  const controllerVideoRef = useRef(null);
  const demoVideoRef = useRef(null);
  const dashboardContainerRef = useRef(null);
  const freehandCanvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const lastDrawPointRef = useRef(null);
  const currentTask = tasks.find((task) => task.id === selectedTaskId) ?? initialTask;
  const selectedObject = currentTask?.objects?.find((object, index) => getObjectKey(object, index) === selectedObjectKey)
    ?? currentTask?.objects?.[0];
  const currentTaskNumber = getTaskNumber(currentTask);
  const runtimeCurrentTaskNumber = getTaskNumber(initialTask);
  const selectedControllerButtons = getButtonsForObject(selectedObject, controllerSide);
  const controllerButtonLabel = getButtonLabel(selectedControllerButtons);
  const demoThumbnail = currentTask?.demoVideoInworld?.thumbnail;
  const controllerThumbnail = selectedObject?.demoVideoPhysicalworld?.thumbnail;
  const demoVideoUrl = currentTask?.demoVideoInworld?.file;
  const controllerVideoUrl = selectedObject?.demoVideoPhysicalworld?.[
    controllerSide === 'right' ? 'rightVideoUrl' : 'leftVideoUrl'
  ];
  const getTaskStatus = (task) => {
    const taskNumber = getTaskNumber(task);
    if (taskNumber < runtimeCurrentTaskNumber) return 'completed';
    if (taskNumber > runtimeCurrentTaskNumber) return 'future';
    return 'current';
  };
  const selectedTaskStatus = getTaskStatus(currentTask);
  const taskStatusRegion = {
    completed: 'dropdown-value',
    current: 'dropdown-value',
    future: 'dropdown-value',
  };
  const sectionTooltips = dashboardText.tooltips ?? {};
  const isCurrentTask = selectedTaskStatus === 'current';
  const sentVideoThumbnail = sentControllerVideo ? controllerThumbnail : '';
  const sentVideoUrl = sentControllerVideo ? controllerVideoUrl : '';
  const hasControllerVideo = Boolean(controllerVideoUrl);
  const regionProps = (regionId) => ({
    'data-region-id': regionId,
    className: `sim-region clickable-region ${selectedRegionId === regionId ? 'selected-region' : ''}`,
    onClick: (event) => {
      event.stopPropagation();
      emitRegionClick(regionId, event);
    },
  });

  const actionProps = (regionId, extraClass = '', disabled = false) => ({
    'data-region-id': regionId,
    className: `sim-button clickable-region ${extraClass} ${disabled ? 'disabled-control' : ''} ${selectedRegionId === regionId ? 'selected-region' : ''}`,
    'aria-disabled': disabled ? 'true' : undefined,
    onClick: (event) => {
      event.stopPropagation();
      emitRegionClick(regionId, event, disabled ? { trackOnly: true } : {});
    },
  });

  useEffect(() => {
    if (!initialTask) return;
    setSelectedTaskId(initialTask.id);
  }, [initialTask?.id]);

  useEffect(() => {
    if (!initialTask) return;
    setSelectedTaskId(initialTask.id);
    setSelectedObjectKey(getObjectKey(initialTask?.objects?.[0], 0));
    setControllerSide('left');
    setIsControllerVideoPlaying(false);
    setIsDemoVideoPlaying(false);
    setControllerVideoProgress(0);
    setDemoVideoProgress(0);
    setSentControllerVideo(false);
    setIsFreehandActive(false);
    setHasActiveAnnotation(false);
    setHasObjectAnnotation(false);
    setIsTaskDropdownOpen(screenVariant === 'dropdown-open');
    setVrViewImage(baseVrViewImage);
    isDrawingRef.current = false;
    lastDrawPointRef.current = null;
    clearFreehandCanvas();
  }, [resetKey, initialTask?.id, baseVrViewImage, screenVariant]);

  useEffect(() => {
    setSelectedObjectKey(getObjectKey(currentTask?.objects?.[0], 0));
    setControllerSide('left');
    setIsControllerVideoPlaying(false);
    setIsDemoVideoPlaying(false);
    setControllerVideoProgress(0);
    setDemoVideoProgress(0);
    setSentControllerVideo(false);
    setIsFreehandActive(false);
    setHasActiveAnnotation(false);
    setHasObjectAnnotation(false);
    setVrViewImage(baseVrViewImage);
    clearFreehandCanvas();
  }, [currentTask?.id, baseVrViewImage]);

  useEffect(() => {
    setIsControllerVideoPlaying(false);
    setSentControllerVideo(false);
    setControllerVideoProgress(0);
  }, [selectedObjectKey, controllerSide]);

  useEffect(() => {
    if (!openTooltipId) return undefined;
    const closeTooltip = (event) => {
      if (event.target?.closest?.('.section-info-wrap')) return;
      setOpenTooltipId('');
    };
    document.addEventListener('pointerdown', closeTooltip, true);
    return () => document.removeEventListener('pointerdown', closeTooltip, true);
  }, [openTooltipId]);

  useEffect(() => {
    const video = controllerVideoRef.current;
    if (!video) return;
    if (isControllerVideoPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isControllerVideoPlaying, controllerVideoUrl]);

  useEffect(() => {
    const video = demoVideoRef.current;
    if (!video) return;
    if (isDemoVideoPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isDemoVideoPlaying, demoVideoUrl]);

  function handleObjectSelect(event) {
    const selectedOptionLabel = event.target.selectedOptions?.[0]?.textContent?.trim() || event.target.value;
    setSelectedObjectKey(event.target.value);
    setIsControllerVideoPlaying(false);
    setSentControllerVideo(false);
    emitRegionClick(readableRegionId('dropdown-value', selectedOptionLabel), event, {
      baseRegionId: 'dropdown-value',
      regionLabel: `dropdown value: ${selectedOptionLabel}`,
    });
  }

  function handleControllerSideSelect(event, nextSide) {
    const selectedSide = nextSide || event.target.value;
    const selectedOptionLabel = selectedSide === 'right'
      ? (dashboardText.rightController ?? 'Right controller')
      : (dashboardText.leftController ?? 'Left controller');
    setControllerSide(selectedSide);
    emitRegionClick(readableRegionId('controller-side-dropdown', selectedOptionLabel), event, {
      baseRegionId: 'controller-side-dropdown',
      regionLabel: `controller side dropdown: ${selectedOptionLabel}`,
    });
  }

  function handleObjectButtonClick(event, object, index) {
    setSelectedObjectKey(getObjectKey(object, index));
    setIsControllerVideoPlaying(false);
    setVrViewImage(getObjectViewImage(index, objectViewImages));
    setHasObjectAnnotation(true);
    setHasActiveAnnotation(true);
    emitRegionClick(readableRegionId('object-button', object?.label, object?.id || index), event, {
      baseRegionId: 'object-button',
      regionLabel: object?.label || object?.id || 'object button',
    });
  }

  function prepareFreehandCanvas() {
    const canvas = freehandCanvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));

    if (canvas.width !== width || canvas.height !== height) {
      const previous = document.createElement('canvas');
      previous.width = canvas.width;
      previous.height = canvas.height;
      previous.getContext('2d')?.drawImage(canvas, 0, 0);

      canvas.width = width;
      canvas.height = height;
      const resizedContext = canvas.getContext('2d');
      resizedContext?.drawImage(previous, 0, 0, width, height);
    }

    const context = canvas.getContext('2d');
    if (!context) return null;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.strokeStyle = '#ffe100';
    context.lineWidth = 6;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    return { canvas, context };
  }

  function getCanvasPoint(event) {
    const canvas = freehandCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function handleFreehandPointerDown(event) {
    if (!isFreehandActive) return;
    event.preventDefault();
    event.stopPropagation();
    prepareFreehandCanvas();
    isDrawingRef.current = true;
    lastDrawPointRef.current = getCanvasPoint(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    emitRegionClick('VR-user-current-view-region', event);
  }

  function handleVideoProgress(event, setProgress) {
    const video = event.currentTarget;
    if (!video.duration || Number.isNaN(video.duration)) {
      setProgress(0);
      return;
    }
    setProgress(Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100)));
  }

  function handleFreehandPointerMove(event) {
    if (!isFreehandActive || !isDrawingRef.current) return;
    event.preventDefault();
    event.stopPropagation();

    const prepared = prepareFreehandCanvas();
    const previousPoint = lastDrawPointRef.current;
    const nextPoint = getCanvasPoint(event);
    if (!prepared || !previousPoint || !nextPoint) return;

    prepared.context.beginPath();
    prepared.context.moveTo(previousPoint.x, previousPoint.y);
    prepared.context.lineTo(nextPoint.x, nextPoint.y);
    prepared.context.stroke();
    lastDrawPointRef.current = nextPoint;
  }

  function stopFreehandDrawing(event) {
    if (!isDrawingRef.current) return;
    event?.preventDefault();
    event?.stopPropagation();
    isDrawingRef.current = false;
    lastDrawPointRef.current = null;
  }

  function clearFreehandCanvas() {
    const canvas = freehandCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  const vrViewRegionProps = regionProps('VR-user-current-view-region');

  function emitRegionClick(regionId, event, details = {}) {
    let dashboardX = '';
    let dashboardY = '';
    const clientX = event?.clientX ?? event?.nativeEvent?.clientX;
    const clientY = event?.clientY ?? event?.nativeEvent?.clientY;
    if (dashboardContainerRef.current && typeof clientX === 'number' && typeof clientY === 'number') {
      const rect = dashboardContainerRef.current.getBoundingClientRect();
      dashboardX = Math.round(clientX - rect.left);
      dashboardY = Math.round(clientY - rect.top);
    }
    onRegionClick(regionId, event, {
      ...details,
      client_x: typeof clientX === 'number' ? Math.round(clientX) : '',
      client_y: typeof clientY === 'number' ? Math.round(clientY) : '',
      dashboard_x: dashboardX,
      dashboard_y: dashboardY,
      viewport_width: typeof window !== 'undefined' ? window.innerWidth : '',
      viewport_height: typeof window !== 'undefined' ? window.innerHeight : '',
      layoutSnapshot: collectLayoutSnapshot(dashboardContainerRef.current, dashboardContainerRef.current),
    });
  }

  function SectionTitle({ children, tooltipId, as: Tag = 'h2' }) {
    const tooltip = sectionTooltips?.[tooltipId];
    return (
      <Tag className="section-title-with-info">
        <span>{children}</span>
        {tooltip && (
          <span className="section-info-wrap">
            <button
              type="button"
              className="section-info-button"
              data-region-id={`tooltip-button-${tooltipId}`}
              aria-label={`More information about ${children}`}
              aria-expanded={openTooltipId === tooltipId}
              onClick={(event) => {
                event.stopPropagation();
                emitRegionClick(`tooltip-button-${tooltipId}`, event, {
                  baseRegionId: 'tooltip-button',
                  regionLabel: `tooltip button: ${tooltipId}`,
                  trackOnly: true,
                });
                setOpenTooltipId((value) => value === tooltipId ? '' : tooltipId);
              }}
            >
              <img className="section-info-icon" src={assetUrl('img/button_icons/info.png')} alt="" aria-hidden="true" />
            </button>
            {openTooltipId === tooltipId && (
              <span className="section-tooltip" role="tooltip" data-region-id={`tooltip-${tooltipId}`}>
                {tooltip}
              </span>
            )}
          </span>
        )}
      </Tag>
    );
  }

  const taskStatusIconPath = {
    completed: 'img/button_icons/completed.png',
    current: 'img/button_icons/current.png',
    future: 'img/button_icons/future.png',
  };

  return (
    <div className="tablet-frame">
    <div
      ref={dashboardContainerRef}
      className={`sim-dashboard selected-task-${selectedTaskStatus} ${selectedRegionId ? 'has-selected-region' : ''}`}
      aria-label="Simulated VR helper dashboard"
      onClick={(event) => {
        setOpenTooltipId('');
        emitRegionClick('dashboard-empty-area', event, {
          baseRegionId: 'dashboard-empty-area',
          regionLabel: 'dashboard empty area',
          trackOnly: true,
        });
      }}
    >
      <section className="sim-region task-dropdown-panel" aria-label="Task dropdown">
        <div className="task-select">
          <button
            type="button"
            className={`task-select-trigger clickable-region ${selectedRegionId === 'dropdown' ? 'selected-region' : ''}`}
            data-region-id="dropdown"
            onClick={(event) => {
              event.stopPropagation();
              setIsTaskDropdownOpen((value) => !value);
              emitRegionClick('dropdown', event);
            }}
          >
            <span className="task-select-trigger-text">
              {currentTaskNumber}. {currentTask?.title}
            </span>
            <img
              className={`task-status-icon task-status-icon-${selectedTaskStatus}`}
              src={assetUrl(taskStatusIconPath[selectedTaskStatus] ?? taskStatusIconPath.future)}
              alt=""
              aria-hidden="true"
            />
            <span className="task-select-chevron" aria-hidden="true">v</span>
          </button>
        </div>
        {isTaskDropdownOpen && (
          <div
            className="task-select-list clickable-region"
            data-region-id="dropdown"
            onClick={(event) => {
              event.stopPropagation();
              emitRegionClick('dropdown', event);
            }}
          >
            {tasks.map((task) => {
              const rowStatus = getTaskStatus(task);
              const rowRegion = taskStatusRegion[rowStatus];
              const rowRegionId = readableRegionId('dropdown-value', `${getTaskNumber(task)}. ${task.title}`, task.id);
              return (
                <button
                  key={task.id}
                  type="button"
                  {...actionProps(rowRegionId, `task-select-option task-select-option-${rowStatus}`)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedTaskId(task.id);
                    setIsTaskDropdownOpen(false);
                    emitRegionClick(rowRegionId, event, {
                      baseRegionId: rowRegion,
                      regionLabel: 'dropdown value: ' + getTaskNumber(task) + '. ' + task.title,
                    });
                  }}
                >
                  <img
                    className={`task-status-icon task-status-icon-${rowStatus}`}
                    src={assetUrl(taskStatusIconPath[rowStatus] ?? taskStatusIconPath.future)}
                    alt=""
                    aria-hidden="true"
                  />
                  <span className="task-select-option-text">
                  {getTaskNumber(task)}. {task.title}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="screencast-volume-control">
          <button
            type="button"
            className="screencast-volume-button clickable-region"
            data-region-id="screencast-volume-control"
            aria-expanded={isVolumeOpen}
            onClick={(event) => {
              event.stopPropagation();
              setIsVolumeOpen((value) => !value);
              emitRegionClick('screencast-volume-control', event);
            }}
          >
            <img className="button-action-icon" src={assetUrl('img/button_icons/listen.png')} alt="" aria-hidden="true" />
            <span>Adjust your volume</span>
          </button>
          {isVolumeOpen && (
            <div className="screencast-volume-popover">
              <input
                aria-label="Manage your own volume"
                className="screencast-volume-slider clickable-region"
                data-region-id="screencast-volume-control"
                type="range"
                min="0"
                max="100"
                value={screencastVolume}
                onClick={(event) => {
                  event.stopPropagation();
                  emitRegionClick('screencast-volume-control', event);
                }}
                onChange={(event) => {
                  setScreencastVolume(Number(event.target.value));
                }}
              />
            </div>
          )}
        </div>
      </section>

      <section className="sim-region objects-panel" aria-label="Current activity objects">
        <SectionTitle tooltipId="objects">{dashboardText.objectsTitle ?? 'Current activity objects'}&nbsp;</SectionTitle>
        <div className="object-button-list">
          {(currentTask?.objects ?? []).map((object, index) => {
            const regionId = readableRegionId('object-button', object?.label, object?.id || index);
            const objectKey = getObjectKey(object, index);
            return (
              <button
                key={objectKey}
                {...actionProps(regionId, `object-button ${selectedObjectKey === objectKey ? 'active-object-button' : ''}`, !isCurrentTask)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!isCurrentTask) return;
                  handleObjectButtonClick(event, object, index);
                }}
              >
                <span className="object-icon-wrap">
                  {object.icon ? <img src={assetUrl(object.icon)} alt="" /> : <span className="object-icon-fallback" />}
                </span>
                <span>{object.label}</span>
              </button>
            );
          })}
        </div>
        <div className="object-clear-area">
          <button
            {...actionProps('objects-region-clear-button', 'object-clear-button')}
            onClick={(event) => {
              event.stopPropagation();
              setVrViewImage(baseVrViewImage);
              setHasObjectAnnotation(false);
              if (!sentControllerVideo && !isFreehandActive) {
                setHasActiveAnnotation(false);
              }
              emitRegionClick('objects-region-clear-button', event);
            }}
          >
            <img className="button-action-icon" src={assetUrl('img/button_icons/clear.png')} alt="" aria-hidden="true" />
            <span>{dashboardText.clearObjects ?? 'Clear'}</span>
          </button>
        </div>
      </section>

      <section
        {...vrViewRegionProps}
        className={`${vrViewRegionProps.className} ${vrViewImage ? 'has-vr-view-image' : ''}`}
        aria-label="Real-time VR user view"
        style={vrViewImage ? { backgroundImage: `url("${assetUrl(vrViewImage)}")` } : undefined}
      >
        <div className="vr-horizon" />
        <div className="ship-deck" />
        <div className="harpoon-silhouette" />
        <canvas
          ref={freehandCanvasRef}
          className={`freehand-canvas ${isFreehandActive ? 'drawing-enabled' : ''}`}
          aria-label="Free hand drawing canvas"
          onPointerDown={handleFreehandPointerDown}
          onPointerMove={handleFreehandPointerMove}
          onPointerUp={stopFreehandDrawing}
          onPointerCancel={stopFreehandDrawing}
          onPointerLeave={stopFreehandDrawing}
        />
        {(sentControllerVideo) && (
          <div
            className="vr-sent-video"
            data-region-id="vr-sent-video"
            style={sentVideoThumbnail ? { backgroundImage: `linear-gradient(rgba(0,0,0,.12), rgba(0,0,0,.42)), url("${assetUrl(sentVideoThumbnail)}")` } : undefined}
          >
            {sentVideoUrl && (
              <video
                className="vr-sent-video-media"
                src={assetUrl(sentVideoUrl)}
                poster={assetUrl(sentVideoThumbnail)}
                autoPlay
                muted
                loop
                playsInline
              />
            )}
            <span className="vr-sent-play">▶</span>
          </div>
        )}
      </section>
      <section
        className={`sim-region physical-action-section dimmable-region ${
          selectedRegionId === 'physical-world-video-region'
          || selectedRegionId === 'controller-send-button'
          || selectedRegionId === 'controller-clear-button'
            ? 'contains-selected-region'
            : ''
        }`}
        aria-label="Physical action video"
      >
        <div className="physical-action-header">
          <span className="physical-action-title-text">{dashboardText.physicalActionTitle ?? 'Physical action video'}</span>
        
          {sectionTooltips?.physicalAction && (
            <span className="section-info-wrap physical-action-info-wrap">
              <button
                type="button"
                className="section-info-button"
                data-region-id="tooltip-button-physicalAction"
                aria-label={`More information about ${dashboardText.physicalActionTitle ?? 'Physical action video'}`}
                aria-expanded={openTooltipId === 'physicalAction'}
                onClick={(event) => {
                  event.stopPropagation();
                  emitRegionClick('tooltip-button-physicalAction', event, {
                    baseRegionId: 'tooltip-button',
                    regionLabel: 'tooltip button: physicalAction',
                    trackOnly: true,
                  });
                  setOpenTooltipId((value) => value === 'physicalAction' ? '' : 'physicalAction');
                }}
              >
                <img className="section-info-icon" src={assetUrl('img/button_icons/info.png')} alt="" aria-hidden="true" />
              </button>
              {openTooltipId === 'physicalAction' && (
                <span className="section-tooltip" role="tooltip" data-region-id="tooltip-physicalAction">
                  {sectionTooltips.physicalAction}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="physical-action-body">
          <div
            data-region-id="physical-world-video-region"
            className={`video-thumb clickable-region ${selectedRegionId === 'physical-world-video-region' ? 'selected-region' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              if (!hasControllerVideo) {
                emitRegionClick('physical-world-video-region', event);
                return;
              }
              setIsControllerVideoPlaying((value) => !value);
              emitRegionClick('physical-world-video-region', event);
            }}
            style={controllerThumbnail ? { backgroundImage: `linear-gradient(rgba(0,0,0,.25), rgba(0,0,0,.55)), url("${assetUrl(controllerThumbnail)}")` } : undefined}
          >
            {hasControllerVideo ? (
              <video
                ref={controllerVideoRef}
                className="study-video-media"
                src={assetUrl(controllerVideoUrl)}
                poster={assetUrl(controllerThumbnail)}
                muted
                loop
                playsInline
                controls={false}
                autoPlay={isControllerVideoPlaying}
                onLoadedMetadata={(event) => handleVideoProgress(event, setControllerVideoProgress)}
                onTimeUpdate={(event) => handleVideoProgress(event, setControllerVideoProgress)}
              />
            ) : (
              <div className="no-video-message">{dashboardText.noActionRequired ?? 'There is no action required for this object'}</div>
            )}
            {hasControllerVideo && (
              <div className="study-video-controls" aria-hidden="true">
                <span className="play-symbol">{isControllerVideoPlaying ? 'Ⅱ' : '▶'}</span>
                <span className="video-progress-track">
                  <span className="video-progress-fill" style={{ width: `${controllerVideoProgress}%` }} />
                </span>
              </div>
            )}
          </div>
          <div className="controller-action-row">
            <button
              {...actionProps('controller-send-button', `controller-send-button ${sentControllerVideo ? 'sent-button' : ''}`, !isCurrentTask || !hasControllerVideo)}
              onClick={(event) => {
                event.stopPropagation();
                if (!isCurrentTask || !hasControllerVideo) return;
                setSentControllerVideo(true);
                setHasActiveAnnotation(true);
                emitRegionClick('controller-send-button', event);
              }}
            >
              <img className="button-action-icon" src={assetUrl('img/button_icons/send.png')} alt="" aria-hidden="true" />
              <span>{dashboardText.send ?? 'Send'}</span>
            </button>
            <button
              {...actionProps('controller-clear-button', 'controller-clear-video-button')}
              onClick={(event) => {
                event.stopPropagation();
                setSentControllerVideo(false);
                if (!hasObjectAnnotation && !isFreehandActive) {
                  setHasActiveAnnotation(false);
                }
                emitRegionClick('controller-clear-button', event);
              }}
            >
              <img className="button-action-icon" src={assetUrl('img/button_icons/clear.png')} alt="" aria-hidden="true" />
              <span>{dashboardText.removeVideo ?? 'Clear video'}</span>
            </button>
          </div>
        </div>
      </section>
      <section
        data-region-id="controller-region"
        className="sim-region clickable-region"
        onClick={(event) => {
          event.stopPropagation();
          emitRegionClick('controller-region', event);
        }}
        aria-label="Current activity controller guidance"
      >
        <div className="controller-header">
          <span className="controller-title-text">{dashboardText.requiredControlsFor ?? 'Required controls for:'}</span>
          <select
            data-region-id="controller-object-selector"
              className="clickable-region"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onChange={handleObjectSelect}
              value={getObjectKey(selectedObject, 0)}
              aria-label="Object selector"
            >
              {(currentTask?.objects ?? []).map((object, index) => (
              <option key={getObjectKey(object, index)} value={getObjectKey(object, index)}>{object.label}</option>
            ))}
          </select>
          {sectionTooltips?.controller && (
            <span className="section-info-wrap controller-info-wrap">
              <button
                type="button"
                className="section-info-button"
                data-region-id="tooltip-button-controller"
                aria-label={`More information about ${dashboardText.requiredControlsFor ?? 'Required controls for:'}`}
                aria-expanded={openTooltipId === 'controller'}
                onClick={(event) => {
                  event.stopPropagation();
                  emitRegionClick('tooltip-button-controller', event, {
                    baseRegionId: 'tooltip-button',
                    regionLabel: 'tooltip button: controller',
                    trackOnly: true,
                  });
                  setOpenTooltipId((value) => value === 'controller' ? '' : 'controller');
                }}
              >
                <img className="section-info-icon" src={assetUrl('img/button_icons/info.png')} alt="" aria-hidden="true" />
              </button>
              {openTooltipId === 'controller' && (
                <span className="section-tooltip" role="tooltip" data-region-id="tooltip-controller">
                  {sectionTooltips.controller}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="controller-body">
          <div className={`controller-model ${selectedRegionId === 'controller-region' ? 'selected-region' : ''}`}>
            <Controller3DViewer
              side={controllerSide}
              modelPath={assetUrl(`models/meta_quest_${controllerSide}_controller.glb`)}
              requiredButtons={selectedControllerButtons}
            />
            {!selectedControllerButtons.length && (
              <span className="controller-button trigger">{controllerButtonLabel}</span>
            )}
          </div>
          <div
            data-region-id="controller-side-dropdown"
            className={`controller-side-toggle clickable-region ${selectedRegionId === 'controller-side-dropdown' ? 'selected-region' : ''}`}
            role="group"
            aria-label="Controller side selector"
            onClick={(event) => {
              event.stopPropagation();
              emitRegionClick('controller-side-dropdown', event);
            }}
          >
            <button
              type="button"
              className={`controller-side-switch ${controllerSide === 'right' ? 'right' : 'left'}`}
              aria-label={`Showing ${controllerSide === 'right' ? 'right' : 'left'} controller`}
              aria-pressed={controllerSide === 'right'}
              onClick={(event) => {
                event.stopPropagation();
                handleControllerSideSelect(event, controllerSide === 'right' ? 'left' : 'right');
              }}
            >
              <span className="controller-side-switch-knob" aria-hidden="true" />
            </button>
            <div className="controller-side-current" aria-hidden="true">
              {controllerSide === 'right' ? 'R' : 'L'}
            </div>
          </div>
        </div>
      </section>

      

      <section
        {...regionProps('in-world-video-region')}
        aria-label="Current activity demonstration video"
      >
        <SectionTitle tooltipId="demo">{dashboardText.demoTitle ?? 'Current activity demo'}</SectionTitle>
        <div
          data-region-id="in-world-video-region"
          className="demo-thumb clickable-region"
          onClick={(event) => {
            event.stopPropagation();
            setIsDemoVideoPlaying((value) => !value);
            emitRegionClick('in-world-video-region', event);
          }}
            style={demoThumbnail ? { backgroundImage: `linear-gradient(rgba(0,0,0,.18), rgba(0,0,0,.55)), url("${assetUrl(demoThumbnail)}")` } : undefined}
          >
          {demoVideoUrl && (
            <video
              ref={demoVideoRef}
              className="study-video-media"
              src={assetUrl(demoVideoUrl)}
              poster={assetUrl(demoThumbnail)}
              muted
              loop
              playsInline
              controls={false}
              autoPlay={isDemoVideoPlaying}
              onLoadedMetadata={(event) => handleVideoProgress(event, setDemoVideoProgress)}
              onTimeUpdate={(event) => handleVideoProgress(event, setDemoVideoProgress)}
            />
          )}
          {demoVideoUrl && (
            <div className="study-video-controls" aria-hidden="true">
              <span className="play-symbol">{isDemoVideoPlaying ? 'Ⅱ' : '▶'}</span>
              <span className="video-progress-track">
                <span className="video-progress-fill" style={{ width: `${demoVideoProgress}%` }} />
              </span>
            </div>
          )}
        </div>      </section>
      <section
        className={`sim-region dimmable-region ${
          selectedRegionId === 'drawing-button' || selectedRegionId === 'drawing-clear-button'
            ? 'contains-selected-region'
            : ''
        }`}
        aria-label="Annotation tools"
      >
        <div className="annotation-tools-stack">
          <button
            {...actionProps('drawing-button', `annotation-tool-button freehand ${isFreehandActive ? 'tool-active' : ''}`, !isCurrentTask)}
            onClick={(event) => {
              event.stopPropagation();
              if (!isCurrentTask) return;
              setIsFreehandActive((value) => !value);
              setHasActiveAnnotation(true);
              emitRegionClick('drawing-button', event);
            }}
          >
                        <img src={assetUrl('img/button_icons/freehand.png')} alt="" aria-hidden="true" />
            <span>{dashboardText.drawing ?? 'Drawing'}</span>
          </button>
          <button
            {...actionProps('drawing-clear-button', `annotation-tool-button clear ${hasActiveAnnotation ? 'clear-enabled' : ''}`)}
            onClick={(event) => {
              event.stopPropagation();
              setIsFreehandActive(false);
              setSentControllerVideo(false);
              clearFreehandCanvas();
              setVrViewImage(baseVrViewImage);
              setHasObjectAnnotation(false);
              setHasActiveAnnotation(false);
              emitRegionClick('drawing-clear-button', event);
            }}
          >
                       <img src={assetUrl('img/button_icons/clear.png')} alt="" aria-hidden="true" />
 <span>{dashboardText.clearDrawing ?? 'Clear'}</span>
          </button>
        </div>
      </section>
    </div>
    </div>
  );
}

function InlineAttentionCheckPage({ check, questionIndex, totalQuestions, onSubmit, uiText }) {
  const [answer, setAnswer] = useState('');
  const [clicks, setClicks] = useState([]);
  const clicksRef = useRef([]);
  const selectedOption = (check.options ?? []).find((option) => getOptionValue(option) === answer);
  const canSubmit = String(answer).trim().length > 0;

  function recordInlineClick(elementName, event) {
    const click = createScreenClickRecord(elementName, event);
    clicksRef.current = [...clicksRef.current, click];
    setClicks(clicksRef.current);
  }

  return (
    <main className="study-interaction-page attention-inline-page" data-region-id="attention-check-screen">
      <header className="question-bar attention-inline-card" data-region-id="attention-check-question-panel">
        <div>
          <p className="eyebrow" data-region-id="attention-check-progress">{formatTextTemplate(uiText?.question?.progressTemplate ?? 'Question {current} of {total}', { current: questionIndex + 1, total: totalQuestions })}</p>
          <h1 data-region-id="attention-check-prompt">{check.prompt}</h1>
          {check.type === 'open_text' && (
            <p className="selection-feedback" data-region-id="attention-check-open-text-instruction">
{uiText?.inlineAttention?.openTextHelp ?? 'Answer in one or two sentences. This response helps us check whether the instruction was understood.'}
            </p>
          )}
        </div>
        <button className="next-button" type="button" data-region-id="attention_check_next_button" disabled={!canSubmit} onClick={(event) => {
          recordInlineClick('attention_check_next_button', event);
          const finalClicks = clicksRef.current;
          onSubmit(answer, selectedOption ? getOptionLabel(selectedOption) : answer, finalClicks);
        }}>
          {uiText?.question?.nextButton ?? 'Next'}
        </button>
      </header>
      <section className="study-card inline-check-panel" data-region-id="attention-check-answer-panel">
        {check.type === 'multiple_choice' ? (
          <div className="choice-grid" data-region-id="attention-check-choice-list">
            {(check.options ?? []).map((option) => {
              const optionValue = getOptionValue(option);
              const optionLabel = getOptionLabel(option);
              return (
                <button
                  key={optionValue}
                  className={'choice-button ' + (answer === optionValue ? 'selected' : '')}
                  type="button"
                  data-region-id={`attention_check_option_${optionLabel}`}
                  onClick={(event) => {
                    recordInlineClick(`attention_check_option_${optionLabel}`, event);
                    setAnswer(optionValue);
                  }}
                >
                  {optionLabel}
                </button>
              );
            })}
          </div>
        ) : (
          <label className="text-answer open-text-answer" data-region-id="attention-check-text-answer-wrap">
            <span>{uiText?.inlineAttention?.answerLabel ?? 'Your answer'}</span>
            <textarea
              data-region-id="attention_check_text_answer"
              value={answer}
              onChange={(event) => {
                if (!answer) {
                  recordInlineClick('attention_check_text_answer', event);
                }
                setAnswer(event.target.value);
              }}
              rows={7}
              placeholder={uiText?.inlineAttention?.answerPlaceholder ?? 'Type your answer here'}
            />
          </label>
        )}
      </section>

    </main>
  );
}
function MainQuestionPage({ question, questionIndex, totalQuestions, selectedRegionId, onRegionClick, onNext, metadata, uiText }) {
  const selectedLabel = selectedRegionId ? getRegionFeedbackLabel(selectedRegionId, uiText) : '';

  return (
    <main className="study-interaction-page" data-region-id="question-screen">
      <header className="question-bar" data-region-id="question-panel">
        <div data-region-id="question-text-area">
          <p className="eyebrow" data-region-id="question-progress">{formatTextTemplate(uiText?.question?.progressTemplate ?? 'Question {current} of {total}', { current: questionIndex + 1, total: totalQuestions })}</p>
          {question.scenario_text ? (
            <p className="scenario-context" data-region-id="question-scenario-text">{question.scenario_text}</p>
          ) : null}
          <h1 data-region-id="question-prompt">{question.prompt}</h1>
          <p className={`selection-feedback ${selectedRegionId ? 'has-selection' : ''}`} data-region-id="question-selection-feedback">
            {selectedRegionId ? (
              <>
{formatTextTemplate(uiText?.question?.selectedTemplate ?? 'You have selected {label}, highlighted in yellow.', { label: selectedLabel })}
              </>
            ) : (
              uiText?.question?.noSelection ?? 'Select one region, button, dropdown, or video in the tablet below.'
            )}
          </p>
        </div>
        <button className="next-button" type="button" data-region-id="question_next_button" disabled={!selectedRegionId} onClick={onNext}>
          {uiText?.question?.nextButton ?? 'Next'}
        </button>
      </header>
      <div className="tablet-stage" data-region-id="tablet-stage">
        <SimulatedDashboard
          selectedRegionId={selectedRegionId}
          onRegionClick={onRegionClick}
          screenVariant={question.screen_variant}
          metadata={metadata}
          resetKey={question.question_id}
          uiText={uiText}
          scenarioConfig={question}
        />
      </div>
    </main>
  );
}

function CompletionPage({
  uiText,
  completionCode,
  qualtricsUrl,
  externalSubmitUrl,
  participantParams,
  sessionId,
  metricsSaveStatus,
  metricsSaveError,
  onRetrySave,
  onSubmitCompletionCode,
  onInteraction,
  debugMode = false,
}) {
  const [enteredCode, setEnteredCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const normalizedEnteredCode = enteredCode.trim().toUpperCase();
  const normalizedCompletionCode = String(completionCode || '').trim().toUpperCase();
  const canSubmitHit = metricsSaveStatus === 'saved'
    && Boolean(externalSubmitUrl)
    && Boolean(normalizedCompletionCode)
    && Boolean(normalizedEnteredCode);

  async function handleSubmitHit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitClick = createScreenClickRecord('completion_code_submit_button', event);
    onInteraction?.({
      type: 'completion_click',
      ...submitClick,
    });
    if (!canSubmitHit || normalizedEnteredCode !== normalizedCompletionCode) {
      setCodeError(uiText?.completion?.codeMismatch ?? 'The code does not match. Please copy the code exactly from Qualtrics.');
      return;
    }
    setCodeError('');
    try {
      await onSubmitCompletionCode?.(enteredCode, submitClick);
    } catch (error) {
      setCodeError(uiText?.completion?.saveFailed ?? 'Responses could not be saved. Please retry before continuing.');
      return;
    }

    try {
      HTMLFormElement.prototype.submit.call(form);
    } catch (error) {
      setCodeError(uiText?.completion?.submitFailed ?? 'Responses were saved, but the MTurk submission failed. Please retry submitting the HIT.');
    }
  }

  return (
    <main className="page-shell" data-region-id="completion-screen">
      <section className="study-card completion-card" data-region-id="completion-card">
        <h1 data-region-id="completion-title">{uiText?.completion?.title ?? 'Please continue to the survey.'}</h1>
        {debugMode && <p className="debug-mode-banner" data-region-id="completion-debug-banner">Debug mode is enabled. MTurk code validation is bypassed.</p>}
        <p data-region-id="completion-save-instruction">{uiText?.completion?.saveBeforeSubmit ?? 'Your study responses must be saved before you can submit this HIT.'}</p>
        {!debugMode && <p data-region-id="completion-keep-open-instruction">{uiText?.completion?.keepOpen ?? 'Keep this page open. The survey opens in a new tab.'}</p>}
        <div className="completion-actions" data-region-id="completion-actions">
          {(metricsSaveStatus === 'idle' || metricsSaveStatus === 'saving') && (
            <button className="primary-action" type="button" data-region-id="completion_saving_button" disabled>
              {uiText?.completion?.saving ?? 'Saving responses...'}
            </button>
          )}
          {metricsSaveStatus === 'failed' && (
            <>
              <p className="save-error" data-region-id="completion-error-message">{uiText?.completion?.saveFailed ?? 'Responses could not be saved. Please retry before continuing.'}</p>
              <button className="primary-action" type="button" onClick={(event) => {
                onInteraction?.({
                  type: 'completion_click',
                  ...createScreenClickRecord('completion_retry_save_button', event),
                });
                onRetrySave();
              }} data-region-id="completion_retry_save_button">
                {uiText?.completion?.retrySaving ?? 'Retry saving responses'}
              </button>
            </>
          )}
          {metricsSaveStatus === 'saved' && qualtricsUrl && (
            <a
              className="primary-action link-action"
              href={qualtricsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                onInteraction?.({
                  type: 'completion_click',
                  ...createScreenClickRecord('completion_open_exit_survey_link', event),
                });
              }}
              data-region-id="completion_open_exit_survey_link"
            >
              {uiText?.completion?.openSurvey ?? 'Open survey'}
            </a>
          )}
          {metricsSaveStatus === 'saved' && !qualtricsUrl && (
            <button className="primary-action" type="button" data-region-id="completion_qualtrics_missing_button" disabled>
              {uiText?.completion?.qualtricsMissing ?? 'Qualtrics URL not configured'}
            </button>
          )}
        </div>
        {metricsSaveStatus === 'saved' && !debugMode && (
          <form className="mturk-submit-form" method="post" action={externalSubmitUrl} onSubmit={handleSubmitHit} data-region-id="completion-code-form">
            <input type="hidden" name="assignmentId" value={participantParams?.assignmentId || ''} />
            <input type="hidden" name="completion_code" value={completionCode || ''} />
            <input type="hidden" name="session_id" value={sessionId || ''} />
            <input type="hidden" name="study_worker_id" value={participantParams?.workerId || ''} />
            <input type="hidden" name="study_hit_id" value={participantParams?.hitId || ''} />
            <label className="completion-code-entry" data-region-id="completion-code-input-wrap">
              <span>{uiText?.completion?.codeLabel ?? 'Completion code from Qualtrics'}</span>
              <input
                data-region-id="completion_code_input"
                value={enteredCode}
                onChange={(event) => {
                  if (!enteredCode) {
                    onInteraction?.({
                      type: 'completion_click',
                      ...createScreenClickRecord('completion_code_input', event),
                    });
                  }
                  setEnteredCode(event.target.value);
                  setCodeError('');
                }}
                placeholder={uiText?.completion?.codePlaceholder ?? 'Paste the code shown at the end of Qualtrics'}
                autoComplete="off"
              />
            </label>
            <button className="primary-action" type="submit" data-region-id="completion_code_submit_button" disabled={!canSubmitHit}>
              {uiText?.completion?.submitHit ?? 'Submit HIT'}
            </button>
            {!externalSubmitUrl && (
              <p className="save-error" data-region-id="completion-error-message">{uiText?.completion?.missingSubmitUrl ?? 'MTurk submit URL is missing. Please open this study from the MTurk page.'}</p>
            )}
            {codeError && <p className="save-error" data-region-id="completion-error-message">{codeError}</p>}
          </form>
        )}
        {metricsSaveError && <p className="save-error-detail" data-region-id="completion-save-error-detail">{metricsSaveError}</p>}
      </section>
    </main>
  );
}

function ThankYouPage({ uiText }) {
  return (
    <main className="page-shell" data-region-id="thank-you-screen">
      <section className="study-card completion-card" data-region-id="thank-you-card">
        <h1 data-region-id="thank-you-title">{uiText?.thankYou?.title ?? 'Thank you for your time.'}</h1>
        <p data-region-id="thank-you-body">{uiText?.thankYou?.body ?? 'The study has ended. You may close this page.'}</p>
      </section>
    </main>
  );
}

function MturkRequiredPage({ uiText }) {
  return (
    <main className="page-shell" data-region-id="mturk-required-screen">
      <section className="study-card completion-card" data-region-id="mturk-required-card">
        <h1 data-region-id="mturk-required-title">{uiText?.access?.mturkRequiredTitle ?? 'Please open this study from the MTurk page.'}</h1>
        <p data-region-id="mturk-required-body">{uiText?.access?.mturkRequiredBody ?? 'This study requires a valid MTurk worker ID, assignment ID, and HIT ID. Please return to MTurk and use the survey link shown inside the HIT.'}</p>
      </section>
    </main>
  );
}

function MturkPreviewPage({ uiText }) {
  return (
    <main className="page-shell" data-region-id="mturk-preview-screen">
      <section className="study-card completion-card" data-region-id="mturk-preview-card">
        <h1 data-region-id="mturk-preview-title">{uiText?.access?.mturkPreviewTitle ?? 'Please accept the study before starting the study.'}</h1>
        <p data-region-id="mturk-preview-body">{uiText?.access?.mturkPreviewBody ?? 'You are currently previewing this HIT. After you accept it on MTurk, this study will open with your assignment information and you can begin.'}</p>
      </section>
    </main>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [attentionChecks, setAttentionChecks] = useState([]);
  const [metadata, setMetadata] = useState(null);
  const [uiText, setUiText] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [phase, setPhase] = useState('loading');
  const [session, setSession] = useState(null);
  const [flowIndex, setFlowIndex] = useState(0);
  const [selectedRegionId, setSelectedRegionId] = useState('');
  const [selectedRegionMeta, setSelectedRegionMeta] = useState({ base_region_id: '', region_label: '' });
  const [currentQuestionStartedAt, setCurrentQuestionStartedAt] = useState('');
  const [firstClick, setFirstClick] = useState(null);
  const [currentQuestionClicks, setCurrentQuestionClicks] = useState([]);
  const currentQuestionClicksRef = useRef([]);
  const currentQuestionLayoutRef = useRef(null);
  const savedSessionIdRef = useRef('');
  const phaseStartedAtRef = useRef('');
  const [metricsSaveStatus, setMetricsSaveStatus] = useState('idle');
  const [metricsSaveError, setMetricsSaveError] = useState('');
  const [backendCompletionCode, setBackendCompletionCode] = useState('');
  const [backendQualtricsUrl, setBackendQualtricsUrl] = useState('');

  useEffect(() => {
    Promise.all([
      fetch(assetUrl('study-config.json')).then((response) => response.json()),
      fetch(assetUrl('scenario-questions.json')).then((response) => response.json()),
      fetch(assetUrl('attention-checks.json')).then((response) => response.json()),
      fetch(assetUrl('task_metadata.json')).then((response) => response.json()),
      fetch(assetUrl('ui-text.json')).then((response) => response.json()),
    ])
      .then(([loadedConfig, loadedQuestions, loadedAttentionChecks, loadedMetadata, loadedUiText]) => {
        const participantParams = getParticipantParams(loadedConfig);
        const shouldRequireMturkParams = loadedConfig.requireMturkParams && !loadedConfig.debugMode;
        if (shouldRequireMturkParams && isMturkPreview(participantParams)) {
          setConfig(loadedConfig);
          setQuestions(loadedQuestions);
          setAttentionChecks(loadedAttentionChecks);
          setMetadata(loadedMetadata);
          setUiText(loadedUiText);
          setPhase('mturk_preview');
          return;
        }
        if (shouldRequireMturkParams && !hasRequiredMturkParams(participantParams)) {
          setConfig(loadedConfig);
          setQuestions(loadedQuestions);
          setAttentionChecks(loadedAttentionChecks);
          setMetadata(loadedMetadata);
          setUiText(loadedUiText);
          setPhase('mturk_required');
          return;
        }
        setConfig(loadedConfig);
        setQuestions(loadedQuestions);
        setAttentionChecks(loadedAttentionChecks);
        setMetadata(loadedMetadata);
        setUiText(loadedUiText);
        setPhase('consent');
      })
      .catch((error) => {
        setLoadError(error.message);
        setPhase('error');
      });
  }, []);

  const flow = useMemo(
    () => buildQuestionFlow(questions, attentionChecks, session?.session_id),
    [questions, attentionChecks, session?.session_id],
  );

  const currentFlowItem = flow[flowIndex];
  const totalQuestionCount = flow.length;
  const displayedQuestionIndex = flowIndex;

  useEffect(() => {
    phaseStartedAtRef.current = getIsoTimestamp();
  }, [phase]);

  useEffect(() => {
    if (phase !== 'main') return;
    setCurrentQuestionStartedAt(getIsoTimestamp());
    setSelectedRegionId('');
    setSelectedRegionMeta({ base_region_id: '', region_label: '' });
    setFirstClick(null);
    setCurrentQuestionClicks([]);
    currentQuestionClicksRef.current = [];
    currentQuestionLayoutRef.current = null;
  }, [phase, flowIndex]);

  useEffect(() => {
    if (!session) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, [session]);

  function createBaseSession(completionStatus = 'in_progress') {
    const participantParams = getParticipantParams(config);
    const sessionId = createSessionId();
    return {
      session_id: sessionId,
      participant_params: participantParams,
      consent_version: CONSENT_VERSION,
      started_at: getIsoTimestamp(),
      ended_at: completionStatus === 'in_progress' ? '' : getIsoTimestamp(),
      completion_status: completionStatus,
      attention_passed: null,
      responses: [],
      attention_checks: [],
      timing: {},
      events: [
        { type: 'session_started', timestamp: getIsoTimestamp(), participant_params: participantParams },
      ],
    };
  }

  function acceptConsent(event) {
    const now = getIsoTimestamp();
    const click = createScreenClickRecord('informed_consent_accept_button', event, { timestamp: now });
    const baseSession = createBaseSession();
    setSession({
      ...baseSession,
      events: [
        ...baseSession.events,
        { type: 'consent_accepted', ...click },
      ],
      timing: {
        ...baseSession.timing,
        informed_consent_started_at: phaseStartedAtRef.current || baseSession.started_at,
        informed_consent_ended_at: now,
        introduction_started_at: now,
      },
    });
    setPhase('intro');
  }

  function declineConsent(event) {
    const now = getIsoTimestamp();
    const click = createScreenClickRecord('informed_consent_decline_button', event, { timestamp: now });
    const baseSession = createBaseSession('consent_declined');
    setSession({
      ...baseSession,
      attention_passed: false,
      events: [
        ...baseSession.events,
        { type: 'consent_declined', ...click },
      ],
      timing: {
        ...baseSession.timing,
        informed_consent_started_at: phaseStartedAtRef.current || baseSession.started_at,
        informed_consent_ended_at: now,
      },
    });
    setPhase('ended');
  }

  function startQuestions() {
    const now = getIsoTimestamp();
    setSession((previous) => ({
      ...previous,
      events: [
        ...previous.events,
        { type: 'introduction_continued', timestamp: now },
      ],
      timing: {
        ...previous.timing,
        introduction_ended_at: now,
        attention_checks_started_at: now,
        actual_study_started_at: now,
      },
    }));
    setFlowIndex(0);
    setPhase('main');
  }

  function recordEvent(event) {
    setSession((previous) => ({
      ...previous,
      events: [...previous.events, { timestamp: getIsoTimestamp(), ...event }],
    }));
  }

  function handleRegionClick(regionId, event, details = {}) {
    const timestamp = getIsoTimestamp();
    const baseRegionId = details.baseRegionId || regionId;
    const regionLabel = details.regionLabel || getRegionFeedbackLabel(regionId, uiText);
    const shouldSelect = !details.trackOnly;
    if (details.layoutSnapshot && !currentQuestionLayoutRef.current) {
      currentQuestionLayoutRef.current = details.layoutSnapshot;
    }
    if (!firstClick) {
      setFirstClick({
        region_id: regionId,
        base_region_id: baseRegionId,
        region_label: regionLabel,
        timestamp,
        client_x: details.client_x ?? '',
        client_y: details.client_y ?? '',
        dashboard_x: details.dashboard_x ?? '',
        dashboard_y: details.dashboard_y ?? '',
      });
    }
    const clickRecord = {
      element_clicked: regionId,
      region_id: regionId,
      base_region_id: baseRegionId,
      region_label: regionLabel,
      timestamp,
      client_x: details.client_x ?? '',
      client_y: details.client_y ?? '',
      dashboard_x: details.dashboard_x ?? details.x ?? '',
      dashboard_y: details.dashboard_y ?? details.y ?? '',
      viewport_width: details.viewport_width ?? '',
      viewport_height: details.viewport_height ?? '',
      track_only: Boolean(details.trackOnly),
    };
    currentQuestionClicksRef.current = [...currentQuestionClicksRef.current, clickRecord];
    setCurrentQuestionClicks(currentQuestionClicksRef.current);
    if (shouldSelect) {
      setSelectedRegionId(regionId);
      setSelectedRegionMeta({ base_region_id: baseRegionId, region_label: regionLabel });
    }
    recordEvent({
      type: 'dashboard_region_clicked',
      question_id: currentFlowItem?.item?.question_id || currentFlowItem?.item?.check_id,
      question_type: currentFlowItem?.type,
      scenario_id: currentFlowItem?.item?.scenario_id || '',
      region_id: regionId,
      base_region_id: baseRegionId,
      region_label: regionLabel,
      track_only: Boolean(details.trackOnly),
    });
  }

  function continueFlow() {
    if (flowIndex + 1 >= flow.length) {
      finishStudy('completed');
      return;
    }

    setFlowIndex((index) => index + 1);
  }

  function applyAttentionResult(previous, result) {
    const nextAttentionChecks = [...previous.attention_checks, result];
    const failureCount = nextAttentionChecks.filter((check) => check.is_correct === false).length;
    return {
      nextAttentionChecks,
      failureCount,
      attentionPassed: failureCount === 0,
    };
  }

  function handleMainNext(event) {
    const question = currentFlowItem.item;
    const answeredAt = getIsoTimestamp();
    const nextClickSnapshot = createScreenClickRecord('question_next_button', event);
    const nextClick = {
      element_clicked: 'question_next_button',
      region_id: 'question_next_button',
      base_region_id: 'question_next_button',
      region_label: 'Question Next button',
      timestamp: answeredAt,
      client_x: nextClickSnapshot.client_x,
      client_y: nextClickSnapshot.client_y,
      dashboard_x: nextClickSnapshot.dashboard_x,
      dashboard_y: nextClickSnapshot.dashboard_y,
      track_only: true,
    };
    const finalQuestionClicks = [...currentQuestionClicksRef.current, nextClick];
    currentQuestionClicksRef.current = finalQuestionClicks;
    setCurrentQuestionClicks(finalQuestionClicks);
    const correctAnswers = question.correct_answers ?? [];
    const isCorrect = isCorrectRegionSelection(selectedRegionId, correctAnswers, selectedRegionMeta.base_region_id);

    setSession((previous) => {
      const response = {
        question_id: question.question_id,
        scenario_id: question.scenario_id || '',
        scenario_text: question.scenario_text || '',
        scenario_order_index: question.scenario_order_index || '',
        scenario_question_index: question.scenario_question_index || '',
        task_id: question.task_id || '',
        task_order: question.task_order || '',
        prompt: question.prompt,
        correct_answers: correctAnswers,
        selected_region_id: selectedRegionId,
        selected_base_region_id: selectedRegionMeta.base_region_id,
        selected_region_label: selectedRegionMeta.region_label,
        first_click_region_id: firstClick?.region_id ?? '',
        first_click_base_region_id: firstClick?.base_region_id ?? '',
        first_click_region_label: firstClick?.region_label ?? '',
        first_click_timestamp: firstClick?.timestamp ?? '',
        final_click_timestamp: answeredAt,
        question_started_at: currentQuestionStartedAt,
        response_time_ms: Date.parse(answeredAt) - Date.parse(currentQuestionStartedAt),
        clicks: finalQuestionClicks,
        layout_snapshot: currentQuestionLayoutRef.current || nextClickSnapshot.layout_snapshot,
        is_correct: isCorrect,
        screen_variant: question.screen_variant,
        question_type: question.question_type,
        is_attention_check: Boolean(question.is_attention_check),
      };
      const event = {
        type: question.is_attention_check ? 'attention_dashboard_question_answered' : 'main_question_answered',
        timestamp: answeredAt,
        question_id: question.question_id,
        scenario_id: question.scenario_id || '',
        selected_region_id: selectedRegionId,
        is_correct: isCorrect,
      };

      if (!question.is_attention_check) {
        return {
          ...previous,
          responses: [...previous.responses, response],
          events: [...previous.events, event],
        };
      }

      const attentionResult = {
        check_id: question.check_id || question.question_id,
        prompt: question.prompt,
        type: question.question_type,
        answer: selectedRegionId,
        answer_base_region_id: selectedRegionMeta.base_region_id,
        answer_label: selectedRegionMeta.region_label,
        correct_answer: correctAnswers.join('|'),
        is_correct: isCorrect,
        started_at: currentQuestionStartedAt,
        ended_at: answeredAt,
        clicks: finalQuestionClicks,
        layout_snapshot: currentQuestionLayoutRef.current || nextClickSnapshot.layout_snapshot,
      };
      const { nextAttentionChecks, failureCount, attentionPassed } = applyAttentionResult(previous, attentionResult);
      return {
        ...previous,
        attention_failure_count: failureCount,
        attention_checks: nextAttentionChecks,
        attention_passed: attentionPassed,
        events: [
          ...previous.events,
          event,
        ],
      };
    });

    continueFlow();
  }

  function handleInlineAttentionSubmit(answer, answerLabel = answer, clicks = []) {
    const check = currentFlowItem.item;
    const answeredAt = getIsoTimestamp();
    const isCorrect = isAttentionCheckCorrect(check, answer);

    setSession((previous) => {
      const attentionResult = {
        check_id: check.check_id,
        prompt: check.prompt,
        type: check.type,
        answer,
        answer_label: answerLabel,
        correct_answer: check.correct_answer || '',
        is_correct: isCorrect,
        requires_manual_review: Boolean(check.requires_manual_review),
        started_at: currentQuestionStartedAt,
        ended_at: answeredAt,
        clicks,
      };
      const { nextAttentionChecks, failureCount, attentionPassed } = applyAttentionResult(previous, attentionResult);
      return {
        ...previous,
        attention_failure_count: failureCount,
        attention_checks: nextAttentionChecks,
        attention_passed: attentionPassed,
        events: [
          ...previous.events,
          {
            type: 'inline_attention_check_answered',
            timestamp: answeredAt,
            check_id: check.check_id,
            answer,
            answer_label: answerLabel,
            is_correct: isCorrect,
          },
        ],
      };
    });

    continueFlow();
  }

  function finishStudy(status) {
    const endedAt = getIsoTimestamp();
    setSession((previous) => ({
      ...previous,
      ended_at: endedAt,
      completion_status: status,
      attention_passed: previous.attention_passed ?? true,
      timing: {
        ...previous.timing,
        attention_checks_ended_at: previous.timing.attention_checks_ended_at || endedAt,
        actual_study_ended_at: endedAt,
      },
      events: [
        ...previous.events,
        { type: 'session_finished', timestamp: endedAt, completion_status: status },
      ],
    }));
    setPhase('complete');
  }

  const sessionPayload = useMemo(() => {
    if (!session || !config) return null;
    return buildMetricsPayload(session, config);
  }, [config, session]);

  function retrySaveMetrics() {
    savedSessionIdRef.current = '';
    setMetricsSaveStatus('idle');
    setMetricsSaveError('');
    setBackendCompletionCode('');
    setBackendQualtricsUrl('');
  }

  async function saveCompletionSubmit(enteredCode, submitClick = null) {
    if (!session || !config) return;
    const submittedAt = getIsoTimestamp();
    const completionStartedAt = session.timing?.completion_started_at || session.ended_at || submittedAt;
    const existingEvents = session.events ?? [];
    const hasSubmitClick = existingEvents.some((event) => (
      event.type === 'completion_click'
      && event.element_clicked === 'completion_code_submit_button'
    ));
    const updatedSession = {
      ...session,
      completion_entered_code: enteredCode,
      completion_submitted_at: submittedAt,
      timing: {
        ...session.timing,
        completion_started_at: completionStartedAt,
        completion_submitted_at: submittedAt,
        completion_duration_ms: durationMs(completionStartedAt, submittedAt),
      },
      events: [
        ...existingEvents,
        ...(submitClick && !hasSubmitClick
          ? [{
              type: 'completion_click',
              ...submitClick,
              timestamp: submitClick.timestamp || submittedAt,
            }]
          : []),
        {
          type: 'completion_code_submitted',
          timestamp: submittedAt,
          element_clicked: 'completion_code_submit_button',
          entered_code: enteredCode,
        },
      ],
    };
    const updatedPayload = buildMetricsPayload(updatedSession, {
      ...config,
      completionCodePrefix: config?.completionCodePrefix ?? 'VRHELP',
    });
    updatedPayload.completion_code = backendCompletionCode || session.completion_code || updatedPayload.completion_code;
    await saveSessionMetrics(updatedPayload, config?.metricsApiBaseUrl);
    setSession(updatedSession);
  }

  useEffect(() => {
    if (!sessionPayload) return;
    if (sessionPayload.completion_status === 'in_progress') return;
    const saveKey = sessionPayload.session_id + ':' + sessionPayload.completion_status;
    if (savedSessionIdRef.current === saveKey) return;

    let cancelled = false;
    savedSessionIdRef.current = saveKey;
    setMetricsSaveStatus('saving');
    setMetricsSaveError('');

    saveSessionMetrics(sessionPayload, config?.metricsApiBaseUrl)
      .then((result) => {
        if (cancelled) return;
        const returnedCode = result.completion_code || '';
        const returnedQualtricsUrl = returnedCode
          ? makeQualtricsUrl(config, sessionPayload, returnedCode, sessionPayload.session_id)
          : '';
        setBackendCompletionCode(returnedCode);
        setBackendQualtricsUrl(returnedQualtricsUrl);
        setMetricsSaveStatus('saved');
        if (config?.debugMode && returnedQualtricsUrl) {
          window.location.assign(returnedQualtricsUrl);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Unable to save MTurk session metrics', error);
        savedSessionIdRef.current = '';
        setMetricsSaveStatus('failed');
        setMetricsSaveError(error.message || 'Unknown save error');
      });

    return () => {
      cancelled = true;
    };
  }, [config, config?.metricsApiBaseUrl, sessionPayload]);

  if (phase === 'loading') {
    return <main className="page-shell"><section className="study-card">{uiText?.access?.loading ?? 'Loading study...'}</section></main>;
  }

  if (phase === 'error') {
    return (
      <main className="page-shell">
        <section className="study-card">
          <h1>{uiText?.access?.loadErrorTitle ?? 'Study could not load'}</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (phase === 'mturk_required') {
    return <MturkRequiredPage uiText={uiText} />;
  }

  if (phase === 'mturk_preview') {
    return <MturkPreviewPage uiText={uiText} />;
  }

  if (phase === 'consent') return <LandingPage onAccept={acceptConsent} onDecline={declineConsent} uiText={uiText} />;
  if (phase === 'intro') return <IntroPage onNext={startQuestions} onInteraction={recordEvent} uiText={uiText} />;

  if (phase === 'main' && currentFlowItem?.type === 'attention_check') {
    return (
      <InlineAttentionCheckPage
        check={currentFlowItem.item}
        questionIndex={displayedQuestionIndex}
        totalQuestions={totalQuestionCount}
        onSubmit={handleInlineAttentionSubmit}
        uiText={uiText}
      />
    );
  }

  if (phase === 'main' && currentFlowItem?.type === 'dashboard') {
    return (
      <MainQuestionPage
        question={currentFlowItem.item}
        questionIndex={displayedQuestionIndex}
        totalQuestions={totalQuestionCount}
        selectedRegionId={selectedRegionId}
        onRegionClick={handleRegionClick}
        onNext={handleMainNext}
        metadata={metadata}
        uiText={uiText}
      />
    );
  }

  if (phase === 'ended') {
    return <ThankYouPage uiText={uiText} />;
  }

  if (phase === 'complete') {
    return (
      <CompletionPage
        uiText={uiText}
        completionCode={backendCompletionCode}
        qualtricsUrl={backendQualtricsUrl}
        externalSubmitUrl={makeExternalSubmitUrl(session?.participant_params?.turkSubmitTo)}
        participantParams={session?.participant_params}
        sessionId={session?.session_id}
        metricsSaveStatus={metricsSaveStatus}
        metricsSaveError={metricsSaveError}
        onRetrySave={retrySaveMetrics}
        onSubmitCompletionCode={saveCompletionSubmit}
        onInteraction={recordEvent}
        debugMode={Boolean(config?.debugMode)}
      />
    );
  }

  return null;
}
