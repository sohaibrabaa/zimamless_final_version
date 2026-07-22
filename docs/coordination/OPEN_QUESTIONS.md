# Open Questions (escalation queue — append-only)

Ambiguities the frozen documents don't resolve, awaiting product-owner ruling. Order of authority first: `03_API_CONTRACT.yaml` → `02_DATABASE_SCHEMA.sql` → `01_..REQUIREMENTS.md` → product owner.

Format:

```
## Q-<seq> — <short title>
Raised by: Agent A|B, <date>, blocking: <phase/task or "not blocking">
Question: <what is ambiguous, with document references>
Options considered: <1..n>
Recommendation: <the agent's preferred answer>
Needed by: <date/phase>
Status: OPEN | RULED (see DECISIONS.md D-ref)
```

Rules: raising a question means you STOP that thread and switch tasks — never work around it. Rulings land in `DECISIONS.md`; update the Status line here to point at them.

---
