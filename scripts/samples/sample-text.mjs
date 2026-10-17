/**
 * Every word of the sample documents (Help -> Sample Documents), as written.
 *
 * The samples are invented work: a footbridge that does not exist, a sync
 * service nobody runs, a lab section that never met, an office move that was
 * never planned. The people are the invented ones from
 * scripts/fixtures/vocabulary.mjs, which re-exports this module, so the PII
 * guard derives its approved words from what is written here
 * (tests/pii/corpus-vocabulary.txt) and reads the built samples back through
 * the app's readers to check them.
 *
 * The Markdown bodies are String.raw templates: TeX keeps its backslashes as
 * typed. A backtick is written \` and `${` as \${ (both put back by `md`), and
 * `{{NAME}}` marks a place the generator (build-samples.mjs) fills: a picture
 * as a data URI, or a figure it works out (the lab report's fit).
 *
 * American spelling throughout.
 */

/** A Markdown body: String.raw, with \` and \${ put back as ` and ${. */
const md = (strings, ...values) => String.raw(strings, ...values).replaceAll('\\`', '`').replaceAll('\\${', '${')

/* -- engineering design note ------------------------------------------------- */

export const SAMPLE_ENGINEERING = {
  file: 'engineering-design-note.md',
  menu: 'Engineering Design Note',
  elevationAlt: 'Elevation of the two-span footbridge with the new deck, bearings and dimensions',
  elevation: {
    title: 'Ferrow Mill footbridge, downstream elevation',
    labels: {
      abutmentA: 'Abutment A',
      pier: 'Pier 1',
      abutmentB: 'Abutment B',
      deck: 'New FRP deck panels',
      bearings: 'Bearings replaced',
      gusset: 'Gusset repair at L2',
      water: 'Normal water level',
      span: '18.0 m span',
      overall: '36.0 m overall',
      height: '2.4 m',
      north: 'Downstream face, looking north',
      scale: '0 to 5 m',
    },
  },
  body: md`---
title: Ferrow Mill Footbridge Deck Retrofit
---

# Ferrow Mill Footbridge: Deck Retrofit

**Design note DN-014, revision B** · Prepared by Ilva Brandt, PE · Checked by Sunil Braddock, PE · October 12, 2026

The Ferrow Mill footbridge carries the riverside trail over the mill race on two simply supported steel Pratt trusses. Its timber deck has reached the end of its life, and the trail is being reclassified for a heavier pedestrian load and a small maintenance vehicle. This note shows that the **existing trusses can carry the new loads if the deck is rebuilt in fiber-reinforced polymer (FRP)**, and sets out the checks behind that conclusion.

{{FIG:elevation}}

## 1. Scope

The retrofit replaces the deck, the bearings and one pair of gusset plates. It *does not* change the trusses, the pier or the abutments. The work covers:

- Removing the timber deck and its nailers, and blasting and painting the stringer top flanges.
- Installing 125 mm FRP sandwich panels[^frp] on the existing stringers, clamped rather than bolted through.
- Replacing all six elastomeric bearings, which are split and walking off their plates.
- Plating over the L2 gusset on the downstream truss, where the last inspection found section loss.[^insp]

~~Widening the deck to 3.6 m~~ was studied and dropped in revision B: it needs new floor beams and doubles the cost.

## 2. Load path

Every load on the deck reaches the ground through one chain of members, and each link is checked in Section 4. The diagram shows that chain; green members are new and orange ones are repaired.

~~~dot
digraph loadpath {
  bgcolor="transparent";
  nodesep=0.45;
  ranksep=0.45;
  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=13, margin="0.18,0.08", color="#3b6ea5", fillcolor="#e8f0fa"];
  edge [color="#55616e", arrowsize=0.8];
  deck [label="FRP deck panels\n(new)", fillcolor="#dff3e4", color="#2f8a4e"];
  stringers [label="Stringers\nW8x18 at 1.2 m"];
  floorbeams [label="Floor beams\nW12x26 at 4.5 m"];
  panel [label="Truss panel points\nL0 to L4"];
  gusset [label="L2 gusset plates\n(repaired)", fillcolor="#fde9d9", color="#c46a1b"];
  truss [label="Pratt trusses\n2 per span"];
  bearings [label="Elastomeric bearings\n(new)", fillcolor="#dff3e4", color="#2f8a4e"];
  abut [label="Abutments A and B"];
  pier [label="Pier 1"];
  ground [label="Spread footings\non rock", style="filled", fillcolor="#efe9df", color="#8a7a5c"];
  {rank=same; deck -> stringers -> floorbeams -> panel;}
  {rank=same; bearings -> truss -> gusset [dir=back];}
  panel -> gusset [style=dashed];
  panel -> truss;
  bearings -> abut;
  bearings -> pier;
  abut -> ground;
  pier -> ground;
}
~~~

## 3. Design loads

The trail standard calls for a pedestrian live load of $\SI{4.3}{\kilo\pascal}$, up from the $\SI{3.6}{\kilo\pascal}$ the 1978 drawings used,[^old] and a $\SI{4.5}{\tonne}$ maintenance vehicle that never shares the deck with a crowd. The FRP panels weigh $\SI{0.95}{\kilo\pascal}$ against $\SI{1.40}{\kilo\pascal}$ for the timber and nailers they replace.

Members are checked for the strength combination

$$w_u = 1.25\,w_D + 1.75\,w_L$$

For an interior stringer, with a tributary width of $\SI{1.2}{\meter}$ and its own weight of $\SI{0.26}{\kilo\newton\per\meter}$, the FRP deck gives $w_D = \SI{1.40}{\kilo\newton\per\meter}$ and $w_L = \SI{5.16}{\kilo\newton\per\meter}$. Spanning $s = \SI{4.5}{\meter}$ between floor beams:

$$M_u = \frac{w_u\,s^2}{8} = \frac{(\SI{10.78}{\kilo\newton\per\meter})(\SI{4.5}{\meter})^2}{8} = \SI{27.3}{\kilo\newton\meter}$$

Two serviceability limits govern a light footbridge more often than strength does:

1. **Deflection.** Live-load deflection of a truss must stay below $\Delta_{\max} = L/360 = \SI{50}{\milli\meter}$. The model gives $\SI{31}{\milli\meter}$.
2. **Vibration.** The first vertical frequency must stay clear of walking pace, above $\SI{3.0}{\hertz}$:

$$f_1 = \frac{\pi}{2L^2}\sqrt{\frac{EI}{\bar{m}}} = \SI{4.1}{\hertz}$$

The timber deck would give $\SI{3.6}{\hertz}$; the lighter deck is what keeps the bridge comfortably above the limit.

## 4. Member checks

Demands are from the frame model with the new live load, for a timber deck replaced in kind and for the FRP deck. Utilization is demand over factored capacity; anything above 1.00 fails.

<table>
<thead>
<tr><th rowspan="2">Member</th><th rowspan="2">Section</th><th rowspan="2">Capacity</th><th colspan="2">Demand</th><th colspan="2">Utilization</th><th rowspan="2">Result</th></tr>
<tr><th>Timber</th><th>FRP</th><th>Timber</th><th>FRP</th></tr>
</thead>
<tbody>
<tr><td>Interior stringer</td><td>W8x18</td><td style="text-align:right">86.4 kN·m</td><td style="text-align:right">29.0 kN·m</td><td style="text-align:right">27.3 kN·m</td><td style="text-align:right">0.34</td><td style="text-align:right">0.32</td><td>OK</td></tr>
<tr><td>Floor beam</td><td>W12x26</td><td style="text-align:right">189 kN·m</td><td style="text-align:right">72.4 kN·m</td><td style="text-align:right">68.1 kN·m</td><td style="text-align:right">0.38</td><td style="text-align:right">0.36</td><td>OK</td></tr>
<tr><td>Bottom chord</td><td>2L 4x4x3/8</td><td style="text-align:right">612 kN</td><td style="text-align:right">438 kN</td><td style="text-align:right">401 kN</td><td style="text-align:right">0.72</td><td style="text-align:right">0.66</td><td>OK</td></tr>
<tr><td>Top chord</td><td>2L 4x4x3/8</td><td style="text-align:right">540 kN</td><td style="text-align:right">446 kN</td><td style="text-align:right">409 kN</td><td style="text-align:right">0.83</td><td style="text-align:right">0.76</td><td>OK</td></tr>
<tr><td>End diagonal</td><td>2L 3x3x5/16</td><td style="text-align:right">296 kN</td><td style="text-align:right">305 kN</td><td style="text-align:right">279 kN</td><td style="text-align:right"><strong>1.03</strong></td><td style="text-align:right">0.94</td><td>Needs FRP deck</td></tr>
<tr><td>L2 gusset, as found</td><td>3/8 in plate</td><td style="text-align:right">563 kN</td><td style="text-align:right">438 kN</td><td style="text-align:right">401 kN</td><td style="text-align:right">0.78</td><td style="text-align:right">0.71</td><td>Plate over</td></tr>
<tr><td>Bearing</td><td>Elastomeric pad</td><td style="text-align:right">180 kN</td><td style="text-align:right">166 kN</td><td style="text-align:right">152 kN</td><td style="text-align:right">0.92</td><td style="text-align:right">0.84</td><td>Replace</td></tr>
</tbody>
</table>

> [!IMPORTANT]
> The end diagonals pass **only** with the FRP deck. A timber deck must not be reinstated on this bridge without strengthening them first.

## 5. Bearings and the L2 gusset

The new bearings are plain elastomeric pads, 250 by 200 by 42 mm, on new stainless sole plates. Each truss keeps one fixed and one expansion end per span, as built. The gusset repair adds a 10 mm plate on the outside face, fastened with the existing bolt pattern plus four new holes, so the truss never has to be jacked.

## Terms used in this note

Load path
: The chain of members a load travels through, from where it is applied to the ground.

Panel point
: A joint of a truss where a floor beam delivers its load; this bridge has five per span, L0 to L4.

Tributary width
: The width of deck whose load one member collects.

Utilization
: Factored demand divided by factored capacity. Values at or below 1.00 pass.

## Next steps

1. Issue revision B for review by the trail owner by October 23.
2. Confirm panel weight and clamp spacing with the panel supplier.
3. Prepare the bearing replacement sequence, one corner at a time, so the trusses stay supported.

[^frp]: Weight taken from the supplier's data sheet for a 125 mm panel with a 6 mm polymer concrete wearing surface.
[^insp]: The June 2026 inspection measured about 8 percent section loss at the L2 gusset plates of the downstream truss; capacity in Section 4 is reduced to match.
[^old]: 75 pounds per square foot, the figure printed on sheet S-2 of the original drawings.
`,
}

/* -- software design specification ------------------------------------------ */

export const SAMPLE_SOFTWARE = {
  file: 'software-design-specification.md',
  menu: 'Software Design Specification',
  body: md`---
title: Heron Sync Service Design Specification
---

# Heron Sync Service: Design Specification

**Version 0.9, draft for review** · Owner: Nils Ashcombe · Reviewers: Iris Vellum and Sunil Braddock · October 14, 2026

Heron keeps a user's notes the same on every device they own, including edits made offline. This specification covers the service side: how a change is accepted, stored and announced, and what happens when two devices edit the same note. The client library is covered only where it shapes the protocol.

## Goals and non-goals

Heron **will** accept edits from any number of devices, merge edits that do not overlap without asking the user, and tell every other device about a change within two seconds. It **will not** offer real-time co-editing with live cursors in this version, nor sync attachments larger than 25 MB, which stay with the existing upload service.

## Requirements

1. The service <u>must</u> accept a change made against any earlier revision, and rebase it onto the head when the edits do not overlap.
2. Every accepted change must be durable before the client hears \`201 Created\`.
3. A change must be idempotent: sending the same \`changeId\` twice stores it once.
4. Other devices of the same user must be notified within 2 s at the 95th percentile.
5. A conflicting change must never be dropped; it is kept as a sibling revision for the user to choose.
6. The service must run with no data loss through the loss of any one node.

## Data model

A document is a chain of revisions; each revision holds the changes one device made in one push. The metadata store keeps the chain in two tables. A revision's number is unique per document, which is what makes a lost race visible as a constraint error rather than a silent fork.

~~~sql
CREATE TABLE documents (
    id            UUID PRIMARY KEY,
    owner_id      UUID NOT NULL,
    head_revision INTEGER NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revisions (
    document_id   UUID NOT NULL REFERENCES documents (id),
    number        INTEGER NOT NULL,
    base_revision INTEGER NOT NULL,
    device_id     UUID NOT NULL,
    change_id     UUID NOT NULL UNIQUE,
    body          JSONB NOT NULL,
    PRIMARY KEY (document_id, number)
);
~~~

In the service's own code the same model reads as four classes:

~~~mermaid
classDiagram
    direction LR
    class Document {
        +UUID id
        +UUID ownerId
        +int headRevision
        +title() string
    }
    class Revision {
        +int number
        +UUID deviceId
        +DateTime createdAt
        +int baseRevision
    }
    class Change {
        +ChangeKind kind
        +int position
        +string text
        +apply(doc) Document
    }
    class Device {
        +UUID id
        +string name
        +DateTime lastSeen
    }
    Document "1" *-- "many" Revision : history
    Revision "1" *-- "1..*" Change : holds
    Device "1" --> "many" Revision : authors
~~~

## Pushing a change

A device sends each change with the revision it was made against. The sync service compares that base with the document's head, rebases when it can, and announces the result on the change queue.

~~~mermaid
sequenceDiagram
    autonumber
    participant App as Notes app
    participant GW as API gateway
    participant Sync as Sync service
    participant DB as Metadata store
    participant N as Notifier
    App->>GW: POST /v1/docs/:id/changes
    GW->>Sync: forward with the user's token checked
    Sync->>DB: read head revision
    alt base revision is the head
        Sync->>DB: append change as new head
    else base revision is behind
        Sync->>Sync: rebase change onto head
        Sync->>DB: append rebased change
    end
    Sync-->>App: 201 Created, revision 42
    Sync-)N: doc.changed, through the change queue
    N-)App: push to the user's other devices
~~~

## Document states on a device

The client library tracks each open document through these states; the service only ever sees the pushes.

~~~mermaid
stateDiagram-v2
    [*] --> Synced
    Synced --> Dirty : local edit
    Dirty --> Pushing : network available
    Pushing --> Synced : 201 accepted
    Pushing --> Rebasing : 409 behind head
    Rebasing --> Pushing : rebased cleanly
    Rebasing --> Conflict : edits overlap
    Conflict --> Dirty : user picks a version
    Pushing --> Dirty : offline again
~~~

## API

All endpoints take and return JSON, and need a bearer token from the auth service.

| Method | Path | Purpose | Reply |
|---|---|---|:---:|
| \`GET\` | \`/v1/docs/:id\` | Head revision and its text | \`200\` |
| \`GET\` | \`/v1/docs/:id/revisions\` | Revisions newer than \`?after=n\` | \`200\` |
| \`POST\` | \`/v1/docs/:id/changes\` | Push a change | \`201\` |
| \`POST\` | \`/v1/docs/:id/resolve\` | Choose between sibling revisions | \`200\` |
| \`DELETE\` | \`/v1/docs/:id\` | Move a document to the trash | \`204\` |

A push names the revision it was made against and carries its changes in order:

~~~json
{
  "changeId": "6f1c2b9e-0d4a-4c8e-9a51-2e7d3b8f4c10",
  "baseRevision": 41,
  "deviceId": "a3e9d2f0-7b61-4f5c-8d2a-91c0e4b7f356",
  "changes": [
    { "kind": "insert", "position": 118, "text": "Bring the tide tables." }
  ]
}
~~~

## Rebasing a change

When the base is behind, the service shifts each incoming change past the changes made since. Edits that touch the same span are not guessed at: the change is stored as a sibling revision and the user is asked.

~~~python
def rebase(change: Change, since: list[Change]) -> Change | None:
    position = change.position
    for earlier in since:
        if earlier.overlaps(change):
            return None  # a conflict: keep as a sibling revision
        if earlier.position <= position:
            position += earlier.delta
    return change.moved_to(position)
~~~

On the device, the client library queues changes while offline and pushes them in order once the network returns:

~~~typescript
export async function pushPending(doc: LocalDoc, api: SyncApi): Promise<void> {
  while (doc.pending.length > 0) {
    const next = doc.pending[0]
    const res = await api.pushChange(doc.id, { ...next, baseRevision: doc.revision })
    if (res.status === 409) return void (doc.state = 'rebasing')
    doc.revision = res.revision
    doc.pending.shift()
  }
  doc.state = 'synced'
}
~~~

## Configuration

Each environment sets its limits in one file; the values below are the production defaults.

~~~yaml
sync:
  max_change_kib: 256
  rebase_window: 500        # revisions a change may be behind
  notify_deadline_ms: 2000
queue:
  topic: doc.changed
  retention_hours: 72
storage: { replicas: 3, write_quorum: 2 }
~~~

**Open questions.** Should the rebase window of 500 revisions be per document or per user? Can the notifier batch pushes to one device and still meet the 2 s target? Background reading: the [conflict handling decision record](https://wiki.example.com/heron/decisions/conflicts) and the [queue sizing notes](https://wiki.example.com/heron/queue-sizing).
`,
}

/* -- lab report ------------------------------------------------------------- */

export const SAMPLE_LAB = {
  file: 'lab-report.md',
  menu: 'Lab Report',
  plotAlt: 'Arrhenius plot: natural log of the rate constant against inverse temperature, five points on a straight line',
  plot: {
    title: 'Arrhenius plot',
    xLabel: '1000 / T (1/K)',
    yLabel: 'ln k',
    points: 'Measured runs',
    fit: 'Least-squares fit',
  },
  cuvetteAlt: 'Photograph of six cuvettes in a row, violet fading to clear from left to right',
  body: md`---
title: Temperature and the Rate of Crystal Violet Fading
---

# Temperature and the Rate of Crystal Violet Fading

**General Chemistry II, Laboratory 6** · Devi Sorrel and Juno Halloway · Section 3 · October 9, 2026

## Abstract

Crystal violet loses its color as hydroxide ions add to it, and how fast that happens depends strongly on temperature. We followed the fading by absorbance at five temperatures from 15 to 35 °C, found a pseudo-first-order rate constant for each, and fitted the Arrhenius equation to them. The activation energy is **{{EA}} kJ/mol**, and the rate roughly doubles for every 10 °C.

## Introduction

The violet cation, written CV<sup>+</sup>, reacts with OH<sup>−</sup> to give a colorless alcohol. With hydroxide in large excess its concentration barely changes, so the rate depends on the dye alone:

$$\newcommand{\kobs}{k_{\mathrm{obs}}}\newcommand{\CV}{\mathrm{CV}^{+}}
\text{rate} = k\,[\CV]\,[\mathrm{OH}^{-}] = \kobs\,[\CV], \qquad \kobs = k\,[\mathrm{OH}^{-}]_0$$

Integrating gives a straight line in time, which is what we fitted for each run, with the absorbance *A* standing in for concentration:

$$\ln A_t = \ln A_0 - \kobs\,t$$

The Arrhenius equation then ties each rate constant to the temperature, through the activation energy $E_a$ and the gas constant $R = \SI{8.314}{\joule\per\mole\per\kelvin}$:

$$\ln \kobs = \ln A_{\mathrm{f}} - \frac{E_a}{R}\cdot\frac{1}{T}$$

## Method

The lab manual sets the one rule that matters most for this experiment:

> Bring both solutions to the bath temperature before they meet. A run started warm and finished cold measures the thermometer, not the reaction.

~~~mermaid
flowchart TB
    subgraph prep [Before each run]
        direction LR
        A[Make up dye<br/>and NaOH] --> B[Warm both<br/>in the bath]
        B --> C{Steady to<br/>0.2 °C?}
        C -- no --> B
    end
    subgraph run [The run]
        direction LR
        D[Mix 3.0 mL<br/>in a cuvette] --> E[Read A at 590 nm<br/>every 15 s]
        E --> F[Fit ln A<br/>against time] --> G([Rate constant<br/>for the run])
    end
    prep -- yes --> run
~~~

Each run used $\SI{2.5e-5}{\mole\per\liter}$ crystal violet and $\SI{0.020}{\mole\per\liter}$ NaOH, read for ten minutes or until the absorbance fell below 0.05. Five runs were made, one at each bath setting.

## Results

Every run gave a straight line of ln *A* against time, with R<sup>2</sup> above 0.998. The rate constants and the quantities plotted are:

| Bath (°C) | *T* (K) | 1000 / *T* (K<sup>−1</sup>) | *k*<sub>obs</sub> (10<sup>−3</sup> s<sup>−1</sup>) | ln *k*<sub>obs</sub> | Half-life (s) |
|---:|---:|---:|---:|---:|---:|
{{TABLE:rates}}

{{FIG:plot}}

*Figure 1. The five rate constants against inverse temperature, with the least-squares line.*

## The activation energy

The fitted line has a slope of {{SLOPE}} K, so

$$E_a = -R \times \text{slope} = \SI{{{EA}}}{\kilo\joule\per\mole}$$

and its intercept gives a frequency factor of about {{AF}} s<sup>−1</sup>, with R<sup>2</sup> = {{R2}}.

{{FIG:cuvettes}}

*Figure 2. The 25 °C run photographed every two minutes: the violet fades as the dye is used up.*

## Discussion

The half-life follows from the first-order rate law as $$t_{1/2} = \frac{\ln 2}{\kobs}$$ which at 25 °C is {{HALF25}} s, close to the {{HALF25ROUND}} s we read straight off the absorbance trace. The ratio of rate constants at 35 and 25 °C is {{RATIO}}, the doubling for every 10 degrees that an activation energy of this size predicts.

Two things limit the result. The bath drifted by up to 0.2 °C during the longest run, which at 15 °C moves $\kobs$ by about 1.5 percent. And at the high-temperature end the first reading came 15 s after mixing, when a quarter of the dye was already gone; fitting from the second reading on changed $\kobs$ by less than 1 percent.

## Conclusion

The fading of crystal violet in excess hydroxide is first order in the dye at every temperature studied, with an activation energy of {{EA}} kJ/mol. A run at 45 °C with readings every 5 s would test whether the line stays straight.
`,
}

/* -- meeting summary ------------------------------------------------------- */

export const SAMPLE_MEETING = {
  file: 'meeting-summary.md',
  menu: 'Meeting Summary',
  planAlt: 'Annotated floor plan of the fourth floor: rooms, desk groups and numbered callouts for the action items',
  plan: {
    title: 'Fourth floor, as planned',
    rooms: {
      reception: 'Reception',
      kitchen: 'Kitchen',
      meeting: 'Meeting room',
      quietA: 'Quiet room A',
      quietB: 'Quiet room B',
      studio: 'Design studio',
      print: 'Print and storage',
      it: 'IT closet',
      lockers: 'Lockers',
      lift: 'Elevators',
      stairs: 'Stairs',
    },
    desks: ['Desk group 1', 'Desk group 2', 'Desk group 3', 'Desk group 4'],
    deskCount: 'desks',
    legend: {
      title: 'Legend',
      desk: 'Desk',
      room: 'Enclosed room',
      route: 'Step-free route',
      callout: 'Action item',
    },
    callouts: [
      'Network drops',
      'Quiet room booking',
      'Accessible desks',
      'Kitchen power',
      'Print area',
      'Lockers',
    ],
    north: 'North',
    scale: '0 to 5 m',
  },
  body: md`---
title: Office Move Planning Meeting Summary
---

# Office Move Planning: Meeting Summary

**October 15, 2026, 10:00 to 11:15** · Fourth-floor meeting room and online · Notes by Mireille Ostrander

> [!NOTE]
> **In short.** The move is set for the weekend of <mark>**December 5 and 6**</mark>. The fourth-floor plan is approved with two changes (more quiet space, step-free desks by the elevators). <mark>Six action items are open</mark>; each is numbered on the floor plan below.

**Attendees:** Odile Larkspur (facilities, chair), Nils Ashcombe (IT), Marta Quill (people operations), Petra Ferrow (finance), Iris Vellum (design studio), Mireille Ostrander (office manager).

## What we covered

~~~mermaid
mindmap
  root((Office move))
    Space
      Desk groups
      Quiet rooms
      Storage
    People
      Seating requests
      Step-free access
    Technology
      Network drops
      Printers
    Logistics
      Movers
      Packing crates
~~~

## Timeline

The build-out has to finish a week before the move so the network can be tested with the desks in place.

~~~mermaid
gantt
    title Move to the fourth floor
    dateFormat YYYY-MM-DD
    axisFormat %b %d
    section Planning
    Final floor plan        :done, plan, 2026-10-12, 2026-10-23
    Order furniture         :active, furn, 2026-10-19, 21d
    section Build-out
    Network and power drops :net, 2026-10-26, 2026-11-13
    Paint and carpet        :paint, after net, 10d
    Network test with desks :test, 2026-11-24, 3d
    section Move
    Pack and label          :pack, 2026-11-30, 5d
    Move weekend            :crit, move, 2026-12-05, 2d
    First day upstairs      :milestone, first, 2026-12-07, 0d
~~~

## The new floor plan

The plan holds 38 desks in four groups, two quiet rooms and a design studio with its own large-format printer. The numbers in circles match the action items.

{{FIG:plan}}

## Decisions

| # | Decision | Agreed by | Effective |
|:---:|---|---|---|
| D1 | Move weekend is December 5 and 6; nobody works from the third floor after December 4. | All | Now |
| D2 | Desk group 1, by the elevators, is kept step-free and holds the four adjustable desks. | Odile Larkspur | Plan rev 3 |
| D3 | The second small meeting room becomes Quiet room B. | Iris Vellum | Plan rev 3 |
| D4 | Each person packs at most two crates; the rest goes to storage or is recycled. | Marta Quill | November 30 |
| D5 | The furniture budget is held at the approved figure; the studio chairs come from the third floor. | Petra Ferrow | Now |

## Action items

- [ ] **1. Network drops.** Confirm the drop count for each desk group with the cabling contractor, including the studio's two plotters. *Nils Ashcombe, due October 22.*
- [ ] **2. Quiet room booking.** Set up booking for both quiet rooms, with a two-hour limit. *Mireille Ostrander, due November 14.*
- [x] **3. Accessible desks.** Reserve the four adjustable desks in desk group 1 for the people who asked for them. *Marta Quill, done in the meeting.*
- [ ] **4. Kitchen power.** Ask the landlord for a second circuit for the kitchen before the dishwasher is ordered. *Odile Larkspur, due October 24.*
- [ ] **5. Print area.** Decide whether the old copier moves or is returned at the end of its lease. *Petra Ferrow, due October 31.*
- [ ] **6. Lockers.** Count who wants a locker; order more if the twenty-four by the stairs are not enough. *Marta Quill, due November 7.*

## Discussion notes

- **Seating**
  - Teams sit together; the studio stays on the north side for the light.
  - Requests so far:
    1. Four people need adjustable desks (now in desk group 1).
    2. Two people asked to sit away from the kitchen.
  - Hot desks: none planned. ~~Two hot desks by reception~~ were dropped; nobody would use them.
- **The move itself**
  - Movers arrive at 8:00 on Saturday; IT reconnects desks on Sunday.
  - Monitors travel in the movers' own crates, *not* in personal ones.
  - A short survey goes out two weeks afterward.

Next meeting: **October 29 at 10:00**, same room. Corrections to these notes go to Mireille Ostrander by Friday.
`,
}

/* -- architecture diagram (standalone SVG) --------------------------------- */

export const SAMPLE_ARCHITECTURE = {
  file: 'architecture-diagram.svg',
  menu: 'Architecture Diagram (SVG)',
  title: 'Heron sync service: system architecture',
  subtitle: 'How an edit travels from one device to the others',
  logoAlt: 'Heron logo',
  lanes: { clients: 'Clients', edge: 'Edge', services: 'Services', events: 'Events', data: 'Data' },
  clients: ['Desktop app', 'Mobile app', 'Web app'],
  clientNote: 'Edits offline, pushes when online',
  gateway: 'API gateway',
  gatewayNote: 'Token check, rate limits',
  services: {
    auth: 'Auth service',
    sync: 'Sync service',
    blob: 'Attachment service',
  },
  serviceNotes: {
    auth: 'Issues device tokens',
    sync: 'Rebases and stores changes',
    blob: 'Files up to 25 MB',
  },
  queue: 'Change queue',
  queueNote: 'Topic doc.changed, kept 72 h',
  workers: { notifier: 'Notifier', indexer: 'Search indexer' },
  stores: { meta: 'Metadata store', objects: 'Object store', search: 'Search index' },
  storeNotes: { meta: 'Documents and revisions', objects: 'Attachments', search: 'Note text' },
  push: 'Push to other devices',
  legend: {
    title: 'Legend',
    request: 'Request and reply',
    event: 'Event, sent and forgotten',
    data: 'Reads and writes',
    service: 'Service we run',
    store: 'Data store',
  },
  footer: 'Draft for the design review, October 2026',
}

/** Every sample, in menu order. */
export const SAMPLE_ORDER = ['engineering', 'software', 'lab', 'meeting', 'architecture']
