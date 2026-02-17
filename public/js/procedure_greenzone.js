/**
 * PROCEDURE: Municipal Green Zone Vehicle Access Permit
 * 
 * Converted from Qualtrics survey (Sludge-Exp) into a realistic
 * government-style web application for behavioral research.
 * 
 * FLOW:
 * 1. Research consent
 * 2. Task instructions (role-play briefing, document access)
 * 3. Application: Applicant Details
 * 4. Application: Eligibility Assessment (rules + decision + doc uploads)
 * 5. Application: Vehicle Details
 * 6. Application: Declaration & Submit
 * 7. Post-task: Demographics
 * 8. Post-task: Attention check
 * 9. Post-task: Feedback & debrief
 * 10. Completion + Prolific redirect
 */

// ============================================================
// FICTIONAL DOCUMENTS (embedded as viewable pages)
// ============================================================
// Instead of external Google Drive links, documents are built into
// the app for reliable tracking and no third-party dependencies.

const APPLICANT_DOCUMENTS = [
  { id: 'driving_license',    name: 'Municipal Driving License',             image: '/images/driving_license.png' },
  { id: 'vehicle_registration', name: 'Vehicle Registration Certificate',    image: '/images/vehicle_registration.png' },
  { id: 'insurance_cert',     name: 'Vehicle Insurance Certificate',         image: '/images/insurance_certificate.png' },
  { id: 'technical_inspection', name: 'Vehicle Technical Inspection Report', image: '/images/technical_inspection.png' },
  { id: 'electricity_bill',   name: 'Electricity Bill (proof of residence)', image: '/images/electricity_bill.png' },
  { id: 'water_bill',         name: 'Water Bill (proof of residence)',       image: '/images/water_bill.png' },
];

// Build the documents panel HTML with data attributes for tracking
function buildDocumentsPanel() {
  let html = '<div class="documents-panel">';
  html += '<div class="documents-panel-header">';
  html += '<span class="documents-panel-icon">📁</span>';
  html += '<span>Applicant\'s Documents</span>';
  html += '<button class="documents-panel-toggle" onclick="toggleDocumentsPanel()" aria-label="Toggle documents panel">−</button>';
  html += '</div>';
  html += '<div class="documents-panel-body" id="documents-panel-body">';
  APPLICANT_DOCUMENTS.forEach((doc) => {
    html += `<details class="document-accordion" data-doc-id="${doc.id}">`;
    html += `<summary class="document-accordion-title">${doc.name}</summary>`;
    html += `<div class="document-accordion-content">`;
    html += `<img src="${doc.image}" alt="${doc.name}" style="width:100%; height:auto; display:block; border-radius:4px;" onclick="openDocDrawer('${doc.image}', '${doc.name.replace(/'/g, "\\'")}')">`;
    html += `<div class="doc-zoom-hint">Click to view alongside form</div>`;
    html += `</div>`;
    html += '</details>';
  });
  html += '</div></div>';
  return html;
}

// Document Drawer: slide-out panel on the right — form stays fully interactive
// Includes zoom controls (+/−/reset) and Ctrl+scroll zoom
window.openDocDrawer = function(src, title) {
  // Close any existing drawer first
  const existingDrawer = document.querySelector('.doc-drawer');
  if (existingDrawer) existingDrawer.remove();

  let zoomLevel = 1;
  const minZoom = 0.5;
  const maxZoom = 4;
  const zoomStep = 0.25;

  const drawer = document.createElement('div');
  drawer.className = 'doc-drawer';
  drawer.innerHTML = `
    <div class="doc-drawer__header">
      <span class="doc-drawer__title">${title}</span>
      <div class="doc-drawer__controls">
        <button class="doc-drawer__zoom-btn" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">\u2212</button>
        <span class="doc-drawer__zoom-level">100%</span>
        <button class="doc-drawer__zoom-btn" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
        <button class="doc-drawer__zoom-btn" data-action="zoom-reset" aria-label="Fit to width" title="Fit to width">\u21BA</button>
        <button class="doc-drawer__close" aria-label="Close document viewer">&times;</button>
      </div>
    </div>
    <div class="doc-drawer__content">
      <img src="${src}" alt="${title}">
    </div>
  `;

  document.body.appendChild(drawer);

  const img = drawer.querySelector('.doc-drawer__content img');
  const content = drawer.querySelector('.doc-drawer__content');
  const levelDisplay = drawer.querySelector('.doc-drawer__zoom-level');

  function updateZoom() {
    img.style.width = (zoomLevel * 100) + '%';
    levelDisplay.textContent = Math.round(zoomLevel * 100) + '%';
  }

  drawer.querySelector('[data-action="zoom-in"]').addEventListener('click', () => {
    zoomLevel = Math.min(maxZoom, zoomLevel + zoomStep);
    updateZoom();
  });

  drawer.querySelector('[data-action="zoom-out"]').addEventListener('click', () => {
    zoomLevel = Math.max(minZoom, zoomLevel - zoomStep);
    updateZoom();
  });

  drawer.querySelector('[data-action="zoom-reset"]').addEventListener('click', () => {
    zoomLevel = 1;
    updateZoom();
  });

  // Ctrl+scroll wheel zoom (regular scroll pans the document)
  content.addEventListener('wheel', function(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomLevel = Math.min(maxZoom, zoomLevel + zoomStep);
      } else {
        zoomLevel = Math.max(minZoom, zoomLevel - zoomStep);
      }
      updateZoom();
    }
  }, { passive: false });

  // Trigger slide-in animation
  requestAnimationFrame(() => {
    drawer.classList.add('doc-drawer--open');
  });

  const close = () => {
    drawer.classList.remove('doc-drawer--open');
    setTimeout(() => { drawer.remove(); }, 250);
  };

  drawer.querySelector('.doc-drawer__close').addEventListener('click', close);
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
  });
};

// Toggle function for collapsing the entire panel
window.toggleDocumentsPanel = function() {
  const body = document.getElementById('documents-panel-body');
  const btn = document.querySelector('.documents-panel-toggle');
  if (body) {
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    btn.textContent = isHidden ? '−' : '+';
  }
};


// ============================================================
// PROCEDURE DEFINITION
// ============================================================

const GREENZONE_PROCEDURE = {
  id: 'greenzone_permit_v1',
  title: 'Municipal Green Zone Vehicle Access Permit',
  version: '1.0',

  // Prolific completion URL — set this before deploying
  prolificCompletionUrl: 'https://app.prolific.com/submissions/complete?cc=XXXXXXX',

  // Stepper: only show these sections in the progress stepper
  stepperSections: ['Applicant details', 'Eligibility', 'Vehicle details', 'Declaration', 'Submit'],

  // Show documents panel on application pages
  showDocumentsPanel: true,
  documentsPanelHtml: buildDocumentsPanel(),
  documentsPanelPages: [
    'applicant_details', 'eligibility_rules', 'eligibility_decision',
    'doc_upload_eligibility', 'doc_upload_residence',
    'vehicle_info', 'vehicle_category', 'vehicle_fuel',
    'vehicle_env_class', 'declaration'
  ],

  pages: [
    // ============================================================
    // RESEARCH CONSENT
    // ============================================================
    {
      id: 'consent',
      type: 'consent',
      title: 'Research Participation — Informed Consent',
      body: `
        <p class="gov-body">You are invited to participate in a scientific experiment. Participation requires that you provide your informed consent.</p>
        <p class="gov-body">Before proceeding, please consider the following information:</p>
        <div class="gov-inset-text">
          <p class="gov-body">In this study, you will complete a short online task that simulates an administrative procedure. The task involves reading instructions, consulting fictional documents, and answering a series of questions.</p>
          <p class="gov-body">There are no risks involved in this study.</p>
          <p class="gov-body">Your privacy will be fully respected, and all data will be collected and analysed anonymously.</p>
          <p class="gov-body">Participation in this study is voluntary. You may choose not to participate or to withdraw at any time without penalty.</p>
        </div>
        <p class="gov-body">By ticking the box below and proceeding to the study, you confirm that you have read this information and agree to participate under the conditions described above.</p>
      `,
      consentLabel: 'I agree to participate in this study.',
      buttonText: 'Continue',
    },

    // ============================================================
    // TASK INSTRUCTIONS
    // ============================================================
    {
      id: 'instructions',
      type: 'info',
      section: 'Instructions',
      title: 'Before you begin',
      customHtml: `
        <div class="gov-panel gov-panel--info" style="background: #f3f2f1; padding: 20px; margin-bottom: 20px;">
          <h2 class="gov-heading-m" style="margin-top: 0;">Application Context Notice</h2>
          <p class="gov-body">This task is part of a research study. You are <strong>not</strong> completing an application for yourself.</p>
          <p class="gov-body">You are asked to <strong>role-play a fictional individual</strong> and complete an administrative application <strong>on their behalf</strong>.</p>
        </div>

        <div class="gov-warning-text">
          <span class="gov-warning-text__icon" aria-hidden="true">!</span>
          <strong class="gov-warning-text__text">
            For this task, you must not enter any of your own personal information (such as your name, address, identification number, or vehicle details). All information entered in the form must correspond only to the fictional person described in the documents provided to you.
          </strong>
        </div>

        <h2 class="gov-heading-m">Scenario</h2>
        <p class="gov-body">A fictional resident and vehicle owner has been informed that continued access to designated low-emission areas (known as "Green Zones") now requires prior authorisation.</p>
        <p class="gov-body">As part of your role, you are completing this application <strong>as if you were this fictional individual</strong>, using their official documents.</p>

        <h2 class="gov-heading-m">Documents provided</h2>
        <p class="gov-body">You have access to fictional official documents belonging to this individual. These documents are the <strong>only valid source of information</strong> for completing the application.</p>
        <p class="gov-body">The documents will appear in a panel on the right-hand side of the screen (or below on mobile devices) once you begin the application. You can expand and collapse individual documents as needed.</p>

        <h2 class="gov-heading-m">Your task</h2>
        <ol class="gov-list gov-list--number">
          <li>Review the fictional documents carefully.</li>
          <li>Enter the requested information into the application form <strong>exactly as it appears in the documents</strong>.</li>
          <li>Use the same wording, numbers, dates, and formats shown in the documents.</li>
        </ol>

        <div class="gov-warning-text">
          <span class="gov-warning-text__icon" aria-hidden="true">!</span>
          <strong class="gov-warning-text__text">
            Do not use your own personal details at any point.
          </strong>
        </div>
      `,
      buttonText: 'Continue',
    },

    {
      id: 'confirm_instructions',
      type: 'form',
      section: 'Instructions',
      title: 'Confirm your understanding',
      body: '<p class="gov-body">Before proceeding, please confirm that you understand the instructions.</p>',
      fields: [
        {
          name: 'confirm_instructions',
          label: '',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'confirmed', label: 'I confirm that I understand the task. I will provide information extracted from the fictional documents only and will not enter any personal or personally identifiable information.' }
          ],
          errorMessage: 'You must confirm that you understand the instructions to continue.'
        }
      ],
      buttonText: 'Begin the application',
    },

    // ============================================================
    // APPLICATION: APPLICANT DETAILS
    // ============================================================
    {
      id: 'applicant_details',
      type: 'form',
      section: 'Applicant details',
      allowBack: true,
      title: 'Your personal details',
      body: '<p class="gov-body">Please provide your personal details as they appear on the official identification document. Inconsistent or incorrect information may result in delays or rejection of your application.</p>',
      fields: [
        {
          name: 'first_name',
          label: 'First name',
          type: 'text',
          required: true,
          width: 'two-thirds',
          autocomplete: 'off',
        },
        {
          name: 'last_name',
          label: 'Last name',
          type: 'text',
          required: true,
          width: 'two-thirds',
          autocomplete: 'off',
        },
        {
          name: 'date_of_birth',
          label: 'Date of birth',
          type: 'date_group',
          required: true,
          hint: 'For example, 15 03 1985. Enter the date as shown on the identification document.',
          errorMessage: 'Enter a complete date of birth',
        },
        {
          name: 'national_id',
          label: 'National ID number',
          type: 'text',
          required: true,
          hint: 'This is shown on your National Identity Card. Use the format ID-XXXXXX.',
          width: 'one-third',
          autocomplete: 'off',
          pattern: '^ID-\\d{6}$',
          patternMessage: 'Enter a valid National ID number in the format ID-XXXXXX (for example, ID-123456)',
        },
      ],
    },

    // ============================================================
    // APPLICATION: ELIGIBILITY
    // ============================================================
    {
      id: 'eligibility_rules',
      type: 'info',
      section: 'Eligibility',
      allowBack: true,
      title: 'Eligibility and documentation standards',
      customHtml: `
        <div class="gov-inset-text" style="border-left-color: #1d70b8;">
          <p class="gov-body" style="margin-bottom: 4px;"><strong>Please read the following rules carefully before proceeding.</strong></p>
          <p class="gov-body" style="margin-bottom: 0;">You will be asked to determine whether the applicant is eligible based on these criteria.</p>
        </div>

        <h2 class="gov-heading-m">1. General prerequisites</h2>
        <p class="gov-body">Possession of a valid insurance policy is a mandatory prerequisite for obtaining an Access Permit. Applicants must provide proof of valid insurance coverage at the time of application. Vehicles lacking valid insurance coverage are ineligible to apply for this permit under any circumstances.</p>

        <h2 class="gov-heading-m">2. Automatically authorised vehicle categories</h2>
        <p class="gov-body">The following vehicle categories are automatically authorised for Green Zone access. Owners of these vehicles <strong>must not submit an application</strong> for this permit:</p>
        <ul class="gov-list gov-list--bullet">
          <li>Electric vehicles</li>
          <li>Hydrogen fuel vehicles</li>
          <li>Vehicles exceeding 30 years of age</li>
          <li>Vehicles registered to persons with recognised disabilities</li>
        </ul>

        <h2 class="gov-heading-m">3. Vehicles not eligible for this permit</h2>
        <p class="gov-body">Vehicles with a registration date <strong>on or after 1 January 2018</strong> fall under a separate regulatory framework and are <strong>not eligible</strong> for this specific permit.</p>

        <h2 class="gov-heading-m">4. Vehicles required to apply</h2>
        <p class="gov-body">Vehicles registered <strong>before 1 January 2018</strong> are required to apply and must provide proof of the registration date.</p>
        <p class="gov-body">Vehicles with a <strong>hybrid fuel type</strong> must also provide an additional technical report.</p>
      `,
      buttonText: 'Continue',
    },

    {
      id: 'eligibility_decision',
      type: 'form',
      section: 'Eligibility',
      allowBack: true,
      title: 'Eligibility assessment',
      body: '<p class="gov-body">Based on the information provided in the case file and the eligibility rules on the previous page, determine whether the applicant is eligible for the Municipal Green Zone Vehicle Access Permit.</p>',
      fields: [
        {
          name: 'is_eligible',
          label: 'Is the applicant eligible for the permit?',
          type: 'radio',
          required: true,
          options: [
            { value: 'yes', label: 'Yes — the applicant is eligible' },
            { value: 'no', label: 'No — the applicant is not eligible' },
          ],
        },
      ],
    },

    {
      id: 'doc_upload_eligibility',
      type: 'form',
      section: 'Eligibility',
      allowBack: true,
      title: 'Supporting documents — eligibility',
      body: `
        <p class="gov-body">Please select the documents that demonstrate compliance with the eligibility and documentation standards described in the rules.</p>
        <p class="gov-body">You may select one or more documents. Only documents relevant to the applicant's vehicle should be provided.</p>
        <div class="gov-warning-text">
          <span class="gov-warning-text__icon" aria-hidden="true">!</span>
          <strong class="gov-warning-text__text">
            Providing incomplete or incorrect documentation may result in the application being rejected or delayed.
          </strong>
        </div>
      `,
      fields: [
        {
          name: 'eligibility_documents',
          label: 'Select the relevant documents to upload',
          type: 'checkbox',
          required: true,
          hint: 'Select all documents that are relevant to demonstrating eligibility.',
          options: [
            { value: 'vehicle_registration', label: 'Vehicle Registration Certificate' },
            { value: 'driving_licence', label: 'Driving Licence' },
            { value: 'insurance_certificate', label: 'Insurance Certificate' },
            { value: 'technical_inspection', label: 'Vehicle Technical Inspection Report' },
            { value: 'water_bill', label: 'Water bill' },
            { value: 'electricity_bill', label: 'Electricity bill' },
          ],
          errorMessage: 'Select at least one document to upload.',
        },
      ],
    },

    {
      id: 'doc_upload_residence',
      type: 'form',
      section: 'Eligibility',
      allowBack: true,
      title: 'Supporting documents — proof of residence',
      body: `
        <h2 class="gov-heading-m">Proof of residence</h2>
        <p class="gov-body">Please select the document you will submit as proof of residence.</p>
        <p class="gov-body">A valid proof of residence must show the applicant's current address and be issued within the last 3 months.</p>
      `,
      fields: [
        {
          name: 'residence_document',
          label: 'Select your proof of residence',
          type: 'radio',
          required: true,
          options: [
            { value: 'vehicle_registration', label: 'Vehicle Registration Certificate' },
            { value: 'driving_licence', label: 'Driving Licence' },
            { value: 'insurance_certificate', label: 'Insurance Certificate' },
            { value: 'technical_inspection', label: 'Vehicle Technical Inspection Report' },
            { value: 'water_bill', label: 'Water bill' },
            { value: 'electricity_bill', label: 'Electricity bill' },
          ],
        },
      ],
    },

    // ============================================================
    // APPLICATION: VEHICLE DETAILS
    // ============================================================
    {
      id: 'vehicle_info',
      type: 'form',
      section: 'Vehicle details',
      allowBack: true,
      title: 'Vehicle information',
      body: `
        <p class="gov-body">Please provide the details of the vehicle for which you are requesting the Municipal Green Zone Vehicle Access Permit.</p>
        <p class="gov-body">The information entered must correspond exactly to the vehicle registration document. Incomplete or inconsistent information may result in delays or rejection.</p>
      `,
      fields: [
        {
          name: 'vehicle_registration_number',
          label: 'Vehicle registration number',
          type: 'text',
          required: true,
          hint: 'Enter in the format shown on the registration certificate (for example, AB-123-CD).',
          width: 'one-third',
          autocomplete: 'off',
          pattern: '^[A-Z]{2}-\\d{3}-[A-Z]{2}$',
          patternMessage: 'Enter a valid registration number in the format AB-123-CD (for example, AB-123-CD)',
        },
        {
          name: 'vehicle_owner_type',
          label: 'Is the vehicle registered in the name of a private person or a company?',
          type: 'radio',
          required: true,
          options: [
            { value: 'company', label: 'Company' },
            { value: 'private', label: 'Private person' },
          ],
        },
      ],
    },

    {
      id: 'vehicle_category',
      type: 'form',
      section: 'Vehicle details',
      allowBack: true,
      title: 'Vehicle category',
      body: '<p class="gov-body">Please state the vehicle category <strong>only as indicated</strong> on the registration certificate.</p>',
      fields: [
        {
          name: 'vehicle_category',
          label: 'Vehicle category',
          type: 'radio',
          required: true,
          options: [
            { value: 'M1', label: 'M1 — Passenger car (up to 8 passengers + driver)' },
            { value: 'M2', label: 'M2 — Minibus (more than 8 passengers + driver, mass less than 5 tonnes)' },
            { value: 'M3', label: 'M3 — Bus (more than 8 passengers + driver, mass over 5 tonnes)' },
            { value: 'N1', label: 'N1 — Van (mass less than 3.5 tonnes)' },
            { value: 'N2', label: 'N2 — Light truck (mass between 3.5 and 12 tonnes)' },
            { value: 'N3', label: 'N3 — Truck (mass over 12 tonnes)' },
            { value: 'T', label: 'T — Agricultural or forestry vehicle' },
            { value: 'not_indicated', label: 'There is no vehicle category provided on my registration document' },
          ],
        },
      ],
    },

    {
      id: 'vehicle_fuel',
      type: 'form',
      section: 'Vehicle details',
      allowBack: true,
      title: 'Fuel type',
      body: '<p class="gov-body">Please state the fuel type <strong>only as indicated</strong> on the registration certificate.</p>',
      fields: [
        {
          name: 'vehicle_fuel_type',
          label: 'Fuel type',
          type: 'radio',
          required: true,
          options: [
            { value: 'petrol', label: 'Petrol' },
            { value: 'diesel', label: 'Diesel (gas oil)' },
            { value: 'lpg', label: 'LPG' },
            { value: 'electric', label: 'Electric' },
            { value: 'hybrid_petrol', label: 'Hybrid petrol (petrol + electricity)' },
            { value: 'hybrid_diesel', label: 'Hybrid diesel (diesel + electricity)' },
            { value: 'hybrid_synth', label: 'Hybrid Synth-Fuel' },
            { value: 'natural_gas', label: 'Natural gas' },
            { value: 'hydrogen', label: 'Hydrogen' },
            { value: 'bioethanol', label: 'Bio-ethanol' },
          ],
        },
      ],
    },

    {
      id: 'vehicle_env_class',
      type: 'form',
      section: 'Vehicle details',
      allowBack: true,
      title: 'Environmental classification',
      body: '<p class="gov-body">Please state the vehicle environmental classification <strong>as indicated</strong> on the vehicle registration document.</p>',
      fields: [
        {
          name: 'vehicle_env_classification',
          label: 'Environmental classification',
          type: 'radio',
          required: true,
          options: [
            { value: 'green_a', label: 'Green Category A' },
            { value: 'green_b', label: 'Green Category B' },
            { value: 'green_c', label: 'Green Category C' },
            { value: 'transitional', label: 'Transitional Category' },
            { value: 'not_indicated', label: 'Not indicated on document' },
            { value: 'z1', label: 'Class Z-1' },
            { value: 'z3', label: 'Class Z-3' },
          ],
        },
      ],
    },

    // ============================================================
    // DECLARATION
    // ============================================================
    {
      id: 'declaration',
      type: 'form',
      section: 'Declaration',
      allowBack: true,
      title: 'Declaration of accuracy',
      body: `
        <p class="gov-body">Before submitting your application, you must confirm the following.</p>
        <div class="gov-warning-text">
          <span class="gov-warning-text__icon" aria-hidden="true">!</span>
          <strong class="gov-warning-text__text">
            Any false declaration may result in the rejection of your application and may lead to further administrative consequences.
          </strong>
        </div>
      `,
      fields: [
        {
          name: 'declaration_accuracy',
          label: '',
          type: 'checkbox',
          required: true,
          options: [
            { value: 'confirmed', label: 'I confirm that the information provided in this application is complete and accurate and matches the official documents referenced.' },
            { value: 'acknowledge', label: 'I acknowledge that any false declaration may result in the rejection of my application.' },
          ],
          errorMessage: 'You must confirm both declarations to submit your application.',
        },
      ],
      buttonText: 'Submit application',
    },

    // ============================================================
    // APPLICATION SUBMITTED — TRANSITION TO POST-TASK
    // ============================================================
    {
      id: 'application_submitted',
      type: 'info',
      section: 'Submit',
      allowBack: true,
      title: 'Application submitted',
      customHtml: `
        <div class="gov-panel gov-panel--confirmation">
          <h1 class="gov-panel__title">Application submitted</h1>
          <div class="gov-panel__body">
            Reference number<br><strong>GZ-2025-00481</strong>
          </div>
        </div>
        <p class="gov-body">Your application for a Municipal Green Zone Vehicle Access Permit has been submitted. You will receive confirmation within 10 working days.</p>
        <hr class="gov-section-break gov-section-break--l gov-section-break--visible">
        <h2 class="gov-heading-m">Thank you</h2>
        <p class="gov-body">You have now finished the fictional application used in this study.</p>
        <p class="gov-body">The following questions are about <strong>you specifically</strong> and <strong>your background</strong>. They are not part of the fictional scenario.</p>
      `,
      buttonText: 'Continue to final questions',
    },

    // ============================================================
    // POST-TASK: DEMOGRAPHICS
    // ============================================================
    {
      id: 'demographics',
      type: 'form',
      section: 'About you',
      allowBack: true,
      title: 'A few questions about you',
      body: '<p class="gov-body">These questions are about you personally. They help us understand who participated in this study.</p>',
      fields: [
        {
          name: 'education_level',
          label: 'Highest level of education completed',
          type: 'radio',
          required: true,
          options: [
            { value: 'secondary', label: 'Secondary school or less' },
            { value: 'vocational', label: 'Vocational or technical training' },
            { value: 'bachelors', label: 'Bachelor\'s degree' },
            { value: 'masters', label: 'Master\'s degree' },
            { value: 'doctorate', label: 'Doctorate' },
          ],
        },
        {
          name: 'form_familiarity',
          label: 'In general, how often do you complete official forms or applications (for example, permits, registrations, benefits)?',
          type: 'radio',
          required: true,
          options: [
            { value: 'never', label: 'Never or almost never' },
            { value: 'few_years', label: 'Once every few years' },
            { value: 'yearly', label: 'About once a year' },
            { value: 'several_year', label: 'Several times a year' },
            { value: 'very_frequent', label: 'Very frequently' },
          ],
        },
        {
          name: 'driving_situation',
          label: 'Which of the following best describes your current situation regarding driving and car ownership?',
          type: 'radio',
          required: true,
          options: [
            { value: 'licence_car', label: 'I have a valid driving licence and own or have regular access to a car' },
            { value: 'licence_no_car', label: 'I have a valid driving licence but do not own or have access to a car' },
            { value: 'no_licence_car', label: 'I do not have a driving licence but have access to a car (for example, shared or household car)' },
            { value: 'no_licence_no_car', label: 'I do not have a driving licence and do not have access to a car' },
          ],
        },
      ],
    },

    // ============================================================
    // POST-TASK: ATTENTION CHECK
    // ============================================================
    {
      id: 'attention_check',
      type: 'form',
      section: 'About you',
      allowBack: true,
      title: 'A question for you',
      body: '<p class="gov-body">Now imagine you are playing video games with a friend and at some point your friend says:</p><div class="gov-inset-text"><p class="gov-body">"I don\'t want to play this game anymore! To make sure that you read the instructions, please write the three following words \'I pay attention\' in the box below. I really dislike this game."</p></div>',
      fields: [
        {
          name: 'attention_response',
          label: 'Do you agree with your friend?',
          type: 'text',
          required: true,
          width: 'two-thirds',
        },
      ],
    },

    // ============================================================
    // POST-TASK: FEEDBACK
    // ============================================================
    {
      id: 'feedback',
      type: 'form',
      section: 'Feedback',
      allowBack: true,
      title: 'Your experience',
      body: '<p class="gov-body">Please indicate how much you agree with the following statements about the procedure you just completed.</p>',
      fields: [
        {
          name: 'understanding',
          label: 'I clearly understood what I was asked to do in this task.',
          type: 'radio',
          required: true,
          inline: false,
          options: [
            { value: '1', label: 'Strongly disagree' },
            { value: '2', label: 'Disagree' },
            { value: '3', label: 'Somewhat disagree' },
            { value: '4', label: 'Neither agree nor disagree' },
            { value: '5', label: 'Somewhat agree' },
            { value: '6', label: 'Agree' },
            { value: '7', label: 'Strongly agree' },
          ],
        },
        {
          name: 'clarity',
          label: 'The instructions were clear and easy to follow.',
          type: 'radio',
          required: true,
          inline: false,
          options: [
            { value: '1', label: 'Strongly disagree' },
            { value: '2', label: 'Disagree' },
            { value: '3', label: 'Somewhat disagree' },
            { value: '4', label: 'Neither agree nor disagree' },
            { value: '5', label: 'Somewhat agree' },
            { value: '6', label: 'Agree' },
            { value: '7', label: 'Strongly agree' },
          ],
        },
        {
          name: 'confidence_completion',
          label: 'I am confident that I completed the task as the researchers intended.',
          type: 'radio',
          required: true,
          inline: false,
          options: [
            { value: '1', label: 'Strongly disagree' },
            { value: '2', label: 'Disagree' },
            { value: '3', label: 'Somewhat disagree' },
            { value: '4', label: 'Neither agree nor disagree' },
            { value: '5', label: 'Somewhat agree' },
            { value: '6', label: 'Agree' },
            { value: '7', label: 'Strongly agree' },
          ],
        },
      ],
    },

    {
      id: 'debrief',
      type: 'form',
      section: 'Feedback',
      allowBack: true,
      title: 'Debrief and feedback',
      body: `
        <p class="gov-body">This study is a pilot. Our main goal is to improve the task before running the full study.</p>
        <p class="gov-body">We would really appreciate any feedback you have — especially anything that was unclear, confusing, or could be improved. Your input is very helpful to us.</p>
      `,
      fields: [
        {
          name: 'debrief_feedback',
          label: 'Your feedback (optional)',
          type: 'textarea',
          required: false,
          rows: 6,
          hint: 'Please share anything about your experience: what worked, what was confusing, what you would change.',
        },
      ],
      buttonText: 'Finish',
    },

    // ============================================================
    // COMPLETION
    // ============================================================
    {
      id: 'completion',
      type: 'completion',
      title: 'Study complete',
      body: `
        <p class="gov-body">Thank you for taking part in this study. Your responses have been recorded.</p>
        <p class="gov-body">Please click the button below to return to Prolific and confirm your submission.</p>
      `,
      buttonText: 'Return to Prolific',
    },
  ],
};

// ============================================================
// CONDITION ROUTING
// ============================================================
// You can create variants by modifying the procedure above.
// For example, a SHORT version could skip some vehicle detail pages,
// or a MULTI-SESSION version could add a break point.

const GREENZONE_SHORT = { ...GREENZONE_PROCEDURE, id: 'greenzone_permit_short_v1' };
// Modify GREENZONE_SHORT.pages to remove pages for shorter version

// Export for use by the engine
window.PROCEDURE_CONFIGS = {
  default: GREENZONE_PROCEDURE,
  greenzone: GREENZONE_PROCEDURE,
  short: GREENZONE_SHORT,
  // Add more conditions as needed
};
