---
title: Heron Sync Service Design Specification
---

# Heron Sync Service: Design Specification

**Version 0.9, draft for review** · Owner: Nils Ashcombe · Reviewers: Iris Vellum and Sunil Braddock · October 14, 2026

Heron keeps a user's notes the same on every device they own, including edits made offline. This specification covers the service side: how a change is accepted, stored and announced, and what happens when two devices edit the same note. The client library is covered only where it shapes the protocol.

## Goals and non-goals

Heron **will** accept edits from any number of devices, merge edits that do not overlap without asking the user, and tell every other device about a change within two seconds. It **will not** offer real-time co-editing with live cursors in this version, nor sync attachments larger than 25 MB, which stay with the existing upload service.

## Requirements

1. The service <u>must</u> accept a change made against any earlier revision, and rebase it onto the head when the edits do not overlap.
2. Every accepted change must be durable before the client hears `201 Created`.
3. A change must be idempotent: sending the same `changeId` twice stores it once.
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
|---|---|---|---|
| `GET` | `/v1/docs/:id` | Head revision and its text | `200` |
| `GET` | `/v1/docs/:id/revisions` | Revisions newer than `?after=n` | `200` |
| `POST` | `/v1/docs/:id/changes` | Push a change | `201` |
| `POST` | `/v1/docs/:id/resolve` | Choose between sibling revisions | `200` |
| `DELETE` | `/v1/docs/:id` | Move a document to the trash | `204` |

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
