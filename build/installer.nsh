; Windows "Open with": the installer's half of what mac.fileAssociations and
; linux.mimeTypes in electron-builder.yml do on the other systems.
;
; electron-builder picks this file up as nsis.include (build/ is
; buildResources). Not electron-builder's own `fileAssociations`: its
; APP_ASSOCIATE writes each extension's default value, making the app the
; default for .docx, .pdf, .html and the rest. This only offers it:
;
;   Software\Classes\.<ext>\OpenWithProgids    the right-click Open with menu
;   Software\Classes\Applications\<exe>         the "Choose another app" list
;   <ProgID> and Capabilities, listed under     Settings > Apps > Default apps
;     RegisteredApplications                    (the user still has to pick it)
;
; SHCTX is HKCU for a per-user install and HKLM for a per-machine one. The
; uninstaller removes only what is ours: our value under each OpenWithProgids,
; never another app's, and never an extension's key. An update runs the old
; uninstaller first, then customInstall again.
;
; The extensions are mac.fileAssociations' (tests/build/file-associations.test.ts
; holds the two lists equal).

!define DOCCONV_PROGID "DocumentConverter.Document"
!define DOCCONV_APP_KEY "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
!define DOCCONV_CAPABILITIES "Software\DocumentConverter\Capabilities"

!macro docconvForEachExt MACRO
  !insertmacro ${MACRO} docx
  !insertmacro ${MACRO} docm
  !insertmacro ${MACRO} doc
  !insertmacro ${MACRO} pdf
  !insertmacro ${MACRO} rtf
  !insertmacro ${MACRO} odt
  !insertmacro ${MACRO} ods
  !insertmacro ${MACRO} odp
  !insertmacro ${MACRO} xlsx
  !insertmacro ${MACRO} xls
  !insertmacro ${MACRO} csv
  !insertmacro ${MACRO} tsv
  !insertmacro ${MACRO} pptx
  !insertmacro ${MACRO} pptm
  !insertmacro ${MACRO} epub
  !insertmacro ${MACRO} html
  !insertmacro ${MACRO} htm
  !insertmacro ${MACRO} md
  !insertmacro ${MACRO} markdown
  !insertmacro ${MACRO} mdown
  !insertmacro ${MACRO} mkd
  !insertmacro ${MACRO} mkdn
  !insertmacro ${MACRO} mdwn
  !insertmacro ${MACRO} markdn
  !insertmacro ${MACRO} rmd
  !insertmacro ${MACRO} qmd
  !insertmacro ${MACRO} txt
  !insertmacro ${MACRO} text
  !insertmacro ${MACRO} adoc
  !insertmacro ${MACRO} asciidoc
  !insertmacro ${MACRO} asc
  !insertmacro ${MACRO} rst
  !insertmacro ${MACRO} djot
  !insertmacro ${MACRO} dj
  !insertmacro ${MACRO} textile
  !insertmacro ${MACRO} opml
  !insertmacro ${MACRO} eml
  !insertmacro ${MACRO} msg
  !insertmacro ${MACRO} mbox
  !insertmacro ${MACRO} ics
  !insertmacro ${MACRO} ical
  !insertmacro ${MACRO} vcf
  !insertmacro ${MACRO} vcard
  !insertmacro ${MACRO} ipynb
  !insertmacro ${MACRO} vtt
  !insertmacro ${MACRO} srt
  !insertmacro ${MACRO} svg
  !insertmacro ${MACRO} emf
  !insertmacro ${MACRO} wmf
  !insertmacro ${MACRO} tif
  !insertmacro ${MACRO} tiff
  !insertmacro ${MACRO} json
  !insertmacro ${MACRO} jsonl
  !insertmacro ${MACRO} ndjson
  !insertmacro ${MACRO} sqlite
  !insertmacro ${MACRO} sqlite3
  !insertmacro ${MACRO} db3
!macroend

!macro docconvOfferExt EXT
  WriteRegNone SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${DOCCONV_PROGID}"
  WriteRegStr SHCTX "${DOCCONV_APP_KEY}\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHCTX "${DOCCONV_CAPABILITIES}\FileAssociations" ".${EXT}" "${DOCCONV_PROGID}"
!macroend

!macro docconvWithdrawExt EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${DOCCONV_PROGID}"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${DOCCONV_PROGID}" "" "Document"
  WriteRegStr SHCTX "Software\Classes\${DOCCONV_PROGID}" "FriendlyTypeName" "Document"
  WriteRegStr SHCTX "Software\Classes\${DOCCONV_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "Software\Classes\${DOCCONV_PROGID}\shell\open\command" "" '"$appExe" "%1"'

  WriteRegStr SHCTX "${DOCCONV_APP_KEY}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "${DOCCONV_APP_KEY}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "${DOCCONV_APP_KEY}\shell\open\command" "" '"$appExe" "%1"'

  WriteRegStr SHCTX "${DOCCONV_CAPABILITIES}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "${DOCCONV_CAPABILITIES}" "ApplicationDescription" "Converts documents to PDF, Word, Markdown, HTML, EPUB and more."
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCT_NAME}" "${DOCCONV_CAPABILITIES}"

  !insertmacro docconvForEachExt docconvOfferExt

  ; SHCNE_ASSOCCHANGED, so Explorer shows the change without a sign-out.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro docconvForEachExt docconvWithdrawExt
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey SHCTX "Software\DocumentConverter"
  DeleteRegKey SHCTX "${DOCCONV_APP_KEY}"
  DeleteRegKey SHCTX "Software\Classes\${DOCCONV_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
