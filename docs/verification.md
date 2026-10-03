# Extraction verification

Verified 2026-10-03T20:27:18.373130+00:00.

- Actual isolated Convex handler/domain tests: **128/128 passed**, 0 failed, 0 skipped.
- Offline schema/API generation: exit 0.
- Additive module plus host Convex typecheck: exit 0.
- Original domain tests unchanged; existing shared authentication/scoped workforce/source evidence dependencies reused in a scratch host fixture. No change to acceptance or permission requirements.
- Model calls: 0. Live provider/business effects: 0. Customer-account seeding, hosted deployment, rendered UI and real-model domain orchestration: not run.

The finance module's first extraction attempt failed to load because commission_terms still imported rental_model. That remaining dependency was redirected to the preserved neutral support module; fresh codegen/types and all original tests then passed. Property-management extraction passed its first isolated run. This is dependency separation evidence, not production or business-completion certification.

Source baseline/original and current exported hashes are in provenance.json. Detailed synthetic test JSON and logs remain in ignored .local fixtures; only these safe aggregate results are published. Test fixtures remain runnable against a compatible local core using the documented command. No local machine/account identity, credential, transcript, database dump, full core source or licensed UI template is included.
