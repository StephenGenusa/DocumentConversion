/**
 * The closed vocabulary every corpus fixture is built from.
 *
 * WHY THIS FILE EXISTS
 *
 * The fixtures used to be the real documents this suite was developed against
 * with words swapped out. Re-theming preserves the original structure and leaks
 * through every gap the swap missed, which it did, repeatedly: each scrub
 * searched for terms already known to be bad and so could not report the ones
 * nobody had thought of.
 *
 * Nothing here is derived from those documents. Every name, place, number and
 * sentence below was written from scratch about a library service that does not
 * exist. The generators compose fixture text from this file and nothing else,
 * so the guarantee is structural rather than a matter of anyone having looked
 * carefully: real content cannot appear in the corpus because it is not an
 * input to it.
 *
 * tests/pii derives its approved word list from THIS file, then checks the text
 * the readers actually extract against it. A generator that emits anything not
 * authored here fails the suite.
 *
 * Adding to this file is the one place new corpus words can enter, so it is the
 * one place that needs reading.
 */

/* -- organisation, sites, people ------------------------------------------- */

export const ORG = 'Elmwood Libraries'
export const ORG_SHORT = 'Elmwood'
export const DISTRICT = 'Elmwood district'

export const BRANCHES = ['North Annex', 'South Wing', 'East Court', 'West Depot']
export const REGIONS = ['North', 'South', 'East', 'West']
export const BRANCH_MAIN = 'Elmwood Branch'
export const BRANCH_SECOND = 'Northgate Annex'

/**
 * Invented people. Surnames are objects and plants rather than family names in
 * use, so a collision with a real person is unlikely and obvious if it happens.
 */
export const PEOPLE = [
  { file: 'nils.ashcombe', last: 'Ashcombe', first: 'Nils', dn: 'NASHCOMBE' },
  { file: 'odile.larkspur', last: 'Larkspur', first: 'Odile', dn: 'OLARKSPUR' },
  { file: 'ilva.brandt', last: 'Brandt', first: 'Ilva', dn: 'IBRANDT' },
  { file: 'juno.halloway', last: 'Halloway', first: 'Juno', dn: 'JHALLOWAY' },
  { file: 'iris.vellum', last: 'Vellum', first: 'Iris', dn: 'IVELLUM' },
  { file: 'petra.ferrow', last: 'Ferrow', first: 'Petra', dn: 'PFERROW' },
  { file: 'marta.quill', last: 'Quill', first: 'Marta', dn: 'MQUILL' },
  { file: 'devi.sorrel', last: 'Sorrel', first: 'Devi', dn: 'DSORREL' },
  { file: 'sunil.braddock', last: 'Braddock', first: 'Sunil', dn: 'SBRADDOCK' },
  { file: 'mireille.ostrander', last: 'Ostrander', first: 'Mireille', dn: 'MOSTRANDER' },
]

/** RFC 2606 reserves example.com/net/org; none of these can resolve. */
export const DOMAINS = { com: 'example.com', org: 'example.org', net: 'example.net' }
export const mailbox = (p, d = DOMAINS.com) => `${p.file}@${d}`
export const displayName = (p) => `${p.last}, ${p.first}`
export const fullName = (p) => `${p.first} ${p.last}`

export const TEAM_MAILBOX = 'opscenter@example.com'
export const TEAM_NAME = 'Ops Center'
export const REQUESTED_BY = 'Branch Operations'

/* -- identifiers ------------------------------------------------------------ */

/** Invented reference numbers. Deliberately short, and unlike any real scheme. */
export const REQUEST_REF = 'REQ-2088'
export const REVIEW_REF = '7742'
export const JOB_REF = '5502187'
export const DATE_ISO = '2026-03-14'
export const DATE_US = '03/14/2026'

/* -- catalogue ------------------------------------------------------------- */

export const CATALOGUE_SHEET = 'Codes'
export const CATALOGUE_HEADERS = ['Catalogue', 'Description', 'Group']
export const MATERIALS = [
  'BUCKRAM', 'LINEN', 'LEATHER', 'HARDBACK', 'PAPERBACK',
  'CLOTH', 'BOARD', 'ACID-FREE', 'POLYESTER', 'KRAFT',
]
export const ITEMS = [
  'BOX FILE', 'SHELF LABEL', 'JACKET', 'SPINE LABEL', 'BOOKEND',
  'DIVIDER', 'PAMPHLET BOX', 'MAP FOLDER', 'SLIP CASE', 'TAPE',
  'INDEX CARD', 'CARD TRAY', 'BOOK STAND', 'BOOK TRUCK', 'SHELF STRIP',
  'DUST COVER', 'ARCHIVE BOX', 'SLEEVE', 'LABEL ROLL', 'END PANEL',
]
export const SPECS = [
  'ACID FREE', 'BUFFERED', 'LIGNIN FREE', 'CLASS 1', 'CLASS 2',
  'HEAVY DUTY', 'STANDARD DUTY', 'WATER RESISTANT', 'UV RESISTANT', 'ARCHIVAL GRADE',
  'REFERENCE ONLY', 'OVERSIZE', 'WITH THUMB CUT', 'PRE-CREASED', 'LARGE PRINT',
  'SELF-ADHESIVE', 'OPEN BOTH ENDS', 'SELF-SEALING', 'CLEAR FRONT', 'FOR REFERENCE USE',
]
export const SIZES = ['A4', 'A5', 'B5', 'ROYAL', 'CROWN', 'DEMY', 'FOLIO', 'QUARTO', 'OCTAVO', 'POCKET']
export const GROUPS = ['FICTION', 'PERIODICALS', 'MEDIA', 'ARCHIVE', 'FURNITURE', 'STATIONERY']

/* -- prose ------------------------------------------------------------------
 *
 * Every sentence any fixture contains. Written for this file; not adapted from
 * anything. Kept grouped by the fixture that uses it so a change is traceable.
 */

export const LOAN_DOC = {
  intro: 'This note explains how to compute loan periods and renewals using the standard loan calculations below.',
  formulaLead: 'That formula is as follows:',
  tableLead: 'The multiplier table below lists the class ratings referenced above.',
  rows: [
    ['28.0 MAX', '21.0 EXC'],
    ['GRADE 220', '14.0 EXC'],
    ['90', '7.0 EXC'],
    ['STANDARD', '3 WEEKS'],
  ],
  tail: [
    'A second formula applies when the service is reference only.',
    'Use the constant shown for the loan form actually installed.',
    'For reserved items, apply the correction factor noted in the appendix.',
    'Round the result to the nearest tenth before recording it on the branch sheet.',
  ],
}

export const SHELVING_DOC = {
  title: 'SHELVING INSTRUCTIONS',
  subtitle: 'Reserve Collection Reference',
  lead: 'Follow the steps below before beginning any pull.',
  steps: [
    'Verify the shelf is clear of dust and damp before staging the trolley.',
    "Confirm the loaded weight does not exceed the shelf manufacturer's rating.",
    'Record the final layout on the floor plan once the move is complete.',
  ],
}

export const DEFINITIONS_DOC = [
  'Broadband is the general term for a connection fast enough to carry more than one signal at once.',
  'A bit is the smallest unit a computer stores, holding either a zero or a one.',
  'A byte is a group of eight bits, and is the usual unit for measuring file size.',
  'Bandwidth describes how much data a connection can carry in a given period of time.',
  'Latency describes how long a single piece of data takes to arrive, independent of how much can be sent.',
  'A protocol is an agreed set of rules that two systems follow so they can exchange data reliably.',
]

export const CLASSIFICATION_DOC = [
  'A three-tier shelfmark adds a third element to the two-part scheme most small collections use.',
  "The third element is taken from the author's surname, which is why it is sometimes called the author mark.",
  'It separates books that would otherwise share a shelfmark, so a popular subject stays in a predictable order.',
  'One of the three elements is written in lower case, unlike the other two.',
  'That element is written differently so it is never mistaken for part of the subject number.',
  'Confusing the two files the book under the wrong subject, where nobody looking for it will pass by.',
]

/** Multiple-choice sets. Each entry is [question, ...options]. */
export const QUIZ_CATALOGUING = [
  ['The height of a top shelf is measured from what?', 'The floor', 'The shelf below'],
  ['A bookend is used mainly to resist what?', 'Books leaning over', 'Books fading'],
  ['Shelving in the reading room is typically made from which material?', 'Steel', 'Oak', 'Laminate'],
  ['A shelfmark relates most directly to what?', 'Where the book is kept', 'Who borrowed it'],
  ['An oversize book is stored where?', 'The bottom shelf', 'The reserve desk'],
]
export const QUIZ_READING_GROUP = [
  ['How long is a standard loan?', 'Three weeks', 'Three months'],
  ['A book is moved to the reserve collection to solve which problem?', 'Too few copies for a class', 'Too many copies on the shelf'],
  ['Which catalogue field records who wrote the book?', 'Author', 'Accession'],
  ['Which number identifies a specific edition?', 'ISBN', 'Shelfmark'],
  ['A book returned with pages missing is most likely?', 'Withdrawn from stock', 'Returned to the shelf'],
]
export const QUIZ_INDUCTION = [
  ['How many branches share the central catalogue?', 'One', 'Two'],
  ['A reservation is cancelled after how many days uncollected, typically?', 'Two', 'Three', 'Four'],
  ['The returns log records which of the following?', 'Late returns', 'Shelf widths'],
  ['An interlibrary request normally starts in which state?', 'Open', 'Closed'],
  ['Which check finds a mis-shelved book automatically?', 'Shelf read', 'Stock count'],
]

export const SUPPLY_DOCX = {
  title: 'BRANCH SUPPLY REQUEST',
  lines: [`Branch: ${BRANCH_MAIN}`, `Requested by: ${REQUESTED_BY}`, `Date: ${DATE_US}`],
}

export const INDUCTION_DOCX = {
  headings: [
    'Handling practices for archive material',
    'Shelf clearance around the reference desk',
    'Storage room capacity guidance',
    'Shelf loading limits',
    'Storage guidance for oversize and folio material',
    'Reshelving checklist',
  ],
  caption: 'Reference figure follows.',
  footer: 'Proprietary and Confidential — Internal Training Material',
}

export const NOTES_DOCX = {
  title: 'Branch Notes',
  toc: [['How to Catalogue', 'Page 3'], ['Reference Section', 'Page 20, 21, & 22']],
  captions: ['Reading room layout', 'Mezzanine stair detail'],
}

export const CHARTS_DOCX = {
  title: 'Loan projection worksheet',
  lead: 'Renewal rates are applied per the standard schedule.',
  tail: 'Totals are carried forward to the summary sheet.',
}

export const FORM_XLS = {
  header: 'Transmittal Data',
  fields: [
    ['Request No', REQUEST_REF],
    ['Project Name', `${BRANCH_MAIN} Refit`],
    ['Requested By', REQUESTED_BY],
    ['Date', DATE_ISO],
  ],
  instructionsLabel: 'Special Instructions:',
  instructions: [
    'Coordinate with the branch desk before closing the aisle.',
    'Confirm shelf clearance with the duty librarian.',
  ],
}

export const REVIEW_RTF = {
  salutation: (p) => `${p.last}, I have completed my review of request ${REVIEW_REF}. No further changes are needed at this time.`,
  items: [
    'Replace 2 damaged shelves in the corner bay.',
    'Add 1 additional bookend at the end of the north run.',
    'Confirm the aisle clearance meets the access standard before closing the ticket.',
  ],
  signOff: 'Thanks,',
  end: 'End of review.',
}

export const MSG = {
  photos: { subject: 'Branch photographs', body: 'Photographs from the branch visit.' },
  status: { subject: 'Weekly status notes', body: 'Status notes are attached below.\n\nNothing further this week.' },
  hours: { subject: 'Branch opening hours', body: 'See the attached opening hours for this quarter.' },
  design: { subject: 'Design question', body: 'Can you confirm the spec for this design before Friday?' },
  attachments: ['floorplan.gif', 'notes.txt', 'shelving.png', 'aisle.jpg'],
}

export const DECK = {
  title: 'Quarterly Branch Review',
  slides: ['Coverage by region', 'Northern district', 'Southern district', 'Site photograph'],
  bullets: [
    'Third level, to clamp the depth', 'Steps to complete', 'Second numbered step',
    'Back to a plain bullet', 'Lettered sub-procedure', 'Second lettered step',
  ],
  tableHeader: 'Spanning header',
  tableCells: [['Status', 'North'], ['24', 'Complete'], ['31', 'In review']],
  wrappedCell: ['Even', 'Spacing'],
  acronym: 'MARC',
  clearances: 'Clearances – Even or Uneven Spacing',
}

/** The two .ics fixtures: an all-invented pair of study notes. */
export const CALENDAR = {
  producer: '-//Example Calendar//EN',
  events: [
    {
      uid: 'lesson-notes-1@example.com',
      summary: 'Study session notes',
      start: '20260305T140000Z',
      end: '20260305T150000Z',
      lines: [
        // The apostrophe is deliberate: reader-ics-html-breaks tests the escaping.
        "What makes a study habit stick, until it doesn't",
        'Where the routine actually breaks down',
        'and a smaller habit to try instead',
      ],
    },
    {
      uid: 'lesson-notes-2@example.com',
      summary: 'Household budgeting notes',
      start: '20260312T140000Z',
      end: '20260312T150000Z',
      lines: [
        'Where a stack of small subscriptions turns into needless overpaying',
        'How a short monthly review pipeline catches it early',
        'and where to start this week',
      ],
    },
  ],
}

export const DIRECTORY_HTML = {
  /**
   * The SharePoint chrome a saved page carries. The visible label and the
   * screen-reader-only text beside it are separate strings on purpose: the
   * reader must not run them together, which is what these fixtures test.
   */
  chrome: {
    siteTitle: 'Team Documents',
    selected: 'Currently selected',
    tabs: [
      ['Browse', 'Tab 1 of 3.'],
      ['Items', 'List Tools group. Tab 2 of 3.'],
      ['List', 'List Tools group. Tab 3 of 3.'],
    ],
    links: ['Home', 'Share'],
    navigateUp: 'Navigate Up', // the sanitiser adds the brackets around alt text
    icons: ['Pin', 'Marker', 'Compass'],
  },
  title: 'Facility Directory',
  heading: 'Branch Directory',
  lead: 'This page lists the branch locations and the reading room plan for each.',
  columns: ['Site', 'Region', 'Floor plan'],
  note: 'Site icons below are decorative and repeat the SharePoint UI chrome seen throughout this export.',
  footer: 'Contact the facilities desk with any corrections to this directory.',
}

export const HANDBOOK = {
  title: 'Visitor Handbook',
  runningHead: `VISITOR HANDBOOK | ${ORG.toUpperCase()}`,
  intro: [
    `Thank you for joining ${ORG}, the library service for the ${DISTRICT} and its four branch ` +
      'reading rooms. This handbook exists to answer the questions that come up most often in the ' +
      'first weeks on the job, and to set out, in one place, the policies every team is expected to ' +
      'follow. Read it once in full and keep it where you can find it again, because most questions ' +
      'about pay, leave, safety and conduct are answered somewhere in these pages, resulting in ' +
      'outstanding service and customer satisfaction.',
    `${ORG} strives to provide a welcoming environment in which members and volunteers can grow a ` +
      'career rather than simply hold a job. Supervisors are expected to explain not just what a ' +
      'policy says but why it exists, and every employee is expected to raise a concern rather than ' +
      'guess at the answer.',
  ],
  mission:
    `${ORG} provides the highest quality of service to its members with a commitment to excellence ` +
    'and integrity. We serve our customers with professionalism, and we respect each person we ' +
    'happen to meet along the way.',
  history:
    `${ORG} began as a single reading room and grew, over three decades, into a regional library ` +
    'service. The people who built that reputation are still the standard every new hire is ' +
    'measured against.',
  conduct:
    'Every employee is expected to act honestly, to treat colleagues and customers with respect, ' +
    'and to raise a concern through the proper channel rather than let it go unreported.',
  generalInfo:
    'This section covers the administrative basics: how pay periods work, how to read a pay stub, ' +
    'and who to contact with a question about benefits enrollment.',
  /** Rotated under each policy heading so the document has depth without new vocabulary. */
  policyBodies: [
    'This policy applies to every employee regardless of role or tenure, and exceptions are ' +
      'granted only in writing by a department manager.',
    'Questions about this section should be directed to a supervisor before the situation becomes ' +
      'urgent, not after.',
    'Records related to this policy are kept for the period required by law and are available to ' +
      'the employee on request.',
  ],
  contents: [
    ['Mission', 5], ['Company History', 5], ['Code of Conduct', 5], ['General Safety Rules', 11],
    [`Worker’s Compensation`, 14], ['Safety & Security', 12],
    ['Americans with Disabilities Act (ADA)/Reasonable Accommodations', 15],
  ],
  policySections: [
    'Workplace Safety', 'Attendance and Punctuality', 'Dress Code and Appearance',
    'Use of Company Equipment', 'Progressive Discipline', 'Anti-Harassment Policy',
    'Drug and Alcohol Policy', 'Social Media Guidelines', 'Data Security', 'Vehicle Use Policy',
    'Expense Reporting', 'Performance Reviews', 'Overtime Policy', 'Meal and Rest Breaks',
    'Leave of Absence', 'Family and Medical Leave', 'Bereavement Leave', 'Jury Duty',
    'Military Leave', 'Holiday Schedule', 'Paid Time Off', 'Sick Leave', 'Remote Work Policy',
    'Travel Policy', 'Confidentiality Agreement', 'Conflict of Interest', 'Gifts and Gratuities',
    'Whistleblower Policy', 'Grievance Procedure', 'Termination Procedures', 'Exit Interviews',
    'Reference Checks', 'Background Checks', 'Onboarding Process', 'Training Requirements',
    'Certification Renewals', 'Safety Equipment', 'Incident Reporting', 'Emergency Procedures',
    'Fire Safety', 'Severe Weather Policy', 'Workplace Violence Prevention',
    'Substance Abuse Program', 'Wellness Program',
  ],
  lateSections: [
    'Parking and Site Access', 'Visitor Policy', 'Photography on Site', 'Company Vehicles',
    'Tool Checkout Procedure', 'Personal Property',
  ],
  safetyHeading: 'General Safety Rules',
  safetyRules: [
    'Horseplay will not be tolerated in the reading rooms at any time.',
    'Report unsafe or defective equipment to management immediately.',
    'Never use equipment unless trained and authorized to do so.',
    'Keep all work areas clean and free of clutter at all times.',
    'Turn off lifts and trolleys whenever they are not in use.',
    'Wear the personal protective equipment assigned for the task.',
  ],
  exhibitTitle: 'Exhibit A Incident Report Form Page',
  acknowledgementHeading: 'Acknowledgement',
  acknowledgement:
    'By continuing your employment after receiving this handbook, you acknowledge that you have ' +
    'read it and agree to follow the policies it describes.',
}

export const EPUB = {
  title: 'Notes on Inference Systems',
  chapters: ['Chapter One: Setting the Scene', 'Chapter Two: Batching Requests', 'Chapter Three: Glossary'],
  c1: [
    'A small model can answer a narrow question quickly, and a large one can answer almost any ' +
      'question slowly; the practical systems described here live somewhere between the two.',
    'See Chapter Two for how batching changes that trade-off.',
    'The appendix in Chapter Three defines every term used below.',
    'Jump to further reading at the end of this chapter.',
    'The background paper this chapter draws on is summarised at',
    'Questions about this text can be sent to the editor .',
    'The same figure again, which must reuse the first resolution:',
    'A figure that is not in the archive at all:',
    'And one whose name needs percent-decoding to be found:',
    'Further reading: none of the sources here are reproduced in full.',
  ],
  c2: [
    'Grouping several requests together amortises the fixed cost of loading weights onto the ' +
      'accelerator, at the price of making every request in the batch wait for the slowest one.',
    'Back to Chapter One, or ahead to',
    'the glossary for the terms used above.',
    'An emphasised cross-reference to the caching section.',
  ],
  c3: [
    'Cache : memory kept from one request to reuse in the next.',
    'Batch : a group of requests processed together; see',
    'External background: a public reading list .',
  ],
  figureAlt: 'throughput against batch size',
  /** Deliberately a reserved example domain, not a real third-party address. */
  externalUrl: 'https://www.example.com/papers/example-model',
  externalLabel: 'example.com/papers',
}

export const HOWTO_DOCX = {
  steps: [
    'Open the Registry Editor by pressing the Windows key plus R and typing regedit.',
    'Navigate to HKEY_CLASSES_ROOT and find the Background key.',
    'Right click the shell key and choose New, then Key.',
    'In that new group you will need:',
    'Name the new key something memorable, like OpenTerminalHere.',
    'Set the default value of that key to the text you want shown in the menu.',
    '(I put them in that order, but you can do whatever order you want.)',
    'Create another subkey underneath named command.',
    'Set the default value of the command key to the full path of the program to run.',
    'Still under the jobs tab, add one more entry for a shortcut you use daily.',
    'Close the Registry Editor and right click on the desktop to see the new entry.',
    'If the entry does not appear, sign out and back in.',
    'Repeat the process for any other shortcuts you want pinned to that menu.',
  ],
}
