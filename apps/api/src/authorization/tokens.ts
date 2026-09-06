/**
 * DI tokens live apart from the module that binds them.
 *
 * The controller needs the tokens and the module needs the controller. With
 * both in one file that is a require cycle, and the symptom is not a warning —
 * it is `Cannot access 'DECISION_SERVICE' before initialization` at startup,
 * from a decorator that ran while the module was still half-evaluated.
 */
export const DECISION_SERVICE = Symbol('DECISION_SERVICE');
export const GRANT_REPOSITORY = Symbol('GRANT_REPOSITORY');
export const L1_CACHE = Symbol('L1_CACHE');
export const KG_QUERIES = Symbol('KG_QUERIES');
