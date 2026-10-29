# What's new

Release notes for Document Converter, newest first. See the
[README](README.md) for what the app does and how to use it.

- [Not yet released](#not-yet-released)
- [1.5.2](#whats-new-in-152)
- [1.5.1](#whats-new-in-151)
- [1.5](#whats-new-in-15)
- [1.4](#whats-new-in-14)
- [1.3](#whats-new-in-13)
- [1.2](#whats-new-in-12)
- [1.1](#whats-new-in-11)

## Not yet released

- **A pasted AI answer opens as Markdown.** A few lines of prose and then
  Markdown with fenced code blocks opened as one code block, colored as the
  first language in it, with `##` and the fences shown as text: the code in
  the fences outvoted the prose round it. It now opens as headings, lists and
  paragraphs, each code block colored in its own language.
- **Markdown copied from where it is shown as source opens as Markdown.** A
  raw `.md` page in a browser, or a JetBrains IDE or Kate, put the document
  on the clipboard as one `<pre>`, which became one code block. Code copied
  the same way is still one code block.
- **Markdown pasted into a document already open is formatted** as it is on
  the start screen. Into a code block it stays text.
- **Ctrl+S saves a copy of a file open in the editor** in the file's own
  format, through the save dialog, which opens on a new name (`notes-1.md`).
- **A file you added is never written over.** Converting `notes.md` to
  Markdown offered `notes.md` itself in the save dialog, and only the
  system's "Replace?" stood between it and the loss of everything the
  converter does not keep, such as its front matter. The dialog now offers a
  new name, and refuses the original with a warning however it is chosen:
  typed back in, through a link, or by another spelling of its path. The
  command line refused nothing: `docconv convert notes.md --to md` replaced
  `notes.md` with its conversion. It now exits 1 and leaves the file alone.

## What's new in 1.5.2

- **Links to a document's own headings work.** A contents list or a "see
  [Sources](#11-sources)" link, written as GitHub writes them, printed as
  blue text that went nowhere: no output gave a heading anything to link to.
  Each heading now gets the anchor GitHub gives it, and the link follows it
  in every output that can link:
  - **PDF and HTML:** a link to the heading.
  - **Word:** a bookmark at the heading and a link to the bookmark, so the
    link jumps there in Word and LibreOffice.
  - **EPUB and AZW3:** a link to the heading, in whichever chapter it is.
  - **Slides (reveal.js):** a link to the slide that holds the heading.
  - Markdown output keeps the links as written.
  - A link to a heading that is not there keeps its text and loses the link.
- **A bookmarks sidebar in every PDF.** A PDF now has an outline, one entry
  per heading, nested by level, in any PDF reader's bookmarks pane. The PDF
  is also tagged for screen readers. The tags make a PDF larger: a 40-page
  guide went from 466 KB to 1.05 MB.
- **Code in a quote no longer stops a Word conversion.** A block quote
  holding any code, inline or a block, made the whole conversion fail with
  "Cannot read properties of undefined (reading 'createFont')". It now
  converts, the code in the code font as everywhere else.

## What's new in 1.5.1

- **Pictures beside a document now show.** A Markdown document that names its
  pictures by path, such as `![chart](assets/chart.svg)`, showed each one as
  its description, in the editor and in every output. They are now read from
  disk and embedded, relative to the document's folder. Any path Markdown can
  write works: `assets/fig.svg`, `../images/fig.png`, an absolute path, a
  Windows `C:\pics\fig.png` or a `file:///…` URL. The Djot and Textile
  readers and a notebook's Markdown cells do the same, and so does the
  command line.
  - Only pictures are read: a file is embedded only if its contents really
    are an image, and only an ordinary file is opened.
  - A network share (`\\host\share`) is never read.
  - A picture that is missing becomes its description, as before.
  - Documents inside a zip have no folder of their own, so their pictures by
    path are still not found.

## What's new in 1.5

- **Open a document from outside the app.** A document dropped on the app's
  icon, or opened with it, is added as if chosen with *Open file*:
  - **macOS:** drop it on the Dock icon, or use Finder's *Open With*. The
    app is offered for documents (Word, PDF, RTF, OpenDocument,
    spreadsheets, slides, EPUB, web pages, Markdown and text, the markup
    formats, email, calendars and contacts, notebooks, subtitles,
    drawings, TIFF scans and data files) but never made their default.
  - **Windows:** drop it on the desktop shortcut or the program, or use
    *Open with* and choose the program.
  - **Linux:** the AppImage's desktop entry lists the same documents, so
    once the AppImage is integrated into the desktop (AppImageLauncher, Gear
    Lever or the like), file managers offer it under *Open With*. Docks that
    pass a dropped file to an app icon do so too; Ubuntu Dock on GNOME 42
    does not.
  - Files given on the command line without `convert`
    (`./docconversion-1.5.1.AppImage report.docx`) open in the window too.
- **One window.** Opening a document while the app is running adds it to
  that window instead of starting a second app. The command line is not
  affected: `convert` still runs with the window open.
- **Smaller downloads.** Each package carried the PDF picture engine for
  every platform it was built beside (about 33 MB each), and the macOS zip
  held the Electron framework three times over. Each now carries only its
  own: the macOS zip is 207 MB (was 451 MB), the Windows installer 172 MB
  (was 184 MB) and the AppImage 203 MB (was 207 MB).

## What's new in 1.4

1.4 is the largest release so far. In short: diagrams and formulas are drawn,
nine more input formats are read, pictures of every common kind go everywhere
they can, code is colored, the app has Settings, and Word and Kindle output
are much more faithful.

**Diagrams, formulas and code**

- **Diagrams are drawn, offline.** Mermaid (flowcharts, sequence, class,
  state, Gantt, mind maps, pies, timelines, git graphs and the rest) and
  Graphviz (`dot`) blocks become pictures in every output: sharp SVG in PDF,
  HTML, slides, EPUB and Kindle Print Replica, PNG in Word and Kindle (AZW3).
  A diagram that fails to draw keeps its source, with a notice. See
  [Diagrams, formulas and code](README.md#diagrams-formulas-and-code).
- **TeX formulas are drawn with MathJax.** `$…$` and `$$…$$` in Markdown,
  and math in AsciiDoc, reStructuredText, Djot and notebooks, print as
  formulas; a document's `\newcommand` carries to its later formulas, and
  `\R`, `\N`, `\bm` and basic siunitx quantities (`\SI`, `\si`, `\num`)
  work. Every formula is drawn however many a document has, with progress.
- **Word equations are read as formulas**, display or inline as Word has them,
  including line breaks, alignment, boxes and brackets.
- **Code is colored by language** in PDF, HTML, slides, EPUB, Kindle and Word,
  with a night palette in e-books and a dark one on dark slides; the author's
  bold, italic and links inside a code block are kept. Settings → Code (or
  `--no-code-color`) writes it plain.

**New inputs**

- **SVG, EMF and WMF drawings, TIFF (every page), BMP, AVIF and ICO** open on
  their own. EMF and WMF (Word's vector pictures) are drawn as SVG by the app's
  own code, gradients, right-to-left text and masked bitmaps included, and
  also convert to text and Markdown as their labels.
- **JSON and JSON Lines** (records become a table), **SQLite databases**
  (schema, every table, views on request), **WebVTT and SRT subtitles** and
  Teams transcripts, **OPML** outlines, **vCard** contacts, **Djot** and
  **Textile**. R Markdown and Quarto, and many more source-code and
  configuration extensions, are read too.
- **A file named for one format but holding another** (a TIFF named `.txt`, a
  Word file named `.md`) is read as what it is, and the app says so.

**Formatting kept**

- **Footnotes** survive every conversion, from Word, RTF, OpenDocument,
  Markdown (`[^1]`), Djot and Textile, and the editor can insert them.
- **Highlighted text** keeps its color through every format, and the editor
  has a Highlight button (Ctrl+Shift+H).
- **Definition lists** from Djot, AsciiDoc, Textile, HTML, reStructuredText
  and Markdown (pandoc's `term` / `:   definition`) stay definition lists.
- **GitHub Markdown:** task lists, alerts (`> [!NOTE]`), single-tilde
  strikethrough and emoji shortcodes; YAML front matter is read (its `title:`
  becomes the document title) instead of being printed as a heading.
- **Superscript, subscript, table column alignment** and **line breaks in
  spreadsheet cells** are kept through every format.
- **Inline SVG** in web pages, pastes, EPUB chapters, email and calendar
  descriptions is kept, as are pictures inside SVGs.

**Word output**

- **Italic, strikethrough and combined formatting** (***bold italic***,
  ~~struck~~) were lost in Word files; they are now kept, as are colors on
  bold and italic words, background colors, and links inside formatting.
- **Word's own page:** 1-inch margins, the page size chosen for PDF (A4 or
  Letter, from Settings), Automatic orientation, and a section a page for a
  fax of portrait and landscape pages.
- **Tables:** columns sized by their content, header rows repeated on each
  page, merged cells and cell borders written as Word expects, tables inside
  cells no longer lost.
- **Code blocks** keep their lines, their language and their monospace font,
  and Word files read back with their code blocks, inline code and math.
- **Pictures:** TIFF, EMF and WMF stay as they are in Word; every SVG picture
  gets a PNG copy Word can show, however many a document has.

**Kindle**

- **AZW3 books open in calibre.** calibre refused every AZW3 the app wrote,
  because of two index fields the writer left wrong; they are now written as
  kindlegen writes them, and the book ends with kindlegen's end-of-file record.
- **AZW3 books have their pictures.** They used to drop every image; pictures
  are now stored in the book, converted to fit Kindle's 5 MB limit when
  needed.

**Pictures**

- **Automatic pictures.** A picture an output can't hold as it is (a TIFF in
  a PDF, a WebP in a Kindle book) becomes PNG when it is a screenshot, line
  art, a diagram, a scan or a GIF, so lines and text stay sharp, and JPG when
  it is a photograph, much smaller. Pictures with see-through parts stay PNG.
  Settings → Pictures (or `--pictures`) can make them all JPG or all PNG.
- **Automatic orientation.** The PDF toolbar's Orientation starts at
  *Automatic*: a wide picture or drawing opened on its own prints on a
  landscape page, a TIFF of portrait and landscape pages keeps each page's
  own orientation, and a document that is mostly tables too wide for a
  portrait page prints landscape. Everything else stays portrait. *Portrait*
  and *Landscape* print every page that way, exactly as before. Word has the
  same choice. On the command line it is `--orientation auto|portrait|landscape`
  (`auto` by default); `--landscape` still works.
- **Every page of a TIFF is recognized** by OCR, page by page, and a picture
  of a page (a scan, a fax) prints filling its page.
- **No size limits on pictures.** Pictures of any size convert, and every
  formula and diagram in a document is drawn; the limits left are the ones
  that protect memory (a picture over 50 megapixels, a TIFF page chain that
  loops).

**Web pictures, intranet and security**

- **Every web picture is fetched, intranet ones included.** 1.3 stopped at 100
  images and 25 MB a document and refused intranet addresses. Now there is no
  count or total, each picture may be up to 200 MB, and private addresses such
  as `http://intranet/logo.png` load. This machine and cloud metadata addresses
  are still refused. Pictures an SVG names by web address are fetched too.
- **Security fix: DNS rebinding.** The address check and the connection used
  to look the name up separately, so a host name could answer a public address
  to the check and this machine to the connection. The connection is now made
  to the address that was checked. OCR language downloads use the same guarded
  path. See [Images and the network](README.md#images-and-the-network).
- **Builds carry no update address.** Every earlier build held an
  `app-update.yml` naming this repository, although no updater reads it; it is
  gone.

**Settings and the command line**

- **Settings.** A Settings dialog holds the defaults for choices most people
  make once. Open it with **File → Settings…** (Ctrl+,) on Windows and Linux,
  **Settings…** (Cmd+,) on macOS, the start screen's *Settings* link or the
  conversion screen's gear button. Its seven sections cover pictures, the
  web, formulas and diagrams, code, pages, reading and OCR, and every setting says
  which outputs it affects. Settings are remembered from one start to the
  next; a change on the conversion screen lasts only until you quit. Web
  pictures, intranet pictures and code color can each be turned off there.
  See [Settings](README.md#settings).
- **The command line takes the same settings.** `--settings <file>` starts from
  a settings file and `--settings app` from the app's own; without either, the
  built-in defaults are used and nothing on disk is read. New flags:
  `--pictures <auto|jpg|png>`, `--ocr-lang <code>`, `--orientation`,
  `--diagrams <svg|png>`, `--json-as <table|text>`, `--no-timestamps`,
  `--sqlite-views`, and the pairs `--fetch`/`--no-fetch`,
  `--local-network`/`--no-local-network`, `--code-color`/`--no-code-color`
  and `--header-footer`/`--no-header-footer`, so a flag can turn back on what
  a settings file turns off. See [Command line](README.md#command-line).

**The app**

- **Sample documents.** Help → Sample Documents (and the start screen's
  *Sample documents* link) opens one of five invented documents that show off
  diagrams, formulas, code, tables and pictures. See
  [Sample documents](README.md#sample-documents).
- **The editor** draws diagrams and formulas as you type (a diagram's source
  over its drawing, an inline formula in a popover), colors code by language
  with a searchable language picker (Ctrl+Alt+L), and has Insert buttons for
  formulas, diagrams and footnotes. See
  [Editing before converting](README.md#editing-before-converting).
- **About and licenses.** Help → About shows the version and the license of
  every component the app ships; the window title shows the version too.
- **Slides** split a titled document into section slides and shrink a slide
  that is too long to fit; long titles fit instead of filling the slide.
- **File dialogs** open on top of the window, one at a time, and the editor
  stays inside its card in a narrow or short window.

**Faster, and lighter on memory**

- A 12 MB SVG file converts to Word in about 3 seconds (was 18) and no longer
  needs more than a gigabyte of memory to be cleaned.
- Excel output is written as it goes and compressed: a million rows take
  about 3 seconds and 300 MB (were 10 seconds and 3 GB), and the file is a
  sixth of the size. An empty cell is now empty in Excel, not empty text.
- A SQLite view that would need more memory than a database is given (a
  quarter of the computer's, at most 1.5 GB) is stopped with a message, and
  the rest of the database is still converted.
- Record files (CSV, JSON Lines and the like) of any size are read, stopping
  with a notice if memory runs out; long code blocks color quickly in the
  editor, and Markdown with long pictures is written in linear time.

## What's new in 1.3

- **Pasted images show up.** Copying from a web page puts only the images'
  addresses on the clipboard, and the editor would not load them, so each one
  was an empty box. The app now downloads them and embeds them before the
  editor opens. A progress bar counts them, and *Skip remaining images* opens
  the editor at once with what has arrived.
- **A document's web images are embedded in every output.** An `.html` or `.md`
  file that refers to images by web address now gets those images embedded when
  it is read, so html, slide and e-book output no longer depends on the website
  staying up.
- **A dead image no longer fails a Word document.** An image the Word writer
  could not download made the whole conversion fail with "console.warning is
  not a function".
- **Email and calendar invitations never load remote images.** Those images are
  how a sender learns a message was opened, and from where. They are replaced
  by their description, as a mail client does.
- **Conversion makes no network requests of its own.** The Word writer and the
  PDF renderer used to fetch remote images themselves, without the checks that
  keep a document from reaching addresses on your local network. All fetching
  now goes through one guarded path, and the PDF renderer is cut off from the
  network entirely.
- **A larger image budget.** Up to 100 images and 25 MB per document or page,
  was 20 and 10 MB, downloaded four at a time.
- **A web page or error served in place of an image is not embedded.** It
  becomes the image's description instead of a broken picture.

## What's new in 1.2

- **A file is read again every time it is converted.** 1.1 read a file once,
  when it was added, and converted those bytes from then on: edit the file in
  another program, convert again, and the output was the old version with
  nothing to say so. The app now goes back to the disk at each conversion.
  Pasted text, a fetched page and the entries of a zip have no file to go back
  to, and stay as they were added.
- **Edits made in the editor survive a conversion.** Dismissing a result rebuilt
  the editor from the original text, so the edits were gone and the next
  conversion quietly produced the original. Canceling the save dialog lost them
  the same way. Edits are now stored before any result is shown, whatever the
  result is.
- **A file that changes on disk while it is open in the editor is not reloaded
  behind your back.** Your edits win. A notice says the file changed on disk and
  offers *Reload from disk* or *Keep my edits*; the conversion uses your edits
  until you choose.
- **A file that was moved, renamed or deleted is reported by name** instead of
  being converted from the bytes it used to have. In a batch it costs its own
  row and nothing else.
- **Edit opens a file as it is now**, not as it was when it was added.

## What's new in 1.1

- **OCR language packs install on Windows.** 1.0 refused every pack there with
  "Unknown OCR language": the check that keeps a pack inside its folder compared
  the path against a `/`, and Windows paths use `\`.
- **All 25 OCR languages can be installed.** The checksum table that verifies a
  download now covers every language in both model sets; 1.0 recorded three.
  The pack list shows each file's real size.
- **PDF zoom defaults to 90%.** The on-screen prose size printed a little large
  at 100%. The app, the CLI's `--scale` and the headless path all start at 0.9.
- **A horizontal rule starts a new page in PDF output.** `---` in Markdown, a
  transition in reStructuredText, or the seam between messages in an mbox now
  breaks the page rather than drawing a line. The rule itself is hidden. Two
  rules in a row give one break, a closing rule adds no blank page, and a rule
  that opens the document leaves the first page in place.
