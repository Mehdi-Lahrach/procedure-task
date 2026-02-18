const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function appendJsonl(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  const line = JSON.stringify({ ...data, _written_at: new Date().toISOString() }) + '\n';
  fs.appendFileSync(filepath, line, 'utf8');
}

function readJsonl(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

const sessionIndex = {};
function loadSessionIndex() {
  const sessions = readJsonl('sessions.jsonl');
  sessions.forEach(s => sessionIndex[s.session_id] = s);
  console.log(`  Loaded ${Object.keys(sessionIndex).length} existing sessions`);
}

// --- Session Management ---
app.post('/api/session/create', (req, res) => {
  try {
    const sessionId = uuidv4();
    const { prolific_pid, prolificPid, study_id, studyId, session_id_prolific, sessionId: sessionIdProlific,
      condition_code, condition, procedure_version, procedureId,
      user_agent, userAgent, screen_width, screenWidth, screen_height, screenHeight,
      window_width, windowWidth, window_height, windowHeight,
      timezone, language, platform, metadata } = req.body;
    const session = {
      session_id: sessionId, prolific_pid: prolific_pid || prolificPid || null,
      study_id: study_id || studyId || null, session_id_prolific: session_id_prolific || sessionIdProlific || null,
      condition_code: condition_code || condition || 'default', procedure_version: procedure_version || procedureId || 'v1',
      user_agent: user_agent || userAgent || null,
      screen_width: screen_width || screenWidth, screen_height: screen_height || screenHeight,
      window_width: window_width || windowWidth, window_height: window_height || windowHeight,
      timezone: timezone || null, language: language || null, platform: platform || null,
      started_at: new Date().toISOString(), completed_at: null,
      is_complete: false, consent_given: false, metadata: metadata || null,
    };
    appendJsonl('sessions.jsonl', session);
    sessionIndex[sessionId] = session;
    res.json({ success: true, session_id: sessionId });
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/session/consent', (req, res) => {
  try {
    const { session_id } = req.body;
    appendJsonl('sessions_updates.jsonl', { session_id, update_type: 'consent', consent_given: true });
    if (sessionIndex[session_id]) sessionIndex[session_id].consent_given = true;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// --- Session Progress (save/resume) ---
app.post('/api/session/progress', (req, res) => {
  try {
    const { session_id, currentPageIndex, formData } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: 'Missing session_id' });
    const update = {
      session_id,
      update_type: 'progress',
      currentPageIndex: currentPageIndex != null ? currentPageIndex : 0,
      formData: formData || {},
    };
    appendJsonl('sessions_updates.jsonl', update);
    if (sessionIndex[session_id]) {
      sessionIndex[session_id].currentPageIndex = update.currentPageIndex;
      sessionIndex[session_id].formData = update.formData;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving progress:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/session/resume', (req, res) => {
  try {
    const { pid, sid } = req.query;
    if (!pid && !sid) return res.json({ found: false });

    const all = getMergedSessions();
    let session = null;

    if (pid && pid !== 'unknown') {
      // Find most recent session for this Prolific PID
      const matches = all.filter(s => s.prolific_pid === pid);
      if (matches.length > 0) {
        session = matches[matches.length - 1]; // most recent
      }
    }
    if (!session && sid) {
      session = all.find(s => s.session_id === sid);
    }

    if (!session) return res.json({ found: false });

    res.json({
      found: true,
      session_id: session.session_id,
      currentPageIndex: session.currentPageIndex || 0,
      formData: session.formData || {},
      is_complete: !!session.is_complete,
    });
  } catch (err) {
    console.error('Error resuming session:', err);
    res.status(500).json({ found: false, error: err.message });
  }
});

// Enhanced session completion — stores full tracker summary
app.post('/api/session/complete', (req, res) => {
  try {
    const { session_id } = req.body;
    const completion = {
      session_id,
      update_type: 'complete',
      completed_at: new Date().toISOString(),
      is_complete: true,
      totalDurationMs: req.body.totalDurationMs || 0,
      applicationDurationMs: req.body.applicationDurationMs || 0,
      totalDocTimeMs: req.body.totalDocTimeMs || 0,
      totalDocOpens: req.body.totalDocOpens || 0,
      totalErrors: req.body.totalErrors || 0,
      errorCountsByPage: req.body.errorCountsByPage || {},
      errorCountsByField: req.body.errorCountsByField || {},
      pageTimings: req.body.pageTimings || [],
      docInteractions: req.body.docInteractions || [],
      formResponses: req.body.formResponses || {},
      total_duration_ms: req.body.totalDurationMs || req.body.total_duration_ms || 0,
      total_errors: req.body.totalErrors || req.body.total_errors || 0,
    };
    appendJsonl('sessions_updates.jsonl', completion);
    if (sessionIndex[session_id]) Object.assign(sessionIndex[session_id], completion);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// --- Batch Event Ingestion ---
app.post('/api/events/batch', (req, res) => {
  try {
    const { session_id, events } = req.body;
    if (!session_id || !events || !Array.isArray(events)) {
      return res.status(400).json({ success: false, error: 'Invalid payload' });
    }
    const fileMap = {
      page: 'page_events.jsonl', click: 'click_events.jsonl',
      visibility: 'visibility_events.jsonl', scroll: 'scroll_events.jsonl',
      field: 'field_events.jsonl', form_response: 'form_responses.jsonl',
      navigation: 'navigation_events.jsonl', document: 'document_events.jsonl',
      validation: 'validation_events.jsonl',
    };
    for (const event of events) {
      const file = fileMap[event.type] || 'misc_events.jsonl';
      appendJsonl(file, { session_id, ...event });
    }
    res.json({ success: true, count: events.length });
  } catch (err) {
    console.error('Error ingesting events:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Data Export ---
const EXPORT_KEY = process.env.EXPORT_KEY || 'research2025';
function checkKey(req, res, next) {
  if (req.query.key !== EXPORT_KEY) return res.status(403).json({ error: 'Invalid export key' });
  next();
}

function getMergedSessions() {
  const sessions = readJsonl('sessions.jsonl');
  const updates = readJsonl('sessions_updates.jsonl');
  const map = {};
  sessions.forEach(s => map[s.session_id] = { ...s });
  updates.forEach(u => { if (map[u.session_id]) Object.assign(map[u.session_id], u); });
  return Object.values(map);
}

app.get('/api/export/sessions', checkKey, (req, res) => {
  try { res.json(getMergedSessions()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export/all/json', checkKey, (req, res) => {
  try {
    res.json({
      sessions: getMergedSessions(),
      page_events: readJsonl('page_events.jsonl'),
      click_events: readJsonl('click_events.jsonl'),
      visibility_events: readJsonl('visibility_events.jsonl'),
      scroll_events: readJsonl('scroll_events.jsonl'),
      field_events: readJsonl('field_events.jsonl'),
      form_responses: readJsonl('form_responses.jsonl'),
      navigation_events: readJsonl('navigation_events.jsonl'),
      document_events: readJsonl('document_events.jsonl'),
      validation_events: readJsonl('validation_events.jsonl'),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ANSWER KEY & APPLICATION QUALITY SCORING
// ============================================================
// Correct answers derived from the fictional documents.
// Used to compute rejection-worthy errors (substantive mistakes
// in the final submitted application, not formatting issues).

const ANSWER_KEY = {
  // Applicant details (from driving license + insurance cert)
  first_name: { correct: 'john', normalize: v => v.trim().toLowerCase() },
  last_name: { correct: 'doe', normalize: v => v.trim().toLowerCase() },
  date_of_birth: {
    correct: '12/06/1990',  // stored as DD/MM/YYYY
    normalize: v => {
      // Accept 12/6/1990 or 12/06/1990
      const parts = v.split('/');
      if (parts.length !== 3) return v;
      return `${parseInt(parts[0])}/${parseInt(parts[1])}/${parts[2]}`;
    },
    compare: (submitted, correct) => {
      const norm = v => { const p = v.split('/'); return `${parseInt(p[0])}/${parseInt(p[1])}/${p[2]}`; };
      return norm(submitted) === norm(correct);
    },
  },
  national_id: { correct: 'id-458921', normalize: v => v.trim().toLowerCase().replace(/\s/g, '') },

  // Eligibility (vehicle registered 2016, has valid insurance, not electric/hydrogen/30yr/disability → eligible)
  is_eligible: { correct: 'yes' },

  // Eligibility documents: vehicle_registration (proves date) + insurance_certificate (proves coverage) + technical_inspection (hybrid vehicles must provide technical report per rule 4)
  eligibility_documents: {
    correct: ['vehicle_registration', 'insurance_certificate', 'technical_inspection'],
    type: 'checkbox_must_include',  // submitted array must include all correct values
  },

  // Residence proof: must be issued within the last 4 months. In Feb 2026, the electricity bill (Nov 2025, ~3.5mo) qualifies; the water bill (Sep 2025, ~5mo) is too old.
  residence_document: {
    correct: ['electricity_bill'],
    type: 'one_of',
  },

  // Vehicle details (from vehicle registration certificate)
  vehicle_registration_number: { correct: 'gx-417-zr', normalize: v => v.trim().toLowerCase().replace(/\s/g, '') },
  vehicle_owner_type: { correct: 'private' },
  vehicle_category: { correct: 'M1' },
  vehicle_fuel_type: { correct: 'hybrid_synth' },
  vehicle_env_classification: { correct: 'z3' },
};

/**
 * Score a session's form responses against the answer key.
 * Returns { totalErrors, errors: [{ field, submitted, expected, description }], wouldReject }
 */
function scoreApplication(session) {
  const result = { totalErrors: 0, errors: [], wouldReject: false };
  if (!session.formResponses) return result;

  // Flatten all form responses into one object
  const responses = {};
  Object.values(session.formResponses).forEach(pageData => Object.assign(responses, pageData));

  for (const [field, rule] of Object.entries(ANSWER_KEY)) {
    const submitted = responses[field];
    if (submitted === undefined || submitted === null || submitted === '') continue; // didn't reach this field

    let isCorrect = false;

    if (rule.type === 'checkbox_must_include') {
      // Submitted should be an array containing all required values
      const arr = Array.isArray(submitted) ? submitted : [submitted];
      isCorrect = rule.correct.every(req => arr.includes(req));
      if (!isCorrect) {
        const missing = rule.correct.filter(req => !arr.includes(req));
        result.errors.push({
          field, submitted: arr.join(', '), expected: rule.correct.join(', '),
          description: `Missing required document(s): ${missing.join(', ')}`,
        });
        result.totalErrors++;
      }
    } else if (rule.type === 'one_of') {
      // Submitted should be one of the acceptable values
      isCorrect = rule.correct.includes(submitted);
      if (!isCorrect) {
        result.errors.push({
          field, submitted, expected: `one of: ${rule.correct.join(', ')}`,
          description: `Invalid choice for ${field}`,
        });
        result.totalErrors++;
      }
    } else if (rule.compare) {
      // Custom comparison function
      isCorrect = rule.compare(submitted, rule.correct);
      if (!isCorrect) {
        result.errors.push({
          field, submitted, expected: rule.correct,
          description: `Incorrect ${field}`,
        });
        result.totalErrors++;
      }
    } else {
      // Simple value comparison (with optional normalization)
      const normalize = rule.normalize || (v => v);
      const normSubmitted = normalize(String(submitted));
      const normCorrect = normalize(String(rule.correct));
      isCorrect = normSubmitted === normCorrect;
      if (!isCorrect) {
        result.errors.push({
          field, submitted, expected: rule.correct,
          description: `Incorrect ${field}`,
        });
        result.totalErrors++;
      }
    }
  }

  // Any substantive error would lead to rejection
  result.wouldReject = result.totalErrors > 0;
  return result;
}

// --- CSV Export: one row per session ---
app.get('/api/export/csv', checkKey, (req, res) => {
  try {
    const sessions = getMergedSessions();
    if (sessions.length === 0) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=sludge_data.csv');
      return res.send('');
    }

    const allFormFields = new Set();
    sessions.forEach(s => {
      if (s.formResponses) {
        Object.values(s.formResponses).forEach(pageData => {
          Object.keys(pageData).forEach(k => allFormFields.add(k));
        });
      }
    });

    const allPageIds = new Set();
    sessions.forEach(s => {
      if (s.pageTimings) s.pageTimings.forEach(pt => allPageIds.add(pt.pageId));
    });

    const allDocIds = new Set();
    sessions.forEach(s => {
      if (s.docInteractions) s.docInteractions.forEach(di => allDocIds.add(di.docId));
    });

    // Enrich sessions with completion_status and last_page
    sessions.forEach(s => {
      s.completion_status = getCompletionStatus(s);
      s.last_page = getLastPage(s);
    });

    const baseHeaders = [
      'session_id', 'prolific_pid', 'study_id', 'condition_code', 'procedure_version',
      'started_at', 'completed_at', 'completion_status', 'last_page', 'consent_given',
      'totalDurationMs', 'applicationDurationMs', 'totalDocTimeMs', 'totalDocOpens', 'totalErrors',
      'screen_width', 'screen_height', 'timezone', 'language', 'platform',
    ];

    const pageTimingHeaders = Array.from(allPageIds).sort().map(pid => `time_${pid}_ms`);
    const docHeaders = [];
    Array.from(allDocIds).sort().forEach(did => {
      docHeaders.push(`doc_${did}_opens`, `doc_${did}_totalMs`);
    });
    const errorByPageHeaders = Array.from(allPageIds).sort().map(pid => `errors_${pid}`);
    const formFieldHeaders = Array.from(allFormFields).sort();

    const qualityHeaders = ['quality_errors', 'quality_would_reject', 'quality_error_fields', 'quality_error_details', 'ineligible_skipped'];
    const headers = [...baseHeaders, ...pageTimingHeaders, ...docHeaders, ...errorByPageHeaders, ...formFieldHeaders, ...qualityHeaders];

    const rows = sessions.map(s => {
      const row = {};
      baseHeaders.forEach(h => { row[h] = s[h] != null ? s[h] : ''; });

      const timingMap = {};
      if (s.pageTimings) s.pageTimings.forEach(pt => { timingMap[pt.pageId] = pt.durationMs; });
      Array.from(allPageIds).sort().forEach(pid => {
        row[`time_${pid}_ms`] = timingMap[pid] != null ? timingMap[pid] : '';
      });

      const docMap = {};
      if (s.docInteractions) {
        s.docInteractions.forEach(di => {
          if (!docMap[di.docId]) docMap[di.docId] = { opens: 0, totalMs: 0 };
          docMap[di.docId].opens++;
          docMap[di.docId].totalMs += di.durationMs || 0;
        });
      }
      Array.from(allDocIds).sort().forEach(did => {
        row[`doc_${did}_opens`] = docMap[did] ? docMap[did].opens : 0;
        row[`doc_${did}_totalMs`] = docMap[did] ? docMap[did].totalMs : 0;
      });

      Array.from(allPageIds).sort().forEach(pid => {
        row[`errors_${pid}`] = s.errorCountsByPage?.[pid] || 0;
      });

      const allResponses = {};
      if (s.formResponses) {
        Object.values(s.formResponses).forEach(pageData => Object.assign(allResponses, pageData));
      }
      formFieldHeaders.forEach(f => {
        const val = allResponses[f];
        row[f] = val != null ? (Array.isArray(val) ? val.join(';') : val) : '';
      });

      // Application quality scoring
      const score = scoreApplication(s);
      row['quality_errors'] = score.totalErrors;
      row['quality_would_reject'] = score.wouldReject ? 'yes' : 'no';
      row['quality_error_fields'] = score.errors.map(e => e.field).join(';');
      row['quality_error_details'] = score.errors.map(e => `${e.field}: submitted="${e.submitted}" expected="${e.expected}"`).join(' | ');

      // Flag if participant said "not eligible" and was skipped past the procedure
      const isIneligible = allResponses.is_eligible === 'no';
      row['ineligible_skipped'] = isIneligible ? 'yes' : 'no';

      return row;
    });

    const csvEscape = (val) => {
      if (val == null) return '';
      const str = String(val);
      return (str.includes(',') || str.includes('"') || str.includes('\n')) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const csvLines = [headers.join(','), ...rows.map(row => headers.map(h => csvEscape(row[h])).join(','))];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=sludge_data.csv');
    res.send(csvLines.join('\n'));
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Per-table export ---
const VALID_FILES = {
  page_events: 'page_events.jsonl', click_events: 'click_events.jsonl',
  visibility_events: 'visibility_events.jsonl', scroll_events: 'scroll_events.jsonl',
  field_events: 'field_events.jsonl', form_responses: 'form_responses.jsonl',
  navigation_events: 'navigation_events.jsonl', document_events: 'document_events.jsonl',
  validation_events: 'validation_events.jsonl',
};

app.get('/api/export/:table', checkKey, (req, res) => {
  const table = req.params.table;
  if (table === 'sessions' || table === 'all' || table === 'csv') return;
  const filename = VALID_FILES[table];
  if (!filename) return res.status(400).json({ error: `Invalid table. Valid: sessions, csv, ${Object.keys(VALID_FILES).join(', ')}` });
  try {
    const data = readJsonl(filename);
    if (req.query.format === 'csv') {
      if (data.length === 0) return res.send('');
      const headers = [...new Set(data.flatMap(Object.keys))];
      const csv = [headers.join(','), ...data.map(row => headers.map(h => {
        const val = row[h];
        if (val == null) return '';
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g,'""')}"` : str;
      }).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${table}.csv`);
      return res.send(csv);
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Friendly page names ---
const PAGE_NAMES = {
  consent: 'Consent',
  instructions: 'Instructions',
  confirm_instructions: 'Confirm instructions',
  applicant_details: 'Applicant details',
  eligibility_rules: 'Eligibility rules',
  eligibility_decision: 'Eligibility decision',
  doc_upload_eligibility: 'Upload eligibility docs',
  doc_upload_residence: 'Upload residence docs',
  vehicle_info: 'Vehicle information',
  vehicle_category: 'Vehicle category',
  vehicle_fuel: 'Vehicle fuel type',
  vehicle_env_class: 'Vehicle environmental class',
  declaration: 'Declaration',
  application_submitted: 'Application submitted',
  demographics: 'Demographics',
  attention_check: 'Attention check',
  feedback: 'Feedback',
  debrief: 'Debrief',
  ineligible_end: 'Ineligible (skipped)',
  completion: 'Completion',
};
const DOC_NAMES = {
  driving_license: 'Driving License',
  vehicle_registration: 'Vehicle Registration',
  insurance_cert: 'Insurance Certificate',
  technical_inspection: 'Technical Inspection',
  electricity_bill: 'Electricity Bill',
  water_bill: 'Water Bill',
};
const pageName = id => PAGE_NAMES[id] || id;
const docName = id => DOC_NAMES[id] || id;

// Ordered pages for consistent display
const PAGE_ORDER = [
  'consent', 'instructions', 'confirm_instructions',
  'applicant_details',
  'eligibility_rules', 'eligibility_decision', 'doc_upload_eligibility', 'doc_upload_residence',
  'vehicle_info', 'vehicle_category', 'vehicle_fuel', 'vehicle_env_class',
  'declaration', 'application_submitted',
  'ineligible_end',
  'demographics', 'attention_check',
  'feedback', 'debrief', 'completion',
];

// Pages that are part of the main task (application)
const APPLICATION_PAGES = [
  'applicant_details',
  'eligibility_rules', 'eligibility_decision', 'doc_upload_eligibility', 'doc_upload_residence',
  'vehicle_info', 'vehicle_category', 'vehicle_fuel', 'vehicle_env_class',
  'declaration',
];

// Completion status — 5 categories:
// - "complete"   : did EVERYTHING — full procedure + post-task (demographics, feedback) + returned to Prolific
// - "submitted"  : submitted the application but dropped before finishing post-task/Prolific. Procedure data is exploitable.
// - "ineligible" : answered "not eligible" on the eligibility question (skipped the procedure). Timing excluded.
// - "dropped"    : consented and started the procedure but did not submit the application.
// - "incomplete" : opened the link but did not consent or barely started.
function getCompletionStatus(session) {
  // Check if participant answered "not eligible"
  const isIneligible = checkIneligible(session);
  if (isIneligible) return 'ineligible';

  // Completed the entire flow (reached final completion page via tracker)
  if (session.is_complete) return 'complete';

  // Check if they at least submitted the application
  const reachedSubmission = hasReachedSubmission(session);
  if (reachedSubmission) return 'submitted';

  // Check if they at least consented and started the procedure
  if (session.consent_given) return 'dropped';

  return 'incomplete';
}

// Helper: did the participant select "not eligible"?
function checkIneligible(session) {
  if (!session.formResponses) return false;
  const responses = {};
  Object.values(session.formResponses).forEach(pageData => Object.assign(responses, pageData));
  return responses.is_eligible === 'no';
}

// Helper: did the participant reach the application_submitted page?
function hasReachedSubmission(session) {
  if (session.pageTimings && Array.isArray(session.pageTimings)) {
    const visitedPages = new Set(session.pageTimings.map(pt => pt.pageId));
    if (visitedPages.has('application_submitted')) return true;
  }
  // Fallback: check currentPageIndex (application_submitted is around index 13-14)
  const pageIndex = session.currentPageIndex || 0;
  if (pageIndex >= 14) return true;
  return false;
}

// Find last visited page for drop-off tracking
function getLastPage(session) {
  if (session.is_complete) return 'completion';
  if (session.pageTimings && Array.isArray(session.pageTimings) && session.pageTimings.length > 0) {
    return session.pageTimings[session.pageTimings.length - 1].pageId;
  }
  const idx = session.currentPageIndex || 0;
  return PAGE_ORDER[idx] || `page_${idx}`;
}

// --- Stats ---
app.get('/api/stats', checkKey, (req, res) => {
  try {
    const all = getMergedSessions();
    const fmt = ms => { if (!ms) return '0s'; const s = Math.floor(ms/1000); const m = Math.floor(s/60); return m > 0 ? `${m}m ${s%60}s` : `${s}s`; };

    // Classify sessions using the 5-category system
    const classified = all.map(s => ({ ...s, completion_status: getCompletionStatus(s), last_page: getLastPage(s) }));
    const complete = classified.filter(s => s.completion_status === 'complete');
    const submitted = classified.filter(s => s.completion_status === 'submitted');
    const ineligible = classified.filter(s => s.completion_status === 'ineligible');
    const dropped = classified.filter(s => s.completion_status === 'dropped');
    const incomplete = classified.filter(s => s.completion_status === 'incomplete');

    // "Exploitable" = sessions with usable procedure data (complete + submitted, both did the full procedure)
    const exploitable = [...complete, ...submitted];

    // Helper: compute median of a numeric array
    const medianOf = arr => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    // Collect raw timing arrays for medians and distribution
    const totalDurations = exploitable.map(s => s.totalDurationMs || s.total_duration_ms || 0).filter(v => v > 0);
    const appDurations = exploitable.map(s => s.applicationDurationMs || 0).filter(v => v > 0);
    const docTimes = exploitable.map(s => s.totalDocTimeMs || 0).filter(v => v > 0);
    const docOpenCounts = exploitable.map(s => s.totalDocOpens || 0);
    const errorCounts = exploitable.map(s => s.totalErrors || s.total_errors || 0);

    // Timing averages from exploitable sessions (everyone who completed the procedure)
    const avgDur = totalDurations.length ? totalDurations.reduce((a, b) => a + b, 0) / totalDurations.length : 0;
    const avgAppDur = appDurations.length ? appDurations.reduce((a, b) => a + b, 0) / appDurations.length : 0;
    const avgErrors = errorCounts.length ? errorCounts.reduce((a, b) => a + b, 0) / errorCounts.length : 0;
    const avgDocTime = docTimes.length ? docTimes.reduce((a, b) => a + b, 0) / docTimes.length : 0;
    const avgDocOpens = docOpenCounts.length ? docOpenCounts.reduce((a, b) => a + b, 0) / docOpenCounts.length : 0;

    // Medians
    const medDur = medianOf(totalDurations);
    const medAppDur = medianOf(appDurations);
    const medErrors = medianOf(errorCounts);
    const medDocTime = medianOf(docTimes);
    const medDocOpens = medianOf(docOpenCounts);

    // Distribution data: procedure time histogram (appDurations in seconds, binned)
    const appDurSec = appDurations.map(ms => Math.round(ms / 1000));
    const BIN_WIDTH = 60; // 1-minute bins
    const histBins = [];
    if (appDurSec.length > 0) {
      const maxSec = Math.max(...appDurSec);
      const nBins = Math.ceil(maxSec / BIN_WIDTH) + 1;
      for (let i = 0; i < nBins; i++) histBins.push({ minSec: i * BIN_WIDTH, maxSec: (i + 1) * BIN_WIDTH, count: 0 });
      appDurSec.forEach(sec => {
        const idx = Math.min(Math.floor(sec / BIN_WIDTH), nBins - 1);
        histBins[idx].count++;
      });
    }

    // Per-page stats (from exploitable sessions — everyone who completed the procedure)
    const pageStats = {};
    PAGE_ORDER.forEach(pid => { pageStats[pid] = { totalTime: 0, nTime: 0, totalErrors: 0, nWithErrors: 0, nTotal: 0 }; });

    exploitable.forEach(s => {
      // Aggregate all visits to the same page within this session first
      if (s.pageTimings) {
        const sessionPageTotals = {};
        s.pageTimings.forEach(pt => {
          if (!sessionPageTotals[pt.pageId]) sessionPageTotals[pt.pageId] = 0;
          sessionPageTotals[pt.pageId] += pt.durationMs;
        });
        // Now add per-session totals (count each participant once per page)
        Object.entries(sessionPageTotals).forEach(([pid, totalMs]) => {
          if (!pageStats[pid]) pageStats[pid] = { totalTime: 0, nTime: 0, totalErrors: 0, nWithErrors: 0, nTotal: 0 };
          pageStats[pid].totalTime += totalMs;
          pageStats[pid].nTime++;
          pageStats[pid].nTotal++;
        });
      }
      if (s.errorCountsByPage) {
        Object.entries(s.errorCountsByPage).forEach(([pid, cnt]) => {
          if (!pageStats[pid]) pageStats[pid] = { totalTime: 0, nTime: 0, totalErrors: 0, nWithErrors: 0, nTotal: 0 };
          pageStats[pid].totalErrors += cnt;
          if (cnt > 0) pageStats[pid].nWithErrors++;
        });
      }
    });

    const pageStatsArr = PAGE_ORDER
      .filter(pid => pageStats[pid] && pageStats[pid].nTime > 0)
      .map(pid => {
        const d = pageStats[pid];
        const isFormPage = APPLICATION_PAGES.includes(pid) || pid === 'demographics' || pid === 'attention_check' || pid === 'feedback';
        return {
          pageId: pid,
          pageName: pageName(pid),
          avgTimeMs: Math.round(d.totalTime / d.nTime),
          avgTimeFormatted: fmt(d.totalTime / d.nTime),
          n: d.nTime,
          totalErrors: d.totalErrors,
          avgErrors: d.nTime > 0 ? (d.totalErrors / d.nTime).toFixed(1) : '0',
          errorRate: d.nTime > 0 ? Math.round(d.nWithErrors / d.nTime * 100) : 0,
          hasErrors: isFormPage, // show error columns only for form pages
        };
      });

    // Document stats (exploitable sessions — everyone who completed the procedure)
    const docAccum = {};
    exploitable.forEach(s => {
      if (s.docInteractions) {
        s.docInteractions.forEach(di => {
          if (!docAccum[di.docId]) docAccum[di.docId] = { opens: 0, totalMs: 0, sessions: new Set() };
          docAccum[di.docId].opens++;
          docAccum[di.docId].totalMs += di.durationMs || 0;
          docAccum[di.docId].sessions.add(s.session_id);
        });
      }
    });
    const docStats = Object.entries(docAccum).map(([docId, d]) => ({
      docId, docName: docName(docId), totalOpens: d.opens,
      avgTimeMs: Math.round(d.totalMs / d.opens), avgTimeFormatted: fmt(d.totalMs / d.opens),
      viewedByPct: exploitable.length ? Math.round(d.sessions.size / exploitable.length * 100) : 0,
      uniqueViewers: d.sessions.size,
    }));

    // Drop-off: where dropped/incomplete participants stopped (not submitted — they finished the procedure)
    const dropOff = {};
    [...dropped, ...incomplete].forEach(s => {
      const lp = s.last_page;
      if (!dropOff[lp]) dropOff[lp] = 0;
      dropOff[lp]++;
    });
    const dropOffArr = PAGE_ORDER
      .filter(pid => dropOff[pid])
      .map(pid => ({ pageId: pid, pageName: pageName(pid), count: dropOff[pid] }));
    // Also add any pages not in PAGE_ORDER
    Object.keys(dropOff).filter(k => !PAGE_ORDER.includes(k)).forEach(pid => {
      dropOffArr.push({ pageId: pid, pageName: pageName(pid), count: dropOff[pid] });
    });

    // Application quality scoring (exploitable sessions — they all submitted the application)
    const qualityScores = exploitable.map(s => scoreApplication(s));
    const rejectedCount = qualityScores.filter(q => q.wouldReject).length;
    const rejectionRate = exploitable.length > 0
      ? Math.round(rejectedCount / exploitable.length * 100)
      : 0;

    // Per-field error breakdown
    const fieldErrorCounts = {};
    qualityScores.forEach(q => {
      q.errors.forEach(e => {
        if (!fieldErrorCounts[e.field]) fieldErrorCounts[e.field] = 0;
        fieldErrorCounts[e.field]++;
      });
    });
    const qualityByField = Object.entries(fieldErrorCounts)
      .map(([field, count]) => ({
        field,
        count,
        rate: exploitable.length > 0 ? Math.round(count / exploitable.length * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({
      total_sessions: all.length,
      complete_sessions: complete.length,
      submitted_sessions: submitted.length,
      ineligible_sessions: ineligible.length,
      dropped_sessions: dropped.length,
      incomplete_sessions: incomplete.length,
      exploitable_sessions: exploitable.length,
      consented_sessions: all.filter(s => s.consent_given).length,
      avg_total_duration_formatted: fmt(avgDur),
      avg_task_duration_formatted: fmt(avgAppDur),
      avg_errors: avgErrors.toFixed(1),
      avg_doc_time_formatted: fmt(avgDocTime),
      avg_doc_opens: avgDocOpens.toFixed(1),
      page_stats: pageStatsArr,
      doc_stats: docStats,
      drop_off: dropOffArr,
      // Medians
      median_total_duration_formatted: fmt(medDur),
      median_task_duration_formatted: fmt(medAppDur),
      median_errors: medErrors,
      median_doc_time_formatted: fmt(medDocTime),
      median_doc_opens: medDocOpens,
      // Distribution data
      procedure_time_distribution: histBins,
      procedure_times_sec: appDurSec,
      // Application quality
      quality_submitted: exploitable.length,
      quality_rejected: rejectedCount,
      quality_rejection_rate: rejectionRate,
      quality_by_field: qualityByField,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Delete all data (piloting) ---
app.post('/api/delete-all-data', checkKey, (req, res) => {
  try {
    const { confirmation } = req.body;
    if (confirmation !== 'i want to delete the data') {
      return res.status(400).json({ error: 'Invalid confirmation text. You must type exactly: i want to delete the data' });
    }
    const files = fs.readdirSync(DATA_DIR);
    let deleted = 0;
    files.forEach(f => {
      if (f.endsWith('.jsonl') || f.endsWith('.json')) {
        fs.unlinkSync(path.join(DATA_DIR, f));
        deleted++;
      }
    });
    // Clear in-memory session index
    Object.keys(sessionIndex).forEach(k => delete sessionIndex[k]);
    console.log(`  [DELETE] All data erased (${deleted} files) by researcher`);
    res.json({ success: true, filesDeleted: deleted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Dashboard ---
app.get('/dashboard', checkKey, (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Sludge Experiment Dashboard</title>
<style>
body{font-family:system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#333}
h1{color:#003078;margin-bottom:5px}
.subtitle{color:#505a5f;margin-bottom:25px;font-size:15px}
h2{color:#1d70b8;border-bottom:2px solid #1d70b8;padding-bottom:8px;margin-top:35px}
h3{color:#333;margin-top:25px}
.stats-grid{display:flex;flex-wrap:wrap;gap:10px;margin:15px 0}
.stat{background:#f3f2f1;padding:15px 25px;border-radius:8px;min-width:130px}
.stat-value{font-size:26px;font-weight:700;color:#1d70b8}.stat-label{font-size:12px;color:#505a5f}
.stat--green .stat-value{color:#00703c}
.stat--blue .stat-value{color:#1d70b8}
.stat--amber .stat-value{color:#b58105}
.stat--red .stat-value{color:#d4351c}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:14px}
th{background:#1d70b8;color:white;padding:8px 12px;text-align:left;white-space:nowrap}
td{padding:6px 12px;border-bottom:1px solid #ddd}
tr:nth-child(even){background:#f8f8f8}
.section-header{background:#003078!important;color:white;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:0.5px}
.section-header td{padding:10px 12px;border:none}
.export{background:#f3f2f1;padding:20px;border-radius:8px;margin:20px 0}
a{color:#1d70b8}pre{background:#f3f2f1;padding:15px;border-radius:8px;overflow-x:auto;font-size:13px}
.help{font-size:13px;color:#505a5f;margin-top:3px;line-height:1.5}
.bar{height:18px;border-radius:2px;display:inline-block;vertical-align:middle}
.bar--red{background:#d4351c}.bar--amber{background:#f47738}.bar--green{background:#00703c}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.legend{background:#f8f8f8;border:1px solid #ddd;border-radius:6px;padding:12px 16px;margin:12px 0;font-size:13px;line-height:1.6}
.legend dt{font-weight:700;display:inline}.legend dd{display:inline;margin:0}.legend dd::after{content:'';display:block;margin-bottom:4px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:middle}
.dot--green{background:#00703c}.dot--amber{background:#b58105}.dot--red{background:#d4351c}.dot--blue{background:#1d70b8}
.hist-bar{position:absolute;bottom:30px;background:#1d70b8;border-radius:2px 2px 0 0;min-width:1px;opacity:0.85}
.hist-bar:hover{opacity:1}.hist-label{position:absolute;bottom:8px;font-size:10px;color:#505a5f;text-align:center;transform:translateX(-50%)}
.hist-y-label{position:absolute;left:0;font-size:10px;color:#505a5f;text-align:right;width:35px}
.hist-mean-line{position:absolute;bottom:30px;width:2px;background:#d4351c;z-index:2}
.hist-mean-label{position:absolute;font-size:10px;color:#d4351c;font-weight:700;white-space:nowrap}
.stat--muted .stat-value{color:#505a5f;font-size:22px}
</style></head>
<body>
<h1>Sludge Experiment Dashboard</h1>

<h2>Participation</h2>
<div id="participation" class="stats-grid"></div>
<div class="legend" id="participation-legend"></div>

<h2>Timing &amp; Behaviour</h2>
<div class="legend" id="timing-legend"></div>
<h3 style="margin-top:18px">Averages</h3>
<div id="timing" class="stats-grid"></div>
<h3>Medians</h3>
<div id="timing-medians" class="stats-grid"></div>
<h3>Procedure Time Distribution</h3>
<div id="histogram-container" style="margin:15px 0;position:relative;height:220px;background:#f8f8f8;border-radius:8px;padding:10px 15px 30px 40px"></div>

<h2>Application Quality</h2>
<p class="help">Substantive errors in submitted applications — wrong personal details, wrong eligibility decision, incorrect documents, wrong vehicle info. Scored automatically against the answer key. This is <em>not</em> about formatting issues (those are "validation errors" below).</p>
<div id="quality-overview" class="stats-grid"></div>
<table id="quality-table">
  <thead><tr><th>Field</th><th>Errors</th><th>Error Rate</th><th></th></tr></thead>
  <tbody></tbody>
</table>

<h2>Per-Page Breakdown</h2>
<p class="help">Timing and <strong>validation errors</strong> per page. Validation errors = formatting issues caught by the form (missing fields, wrong format). These are different from quality errors above.</p>
<table id="page-table">
  <thead><tr><th>Page</th><th>Avg Time</th><th>N</th><th>Avg Val. Errors</th><th>% with Val. Errors</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Document Interactions</h2>
<table id="doc-table">
  <thead><tr><th>Document</th><th>Viewers</th><th>% Viewed</th><th>Total Opens</th><th>Avg View Time</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Drop-off Analysis</h2>
<p class="help">Where participants who didn't finish stopped. Helps identify problematic pages.</p>
<table id="dropoff-table">
  <thead><tr><th>Last Page Reached</th><th>Count</th><th></th></tr></thead>
  <tbody></tbody>
</table>

<div class="export">
<h2 style="border:none;margin-top:0">Export Data</h2>
<p><a href="/api/export/csv?key=${EXPORT_KEY}"><strong>Download CSV</strong></a> — one row per participant, includes <code>completion_status</code> (complete/submitted/ineligible/dropped/incomplete), quality scoring, all form responses</p>
<p><a href="/api/export/all/json?key=${EXPORT_KEY}"><strong>All data (JSON)</strong></a></p>
<p>Tables:
<a href="/api/export/sessions?key=${EXPORT_KEY}">Sessions</a> |
<a href="/api/export/page_events?key=${EXPORT_KEY}">Pages</a> |
<a href="/api/export/form_responses?key=${EXPORT_KEY}">Responses</a> |
<a href="/api/export/document_events?key=${EXPORT_KEY}">Documents</a> |
<a href="/api/export/validation_events?key=${EXPORT_KEY}">Validation</a>
&nbsp;(append <code>&format=csv</code> for CSV)
</p>
</div>

<div class="export" style="border:2px solid #d4351c;background:#fef7f7">
<h2 style="border:none;margin-top:0;color:#d4351c">Erase All Data</h2>
<p style="color:#505a5f;font-size:13px">Delete all collected session data. Use this during piloting to start fresh. <strong>This cannot be undone.</strong></p>
<div id="delete-section">
  <button id="delete-btn-1" style="background:#d4351c;color:white;border:none;padding:10px 24px;border-radius:5px;cursor:pointer;font-size:14px;font-weight:600">Delete all data</button>
</div>
<div id="delete-step2" style="display:none;margin-top:12px">
  <p style="color:#d4351c;font-weight:600;margin-bottom:8px">Are you sure? Type <code>i want to delete the data</code> below to confirm:</p>
  <input id="delete-confirm-input" type="text" placeholder="Type confirmation here..." style="padding:8px 12px;border:1px solid #d4351c;border-radius:4px;width:300px;font-size:14px">
  <button id="delete-btn-2" style="background:#d4351c;color:white;border:none;padding:8px 20px;border-radius:5px;cursor:pointer;font-size:14px;margin-left:8px;font-weight:600">Confirm &amp; Delete</button>
  <button id="delete-cancel" style="background:#f3f2f1;color:#333;border:1px solid #ccc;padding:8px 20px;border-radius:5px;cursor:pointer;font-size:14px;margin-left:4px">Cancel</button>
  <p id="delete-error" style="color:#d4351c;font-size:13px;margin-top:6px;display:none"></p>
</div>
<div id="delete-success" style="display:none;margin-top:12px;color:#00703c;font-weight:600"></div>
</div>

<h3>Import into R</h3>
<pre>df &lt;- read.csv("http://YOUR_SERVER/api/export/csv?key=${EXPORT_KEY}")
# All exploitable procedure data (complete + submitted):
exploitable &lt;- df[df$$completion_status %in% c("complete", "submitted"), ]
# Only fully complete sessions (everything including post-task + Prolific):
full &lt;- df[df$$completion_status == "complete", ]</pre>

<h3>Import into Python</h3>
<pre>import pandas as pd
df = pd.read_csv("http://YOUR_SERVER/api/export/csv?key=${EXPORT_KEY}")
# All exploitable procedure data (complete + submitted):
exploitable = df[df.completion_status.isin(["complete", "submitted"])]
# Only fully complete sessions (everything including post-task + Prolific):
full = df[df.completion_status == "complete"]</pre>

<script>
const K = '${EXPORT_KEY}';
const fmt = ms => { if (!ms) return '0s'; const s = Math.floor(ms/1000); const m = Math.floor(s/60); return m > 0 ? m+'m '+s%60+'s' : s+'s'; };

const SECTIONS = {
  'Consent': 'Consent',
  'Instructions': 'Instructions', 'Confirm instructions': 'Instructions',
  'Applicant details': 'Applicant Details',
  'Eligibility rules': 'Eligibility', 'Eligibility decision': 'Eligibility',
  'Upload eligibility docs': 'Eligibility', 'Upload residence docs': 'Eligibility',
  'Vehicle information': 'Vehicle Details', 'Vehicle category': 'Vehicle Details',
  'Vehicle fuel type': 'Vehicle Details', 'Vehicle environmental class': 'Vehicle Details',
  'Declaration': 'Declaration',
  'Application submitted': 'Post-Task', 'Ineligible (skipped)': 'Post-Task',
  'Demographics': 'Post-Task', 'Attention check': 'Post-Task',
  'Feedback': 'Post-Task', 'Debrief': 'Post-Task', 'Completion': 'Post-Task',
};

fetch('/api/stats?key='+K).then(r=>r.json()).then(s=>{
  const total = s.total_sessions || 0;
  const comp = s.complete_sessions || 0;
  const subm = s.submitted_sessions || 0;
  const inelig = s.ineligible_sessions || 0;
  const drop = s.dropped_sessions || 0;
  const incomp = s.incomplete_sessions || 0;
  const exploit = s.exploitable_sessions || 0;
  const rate = total > 0 ? (comp/total*100).toFixed(0)+'%' : '0%';

  // Participation cards
  document.getElementById('participation').innerHTML = [
    ['Total', total, ''],
    ['Complete', comp, 'green'],
    ['Submitted', subm, subm > 0 ? 'blue' : ''],
    ['Ineligible', inelig, inelig > 0 ? 'amber' : ''],
    ['Dropped', drop, drop > 0 ? 'amber' : ''],
    ['Incomplete', incomp, incomp > 0 ? 'red' : ''],
  ].map(([l,v,c])=>'<div class="stat'+(c?' stat--'+c:'')+'"><div class="stat-value">'+v+'</div><div class="stat-label">'+l+'</div></div>').join('');

  // Legend
  document.getElementById('participation-legend').innerHTML =
    '<dl>'+
    '<dt><span class="dot dot--green"></span>Complete ('+comp+')</dt><dd> — finished everything: procedure + post-task questionnaires + returned to Prolific. Full dataset available.</dd>'+
    '<dt><span class="dot dot--blue"></span>Submitted ('+subm+')</dt><dd> — submitted the application but dropped before finishing post-task or returning to Prolific. <strong>Procedure data is exploitable</strong> (timing, errors, documents, form responses).</dd>'+
    '<dt><span class="dot dot--amber"></span>Ineligible ('+inelig+')</dt><dd> — answered "not eligible" and were skipped past the procedure. Counts as a quality error; timing is excluded from averages.</dd>'+
    '<dt><span class="dot dot--amber"></span>Dropped ('+drop+')</dt><dd> — consented and started the procedure but did not submit the application.</dd>'+
    '<dt><span class="dot dot--red"></span>Incomplete ('+incomp+')</dt><dd> — opened the link but did not consent or barely started.</dd>'+
    '</dl>'+
    '<p style="margin:8px 0 0;font-size:12px;color:#505a5f"><strong>Exploitable data:</strong> '+exploit+' sessions (Complete + Submitted). Timing and quality averages are computed from these sessions.</p>';

  // Timing legend
  document.getElementById('timing-legend').innerHTML =
    '<p style="margin:0 0 8px;font-size:13px;color:#505a5f">All timing and behaviour metrics are computed from <strong>exploitable sessions</strong> ('+exploit+' sessions: Complete + Submitted — everyone who finished the procedure).</p>'+
    '<dl>'+
    '<dt>Procedure Time</dt><dd> — time from the first form page (Applicant details) to clicking "Submit application". This is the core task duration.</dd>'+
    '<dt>Total Time</dt><dd> — time from session start to session end, including consent, instructions, post-task questionnaires, and feedback.</dd>'+
    '<dt>Validation Errors</dt><dd> — formatting issues caught by the form during the procedure (e.g., missing required fields, invalid date format). These are <em>not</em> substantive quality errors.</dd>'+
    '<dt>Doc Time</dt><dd> — total time spent viewing reference documents (ID card, vehicle registration, etc.) in the document viewer.</dd>'+
    '<dt>Doc Opens</dt><dd> — number of times a participant opened a reference document.</dd>'+
    '</dl>';

  // Timing average cards (from exploitable sessions)
  document.getElementById('timing').innerHTML = [
    ['Avg Procedure Time', s.avg_task_duration_formatted, ''],
    ['Avg Total Time', s.avg_total_duration_formatted, ''],
    ['Avg Validation Errors', s.avg_errors, ''],
    ['Avg Doc Time', s.avg_doc_time_formatted, ''],
    ['Avg Doc Opens', s.avg_doc_opens, ''],
  ].map(([l,v,c])=>'<div class="stat'+(c?' stat--'+c:'')+'"><div class="stat-value">'+v+'</div><div class="stat-label">'+l+'</div></div>').join('');

  // Timing median cards
  document.getElementById('timing-medians').innerHTML = [
    ['Mdn Procedure Time', s.median_task_duration_formatted || '—', 'muted'],
    ['Mdn Total Time', s.median_total_duration_formatted || '—', 'muted'],
    ['Mdn Validation Errors', s.median_errors != null ? s.median_errors : '—', 'muted'],
    ['Mdn Doc Time', s.median_doc_time_formatted || '—', 'muted'],
    ['Mdn Doc Opens', s.median_doc_opens != null ? s.median_doc_opens : '—', 'muted'],
  ].map(([l,v,c])=>'<div class="stat'+(c?' stat--'+c:'')+'"><div class="stat-value">'+v+'</div><div class="stat-label">'+l+'</div></div>').join('');

  // Histogram: procedure time distribution
  const histBins = s.procedure_time_distribution || [];
  const histContainer = document.getElementById('histogram-container');
  if (histBins.length > 0) {
    const maxCount = Math.max(...histBins.map(b=>b.count));
    const chartW = histContainer.clientWidth - 55; // leave room for y-axis labels
    const chartH = 160;
    const barW = Math.max(Math.floor(chartW / histBins.length) - 2, 4);
    let html = '';
    // Y-axis labels
    for (let i = 0; i <= 4; i++) {
      const yVal = Math.round(maxCount * (4-i) / 4);
      const yPx = 30 + (chartH * i / 4);
      html += '<span class="hist-y-label" style="top:'+yPx+'px">'+yVal+'</span>';
    }
    // Bars + x-axis labels
    histBins.forEach((b, i) => {
      const h = maxCount > 0 ? Math.round(b.count / maxCount * chartH) : 0;
      const x = 45 + i * (barW + 2);
      html += '<div class="hist-bar" style="left:'+x+'px;width:'+barW+'px;height:'+h+'px" title="'+b.minSec/60+'-'+b.maxSec/60+' min: '+b.count+' sessions"></div>';
      if (i % 2 === 0 || histBins.length <= 10) {
        html += '<span class="hist-label" style="left:'+(x+barW/2)+'px">'+Math.round(b.minSec/60)+'m</span>';
      }
    });
    // Mean line
    const rawTimes = s.procedure_times_sec || [];
    if (rawTimes.length > 0) {
      const meanSec = rawTimes.reduce((a,b)=>a+b,0) / rawTimes.length;
      const meanBinIdx = Math.min(Math.floor(meanSec / 60), histBins.length - 1);
      const meanX = 45 + meanBinIdx * (barW + 2) + barW/2;
      html += '<div class="hist-mean-line" style="left:'+meanX+'px;height:'+chartH+'px"></div>';
      html += '<span class="hist-mean-label" style="left:'+(meanX+4)+'px;top:8px">Mean: '+(meanSec/60).toFixed(1)+'m</span>';
    }
    histContainer.innerHTML = html;
  } else {
    histContainer.innerHTML = '<p style="text-align:center;color:#505a5f;padding-top:80px">No procedure time data yet</p>';
  }

  // Quality scoring
  const qRej = s.quality_rejected || 0;
  const qRate = s.quality_rejection_rate || 0;
  document.getElementById('quality-overview').innerHTML = [
    ['Would Be Rejected', qRej, qRej > 0 ? 'red' : 'green'],
    ['Rejection Rate', qRate+'%', qRate > 30 ? 'red' : qRate > 10 ? 'amber' : 'green'],
  ].map(([l,v,c])=>'<div class="stat'+(c?' stat--'+c:'')+'"><div class="stat-value">'+v+'</div><div class="stat-label">'+l+'</div></div>').join('');

  const qFields = s.quality_by_field || [];
  const maxFieldErr = Math.max(...qFields.map(f=>f.count), 1);
  document.querySelector('#quality-table tbody').innerHTML = qFields.map(f => {
    const pct = Math.round(f.count/maxFieldErr*100);
    return '<tr><td>'+f.field.replace(/_/g,' ')+'</td><td class="num">'+f.count+'</td><td class="num">'+f.rate+'%</td><td><span class="bar bar--amber" style="width:'+pct+'%">&nbsp;</span></td></tr>';
  }).join('') || '<tr><td colspan="4">No quality errors detected</td></tr>';

  // Page table
  const pages = s.page_stats || [];
  let lastSection = '';
  let tableHtml = '';
  pages.forEach(p => {
    const sec = SECTIONS[p.pageName] || 'Other';
    if (sec !== lastSection) {
      tableHtml += '<tr class="section-header"><td colspan="5">'+sec+'</td></tr>';
      lastSection = sec;
    }
    const errCols = p.hasErrors
      ? '<td class="num">'+p.avgErrors+'</td><td class="num">'+p.errorRate+'%</td>'
      : '<td class="num" style="color:#b1b4b6">&mdash;</td><td class="num" style="color:#b1b4b6">&mdash;</td>';
    tableHtml += '<tr><td>'+p.pageName+'</td><td class="num">'+p.avgTimeFormatted+'</td><td class="num">'+p.n+'</td>'+errCols+'</tr>';
  });
  document.querySelector('#page-table tbody').innerHTML = tableHtml || '<tr><td colspan="5">No data yet</td></tr>';

  // Document table
  const ds = s.doc_stats || [];
  document.querySelector('#doc-table tbody').innerHTML = ds.map(d =>
    '<tr><td>'+d.docName+'</td><td class="num">'+d.uniqueViewers+'</td><td class="num">'+d.viewedByPct+'%</td><td class="num">'+d.totalOpens+'</td><td class="num">'+d.avgTimeFormatted+'</td></tr>'
  ).join('') || '<tr><td colspan="5">No data yet</td></tr>';

  // Drop-off table
  const dropOffs = s.drop_off || [];
  const maxDrop = Math.max(...dropOffs.map(d=>d.count), 1);
  document.querySelector('#dropoff-table tbody').innerHTML = dropOffs.map(d => {
    const pct = Math.round(d.count/maxDrop*100);
    return '<tr><td>'+d.pageName+'</td><td class="num">'+d.count+'</td><td><span class="bar bar--red" style="width:'+pct+'%">&nbsp;</span></td></tr>';
  }).join('') || '<tr><td colspan="3">No drop-offs recorded</td></tr>';
});

// Delete data flow
document.getElementById('delete-btn-1').onclick = function() {
  document.getElementById('delete-btn-1').style.display = 'none';
  document.getElementById('delete-step2').style.display = 'block';
  document.getElementById('delete-confirm-input').focus();
};
document.getElementById('delete-cancel').onclick = function() {
  document.getElementById('delete-step2').style.display = 'none';
  document.getElementById('delete-btn-1').style.display = '';
  document.getElementById('delete-confirm-input').value = '';
  document.getElementById('delete-error').style.display = 'none';
};
document.getElementById('delete-btn-2').onclick = function() {
  const val = document.getElementById('delete-confirm-input').value.trim().toLowerCase();
  const errEl = document.getElementById('delete-error');
  if (val !== 'i want to delete the data') {
    errEl.textContent = 'Confirmation text does not match. Please type exactly: i want to delete the data';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  fetch('/api/delete-all-data?key='+K, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ confirmation: val })
  }).then(r=>r.json()).then(d => {
    if (d.success) {
      document.getElementById('delete-step2').style.display = 'none';
      document.getElementById('delete-success').style.display = 'block';
      document.getElementById('delete-success').textContent = 'All data deleted ('+d.filesDeleted+' files). Refresh the page to see empty dashboard.';
    } else {
      errEl.textContent = d.error || 'Deletion failed';
      errEl.style.display = 'block';
    }
  }).catch(e => { errEl.textContent = 'Request failed: '+e.message; errEl.style.display = 'block'; });
};
</script>
</body></html>`);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

loadSessionIndex();
app.listen(PORT, () => {
  console.log(`\n  Sludge Experiment Server`);
  console.log(`  Procedure:  http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard?key=${EXPORT_KEY}`);
  console.log(`  CSV Export: http://localhost:${PORT}/api/export/csv?key=${EXPORT_KEY}`);
  console.log(`  Data dir:   ${DATA_DIR}\n`);
});
