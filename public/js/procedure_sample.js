/**
 * SAMPLE PROCEDURE: Housing Support Benefit Application
 * 
 * This is a SAMPLE procedure to demonstrate the framework.
 * Replace this file with your actual procedure from the QSF export.
 * 
 * EXPERIMENTAL DESIGN NOTES:
 * - Each page has an ID for tracking
 * - Fields have names for data collection
 * - You can create multiple versions by modifying this config
 *   (e.g., long vs short, one-go vs multi-session, online-only vs mixed)
 * - Condition routing can be handled via URL params (?CONDITION=long)
 * 
 * TO ADD YOUR OWN PROCEDURE:
 * 1. Create a new file (e.g., procedure_tax_return.js)
 * 2. Define your pages array following this structure
 * 3. Update index.html to load your procedure file instead
 */

const SAMPLE_PROCEDURE = {
  id: 'housing_support_v1',
  title: 'Housing Support Benefit Application',
  version: '1.0',

  // Prolific completion URL (set this when deploying)
  prolificCompletionUrl: 'https://app.prolific.com/submissions/complete?cc=XXXXXXX',

  pages: [
    // ============================================================
    // INTRODUCTION
    // ============================================================
    {
      id: 'intro',
      type: 'intro',
      title: 'Apply for Housing Support Benefit',
      caption: 'Department of Social Services',
      body: `
        <p class="gov-body">Use this service to apply for Housing Support Benefit if you are a resident of Newland.</p>
        <p class="gov-body">Housing Support Benefit helps people on low incomes pay their rent. The amount you get depends on your income, savings, and housing costs.</p>
        <p class="gov-body">Applying takes approximately 15 to 25 minutes.</p>
      `,
      infoItems: [
        'Your national identification number',
        'Details of your income and savings',
        'Your rental agreement or lease',
        'Bank statements for the last 3 months',
        'Details of anyone else living in your home',
      ],
      warningText: 'You must complete this application in one session. Your progress cannot be saved.',
      buttonText: 'Start now',
    },

    // ============================================================
    // CONSENT (for research)
    // ============================================================
    {
      id: 'consent',
      type: 'consent',
      title: 'Research Participation Information',
      body: `
        <p class="gov-body"><strong>Important:</strong> This is a simulated government procedure created for research purposes. No real application will be submitted, and no real data will be processed by any government agency.</p>
        <p class="gov-body">We are studying how people experience administrative procedures. By continuing, you agree that:</p>
        <ul class="gov-list gov-list--bullet">
          <li>Your responses and behavioral data (such as time spent on each page) will be collected for research purposes</li>
          <li>All data will be anonymised and stored securely</li>
          <li>You may withdraw at any time by closing the browser window</li>
          <li>Your participation is voluntary</li>
        </ul>
        <p class="gov-body">This study has been approved by [Ethics Committee Name], reference [XXX-XXX].</p>
      `,
      consentLabel: 'I have read and understood the information above, and I agree to participate',
      buttonText: 'Continue to the procedure',
    },

    // ============================================================
    // SECTION 1: PERSONAL INFORMATION
    // ============================================================
    {
      id: 'personal_details',
      type: 'form',
      title: 'Your personal details',
      caption: 'Section 1 of 6',
      description: 'We need your personal information to process your application and verify your identity.',
      fields: [
        {
          name: 'title',
          type: 'select',
          label: 'Title',
          required: true,
          options: ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Other'],
          errorMessage: 'Select your title',
        },
        {
          name: 'first_name',
          type: 'text',
          label: 'First name',
          required: true,
          autocomplete: 'given-name',
          errorMessage: 'Enter your first name',
        },
        {
          name: 'middle_names',
          type: 'text',
          label: 'Middle name(s)',
          hint: 'If you have any middle names, enter all of them',
          required: false,
        },
        {
          name: 'last_name',
          type: 'text',
          label: 'Last name',
          required: true,
          autocomplete: 'family-name',
          errorMessage: 'Enter your last name',
        },
        {
          name: 'dob',
          type: 'date_group',
          label: 'Date of birth',
          hint: 'For example, 27 3 1990',
          required: true,
          errorMessage: 'Enter your date of birth',
        },
        {
          name: 'national_id',
          type: 'text',
          label: 'National Identification Number',
          hint: 'This is on your national ID card. It\'s a 12-digit number, for example 123 456 789 012. If you do not have this number, you can find it on your tax notice or by contacting the National Registry.',
          required: true,
          widthClass: 'gov-input--width-20',
          errorMessage: 'Enter your National Identification Number',
        },
      ],
      allowBack: false,
      buttonText: 'Continue',
    },

    // ============================================================
    // SECTION 2: CONTACT INFORMATION
    // ============================================================
    {
      id: 'contact_details',
      type: 'form',
      title: 'Your contact details',
      caption: 'Section 2 of 6',
      fields: [
        {
          name: 'email',
          type: 'email',
          label: 'Email address',
          hint: 'We will use this to send you updates about your application',
          required: true,
          autocomplete: 'email',
          errorMessage: 'Enter your email address',
        },
        {
          name: 'phone',
          type: 'tel',
          label: 'Phone number',
          hint: 'We may need to contact you about your application',
          required: true,
          autocomplete: 'tel',
          errorMessage: 'Enter your phone number',
        },
        {
          name: 'preferred_contact',
          type: 'radio',
          label: 'How would you prefer to be contacted?',
          required: true,
          options: [
            { value: 'email', label: 'Email' },
            { value: 'phone', label: 'Phone' },
            { value: 'post', label: 'Letter (post)' },
          ],
          errorMessage: 'Select your preferred contact method',
        },
      ],
      allowBack: true,
      buttonText: 'Continue',
    },

    // ============================================================
    // SECTION 3: ADDRESS
    // ============================================================
    {
      id: 'address',
      type: 'form',
      title: 'Your current address',
      caption: 'Section 3 of 6',
      description: 'Enter the address where you currently live and for which you are claiming Housing Support Benefit.',
      fields: [
        {
          name: 'address_line1',
          type: 'text',
          label: 'Address line 1',
          required: true,
          autocomplete: 'address-line1',
          errorMessage: 'Enter the first line of your address',
        },
        {
          name: 'address_line2',
          type: 'text',
          label: 'Address line 2 (optional)',
          required: false,
          autocomplete: 'address-line2',
        },
        {
          name: 'city',
          type: 'text',
          label: 'Town or city',
          required: true,
          autocomplete: 'address-level2',
          errorMessage: 'Enter your town or city',
        },
        {
          name: 'postcode',
          type: 'text',
          label: 'Postcode',
          required: true,
          widthClass: 'gov-input--width-10',
          autocomplete: 'postal-code',
          errorMessage: 'Enter your postcode',
        },
        {
          name: 'move_in_date',
          type: 'date_group',
          label: 'When did you move to this address?',
          hint: 'For example, 15 6 2022',
          required: true,
          errorMessage: 'Enter the date you moved to this address',
        },
      ],
      allowBack: true,
      buttonText: 'Continue',
    },

    // ============================================================
    // SECTION 4: HOUSING DETAILS (sludge-heavy section)
    // ============================================================
    {
      id: 'housing_info',
      type: 'info',
      title: 'About your housing costs',
      caption: 'Section 4 of 6',
      body: `
        <p class="gov-body">In this section, we need detailed information about your housing costs. Please have the following ready:</p>
        <ul class="gov-list gov-list--bullet">
          <li>Your current rent amount and payment frequency</li>
          <li>Details of any service charges included in your rent</li>
          <li>Your tenancy type and landlord details</li>
          <li>Whether you receive any housing-related discounts or subsidies</li>
        </ul>
        <div class="gov-warning-text">
          <span class="gov-warning-text__icon">!</span>
          <span>If you are unsure about any of these details, you should check your tenancy agreement or contact your landlord before continuing. Providing incorrect information may delay your application or result in overpayment recovery.</span>
        </div>
      `,
      allowBack: true,
      buttonText: 'Continue',
    },

    {
      id: 'housing_costs',
      type: 'form',
      title: 'Your housing costs',
      caption: 'Section 4 of 6',
      fields: [
        {
          name: 'tenancy_type',
          type: 'radio',
          label: 'What type of tenancy do you have?',
          hint: 'If you are unsure, check your tenancy agreement',
          required: true,
          options: [
            { value: 'social', label: 'Social housing (council or housing association)' },
            { value: 'private', label: 'Private rental' },
            { value: 'shared', label: 'Shared accommodation or house share' },
            { value: 'supported', label: 'Supported or sheltered housing' },
            { value: 'temporary', label: 'Temporary or emergency accommodation' },
            { value: 'other', label: 'Other' },
          ],
          errorMessage: 'Select your tenancy type',
        },
        {
          name: 'rent_amount',
          type: 'number',
          label: 'How much is your rent?',
          hint: 'Enter the amount in dollars, before any discounts. Do not include service charges.',
          required: true,
          widthClass: 'gov-input--width-10',
          errorMessage: 'Enter your rent amount',
        },
        {
          name: 'rent_frequency',
          type: 'radio',
          label: 'How often do you pay rent?',
          required: true,
          options: [
            { value: 'weekly', label: 'Weekly' },
            { value: 'fortnightly', label: 'Every 2 weeks' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'quarterly', label: 'Quarterly' },
          ],
          errorMessage: 'Select how often you pay rent',
        },
        {
          name: 'service_charges',
          type: 'radio',
          label: 'Does your rent include service charges?',
          hint: 'Service charges may include things like maintenance of communal areas, building insurance, or heating for shared spaces. Check your tenancy agreement if you are unsure.',
          required: true,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
            { value: 'unsure', label: 'I\'m not sure' },
          ],
          errorMessage: 'Select whether your rent includes service charges',
        },
        {
          name: 'service_charge_amount',
          type: 'number',
          label: 'If yes, how much are the service charges?',
          hint: 'Enter the amount per payment period. If you don\'t know the exact amount, provide your best estimate.',
          required: false,
          widthClass: 'gov-input--width-10',
        },
      ],
      allowBack: true,
      buttonText: 'Continue',
    },

    {
      id: 'landlord_details',
      type: 'form',
      title: 'Your landlord\'s details',
      caption: 'Section 4 of 6',
      description: 'We need your landlord\'s details to verify your tenancy and, if your application is approved, to arrange payment.',
      fields: [
        {
          name: 'landlord_name',
          type: 'text',
          label: 'Landlord or letting agent name',
          required: true,
          errorMessage: 'Enter your landlord\'s name',
        },
        {
          name: 'landlord_address',
          type: 'text',
          label: 'Landlord\'s address',
          required: true,
          errorMessage: 'Enter your landlord\'s address',
        },
        {
          name: 'landlord_phone',
          type: 'tel',
          label: 'Landlord\'s phone number (optional)',
          required: false,
        },
        {
          name: 'landlord_email',
          type: 'email',
          label: 'Landlord\'s email address (optional)',
          required: false,
        },
      ],
      allowBack: true,
      buttonText: 'Continue',
    },

    // ============================================================
    // SECTION 5: INCOME AND SAVINGS
    // ============================================================
    {
      id: 'income',
      type: 'form',
      title: 'Your income',
      caption: 'Section 5 of 6',
      hint: 'You must declare all sources of income. Failure to declare income may result in penalties and recovery of overpayments. Include income from employment, self-employment, benefits, pensions, investments, and any other regular payments.',
      fields: [
        {
          name: 'employment_status',
          type: 'radio',
          label: 'What is your employment status?',
          required: true,
          options: [
            { value: 'employed_ft', label: 'Employed full-time (30+ hours per week)' },
            { value: 'employed_pt', label: 'Employed part-time (less than 30 hours per week)' },
            { value: 'self_employed', label: 'Self-employed' },
            { value: 'unemployed', label: 'Unemployed and seeking work' },
            { value: 'retired', label: 'Retired' },
            { value: 'student', label: 'Full-time student' },
            { value: 'unable', label: 'Unable to work due to illness or disability' },
            { value: 'carer', label: 'Full-time carer' },
            { value: 'other', label: 'Other' },
          ],
          errorMessage: 'Select your employment status',
        },
        {
          name: 'gross_income',
          type: 'number',
          label: 'What is your total gross monthly income?',
          hint: 'This is your income before tax and other deductions. Include all sources: employment, benefits, pensions, and any other regular payments. If your income varies, provide an average of the last 3 months.',
          required: true,
          widthClass: 'gov-input--width-10',
          errorMessage: 'Enter your gross monthly income',
        },
        {
          name: 'net_income',
          type: 'number',
          label: 'What is your total net monthly income?',
          hint: 'This is your income after tax, national insurance, and pension contributions.',
          required: true,
          widthClass: 'gov-input--width-10',
          errorMessage: 'Enter your net monthly income',
        },
        {
          name: 'other_benefits',
          type: 'checkbox',
          label: 'Are you currently receiving any of the following benefits?',
          hint: 'Select all that apply',
          required: false,
          options: [
            { value: 'jobseeker', label: 'Jobseeker\'s Allowance' },
            { value: 'disability', label: 'Disability Living Allowance' },
            { value: 'childcare', label: 'Child Benefit or Childcare Support' },
            { value: 'pension_credit', label: 'Pension Credit' },
            { value: 'income_support', label: 'Income Support' },
            { value: 'none', label: 'None of the above' },
          ],
        },
      ],
      allowBack: true,
      buttonText: 'Continue',
    },

    {
      id: 'savings',
      type: 'form',
      title: 'Your savings and assets',
      caption: 'Section 5 of 6',
      description: 'We need to know about your savings and capital to assess your eligibility. If your total savings exceed $16,000, you may not be eligible for Housing Support Benefit.',
      fields: [
        {
          name: 'total_savings',
          type: 'number',
          label: 'What are your total savings?',
          hint: 'Include all bank accounts, building society accounts, ISAs, premium bonds, and any cash savings. Do not include the value of your home if you own one.',
          required: true,
          widthClass: 'gov-input--width-10',
          errorMessage: 'Enter your total savings',
        },
        {
          name: 'investments',
          type: 'radio',
          label: 'Do you have any investments (stocks, shares, bonds, or property other than your home)?',
          required: true,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
          errorMessage: 'Select whether you have investments',
        },
        {
          name: 'investment_value',
          type: 'number',
          label: 'If yes, what is the approximate total value of your investments?',
          required: false,
          widthClass: 'gov-input--width-10',
        },
      ],
      allowBack: true,
      buttonText: 'Continue',
    },

    // ============================================================
    // SECTION 6: HOUSEHOLD
    // ============================================================
    {
      id: 'household',
      type: 'form',
      title: 'People living in your home',
      caption: 'Section 6 of 6',
      description: 'Tell us about other people who live at the same address. This includes partners, children, and any other adults.',
      fields: [
        {
          name: 'household_size',
          type: 'radio',
          label: 'How many people live in your home in total (including you)?',
          required: true,
          options: [
            { value: '1', label: 'Just me' },
            { value: '2', label: '2 people' },
            { value: '3', label: '3 people' },
            { value: '4', label: '4 people' },
            { value: '5plus', label: '5 or more people' },
          ],
          errorMessage: 'Select the number of people in your household',
        },
        {
          name: 'has_partner',
          type: 'radio',
          label: 'Do you live with a partner?',
          hint: 'A partner is someone you are married to, in a civil partnership with, or living with as if you were married',
          required: true,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
          errorMessage: 'Select whether you live with a partner',
        },
        {
          name: 'dependent_children',
          type: 'radio',
          label: 'How many dependent children (under 18) live with you?',
          required: true,
          options: [
            { value: '0', label: 'None' },
            { value: '1', label: '1 child' },
            { value: '2', label: '2 children' },
            { value: '3plus', label: '3 or more children' },
          ],
          errorMessage: 'Select the number of dependent children',
        },
        {
          name: 'non_dependants',
          type: 'radio',
          label: 'Do any non-dependent adults (aged 18 or over who are not your partner) live with you?',
          hint: 'This includes adult children, friends, or lodgers. Non-dependants may affect the amount of benefit you receive.',
          required: true,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
          errorMessage: 'Select whether non-dependent adults live with you',
        },
      ],
      allowBack: true,
      buttonText: 'Continue',
    },

    // ============================================================
    // ADDITIONAL INFORMATION
    // ============================================================
    {
      id: 'additional_info',
      type: 'form',
      title: 'Additional information',
      description: 'Is there anything else we should know about your circumstances that may be relevant to your application?',
      fields: [
        {
          name: 'additional_circumstances',
          type: 'textarea',
          label: 'Additional circumstances (optional)',
          hint: 'For example, if you have a disability, are fleeing domestic violence, or have any other circumstances that affect your housing needs.',
          required: false,
          rows: 5,
        },
        {
          name: 'how_heard',
          type: 'select',
          label: 'How did you hear about this service?',
          required: true,
          options: [
            'Internet search',
            'Government website',
            'Advice service or charity',
            'Friend or family member',
            'Employer',
            'Healthcare professional',
            'Other',
          ],
          errorMessage: 'Select how you heard about this service',
        },
      ],
      allowBack: true,
      buttonText: 'Continue to review',
    },

    // ============================================================
    // REVIEW & SUBMIT
    // ============================================================
    {
      id: 'review',
      type: 'review',
      title: 'Check your answers',
      description: 'Review the information you have provided. If anything is incorrect, you will need to go back and amend it.',
      sections: [
        {
          title: 'Personal details',
          fields: ['title', 'first_name', 'last_name', 'dob', 'national_id'],
        },
        {
          title: 'Contact details',
          fields: ['email', 'phone', 'preferred_contact'],
        },
        {
          title: 'Address',
          fields: ['address_line1', 'city', 'postcode', 'move_in_date'],
        },
        {
          title: 'Housing costs',
          fields: ['tenancy_type', 'rent_amount', 'rent_frequency', 'landlord_name'],
        },
        {
          title: 'Income and savings',
          fields: ['employment_status', 'gross_income', 'net_income', 'total_savings'],
        },
        {
          title: 'Household',
          fields: ['household_size', 'has_partner', 'dependent_children'],
        },
      ],
      declaration: 'By submitting this application, I declare that the information I have given is correct and complete to the best of my knowledge and belief. I understand that I must report any changes in my circumstances and that providing false information may result in prosecution.',
      buttonText: 'Accept and submit application',
    },

    // ============================================================
    // COMPLETION
    // ============================================================
    {
      id: 'completion',
      type: 'completion',
      title: 'Application submitted',
      referenceLabel: 'Your application reference',
      body: `
        <p class="gov-body">We have sent a confirmation email to the address you provided.</p>
      `,
      whatHappensNext: 'We will review your application within 14 working days. You may be contacted if we need additional information or documentation. You will receive a decision letter by post.',
      // Set this to your Prolific completion URL
      prolificRedirect: null,
    },
  ],
};

// Export
window.SAMPLE_PROCEDURE = SAMPLE_PROCEDURE;
