# Loan arithmetic

Branches calculate overdue charges, average borrowing and shelving capacity with the formulas below. Treasurers check every figure before the monthly report.

A volume returned $d_i$ days late owes $f_i = r \cdot d_i$, where the daily rate $r_{\text{day}}$ is set by each branch, and a reader pays at most $\min(f_i, 20)$.

Over a month, the fines collected from all returns are

$$\sum_{i=1}^{n} f_i = r \sum_{i=1}^{n} d_i$$

The average loan, numbered so the report can refer to it:

$$\bar{x} = \frac{1}{n} \sum_{i=1}^{n} x_i \tag{1}$$

Fines start after a week of grace:

$$f(d) = \begin{cases} 0 & d \le 7 \\ r\,(d - 7) & d > 7 \end{cases}$$

Shelf capacity per room, by wall and by tier:

$$C = \begin{pmatrix} 120 & 80 \\ 95 & 60 \end{pmatrix}$$

Smaller pieces sit in the line of text: a share $\frac{a}{b}$ of the stock, a decay $e^{-\lambda t}$ in demand, a spread $\sqrt{\sigma^2 + 1}$ and an area $\int_0^1 x^2 \, dx$.

Membership costs $5 for students and $10 for everyone else.

The nightly export is started from a terminal:

```sh
$ export-loans --since yesterday
```

One formula uses a command TeX does not know and stays as written: $\fines{d}$.

Treasurers round every charge to the nearest penny.
