# Log

Registro append-only in stile LLM Wiki (Karpathy). Una riga di intestazione per
evento, prefisso coerente `## [AAAA-MM-GG] tipo | titolo`, così è filtrabile con
strumenti unix. Non riscrivere le voci passate: si aggiunge in fondo.

## [2026-11-23] fix | Coerenza timeline vocale / finestre di mix / cache (analysis v3)

Risolte le contraddizioni tra la timeline Demucs e le finestre di mix che
rendevano la seconda analisi di uno stesso brano diversa dalla prima (e
potevano marcare come mixabili sezioni cantate). Vedi [[analysis-mix-engine]].

- Una SINGOLA corsa Demucs su tutto il brano (`stems.analyze_vocal_track`)
  produce ora tutti i segnali vocali: `timeline.vocalRisk`,
  `firstVocalAt`/`lastVocalAt`, `vocalIntro`/`vocalOutro` e densità head/tail,
  tutti derivati dalla stessa envelope e quindi mutuamente consistenti.
- Rimosso il vecchio percorso `analyze_vocals` head/tail (seconda corsa
  Demucs separata) e `refine_vocal_risk`: l'euristica non può più sovrascrivere
  la mappa autorevole. `mixableIntro` è clampato a fermarsi prima di
  `firstVocalAt` (passo di timeline incluso).
- Fallback pulito: se Demucs manca o solleva eccezioni, `vocalSource="heuristic"`,
  `firstVocalAt`/`lastVocalAt` null e `vocals == {"available": False}` — nessun
  campo Demucs residuo, anche da tracce/analisi precedenti.
- Cache: la key già distingueva byte+versione+stems/nostems; aggiunta
  validazione strutturale all'hit (`_is_valid_cached_result`), così un hit ha
  sempre la stessa shape di una miss. `ANALYSIS_VERSION` portata a 3: le entry
  v2 vengono ignorate.
- Prima traccia senza voce: `firstVocalAt`/`lastVocalAt` sono `null` (prima
  venivano riportati 0/duration).

## [2026-06-06] sessione | Precisione intro/outro + voce Demucs

Lavoro guidato da feedback reale dell'utente ("parte a metà / esce a 2/3 / cantato
su cantato / override non risponde"). Vedi [[current-status]], [[analysis-mix-engine]].

- Cue-in = primo suono reale (RMS grezzo vs picco ~8%, non energia a percentili).
- Griglia a battute (4 beat) per entry/introEnd/mixPoint.
- mixPoint tardivo + senza voce; durata transizione limitata a intro entrante e a
  coda uscente → la canzone suona fino in fondo (niente taglio a 2/3).
- Segmentazione strutturale DSP (`structural_boundaries`: chroma+MFCC beat-sync,
  agglomerative) per snap di introEnd/outroStart.
- Voce autoritativa: Demucs sull'INTERO brano → `timeline.vocalRisk`
  (`vocalSource="demucs"`), stems ON di default, cache analisi versionata.
- Override manuale marker ripristinato (`bestCandidate`).
- Decisione: baseline DSP → Demucs → allin1 come step 2. Vedi [[decisions]],
  [[roadmap]].
- DA VALIDARE: l'utente non ha ancora provato il fix Demucs su brani reali.

## [2026-06-05] sessione | Pipeline di mix spiegabile (analysis v2)

Introdotta la pipeline v2 (`par8dj-mixengine-v2`): timeline 1s, candidati con
punteggio+motivazioni, phrase grid 16/32/64, loudness truePeak/lra/crest,
`plannedTransition` condivisa, pannello debug. Vedi [[analysis-mix-engine]].
