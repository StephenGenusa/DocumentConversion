# Returns procedure

Returned volumes travel through sorting, inspection and reshelving before borrowers see them again. Damaged volumes wait for repairs.

```mermaid
flowchart TD
  R[Returned volume] --> S{Damaged?}
  S -->|No| H[Reshelve]
  S -->|Yes| P[Repairs queue]
  P --> H
```

The desk and the catalogue exchange two messages for every return.

```mermaid
sequenceDiagram
  participant Desk
  participant Catalogue
  Desk ->> Catalogue: Item returned
  Catalogue -->> Desk: Status updated
```

This one is unfinished and stays as written:

```mermaid
flowchart TD
  Q -->
```

Graphviz is kept as source for now:

```dot
digraph { shelf -> trolley }
```

Overdue charge: $$c = r \times d$$
