# Logger — Namespaces

Imposta `LOG_NAMESPACES` nel `.env` con i namespace separati da virgola.

```env
LOG_NAMESPACES=pddl,nav      # solo questi due
LOG_NAMESPACES=*             # tutto (default)
LOG_NAMESPACES=              # silenzio totale
```

> `warn` e `error` sono sempre visibili indipendentemente dal filtro.

---

## Namespace disponibili

| Flag | Descrizione |
|------|-------------|
| `config` | Configurazione server ricevuta |
| `map` | Caricamento mappa e tile |
| `crate` | Casse apparse/rimosse |
| `sensing` | Agenti e casse sensed |
| `nav` | Navigazione A* step-by-step |
| `move` | Ogni movimento eseguito |
| `move:pddl` | Movimenti pianificati da PDDL |
| `pddl` | Pianificatore PDDL (push casse) |
| `intention` | Gestione intenzioni BDI |
| `agent` | Loop intenzioni agente |
| `strategy` | Strategia selezionata |
| `explore` | Esplorazione mappa |
| `delivery` | Selezione zona consegna |
| `pathlen` | Costo percorso con casse |
| `blind` | StrategyBlind decisions |
| `greedy` | StrategyGreedy decisions |
| `hurry` | StrategyHurry decisions |
| `memory` | StrategyMemory decisions |
| `lookahead` | StrategyLookAhead decisions |
| `stochastic` | Esplorazione probabilistica gruppi |
| `not-too-greedy` | StrategyNotTooGreedy decisions |
| `simple` | StrategySimple decisions |
| `single-parcel` | StrategySingleParcel decisions |
| `llm` | Layer comandi LLM |
| `llm:chat` | Messaggi chat in arrivo |
| `llm:tool` | Tool calls LLM eseguiti |
