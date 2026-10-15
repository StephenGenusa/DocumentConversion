# Shelving routes

Volumes move between rooms in a fixed order. Couriers collect crates from branches each morning, and the sorting room decides where every volume goes next.

```dot
digraph route {
  rankdir=LR;
  node [shape=box, style=rounded];
  Returns -> Sorting [label=crates];
  Sorting -> Repairs [label=damaged];
  Sorting -> Reshelving;
  Repairs -> Reshelving [label=mended];
  Reshelving -> Stacks;
  Stacks [fontname=Courier];
}
```

Branches share couriers, so their links have no direction:

```graphviz
graph branches {
  layout=neato;
  node [shape=ellipse];
  Central -- Northgate [label=daily];
  Central -- Riverside;
  Central -- Hillcrest;
  Northgate -- Riverside [label=weekly];
}
```

A plain undirected sketch of the reading room:

```gv
graph room {
  entrance -- periodicals -- fiction;
  entrance -- media;
}
```

This route is unfinished and stays as written:

```dot
digraph {
  desk -> 
}
```

Couriers report delays to the sorting room.
