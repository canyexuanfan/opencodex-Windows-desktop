# Findings: Codex-Desktop-Streaming über OpenCodex

Stand: 2026-08-11

## Problem

- DeepSeek direkt in Codex streamt in Codex Desktop sichtbar progressiv.
- Über OpenCodex traten modellabhängig End-Bursts, dauerhaftes „Denke nach“ und bei misslungenen Patches hängende Turns auf.
- Betroffen waren Responses und Chat Completions; ein einzelner Provider oder Wire-Typ erklärt das Problem nicht.
- Ziel ist echter Live-Text im Codex-Responses-Dialekt, nicht synthetisches SSE aus einer fertigen JSON-Antwort.

## Gesicherte Messungen

| Pfad | erstes erkanntes Output | Ende | Ergebnis |
|---|---:|---:|---|
| DeepSeek direkt in Codex | 2,983 s | 17,469 s | progressiv |
| OpenRouter → DeepSeek V4 Flash | 12,108 s | 50,571 s | progressiv |
| OpenRouter Responses → GLM-5.2 | 37,638 s | 37,707 s | 69-ms-Burst |
| OpenRouter Responses → Muse Spark 1.2 | 9,360 s | 9,388 s | 28-ms-Burst |
| OpenRouter Chat → GLM-5.2 | 38,534 s | 38,560 s | 26-ms-Burst |

- OpenRouter kann grundsätzlich progressiv liefern: direkter Test mit 1.945 Textdeltas über 22,126 s.
- OpenCodex kann grundsätzlich progressiv weiterleiten: HTTP-Test mit ca. 13,711 s Deltafenster und App-Server-Test mit 918 Textdeltas über 5,871 s.
- Codex-Rollouts enthalten keine Zeitstempel pro Textdelta; finale Nachrichtenzeiten beweisen weder Burst noch Streaming.
- Der OpenCode-Vergleich ist noch nicht modellidentisch: dort ist OpenRouter/DeepSeek, nicht GLM-5.2 oder Muse Spark, bestätigt.

## Getrennte Symptome

- Fehlendes `item.phase: "final_answer"` kann erklären, warum Text streamt, während „Denke nach“ bis zum Turn-Ende bleibt.
- Es erklärt keinen Text-Burst: Eine minimale Phase-Reparatur änderte GLM nicht.
- Der eingebaute DeepSeek-Pfad hatte zusätzlich `modelResponsesUpstreamStreaming: false`; das erzwang `stream:false`, vollständiges JSON und synthetisches SSE. Dies ist nicht die allgemeine Ursache.
- GPT-Zwischenmeldungen sind weder als Tool-Aufruf noch als Sidecar-Modell nachgewiesen.

## Grenze der bisherigen Messung

- Native Responses werden weitgehend unverändert weitergeleitet; der Standardpfad auf macOS nutzt `ReadableStream.tee()`.
- `firstOutputMs` erkennt nur `response.output_text.delta`, `response.reasoning_summary_text.delta` und `response.reasoning_text.delta`.
- OpenRouter dokumentiert außerdem `response.reasoning.delta`; frühe Events dieses Typs lösen die Metrik nicht aus und können für Codex unsichtbar sein.
- Daher beweist spätes `firstOutputMs` nicht, dass vorher keine Rohbytes oder anderen SSE-Events ankamen.
- Der Chat-Adapter reicht jedes `delta.content` sofort weiter. Er erkennt String-Felder `reasoning` und `reasoning_content`, aber kein strukturiertes `reasoning_details`.
- Noch offen ist, ob Text bereits früh am ersten Reader ankommt, Bun Chunks spät exponiert oder Requestfelder upstream ein anderes Streaming-Verhalten auslösen.

## Widerlegte oder gefährliche Ansätze

- Reasoning, ein einzelner Provider oder Responses/Chat als pauschale Hauptursache.
- `stream:false`: verhindert echtes Upstream-Streaming.
- Globales Parsen und Serialisieren aller SSE-Events: veränderte das Chunking und korrelierte mit Bursts.
- Synthetischer Terminal-Timer und globale Phase-Reparatur: verursachten Hänger und wurden entfernt.
- Alte PR-#123-Macrotask-Yields (`008c879f`): änderten GLM im minimalen Versuch nicht.
- `streamMode: "eager-relay"` kann `tee()` isolieren, erklärt aber keinen Chat-Completions-Burst.

## Nächster entscheidender Test

Direkt am ersten Upstream-Reader nur Zeit, Bytezahl und SSE-Eventtyp erfassen; niemals Text, Prompt, Header oder Schlüssel:

- erster Rohchunk
- erstes `response.reasoning.delta`
- erstes und letztes `response.output_text.delta`
- Anzahl und Größe der Textdeltas
- Terminal-Event

Auswertung:

- Frühe `output_text`-Events am Reader, später Client-Burst → Fehler nach dem Reader in OpenCodex.
- Frühe Reasoning-, aber späte Text-Events → Upstream-/Requestverhalten plus Dialekt-/UI-Lücke.
- Erster Rohchunk erst am Ende → exakt denselben Request mit Bun und `curl --no-buffer` vergleichen.
- Danach GLM-5.2 modellidentisch in OpenCode testen und Requestfelder vergleichen.

## Isolierte Experiment-Installation

- Offiziell: `/opt/homebrew/bin/ocx`, Version 2.12.0; nicht verändert.
- Experiment: `ocx-exp`, Version 2.12.0 aus Release-Commit `6d881db20`, Port 10101.
- Eigene Daten: `~/.local/share/opencodex-experiment/home`; eigenes Codex-Home: `~/.local/share/opencodex-experiment/codex-home`.
- Paketkopie: `~/.local/share/opencodex-experiment/runtime`; Befehl: `~/.local/bin/ocx-exp`.
- `update`, `service`, `codex-shim`, `tray` und der parameterlose Start sind gesperrt.
- Start nur durch Robin im Vordergrund: `ocx-exp start`; der Agent führt keine Lifecycle-Kommandos aus.

## Aktueller Zustand

- Keine untersuchte Streaming-Lösung ist im Quellbaum aktiv.
- Kein Patch gilt als Lösung des GLM-/Muse-Bursts.
- Offizielle und experimentelle Installation basieren für den A/B-Ausgangspunkt auf Release 2.12.0; der geöffnete Entwicklungsbranch bleibt separat auf `origin/dev` (`e8db4e036`).

## A/B 2026-08-11 abends (beide Instanzen live, 10100 + 10101)

- Quellcode identisch (`diff -rq` offiziell vs. `runtime/` leer), `config.json` identisch bis auf `port` + `googleAntigravityStaticCatalogVersion: 2` (nur Experiment), API-Keys identisch (SHA-256).
- HTTP-A/B, gleicher Request (Zahlen 1–500, `opencode-go/deepseek-v4-flash`, effort max, 3 Läufe): beide Instanzen liefern 999 `output_text.delta` über ~4 s (p50 0 ms, p90 14–22 ms), `response.completed` + `final_answer` vorhanden. KEIN Burst, kein fehlender Terminal-Event.
- Einziger messbarer Unterschied: TTFT offiziell ~5 s höher (14,5–18,1 s vs. 9,5 s), mehr `response.heartbeat` (7/5 vs. 3).
- Weitere Ist-Differenzen: offizielle Instanz bedient Desktop UND Agent-Turns (ein Bun-Event-Loop), Experiment exklusiv; `responses-state.json` 24 MB/24 States vs. 2,6 KB/3; Start als Service vs. Vordergrund; `config_generation` 28 vs. 2.
- Schluss: Kein Code-/Config-Unterschied erklärt Burst oder fehlendes Completed. Nächstliegend: Last-Kontention auf der offiziellen Instanz (parallele Agent-Session) verzögert die SSE-Weitergabe im Desktop. Offener Test: Integer-Turn via offiziell ohne parallelen Agent-Traffic bzw. mit definierter Parallellast.
