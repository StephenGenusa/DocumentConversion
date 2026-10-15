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

/**
 * tests/corpus/diagram-notes.md (scripts/fixtures/build-diagram-fixture.mjs):
 * invented returns notes with Mermaid diagrams. Arrows are spaced so that a
 * participant's name never runs into its arrow as one word.
 */
export const DIAGRAM_NOTES = {
  title: 'Returns procedure',
  intro:
    'Returned volumes travel through sorting, inspection and reshelving before borrowers see them again. Damaged volumes wait for repairs.',
  flowchart: [
    'flowchart TD',
    '  R[Returned volume] --> S{Damaged?}',
    '  S -->|No| H[Reshelve]',
    '  S -->|Yes| P[Repairs queue]',
    '  P --> H',
  ],
  between: 'The desk and the catalogue exchange two messages for every return.',
  sequence: [
    'sequenceDiagram',
    '  participant Desk',
    '  participant Catalogue',
    '  Desk ->> Catalogue: Item returned',
    '  Catalogue -->> Desk: Status updated',
  ],
  brokenIntro: 'This one is unfinished and stays as written:',
  broken: ['flowchart TD', '  Q -->'],
  dotIntro: 'Graphviz draws the trolley run:',
  dot: 'digraph { shelf -> trolley }',
  formula: 'Overdue charge: $$c = r \\times d$$',
}

/**
 * The Graphviz fixture (step 17): routes between library rooms, drawn by the
 * dot layout, by neato (the graph's own layout=) and as an undirected graph.
 * One node names its own font, which must be kept.
 */
export const GRAPHVIZ_NOTES = {
  title: 'Shelving routes',
  intro:
    'Volumes move between rooms in a fixed order. Couriers collect crates from branches each morning, and the sorting room decides where every volume goes next.',
  // No quoted strings: the PII guard reads code text with its entities, so
  // labels are single words, which Graphviz takes unquoted.
  route: [
    'digraph route {',
    '  rankdir=LR;',
    '  node [shape=box, style=rounded];',
    '  Returns -> Sorting [label=crates];',
    '  Sorting -> Repairs [label=damaged];',
    '  Sorting -> Reshelving;',
    '  Repairs -> Reshelving [label=mended];',
    '  Reshelving -> Stacks;',
    '  Stacks [fontname=Courier];',
    '}',
  ],
  branchesIntro: 'Branches share couriers, so their links have no direction:',
  branches: [
    'graph branches {',
    '  layout=neato;',
    '  node [shape=ellipse];',
    '  Central -- Northgate [label=daily];',
    '  Central -- Riverside;',
    '  Central -- Hillcrest;',
    '  Northgate -- Riverside [label=weekly];',
    '}',
  ],
  undirectedIntro: 'A plain undirected sketch of the reading room:',
  undirected: ['graph room {', '  entrance -- periodicals -- fiction;', '  entrance -- media;', '}'],
  brokenIntro: 'This route is unfinished and stays as written:',
  broken: ['digraph {', '  desk -> ', '}'],
  closing: 'Couriers report delays to the sorting room.',
}

/**
 * The formula fixture (step 18, spec B1, B3): invented notes on how overdue
 * fines and loan figures are worked out, with TeX formulas inline and on lines
 * of their own. Each formula is written here as TeX, byte for byte; the
 * matrix and the host test draw them with MathJax. `unknown` uses a macro TeX
 * does not have, so it stays as written, with a notice.
 */
export const FORMULA_NOTES = {
  title: 'Loan arithmetic',
  intro:
    'Branches calculate overdue charges, average borrowing and shelving capacity with the formulas below. Treasurers check every figure before the monthly report.',
  finesLead: 'A volume returned',
  finesDays: 'd_i',
  finesMid: 'days late owes',
  finesRate: 'f_i = r \\cdot d_i',
  finesTail: 'where the daily rate',
  rate: 'r_{\\text{day}}',
  finesEnd: 'is set by each branch, and a reader pays at most',
  cap: '\\min(f_i, 20)',
  sumLead: 'Over a month, the fines collected from all returns are',
  total: '\\sum_{i=1}^{n} f_i = r \\sum_{i=1}^{n} d_i',
  meanLead: 'The average loan, numbered so the report can refer to it:',
  mean: '\\bar{x} = \\frac{1}{n} \\sum_{i=1}^{n} x_i \\tag{1}',
  ruleLead: 'Fines start after a week of grace:',
  rule: 'f(d) = \\begin{cases} 0 & d \\le 7 \\\\ r\\,(d - 7) & d > 7 \\end{cases}',
  gridLead: 'Shelf capacity per room, by wall and by tier:',
  grid: 'C = \\begin{pmatrix} 120 & 80 \\\\ 95 & 60 \\end{pmatrix}',
  inlineLead: 'Smaller pieces sit in the line of text: a share',
  share: '\\frac{a}{b}',
  inlineMid: 'of the stock, a decay',
  decay: 'e^{-\\lambda t}',
  inlineMore: 'in demand, a spread',
  spread: '\\sqrt{\\sigma^2 + 1}',
  inlineEnd: 'and an area',
  area: '\\int_0^1 x^2 \\, dx',
  prices: 'Membership costs $5 for students and $10 for everyone else.',
  shellLead: 'The nightly export is started from a terminal:',
  shell: '$ export-loans --since yesterday',
  unknownLead: 'One formula uses a command TeX does not know and stays as written:',
  unknown: '\\fines{d}',
  closing: 'Treasurers round every charge to the nearest penny.',
}

/** The SVG fixtures (step 16, spec D10): a floor plan drawn as an SVG, and a page that shows it. */
export const READING_ROOM = {
  title: 'Reading room plan',
  labels: ['Fiction', 'Periodicals', 'Media', 'Desk', 'Entrance'],
  pageTitle: 'Finding your way around',
  pageIntro:
    'The reading room plan below shows where each collection stands. Periodicals sit beside the windows; the desk faces the entrance.',
  pageAfter: 'Volunteers keep the plan current whenever shelving moves.',
  iconIntro: 'A small marker shows quiet seating:',
  iconAlt: 'Quiet seating marker',
  albumTitle: 'Reading room album',
  albumIntro: 'Photographs and plans of the reading room, gathered for the volunteer handbook.',
  photoAlt: 'Morning light across the periodicals',
  photoAfter: 'The windows face east, so mornings are brightest beside the periodicals.',
  webpAlt: 'Media shelves after refitting',
  flowIntro: 'Returned volumes reach the shelves in three steps:',
  flow: ['Returned', 'Sorted', 'Reshelved'],
}

/**
 * The Word equations fixture (step 19, spec B12): invented notes on loan and
 * shelving figures, written as Word equations (OMML) so the docx reader turns
 * them into TeX. One lead sentence per equation; the equations themselves are
 * built in scripts/fixtures/build-omml-fixture.mjs, and `texWords` lists the
 * TeX command names the reader writes for them (they reach the hub as text).
 */
export const OMML_NOTES = {
  title: 'Equations from the treasurer',
  intro:
    'Treasurers keep their working in Word, with every figure typed as an equation. Each equation below should come through as a formula, drawn the way Word draws it.',
  styles: 'Letters in different styles, and a few words of normal text:',
  styleText: 'per branch',
  fractions: 'Fractions: stacked, linear, skewed, and without a bar:',
  scripts: 'Powers, indices, both together, and indices written before:',
  roots: 'A square root and a cube root:',
  sums: 'Sums, products, unions and integrals, with and without limits:',
  delimiters: 'Brackets of every shape, a separator, and a bar with nothing on its left:',
  matrices: 'Shelf grids as matrices, in parentheses, in brackets, and bare:',
  aligned: 'Two lines lined up on their equals signs:',
  cases: 'Fines by the number of days late:',
  casesText: 'otherwise',
  functions: 'Functions by name, with a power on one of them:',
  limits: 'A limit, a maximum, and a definition written over an equals sign:',
  accents: 'Accents, bars and braces over and under terms:',
  braceLabel: 'terms',
  boxes: 'A boxed result, a struck term, and a hidden spacer:',
  symbols: 'Greek letters, operators and arrows:',
  specials: 'Characters that mean something to TeX, typed as text:',
  specialText: 'rate in % per $ & # of_days',
  twoLines: 'Two equations in one math paragraph:',
  inlineLead: 'Inline, a share',
  inlineMid: 'of the stock goes to each branch, and the daily rate',
  inlineEnd: 'stays the same all year.',
  aloneLead: 'An equation alone in its paragraph, not marked as a math paragraph:',
  footnoteLead: 'The yearly figure has a note',
  footnote: 'Worked out as',
  footnoteEnd: 'for each branch.',
  endnoteLead: 'The monthly figure has an endnote',
  endnote: 'The monthly total is',
  unknownLead: 'One equation holds an element no version of Word writes; its characters come through as they are:',
  closing: 'Treasurers check every equation against the printed report.',
  texWords:
    'mathbb mathcal mathfrak mathrm mathbf mathsf boldsymbol text frac genfrac sqrt sum prod bigcup int iint oint ' +
    'limits nolimits left right middle langle rangle begin end matrix pmatrix bmatrix vmatrix aligned gathered cases ' +
    'sin log operatorname sgn lim rightarrow infty max underset overset hat tilde dot ddot vec bar overline underline ' +
    'widehat overrightarrow underbrace overbrace boxed cancel phantom alpha beta gamma delta varepsilon theta lambda ' +
    'sigma omega Delta Sigma Omega forall exists le ge ne approx pm times cdot Rightarrow in subseteq cup cap partial ' +
    'nabla backslash def cos cdots quad bbb c-b x-a',
}
