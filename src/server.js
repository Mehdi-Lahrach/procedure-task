const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

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

// --- Block Randomization for Estimation Condition ---
// Two conditions: 'self' (estimate own time) vs 'average' (estimate average participant time)
const ESTIMATION_CONDITIONS = ['self', 'average'];
const ESTIMATION_BLOCK_SIZE = 4; // 2 self + 2 average per block

function blockRandomize(existingSessions) {
  // Only count non-forced assignments
  const assigned = existingSessions
    .filter(s => !s.condition_forced && s.condition_code && ESTIMATION_CONDITIONS.includes(s.condition_code))
    .map(s => s.condition_code);

  const total = assigned.length;
  const posInBlock = total % ESTIMATION_BLOCK_SIZE;

  if (posInBlock === 0) {
    // New block: generate permuted block (Fisher-Yates shuffle)
    const block = [];
    for (const c of ESTIMATION_CONDITIONS) {
      for (let i = 0; i < ESTIMATION_BLOCK_SIZE / ESTIMATION_CONDITIONS.length; i++) block.push(c);
    }
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [block[i], block[j]] = [block[j], block[i]];
    }
    blockRandomize._currentBlock = block;
    return block[0];
  }

  // Mid-block: use stored block with consistency check
  if (blockRandomize._currentBlock && blockRandomize._currentBlock.length === ESTIMATION_BLOCK_SIZE) {
    const expected = blockRandomize._currentBlock.slice(0, posInBlock);
    const actual = assigned.slice(-posInBlock);
    const consistent = expected.every((c, i) => c === actual[i]);
    if (consistent) {
      return blockRandomize._currentBlock[posInBlock];
    }
  }

  // Fallback: balanced assignment (server restart mid-block)
  const selfCount = assigned.filter(c => c === 'self').length;
  const avgCount = assigned.filter(c => c === 'average').length;
  if (selfCount < avgCount) return 'self';
  if (avgCount < selfCount) return 'average';
  return Math.random() < 0.5 ? 'self' : 'average';
}
blockRandomize._currentBlock = null;

// --- Session Management ---
app.post('/api/session/create', (req, res) => {
  try {
    const sessionId = uuidv4();
    const { prolific_pid, prolificPid, study_id, studyId, session_id_prolific, sessionId: sessionIdProlific,
      condition_code, condition, procedure_version, procedureId,
      user_agent, userAgent, screen_width, screenWidth, screen_height, screenHeight,
      window_width, windowWidth, window_height, windowHeight,
      timezone, language, platform, metadata } = req.body;

    // Determine estimation condition via block randomization
    const requestedCondition = condition_code || condition || null;
    const isValidCondition = requestedCondition && ESTIMATION_CONDITIONS.includes(requestedCondition);
    const allSessions = Object.values(sessionIndex);
    const assignedCondition = isValidCondition ? requestedCondition : blockRandomize(allSessions);
    const conditionForced = isValidCondition; // true if researcher forced via URL param

    const session = {
      session_id: sessionId, prolific_pid: prolific_pid || prolificPid || null,
      study_id: study_id || studyId || null, session_id_prolific: session_id_prolific || sessionIdProlific || null,
      condition_code: assignedCondition, condition_forced: conditionForced,
      procedure_version: procedure_version || procedureId || 'v1',
      user_agent: user_agent || userAgent || null,
      screen_width: screen_width || screenWidth, screen_height: screen_height || screenHeight,
      window_width: window_width || windowWidth, window_height: window_height || windowHeight,
      timezone: timezone || null, language: language || null, platform: platform || null,
      started_at: new Date().toISOString(), completed_at: null,
      is_complete: false, consent_given: false, metadata: metadata || null,
    };
    appendJsonl('sessions.jsonl', session);
    sessionIndex[sessionId] = session;
    res.json({ success: true, session_id: sessionId, condition: assignedCondition });
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
    const { session_id, currentPageIndex, currentPageId, formData } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: 'Missing session_id' });
    const update = {
      session_id,
      update_type: 'progress',
      currentPageIndex: currentPageIndex != null ? currentPageIndex : 0,
      currentPageId: currentPageId || null,
      formData: formData || {},
    };
    appendJsonl('sessions_updates.jsonl', update);
    if (sessionIndex[session_id]) {
      sessionIndex[session_id].currentPageIndex = update.currentPageIndex;
      sessionIndex[session_id].currentPageId = update.currentPageId;
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
      condition: session.condition_code || 'self',
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

// --- Session Snapshot (partial summary sent on application submission) ---
// This captures timing/error/document data for participants who submit the application
// but may drop out before final completion. Ensures "submitted" sessions have exploitable data.
app.post('/api/session/snapshot', (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: 'Missing session_id' });
    const snapshot = {
      session_id,
      update_type: 'snapshot',
      snapshot_at: new Date().toISOString(),
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
      total_duration_ms: req.body.totalDurationMs || 0,
      total_errors: req.body.totalErrors || 0,
    };
    appendJsonl('sessions_updates.jsonl', snapshot);
    // Save snapshot data to session — will be overwritten by complete data if they finish
    if (sessionIndex[session_id]) {
      // Only apply snapshot if session is not already complete
      if (!sessionIndex[session_id].is_complete) {
        Object.assign(sessionIndex[session_id], snapshot);
      }
    }
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
  const result = { totalErrors: 0, errors: [], wouldReject: false, overDocumentation: [] };
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
      // Track over-documentation: extra documents beyond what's required
      const extras = arr.filter(v => !rule.correct.includes(v));
      if (extras.length > 0) {
        result.overDocumentation.push({
          field,
          extraDocs: extras,
          totalSelected: arr.length,
          requiredCount: rule.correct.length,
        });
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
      'session_id', 'prolific_pid', 'study_id', 'condition_code', 'condition_forced', 'procedure_version',
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

    const qualityHeaders = ['quality_errors', 'quality_would_reject', 'quality_error_fields', 'quality_error_details',
      'overdoc_eligibility', 'overdoc_eligibility_extras', 'overdoc_eligibility_total_selected',
      'overdoc_residence', 'overdoc_residence_selected',
      'ineligible_skipped'];
    const computedHeaders = ['time_estimate_total_seconds'];
    const headers = [...baseHeaders, ...pageTimingHeaders, ...docHeaders, ...errorByPageHeaders, ...formFieldHeaders, ...qualityHeaders, ...computedHeaders];

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

      // Over-documentation tracking
      const eligOverdoc = score.overDocumentation.find(o => o.field === 'eligibility_documents');
      row['overdoc_eligibility'] = eligOverdoc ? 'yes' : 'no';
      row['overdoc_eligibility_extras'] = eligOverdoc ? eligOverdoc.extraDocs.join(';') : '';
      row['overdoc_eligibility_total_selected'] = eligOverdoc ? eligOverdoc.totalSelected : (allResponses.eligibility_documents ? (Array.isArray(allResponses.eligibility_documents) ? allResponses.eligibility_documents.length : 1) : '');
      // Residence is a radio (single select), so over-doc means they picked something that's not a valid recent bill
      // We track what they selected — the quality scoring handles correctness separately
      const residenceVal = allResponses.residence_document || '';
      row['overdoc_residence'] = (residenceVal && !['electricity_bill'].includes(residenceVal)) ? 'wrong_choice' : 'correct';
      row['overdoc_residence_selected'] = residenceVal;

      // Flag if participant said "not eligible" and was skipped past the procedure
      const isIneligible = allResponses.is_eligible === 'no';
      row['ineligible_skipped'] = isIneligible ? 'yes' : 'no';

      // Computed: time estimate in total seconds (for easier analysis)
      const estMin = parseInt(allResponses.time_estimate_minutes) || 0;
      const estSec = parseInt(allResponses.time_estimate_seconds) || 0;
      row['time_estimate_total_seconds'] = (estMin > 0 || estSec > 0) ? (estMin * 60 + estSec) : '';

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
  eligibility_rules: 'Eligibility rules & decision',
  doc_upload_eligibility: 'Upload eligibility docs',
  doc_upload_residence: 'Upload residence docs',
  vehicle_info: 'Vehicle information',
  vehicle_category: 'Vehicle category',
  vehicle_fuel: 'Vehicle fuel type',
  vehicle_env_class: 'Vehicle environmental class',
  application_review: 'Review & submit',
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
  'eligibility_rules', 'doc_upload_eligibility', 'doc_upload_residence',
  'vehicle_info', 'vehicle_category', 'vehicle_fuel', 'vehicle_env_class',
  'application_review', 'application_submitted',
  'ineligible_end',
  'demographics', 'attention_check',
  'feedback', 'debrief', 'completion',
];

// Pages that are part of the main task (application)
const APPLICATION_PAGES = [
  'applicant_details',
  'eligibility_rules', 'doc_upload_eligibility', 'doc_upload_residence',
  'vehicle_info', 'vehicle_category', 'vehicle_fuel', 'vehicle_env_class',
  'application_review',
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
// A session counts as "submitted" as soon as the participant lands on the application_submitted confirmation page.
function hasReachedSubmission(session) {
  // Check pageTimings (available when session is complete)
  if (session.pageTimings && Array.isArray(session.pageTimings)) {
    const visitedPages = new Set(session.pageTimings.map(pt => pt.pageId));
    if (visitedPages.has('application_submitted')) return true;
  }
  // Check currentPageId saved in progress (most reliable for incomplete sessions)
  const postSubmissionPages = ['application_submitted', 'demographics', 'attention_check', 'feedback', 'debrief', 'completion'];
  if (session.currentPageId && postSubmissionPages.includes(session.currentPageId)) return true;
  // Fallback: check currentPageIndex (application_submitted is at index 12 in the procedure pages)
  const pageIndex = session.currentPageIndex || 0;
  if (pageIndex >= 12) return true;
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
    const fmt = ms => { if (!ms) return '0s'; const s = Math.round(ms/1000); const m = Math.floor(s/60); return m > 0 ? `${m}m ${s%60}s` : `${s}s`; };

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
        const isFormPage = APPLICATION_PAGES.includes(pid) || pid === 'application_submitted' || pid === 'demographics' || pid === 'attention_check' || pid === 'feedback';
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

    // Over-documentation analysis
    const overdocEligCount = qualityScores.filter(q => q.overDocumentation.some(o => o.field === 'eligibility_documents')).length;
    const overdocEligRate = exploitable.length > 0 ? Math.round(overdocEligCount / exploitable.length * 100) : 0;
    // Collect which extra docs people selected for eligibility
    const overdocEligExtras = {};
    qualityScores.forEach(q => {
      q.overDocumentation.filter(o => o.field === 'eligibility_documents').forEach(o => {
        o.extraDocs.forEach(d => {
          if (!overdocEligExtras[d]) overdocEligExtras[d] = 0;
          overdocEligExtras[d]++;
        });
      });
    });
    const overdocEligExtrasList = Object.entries(overdocEligExtras)
      .map(([doc, count]) => ({ doc, count, rate: exploitable.length > 0 ? Math.round(count / exploitable.length * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

    // Residence: track what participants selected (radio, so no "extra" — just wrong choice)
    // We flatten responses for each exploitable session
    const residenceChoices = {};
    exploitable.forEach(s => {
      const responses = {};
      if (s.formResponses) Object.values(s.formResponses).forEach(pd => Object.assign(responses, pd));
      const choice = responses.residence_document;
      if (choice) {
        if (!residenceChoices[choice]) residenceChoices[choice] = 0;
        residenceChoices[choice]++;
      }
    });
    const residenceBreakdown = Object.entries(residenceChoices)
      .map(([doc, count]) => ({ doc, count, rate: exploitable.length > 0 ? Math.round(count / exploitable.length * 100) : 0, isCorrect: doc === 'electricity_bill' }))
      .sort((a, b) => b.count - a.count);

    // Phase-level timing (aggregate page times into sections)
    const PHASE_MAP = {
      'applicant_details': 'Applicant Details',
      'eligibility_rules': 'Eligibility',
      'doc_upload_eligibility': 'Eligibility', 'doc_upload_residence': 'Eligibility',
      'vehicle_info': 'Vehicle Details', 'vehicle_category': 'Vehicle Details',
      'vehicle_fuel': 'Vehicle Details', 'vehicle_env_class': 'Vehicle Details',
      'application_review': 'Review & Submit',
    };
    const phaseTotals = {}; // { phaseName: { totalMs: 0, sessionCount: 0 } }
    exploitable.forEach(s => {
      if (!s.pageTimings) return;
      // Accumulate per-session phase totals first, so each session counts once per phase
      const sessionPhaseTotals = {};
      s.pageTimings.forEach(pt => {
        const phase = PHASE_MAP[pt.pageId];
        if (!phase) return;
        if (!sessionPhaseTotals[phase]) sessionPhaseTotals[phase] = 0;
        sessionPhaseTotals[phase] += pt.durationMs;
      });
      Object.entries(sessionPhaseTotals).forEach(([phase, ms]) => {
        if (!phaseTotals[phase]) phaseTotals[phase] = { totalMs: 0, sessionCount: 0 };
        phaseTotals[phase].totalMs += ms;
        phaseTotals[phase].sessionCount++;
      });
    });
    // --- Time Estimation (Post-Procedure) ---
    const estimationStats = (() => {
      // Collect estimation data from exploitable sessions with estimation responses
      const withEstimates = exploitable.filter(s => {
        const resp = {};
        if (s.formResponses) Object.values(s.formResponses).forEach(pd => Object.assign(resp, pd));
        const min = parseInt(resp.time_estimate_minutes) || 0;
        const sec = parseInt(resp.time_estimate_seconds) || 0;
        return (min > 0 || sec > 0);
      }).map(s => {
        const resp = {};
        if (s.formResponses) Object.values(s.formResponses).forEach(pd => Object.assign(resp, pd));
        const min = parseInt(resp.time_estimate_minutes) || 0;
        const sec = parseInt(resp.time_estimate_seconds) || 0;
        return {
          condition: s.condition_code || 'self',
          estimateSec: min * 60 + sec,
          confidence: parseInt(resp.time_estimate_confidence) || null,
          actualMs: s.applicationDurationMs || 0,
          actualSec: Math.round((s.applicationDurationMs || 0) / 1000),
        };
      });

      const selfData = withEstimates.filter(d => d.condition === 'self');
      const avgData = withEstimates.filter(d => d.condition === 'average');

      // Actual procedure times from all exploitable sessions (for comparison baseline)
      const actualSecAll = appDurations.map(ms => Math.round(ms / 1000));
      const actualMeanSec = actualSecAll.length > 0 ? Math.round(actualSecAll.reduce((a, b) => a + b, 0) / actualSecAll.length) : 0;
      const actualMedianSec = Math.round(medianOf(actualSecAll));

      const conditionStats = (data, label) => {
        if (data.length === 0) return { label, n: 0 };
        const estimates = data.map(d => d.estimateSec);
        const mean = Math.round(estimates.reduce((a, b) => a + b, 0) / estimates.length);
        const median = Math.round(medianOf(estimates));
        const confidences = data.map(d => d.confidence).filter(c => c != null);
        const meanConf = confidences.length > 0 ? (confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(1) : '—';
        // Estimation ratio: estimate / actual (>1 = overestimate, <1 = underestimate)
        const meanRatio = actualMeanSec > 0 ? (mean / actualMeanSec).toFixed(2) : '—';
        const medianRatio = actualMedianSec > 0 ? (median / actualMedianSec).toFixed(2) : '—';
        return { label, n: data.length, meanEstimateSec: mean, medianEstimateSec: median, meanConfidence: meanConf, meanRatio, medianRatio };
      };

      // Self-condition individual accuracy: each person's estimate vs their own actual time
      const selfAccuracy = (() => {
        if (selfData.length === 0) return null;
        const withActual = selfData.filter(d => d.actualSec > 0);
        if (withActual.length === 0) return null;
        const signedErrors = withActual.map(d => d.estimateSec - d.actualSec); // + = overestimate
        const absErrors = signedErrors.map(e => Math.abs(e));
        const ratios = withActual.map(d => d.estimateSec / d.actualSec); // >1 = overestimate
        const meanAbsError = Math.round(absErrors.reduce((a, b) => a + b, 0) / absErrors.length);
        const medianAbsError = Math.round(medianOf(absErrors));
        const meanSignedBias = Math.round(signedErrors.reduce((a, b) => a + b, 0) / signedErrors.length);
        const meanRatio = (ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2);
        const medianRatio = medianOf(ratios).toFixed(2);
        const overestimators = signedErrors.filter(e => e > 0).length;
        const underestimators = signedErrors.filter(e => e < 0).length;
        const exact = signedErrors.filter(e => e === 0).length;
        return {
          n: withActual.length,
          meanAbsErrorSec: meanAbsError,
          medianAbsErrorSec: medianAbsError,
          meanSignedBiasSec: meanSignedBias,
          meanRatio, medianRatio,
          overestimators, underestimators, exact,
          overPct: Math.round(overestimators / withActual.length * 100),
          underPct: Math.round(underestimators / withActual.length * 100),
        };
      })();

      // Confidence distribution (1–5) across all participants with estimates
      const confidenceDistribution = [1, 2, 3, 4, 5].map(level => {
        const selfN = selfData.filter(d => d.confidence === level).length;
        const avgN = avgData.filter(d => d.confidence === level).length;
        return { level, self: selfN, average: avgN, total: selfN + avgN };
      });

      // Confidence × accuracy for self-condition: do confident people estimate better?
      const confidenceAccuracy = (() => {
        if (selfData.length === 0) return null;
        const withActual = selfData.filter(d => d.actualSec > 0 && d.confidence != null);
        if (withActual.length < 3) return null; // too little data
        // Group by confidence level
        const byLevel = {};
        withActual.forEach(d => {
          if (!byLevel[d.confidence]) byLevel[d.confidence] = [];
          byLevel[d.confidence].push(Math.abs(d.estimateSec - d.actualSec));
        });
        return Object.entries(byLevel)
          .map(([level, errors]) => ({
            level: parseInt(level),
            n: errors.length,
            meanAbsErrorSec: Math.round(errors.reduce((a, b) => a + b, 0) / errors.length),
          }))
          .sort((a, b) => a.level - b.level);
      })();

      // Between-condition comparison: which condition is closer to actual time?
      const conditionComparison = (() => {
        const selfStats = conditionStats(selfData, 'Self');
        const avgStats = conditionStats(avgData, 'Average');
        if (selfStats.n === 0 && avgStats.n === 0) return null;
        const selfErrorVsActualMean = selfStats.n > 0 && actualMeanSec > 0
          ? Math.round(Math.abs(selfStats.meanEstimateSec - actualMeanSec)) : null;
        const avgErrorVsActualMean = avgStats.n > 0 && actualMeanSec > 0
          ? Math.round(Math.abs(avgStats.meanEstimateSec - actualMeanSec)) : null;
        let closerCondition = null;
        if (selfErrorVsActualMean != null && avgErrorVsActualMean != null) {
          closerCondition = selfErrorVsActualMean < avgErrorVsActualMean ? 'Self' :
            selfErrorVsActualMean > avgErrorVsActualMean ? 'Average' : 'Tied';
        }
        return { selfErrorVsActualMean, avgErrorVsActualMean, closerCondition };
      })();

      // Condition balance (all sessions, not just those with estimates)
      const allSelfCount = Object.values(sessionIndex).filter(s => s.condition_code === 'self').length;
      const allAvgCount = Object.values(sessionIndex).filter(s => s.condition_code === 'average').length;

      return {
        conditionBalance: { self: allSelfCount, average: allAvgCount },
        actualMeanSec, actualMedianSec,
        self: conditionStats(selfData, 'Self'),
        average: conditionStats(avgData, 'Average'),
        selfAccuracy,
        confidenceDistribution,
        confidenceAccuracy,
        conditionComparison,
        totalWithEstimates: withEstimates.length,
      };
    })();

    const phaseOrder = ['Applicant Details', 'Eligibility', 'Vehicle Details', 'Review & Submit'];
    const phaseStats = phaseOrder
      .filter(p => phaseTotals[p])
      .map(p => ({
        phase: p,
        avgMs: Math.round(phaseTotals[p].totalMs / phaseTotals[p].sessionCount),
        avgFormatted: fmt(phaseTotals[p].totalMs / phaseTotals[p].sessionCount),
        medianMs: medianOf((() => {
          // Compute per-session totals for this phase
          const vals = [];
          exploitable.forEach(s => {
            if (!s.pageTimings) return;
            let total = 0;
            s.pageTimings.forEach(pt => { if (PHASE_MAP[pt.pageId] === p) total += pt.durationMs; });
            if (total > 0) vals.push(total);
          });
          return vals;
        })()),
        medianFormatted: fmt(medianOf((() => {
          const vals = [];
          exploitable.forEach(s => {
            if (!s.pageTimings) return;
            let total = 0;
            s.pageTimings.forEach(pt => { if (PHASE_MAP[pt.pageId] === p) total += pt.durationMs; });
            if (total > 0) vals.push(total);
          });
          return vals;
        })())),
        n: phaseTotals[p].sessionCount,
      }));

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
      // Over-documentation
      overdoc_eligibility_count: overdocEligCount,
      overdoc_eligibility_rate: overdocEligRate,
      overdoc_eligibility_extras: overdocEligExtrasList,
      residence_breakdown: residenceBreakdown,
      // Phase timing
      phase_stats: phaseStats,
      // Time estimation
      estimation_stats: estimationStats,
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

// --- List all sessions (prolific_pid + completion status) ---
app.get('/api/list-sessions', checkKey, (req, res) => {
  const sessions = readJsonl('sessions.jsonl');
  res.json(sessions.map(s => ({
    session_id: s.session_id,
    prolific_pid: s.prolific_pid,
    completion_status: s.completion_status,
    completed_at: s.completed_at || null,
  })));
});

// --- Bulk import sessions (restore from CSV backup) ---
app.post('/api/import-sessions', checkKey, (req, res) => {
  try {
    const { sessions } = req.body;
    if (!Array.isArray(sessions) || sessions.length === 0)
      return res.status(400).json({ error: 'sessions array required' });
    const filepath = path.join(DATA_DIR, 'sessions.jsonl');
    const lines = sessions.map(s => JSON.stringify({ ...s, _written_at: new Date().toISOString() }));
    fs.writeFileSync(filepath, lines.join('\n') + '\n', 'utf8');
    // Rebuild in-memory index
    Object.keys(sessionIndex).forEach(k => delete sessionIndex[k]);
    sessions.forEach(s => { sessionIndex[s.session_id] = s; });
    console.log(`  [IMPORT] ${sessions.length} sessions restored`);
    res.json({ success: true, imported: sessions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Remove specific participant by prolific_pid ---
app.get('/api/remove-participant', checkKey, (req, res) => {
  try {
    const { pid } = req.query;
    if (!pid) return res.status(400).json({ error: 'pid query param required' });

    const sessions = readJsonl('sessions.jsonl');
    const toRemove = sessions.filter(s => s.prolific_pid === pid);
    if (toRemove.length === 0) return res.status(404).json({ error: 'No sessions found for that prolific_pid' });

    const sessionIds = new Set(toRemove.map(s => s.session_id));

    // Filter sessions.jsonl
    const filtered = sessions.filter(s => s.prolific_pid !== pid);
    const sessionsPath = path.join(DATA_DIR, 'sessions.jsonl');
    fs.writeFileSync(sessionsPath, filtered.map(s => JSON.stringify(s)).join('\n') + (filtered.length ? '\n' : ''), 'utf8');

    // Filter all event files by session_id
    ['navigation_events.jsonl', 'misc_events.jsonl', 'sessions_updates.jsonl'].forEach(filename => {
      const filepath = path.join(DATA_DIR, filename);
      if (!fs.existsSync(filepath)) return;
      const records = readJsonl(filename);
      const filteredRecords = records.filter(r => !sessionIds.has(r.session_id));
      fs.writeFileSync(filepath, filteredRecords.map(r => JSON.stringify(r)).join('\n') + (filteredRecords.length ? '\n' : ''), 'utf8');
    });

    // Remove from in-memory index
    sessionIds.forEach(sid => delete sessionIndex[sid]);

    console.log(`  [REMOVE] Participant ${pid} removed (${toRemove.length} session(s))`);
    res.json({ success: true, removed_sessions: toRemove.length, session_ids: [...sessionIds] });
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

<h2>Document Selection Behaviour</h2>
<p class="help">Tracks whether participants selected <strong>more documents than required</strong> (over-documentation) — a "select everything" strategy. Over-documentation does not cause rejection, but reveals cautious or confused behaviour.</p>
<h3>Eligibility documents</h3>
<p class="help">Required: Vehicle Registration + Insurance Certificate + Technical Inspection Report (3 documents). Extra = unnecessary documents selected.</p>
<div id="overdoc-elig" class="stats-grid"></div>
<div id="overdoc-elig-extras"></div>
<h3>Residence proof</h3>
<p class="help">Required: a utility bill issued within the last 4 months. Only the electricity bill (Nov 2025) is valid; the water bill (Sep 2025) is too old.</p>
<div id="overdoc-residence"></div>

<h2>Phase Timing</h2>
<p class="help">Average and median time per application phase (aggregating individual pages). Computed from exploitable sessions.</p>
<table id="phase-table">
  <thead><tr><th>Phase</th><th>Avg Time</th><th>Median Time</th><th>N</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Time Estimation (Post-Procedure)</h2>
<div class="legend">
  <p style="margin:0 0 8px;font-size:13px"><strong>Design:</strong> After submitting the application, participants are asked to estimate how long the procedure took. There are two between-subjects conditions, assigned via block randomization (permuted blocks of 4):</p>
  <dl>
    <dt><span class="dot dot--blue"></span>Self condition</dt><dd> — participants estimate how long <strong>they personally</strong> spent completing the application.</dd>
    <dt><span class="dot dot--green"></span>Average condition</dt><dd> — participants estimate how long <strong>an average participant</strong> would take to complete the application.</dd>
  </dl>
  <p style="margin:8px 0 0;font-size:12px;color:#505a5f">Both conditions ask for minutes + seconds and a confidence rating (1–5 Likert scale). The actual procedure time (used for comparison) is computed from all exploitable sessions.</p>
</div>

<h3>Condition Balance</h3>
<p class="help">Number of participants assigned to each condition. Block randomization ensures roughly equal allocation.</p>
<div id="estimation-balance" class="stats-grid"></div>

<h3>Analysis 1: Group-Level Estimates vs Actual Procedure Time</h3>
<p class="help">Compares the <strong>average estimate</strong> in each condition to the <strong>actual average procedure time</strong> across all exploitable sessions. The <em>Ratio</em> column shows estimate ÷ actual: a ratio of 1.00 means perfect calibration, &gt;1 means overestimation, &lt;1 means underestimation. This answers: <em>Do people think the procedure takes longer or shorter than it actually does?</em></p>
<table id="estimation-table">
  <thead><tr><th>Condition</th><th>N</th><th>Mean Estimate</th><th>Median Estimate</th><th>Actual Mean</th><th>Actual Median</th><th>Ratio (Mean)</th><th>Avg Confidence</th></tr></thead>
  <tbody></tbody>
</table>

<div id="self-accuracy"></div>

<div id="condition-comparison"></div>

<h3>Analysis 3: Confidence Distribution</h3>
<p class="help">How participants rated their confidence in their estimate (1 = not at all confident, 5 = extremely confident), broken down by condition.</p>
<table id="confidence-dist-table">
  <thead><tr><th>Confidence Level</th><th>Self</th><th>Average</th><th>Total</th></tr></thead>
  <tbody></tbody>
</table>

<div id="confidence-accuracy"></div>

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
const fmt = ms => { if (!ms) return '0s'; const s = Math.round(ms/1000); const m = Math.floor(s/60); return m > 0 ? m+'m '+s%60+'s' : s+'s'; };

const SECTIONS = {
  'Consent': 'Consent',
  'Instructions': 'Instructions', 'Confirm instructions': 'Instructions',
  'Applicant details': 'Applicant Details',
  'Eligibility rules & decision': 'Eligibility',
  'Upload eligibility docs': 'Eligibility', 'Upload residence docs': 'Eligibility',
  'Vehicle information': 'Vehicle Details', 'Vehicle category': 'Vehicle Details',
  'Vehicle fuel type': 'Vehicle Details', 'Vehicle environmental class': 'Vehicle Details',
  'Review & submit': 'Review & Submit',
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

  // Over-documentation: eligibility
  const odEligCount = s.overdoc_eligibility_count || 0;
  const odEligRate = s.overdoc_eligibility_rate || 0;
  document.getElementById('overdoc-elig').innerHTML = [
    ['Over-documented', odEligCount, odEligCount > 0 ? 'amber' : 'green'],
    ['Over-doc Rate', odEligRate+'%', odEligRate > 50 ? 'amber' : ''],
  ].map(([l,v,c])=>'<div class="stat'+(c?' stat--'+c:'')+'"><div class="stat-value">'+v+'</div><div class="stat-label">'+l+'</div></div>').join('');

  const odExtras = s.overdoc_eligibility_extras || [];
  if (odExtras.length > 0) {
    document.getElementById('overdoc-elig-extras').innerHTML =
      '<table style="margin-top:8px"><thead><tr><th>Unnecessary document selected</th><th>Count</th><th>Rate</th><th></th></tr></thead><tbody>' +
      odExtras.map(e => {
        const barW = Math.round(e.rate);
        return '<tr><td>'+e.doc.replace(/_/g,' ')+'</td><td class="num">'+e.count+'</td><td class="num">'+e.rate+'%</td><td><span class="bar bar--amber" style="width:'+barW+'%">&nbsp;</span></td></tr>';
      }).join('') + '</tbody></table>';
  }

  // Over-documentation: residence
  const resBkdn = s.residence_breakdown || [];
  if (resBkdn.length > 0) {
    document.getElementById('overdoc-residence').innerHTML =
      '<table style="margin-top:8px"><thead><tr><th>Document chosen</th><th>Count</th><th>Rate</th><th>Correct?</th></tr></thead><tbody>' +
      resBkdn.map(r => {
        const cls = r.isCorrect ? 'color:#00703c;font-weight:700' : 'color:#d4351c;font-weight:700';
        return '<tr><td>'+r.doc.replace(/_/g,' ')+'</td><td class="num">'+r.count+'</td><td class="num">'+r.rate+'%</td><td style="'+cls+'">'+(r.isCorrect ? 'Yes' : 'No')+'</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // Phase timing table
  const phases = s.phase_stats || [];
  document.querySelector('#phase-table tbody').innerHTML = phases.map(p =>
    '<tr><td><strong>'+p.phase+'</strong></td><td class="num">'+p.avgFormatted+'</td><td class="num">'+p.medianFormatted+'</td><td class="num">'+p.n+'</td></tr>'
  ).join('') || '<tr><td colspan="4">No data yet</td></tr>';

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

  // Time Estimation section
  const est = s.estimation_stats || {};
  const bal = est.conditionBalance || {};
  const totalAssigned = (bal.self || 0) + (bal.average || 0);
  const withEst = est.totalWithEstimates || 0;
  const responseRate = totalAssigned > 0 ? Math.round(withEst / totalAssigned * 100) : 0;
  document.getElementById('estimation-balance').innerHTML = [
    ['Assigned to Self', bal.self || 0, 'blue'],
    ['Assigned to Average', bal.average || 0, 'green'],
    ['Provided an estimate', withEst + ' / ' + totalAssigned, ''],
    ['Response rate', responseRate + '%', responseRate >= 80 ? 'green' : responseRate >= 50 ? 'amber' : 'red'],
  ].map(([l,v,c])=>'<div class="stat'+(c?' stat--'+c:'')+'"><div class="stat-value">'+v+'</div><div class="stat-label">'+l+'</div></div>').join('');

  const fmtSec = sec => { if (!sec && sec !== 0) return '—'; const s2 = Math.round(sec); const m = Math.floor(s2/60); return m > 0 ? m+'m '+(s2%60)+'s' : s2+'s'; };
  const ratioColor = r => { if (r === '—') return ''; const v = parseFloat(r); if (v > 1.1) return ' style="color:#b58105;font-weight:700"'; if (v < 0.9) return ' style="color:#1d70b8;font-weight:700"'; return ' style="color:#00703c;font-weight:700"'; };
  const estRows = [est.self, est.average].filter(c => c && c.n > 0);
  document.querySelector('#estimation-table tbody').innerHTML = estRows.map(c =>
    '<tr><td><strong>'+c.label+'</strong></td><td class="num">'+c.n+'</td><td class="num">'+fmtSec(c.meanEstimateSec)+'</td><td class="num">'+fmtSec(c.medianEstimateSec)+'</td><td class="num">'+fmtSec(est.actualMeanSec)+'</td><td class="num">'+fmtSec(est.actualMedianSec)+'</td><td class="num"'+ratioColor(c.meanRatio)+'>'+c.meanRatio+'</td><td class="num">'+c.meanConfidence+' / 5</td></tr>'
  ).join('') || '<tr><td colspan="8">No estimation data yet</td></tr>';

  // Self-condition individual accuracy
  const acc = est.selfAccuracy;
  if (acc) {
    const biasDir = acc.meanSignedBiasSec > 0 ? 'overestimation' : acc.meanSignedBiasSec < 0 ? 'underestimation' : 'no bias';
    const biasColor = acc.meanSignedBiasSec > 0 ? 'amber' : acc.meanSignedBiasSec < 0 ? 'blue' : 'green';
    document.getElementById('self-accuracy').innerHTML =
      '<h3>Analysis 2: Self-Condition Individual Accuracy</h3>'+
      '<p class="help"><strong>What this does:</strong> For each participant in the <em>Self</em> condition, we compute: <code>error = their estimate &minus; their own actual procedure time</code>. This is a <strong>within-subject</strong> analysis — each person is compared to themselves, not to the group average. It answers: <em>Can people accurately perceive how long they personally spent?</em></p>'+
      '<p class="help"><strong>Why it matters:</strong> Analysis 1 compares group averages, which can hide individual errors that cancel out. This analysis reveals the typical magnitude of individual errors and whether people systematically overestimate or underestimate their own time.</p>'+
      '<div class="stats-grid">'+
        '<div class="stat stat--'+biasColor+'"><div class="stat-value">'+(acc.meanSignedBiasSec > 0 ? '+' : '')+fmtSec(Math.abs(acc.meanSignedBiasSec))+'</div><div class="stat-label">Mean Signed Error</div></div>'+
        '<div class="stat"><div class="stat-value">'+fmtSec(acc.meanAbsErrorSec)+'</div><div class="stat-label">Mean Absolute Error</div></div>'+
        '<div class="stat"><div class="stat-value">'+fmtSec(acc.medianAbsErrorSec)+'</div><div class="stat-label">Median Absolute Error</div></div>'+
        '<div class="stat"><div class="stat-value">'+acc.meanRatio+'x</div><div class="stat-label">Mean Ratio (est ÷ actual)</div></div>'+
      '</div>'+
      '<div class="legend" style="margin-top:12px">'+
        '<dl>'+
        '<dt>Mean Signed Error</dt><dd> — average of (estimate &minus; actual) across all self-condition participants. Positive = systematic overestimation, negative = systematic underestimation. Currently: <strong style="color:'+(biasColor==='amber'?'#b58105':biasColor==='blue'?'#1d70b8':'#00703c')+'">'+biasDir+'</strong>.</dd>'+
        '<dt>Mean Absolute Error</dt><dd> — average of |estimate &minus; actual|, ignoring direction. Shows how far off people are on average regardless of whether they over- or underestimate.</dd>'+
        '<dt>Median Absolute Error</dt><dd> — same as above but using the median, which is more robust to outliers (one participant wildly off won&#39;t skew this).</dd>'+
        '<dt>Mean Ratio</dt><dd> — average of (estimate ÷ actual). A value of 1.00x = perfect accuracy, 1.50x = people estimate 50% more than their real time, 0.70x = people estimate 30% less.</dd>'+
        '</dl>'+
      '</div>'+
      '<p class="help" style="margin-top:8px"><strong>Direction breakdown (N='+acc.n+'):</strong> '+acc.overPct+'% overestimated their time ('+acc.overestimators+'/'+acc.n+'), '+acc.underPct+'% underestimated ('+acc.underestimators+'/'+acc.n+')'+(acc.exact > 0 ? ', '+acc.exact+' were exact' : '')+'.</p>';
  } else {
    document.getElementById('self-accuracy').innerHTML =
      '<h3>Analysis 2: Self-Condition Individual Accuracy</h3>'+
      '<p class="help"><strong>What this will do:</strong> For each participant in the <em>Self</em> condition, this analysis computes <code>error = their estimate &minus; their own actual procedure time</code>. This is a within-subject comparison — each person compared to themselves. It will show whether people systematically overestimate or underestimate their own time, and by how much.</p>'+
      '<p class="help">No self-condition estimation data yet.</p>';
  }

  // Between-condition comparison
  const cmp = est.conditionComparison;
  if (cmp) {
    const selfErr = cmp.selfErrorVsActualMean;
    const avgErr = cmp.avgErrorVsActualMean;
    const closer = cmp.closerCondition;
    let verdictHtml = '';
    if (closer && selfErr != null && avgErr != null) {
      const verdictColor = closer === 'Self' ? 'color:#1d70b8' : closer === 'Average' ? 'color:#00703c' : 'color:#505a5f';
      verdictHtml = '<p class="help" style="margin-top:10px"><strong style="'+verdictColor+'">'+
        (closer === 'Tied' ? 'Both conditions are equally close to actual time.' :
        'The <em>'+closer+'</em> condition is closer to the actual mean procedure time.')+
        '</strong> Self-condition mean is off by '+fmtSec(selfErr)+', Average-condition mean is off by '+fmtSec(avgErr)+'.</p>';
    }
    document.getElementById('condition-comparison').innerHTML =
      '<h3>Between-Condition Comparison</h3>'+
      '<p class="help">Which framing produces estimates closer to the actual procedure time? Compares each condition&#39;s mean estimate to the actual mean time across all exploitable sessions.</p>'+
      '<div class="stats-grid">'+
        (selfErr != null ? '<div class="stat'+(closer==='Self'?' stat--blue':'')+'"><div class="stat-value">'+fmtSec(selfErr)+'</div><div class="stat-label">Self: distance from actual mean</div></div>' : '')+
        (avgErr != null ? '<div class="stat'+(closer==='Average'?' stat--green':'')+'"><div class="stat-value">'+fmtSec(avgErr)+'</div><div class="stat-label">Average: distance from actual mean</div></div>' : '')+
      '</div>'+verdictHtml;
  }

  // Confidence distribution table
  const confDist = est.confidenceDistribution || [];
  const confLabels = {1:'1 — Not at all confident', 2:'2', 3:'3 — Moderately confident', 4:'4', 5:'5 — Extremely confident'};
  document.querySelector('#confidence-dist-table tbody').innerHTML = confDist.map(c =>
    '<tr><td>'+confLabels[c.level]+'</td><td class="num">'+c.self+'</td><td class="num">'+c.average+'</td><td class="num"><strong>'+c.total+'</strong></td></tr>'
  ).join('') || '<tr><td colspan="4">No data yet</td></tr>';

  // Confidence × accuracy (self-condition only)
  const confAcc = est.confidenceAccuracy;
  if (confAcc && confAcc.length > 0) {
    const maxErr = Math.max(...confAcc.map(c => c.meanAbsErrorSec), 1);
    document.getElementById('confidence-accuracy').innerHTML =
      '<h3>Analysis 4: Does Confidence Predict Accuracy? (Self-Condition)</h3>'+
      '<p class="help">For self-condition participants only: does reporting higher confidence correspond to a more accurate estimate? Shows the mean absolute error (estimate minus actual time) at each confidence level. Lower error = more accurate.</p>'+
      '<table><thead><tr><th>Confidence Level</th><th>N</th><th>Mean Absolute Error</th><th></th></tr></thead><tbody>'+
      confAcc.map(c => {
        const barW = Math.round(c.meanAbsErrorSec / maxErr * 100);
        const color = c.meanAbsErrorSec < maxErr * 0.5 ? 'green' : c.meanAbsErrorSec < maxErr * 0.8 ? 'amber' : 'red';
        return '<tr><td>'+confLabels[c.level]+'</td><td class="num">'+c.n+'</td><td class="num">'+fmtSec(c.meanAbsErrorSec)+'</td><td><span class="bar bar--'+color+'" style="width:'+barW+'%">&nbsp;</span></td></tr>';
      }).join('')+
      '</tbody></table>'+
      '<p class="help" style="margin-top:8px;font-size:12px;color:#505a5f">If confidence tracks accuracy, higher confidence levels should show smaller errors. A flat pattern suggests metacognitive miscalibration — people feel confident but aren&#39;t actually more accurate.</p>';
  } else {
    document.getElementById('confidence-accuracy').innerHTML =
      '<h3>Analysis 4: Does Confidence Predict Accuracy? (Self-Condition)</h3>'+
      '<p class="help">Not enough self-condition data yet (minimum 3 participants needed). This analysis will show whether more confident participants estimate more accurately.</p>';
  }

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
