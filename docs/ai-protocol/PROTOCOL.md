# Tremiom AI session protocol v1.0

This protocol lets an AI assistant interpret and manipulate only the data
already present in one Tremiom browser session. It does not require MCP or
give the model direct access to Tremiom, its server, upstream services, other
sessions, or the filesystem.

The two normative grammars are:

- [`session-input.schema.json`](./session-input.schema.json) — evidence
  Tremiom may supply to the model.
- [`session-output.schema.json`](./session-output.schema.json) — response,
  evidence citations, UI actions, and bounded data requests the model may
  return.

Both are JSON Schema Draft 2020-12 documents. The application must use strict
schema validation or the model provider's structured-output facility. Model
output is untrusted even when constrained by a schema.

## Normative system instructions

The schemas define syntax. The following rules define semantics and should be
part of the assistant's stable system prompt:

1. The input envelope is the complete observable world for this turn. Do not
   claim to have observed an event, station, pick, waveform, plot, interval,
   or measurement that is absent.
2. Operate only on the current session. Never request a new upstream fetch,
   arbitrary event or station search, another session, server configuration,
   credentials, URLs, files, or code execution.
3. Distinguish observation from interpretation. Measurements and catalog
   fields are observations; source classification and physical explanation
   are interpretations.
4. Cite every material scientific claim with one or more `evidenceId` values
   from the current input. Never invent an evidence identifier.
5. Respect `status`, `quality.status`, coverage, gaps, clipping, response
   removal, units, component, filter, sample rate, decimation, time window,
   and algorithm provenance. Absence of data is not evidence of absence.
6. Use UTC timestamps internally and state explicitly when displaying another
   timezone. Never mix seconds from origin with absolute timestamps.
7. Treat predicted arrivals as model predictions, automatic picks as
   preliminary observations, and manual reviewed picks as analyst decisions.
   Do not represent TauP predictions as detected arrivals.
8. Do not assign an authoritative event type, origin, magnitude, or focal
   mechanism from weak or single-station evidence. State alternatives and
   limitations when discrimination is not robust.
9. Prefer compact summaries. Request a bounded series excerpt only when the
   supplied summary cannot answer the user's question.
10. Returned actions are proposals. A `propose-pick` or `export-session`
    action always requires user confirmation. Never claim an action succeeded
    until Tremiom returns a completed action result.
11. All referenced event IDs, station IDs, pick IDs, plot IDs, and evidence
    IDs must occur in the current input. The application must independently
    enforce this membership rule.
12. Return exactly one JSON object conforming to the output grammar. Put
    user-facing prose in `message`; emit no text outside the JSON object.

The provider-facing system prompt can embed these rules and the two schemas,
or provide the output schema through a structured-output API. Because the
protocol is stable, it is suitable for prompt caching.

## Input grammar

At a conceptual level:

```text
Input :=
  ProtocolVersion
  + Turn
  + UserRequest
  + SessionManifest
  + SessionEvidence
  + OptionalConversationSummary

SessionEvidence :=
  Events
  + Stations
  + Picks
  + PlotContexts
  + PriorActionResults
```

The session manifest is an allowlist. An item being present in a server cache
does not place it in the AI session; it must appear in the input manifest and
evidence collection.

Every evidence-bearing object has a stable `evidenceId`. Scientific prose can
therefore be traced to the exact input object without copying large arrays
into the conversation.

### Plot vocabulary

The grammar covers all current Tremiom panel and event visualizations:

| Plot type | Scientific content | Summary type |
|---|---|---|
| `world-map` | Session events, stations, selection and viewport | `map` |
| `record-section` | Distance-ordered traces and P/S predictions/picks | `record-section` |
| `drum` | 24-hour, six-second min/max envelope | `time-series` |
| `helicorder` | Short rolling waveform strip | `time-series` |
| `raw-scope` | Processed waveform window | `time-series` |
| `three-comp` | Z plus N/E or 1/2 components | `time-series` |
| `spectrogram` | Time-frequency power | `spectral` |
| `spectrum` | Instantaneous amplitude spectrum | `spectral` |
| `psd` | Welch power spectral density | `spectral` |
| `ppsd` | Probabilistic noise distribution | `spectral` |
| `sta-lta` | Detection characteristic function | `trigger` |
| `particle-motion` | Horizontal hodogram/polarization | `polarization` |
| `hv` | Horizontal-to-vertical spectral ratio | `spectral` |
| `rsam` | Binned real-time seismic amplitude trend | `time-series` |
| `network` | Multi-station comparison/coherence | `network` |
| `qc` | Availability, latency, RMS, gaps and clipping | `quality-control` |
| `beachball` | Focal-mechanism nodal plane | `mechanism` |
| `dyfi` | Community-reported intensity | `intensity` |
| `shakemap` | Modeled instrumental intensity | `intensity` |
| `wadati` | Multi-station P/S consistency and apparent Vp/Vs | `wadati` |

An unavailable or not-yet-computed plot uses the `unavailable` summary rather
than fabricated zero-valued measurements.

## Added plot: Wadati

Tremiom already supports manual and automatic P/S picks, TauP predictions,
record sections, and grid-search location. A Wadati diagram is the missing
quality-control bridge between picking and location.

The classic plot uses:

```text
x = observed P arrival time
y = observed S arrival time - observed P arrival time
y = m(x - t0)
apparent Vp/Vs = m + 1
```

It provides:

- an immediate check that P/S pairs from different stations are mutually
  consistent;
- conspicuous outliers for swapped, emergent, or erroneous picks;
- a provisional origin-time intercept independent of absolute station
  distance;
- an apparent `Vp/Vs` estimate for the sampled region.

The plot should require at least three stations with both P and S picks;
four or more is preferable. A robust regression should report its included
points, rejected outliers, `R²`, RMS residual, slope, apparent `Vp/Vs`, and
origin-time estimate. With only three pairs, large uncertainty, narrow
arrival-time span, or a poor fit, the result must be labeled preliminary or
unstable. It must not be presented as a crustal velocity model.

For spatially compact networks, the modified differential Wadati method may
reduce origin-time sensitivity:

```text
x = P_i - P_reference
y = S_i - S_reference
slope = apparent Vp/Vs
```

Both methods are represented in the schemas.

## Output grammar

Conceptually:

```text
Output :=
  ProtocolVersion
  + ResponseId
  + UserMessage
  + Assessment
  + EvidenceCitations
  + SessionActions
  + SessionDataRequests
```

An output may explain without acting, act without requesting more data, or
request a small amount of already-loaded data for a continuation turn.

### Action classes

Safe view changes can execute automatically after validation:

- `set-mode`
- `select-event`
- `select-station`
- `set-visible-plots`
- `set-time-window`
- `set-filter`
- `set-units`
- `set-component`
- `focus-evidence`

Session content changes:

- `add-annotation`
- `create-wadati`

Explicit confirmation:

- `propose-pick`
- `export-session`

The model does not provide a user or session ID. Tremiom binds actions to the
browser connection from which the request originated.

### Data requests

Data requests are not general retrieval tools. Every request has
`alreadyLoadedOnly: true`, and Tremiom must reject it unless every referenced
resource is already in the current session:

- `get-plot-summary`
- `compare-session-stations`
- `get-series-excerpt`
- `get-session-picks`

Series excerpts are capped at 2,000 values and represented as an envelope,
uniform downsample, spectral peaks, or time-frequency ridges. Full-resolution
waveforms and complete spectrogram matrices do not belong in model context.

## Validation and execution

The minimum safe pipeline is:

```text
Model output
  -> JSON parse
  -> output-schema validation
  -> identifier membership checks against the input session
  -> scientific parameter checks
  -> cost and action-count limits
  -> confirmation policy
  -> session-bound dispatch
  -> action results in the next input turn
```

Additional runtime checks that JSON Schema cannot express include:

- end time must be later than start time and remain inside a loaded window;
- band-pass `lowHz` must be below `highHz` and both below Nyquist;
- chosen plots must be available in the current mode;
- Wadati input must contain matched P/S pairs from at least three stations;
- evidence citations and actions must reference the current input;
- no action may trigger an implicit upstream retrieval;
- physical-unit comparisons require compatible response removal and units.

## Multi-user isolation

Underlying immutable waveform data and computations may be shared for
efficiency, but AI context and actions are session-local. Filters, units, time
windows, annotations, picks, visible plots, and conversation state must not be
stored as global per-station state.

The assistant context should be held in browser memory by default and cleared
when the session ends. If session persistence is added later, it must be
scoped to an authenticated owner and remain logically separate from shared
waveform caches.
