import React, { useEffect, useMemo, useRef, useState } from 'react';
import Controller3DViewer from './controllers/Controller3DViewer';
import './controllers/Controller3DViewer.css';

const STORAGE_KEY = 'vr-helper-mturk-study-session';
const CONSENT_VERSION = '2026-07-06';
const FALLBACK_AUDIO_PATH = 'audio/task-16.mp3';
const AVAILABLE_AUDIO_TASKS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16]);
const FIXED_VR_VIEW_IMAGE = 'img/VR_user_current_view_screenshots/task-18-no-annotation.png';

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

function isMturkPreview(participantParams) {
  return participantParams?.assignmentId === 'ASSIGNMENT_ID_NOT_AVAILABLE';
}

function normalizeAnswer(value) {
  return String(value ?? '').trim().toLowerCase();
}

function buildQuestionFlow(questions) {
  return [...questions]
    .sort((a, b) => a.order - b.order)
    .map((question) => ({ type: 'main', id: question.question_id, item: question }));
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
    timestamp: click.timestamp || '',
  };
}

function buildMetricsPayload(session, config) {
  const participantParams = session.participant_params ?? {};
  const timing = session.timing ?? {};
  const attentionChecks = session.attention_checks ?? [];
  const mainQuestions = (session.responses ?? []).map((response) => ({
    question_asked_id: response.question_id,
    all_regions_clicked_with_timestamp: (response.clicks ?? []).map(compactClick),
    final_answer_selected: response.selected_region_id,
    is_correct: response.is_correct,
    total_time_taken_to_answer_ms: response.response_time_ms,
  }));

  return {
    session_id: session.session_id,
    participant_id: participantParams.participant_id || participantParams.workerId || session.session_id,
    workerId: participantParams.workerId || '',
    assignmentId: participantParams.assignmentId || '',
    hitId: participantParams.hitId || '',
    turkSubmitTo: participantParams.turkSubmitTo || '',
    completion_status: session.completion_status,
    attention_passed: session.attention_passed,
    completion_code: session.completion_code || '',
    completion_code_prefix: config?.completionCodePrefix ?? 'VRHELP',
    qualtrics_redirect_url: session.qualtrics_redirect_url || '',
    study_name: config?.studyName ?? '',
    generated_at: getIsoTimestamp(),
    attention_checks: attentionChecks.map((check) => ({
      attention_question_id: check.check_id,
      answer: check.answer,
      is_correct: check.is_correct,
      started_at: check.started_at,
      ended_at: check.ended_at,
    })),
    timing: {
      informed_consent_duration_ms: durationMs(timing.informed_consent_started_at, timing.informed_consent_ended_at),
      attention_checks_total_duration_ms: durationMs(timing.attention_checks_started_at, timing.attention_checks_ended_at),
      introduction_duration_ms: durationMs(timing.introduction_started_at, timing.introduction_ended_at),
      actual_study_total_duration_ms: durationMs(timing.actual_study_started_at, timing.actual_study_ended_at),
    },
    main_questions: mainQuestions,
  };
}

function LandingPage({ onAccept, onDecline }) {
  return (
    <main className="page-shell">
      <section className="study-card consent-card">
        <h1>Informed Consent</h1>
        <div className="consent-box consent-full-text">
          <p><strong>STUDY TITLE</strong></p>
          <p>Evaluating the understandability of an assistance tool for virtual reality application</p>

          <p><strong>PRINCIPAL INVESTIGATOR</strong></p>
          <p>Krishna Kumar Venkatasubramanian, Ph.D.</p>
          <p>Office: (401) 874-2701</p>
          <p>Email: krish@uri.edu</p>

          <p><strong>STUDENT INVESTIGATORS</strong></p>
          <p>Piriyankan Kirupaharan</p>
          <p>Email: pkirupaharan@uri.edu</p>

          <p><strong>OTHER INVESTIGATORS</strong></p>
          <p>Tina-Marie Ranalli</p>
          <p>tinamarie.ranalli@uri.edu</p>

          <p><strong>KEY INFORMATION</strong></p>

          <p>Important information to know about this research study:</p>

          <ul>
            <li>The purpose of this study is to evaluate whether untrained first-time users can correctly identify the appropriate assistance features in the assistance tool, and to measure how efficiently they can do so</li>
            <li>If you choose to participate, you will interact with a web application designed to help a person using virtual reality application. You will then be asked a few questions about your experience. This will take about 20 minutes.</li>
            <li>Risks or discomfort from this research are expected to be minimal.</li>
            <li>The study will have no direct benefits to you.</li>
            <li>You will be paid $4 for your participation.</li>
            <li>Taking part in this research project is voluntary. You do not have to participate, and you can stop at any time.</li>
          </ul>

          <p><strong>INVITATION</strong></p>

          <p>You are invited to take part in this research study. The information in this form is meant to help you decide whether or not to participate. If you have any questions, please ask.</p>

          <p><strong>Why are you being asked to be in this research study?</strong></p>

          <p>You are being asked to be in this study in order to evaluate understandability of an assistance tool. In order to participate you must at least 18 years old.</p>

          <p><strong>What is the reason for doing this research study?</strong></p>

          <p>The goal of this study is to evaluate the understandability of an assistance tool for virtual reality application.</p>
          <p>This study focuses on whether first-time users can identify the correct assistance feature in the assistance tool when asked what assistance they would provide.</p>

          <p><strong>What will be done during this research study?</strong></p>

          <p>If you agree to participate, you will first read a brief introduction explaining the purpose of the study and your role. You will then complete several attention check questions. These questions are included to ensure that participants are carefully reading the study materials. If you pass the attention checks, you will complete a series of questions about the helper tool. For each question, you will see the assistance tool and your task is to click the part of the assistance tool that best answers the question. The assistance tool includes several regions, after you click a region, the selected region will be highlighted. You may change your selection before moving to the next question. Only your final selected region for each question will be recorded as your answer. You will not be told whether each answer is correct during the study.</p>

          <p>Afterward, you will be asked to complete a short survey with questions your experience using the assistance tool as well as a few demographics questions such as age, gender, and prior VR experience. Your answers to the survey will not affect your compensation in any way. At the end of the survey, you will receive a completion code. You will copy and paste this code into Amazon Mechanical Turk to receive payment for completing the study.</p>

          <p><strong>What are the possible risks of being in this research study?</strong></p>

          <p>There are no known risks to you from being in this research study.</p>

          <p><strong>What are the possible benefits to you?</strong></p>

          <p>You are not expected to get any benefit from being in this study.</p>

          <p><strong>What are the possible benefits to other people?</strong></p>
          <p>This research may help us understand whether people can use the assistance tool to provide assistance in VR activities. The results may help improve future tools for supporting VR users, including users who may need assistance during VR activities.</p>

          <p><strong>What will being in this research study cost you?</strong></p>

          <p>There is no cost to you to be in this research study.</p>

          <p><strong>Will you be compensated for being in this research study?</strong></p>

          <p>You will receive $4 for participating in this study.</p>

          <p><strong>What should you do if you have a problem during this research study?</strong></p>

          <p>Your welfare is the major concern of every member of the research team. If you have a problem as a direct result of being in this study, you should immediately contact one of the people listed at the beginning of this consent form.</p>

          <p><strong>How will information about you be protected?</strong></p>

          <p>Reasonable steps will be taken to protect your privacy and the confidentiality of your study data.</p>

          <p>The data will be stored electronically through a secure server and will only be seen by the research team during the study and for 5 years or longer after the study is complete.</p>

          <p>The only persons who will have access to your research records are the study personnel, the Institutional Review Board (IRB), and any other person, agency, or sponsor as required by law. The information from this study may be published in scientific journals or presented at scientific meetings but the data will be reported as group or summarized data and your identity will be kept strictly confidential.</p>

          <p><strong>What are your rights as a research subject?</strong></p>

          <p>You may ask any questions concerning this research and have those questions answered before agreeing to participate in or during the study.</p>

          <p>For study related questions, please contact the investigator(s) listed at the beginning of this form.</p>

          <p>For questions concerning your rights or complaints about the research contact the Institutional Review Board (IRB) or Vice President for Research and Economic Development:</p>

          <ul>
            <li>IRB: (401) 874-4328 / researchintegrity@etal.uri.edu.</li>
            <li>Vice President for Research and Economic Development: at (401) 874-4576</li>
          </ul>

          <p><strong>What will happen if you decide not to be in this research study or decide to stop participating once you start?</strong></p>

          <p>You can decide not to be in this research study, or you can stop being in this research study (“withdraw”) at any time before, during, or after the research begins for any reason. Deciding not to be in this research study or deciding to withdraw will not affect your relationship with the investigator or with the University of Rhode Island.</p>

          <p>You will not lose any benefits to which you are entitled.</p>

          <p><strong>Documentation of informed consent</strong></p>

          <p>You are voluntarily making a decision whether or not to be in this research study. Agreeing to this form means that (1) you have read and understood this consent form, (2) you have had your questions answered, and (3) you have decided to be in the research study. You can request a copy of this consent form to keep</p>
        </div>
        <div className="consent-actions">
          <button className="primary-action" type="button" onClick={onAccept}>
            I consent and want to continue
          </button>
          <button className="secondary-action" type="button" onClick={onDecline}>
            I do not consent
          </button>
        </div>
      </section>
    </main>
  );
}
function IntroPage({ onNext }) {
  return (
    <main className="page-shell">
      <section className="study-card intro-card">
        <p className="eyebrow">Study Introduction</p>
        <h1>How this study works</h1>
        <p>
          In this study, you will be shown a helper tool designed to assist a person using a virtual
          reality (VR) application. The helper tool displays the VR user's current view together with
          information and features that can be used to assist the VR user during different activities.
        </p>
        <p>
          Imagine that you are observing the VR user through this helper tool. Throughout the study,
          you will be asked questions about the helper tool, such as where you would find specific
          information or which feature you would use in a particular situation. For each question,
          your task is to click the appropriate part of the helper tool that best answers the question.
        </p>
        <p>
          All regions in the dashboard are clickable. You may click any region, button, dropdown,
          video, or control while answering a question. If you click more than one place, only the
          last region you clicked before pressing Next will be counted as your chosen answer.
        </p>
        <p>
          The same dashboard region may be the correct answer for more than one question.
        </p>
        <button className="primary-action" type="button" onClick={onNext}>
          Start study questions
        </button>
      </section>
    </main>
  );
}

function AttentionGatePage({ checks, onSubmit }) {
  const [answers, setAnswers] = useState({});
  const [currentCheckIndex, setCurrentCheckIndex] = useState(0);
  const [answeredResults, setAnsweredResults] = useState([]);
  const [currentCheckStartedAt, setCurrentCheckStartedAt] = useState(getIsoTimestamp());
  const currentCheck = checks[currentCheckIndex];
  const currentAnswer = currentCheck ? answers[currentCheck.check_id] ?? '' : '';
  const canSubmit = String(currentAnswer).trim().length > 0;

  useEffect(() => {
    setCurrentCheckStartedAt(getIsoTimestamp());
  }, [currentCheckIndex]);

  function setAnswer(checkId, answer) {
    setAnswers((previous) => ({ ...previous, [checkId]: answer }));
  }

  function handleCurrentSubmit() {
    if (!currentCheck) return;
    const answeredAt = getIsoTimestamp();
    const nextAnswers = { ...answers, [currentCheck.check_id]: currentAnswer };
    const isCorrect = normalizeAnswer(currentAnswer) === normalizeAnswer(currentCheck.correct_answer);
    const currentResult = {
      check_id: currentCheck.check_id,
      prompt: currentCheck.prompt,
      answer: currentAnswer,
      correct_answer: currentCheck.correct_answer,
      is_correct: isCorrect,
      started_at: currentCheckStartedAt,
      ended_at: answeredAt,
    };
    const nextResults = [...answeredResults, currentResult];

    if (!isCorrect || currentCheckIndex === checks.length - 1) {
      onSubmit(nextResults);
      return;
    }

    setAnswers(nextAnswers);
    setAnsweredResults(nextResults);
    setCurrentCheckIndex((index) => index + 1);
  }

  return (
    <main className="page-shell">
      <section className="study-card attention-card">
        <h1>Please answer this question before starting the study</h1>
        <p>Question {currentCheckIndex + 1} of {checks.length}. All screening questions must be answered correctly to continue.</p>
        {currentCheck && (
          <div className="attention-gate-item" key={currentCheck.check_id}>
            <h2>{currentCheck.prompt}</h2>
            {currentCheck.image_placeholder && (
              <div className="attention-image" aria-label="Placeholder image with highlighted ship bell">
                <div className="attention-scene">
                  <span className="attention-object bell-object">Ship bell</span>
                  <span className="attention-object barrel-object">Cargo barrel</span>
                  <span className="attention-highlight" />
                </div>
              </div>
            )}
            {currentCheck.type === 'multiple_choice' ? (
              <div className="choice-grid">
                {(currentCheck.options ?? []).map((option) => (
                  <button
                    key={option}
                    className={`choice-button ${currentAnswer === option ? 'selected' : ''}`}
                    type="button"
                    onClick={() => setAnswer(currentCheck.check_id, option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : (
              <label className="text-answer">
                <span>Your answer</span>
                <input
                  value={currentAnswer}
                  onChange={(event) => setAnswer(currentCheck.check_id, event.target.value)}
                />
              </label>
            )}
          </div>
        )}

        <button className="primary-action" type="button" disabled={!canSubmit} onClick={handleCurrentSubmit}>
          {currentCheckIndex === checks.length - 1 ? 'Submit screening question' : 'Next screening question'}
        </button>
      </section>
    </main>
  );
}

const CURRENT_TASK_ORDER = 18;

function getTaskNumber(task) {
  return Number.isFinite(Number(task?.order)) ? Number(task.order) : 0;
}

function getObjectKey(object, index) {
  return object?.objectPath || object?.id || `object-${index}`;
}

function getInstructionLines(task) {
  return String(task?.writtenInstructions ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getButtonsForObject(object, controllerSide = 'left') {
  return object?.controllerHints?.[controllerSide]?.needsToPress ?? [];
}

function getButtonLabel(buttons) {
  return buttons?.length
    ? buttons.map((button) => button[0].toUpperCase() + button.slice(1)).join(' + ')
    : 'No buttons required';
}

function getStudyAudioPath(task) {
  const taskNumber = getTaskNumber(task);
  if (AVAILABLE_AUDIO_TASKS.has(taskNumber) && task?.sendAudioInstructionMp3Path) {
    return task.sendAudioInstructionMp3Path;
  }
  return FALLBACK_AUDIO_PATH;
}

function getObjectViewImage(index) {
  const objectNumber = index + 1;
  if (objectNumber === 7) return 'img/VR_user_current_view_screenshots/task-18-obj-7).png';
  return `img/VR_user_current_view_screenshots/task-18-obj-${objectNumber}.png`;
}

function getRegionFeedbackLabel(regionId) {
  if (regionId?.startsWith('object-button-')) return 'object button';

  const labels = {
    'task-dropdown': 'task dropdown',
    'task-list': 'activity list',
    'task-progress': 'current task and progress text',
    'completed-task': 'completed task option',
    'current-task': 'current task option',
    'future-task': 'future task option',
    'instructions-panel': 'current activity section',
    'instructions-written': 'written instruction text',
    'listen-button': 'Listen button',
    'objects-panel': 'current activity objects section',
    'object-guide-button': 'object button',
    'object-highlight-button': 'object button',
    'vr-view': "VR user's current view",
    'freehand-button': 'Free hand drawing button',
    'clear-button': 'Clear button',
    'controller-panel': 'controller guidance section',
    'controller-object-dropdown': 'controller object dropdown',
    'controller-side-dropdown': 'left/right controller dropdown',
    'controller-video': 'controller video player',
    'controller-send-button': 'controller Send button',
    'demo-panel': 'current activity demo section',
    'demo-video': 'activity demo video player',
    'demo-send-button': 'demo Send button',
    'vr-sent-video': 'video shown in the VR view',
  };
  return labels[regionId] ?? regionId.replaceAll('-', ' ');
}

function isCorrectRegionSelection(selectedRegionId, correctRegionIds) {
  if (correctRegionIds.includes(selectedRegionId)) return true;
  if (selectedRegionId?.startsWith('object-button-')) {
    return correctRegionIds.includes('object-guide-button')
      || correctRegionIds.includes('object-highlight-button');
  }
  return false;
}

function SimulatedDashboard({ selectedRegionId, onRegionClick, screenVariant, metadata, resetKey }) {
  const tasks = metadata?.tasks ?? [];
  const initialTask = tasks.find((task) => getTaskNumber(task) === CURRENT_TASK_ORDER) ?? tasks[0];
  const [selectedTaskId, setSelectedTaskId] = useState(initialTask?.id ?? '');
  const [selectedObjectKey, setSelectedObjectKey] = useState('');
  const [controllerSide, setControllerSide] = useState('left');
  const [isInstructionPlaying, setIsInstructionPlaying] = useState(false);
  const [isControllerVideoPlaying, setIsControllerVideoPlaying] = useState(false);
  const [isDemoVideoPlaying, setIsDemoVideoPlaying] = useState(false);
  const [sentControllerVideo, setSentControllerVideo] = useState(false);
  const [sentDemoVideo, setSentDemoVideo] = useState(false);
  const [isFreehandActive, setIsFreehandActive] = useState(false);
  const [isCleared, setIsCleared] = useState(false);
  const [hasActiveAnnotation, setHasActiveAnnotation] = useState(false);
  const [vrViewImage, setVrViewImage] = useState(FIXED_VR_VIEW_IMAGE);
  const [isTaskDropdownOpen, setIsTaskDropdownOpen] = useState(false);
  const controllerVideoRef = useRef(null);
  const demoVideoRef = useRef(null);
  const instructionAudioRef = useRef(null);
  const freehandCanvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const lastDrawPointRef = useRef(null);
  const currentTask = tasks.find((task) => task.id === selectedTaskId) ?? initialTask;
  const selectedObject = currentTask?.objects?.find((object, index) => getObjectKey(object, index) === selectedObjectKey)
    ?? currentTask?.objects?.[0];
  const instructions = getInstructionLines(currentTask);
  const currentTaskNumber = getTaskNumber(currentTask);
  const runtimeCurrentTaskNumber = getTaskNumber(initialTask);
  const totalTasks = tasks.length;
  const selectedControllerButtons = getButtonsForObject(selectedObject, controllerSide);
  const controllerButtonLabel = getButtonLabel(selectedControllerButtons);
  const demoThumbnail = currentTask?.demoVideoInworld?.thumbnail;
  const controllerThumbnail = selectedObject?.demoVideoPhysicalworld?.thumbnail;
  const demoVideoUrl = currentTask?.demoVideoInworld?.file;
  const controllerVideoUrl = selectedObject?.demoVideoPhysicalworld?.[
    controllerSide === 'right' ? 'rightVideoUrl' : 'leftVideoUrl'
  ];
  const instructionAudioUrl = getStudyAudioPath(currentTask);
  const getTaskStatus = (task) => {
    const taskNumber = getTaskNumber(task);
    if (taskNumber < runtimeCurrentTaskNumber) return 'completed';
    if (taskNumber > runtimeCurrentTaskNumber) return 'future';
    return 'current';
  };
  const selectedTaskStatus = getTaskStatus(currentTask);
  const taskStatusRegion = {
    completed: 'completed-task',
    current: 'current-task',
    future: 'future-task',
  };
  const taskStatusLabel = {
    completed: 'Completed task',
    current: 'Current task',
    future: 'Future task',
  };
  const isCurrentTask = selectedTaskStatus === 'current';
  const sentVideoThumbnail = sentDemoVideo ? demoThumbnail : sentControllerVideo ? controllerThumbnail : '';
  const sentVideoUrl = sentDemoVideo ? demoVideoUrl : sentControllerVideo ? controllerVideoUrl : '';
  const hasControllerVideo = Boolean(controllerVideoUrl);
  const regionProps = (regionId) => ({
    'data-region-id': regionId,
    className: `sim-region clickable-region ${selectedRegionId === regionId ? 'selected-region' : ''}`,
    onClick: (event) => {
      event.stopPropagation();
      onRegionClick(regionId, event);
    },
  });

  const actionProps = (regionId, extraClass = '', disabled = false) => ({
    'data-region-id': regionId,
    className: `sim-button clickable-region ${extraClass} ${disabled ? 'disabled-control' : ''} ${selectedRegionId === regionId ? 'selected-region' : ''}`,
    disabled,
    'aria-disabled': disabled ? 'true' : undefined,
    onClick: (event) => {
      event.stopPropagation();
      if (disabled) return;
      onRegionClick(regionId, event);
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
    setIsInstructionPlaying(false);
    setSentControllerVideo(false);
    setSentDemoVideo(false);
    setIsFreehandActive(false);
    setIsCleared(false);
    setHasActiveAnnotation(false);
    setIsTaskDropdownOpen(false);
    setVrViewImage(FIXED_VR_VIEW_IMAGE);
    isDrawingRef.current = false;
    lastDrawPointRef.current = null;
    clearFreehandCanvas();
  }, [resetKey, initialTask?.id]);

  useEffect(() => {
    setSelectedObjectKey(getObjectKey(currentTask?.objects?.[0], 0));
    setControllerSide('left');
    setIsControllerVideoPlaying(false);
    setIsDemoVideoPlaying(false);
    setIsInstructionPlaying(false);
    setSentControllerVideo(false);
    setSentDemoVideo(false);
    setIsFreehandActive(false);
    setIsCleared(false);
    setHasActiveAnnotation(false);
    setVrViewImage(FIXED_VR_VIEW_IMAGE);
    clearFreehandCanvas();
  }, [currentTask?.id]);

  useEffect(() => {
    setIsControllerVideoPlaying(false);
    setSentControllerVideo(false);
  }, [selectedObjectKey, controllerSide]);

  useEffect(() => {
    const audio = instructionAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setIsInstructionPlaying(false);
  }, [instructionAudioUrl]);

  function handleListenClick(event) {
    event.stopPropagation();
    if (!isCurrentTask || !instructionAudioUrl) return;

    const audio = instructionAudioRef.current;
    if (!audio) return;

    if (isInstructionPlaying) {
      audio.pause();
      setIsInstructionPlaying(false);
    } else {
      audio.play()
        .then(() => setIsInstructionPlaying(true))
        .catch(() => setIsInstructionPlaying(false));
    }

    onRegionClick('listen-button', event);
  }

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
    setSelectedObjectKey(event.target.value);
    setIsControllerVideoPlaying(false);
    setSentControllerVideo(false);
    onRegionClick('controller-object-dropdown', event);
  }

  function handleControllerSideSelect(event) {
    setControllerSide(event.target.value);
    onRegionClick('controller-side-dropdown', event);
  }

  function handleObjectButtonClick(event, object, index) {
    setSelectedObjectKey(getObjectKey(object, index));
    setIsControllerVideoPlaying(false);
    setVrViewImage(getObjectViewImage(index));
    setHasActiveAnnotation(true);
    setIsCleared(false);
    onRegionClick(`object-button-${index}`, event);
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
    onRegionClick('vr-view', event);
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

  const vrViewRegionProps = regionProps('vr-view');

  return (
    <div className="tablet-frame">
    <div className={`sim-dashboard selected-task-${selectedTaskStatus}`} aria-label="Simulated VR helper dashboard">
      <section {...regionProps('task-dropdown')} aria-label="Task dropdown and progress">
        <div className="task-select">
          <button
            type="button"
            className={`task-select-trigger clickable-region ${selectedRegionId === 'task-dropdown' ? 'selected-region' : ''}`}
            data-region-id="task-dropdown"
            onClick={(event) => {
              event.stopPropagation();
              setIsTaskDropdownOpen((value) => !value);
              onRegionClick('task-dropdown', event);
            }}
          >
            <span className="task-select-trigger-text">
              {currentTaskNumber}. {currentTask?.title}
            </span>
            <span className={`task-status-icon task-status-icon-${selectedTaskStatus}`} aria-hidden="true" />
            <span className="task-select-chevron" aria-hidden="true">v</span>
          </button>
        </div>
        {isTaskDropdownOpen && (
          <div
            className={`task-select-list clickable-region ${
              selectedRegionId === 'task-list' ? 'selected-region' : ''
            }`}
            data-region-id="task-list"
            onClick={(event) => {
              event.stopPropagation();
              onRegionClick('task-list');
            }}
          >
            {tasks.map((task) => {
              const rowStatus = getTaskStatus(task);
              const rowRegion = taskStatusRegion[rowStatus];
              return (
                <button
                  key={task.id}
                  type="button"
                  {...actionProps(rowRegion, `task-select-option task-select-option-${rowStatus}`)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedTaskId(task.id);
                    setIsTaskDropdownOpen(false);
                    onRegionClick(rowRegion, event);
                  }}
                >
                  <span className={`task-status-icon task-status-icon-${rowStatus}`} aria-hidden="true" />
                  <span className="task-select-option-text">
                  {getTaskNumber(task)}. {task.title}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div
          data-region-id="task-progress"
          className={`task-progress-line clickable-region ${selectedRegionId === 'task-progress' ? 'selected-region' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onRegionClick('task-progress', event);
          }}
        >
          <span className={`task-status-icon task-status-icon-${selectedTaskStatus}`} aria-hidden="true" />
          <span>{taskStatusLabel[selectedTaskStatus]}</span>
          <strong>{currentTaskNumber}/{totalTasks}</strong>
        </div>
      </section>

      <section {...regionProps('instructions-panel')} aria-label="Current activity instructions">
        <h2>Current activity</h2>
        <p
          data-region-id="instructions-written"
          className={`instruction-copy clickable-region ${selectedRegionId === 'instructions-written' ? 'selected-region' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onRegionClick('instructions-written', event);
          }}
        >
          {instructions.map((line, index) => (
            <span key={`${line}-${index}`}>
              {instructions.length > 1 ? `${index + 1}. ` : ''}
              {line}
              <br />
            </span>
          ))}
        </p>
        {instructionAudioUrl && (
          <audio
            ref={instructionAudioRef}
            src={assetUrl(instructionAudioUrl)}
            onEnded={() => setIsInstructionPlaying(false)}
          />
        )}
        <button
          {...actionProps('listen-button', 'listen-button', !isCurrentTask || !instructionAudioUrl)}
          onClick={handleListenClick}
        >
          {isInstructionPlaying ? 'Playing' : 'Listen'}
        </button>
      </section>

      <section {...regionProps('objects-panel')} aria-label="Current activity objects">
        <h2>Current activity objects</h2>
        <p>Tap to highlight and point</p>
        <div className="object-button-list">
          {(currentTask?.objects ?? []).map((object, index) => {
            const regionId = `object-button-${index}`;
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
        {(sentControllerVideo || sentDemoVideo) && (
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
        <div className="vr-floating-tools">
          <button
            {...actionProps('freehand-button', `floating-tool freehand ${isFreehandActive ? 'tool-active' : ''}`, !isCurrentTask)}
            onClick={(event) => {
              event.stopPropagation();
              if (!isCurrentTask) return;
              setIsFreehandActive((value) => !value);
              setHasActiveAnnotation(true);
              setIsCleared(false);
              onRegionClick('freehand-button', event);
            }}
          >
            {isFreehandActive ? 'Drawing' : 'Free hand'}
          </button>
          <button
            {...actionProps('clear-button', `floating-tool clear ${hasActiveAnnotation ? 'clear-enabled' : ''}`, !isCurrentTask || !hasActiveAnnotation)}
            onClick={(event) => {
              event.stopPropagation();
              if (!isCurrentTask || !hasActiveAnnotation) return;
              setIsFreehandActive(false);
              setSentControllerVideo(false);
              setSentDemoVideo(false);
              clearFreehandCanvas();
              setVrViewImage(FIXED_VR_VIEW_IMAGE);
              setHasActiveAnnotation(false);
              setIsCleared(true);
              onRegionClick('clear-button', event);
            }}
          >
            Clear
          </button>
        </div>
      </section>

      <section {...regionProps('controller-panel')} aria-label="Current activity controller guidance">
        <div className="controller-header">
          <span>Required controls for:</span>
          <select
            data-region-id="controller-object-dropdown"
              className={`clickable-region ${selectedRegionId === 'controller-object-dropdown' ? 'selected-region' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                onRegionClick('controller-object-dropdown', event);
              }}
              onChange={handleObjectSelect}
              value={getObjectKey(selectedObject, 0)}
              aria-label="Object selector"
            >
              {(currentTask?.objects ?? []).map((object, index) => (
              <option key={getObjectKey(object, index)} value={getObjectKey(object, index)}>{object.label}</option>
            ))}
          </select>
          <select
            data-region-id="controller-side-dropdown"
              className={`clickable-region ${selectedRegionId === 'controller-side-dropdown' ? 'selected-region' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                onRegionClick('controller-side-dropdown', event);
              }}
              onChange={handleControllerSideSelect}
              value={controllerSide}
              aria-label="Controller side selector"
            >
            <option value="left">Left controller</option>
            <option value="right">Right controller</option>
          </select>
        </div>
        <div className="controller-body">
          <div className="controller-model">
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
            data-region-id="controller-video"
            className={`video-thumb clickable-region ${selectedRegionId === 'controller-video' ? 'selected-region' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              if (!hasControllerVideo) {
                onRegionClick('controller-video', event);
                return;
              }
              setIsControllerVideoPlaying((value) => !value);
              onRegionClick('controller-video', event);
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
                controls={isControllerVideoPlaying}
                autoPlay={isControllerVideoPlaying}
              />
            ) : (
              <div className="no-video-message">There is no action required for this object</div>
            )}
            {hasControllerVideo && <span className="play-symbol">{isControllerVideoPlaying ? 'Ⅱ' : '▶'}</span>}
          </div>
          <button
            {...actionProps('controller-send-button', `controller-send-button ${sentControllerVideo ? 'sent-button' : ''}`, !isCurrentTask || !hasControllerVideo)}
            onClick={(event) => {
              event.stopPropagation();
              if (!isCurrentTask || !hasControllerVideo) return;
              if (sentControllerVideo) {
                setSentControllerVideo(false);
              } else {
                setSentControllerVideo(true);
                setSentDemoVideo(false);
                setHasActiveAnnotation(true);
                setIsCleared(false);
              }
              onRegionClick('controller-send-button', event);
            }}
          >
            {sentControllerVideo ? 'Remove video' : 'Send'}
          </button>
        </div>
      </section>

      <section {...regionProps('demo-panel')} aria-label="Current activity demonstration video">
        <h2>Current activity demo</h2>
        <div
          data-region-id="demo-video"
          className={`demo-thumb clickable-region ${selectedRegionId === 'demo-video' ? 'selected-region' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            setIsDemoVideoPlaying((value) => !value);
            onRegionClick('demo-video', event);
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
              controls={isDemoVideoPlaying}
              autoPlay={isDemoVideoPlaying}
            />
          )}
          <span className="play-symbol">{isDemoVideoPlaying ? 'Ⅱ' : '▶'}</span>
        </div>
        <button
          {...actionProps('demo-send-button', `demo-send-button ${sentDemoVideo ? 'sent-button' : ''}`, !isCurrentTask || !demoVideoUrl)}
          onClick={(event) => {
            event.stopPropagation();
            if (!isCurrentTask || !demoVideoUrl) return;
            if (sentDemoVideo) {
              setSentDemoVideo(false);
            } else {
              setSentControllerVideo(false);
              setSentDemoVideo(true);
              setHasActiveAnnotation(true);
              setIsCleared(false);
            }
            onRegionClick('demo-send-button', event);
          }}
        >
          {sentDemoVideo ? 'Remove video' : 'Send'}
        </button>
      </section>
    </div>
    </div>
  );
}

function MainQuestionPage({ question, questionIndex, totalQuestions, selectedRegionId, onRegionClick, onNext, metadata }) {
  const selectedLabel = selectedRegionId ? getRegionFeedbackLabel(selectedRegionId) : '';

  return (
    <main className="study-interaction-page">
      <header className="question-bar">
        <div>
          <p className="eyebrow">Question {questionIndex + 1} of {totalQuestions}</p>
          <h1>{question.prompt}</h1>
          <p className={`selection-feedback ${selectedRegionId ? 'has-selection' : ''}`}>
            {selectedRegionId ? (
              <>
                You have selected <strong>{selectedLabel}</strong>, highlighted in yellow.
              </>
            ) : (
              'Select one region, button, dropdown, or video in the tablet below.'
            )}
          </p>
        </div>
        <button className="next-button" type="button" disabled={!selectedRegionId} onClick={onNext}>
          Next
        </button>
      </header>
      <div className="tablet-stage">
        <SimulatedDashboard
          selectedRegionId={selectedRegionId}
          onRegionClick={onRegionClick}
          screenVariant={question.screen_variant}
          metadata={metadata}
          resetKey={question.question_id}
        />
      </div>
    </main>
  );
}

function StoppedPage() {
  return (
    <main className="page-shell">
      <section className="study-card">
        <p className="eyebrow">Study Ended</p>
        <h1>You are not eligible to continue this study.</h1>
        <p>
          Based on the study rules, too many attention checks were answered incorrectly. The session
          has been marked as attention_passed=false.
        </p>
      </section>
    </main>
  );
}

function CompletionPage({
  completionCode,
  qualtricsUrl,
  externalSubmitUrl,
  participantParams,
  sessionId,
  metricsSaveStatus,
  metricsSaveError,
  onRetrySave,
}) {
  const [enteredCode, setEnteredCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const normalizedEnteredCode = enteredCode.trim().toUpperCase();
  const normalizedCompletionCode = String(completionCode || '').trim().toUpperCase();
  const canSubmitHit = metricsSaveStatus === 'saved'
    && Boolean(externalSubmitUrl)
    && Boolean(normalizedCompletionCode)
    && Boolean(normalizedEnteredCode);

  function handleSubmitHit(event) {
    if (!canSubmitHit || normalizedEnteredCode !== normalizedCompletionCode) {
      event.preventDefault();
      setCodeError('The code does not match. Please copy the code exactly from Qualtrics.');
      return;
    }
    setCodeError('');
  }

  return (
    <main className="page-shell">
      <section className="study-card completion-card">
        <h1>Please continue to the exit survey.</h1>
        <p>Your study responses must be saved before you can submit this HIT.</p>
        <p>Keep this MTurk page open. The exit survey opens in a new tab.</p>
        <div className="completion-actions">
          {(metricsSaveStatus === 'idle' || metricsSaveStatus === 'saving') && (
            <button className="primary-action" type="button" disabled>
              Saving responses...
            </button>
          )}
          {metricsSaveStatus === 'failed' && (
            <>
              <p className="save-error">Responses could not be saved. Please retry before continuing.</p>
              <button className="primary-action" type="button" onClick={onRetrySave}>
                Retry saving responses
              </button>
            </>
          )}
          {metricsSaveStatus === 'saved' && qualtricsUrl && (
            <a className="primary-action link-action" href={qualtricsUrl} target="_blank" rel="noopener noreferrer">
              Open exit survey
            </a>
          )}
          {metricsSaveStatus === 'saved' && !qualtricsUrl && (
            <button className="primary-action" type="button" disabled>
              Qualtrics URL not configured
            </button>
          )}
        </div>
        {metricsSaveStatus === 'saved' && (
          <form className="mturk-submit-form" method="post" action={externalSubmitUrl} onSubmit={handleSubmitHit}>
            <input type="hidden" name="assignmentId" value={participantParams?.assignmentId || ''} />
            <input type="hidden" name="completion_code" value={completionCode || ''} />
            <input type="hidden" name="session_id" value={sessionId || ''} />
            <input type="hidden" name="study_worker_id" value={participantParams?.workerId || ''} />
            <input type="hidden" name="study_hit_id" value={participantParams?.hitId || ''} />
            <label className="completion-code-entry">
              <span>Completion code from Qualtrics</span>
              <input
                value={enteredCode}
                onChange={(event) => {
                  setEnteredCode(event.target.value);
                  setCodeError('');
                }}
                placeholder="Paste the code shown at the end of Qualtrics"
                autoComplete="off"
              />
            </label>
            <button className="primary-action" type="submit" disabled={!canSubmitHit}>
              Submit HIT
            </button>
            {!externalSubmitUrl && (
              <p className="save-error">MTurk submit URL is missing. Please open this study from the MTurk HIT page.</p>
            )}
            {codeError && <p className="save-error">{codeError}</p>}
          </form>
        )}
        {metricsSaveError && <p className="save-error-detail">{metricsSaveError}</p>}
      </section>
    </main>
  );
}

function ThankYouPage() {
  return (
    <main className="page-shell">
      <section className="study-card completion-card">
        <h1>Thank you for your time.</h1>
        <p>The study has ended. You may close this page.</p>
      </section>
    </main>
  );
}

function MturkRequiredPage() {
  return (
    <main className="page-shell">
      <section className="study-card completion-card">
        <h1>Please open this study from the MTurk HIT page.</h1>
        <p>
          This study requires a valid MTurk worker ID, assignment ID, and HIT ID. Please return to
          MTurk and use the survey link shown inside the HIT.
        </p>
      </section>
    </main>
  );
}

function MturkPreviewPage() {
  return (
    <main className="page-shell">
      <section className="study-card completion-card">
        <h1>Please accept the HIT before starting the study.</h1>
        <p>
          You are currently previewing this HIT. After you accept it on MTurk, this study will open
          with your assignment information and you can begin.
        </p>
      </section>
    </main>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [attentionChecks, setAttentionChecks] = useState([]);
  const [metadata, setMetadata] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [phase, setPhase] = useState('loading');
  const [session, setSession] = useState(null);
  const [flowIndex, setFlowIndex] = useState(0);
  const [selectedRegionId, setSelectedRegionId] = useState('');
  const [currentQuestionStartedAt, setCurrentQuestionStartedAt] = useState('');
  const [firstClick, setFirstClick] = useState(null);
  const [currentQuestionClicks, setCurrentQuestionClicks] = useState([]);
  const savedSessionIdRef = useRef('');
  const phaseStartedAtRef = useRef('');
  const [metricsSaveStatus, setMetricsSaveStatus] = useState('idle');
  const [metricsSaveError, setMetricsSaveError] = useState('');
  const [backendCompletionCode, setBackendCompletionCode] = useState('');
  const [backendQualtricsUrl, setBackendQualtricsUrl] = useState('');

  useEffect(() => {
    Promise.all([
      fetch(assetUrl('study-config.json')).then((response) => response.json()),
      fetch(assetUrl('questions.json')).then((response) => response.json()),
      fetch(assetUrl('attention-checks.json')).then((response) => response.json()),
      fetch(assetUrl('task_metadata.json')).then((response) => response.json()),
    ])
      .then(([loadedConfig, loadedQuestions, loadedAttentionChecks, loadedMetadata]) => {
        const participantParams = getUrlParams();
        if (loadedConfig.requireMturkParams && isMturkPreview(participantParams)) {
          setConfig(loadedConfig);
          setQuestions(loadedQuestions);
          setAttentionChecks(loadedAttentionChecks);
          setMetadata(loadedMetadata);
          setPhase('mturk_preview');
          return;
        }
        if (loadedConfig.requireMturkParams && !hasRequiredMturkParams(participantParams)) {
          setConfig(loadedConfig);
          setQuestions(loadedQuestions);
          setAttentionChecks(loadedAttentionChecks);
          setMetadata(loadedMetadata);
          setPhase('mturk_required');
          return;
        }
        setConfig(loadedConfig);
        setQuestions(loadedQuestions);
        setAttentionChecks(loadedAttentionChecks);
        setMetadata(loadedMetadata);
        setPhase('consent');
      })
      .catch((error) => {
        setLoadError(error.message);
        setPhase('error');
      });
  }, []);

  const flow = useMemo(
    () => buildQuestionFlow(questions),
    [questions],
  );

  const currentFlowItem = flow[flowIndex];
  const mainQuestionCount = questions.length;
  const answeredMainQuestions = session?.responses?.length ?? 0;

  useEffect(() => {
    phaseStartedAtRef.current = getIsoTimestamp();
  }, [phase]);

  useEffect(() => {
    if (phase !== 'main') return;
    setCurrentQuestionStartedAt(getIsoTimestamp());
    setSelectedRegionId('');
    setFirstClick(null);
    setCurrentQuestionClicks([]);
  }, [phase, flowIndex]);

  useEffect(() => {
    if (!session) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, [session]);

  function createBaseSession(completionStatus = 'in_progress') {
    const participantParams = getUrlParams();
    const sessionId = createSessionId();
    return {
      session_id: sessionId,
      participant_params: participantParams,
      consent_version: CONSENT_VERSION,
      started_at: getIsoTimestamp(),
      ended_at: completionStatus === 'in_progress' ? '' : getIsoTimestamp(),
      completion_status: completionStatus,
      attention_passed: null,
      attention_failure_count: 0,
      responses: [],
      attention_checks: [],
      timing: {},
      events: [
        { type: 'session_started', timestamp: getIsoTimestamp(), participant_params: participantParams },
      ],
    };
  }

  function acceptConsent() {
    const now = getIsoTimestamp();
    const baseSession = createBaseSession();
    setSession({
      ...baseSession,
      timing: {
        ...baseSession.timing,
        informed_consent_started_at: phaseStartedAtRef.current || baseSession.started_at,
        informed_consent_ended_at: now,
        attention_checks_started_at: now,
      },
    });
    setPhase('attention_gate');
  }

  function declineConsent() {
    setSession({
      ...createBaseSession('consent_declined'),
      attention_passed: false,
      events: [
        { type: 'session_started', timestamp: getIsoTimestamp(), participant_params: getUrlParams() },
        { type: 'consent_declined', timestamp: getIsoTimestamp() },
      ],
    });
    setPhase('ended');
  }

  function startQuestions() {
    const now = getIsoTimestamp();
    setSession((previous) => ({
      ...previous,
      timing: {
        ...previous.timing,
        introduction_ended_at: now,
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

  function handleRegionClick(regionId, event) {
    const timestamp = getIsoTimestamp();
    if (!firstClick) {
      setFirstClick({
        region_id: regionId,
        timestamp,
        offset_x: Math.round(event?.nativeEvent?.offsetX ?? 0),
        offset_y: Math.round(event?.nativeEvent?.offsetY ?? 0),
      });
    }
    const clickRecord = {
      region_id: regionId,
      timestamp,
    };
    setCurrentQuestionClicks((previous) => [...previous, clickRecord]);
    setSelectedRegionId(regionId);
    recordEvent({
      type: 'dashboard_region_clicked',
      question_id: currentFlowItem?.item?.question_id,
      region_id: regionId,
    });
  }

  function continueFlow() {
    if (flowIndex + 1 >= flow.length) {
      finishStudy('completed');
      return;
    }

    setFlowIndex((index) => index + 1);
  }

  function handleMainNext() {
    const question = currentFlowItem.item;
    const answeredAt = getIsoTimestamp();
    const correctRegionIds = question.correct_region_ids ?? [];
    const isCorrect = isCorrectRegionSelection(selectedRegionId, correctRegionIds);

    setSession((previous) => ({
      ...previous,
      responses: [
        ...previous.responses,
        {
          question_id: question.question_id,
          prompt: question.prompt,
          target_feature: question.target_feature,
          acceptable_features: question.acceptable_features ?? [],
          correct_region_ids: correctRegionIds,
          selected_region_id: selectedRegionId,
          first_click_region_id: firstClick?.region_id ?? '',
          first_click_timestamp: firstClick?.timestamp ?? '',
          final_click_timestamp: answeredAt,
          question_started_at: currentQuestionStartedAt,
          response_time_ms: Date.parse(answeredAt) - Date.parse(currentQuestionStartedAt),
          clicks: currentQuestionClicks,
          is_correct: isCorrect,
          screen_variant: question.screen_variant,
        },
      ],
      events: [
        ...previous.events,
        {
          type: 'main_question_answered',
          timestamp: answeredAt,
          question_id: question.question_id,
          selected_region_id: selectedRegionId,
          is_correct: isCorrect,
        },
      ],
    }));

    continueFlow();
  }

  function handleAttentionGateSubmit(results) {
    const answeredAt = getIsoTimestamp();
    const failureCount = results.filter((result) => !result.is_correct).length;
    setSession((previous) => {
      const endedAt = failureCount > 0 ? getIsoTimestamp() : '';
      return {
        ...previous,
        ended_at: endedAt,
        completion_status: failureCount > 0 ? 'attention_failed' : previous.completion_status,
        attention_failure_count: failureCount,
        attention_checks: results,
        attention_passed: failureCount === 0,
        timing: {
          ...previous.timing,
          attention_checks_ended_at: answeredAt,
          ...(failureCount === 0 ? { introduction_started_at: answeredAt } : {}),
        },
        events: [
          ...previous.events,
          {
            type: 'attention_gate_submitted',
            timestamp: answeredAt,
            failure_count: failureCount,
          },
          ...(failureCount > 0
            ? [{ type: 'session_finished', timestamp: endedAt, completion_status: 'attention_failed' }]
            : []),
        ],
      };
    });
    if (failureCount > 0) {
      setPhase('ended');
      return;
    }
    setPhase('intro');
  }

  function finishStudy(status) {
    const endedAt = getIsoTimestamp();
    setSession((previous) => ({
      ...previous,
      ended_at: endedAt,
      completion_status: status,
      attention_passed: status !== 'attention_failed',
      timing: {
        ...previous.timing,
        actual_study_ended_at: endedAt,
      },
      events: [
        ...previous.events,
        { type: 'session_finished', timestamp: endedAt, completion_status: status },
      ],
    }));
    setPhase(status === 'attention_failed' ? 'stopped' : 'complete');
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

  useEffect(() => {
    if (!sessionPayload) return;
    if (sessionPayload.completion_status === 'in_progress') return;
    const saveKey = `${sessionPayload.session_id}:${sessionPayload.completion_status}`;
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
    return <main className="page-shell"><section className="study-card">Loading study...</section></main>;
  }

  if (phase === 'error') {
    return (
      <main className="page-shell">
        <section className="study-card">
          <h1>Study could not load</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (phase === 'mturk_required') {
    return <MturkRequiredPage />;
  }

  if (phase === 'mturk_preview') {
    return <MturkPreviewPage />;
  }

  if (phase === 'consent') return <LandingPage onAccept={acceptConsent} onDecline={declineConsent} />;
  if (phase === 'attention_gate') {
    return <AttentionGatePage checks={attentionChecks} onSubmit={handleAttentionGateSubmit} />;
  }
  if (phase === 'intro') return <IntroPage onNext={startQuestions} />;

  if (phase === 'main' && currentFlowItem?.type === 'main') {
    return (
      <MainQuestionPage
        question={currentFlowItem.item}
        questionIndex={answeredMainQuestions}
        totalQuestions={mainQuestionCount}
        selectedRegionId={selectedRegionId}
        onRegionClick={handleRegionClick}
        onNext={handleMainNext}
        metadata={metadata}
      />
    );
  }

  if (phase === 'stopped') {
    return <StoppedPage />;
  }

  if (phase === 'ended') {
    return <ThankYouPage />;
  }

  if (phase === 'complete') {
    return (
      <CompletionPage
        completionCode={backendCompletionCode}
        qualtricsUrl={backendQualtricsUrl}
        externalSubmitUrl={makeExternalSubmitUrl(session?.participant_params?.turkSubmitTo)}
        participantParams={session?.participant_params}
        sessionId={session?.session_id}
        metricsSaveStatus={metricsSaveStatus}
        metricsSaveError={metricsSaveError}
        onRetrySave={retrySaveMetrics}
      />
    );
  }

  return null;
}
