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

    const headers = [...baseHeaders, ...pageTimingHeaders, ...docHeaders, ...errorByPageHeaders, ...formFieldHeaders];

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

// Completion status:
// - "complete" : reached the final completion page
// - "partial"  : submitted the application (passed application_submitted) but did not finish post-task
// - "incomplete": did not even submit the application
function getCompletionStatus(session) {
  if (session.is_complete) return 'complete';
  const pageIndex = session.currentPageIndex || 0;
  // application_submitted is page index 14 in the standard order (0-indexed)
  // We check if they have pageTimings past the declaration page
  if (session.pageTimings && Array.isArray(session.pageTimings)) {
    const visitedPages = new Set(session.pageTimings.map(pt => pt.pageId));
    if (visitedPages.has('application_submitted')) return 'partial';
  }
  // Also check by currentPageIndex — application_submitted is index 14 in the procedure
  if (pageIndex >= 14) return 'partial';
  return 'incomplete';
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

    // Classify sessions
    const classified = all.map(s => ({ ...s, completion_status: getCompletionStatus(s), last_page: getLastPage(s) }));
    const complete = classified.filter(s => s.completion_status === 'complete');
    const partial = classified.filter(s => s.completion_status === 'partial');
    const incomplete = classified.filter(s => s.completion_status === 'incomplete');
    // Dashboard shows complete + partial only
    const usable = [...complete, ...partial];

    // Averages only from complete sessions (per user's request)
    const avgDur = complete.length ? complete.reduce((s,c) => s + (c.totalDurationMs || c.total_duration_ms || 0), 0) / complete.length : 0;
    const avgAppDur = complete.length ? complete.reduce((s,c) => s + (c.applicationDurationMs || 0), 0) / complete.length : 0;
    const avgErrors = complete.length ? complete.reduce((s,c) => s + (c.totalErrors || c.total_errors || 0), 0) / complete.length : 0;
    const avgDocTime = complete.length ? complete.reduce((s,c) => s + (c.totalDocTimeMs || 0), 0) / complete.length : 0;
    const avgDocOpens = complete.length ? complete.reduce((s,c) => s + (c.totalDocOpens || 0), 0) / complete.length : 0;

    // Per-page stats (only from complete sessions)
    const pageStats = {};
    PAGE_ORDER.forEach(pid => { pageStats[pid] = { totalTime: 0, nTime: 0, totalErrors: 0, nWithErrors: 0, nTotal: 0 }; });

    complete.forEach(s => {
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

    // Document stats (complete sessions only)
    const docAccum = {};
    complete.forEach(s => {
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
      viewedByPct: complete.length ? Math.round(d.sessions.size / complete.length * 100) : 0,
      uniqueViewers: d.sessions.size,
    }));

    // Drop-off: where incomplete/partial participants stopped
    const dropOff = {};
    [...incomplete, ...partial].forEach(s => {
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

    res.json({
      total_sessions: all.length,
      complete_sessions: complete.length,
      partial_sessions: partial.length,
      incomplete_sessions: incomplete.length,
      consented_sessions: all.filter(s => s.consent_given).length,
      avg_total_duration_formatted: fmt(avgDur),
      avg_task_duration_formatted: fmt(avgAppDur),
      avg_errors: avgErrors.toFixed(1),
      avg_doc_time_formatted: fmt(avgDocTime),
      avg_doc_opens: avgDocOpens.toFixed(1),
      page_stats: pageStatsArr,
      doc_stats: docStats,
      drop_off: dropOffArr,
    });
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
.stats-grid{display:flex;flex-wrap:wrap;gap:10px;margin:15px 0}
.stat{background:#f3f2f1;padding:15px 25px;border-radius:8px;min-width:130px}
.stat-value{font-size:26px;font-weight:700;color:#1d70b8}.stat-label{font-size:12px;color:#505a5f}
.stat--green .stat-value{color:#00703c}
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
.badge{display:inline-block;background:#1d70b8;color:white;padding:2px 8px;border-radius:10px;font-size:11px;margin-left:5px}
.help{font-size:12px;color:#505a5f;margin-top:3px}
.bar{height:18px;border-radius:2px;display:inline-block;vertical-align:middle}
.bar--red{background:#d4351c}.bar--amber{background:#f47738}.bar--green{background:#00703c}
td.num{text-align:right;font-variant-numeric:tabular-nums}
</style></head>
<body>
<h1>Sludge Experiment Dashboard</h1>
<p class="subtitle">Averages computed from <strong>complete</strong> sessions only. Partial and incomplete sessions excluded from timing/error stats.</p>

<div id="overview" class="stats-grid"></div>

<h2>Per-Page Breakdown</h2>
<p class="help">Avg time and errors from complete sessions. Pages grouped by procedure section.</p>
<table id="page-table">
  <thead><tr><th>Page</th><th>Avg Time</th><th>N</th><th>Avg Errors</th><th>% with Errors</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Document Interactions</h2>
<table id="doc-table">
  <thead><tr><th>Document</th><th>Viewers</th><th>% Viewed</th><th>Total Opens</th><th>Avg View Time</th></tr></thead>
  <tbody></tbody>
</table>

<h2>Drop-off Analysis</h2>
<p class="help">Where incomplete/partial participants stopped. Helps identify problematic pages.</p>
<table id="dropoff-table">
  <thead><tr><th>Last Page Reached</th><th>Participants</th><th>Visual</th></tr></thead>
  <tbody></tbody>
</table>

<div class="export">
<h2 style="border:none;margin-top:0">Export Data</h2>
<p><a href="/api/export/csv?key=${EXPORT_KEY}"><strong>Download CSV (one row per participant)</strong></a> &mdash; includes <code>completion_status</code> (complete / partial / incomplete) and <code>last_page</code></p>
<p><a href="/api/export/all/json?key=${EXPORT_KEY}"><strong>All data (JSON)</strong></a></p>
<p>Individual tables:
<a href="/api/export/sessions?key=${EXPORT_KEY}">Sessions</a> |
<a href="/api/export/page_events?key=${EXPORT_KEY}">Pages</a> |
<a href="/api/export/form_responses?key=${EXPORT_KEY}">Responses</a> |
<a href="/api/export/document_events?key=${EXPORT_KEY}">Documents</a> |
<a href="/api/export/validation_events?key=${EXPORT_KEY}">Validation</a>
</p>
<p>CSV: append <code>&format=csv</code> to any table URL</p>
</div>

<h3>Import into R</h3>
<pre>library(jsonlite)
data &lt;- fromJSON("http://YOUR_SERVER/api/export/all/json?key=${EXPORT_KEY}")
sessions &lt;- data$$sessions
# Or flat CSV:
df &lt;- read.csv("http://YOUR_SERVER/api/export/csv?key=${EXPORT_KEY}")</pre>

<h3>Import into Python</h3>
<pre>import requests, pandas as pd
data = requests.get("http://YOUR_SERVER/api/export/all/json?key=${EXPORT_KEY}").json()
sessions = pd.DataFrame(data["sessions"])
# Or flat CSV:
df = pd.read_csv("http://YOUR_SERVER/api/export/csv?key=${EXPORT_KEY}")</pre>

<script>
const K = '${EXPORT_KEY}';
const fmt = ms => { if (!ms) return '0s'; const s = Math.floor(ms/1000); const m = Math.floor(s/60); return m > 0 ? m+'m '+s%60+'s' : s+'s'; };

// Section groupings for page table
const SECTIONS = {
  'Consent': 'Consent',
  'Instructions': 'Instructions', 'Confirm instructions': 'Instructions',
  'Applicant details': 'Applicant Details',
  'Eligibility rules': 'Eligibility', 'Eligibility decision': 'Eligibility',
  'Upload eligibility docs': 'Eligibility', 'Upload residence docs': 'Eligibility',
  'Vehicle information': 'Vehicle Details', 'Vehicle category': 'Vehicle Details',
  'Vehicle fuel type': 'Vehicle Details', 'Vehicle environmental class': 'Vehicle Details',
  'Declaration': 'Declaration',
  'Application submitted': 'Post-Task',
  'Demographics': 'Post-Task', 'Attention check': 'Post-Task',
  'Feedback': 'Post-Task', 'Debrief': 'Post-Task', 'Completion': 'Post-Task',
};

fetch('/api/stats?key='+K).then(r=>r.json()).then(s=>{
  // Overview cards
  const total = s.total_sessions || 0;
  const comp = s.complete_sessions || 0;
  const part = s.partial_sessions || 0;
  const incomp = s.incomplete_sessions || 0;
  const rate = total > 0 ? (comp/total*100).toFixed(0)+'%' : '0%';

  document.getElementById('overview').innerHTML = [
    ['Total Sessions', total, ''],
    ['Complete', comp, 'green'],
    ['Partial', part, 'amber'],
    ['Incomplete', incomp, 'red'],
    ['Completion Rate', rate, ''],
    ['Avg Task Time', s.avg_task_duration_formatted, ''],
    ['Avg Total Time', s.avg_total_duration_formatted, ''],
    ['Avg Errors', s.avg_errors, ''],
    ['Avg Doc Time', s.avg_doc_time_formatted, ''],
    ['Avg Doc Opens', s.avg_doc_opens, ''],
  ].map(([l,v,c])=>'<div class="stat'+(c?' stat--'+c:'')+'"><div class="stat-value">'+v+'</div><div class="stat-label">'+l+'</div></div>').join('');

  // Page table with section headers
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
  const drop = s.drop_off || [];
  const maxDrop = Math.max(...drop.map(d=>d.count), 1);
  document.querySelector('#dropoff-table tbody').innerHTML = drop.map(d => {
    const pct = Math.round(d.count/maxDrop*100);
    return '<tr><td>'+d.pageName+'</td><td class="num">'+d.count+'</td><td><span class="bar bar--red" style="width:'+pct+'%">&nbsp;</span></td></tr>';
  }).join('') || '<tr><td colspan="3">No drop-offs recorded</td></tr>';
});
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
